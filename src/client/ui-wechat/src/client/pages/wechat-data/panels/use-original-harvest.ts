/**
 * 「原图自动收割」的状态与动作（从 `settings-state.tsx` 抽出）。
 *
 * ## 为什么单独一个 hook
 *
 * `useSettingsState` 已经 784 行，逼近函数行数棘轮（250 行上限的登记值）。
 * 收割器要 4 个状态 + 1 个动作，直接塞进去会把它顶破 —— 而棘轮只允许变小。
 * 抽成独立 hook 后，`useSettingsState` 只多一行 `const harvest = useOriginalHarvest(notify)`。
 *
 * ## 这是拿到高清原图唯一不越界的通路
 *
 * 2026-10-17 实测确认了三条死路（脚本 `working/probe-*.mjs`，不入库）：
 * ① 消息 XML 的 `tphdurl`/`tpurl` 本机 20,431 条**全部**指向企业微信 `wwfile` 端点，匿名 GET 一律 403；
 * ② 进程内存里确实有 `tpauthkey`（806 处），但拼进 URL 的 5 种变体**全部 403** ——
 *    它是给 mmtls 私有协议用的，不是 HTTP 凭据；
 * ③ 进程内存里有 225 个完整 JPEG，但与数据库 48,882 个图片 md5 **交集为 0** ——
 *    那是界面渲染缓存，不是聊天原图。
 *
 * 结论：聊天图片走 mmtls 私有 RPC，不是 HTTP 直链。但微信**自己**会下载原图
 * （用户点「查看原图」时落盘 `<md5>_h.dat`，实测本机 1,459 个且仍在新增）。
 * 本 hook 就盯住这个落盘动作：微信负责下载，我们负责收割 —— 不联网、不碰凭据、不注入进程。
 */
import { useCallback, useEffect, useState } from 'react'
import { apiGetOriginalHarvestStatus, apiOriginalHarvest } from '../api.ts'
import { forgetAllImages } from '../image-cache.ts'
import type { HarvestResult, HarvestStatus } from '@deepseek-ai/dsh-wechat-data/types'

/** 收割动作（`status` 只读，不进 busy 态）。 */
export type HarvestAction = 'start' | 'stop' | 'now'

/** 通知函数（与 `useTransientNotice` 的 `notify` 同形）。 */
export type HarvestNotify = (kind: 'ok' | 'err', text: string, items?: string[]) => void

/** {@link useOriginalHarvest} 的返回值。 */
export interface OriginalHarvestState {
  /** 进行中的动作；null = 空闲。 */
  busy: HarvestAction | null
  /** 上一次 `start`/`now` 的结果；null = 还没跑过。 */
  result: HarvestResult | null
  /** 当前监控状态；null = 还没读过。 */
  status: HarvestStatus | null
  /** 执行一个动作。 */
  run: (action: HarvestAction) => Promise<void>
}

/**
 * 原图自动收割的状态与动作。
 * @param notify - 通知回调（成功/失败都走它，失败明细作为 `items` 传）。
 * @returns 状态与 `run`。
 */
export function useOriginalHarvest(notify: HarvestNotify): OriginalHarvestState {
  const [busy, setBusy] = useState<HarvestAction | null>(null)
  const [result, setResult] = useState<HarvestResult | null>(null)
  const [status, setStatus] = useState<HarvestStatus | null>(null)

  const run = useCallback(async (action: HarvestAction): Promise<void> => {
    setBusy(action)
    setResult(null)
    // 手动收割要 69 秒（本机 1,459 个 `_h.dat`）：期间每 1.5 秒读一次进度，
    // 否则界面只能显示「收割中…」干等一分钟，用户会以为卡死了。
    // 走 `apiGetOriginalHarvestStatus`（普通队列）而不是 `originalHarvest('status')`
    // —— 后者会被归成重任务，而收割本身占着唯一的重任务槽，读进度会被拒。
    let poll: ReturnType<typeof setInterval> | undefined
    if (action === 'now') {
      poll = setInterval(() => {
        void apiGetOriginalHarvestStatus().then(setStatus).catch(() => { /* 轮询失败不影响主流程 */ })
      }, 1500)
    }
    try {
      const r = await apiOriginalHarvest(action)
      if (action === 'start' || action === 'now') {
        const res = r as HarvestResult
        setResult(res)
        // 收割写的是解码缓存的主槽，而内存里那份 LRU 很可能还是旧缩略图（跨面板不失效）
        // —— 不清的话用户切回会话看到的仍是糊的，「收割成功」看起来像没发生。
        if (res.harvested > 0) forgetAllImages()
        notify(res.failed === 0 ? 'ok' : 'err',
          `${action === 'start' ? '已启动自动收割' : '收割完成'}：${res.harvested} 张原图`
          + (res.failed > 0 ? `，失败 ${res.failed}` : ''),
          res.errors.map((e) => `${e.file} — ${e.error}`))
      } else {
        notify('ok', '已停止自动收割')
      }
      setStatus(await apiGetOriginalHarvestStatus())
    } catch (e) {
      notify('err', (e as Error).message)
    } finally {
      if (poll !== undefined) clearInterval(poll)
      setBusy(null)
    }
  }, [notify])

  /**
   * 面板挂载时读一次状态。
   *
   * 为什么需要：监控跑在**后端进程**里（`utilityProcess`，不随面板卸载），但前端状态是
   * 组件内的 `useState` —— 退出设置再进来会重新挂载，`status` 回到 null，界面就显示成
   * 「点开启自动收割后…」，看起来像「退出设置就停了」。实际后端一直在监控。
   */
  useEffect(() => {
    void apiGetOriginalHarvestStatus()
      .then(setStatus)
      .catch(() => { /* 读不到就保持 null，界面显示引导文案 */ })
  }, [])

  return { busy, result, status, run }
}
