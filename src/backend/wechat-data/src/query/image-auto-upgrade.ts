/**
 * 自动取原图：`getImageDataUrl` 返回缩略图时，**后端自己**再试一次升级，不需要用户点按钮。
 *
 * ## 为什么放在后端而不是前端
 *
 * 前端 `MessageImage` 每次渲染都会调 `getImageDataUrl`（虚拟列表一屏几十张）。如果让前端
 * 在拿到 `thumb: true` 后再发一次 `getImageOriginal`，那是**每张图两个 RPC**，而且前端
 * 还要管「这张试过了别再试」的状态。放在后端就只有一个 RPC，且升级结果直接落进缓存槽，
 * 下一次渲染自然命中。
 *
 * ## 三条升级路径（按代价从低到高）
 *
 * | 路径 | 代价 | 命中条件 |
 * |---|---|---|
 * | ① 本机重解 | 纯本地，几十毫秒 | 用户已在微信里点开过（attach 里有 `_h.dat`） |
 * | ② CDN 直链 | 一次网络往返 | XML 带 `tphdurl`/`tpurl` 且主机不是企业微信端点 |
 * | ③ 放弃 | 0 | 只有 `cdnbigimgurl`（需登录态，本应用不做） |
 *
 * 2026-10-17 实测：本机 20,431 条 `tpurl` 全部指向企业微信 `wwfile` 端点（匿名 GET 一律 403），
 * 所以路径 ② 在本机数据上产出为 0；真正有效的是路径 ①。
 *
 * ## 为什么要有「试过就别再试」的记忆
 *
 * 一张图如果三条路都不通（本机只有缩略图 + 无直链），每次渲染都重试就是**每次几十毫秒的
 * 白烧**（虚拟列表滚动时同一张图会被反复挂载）。所以进程内记一份「已试过且失败」的 md5 集合，
 * 带 TTL（默认 10 分钟）—— 用户中途在微信里点开了原图，10 分钟后会自动再试一次。
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { clearDecodedImageCache, resolveImageResourceHint, writeDecodedCache, type ImageResourceHint } from './media-image.ts'
import { decodeImageDataUrlAsync } from './media-image-async.ts'
import { fetchImageOriginalToCache, resolveImageOriginalLink } from './image-original.ts'
import { recordFetchedOriginal } from './image-original-batch.ts'
import { downloadOriginalByFileid } from './wxcdn-original.ts'
import { getConfig } from '../config/wechat-config.ts'
import { DatabaseSync } from './db-open.ts'
import { decompress } from 'fzstd'
import { createHash } from 'node:crypto'
import { shardCatalogDirs } from './meta.ts'

/** zstd magic（4.x 的 `message_content` 是压缩的）。 */
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/**
 * 「用第三方服务取原图」开关是否打开（默认关闭）。
 *
 * 默认关闭的理由：`wxcdn.c3o.re` 不是腾讯官方服务，且需要把本机的
 * `all_users/config/global_config` 发给它，还按流量计费 —— 这类外发必须由用户显式打开。
 * @param decryptedDir - 解密数据根（配置从这里读）。
 * @returns 开关值；读不到配置时按关闭处理。
 */
function isWxcdnEnabled(decryptedDir: string): boolean {
  try {
    return getConfig(decryptedDir)['wxcdn_original_enabled'] === true
  } catch {
    return false
  }
}

/** 把 message_content 单元格解成文本。 */
function cellText(v: unknown): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'string') return v
  const b = Buffer.isBuffer(v) ? v : (v instanceof Uint8Array ? Buffer.from(v) : null)
  if (b === null) return String(v)
  let out = b
  if (b.length >= 4 && b.subarray(0, 4).equals(ZSTD_MAGIC)) {
    try { out = Buffer.from(decompress(b)) } catch { /* 按原字节试 */ }
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(out)
}

/**
 * 从消息 XML 里取 `cdnbigimgurl`（或 `cdnmidimgurl`）、`aeskey` 与 `md5`。
 *
 * ⚠️ **`md5` 必须从 XML 取，不能用 `resolveImageResourceHint` 的**：实测同一条消息
 * 两者会不一致（`packed_info_data` 里存的是另一份资源的 md5，例如 `472d560e…`，
 * 而 XML 的 `md5` 是 `9dd7feaa…`）。缓存键用错的话，下载成功了前端也读不到 ——
 * 它按 XML 的 md5 查缓存，永远 miss。
 * @param decryptedDir - 解密数据根。
 * @param username - 会话 username。
 * @param localId - 消息 local_id。
 * @returns `{ fileid, aesKey, md5 }`；拿不到时 null。
 */
function readCdnFileid(decryptedDir: string, username: string, localId: number): { fileid: string; aesKey: string; md5: string } | null {
  const table = 'Msg_' + createHash('md5').update(username, 'utf8').digest('hex')
  for (const shard of shardCatalogDirs(decryptedDir, ['message'])) {
    const meta = shard.tables.get(table)
    if (!meta) continue
    const contentCol = [...meta.cols].find((c) => String(c).toLowerCase().includes('message_content'))
    if (!contentCol) continue
    let db: DatabaseSync | null = null
    try { db = new DatabaseSync(shard.file, { readOnly: true }) } catch { continue }
    try {
      const row = db.prepare(`SELECT "${contentCol}" AS c FROM "${table}" WHERE local_id = ? LIMIT 1`).get(localId) as { c?: unknown } | undefined
      if (!row) continue
      const xml = cellText(row.c)
      const m = /<img\b([^>]*)>/i.exec(xml)
      if (m === null) continue
      const at: Record<string, string> = {}
      for (const p of (m[1] ?? '').matchAll(/([A-Za-z_][\w:-]*)\s*=\s*"([^"]*)"/g)) at[(p[1] ?? '').toLowerCase()] = p[2] ?? ''
      const fileid = (at['cdnbigimgurl'] ?? '') !== '' ? (at['cdnbigimgurl'] as string) : (at['cdnmidimgurl'] ?? '')
      const aesKey = at['aeskey'] ?? ''
      if (fileid === '' || aesKey === '') continue
      return { fileid, aesKey, md5: at['md5'] ?? '' }
    } catch { /* 这张分片读不动就试下一张 */ } finally {
      try { db?.close() } catch { /* 已关 */ }
    }
  }
  return null
}

/**
 * 走 WxCDN 取原图（`cdnbigimgurl` 的 fileid + 服务端解密）。
 *
 * 这是本机数据上**唯一能覆盖那 81.6%** 的通路：实测 6/6 成功，拿到真原图
 * （2,751 KB 的高清照片，不是缩略图）。按流量计费，所以只在用户开启开关时调用。
 * @param decryptedDir - 解密数据根。
 * @param decodedDir - 解码缓存根。
 * @param username - 会话 username。
 * @param localId - 消息 local_id。
 * @param wechatBaseDir - 微信原始目录（找 `all_users/config` 用）。
 * @param md5 - 图片内容 md5（缓存键）。
 * @returns 升级结果；`format` 为空表示失败。
 */
async function tryWxcdnUpgrade(
  decryptedDir: string,
  decodedDir: string,
  username: string,
  localId: number,
  wechatBaseDir: string,
  md5: string,
): Promise<AutoUpgradeResult> {
  const info = readCdnFileid(decryptedDir, username, localId)
  if (info === null) return { error: '这条消息没有 cdnbigimgurl' }
  const r = await downloadOriginalByFileid(wechatBaseDir, info.fileid, info.aesKey)
  if (r.bytes === undefined || r.format === undefined) return { error: r.error ?? 'WxCDN 下载失败' }
  // 缓存键优先用 XML 的 `md5`：前端按它查缓存，用 `packed_info_data` 那份会永远 miss。
  const cacheKey = info.md5 !== '' ? info.md5 : md5
  try {
    // 写全局槽（username 传空串），与 CDN 直链原图同一个位置。
    writeDecodedCache(decodedDir, '', cacheKey, r.format, r.bytes, false)
  } catch (e) {
    return { error: '写入缓存失败: ' + (e as Error).message }
  }
  return { format: r.format, bytes: r.bytes.length, via: 'wxcdn' }
}

/** 「已试过且失败」的记忆保留多久（毫秒）。用户中途点开原图后，过了这个时间会自动再试。 */
const RETRY_TTL_MS = 10 * 60 * 1000

/** 进程内记忆：`<username>|<localId>` → 上次失败的时间戳。 */
const triedAt = new Map<string, number>()

/** 自动升级的结果（给调用方决定要不要替换返回值）。 */
export interface AutoUpgradeResult {
  /** 升级成功时的格式。 */
  format?: string
  /** 升级成功时的字节数（CDN 路径才有）。 */
  bytes?: number
  /** 走的是哪条路（`local` / `cdn` / `wxcdn`）；失败时为空。 */
  via?: 'local' | 'cdn' | 'wxcdn'
  /** 失败原因（只用于日志，不显示给用户 —— 用户看到的是缩略图，不是错误）。 */
  error?: string
}

/**
 * 清掉「已试过」记忆（用户显式点「取原图」时调用，让那次一定真的重试）。
 * @param username - 会话 username。
 * @param localId - 消息 local_id。
 */
export function forgetAutoUpgradeAttempt(username: string, localId: number): void {
  triedAt.delete(username + '|' + String(localId))
}

/**
 * 尝试把一张缩略图升级成原图（**不联网优先**）。
 *
 * 调用方是 `getImageDataUrl`：它已经解出缩略图了，这里只负责「再试一次更好的」。
 * 失败是常态（本机 97% 的图微信从没下载过原图），所以**不抛异常、不写操作记录**。
 * @param decryptedDir - 解密数据根。
 * @param decodedDir - 解码缓存根。
 * @param username - 会话 username。
 * @param localId - 消息 local_id。
 * @param wechatBaseDir - 微信原始目录（本机 `.dat` 回退用）。
 * @param aesKey - V2 AES 密钥。
 * @param xorKey - XOR key 字节。
 * @param allowNetwork - 是否允许走 CDN 直链（默认 true；批量路径可关掉以免拖慢）。
 * @param options - optional resolved hint / fileOnly mode used by the batch entry.
 * @returns 升级结果；`format` 为空表示没升级成功。
 */
export async function tryUpgradeToOriginal(
  decryptedDir: string,
  decodedDir: string,
  username: string,
  localId: number,
  wechatBaseDir: string | undefined,
  aesKey: string | Uint8Array | undefined,
  xorKey: number,
  allowNetwork = true,
  options: { hint?: ImageResourceHint; fileOnly?: boolean } = {},
): Promise<AutoUpgradeResult> {
  const key = username + '|' + String(localId)
  const last = triedAt.get(key)
  if (last !== undefined && Date.now() - last < RETRY_TTL_MS) return { error: '最近试过，跳过' }

  const hint = options.hint ?? resolveImageResourceHint(decryptedDir, username, localId)
  if (!hint.md5) return { error: '拿不到 md5' }

  // ① 本机重解：清掉占坑的缩略图缓存，按本机最好的一档重解。
  //    这是本机数据上**唯一有效**的路径（用户点开过原图 ⇒ attach 里有 `_h.dat`）。
  clearDecodedImageCache(decodedDir, username, hint.md5)
  const redone = await decodeImageDataUrlAsync(
    decryptedDir, decodedDir, username, localId, wechatBaseDir, aesKey, xorKey,
    { hint, fileOnly: options.fileOnly },
  )
  if ((redone.url !== undefined || redone.file !== undefined) && redone.thumb !== true) {
    triedAt.delete(key)
    return { format: redone.format, via: 'local' }
  }

  // ② CDN 直链：只有 XML 带 `tphdurl`/`tpurl` 且不是企业微信端点时才可能成功。
  if (allowNetwork) {
    const link = resolveImageOriginalLink(decryptedDir, username, localId)
    if (link !== null) {
      const r = await fetchImageOriginalToCache(link, decodedDir)
      if (r.bytes !== undefined) {
        recordFetchedOriginal(decodedDir, link.md5)
        triedAt.delete(key)
        return { format: r.format, bytes: r.bytes, via: 'cdn' }
      }
    }
    // ③ WxCDN：用 `cdnbigimgurl` 的 fileid 走第三方服务（按流量计费，需用户开启）。
    //    这是本机数据上**唯一能覆盖那 81.6%** 的通路（实测 6/6 成功，拿到真原图）。
    if (wechatBaseDir !== undefined && isWxcdnEnabled(decryptedDir)) {
      const wx = await tryWxcdnUpgrade(decryptedDir, decodedDir, username, localId, wechatBaseDir, hint.md5)
      if (wx.format !== undefined) {
        triedAt.delete(key)
        return wx
      }
    }
  }

  // ③ 都不通：记下来，TTL 内不再重试（虚拟列表滚动会反复挂载同一张图）。
  triedAt.set(key, Date.now())
  return { error: '本机只有缩略图，且没有可用的免登录直链' }
}

/**
 * 清空全部「已试过」记忆（切换账号 / 用户手动触发全量重试时用）。
 */
export function clearAutoUpgradeMemory(): void {
  triedAt.clear()
}

/**
 * 读「已试过」记忆的条目数（诊断用）。
 * @returns 当前记住的失败条目数。
 */
export function autoUpgradeMemorySize(): number {
  return triedAt.size
}

/** 供测试注入时间（避免等 10 分钟）。 */
export const __testing = { RETRY_TTL_MS, triedAt, existsSync, join }
