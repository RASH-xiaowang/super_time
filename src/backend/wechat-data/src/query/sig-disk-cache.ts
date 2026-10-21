/**
 * 「签名 + 结果」通用磁盘缓存（2026-10-21 性能专项）。
 *
 * ## 为什么
 *
 * 首屏里有若干**纯函数式**聚合：输入 = 若干只读库文件，输出 = 可 JSON 序列化的小对象。
 * 进程内已经用 `cachedBySig` 做了 30s 缓存，但**跨启动完全失效** —— 每次开应用都要把
 * 同样的 239 张 Msg_ 表再扫一遍（实测 `overviewExtras` 冷算 ~120ms、
 * `insights` 分片扫描 ~208ms）。
 *
 * 这里提供一个最小落盘层：`{sig, value}` 一起写，读的时候**逐字比对 sig**，
 * 只在不匹配时返回 null（调用方自己重算）。于是「数据一更新就失效」由签名保证，
 * 不依赖 TTL，也不需要清理逻辑。
 *
 * ## 纪律
 *
 *  - 纯缓存：不存在/损坏/没权限 ⇒ 返回 null；
 *  - 原子写：`.tmp` + rename，避免半写文件被当成有效值；
 *  - 大小上限：超过视为异常文件不读（防止坏数据拖慢启动）。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** 单个缓存文件大小上限：超过视为异常文件（正常结果只有几 KB）。 */
const MAX_BYTES = 8 * 1024 * 1024

/**
 * 读取「签名匹配」的缓存值。
 * @param path - 缓存文件路径。
 * @param sig - 当前数据的指纹。
 * @returns 命中返回值；未命中/损坏/签名不符返回 null。
 */
export function loadSigCached<T>(path: string, sig: string): T | null {
  try {
    if (!existsSync(path)) return null
    const text = readFileSync(path, 'utf8')
    if (text.length > MAX_BYTES) return null
    const parsed: unknown = JSON.parse(text)
    if (!parsed || typeof parsed !== 'object') return null
    const row = parsed as { sig?: unknown; value?: unknown }
    if (typeof row.sig !== 'string' || row.sig !== sig) return null
    if (row.value === undefined) return null
    return row.value as T
  } catch {
    return null
  }
}

/**
 * 原子写入「签名 + 值」。
 * @param path - 缓存文件路径。
 * @param sig - 当前数据的指纹。
 * @param value - 可 JSON 序列化的结果。
 * @returns true = 成功；失败只返回 false，不抛。
 */
export function saveSigCached<T>(path: string, sig: string, value: T): boolean {
  const tmp = path + '.tmp'
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(tmp, JSON.stringify({ sig, value }), 'utf8')
    renameSync(tmp, path)
    return true
  } catch {
    try { writeFileSync(tmp, '', 'utf8') } catch { /* 清理失败也不影响 */ }
    return false
  }
}
