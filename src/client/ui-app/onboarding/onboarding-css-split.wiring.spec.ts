/**
 * `onboarding.module.css` 拆成两份之后的接线守卫（M21 第 50 刀）。
 *
 * 三条不变量的实现**在尺子里**（`css-cascade.ts` 的 `splitInvariants`），与 chats 那份共用 ——
 * 两份各抄一遍的话将来只会修其中一处（本仓写过很多次：一把尺子不许两套实现）。
 *
 * 为什么值得钉住（这一份尤其）：`onboarding` 曾经有一整层 `:global(.theme-light)` 的浅色覆盖，
 * 它引用的是**本文件的局部类**。这类规则一旦与所覆盖的基态规则分家、或在 CSS Modules 里被哈希成
 * `_theme-light_xxx`（选择器永不命中），症状不是报错而是「浅色主题下某个元素样式没了」。
 * 2026-10-19 微信化改版把整层局部浅色覆盖随霓虹皮一起删除（主题只由全局 `--nm-*` 令牌定义），
 * 本文件因此不再调用 `splitInvariants` 之外的浅色层判据，改为**反向**钉住「局部主题层不许回潮」。
 * @vitest-environment node
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { aliasImports, splitInvariants } from '../../ui-wechat/src/client/css-cascade.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const LIMIT = 1000
/**
 * 三份分片（2026-10-17 从两份拆成三份；2026-10-19 微信化改版后职责不变）：
 *   · `onboarding-stage.module.css` —— 舞台外壳（灰底画布 / 顶栏 / 单滚动内容区 / 底栏）
 *   · `onboarding-stages.module.css` —— 内容页排版（页头 / 首页 / 功能引导 / 使用说明 / 关于）
 *   · `onboarding.module.css` —— 壳的零件（内容列 / 按钮 / 标签 / 步骤行 / 区块标题 / 卡片）
 *
 * 为什么再拆一份：重设计要动的是「壳」，而两份都已 570 / 890 行，贴着 1000 行硬棘轮。
 * 拆开之后改外壳不再挤内容页的行数预算。
 */
const PARTS = ['onboarding.module.css', 'onboarding-stage.module.css', 'onboarding-stages.module.css']
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

/** 剥掉 CSS 注释（保留换行，便于定位）。断言前必须剥 —— 注释里常写着历史成因。 */
function stripCssComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
}

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
    // 局部浅色层已整层删除（见下面「主题由全局令牌唯一定义」），所以这里不再需要
    // 「主题层专用」的跨份检查：`:global(...)` 不参与闭包，覆盖层的局部类仍由 ① 统一兜住。
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

  it('主题由全局令牌唯一定义：启动页不再自带浅色覆盖层', () => {
    // 2026-10-19 微信化改版：舞台改成 `--nm-*` 令牌直出，整层 `:global(.theme-light)`
    // 局部覆盖随霓虹皮一起删除。留一条**反向**判据，防止局部浅色层又长回来：
    //   · 重复定义主题 ⇒ 令牌不再是唯一真源，两套值会悄悄分叉；
    //   · 裸写 `theme-light` 在 CSS Modules 里会被哈希（选择器永不命中）⇒ 浅色下样式静默失效。
    // 因此这里要求：三份分片里**一次都不出现** `theme-light`；将来若确需局部覆盖，
    // 必须包 `:global(...)`，并由本 spec 重新登记一条正向判据。
    const hits = parts.flatMap((p) => [...p.css.matchAll(/theme-light/g)].map((m) => `${p.name}:${String(m.index ?? 0)}`))
    expect(hits, '启动页又出现局部 theme-light 覆盖 —— 主题应只由全局令牌定义：' + hits.join(', ')).toEqual([])
  })
})

describe('启动页舞台：铺满 #root + 自适应单列可滚（2026-10-19 微信化改版）', () => {
  const stageCss = readFileSync(join(HERE, 'onboarding-stage.module.css'), 'utf8')
  const shellCss = readFileSync(join(HERE, 'onboarding.module.css'), 'utf8')
  const runtimeSrc = readFileSync(join(HERE, 'runtime.ts'), 'utf8')
  const titlebarCss = readFileSync(join(HERE, '..', 'titlebar.css'), 'utf8')

  it('外壳铺满 #root（窗口更大时不露黑边）', () => {
    const block = /\.shell\s*\{[^}]*\}/.exec(stageCss)?.[0] ?? ''
    expect(block, '找不到 .shell 规则').not.toBe('')
    expect(block, '外壳宽度必须铺满').toMatch(/width:\s*100%/)
    expect(block, '外壳高度必须铺满').toMatch(/height:\s*100%/)
    // 反向：外壳不许写死像素尺寸（那会在窗口里浮一张卡片，四周露黑边）
    expect(block, '外壳不许写死像素宽高').not.toMatch(/(?:^|\s)(?:width|height):\s*\d+px/)
  })

  it('内容区：唯一滚动容器 + 内容列 760 上限（自适应单列，不再有固定 1180×760 舞台）', () => {
    const body = /\.body\s*\{[^}]*\}/.exec(stageCss)?.[0] ?? ''
    expect(body, '找不到 .body 规则').not.toBe('')
    expect(body, '内容区必须是滚动容器（超出上下滚动）').toMatch(/overflow-y:\s*auto/)
    expect(body, '内容区必须水平居中').toMatch(/margin:\s*0 auto/)
    // 1180 是「画布」上限（与顶栏/底栏对齐）；真正的内容列是 760，且宽度自适应。
    expect(body, '画布上限 1180px').toMatch(/max-width:\s*1180px/)
    expect(body, '内容区不许写死高度（自适应单列已取消固定舞台）').not.toMatch(/(?:^|[\s;])height:\s*\d+px/)

    const page = /\.page\s*\{[^}]*\}/.exec(shellCss)?.[0] ?? ''
    expect(page, '找不到内容列 .page 规则').not.toBe('')
    expect(page, '内容列上限 760px（一屏读得完的宽度）').toMatch(/max-width:\s*760px/)
    expect(page, '内容列宽度必须自适应').toMatch(/width:\s*100%/)
    expect(page, '内容列必须居中').toMatch(/margin:\s*0 auto/)
  })

  it('固定舞台的 TS 常量已被删除（防止「固定尺寸 + 等比缩放」整套机制回潮）', () => {
    // 2026-10-19：`STAGE_W/STAGE_H` 与按舞台宽度缩放的计算随固定舞台一起删除。
    // 留着这条反向判据，是因为「固定尺寸」曾经是产品要求；哪天有人按旧文档把它加回来，
    // 至少会先在这里被问一句「自适应单列的产品口径改了？」
    // ⚠️ 必须剥注释再判：文件头注释里为了记录改版原因**原样写了**这两个名字，
    // 直接扫原文会把说明文字当成实现（本仓库「注释里的字样被当代码」的老坑）。
    const runtimeCode = stripCssComments(runtimeSrc)
    expect(runtimeCode, 'STAGE_W/STAGE_H 又回来了 ⇒ 固定舞台机制复活').not.toMatch(/\bSTAGE_(?:W|H)\b/)
  })

  it('舞台的定位祖先是 #root，不是视口（否则会盖住标题栏）', () => {
    // 2026-10-17 真机踩到：`#root` 没有 position ⇒ `.stage { inset: 0 }` 一路找到视口
    // ⇒ 舞台从 y=0 开始，把 38px 高的自绘标题栏整个盖住（用户报「全屏按钮那些也不见了」）。
    //
    // ⚠️ 判据必须**取出 #root 规则体再断言 position 的值**：只写
    // `toMatch(/#root\s*\{[^}]*position:\s*relative/)` 时，变异成 `position: static`
    // 仍然命中（`[^}]*` 会跨过 `position: static` 去匹配别处的 `position: relative`），
    // 实测 M680 第一次没咬住。
    // ⚠️ 文件开头还有一条 `html, body, #root { height: 100% }`，`/#root\s*\{/` 会先抓到它
    // ⇒ 必须按「含 flex: 1 的那条」定位（那才是布局用的 #root 规则）。
    // ⚠️ 断言前必须**剥注释**：那条规则的注释里**故意**写了 `position: absolute`（说明历史成因），
    // 不剥的话反向断言会被自己的注释咬到（本轮实测踩到）。
    const rootBlock = stripCssComments(/#root\s*\{[^}]*flex:\s*1[^}]*\}/.exec(titlebarCss)?.[0] ?? '')
    expect(rootBlock, '找不到 #root 的布局规则（含 flex: 1 的那条）').not.toBe('')
    expect(rootBlock, '#root 必须是定位祖先（position: relative）').toMatch(/position:\s*relative/)
    expect(rootBlock, '#root 不许被改成 static / absolute').not.toMatch(/position:\s*(?:static|absolute|fixed)/)
    expect(stageCss, '舞台必须相对 #root 铺满').toMatch(/\.stage\s*\{[^}]*inset:\s*0/)
  })

  it('内容页样式里不许再有 @media 断点（内容页是流体宽度，断点只由外壳统一提供）', () => {
    const stagesCss = readFileSync(join(HERE, 'onboarding-stages.module.css'), 'utf8')
    expect(stagesCss, '内容页自己又长了一套断点 → 与外壳的两档断点会叠成多套分支').not.toMatch(/@media\s*\(max-width/)
  })
})

describe('入场方式：整页直出（2026-10-19 微信化改版，逐条浮现机制已撤掉）', () => {
  const allCss = ['onboarding.module.css', 'onboarding-stage.module.css', 'onboarding-stages.module.css']
    .map((f) => readFileSync(join(HERE, f), 'utf8'))
    .join('\n')

  it('逐条浮现机制不许回潮：没有 Reveal 组件、没有 --rise-i 错峰', () => {
    // 旧实现是 `Reveal.tsx` 给每个块写 `--rise-i`，CSS 用 `animation-delay: calc(var(--rise-i) * 45ms)`
    // 逐条浮现（2026-10-17 的观感要求）。2026-10-19 微信定调「克制、不做装饰动画」后整条机制删除；
    // 这里同时钉「文件不重建」与「行内写法不回流」两端 —— 只删 CSS 但重建组件，同样会绕开本判据。
    expect(existsSync(join(HERE, 'Reveal.tsx')), 'Reveal.tsx 又回来了 ⇒ 逐条浮现机制被重建').toBe(false)
    expect(allCss, 'CSS 里又出现 --rise-i ⇒ 错峰入场被加回').not.toContain('--rise-i')
    for (const c of consumers) expect(c.text, `${c.file} 又写 --rise-i`).not.toContain('--rise-i')
  })

  it('启动页不做装饰动画（无 @keyframes / 无 animation）；将来要加必须带 reduced-motion 降级', () => {
    // 旧判据是「不许再出现这 7 个无限循环 keyframes 名字」；新设计把装饰动画整类删除，
    // 因此口径收紧成「一个动画都不许有」。语义强度不降：任何回潮（无论叫什么名字）都会红。
    expect(allCss, '启动页又加了 @keyframes 动画').not.toMatch(/@keyframes\s+[A-Za-z_]/)
    const animated = /(?:^|[;{\s])animation(?:-name)?\s*:/.test(allCss)
    expect(animated, '启动页又加了 animation 声明（微信定调：不做装饰动画）').toBe(false)
    // 若未来产品确实要加入场动画，旧判据里「不许出现内容永远透明」的语义仍必须成立：
    // 那时必须同时给 prefers-reduced-motion 降级，否则这条会红。
    if (animated) {
      expect(allCss, '有动画却没有 prefers-reduced-motion 降级').toMatch(/@media \(prefers-reduced-motion: reduce\)/)
    }
  })
})
