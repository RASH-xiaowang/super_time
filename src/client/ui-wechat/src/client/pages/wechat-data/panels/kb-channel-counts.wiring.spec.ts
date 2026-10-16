// @vitest-environment node
/**
 * W2-7.4 前端那一半：面板标题要把「关键词命中 x / 语义命中 y」说出来。
 *
 * ## 为什么是接线判据而不是渲染断言
 *
 * 这个面板是纯客户端渲染，标题那一行就是一个模板串；真跑起来测它要拖起
 * 整个 React + CSS 模块链，而能退化的地方全在**那几个拼进模板的值**上。
 * 所以判据钉「标题由哪几样拼成」，以及 `channelCountLine` 的口径
 * （只数 `active` 的那一路、dense 叫「语义命中」、其余叫「关键词命中」）。
 *
 * ## 两条不许退化的纪律
 *
 * ① 有降级说明时整句取自后端 `degraded.label` —— 那句话有三种触发条件
 *    （没建索引 / 没配向量模型 / 这次语义检索没跑成），前端自己猜一种
 *    就会在其余两种下说错。所以 `degraded.label` 优先于本地的通道名。
 * ② 没跑成的那一路**不出现**在计数行里：稠密没跑不是「语义命中 0」，
 *    是「这一路这次没参加」，两者含义不同。
 * @module kb-channel-counts-wiring
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const PANEL = fileURLToPath(new URL('./kb-files-panel.tsx', import.meta.url))
const src = readFileSync(PANEL, 'utf8')

describe('W2-7.4 面板标题', () => {
  it('拼进标题的是「两路各自命中数」，而不是融合后的总条数', () => {
    // 计数是折进模板里的（不再单独起一个中间变量）—— 所以判据也钉那个折法。
    // 计数折进模板里（不再单独起一个中间变量）—— 判据也钉那个折法。
    const folded = "${base}${channelCountLine(search) === '' ? '' : ' · ' + channelCountLine(search)}"
    expect(src).toContain(folded)
  })

  it('降级说明优先于本地通道名（那句整句取自后端，前端不复述）', () => {
    expect(src).toMatch(/const base = search\.degraded\?\.label \?\? searchTitleBase\(search\)/)
  })

  it('总条数与用时仍然在标题里（不能为了加两路把原有的丢掉）', () => {
    expect(src).toContain('${search.hits.length} 条')
    expect(src).toContain('${Math.round(search.stats.elapsedMs)}ms')
  })
})

describe('W2-7.4 channelCountLine 的口径', () => {
  it('只数 active 的通道：稠密没跑不是「语义命中 0」', () => {
    expect(src).toMatch(/stats\.channels \?\? \[\]\)\s*\n\s*\.filter\(\(c\) => c\.active\)/)
  })

  it('dense 叫「语义命中」，其余叫「关键词命中」', () => {
    // 源码里这行用的是反引号（模板串里嵌引号），判据先把引号统一，别让判据去挑引号风格。
    const flat = src.replace(/`/g, "'")
    expect(flat).toContain("c === 'dense' ? '语义命中' : '关键词命中'")
  })

  it('两路之间用「 · 」隔开', () => {
    expect(src).toContain(".join(' · ')")
  })

  it('搜索入口自己取的是 `search`（不是上一次的结果）', () => {
    expect(src).toContain('await apiSearchKb(kbId, kw)')
    // 旧结果在切词/切库后必须被判为过期，标题显示「正在检索正文…」
    expect(src).toContain("if (search === null || searchStale) return '正在检索正文…'")
  })
})

describe('W2-7.4 searchTitleBase', () => {
  it('两路都跑成叫「混合检索」，只有一路叫「关键词检索」', () => {
    expect(src).toContain("return active.length > 1 ? '混合检索' : '关键词检索'")
    expect(src).toMatch(/const active = \(res\.stats\.channels \?\? \[\]\)\.filter\(\(c\) => c\.active\)/)
  })
})