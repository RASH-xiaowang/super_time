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
 * Resolve a received message file to a base64 data URL from msg/file.
 * @param wechatBaseDir - raw WeChat install dir (current account root).
 * @param fileName - original file name (e.g. 测试报告.pdf).
 * @returns ImageDataUrlResult-like result.
 */
export function resolveMessageFileDataUrl(wechatBaseDir: string | undefined, fileName: string): { url?: string; error?: string } {
  if (!wechatBaseDir) return { error: '未配置微信原始目录，无法定位文件' }
  const name = sanitize(fileName)
  if (!name) return { error: '缺少文件名' }
  const cacheKey = name.toLowerCase()
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
    let found = ''
    let bestMtime = -1
    for (const e of readdirSync(fileRoot, { withFileTypes: true })) {
      if (!e.isDirectory()) continue
      const p = join(fileRoot, e.name, name)
      if (!existsSync(p)) continue
      const st = statSync(p)
      if (st.mtimeMs > bestMtime) {
        bestMtime = st.mtimeMs
        found = p
      }
    }
    if (!found) {
      boundedSet(fileCache, cacheKey, '')
      return { error: '本地未找到该文件（需在微信中先打开/下载）' }
    }
    const bytes = readFileSync(found)
    const url = 'data:' + mimeOf(name) + ';base64,' + bytes.toString('base64')
    boundedSet(fileCache, cacheKey, url)
    return { url }
  } catch (e) {
    boundedSet(fileCache, cacheKey, '')
    return { error: (e as Error).message }
  }
}
