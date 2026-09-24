/**
 * `chats.module.css` 拆成四份之后的接线守卫（M21 第 49 刀）。
 *
 * 三条不变量（同名类不跨份、引用不悬空、每份自己达标）的实现**在尺子里**
 * （`css-cascade.ts` 的 `splitInvariants`），这里只负责「读真文件 + 摆事实」——
 * 因为 chats 与 onboarding 是同一套判据，两处各抄一遍的话将来只会修其中一处，
 * 而那正是本仓反复写过的「一把尺子两套实现」。onboarding 那一侧的 spec 同理。
 *
 * 为什么这三条必须有机检（而不是「构建过了就行」）：CSS Modules 按**文件**给类名打 hash，
 * ①与②两种坏法都不报错、不让任何测试变红，症状只是「某个元素没样式」。
 * @vitest-environment node
 */
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { aliasImports, parseSource as parseSourceOf, splitInvariants } from './css-cascade.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const PANELS = join(HERE, 'pages', 'wechat-data', 'panels')
const LIMIT = 1000

/** 拆出来的那几份（含原文件）。新增一份要登记在这里。 */
const PARTS = ['chats.module.css', 'chats-rows.module.css', 'chats-cards.module.css', 'chats-shell.module.css']
/** 引用它们的消费者（第 49 刀改前缀的那批）。 */
const CONSUMERS = [
  'pages/wechat-data/panels/Chats.tsx',
  'pages/wechat-data/panels/chats-cards.tsx',
  'pages/wechat-data/panels/chats-media.tsx',
  'pages/wechat-data/panels/chats-support.tsx',
  'pages/wechat-data/panels/chats-thread.tsx',
  'pages/wechat-data/panels/chats-view.tsx',
  'pages/wechat-data/utils/message-text.tsx',
]

const parts = PARTS.map((name) => ({ name, css: readFileSync(join(PANELS, name), 'utf8') }))
const consumers = CONSUMERS.map((rel) => {
  const text = readFileSync(join(HERE, rel), 'utf8')
  return { file: rel, text, aliases: aliasImports(text).filter((a) => PARTS.includes(a.file)).map((a) => ({ alias: a.alias, part: a.file })) }
})

describe('chats 那套 CSS 拆成四份之后的三条不变量', () => {
  it('登记在册的四份都在（改名/新增要先更新这张表）', () => {
    const onDisk = readdirSync(PANELS).filter((f) => /^chats.*\.module\.css$/.test(f)).sort()
    expect(onDisk.join(', '), '实际文件与 PARTS 不一致 —— 新增了要登记，删了要一并清掉引用')
      .toBe([...PARTS].sort().join(', '))
  })

  it('每个消费者都真的 import 了至少一份（对应表不是空的）', () => {
    for (const c of consumers) {
      expect(c.aliases.length, `${c.file} 一个 chats 样式都没 import —— 别名表是空的，②就成了空转`).toBeGreaterThan(0)
    }
    expect(consumers.length).toBe(CONSUMERS.length)
  })

  it('三条不变量：① 类名不跨份、② 引用不悬空、③ 每份 ≤ 上限', () => {
    const defects = splitInvariants(parts, consumers, LIMIT)
    expect(defects.join('\n'), 'CSS Modules 的两条静默坏法（同名类两个 hash / 引用拿到 undefined）都不允许').toBe('')
  })

  it('判据自己有判别力：三种坏法各造一次，必须各被对应的那一支抓到', () => {
    const base = parts.map((p) => ({ ...p }))
    const one = base.find((p) => p.name === 'chats-rows.module.css')
    const two = base.find((p) => p.name === 'chats.module.css')
    if (one === undefined || two === undefined) throw new Error('两份文件没读到')
    // ① 同名类出现在两份里：把 rows 里**已存在**的一个类抄进主份
    //（造一个两边都没有的新类是没用的 —— 那不叫跨份，第一版就是这么写错的）
    const rowsOnly = [...new Set(parseSourceOf(one.css).leaves.flatMap((l) => l.classes))].sort()[0] ?? ''
    if (rowsOnly === '') throw new Error('rows 那份里没解析出类名')
    const dup = base.map((p) => (p.name === 'chats.module.css' ? { ...p, css: `.${rowsOnly} { color: red }\n` + p.css } : p))
    const dupDefects = splitInvariants(dup, consumers, LIMIT)
    expect(dupDefects.length, `把 .${rowsOnly} 抄进主份：不报错的话守卫就是空的`).toBeGreaterThan(0)
    expect(dupDefects.filter((d) => d.startsWith('①')).length, '必须是被①那一支抓到的').toBeGreaterThan(0)
    // ② 引用悬空：拿一个只在 rows 里出现的类，用主份的别名去引用
    const badConsumer = {
      file: 'synthetic.tsx',
      text: `import css from "./chats.module.css"\nconst x = <div className={css.${rowsOnly}} />`,
      aliases: [{ alias: 'css', part: 'chats.module.css' }],
    }
    const dangling = splitInvariants(base, [...consumers, badConsumer], LIMIT)
    expect(dangling.filter((d) => d.startsWith('②')).length, '引用了不存在于那份文件的类 ⇒ 必须报').toBe(1)
    // ③ 超上限：把上限调到比现有份更小
    const overLimit = splitInvariants(base, consumers, 300)
    expect(overLimit.some((d) => d.startsWith('③')), '上限压到 300 时应该报超限').toBe(true)
    // 反向：原样喂进去必须 0 条（上面那条 it 已经验过一次，这里是让「三支各自有效」不被误报掩盖）
    expect(splitInvariants(base, consumers, LIMIT).join('\n')).toBe('')
  })
})
