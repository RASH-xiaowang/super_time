/**
 * 正文阅读区（`kb-file-reader.tsx` + 它在 `kbfiles.module.css` 里的样式）的接线守卫。
 *
 * ## 为什么单独一份（2026-10-17）
 *
 * 这些判据原本长在 `kb-files.wiring.spec.ts` 里，而那份文件已经 1024 行 ——
 * 撞上 `m21-file-size-ratchet.spec.ts` 的 1000 行上限。拆出来不是「放宽」：
 * 断言一条没删、一条没改，只是换了个文件放。
 *
 * ## 这一屏的退化方式
 *
 * 全都是「界面照常打开、断言全绿」的那种：
 *   ① 两栏各自滚 → 退回整块滚，滚原文把目录一起滚走；
 *   ② 目录在左 → 退回在右，用户每换一块都要横跨整个屏幕；
 *   ③ 目录是索引 → 退回把每块正文再抄一遍，两栏内容重复；
 *   ④ 目录标题带文件级前缀 → 60 条重复同一句话；
 *   ⑤ 悬停联动 → 去掉，两栏之间失去对应关系；
 *   ⑥ 查看正文挤压文件列表 / 正文滚动带动列表。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))

/**
 * 去注释后读源码。
 * 这一屏的注释里**必然**会出现被否掉的写法（它们正是要防的东西），
 * 不剥掉就会把自己的说明文字当成违规。
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/)
    .map(l => l.replace(/\/\/.*$/, ''))
    .join('\n')
}

const readerSrc = stripComments(readFileSync(join(HERE, 'kb-file-reader.tsx'), 'utf8'))
const detailSrc = stripComments(readFileSync(join(HERE, 'kb-files-detail.tsx'), 'utf8'))
const panelCss = readFileSync(join(HERE, 'kbfiles.module.css'), 'utf8')

/** 抽某个类的规则体（去注释）。 */
function ruleOf(cls: string): string {
  const m = new RegExp(`\\.${cls}\\s*\\{([^}]*)\\}`).exec(panelCss)
  return stripComments(m?.[1] ?? '')
}

describe('正文阅读区：两栏各自独立滚动（2026-10-17 用户要求）', () => {
  /**
   * 改前两栏都不设 overflow，整块随内容长高由 `.bodyWrap` 统一滚 ——
   * 于是滚原文会把左边的目录一起滚走，用户想换一块得先滚回去找目录。
   *
   * 现在：两栏各自滚，高度由 `.readerSplit` 的 `max-height` 封顶。
   *
   * ⚠️ 滚动**落在 `.paneBody` 上，不是 `.readerMain` / `.readerToc`**：
   * 后两者同时装着栏头和内容，一滚栏头就跟着走（用户截图实测：栏头被压掉半截）。
   * 栏头留在滚动区外面当固定的一行。
   *
   * ⚠️ 高度必须封在 `.readerSplit` 上，不能封在两栏各自身上：
   * 封在栏上时两栏高度各算各的，内容少的那栏会短一截，看起来像没对齐。
   */
  it('原文与分块各自滚：滚原文不带动分块目录', () => {
    // 两栏外壳：不滚（`overflow: hidden`），只负责装栏头 + 滚动区
    for (const cls of ['readerMain', 'readerToc']) {
      const body = ruleOf(cls)
      expect(body, `找不到 .${cls}`).not.toBe('')
      expect(body, `.${cls} 必须 height: 100% 才能与另一栏等高`).toMatch(/height:\s*100%/)
      expect(body, `.${cls} 必须 min-height: 0（否则 flex 子项撑住内容高度，滚不动）`).toMatch(/min-height:\s*0/)
      // 外壳不许自己滚 —— 它装着栏头，一滚栏头就跟着走
      expect(body, `.${cls} 不许自己滚（栏头会被滚走），滚动要落在 .paneBody 上`).not.toMatch(/overflow-y:\s*auto/)
      expect(body, `.${cls} 必须 overflow: hidden 把滚动交给 .paneBody`).toMatch(/overflow:\s*hidden/)
      // 高度不许封在栏自己身上 —— 那样两栏高度各算各的，会一高一低
      expect(body, `.${cls} 不许自己设 max-height（高度要封在 .readerSplit 上）`).not.toMatch(/max-height/)
    }
    // 真正的滚动区
    const paneBody = ruleOf('paneBody')
    expect(paneBody, '找不到 .paneBody').not.toBe('')
    expect(paneBody, '.paneBody 必须自己滚').toMatch(/overflow-y:\s*auto/)
    expect(paneBody, '.paneBody 必须 min-height: 0（否则 flex 子项撑住内容高度，滚不动）').toMatch(/min-height:\s*0/)
    expect(paneBody, '.paneBody 必须 overscroll-behavior-y: contain（否则滚到底传染给外层）').toMatch(/overscroll-behavior-y:\s*contain/)
  })

  /**
   * 栏头必须**在滚动区外面**（2026-10-17 用户截图实测）。
   *
   * 改前 `.paneLabel` 用 `position: sticky` 贴在滚动区里，而滚动区有 `padding` ——
   * sticky 的 `top: 0` 是相对**内容区**的，于是滚动时正文从 padding 区域穿过去，
   * 把栏头压掉半截（截图里只露出「分块（195）」「原文」的下半截）。
   */
  it('栏头在滚动区外面，不许用 sticky', () => {
    const label = ruleOf('paneLabel')
    expect(label, '找不到 .paneLabel').not.toBe('')
    expect(label, '栏头不许用 position: sticky（会被滚动内容压住）').not.toMatch(/position:\s*sticky/)
    expect(label, '栏头必须 flex: 0 0 auto（不参与伸缩，固定一行）').toMatch(/flex:\s*0 0 auto/)
    // JSX 里栏头必须是 .paneBody 的**兄弟**，不是它的子节点
    const nav = /<nav className=\{css\.readerToc\}[\s\S]*?<\/nav>/.exec(readerSrc)?.[0] ?? ''
    expect(nav, '找不到分块目录 <nav>').not.toBe('')
    const labelIdx = nav.indexOf('css.paneLabel')
    const bodyIdx = nav.indexOf('css.paneBody')
    expect(labelIdx, '目录里找不到栏头').toBeGreaterThan(0)
    expect(bodyIdx, '目录里找不到滚动区 .paneBody').toBeGreaterThan(0)
    expect(labelIdx, '栏头必须排在 .paneBody 之前（在滚动区外面）').toBeLessThan(bodyIdx)
  })

  it('高度封在 .readerSplit 上，且行高必须显式封顶', () => {
    const split = ruleOf('readerSplit')
    expect(split, '找不到 .readerSplit').not.toBe('')
    expect(split, '.readerSplit 必须 max-height 封顶').toMatch(/max-height:\s*60vh/)
    expect(split, '.readerSplit 必须 align-items: stretch 让两栏等高').toMatch(/align-items:\s*stretch/)
    // ⚠️ 行高必须 `minmax(0, 1fr)`：`auto` 行会被内容撑到 5867px，
    // 于是子项的 `height: 100%` 也变成 5867px，`max-height` 形同虚设（真机实测）。
    expect(split, '.readerSplit 的行高必须 minmax(0, 1fr)，不能留给 auto').toMatch(
      /grid-template-rows:\s*minmax\(0,\s*1fr\)/,
    )
  })
})

describe('正文阅读区：两栏顺序（目录在左、原文在右）', () => {
  /**
   * 目录是导航，导航在左、内容在右是阅读器的通行布局（文件树 / 大纲 / 书签都在左）。
   * 改前目录在右，用户的眼睛要先跳到最右边才能定位，再跳回左边读 ——
   * 每换一块都要横跨整个屏幕。
   */
  it('分块目录排在原文之前，CSS 列顺序也跟着换', () => {
    const navIdx = readerSrc.search(/<nav className=\{css\.readerToc\}/)
    const mainIdx = readerSrc.search(/<div className=\{css\.readerMain\}>/)
    expect(navIdx, '找不到分块目录 <nav>').toBeGreaterThan(0)
    expect(mainIdx, '找不到原文 .readerMain').toBeGreaterThan(0)
    expect(navIdx, '分块目录必须排在原文之前（目录在左）').toBeLessThan(mainIdx)
    // CSS 的列顺序也要跟着换：第一列是窄目录，第二列是 1fr 原文
    expect(ruleOf('readerSplit'), 'CSS 列顺序必须是「窄目录 + 1fr 原文」').toMatch(
      /grid-template-columns:\s*minmax\(160px,\s*200px\)\s+minmax\(0,\s*1fr\)/,
    )
  })
})

describe('正文阅读区：右栏是目录不是正文副本', () => {
  it('目录项只放序号 + 首行摘要 + 页码/字数，不许渲染整块正文', () => {
    // 目录项只放「怎么找到它」需要的信息。
    expect(readerSrc).toMatch(/className=\{css\.tocItem\}/)
    expect(readerSrc).toMatch(/className=\{css\.tocPreview\}/)
    // 目录项必须是 `<button>`：它真的会跳转，键盘用户也要能按到。
    expect(readerSrc).toMatch(/<button[\s\S]{0,200}className=\{css\.tocItem\}/)
    // 首行摘要必须截断（目录是索引不是内容，多行会把窄栏撑成一堵墙）。
    expect(readerSrc).toContain('TOC_PREVIEW_CHARS')
    // ⚠️ 关键：目录里**不许**出现整块正文。改前右栏是 `<p className={css.chunkText}>{c.text}</p>`，
    // 两栏内容重复、各占一个滚动条，目录也失去「快速定位」的作用。
    const nav = /<nav[\s\S]*?<\/nav>/.exec(readerSrc)?.[0] ?? ''
    expect(nav, '找不到分块目录 <nav>').not.toBe('')
    expect(nav, '目录里不许渲染整块正文（那是正文副本，不是目录）').not.toMatch(/\{[a-z]\.text\}/)
    expect(nav, '目录里不许渲染整块正文（那是正文副本，不是目录）').not.toMatch(/items\[[^\]]*\]\?\.text/)
  })
})

describe('正文阅读区：两栏之间的对应关系', () => {
  /**
   * 「这是解析文本不是原稿」必须说出口，但**不许占一整段**（2026-10-17）。
   *
   * 改前它是一段独立的 `<p>`，占两行，把正文推下去 —— 而用户点「查看正文」
   * 就是要读原文。这段说明属于「第一次用才需要看一次」的信息。
   *
   * 现在收进栏头右侧的小标签（`.readerHint`），全文在 `title` 上悬停即见。
   * 但它**不能删**：不说清这一点，用户会拿解析文本核对原稿，
   * 而两者可以给出不同的结论（表格、图片、页眉页脚在解析时已经丢掉）。
   */
  it('「解析文本非原稿」收进栏头，不占独立一段', () => {
    // 小标签必须在
    expect(readerSrc, '找不到「解析文本，非原稿」小标签').toContain('解析文本，非原稿')
    expect(readerSrc).toMatch(/className=\{css\.readerHint\}/)
    // 全文必须在 title 上（悬停即见），且要点明「表格、图片与页眉页脚已经丢掉」
    expect(readerSrc).toMatch(/title=\{'这是解析出来的文本/)
    expect(readerSrc, 'title 里必须说清哪些内容在解析时丢掉了').toContain('表格、图片与页眉页脚在解析时已经丢掉')
    // 不许退回独立一段（那正是要防的写法）
    expect(readerSrc, '说明不许退回独立一段（会占两行把正文推下去）').not.toMatch(/<p className=\{css\.readerNote\}>/)
  })

  it('悬停联动 + 点击跳转', () => {
    // 悬停任一侧，另一侧同步高亮 —— 这是「对照」这件事唯一真正有用的形态。
    expect(readerSrc).toMatch(/onMouseEnter=\{\(\) => \{ setActive\(c\.ordinal\) \}\}/)
    expect(readerSrc).toMatch(/onMouseEnter=\{\(\) => \{ setActive\(t\.ordinal\) \}\}/)
    // 点击目录滚到对应块。`block: 'nearest'` 而不是 `'center'`：
    // center 会把块顶到栏的正中，上下文全被挤出去 —— 而对照阅读恰恰需要上下文。
    expect(readerSrc).toMatch(/scrollIntoView\(\{ block: 'nearest'/)
    // 原文每块带 `#N` 角标，与目录一一对应 —— 没有它，用户看到虚线也不知道是第几块。
    expect(readerSrc).toMatch(/className=\{css\.rawNo\}/)
  })
})

describe('正文阅读区：目录标题与摘要的清洗', () => {
  it('目录标题剥掉文件级前缀（否则 60 条重复同一句话）', () => {
    // 后端给的 heading 是 `文件名 › 一级 › 二级` 的层级路径，每块都带同一个文件级前缀。
    // 直接显示 ⇒ 60 条目录项重复同一句话，把「第 N 页 / N 字」挤到看不见（真机实测）。
    expect(readerSrc).toContain('function shortHeading')
    expect(readerSrc).toMatch(/heading\.split\('›'\)/)
    // 求公共前缀：只留与上一块不同的那一段。
    expect(readerSrc).toMatch(/while \(i < parts\.length && i < prevParts\.length && parts\[i\] === prevParts\[i\]\)/)
    // ⚠️ 关键：`shortHeading` 必须**真的被调用**。只定义不调用等于没修。
    expect(readerSrc, 'shortHeading 定义了却没被调用').toMatch(/const heading = shortHeading\(c\.heading, prevHeading\)/)
    // 而且不许退回直接读 `c.heading`（那正是要防的写法）。
    expect(readerSrc).not.toMatch(/const heading = c\.heading\b/)
  })

  it('目录摘要剥掉 Markdown 标记与表格分隔行', () => {
    // 行首标记必须在压平换行**之前**剥（`^` 锚点依赖行首）。
    const fn = /function tocPreview[\s\S]*?\n\}/.exec(readerSrc)?.[0] ?? ''
    expect(fn, '找不到 tocPreview').not.toBe('')
    const quoteIdx = fn.indexOf(".replace(/^\\s*>\\s?/gm, '')")
    const flatIdx = fn.indexOf('.replace(/\\s+/g, ')
    expect(quoteIdx, '行首标记剥离不见了').toBeGreaterThan(0)
    expect(flatIdx, '压平空白不见了').toBeGreaterThan(0)
    expect(quoteIdx, '行首标记必须在压平空白之前剥（否则 ^ 锚点匹配不到行首）').toBeLessThan(flatIdx)
    // 表格分隔行（`| --- | --- |`）整行丢掉，否则预览变成半截乱码。
    expect(fn).toMatch(/\^\[\\s\|:-\]\*\$\|\^\[\\s\|:-\]\*\\\|\[\\s\|:-\]\*\$/m)
    // 只剩分隔线 ⇒ 返回空串，由调用方给占位文案。
    expect(fn).toMatch(/if \(\/\^\[-\|\*_\\s\]\*\$\/\.test\(flat\)\) return ''/)
  })
})

describe('正文阅读区：自动全部加载（2026-10-17 用户要求）', () => {
  /**
   * 用户点「查看正文」就是要读完整份，让他一块一块点「继续加载」是把分页的
   * 实现细节推给了用户。
   *
   * 但**不能一次全取**：单文件上限两万块，一次全取会把几十万字塞进一次 IPC 响应，
   * 主进程序列化 + 渲染进程反序列化会卡住整个面板。所以是「循环拉，直到取完」。
   */
  const hookSrc = stripComments(readFileSync(join(HERE, 'kb-save-note.ts'), 'utf8'))

  it('阅读器里没有「继续加载」按钮', () => {
    expect(readerSrc, '阅读器里不许再有「继续加载」按钮').not.toContain('继续加载')
    expect(readerSrc, '阅读器不许再收 onMore 回调').not.toMatch(/onMore/)
    // 还没拉完时给一句进度，而不是留一个按钮让用户点
    expect(readerSrc).toMatch(/正在加载剩余 \{total - items\.length\} 块/)
  })

  it('循环拉取直到取完，且每轮核对 fileId', () => {
    // 必须是循环（`for (;;)`），不是「取一页就停」
    expect(hookSrc, '找不到循环拉取').toMatch(/for \(;;\) \{/)
    // 每轮用已取到的块数当 offset
    expect(hookSrc).toMatch(/offset: acc\.length/)
    // 取完了就退出
    expect(hookSrc).toMatch(/if \(acc\.length >= total \|\| r\.items\.length === 0\) return/)
    // 每轮核对「用户是不是已经切走了」，切走了立刻停（不再继续拉）
    expect(hookSrc).toMatch(/if \(readerRef\.current\?\.fileId !== fileId\) return/)
    // 每轮都推一次状态：用户能边读边等，而不是盯着一个空壳
    expect(hookSrc).toMatch(/loading: acc\.length < total/)
  })

  it('每轮取满后端上限，但仍然是分轮（不是一次全取）', () => {
    // 每轮取 200（后端 MAX_CHUNK_PAGE），少跑几趟 IPC
    expect(hookSrc).toMatch(/limit: MAX_CHUNK_PAGE/)
    // 但必须分轮 —— 一次全取会卡住面板
    expect(hookSrc, '不许一次全取（会卡住面板）').not.toMatch(/limit:\s*(?:Infinity|Number\.MAX_SAFE_INTEGER)/)
  })

  /**
   * 用到的 React hook 必须真的 import 了（2026-10-17 实测踩到）。
   *
   * 加 `readerRef` 时忘了把 `useRef` 加进 import —— `tsc` 和 `get_errors` 都没报，
   * 因为 `noUnusedLocals` 只查「导入了没用」，不查「用了没导入」在打包后才会炸。
   * 真机表现：整个知识库页面白屏，控制台 `ReferenceError: useRef is not defined`。
   *
   * 判据：源码里出现的每个 `useXxx(` 都必须在 `from 'react'` 的 import 列表里。
   */
  it('用到的 React hook 都 import 了（否则打包后白屏）', () => {
    const panelSrc = stripComments(readFileSync(join(HERE, 'kb-files-panel.tsx'), 'utf8'))
    const imported = /import \{([^}]*)\} from 'react'/.exec(panelSrc)?.[1] ?? ''
    const importedNames = new Set(imported.split(',').map(s => s.trim()).filter(s => s !== ''))
    // 只查 React 内置 hook 名（自定义 hook 以 `use` 开头但不在这个名单里）
    const REACT_HOOKS = ['useState', 'useEffect', 'useMemo', 'useCallback', 'useRef', 'useReducer', 'useContext', 'useLayoutEffect']
    // ⚠️ 必须允许泛型参数：`useRef<KbFileReaderState | null>(null)` 里 `useRef` 与 `(`
    // 之间隔着 `<...>`，只写 `\s*\(` 会漏掉它 —— 而 `useRef` 恰恰是最容易忘 import 的那个
    // （2026-10-17 实测：漏了它整个知识库页面白屏，而这条守卫当时没抓住）。
    const used = new Set([...panelSrc.matchAll(/\b(use[A-Z][A-Za-z]*)\s*(?:<[^>()]*>)?\s*\(/g)].map(m => m[1] ?? ''))
    const missing = [...used].filter(n => REACT_HOOKS.includes(n) && !importedNames.has(n))
    expect(missing, `这些 hook 用了却没 import：${missing.join(', ')}`).toEqual([])
    // 防空转：`useRef` 必须真的被扫到（否则上面那条对它是恒真的）
    expect(used.has('useRef'), 'useRef 没被扫到 —— 正则漏了泛型参数').toBe(true)
  })
})

describe('骨架屏：去掉微光/呼吸动画（2026-10-17 用户要求「这样的加载样式全部修改」）', () => {
  const themeSrc = readFileSync(join(HERE, '..', 'scifi-theme.css'), 'utf8')
  const hooksSrc = stripComments(readFileSync(join(HERE, 'hooks.tsx'), 'utf8'))

  /**
   * 改前全仓有 6 处骨架带无限循环动画：
   *   · `.nm-skel::after` 的 `nmSkelSweep` 扫光（ListSkeleton 全局用）
   *   · `.skLine` / `.skeletonMap::after` / `.skBarFill` 的 `ov-shimmer`
   *   · `.heatmapSkeleton i` 的 `ov-pulse-block`
   *   · `.msgImageSkeleton` 的 `wxImgPulse`
   *   · `.skelBlock` 的 `wcSkel`
   *   · `.skelCard` 的 `annualSkeletonPulse`
   *
   * 三个问题：① 本机加载通常几百毫秒，光还没扫完内容就出来了，看起来像卡顿；
   * ② 一屏好几条同时动，视觉噪音大而信息量是零；③ 无限循环动画持续触发合成层重绘。
   *
   * 骨架**不能整个删掉**：它的职责是占住布局，避免内容出现时列表整体跳一下。
   */
  it('全局 .nm-skel 不再有扫光动画', () => {
    expect(themeSrc, '.nm-skel 不许再有扫光 keyframes').not.toContain('@keyframes nmSkelSweep')
    expect(themeSrc, '.nm-skel::after 必须清空（content: none）').toMatch(/\.nm-skel::after\s*\{\s*content:\s*none/)
    // 底色必须还在 —— 没有底色的骨架等于空白
    expect(themeSrc).toMatch(/\.nm-skel\s*\{[^}]*background:\s*var\(--nm-bg-hover\)/)
  })

  it('ListSkeleton 统一为「旋转指示 + 加载中…」，不再渲染骨架条（2026-10-18 用户要求正常加载样式）', () => {
    expect(hooksSrc, 'ListSkeleton 还在渲染骨架条').not.toMatch(/className=\{`nm-skel|className="nm-skel/)
    expect(hooksSrc, 'ListSkeleton 没接统一加载态')
      .toMatch(/return <LoadingState variant="compact" label="加载中…" \/>/)
  })

  it('各面板的骨架都不许再挂无限循环动画', () => {
    const files = [
      ['overview.module.css', ['ov-shimmer', 'ov-pulse-block', 'ov-skeleton-in']],
      ['chats.module.css', ['wxImgPulse']],
      ['storage.module.css', ['wcSkel']],
      ['annual.module.css', ['annualSkeletonPulse']],
    ] as const
    for (const [file, keys] of files) {
      const css = readFileSync(join(HERE, file), 'utf8')
      for (const k of keys) {
        expect(css, `${file} 里不许再有 @keyframes ${k}`).not.toContain(`@keyframes ${k}`)
      }
    }
  })
})

describe('文件面板页头：压缩到两行（2026-10-17 用户要求「不要占用太多空间」）', () => {
  const panelSrc = stripComments(readFileSync(join(HERE, 'kb-files-panel.tsx'), 'utf8'))
  const supportSrc = stripComments(readFileSync(join(HERE, 'kb-files-support.tsx'), 'utf8'))
  const queueSrc = stripComments(readFileSync(join(HERE, 'kb-queue-line.tsx'), 'utf8'))

  /**
   * 改前页头占四行：标题行 + 描述行 + 工具栏行 + 「解析队列：空的」。
   * 现在：
   *   · 描述收进标题的 `title`（悬停即见）—— 「第一次用才看一次」的信息不该每次占一行；
   *   · 「已登记 N 个」与索引状态并进标题行；
   *   · 解析队列只在**有活干**时才出现。
   */
  it('描述收进 title，不再占独立一行', () => {
    // PanelHeader 不许再传 desc（那会渲染成独立一行）
    expect(panelSrc, 'PanelHeader 不许再传 desc（会占一整行）').not.toMatch(/<PanelHeader[\s\S]{0,200}?desc=/)
    // 描述必须还在，只是收进 title
    expect(supportSrc, '描述必须收进 title（不能删）').toContain('当前知识库里的本地文件：登记 / 解析状态')
    expect(supportSrc).toMatch(/title="当前知识库里的本地文件/)
  })

  it('已登记数与索引状态并进标题行', () => {
    // 标题行组件必须同时含这三样
    expect(supportSrc).toContain('export function KbTitleRow')
    expect(supportSrc).toMatch(/className=\{css\.titleRow\}/)
    expect(supportSrc).toMatch(/已登记 \{visible\} \/ \{total\}/)
    expect(supportSrc).toMatch(/className=\{css\.indexChip\}/)
    // 面板里用这个组件，不再自己拼
    expect(panelSrc).toMatch(/title=\{<KbTitleRow visible=\{visible\.length\} total=\{total\} index=\{idx\} \/>\}/)
    // 工具栏右侧不许再挂统计（那会多占一行）
    expect(panelSrc, '工具栏不许再挂 right 统计').not.toMatch(/<Toolbar[\s\S]{0,900}?right=\{/)
  })

  it('解析队列空且无事可做时整行不渲染', () => {
    // 改前会显示「解析队列：空的」—— 一句没信息量的话占掉一整行
    expect(queueSrc, '队列空时不许渲染「空的」').not.toContain('解析队列：空的')
    expect(queueSrc, '队列空且无待处理时必须 return null').toMatch(/if \(pending === 0 && attention === 0\) return null/)
  })
})

describe('正文阅读区：与文件列表的关系', () => {
  /**
   * 正文展开时，**文件设置类的三块全部让位**（2026-10-17 用户要求）。
   *
   * 用户点「查看正文」就是要读原文。摘要、出网开关、明细（大小/指纹/路径）
   * 都属于「文件设置」，占着上面一大块把正文推下去，或者排在正文下方
   * 让用户滚到底时突然撞见一堆指纹和路径。
   *
   * 收起正文后它们自然回来 —— 没有丢，只是让位给用户此刻真正要看的东西。
   *
   * ⚠️ 判据必须是「被 `!readerOpen` 包住」，不能只判「有 readerOpen 变量」：
   * 变量存在但没用在块上，等于没改。
   */
  it('正文展开时摘要 / 出网开关 / 明细三块都让位', () => {
    // readerOpen 必须真的被算出来（依赖 reader 与 selected 的 fileId 一致）
    expect(detailSrc).toMatch(/const readerOpen = reader !== null && selected !== null && reader\.fileId === selected\.id/)
    // 三块都必须被 `{!readerOpen && (` 包住
    for (const [cls, label] of [['summary', '摘要块'], ['switchRow', '出网开关'], ['sectionLabel', '明细']] as const) {
      const re = new RegExp(`\\{!readerOpen && \\([\\s\\S]{0,200}?css\\.${cls}`)
      expect(detailSrc, `${label}没有被 !readerOpen 包住`).toMatch(re)
    }
    // 不许退回无条件渲染（那正是要防的写法）
    expect(detailSrc, '摘要块不许无条件渲染').not.toMatch(/\n\s{10}<div className=\{css\.summary\}>/)
    expect(detailSrc, '出网开关不许无条件渲染').not.toMatch(/\n\s{10}<div className=\{css\.switchRow\}>/)
    expect(detailSrc, '明细不许无条件渲染').not.toMatch(/\n\s{10}<div className=\{css\.sectionLabel\}>明细/)
  })

  /**
   * 查看正文**不许挤压文件列表**（2026-10-17 用户要求）。
   *
   * 改前正文展开时给详情区加 `detailPaneFull`（`grid-column: 1 / -1`）跨满两栏 ——
   * 文件列表被挤到上面去，用户点「查看正文」只是想读内容，不是想把列表收起来。
   */
  it('详情区不许跨满两栏', () => {
    expect(detailSrc, '详情区不许再跨满两栏（会把文件列表挤走）').not.toMatch(/css\.detailPaneFull/)
    // CSS 里也不许留着这条规则（留着就是给下一个人递刀）
    expect(panelCss, 'CSS 里不许再有 .detailPaneFull').not.toMatch(/\.detailPaneFull\s*\{/)
    // 详情区必须仍是 `.body` 网格的第二列（不跨栏）。
    // 2026-10-17：列表栏从 240–340px 收窄到 200–260px（用户要求「文件列表区域太宽了」），
    // 判据跟着改 —— 但**结构**不变：仍是「窄列表 + 1fr 详情」两列。
    expect(panelCss).toMatch(/\.body\s*\{[^}]*grid-template-columns:\s*minmax\(200px,\s*260px\)\s+minmax\(0,\s*1fr\)/)
  })

  /**
   * 正文滚动**不许带动文件列表**（2026-10-17 用户要求）。
   *
   * 改前 `.bodyWrap` 是整个面板唯一的滚动区，文件列表和详情栏都在里面 ——
   * 正文很长时，滚正文会把左边的文件列表一起滚走。
   *
   * ⚠️ 三个坑，缺一个就退回去：
   *   ① `.body` 必须 `height: 100%`（不是 `max-height`）—— `.bodyWrap` 是 flex 子项，
   *      `max-height: 100%` 的百分比基准是内容高度，等于没封顶（真机实测撑到 6577px）；
   *   ② `.detailPane` 是 kit 的 Card（`.card` 有 `overflow: hidden`），
   *      必须用两级选择器压过它，否则滚动条出不来；
   *   ③ 滚动容器必须落在 `.list` 自己身上，不能给 `.listPane`（Card 会裁掉）。
   */
  it('两栏各自滚，.bodyWrap 不再滚', () => {
    // ① 正文展开时 .bodyWrap 不再滚
    expect(panelCss).toMatch(/\.bodyWrap:has\(\.reader\)\s*\{[^}]*overflow:\s*hidden/)
    // ② .body 用 height: 100% 封顶（不是 max-height —— 百分比基准是内容高度，等于没封顶）
    const bodyRule = /\.bodyWrap:has\(\.reader\)\s+\.body\s*\{([^}]*)\}/.exec(panelCss)?.[1] ?? ''
    expect(bodyRule, '找不到 .bodyWrap:has(.reader) .body').not.toBe('')
    expect(bodyRule, '.body 必须 height: 100% 封顶').toMatch(/height:\s*100%/)
    expect(bodyRule, '.body 不许用 max-height（百分比基准是内容高度，等于没封顶）').not.toMatch(/max-height/)
    // ③ 列表自己滚（落在 .list 上，不是 .listPane —— Card 会裁掉）
    const listRule = /\.bodyWrap:has\(\.reader\)\s+\.list\s*\{([^}]*)\}/.exec(panelCss)?.[1] ?? ''
    expect(listRule, '找不到 .bodyWrap:has(.reader) .list').not.toBe('')
    expect(listRule).toMatch(/overflow-y:\s*auto/)
    expect(listRule).toMatch(/height:\s*100%/)
    // ④ 详情栏自己滚，且必须压过 kit 的 .card { overflow: hidden }
    const detailRule = /\.bodyWrap:has\(\.reader\)\s+\.detailPane\s*\{([^}]*)\}/.exec(panelCss)?.[1] ?? ''
    expect(detailRule, '找不到 .bodyWrap:has(.reader) .detailPane').not.toBe('')
    expect(detailRule).toMatch(/overflow-y:\s*auto/)
    expect(detailRule).toMatch(/height:\s*100%/)
    // ⑤ 两栏都要 overscroll-behavior-y: contain —— 否则滚到底会「传染」给外层
    expect(listRule).toMatch(/overscroll-behavior-y:\s*contain/)
    expect(detailRule).toMatch(/overscroll-behavior-y:\s*contain/)
  })

  /**
   * 正文两栏的容器查询必须查**详情栏**，不是 `.bodyWrap`。
   *
   * `.bodyWrap` 是整个面板的宽度（约 1200px），而正文阅读区的可用宽度是详情栏
   * （约 856px）。拿面板宽度判「两栏放不放得下」永远判成「放得下」——
   * 真机实测正文栏只剩 562px，读起来太窄。
   */
  it('容器查询查详情栏，不是整个面板', () => {
    expect(panelCss).toMatch(/\.detailPane\s*\{[^}]*container-type:\s*inline-size/)
    expect(panelCss).toMatch(/\.detailPane\s*\{[^}]*container-name:\s*kbfilesdetail/)
    expect(panelCss).toMatch(/@container kbfilesdetail \(max-width:\s*760px\)/)
    expect(panelCss, '正文两栏不许查整个面板的宽度').not.toMatch(/@container kbfiles \(max-width:\s*\d+px\)\s*\{\s*\.readerSplit/)
  })
})
