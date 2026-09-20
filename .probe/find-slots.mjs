/**
 * Find every UI slot name the published DSH packages declare.
 *
 * Slot names are string literals passed to a `slots.declare(...)`-style call, so
 * the authoritative answer is inside the tarballs, not in any README. This
 * downloads the candidate packages, unpacks them, and greps for slot-shaped
 * literals, then prints the deduplicated set.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const ROOT = process.cwd()
const WORK = join(ROOT, 'work')

function npmRun(args) {
  return execFileSync(npm, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], shell: true, cwd: WORK })
}

function latestVersion(spec) {
  const raw = npmRun(['view', spec, 'version', '--json'])
  return JSON.parse(raw)
}

/** Every published version, newest last. */
function allVersions(spec) {
  const raw = npmRun(['view', spec, 'versions', '--json'])
  return JSON.parse(raw)
}

const PACKAGES = [
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-settings-plugins',
  '@deepseek-ai/dsh-client-ui-settings',
  '@deepseek-ai/dsh-client-ui-conversation',
  '@deepseek-ai/dsh-client-ui-model-selection',
  '@deepseek-ai/dsh-client-ui-agent-preset',
  '@deepseek-ai/dsh-web-app',
  '@deepseek-ai/dsh-client-ui-renderer',
]

rmSync(WORK, { recursive: true, force: true })
mkdirSync(WORK, { recursive: true })
writeFileSync(join(WORK, 'package.json'), '{"name":"probe","private":true,"version":"0.0.0"}\n')

const report = {}
for (const name of PACKAGES) {
  let versions
  try {
    versions = allVersions(name)
  } catch {
    continue
  }
  // Prefer a version that matches the generation dsh-workbuddy-connect targets.
  const wanted = versions.filter(v => /^0\.1\.(5|6)/.test(v)).pop() ?? versions[versions.length - 1]
  const spec = `${name}@${wanted}`
  try {
    const out = npmRun(['pack', spec, '--json'])
    const info = JSON.parse(out)
    const tarball = info[0]?.filename
    if (tarball !== undefined) {
      execFileSync('tar', ['-xzf', tarball], { cwd: WORK, stdio: 'ignore', shell: true })
      report[name] = { version: wanted, dir: join(WORK, 'package') }
      // Move aside so the next unpack does not overwrite before we read it.
      rmSync(join(WORK, `unpacked-${name.split('/').pop()}`), { recursive: true, force: true })
      execFileSync('cmd', ['/c', 'move', join(WORK, 'package'), join(WORK, `unpacked-${name.split('/').pop()}`)],
        { cwd: WORK, stdio: 'ignore' })
      report[name].dir = join(WORK, `unpacked-${name.split('/').pop()}`)
    }
  } catch (error) {
    report[name] = { error: String(error).slice(0, 120) }
  }
}

console.log('=== unpacked ===')
for (const [name, info] of Object.entries(report)) {
  console.log(`${name}\t${info.version ?? 'ERR'}\t${info.error ?? info.dir}`)
}

const SLOT_RE = /['"`]([a-z][a-zA-Z0-9]*(?:\.[a-zA-Z0-9-]+)+)['"`]/g
const slots = new Map()

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    let st
    try {
      st = statSync(full)
    } catch {
      continue
    }
    if (st.isDirectory()) {
      walk(full)
      continue
    }
    if (!/\.(js|mjs|cjs|ts|d\.ts)$/.test(entry)) continue
    const text = readFileSync(full, 'utf8')
    // Only look at lines that talk about slots, to avoid collecting every
    // dotted identifier in the bundle.
    for (const line of text.split('\n')) {
      if (!/slot/i.test(line)) continue
      for (const match of line.matchAll(SLOT_RE)) {
        const value = match[1]
        if (!/^(settings|conversation|session|app|sidebar|status|panel|composer|workspace|command|model|chat|plugin)\b/.test(value)) continue
        const owner = full.slice(WORK.length + 1)
        if (!slots.has(value)) slots.set(value, new Set())
        slots.get(value).add(owner)
      }
    }
  }
}

for (const info of Object.values(report)) {
  if (info.dir !== undefined) walk(info.dir)
}

console.log('\n=== slot-shaped names found in files that mention "slot" ===')
for (const [value, owners] of [...slots].sort()) {
  console.log(`${value}\t<- ${[...owners].slice(0, 3).join(', ')}`)
}
console.log(`total ${slots.size}`)
