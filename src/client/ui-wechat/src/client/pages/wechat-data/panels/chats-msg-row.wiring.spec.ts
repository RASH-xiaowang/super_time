/**
 * 消息行组件的**接线**守卫（#19 第二刀的另一半）。
 *
 * 与 `chats-polling.wiring.spec.ts` 同一个道理：搬出去的渲染若没人挂，界面不会坏掉 ——
 * 只是 `useChatsThread` 里那一坨 JSX 又会长回来（这一次是六份闭包依赖 + 68 行 JSX），
 * 而"头像身份键"那条规则一旦重新散进钩子，就又变成只能靠注释提醒的样子了。
 */
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readStripped } from './wiring-kit.ts'

const HERE = import.meta.dirname

/** 行渲染的指纹：出现在 `useChatsThread` 里就说明那段 JSX 又长了回去。 */
const ROW_FINGERPRINTS = ['<Avatar', '<MessageBody', '<MessageImageGroup', 'msgRowSelf', 'renderKindOf('] as const

describe('消息行组件的接线', () => {
  const thread = readStripped(join(HERE, 'chats-thread.tsx'))
  const rowmod = readStripped(join(HERE, 'chats-msg-row.tsx'))

  it('哨兵：两份文件都真读到了东西（读空 ⇒ 下面的「不含」全恒真）', () => {
    expect(thread.length, 'chats-thread.tsx 没读到').toBeGreaterThan(2000)
    expect(rowmod.length, 'chats-msg-row.tsx 没读到').toBeGreaterThan(2000)
  })

  it('useChatsThread 真的在用 makeMsgRow（把它摘掉 = 会话里再也不画消息）', () => {
    expect(thread).toContain('makeMsgRow(')
  })

  it('行的 JSX 与分类器不许再长在 useChatsThread 里', () => {
    for (const fp of ROW_FINGERPRINTS) {
      expect(thread, `chats-thread.tsx 里又出现了 ${fp} —— 行渲染要待在 chats-msg-row.tsx`).not.toContain(fp)
    }
  })

  it('chats-msg-row.tsx 自己五件齐全（少一件就是搬漏了一支）', () => {
    for (const fp of ROW_FINGERPRINTS) {
      expect(rowmod, `chats-msg-row.tsx 里少了 ${fp}`).toContain(fp)
    }
  })

  it('反例自证：明知含指纹的合成源码必须被同一个判据抓住', () => {
    const fake = thread + '\nconst leak = <Avatar name={x} username={y} size={34} />\n'
    const bites = ROW_FINGERPRINTS.filter((fp) => fake.includes(fp))
    expect(bites.length, '合成违例一个指纹都没命中 ⇒ 指纹清单是空的').toBeGreaterThan(0)
    expect(thread, '合成违例的指纹在真文件里本来就命中 ⇒ 上面那条"不含指纹"是假绿').not.toContain(bites[0]!)
  })
})
