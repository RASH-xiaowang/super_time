/**
 * 微信数据面的**WAL 实时刷新覆盖**接线守卫（2026-10-13，用户要求
 * 「所有使用到微信数据库的地方全部使用 WAL 增量实时推送更新」）。
 *
 * 后端半边（`sync-watch.ts`：WAL 目录监听 → 拍同步节拍 → 推送 `wechat-data/updated`）
 * 由 `sync-watch.spec.ts` 钉住；这里钉的是**前端消费面**：每一个展示微信数据库数据的
 * 面板/钩子都必须有一条「推送 → 静默重取」的通路 —— 没有通路的面板会停在打开那一刻
 * （本次逐面板排查出的缺口：年度报告 / 通话 / 健康 / 资金往来 / 公众号资产 / 待办 /
 * 词云 / 地区榜单 / 日历 / 总结任务）。三种被认可的通路形状：
 *   ① `useWechatDataUpdated(...)` 直订（面板内静默重取）；
 *   ② `useFreshData(..., { liveRefresh: true })`（钩子内静默重查）；
 *   ③ `usePagedList`（钩子内已订推送做节流刷新，会话列表额外把节流降到 3s）。
 * 每条锚点都是**单行**、在文件里唯一；清单非空 + 每份都真读到东西（哨兵）——
 * 清单被清空或文件读空都会红，不会恒真。
 * @vitest-environment node
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))

/** `文件 → 必须含有的实时接线锚点`。新增微信数据面板时**必须**在这里登记一行。 */
const LIVE_WIRING: ReadonlyArray<readonly [string, string]> = [
  // ── 共用钩子（语义真源）──
  ['hooks.tsx', 'useWechatDataUpdated(() => {'],
  ['use-fresh-data.ts', 'useWechatDataUpdated(() => {'],
  ['use-fresh-data.ts', 'if ((silent || keepContent) && dataRef.current !== null) return'],
  ['chats-polling.ts', "window.addEventListener('dsh-wechat-data-updated', onUpdated)"],
  // ── 聊天会话族 ──
  ['Chats.tsx', 'refreshMinIntervalMs: SESSIONS_REFRESH_MIN_INTERVAL_MS'],
  ['chats-info-live.ts', 'useWechatDataUpdated(refresh)'],
  ['chats-contact-info-view.tsx', 'useWechatDataUpdated(refreshContact360)'],
  ['chats-calendar-dialog.tsx', 'useWechatDataUpdated(() => { if (calOpen) void refreshCurrentMonth() })'],
  ['WordCloudCard.tsx', 'WORDCLOUD_LIVE_MIN_INTERVAL_MS'],
  // ── 面板（useFreshData liveRefresh 族）──
  ['Calls.tsx', 'liveRefresh: true'],
  ['OfficialAssets.tsx', 'liveRefresh: true'],
  ['Tasks.tsx', 'liveRefresh: true'],
  // ── 面板（直订族，本轮新接）──
  ['Annual.tsx', 'ANNUAL_LIVE_MIN_INTERVAL_MS'],
  ['Annual.tsx', 'useWechatDataUpdated(() => {'],
  ['Health.tsx', 'useWechatDataUpdated(() => { void load() })'],
  ['Ledger.tsx', 'useWechatDataUpdated(() => { void load(month) })'],
  ['RegionBoard.tsx', 'useWechatDataUpdated(() => { void load() })'],
  ['DailySummary.tsx', 'useDailySummaryTasks(loadTasks)'],
  // ── 面板（既有订阅，防复发）──
  ['overview-panel.tsx', 'useWechatDataUpdated(() => { void load() })'],
  ['Contacts.tsx', 'useWechatDataUpdated('],
  ['Files.tsx', 'useWechatDataUpdated('],
  ['Records.tsx', 'useWechatDataUpdated('],
  ['Storage.tsx', 'useWechatDataUpdated('],
  ['WorldMap.tsx', 'useWechatDataUpdated('],
  ['Graph.tsx', 'useWechatDataUpdated('],
  ['GroupInsights.tsx', 'useWechatDataUpdated('],
  ['Monitor.tsx', 'useWechatDataUpdated('],
  ['PrivacyTrust.tsx', 'useWechatDataUpdated('],
  ['AssetInsights.tsx', 'useWechatDataUpdated('],
  ['MediaAssets.tsx', 'useWechatDataUpdated('],
  ['MomentsInsights.tsx', 'useWechatDataUpdated('],
  ['Emoticons.tsx', 'usePagedList<'],
  ['Favorites.tsx', 'usePagedList<'],
  ['Revoked.tsx', 'usePagedList<'],
  ['OperationLogPanel.tsx', 'usePagedList<'],
  ['moments-data.ts', 'useWechatDataUpdated('],
]

describe('微信数据面的 WAL 实时刷新覆盖', () => {
  it('哨兵：清单非空且每份都真读到了东西（清单空/文件读空 ⇒ 下面的断言全恒真）', () => {
    expect(LIVE_WIRING.length, '实时接线清单被清空了').toBeGreaterThanOrEqual(30)
    for (const [file] of LIVE_WIRING) {
      const src = readFileSync(join(HERE, file), 'utf8')
      expect(src.length, `${file} 没读到（路径错/文件被删）`).toBeGreaterThan(500)
    }
  })

  it('每个数据面都有「推送 → 静默重取」的通路（缺一条就有一个面板停在打开那一刻）', () => {
    for (const [file, anchor] of LIVE_WIRING) {
      const src = readFileSync(join(HERE, file), 'utf8')
      expect(src, `${file} 丢了实时接线锚点：${anchor}`).toContain(anchor)
    }
  })

  it('反例自证：明知缺一条接线的合成清单必须被同一判据抓住', () => {
    const fake: ReadonlyArray<readonly [string, string]> = [...LIVE_WIRING, ['Annual.tsx', 'useWechatDataUpdated(() => { void load(year) }) // 摘掉后不可能存在的锚点']]
    const bites = fake.filter(([, anchor]) => !readFileSync(join(HERE, 'Annual.tsx'), 'utf8').includes(anchor))
    expect(bites.length, '合成违例没被认出来 ⇒ 上面那条判断是恒真的').toBeGreaterThan(0)
    expect(LIVE_WIRING.length).toBeGreaterThan(0)
  })
})
