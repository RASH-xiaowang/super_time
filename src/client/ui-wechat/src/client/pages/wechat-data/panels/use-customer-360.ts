/**
 * 加载单个客户的 360° 画像快照。
 *
 * 只在选中客户或打开画像抽屉时请求一个 username，避免客户目录为每一行批量打
 * `getContact360`。状态带 username 归属，切换客户时旧响应不会被贴到新客户上。
 */
import { useCallback, useEffect, useState } from 'react'
import type { Contact360Snapshot } from '@deepseek-ai/dsh-wechat-data/types'
import { apiGetContact360 } from '../api.ts'
import { useWechatDataUpdated } from './hooks.tsx'

interface Contact360State {
  username: string | null
  snapshot: Contact360Snapshot | null
  loading: boolean
  error: string | null
}

export function useCustomer360(username: string | null): {
  snapshot: Contact360Snapshot | null
  loading: boolean
  error: string | null
  reload: () => void
} {
  const [nonce, setNonce] = useState(0)
  const [state, setState] = useState<Contact360State>({
    username: null,
    snapshot: null,
    loading: false,
    error: null,
  })
  const reload = useCallback((): void => { setNonce((v) => v + 1) }, [])

  // 页面选中项和已打开的画像抽屉共用这一条订阅：宿主同步新数据后，旧统计会静默
  // 刷新；已有快照时不清空，避免每 10 秒一次的实时同步把画像闪成骨架。
  useWechatDataUpdated(reload)

  useEffect(() => {
    if (username === null || username.trim() === '') {
      setState({ username: null, snapshot: null, loading: false, error: null })
      return
    }
    let alive = true
    setState((prev) => {
      const sameCustomer = prev.username === username
      return {
        username,
        snapshot: sameCustomer ? prev.snapshot : null,
        loading: !sameCustomer || prev.snapshot === null,
        error: null,
      }
    })
    void apiGetContact360(username)
      .then((snapshot) => {
        if (alive) setState({ username, snapshot, loading: false, error: null })
      })
      .catch((error: unknown) => {
        if (!alive) return
        setState((prev) => {
          // 后台刷新失败时保留已画出的快照；只有首次加载失败才把错误交给页面。
          if (prev.username !== username) return prev
          return {
            ...prev,
            loading: false,
            error: prev.snapshot === null ? (error as Error).message : null,
          }
        })
      })
    return () => { alive = false }
  }, [username, nonce])

  const belongsToCurrent = state.username === username
  return {
    snapshot: belongsToCurrent ? state.snapshot : null,
    loading: belongsToCurrent ? state.loading : username !== null && username.trim() !== '',
    error: belongsToCurrent ? state.error : null,
    reload,
  }
}
