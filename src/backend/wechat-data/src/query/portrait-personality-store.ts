/**
 * 人物性格的本机存档。
 *
 * 分析一次要读聊天、朋友圈，再等模型写完四段。结果按好友落在数据根旁边的
 * `portrait-personality/`，下次打开直接读文件，不再自动重跑。
 * 只有用户点「重新分析」才覆盖这份存档。失败结果不写入，避免把「没写成」盖掉上次成功的正文。
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { writeFileAtomic } from '../config/atomic-json.ts'
import type { PortraitPersonalityResult } from '../types.ts'
import { missingPortraitSections } from './portrait-personality.ts'

interface StoredPortraitPersonality {
  version: number
  username: string
  savedAt: number
  text: string
  messages: number
  moments: number
}

/** 带画面和分块观察的分析版本。读取时不因版本不同而丢掉旧正文。 */
const STORE_VERSION = 3

/** 已经把目录扫进内存的数据根。空目录也记上，避免每次打开都 readdir。 */
const indexed = new Set<string>()

const memory = new Map<string, Map<string, PortraitPersonalityResult>>()

function memoryOf(decryptedDir: string): Map<string, PortraitPersonalityResult> {
  let bucket = memory.get(decryptedDir)
  if (bucket === undefined) {
    bucket = new Map()
    memory.set(decryptedDir, bucket)
  }
  return bucket
}

/** 存档目录：解密库的兄弟目录，换数据根时跟账号走。 */
export function portraitPersonalityDir(decryptedDir: string): string {
  return join(dirname(decryptedDir), 'portrait-personality')
}

function fileOf(decryptedDir: string, username: string): string {
  const name = createHash('sha256').update(username, 'utf8').digest('hex').slice(0, 32)
  return join(portraitPersonalityDir(decryptedDir), `${name}.json`)
}

function asStored(value: unknown, username: string): StoredPortraitPersonality | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const row = value as Partial<StoredPortraitPersonality>
  if (row.username !== username) return undefined
  if (typeof row.text !== 'string' || row.text.trim() === '') return undefined
  if (!Number.isFinite(row.savedAt) || !Number.isFinite(row.messages) || !Number.isFinite(row.moments)) return undefined
  return {
    version: Number.isFinite(row.version) ? Math.floor(Number(row.version)) : 0,
    username,
    savedAt: Math.floor(Number(row.savedAt)),
    text: row.text.trim(),
    messages: Math.max(0, Math.floor(Number(row.messages))),
    moments: Math.max(0, Math.floor(Number(row.moments))),
  }
}

function resultOf(stored: StoredPortraitPersonality): PortraitPersonalityResult {
  return {
    ok: true,
    text: stored.text,
    messages: stored.messages,
    moments: stored.moments,
    savedAt: stored.savedAt,
    cached: true,
  }
}

/** 把目录里已有的存档一次读进内存。单份损坏不影响其余人。 */
function ensureIndex(decryptedDir: string): Map<string, PortraitPersonalityResult> {
  const bucket = memoryOf(decryptedDir)
  if (indexed.has(decryptedDir)) return bucket
  indexed.add(decryptedDir)
  const dir = portraitPersonalityDir(decryptedDir)
  if (!existsSync(dir)) return bucket
  let names: string[] = []
  try { names = readdirSync(dir) } catch { return bucket }
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    try {
      const parsed = JSON.parse(readFileSync(join(dir, name), 'utf8')) as { username?: unknown }
      const username = typeof parsed.username === 'string' ? parsed.username : ''
      const stored = asStored(parsed, username)
      if (stored === undefined) continue
      bucket.set(username, resultOf(stored))
    } catch { /* 一份坏档跳过 */ }
  }
  return bucket
}

/** 读取已保存的性格速写。旧版式也直接返回，不在读取时重新生成。 */
export function readPortraitPersonality(decryptedDir: string, username: string): PortraitPersonalityResult | undefined {
  const talker = username.trim()
  if (talker === '' || decryptedDir.trim() === '') return undefined
  const bucket = ensureIndex(decryptedDir)
  const hit = bucket.get(talker)
  if (hit !== undefined) return hit
  const path = fileOf(decryptedDir, talker)
  if (!existsSync(path)) return undefined
  try {
    const stored = asStored(JSON.parse(readFileSync(path, 'utf8')) as unknown, talker)
    if (stored === undefined) return undefined
    const result = resultOf(stored)
    bucket.set(talker, result)
    return result
  } catch {
    return undefined
  }
}

/**
 * 把一次成功的性格速写写到硬盘。
 * @returns 写入时间（Unix 秒）。写失败时 undefined，调用方仍可把这次结果展示出来。
 */
export function savePortraitPersonality(
  decryptedDir: string,
  username: string,
  result: PortraitPersonalityResult,
): number | undefined {
  const talker = username.trim()
  if (talker === '' || decryptedDir.trim() === '' || result.ok !== true) return undefined
  if (missingPortraitSections(result.text).length > 0) return undefined
  const savedAt = Math.floor(Date.now() / 1000)
  const stored: StoredPortraitPersonality = {
    version: STORE_VERSION,
    username: talker,
    savedAt,
    text: result.text.trim(),
    messages: result.messages,
    moments: result.moments,
  }
  try {
    const path = fileOf(decryptedDir, talker)
    mkdirSync(dirname(path), { recursive: true })
    writeFileAtomic(path, JSON.stringify(stored))
    memoryOf(decryptedDir).set(talker, {
      ok: true,
      text: stored.text,
      messages: stored.messages,
      moments: stored.moments,
      savedAt,
      cached: true,
    })
    return savedAt
  } catch {
    return undefined
  }
}
