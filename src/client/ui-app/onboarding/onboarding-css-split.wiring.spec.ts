/**
 * `onboarding.module.css` 拆成两份之后的接线守卫（M21 第 50 刀）。
 *
 * 三条不变量的实现**在尺子里**（`css-cascade.ts` 的 `splitInvariants`），与 chats 那份共用 ——
 * 两份各抄一遍的话将来只会修其中一处（本仓写过很多次：一把尺子不许两套实现）。
 *
 * 为什么值得钉住（这一份尤其）：`onboarding` 里有一整层 `:global(.theme-light)` 的浅色覆盖，
 * 它引用的是**本文件的局部类**（`.shell`、`.bgImage`、`.stageWash`…）。这类规则一旦与它所覆盖的
 * 基态规则分家，症状不是报错而是「浅色主题下某个元素样式没了」——只有对着那块屏才看得见。
 * @vitest-environment node
 */
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { aliasImports, splitInvariants } from '../../ui-wechat/src/client/css-cascade.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const LIMIT = 1000
const PARTS = ['onboarding.module.css', 'onboarding-stages.module.css']
const CONSUMERS = ['OnboardingShell.tsx', 'Reveal.tsx']

const parts = PARTS.map((name) => ({ name, css: readFileSync(join(HERE, name), 'utf8') }))
const consumers = CONSUMERS.map((name) => {
  const text = readFileSync(join(HERE, name), 'utf8')
  return {
    file: name,
    text,
    aliases: aliasImports(text).filter((a) => PARTS.includes(a.file)).map((a) => ({ alias: a.alias, part: a.file })),
  }
})

/**
 * 登记在册的死引用 —— **拆之前就已经是死的**（`git show origin/main:...onboarding.module.css` 里
 * 没有 `.revealIn` 这个类，也没有同名 `@keyframes`，所以 `css.revealIn` 一直是 `undefined`，
 * 而使用点 `[...].filter(Boolean)` 正好把它吃掉 ⇒ 渲染结果一个字都没变）。
 *
 * 为什么不顺手删掉：`shown` 只被这一个表达式读，删了它整个 `IntersectionObserver` + state 就成了
 * 死码，而「Reveal 到底该不该按可见性触发样式」是个产品问题（答案目前是从 CSS 里找不到依据）。
 * 那是另起一条工的事，不该混在拆文件里 —— 与本仓 M21 棘轮同一套做法：**名单只许变短，
 * 账清完了条目还留着就会红**（`splitInvariants` 里那一条反向检查）。
 */
const KNOWN_DEAD_REFS = new Set(['Reveal.tsx:css.revealIn'])

describe('onboarding 那套 CSS 拆成两份之后的三条不变量', () => {
  it('两份都在，且没有没登记的分片（新增要登记、改名要清引用）', () => {
    const onDisk = readdirSync(HERE).filter((f) => /^onboarding.*\.module\.css$/.test(f)).sort()
    expect(onDisk.join(', ')).toBe([...PARTS].sort().join(', '))
  })

  it('两个消费者都真的 import 了至少一份（别名表不是空的）', () => {
    for (const c of consumers) expect(c.aliases.length, `${c.file} 一个 onboarding 样式都没 import`).toBeGreaterThan(0)
  })

  it('三条不变量：① 类名不跨份、② 引用不悬空、③ 每份 ≤ 上限', () => {
    // 浅色层不需要单独一条判据：`:global(.theme-light) .shell` 里的 `.shell` 是本份的局部类，
    // 一旦它的基态规则落在别份，①（同名类不跨份）就会红 —— 那条已经覆盖了这个形状，
    // 再写一支「主题层专用」的检查就是重复实现，而且很容易写成永远不会响的空转。
    const defects = splitInvariants(parts, consumers, LIMIT, KNOWN_DEAD_REFS)
    expect(defects.join('\n'), '同名类分家 = 两个 hash（静默失效）；引用悬空 = className 变 undefined').toBe('')
  })

  it('免检名单本身是活的：不传名单时那条死引用必须被抓到（不然它就是永久出口）', () => {
    const without = splitInvariants(parts, consumers, LIMIT)
    expect(without.filter((d) => d.startsWith('②')).join('\n'), 'Reveal.tsx 的 css.revealIn 必须仍然被②抓到').toContain('Reveal.tsx:css.revealIn')
    // 反向：名单里放一条根本不存在的，也要报（账清完了条目还留着 ⇒ 判据在放空炮）
    const stale = splitInvariants(parts, consumers, LIMIT, new Set([...KNOWN_DEAD_REFS, 'Nope.tsx:css.nothere']))
    expect(stale.filter((d) => d.includes('找不到了')).length, '登记项已不成立时必须红').toBe(1)
  })

  it('这一份家族确实有 :global(.theme-light) 规则（不然上面那条对浅色层的覆盖是空转）', () => {
    const themeRules = parts.flatMap((p) => [...p.css.matchAll(/:global\(\.theme-light\)\s+\.([A-Za-z_][\w-]*)/g)].map((m) => `${p.name}:${m[1]}`))
    expect(themeRules.length, '浅色覆盖规则一条都没匹配到 —— 说明这批规则的形状变了，判据要跟着改').toBeGreaterThan(10)
  })
})
