// Check whether the peer/dev dependencies dsh-workbuddy-connect needs are
// actually resolvable from the public npm registry.  The plugin declares
// `@deepseek-ai/*` ranges pinned at ^0.1.5-rc.1; `npm view <pkg> version`
// reports the `latest` dist-tag, which for several of these packages points at
// an older 0.0.1-rc.x build, so the range has to be checked against the full
// version list rather than the default tag.
import { execFileSync } from 'node:child_process'

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'

function versions(name) {
  try {
    return JSON.parse(execFileSync(npm, ['view', name, 'versions', '--json'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], shell: true }))
  } catch {
    return undefined
  }
}

const WANTED = [
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-llm-pi-ai',
  '@deepseek-ai/dsh-settings',
  '@deepseek-ai/dsh-credentials',
  '@deepseek-ai/dsh-atomic-write',
  '@deepseek-ai/dsh-attachment',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-renderer',
  '@deepseek-ai/dsh-client-ui-settings-plugins',
  '@deepseek-ai/dsh-client-ui-conversation',
  '@deepseek-ai/dsh-client-ui-model-selection',
  '@deepseek-ai/dsh-client-locale',
  '@deepseek-ai/dsh-home-paths',
  '@deepseek-ai/dsh-host-webserver',
  '@earendil-works/pi-ai',
]

for (const name of WANTED) {
  const list = versions(name)
  if (list === undefined) {
    console.log(`${name}\tUNPUBLISHED`)
    continue
  }
  const matching = list.filter(v => /^0\.1\.[5-9]/.test(v))
  console.log(`${name}\tlatest=${list[list.length - 1]}\tmatch(^0.1.5-rc.1)=${matching.length === 0 ? 'NONE' : matching.join(',')}`)
}
