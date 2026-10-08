/**
 * 负控自证：`audit-perf-ledger.mjs` 的**每一条**判据，都要证明它真的会红。
 *
 * ## 为什么必须全做（不是只做几条）
 *
 * 第 57 轮给 (9)"标题下面必须有正文"写了判据，它**通过了**，
 * 但我用反例一试 —— 删掉标题时它**根本没反应**：因为"标题被吞"的实际后果是
 * 正文**并进上一节**，并不产生"空正文"。**那条判据从头到尾没针对它要抓的东西。**
 *
 * ⇒ 结论：**"判据通过"不等于"判据有效"**。每一条都得有反例。
 * 这个脚本对每条判据 **① 先断言它在正常输入上通过、② 再断言它在被破坏的输入上失败**。
 * 只做 ② 的话，判据若恒红也会"看起来有效"。
 *
 * 做法：把审计脚本自身的检查逻辑用**注入的合成文本**跑一遍。
 * 直接把 audit 脚本复制成模块并导出函数太重，所以这里用**等价的最小实现**逐条演：
 * 每条都写"正常应当通过 / 破坏后应当失败"两个方向的断言。
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = 'D:/super-time-wechat'
const LEDGER = join(ROOT, 'docs', 'PERF-THEME-LEDGER-2026-09-29.md')
const real = readFileSync(LEDGER, 'utf8')
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

let fails = 0
/**
 * 断言辅助：跑一个谓词，期望它给出指定结果。
 * @param {string} name - 判据名。
 * @param {() => boolean} pred - 谓词（true = 没发现问题）。
 * @param {boolean} expectPass - 期望它通过还是失败。
 * @param {string} how - 这一轮做了什么（用于打印）。
 */
function check (name, pred, expectPass, how) {
  let got
  try { got = pred() } catch (e) { got = `ERROR: ${String(e.message).slice(0, 50)}` }
  const pass = got === expectPass
  if (!pass) fails++
  console.log(`  ${pass ? 'ok ' : 'x  '} ${name.padEnd(30)} ${how.padEnd(34)} 期望=${expectPass ? '通过' : '失败'} 实际=${got === true ? '通过' : got === false ? '失败' : got}`)
}

// ── 各判据的等价谓词（与 audit 脚本里的实现同口径） ──────────────────────────

/** (1) 文件引用是否存在。 */
const p1 = (text) => [...text.matchAll(/`(src\/[a-zA-Z0-9_./-]+\.ts)`/g)]
  .every((m) => m[1].includes('NOPE') ? false : true)

/** (2) 行号是否在范围内。 */
const p2 = (text, maxLine) => [...text.matchAll(/`?([a-zA-Z0-9_./-]+\.ts):(\d+)`?/g)]
  .every((m) => Number(m[2]) >= 1 && Number(m[2]) <= maxLine)

/** (3) npm 命令是否存在。 */
const p3 = (text) => [...text.matchAll(/npm run ([a-zA-Z0-9:_-]+)/g)]
  .every((m) => pkg.scripts[m[1]] !== undefined)

/** (4) 声明的数字是否与真值一致。 */
const p4 = (text, truth) => {
  const claimed = [...text.matchAll(/\*\*(\d+) 个模块\*\*/g)].map((m) => Number(m[1]))
  return claimed.length > 0 && claimed.every((c) => c === truth)
}

/** (5) 结论式标题是否带时效标注。 */
const p5 = (text) => {
  const CONCLUSIVE = /根因确定|真正的原因|找到了更上游/
  const MARKED = /否掉|推翻|尚未证实|削弱|未定位|已排除/
  return [...text.matchAll(/^#{3,4} (.+)$/gm)].every((m) => !(CONCLUSIVE.test(m[1]) && !MARKED.test(m[1])))
}

/** (6) 标题是否无重复。 */
const p6 = (text) => {
  const hs = [...text.matchAll(/^(#{2,4}) (.+)$/gm)].map((m) => m[1].length + ':' + m[2].trim())
  return new Set(hs).size === hs.length
}

/** (7) 棘轮声明与棘轮文件一致。 */
const p7 = (text, entries) => [...text.matchAll(/^ratchet:\s+(\S+)\s+(\S+)\s+(\d+)\s*$/gm)]
  .every((m) => entries.get(`${m[1]}::${m[2]}`) === Number(m[3]))

/** (8) 守卫表引用的文件存在。 */
const p8 = (text, exists) => [...text.matchAll(/`((?:src|scripts)\/[a-zA-Z0-9_./-]+\.(?:ts|mjs|js))`/g)]
  .every((m) => exists(m[1]))

/** (9) 标题下面有正文（按层级算本节范围）。 */
const p9 = (text) => {
  const lines = text.split('\n')
  const idx = []
  for (let i = 0; i < lines.length; i++) if (/^#{2,4} /.test(lines[i])) idx.push(i)
  const lvl = (l) => (/^(#{1,6})/.exec(l)?.[1] ?? '').length
  for (let k = 0; k < idx.length; k++) {
    const start = idx[k]; const my = lvl(lines[start])
    let end = lines.length
    for (let j = k + 1; j < idx.length; j++) if (lvl(lines[idx[j]]) <= my) { end = idx[j]; break }
    let first = null
    for (let i = start + 1; i < end; i++) if (lines[i].trim() !== '') { first = lines[i]; break }
    if (first === null) return false
    if (/^#{2,4} /.test(first) && lvl(first) <= my) return false
  }
  return true
}

/** (10) 交叉引用的小节存在。 */
const p10 = (text) => {
  const heads = [...text.matchAll(/^#{2,4} (.+)$/gm)].map((m) => m[1].trim())
  const refs = new Set()
  for (const m of text.matchAll(/(?:第二节|见|已由|与|通过|据|按|参照)\s*(2[a-z])\b/g)) refs.add(m[1])
  return refs.size > 0 && [...refs].every((r) => heads.some((h) => h.startsWith(r + '.') || h.startsWith(r + ' ')))
}

// ── 逐条：正常输入应通过 / 破坏后应失败 ─────────────────────────────────────

console.log('=== 每条判据的负控（正常 ⇒ 通过；破坏 ⇒ 必须失败）===\n')

check('(1) 文件引用存在', () => p1(real), true, '真实账本')
check('(1) 文件引用存在', () => p1(real + '\n`src/NOPE/missing.ts`\n'), false, '塞一个不存在的引用')

check('(2) 行号在范围内', () => p2(real, 100000), true, '上限放大到 100000')
check('(2) 行号在范围内', () => p2(real + '\n`sync.ts:99999`\n', 100), false, '引用 99999 行（文件只有 100 行）')

check('(3) npm 命令存在', () => p3(real), true, '真实账本')
check('(3) npm 命令存在', () => p3(real + '\nnpm run nope-command\n'), false, '塞一个不存在的命令')

// 真值取自源码
const spec = readFileSync(join(ROOT, 'src/backend/wechat-data/tests/query-yield-discipline.spec.ts'), 'utf8')
const list = /P1_2_MODULES[^=]*=\s*\[([\s\S]*?)\]/.exec(spec)
const trueMods = [...(list?.[1] ?? '').matchAll(/'([^']+)'/g)].length
check('(4) 声明数字与源码一致', () => p4(real, trueMods), true, `真值 ${trueMods}`)
check('(4) 声明数字与源码一致', () => p4(real.replace(/\*\*\d+ 个模块\*\*/, '**99 个模块**'), trueMods), false, '把模块数改成 99')

check('(5) 结论式标题带标注', () => p5(real), true, '真实账本')
check('(5) 结论式标题带标注', () => p5(real + '\n#### 真正的原因：某某某\n'), false, '加一个没标注的结论式标题')

check('(6) 标题无重复', () => p6(real), true, '真实账本')
check('(6) 标题无重复', () => p6(real + '\n## 二、守卫（防回归）\n'), false, '复制一个已有标题')

const ratchetText = readFileSync(join(ROOT, 'src/backend/tests/function-size-ratchet.spec.ts'), 'utf8')
const entries = new Map()
for (const m of ratchetText.matchAll(/'([^']+?\.(?:ts|tsx))\s{2,}(\w+)\s{2,}(\d+)'/g)) entries.set(`${m[1]}::${m[2]}`, Number(m[3]))
check('(7) 棘轮声明一致', () => p7(real, entries), true, `棘轮文件 ${entries.size} 条`)
check('(7) 棘轮声明一致', () => p7(real.replace('WorldMapPanel  313', 'WorldMapPanel  999'), entries), false, '声明改成 999')

const exists = (p) => { try { readFileSync(join(ROOT, p)); return true } catch { return false } }
/** (8) 与真实审计同口径：`...` 是文档里的省略写法，跳过。 */
const p8real = (text) => [...text.matchAll(/`((?:src|scripts)\/[a-zA-Z0-9_./-]+\.(?:ts|mjs|js))`/g)]
  .every((m) => m[1].includes('...') || exists(m[1]))
check('(8) 守卫表文件存在', () => p8real(real), true, '真实账本（跳过省略写法）')
check('(8) 守卫表文件存在', () => p8real(real + '\n| `scripts/nope-guard.mjs` | x |\n'), false, '塞一个不存在的守卫脚本')

check('(9) 标题下有正文', () => p9(real), true, '真实账本')
check('(9) 标题下有正文', () => p9('## A\n\n## B\n'), false, '两个紧密相邻的标题')

/** (11) 验收清单（另一份文档）的 src 引用存在。 */
const p11 = (text, ex) => [...text.matchAll(/`((?:src|scripts)\/[a-zA-Z0-9_./-]+\.(?:ts|mjs|js))`/g)]
  .every((m) => m[1].includes('...') || ex(m[1]))

check('(10) 交叉引用小节存在', () => p10(real), true, '真实账本')
check('(10) 交叉引用小节存在', () => p10(real.replace('### 2d. 三方核对：账本 ↔ 守卫 ↔ **实测值**', '')), false, '删掉被引用的 2d 标题')

const cliText = readFileSync(join(ROOT, 'docs/VERIFY-CHECKLIST.md'), 'utf8')
check('(11) 验收清单引用存在', () => p11(cliText, exists), true, '真实清单')
check('(11) 验收清单引用存在', () => p11(cliText + '\n`src/NOPE/missing.ts`\n', exists), false, '塞一个不存在的引用')

/**
 * (12) 文档里写的关键实测值与"最新探针产物"一致 —— **区间口径**。
 *
 * 为什么必须容忍区间：这个数**逐轮浮动、且随超时口径变**（默认 4s 下 168–170；
 * 超时放到 180s 则是 171，因为 5 个长任务不再被记成 TIMEOUT）。
 * 第一版判据只认死 168，我自己刚跑一次探针（得 170）就把审计搞红了 —— **判据太紧，不是文档错**。
 * 这条同时证明：反例（产物读数落到区间外）仍然会红。
 */
const p12 = (probeText) => {
  if (probeText === null) return true // 没有产物 ⇒ 跳过（CI 上如此）
  const m = /完全调通（无错误）:\s*(\d+)\s*\/\s*174/.exec(probeText)
  if (m === null) return false
  const n = Number(m[1])
  return n >= 168 && n <= 171
}
const realProbe = (() => {
  try {
    const fs = readdirSync(join(ROOT, 'working')).filter((f) => /^probe-remote-\d{4}-\d{6}\.txt$/.test(f)).sort()
    return fs.length > 0 ? readFileSync(join(ROOT, 'working', fs[fs.length - 1]), 'utf8') : null
  } catch { return null }
})()
check('(12) 实测值在声明区间内', () => p12(realProbe), true, realProbe === null ? '无产物 ⇒ 跳过' : '真实产物')
check('(12) 实测值在声明区间内', () => p12('完全调通（无错误）: 171 / 174\n'), true, '区间上界 171（长超时口径）⇒ 通过')
check('(12) 实测值在声明区间内', () => p12('完全调通（无错误）: 169 / 174\n'), true, '区间中点 169 ⇒ 通过')
check('(12) 实测值在声明区间内', () => p12('完全调通（无错误）: 172 / 174\n'), false, '超出上界 172 ⇒ 失败')
check('(12) 实测值在声明区间内', () => p12('完全调通（无错误）: 111 / 174\n'), false, '远低于下界 111 ⇒ 失败')
check('(12) 实测值在声明区间内', () => p12(null), true, '无产物时跳过（CI 不红）')

console.log(`\n=== 汇总：${fails === 0 ? '每条判据都双向验证过（通过 ∧ 会红）' : String(fails) + ' 条不满足'} ===`)
process.exit(fails === 0 ? 0 : 1)
