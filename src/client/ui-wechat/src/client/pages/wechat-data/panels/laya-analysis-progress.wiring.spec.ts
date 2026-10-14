// @vitest-environment node
/**
 * W3-11.5：逐条分析的进度必须真的走到界面上（接线守卫）。
 *
 * 后端那一半由 `laya-analysis-progress.spec.ts` 钉行为（每条推一次、单调、total 是截断后的条数）。
 * 本文件钉的是**另一半**：那一半全对、界面却什么都看不到，本身不会让任何用例变红 ——
 * `ui-entry.tsx` 不中继、hook 不带 jobId、面板不画数字，三者任意一处被改回去，
 * 用户看到的仍是那个不动的「本地分析中…」。这三件事的本质是「接线存在」，所以读源码。
 *
 * 事件名钉**两处取出来比对**而不是各写一遍常量：写两遍的话，改名只改一边会假绿。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
const read = (...p: string[]): string => readFileSync(join(...p), 'utf8')
/** ui-entry 在 `src/client/ui-wechat/src/client/ui-app`，后端在仓库根下的 `src/backend`（各 6 级）。 */
const entry = read(HERE, '..', '..', '..', '..', '..', '..', 'ui-app', 'ui-entry.tsx')
/**
 * 事件映射表（2026-10-14 从 ui-entry 的内联 if-else 抽出）。
 *
 * 为什么抽：手机浏览器那条路（SSE）也要用同一份映射，两边各写一份必然漂 ——
 * 漂的症状是「桌面端进度条会动、手机端不会」，只在一端复现，现场极难定位。
 * 所以本文件原来查 ui-entry 的那两条判据，现在改查**表 + ui-entry 的接线**。
 */
const events = read(HERE, '..', '..', '..', '..', '..', '..', 'ui-app', 'wechat-events.ts')
const hook = read(HERE, 'use-inline-analysis.ts')
const panel = read(HERE, 'ChatAnalysisPanel.tsx')
const remotes = read(HERE, '..', '..', '..', '..', '..', '..', '..', 'backend', 'wechat-data', 'src', 'remotes', 'laya.ts')

/** 主进程侧发出的事件名（必须原样进中继，不能在后半段改名）。 */
const BACKEND_EVENT = 'laya-analysis/progress'

/** 从映射表里取这条后端事件对应的 DOM 事件名。 */
function domNameFor(backendEvent: string): string {
  const re = new RegExp(`\\{\\s*from:\\s*'${backendEvent.replace('/', '\\/')}',\\s*to:\\s*'([^']+)'`)
  return re.exec(events)?.[1] ?? ''
}

describe('W3-11.5：分析进度的接线', () => {
  it('ui-entry 把后端事件原名中继成 DOM 事件', () => {
    expect(domNameFor(BACKEND_EVENT), `映射表里不再中继 ${BACKEND_EVENT}`).not.toBe('')
    // 事件名不许在后半段被改 —— 两边不一致的话面板的监听就是聋的。
    expect(domNameFor(BACKEND_EVENT), '后端事件名与中继出去的 DOM 事件名对不上')
      .toMatch(/^dsh-laya-analysis-/)
    // 表在，还得真的接上：ui-entry 必须把它挂到 IPC 的 onEvent 上
    expect(entry, 'ui-entry 没有把共用的映射表接到 IPC 事件上（表就成了死数据）')
      .toContain('onEvent(dispatchWechatEvent)')
  })

  it('hook 监听的正是中继出去的那个名字，且卸载时摘掉监听', () => {
    const entryDom = domNameFor(BACKEND_EVENT)
    expect(entryDom, '取不到中继出去的 DOM 事件名').not.toBe('')
    expect(hook, 'hook 监听的事件名与中继出去的不是一个').toContain(`addEventListener('${entryDom}'`)
    expect(hook, '卸载时不摘监听 ⇒ 换会话后旧监听还在改新会话的进度').toContain(`removeEventListener('${entryDom}'`)
  })

  it('进度按 jobId 认领（迟到的事件不许把上一批的进度画回来）', () => {
    expect(hook).toMatch(/d\.jobId !== progressJobRef\.current/)
  })

  it('批次序号是 ref 而不是局部变量（局部变量每渲染重置 ⇒ 所有批都是 laya-1）', () => {
    expect(hook, '批次序号必须是 useRef').toMatch(/useRef\(0\)/)
    expect(hook, 'jobId 序号没有走 ref').toContain('++jobSeqRef.current')
    expect(hook, '局部 let 计数器会让每批的 jobId 相同').not.toMatch(/\n\s*let jobSeq = 0/)
  })

  it('请求带上 jobId（不带的话后端连推给谁都不知道）', () => {
    expect(hook).toMatch(/apiAnalyzeVisibleMessages\(\{[^}]*jobId[^}]*\}\)/s)
  })

  it('后端只在带了 jobId 时才推送（没带就静默算完，别把事件打成洪水）', () => {
    const at = remotes.indexOf('const jobId =')
    expect(at, 'laya 远端里找不到 jobId 提取').toBeGreaterThan(-1)
    const block = remotes.slice(at, at + 700)
    expect(block, '空 jobId 时不该建回调').toMatch(/jobId === ''\s*\?\s*undefined/)
    expect(block).toContain(`'${BACKEND_EVENT}'`)
    // 事件载荷必须带 jobId，否则 hook 那侧的认领永远不成立。
    expect(block).toMatch(/emit\('laya-analysis\/progress',\s*\{\s*jobId/)
  })

  it('面板把 done/total 画出来（不是只有一句「分析中」）', () => {
    expect(panel).toContain('progress ? ')
    expect(panel).toMatch(/\$\{progress\.done\}\/\$\{progress\.total\}/)
  })

  // ---- 取消那一半 ----
  it('后端给了取消入口（Remote + api 包装），且槽位与进度各占各的 Map', () => {
    expect(hook, 'hook 还没导入取消用的 api').toMatch(/import \{[^}]*apiCancelLayaAnalysis[^}]*\} from '\.\.\/api\.ts'/)
    expect(hook, '没有批在跑时必须是空操作，而不是报错').toMatch(/if \(jobId === ''\) return Promise\.resolve\(\)/)
    // 槽位必须用**另一个** Map：共用问答复用的那一格，A 批的取消会打到 B 批上。
    // 这一条在行为用例里也有（网关那组的第 ④ 条），这里补的是「形状对不对」的另一侧。
    expect(remotes).toContain("rc.ctx().emit('laya-analysis/progress'")
    expect(remotes).toMatch(/rc\.layaSignal\(jobId\)/)
    expect(remotes, '槽位归还被删了 ⇒ 同一个 jobId 会被永久占着').toMatch(/\} finally \{\s*ctl\?\.done\(\)/)
  })

  it('hook 的 finally 清掉槽位（不然下一次「停止」会打到上一批那个已结束的 id）', () => {
    expect(hook).toMatch(/if \(runningJobRef\.current === jobId\) runningJobRef\.current = ''/)
  })

  it('被取消**不是失败**：部分结果照常进 map，收尾单独说「已停止」', () => {
    expect(hook).toMatch(/if \(res\.canceled === true\)/)
    expect(hook, '取消回执没被单独记下来').toContain('setStopped({')
    expect(panel, '面板没有「已停止」那一行').toContain('已停止（算出 ')
    // 不许把 canceled 当失败弹（那正是 6.1 问答取消里学到的教训）。
    expect(panel).not.toMatch(/分析失败：\{[^}]*canceled/)
  })

  it('停止按钮只在真有批在跑时出现，且写明「最多再等一条」', () => {
    expect(panel).toMatch(/progress !== null && progress !== undefined && onCancel !== undefined/)
    expect(panel, '取消只在每条之间生效，这个限制必须写在按钮上').toContain('最多再等当前这一条算完')
  })

  it('失败态给出「重试这一条」，且入口一路接到 hook 的 retry', () => {
    expect(panel, '失败态没有重试按钮 ⇒ 用户只能等下一次自动重跑').toContain('重试这一条')
    // 按钮必须真的调 onRetry，且传的是**当前选中**的那条 localId。
    expect(panel).toMatch(/onRetry !== undefined && targetId !== null/)
    expect(panel).toMatch(/onRetry\(targetId\)/)
    expect(hook, 'hook 的 retry 只改失败态（pending/done 不该被这条入口改写）')
      .toMatch(/cur\.state !== 'error'\) return/)
  })

it('retry 会把那一条钉住（不给钉住特权就会被 `map.has` 滤掉，按钮点了没反应）', () => {
  expect(hook).toContain('pinnedSeq.current.set(localId, seq)')
  expect(hook).toMatch(/pinned\.current = new Set\(\[\.\.\.pinned\.current, localId\]\)/)
  // 钉住集合要在收集里被消费，且只在本批容量内生效（否则它会永远排第一）。
  expect(hook).toMatch(/collectAnalyzeTargets\(visible, \(id\) => map\.has\(id\), inflight\.current, skips, MAX_BATCH, pinnedSeq\.current\)/)
  expect(hook).toMatch(/filter\(\(id\) => !sent\.has\(id\)\)/)
})

it('retry 找不到那条消息时保持失败态（不做「抹掉失败态却没人重算」的半截状态）', () => {
  expect(hook).toMatch(/if \(seq === undefined\) return/)
  // 顺序也是契约：先查得到、再动状态。
  const at = hook.indexOf('const retry = useCallback')
  const body = hook.slice(at, at + 900)
  expect(body.indexOf('findSortSeq'), 'retry 里没有查游标').toBeGreaterThan(-1)
  expect(body.indexOf('findSortSeq')).toBeLessThan(body.indexOf('setMap('))
})

it('换会话清掉钉住集合（上一会话的重试不该让新会话的消息被重发）', () => {
  const at = hook.indexOf('epoch.current += 1')
  const block = hook.slice(at, at + 520)
  expect(block).toContain('pinned.current = new Set<number>()')
  expect(block).toContain('pinnedSeq.current = new Map<number, number>()')
})

it('取消时没算到的那几条要从结果表里删掉（留着 pending 会永远显示「分析中…」）', () => {
    // `map.has` 是收集那一步的跳过条件 —— 留着条目就等于永久拉黑。
    expect(hook, '取消分支没删未处理的条目 ⇒ 那几条永远停在 pending').toMatch(/next\.delete\(t\.localId\)/)
    expect(hook).toMatch(/const skipped: number\[\] = \[\]/)
  })

  it('删掉的那些本轮要豁免（否则「点停止」变成「停半秒又自己跑」）', () => {
    expect(hook, '豁免集合没被赋上值').toMatch(/skipOnce\.current = new Set\(skipped\)/)
    expect(hook, '收集那一步没消费豁免集合')
      .toMatch(/collectAnalyzeTargets\(visible, \(id\) => map\.has\(id\), inflight\.current, skips, MAX_BATCH/)
    // 换会话必须清掉：上一会话的豁免不该让新会话的头几条被白白跳过。
    const at = hook.indexOf('epoch.current += 1')
    const block = hook.slice(at, at + 420)
    expect(block, '换会话时豁免集合没被清空').toContain('skipOnce.current = new Set<number>()')
  })
})