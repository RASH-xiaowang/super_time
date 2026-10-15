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
const parts = PARTS.map((name) => ({ name, css: readFileSync(join(HERE, name), 'utf8') }))
/**
 * 现在还在用这套样式的文件。
 *
 * 2026-10-12 起**从目录推导**而不是手写名单：拆屏（四个内容页 + 舞台零件各自成文件）之后
 * 消费者从 1 个变成 6 个，而手写名单的教训已经有过一次 —— `Reveal.tsx` 曾经在这里挂着，
 * 它退化成纯容器不再 import CSS 之后，是「每个消费者都至少 import 一份」那条把它拦下来的
 * （守卫咬得对：注册表过期了）。所以这里扫 `onboarding/` 下所有 import 这两份样式的源码，
 * 名单自己长出来；往目录里再加一个消费者时，它**自动**进这三条不变量的覆盖范围。
 *
 * ⚠️ `.spec.` 文件要排除：本文件自己的文本里就有 `css.thisClassDoesNotExistAnywhere`
 * （那条合成用例），不排除的话守卫会把它自己当成一个引用悬空的消费者。
 */
const HERE_FILES = readdirSync(HERE, { withFileTypes: true })
  .filter((e) => e.isFile() && /\.tsx?$/.test(e.name) && !e.name.includes('.spec.'))
  .map((e) => e.name)
  .concat(readdirSync(join(HERE, 'pages'), { withFileTypes: true })
    .filter((e) => e.isFile() && /\.tsx?$/.test(e.name) && !e.name.includes('.spec.'))
    .map((e) => 'pages/' + e.name))
  .sort()
const CONSUMERS = HERE_FILES.filter((name) => {
  const text = readFileSync(join(HERE, name), 'utf8')
  return aliasImports(text).some((a) => PARTS.includes(a.file))
})
const consumers = CONSUMERS.map((name) => {
  const text = readFileSync(join(HERE, name), 'utf8')
  return {
    file: name,
    text,
    aliases: aliasImports(text).filter((a) => PARTS.includes(a.file)).map((a) => ({ alias: a.alias, part: a.file })),
  }
})

/**
 * 免检名单 —— **现在是空的**。
 *
 * 这里曾经挂着 `Reveal.tsx:css.revealIn`：那是拆文件之前就已经死的引用（`.revealIn` 这个类
 * 全仓库从来没写过，使用点又被 `.filter(Boolean)` 吞掉 ⇒ 渲染结果一个字都没变）。
 * 2026-09-25 按产品口径把这套死机制整条撤掉（observer / rAF / `shown` / `--reveal-delay` /
 * 五个只在 `prefers-reduced-motion` 段里出现的动画类），账清了 ⇒ 名单收回空集。
 *
 * 名单只许变短这件事由 `splitInvariants` 的反向检查盯着：**条目留着而引用没了 ⇒ 红**。
 */
const KNOWN_DEAD_REFS = new Set<string>()

describe('onboarding 那套 CSS 拆成两份之后的三条不变量', () => {
  it('两份都在，且没有没登记的分片（新增要登记、改名要清引用）', () => {
    const onDisk = readdirSync(HERE).filter((f) => /^onboarding.*\.module\.css$/.test(f)).sort()
    expect(onDisk.join(', ')).toBe([...PARTS].sort().join(', '))
  })

  it('名单里每个消费者都真的 import 了至少一份（别名表不是空的）', () => {
    // 扫出来的消费者至少要有几个：拆屏之前是 1 个（只有壳），拆屏之后四页 + 舞台零件 + 壳。
    // 少于 5 个说明推导逻辑坏了（比如 pages/ 目录没扫到），那时上面几条会是恒真的。
    expect(consumers.length, `只扫到 ${String(consumers.length)} 个消费者 —— 目录推导大概坏了`).toBeGreaterThanOrEqual(5)
    for (const c of consumers) expect(c.aliases.length, `${c.file} 一个 onboarding 样式都没 import`).toBeGreaterThan(0)
  })

  it('三条不变量：① 类名不跨份、② 引用不悬空、③ 每份 ≤ 上限', () => {
    // 浅色层不需要单独一条判据：`:global(.theme-light) .shell` 里的 `.shell` 是本份的局部类，
    // 一旦它的基态规则落在别份，①（同名类不跨份）就会红 —— 那条已经覆盖了这个形状，
    // 再写一支「主题层专用」的检查就是重复实现，而且很容易写成永远不会响的空转。
    const defects = splitInvariants(parts, consumers, LIMIT, KNOWN_DEAD_REFS)
    expect(defects.join('\n'), '同名类分家 = 两个 hash（静默失效）；引用悬空 = className 变 undefined').toBe('')
  })

  it('② 这条判据仍然咬得住：合成一个假引用必须被抓到，名单里的旧条目必须被要求删掉', () => {
    // 真仓库现在没有死引用了 ⇒ 判据不能靠"以前抓到过一个真的"来证明自己没空转，
    // 所以要**造一个违规的**塞进去：抓不到就说明 ② 是空的。
    const synthetic = {
      file: 'Synthetic.tsx',
      text: `import css from './onboarding.module.css'\nexport const x = <div className={css.thisClassDoesNotExistAnywhere} />`,
      aliases: [{ alias: 'css', part: 'onboarding.module.css' }],
    }
    const hits = splitInvariants(parts, [...consumers, synthetic], LIMIT, KNOWN_DEAD_REFS).filter((d) => d.startsWith('②'))
    expect(hits.join('\n'), '把不存在的类名塞进消费者，②必须点名它').toContain('Synthetic.tsx:css.thisClassDoesNotExistAnywhere')
    // 反向：账清完了条目还留着 ⇒ 也要红（这里用的正是刚删掉的那个名字）
    const stale = splitInvariants(parts, consumers, LIMIT, new Set(['Reveal.tsx:css.revealIn']))
    expect(stale.filter((d) => d.includes('找不到了')).length, '登记项已不成立时必须红').toBe(1)
  })

  it('这一份家族确实有 :global(.theme-light) 规则（不然上面那条对浅色层的覆盖是空转）', () => {
    const themeRules = parts.flatMap((p) => [...p.css.matchAll(/:global\(\.theme-light\)\s+\.([A-Za-z_][\w-]*)/g)].map((m) => `${p.name}:${m[1]}`))
    expect(themeRules.length, '浅色覆盖规则一条都没匹配到 —— 说明这批规则的形状变了，判据要跟着改').toBeGreaterThan(10)
  })
})
