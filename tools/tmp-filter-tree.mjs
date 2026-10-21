import { readFileSync } from 'node:fs'

const data = JSON.parse(readFileSync(new URL('../.tmp-weflow-tree.json', import.meta.url), 'utf8'))
const matches = data.tree
  .filter((entry) => /favorite|cdn|media|image|download|voice|file/i.test(entry.path))
  .map((entry) => entry.path)
console.log(matches.join('\n'))
