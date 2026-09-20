/**
 * Enumerate what the published DSH packages declare, so we can answer
 * "can a plugin add an independent settings section?" with evidence rather
 * than assumption.
 *
 * Two questions:
 *   1. Which `@deepseek-ai/dsh*` packages exist (they are public on npm)?
 *   2. Which UI slot names do they declare, and which do they consume?
 */
import { execFileSync } from 'node:child_process'

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'

function view(spec, field) {
  try {
    const args = ['view', spec]
    if (field !== undefined) args.push(field)
    args.push('--json')
    // `shell: true` is required on Windows: npm.cmd is a batch shim that
    // execFileSync cannot launch directly.
    return execFileSync(npm, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], shell: true })
  } catch {
    return undefined
  }
}

// The client half is where slots live; these are the names dsh-workbuddy-connect
// names in package.json plus the ones the READMEs of sibling plugins mention.
const CANDIDATES = [
  '@deepseek-ai/dsh',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-renderer',
  '@deepseek-ai/dsh-client-ui-settings-plugins',
  '@deepseek-ai/dsh-client-ui-conversation',
  '@deepseek-ai/dsh-client-ui-model-selection',
  '@deepseek-ai/dsh-client-locale',
  '@deepseek-ai/dsh-client-ui',
  '@deepseek-ai/dsh-client-shell',
  '@deepseek-ai/dsh-client-ui-settings',
  '@deepseek-ai/dsh-client-ui-settings-page',
  '@deepseek-ai/dsh-client-ui-navigation',
  '@deepseek-ai/dsh-client-ui-sidebar',
  '@deepseek-ai/dsh-client-ui-status-bar',
  '@deepseek-ai/dsh-client-ui-command',
  '@deepseek-ai/dsh-client-ui-panel',
  '@deepseek-ai/dsh-host-webserver',
  '@deepseek-ai/dsh-llm',
]

console.log('spec\tversion')
for (const name of CANDIDATES) {
  const raw = view(name, 'version')
  console.log(`${name}\t${raw === undefined ? '(absent)' : raw.trim()}`)
}

console.log('\n=== @deepseek-ai/* dependencies declared by @deepseek-ai/dsh ===')
const meta = JSON.parse(view('@deepseek-ai/dsh') ?? '{}')
const all = new Set([
  ...Object.keys(meta.dependencies ?? {}),
  ...Object.keys(meta.optionalDependencies ?? {}),
  ...Object.keys(meta.peerDependencies ?? {}),
])
const scoped = [...all].filter(n => n.startsWith('@deepseek-ai/')).sort()
console.log(scoped.join('\n') || '(none)')
console.log(`total ${scoped.length}`)
