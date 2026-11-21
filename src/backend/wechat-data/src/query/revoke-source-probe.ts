/**
 * 撤回列表的**源库探测**（2026-11-19 从 `revoke-retain.ts` 拆出）。
 *
 * ## 为什么要单独一个模块
 *
 * 一是 `revoke-retain.ts` 顶到了文件尺寸棘轮（1000 行）；二是这里做的事与"归档"
 * 完全正交：归档回答「我们曾经看到过什么」，探测回答「微信**现在**把它们改成了什么」。
 * 后者是判定「归档里那行到底是不是撤回原文」的唯一依据，值得独立成篇、单独测。
 *
 * ## 为什么必须探测（真机结论）
 *
 * 微信撤回是**就地改写**那一行：原文不再以任何形式留在库里。于是「提示前一条」
 * 大多数时候只是**上一条不相干的消息**。旧实现不看源库就把前者当作原文，
 * 真机 4,554 条提示里只有 208 条真的存下了原文，其余显示的都是上一条 ——
 * 用户因此"看不到撤回的内容是啥"。
 *
 * ## 成本
 *
 * 只扫 `local_type = 10000` 的行再解码判断，不碰 50 余万条普通消息。
 * 结果按消息目录签名缓存（探测"哪些行现在是提示"这件事与分页无关，
 * 分页翻十次不必重扫十次）。
 *
 * @module query/revoke-source-probe
 */
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { withDb } from './db-open.ts'
import { decodeBlobText } from './messages.ts'

/** 撤回提示的文本特征（真机实测：`"某某" 撤回了一条消息`）。 */
const REVOKE_TIP = '撤回了一条消息'

/** 源库某行的**当前状态**——判定「归档里那行到底是不是撤回原文」的唯一依据。 */
export type SourceRowState =
  /** 源库已没有这一行（被删除）⇒ 我们存下的就是它。 */
  | 'deleted'
  /** 源库这一行已变成撤回提示（微信**就地改写**）⇒ 我们存下的就是原文。 */
  | 'rewritten'
  /** 源库这一行还是原样 ⇒ 它不是被撤回的那条，只是"提示前一条"。 */
  | 'intact'
  /** 分片/表读不到（离线、权限）⇒ 无法判定。 */
  | 'unknown'

/** `talker\u0000rowKey` → 状态。用分隔符避免 `Msg_a` 与 `Msg_a1` 撞键。 */
export function stateKey (talker: string, k: number): string {
  return talker + '\u0000' + String(k)
}

/** 一条源库撤回提示：提示正文 + 时间。 */
export interface SourceTip {
  text: string
  /** 提示行的 `create_time`（秒）。 */
  ct: number
}

/** talker → rowKey → 提示。 */
export type SourceTipMap = Map<string, Map<number, SourceTip>>

/** 按消息目录的签名缓存「哪些行现在是提示」——这一步与分页无关，不必每页重扫。 */
let tipCache: { sig: string; tips: SourceTipMap } = { sig: '', tips: new Map() }

/** 消息目录签名：文件名 + 纳秒 mtime + 大小。任一变化就重扫。 */
function dirSig (msgDir: string): string {
  let out = ''
  try {
    for (const f of readdirSync(msgDir).sort()) {
      if (!f.endsWith('.db')) continue
      try {
        const st = statSync(join(msgDir, f), { bigint: true })
        out += f + ':' + String(st.mtimeNs) + ':' + String(st.size) + ';'
      } catch { out += f + ':?;' }
    }
  } catch { return '' }
  return out
}

/** `talker`（`message_0.db#Msg_xxx`）→ 分片文件名与表名。 */
function splitTalker (talker: string): { file: string; table: string } | null {
  const hash = talker.indexOf('#')
  if (hash <= 0) return null
  return { file: talker.slice(0, hash), table: talker.slice(hash + 1) }
}

/**
 * 扫出**当前**所有撤回提示行：`talker → rowKey → {text, ct}`。
 *
 * 只读分片、不写；每个分片按 `withDb` 开一次连接（遵守连接纪律）。
 * 结果按目录签名缓存 —— 分页翻页时命中缓存，只有微信真的写入新消息才重扫。
 *
 * @param decryptedDir - 解密数据根。
 * @returns 提示行集合；目录不存在或全部读不动时为空 Map。
 */
export function scanSourceTips (decryptedDir: string): SourceTipMap {
  const msgDir = join(decryptedDir, 'message')
  if (!existsSync(msgDir)) return new Map()
  const sig = dirSig(msgDir)
  if (sig !== '' && sig === tipCache.sig) return tipCache.tips

  const tips: SourceTipMap = new Map()
  let files: string[] = []
  try {
    files = readdirSync(msgDir).filter(f => f.endsWith('.db') && !f.includes('_shm') && !f.includes('_wal'))
  } catch { return tips }

  for (const file of files) {
    const path = join(msgDir, file)
    if (!existsSync(path)) continue
    try {
      withDb(path, (db) => {
        const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'Msg\\_%' ESCAPE '\\'").all() as Array<{ name: string }>)
          .map(r => String(r.name))
        for (const table of tables) {
          let cols: Set<string>
          try {
            cols = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(r => r.name))
          } catch { continue }
          if (!cols.has('message_content') || !cols.has('local_type')) continue
          const ctCol = cols.has('create_time') ? 'create_time AS ct' : '0 AS ct'
          let rows: Array<{ k: number; ct: number; mc: unknown }>
          try {
            rows = db.prepare(`SELECT rowid AS k, ${ctCol}, message_content AS mc FROM ${table} WHERE local_type = 10000`)
              .all() as Array<{ k: number; ct: number; mc: unknown }>
          } catch { continue }
          if (rows.length === 0) continue
          const map = new Map<number, SourceTip>()
          for (const r of rows) {
            const text = decodeBlobText(r.mc)
            if (text.includes(REVOKE_TIP)) map.set(Number(r.k), { text, ct: Number(r.ct ?? 0) })
          }
          if (map.size > 0) tips.set(file + '#' + table, map)
        }
      })
    } catch { /* 该分片读不动 ⇒ 跳过，绝不整体失败 */ }
  }
  if (sig !== '') tipCache = { sig, tips }
  return tips
}

/**
 * 查一批行的**当前状态**（点查，通常几百行）。
 *
 * 按分片分组，每个文件只开一次连接。
 * @param decryptedDir - 解密数据根。
 * @param wanted - talker → 需要校验的 row_key。
 * @returns `stateKey → 状态`；读不到的分片保持 `unknown`（调用方据此降级为"推定"）。
 */
export function probeRowStates (
  decryptedDir: string,
  wanted: ReadonlyMap<string, ReadonlySet<number>>,
): Map<string, SourceRowState> {
  const states = new Map<string, SourceRowState>()
  const msgDir = join(decryptedDir, 'message')
  if (!existsSync(msgDir)) return states

  /** 按文件分组：一个分片只开一次连接。 */
  const byFile = new Map<string, Array<{ talker: string; table: string; keys: ReadonlySet<number> }>>()
  for (const [talker, keys] of wanted) {
    const split = splitTalker(talker)
    if (split === null) continue
    const list = byFile.get(split.file) ?? []
    list.push({ talker, table: split.table, keys })
    byFile.set(split.file, list)
  }

  for (const [file, entries] of byFile) {
    const path = join(msgDir, file)
    if (!existsSync(path)) continue
    try {
      withDb(path, (db) => {
        const hasTable = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?")
        for (const { talker, table, keys } of entries) {
          if (keys.size === 0) continue
          if (hasTable.get(table) === undefined) {
            // 表没了（换了分片/会话被清）⇒ 归档里那些行在源库都算"已删除"。
            for (const k of keys) states.set(stateKey(talker, k), 'deleted')
            continue
          }
          let sel
          try {
            sel = db.prepare(`SELECT local_type AS lt, message_content AS mc FROM ${table} WHERE rowid = ?`)
          } catch { continue }
          for (const k of keys) {
            const row = sel.get(k) as { lt?: number; mc?: unknown } | undefined
            if (row === undefined) { states.set(stateKey(talker, k), 'deleted'); continue }
            const text = decodeBlobText(row.mc)
            const isTip = Number(row.lt ?? 0) === 10000 && text.includes(REVOKE_TIP)
            states.set(stateKey(talker, k), isTip ? 'rewritten' : 'intact')
          }
        }
      })
    } catch { /* 读不动 ⇒ 保持 unknown */ }
  }
  return states
}

/** 仅供测试：清掉模块级缓存（不同用例用不同临时目录时必须调）。 */
export function resetSourceProbeCache (): void {
  tipCache = { sig: '', tips: new Map() }
}
