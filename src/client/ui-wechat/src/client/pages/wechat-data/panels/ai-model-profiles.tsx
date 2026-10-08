/**
 * 「已配置模型」快速切换条（2026-09-30 从 `AiModelConfig` 拆出，重做时定位为**对话模型的快速切换**）。
 *
 * 为什么单独成文件：主组件有行数棘轮（≤540），而这次重做要把它拆成三个可折叠面板。
 * 这一块本来就是自成一体的（一组已保存配置 + 切换/新增/删除），拆出来顺带让
 * `ai-model-profiles.wiring.spec.ts` 有了明确的判据文件（判据随代码搬，不放宽）。
 *
 * 两条纪律照旧（都在守卫里钉着）：
 *   · **绝不显示 API Key** —— 切换条是随手会看的东西；
 *   · 「使用中」那颗**禁用**（点了没意义，还要防重复写盘），并用 `aria-current` 标出来。
 */
import type { WechatLlmConfig, WechatLlmProfile } from '../api.ts'
import css from './ai-model.module.css'

/** 「上次使用」的相对时间：比一串时间戳更易读，也避免让人以为那是配置时间。 */
export function usedText(ts: number): string {
  if (!ts) return '从未使用'
  const days = Math.floor((Date.now() - ts) / 86_400_000)
  if (days <= 0) return '今天用过'
  if (days === 1) return '昨天用过'
  return `${days} 天前用过`
}

export interface ProfilesQuickSwitchProps {
  /** 已保存的配置集。 */
  profiles: WechatLlmProfile[]
  /** 使用中那条的 id。 */
  activeProfileId: string
  /** 配置集操作进行中（写盘动作要单飞）。 */
  profileBusy: boolean
  /** 是否处于「新增配置」草稿态。 */
  draftNew: boolean
  /** 当前草稿配置（未加载完时为 null，此时禁用"新增"）。 */
  cfg: WechatLlmConfig | null
  /** 切换到某条配置（立即生效，后端每次请求重读 llm.json）。 */
  onSwitch: (p: WechatLlmProfile) => void
  /** 删除某条配置。 */
  onRemove: (p: WechatLlmProfile) => void
  /** 以当前配置为起点新建一份。 */
  onStartNew: () => void
  /** 取消新增草稿。 */
  onCancelNew: () => void
}

/**
 * 渲染快速切换条。
 * @param props - 配置集与四个动作。
 * @returns 切换条元素。
 */
export function ProfilesQuickSwitch({
  profiles,
  activeProfileId,
  profileBusy,
  draftNew,
  cfg,
  onSwitch,
  onRemove,
  onStartNew,
  onCancelNew,
}: ProfilesQuickSwitchProps): React.JSX.Element {
  return (
    <div className={css.profileBlock} data-llm-profiles="">
      <div className={css.profileHead}>
        <span className={css.profileTitle}>快速切换</span>
        <span className={css.profileHint}>
          {profiles.length > 1 ? '点击即切换，下一次提问立即生效' : '再配一家就会有第二颗芯片，可随时切回来'}
        </span>
        <span className={css.profileSpacer} />
        {draftNew ? (
          <button type="button" className={css.profileAdd} data-cancel-new-profile="" disabled={profileBusy} onClick={onCancelNew}>
            取消新增
          </button>
        ) : (
          <button type="button" className={css.profileAdd} data-add-llm-profile="" disabled={profileBusy || !cfg} onClick={onStartNew}
            title="以当前配置为起点新建一份配置；不会覆盖现有配置">
            ＋ 新增配置
          </button>
        )}
      </div>
      <div className={css.profileList}>
        {profiles.map((p) => {
          const active = p.id === activeProfileId
          return (
            <div key={p.id} className={css.profileChip} data-active={active || undefined}>
              <button
                type="button"
                className={css.profilePick}
                data-activate-llm-profile={p.id}
                onClick={() => { onSwitch(p) }}
                disabled={profileBusy || active}
                aria-current={active || undefined}
                title={active
                  ? `当前使用中：${p.provider} / ${p.model}`
                  : `切换到「${p.label}」（${p.provider} / ${p.model}）`}
              >
                <span className={css.profileDot} aria-hidden="true" />
                <span className={css.profileLabel}>{p.label}</span>
                <span className={css.profileModel}>{p.model || '（缺模型名）'}</span>
                <span className={css.profileState}>{active ? '使用中' : usedText(p.usedAt)}</span>
              </button>
              {profiles.length > 1 && (
                <button
                  type="button"
                  className={css.profileDel}
                  data-delete-llm-profile={p.id}
                  disabled={profileBusy}
                  onClick={() => { onRemove(p) }}
                  title={`删除配置「${p.label}」（会一起删掉存在里面的 API Key）`}
                  aria-label={`删除配置 ${p.label}`}
                >
                  ×
                </button>
              )}
            </div>
          )
        })}
        {profiles.length === 0 && (
          <span className={css.profileEmpty}>还没有保存过配置：填好下方表单并保存，就会出现第一颗芯片</span>
        )}
      </div>
    </div>
  )
}
