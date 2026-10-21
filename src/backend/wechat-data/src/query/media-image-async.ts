/**
 * `media-image.ts` 的异步媒体解码面。
 *
 * 同步面（`decodeImageDataUrl` / `decodeEmoticonDataUrl`）仍保留给测试与不跨 RPC 的调用；
 * 生产媒体 RPC 必须走这里的 async 入口：原始 .dat、缓存与写入都走 fs/promises，
 * wxgf → ffmpeg 兜底再 await 子进程，尽量不让 worker 事件循环做磁盘/进程等待。
 */
import { access, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { isMd5 } from '../md5.ts'
import { normalizeAesKey } from '../keys/image-key.ts'
import { emoticonIndexFor, emoticonMissFresh, findEmoticonDats, noteEmoticonMiss } from './emoticon-index.ts'
import {
  RENDERABLE_EXTS,
  datTierOf,
  datTierRank,
  decodeDatPayload,
  findDatFiles,
  isThumbTier,
  msgTableName,
  renderWxgfTranscode,
  resolveImageFilePath,
  resolveImageResourceHint,
  type DecodeDatPayload,
  type ImageResourceHint,
} from './media-image.ts'
import { transcodeWxgfAsync, type WxgfTranscoderAsync } from './wxam-image.ts'

export type AsyncImageResult = {
  url?: string
  format?: string
  thumb?: boolean
  /** 相对 decoded_images 的落盘路径（如 `wxid_x/ab12.jpg`）：桌面端拼 wechat-media://，手机端忽略。 */
  file?: string
  error?: string
}

export interface DecodeImageOptions {
  /** Hint already resolved by the batch entry; avoids a per-image shard lookup. */
  hint?: ImageResourceHint
  /** Return only the decoded file path when possible; skip base64 in fileOnly mode. */
  fileOnly?: boolean
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/** 异步版 `cachedImage`：缓存读取不再占用 worker 事件循环。 */
async function cachedImageAsync(
  dir: string,
  md5: string,
  fileOnly = false,
): Promise<{ url?: string; format?: string; thumb?: boolean; file?: string } | null> {
  for (const thumb of [false, true]) {
    for (const ext of RENDERABLE_EXTS) {
      const p = join(dir, md5 + (thumb ? '.t.' : '.') + ext)
      if (!(await pathExists(p))) continue
      const fmt = ext === 'jpeg' ? 'jpg' : ext
      if (fileOnly) {
        try {
          if (!(await stat(p)).isFile()) return null
          return { format: fmt, ...(thumb ? { thumb: true } : {}), file: p }
        } catch {
          return null
        }
      }
      try {
        const bytes = await readFile(p)
        return { url: toDataUrl(fmt, new Uint8Array(bytes)), format: fmt, ...(thumb ? { thumb: true } : {}), file: p }
      } catch {
        // 与同步入口一致：坏缓存落到 .dat 重解，而不是把读失败当成答案。
        return null
      }
    }
  }
  return null
}

/** 异步版 `probeDecodedCache`：读失败与未命中的措辞保持同步入口同款。 */
async function probeDecodedCacheAsync(
  dir: string,
  md5: string,
  exts: readonly string[],
  failNote: string,
): Promise<{ hit: { url: string; format: string } } | { error: string } | null> {
  for (const ext of exts) {
    const p = join(dir, md5 + '.' + ext)
    if (!(await pathExists(p))) continue
    try {
      const bytes = await readFile(p)
      const format = ext === 'jpeg' ? 'jpg' : ext
      return { hit: { url: toDataUrl(format, new Uint8Array(bytes)), format } }
    } catch (e) {
      return { error: failNote + ': ' + (e as Error).message }
    }
  }
  return null
}

/**
 * 异步版 `decodeDatBytes`。解密本身仍是 CPU 内的纯计算；wxgf 转码时才会真正 await。
 */
export async function decodeDatBytesAsync(
  data: Uint8Array,
  aesKey: Uint8Array | string | null,
  xorKey: number,
  opts: { wxgf?: WxgfTranscoderAsync } = {},
): Promise<{ bytes: Uint8Array; format: string } | { error: string }> {
  const payload = decodeDatPayload(data, aesKey, xorKey)
  if ('error' in payload || payload.format !== 'wxgf') return payload
  const t = await (opts.wxgf ?? transcodeWxgfAsync)(payload.bytes)
  return renderWxgfTranscode(payload.bytes, t)
}

/**
 * 依次异步解码候选 `.dat`，第一个可渲染的结果收工。语义与同步 helper 完全一致。
 */
async function decodeDatToResultAsync(
  files: readonly string[],
  aesBytes: Uint8Array | null,
  xorKey: number,
  onDecoded: (file: string, dec: { format: string; bytes: Uint8Array }) => void | Promise<void>,
  includeDataUrl = true,
): Promise<{ url?: string; format: string; file: string; bytes: Uint8Array } | null> {
  for (const f of files) {
    try {
      const bytes = await readFile(f)
      const dec = await decodeDatBytesAsync(new Uint8Array(bytes), aesBytes, xorKey)
      if ('error' in dec || dec.format === 'hevc') continue
      try {
        await onDecoded(f, dec)
      } catch { /* cache best-effort */ }
      return {
        ...(includeDataUrl ? { url: toDataUrl(dec.format, dec.bytes) } : {}),
        format: dec.format,
        file: f,
        bytes: dec.bytes,
      }
    } catch { /* try next candidate */ }
  }
  return null
}

function toDataUrl(format: string, bytes: Uint8Array): string {
  const mime = format === 'jpg' ? 'jpeg' : format
  return 'data:image/' + mime + ';base64,' + Buffer.from(bytes).toString('base64')
}

/** `decodeImageDataUrl` 的异步版；生产 `getImageDataUrl` / 批量取图走这里。 */
export async function decodeImageDataUrlAsync(
  decryptedDir: string,
  decodedDir: string,
  username: string,
  localId: number,
  wechatBaseDir?: string,
  aesKey?: string | Uint8Array,
  xorKey?: number,
  options: DecodeImageOptions = {},
): Promise<AsyncImageResult> {
  const hint = options.hint ?? resolveImageResourceHint(decryptedDir, username, localId)
  const md5 = hint.md5
  const fileOnly = options.fileOnly === true
  // 桌面临时路径：落盘成功才回填，失败时留给 data URL 兜底（不能把不存在的路径发给渲染层）。
  let writtenFile = ''
  const relFile = (abs: string): string => relative(decodedDir, abs).split('\\').join('/')
  if (!md5 && !hint.dataIndex) return { error: '无法找到图片 MD5' }
  if (md5) {
    const hit = await cachedImageAsync(decodedDir, md5, fileOnly)
      ?? await cachedImageAsync(join(decodedDir, username), md5, fileOnly)
    if (hit) return hit.file === undefined ? hit : { ...hit, file: relFile(hit.file) }
  }
  // 老缓存里的 `.hevc` 占位只在所有可重解路径都失败后用于给出一致的降级文案；
  // 这里不调同步能力探测（首次探测会加载 DLL，反而先卡住 worker）。
  const hasHevc = md5 ? await pathExists(join(decodedDir, username, md5 + '.hevc')) : false
  if (wechatBaseDir && md5) {
    const attach = join(wechatBaseDir, 'msg', 'attach', msgTableName(username).replace(/^Msg_/, ''))
    const dats = findDatFiles(attach, md5)
    if (dats.length > 0) {
      const aesBytes = normalizeAesKey(aesKey)
      const ordered = [...dats].sort((a, b) => datTierRank(a) - datTierRank(b))
      writtenFile = ''
      const r = await decodeDatToResultAsync(ordered, aesBytes, xorKey ?? 0xff, (f, dec) => {
        const dir = join(decodedDir, username)
        const out = join(dir, md5 + (isThumbTier(f) ? '.t.' : '.') + dec.format)
        return mkdir(dir, { recursive: true })
          .then(() => writeFile(out, Buffer.from(dec.bytes)))
          .then(() => { writtenFile = out })
      }, !fileOnly)
      if (r) {
        return {
          ...(r.url !== undefined
            ? { url: r.url }
            : writtenFile === ''
              ? { url: toDataUrl(r.format, r.bytes) }
              : {}),
          format: r.format,
          ...(isThumbTier(r.file) ? { thumb: true } : {}),
          ...(writtenFile === '' ? {} : { file: relFile(writtenFile) }),
        }
      }
      return { error: 'hevc-unsupported' }
    }
  }
  if (wechatBaseDir) {
    const hd = resolveImageFilePath(decryptedDir, wechatBaseDir, md5 ?? '', hint.dataIndex)
    if (hd) {
      writtenFile = ''
      const r = await decodeDatToResultAsync([hd], normalizeAesKey(aesKey), xorKey ?? 0xff, (f, dec) => {
        const key = md5 || 'data-' + hint.dataIndex
        const dir = join(decodedDir, username)
        const out = join(dir, key + (isThumbTier(f) ? '.t.' : '.') + dec.format)
        return mkdir(dir, { recursive: true })
          .then(() => writeFile(out, Buffer.from(dec.bytes)))
          .then(() => { writtenFile = out })
      }, !fileOnly)
      if (r) {
        return {
          ...(r.url !== undefined
            ? { url: r.url }
            : writtenFile === ''
              ? { url: toDataUrl(r.format, r.bytes) }
              : {}),
          format: r.format,
          ...(isThumbTier(r.file) ? { thumb: true } : {}),
          ...(writtenFile === '' ? {} : { file: relFile(writtenFile) }),
        }
      }
    }
  }
  if (hasHevc) return { error: 'hevc-unsupported' }
  return { error: md5 ? '找不到 .dat 文件 (MD5=' + md5 + ')' : '无法定位图片文件 (data_index=' + hint.dataIndex + ')' }
}

/** `decodeEmoticonDataUrl` 的异步版：缓存命中不 await，只有 .dat 解码可能起 ffmpeg。 */
export async function decodeEmoticonDataUrlAsync(
  decryptedDir: string,
  decodedDir: string,
  wechatBaseDir: string | undefined,
  md5: string | undefined,
  aesKey?: string | Uint8Array,
  xorKey = 0xff,
): Promise<{ url?: string; format?: string; error?: string }> {
  const m = (md5 ?? '').trim().toLowerCase()
  if (!isMd5(m)) return { error: '缺少表情 MD5' }
  const probed = await probeDecodedCacheAsync(decodedDir, m, RENDERABLE_EXTS, '读取已解码表情失败')
  if (probed && 'error' in probed) return { error: probed.error }
  if (probed) return { url: probed.hit.url, format: probed.hit.format }
  if (!wechatBaseDir) return { error: '表情未缓存且缺少原始微信目录' }
  const attachRoot = join(wechatBaseDir, 'msg', 'attach')
  if (!(await pathExists(attachRoot))) return { error: '表情未缓存且找不到 msg/attach' }
  if (emoticonMissFresh(attachRoot, m)) return { error: '未找到表情文件 (MD5=' + m + ')' }
  const dats = findEmoticonDats(emoticonIndexFor(attachRoot), m)
  if (dats.length === 0) {
    noteEmoticonMiss(attachRoot, m)
    return { error: '未找到表情文件 (MD5=' + m + ')' }
  }
  const aesBytes = normalizeAesKey(aesKey)
  const THUMB_FIRST: Record<ReturnType<typeof datTierOf>, number> = { thumb: 0, other: 1, chat: 2, original: 3 }
  const ordered = [...dats].sort((a, b) => THUMB_FIRST[datTierOf(a)] - THUMB_FIRST[datTierOf(b)])
  const r = await decodeDatToResultAsync(ordered, aesBytes, xorKey, (f, dec) => {
    return writeFile(join(decodedDir, m + '.' + dec.format), Buffer.from(dec.bytes))
  })
  if (r) return { url: r.url, format: r.format }
  return { error: '表情文件无法解码为浏览器可渲染格式' }
}

/** 文件库只读已解码缓存，无子进程路径；提供 async 面是为了与其它媒体 RPC 同形。 */
export async function decodeFileImageDataUrlAsync(
  decryptedDir: string,
  decodedDir: string,
  wechatBaseDir: string | undefined,
  md5: string | undefined,
  aesKey?: string | Uint8Array,
  xorKey = 0xff,
): Promise<{ url?: string; error?: string }> {
  const m = (md5 ?? '').trim().toLowerCase()
  if (!isMd5(m)) return { error: '缺少图片 MD5' }
  const probed = await probeDecodedCacheAsync(decodedDir, m, ['jpg'], '读取已解码图片失败')
  if (probed && 'error' in probed) return { error: probed.error }
  if (probed) return { url: probed.hit.url }
  return { error: '未找到已解密图片（decoded_images/' + m + '.jpg 不存在）' }
}

export type { DecodeDatPayload }
