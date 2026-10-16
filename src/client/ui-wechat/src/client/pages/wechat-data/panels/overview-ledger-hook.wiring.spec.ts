/**
 * 真窗口验收用的那个钩子必须和它的唯一消费者一起存在（P2-4 打点）。
 *
 * 起因：`scripts/ledger-reload-e2e.mjs` 要判断"资金那一格此刻在不在屏上"。
 * 用文案匹配是错的 —— 「收入」这类词在别的页签的正文里也会出现（实测在「聊天会话」上照样匹配得到），
 * 而页签是保活的，于是"离开总览之后应当没有"这条**假对照**一直为真，判据只剩"它在不在文本里"，
 * 量出来的是假绿。所以源码里留一个专属属性。
 *
 * 这条判据守的是**漂移**：面板改了属性名、或脚本换了查询串，两边各自都"看起来没错"，
 * 只有真窗口跑一遍才暴露 —— 而那一步不在 CI 里。所以在这里先把两端对齐一次。
 * @vitest-environment node
 */
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { findRoot, readStripped } from '../../../test-helpers/wiring-kit.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = findRoot(HERE)
const HOOK = 'data-st-ledger-money'
/** 剥过注释的源码（注释里讲这个属性的历史，不该被当成"代码里出现了一次"）。 */
const panel = () => readStripped(`${HERE}/overview-panel.tsx`)
const harness = () => readStripped(`${ROOT}/scripts/ledger-reload-e2e.mjs`)

describe('资金快照那一格的真窗口钩子', () => {
  it('面板里有这个属性，且挂在那一格 metricGrid 上（不是随手加在别的容器上）', () => {
    const code = panel()
    const line = code.split('\n').find((l) => l.includes(HOOK))
    expect(line, `overview-panel.tsx 里找不到 ${HOOK} ⇒ 真窗口那条判据已经失去靶子`).toBeTruthy()
    expect(line, `${HOOK} 必须与那一格的容器同在一行（脚本问的就是这一格）`).toContain('metricGrid')
  })

  it('脚本问的是同一个串（两边名字漂开就等于没有判据）', () => {
    const code = harness()
    expect(code, `e2e 脚本里不再引用 [${HOOK}] ⇒ 它要么改回了文案匹配，要么钩子被删了`).toContain(`[${HOOK}]`)
    expect(code, '脚本改回按 innerText 找「收入」⇒ 页签保活会让它一直为真（见本文件头）')
      .not.toMatch(/innerText\.includes\([^\)]*收入/)
  })

  it('反例自证：属性改名 / 脚本换查询串，上面两条必须分别报出来', () => {
    const code = panel()
    expect(code.includes(HOOK), '现仓本来就没有这个属性 ⇒ 第一条是假绿').toBe(true)
    // 注意别拿 `HOOK + '-RENAMED'` 当"改名"：新串里仍然**含**旧串，`includes` 恒真，
    // 自证就成了自欺（本仓栽过一次，同款）。要换成一个不含旧串的名字。
    expect(code.split(HOOK).join('data-st-other-money').split('\n').some((l) => l.includes(HOOK)),
      '改名之后仍然"找得到" ⇒ 第一条判据是空的').toBe(false)
    const h = harness()
    expect(h.includes(`[${HOOK}]`), '脚本本来就不引用它 ⇒ 第二条是假绿').toBe(true)
    expect(h.replace(`[${HOOK}]`, '[]').includes(`[${HOOK}]`),
      '换掉查询串之后仍然匹配 ⇒ 第二条判据是空的').toBe(false)
  })
})
