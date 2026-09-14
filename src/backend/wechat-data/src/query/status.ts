/**
 * Decrypted DB status summary, rewritten from st_control
 * handlers/data/media.rs get_wechat_db_status.
 */
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { cachedBySig, dataGenerationSig } from './meta.ts'

const LABEL_MAP: Array<[string, string]> = [
  ['session', '会话(session)'],
  ['message', '消息(message)'],
  ['contact', '通讯录(contact)'],
  ['sns', '朋友圈(sns)'],
  ['favorite', '收藏(favorite)'],
  ['emoticon', '表情(emoticon)'],
  ['hardlink', '文件(hardlink)'],
  ['general', '通用(general)'],
  ['bizchat', '公众号(bizchat)'],
  ['head_image', '头像缓存(head_image)'],
  ['solitaire', '接龙(solitaire)'],
  ['backup', '备份(backup)'],
]
const EXCLUDED = ['monitor_cache', 'exports']

/** Recursively check whether a directory contains any .db file (max depth 5). */
function hasDbFile(dir: string, depth = 0): boolean {
  if (depth > 5 || !existsSync(dir)) return false
  let entries: Array<{ name: string; isDir: boolean }> = []
  try { entries = readdirSync(dir, { withFileTypes: true }).map(e => ({ name: e.name, isDir: e.isDirectory() })) } catch { return false }
  for (const e of entries) {
    const p = join(dir, e.name)
    if (e.isDir) { if (hasDbFile(p, depth + 1)) return true }
    else if (e.name.endsWith('.db')) return true
  }
  return false
}

/**
 * Summarize the decrypted DB directories as status lines (cached ~5s).
 * @param decryptedDir - decrypted data root.
 * @returns status lines plus the resolved path.
 */
export function getDbStatus(decryptedDir: string): { lines: string[]; path: string } {
  const key = 'db-status:' + decryptedDir
  // 这份快照统计的是**整棵** decrypted 树，没法用某一个文件的签名表达，所以用数据世代
  // 签名（实时同步落地后 +1）。**不要**换成「整树签名」—— 那要每次查询都 stat 成千上万个
  // 文件，比缓存本身还贵；也不要沿用原先的常量签名 + 靠「事件后整表清空」兜底（M8 去掉了
  // 那层兜底，常量签名会让它只能等 5s TTL）。
  return cachedBySig(key, dataGenerationSig(), () => computeDbStatus(decryptedDir))
}

function computeDbStatus(decryptedDir: string): { lines: string[]; path: string } {
  const lines: string[] = []
  if (!existsSync(decryptedDir)) {
    lines.push('⚠️ 解密目录不存在')
    return { lines, path: decryptedDir }
  }
  let dirs: Array<{ name: string }> = []
  try {
    dirs = readdirSync(decryptedDir, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => ({ name: e.name }))
      .sort((a, b) => a.name.localeCompare(b.name))
  } catch (e) {
    lines.push('⚠️ 读取目录失败: ' + (e as Error).message)
    return { lines, path: decryptedDir }
  }
  for (const d of dirs) {
    if (EXCLUDED.includes(d.name) || d.name.startsWith('.')) continue
    const ok = hasDbFile(join(decryptedDir, d.name))
    const label = LABEL_MAP.find(([k]) => k === d.name)?.[1] ?? d.name
    lines.push(ok ? label + ': ✅ 可用' : label + ': ⚠️ 空目录')
  }
  lines.push('路径: ' + decryptedDir)
  return { lines, path: decryptedDir }
}
