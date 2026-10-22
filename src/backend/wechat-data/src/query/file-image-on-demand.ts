/**
 * 文件库（hardlink 三表）图片的**按需解密**（2026-10-21，借鉴 Alpha 的 thumb/full 两档）。
 *
 * ## 为什么需要
 *
 * 「文件」面板里 13,071 张图片，`getFileImageDataUrl` 原先只查 `decoded_images/<key>.jpg`
 * 的**已解密缓存**；实测这 13,071 个 key 命中 **0 个** —— 文件库图片从没有任何链路
 * 去解过，所以界面上永远是「dat」占位图标。而它们其实都能解：
 * 探针实测 8/8 成功、单张 0.8–67ms（含 1.18MB 原图）。
 *
 * ## 做法（与 Alpha 的 `alpha-media://viewer/<token>/<i>/(thumb|full)` 同思路）
 *
 *  1. 先查 decoded 缓存（主槽 `<key>.<ext>` → 缩略槽 `<key>.t.<ext>`），命中直接给**相对路径**；
 *  2. 未命中：用 `msg/attach` 索引（md5 前缀 = 文件名前缀）定位 `.dat` 档位，解密；
 *  3. 解密结果落 decoded 缓存（缩略档进 `.t.` 槽，原图进主槽），再把**相对路径**交给上层，
 *     由渲染层拼 `wechat-media://` 流式显示 —— 不再走 base64/IPC。
 *
 * 缓存键约定与 `decrypt-images.ts` 完全一致（同一份槽位、同一份档位排序），
 * 否则会出现「批量解密看得到、单张预览看不到」的偏差。
 *
 * ## 边界
 *
 *  - 纯缓存 + 按需，不联网、不碰微信登录态；
 *  - 单张超过 {@link MAX_DAT_BYTES} 不解（防 OOM，返回可展示原因）；
 *  - 同时最多 {@link MAX_CONCURRENT_DECODES} 张在解（保护 UI 线程响应）；
 *  - 找不到附件目录 / 索引里没有 → 返回 `error`，界面保留图标兜底。
 */
import { existsSync } from 'node:fs'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { collectImageDatFilesAsync, groupImageDatsByMd5 } from './decrypt-images.ts'
import { decodeDatBytesAsync } from './media-image-async.ts'
import { RENDERABLE_EXTS, datTierRank, isThumbTier } from './media-image.ts'
import { isMd5 } from '../md5.ts'

/** 浏览器可渲染的落盘扩展名（与 batch decrypt 的 WRITE_EXTS 一致）。 */
const WRITE_EXTS = new Set(['jpg', 'png', 'gif', 'webp'])

/** 单张 `.dat` 解密上限：超过它不展开（文件库里的超大「图片」多半是伪装/损坏）。 */
const MAX_DAT_BYTES = 64 * 1024 * 1024

/** 解码并发上限：一屏几十格同时挂载时，避免把 worker 线程按住。 */
const MAX_CONCURRENT_DECODES = 4

/** 一次解密结果：`file` 是相对 decoded 根的路径（渲染层拼协议 URL），或可展示的错误。 */
export interface FileImageHit {
  file?: string
  format?: string
  /** true = 给的是缩略/中图那一档（对应 `.t.` 槽）。 */
  thumb?: boolean
  error?: string
}

/**
 * 附件文件名 → 解码键（= 解码缓存的 md5 槽位）。
 *
 * 微信附件的文件名本身就是内容 md5 前缀：`<md5>[_t|_h].dat`。
 * 客户端 `fileKey()` 与服务端这里必须是**同一套剥离规则**（少剥一个 `_h` 就会查错槽）。
 * @param fileName - `file_name` 列（如 `09da5c12…_h.dat`）。
 * @returns 32 位小写 md5；形状不对时为空串。
 */
export function fileImageKeyOf(fileName: string): string {
  const key = String(fileName ?? '')
    .replace(/\.dat$/i, '')
    .replace(/_(t|h|b|thumb.*)$/i, '')
    .trim()
    .toLowerCase()
  return isMd5(key) ? key : ''
}

/**
 * 已解密缓存命中：先主槽（原图）再 `.t.` 缩略槽，返回相对 decoded 根的路径。
 * @param decodedDir - decoded_images 根。
 * @param key - {@link fileImageKeyOf} 的结果。
 * @returns 形如 `ab12….jpg` / `ab12….t.jpg`；未命中 null。
 */
export function decodedFileRel(decodedDir: string, key: string): string | null {
  for (const thumb of [false, true]) {
    for (const ext of RENDERABLE_EXTS) {
      const rel = key + (thumb ? '.t.' : '.') + ext
      if (existsSync(join(decodedDir, rel))) return rel
    }
  }
  return null
}

/** `msg/attach` 索引：md5 → 该 md5 的 `.dat` 路径（`groupImageDatsByMd5` 已按档位从优到劣排序）。 */
interface AttachIndex {
  base: string
  at: number
  promise: Promise<Map<string, string[]>>
}

let attachIndex: AttachIndex | null = null
/** 索引 miss 后至少间隔这么久才重建（微信落新附件后下一次请求能自愈）。 */
const INDEX_REBUILD_GAP_MS = 1500

/**
 * 取（或构建）`msg/attach` 索引。64001 个文件全树遍历实测 232ms，只做一次；
 * 并发请求共享同一个 Promise。
 * @param rawBase - 微信账号原始根（`msg/attach` 的父目录）。
 * @returns md5 → 候选 `.dat` 列表。
 */
async function attachIndexFor(rawBase: string): Promise<Map<string, string[]>> {
  if (attachIndex && attachIndex.base === rawBase) {
    const idx = await attachIndex.promise
    if (idx.size > 0 || Date.now() - attachIndex.at < INDEX_REBUILD_GAP_MS) return idx
  }
  const at = Date.now()
  const promise = collectImageDatFilesAsync(rawBase).then((files) => groupImageDatsByMd5(files))
  attachIndex = { base: rawBase, at, promise }
  return await promise
}

/**
 * 按解码键定位 `.dat` 候选（已按档位排序）。
 * @param rawBase - 微信账号原始根。
 * @param key - {@link fileImageKeyOf} 的结果。
 * @returns 候选绝对路径（可能为空数组）。
 */
export async function locateFileDats(rawBase: string, key: string): Promise<string[]> {
  if (rawBase === '' || key === '') return []
  try {
    const idx = await attachIndexFor(rawBase)
    return idx.get(key) ?? []
  } catch {
    return []
  }
}

/** 测试用：清掉模块内的 attach 索引缓存。 */
export function resetAttachIndexForTest(): void {
  attachIndex = null
}

/** 解码槽位（并发上限）；`release` 把槽位直接转交给下一个等待者。 */
let activeDecodes = 0
const decodeWaiters: Array<() => void> = []

/**
 * 取一个解码槽位。
 * @returns 等待完成（调用方之后必须调用 {@link releaseDecodeSlot}）。
 */
async function acquireDecodeSlot(): Promise<void> {
  if (activeDecodes < MAX_CONCURRENT_DECODES) {
    activeDecodes += 1
    return
  }
  await new Promise<void>((resolve) => { decodeWaiters.push(resolve) })
}

/** 归还槽位（有等待者则直接转交，保持 `activeDecodes` 不抖动）。 */
function releaseDecodeSlot(): void {
  const next = decodeWaiters.shift()
  if (next) next()
  else activeDecodes -= 1
}

/** 同一张图在解时，后来的请求等同一个 Promise（避免一屏叠影时重复解密）。 */
const inFlight = new Map<string, Promise<FileImageHit>>()

/** 批量请求的参数（与单张一致，去掉 `key`/`thumbFirst` 由调用方逐个传）。 */
export interface FileImageBatchArgs {
  decryptedDir: string
  decodedDir: string
  rawBase: string
  aesKey?: string | Uint8Array
  xorKey?: number
}

/** 批量结果里的一条：`key` 如实回信，便于调用方按自己的卡片匹配。 */
export interface FileImageBatchItem extends FileImageHit {
  key: string
}

/** 单次批量上限：一屏最多几十格，超过它多半是调用方算错，直接截断保护 worker。 */
export const MAX_BATCH_KEYS = 48

/** 单块并行宽度（与全局解码槽位 4 配合：块内大多在等磁盘/解密）。 */
const BATCH_CHUNK = 12

/**
 * 批量按需解密（把「N 格 = N 次 RPC」收成 1 次，借鉴 Alpha 的批量 token 解析）。
 *
 * 去重 + 保持首次出现顺序；超过 {@link MAX_BATCH_KEYS} 截断；分块推进，
 * 真正的解码并发由 {@link ensureFileImageDecoded} 的全局槽位（4）限制 —— 两层都保留：
 * 块内并行隐藏磁盘延迟，又不让一屏 30 张同时解。
 * @param args - 解密/缓存参数。
 * @param keys - 待取 key 列表（客户端 `fileKey()` 结果；自动去重、忽略空值）。
 * @param thumbFirst - true 时优先缩略档（网格），false 原图档优先（灯箱）。
 * @returns 逐条结果，顺序 = 去重后的入参顺序（`key` 回信）。
 */
export async function ensureFileImagesDecodedBatch(
  args: FileImageBatchArgs,
  keys: readonly string[],
  thumbFirst = true,
): Promise<FileImageBatchItem[]> {
  const uniq: string[] = []
  const seen = new Set<string>()
  for (const raw of keys ?? []) {
    const key = String(raw ?? '').trim().toLowerCase()
    if (key === '' || seen.has(key)) continue
    seen.add(key)
    uniq.push(key)
    if (uniq.length >= MAX_BATCH_KEYS) break
  }
  const out = new Array<FileImageBatchItem>(uniq.length)
  for (let i = 0; i < uniq.length; i += BATCH_CHUNK) {
    const slice = uniq.slice(i, i + BATCH_CHUNK)
    await Promise.all(slice.map(async (key, j) => {
      const hit = await ensureFileImageDecoded({ ...args, key, thumbFirst })
      out[i + j] = { key, ...hit }
    }))
  }
  return out
}

/**
 * 按需把文件库图片解到 decoded 缓存，并给出流式显示用的相对路径。
 *
 * @param args.decryptedDir - 解密数据根（定位配置/密钥）。
 * @param args.decodedDir - decoded_images 根。
 * @param args.rawBase - 微信账号原始根（`db_dir` 的父目录），空串表示未配置。
 * @param args.key - 解码键（客户端传的是 `fileKey()` 的结果，与 md5 槽位一致）。
 * @param args.aesKey - V2 AES key（字符串或字节）。
 * @param args.xorKey - XOR key。
 * @param args.thumbFirst - true 时优先用缩略档（`_t`），否则按原图档优先（灯箱用）。
 * @returns 命中/解密成功 `{file, format, thumb?}`；失败 `{error}`。
 */
export async function ensureFileImageDecoded(args: {
  decryptedDir: string
  decodedDir: string
  rawBase: string
  key: string
  aesKey?: string | Uint8Array
  xorKey?: number
  thumbFirst?: boolean
}): Promise<FileImageHit> {
  const key = String(args.key ?? '').trim().toLowerCase()
  if (!isMd5(key)) return { error: '缺少图片 MD5' }
  const cached = decodedFileRel(args.decodedDir, key)
  if (cached !== null) {
    const thumb = cached.includes('.t.')
    const format = cached.slice(cached.lastIndexOf('.') + 1)
    return { file: cached, format, thumb }
  }
  if (args.rawBase === '') return { error: '未配置微信数据目录（db_dir），无法定位附件原图' }
  const flightKey = args.rawBase + '|' + key + '|' + (args.thumbFirst === true ? 't' : 'f')
  const existing = inFlight.get(flightKey)
  if (existing) return await existing
  const work = (async (): Promise<FileImageHit> => {
    const candidates = await locateFileDats(args.rawBase, key)
    if (candidates.length === 0) {
      return { error: '未找到附件原图（msg/attach 里没有该 md5 的 .dat）' }
    }
    // 档位顺序：灯箱走原图优先（groupImageDatsByMd5 已排好）；网格只要「能看」就先 `_t`。
    const ordered = args.thumbFirst === true
      ? [...candidates].sort((a, b) => Number(isThumbTier(b)) - Number(isThumbTier(a)) || datTierRank(a) - datTierRank(b))
      : candidates
    await acquireDecodeSlot()
    try {
      for (const file of ordered) {
        const tier = isThumbTier(file)
        try {
          const st = await fs.stat(file)
          if (st.size > MAX_DAT_BYTES) continue
          const bytes = await fs.readFile(file)
          const dec = await decodeDatBytesAsync(new Uint8Array(bytes), args.aesKey ?? null, args.xorKey ?? 0xff)
          if ('error' in dec) continue
          if (dec.format === 'hevc') continue
          const ext = dec.format === 'jpeg' ? 'jpg' : dec.format
          if (!WRITE_EXTS.has(ext)) continue
          const rel = key + (tier ? '.t.' : '.') + ext
          try {
            await fs.mkdir(args.decodedDir, { recursive: true })
            await fs.writeFile(join(args.decodedDir, rel), Buffer.from(dec.bytes))
          } catch { /* 写缓存失败不影响本次显示（协议层会 404，但调用方拿到 file 也没用） */ }
          if (!existsSync(join(args.decodedDir, rel))) continue
          return { file: rel, format: ext, thumb: tier }
        } catch { /* 该档读不动/解不开：试下一档 */ }
      }
      return { error: '附件原图解密失败（档位都不可渲染）' }
    } finally {
      releaseDecodeSlot()
    }
  })()
  inFlight.set(flightKey, work)
  try {
    return await work
  } finally {
    inFlight.delete(flightKey)
  }
}
