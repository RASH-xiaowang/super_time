/**
 * 「本会话已编辑消息」浮层（#19 第七刀，自 `chats-view.tsx` 那棵渲染树里切出）。
 *
 * 这一屏只有两行 JSX，但它带着一条**本轮修掉的 bug**：
 * 原先遮罩写的是 `onClick={() => setEditedOpen(false)}`（没有 `e.target === e.currentTarget` 那一判），
 * 于是列表里任何一个动作都会顺手把浮层关掉 —— 点「恢复原文」时事件冒泡到遮罩，
 * 用户看不到"恢复了哪条、还剩几条"，只见到浮层一闪没掉；连选中一行文字都会关。
 * 现在按日历与导出弹窗同一口径来：只有点在遮罩**本身**才关。
 * 另外「恢复原文」在写盘进行中（`editing`）必须锁住，否则两次恢复会打架。
 */
import kitCss from '../ui/kit.module.css'
import type { EditedMessageRecord } from '@deepseek-ai/dsh-wechat-data/types'
import csscards from './chats-cards.module.css'
import cssshell from './chats-shell.module.css'

/** 一行的读数：消息号 + 被改了几次 + 最后一次改动的时间。 */
export function editedRowLabel(rec: EditedMessageRecord): string {
  return `#${rec.localId} · 编辑 ${rec.editCount} 次 · ${new Date(rec.lastEditedAt).toLocaleString()}`
}

export interface ChatsEditedDialogProps {
  doReset: (rec: EditedMessageRecord) => Promise<void>
  editedOpen: boolean
  editing: boolean
  edits: readonly EditedMessageRecord[]
  setEditedOpen: (open: boolean) => void
}

/** 已编辑消息清单（带逐条「恢复原文」）。 */
export function ChatsEditedDialog(props: ChatsEditedDialogProps): React.JSX.Element | null {
  const { doReset, editedOpen, editing, edits, setEditedOpen } = props
  if (!editedOpen) return null
  return (
    <div className={csscards.calOverlay} data-st-dialog="chats-edited"
      onClick={(e) => { if (e.target === e.currentTarget) setEditedOpen(false) }}
      role="dialog" aria-modal="true">
      <div className={csscards.calDialog}>
        <div className={cssshell.calHeader}>
          <span className={csscards.calTitle}>本会话已编辑消息</span>
          <button type="button" className={csscards.calClose} onClick={() => { setEditedOpen(false) }} aria-label="关闭">×</button>
        </div>
        <div className={csscards.calBody}>
          {edits.length === 0 ? (
            <div className={kitCss.emptyInline}>暂无编辑记录（修改仅写入本地解密副本）</div>
          ) : (
            edits.map(rec => (
              <div key={`${rec.sessionId}:${rec.localId}`} className={csscards.editRow}>
                <span className={cssshell.editRowInfo}>{editedRowLabel(rec)}</span>
                <button type="button" className={csscards.editRowAction} onClick={() => { void doReset(rec) }} disabled={editing}>恢复原文</button>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  )
}
