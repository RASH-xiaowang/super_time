/**
 * 年度看板的公共小件（2026-09-30 从 `Annual.tsx` 拆出）。
 *
 * 为什么单独一个文件：海报卡与新拆出的「更多」段卡片都要用它们，
 * 若把 `Avatar` 留在 `Annual.tsx` 而卡片文件反过来 import 主文件，就会形成
 * **循环依赖**（仓库有 `module-cycle-guard`，会直接红）。放这里两边各自 import，方向是单向的。
 */
import { avatarColors } from '../utils/format.ts'
import css from './annual.module.css'

/** 圆形头像（拿不到真头像时用首字 + 稳定色）。 */
export function Avatar({ username, name, size = 32, src }: { username: string; name: string; size?: number; src?: string }): React.JSX.Element {
  const c = avatarColors(username || name || '?')
  return (
    <span className={css.av} style={{ width: size, height: size, background: c.background, color: c.color, fontSize: Math.round(size * 0.42) }}>
      {src ? <img src={src} alt="" /> : (name || username || '?').slice(0, 1)}
    </span>
  )
}

/** 千分位。 */
export const fmt = (n: number): string => (Number.isFinite(n) ? n.toLocaleString('zh-CN') : '0')
/**
 * 头像的唯一规格（2026-09-30 用户：「各个头像的尺寸大小不一致，需要统一为相同的规格」）。
 *
 * 年报里原先有 18 / 24 / 26 / 30 / 32 / 34 六种尺寸 —— 同一屏里大小不一，看着像没对齐。
 * 现在只此一处定义，所有 `<Avatar>` 都引用它；要调就调这一个数。
 */
export const AVATAR_SIZE = 26
/** 秒 → 可读时长。 */
export function dur(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '—'
  if (sec < 60) return `${Math.round(sec)}秒`
  if (sec < 3600) return `${Math.round(sec / 60)}分钟`
  if (sec < 86400) return `${(sec / 3600).toFixed(1)}小时`
  return `${Math.round(sec / 86400)}天`
}
