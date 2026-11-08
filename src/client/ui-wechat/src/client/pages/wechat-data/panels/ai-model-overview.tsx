import { StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { WechatLlmConfig, WechatLlmProfile } from '../api.ts'
import { LlmBalanceButton, LlmProbeButton } from './llm-probe.tsx'
import { hostOfUrl } from './ai-model-templates.ts'
import css from './ai-model.module.css'

export interface AiModelOverviewProps {
  /** 已保存并正在生效的配置。 */
  savedConfig: WechatLlmConfig | null
  /** 当前使用中的配置记录。 */
  activeProfile: WechatLlmProfile | undefined
  /** 当前编辑器草稿；测试连接和余额时使用它。 */
  draftConfig: WechatLlmConfig
  draftNew: boolean
  dirty: boolean
}

/**
 * 当前连接总览。
 *
 * 这里只描述“已经保存并生效”的配置；草稿差异由单独的“未保存修改”标记表达，
 * 避免把尚未保存的模型名误报成当前连接。
 */
export function AiModelOverview({
  savedConfig,
  activeProfile,
  draftConfig,
  draftNew,
  dirty,
}: AiModelOverviewProps): React.JSX.Element {
  const configured = Boolean(savedConfig?.model && savedConfig?.apiUrl)
  const host = hostOfUrl(savedConfig?.apiUrl)
  const keyState = savedConfig?.apiKey ? 'Key 已保存' : '未保存 Key'
  const title = savedConfig?.model || '尚未配置对话模型'
  const provider = savedConfig?.provider || '等待选择供应商'
  const mode = draftNew ? '正在新建配置' : dirty ? '草稿有未保存修改' : '当前配置已保存'

  return (
    <section className={css.overviewCard} data-llm-current="" aria-label="当前模型连接">
      <div className={css.overviewMain}>
        <div className={css.overviewEyebrow}>当前连接</div>
        <div className={css.overviewTitleRow}>
          <span className={css.overviewTitle} title={title}>{title}</span>
          <span className={css.overviewStatus} data-tone={configured ? 'ok' : 'warn'}>
            <StateDot state={configured ? 'done' : 'warning'} />
            {configured ? '使用中' : '待补全'}
          </span>
          {dirty && <span className={css.draftBadge}>{draftNew ? '新配置草稿' : '未保存修改'}</span>}
        </div>
        <div className={css.overviewMeta}>
          <span className={css.overviewProfile} title={activeProfile?.label}>
            配置：{draftNew ? '新建草稿' : activeProfile?.label || '尚未生成'}
          </span>
          <span>供应商：{provider}</span>
          <span>端点：{host || '未设置'}</span>
          <span>{keyState}</span>
        </div>
        <div className={css.overviewFootnote}>
          {mode}。测试与余额使用编辑器草稿；保存后下一次请求立即生效。
        </div>
      </div>
      <div className={css.overviewActions}>
        <LlmProbeButton kind="chat" cfg={draftConfig} label="测试当前草稿" />
        <LlmBalanceButton cfg={draftConfig} />
      </div>
    </section>
  )
}
