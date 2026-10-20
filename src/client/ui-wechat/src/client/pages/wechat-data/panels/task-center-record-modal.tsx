/**
 * 「任务触发记录」完整内容弹窗（2026-10-19）。
 *
 * 一条触发记录**只有在弹窗里才看得全**：触发时间 / 触发群聊 / 触发对象 / 命中关键词 /
 * 触发文本 / 触发图片（可能多张），再加回调状态与「重新投递」。列表行只放摘要。
 *
 * 三个刻意的实现选择：
 *  ① **手写覆盖层而不是 Radix `Dialog`**：需求要求 `role="dialog"` + `aria-modal` 与
 *     `useEscapeToClose` / `useDialogFocus` 两套钩子；手写层才能把这两组属性写在**源码里**，
 *     并被 `dialog-a11y` 那类守卫追溯到。Esc 走 `escStack`（只让最上层响应：本弹窗之上
 *     还能再叠一层图片放大）；
 *  ② **图片按需批量解码**：记录里只存 `(chatUsername, image.localId)` 引用，弹窗打开才
 *     调 `apiGetImageDataUrlsBatch` 一次取齐；单张失败显示占位而不是整块报错；
 *  ③ **不因后台刷新丢当前记录**：记录由容器按 id 从**最新快照**里解析后传进来；
 *     解析不到时（任务被切换/记录被清理）`record === null`，这里显示「记录已不可用」，
 *     而不是把弹窗静默关掉或显示一条过期副本。
 *
 * @module task-center-record-modal
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  TaskCallbackDispatchResult,
  TaskTriggerCallbackStatus,
  TaskTriggerRecord,
} from '@deepseek-ai/dsh-wechat-data/types'
import { apiGetImageDataUrlsBatch } from '../api-media.ts'
import { Badge, Button, LoadingState, useDialogFocus, useEscapeToClose } from '../ui/kit.tsx'
import { desktopActionProps } from '../ui/desktop-only.tsx'
import { useTransientNotice } from './hooks.tsx'
import {
  callbackStatusMeta,
  dispatchResultText,
  triggerTimeText,
  plainText,
  recordImageCountLabel,
} from './task-center.ts'
import css from './task-center.module.css'
import kitCss from '../ui/kit.module.css'

/**
 * 手写覆盖层的无障碍接线说明：
 * `useDialogFocus` 的第二个参数用**字面量选择器**（不抽常量）——`dialog-a11y.wiring.spec.ts`
 * 是按 `useDialogFocus(…, '[data-st-dialog="x"]')` 这个形状配对宿主与钩子的；抽成常量后
 * 守卫看不见（同一形状在 `task-create-dialog.tsx` 上已经踩过一次）。
 */

/** 一张图片的解码结果（`url` 与 `error` 二者其一）。 */
interface ImageState {
  url?: string
  error?: string
}

/** 弹窗注入依赖。 */
export interface TaskCenterRecordModalProps {
  /** 触发记录 id（用于头部标题兜底与重新投递）。 */
  triggerId: number
  /** 按 id 从最新快照解析出的记录；`null` = 记录已不可用。 */
  record: TaskTriggerRecord | null
  /** 关闭弹窗。 */
  onClose: () => void
  /** 手动重投一条回调（容器调用 `apiDispatchTaskCallback`）。 */
  onDispatch: (triggerId: number) => Promise<TaskCallbackDispatchResult>
}

/**
 * 图片网格：按需解码 + 单张失败占位 + 点击放大。
 * @param props.record - 触发记录（已保证非空）。
 * @param props.onZoom - 点击某张成功解码的图片时打开放大层。
 * @returns 图片网格。
 */
function RecordImages({ record, onZoom }: {
  record: TaskTriggerRecord
  onZoom: (url: string) => void
}): React.JSX.Element {
  const [images, setImages] = useState<Record<number, ImageState>>({})
  // 初值就按「有图 = 正在解码」：SSR / 首帧在 effect 之前渲染，若初值为 false 会把图片位置
  // 画成「解码失败」的占位（谎报一次错误），等 effect 跑起来又变成加载态。
  const [loading, setLoading] = useState(record.images.length > 0)
  const recordRef = useRef(record)
  recordRef.current = record
  const imageCount = record.images.length
  const chatUsername = record.chatUsername

  useEffect(() => {
    const current = recordRef.current
    if (imageCount === 0) {
      setImages({})
      setLoading(false)
      return undefined
    }
    let cancelled = false
    setLoading(true)
    setImages({})
    void apiGetImageDataUrlsBatch(current.images.map((img) => ({ username: current.chatUsername, localId: img.localId })))
      .then((rows) => {
        if (cancelled) return
        const next: Record<number, ImageState> = {}
        for (const row of rows) {
          next[row.localId] = row.url !== undefined && row.url !== ''
            ? { url: row.url }
            : { error: row.error !== undefined && row.error !== '' ? row.error : '图片解码失败' }
        }
        setImages(next)
      })
      .catch((e: unknown) => {
        if (cancelled) return
        const message = (e as Error).message
        const failed: Record<number, ImageState> = {}
        for (const img of current.images) failed[img.localId] = { error: message }
        setImages(failed)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
    // 依赖只取「记录身份 + 图片数 + 会话」：同一条记录的后台刷新会换数组身份，
    // 若把它放进依赖，每约 10 秒就会把已解码的图片全部重取一遍。
  }, [record.id, imageCount, chatUsername])

  if (loading) return <LoadingState variant="compact" label="正在解码触发图片…" />
  return (
    <div className={css.imageGrid}>
      {record.images.map((img) => {
        const state = images[img.localId]
        const title = `发送者 ${img.sender} · ${triggerTimeText(img.createTime)}`
        if (state !== undefined && state.url !== undefined) {
          const url = state.url
          return (
            <button
              key={`${String(img.localId)}-${String(img.createTime)}`}
              type="button"
              className={css.imageCell}
              title={`${title}（点击放大）`}
              aria-label={`放大触发图片：${title}`}
              onClick={() => { onZoom(url) }}
            >
              <img className={css.image} src={url} alt={title} loading="lazy" draggable={false} />
            </button>
          )
        }
        return (
          <div key={`${String(img.localId)}-${String(img.createTime)}`} className={css.imageCell} title={title}>
            <span className={css.imageFail}>{state?.error ?? '图片解码失败'}</span>
          </div>
        )
      })}
    </div>
  )
}

/**
 * 触发记录完整内容弹窗。
 * @param props - 记录、关闭与重新投递回调（见 {@link TaskCenterRecordModalProps}）。
 * @returns 弹窗元素。
 */
export function TaskCenterRecordModal({ triggerId, record, onClose, onDispatch }: TaskCenterRecordModalProps): React.JSX.Element {
  const [result, setResult] = useState<TaskCallbackDispatchResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [zoom, setZoom] = useState<string | null>(null)
  const { notice, flash, hold } = useTransientNotice(4000)

  /** Esc 栈：记录弹窗在最下层；图片放大开着时由放大层（后 push）先响应。 */
  useEscapeToClose(true, onClose)
  // 图片放大层打开时**关掉**记录弹窗的焦点环：放大层是它的子节点，两个 Tab 陷阱会互相抢焦点。
  // 选择器写字面量（理由见文件头「手写覆盖层的无障碍接线说明」）。
  useDialogFocus(zoom === null, '[data-st-dialog="task-center-record"]')
  useEscapeToClose(zoom !== null, () => { setZoom(null) })
  useDialogFocus(zoom !== null, '[data-st-dialog="task-center-zoom"]')

  // 换到另一条记录时清掉上一次的投递结果（否则徽标会带着上一条的状态）。
  useEffect(() => { setResult(null) }, [triggerId])

  const redo = useCallback(async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      const r = await onDispatch(triggerId)
      setResult(r)
      if (r.ok) flash(dispatchResultText(r))
      else hold(dispatchResultText(r))
    } catch (e) {
      const failed: TaskCallbackDispatchResult = { ok: false, status: 'failed', error: (e as Error).message }
      setResult(failed)
      hold(dispatchResultText(failed))
    } finally {
      setBusy(false)
    }
  }, [busy, flash, hold, onDispatch, triggerId])

  /** 当前展示的回调状态：本地重投结果优先（后端快照刷新到位后由容器传新记录覆盖）。 */
  const status: TaskTriggerCallbackStatus = result?.status ?? record?.callbackStatus ?? 'skipped'
  const statusMeta = callbackStatusMeta(status)

  return (
    <div
      className={css.modalOverlay}
      role="presentation"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div
        className={css.modal}
        role="dialog"
        aria-modal="true"
        aria-labelledby="task-record-title"
        data-st-dialog="task-center-record"
      >
        <header className={css.modalHd}>
          <span className={css.modalTitle} id="task-record-title">
            {record === null ? '任务触发记录' : `任务触发记录 · ${record.taskName}`}
          </span>
          <button type="button" className={css.modalClose} aria-label="关闭触发记录" onClick={onClose}>×</button>
        </header>

        <div className={css.modalBody}>
          {record === null ? (
            <div className={css.modalSection}>
              <span className={css.modalSectionLabel}>记录已不可用</span>
              <span className={css.modalValue}>
                这条触发记录已不在最新快照里（可能所属任务刚被切换，或记录已被清理）。关闭后重新点开右栏里的记录即可。
              </span>
            </div>
          ) : (
            <>
              <div className={css.modalGrid}>
                <section className={css.modalSection}>
                  <span className={css.modalSectionLabel}>触发时间</span>
                  <span className={css.modalValue}>{triggerTimeText(record.triggeredAt)}</span>
                </section>
                <section className={css.modalSection}>
                  <span className={css.modalSectionLabel}>触发群聊</span>
                  <span className={css.modalValue} title={record.chatUsername}>{record.chatName || '未知会话'}</span>
                </section>
                <section className={css.modalSection}>
                  <span className={css.modalSectionLabel}>触发对象</span>
                  <span className={css.modalValue} title={record.targetUsername}>{record.targetName || '未知对象'}</span>
                </section>
                <section className={css.modalSection}>
                  <span className={css.modalSectionLabel}>任务</span>
                  <span className={css.modalValue}>#{String(record.taskId)} · {record.taskName}</span>
                </section>
              </div>

              <section className={css.modalSection}>
                <span className={css.modalSectionLabel}>命中关键词</span>
                <div className={css.kwRow}>
                  <Badge tone="cyan">{record.keyword}</Badge>
                </div>
              </section>

              <section className={css.modalSection}>
                <span className={css.modalSectionLabel}>触发文本</span>
                <pre className={css.modalText}>{plainText(record.text) === '' ? '（无文本）' : record.text}</pre>
              </section>

              <section className={css.modalSection}>
                <span className={css.modalSectionLabel}>触发图片（{recordImageCountLabel(record.images.length)}）</span>
                {record.images.length === 0
                  ? <span className={kitCss.textMeta}>这条记录没有图片（任务的照片数量为 0，或触发对象附近没有图片）。</span>
                  : <RecordImages record={record} onZoom={(url) => { setZoom(url) }} />}
              </section>

              <div className={css.callbackBar}>
                <div className={css.callbackRow}>
                  <span className={css.modalSectionLabel}>回调状态</span>
                  <Badge tone={statusMeta.tone} title={statusMeta.hint}>{statusMeta.label}</Badge>
                  {record.callbackAt !== undefined && record.callbackAt > 0 && (
                    <span className={kitCss.textMeta}>投递时间 {triggerTimeText(record.callbackAt)}</span>
                  )}
                </div>
                {record.callbackError !== undefined && record.callbackError !== '' && (
                  <div className={css.callbackError}>失败原因：{record.callbackError}</div>
                )}
                {notice !== null && <div className={kitCss.hint} role="status">{notice}</div>}
                <div className={css.callbackRow}>
                  {/* 重投会把触发内容 POST 到用户配置的外部地址（后端 D 族，仅桌面）：手机端禁用。 */}
                  <Button size="sm" variant="outline" disabled={busy} onClick={() => { void redo() }} {...desktopActionProps()}>
                    {busy ? '投递中…' : '重新投递'}
                  </Button>
                  <span className={kitCss.textMeta}>只重发这一条记录，不会重新触发任务。</span>
                </div>
              </div>
            </>
          )}
        </div>

        <div className={css.modalFt}>
          <Button size="sm" variant="outline" onClick={onClose}>关闭</Button>
        </div>
      </div>

      {zoom !== null && (
        <div
          className={css.zoomOverlay}
          role="dialog"
          aria-modal="true"
          aria-label="查看大图"
          data-st-dialog="task-center-zoom"
          onMouseDown={(e) => { if (e.target === e.currentTarget) setZoom(null) }}
        >
          <img className={css.zoomImg} src={zoom} alt="触发图片大图" draggable={false} />
          <button type="button" className={css.zoomClose} aria-label="关闭大图" onClick={() => { setZoom(null) }}>×</button>
        </div>
      )}
    </div>
  )
}
