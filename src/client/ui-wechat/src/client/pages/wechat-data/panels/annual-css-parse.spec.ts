/**
 * CSS 可解析性守卫（2026-11-19）。
 *
 * ## 为什么需要它
 *
 * 当天改版时我往 `annual.module.css` 里插入了一段 `⚠️ …` 说明文字，但它落在了
 * 注释块**外面** —— 结果是裸文本，postcss 报 `Expected a pseudo-class or pseudo-element`，
 * `build:ui` 直接失败、应用起不来。
 *
 * 而当时**全量测试 8689 项全绿**：所有既有守卫都是「正则扫源码找某个形状」，
 * 没有一个真的把 CSS 交给解析器。这类错误（注释没闭合、多了个花括号、裸文本）
 * 恰好是正则最抓不住、而构建最先炸的一类。
 *
 * 所以这里用 postcss 真的解析一遍三张总结页的样式表：能解析 = 结构合法。
 * 它不判断样式好不好看，只保证"浏览器/构建工具读得懂"。
 * @vitest-environment node
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import postcss from 'postcss'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))

/** 年度报告的样式表（本次出问题的那张）。 */
const ANNUAL = join(HERE, 'annual.module.css')

describe('年度报告 CSS 必须能被解析', () => {
  it('annual.module.css 通过 postcss 解析（注释闭合、括号配平、无裸文本）', () => {
    const css = readFileSync(ANNUAL, 'utf8')
    const parsed = postcss.parse(css, { from: ANNUAL })
    expect(parsed.nodes.length, '一条规则都没解析出来 ⇒ 文件结构不对').toBeGreaterThan(30)

    /**
     * **注释没闭合的指纹**：postcss 会把落在注释外的说明文字当成一条「选择器」。
     * 2026-11-19 那次事故就是这样 —— `⚠️ align-items: stretch …` 成了选择器，
     * postcss 不抛错（所以只查"能不能 parse"抓不到），但构建器随后报
     * `Expected a pseudo-class or pseudo-element`。
     *
     * 判据：选择器里出现说明文字才会有的符号（⚠️ 之类的非 ASCII 符号）。
     * 正常选择器是 `.foo` / `.foo > .bar` / `@media (…)`，不会有这些字符。
     */
    const suspicious: string[] = []
    parsed.walkRules((rule) => {
      const sel = rule.selector.trim()
      if (sel === '') return
      if (/[⚠✅❌→]/.test(sel) || /[\u4e00-\u9fff]/.test(sel)) suspicious.push(sel.slice(0, 60))
    })
    expect(suspicious, `这些「选择器」其实是走漏的说明文字 ⇒ 注释没闭合：\n  ${suspicious.join('\n  ')}`)
      .toEqual([])
  })

  it('防空转：解析结果里确实有本次新增的关键规则', () => {
    const css = readFileSync(ANNUAL, 'utf8')
    const root = postcss.parse(css, { from: ANNUAL })
    const selectors = new Set<string>()
    root.walkRules((rule) => { selectors.add(rule.selector.trim()) })
    for (const sel of ['.board', '.cardFill', '.moreBody', '.tileGrid']) {
      expect(selectors.has(sel), `解析后找不到 ${sel} —— 判据对象变了`).toBe(true)
    }
  })

  it('同行等高与填充层同时在（补齐空白的两个前提）', () => {
    const root = postcss.parse(readFileSync(ANNUAL, 'utf8'), { from: ANNUAL })
    /** 取某条选择器的全部声明值。 */
    const declarationsOf = (selector: string): string[] => {
      const out: string[] = []
      root.walkRules((rule) => {
        if (rule.selector.trim() !== selector) return
        rule.walkDecls((decl) => { out.push(`${decl.prop}:${decl.value}`) })
      })
      return out
    }
    expect(declarationsOf('.board'), '.board 缺 align-items: stretch').toContain('align-items:stretch')
    expect(declarationsOf('.cardFill'), '.cardFill 缺 space-between').toContain('justify-content:space-between')
    expect(declarationsOf('.moreBody'), '.moreBody 缺 space-between').toContain('justify-content:space-between')
  })
})
