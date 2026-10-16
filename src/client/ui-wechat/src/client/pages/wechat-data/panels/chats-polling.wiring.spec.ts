/**
 * 轮询族的**接线**守卫（#19 第一刀的另一半）。
 *
 * 行为判据（`chats-polling.spec.ts`）只证明"搬出去的那份是对的"；这一份管两件事：
 * ① 那个钩子**真的被挂着**（搬完就没人调用，是最体面的死法 —— 界面照旧画，只是永远不刷新）；
 * ② 这一族的形状不许在原处**再长一遍**（`useChatsThread` 之所以涨到 458 行，就是因为
 *    定时器 / 推送 / 对账 / 水位四件事一直就地写着）。
 *
 * 扫描一律走 `readStripped`（先剥注释）：本仓已经踩过三次「注释里的代码字样被当代码」，
 * 而 `chats-polling.ts` 的头部注释里就写着 `setInterval`、`visibilitychange` 这些词。
 */
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readStripped } from '../../../test-helpers/wiring-kit.ts'

const HERE = import.meta.dirname

/** 这一族的指纹：出现在 `useChatsThread` 里就说明有人又把轮询就地写了一遍。 */
const FINGERPRINTS = ['setInterval(', 'apiGetNewMessages', "addEventListener('visibilitychange'", 'dsh-wechat-data-updated', 'SNAPSHOT_REFRESHED_EVENT'] as const

describe('轮询族的接线', () => {
  const thread = readStripped(join(HERE, 'chats-thread.tsx'))

  it('哨兵：读到的不是空文件（剥注释读失败时「不含指纹」会恒真）', () => {
    expect(thread.length, 'chats-thread.tsx 没读到东西').toBeGreaterThan(2000)
  })

  it('useChatsThread 真的挂着 useChatsPolling（搬完不调用等于把刷新功能删了）', () => {
    expect(thread).toContain('useChatsPolling(')
  })

  it('这一族的四件指纹都不许再留在 useChatsThread 里', () => {
    for (const fp of FINGERPRINTS) {
      expect(thread, `chats-thread.tsx 里又出现了 ${fp} —— 轮询族要待在 chats-polling.ts`).not.toContain(fp)
    }
  })

  it('chats-polling.ts 自己把四个入口都接着（少一个就是少一条刷新路径）', () => {
    const polling = readStripped(join(HERE, 'chats-polling.ts'))
    expect(polling.length).toBeGreaterThan(2000)
    for (const fp of FINGERPRINTS) {
      expect(polling, `chats-polling.ts 里少了 ${fp}`).toContain(fp)
    }
  })

  it('反例自证：明知含指纹的合成源码必须被同一个判据抓住', () => {
    // 「不含」那两条要是不咬，整份守卫就是装饰 —— 这里当场造一个违例样本喂给同一段代码。
    const fake = thread + '\nconst leak = setInterval(() => { void apiGetNewMessages({}) }, 1000)\n'
    const bites = FINGERPRINTS.filter((fp) => fake.includes(fp))
    expect(bites.length, '合成违例居然一个指纹都没命中 ⇒ 指纹清单或扫描本身是空的').toBeGreaterThan(0)
    expect(thread, '合成违例的指纹在真文件里本来就命中 ⇒ 上面那条"不含指纹"是假绿').not.toContain(bites[0]!)
  })
})
