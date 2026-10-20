/**
 * 正文阅读区 —— 从 `kb-files-detail.tsx` 拆出（单函数 250 行棘轮）。
 *
 * ## 设计（2026-10-17 重做）
 *
 * 改前是「左右两栏各自 `max-height: 52vh` + `overflow-y: auto`」，真机截图暴露三个问题：
 *
 *   ① **滚动条套滚动条**：外层 `.bodyWrap` 已经是滚动区，两栏里又各有一个 ——
 *      滚轮落在哪一层全看指针位置，用户滚不动正文时根本不知道为什么；
 *   ② **52vh 在 1000px 高的窗口里只有 520px**，正文下方留一大片死空白，
 *      而正文下方留一大片死空白；
 *   ③ **两栏之间没有关联**：左边读到第 3 段，右边不知道对应哪一块 ——
 *      而「切得对不对」正是知识库最该让人看见的事。
 *
 * 现在：
 *   · **单滚动区**：整块随内容长高，由 `.bodyWrap` 统一滚（与面板其它区域一致）；
 *   · **左原文 / 右分块目录**：右栏是**窄目录**（块序号 + 页码 + 字数 + 首行摘要），
 *     点一下滚到左边对应位置 —— 目录不该把正文再抄一遍；
 *   · **悬停联动**：鼠标停在某块上，左边对应段落高亮（`data-active`），
 *     反过来也一样。这是「对照」这件事唯一真正有用的形态；
 *   · **块间分隔线**：原文里每块之间画一条极淡的虚线，让「切在哪」看得见，
 *     但不像卡片那样把连续文本切碎。
 *
 * ⚠️ 窄容器退成上下两段用**容器查询**（`.bodyWrap` 已声明 `container-type: inline-size`），
 * 不用窗口媒体查询：侧栏折叠会改变本区域可用宽度而窗口尺寸不变。
 */
import { useCallback, useMemo, useRef, useState } from 'react'
import type { KbFileChunk } from '../types.ts'
import { headingWorthShowing } from './kb-files-support.tsx'
import css from './kbfiles.module.css'
import kitCss from '../ui/kit.module.css'

/** 目录里每块显示的首行摘要长度（够认出是哪一段，又不至于把正文抄一遍）。 */
const TOC_PREVIEW_CHARS = 42

/**
 * 把一块正文压成一行目录摘要。
 *
 * 换行、连续空白、Markdown 标记都要压掉：目录是**索引**不是内容，
 * 保留 `##`、`>`、`**` 只会让一列窄栏变成乱码。
 *
 * ⚠️ 顺序有讲究：先剥行首的引用/标题/列表标记（它们带 `^` 锚点，必须在压平换行**之前**做），
 * 再压平空白，最后剥行内的强调标记（`**粗体**`、`` `代码` ``）—— 反过来的话
 * 换行已经没了，`^` 锚点就再也匹配不到行首。
 * @param text - 块正文。
 * @returns 单行摘要（超长截断并加省略号）；整块只有分隔线时返回空串。
 */
function tocPreview(text: string): string {
  const flat = text
    // 行首标记：引用 `>`、标题 `#`、列表 `- * +`、有序列表 `1.`、表格竖线
    .replace(/^\s*>\s?/gm, '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+\.\s+/gm, '')
    .replace(/^\s*\|/gm, '')
    // 表格分隔行（`| --- | --- |`、`--- | ---`）整行丢掉 —— 它只有边框没有内容，
    // 留着会让预览变成「指标 | 数值 | 说明 | --- | --- | ---」这种半截乱码。
    // 必须在压平空白**之前**按行处理，压平后就分不出行了。
    .replace(/^[\s|:-]*$|^[\s|:-]*\|[\s|:-]*$/gm, '')
    // 压平空白（必须在行首标记之后）
    .replace(/\s+/g, ' ')
    // 行内强调：`**粗**`、`*斜*`、`` `代码` ``、`[文字](链接)` 只留文字
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .trim()
  // 只剩分隔线 / 表格边框（`---`、`| --- | --- |`、`***`）⇒ 没有可读内容。
  // 判据是「去掉 `-` `|` `*` `_` 和空白后什么都不剩」，而不是「等于 `---`」——
  // 表格边框压平后是 `--- | --- | ---`，逐字比对抓不到。
  if (/^[-|*_\s]*$/.test(flat)) return ''
  return flat.length > TOC_PREVIEW_CHARS ? flat.slice(0, TOC_PREVIEW_CHARS) + '…' : flat
}

/**
 * 把后端给的层级 heading 压成「只够区分这一块」的短标题。
 *
 * 后端给的是 `文件名 › 一级 › 二级` 这样的完整路径（见 `entities.ts:normalizeHeading`），
 * 于是每一条目录项都带着同一个文件级前缀 —— 60 条重复同一句话，
 * 真正有信息量的「第 N 页 / N 字」被挤到看不见（真机截图实测）。
 *
 * 做法：按 `›` 切开，**丢掉与上一块相同的前缀**，只留变化的那一段。
 * 例：上一块 `文件 › 1 公司 › 1.1 介绍`，这一块 `文件 › 1 公司 › 1.2 数字`
 * ⇒ 只显示 `1.2 数字`。
 * @param heading - 后端给的完整 heading。
 * @param prev - 上一块的 heading（用于求公共前缀）。
 * @returns 要显示的短标题；没有可显示的内容时返回空串。
 */
function shortHeading(heading: string, prev: string): string {
  if (!headingWorthShowing(heading)) return ''
  const parts = heading.split('›').map(s => s.trim()).filter(s => s !== '')
  const prevParts = prev.split('›').map(s => s.trim()).filter(s => s !== '')
  let i = 0
  while (i < parts.length && i < prevParts.length && parts[i] === prevParts[i]) i += 1
  const rest = parts.slice(i).join(' › ')
  // 整条都是前缀（同一节被切成多块）⇒ 没有新信息，不显示。
  return rest
}

/**
 * 渲染正文阅读区。
 *
 * 正文**自动全部加载**（2026-10-17 用户要求）：不再有「继续加载」按钮 ——
 * 用户点「查看正文」就是要读完整份，让他一块一块点下去是把分页的实现细节
 * 推给了用户。分轮拉取在 `kb-files-panel.tsx` 的 `loadChunks` 里做，
 * 这里只负责把已到的块画出来，并在还没拉完时显示进度。
 * @param props.items - 已读到的块。
 * @param props.total - 总块数。
 * @param props.totalChars - 总字数。
 * @param props.loading - 是否还在拉取。
 * @param props.error - 读取错误。
 * @returns 阅读区元素。
 */
export function KbFileReader({ items, total, totalChars, loading, error }: {
  items: readonly KbFileChunk[]
  total: number
  totalChars: number
  loading: boolean
  error: string | null
}): React.JSX.Element {
  /** 当前高亮的块序号（悬停或点击目录时设置）。`null` = 没有高亮。 */
  const [active, setActive] = useState<number | null>(null)
  /** 原文各块的 DOM 引用，供目录点击时 `scrollIntoView`。 */
  const blockRefs = useRef(new Map<number, HTMLDivElement>())

  const registerBlock = useCallback((ordinal: number, el: HTMLDivElement | null): void => {
    if (el === null) blockRefs.current.delete(ordinal)
    else blockRefs.current.set(ordinal, el)
  }, [])

  /**
   * 点目录 → 滚到右边对应块。
   *
   * `block: 'nearest'` 而不是 `'center'`：滚动发生在 `.readerMain` 内部
   * （两栏各自滚，见样式表），`center` 会把块顶到栏的正中，
   * 上下文（上一块结尾、下一块开头）全被挤出去 —— 而对照阅读恰恰需要上下文。
   * `nearest` 只在块不在视野里时才滚，且滚到刚好可见为止。
   */
  const jumpTo = useCallback((ordinal: number): void => {
    setActive(ordinal)
    blockRefs.current.get(ordinal)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [])

  /**
   * 目录数据：只在块列表变化时重算（`tocPreview` 要跑正则，别每帧都算）。
   *
   * ⚠️ 第二行**只放会变的东西**（章节 / 页码 / 字数）。改前把完整 `heading` 放进去，
   * 而它是 `文件名 › 一级 › 二级` 的层级路径 —— 60 条目录项重复同一个文件级前缀，
   * 把真正有信息量的「第 N 页 / N 字」挤到看不见（真机截图实测）。
   * 现在用 `shortHeading` 只留与上一块不同的那一段。
   */
  const toc = useMemo(() => {
    let prevHeading = ''
    return items.map((c) => {
      const preview = tocPreview(c.text)
      const heading = shortHeading(c.heading, prevHeading)
      prevHeading = c.heading
      return {
        ordinal: c.ordinal,
        page: c.page,
        heading,
        chars: c.charCount,
        // 有些块只有分隔线 / 表格边框（`---`、`| --- |`），压平后是空串。
        // 留空会让目录项看起来像坏了，给一句占位说明它是什么。
        preview: preview === '' ? '（分隔线 / 空块）' : preview,
      }
    })
  }, [items])

  return (
    <div className={css.reader}>
      {/* 栏头：标题 + 进度 + 一句「这是什么」。
          2026-10-17：说明文字从**独立一段**收进栏头右侧（`title` 悬停看全文）。
          改前它占两行，把正文推下去 —— 而用户点「查看正文」就是要读原文，
          这段说明属于「第一次用才需要看一次」的信息，不该每次都占版面。
          但它不能删：不说清「这是解析文本不是原稿」，用户会拿它核对原稿，
          而两者可以给出不同的结论。所以收进 `title`，需要时悬停即见。 */}
      <div className={css.readerHd}>
        <span>正文</span>
        <span
          className={css.readerMeta}
          title={'这是解析出来的文本，也就是问答与正文检索实际读到的内容 —— '
            + '表格、图片与页眉页脚在解析时已经丢掉。要核对原稿请用「在资源管理器中定位」。'}
        >
          已读 {items.length} / {total} 块 · {totalChars.toLocaleString('zh-CN')} 字
          <span className={css.readerHint}>解析文本，非原稿</span>
        </span>
      </div>
      {error && <div className={kitCss.error} role="alert">{error}</div>}
      {loading && items.length === 0 && (
        <div className={css.readerLoading} role="status">读取正文…</div>
      )}
      {items.length === 0 && !loading && error === null && (
        <div className={css.readerEmpty}>
          这个文件还没有正文块 —— 解析没成功或还在排队时，展开就是空的。
        </div>
      )}
      {items.length > 0 && (
        <div className={css.readerSplit}>
          {/* 左：分块目录 —— 窄栏，只放「怎么找到它」需要的信息。
              2026-10-17 换到左边：目录是**导航**，导航在左、内容在右是阅读器的通行布局
              （文件树 / 大纲 / 书签都在左）。改前目录在右，用户的眼睛要先跳到最右边
              才能定位，再跳回左边读 —— 每换一块都要横跨整个屏幕。
              点一下滚到右边对应块，悬停时两边同时高亮。

              ⚠️ 栏头（`.paneLabel`）在**滚动区外面**：改前它用 `position: sticky`
              贴在滚动区里，而滚动区有 `padding` —— sticky 的 `top: 0` 是相对内容区的，
              于是滚动时正文从 padding 区域穿过去，把栏头压掉半截（用户截图实测）。
              现在栏头是固定的一行，只有下面的 `.paneBody` 滚。 */}
          <nav className={css.readerToc} aria-label="分块目录">
            <div className={css.paneLabel}>分块（{items.length}）</div>
            <div className={css.paneBody}>
              {toc.map(t => (
                <button
                  key={t.ordinal}
                  type="button"
                  className={css.tocItem}
                  data-active={active === t.ordinal ? 'true' : undefined}
                  onClick={() => { jumpTo(t.ordinal) }}
                  onMouseEnter={() => { setActive(t.ordinal) }}
                  onMouseLeave={() => { setActive(null) }}
                  title={t.preview}
                >
                  <span className={css.tocNo}>#{t.ordinal + 1}</span>
                  <span className={css.tocPreview}>{t.preview}</span>
                  <span className={css.tocMeta}>
                    {t.page > 0 ? `第 ${t.page} 页 · ` : ''}
                    {headingWorthShowing(t.heading) ? `${t.heading} · ` : ''}
                    {t.chars} 字
                  </span>
                </button>
              ))}
            </div>
          </nav>
          {/* 右：原文 —— 连续文本，块之间一条虚线标出「切在哪」。
              虚线而不是卡片：卡片会把一份文档切成一堆碎片，读起来像列表不像文章。
              每块左上角一个 `#N` 角标，与左栏目录一一对应 —— 没有它，
              用户看到虚线也不知道「这是第几块」，对照就无从谈起。
              栏头同样在滚动区外面（理由见左栏）。 */}
          <div className={css.readerMain}>
            <div className={css.paneLabel}>原文</div>
            <div className={css.paneBody}>
              <div className={css.rawText}>
                {items.map(c => (
                  <div
                    key={c.ordinal}
                    ref={(el) => { registerBlock(c.ordinal, el) }}
                    className={css.rawBlock}
                    data-active={active === c.ordinal ? 'true' : undefined}
                    onMouseEnter={() => { setActive(c.ordinal) }}
                    onMouseLeave={() => { setActive(null) }}
                  >
                    <span className={css.rawNo}>#{c.ordinal + 1}</span>
                    {c.text}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
      {items.length < total && (
        <div className={css.readerLoading} role="status">
          正在加载剩余 {total - items.length} 块…
        </div>
      )}
    </div>
  )
}
