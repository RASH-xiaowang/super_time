/**
 * 「当前登录账号」的展示信息（昵称/备注/别名），供侧栏品牌位显示用户网名。
 *
 * ## 为什么需要
 *
 * 侧栏品牌位原来写死 `Super Time`；用户要求改成自己的网名/昵称。微信自己的资料
 * 就落在 `contact.db` 的 `contact` 表里（`username` = 自己的 wxid，实测该行存在，
 * `nick_name` = `SuperT_王国宁`）。这里只读一行，不复用 `queryContacts()` 的全表扫描
 * （那个要读 3000+ 联系人，给侧栏常驻组件太重）。
 *
 * ## 边界
 *
 *  - 只读本机库，不联网、不碰登录态；
 *  - 未解密/表缺失/没有该行：`name` 为空串，调用方回退品牌名（绝不能因为取不到名字而不渲染）；
 *  - 显示优先级与微信一致：备注 > 昵称 > 微信号（alias）。
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { resolveSelfUsername } from '../config/index.ts'
import { withDb } from './db-open.ts'

/** 当前账号展示信息。`username` 可能为空（还没配置/未解密），`name` 可能为空（回退品牌名）。 */
export interface SelfProfile {
  username: string
  /** 备注 > 昵称 > 别名；都取不到时为空串。 */
  name: string
  /** 微信号（alias），有就带上，供界面 tooltip 区分同名。 */
  alias?: string
}

/** SQLite 里可能是 TEXT/INTEGER/BLOB：统一成可读字符串（与 query 层其它 cellStr 同口径）。 */
function cellStr(v: unknown): string {
  if (typeof v === 'string') return v
  if (v === null || v === undefined) return ''
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return String(v)
  if (v instanceof Uint8Array) return new TextDecoder('utf-8', { fatal: false }).decode(v)
  return ''
}

/**
 * 读当前账号的昵称（备注 > 昵称 > 别名）。
 * @param decryptedDir - 已解密数据根。
 * @returns `{username, name, alias?}`；任何一步取不到都给空串而不是抛错。
 */
export function querySelfProfile(decryptedDir: string): SelfProfile {
  const username = resolveSelfUsername(decryptedDir)
  if (username === '') return { username: '', name: '' }
  const path = join(decryptedDir, 'contact', 'contact.db')
  if (!existsSync(path)) return { username, name: '' }
  let name = ''
  let alias = ''
  try {
    withDb(path, (db) => {
      const has = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='contact'").get() !== undefined
      if (!has) return
      const row = db.prepare('SELECT nick_name, remark, alias FROM contact WHERE username = ? LIMIT 1').get(username) as
        | { nick_name?: unknown; remark?: unknown; alias?: unknown }
        | undefined
      if (!row) return
      alias = cellStr(row.alias).trim()
      name = cellStr(row.remark).trim() || cellStr(row.nick_name).trim() || alias
    })
  } catch { /* 未解密 / 读失败：回退品牌名 */ }
  return alias === '' ? { username, name } : { username, name, alias }
}
