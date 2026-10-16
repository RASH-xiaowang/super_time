/**
 * 方块图（treemap）舞台：世界地图面板的「没有地理底图」兜底视图。
 *
 * 从 `WorldMap.tsx` 里整块搬出来的 —— 它是面板里最长的一段 JSX（原来的
 * `WorldMapPanel` 因此顶穿了 250 行的单函数棘轮）。搬出来后这一块自带
 * 舞台骨架（`MapStage` + 两侧头像栏），只在 `showTreemap` 为真时挂载。
 *
 * 为什么保留方块图而不是全删：世界层要的是真地图，但省/市两级在
 * ECharts（或 GeoJSON）起不来时仍需一个能看能点的视图 —— 地理 SVG 已移除，
 * 方块图是唯一不依赖出网的兜底。
 *
 * 这里不做取数与派生（`slots` / `children` / `box` 都由父层算好传进来），
 * 只负责画和响应点击，避免把 `useEffect` 与 `ResizeObserver` 一起搬乱。
 */
import type { RegionFriend, RegionNode } from '@deepseek-ai/dsh-wechat-data/types'
import { FriendAvatarRail } from './FriendAvatarRail.tsx'
import { MapStage } from './MapStage.tsx'
import css from './world-map.module.css'

/** 一个已定好位置的方块：`node` 是对应节点，`x/y/w/h` 是相对画布的像素矩形。 */
export interface TreemapSlot {
  node: RegionNode
  x: number
  y: number
  w: number
  h: number
}

export interface TreemapStageProps {
  /** 画布容器 ref（父层用它挂 ResizeObserver 量尺寸）。 */
  canvasRef: React.Ref<HTMLDivElement>
  /** 当前层可下钻的子节点。 */
  children: readonly RegionNode[]
  /** 布局好的方块（由父层 squarify 得到）。 */
  slots: readonly TreemapSlot[]
  /** 画布是否已量出尺寸（为 0 时不画空态提示，避免闪一下）。 */
  measured: boolean
  /** 正在悬停/选中的节点，用来高亮方块并在旁展示好友。 */
  hoverCity: RegionNode | null
  /** 面包屑路径，非空时给一个「← 上一级」。 */
  canGoUp: boolean
  /** 点击非叶方块下钻。 */
  onDrill: (node: RegionNode) => void
  onHover: (node: RegionNode | null) => void
  onGoUp: () => void
  leftFriends: readonly RegionFriend[]
  rightFriends: readonly RegionFriend[]
  avatars: Record<string, string>
  /** 好友显示名（父层的 `friendName`）。 */
  nameOf: (f: RegionFriend) => string
}

export function TreemapStage(props: TreemapStageProps): React.JSX.Element {
  const { canvasRef, children, slots, measured, hoverCity, canGoUp, onDrill, onHover, onGoUp } = props
  const { leftFriends, rightFriends, avatars, nameOf } = props
  return (
    <MapStage leftFriends={leftFriends} rightFriends={rightFriends} avatars={avatars}>
      {children.length > 0 && (
        <div ref={canvasRef} className={css.canvas}>
          {slots.map((s) => {
            const isLeaf = s.node.children.length === 0
            const isHovered = hoverCity?.key === s.node.key
            return (
              <button
                key={s.node.key}
                type="button"
                className={css.cell}
                data-leaf={isLeaf || undefined}
                data-hovered={isHovered || undefined}
                style={{ left: s.x, top: s.y, width: s.w, height: s.h }}
                onMouseEnter={() => { if (isLeaf) onHover(s.node) }}
                onClick={() => { if (!isLeaf) onDrill(s.node) }}
                title={`${s.node.name} · ${s.node.count} 位好友`}
              >
                <span className={css.cellName}>{s.node.name}</span>
                <span className={css.cellCount}>{s.node.count}</span>
              </button>
            )
          })}
          {slots.length === 0 && measured && <div className={css.empty}>没有子板块</div>}
          {canGoUp && (
            <button type="button" className={css.backOverlay} onClick={onGoUp}>← 上一级</button>
          )}
        </div>
      )}
      {children.length === 0 && !hoverCity && <div className={css.empty}>没有子板块</div>}

      {hoverCity && hoverCity.friends.length > 0 && (
        <div className={css.friends}>
          <div className={css.friendsHd}>
            <span>{hoverCity.name}</span>
            <span className={css.friendsCount}>{hoverCity.friends.length} 位好友</span>
          </div>
          <div className={css.friendGrid}>
            {hoverCity.friends.map(f => (
              <div key={f.username} className={css.friend} title={`${nameOf(f)}\n${f.username}`}>
                <span className={css.avatarWrap}>
                  {avatars[f.username] ? (
                    <img className={css.avatar} src={avatars[f.username]} alt="" loading="lazy" referrerPolicy="no-referrer" />
                  ) : (
                    <span className={css.avatarFallback}>{nameOf(f).slice(0, 1)}</span>
                  )}
                </span>
                <span className={css.friendLabel}>{nameOf(f)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
      {children.length === 0 && canGoUp && (
        <button type="button" className={css.backOverlay} onClick={onGoUp}>← 上一级</button>
      )}
    </MapStage>
  )
}
