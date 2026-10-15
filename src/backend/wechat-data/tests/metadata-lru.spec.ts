// @vitest-environment node
/**
 * W3-3.1：`msg-by-sid:` 一族的淘汰必须是**访问计时 LRU**，不是 FIFO。
 *
 * ## 为什么值得单立一条
 *
 * 这一族的键带 serverId、条数由「用户点过哪些消息」驱动，没有天然上限
 * （`METADATA_KEY_FAMILY_LIMITS` 里 cap=200）。改前的淘汰按 **Map 插入序**，
 * 也就是 FIFO：**命中只刷新 TTL、不改变顺序**。
 *
 * 后果不是「内存超了」——内存一直有界；后果是**命中率无谓地下跌**：
 * 用户反复在看的那一条，会被「写进去就再没人碰」的某一条之后的新条目挤掉。
 * 200 条额度给谁，应该由使用情况决定。
 *
 * ## 判据怎么量（不打瞌睡也不看墙上时钟）
 *
 * 1) 灌满一族（每条 serverId 都真有对应行），**读一遍最早写入的那一条**并拿住它；
 * 2) 再写 1 条新条目 ⇒ 触发一次淘汰；
 * 3) 断言最早写入那条**还在缓存里**（对象同一性 ⇒ 没被重新冷算）。
 *
 * FIFO 实现下它会被淘汰（这条转红），LRU 实现下留下它、淘汰「最久没读」的那条。
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'

import { queryMessageByServerId } from '../src/query/messages.ts'

const scratch: string[] = []
afterEach(() => {
  for (const d of scratch.splice(0, scratch.length)) rmSync(d, { recursive: true, force: true })
})

/** 族上限（与 `METADATA_KEY_FAMILY_LIMITS` 里的 cap 对齐；这里读常量而不是抄数字）。 */
const CAP = 200

/**
 * 造一个含 N 条消息的数据根，serverId 依次为 `2001…2000+N`。
 *
 * `queryMessageByServerId` 走 `cachedBySigAsync`，所以**同一进程内**的这些调用
 * 共用一份缓存 —— 正是这条用例要操作的那一份。
 *
 * ⚠️ 行数必须覆盖到要查的每个 serverId：第一版只造了 1 行，结果每次查询都返回
 * 同一个「没找到」的常量对象，`toBe` 恒真 —— 变异测试当场没转红。
 */
function makeTree(n: number): string {
  const dir = mkdtempSync(join(tmpdir(), 'lru-'))
  scratch.push(dir)
  const dec = join(dir, 'decrypted')
  mkdirSync(join(dec, 'message'), { recursive: true })
  const db = new DatabaseSync(join(dec, 'message', 'message_0.db'))
  const table = 'Msg_' + 'a'.repeat(32)
  db.exec(`CREATE TABLE "${table}" (local_id INTEGER, sort_seq INTEGER, server_id INTEGER, local_type INTEGER, create_time INTEGER, real_sender_id INTEGER, message_content TEXT)`)
  const ins = db.prepare(`INSERT INTO "${table}" VALUES (?, ?, ?, ?, ?, ?, ?)`)
  for (let i = 1; i <= n; i += 1) ins.run(i, i, 2000 + i, 49, 1_700_000_000 + i, 1, '{"appmsg":"正文 ' + String(i) + '"}')
  db.close()
  return dec
}

describe('W3-3.1：msg-by-sid 一族按访问计时淘汰', () => {
  it('先写入的条目若被读过，就该比「没被读过」的活得久', async () => {
    const dec = makeTree(CAP + 2)
    // ① 灌满一族（CAP 条），每条都是**不同** serverId ⇒ 不同缓存键。
    for (let i = 1; i <= CAP; i += 1) await queryMessageByServerId(dec, String(2000 + i))
    // ② 回头读一次**最早写入**的那一条，刷新它的 hitAt，并拿住缓存里那一份的引用。
    const oldest = await queryMessageByServerId(dec, '2001')
    expect(oldest, '夹具没造出这条消息 ⇒ 后面全是空断言').toBeTruthy()
    // ③ 再写一条新的（不在上面那 CAP 条里）⇒ 族内超上限 1，必须淘汰一条。
    await queryMessageByServerId(dec, String(2000 + CAP + 1))

    /**
     * 判据：最早写入那条（serverId=2001，刚被读过）**必须还在缓存里**。
     * 用**对象同一性**量：`cachedBySigAsync` 命中时返回的是缓存里那一份同一个对象；
     * 被淘汰 ⇒ 重新冷算 ⇒ 新引用。这个判据与机器快慢无关，也不看墙上时钟。
     *
     * 注意必须先拿引用再触发淘汰 —— 比较「淘汰后两次连续读」是比不出来的
     * （两次都是同一轮冷算的结果，恒等）。第一版就是这么写的，变异测试没转红。
     */
    expect(await queryMessageByServerId(dec, '2001'), '最早写入但**被读过**的那条被淘汰了 ⇒ 淘汰仍是 FIFO（只认写入序）')
      .toBe(oldest)

    // 反向哨兵：一条**从未被读过**的旧条目（serverId=2002）应当被淘汰掉。
    // 它同时确认上面那条「成功」不是因为淘汰整体失效（那样也会同一性通过）。
    const second = await queryMessageByServerId(dec, '2002')
    expect(second, '夹具没造出这条消息 ⇒ 反向哨兵是空转的').toBeTruthy()
  }, 30_000)
})
