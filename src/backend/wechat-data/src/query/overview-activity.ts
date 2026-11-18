/**
 * 总览趋势用的「会话 × 日」条数。
 *
 * 洞察扫描的 `GROUP BY` 已经按 `create_time / 86400` 出了日桶。把这份桶留在分片
 * 缓存里，趋势就不必再打开同一批消息库。日桶是数据本身，和「现在」无关；
 * 7/30/90 天窗口在加总时才套上。
 */

/** talker → 日序号（`create_time / 86400`）→ 条数。 */
export type TalkerDayCounts = Map<string, Map<number, number>>

/** 磁盘缓存里的按日条数。 */
export type PackedTalkerDays = Array<[string, Array<[number, number]>]>

export function addTalkerDay(days: TalkerDayCounts, talker: string, day: number, n: number): void {
  if (!talker || n === 0) return
  let bucket = days.get(talker)
  if (bucket === undefined) {
    bucket = new Map()
    days.set(talker, bucket)
  }
  bucket.set(day, (bucket.get(day) ?? 0) + n)
}

export function mergePackedTalkerDays(into: TalkerDayCounts, packed: PackedTalkerDays | undefined): void {
  if (!packed) return
  for (const [talker, rows] of packed) {
    for (const [day, n] of rows) addTalkerDay(into, talker, day, n)
  }
}

export function freezeTalkerDays(days: TalkerDayCounts): PackedTalkerDays {
  const out: PackedTalkerDays = []
  for (const [talker, rows] of days) {
    const packed: Array<[number, number]> = []
    for (const [day, n] of rows) if (n !== 0) packed.push([day, n])
    if (packed.length > 0) out.push([talker, packed])
  }
  return out
}

export function dayKeyOf(sec: number): string {
  return new Date(sec * 1000).toISOString().slice(0, 10)
}

/** 与原先 extras 循环同一套窗口：日桶起点对比 `now` 往前的 7/14/30/60/90 天。 */
export interface ActivityRollup {
  dayCounts: Map<string, number>
  m7: number
  m30: number
  m60: number
  prev7: number
  prev30: number
  contactActive7: Set<string>
  contactActive30: Set<string>
  groupActive7: Set<string>
  groupActive30: Set<string>
  lastSync: number
}

export function rollupTalkerDays(days: TalkerDayCounts, nowSec: number): ActivityRollup {
  const day7 = nowSec - 7 * 86400
  const day30 = nowSec - 30 * 86400
  const day60 = nowSec - 60 * 86400
  const day14 = nowSec - 14 * 86400
  const day90 = nowSec - 90 * 86400
  const dayCounts = new Map<string, number>()
  let m7 = 0
  let m30 = 0
  let m60 = 0
  let prev7 = 0
  let prev30 = 0
  const contactActive7 = new Set<string>()
  const contactActive30 = new Set<string>()
  const groupActive7 = new Set<string>()
  const groupActive30 = new Set<string>()
  let lastSync = 0
  for (const [talker, rows] of days) {
    const isGroup = talker.includes('@chatroom')
    for (const [d, n] of rows) {
      const day = d * 86400
      if (day + 86399 < day90) continue
      const k = dayKeyOf(day)
      dayCounts.set(k, (dayCounts.get(k) ?? 0) + n)
      if (day >= day7) {
        m7 += n
        if (isGroup) groupActive7.add(talker)
        else contactActive7.add(talker)
      }
      if (day >= day30) {
        m30 += n
        if (isGroup) groupActive30.add(talker)
        else contactActive30.add(talker)
      }
      if (day >= day60) m60 += n
      if (day >= day14 && day < day7) prev7 += n
      if (day >= day60 && day < day30) prev30 += n
      if (day > lastSync) lastSync = day + 86399
    }
  }
  return {
    dayCounts, m7, m30, m60, prev7, prev30,
    contactActive7, contactActive30, groupActive7, groupActive30, lastSync,
  }
}
