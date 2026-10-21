import { readFileSync } from 'node:fs'

const [file, startRaw, endRaw] = process.argv.slice(2)
const start = Number.parseInt(startRaw ?? '', 10)
const end = Number.parseInt(endRaw ?? '', 10)
if (!file || !Number.isFinite(start) || !Number.isFinite(end)) {
  console.error('usage: node tools/tmp-read-lines.mjs <file> <start> <end>')
  process.exit(1)
}

const lines = readFileSync(file, 'utf8').split(/\r?\n/)
const from = Math.max(1, start)
const to = Math.min(lines.length, end)
for (let i = from; i <= to; i += 1) {
  console.log(String(i).padStart(6, ' ') + ': ' + (lines[i - 1] ?? ''))
}
