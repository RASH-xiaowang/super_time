/**
 * 群成员那一族的**算术**（#19 第五刀，自 `chats-group-info.tsx` 的钩子里再抽一层）。
 *
 * 钩子里这几行看着不起眼，实际管着四件会直接影响可见性的事：
 * ① 搜索词怎么归一（`trim` + 小写 ⇒ 「 张三 」「ZHANGSAN」都能命中，微信号也能搜）；
 * ② 折叠时给多少条、展开时给多少条（24 / 200 —— 与官方客户端的密度对得上）；
 * ③ 「查看更多 / 收起」那颗按钮**该不该出现**（原来搜索态拿"当前上限"当门槛，见 `hasMoreMembers` 的注释）；
 * ④ 悬浮资料卡的落点（左边放不下就翻到右边、上下各留 8px 边距、按视口高度夹住）。
 * 抽出来的理由与日历那一族一样：这些是**不需要 DOM 就能判对错**的规则，
 * 留在钩子里就只能靠"看代码的人自己算对了"。
 */
import type { GroupMember } from '@deepseek-ai/dsh-wechat-data/types'

/** 折叠态一屏给多少位成员（也是「还有没有更多」的门槛）。 */
export const MEMBER_PAGE = 24
/** 展开态的上限：不是无限 —— 千人群一次画完会卡住整屏（审计 P2-4 同源）。 */
export const MEMBER_EXPANDED_PAGE = 200

/** 悬浮资料卡的尺寸与视口边距（宽度参与左右翻转的判断，高度参与上下夹取）。 */
const PROFILE_W = 232
const PROFILE_H = 170
const PROFILE_GAP = 10
const VIEWPORT_EDGE = 8

/**
 * 搜索词归一：去首尾空白再转小写。
 * 空串代表「没有查询词」，下游多处按这个事实分支（`memberQuery` 因此是 falsy 而不是 `''` 长度判断）。
 */
export function memberQueryOf(search: string): string {
  return search.trim().toLowerCase()
}

/**
 * 按昵称或微信号过滤。查询词为空时**原样返回**（包括引用相等，展开/折叠不该改变成员顺序）。
 */
export function filterMembers(members: GroupMember[], query: string): GroupMember[] {
  if (!query) return members
  return members.filter((m) =>
    m.name.toLowerCase().includes(query) || m.username.toLowerCase().includes(query))
}

/** 当前该画多少条：折叠 24、展开 200。 */
export function memberLimitOf(expanded: boolean): number {
  return expanded ? MEMBER_EXPANDED_PAGE : MEMBER_PAGE
}

/**
 * 「还有更多」到底跟谁比。
 *
 * 旧写法在**搜索态**比的是 `filteredMembers.length > memberLimit`，而 `memberLimit` 在展开后变成 200 ⇒
 * 命中 100 位时：折叠态 100>24 出「展开更多匹配」，点下去之后 100>200 不成立 ⇒ 按钮整颗消失，
 * 用户**收不回来**（除非清空搜索）。非搜索态一直比的是总数与 24，所以没这个洞。
 * 两种模式都拿折叠门槛比，才只有一条口径。
 */
export function hasMoreMembers(filteredCount: number, total: number, query: string): boolean {
  return (query ? filteredCount : total) > MEMBER_PAGE
}

/** 「查看更多 / 收起」那颗按钮该写什么（搜索态要说清楚命中了多少位，否则用户以为搜没了）。 */
export function memberMoreLabel(expanded: boolean, filteredCount: number, total: number, query: string): string {
  if (expanded) return '收起'
  return query ? `展开更多匹配（共 ${filteredCount} 位）` : `查看更多（${total} 人）`
}

/** 网格末尾那颗「＋ 添加」占位方块：只在没有查询词时出现（搜索结果里挂一颗加人方块是误导）。 */
export function showsAddTile(query: string): boolean {
  return !query
}

/** 资料卡要摆的那块矩形在视口里的位置（只取用到的三个量，方便测试）。 */
export interface ProfileRect { left: number; right: number; top: number }

/**
 * 悬浮资料卡的落点：默认摆在触发元素**左边**（左侧是头像列，卡片盖住正文最少），
 * 左边放不下（不到 8px 边距）就翻到右边；垂直按视口高度夹住，不许露出屏幕下沿。
 */
export function profileAnchor(rect: ProfileRect, viewportHeight: number): { left: number; top: number } {
  const roomOnLeft = rect.left - PROFILE_W - PROFILE_GAP
  const left = roomOnLeft >= VIEWPORT_EDGE
    ? roomOnLeft
    : rect.right + PROFILE_GAP
  const top = Math.max(VIEWPORT_EDGE, Math.min(rect.top, viewportHeight - PROFILE_H))
  return { left, top }
}
