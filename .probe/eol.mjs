// Report the line-ending convention of a file, so edits can match it.
import { readFileSync } from 'node:fs'

const file = process.argv[2]
const text = readFileSync(file, 'latin1')
const crlf = (text.match(/\r\n/g) ?? []).length
const loneLf = (text.match(/(?<!\r)\n/g) ?? []).length
console.log(`${file}\tCRLF=${crlf}\tloneLF=${loneLf}`)
