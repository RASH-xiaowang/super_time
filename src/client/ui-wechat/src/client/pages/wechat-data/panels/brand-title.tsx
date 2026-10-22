/**
 * 侧栏品牌位的**当前用户昵称与地区**（2026-10-22）。
 *
 * 用户要求把原来写死的 `Super Time` 换成自己的网名/昵称，并把副标题从
 * 产品名「微信数据工作台」改成当前账号的地区。两行共用一份资料快照，
 * 数据源见 `query/self-profile.ts`（只读 `contact.db` 的自己那一行）。
 *
 * 三条纪律：
 *  1. 取不到名字**必须回退品牌名** `Super Time`，取不到地区则回退「微信数据工作台」
 *     （不能出现空标题或空副标题）；
 *  2. 模块级缓存一次，避免导航栏常驻组件在切页签时反复打 Remote（与 `BrandAvatar` 同一做法）；
 *  3. 名字很长时靠 CSS 省略号截断，`title` 里保留完整文本（含品牌名，便于认出这是什么应用）。
 * 独立成文件而不是塞进 `WechatDataPanel.tsx`：后者已 948 行，受「单文件 ≤1000 行」棘轮约束。
 */
import { useEffect, useState } from 'react'
import { apiGetSelfProfile } from '../api.ts'
import css from '../wechat-data.module.css'

/** 品牌名兜底（与窗口标题/关于页同一口径）。 */
export const BRAND_NAME = 'Super Time'

/** 副标题兜底：没有地区资料时仍要说明这是什么应用。 */
export const BRAND_SUBTITLE = '微信数据工作台'

interface BrandProfileView {
  name: string
  region: string
}

/** 会话级缓存：`null` 表示还没取过；空字段表示取过但没拿到（别再打 Remote）。 */
let cachedProfile: BrandProfileView | null = null
let pendingProfile: Promise<BrandProfileView> | null = null

function profileViewOf(profile: { name?: string; region?: string } | undefined): BrandProfileView {
  return {
    name: (profile?.name ?? '').trim(),
    region: (profile?.region ?? '').trim(),
  }
}

/** 读一次本人资料；并发调用共享同一个 Promise，失败按空档案缓存。 */
function loadProfile(): Promise<BrandProfileView> {
  if (cachedProfile !== null) return Promise.resolve(cachedProfile)
  pendingProfile ??= apiGetSelfProfile()
    .then((profile) => {
      cachedProfile = profileViewOf(profile)
      return cachedProfile
    })
    .catch(() => {
      cachedProfile = { name: '', region: '' }
      return cachedProfile
    })
    .finally(() => { pendingProfile = null })
  return pendingProfile
}

/**
 * 品牌位文本：第一行昵称（回退品牌名），第二行地区（回退「微信数据工作台」）。
 * @returns 标题与副标题两个 span（沿用原 `navBrandText` 容器与类名）。
 */
export function BrandTitle(): React.JSX.Element {
  const [profile, setProfile] = useState<BrandProfileView>(
    cachedProfile ?? { name: '', region: '' },
  )
  useEffect(() => {
    if (cachedProfile !== null) return
    let cancelled = false
    void loadProfile().then((next) => {
      if (!cancelled) setProfile(next)
    })
    return () => { cancelled = true }
  }, [])
  const name = profile.name
  const text = name || BRAND_NAME
  const subtitle = profile.region || BRAND_SUBTITLE
  const tooltip = [text, subtitle === BRAND_SUBTITLE ? BRAND_SUBTITLE : `${subtitle} · ${BRAND_NAME}`]
    .filter(Boolean)
    .join(' · ')
  return (
    <>
      <span className={css.navBrandName} title={tooltip}>{text}</span>
      <span className={css.navBrandSub} title={subtitle}>{subtitle}</span>
    </>
  )
}
