/**
 * 朋友圈媒体目录（`cache/<月>/Sns/{Img,Video}`）的扫描口（P1-1 / #9 后端读失败契约）。
 *
 * ## 为什么单独一个文件
 *
 * `sns-image.ts` 与 `sns-video.ts` 各写了一份几乎一样的「列月份根目录 + 安全 readdir」，
 * 两份都把 `readdirSync` 的失败**咽成空列表**。后果不是少几个文件，而是一句谎：
 * 索引没扫全时被说成「本机缓存里没有这条视频」—— 用户于是去微信里翻，而真实原因是
 * `cache` 目录读不动（权限 / 正在被微信写 / 网络盘断了）。同一条负缓存还会被
 * `sns-video.ts` 的 `idx.misses` **永久记住**（扫不到 ⇒ 目录签名也不变 ⇒ 再也不重扫）。
 *
 * 所以这里把「扫完了没有」变成返回值的一部分：调用方拿到 `notes` 非空时，
 * 既不许缓存「没有」这个结论，也要把原因并进给用户看的那句 error 里。
 *
 * @module query/sns-scan
 */
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** 扫描期间「这一处没读到」的说明；空数组 = 扫全是完整的。 */
export type ScanNotes = string[]

/** 一个月度媒体根目录（带签名，用于增量判断）。 */
export interface SnsMonthRoot {
  month: string
  root: string
  mtimeMs: number
  size: number
}

/** 记一条「没读到」，并把异常收成一句人话（导出版给本目录之外的扫描口复用）。 */
export function noteScan(notes: ScanNotes | undefined, dir: string, e: unknown): void {
  if (!notes) return
  const msg = e instanceof Error ? e.message : String(e)
  notes.push(`${dir}：${msg}`)
}

/** 内部别名，保持本文件里的调用点简短。 */
const note = noteScan

/**
 * 列出 `cache/<月份>/Sns/<kind>` 这些根目录，按月份由新到旧。
 * @param wechatBaseDir - 微信账号根目录（raw wechat base）。
 * @param kind - `Img` 或 `Video`（图片与视频的缓存子目录同名规则）。
 * @param notes - 传入则把每处读不到的目录记进这里（不传 = 老的「咽掉」行为，仅用于
 *   「扫不全也无所谓」的探针路径）。
 * @returns 带签名的月份根目录。
 */
export function snsMonthRoots(
  wechatBaseDir: string,
  kind: 'Img' | 'Video',
  notes?: ScanNotes,
): SnsMonthRoot[] {
  const cacheRoot = join(wechatBaseDir, 'cache')
  const out: SnsMonthRoot[] = []
  if (!existsSync(cacheRoot)) return out
  let months: string[]
  try {
    months = readdirSync(cacheRoot)
  } catch (e) {
    note(notes, cacheRoot, e)
    return out
  }
  for (const month of months.sort().reverse()) {
    const root = join(cacheRoot, month, 'Sns', kind)
    if (!existsSync(root)) continue
    try {
      const st = statSync(root)
      out.push({ month, root, mtimeMs: st.mtimeMs, size: st.size })
    } catch (e) {
      // 单个目录 stat 不了：跳过它，但**记下**——否则「这个月的缓存没扫」会被说成「本机没有」。
      note(notes, root, e)
    }
  }
  return out
}

/**
 * 只列根目录、不带签名的版本（用于「按已知文件名直接探测是否存在」的路径）。
 * @param wechatBaseDir - 微信账号根目录。
 * @param kind - `Img` 或 `Video`。
 * @param notes - 见 {@link snsMonthRoots}。
 * @returns 存在的媒体根目录路径。
 */
export function snsLeafRoots(wechatBaseDir: string, kind: 'Img' | 'Video', notes?: ScanNotes): string[] {
  const cacheRoot = join(wechatBaseDir, 'cache')
  const out: string[] = []
  if (!existsSync(cacheRoot)) return out
  let months: string[]
  try {
    months = readdirSync(cacheRoot, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name)
  } catch (e) {
    note(notes, cacheRoot, e)
    return out
  }
  for (const name of months) {
    const root = join(cacheRoot, name, 'Sns', kind)
    if (existsSync(root)) out.push(root)
  }
  return out
}

/**
 * 目录列举失败时回空数组，**并把失败记进 notes**。
 * @param dir - 要列的目录。
 * @param notes - 可选的注记收集器。
 * @returns 目录里的条目名（读不到时为空）。
 */
export function safeReaddir(dir: string, notes?: ScanNotes): string[] {
  try {
    return readdirSync(dir)
  } catch (e) {
    note(notes, dir, e)
    return []
  }
}

/**
 * 把「扫不全」的原因并进一句本来要说「本机没有」的话里。
 * @param msg - 原句（例如「本机缓存里没有这条视频」）。
 * @param notes - 扫描注记。
 * @returns notes 为空时原句；否则原句 + 原因（最多三条，多了没人看）。
 */
export function missWithScanNotes(msg: string, notes: ScanNotes): string {
  if (notes.length === 0) return msg
  return `${msg}（媒体缓存目录没扫全：${notes.slice(0, 3).join('；')}${notes.length > 3 ? '…' : ''}）`
}
