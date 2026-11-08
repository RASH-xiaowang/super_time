/**
 * 消息文件解析：从 msg/file/<月份>/<原文件名> 读取微信接收/下载的文件（明文），
 * 转成 base64 data URL，供聊天界面「点击打开/下载」使用。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { boundedSet } from './meta.ts'

/**
 * 解析结果缓存。`url === ''` 是「这一次没找到」的**负缓存条目**。
 *
 * 负缓存必须有保质期：用户点了「本地未找到」之后做的正是去微信里打开/下载那个文件，
 * 而旧实现把空串**永久**钉在缓存里（没有 TTL、也没有 mtime/大小指纹）——
 * 文件已经下载好了，这条消息却永远显示「本地未找到」，直到重启应用。
 * 60 秒这条线与 `article-cover.ts` 的负缓存同口径（同样是「瞬时失败」而不是「没有这个东西」）。
 */
const fileCache = new Map<string, { path: string, at: number }>()
const NEGATIVE_TTL_MS = 60_000
/**
 * IPC/HTTP 仍把文件作为 base64 data URL 传递，必须给同步整读设硬上限。
 * 超过上限应走系统“打开文件”而不是把几十/几百 MB 扩展 4/3 后塞进 worker 内存。
 */
export const MESSAGE_FILE_DATA_URL_MAX_BYTES = 16 * 1024 * 1024

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
 * Resolve a received message file's on-disk path from msg/file.
 *
 * 归属要点：微信把收到的文件平铺在 `msg/file/<月份>/<原文件名>`，**目录不区分会话**，
 * 所以同一账号里同名文件可能有多个副本。旧实现只按文件名全库找、取 mtime 最新的
 * 那个，会把**别的会话**的同名文件当成这条消息的附件打开。这里用消息自带的两条
 * 线索收敛到唯一候选：
 *   1. `createTime` → 月份目录（先只在这个月里找，找不到才退回全库）；
 *   2. `fileSize`（appmsg 的 `<totallen>`）→ 精确字节数匹配，优先于 mtime。
 * 同名同大小又同月时，若消息带 `fileMd5`，则读取候选内容逐个比对 MD5；
 * 只有未提供 MD5 时才保留旧的 mtime 兜底。给了 MD5 但没有任何候选匹配，
 * 必须明确失败，不能拿另一份同名文件冒充。
 * @param wechatBaseDir - raw WeChat install dir (current account root).
 * @param fileName - original file name (e.g. 测试报告.pdf).
 * @param opts - 归属线索：文件字节数、接收时间与附件 MD5。
 * @returns path/name/mime/size, or a readable error.
 */
export interface MessageFileResolution {
  path?: string
  name?: string
  mime?: string
  size?: number
  error?: string
}

/**
 * Locate a received file without reading its bytes into a data URL.
 *
 * Export uses this path form so large attachments can be streamed straight into
 * the ZIP. `resolveMessageFileDataUrl` keeps the existing RPC contract and
 * reads the already-validated path afterwards.
 */
export function resolveMessageFilePath(
  wechatBaseDir: string | undefined,
  fileName: string,
  opts: { size?: number; createTime?: number; fileMd5?: string; requireUnique?: boolean } = {},
): MessageFileResolution {
  if (!wechatBaseDir) return { error: '未配置微信原始目录，无法定位文件' }
  const name = sanitize(fileName)
  if (!name) return { error: '缺少文件名' }
  const month = monthDirOf(opts.createTime)
  const size = Number.isFinite(opts.size) && (opts.size ?? 0) > 0 ? Math.trunc(opts.size as number) : 0
  const rawFileMd5 = String(opts.fileMd5 ?? '').trim()
  const fileMd5 = normalizeMd5(rawFileMd5)
  const requireUnique = opts.requireUnique === true
  if (rawFileMd5 !== '' && fileMd5 === undefined) {
    return { error: '文件 MD5 格式不正确，无法校验同名文件' }
  }
  // 缓存键要带上**当前账号的根目录**：换账号 / 改 `wechat_base_dir` 之后，同名同大小同月
  // 的文件是另一个目录里的另一份字节 —— 少了这一维，会把上一个账号的文件内容发回界面。
  const cacheKey = `${wechatBaseDir.toLowerCase()}|${name.toLowerCase()}|${String(size)}|${month}|${fileMd5 ?? ''}|${requireUnique ? 'unique' : 'latest'}`
  const hit = fileCache.get(cacheKey)
  if (hit !== undefined && (hit.path !== '' || Date.now() - hit.at < NEGATIVE_TTL_MS)) {
    if (hit.path !== '') {
      try {
        const st = statSync(hit.path)
        if (st.isFile()) return { path: hit.path, name, mime: mimeOf(name), size: st.size }
      } catch {
        // The cache entry can race with WeChat deleting/moving the attachment.
      }
      fileCache.delete(cacheKey)
    }
    if (hit.path === '') return { error: '本地未找到该文件' }
  }
  const fileRoot = join(wechatBaseDir, 'msg', 'file')
  if (!existsSync(fileRoot)) {
    boundedSet(fileCache, cacheKey, { path: '', at: Date.now() })
    return { error: 'msg/file 目录不存在，文件尚未下载' }
  }
  try {
    const scan = (dirs: string[]): { path: string; mtime: number; size: number }[] => {
      const hits: { path: string; mtime: number; size: number }[] = []
      for (const dir of dirs) {
        const p = join(dir, name)
        try {
          const st = statSync(p)
          if (!st.isFile()) continue
          hits.push({ path: p, mtime: st.mtimeMs, size: st.size })
        } catch {
          // Missing or concurrently removed candidates are simply skipped.
        }
      }
      return hits
    }
    const allDirs = readdirSync(fileRoot, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => join(fileRoot, e.name))
    // 先按消息所在月份就近找；这个月没有（转发/更早接收）再退回全库。
    // 带 MD5 时必须扫全部月份：同名同大小的正确副本可能在别的月份，
    // 不能因为当月有同名文件就提前收窄候选。
    const monthDirs = month ? allDirs.filter(d => d.endsWith(month)) : []
    let hits = monthDirs.length > 0 && fileMd5 === undefined ? scan(monthDirs) : []
    if (hits.length === 0) hits = scan(allDirs)
    if (hits.length === 0) {
      boundedSet(fileCache, cacheKey, { path: '', at: Date.now() })
      return { error: '本地未找到该文件（需在微信中先打开/下载）' }
    }
    // 未给 MD5 时体积精确相等优先；给了 MD5 时 MD5 是更强证据，
    // 不再让可能失真的体积线索排除正确副本。
    const sized = size > 0 ? hits.filter(h => h.size === size) : []
    if (size > 0 && sized.length === 0 && requireUnique && fileMd5 === undefined) {
      boundedSet(fileCache, cacheKey, { path: '', at: Date.now() })
      return { error: '没有与消息记录大小一致的本地文件，已停止猜测' }
    }
    const pool = fileMd5 !== undefined ? hits : (sized.length > 0 ? sized : hits)
    if (fileMd5 === undefined && requireUnique && pool.length !== 1) {
      boundedSet(fileCache, cacheKey, { path: '', at: Date.now() })
      return { error: '找到多个同名同大小文件，缺少 MD5，无法确认原文件；已停止猜测' }
    }
    const best = fileMd5 !== undefined
      ? pool.find(h => hashFile(h.path) === fileMd5)
      : pool.reduce((a, b) => (b.mtime > a.mtime ? b : a), pool[0] as { path: string; mtime: number; size: number })
    if (best === undefined) {
      boundedSet(fileCache, cacheKey, { path: '', at: Date.now() })
      return { error: '同名文件未匹配到消息里的 MD5，已停止猜测；请在微信里重新下载该文件' }
    }
    boundedSet(fileCache, cacheKey, { path: best.path, at: Date.now() })
    return { path: best.path, name, mime: mimeOf(name), size: best.size }
  } catch (e) {
    boundedSet(fileCache, cacheKey, { path: '', at: Date.now() })
    return { error: (e as Error).message }
  }
}

/** Resolve a received message file to a base64 data URL from msg/file. */
export function resolveMessageFileDataUrl(
  wechatBaseDir: string | undefined,
  fileName: string,
  opts: { size?: number; createTime?: number; fileMd5?: string } = {},
): { url?: string; error?: string } {
  const found = resolveMessageFilePath(wechatBaseDir, fileName, opts)
  if (!found.path) return { error: found.error ?? '本地未找到该文件' }
  try {
    const size = found.size ?? statSync(found.path).size
    if (size > MESSAGE_FILE_DATA_URL_MAX_BYTES) {
      const mb = (size / (1024 * 1024)).toFixed(1)
      return { error: `文件过大（${mb} MB），请使用“打开文件”直接访问，避免 base64 传输占满内存` }
    }
    const bytes = readFileSync(found.path)
    return { url: 'data:' + (found.mime ?? mimeOf(found.name ?? fileName)) + ';base64,' + bytes.toString('base64') }
  } catch (e) {
    return { error: (e as Error).message }
  }
}

/** Lowercase, trim and validate a 32-char hex MD5. */
function normalizeMd5(value: string | undefined): string | undefined {
  const md5 = String(value ?? '').trim().toLowerCase()
  return /^[a-f0-9]{32}$/.test(md5) ? md5 : undefined
}

/** MD5 of a candidate file's bytes; callers only use it to disambiguate same-name files. */
function hashFile(path: string): string {
  return createHash('md5').update(readFileSync(path)).digest('hex')
}
