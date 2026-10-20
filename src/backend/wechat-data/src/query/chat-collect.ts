/**
 * 聊天素材收集任务（2026-10-19）：从某个会话里保留「最近 N 条文本 + M 张图片」。
 *
 * 与 `wechat-tasks.ts` 的待办提取不同 —— 那是**文本规则**（记得/待办/提醒…），
 * 这一份是**用户显式创建的资源任务**：把最近的聊天内容与图片复制到任务目录，供之后
 * 复盘 / 交给模型 / 手工查看。任务记录存 `<数据根>/wechat_collect.db`，资源目录在
 * `<数据根>/collect-tasks/<时间戳>_<会话名>/`（texts.json / images/ / task.json）。
 *
 * 图片**按需解码**：只有被选中的 M 张才走 `decodeImageDataUrlAsync`，不会为整段聊天
 * 批量解码。解不出来的图片不伪造成功，只把引用记进 task.json，计数按实际落盘算。
 */
import { DatabaseSync } from './db-open.ts'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { decodeImageDataUrlAsync } from './media-image-async.ts'
import { queryMessages } from './messages.ts'
import type {
  ChatCollectTask, ChatCollectTaskResult, ChatCollectTaskSnapshot, WechatMessage,
} from '../types.ts'

/** 一次收集任务创建时的外部参数（网关层只负责补密钥与自身 wxid）。 */
export interface ChatCollectOptions {
  username: string
  displayName?: string
  /** 保留文本条数（1..200，默认 20）。 */
  textLimit?: number
  /** 保留图片张数（0..24，默认 6）。 */
  imageLimit?: number
  /** 登录账号 wxid（用于把 isSender 标成「我」）。 */
  selfUsername?: string
  /** 微信账号根目录（解密图片用），空 = 只读已解码缓存。 */
  wechatBaseDir?: string
  aesKey?: string
  xorKey?: number
}

/** 资源目录中的一个文本条目。 */
interface CollectTextItem {
  localId: number
  sender: string
  time: number
  content: string
}

/** 资源目录中的一张图片（file 为空 = 解码失败，仅保留引用）。 */
interface CollectImageItem {
  localId: number
  sender: string
  time: number
  md5?: string
  file?: string
}

const TEXT_LIMIT_DEFAULT = 20
const IMAGE_LIMIT_DEFAULT = 6
const TEXT_LIMIT_MAX = 200
const IMAGE_LIMIT_MAX = 24
/** 最多翻多少页（每页 200 条）去找够 N 条文本 / M 张图；防止在纯图片/纯文本会话里扫全库。 */
const MAX_PAGES = 10

function dbPath(decryptedDir: string): string {
  return join(dirname(decryptedDir), 'wechat_collect.db')
}

function clampInt(v: unknown, fallback: number, min: number, max: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : fallback
  return Math.min(max, Math.max(min, n))
}

function errorText(e: unknown): string {
  const msg = (e as { message?: unknown } | null | undefined)?.message
  return typeof msg === 'string' && msg !== '' ? msg : String(e)
}

function cellStr(v: unknown): string {
  if (typeof v === 'string') return v
  if (v === null || v === undefined) return ''
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return String(v)
  return ''
}

function cellNum(v: unknown): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

function rowToTask(r: Record<string, unknown>): ChatCollectTask {
  return {
    id: cellNum(r['id']),
    username: cellStr(r['username']),
    displayName: cellStr(r['display_name']),
    textLimit: cellNum(r['text_limit']),
    imageLimit: cellNum(r['image_limit']),
    textCount: cellNum(r['text_count']),
    imageCount: cellNum(r['image_count']),
    dir: cellStr(r['dir']),
    createdAt: cellNum(r['created_at']),
  }
}

/**
 * 打开（不存在则建）收集任务库。
 * @param decryptedDir - 解密数据根。
 * @returns 已建表的数据库连接。
 */
function openStore(decryptedDir: string): DatabaseSync {
  const file = dbPath(decryptedDir)
  try {
    mkdirSync(dirname(file), { recursive: true })
  } catch (e) {
    console.warn('[chat-collect] 数据根目录创建失败，继续尝试打开库：' + errorText(e))
  }
  const db = new DatabaseSync(file)
  db.exec(`CREATE TABLE IF NOT EXISTS chat_collect_tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL,
    display_name TEXT NOT NULL DEFAULT '',
    text_limit INTEGER NOT NULL,
    image_limit INTEGER NOT NULL,
    text_count INTEGER NOT NULL,
    image_count INTEGER NOT NULL,
    dir TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`)
  return db
}

/**
 * 读取收集任务列表（最新在前）。
 * @param decryptedDir - 解密数据根。
 * @returns 任务快照；读库失败时带 `readError`（与「确实没有任务」区分）。
 */
export function listChatCollectTasks(decryptedDir: string): ChatCollectTaskSnapshot {
  try {
    const db = openStore(decryptedDir)
    try {
      const rows = db.prepare('SELECT * FROM chat_collect_tasks ORDER BY id DESC LIMIT 50').all() as Array<Record<string, unknown>>
      return { items: rows.map(rowToTask), total: rows.length }
    } finally {
      db.close()
    }
  } catch (e) {
    const readError = errorText(e)
    console.warn('[chat-collect] 收集任务库读取失败（与「确无任务」不同）：' + readError)
    return { items: [], total: 0, readError }
  }
}

/** 全角/非法字符压成文件名安全片段。 */
function safeFolderName(name: string, fallback: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|\s]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 24)
  return cleaned !== '' ? cleaned : fallback
}

/** 把 data URL / 解码结果里的图片字节写进任务目录。 */
function writeImageBytes(decodedFile: string, dataUrl: string): Buffer | null {
  if (decodedFile !== '') {
    try {
      const bytes = readFileSync(decodedFile)
      if (bytes.byteLength > 0) return bytes
    } catch { /* 退到 data URL */ }
  }
  const comma = dataUrl.indexOf(',')
  if (comma < 0) return null
  try {
    const bytes = Buffer.from(dataUrl.slice(comma + 1), 'base64')
    return bytes.byteLength > 0 ? bytes : null
  } catch { return null }
}

/** 从 data URL / 文件后缀推扩展名（默认 .jpg）。 */
function imageExt(file: string, dataUrl: string): string {
  const fromFile = /\.([a-zA-Z0-9]+)$/.exec(file)?.[1]?.toLowerCase()
  if (fromFile === 'png' || fromFile === 'webp' || fromFile === 'gif' || fromFile === 'bmp') return fromFile
  if (fromFile === 'jpeg' || fromFile === 'jpg') return 'jpg'
  const mime = /^data:image\/([a-zA-Z0-9.+-]+)/.exec(dataUrl)?.[1]?.toLowerCase()
  if (mime === 'jpeg') return 'jpg'
  if (mime === 'png' || mime === 'webp' || mime === 'gif' || mime === 'bmp') return mime
  return 'jpg'
}

/** 消息里可读的文本（displayText 优先；链接卡等没有正文的跳过）。 */
function textOf(m: WechatMessage): string {
  const raw = m.displayText ?? m.msgContent ?? m.strContent ?? ''
  return raw.trim()
}

/** 发送者显示名（群聊用 senderName；单聊退回「我 / 对方」）。 */
function senderOf(m: WechatMessage, selfUsername: string): string {
  if (m.senderName && m.senderName.trim() !== '') return m.senderName.trim()
  if (m.sender && m.sender.trim() !== '') return m.sender.trim()
  if (m.isSender === 1) return '我'
  return selfUsername === '' ? '对方' : '对方'
}

/**
 * 收集某个会话最近的文本与图片，创建任务并落盘。
 * @param decryptedDir - 解密数据根（库路径 = 它的父目录）。
 * @param decodedDir - 图片解码缓存根。
 * @param options - 会话 / 数量 / 图片密钥。
 * @returns 创建结果（失败带 error，不抛异常）。
 */
export async function createChatCollectTask(
  decryptedDir: string,
  decodedDir: string,
  options: ChatCollectOptions,
): Promise<ChatCollectTaskResult> {
  const username = typeof options.username === 'string' ? options.username.trim() : ''
  if (username === '') return { ok: false, error: '未指定会话' }
  const textLimit = clampInt(options.textLimit, TEXT_LIMIT_DEFAULT, 1, TEXT_LIMIT_MAX)
  const imageLimit = clampInt(options.imageLimit, IMAGE_LIMIT_DEFAULT, 0, IMAGE_LIMIT_MAX)
  const displayName = (options.displayName ?? '').trim()
  const selfUsername = (options.selfUsername ?? '').trim()
  const texts: CollectTextItem[] = []
  const images: CollectImageItem[] = []
  try {
    let cursor: number | undefined
    let cursorLocalId: number | undefined
    for (let page = 0; page < MAX_PAGES; page += 1) {
      if (texts.length >= textLimit && images.length >= imageLimit) break
      const snap = queryMessages(decryptedDir, username, 200, cursor, selfUsername, cursorLocalId)
      const msgs = snap.messages
      for (let i = msgs.length - 1; i >= 0; i -= 1) {
        if (texts.length >= textLimit && images.length >= imageLimit) break
        const m = msgs[i]
        if (m === undefined) continue
        if (texts.length < textLimit && (m.renderType === 'text' || (m.renderType === undefined && m.type === 1))) {
          const content = textOf(m)
          if (content !== '') {
            texts.push({ localId: m.localId, sender: senderOf(m, selfUsername), time: m.createTime, content: content.slice(0, 4000) })
          }
          continue
        }
        if (images.length < imageLimit && m.renderType === 'image') {
          images.push({ localId: m.localId, sender: senderOf(m, selfUsername), time: m.createTime, ...(m.rich?.md5 ? { md5: m.rich.md5 } : {}) })
        }
      }
      if (snap.hasMore !== true || snap.cursor === undefined) break
      cursor = snap.cursor
      cursorLocalId = snap.cursorLocalId
    }
  } catch (e) {
    return { ok: false, error: '读取会话消息失败：' + errorText(e) }
  }
  // 收集时是「新 → 旧」，落盘统一按时间正序（与聊天记录阅读方向一致）。
  texts.reverse()
  images.reverse()
  const createdAt = Date.now()
  const dataRoot = dirname(decryptedDir)
  const folder = join(dataRoot, 'collect-tasks', `${String(createdAt)}_${safeFolderName(displayName || username, 'chat')}`)
  const imageDir = join(folder, 'images')
  try {
    mkdirSync(imageDir, { recursive: true })
  } catch (e) {
    return { ok: false, error: '创建任务目录失败：' + errorText(e) }
  }
  let imageCount = 0
  for (const [index, image] of images.entries()) {
    try {
      const decoded = await decodeImageDataUrlAsync(
        decryptedDir, decodedDir, username, image.localId,
        options.wechatBaseDir, options.aesKey, options.xorKey,
      )
      if (decoded.url === undefined && decoded.file === undefined) continue
      const decodedFile = decoded.file === undefined || decoded.file.startsWith('..') ? '' : join(decodedDir, decoded.file)
      const bytes = writeImageBytes(decodedFile, decoded.url ?? '')
      if (bytes === null) continue
      const ext = imageExt(decoded.file ?? '', decoded.url ?? '')
      const name = `img_${String(index + 1).padStart(2, '0')}_${String(image.localId)}.${ext}`
      writeFileSync(join(imageDir, name), bytes)
      image.file = name
      imageCount += 1
    } catch { /* 单张失败不影响其它图片 */ }
  }
  const taskMeta = {
    username,
    displayName,
    textLimit,
    imageLimit,
    textCount: texts.length,
    imageCount,
    createdAt,
    texts,
    images,
  }
  try {
    writeFileSync(join(folder, 'texts.json'), JSON.stringify(texts, null, 2), 'utf8')
    writeFileSync(join(folder, 'task.json'), JSON.stringify(taskMeta, null, 2), 'utf8')
  } catch (e) {
    return { ok: false, error: '写入任务文件失败：' + errorText(e) }
  }
  try {
    const db = openStore(decryptedDir)
    try {
      const info = db.prepare(`INSERT INTO chat_collect_tasks
        (username, display_name, text_limit, image_limit, text_count, image_count, dir, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(username, displayName, textLimit, imageLimit, texts.length, imageCount, folder, createdAt)
      const id = cellNum(info.lastInsertRowid)
      const task: ChatCollectTask = {
        id, username, displayName, textLimit, imageLimit, textCount: texts.length, imageCount, dir: folder, createdAt,
      }
      return { ok: true, task }
    } finally {
      db.close()
    }
  } catch (e) {
    return { ok: false, error: '保存任务记录失败：' + errorText(e) }
  }
}
