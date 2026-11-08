import type { WechatLlmConfig, WechatLlmProfile } from '../api.ts'
import css from './ai-model.module.css'

/** 「上次使用」的相对时间：比时间戳更易读。 */
export function usedText(ts: number): string {
  if (!ts) return '从未切换使用'
  const days = Math.floor((Date.now() - ts) / 86_400_000)
  if (days <= 0) return '今天使用过'
  if (days === 1) return '昨天使用过'
  return `${days} 天前使用过`
}

export interface ProfilesQuickSwitchProps {
  profiles: WechatLlmProfile[]
  activeProfileId: string
  profileBusy: boolean
  draftNew: boolean
  cfg: WechatLlmConfig | null
  onSwitch: (profile: WechatLlmProfile) => void
  onRemove: (profile: WechatLlmProfile) => void
  onStartNew: () => void
  onCancelNew: () => void
}

/**
 * 已保存配置切换区。
 *
 * 切换是“立即写盘并生效”，编辑下方草稿则要显式保存；两者用不同容器分开，
 * 避免把配置卡误认为表单的一部分。芯片绝不渲染 API Key。
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
    <section className={css.profileBlock} data-llm-profiles="" aria-labelledby="llm-profiles-title">
      <div className={css.profileHead}>
        <div className={css.profileHeading}>
          <span className={css.sectionKicker}>配置切换</span>
          <h2 className={css.profileTitle} id="llm-profiles-title">已保存的连接</h2>
          <p className={css.profileHint}>点击卡片立即切换，下一次提问立即生效；下方编辑区只修改当前草稿。</p>
        </div>
        <span className={css.profileCount}>{profiles.length} 套配置</span>
      </div>

      <div className={css.profileList}>
        {profiles.map((profile) => {
          const active = profile.id === activeProfileId
          return (
            <div key={profile.id} className={css.profileChip} data-active={active || undefined}>
              <button
                type="button"
                className={css.profilePick}
                data-activate-llm-profile={profile.id}
                onClick={() => { onSwitch(profile) }}
                disabled={profileBusy || active}
                aria-current={active || undefined}
                title={active
                  ? `当前使用中：${profile.provider} / ${profile.model}`
                  : `切换到「${profile.label}」（${profile.provider} / ${profile.model}），下一次提问立即生效`}
              >
                <span className={css.profileDot} aria-hidden="true" />
                <span className={css.profileLabel}>{profile.label}</span>
                <span className={css.profileModel}>{profile.model || '（缺模型名）'}</span>
                <span className={css.profileState}>{active ? '使用中 · 点击下方编辑' : usedText(profile.usedAt)}</span>
              </button>
              {profiles.length > 1 && (
                <button
                  type="button"
                  className={css.profileDel}
                  data-delete-llm-profile={profile.id}
                  disabled={profileBusy}
                  onClick={() => { onRemove(profile) }}
                  title={`删除配置「${profile.label}」（会一起删掉存在里面的 API Key）`}
                  aria-label={`删除配置 ${profile.label}`}
                >
                  ×
                </button>
              )}
            </div>
          )
        })}

        {draftNew ? (
          <button
            type="button"
            className={`${css.profileAddCard} ${css.profileDraftCard}`}
            data-cancel-new-profile=""
            disabled={profileBusy}
            onClick={onCancelNew}
          >
            <span className={css.profileAddIcon} aria-hidden="true">×</span>
            <span className={css.profileAddTitle}>取消新建</span>
            <span className={css.profileAddHint}>当前草稿尚未保存</span>
          </button>
        ) : (
          <button
            type="button"
            className={css.profileAddCard}
            data-add-llm-profile=""
            disabled={profileBusy || !cfg}
            onClick={onStartNew}
            title="以当前配置为起点新建一份配置；不会覆盖现有配置"
          >
            <span className={css.profileAddIcon} aria-hidden="true">＋</span>
            <span className={css.profileAddTitle}>新建配置</span>
            <span className={css.profileAddHint}>保留现有配置，另存一套</span>
          </button>
        )}
      </div>

      {profiles.length === 0 && (
        <span className={css.profileEmpty}>还没有保存过配置：填好下方表单并保存，就会出现第一张配置卡。</span>
      )}
    </section>
  )
}
