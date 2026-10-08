/**
 * 地图「舞台」骨架（2026-09-27）：`左联系人栏 + 地图区 + 提示 + 右联系人栏`。
 *
 * ## 为什么抽出来
 *
 * 这段骨架在 `WorldMap.tsx` 里出现了四次（世界层 / 中国层 / 省层 / 市层），
 * 每次都是同样五件事、只是地图组件与提示文案不同。四份重复除了占行数，
 * 更实际的问题是**改一处忘三处** —— 比如给某个层补 `overlay`、或调栏宽，
 * 很容易只改到眼前那一份。
 *
 * 抽出来还顺带解决了另一件事：`WorldMapPanel` 那个函数顶在
 * `function-size-ratchet` 上限（登记 350 行、只许变小），而这次要加"国家层"
 * 就必须先腾出空间 —— 抽骨架是本轮唯一**净减**行数的动作（其余改动都在加行）。
 *
 * ## 边界
 *
 * 它只认识"骨架"，不认识任何地图语义：地图本体、提示文案、覆盖按钮都由调用方传。
 * 于是 `WorldIsoMap` / `ChinaMap` / `ProvinceMap` / `CityMap` 四者都能套它，
 * 将来换渲染器也不必动这里。
 *
 * @module MapStage
 */

import { FriendAvatarRail } from './FriendAvatarRail.tsx'
import type { RegionFriend } from '@deepseek-ai/dsh-wechat-data/types'
import css from './world-map.module.css'

/** Props：两侧要展示的好友与头像，以及中间那块内容。 */
export interface MapStageProps {
  leftFriends: readonly RegionFriend[]
  rightFriends: readonly RegionFriend[]
  avatars: Record<string, string>
  /** 地图区下方那行提示（可省）。 */
  hint?: string
  /** 中间那块地图内容（地图组件本身；它的 `overlay` 由调用方自己给）。 */
  children: React.ReactNode
}

/**
 * 渲染地图舞台。
 * @param props - 见 `MapStageProps`。
 * @returns 舞台元素。
 */
export function MapStage({ leftFriends, rightFriends, avatars, hint, children }: MapStageProps): React.JSX.Element {
  return (
    <div className={css.stage}>
      <FriendAvatarRail side="left" friends={leftFriends} avatars={avatars} />
      {children}
      {hint !== undefined && <div className={css.mapHint}>{hint}</div>}
      <FriendAvatarRail side="right" friends={rightFriends} avatars={avatars} />
    </div>
  )
}
