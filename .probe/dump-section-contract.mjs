// Dump the installed declaration of the `settings.section` slot so the client
// half can be written against the *installed* API rather than the 0.1.6-alpha
// wording: the registrant option names are what actually matter (`id`/`order`
// vs the `key`/`priority` spelling `settings.plugin.item` uses).
//
// Usage: node dump-section-contract.mjs <plugin-root> <package-name-substring>
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const root = process.argv[2] ?? '.'
const needle = process.argv[3] ?? 'settings-plugins'
const store = join(root, 'node_modules', '.pnpm')

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) walk(path, out)
    else if (entry.isFile()) out.push(path)
  }
  return out
}

for (const dir of readdirSync(store)) {
  if (!dir.startsWith('@deepseek-ai+')) continue
  const inner = join(store, dir, 'node_modules', '@deepseek-ai')
  if (!existsSync(inner)) continue
  for (const pkg of readdirSync(inner)) {
    if (!pkg.includes(needle)) continue
    const pkgDir = join(inner, pkg)
    const manifest = join(pkgDir, 'package.json')
    if (!existsSync(manifest)) continue
    const parsed = JSON.parse(readFileSync(manifest, 'utf8'))
    console.log(`=== ${parsed.name}@${parsed.version}`)
    console.log(`dir: ${pkgDir}`)
    for (const file of walk(pkgDir)) {
      if (!/\.(d\.ts|js|md|json)$/.test(file)) continue
      const text = readFileSync(file, 'utf8')
      if (!text.includes('settings.section')) continue
      console.log(`\n--- ${file.slice(pkgDir.length)}`)
      const lines = text.split('\n')
      for (let index = 0; index < lines.length; index += 1) {
        if (!lines[index].includes('settings.section')) continue
        const from = Math.max(0, index - 12)
        const to = Math.min(lines.length, index + 14)
        console.log(lines.slice(from, to).map((l, i) => `${from + i + 1}: ${l}`).join('\n'))
        console.log('   ...')
      }
    }
  }
}
