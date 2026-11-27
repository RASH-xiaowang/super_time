/** 手动新增消息记录与 Webhook 规则编辑弹窗。 */
import { useEffect, useState } from 'react'
import { Button, Dialog } from '../ui/kit.tsx'
import type { AppsWebhookTarget } from '../../../electron-api.ts'
import { apiAppsWebhookTargets } from '../api-apps.ts'
import type { RecordForm, RuleForm } from './message-list-view.ts'
import css from './message-list.module.css'

/**
 * 「下游 Webhook」候选托管实例。
 *
 * 地址是脱敏的（令牌 `***`）—— 真实 `/webhook/<token>` 由主进程在保存时现取。
 * 拉取失败（浏览器交接态 / 老版本主进程）时返回空数组，界面退化成纯手填，
 * 不阻断规则编辑。
 */
function useWebhookTargets(open: boolean): AppsWebhookTarget[] {
  const [targets, setTargets] = useState<AppsWebhookTarget[]>([])
  useEffect(() => {
    if (!open) return
    let alive = true
    void apiAppsWebhookTargets().then((result) => {
      if (!alive) return
      setTargets(Array.isArray(result.targets) ? result.targets : [])
    })
    return () => { alive = false }
  }, [open])
  return targets
}

/** 实例下拉的标签：可用性写在文字里，避免「选了一个不能用的」。 */
function targetLabel(target: AppsWebhookTarget): string {
  const where = target.maskedUrl === '' ? '未启动' : target.maskedUrl
  const suffix = !target.enabled ? '（已停用）' : target.ready ? '' : '（未就绪）'
  return '席位 ' + String(target.seat) + ' · ' + target.name + ' — ' + where + suffix
}

export function RecordFormDialog(props: {
  form: RecordForm | null
  saving: boolean
  onChange: (form: RecordForm) => void
  onChooseAttachments: () => void
  onRemoveAttachment: (stagedId: string) => void
  onClose: () => void
  onSubmit: () => void
}): React.JSX.Element {
  const form = props.form
  return (
    <Dialog
      open={form !== null}
      onClose={() => { if (!props.saving) props.onClose() }}
      title="手动新增消息记录"
      className={css.dialogWide}
      footer={(
        <div className={css.dialogActions}>
          <Button size="sm" variant="ghost" onClick={props.onClose} disabled={props.saving}>取消</Button>
          <Button size="sm" variant="primary" onClick={props.onSubmit} disabled={props.saving}>
            {props.saving ? '提交中…' : '插入并投递'}
          </Button>
        </div>
      )}
    >
      {form && (
        <div className={css.form}>
          <label className={css.field}>
            <span>会话名</span>
            <input
              className={css.input}
              value={form.chatName}
              onChange={(e) => { props.onChange({ ...form, chatName: e.target.value }) }}
              placeholder="例如：客户群 A"
            />
          </label>
          <label className={css.field}>
            <span>触发对象 <b className={css.required}>*</b></span>
            <input
              className={css.input}
              value={form.targetName}
              onChange={(e) => { props.onChange({ ...form, targetName: e.target.value }) }}
              placeholder="例如：文件传输助手"
            />
          </label>
          <label className={css.field}>
            <span>触发文本</span>
            <textarea
              className={css.textarea}
              rows={4}
              value={form.text}
              onChange={(e) => { props.onChange({ ...form, text: e.target.value }) }}
              placeholder="要发送的回复正文"
            />
          </label>
          <label className={css.field}>
            <span>触发图片 URL（每行一个，可选）</span>
            <textarea
              className={css.textarea}
              rows={3}
              value={form.imageUrls}
              onChange={(e) => { props.onChange({ ...form, imageUrls: e.target.value }) }}
              placeholder="https://… 或 data:image/jpeg;base64,…"
            />
          </label>
          <div className={css.field}>
            <span>本机附件（跨机发送时自动上传到发送端）</span>
            <div className={css.attachmentRow}>
              <Button size="sm" variant="outline" onClick={props.onChooseAttachments} disabled={props.saving || form.stagedAttachments.length >= 9}>
                选择附件
              </Button>
              <span className={css.formHint}>单个 ≤ 20 MB，最多 9 个；附件记录不能同时带正文。</span>
            </div>
            {form.stagedAttachments.length > 0 && (
              <ul className={css.attachmentList}>
                {form.stagedAttachments.map((attachment) => (
                  <li key={attachment.stagedId}>
                    <span className={css.attachmentName} title={attachment.name}>{attachment.name ?? 'attachment.bin'}</span>
                    <button
                      type="button"
                      className={css.attachmentRemove}
                      onClick={() => { if (attachment.stagedId !== undefined) props.onRemoveAttachment(attachment.stagedId) }}
                    >
                      移除
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <label className={css.field}>
            <span>备注</span>
            <textarea
              className={css.textarea}
              rows={2}
              value={form.note}
              onChange={(e) => { props.onChange({ ...form, note: e.target.value }) }}
              placeholder="可选"
            />
          </label>
          <p className={css.formHint}>保存后立即按当前规则尝试投递；没有匹配规则时记录保持“待执行”。</p>
        </div>
      )}
    </Dialog>
  )
}

export function RuleFormDialog(props: {
  form: RuleForm | null
  saving: boolean
  onChange: (form: RuleForm) => void
  onClose: () => void
  onSubmit: () => void
}): React.JSX.Element {
  const form = props.form
  const targets = useWebhookTargets(form !== null)
  const selectedId = form?.appInstanceId ?? ''
  const selected = selectedId === '' ? undefined : targets.find((item) => item.id === selectedId)
  // 托管地址用「实例当前地址」而不是表单里那份：实例重启换端口后，旧记录里的地址
  // 已经过期，展示新的才与保存结果一致。
  const displayUrl = selected?.maskedUrl ?? form?.webhookUrl ?? ''
  const pickTarget = (id: string): void => {
    if (form === null) return
    if (id === '') {
      // 切回手填：清空脱敏串，否则它会被当成真实地址提交（保存必然失败）。
      props.onChange({ ...form, appInstanceId: undefined, webhookUrl: '' })
      return
    }
    const hit = targets.find((item) => item.id === id)
    props.onChange({
      ...form,
      appInstanceId: id,
      webhookUrl: hit?.maskedUrl ?? form.webhookUrl,
    })
  }
  return (
    <Dialog
      open={form !== null}
      onClose={() => { if (!props.saving) props.onClose() }}
      title={form?.id === undefined ? '新增 Webhook 规则' : '编辑 Webhook 规则'}
      className={css.dialogWide}
      footer={(
        <div className={css.dialogActions}>
          <Button size="sm" variant="ghost" onClick={props.onClose} disabled={props.saving}>取消</Button>
          <Button size="sm" variant="primary" onClick={props.onSubmit} disabled={props.saving}>
            {props.saving ? '保存中…' : '保存规则'}
          </Button>
        </div>
      )}
    >
      {form && (
        <div className={css.form}>
          <div className={css.formPair}>
            <label className={css.field}>
              <span>会话名（空 = 任意会话）</span>
              <input
                className={css.input}
                value={form.chatName}
                onChange={(e) => { props.onChange({ ...form, chatName: e.target.value }) }}
                placeholder="例如：客户群 A"
              />
            </label>
            <label className={css.field}>
              <span>触发对象（空 = 任意对象）</span>
              <input
                className={css.input}
                value={form.targetName}
                onChange={(e) => { props.onChange({ ...form, targetName: e.target.value }) }}
                placeholder="例如：张三"
              />
            </label>
          </div>
          <label className={css.field}>
            <span>下游 Webhook 地址 <b className={css.required}>*</b></span>
            <input
              className={css.input}
              value={displayUrl}
              onChange={(e) => { props.onChange({ ...form, webhookUrl: e.target.value }) }}
              placeholder="http://192.168.1.20:8080/reply"
              disabled={form.appInstanceId !== undefined}
              readOnly={form.appInstanceId !== undefined}
            />
          </label>
          <label className={css.field}>
            <span>托管应用环境（可选）</span>
            <select
              className={css.input}
              value={selectedId}
              onChange={(e) => { pickTarget(e.target.value) }}
            >
              <option value="">不使用 —— 手填上面的地址</option>
              {selectedId !== '' && selected === undefined && (
                <option value={selectedId}>实例已删除（请改为手填或另选）</option>
              )}
              {targets.map((target) => (
                <option key={target.id} value={target.id} disabled={!target.usable}>
                  {targetLabel(target)}
                </option>
              ))}
            </select>
            {form.appInstanceId !== undefined ? (
              <span className={css.formHint}>
                地址由该托管实例提供；令牌只在主进程里，实例重启换了端口会自动同步到这条规则。
                要改回手填，选「不使用」。
              </span>
            ) : (
              <span className={css.formHint}>
                {targets.length === 0
                  ? '还没有可用的托管实例；在「应用托管」里新建并启动后，这里会列出它们的 Webhook 地址。'
                  : '选一个已启动的实例，用它的 /webhook 地址作为下游；实例未启动时不可选（端口还没分配）。'}
              </span>
            )}
          </label>
          <label className={css.field}>
            <span>备注</span>
            <textarea
              className={css.textarea}
              rows={2}
              value={form.note}
              onChange={(e) => { props.onChange({ ...form, note: e.target.value }) }}
              placeholder="说明这条规则服务于哪个系统"
            />
          </label>
          <label className={css.checkLine}>
            <input
              type="checkbox"
              checked={form.enabled}
              onChange={(e) => { props.onChange({ ...form, enabled: e.target.checked }) }}
            />
            <span>启用这条规则</span>
          </label>
          <p className={css.formHint}>同一「会话名 + 触发对象」只能有一条规则，重复组合请直接编辑现有规则。</p>
        </div>
      )}
    </Dialog>
  )
}
