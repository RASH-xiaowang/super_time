/**
 * 「文件」页头的一键批量动作按钮。
 *
 * 按钮本身不判断候选：候选、出网数量与确认文案在 `use-kb-batch-actions`。
 * 这里只处理一个视觉与语义边界：批量任务进行中时禁用两个入口，并让当前动作的
 * 按钮说明它正在跑，避免用户重复点击启动第二条队列。
 *
 * @module kb-batch-actions
 */
import { useState } from 'react'
import { Button } from '../ui/kit.tsx'
import { desktopAction } from '../ui/desktop-only.tsx'
import type { KbBatchRun } from './kb-batch-jobs.ts'
import { useMenuDismiss } from './use-menu-dismiss.ts'
import css from './kbfiles.module.css'

export interface KbBatchActionButtonsProps {
  /** 当前队列；`null` = 从未启动。 */
  run: KbBatchRun | null
  /** 正在执行的文件 id；非空即整轮仍忙。 */
  runningId: number | null
  /** 语义索引也在出网时，批量入口跟着禁用，避免同时打满模型通道。 */
  indexing: boolean
  onSummaries: () => void
  onEntities: () => void
}

/**
 * 两个批量按钮。
 * @param props - 队列状态与点击回调。
 * @returns 两个 ghost 按钮。
 */
export function KbBatchActionButtons({
  run, runningId, indexing, onSummaries, onEntities,
}: KbBatchActionButtonsProps): React.JSX.Element {
  const busy = runningId !== null || indexing
  return (
    <>
      <Button
        variant="ghost"
        onClick={onSummaries}
        disabled={busy}
        title="为还没有摘要、且允许出网的文件依次生成摘要（会出网）"
      >
        {runningId !== null && run?.action === 'summary' ? '批处理中…' : '批量摘要'}
      </Button>
      <Button
        variant="ghost"
        onClick={onEntities}
        disabled={busy}
        title="为所有允许出网的文件依次提取实体，并同步到知识图谱（会出网）"
      >
        {runningId !== null && run?.action === 'entities' ? '批处理中…' : '批量实体'}
      </Button>
    </>
  )
}

export interface KbToolsMenuProps extends KbBatchActionButtonsProps {
  /** 文件列表刷新是否在途。 */
  loading: boolean
  /** 建/补齐语义索引。 */
  onIndex: () => void
  /** 重新读取文件列表与索引状态。 */
  onRefresh: () => void
}

/**
 * 知识库文件页的低频工具菜单。
 *
 * 页头只留「添加文件」一个主操作；语义索引、批量摘要、批量实体和刷新都属于低频或
 * 有出网后果的动作，收进这里后不再与主操作抢同一行。菜单用条件渲染，关闭时不把
 * 业务文案留在 DOM 里（响应式审计会把它误判成被隐藏的内容）。
 * @param props - 批量队列、索引入口与刷新回调。
 * @returns 页头「文档工具」菜单。
 */
export function KbToolsMenu({
  run, runningId, indexing, loading, onSummaries, onEntities, onIndex, onRefresh,
}: KbToolsMenuProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const { rootRef, triggerRef } = useMenuDismiss(open, () => { setOpen(false) })
  const busy = runningId !== null || indexing
  const desktopOnly = desktopAction()

  const runAndClose = (action: () => void): void => {
    setOpen(false)
    action()
  }

  return (
    <div className={css.toolsMenu} ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className={css.toolsTrigger}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => { setOpen(value => !value) }}
      >
        文档工具 ▾
      </button>
      {open && (
        <div className={css.toolsPanel} role="menu" aria-label="知识库文档工具">
          <button
            type="button"
            role="menuitem"
            className={css.toolsItem}
            autoFocus
            disabled={busy || desktopOnly}
            title={desktopOnly
              ? '语义索引需要桌面端本地能力；当前视图不可用'
              : busy
                ? '批量任务或索引构建进行中，完成后可再次操作'
                : '把本库参与语义检索的文件正文发给向量模型，建/补齐向量索引（会出网）'}
            onClick={() => { runAndClose(onIndex) }}
          >
            <span>{indexing ? '建索引中…' : '语义索引'}</span>
            <span className={css.toolsHint}>{desktopOnly ? '仅电脑' : '会出网'}</span>
          </button>
          <button
            type="button"
            role="menuitem"
            className={css.toolsItem}
            disabled={busy || desktopOnly}
            onClick={() => { runAndClose(onSummaries) }}
          >
            <span>{runningId !== null && run?.action === 'summary' ? '批处理中…' : '批量摘要'}</span>
            <span className={css.toolsHint}>{desktopOnly ? '仅电脑' : '会出网'}</span>
          </button>
          <button
            type="button"
            role="menuitem"
            className={css.toolsItem}
            disabled={busy || desktopOnly}
            onClick={() => { runAndClose(onEntities) }}
          >
            <span>{runningId !== null && run?.action === 'entities' ? '批处理中…' : '批量实体'}</span>
            <span className={css.toolsHint}>{desktopOnly ? '仅电脑' : '会出网'}</span>
          </button>
          <div className={css.toolsDivider} role="separator" />
          <button
            type="button"
            role="menuitem"
            className={css.toolsItem}
            disabled={loading}
            onClick={() => { runAndClose(onRefresh) }}
          >
            <span>{loading ? '读取中…' : '刷新文件列表'}</span>
          </button>
        </div>
      )}
    </div>
  )
}
