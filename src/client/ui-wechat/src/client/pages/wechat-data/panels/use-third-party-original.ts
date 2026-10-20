/**
 * 「第三方原图服务」开关与额度（从 `settings-state.tsx` 抽出）。
 *
 * ## 为什么单独一个 hook
 *
 * `useSettingsState` 已 791 行、文件 1030 行，都贴着棘轮上限。这个功能要 3 个状态 +
 * 2 个动作，直接塞进去会同时顶破函数行数与文件行数两条棘轮。
 *
 * ## 这个开关是什么
 *
 * 打开后，本机没有原图时会用消息里的 `cdnbigimgurl` 向 `wxcdn.c3o.re` 请求原图
 * （实测 6/6 成功，拿到 2,751 KB 的真原图）。这是本机数据上**唯一能覆盖那 81.6%** 的通路。
 *
 * ## 为什么默认关闭
 *
 *   · 该服务**不是腾讯官方**，且需要把本机的 `all_users/config/global_config` 发给它；
 *   · **按流量计费**（Free 套餐 50 MB/天），实测下载 2.7 MB 一张就扣 2.7 MB。
 *
 * 这类外发必须由用户显式打开，不能靠缺省值悄悄生效。
 */
import { useCallback, useState } from 'react'
import { apiGetWxcdnQuota, apiSaveWechatConfig } from '../api.ts'
import type { WxcdnQuota } from '@deepseek-ai/dsh-wechat-data/types'

/** 通知函数（与 `useTransientNotice` 的 `notify` 同形）。 */
export type WxcdnNotify = (kind: 'ok' | 'err', text: string) => void

/** {@link useThirdPartyOriginal} 的返回值。 */
export interface ThirdPartyOriginalState {
  /** 开关是否打开。 */
  enabled: boolean
  /** 是否有请求在跑。 */
  busy: boolean
  /** 额度快照；null = 还没查过。 */
  quota: { quota?: WxcdnQuota; error?: string } | null
  /** 切换开关（立即落盘，不等「保存」）。 */
  toggle: () => Promise<void>
  /** 查额度。 */
  refresh: () => Promise<void>
}

/**
 * 第三方原图服务的开关与额度。
 * @param initialEnabled - 初始开关值（从缓存的配置读）。
 * @param notify - 通知回调。
 * @returns 状态与两个动作。
 */
export function useThirdPartyOriginal(initialEnabled: boolean, notify: WxcdnNotify): ThirdPartyOriginalState {
  const [enabled, setEnabled] = useState(initialEnabled)
  const [busy, setBusy] = useState(false)
  const [quota, setQuota] = useState<{ quota?: WxcdnQuota; error?: string } | null>(null)

  const toggle = useCallback(async (): Promise<void> => {
    setBusy(true)
    try {
      const next = !enabled
      await apiSaveWechatConfig({ patch: { wxcdn_original_enabled: next } })
      setEnabled(next)
      notify('ok', next ? '已开启第三方原图服务（按流量计费）' : '已关闭第三方原图服务')
      if (next) setQuota(await apiGetWxcdnQuota())
    } catch (e) {
      notify('err', (e as Error).message)
    } finally {
      setBusy(false)
    }
  }, [enabled, notify])

  const refresh = useCallback(async (): Promise<void> => {
    setBusy(true)
    try {
      setQuota(await apiGetWxcdnQuota())
    } catch (e) {
      setQuota({ error: (e as Error).message })
    } finally {
      setBusy(false)
    }
  }, [])

  return { enabled, busy, quota, toggle, refresh }
}
