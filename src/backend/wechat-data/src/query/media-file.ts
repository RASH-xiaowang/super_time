/**
 * 消息文件解析：从 msg/file/<月份>/<原文件名> 读取微信接收/下载的文件（明文），
 * 转成 base64 data URL，供聊天界面「点击打开/下载」使用。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { boundedSet } from './meta.ts'

const fileCache = new Map<string, string>()

const FILE_MIME: Record<string, string> = {
  pdf: 'application/pdf',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp',
  mp4: 'video/mp4', mov: 'video/quicktime', avi: 'video/x-msvideo',
  mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4',
  zip: 'application/zip', rar: 'application/vnd.rar', '7z': 'application/x-7z-compressed', tar: 'application/x-tar', gz: 'application/gzip',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  txt: 'text/plain', md: 'text/markdown', log: 'text/plain', ini: 'text/plain', cfg: 'text/plain',
  json: 'application/json', js: 'text/javascript', ts: 'text/plain', html: 'text/html', css: 'text/css',
  xml: 'application/xml', yaml: 'text/yaml', yml: 'text/yaml', csv: 'text/csv', sql: 'text/plain',
  rtf: 'application/rtf', bat: 'text/plain', ps1: 'text/plain', py: 'text/plain',
}

function mimeOf(name: string): string {
  const ext = (name.split('.').pop() ?? '').toLowerCase()
  return FILE_MIME[ext] || 'application/octet-stream'
}

/** Sanitize a message file name for safe path lookup. */
function sanitize(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '_').trim() || ''
}

/**
 * 消息 `create_time`（秒）→ `msg/file` 下的月份目录名（`YYYY-MM`）。
 * @param createTime - unix 秒；缺失或非法时返回空串。
 * @returns 目录名或空串。
 */
function monthDirOf(createTime: number | undefined): string {
  if (!createTime || !Number.isFinite(createTime)) return ''
  const d = new Date(createTime * 1000)
  if (Number.isNaN(d.getTime())) return ''
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

/**
 * Resolve a received message file to a base64 data URL from msg/file.
 *
 * 归属要点：微信把收到的文件平铺在 `msg/file/<月份>/<原文件名>`，**目录不区分会话**，
 * 所以同一账号里同名文件可能有多个副本。旧实现只按文件名全库找、取 mtime 最新的
 * 那个，会把**别的会话**的同名文件当成这条消息的附件打开。这里用消息自带的两条
 * 线索收敛到唯一候选：
 *   1. `createTime` → 月份目录（先只在这个月里找，找不到才退回全库）；
 *   2. `fileSize`（appmsg 的 `<totallen>`）→ 精确字节数匹配，优先于 mtime。
 * 同名同大小又同月时仍只能回退 mtime —— 微信的存储路径里没有会话维度，
 * 这一档限制来自数据布局本身，无法在读取侧彻底消除。
 * @param wechatBaseDir - raw WeChat install dir (current account root).
 * @param fileName - original file name (e.g. 测试报告.pdf).
 * @param opts - 归属线索：消息里的文件字节数与接收时间。
 * @returns ImageDataUrlResult-like result.
 */
export function resolveMessageFileDataUrl(
  wechatBaseDir: string | undefined,
  fileName: string,
  opts: { size?: number; createTime?: number } = {},
): { url?: string; error?: string } {
  if (!wechatBaseDir) return { error: '未配置微信原始目录，无法定位文件' }
  const name = sanitize(fileName)
  if (!name) return { error: '缺少文件名' }
  const month = monthDirOf(opts.createTime)
  const size = Number.isFinite(opts.size) && (opts.size ?? 0) > 0 ? Math.trunc(opts.size as number) : 0
  // 缓存键带上线索：同名文件在不同会话/不同月份是不同请求，不能共用一条结果。
  const cacheKey = `${name.toLowerCase()}|${size}|${month}`
  if (fileCache.has(cacheKey)) {
    const cached = fileCache.get(cacheKey) ?? ''
    return cached ? { url: cached } : { error: '本地未找到该文件' }
  }
  const fileRoot = join(wechatBaseDir, 'msg', 'file')
  if (!existsSync(fileRoot)) {
    boundedSet(fileCache, cacheKey, '')
    return { error: 'msg/file 目录不存在，文件尚未下载' }
  }
  try {
    const scan = (dirs: string[]): { path: string; mtime: number; size: number }[] => {
      const hits: { path: string; mtime: number; size: number }[] = []
      for (const dir of dirs) {
        const p = join(dir, name)
        if (!existsSync(p)) continue
        const st = statSync(p)
        if (!st.isFile()) continue
        hits.push({ path: p, mtime: st.mtimeMs, size: st.size })
      }
      return hits
    }
    const allDirs = readdirSync(fileRoot, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => join(fileRoot, e.name))
    // 先按消息所在月份就近找；这个月没有（转发/更早接收）再退回全库。
    const monthDirs = month ? allDirs.filter(d => d.endsWith(month)) : []
    let hits = monthDirs.length > 0 ? scan(monthDirs) : []
    if (hits.length === 0) hits = scan(allDirs)
    if (hits.length === 0) {
      boundedSet(fileCache, cacheKey, '')
      return { error: '本地未找到该文件（需在微信中先打开/下载）' }
    }
    // 体积精确相等优先；多条同大小同名时退化为「取最新」。
    const sized = size > 0 ? hits.filter(h => h.size === size) : []
    const pool = sized.length > 0 ? sized : hits
    const best = pool.reduce((a, b) => (b.mtime > a.mtime ? b : a), pool[0] as { path: string; mtime: number; size: number })
    const bytes = readFileSync(best.path)
    const url = 'data:' + mimeOf(name) + ';base64,' + bytes.toString('base64')
    boundedSet(fileCache, cacheKey, url)
    return { url }
  } catch (e) {
    boundedSet(fileCache, cacheKey, '')
    return { error: (e as Error).message }
  }
}
