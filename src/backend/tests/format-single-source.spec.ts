/**
 * 「同类格式化只允许一个实现」的守卫（P3-1 / P3-2，第一批 #8）。
 *
 * ## 为什么这条守卫是新生出来的
 *
 * `utils/format.ts` 的注释一直写着「这条由 `scripts/check-ui-consistency.js` 把关」，
 * 而**那个脚本不在仓库里**。写着「有守卫」但守卫没提交，等于没有守卫 ——
 * 于是审查报告能数到 4 份 `fmtTime`（两份收秒、两份收毫秒，类型都是 number，
 * 传错了不报错、只是把时间画到 1970 年）与 5 份字节格式化（同一个 1.5 GB
 * 在不同面板是 `1536.0 MB` / `1.50 GB` / `1.4 MB`）。
 *
 * ## 判据
 *
 * 「实现」与「别名/薄适配器」的差别不能靠名字判（`const fmtSize = (n) => …` 既可能是
 * 复制了一份逻辑，也可能只是给 null 加个分支），所以这里看**函数体里有没有单位换算本身**：
 * `1024` / `toLocaleString` / `padStart` / `getMonth()` 出现即算一份实现，
 * 只允许住在两个唯一出处里（前端 `utils/format.ts`、后端 `src/format.ts`）。
 * 判据本身由文件末尾那条**自证**用例钉住：喂它一段本地实现，它必须报出来。
 * @vitest-environment node
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const FRONT_OWNER = 'src/client/ui-wechat/src/client/pages/wechat-data/utils/format.ts'
const BACK_OWNER = 'src/backend/wechat-data/src/format.ts'
const OWNERS = new Set([FRONT_OWNER, BACK_OWNER])
const SKIP_DIRS = new Set(['node_modules', 'deps', 'lib', 'ui-dist', 'dist', 'fixtures', 'native'])

/** 出现即视为「这里自己实现了一遍」的痕迹。 */
const IMPL_MARKS = /\b1024\b|toLocaleString|padStart|getMonth\(\)/

/**
 * 已知的「第二份时间格式化」（审查报告数到 4 份 fmtTime，本守卫按名字宽口径扫到更多）。
 * **这张清单 2026-09-26 清空了 ⇒ 这一档从此是零容忍闸门，不再登记豁免。**
 *
 * 头几份（`fmtTime` 四份、`search-query.ts` 的 `formatFullTime`）在第一批 #8 / 第三批 #21 就没了。
 * 剩下的六条当时被判成「形状各不相同 ⇒ 统一就得改界面文案，属于另一轮」：
 * `query/favorites.ts` 的 `fmtDateTime`、单聊资料页的 `fmtDate`、知识库的 `formatDate`、
 * 朋友圈评论角的 `fmtCommentTime`、同步状态行的 `fmtSyncTime`、区间层的 `formatLocalDate`。
 * 这轮看清的是：**守卫要的是「一处实现」，不是「一种输出」** —— 把形状本身搬进唯一出处、
 * 并按约定把单位写进名字（`fmtLocalDate` / `fmtDateSec` / `fmtDateMs` / `fmtHourMinuteMs` /
 * `fmtCommentTimeSec`），界面文案一个字都不用动。唯一改动的显示是空值那一档：
 * `formatDate(0)` 原先画成 `1970-01-01`，现在回占位符 —— 那正是 P3-1 点名的病，不是顺手改文案。
 *
 * 所以：**再长出第二份实现 = 红**。真觉得共享出处装不下那个形状，先把「为什么装不下」写进
 * 唯一出处的注释，而不是往这里加一行。
 */
const KNOWN_SECOND_TIME: ReadonlyArray<string> = []

/** 这些名字**一个都不许有第二份**（审查点名的那四类：单位歧义与字节口径的直接来源）。 */
const NEVER_TWICE = /^(fmtTime|fmtBytes|formatBytes|fmtSize)$/

function sourceFiles(): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      if (SKIP_DIRS.has(e.name)) continue
      const rel = `${dir}/${e.name}`
      if (e.isDirectory()) { walk(rel); continue }
      if (!/\.(ts|tsx)$/.test(e.name) || /\.d\.ts$/.test(e.name) || /\.spec\./.test(e.name)) continue
      if (statSync(join(ROOT, rel)).isFile()) out.push(rel)
    }
  }
  walk('src')
  walk('scripts')
  return out
}

/**
 * 扫出一份源码里「自己实现了一遍格式化」的地方。
 *
 * 返回值**只有函数名、不带行号**：行号会随无关编辑漂移，而这份清单是棘轮 ——
 * 一行挪动就报「新增第二份实现」只会让人学会忽略它。
 * @param label - 报错时用的文件名。
 * @param code - 源码。
 * @returns 涉嫌本地实现的函数名列表。
 */
function implementations(label: string, code: string): string[] {
  const sf = ts.createSourceFile(label, code.replace(/\r\n/g, '\n'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const hits: string[] = []
  const seen = new Set<ts.Node>()
  const nameOf = (node: ts.Node): string | null => {
    if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) return node.name ? node.name.getText(sf) : null
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) return node.name.text
    return null
  }
  const isFormatterName = (n: string): boolean => /^(fmt|format)/i.test(n) && /(byte|size|time|date|dt)/i.test(n)
  const walk = (node: ts.Node): void => {
    if (seen.has(node)) return
    seen.add(node)
    const nm = nameOf(node)
    if (nm && isFormatterName(nm)) {
      // 函数声明取整段；变量声明取它的初始化器（箭头函数体）
      const target = ts.isVariableDeclaration(node) ? node.initializer : node
      if (target && IMPL_MARKS.test(target.getText(sf))) {
        hits.push(nm)
      }
    }
    ts.forEachChild(node, walk)
  }
  walk(sf)
  return hits
}

const files = sourceFiles()

describe('格式化函数只有一个实现处', () => {
  it('扫描范围非空（防空转）', () => {
    expect(files.length, '一个源码文件都没扫到 ⇒ 判据恒真').toBeGreaterThan(300)
    for (const owner of OWNERS) {
      expect(files, `唯一出处不存在：${owner}`).toContain(owner)
    }
  })

  it('第二份实现与棘轮清单逐个对齐（只能变小；审查点名的那四类必须为零）', () => {
    const dupes: string[] = []
    for (const f of files) {
      if (OWNERS.has(f)) continue
      for (const h of implementations(f, readFileSync(join(ROOT, f), 'utf8'))) {
        dupes.push(`${f}  ${h}`)
      }
    }
    // ① 严格那一档：字节/`fmtTime` 这类连单位都没写的，一处都不许有
    const never = dupes.filter((d) => NEVER_TWICE.test(d.split('  ')[1] ?? ''))
    expect(never, '这些是审查点名消灭掉的那几类，又长出第二份了：\n  ' + never.join('\n  ')).toEqual([])
    // ② 其余按棘轮对齐：新增要登记（并说明为什么不能复用共享实现），修好要删条目
    expect(dupes.sort(), '第二份实现变了。新增 ⇒ 先证明它确实不是同一个形状，否则用 utils/format.ts / src/format.ts；'
      + '修好 ⇒ 把 `KNOWN_SECOND_TIME` 里那条删掉。\n  实测：\n  ' + dupes.join('\n  '))
      .toEqual([...KNOWN_SECOND_TIME].sort())
    // ③ 清单不许腐烂：登记的每一条必须还在（搬走/改名也要来更新这里）
    for (const k of KNOWN_SECOND_TIME) {
      expect(dupes, `清单里的这条已经不存在了（删掉它）：${k}`).toContain(k)
    }
    // ④ 这一档已经是零容忍闸门：往回登记条目就等于恢复「登记豁免」的老规矩，先拦在这里
    expect(KNOWN_SECOND_TIME, '第二份时间格式化又登记回清单了 —— 该搬进唯一出处，不是登记豁免').toEqual([])
  })

  it('两个唯一出处各自真的定义了共享实现（防空转）', () => {
    const front = readFileSync(join(ROOT, FRONT_OWNER), 'utf8')
    const back = readFileSync(join(ROOT, BACK_OWNER), 'utf8')
    for (const name of ['fmtBytes', 'fmtLocaleMs', 'fmtLocaleSec', 'fmtTodayOrLocaleMs',
      'fmtLocalDate', 'fmtDateSec', 'fmtDateMs', 'fmtHourMinuteMs', 'fmtCommentTimeSec']) {
      expect(front, `${FRONT_OWNER} 不再导出 ${name}`).toContain(`export function ${name}`)
    }
    for (const name of ['fmtBytes', 'fmtDateTimeSec', 'fmtRelativeDaySec']) {
      expect(back, `${BACK_OWNER} 不再导出 ${name}`).toContain(`export function ${name}`)
    }
  })

  it('时间格式化的名字里必须带单位（`fmtTime` 这种含糊名字就是 1970 年的来源）', () => {
    for (const owner of [...OWNERS]) {
      const code = readFileSync(join(ROOT, owner), 'utf8')
      expect(code, `${owner} 又出现了不带单位的 fmtTime`).not.toMatch(/export function fmtTime\s*\(/)
      expect(code).toMatch(/fmt\w*(Sec|Ms)\b/)
    }
  })

  /**
   * 「实现搬进了唯一出处」与「调用方真的用上了」是两件事。
   *
   * 上面那条扫的是**实现**（本地不许再留一份带换算的副本），但把 import 那行删掉只剩调用点、
   * 或者留个 import 却仍调本地那一份，扫描都看不见 —— 所以这里逐个调用点钉三件事：
   * ① 这份文件**从唯一出处 import 了**那个名字（不是「文件里出现过这个名字」）；
   * ② 真的有一个 `名字(` 的调用点；③ 不带单位的老名字不再出现（老名字还在就是没搬干净）。
   */
  const REPOINTED: ReadonlyArray<{ file: string; name: string; oldName: string }> = [
    { file: 'src/backend/wechat-data/src/query/favorites.ts', name: 'fmtDateTimeSec', oldName: 'fmtDateTime' },
    { file: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/chats-contact-info-view.tsx', name: 'fmtDateSec', oldName: 'fmtDate' },
    { file: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/kb-model.ts', name: 'fmtDateMs', oldName: 'formatDate' },
    { file: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/KnowledgeBase.tsx', name: 'fmtDateMs', oldName: 'formatDate' },
    { file: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/moments-card.tsx', name: 'fmtCommentTimeSec', oldName: 'fmtCommentTime' },
    { file: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/moments-portals.tsx', name: 'fmtCommentTimeSec', oldName: 'fmtCommentTime' },
    { file: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/moments-panel.tsx', name: 'fmtHourMinuteMs', oldName: 'fmtSyncTime' },
    { file: 'src/client/ui-wechat/src/client/pages/wechat-data/utils/date-range.ts', name: 'fmtLocalDate', oldName: 'formatLocalDate' },
  ]

  const readSrc = (file: string): string => readFileSync(join(ROOT, file), 'utf8').replace(/\r\n/g, '\n')
  /** 「从哪一份 format.ts import 了这个名字」——出处只认文件名，不写死相对深度。 */
  const importReOf = (name: string): RegExp =>
    new RegExp(`import \\{[^}]*\\b${name}\\b[^}]*\\} from '[^']*format\\.ts'`)

  it('八处调用点：import 自唯一出处、真的有调用点、老名字不再出现', () => {
    expect(REPOINTED.length, '调用点清单是空的 ⇒ 这条会静默恒真').toBe(8)
    for (const r of REPOINTED) {
      const code = readSrc(r.file)
      expect(importReOf(r.name).test(code), `${r.file} 不再从唯一出处 import ${r.name}（只剩本地副本或干脆没接）`).toBe(true)
      expect(code, `${r.file} 里没有 ${r.name} 的调用点`).toMatch(new RegExp(`\\b${r.name}\\(`))
      expect(code, `${r.file} 还在用老名字 ${r.oldName} —— 没搬干净`).not.toMatch(new RegExp(`\\b${r.oldName}\\b`))
    }
  })

  it('反例自证：抽掉 import 那一行 / 把调用换回老名字，上面那条必须分辨得出来', () => {
    const target = REPOINTED.find((r) => r.file.endsWith('favorites.ts'))
    if (!target) throw new Error('调用点清单里找不到 favorites.ts ⇒ 自证没有靶子')
    const code = readSrc(target.file)
    const re = importReOf(target.name)
    expect(re.test(code), '现仓本来就没有那行 import ⇒ 接线那条是假绿').toBe(true)
    expect(re.test(code.replace(re, '')), '抽掉 import 之后仍像接着的 ⇒ 判据只看得到名字，看不到出处').toBe(false)
    const backToOld = code.replace(new RegExp(`\\b${target.name}\\(`), `${target.oldName}(`)
    expect(new RegExp(`\\b${target.oldName}\\b`).test(backToOld), '换回老名字没被 ③ 那面看到').toBe(true)
  })

  it('判据自证：喂它一段本地实现，它必须报出来（否则上面几条是恒真）', () => {
    // 换个名字的本地实现也要抓到（判据不能只认老名字）
    const renamed = "function humanSize(n: number): string {\n  return n < 1024 ? n + ' B' : (n / 1024).toFixed(1) + ' KB'\n}\n"
    expect(implementations('renamed.ts', renamed), '判据只认固定名字 ⇒ 换个名字就失明').toEqual([])
    const bytesDup = "function fmtBytes2(n: number): string {\n  return n < 1024 ? String(n) : (n / 1024).toFixed(1) + ' KB'\n}\n"
    expect(implementations('dup2.ts', bytesDup).length, '同类改名版没被抓到').toBe(1)
    const dup = "function fmtBytes(n: number): string {\n  if (n < 1024) return n + ' B'\n  return (n / 1024).toFixed(1) + ' KB'\n}\n"
    const found = implementations('dup.ts', dup)
    expect(found.length, '本地实现没被抓到 ⇒ 判据形同虚设').toBe(1)
    expect(found[0]).toContain('fmtBytes')
    // 薄适配器（只是转调共享实现）不许被误报
    const adapter = "const fmtSize = (n: number | null): string => (n === null ? '—' : fmtBytes(n))\n"
    expect(implementations('adapter.ts', adapter)).toEqual([])
    const alias = 'export const formatBytes = fmtBytes\n'
    expect(implementations('alias.ts', alias)).toEqual([])
    // 本轮搬进唯一出处的形状，本地再长一份仍然不能失明
    const dateDup = "function fmtDateOnly(ts: number): string {\n  const d = new Date(ts)\n  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`\n}\n"
    expect(implementations('date-dup.ts', dateDup).length, '日期形状的本地副本没被抓到 ⇒ 归零的那张清单是假清').toBe(1)
    const clockDup = "function fmtShortTime(ts: number): string {\n  const d = new Date(ts)\n  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`\n}\n"
    expect(implementations('clock-dup.ts', clockDup).length, '钟点形状的本地副本没被抓到').toBe(1)
  })
})
