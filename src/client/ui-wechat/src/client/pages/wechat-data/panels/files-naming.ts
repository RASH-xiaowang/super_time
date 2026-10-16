/**
 * 文件面板的命名与来源算术（纯函数，不依赖 React）。
 *
 * 为什么单独一份：这一族决定界面上**看得见的那两行字**（文件名、来源、悬停 tooltip），
 * 而它的坏法都是"安静错"：`fileKey` 少剥一个 `_t` 后缀就会把缩略图和原图当成两个文件，
 * `isHashLike` 判错会让一屏哈希串直接进界面（微信附件名本来就是哈希），
 * `fileTitle` 与显示名不一致时用户复制不到真名字。这些此前都埋在面板文件顶部，
 * 没有任何用例（要跑得先把整个面板挂起来）。虚拟化把格子拆成组件时顺手把它们搬到这里，
 * 于是每一格都能单独喂数据。
 */
import type { FileItem } from '@deepseek-ai/dsh-wechat-data/types'
import { fmtMonthDaySec } from '../utils/format.ts'

/** 类目 → 中文（界面与 tooltip 共用一份，别写两处）。 */
export const CAT_LABEL: Record<string, string> = { image: '图片', video: '视频', file: '文件' }

/** 缓存文件名 → 解析键（去掉 .dat / _t/_h/_b 后缀）。 */
export function fileKey(f: FileItem): string {
  const base = f.fileName || f.md5
  return base.replace(/\.dat$/i, '').replace(/_(t|h|b|thumb.*)$/i, '')
}

/** Detects a hash-like (unreadable) file name: hex/base32 without a real extension. */
export function isHashLike(f: FileItem): boolean {
  const n = (f.fileName || f.md5).replace(/\.dat$/i, '')
  if (/^[0-9a-f]{16,64}$/i.test(n)) return true
  return !n.includes('.') && /^[0-9a-z]{16,}$/i.test(n)
}

/**
 * 来源口径（第 84 轮）：会话名优先用 message_resource 口径（`sessionName`），
 * 缺失时用附件目录口径（`sourceTalker`，由 `dir2id` 的 `md5(username)` 反查得到）；
 * 月份来自 `dir1`/`dir2` → `dir2id`，三个类目 100% 有值。
 * @param f - file item.
 * @returns 形如「黑龙江沃融-燎引擎 · 2026-09」的来源串（可能只有月份，或为空）。
 */
export function fileSource(f: FileItem): string {
  const who = f.sessionName || f.sourceTalker || ''
  const month = f.sourceMonth || ''
  return [who, month].filter(Boolean).join(' · ')
}

/** Readable label: uses the original name when readable, else category + date. */
export function fileDisplayName(f: FileItem | undefined): string {
  if (!f) return '(未知)'
  if (!isHashLike(f)) return f.fileName || f.md5 || ''
  const label = CAT_LABEL[f.category] || f.category || '文件'
  const src = f.sessionName ? `来自 ${f.sessionName} · ` : ''
  return `${label} · ${src}${fmtMonthDaySec(f.modifyTime)}`
}

/**
 * Hover tooltip for a file cell: full display label plus the raw file name when
 * they differ. 卡片里的可见文本会被 CSS 省略号截断（实测文件名最长 207px 而格位 124px），
 * 所以 title 必须给出**完整**文本，而不是只给原始文件名。
 * 第 84 轮补：来源（会话 / 月份）也写进 title —— 视频与文件没有预览，
 * tooltip 与「详情」抽屉是它们唯一能看到来源的地方。
 * @param f - file item.
 * @returns the tooltip text.
 */
export function fileTitle(f: FileItem): string {
  const label = fileDisplayName(f)
  const raw = f.fileName || ''
  const src = fileSource(f)
  const lines = [label]
  if (src) lines.push(`来源：${src}`)
  if (raw && raw !== label) lines.push(raw)
  return lines.join('\n')
}
