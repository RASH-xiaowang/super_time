/** 手动新增消息记录与 Webhook 规则编辑弹窗。 */
import { Button, Dialog } from '../ui/kit.tsx'
import type { RecordForm, RuleForm } from './message-list-view.ts'
import css from './message-list.module.css'

export function RecordFormDialog(props: {
  form: RecordForm | null
  saving: boolean
  onChange: (form: RecordForm) => void
  onClose: () => void
  onSubmit: () => void
}): React.JSX.Element {
  const form = props.form
  return (
    <Dialog
      open={form !== null}
      onClose={() => { if (!props.saving) props.onClose() }}
      title="手动新增消息记录"
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
  return (
    <Dialog
      open={form !== null}
      onClose={() => { if (!props.saving) props.onClose() }}
      title={form?.id === undefined ? '新增 Webhook 规则' : '编辑 Webhook 规则'}
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
              value={form.webhookUrl}
              onChange={(e) => { props.onChange({ ...form, webhookUrl: e.target.value }) }}
              placeholder="http://192.168.1.20:8080/reply"
            />
          </label>
          <label className={css.field}>
            <span>首次触发文本（问候语）</span>
            <textarea
              className={css.textarea}
              rows={3}
              maxLength={4000}
              value={form.greetingText}
              onChange={(e) => { props.onChange({ ...form, greetingText: e.target.value }) }}
              placeholder="例如：您好，已收到，我会尽快处理。留空时使用“你好”。"
            />
            <span className={css.formHint}>
              文本按当前“会话名 + 触发对象”匹配，不同触发对象可以分别设置不同内容。
            </span>
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
