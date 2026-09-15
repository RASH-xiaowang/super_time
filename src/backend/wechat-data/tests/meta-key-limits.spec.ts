/**
 * N16（附带项）：`meta.ts` 的全局 `entries` Map 原来**没有任何上限**。
 *
 * 会涨的是 key 里带用户输入的族：`msg-by-sid:<dir>:<serverId>` 的条数由「用户点过哪些
 * 消息」驱动（M11 复审实测负条目 ~740B、命中条目还可能含整份 rich），点得越多涨得越多。
 * 处理方式是按**前缀**限界，而不是给整张表设全局 cap —— 后者会把 `contact-meta:` /
 * `shard-meta:` 这类「条数由数据目录决定（几十条）但最贵」的条目一起挤掉。
 *
 * 两条用例分别守住这两面：该族**超限会淘汰**、其他族**不被牵连**。
 *
 * @vitest-environment node
 */
import { afterEach, describe, expect, it } from 'vitest'
import { METADATA_KEY_FAMILY_LIMITS, cachedBySig, invalidateWechatMeta } from '../src/query/meta.ts'

afterEach(() => {
  invalidateWechatMeta()
})

/** 该族的容量上限（从实现里读，用例不跟着常量漂）。 */
const MSG_BY_SID_CAP = METADATA_KEY_FAMILY_LIMITS.find(l => l.prefix === 'msg-by-sid:')!.cap

describe('N16：entries 的按需限界', () => {
  it('msg-by-sid: 超过上限后淘汰最老的条目（内存有上界）', () => {
    const key = (i: number): string => `msg-by-sid:/root:${i}`
    let loads = 0
    const loader = (): string => { loads += 1; return 'v' }
    for (let i = 0; i <= MSG_BY_SID_CAP; i += 1) cachedBySig(key(i), 's', loader, 3_600_000)

    // 最新一条还在（超限淘汰的是最老的，不是整族清空）
    const afterInsert = loads
    cachedBySig(key(MSG_BY_SID_CAP), 's', loader, 3_600_000)
    expect(loads, '刚写进去的条目被淘汰了').toBe(afterInsert)

    // 最老的一条必须已经不在缓存里（没有限界时它是命中的 → 这里会红）
    cachedBySig(key(0), 's', loader, 3_600_000)
    expect(loads, 'msg-by-sid: 没有上限，entries 会一直涨').toBe(afterInsert + 1)
  })

  it('限界只作用于该族：高频且昂贵的元数据条目不会被挤掉（全局 cap 会误伤）', () => {
    let loads = 0
    const hot = (): string => { loads += 1; return 'hot' }
    // 先写一条「最贵但条数有限」的条目：contact-meta 要整表读 contact.db
    cachedBySig('contact-meta:/root', 's', hot, 3_600_000)
    // 再模拟「用户狂点消息 + 翻各种面板」：写入远超任何合理 cap 的条目
    for (let i = 0; i < MSG_BY_SID_CAP * 4; i += 1) cachedBySig(`msg-by-sid:/root:${i}`, 's', () => i, 3_600_000)
    for (let i = 0; i < 500; i += 1) cachedBySig(`overview:other:${i}`, 's', () => i, 3_600_000)

    cachedBySig('contact-meta:/root', 's', hot, 3_600_000)
    expect(loads, 'contact-meta 被挤掉了 —— 说明用的是全局 cap，而不是按族限界').toBe(1)
  })
})
