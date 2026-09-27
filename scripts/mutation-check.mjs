#!/usr/bin/env node
/**
 * 变异反证**跑手**：把「注入缺陷 → 守卫必须变红 → 逐字节还原」这套动作从手写脚本变成可回归的步骤。
 *
 * ── 为什么需要它 ──────────────────────────────────────────────────────────
 * 本仓库的守卫纪律要求「新增/恢复的守卫必须有反证，不接受只看绿色」。在此之前，每一轮都是
 * 现写一个 `working/mutation-*.py`：读文件、字符串替换、跑 vitest、还原 —— 而那批脚本是**一次性的**，
 * 下一轮没人会再跑。于是「这条守卫到底会不会咬」这个事实，随着临时脚本一起消失了。
 * 更危险的是它没有第二道闸：脚本自己写错（锚点命中 0 次、替换后语法坏掉、忘记还原）时，
 * 看起来仍然「变异全咬」。
 *
 * 这个跑手把三件事变成强制：
 *   ① **锚点必须恰好命中一次** —— 命中 0 次或多处重复，直接判为「锚点失效」，不算通过
 *      （否则「替换没生效」会被误报成「守卫没咬住」）；
 *   ② **必须变红** —— vitest 退出码为 0 即判「没咬住」，顺便把那次运行的输出摘出来；
 *   ③ **还原必须逐字节一致** —— 比对还原后的字节与原始字节，不一致立刻非零退出。
 *      运行前还会把原文备份到 `working/mutation-backup/`，硬崩也能人工恢复。
 *
 * ── 用法 ─────────────────────────────────────────────────────────────────
 *   node scripts/mutation-check.mjs            # 跑全部
 *   node scripts/mutation-check.mjs --list     # 只列清单
 *   node scripts/mutation-check.mjs --only M5  # 只跑一条（可按前缀匹配多条）
 *   node scripts/mutation-check.mjs --self-test # 自检工具本身（三条判定路径 + 逐字节还原）
 *
 * 结果同时打印到 stdout 与写入 `working/mutation-check.txt`（本机 node 的 stdout 重定向不可靠，
 * 需要留档时读那个文件）。
 *
 * ── 加新条目 ──────────────────────────────────────────────────────────────
 * 表在 `scripts/mutations-registry.mjs`（数据与跑手分开：这张表每加一条就长 7 行，
 * 和执行的活放在一起会撞「单文件 1000 行」棘轮）。写法与「锚点必须唯一」的要求写在那份文件头。
 */
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MUTATIONS } from './mutations-registry.mjs'

const ROOT = join(import.meta.dirname, '..')
const VITEST = join(ROOT, 'node_modules', 'vitest', 'vitest.mjs')
const REPORT = join(ROOT, 'working', 'mutation-check.txt')
const BACKUP_DIR = join(ROOT, 'working', 'mutation-backup')

const argv = process.argv.slice(2)
const only = argv.includes('--only') ? argv[argv.indexOf('--only') + 1] : undefined
const listOnly = argv.includes('--list')

const chosen = only === undefined ? MUTATIONS : MUTATIONS.filter((m) => m.id.startsWith(only))
if (chosen.length === 0) {
  process.stdout.write(`没有匹配 --only ${String(only)} 的变异\n`)
  process.exit(2)
}

if (listOnly) {
  process.stdout.write(chosen.map((m) => `${m.id}  ${m.file}\n      ${m.why}\n`).join(''))
  process.exit(0)
}

/** 与文件原始字节比对是否一致。 */
function sameBytes(a, b) {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

/** 在文本里定位唯一锚点，返回实际用于匹配的写法（兼容 CRLF 文件）。 */
function locate(text, from) {
  const hitsLf = text.split(from).length - 1
  if (hitsLf === 1) return { needle: from, hits: 1 }
  const crlf = from.replace(/\n/g, '\r\n')
  if (crlf !== from) {
    const hitsCrlf = text.split(crlf).length - 1
    if (hitsCrlf === 1) return { needle: crlf, hits: 1 }
    if (hitsCrlf > 1) return { needle: crlf, hits: hitsCrlf }
  }
  return { needle: from, hits: hitsLf }
}

/**
 * 判定一段 vitest 输出是否属于**编译/语法错误**，而不是断言失败。
 *
 * 为什么要单独判这一条：本项目记录过一次「变异靠语法错误假咬」——
 * 注入的缺陷让文件根本编不过，vitest 照样退出非零，看起来"守卫咬住了"，
 * 其实守卫一行都没执行。这类"假咬"会把一条完全失效的守卫伪装成有效。
 * @param text - vitest 的完整输出（已去 ANSI）。
 * @returns 命中语法/转换错误标记时为 true。
 */
function looksLikeParseError(text) {
  return /SyntaxError|Transform failed|PARSE_ERROR|Unexpected token|Expected "\)"|Expected ";"|error TS\d+|\[plugin:/i.test(text)
}

/** 跑一次 vitest，返回 `{ rc, tail, parseError }`。 */
function runSpec(specPath) {
  const env = { ...process.env, CODEBUDDY_SAFE_DELETE_ENABLED: '0' }
  delete env.ELECTRON_RUN_AS_NODE
  const r = spawnSync(process.execPath, [VITEST, 'run', specPath, '--maxWorkers=1', '--no-file-parallelism'], {
    cwd: ROOT, env, encoding: 'buffer', timeout: 900_000,
  })
  const raw = Buffer.concat([r.stdout ?? Buffer.alloc(0), r.stderr ?? Buffer.alloc(0)])
  const text = raw.toString('utf8').replace(/\x1b\[[0-9;]*m/g, '')
  const keep = text.split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('FAIL') || /Tests\s|Test Files\s|AssertionError|Error:/.test(l))
  return { rc: r.status ?? -1, tail: keep.slice(0, 4).join(' | ').slice(0, 300), parseError: looksLikeParseError(text) }
}

mkdirSync(BACKUP_DIR, { recursive: true })

/**
 * 施加一条变异、跑目标 spec、无论成败都还原，返回结论行。
 * 抽成函数是为了让 `--self-test` 能复用同一条路径（自检必须走真代码，不能另写一份）。
 * @param {{ id: string, file: string, from: string, to: string, spec: string }} m - 变异定义。
 * @returns {{ id: string, verdict: string, detail?: string, identical?: boolean }} 结论。
 */
function execute(m) {
  const abs = join(ROOT, m.file)
  if (!existsSync(abs)) return { id: m.id, verdict: '锚点失效', detail: `文件不存在：${m.file}` }
  const backup = readFileSync(abs)
  copyFileSync(abs, join(BACKUP_DIR, `${m.id}${m.file.slice(m.file.lastIndexOf('.'))}.bak`))
  const text = backup.toString('utf8')
  const { needle, hits } = locate(text, m.from)
  if (hits !== 1) {
    return { id: m.id, verdict: '锚点失效', detail: `锚点命中 ${hits} 次（必须恰好 1 次）：${m.from.slice(0, 60)}` }
  }
  // 注入文本要跟着锚点走：CRLF 文件里塞进裸 LF 会变成混合行尾（编辑器与 git 都会抖）。
  const crlfNeedle = needle.indexOf(String.fromCharCode(13) + String.fromCharCode(10)) >= 0
  const inject = crlfNeedle ? m.to.split(String.fromCharCode(10)).join(String.fromCharCode(13) + String.fromCharCode(10)) : m.to

  let verdict = ''
  let detail = ''
  try {
    // 用**函数**做替换：`String.replace` 的替换串里 `$&` / `$'` / `` $` `` 是特殊序列，
    // 直接传 m.to 会把「带引号的正则」这类锚点展开成别的内容 —— 表现是文件被写坏后报
    // 「语法假咬」，看着像变异没意义，其实是工具自己把内容改了形。
    writeFileSync(abs, text.replace(needle, () => inject), 'utf8')
    const r = runSpec(m.spec)
    if (r.rc === 0) {
      verdict = '没咬住'
      detail = `注入后 ${m.spec} 仍然通过（rc=0）`
    } else if (r.parseError) {
      verdict = '语法假咬'
      detail = `注入让文件编不过，守卫可能一行都没跑：${r.tail}`
    } else {
      verdict = '咬红'
      detail = r.tail
    }
  } catch (e) {
    verdict = '运行异常'
    detail = String(e?.message ?? e)
  } finally {
    writeFileSync(abs, backup)
  }

  const identical = sameBytes(backup, readFileSync(abs))
  if (!identical) {
    return {
      id: m.id, verdict: '还原不一致',
      detail: '还原后的字节与原始不同 —— 请用 working/mutation-backup/ 里的备份手工恢复', identical: false,
    }
  }
  return { id: m.id, verdict, detail, identical: true }
}

/**
 * 自检的两个靶子与锚点。
 *
 * ⚠️ 这两条路径**曾经漂过而无人知晓**：wiring-kit 从 `panels/` 搬进 `test-helpers/` 之后，
 * 自检的 S3/S4 一起报「锚点失效」（2026-09-27 手工跑 `--self-test` 才发现 —— 全量表是逐条
 * spawn `spec`，从不读这两个常量，所以 `npm test` 与 `check:mutation` 都照样绿）。
 * 兜它的是 `src/backend/tests/mutation-registry-anchors.spec.ts` 里那条「自检靶子必须还在、
 * 锚点必须仍命中一次」的判据：它只读文本与文件存在性，不在 `npm test` 里嵌套跑 vitest。
 */
const SELF_FILE = 'src/client/ui-wechat/src/client/test-helpers/wiring-kit.ts'
const SELF_SPEC = 'src/client/ui-wechat/src/client/test-helpers/wiring-kit.spec.ts'
/** 自检用的锚点：`atLeast` 的声明行开头，改成 `@@@` 后必然编不过。 */
const SELF_ANCHOR = 'export function atLeast('

/**
 * 工具自检：三条判定路径必须各自成立 —— 只跑一次全绿说明不了工具是对的。
 * @returns {Array<{ id: string, verdict: string, detail: string }>} 结论行。
 */
function selfTest() {
  const out = []

  const miss = locate('abc', 'zzz')
  out.push({ id: 'S1 锚点缺失要数成 0 次', verdict: miss.hits === 0 ? '通过' : '失败', detail: `hits=${miss.hits}` })

  const dup = locate('aXa', 'a')
  out.push({ id: 'S2 重复锚点要数成 2 次', verdict: dup.hits === 2 ? '通过' : '失败', detail: `hits=${dup.hits}` })

  // 空变异（from === to）什么都没改，spec 必然通过 ⇒ 必须被判「没咬住」。
  // 这条最重要：它挡住的是「守卫已经失效，却被当成咬住了」。
  const noop = execute({ id: 'S3-noop', file: SELF_FILE, from: SELF_ANCHOR, to: SELF_ANCHOR, spec: SELF_SPEC })
  out.push({
    id: 'S3 空变异必须判「没咬住」',
    verdict: noop.verdict === '没咬住' ? '通过' : '失败',
    detail: `verdict=${noop.verdict}`,
  })

  // 破坏语法：spec 也会非零退出，但这**不是**守卫咬住了 ⇒ 必须被判「语法假咬」。
  const broken = execute({ id: 'S4-syntax', file: SELF_FILE, from: SELF_ANCHOR, to: 'export function atLeast(@@@ ', spec: SELF_SPEC })
  out.push({
    id: 'S4 语法错误必须判「语法假咬」',
    verdict: broken.verdict === '语法假咬' ? '通过' : '失败',
    detail: `verdict=${broken.verdict}`,
  })

  out.push({
    id: 'S5 两条自检变异都要逐字节还原',
    verdict: noop.identical === true && broken.identical === true ? '通过' : '失败',
    detail: `noop=${String(noop.identical)} syntax=${String(broken.identical)}`,
  })

  return out
}

if (argv.includes('--self-test')) {
  const out = selfTest()
  const failed = out.filter((r) => r.verdict !== '通过').length
  const text = ['变异工具自检', '='.repeat(70), ...out.map((r) => `[${r.verdict}] ${r.id}  ${r.detail}`), '',
    failed === 0 ? '结论：工具的三条判定路径都成立。' : `结论：${failed} 条自检未通过。`].join('\n')
  writeFileSync(REPORT, text + '\n', 'utf8')
  process.stdout.write(text + '\n')
  process.exit(failed === 0 ? 0 : 1)
}

const rows = []
let bad = 0

for (const m of chosen) {
  const r = execute(m)
  if (r.verdict !== '咬红') bad++
  rows.push(r)
}

const lines = []
lines.push(`变异反证：共 ${rows.length} 条，异常 ${bad} 条`)
lines.push('='.repeat(70))
for (const r of rows) {
  lines.push(`[${r.verdict}] ${r.id}  逐字节还原=${r.identical === false ? '否' : r.identical === true ? '是' : '未执行'}`)
  if (r.detail) lines.push(`         ${r.detail}`)
}
lines.push('')
lines.push(bad === 0 ? '结论：全部变异都咬住了，且全部逐字节还原。' : `结论：有 ${bad} 条异常，见上。`)
const report = lines.join('\n')
writeFileSync(REPORT, report + '\n', 'utf8')
process.stdout.write(report + '\n')
process.exit(bad === 0 ? 0 : 1)
