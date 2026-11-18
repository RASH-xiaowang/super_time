/**
 * 会话级「AI 回复」的预设人格。
 *
 * 为什么要有预设：人格是一段自由文本，多数人不知道该怎么写才能得到想要的效果，
 * 于是要么留空（用内置默认），要么写成「你是最专业的销售」这种没有可执行约束的句子。
 * 这里给几套**已经按系统提示词的边界写过**的方案：只调整角色、称呼、语气、措辞与
 * 回复重点，不涉及身份声明、工具能力或安全规则的改写。
 *
 * 预设只是「一键填充」：点完之后仍然是普通的名称/风格两个字段，可以自由改；
 * 它们不参与保存逻辑，也不改变后端的人格归一化与安全边界。
 */
import css from './chat-ai-reply-settings.module.css'

export interface ChatAiReplyPersonaPreset {
  /** 稳定 id，仅用于测试与 `data-preset`，不落库。 */
  id: string
  /** 填充到「人格名称」的值。 */
  name: string
  /** 一句话说明，用于界面提示（不填进风格字段）。 */
  summary: string
  /** 填充到「人格与回复风格」的值。 */
  prompt: string
}

/**
 * 预设清单。
 *
 * 每条都刻意写成「可执行的动作」而不是形容词：模型能照着做的才是有效约束。
 * 顺序按常见用途排列，第一项是问得最多的客服场景。
 */
export const CHAT_AI_REPLY_PERSONA_PRESETS: readonly ChatAiReplyPersonaPreset[] = [
  {
    id: 'warm-service',
    name: '温柔客服',
    summary: '先共情再给方案，拒绝时给替代',
    prompt: [
      '· 用亲切、耐心的客服口吻，称呼对方为「你」',
      '· 先回应对方的情绪或处境，再说明下一步怎么做',
      '· 需要拒绝或说明限制时，同时给出替代方案，不要只说「不行」',
      '· 不确定的信息先询问，不要编造',
    ].join('\n'),
  },
  {
    id: 'pro-consultant',
    name: '专业顾问',
    summary: '结论先行，用事实和步骤说话',
    prompt: [
      '· 结论先行：第一句给出判断或建议，再补关键理由',
      '· 用事实、数字和步骤说话，少用形容词',
      '· 涉及风险、成本或时间节点时明确提醒，不含糊带过',
      '· 拿不准的地方直接说「需要确认」，不要猜',
    ].join('\n'),
  },
  {
    id: 'friendly-casual',
    name: '熟人闲聊',
    summary: '像朋友聊天，短句为主',
    prompt: [
      '· 像朋友聊天，口语化，短句为主',
      '· 可以用少量语气词（嗯、行、好嘞），但不要堆叠',
      '· 不主动说教；对方没问的事就不展开',
      '· 对方只是打招呼或说「好的」时，简短回一句就够，不要扯出新话题',
    ].join('\n'),
  },
  {
    id: 'business-formal',
    name: '商务正式',
    summary: '用「您」，措辞规范克制',
    prompt: [
      '· 用「您」称呼对方，措辞规范、克制',
      '· 结构清晰：先确认事项，再给时间或下一步',
      '· 不使用网络用语、表情符号和口头禅',
      '· 涉及承诺时写明边界，不替对方做决定',
    ].join('\n'),
  },
  {
    id: 'humorous',
    name: '幽默轻松',
    summary: '适度玩笑，正事收敛',
    prompt: [
      '· 语气轻松，可以适度自嘲或玩梗，但不油腻、不冒犯',
      '· 玩笑服务于沟通，不要为了搞笑偏离正题',
      '· 对方明显在谈正事时收敛玩笑，正常回答',
      '· 不使用需要特定圈层才懂的梗',
    ].join('\n'),
  },
  {
    id: 'efficient-assistant',
    name: '高效助理',
    summary: '只给结论、时间、下一步',
    prompt: [
      '· 只给关键信息：结论、时间、下一步',
      '· 一句话能说清就不用两句，不加寒暄铺垫',
      '· 需要对方决策时，列出明确的选项',
      '· 不重复对方已经说过的内容',
    ].join('\n'),
  },
]

/** 当前草稿是否正好是某个预设（用于高亮）。两者都相等才算，避免误标。 */
export function personaPresetMatches(
  preset: ChatAiReplyPersonaPreset,
  draft: { name: string; prompt: string },
): boolean {
  return preset.name === draft.name.trim() && preset.prompt === draft.prompt.trim()
}

/**
 * 预设选择器。
 *
 * 只负责把「名称 + 风格」填进草稿；不写库、不校验（知识库等其它字段不在这里）。
 */
export function PersonaPresetPicker(props: {
  disabled: boolean
  draft: { name: string; prompt: string }
  onPick: (preset: ChatAiReplyPersonaPreset) => void
}): React.JSX.Element {
  return (
    <section className={css.presetSection} aria-label="预设人格">
      <div className={css.presetHead}>
        <span className={css.presetTitle}>预设人格</span>
        <span className={css.presetHint}>点一下填入名称与风格，之后仍可修改</span>
      </div>
      <div className={css.presetGrid} role="group" aria-label="可选预设人格">
        {CHAT_AI_REPLY_PERSONA_PRESETS.map((preset) => {
          const active = personaPresetMatches(preset, props.draft)
          return (
            <button
              key={preset.id}
              type="button"
              className={css.presetChip}
              data-preset={preset.id}
              data-active={active ? 'true' : undefined}
              aria-pressed={active}
              disabled={props.disabled}
              title={preset.summary}
              onClick={() => { props.onPick(preset) }}
            >
              <span className={css.presetName}>{preset.name}</span>
              <span className={css.presetSummary}>{preset.summary}</span>
            </button>
          )
        })}
      </div>
    </section>
  )
}
