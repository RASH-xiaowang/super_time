import css from './ai-model.module.css'

export interface AiModelSaveBarProps {
  dirty: boolean
  draftNew: boolean
  saving: boolean
  message: { kind: 'ok' | 'err'; text: string } | null
  onSave: () => void
  onDiscard: () => void
}

/** 粘性保存栏：始终把草稿状态和保存动作留在视口内。 */
export function AiModelSaveBar({
  dirty,
  draftNew,
  saving,
  message,
  onSave,
  onDiscard,
}: AiModelSaveBarProps): React.JSX.Element {
  const saveLabel = draftNew ? '保存为新配置' : '保存模型配置'
  const stateText = message?.text
    || (dirty
      ? (draftNew ? '这是一份尚未保存的新配置。' : '当前修改尚未写入模型配置。')
      : '当前配置已保存，下一次请求会直接使用它。')

  return (
    <div className={css.saveDock} data-llm-save-dock="">
      <div
        className={css.saveFeedback}
        data-tone={message?.kind ?? (dirty ? 'draft' : 'ok')}
        role={message?.kind === 'err' ? 'alert' : 'status'}
      >
        <span className={css.saveFeedbackMark} aria-hidden="true">
          {message?.kind === 'err' ? '!' : dirty ? '•' : '✓'}
        </span>
        <span className={css.saveFeedbackText}>{stateText}</span>
      </div>
      <div className={css.saveActions}>
        <button
          type="button"
          className={css.modelGhost}
          onClick={onDiscard}
          disabled={!dirty || saving}
        >
          {draftNew ? '取消新建' : '放弃修改'}
        </button>
        <button
          type="button"
          className={css.modelPrimary}
          data-save-llm=""
          onClick={onSave}
          disabled={saving || !dirty}
        >
          {saving ? '保存中…' : saveLabel}
        </button>
      </div>
    </div>
  )
}
