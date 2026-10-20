/**
 * 「微信原图自动下载（实验）」设置行（挂在设置 → 图片解码卡片里）。
 *
 * ## 它是什么
 *
 * 本仓库原有三条原图通路（本机 `_h.dat` 重解 / 免登录直链 / 第三方服务）都覆盖不了
 * 「本机只有缩略图、XML 只有 `cdnbigimgurl`」的那部分。微信自己其实能下载原图（默认只下缩略图），
 * 本功能复用上游 WeFlow-X（MIT）的 `img_helper.dll`，注入正在运行的微信进程，让微信
 * **在接收新图片时**按原图下载。本应用自己不发任何网络请求、不接触登录凭据。
 *
 * ## 为什么单独一个组件
 *
 * `settings-steps.tsx` 只负责摆 UI、状态留在面板；这个功能的状态是**自包含**的
 * （组件挂载即读 `wechatImageAutoDownload('status')`，5s 轮询），不需要往
 * `useSettingsState` 里再塞状态（那个函数已经贴着行数棘轮）。
 *
 * ## 为什么默认关闭 + 文案必须直白
 *
 * 它会**修改微信进程内存**：只影响开启之后新收到的图片；历史图片不会补下载；应用崩溃时
 * 微信可能保持被修改状态直到重启（`cleanupUnconfirmed` 会如实提示）。这类副作用必须由
 * 用户显式打开，不能靠缺省值悄悄生效。
 *
 * 仅桌面端：`wechatImageAutoDownload` 在 `http-remote-policy.js` 里归「凭据/配置」A 族，
 * 手机/浏览器态没有本机微信进程；设置面板本身也是桌面专属（见门控台账 `remote-action-gating`）。
 */
import { useCallback, useEffect, useState } from 'react'

import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { clsx } from 'clsx'
import type { WechatImageAutoDownloadStatus } from '@deepseek-ai/dsh-wechat-data/types'

import { apiWechatImageAutoDownload } from '../api.ts'
import { css } from './settings-css.ts'

/** 状态轮询间隔（等待微信启动 / 进程重启恢复都靠它）。 */
const POLL_MS = 5000

/** 把状态快照翻成一句人话（界面只显示这一行）。 */
function statusText(status: WechatImageAutoDownloadStatus | null): string {
  if (status === null) return '读取状态中…'
  if (status.supported !== true) return '当前系统不支持（仅 Windows x64，且安装包需包含原图下载组件）'
  if (status.cleanupUnconfirmed) return `⚠️ ${status.message === '' ? '上次退出未确认清理：请先重启微信，再重新开启' : status.message}`
  if (status.enabled !== true) {
    return '未开启 · 开启后由微信自己下载新收到的图片原图（只影响开启之后收到的图片，历史图片仍需在微信里点开）'
  }
  if (status.state === 'running' && status.pid !== null) {
    return `✅ 已接入微信（pid ${String(status.pid)}）· 之后在下载范围内收到的图片，微信会自动下载原图`
  }
  if (status.state === 'waiting_wechat') return '已开启，等待微信启动…'
  if (status.state === 'starting') return '正在接入微信…'
  if (status.state === 'stopping') return '正在关闭并还原微信进程…'
  if (status.state === 'failed') {
    return `⚠️ ${status.code === '' ? '' : status.code + '：'}${status.message === '' ? '操作失败' : status.message}`
  }
  return '已开启，准备接入微信…'
}

/** 行内提示：只在用户刚操作/出错时显示。 */
type RowMessage = { kind: 'ok' | 'err'; text: string } | null

/**
 * 「微信原图自动下载」开关行（自带状态轮询，不依赖面板状态）。
 * @returns 两行：开关行 + 状态行。
 */
export function ImageAutoDownloadCard(): React.JSX.Element {
  const [status, setStatus] = useState<WechatImageAutoDownloadStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<RowMessage>(null)

  useEffect(() => {
    let alive = true
    const load = (): void => {
      void apiWechatImageAutoDownload('status')
        .then((next) => { if (alive) setStatus(next) })
        .catch(() => { /* 读不到就保持上一帧，状态行会显示「读取状态中…」 */ })
    }
    load()
    const timer = setInterval(load, POLL_MS)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [])

  const toggle = useCallback(async (): Promise<void> => {
    setBusy(true)
    setMsg(null)
    try {
      const next = status?.enabled !== true
      const updated = await apiWechatImageAutoDownload(next ? 'start' : 'stop')
      setStatus(updated)
      setMsg({
        kind: 'ok',
        text: next
          ? '已开启：之后新收到的图片由微信自己下载原图（历史图片仍需在微信里点开）'
          : '已关闭：已请求还原微信进程',
      })
    } catch (e) {
      setMsg({ kind: 'err', text: e instanceof Error ? e.message : String(e) })
    } finally {
      setBusy(false)
    }
  }, [status])

  const enabled = status?.enabled === true
  const blocked = busy || status === null || status.supported !== true || status.cleanupUnconfirmed

  return (
    <>
      <div className={css.row}>
        <span className={css.rowName}>微信原图自动下载</span>
        <span
          className={css.rowMeta}
          title="实验功能：把上游 WeFlow-X（MIT）的 img_helper.dll 注入正在运行的微信进程，让微信在接收新图片时按原图下载。
只影响开启之后收到的图片（历史图片仍需在微信里点开）；本应用自己不联网、不碰登录凭据，但会修改微信进程内存，关闭/退出时会请求还原。
默认关闭。"
        >
          实验：微信自己下载新图片的原图（只影响之后收到的图片，会修改微信进程内存）
        </span>
        <Button
          size="sm"
          variant={enabled ? 'outline' : 'primary'}
          className={clsx(css.btnFx, css.btnFixed)}
          onClick={() => { void toggle() }}
          disabled={blocked}
        >
          {busy ? '处理中…' : enabled ? '关闭并还原' : '开启'}
        </Button>
      </div>
      <div className={css.row}>
        <span className={css.rowNote}>
          {statusText(status)}
          {msg !== null ? ` · ${msg.kind === 'ok' ? '✅' : '⚠️'} ${msg.text}` : ''}
        </span>
      </div>
    </>
  )
}
