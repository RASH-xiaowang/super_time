/**
 * 数据健康面板的取数与动作（自 `Health.tsx` 抽出）。
 *
 * 拆分动机有两个：
 *   ① `HealthPanel` 已顶到函数尺寸棘轮的登记上限，渲染与取数继续混在一起只会越拆越难；
 *   ② 取数纪律需要在一处说清 —— **同步事件只刷统计**（`loadStats`），逐库
 *      `PRAGMA integrity_check` 是显式动作（`loadIntegrity`），不能被 WAL 推送顺带触发。
 *      体检失败也必须单独成态（`integrityError`），不能吞成 `null` 让界面看起来全绿。
 *
 * 组件的初始状态仍从渲染缓存同步预填，挂载时**不**自动跑体检或全量统计（保留现状）。
 */
import { useCallback, useState } from 'react'
import {
  apiBuildSearchIndex,
  apiCheckDbIntegrity,
  apiDecryptAllDatabases,
  apiGetDbHealth,
  apiGetDbStatus,
  apiGetDecryptStatus,
  apiRepairCorruptDbs,
  readRenderCache,
  writeRenderCache,
} from '../api.ts'
import type { DbHealthSnapshot, DbIntegrityResult, DbStatusSnapshot, DecryptStatus } from '@deepseek-ai/dsh-wechat-data/types'
import { repairNotice } from './repair-notice.ts'

interface HealthRenderCache {
  snap: DbHealthSnapshot | null
  status: DbStatusSnapshot | null
}

export interface HealthPanelActions {
  snap: DbHealthSnapshot | null
  status: DbStatusSnapshot | null
  decrypt: DecryptStatus | null
  integrity: DbIntegrityResult | null
  /** 体检请求本身失败的原因；与「体检结论是坏的」是两件事。 */
  integrityError: string | null
  loading: boolean
  retrying: boolean
  repairing: boolean
  building: boolean
  error: string | null
  /** 手动「重新检查」：统计 + 逐库体检。 */
  load: () => Promise<void>
  /** 同步事件用：只取统计/状态/解密进度，**绝不**触发全库体检。 */
  loadStats: () => Promise<void>
  repair: () => Promise<void>
  retryDecrypt: () => Promise<void>
  rebuild: () => Promise<void>
}

function cachedHealth(): HealthRenderCache | null {
  return readRenderCache<HealthRenderCache>('health')
}

function errorText(e: unknown): string {
  const message = e instanceof Error ? e.message : String(e)
  return message.length > 0 ? message : '未知错误'
}

/**
 * 健康面板的全部取数与动作。
 * @param flash - 公共提示条写入函数（自动消失，见 `hooks.tsx` 的 `useTransientNotice`）。
 * @returns 渲染所需状态与动作。
 */
export function useHealthPanelActions(flash: (s: string) => void): HealthPanelActions {
  const [snap, setSnap] = useState<DbHealthSnapshot | null>(() => cachedHealth()?.snap ?? null)
  const [status, setStatus] = useState<DbStatusSnapshot | null>(() => cachedHealth()?.status ?? null)
  const [loading, setLoading] = useState(false)
  const [building, setBuilding] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** 最近一次解密的失败明细（哪个库、因为什么）。 */
  const [decrypt, setDecrypt] = useState<DecryptStatus | null>(null)
  /** 是否正在重试解密（与「重建索引」「修复」各占一个忙闲闸门，互不干扰）。 */
  const [retrying, setRetrying] = useState(false)
  /**
   * 逐库完整性体检结论。**不进渲染缓存** —— 它是「现在坏没坏」的最新信号，
   * 修完之后缓存里那份旧的「坏 1 个」会把已修好的状态继续说成坏的。
   */
  const [integrity, setIntegrity] = useState<DbIntegrityResult | null>(null)
  /** 体检没跑成（RPC 抛错）的原因；此时 `integrity` 必须置 null，不能当全绿。 */
  const [integrityError, setIntegrityError] = useState<string | null>(null)
  /** 修复（只重解密损坏的那几个）进行中。 */
  const [repairing, setRepairing] = useState(false)

  /**
   * 只取统计：健康快照 + DB 状态 + 解密进度。
   *
   * 这是 WAL 推送唯一允许调用的取数入口。别把 `apiCheckDbIntegrity` 挪进来 ——
   * 本机十个库合计两百多兆，每个同步事件全扫一遍会拖慢同步并长期占用快照句柄。
   */
  const fetchStats = useCallback(async (): Promise<void> => {
    setError(null)
    try {
      const [h, s, d] = await Promise.all([
        apiGetDbHealth(),
        apiGetDbStatus().catch((): null => null),
        apiGetDecryptStatus().catch((): null => null),
      ])
      setSnap(h)
      setStatus(s)
      setDecrypt(d)
      writeRenderCache('health', { snap: h, status: s })
    } catch (e) {
      setError(errorText(e))
    }
  }, [])

  /**
   * 同步事件用的统计刷新。
   *
   * 刻意不碰 `loading`：那个闸门属于手动「重新检查」（按钮文案「检查中…」）。
   * 同步事件很密，若每次都翻闸，按钮会长期停在「检查中…」并反复被禁用。
   */
  const loadStats = useCallback(async (): Promise<void> => {
    await fetchStats()
  }, [fetchStats])

  /**
   * 逐库体检（显式动作）：成功就刷新结论并清掉上次的失败原因；失败则把结论置空、
   * 单独记下原因。**不许**把失败 catch 成 `null` 后继续当「没有损坏」渲染。
   */
  const loadIntegrity = useCallback(async (): Promise<void> => {
    try {
      const result = await apiCheckDbIntegrity()
      setIntegrity(result)
      setIntegrityError(null)
    } catch (e) {
      setIntegrity(null)
      setIntegrityError(errorText(e))
    }
  }, [])

  /**
   * 手动「重新检查」：统计与体检并行，两者各自维护自己的失败态。
   * 忙闲闸门包在两者外层 —— 体检比统计慢时按钮不会提前恢复，避免再点出第二次全库扫描。
   */
  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    try {
      await Promise.all([fetchStats(), loadIntegrity()])
    } finally {
      setLoading(false)
    }
  }, [fetchStats, loadIntegrity])

  /** 重试解密。失败最常见的原因是「库还被微信占着」，重试往往立刻就好。 */
  const retryDecrypt = useCallback(async (): Promise<void> => {
    setRetrying(true)
    try {
      const r = await apiDecryptAllDatabases()
      setDecrypt(await apiGetDecryptStatus())
      flash(r.failed.length === 0
        ? `解密完成：成功 ${String(r.okCount)}/${String(r.total)}`
        : `解密完成：成功 ${String(r.okCount)}/${String(r.total)}，仍有 ${String(r.failed.length)} 个失败`)
    } catch (e) {
      setError(errorText(e))
    } finally {
      setRetrying(false)
    }
  }, [flash])

  /**
   * 修复损坏的库：后端会先体检、只重解密损坏的那几个、再复检。
   *
   * 修完**恰好复检一次**（`loadIntegrity`），然后刷新统计。这里不能再 `await load()`：
   * 那会在复检之外再跑一遍全库 `PRAGMA integrity_check`，白扫一次快照。
   * 提示语文案由 `repairNotice` 统一判定（任务占用 / ok:false / 明细都不会被误报）。
   */
  const repair = useCallback(async (): Promise<void> => {
    setRepairing(true)
    try {
      const r = await apiRepairCorruptDbs()
      await loadIntegrity()
      flash(repairNotice(r))
      await loadStats()
    } catch (e) {
      setError(errorText(e))
    } finally {
      setRepairing(false)
    }
  }, [flash, loadIntegrity, loadStats])

  /** 重建搜索索引；重建期间搜索仍走旧索引，建完只刷统计即可。 */
  const rebuild = useCallback(async (): Promise<void> => {
    setBuilding(true)
    // 重建期间读者读到的是**旧索引**（ROLLBACK 保证），所以要把话说清楚 ——
    // 否则用户以为「正在建」等于「已经更快了」。与 chats 面板那句同一口径。
    flash('正在重建：期间搜索走的是旧索引，可能变慢；建完会自动切到新的')
    try {
      const r = await apiBuildSearchIndex({ force: true })
      // r.message 只在「跳过不可读分片」这类场景出现：有它在就说明索引是残缺的，
      // 不能只报「已完成」，否则用户看到 199 行也说不出哪里不对。
      flash(r.message ? `重建完成：${String(r.rows)} 行索引（${r.message}）` : `重建完成：${String(r.rows)} 行索引`)
      await loadStats()
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBuilding(false)
    }
  }, [flash, loadStats])

  return {
    snap,
    status,
    decrypt,
    integrity,
    integrityError,
    loading,
    retrying,
    repairing,
    building,
    error,
    load,
    loadStats,
    repair,
    retryDecrypt,
    rebuild,
  }
}
