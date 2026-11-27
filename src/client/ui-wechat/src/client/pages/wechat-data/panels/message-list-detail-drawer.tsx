/**
 * 消息记录详情抽屉（只读）。
 *
 * 入口在记录行的状态徽标与回复 ID 上；抽屉本身不接任何 Remote、不渲染重发/
 * 探测/删除等写操作，只做展示与「复制正文 / 复制 sourceRef」两个本地辅助动作。
 * 记录刷新后由父组件按 id 取最新一条重新传入，抽屉内容随事件更新。
 */
import type { MessageListImage, MessageListRecord } from '@deepseek-ai/dsh-wechat-data/types'
import { Badge, Button, Drawer } from '../ui/kit.tsx'
import { copyTextToClipboard } from '../utils/misc.ts'
import { localImageKey, statusTone } from './message-list-view.ts'
import {
  messageListDetailModel,
  type MessageListDetailModel,
} from './message-list-detail.ts'
import { MessageListTraceSection } from './message-list-detail-trace.tsx'
import css from './message-list-detail.module.css'

export interface MessageListDetailDrawerProps {
  /** 当前要展示的记录；null 表示关闭。父组件每次都从最新 records 里按 id 取。 */
  record: MessageListRecord | null
  /** 本机解码图片缓存，与列表行共用。 */
  thumbs: Record<string, string>
  /** 当前规则表里是否已有覆盖这条记录的规则；用于区分「待配置」与「待发送」。 */
  hasRule?: boolean
  onClose: () => void
}

function copyQuietly(text: string): void {
  // 只读辅助动作：复制失败静默，不弹错误、不打断查看。
  void copyTextToClipboard(text)
}

function attachmentSource(
  image: MessageListImage,
  record: MessageListRecord,
  thumbs: Record<string, string>,
): string | undefined {
  if (image.dataUrl !== undefined) return image.dataUrl
  if (image.localId === undefined) return undefined
  return thumbs[localImageKey(record.chatUsername, image.localId)]
}

function attachmentLabel(image: MessageListImage): string {
  if (image.name !== undefined && image.name.trim() !== '') return image.name
  if (image.stagedId !== undefined) return '暂存附件'
  if (image.url !== undefined) return '外链附件'
  if (image.localId !== undefined) return '待解码附件'
  return '附件'
}

function AttachmentList(props: {
  record: MessageListRecord
  images: MessageListImage[]
  thumbs: Record<string, string>
}): React.JSX.Element {
  if (props.images.length === 0) return <p className={css.muted}>—</p>
  return (
    <ul className={css.attachments}>
      {props.images.map((image, index) => {
        const src = attachmentSource(image, props.record, props.thumbs)
        const label = attachmentLabel(image)
        return (
          <li className={css.attachment} key={String(index)}>
            {src === undefined
              ? <span className={css.attachmentChip}>{image.url === undefined ? '待解码' : '外链'}</span>
              : <img className={css.attachmentThumb} src={src} alt={'附件 ' + String(index + 1)} />}
            <span className={css.attachmentName} title={label}>{label}</span>
          </li>
        )
      })}
    </ul>
  )
}

function DetailBody(props: {
  model: MessageListDetailModel
  record: MessageListRecord
  thumbs: Record<string, string>
}): React.JSX.Element {
  const { model, record } = props
  return (
    <div className={css.body}>
      <div className={css.subtitle}>{model.sourceLabel}</div>
      <div className={css.actions}>
        <Button
          size="sm"
          variant="outline"
          disabled={model.text.trim() === ''}
          onClick={() => { copyQuietly(model.text) }}
        >
          复制正文
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={model.sourceRef === ''}
          onClick={() => { copyQuietly(model.sourceRef) }}
        >
          复制 sourceRef
        </Button>
      </div>

      <section className={css.section} aria-label="状态">
        <h3 className={css.sectionTitle}>状态</h3>
        <div className={css.statusLine}>
          <Badge tone={statusTone(record.status)}>{model.statusLabel}</Badge>
        </div>
        {model.statusHint !== '' && <p className={css.hint}>{model.statusHint}</p>}
      </section>

      <section className={css.section} aria-label="正文">
        <h3 className={css.sectionTitle}>正文</h3>
        <div
          className={css.textBox}
          data-empty={model.text.trim() === '' ? 'true' : undefined}
        >
          {model.text.trim() === '' ? '—' : model.text}
        </div>
      </section>

      {model.showFailure && (
        <section className={css.section} aria-label="失败信息">
          <h3 className={css.sectionTitle}>失败信息</h3>
          <div className={css.failure}>
            <div className={css.failureTitle}>{model.failure.title}</div>
            <p className={css.failureDetail}>{model.failure.detail}</p>
            {model.failure.hint !== '' && (
              <p className={css.failureHint}>建议：{model.failure.hint}</p>
            )}
          </div>
        </section>
      )}

      {record.source === 'ai_reply' && <MessageListTraceSection recordId={record.id} />}

      <section className={css.section} aria-label="关键时间">
        <h3 className={css.sectionTitle}>关键时间</h3>
        <dl className={css.times}>
          {model.times.map((item) => (
            <div className={css.timeRow} key={item.label}>
              <dt className={css.itemLabel}>{item.label}</dt>
              <dd className={`${css.itemValue} ${css.timeValue}`}>{item.value}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section className={css.section} aria-label="标识">
        <h3 className={css.sectionTitle}>标识</h3>
        <dl className={css.ids}>
          {model.ids.map((item) => (
            <div className={css.idRow} key={item.label}>
              <dt className={css.itemLabel}>{item.label}</dt>
              <dd className={`${css.itemValue} ${css.idValue}`}>{item.value}</dd>
            </div>
          ))}
          {model.segments !== undefined && (
            <div className={css.idRow}>
              <dt className={css.itemLabel}>分段</dt>
              <dd className={`${css.itemValue} ${css.idValue}`}>
                第 {String(model.segments.index)}/{String(model.segments.count)} 段
                {' · 本段 '}{String(model.segments.total)} 字
              </dd>
            </div>
          )}
          {model.mention !== undefined && (
            <div className={css.idRow}>
              <dt className={css.itemLabel}>提及</dt>
              <dd className={`${css.itemValue} ${css.idValue}`}>
                {model.mention.text}
                {model.mention.hint !== '' && (
                  <span className={css.mentionHint}>{' · '}{model.mention.hint}</span>
                )}
              </dd>
            </div>
          )}
        </dl>
      </section>

      <section className={css.section} aria-label="附件">
        <h3 className={css.sectionTitle}>附件</h3>
        <AttachmentList record={record} images={model.images} thumbs={props.thumbs} />
      </section>

      {model.job !== undefined && (
        <section className={css.section} aria-label="任务">
          <h3 className={css.sectionTitle}>任务</h3>
          <dl className={css.ids}>
            <div className={css.idRow}>
              <dt className={css.itemLabel}>任务 ID</dt>
              <dd className={`${css.itemValue} ${css.idValue}`}>{model.job.id}</dd>
            </div>
            <div className={css.idRow}>
              <dt className={css.itemLabel}>任务状态</dt>
              <dd className={`${css.itemValue} ${css.idValue}`}>{model.job.state}</dd>
            </div>
          </dl>
        </section>
      )}
    </div>
  )
}

export function MessageListDetailDrawer(
  props: MessageListDetailDrawerProps,
): React.JSX.Element {
  const model = props.record === null
    ? null
    : messageListDetailModel(props.record, Date.now(), props.hasRule === true)
  return (
    <Drawer
      open={model !== null}
      onClose={props.onClose}
      title={model === null ? '记录详情' : model.title}
      width={560}
    >
      {model !== null && props.record !== null && (
        <DetailBody model={model} record={props.record} thumbs={props.thumbs} />
      )}
    </Drawer>
  )
}
