/**
 * WeChat user avatar resolution, rewritten from st_control modules/avatar.rs.
 * Priority: head_image.db image_buffer (data URL) -> contact small/big_head_url.
 */
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** Sniff an image format from magic bytes. */
function sniffImageFormat(data: Uint8Array): string {
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'jpeg'
  if (data.length >= 4 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) return 'png'
  if (data.length >= 4 && data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x38) return 'gif'
  if (data.length >= 12 && data[0] === 0x52 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x46 && data[8] === 0x57 && data[9] === 0x45 && data[10] === 0x42 && data[11] === 0x50) return 'webp'
  return 'jpeg'
}

/** Coerce a DB cell to a string (null -> '', else String()). */
function cellStr(v: unknown): string {
  if (typeof v === 'string') return v
  if (v === null || v === undefined) return ''
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint' || typeof v === 'symbol') return String(v)
  return ''
}

/** Avatar from head_image.db image_buffer. */
function avatarFromHeadImageDb(decryptedDir: string, username: string): string | null {
  const dbPath = join(decryptedDir, 'head_image', 'head_image.db')
  if (!existsSync(dbPath)) return null
  try {
    const db = new DatabaseSync(dbPath, { readOnly: true })
    const has = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='head_image'").get() !== undefined
    if (!has) { db.close(); return null }
    const row = db.prepare('SELECT image_buffer AS b FROM head_image WHERE username = ? ORDER BY update_time DESC LIMIT 1').get(username) as { b?: unknown } | undefined
    db.close()
    if (!row) return null
    const buf = row.b instanceof Uint8Array ? row.b : null
    if (!buf || buf.length < 16) return null
    const fmt = sniffImageFormat(buf)
    return 'data:image/' + fmt + ';base64,' + Buffer.from(buf).toString('base64')
  } catch {
    return null
  }
}

/** Avatar URL from contact table (small then big). */
function avatarUrlFromContact(decryptedDir: string, username: string): string | null {
  const dbPath = join(decryptedDir, 'contact', 'contact.db')
  if (!existsSync(dbPath)) return null
  try {
    const db = new DatabaseSync(dbPath, { readOnly: true })
    const has = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='contact'").get() !== undefined
    if (!has) { db.close(); return null }
    const cols = (db.prepare('PRAGMA table_info(contact)').all() as Array<{ name: string }>).map(r => r.name)
    if (!cols.includes('username')) { db.close(); return null }
    const small = cols.includes('small_head_url') ? 'small_head_url' : 'NULL'
    const big = cols.includes('big_head_url') ? 'big_head_url' : 'NULL'
    const row = db.prepare('SELECT COALESCE(NULLIF(' + small + ", ''), " + big + ') AS u FROM contact WHERE username = ? LIMIT 1').get(username) as { u?: unknown } | undefined
    db.close()
    const url = row?.u ? cellStr(row.u) : ''
    return url ? url : null
  } catch {
    return null
  }
}


/** Avatar from the raw temp/head_image cache (file name = md5(avatar URL), plain JPEG/PNG). */
function avatarFromTempHeadFile(wechatBaseDir: string | undefined, url: string): string | null {
  if (!wechatBaseDir || !url) return null
  const hash = createHash('md5').update(Buffer.from(url, 'utf8')).digest('hex')
  const f = join(wechatBaseDir, 'temp', 'head_image', hash)
  if (!existsSync(f)) return null
  try {
    const buf = readFileSync(f)
    if (buf.length < 16) return null
    const fmt = sniffImageFormat(new Uint8Array(buf))
    return 'data:image/' + fmt + ';base64,' + buf.toString('base64')
  } catch {
    return null
  }
}

/** Contact row (username + avatar URL + head_img_md5) found by exact nick_name. */
function contactByNickname(decryptedDir: string, nickname: string): { username: string; url: string; md5: string } | null {
  if (!nickname) return null
  const dbPath = join(decryptedDir, 'contact', 'contact.db')
  if (!existsSync(dbPath)) return null
  try {
    const db = new DatabaseSync(dbPath, { readOnly: true })
    const has = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='contact'").get() !== undefined
    if (!has) { db.close(); return null }
    const cols = (db.prepare('PRAGMA table_info(contact)').all() as Array<{ name: string }>).map(r => r.name)
    if (!cols.includes('username') || !cols.includes('nick_name')) { db.close(); return null }
    const small = cols.includes('small_head_url') ? 'small_head_url' : 'NULL'
    const big = cols.includes('big_head_url') ? 'big_head_url' : 'NULL'
    const md = cols.includes('head_img_md5') ? 'head_img_md5' : 'NULL'
    const sql =
      `SELECT username, COALESCE(NULLIF(${small}, ''), ${big}) AS u, ${md} AS m ` +
      `FROM contact WHERE nick_name = ? AND COALESCE(NULLIF(${small}, ''), ${big}) != '' LIMIT 1`
    const row = db.prepare(sql).get(nickname) as { u?: unknown; m?: unknown; username?: unknown } | undefined
    db.close()
    if (!row) return null
    const username = cellStr(row.username)
    const url = cellStr(row.u)
    return username && url ? { username, url, md5: cellStr(row.m) } : null
  } catch {
    return null
  }
}
/**
 * 是否可作为远端头像返回。
 *
 * 只放行 **https**：M23 之后这个地址不再由 `<img>` 直接吃，而是交给后端图片代理
 * （`query/remote-image.ts`），而它明确拒 https 以外的协议（`fetchRemoteImage` 里那句
 * 「图片地址不是 https」）。本机 1,994 个联系人 URL 里 1,594 个是 https
 * （wx.qlogo.cn / mmhead.c2c.wechat.com / thirdwx.qlogo.cn / wework.qpic.cn，
 * 后两个主机分别落在白名单的 `qlogo.cn` 与 `wechat.com`/`qpic.cn` 后缀里），
 * 400 个是 http —— 返回了也取不回来，不如如实返回 none。
 */
function remoteAvatarUrl(url: string | null | undefined): string | null {
  const u = (url ?? '').trim()
  return /^https:\/\//i.test(u) ? u : null
}

/**
 * Resolve a user avatar.
 * Priority: head_image.db by username -> contact URL (temp cache data URL first) ->
 * 远端 https URL -> contact matched by nick_name（同样顺序）-> none.
 *
 * 第 41 轮改动：本地实在没有时**返回 https 远端 URL**（此前直接返回 none，
 * 连 URL 都丢掉）。实测本地覆盖只有 17.4%（head_image.db 356 行 + temp 缓存 28 个），
 * 而 79.2% 的联系人有可用的 https 头像 URL；前端 6 处调用点**早已**写好
 * `kind === 'url'` 分支（只是后端从不返回）。
 * @param decryptedDir - decrypted data root.
 * @param username - contact or chatroom username.
 * @param wechatBaseDir - raw WeChat install root (temp/head_image cache).
 * @param nickname - optional display name for contact-by-nickname fallback.
 * @returns kind + data URL / remote URL.
 */
export function resolveAvatar(
  decryptedDir: string,
  username: string,
  wechatBaseDir?: string,
  nickname?: string,
): { kind: string; data?: string; url?: string } {
  const data = avatarFromHeadImageDb(decryptedDir, username)
  if (data) return { kind: 'data', data }
  const url = avatarUrlFromContact(decryptedDir, username)
  if (url) {
    const temp = avatarFromTempHeadFile(wechatBaseDir, url)
    if (temp) return { kind: 'data', data: temp }
    const remote = remoteAvatarUrl(url)
    if (remote) return { kind: 'url', url: remote }
    return { kind: 'none' }
  }
  if (nickname) {
    const c = contactByNickname(decryptedDir, nickname)
    if (c) {
      const temp = avatarFromTempHeadFile(wechatBaseDir, c.url)
      if (temp) return { kind: 'data', data: temp }
      const head = avatarFromHeadImageDb(decryptedDir, c.username)
      if (head) return { kind: 'data', data: head }
      const remote = remoteAvatarUrl(c.url)
      if (remote) return { kind: 'url', url: remote }
      return { kind: 'none' }
    }
  }
  return { kind: 'none' }
}

/** 一次打开 contact.db,取一批 username 的头像 URL(small 优先,回落 big)。 */
function contactAvatarUrlMap(decryptedDir: string, usernames: string[]): Map<string, string> {
  const out = new Map<string, string>()
  const dbPath = join(decryptedDir, 'contact', 'contact.db')
  if (!existsSync(dbPath)) return out
  try {
    const db = new DatabaseSync(dbPath, { readOnly: true })
    const has = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='contact'").get() !== undefined
    if (has) {
      const cols = (db.prepare('PRAGMA table_info(contact)').all() as Array<{ name: string }>).map(r => r.name)
      if (cols.includes('username')) {
        const small = cols.includes('small_head_url') ? 'small_head_url' : 'NULL'
        const big = cols.includes('big_head_url') ? 'big_head_url' : 'NULL'
        const stmt = db.prepare(`SELECT COALESCE(NULLIF(${small}, ''), ${big}) AS u FROM contact WHERE username = ? LIMIT 1`)
        for (const username of usernames) {
          const row = stmt.get(username) as { u?: unknown } | undefined
          const url = row?.u ? cellStr(row.u) : ''
          if (url) out.set(username, url)
        }
      }
    }
    db.close()
  } catch { /* best effort */ }
  return out
}

/**
 * 批量读取头像:head_image.db 优先,未命中再用 contact 表的头像 URL 兜底。
 *
 * 三级取值来源(优先级从高到低):
 *   ① `head_image.db` 的 image_buffer → data URL(纯本地,不联网)
 *   ② `temp/head_image` 缓存文件(文件名 = md5(头像 URL))→ data URL(同上)
 *   ③ contact 表的 **https** URL(仅 `allowRemote` 时返回)
 *
 * 为什么必须有后两级:图谱面板一次要 250 个头像,而 `head_image.db` 只覆盖本机收过的
 * 那些 —— 真机实测「好友图」上 240 个节点只命中 131 个,另外 109 个只能画成
 * 「社区色 + 首字」,看起来就是「有些节点没有头像」。contact 表里 96% 的人有头像 URL,
 * 其中 80% 是 https（http 连后端图片代理都不取 —— `fetchRemoteImage` 明确只放行 https，所以不返回）。
 *
 * 第 ③ 级交出的只是**地址**，取回动作在渲染层的 api 层完成（M23）：`apiGetAvatarsLocal` 把
 * 非本机的那几条交给后端 `query/remote-image.ts` 代取成 data URL，界面拿到的只剩能直接画的地址。
 * 于是「自动获取原图（CDN）」与「禁止出网」真的管得到头像 —— 这一类此前由 `<img>` 直连，
 * 两个开关都拦不到它。图谱把它画进 canvas 再导出 PNG 时拿到的已是 data URL，
 * 不存在跨域污染（远程地址时代要靠 `crossOrigin='anonymous'` 才不会让 `toDataURL()` 抛 SecurityError）。
 *
 * @param decryptedDir - 解密数据根目录。
 * @param usernames - 需要头像的用户名。
 * @param opts - `wechatBaseDir`(找 temp 缓存)与 `allowRemote`(是否放行远端 URL;
 *   调用方在用户开了「出站拦截」时传 false)。
 * @returns username → data URL 或 https URL（远程那一级由渲染层再换成 data URL）；未命中的不出现在结果中。
 */
export function resolveAvatarsLocal(
  decryptedDir: string,
  usernames: string[],
  opts: { wechatBaseDir?: string | undefined; allowRemote?: boolean } = {},
): Record<string, string> {
  const out: Record<string, string> = {}
  if (usernames.length === 0) return out
  const dbPath = join(decryptedDir, 'head_image', 'head_image.db')
  if (existsSync(dbPath)) {
    try {
      const db = new DatabaseSync(dbPath, { readOnly: true })
      const has = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='head_image'").get() !== undefined
      if (has) {
        const stmt = db.prepare('SELECT image_buffer AS b FROM head_image WHERE username = ? ORDER BY update_time DESC LIMIT 1')
        for (const username of usernames) {
          const row = stmt.get(username) as { b?: unknown } | undefined
          if (!row) continue
          const buf = row.b instanceof Uint8Array ? row.b : null
          if (!buf || buf.length < 16) continue
          const fmt = sniffImageFormat(buf)
          out[username] = 'data:image/' + fmt + ';base64,' + Buffer.from(buf).toString('base64')
        }
      }
      db.close()
    } catch { /* best effort */ }
  }
  const rest = usernames.filter(u => !(u in out))
  if (rest.length === 0) return out
  for (const [username, url] of contactAvatarUrlMap(decryptedDir, rest)) {
    const temp = avatarFromTempHeadFile(opts.wechatBaseDir, url)
    if (temp) { out[username] = temp; continue }
    if (opts.allowRemote) {
      const remote = remoteAvatarUrl(url)
      if (remote) out[username] = remote
    }
  }
  return out
}
