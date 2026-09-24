/**
 * 「这两个超限 CSS 到底拆不拆得动」——一条命令查得出来的数（M21 第 48 步的尺子）。
 *
 * 为什么要有它：2026-09-22 那次勘测用一次性脚本量出「最大不可分簇 = 1140 / 1113 行 ⇒ 拆不到 1000」，
 * 之后**每改一次层叠写法都要重新量一遍**，而没有落进仓库的算料一定会腐烂（N36 / N38 的同类教训）。
 * 现在尺子是committed 的：判据在 `src/client/ui-wechat/src/client/css-cascade.ts`（纯函数 + 枚举期望值的
 * 单测），这里只做「读文件 + 打印」。
 *
 * 两条判据各说各的话，所以分开印：
 *   ① **保序连续切**：不 regroup 规则，只在行边界断刀 —— 切点必须不被任何类名跨度跨过；
 *   ② **按簇 regroup**：允许把规则搬家，代价是产物里的规则次序会变 ⇒ 拆完必须过 `npm run css:bundle-diff`。
 * 只要 ② 的最大簇 > 上限，就说明「不改层叠语义拆不动」，得先解耦（用户 2026-09-24 定的方向：先只解 chats）。
 *
 * 运行：`npm run css:clusters`（可加文件名子串只量一个，如 `npm run css:clusters -- module.css`）
 * 退出码：0 = 量完了（**结论是拆不动也照样 0**，它不是门禁）；2 = 一个 CSS Module 都没找到（口径坏了）。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  clustersOf, coOccurrencesFromSources, contiguousCuts, dangerPairs, parseSource,
  summarize, weakLinks,
} from '../src/client/ui-wechat/src/client/css-cascade.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
/** 与 M21 棘轮同一份上限。 */
const LIMIT = 1000

/** 递归收 `.module.css` 与消费者 TSX（同 `css-bundle-diff` 的走法：跳过构建产物与 node_modules）。 */
function collect (dir, exts, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'ui-dist' || e.name.startsWith('.')) continue
    const p = join(dir, e.name)
    if (e.isDirectory()) collect(p, exts, out)
    else if (exts.some((x) => e.name.endsWith(x))) out.push(p)
  }
  return out
}

const cssFiles = collect(join(ROOT, 'src', 'client'), ['.module.css'])
  .filter((p) => !/ui-primitives-shim/.test(p))
  .sort()
if (cssFiles.length === 0) {
  console.error('[前置] 一个 .module.css 都没找到 —— 扫描口径变了')
  process.exit(2)
}
const tsxTexts = collect(join(ROOT, 'src', 'client'), ['.tsx']).map((p) => readFileSync(p, 'utf8'))
const COOC = coOccurrencesFromSources(tsxTexts)
const filter = process.argv[2]
let oversize = 0

for (const abs of cssFiles) {
  const rel = relative(ROOT, abs).split(sep).join('/')
  if (filter !== undefined && !rel.includes(filter)) continue
  const css = readFileSync(abs, 'utf8')
  const parsed = parseSource(css)
  if (parsed.lines <= LIMIT) continue
  const weak = weakLinks(parsed)
  const weakClusters = clustersOf(weak.links, weak.owner, parsed.frames, parsed.leaves)
  const coocHere = new Set([...COOC].filter((p) => {
    const [a, b] = p.split(' + ')
    return weak.owner.has('c:' + String(a)) && weak.owner.has('c:' + String(b))
  }))
  const dangers = dangerPairs(parsed, coocHere)
  const strongLinks = [...weak.links, ...dangers.map((d) => ['c:' + String(d.pair.split(' + ')[0]), 'c:' + String(d.pair.split(' + ')[1])])]
  const strongClusters = clustersOf(strongLinks, weak.owner, parsed.frames, parsed.leaves)
  const cuts = contiguousCuts(parsed, LIMIT)
  const strongTop = strongClusters[0]?.lines ?? 0
  if (strongTop > LIMIT) oversize += 1
  // 格式化本身也在这条命令里被复用 —— 单测钉的就是这几行（免得「脚本印的」与「测的」两套口径）。
  for (const line of summarize(rel, parsed, weakClusters, strongClusters, LIMIT, coocHere.size, dangers.length, cuts)) console.log(line)
}
console.log(`\n[结论] 超限文件里「按簇也装不进 ${String(LIMIT)} 行」的有 ${String(oversize)} 个` +
  `（共现类对总池 ${String(COOC.size)} 对，来自 ${String(tsxTexts.length)} 份 TSX）`)
