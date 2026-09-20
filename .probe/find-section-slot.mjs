// Which *installed* DSH package declares the `settings.section` slot, and does
// the installed version set provide it at all?
//
// The pnpm virtual store truncates long directory names and appends a hash, so
// the package identity has to come from each package.json rather than the path.
// Plain `grep -r node_modules/@deepseek-ai` is not conclusive here because those
// entries are symlinks.
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const root = process.argv[2] ?? '.'
const store = join(root, 'node_modules', '.pnpm')
const packages = []

for (const dir of readdirSync(store)) {
  if (!dir.startsWith('@deepseek-ai+')) continue
  const inner = join(store, dir, 'node_modules', '@deepseek-ai')
  if (!existsSync(inner)) continue
  for (const pkg of readdirSync(inner)) {
    const pkgDir = join(inner, pkg)
    const manifest = join(pkgDir, 'package.json')
    if (!existsSync(manifest)) continue
    const parsed = JSON.parse(readFileSync(manifest, 'utf8'))
    packages.push({ name: `@deepseek-ai/${pkg}`, version: parsed.version, dir: pkgDir })
  }
}

/** Collect candidate source files under a package, skipping symlinks. */
function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) walk(path, out)
    else if (entry.isFile() && /\.(d\.ts|js|md)$/.test(entry.name)) out.push(path)
  }
  return out
}

console.log(`installed @deepseek-ai packages: ${packages.length}`)
for (const pkg of packages) {
  const hits = []
  for (const file of walk(pkg.dir)) {
    if (readFileSync(file, 'utf8').includes('settings.section')) hits.push(file.slice(pkg.dir.length))
  }
  if (hits.length > 0) {
    console.log(`DECLARES settings.section: ${pkg.name}@${pkg.version}`)
    for (const hit of hits.slice(0, 6)) console.log(`   ${hit}`)
  }
}
console.log('---')
for (const pkg of packages.sort((a, b) => a.name.localeCompare(b.name))) {
  console.log(`${pkg.name}\t${pkg.version}`)
}
