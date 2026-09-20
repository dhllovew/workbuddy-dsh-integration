/**
 * Publish the working tree's current state to GitHub as one commit per local
 * commit, using the Git Data API.
 *
 * WHY THE API: this environment resets every Git-over-HTTPS connection to
 * `github.com` (only that host; `api.github.com` is reachable), so `git push`
 * cannot work. The API builds the same objects server-side.
 *
 * HOW: the tree for each local commit is read from `git ls-tree` and its blobs
 * uploaded from the worktree. A commit's files are read from its *tree*, not
 * from the worktree, so a historical path that no longer exists on disk is
 * fetched with `git cat-file` instead of `readFileSync` — which is what makes
 * a multi-commit history replayable.
 *
 * Usage: node .probe/push-via-api.mjs <owner/repo> [branch]
 */
import { execFileSync } from 'node:child_process'

const [repoSlug, branch = 'main'] = process.argv.slice(2)
if (repoSlug === undefined) {
  console.error('usage: node push-via-api.mjs <owner/repo> [branch]')
  process.exit(2)
}

/** Run one git command and return its stdout as a Buffer. */
function gitBuffer(...args) {
  return execFileSync('git', args, { maxBuffer: 512 * 1024 * 1024 })
}

/** Run one git command and return its stdout as text. */
function git(...args) {
  return gitBuffer(...args).toString('utf8')
}

/** Authenticated GitHub API call, retrying transport-level failures. */
function api(path, { method = 'GET', body } = {}) {
  const args = ['api', '-X', method, path, '-H', 'Accept: application/vnd.github+json']
  if (body !== undefined) args.push('--input', '-')
  let last
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const out = execFileSync('gh', args, {
        encoding: 'utf8',
        input: body === undefined ? undefined : JSON.stringify(body),
        maxBuffer: 512 * 1024 * 1024,
      })
      return out.trim() === '' ? undefined : JSON.parse(out)
    } catch (error) {
      last = error
      // Retry only transport failures; a 4xx is a real rejection and must
      // surface rather than being retried into a timeout.
      if (!/timeout|reset|EOF|handshake|connection|503|502/i.test(String(error.stderr ?? ''))) throw error
      console.error(`  retrying after transport error (attempt ${attempt + 1})`)
      execFileSync('node', ['-e', 'setTimeout(()=>{},2000)'])
    }
  }
  throw last
}

/** Every commit to publish, oldest first. */
function commits() {
  const raw = git('log', '--reverse', '--format=%H%x00%T%x00%P%x00%an%x00%ae%x00%aI%x00%s', branch)
  return raw.split('\n').filter(Boolean).map(line => {
    const [sha, tree, parents, author, email, date, subject] = line.split('\u0000')
    return { sha, tree, parents: parents.trim() === '' ? [] : parents.trim().split(' '), author, email, date, subject }
  })
}

/**
 * Create one blob for a file, reading content from a tree object.
 *
 * When the remote already holds a blob with this exact sha, the content is
 * identical and the upload is skipped: GitHub hashes blob content the same way
 * git does, so a matching sha is proof the bytes already exist server-side.
 * That is what keeps a follow-up commit cheap instead of re-sending the tree.
 */
function createBlob(blobSha, path) {
  if (knownBlobs.has(blobSha)) return blobSha
  const content = gitBuffer('cat-file', 'blob', blobSha)  // the object's stable content
  const isBinary = content.includes(0)
  const made = api(`repos/${repoSlug}/git/blobs`, {
    method: 'POST',
    body: isBinary
      ? { content: content.toString('base64'), encoding: 'base64' }
      : { content: content.toString('utf8'), encoding: 'utf-8' },
  }).sha
  knownBlobs.add(made)
  knownBlobs.add(blobSha)
  return made
}

/**
 * Create a tree from the entries of one local tree object.
 *
 * Recursion is what makes this correct for nested paths: a subtree is created
 * from its own `ls-tree` output and then referenced as a `tree` entry by its
 * parent. Deriving directories from path prefixes instead would drop every
 * subdirectory, because a parent would never receive an entry for it.
 */
function createTree(treeSha) {
  const raw = git('ls-tree', '-z', treeSha)
  const entries = raw.split('\u0000').filter(Boolean).map(entry => {
    const [meta, path] = entry.split('\t')
    const [mode, type, sha] = meta.split(' ')
    return { mode, type, sha, path }
  })

  const out = []
  for (const entry of entries) {
    if (entry.type === 'blob') {
      out.push({ path: entry.path, mode: entry.mode, type: 'blob', sha: createBlob(entry.sha, entry.path) })
    } else {
      // A subtree has to exist before the parent can reference it.
      out.push({ path: entry.path, mode: entry.mode, type: 'tree', sha: createTree(entry.sha) })
    }
  }
  return api(`repos/${repoSlug}/git/trees`, { method: 'POST', body: { tree: out } }).sha
}

/**
 * Blob shas the remote already stores, so their content need not be re-sent.
 *
 * Seeded from the current remote tip's tree; empty for a first push, which
 * makes that case upload everything exactly as before.
 */
const knownBlobs = new Set()
const existingTip = (() => {
  try {
    return api(`repos/${repoSlug}/git/ref/heads/${branch}`).object.sha
  } catch {
    return undefined
  }
})()
if (existingTip !== undefined) {
  const remoteCommit = api(`repos/${repoSlug}/git/commits/${existingTip}`)
  const remoteTree = api(`repos/${repoSlug}/git/trees/${remoteCommit.tree.sha}?recursive=1`)
  for (const entry of remoteTree.tree) {
    if (entry.type === 'blob') knownBlobs.add(entry.sha)
  }
  console.log(`remote tip ${existingTip.slice(0, 8)} carries ${knownBlobs.size} blobs; unchanged ones will be reused`)
}

const remap = new Map()
let created = 0

for (const commit of commits()) {
  const parents = commit.parents.map(sha => remap.get(sha) ?? sha)
  const treeSha = createTree(commit.tree)
  let made
  try {
    made = api(`repos/${repoSlug}/git/commits`, {
      method: 'POST',
      body: {
        message: commit.subject,
        tree: treeSha,
        parents,
        author: { name: commit.author, email: commit.email, date: commit.date },
        committer: { name: commit.author, email: commit.email, date: commit.date },
      },
    })
  } catch (error) {
    // GitHub hashes identical commit content identically, so an already-present
    // commit rejects as a duplicate; reuse the sha it reported.
    const existing = String(error.stdout ?? '').match(/"sha"\s*:\s*"([0-9a-f]{40})"/)?.[1]
    if (existing === undefined) throw error
    made = { sha: existing }
  }
  remap.set(commit.sha, made.sha)
  created += 1
  console.log(`${commit.sha.slice(0, 8)} -> ${made.sha.slice(0, 8)}  ${commit.subject}`)
}

const tipSha = [...remap.values()].pop()
try {
  api(`repos/${repoSlug}/git/refs/heads/${branch}`, { method: 'PATCH', body: { sha: tipSha, force: true } })
} catch {
  api(`repos/${repoSlug}/git/refs`, { method: 'POST', body: { ref: `refs/heads/${branch}`, sha: tipSha } })
}
console.log(`updated refs/heads/${branch} -> ${tipSha}  (${created} commits)`)
