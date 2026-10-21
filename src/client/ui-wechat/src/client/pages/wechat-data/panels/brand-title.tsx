/**
 * 侧栏品牌位的**当前用户昵称**（2026-10-21）。
 *
 * 用户要求把原来写死的 `Super Time` 换成自己的网名/昵称。数据源见
 * `query/self-profile.ts`（只读 `contact.db` 的自己那一行）。
 *
 * 三条纪律：
 *  1. 取不到名字**必须回退品牌名** `Super Time`（不能出现空标题）；
 *  2. 模块级缓存一次，避免导航栏常驻组件在切页签时反复打 Remote（与 `BrandAvatar` 同一做法）；
 *  3. 名字很长时靠 CSS 省略号截断，`title` 里保留完整文本（含品牌名，便于认出这是什么应用）。
 * 独立成文件而不是塞进 `WechatDataPanel.tsx`：后者已 947 行，受「单文件 ≤1000 行」棘轮约束。
 */
import { useEffect, useState } from 'react'
import { apiGetSelfProfile } from '../api.ts'
import css from '../wechat-data.module.css'

/** 品牌名兜底（与窗口标题/关于页同一口径）。 */
export const BRAND_NAME = 'Super Time'

/** 会话级缓存：`null` 表示还没取过；空串表示取过但没拿到（别再打 Remote）。 */
let cachedName: string | null = null

/**
 * 品牌位文本：有昵称显示昵称，否则显示品牌名。
 * @returns 一个 `navBrandName` span（结构沿用原写死版本，CSS 不变）。
 */
export function BrandTitle(): React.JSX.Element {
  const [name, setName] = useState<string>(cachedName ?? '')
  useEffect(() => {
    if (cachedName !== null) return
    let cancelled = false
    void (async (): Promise<void> => {
      try {
        const p = await apiGetSelfProfile()
        const next = (p?.name ?? '').trim()
        cachedName = next
        if (!cancelled) setName(next)
      } catch {
        cachedName = ''
      }
    })()
    return () => { cancelled = true }
  }, [])
  const text = name || BRAND_NAME
  return (
    <span className={css.navBrandName} title={text === BRAND_NAME ? BRAND_NAME : `${text} · ${BRAND_NAME}`}>
      {text}
    </span>
  )
}
