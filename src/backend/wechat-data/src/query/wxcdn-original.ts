/**
 * WxCDN 原图下载：用本机微信配置换 token，按 `cdnbigimgurl` 的 fileid 取回**真原图**。
 *
 * ## 为什么需要它（2026-10-17 实测）
 *
 * 本项目的原图链路此前只有两条，都不够用：
 *
 * | 通路 | 实测结果 |
 * |---|---|
 * | 消息 XML 的 `tphdurl`/`tpurl` | 本机 20,431 条**全部**指向企业微信 `wwfile` 端点，匿名 GET 一律 403 |
 * | 本机 `_h.dat` | 只有 1,459 个（用户点开过才有），覆盖率约 3% |
 *
 * 而 `cdnbigimgurl`（占 81.6%）此前被判定为「需要微信登录态凭据，本应用不做」。
 * 实测发现：**存在一个第三方服务 `wxcdn.c3o.re`，它接受本机微信的 `global_config`
 * 换 token，然后按 fileid 返回原图字节**。这条路不需要登录、不需要读进程内存、
 * 不需要 hook —— 只读本机已有的两个配置文件。
 *
 * ## 协议（实测确认）
 *
 * 1. `POST /token`（multipart：`weixinIDFolder` / `fileBytes` / `crcBytes` / `tokenDuration`）
 *    → `{ token, expiresAt, account: { plan }, quota: { limitBytes, usedBytes, remainingBytes } }`
 * 2. `GET /download?fileid=<cdnbigimgurl>&type=orig&key=<aeskey>`（`Authorization: Bearer`）
 *    → 图片字节（**带 `key=` 时服务端解密**，返回可直接渲染的 JPEG/PNG）
 *
 * ⚠️ **必须带 `key=`**：不带时返回的是 AES 密文（实测 3,502,640 字节，头 `c502e100…`），
 * 本地用 `aeskey` 按 hex 解码后 AES-128-ECB 解**也解不出**（实测头 `04693b23…`）。
 * 服务端解密是唯一可行路径。
 *
 * ## 边界（写清楚，别让人以为它免费无限）
 *
 *   · **按流量计费**：Free 套餐 50 MB/天，实测下载 2.7 MB 一张就扣 2.7 MB。
 *     所以本模块**只在用户显式开启**时才被调用（`autoFetchOriginal` 开关），
 *     且每次调用前检查剩余额度。
 *   · **fileid 会过期**：实测同一条消息的 fileid 隔一段时间后返回 404。
 *     所以失败要如实回报「fileid 已过期，请在微信里重新打开这张图」。
 *   · **第三方服务**：`wxcdn.c3o.re` 不是腾讯官方服务。用户数据（`global_config`）
 *     会发给它 —— 这一点必须在隐私声明里写明，且默认关闭。
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { MD5_SEGMENT } from '../md5.ts'

/** 服务基址（第三方，非腾讯官方）。 */
const BASE_URL = 'https://wxcdn.c3o.re'
const TOKEN_URL = BASE_URL + '/token'
const DOWNLOAD_URL = BASE_URL + '/download'

/** token 有效期档位（服务端支持 short/medium/long）。 */
const TOKEN_DURATION = 'medium'

/** 单次下载超时（原图可达几 MB，给足时间）。 */
const DOWNLOAD_TIMEOUT_MS = 120_000
/** 换 token 超时。 */
const TOKEN_TIMEOUT_MS = 30_000

/** 进程内缓存的 token（按 wxid 分）。 */
interface CachedToken {
  token: string
  expiresAt: number
  plan: string
  remainingBytes: number
  limitBytes: number
  /** 额度重置时间（秒级时间戳）。缓存命中时也要能显示，否则界面会显示成 1970 年。 */
  resetsAt: number
}
const tokenCache = new Map<string, CachedToken>()

/** 一次下载的结果。 */
export interface WxcdnDownloadResult {
  /** 图片字节（服务端已解密）。 */
  bytes?: Uint8Array
  /** 嗅出来的格式（jpg/png/gif/webp）。 */
  format?: string
  /** 失败原因（可直接显示给用户）。 */
  error?: string
  /** 本次消耗的字节数（用于额度提示）。 */
  costBytes?: number
}

/** 额度快照（界面显示「剩余 N MB」）。 */
export interface WxcdnQuota {
  plan: string
  limitBytes: number
  usedBytes: number
  remainingBytes: number
  /** 额度重置时间（Unix 秒）。 */
  resetsAt: number
}

/**
 * 从微信数据根找 `all_users/config` 目录。
 *
 * 目录结构：`<xwechat_files>/all_users/config/{global_config, global_config.crc}`。
 * `rawRoot` 是 `<xwechat_files>/<wxid>_<hash>`，所以往上两级。
 *
 * ⚠️ **`all_users/config` 是全局共享的，但内容只属于「当前登录的那个账号」**：
 * 微信切换账号时会重写这两个文件。所以换账号后必须重新换 token（缓存按目录名分，
 * 天然不会串），否则服务端会回 `400 invalid_config`（实测：拿 A 账号的
 * `global_config` 配 B 账号的目录名，一律 400）。
 * @param rawRoot - 微信账号原始根（`msg/attach` 的父目录）。
 * @returns 配置目录的绝对路径；不存在时 null。
 */
function configDirOf(rawRoot: string): string | null {
  const dir = join(rawRoot, '..', 'all_users', 'config')
  return existsSync(join(dir, 'global_config')) ? dir : null
}

/**
 * 从账号目录名推出 `weixinIDFolder`。
 *
 * 实测：服务端要的是**完整目录名**（`wxid_xxx_<hash>`），不是裸 wxid ——
 * 传裸 wxid 会回 `400 invalid_config`。
 * @param rawRoot - 微信账号原始根。
 * @returns 目录名（`wxid_xxx_<hash>`）。
 */
function folderNameOf(rawRoot: string): string {
  const parts = rawRoot.split(/[\\/]/).filter((s) => s !== '')
  return parts[parts.length - 1] ?? ''
}

/**
 * 换 token（带进程内缓存）。
 *
 * 服务端按 IP 限频（10 秒 3 次），所以缓存是必需的 —— 每张图都换一次会被 429。
 * @param rawRoot - 微信账号原始根。
 * @returns token 与额度；失败时 `{ error }`。
 */
async function ensureToken(rawRoot: string): Promise<{ token?: string; quota?: WxcdnQuota; error?: string }> {
  const folder = folderNameOf(rawRoot)
  const cached = tokenCache.get(folder)
  // 提前 5 分钟视为过期，避免边界上刚好失效。
  if (cached !== undefined && cached.expiresAt * 1000 - Date.now() > 5 * 60 * 1000) {
    return {
      token: cached.token,
      quota: { plan: cached.plan, limitBytes: cached.limitBytes, usedBytes: cached.limitBytes - cached.remainingBytes, remainingBytes: cached.remainingBytes, resetsAt: cached.resetsAt },
    }
  }

  const cfgDir = configDirOf(rawRoot)
  if (cfgDir === null) return { error: '找不到微信配置目录（all_users/config），无法换取原图下载凭据' }

  let blob1: Buffer
  let blob2: Buffer
  try {
    blob1 = readFileSync(join(cfgDir, 'global_config'))
    blob2 = readFileSync(join(cfgDir, 'global_config.crc'))
  } catch (e) {
    return { error: '读取微信配置文件失败: ' + (e as Error).message }
  }

  const form = new FormData()
  form.append('weixinIDFolder', folder)
  form.append('tokenDuration', TOKEN_DURATION)
  form.append('fileBytes', new Blob([new Uint8Array(blob1)], { type: 'application/octet-stream' }), 'global_config')
  form.append('crcBytes', new Blob([new Uint8Array(blob2)], { type: 'application/octet-stream' }), 'global_config.crc')

  let res: Response
  try {
    res = await fetch(TOKEN_URL, { method: 'POST', body: form, signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS) })
  } catch (e) {
    return { error: '连接原图服务失败: ' + (e as Error).message }
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    // 400 invalid_config = 目录名与 global_config 不匹配。最常见成因：微信里刚换了账号，
    // 但 `all_users/config` 还没被新账号重写（或本应用读的是旧快照）。
    if (res.status === 400 && text.includes('invalid_config')) {
      return { error: '原图服务不认这个账号的配置（invalid_config）：请在微信里切到该账号并保持登录，再点「查额度」重试' }
    }
    return { error: `换取原图下载凭据失败（HTTP ${String(res.status)}）${text.slice(0, 120)}` }
  }
  const body = (await res.json().catch(() => ({}))) as {
    token?: string
    expiresAt?: number
    account?: { plan?: string }
    quota?: { limitBytes?: number; usedBytes?: number; remainingBytes?: number; resetsAt?: number }
  }
  const token = String(body.token ?? '')
  if (token === '') return { error: '原图服务没有返回凭据' }

  const quota: WxcdnQuota = {
    plan: String(body.account?.plan ?? 'Free'),
    limitBytes: Number(body.quota?.limitBytes ?? 0),
    usedBytes: Number(body.quota?.usedBytes ?? 0),
    remainingBytes: Number(body.quota?.remainingBytes ?? 0),
    resetsAt: Number(body.quota?.resetsAt ?? 0),
  }
  tokenCache.set(folder, {
    token,
    expiresAt: Number(body.expiresAt ?? 0),
    plan: quota.plan,
    remainingBytes: quota.remainingBytes,
    limitBytes: quota.limitBytes,
    resetsAt: quota.resetsAt,
  })
  return { token, quota }
}

/** 只认浏览器能直接渲染的那几种魔数。 */
function sniffFormat(b: Uint8Array): string | null {
  if (b.length < 12) return null
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png'
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg'
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'gif'
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'webp'
  return null
}

/**
 * 按 fileid 下载原图（服务端解密）。
 *
 * ⚠️ **必须带 `key=`**：不带时返回 AES 密文，本地解不出（实测确认）。
 * @param rawRoot - 微信账号原始根。
 * @param fileid - 消息 XML 的 `cdnbigimgurl`（或 `cdnmidimgurl`）。
 * @param aesKey - 消息 XML 的 `aeskey`（32 位 hex）。
 * @returns 图片字节与格式；失败时 `{ error }`。
 */
export async function downloadOriginalByFileid(
  rawRoot: string,
  fileid: string,
  aesKey: string,
): Promise<WxcdnDownloadResult> {
  const id = String(fileid ?? '').trim()
  if (id === '') return { error: '这条消息没有 CDN 文件标识' }
  const key = String(aesKey ?? '').trim().toLowerCase()
  if (!new RegExp('^' + MD5_SEGMENT + '$').test(key)) return { error: '这条消息的 aeskey 形态不对，无法解密原图' }

  const t = await ensureToken(rawRoot)
  if (t.token === undefined) return { error: t.error ?? '换取凭据失败' }
  if (t.quota !== undefined && t.quota.remainingBytes <= 0) {
    return { error: `今日原图额度已用完（${t.quota.plan} 套餐 ${String(Math.round(t.quota.limitBytes / 1024 / 1024))} MB/天），明天重置` }
  }

  const url = new URL(DOWNLOAD_URL)
  url.searchParams.set('fileid', id)
  url.searchParams.set('type', 'orig')
  url.searchParams.set('key', key)

  let res: Response
  try {
    res = await fetch(url, {
      headers: { Authorization: 'Bearer ' + t.token },
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    })
  } catch (e) {
    return { error: '下载原图失败: ' + (e as Error).message }
  }
  if (res.status === 404) {
    return { error: '这条原图已过期（CDN 文件标识失效），请在微信里重新打开这张图后再试' }
  }
  if (res.status === 401) {
    tokenCache.delete(folderNameOf(rawRoot))
    return { error: '原图下载凭据已失效，请重试' }
  }
  if (res.status === 429) {
    return { error: '原图服务限流或额度不足，请稍后再试' }
  }
  if (!res.ok) {
    return { error: `下载原图失败（HTTP ${String(res.status)}）` }
  }

  const bytes = new Uint8Array(await res.arrayBuffer())
  if (bytes.length === 0) return { error: '原图下载回来是空文件' }
  const format = sniffFormat(bytes)
  if (format === null) {
    return { error: '原图下载回来不是可识别的图片格式（服务端可能未解密）' }
  }
  // 更新缓存里的剩余额度（服务端按实际字节扣）。
  const folder = folderNameOf(rawRoot)
  const c = tokenCache.get(folder)
  if (c !== undefined) c.remainingBytes = Math.max(0, c.remainingBytes - bytes.length)
  return { bytes, format, costBytes: bytes.length }
}

/**
 * 读当前额度（界面显示「剩余 N MB」）。
 * @param rawRoot - 微信账号原始根。
 * @returns 额度快照；失败时 `{ error }`。
 */
export async function fetchQuota(rawRoot: string): Promise<{ quota?: WxcdnQuota; error?: string }> {
  const t = await ensureToken(rawRoot)
  if (t.quota === undefined) return { error: t.error ?? '读额度失败' }
  return { quota: t.quota }
}

/**
 * 清掉进程内缓存的 token（切换账号 / 用户手动刷新时用）。
 * @param rawRoot - 微信账号原始根；省略则清全部。
 */
export function clearWxcdnToken(rawRoot?: string): void {
  if (rawRoot === undefined) tokenCache.clear()
  else tokenCache.delete(folderNameOf(rawRoot))
}
