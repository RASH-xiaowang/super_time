/**
 * U2 · 慢查询必须给出「在做什么 + 已经等了多久」，不能只有一行「统计中…」。
 *
 * ── 这条守卫守的是什么 ────────────────────────────────────────────────────
 * 后端是**同步 SQLite**：一次重查询会把后面的全堵在队列里。R2/R3 实测过两次 —
 * 资金账本在「数据总览」的全量统计（扫 21 万条消息）跑完前要等十几秒，
 * 而那期间界面上只有一行「正在统计资金账本…」，用户无法区分"在跑"和"卡死"。
 * R3 给资金账本补齐了【走秒 + 骨架 + 为什么慢】，2026-09-26 把走秒抽成
 * `hooks.tsx#useElapsedSeconds` 并推广到另外三个同样会慢的面板。
 *
 * ── 为什么走秒而不是真进度 ────────────────────────────────────────────────
 * 后端这些查询是**单次同步调用**，不吐中间进度。要真进度就得改后端为分批 +
 * 进度表，那是另一个量级的改动。走秒是"不加后端成本就能给出进度感"的唯一办法，
 * 所以口径就是：**至少要有秒数**，有骨架更好。
 * @vitest-environment node
 */
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { atLeast, readStripped } from '../../../test-helpers/wiring-kit.ts'

const HERE = import.meta.dirname

/** 四个会排队的重查询面板：文件 + 它的走秒文案特征。 */
const SLOW_PANELS: ReadonlyArray<{ panel: string; tsx: string; text: string; timed?: boolean }> = [
  { panel: '资金往来', tsx: 'Ledger.tsx', text: '正在统计资金账本…已用' },
  { panel: '媒体资产', tsx: 'MediaAssets.tsx', text: '正在盘点本机媒体资产…已用' },
  // 2026-10-18：存储分析改用统一 `LoadingState variant="timed"`（走秒由组件按 since 渲染）
  { panel: '存储分析', tsx: 'Storage.tsx', text: '正在统计存储占用…', timed: true },
  { panel: '群聊分析', tsx: 'GroupInsights.tsx', text: '正在统计群聊洞察…已用' },
]

describe('U2 · 慢查询的加载态要有秒数，不能只有一行「统计中…」', () => {
  for (const { panel, tsx, text, timed } of SLOW_PANELS) {
    it(`${panel}：加载态给出「在做什么 + 已用几秒」`, () => {
      const src = readStripped(join(HERE, tsx))
      expect(src, `${panel} 没有用共用的走秒 hook`).toContain('useElapsedSeconds(')
      expect(src, `${panel} 的加载文案里没有秒数`).toContain(text)
      if (timed === true) {
        // 统一加载态组件把 `since` 渲染成「（已等待 Ns）」
        expect(src, '没有接统一加载态的 timed 档').toMatch(/variant="timed"/)
        expect(src, 'timed 档没有把走秒传进去').toMatch(/since=\{elapsed\}/)
      } else {
        // 两种都是合法的 React 插值：JSX 里直接 `{elapsed}`，模板串里 `${elapsed}`
        // （资金账本是 R3 写的前者，另外三个是后加的后者，不强行统一以免动已验证代码）。
        expect(src, `${panel} 的秒数没有插值到界面上`).toMatch(/已用 (?:\{elapsed\}|\$\{elapsed\})s/)
      }
    })
  }

  it('走秒只有一份实现（不许再有面板自己 setInterval）', () => {
    for (const { panel, tsx } of SLOW_PANELS) {
      const src = readStripped(join(HERE, tsx))
      expect(src, `${panel} 又写了手写计时器 —— 应该用 hooks.tsx#useElapsedSeconds`)
        .not.toMatch(/setInterval\(\s*\(\)\s*=>\s*\{\s*setElapsed/)
    }
  })

  it('hook 本身在 hooks.tsx 里，且签名是 active 布尔', () => {
    const hooks = readStripped(join(HERE, 'hooks.tsx'))
    expect(hooks, 'useElapsedSeconds 不存在').toContain('export function useElapsedSeconds(active: boolean): number')
    // 防空转哨兵：hooks.tsx 至少要有这些导出，否则说明文件读错了
    atLeast(hooks.split('export function ').length - 1, 8, 'hooks.tsx 的导出数')
  })
})
