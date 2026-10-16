/**
 * 面板反馈矩阵守卫（W3-11.10）：每个**写操作**的调用点之后必须出现反馈。
 *
 * ## 为什么需要它
 *
 * 2026-10-09 的梳理量出三类真缺口：14 处阻塞式 `window.alert`（风格不一致、钉住窗口）、
 * 3 处**失实文案**（说着已移除的机制）、若干写操作「点了没反应」（成功失败都不说）。
 * 前两类各已有守卫（`stale-copy-guard.spec.ts`、`outbound-site-coverage.spec.ts`），
 * 第三类没有 —— 因为「有没有反馈」此前只能靠人一个个面板看。
 *
 * 本守卫把它变成机械判据：
 *   ① 面板里每个**写操作**调用（`await apiSaveXxx(...)` / `await apiDeleteXxx(...)` 这类）
 *      之后 16 行内必须有反馈令牌；
 *   ② `src/client/**` 的活代码里不许再出现 `window.alert(`（阻塞式原生弹窗）。
 * 反馈令牌 = 会渲染给用户的那类 setter / flash / notify（清单见 {@link FEEDBACK_TOKENS}）。
 *
 * 口径说明（避免这条判据变成噪声源）：
 *   · 只扫 `panels/**` —— 那是全部界面的所在地；`ui/`（kit）与 `utils/` 不做业务调用；
 *   · **同文件 20 行内**的反馈算这个调用点的 —— 反馈常常由 `catch` 分支里的 setter 给出，
 *     而 catch 就在调用点下方；
 *   · 豁免清单（{@link EXEMPT}）必须逐条写明理由，新增豁免要先问「是不是反馈真的缺失」。
 *     宁可虚报（让人来看一眼），不可让判据悄悄恒真。
 * @vitest-environment node
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
/** 本 spec 住在 panels/ 下，往上一路找到仓库根（以根 package.json 的 name 为锚，数层级数会错）。 */
function findRoot(from: string): string {
  let dir = from
  for (let i = 0; i < 20; i += 1) {
    const pkg = join(dir, 'package.json')
    if (existsSync(pkg)) {
      try {
        const j = JSON.parse(readFileSync(pkg, 'utf8')) as { name?: string }
        if (j.name === 'super-time-electron') return dir
      } catch { /* 不是那份 package.json，继续往上 */ }
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  throw new Error('找不到仓库根（package.json name=super-time-electron）')
}
const ROOT = findRoot(HERE)
const PANELS = join(ROOT, 'src', 'client', 'ui-wechat', 'src', 'client', 'pages', 'wechat-data', 'panels')

/** 写操作的动词前缀：命中即认为「用户点了一下、系统改了东西」，必须有反馈。 */
const WRITE_VERBS = ['Save', 'Delete', 'Add', 'Create', 'Rename', 'Set', 'Build', 'Export', 'Submit',
  'Reset', 'Edit', 'Clear', 'Remove', 'Update', 'Cancel', 'AutoGet', 'Generate', 'Extract', 'Adopt',
  'Download', 'Install', 'Restore', 'Import', 'Migrate', 'Analyze', 'Transcribe', 'Decrypt', 'Sync',
  'Toggle', 'Pump', 'Warm', 'Optimize', 'Run', 'Register', 'Upsert', 'Apply', 'Activate', 'Deactivate',
  'Issue', 'Keygen', 'RemoveAll', 'Prune', 'Recover', 'Requeue', 'Attach']
const WRITE_RE = new RegExp(`\\bapi(?:${WRITE_VERBS.join('|')})\\w*\\(`)

/**
 * 反馈令牌：会渲染给用户的那类状态写入。
 * `hold|flash|notify` 是 `useTransientNotice` 的三件套；名字里带 Error/Err/Msg/Notice/
 * Hint/Flash/Tip/Toast 的 setter 是各面板自己的消息位（`setError` / `exportMsg` /
 * `editNotice` / `llmMsg` / `indexError` …）。
 */
const FEEDBACK_TOKENS = [
  /\bnotify\(/, /\bflash\(/, /\bhold\(/, /\bflashActionNotice\(/, /\bflashEditNotice\(/,
  // 名字里带反馈词的 setter：setError/setErr/setMsg/setExportMsg/setLlmMsg/setIndexError…
  // ⚠ 两版都错过，错法不同：第一版写成 setXxxError 形态，`setError(` 整个匹配不上；
  // 第二版写成 set[A-Z]\w*(Error|…)，开头的 [A-Z] 把 'E' 吃掉后照样匹配不上 `setError(`。
  // 正确形状是「可选前缀 + 反馈词」：set(可选 Xxx)?(Error|Err|Msg|Notice|Hint|Flash|Tip|Toast)(
  // `setBusy(` / `setLoading(` 这类纯状态开关两种形状下都不匹配 —— 那是刻意的。
  /\bset(?:[A-Z]\w*)?(?:Error|Err|Msg|Note|Notice|Hint|Flash|Tip|Toast)\(/,
  /\bflash\w*\(/,
  /window\.alert\(/,
]

/**
 * 调用点之后往后看多少行。40 而不是 16：成功反馈常常落在调用后十几行 ——
 * 先 `await load()` 刷新、再分情况给文案（AiModelConfig 的保存就是 21 行后才 setLlmMsg）。
 */
const LOOKAHEAD_LINES = 40

/** 豁免：文件 → 调用点子串 → 理由。没有理由的一律不接受。 */
const EXEMPT: Array<{ file: string; call: string; why: string }> = [
  {
    // 逐条分析的反馈不在消息栏里，而在**每条消息自己的状态槽**：`setMap` 写
    // `{state:'pending'|'error'|'done'}`，由 ChatAnalysisPanel.tsx:77-82 渲染成
    // 「本地分析中… / 分析失败：<原因> / 结果 + 缓存与耗时」。所以它不是没有反馈，
    // 是反馈不住在 setter 名字里 —— 这条豁免把那个事实记在这里，免得下一个人误判。
    file: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/use-inline-analysis.ts',
    call: 'apiAnalyzeVisibleMessages',
    why: '反馈经 setMap 写入逐消息状态槽，由 ChatAnalysisPanel 渲染 pending/error/done 三态',
  },
  {
    // 「知道了」（M1 密钥搬家提示，W2-12.3）：反馈经 `report(...)` 回传，
    // 由 hook 里的 `setSaveMsg` 渲染成设置页的提示条 —— 与上面那条同一种形状：
    // 反馈是真的，只是隔了一层参数，不是「没做反馈」。写成豁免是如实记账，
    // 好过把 `writeSecretMigrationAck` 塞回 hook 里（那个函数已经八百多行）。
    file: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/settings-state.tsx',
    call: 'apiSaveWechatConfig',
    why: '模块级助手 writeSecretMigrationAck 里的确认位写入，失败经 report 回调落到 setSaveMsg 提示条',
  },
]

function panelFiles(): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue
      const p = join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (/\.tsx?$/.test(e.name) && !/\.spec\.tsx?$/.test(e.name)) out.push(relative(ROOT, p).replace(/\\/g, '/'))
    }
  }
  walk(PANELS)
  return out.sort()
}

/**
 * 逐行读原始文件并跳过注释内容。
 *
 * 为什么不用「先整篇剥注释再 split」：那样得到的行号是**剥过注释之后**的行号，与源文件对不上 ——
 * 本守卫第一版就是这么写的，跑出一批「缺口」后逐个去对应位置，有一半对不上，白花时间。
 * 块注释用简单状态机跟踪（本仓没有嵌套块注释）。
 */
function codeLines(file: string): Array<{ text: string; no: number }> {
  const raw = readFileSync(join(ROOT, file), 'utf8').replace(/\r\n/g, '\n').split('\n')
  const out: Array<{ text: string; no: number }> = []
  let inBlock = false
  for (let i = 0; i < raw.length; i += 1) {
    const line = raw[i] ?? ''
    if (inBlock) {
      const end = line.indexOf('*/')
      if (end >= 0) { inBlock = false; out.push({ text: line.slice(end + 2), no: i + 1 }) }
      continue
    }
    const start = line.indexOf('/*')
    if (start >= 0) {
      inBlock = !line.slice(start).includes('*/')
      out.push({ text: line.slice(0, start), no: i + 1 })
      continue
    }
    const slash = line.indexOf('//')
    if (slash >= 0) {
      const before = line.slice(0, slash)
      const odd = (q: string): boolean => (before.split(q).length - 1) % 2 === 1
      out.push({ text: odd("'") || odd('"') || odd('`') ? line : before, no: i + 1 })
      continue
    }
    out.push({ text: line, no: i + 1 })
  }
  return out
}

interface Miss { file: string; line: number; call: string }

function misses(): Miss[] {
  const out: Miss[] = []
  for (const file of panelFiles()) {
    const lines = codeLines(file)
    for (let i = 0; i < lines.length; i += 1) {
      const cur = lines[i] ?? { text: '', no: i + 1 }
      const m = WRITE_RE.exec(cur.text)
      if (!m) continue
      const window = lines.slice(i + 1, i + 1 + LOOKAHEAD_LINES).map((l) => l.text).join('\n')
      const has = FEEDBACK_TOKENS.some((re) => re.test(window))
      if (has) continue
      const exempt = EXEMPT.find((e) => e.file === file && cur.text.includes(e.call))
      if (exempt) continue
      out.push({ file, line: cur.no, call: m[0] })
    }
  }
  return out
}

describe('面板反馈矩阵（W3-11.10）', () => {
  const all = misses()

  it('防空转：扫到了面板与写操作调用点', () => {
    expect(panelFiles().length, '一个面板文件都没扫到 ⇒ 扫描范围错了').toBeGreaterThan(50)
    let writeCalls = 0
    for (const f of panelFiles()) writeCalls += (codeLines(f).map((l) => l.text).join('\n').match(WRITE_RE) ?? []).length
    expect(writeCalls, '一个写操作调用点都没扫到 ⇒ 判据是恒真的').toBeGreaterThan(30)
  })

  /**
   * ⚠ 本守卫**看不到**的三类形态（2026-10-09 实测后如实记账，别再当成已覆盖）：
   *   ① 「成功不吭声、只有错了才说」—— 需要 AST 才能把成功路径与 catch 分开，
   *      文本层的窗口检查做不到（试过按 `catch` 切窗口，误报 15 处：成功反馈常在
   *      十几行外，或经 `finishWith(...)` 这类助手给出）；
   *   ② 反馈经助手函数 / 逐项状态槽给出（`finishWith` / `setMap(state:'error')`）；
   *   ③ 钩子模块（`chats-edit.tsx` / `chats-export.tsx` / `use-inline-analysis.ts`）
   *      自己不渲染，反馈面在宿主面板里 —— 按文件扫会误报一片。
   * 这三类要靠「AST + 渲染树」才能机检，登记在优化计划 W3 的欠账里。
   * 在那之前，本守卫的实际作用是：**新增一个完全静音的写操作会立刻转红**。
   */
  it('每个写操作调用点之后都有反馈令牌', () => {
    const report = all.map((m) => `${m.file}:${String(m.line)} ${m.call}`).join('\n  ')
    expect(all, `这些写操作点了之后看不出成没成（要么补反馈，要么带理由进 EXEMPT）：\n  ${report}`).toEqual([])
  })

  it('活代码里不许有 window.alert（阻塞式原生弹窗）', () => {
    const offenders: string[] = []
    const clientRoot = join(ROOT, 'src', 'client')
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.name === 'node_modules' || e.name.startsWith('.')) continue
        const p = join(dir, e.name)
        if (e.isDirectory()) walk(p)
        else if (/\.tsx?$/.test(e.name) && !/\.spec\.tsx?$/.test(e.name)) {
          const rel = relative(ROOT, p).replace(/\\/g, '/')
          const code = codeLines(rel).map((l) => l.text).join('\n')
          if (code.includes('window.alert(')) offenders.push(rel)
        }
      }
    }
    walk(clientRoot)
    expect(offenders, `这些文件还在用阻塞式原生弹窗：${offenders.join(', ')}`).toEqual([])
  })
})
