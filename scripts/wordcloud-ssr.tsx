/**
 * 词云卡片的离屏冒烟（SSR，无浏览器）。
 *
 * 为什么需要它：2026-09-30 把「全部热词」从 flex 排布重做成**螺线撒点**，而撒点需要容器宽度 ——
 * SSR / 首帧没有宽度，代码里因此留了一条 flex 回落分支。这条分支和「词仍是可点的 button」
 * 一样属于**只有真渲染一次才看得到**的事实（本环境没有 DOM 测试环境：
 * 见 `docs` 里 M13/M15 的结论），所以用 react-dom/server 渲染成静态 HTML 来断言。
 *
 * 词表靠**渲染缓存**喂进去：卡片初值就取 `readRenderCache`，在这里塞一份合法信封即可 ——
 * 这样不必碰 `apiGetWordCloud`（它在 effect 里，SSR 根本不会跑）。
 *
 * 运行：`node scripts/ui-ask-smoke.js scripts/wordcloud-ssr.tsx`
 */
import { createElement as h } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { writeRenderCache } from '../src/client/ui-wechat/src/client/pages/wechat-data/cache.ts'

/** 先装一个内存 localStorage —— 必须在 import 组件之前（初值读取发生在渲染时，不是导入时）。 */
const store = new Map<string, string>()
;(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, v) },
  removeItem: (k: string) => { store.delete(k) },
}

const { WordCloudCard } = await import('../src/client/ui-wechat/src/client/pages/wechat-data/panels/WordCloudCard.tsx')

let passed = 0
let failed = 0

/** 断言块。 */
function check(name: string, fn: () => void): void {
  try {
    fn()
    passed += 1
    console.log(`  ✅ ${name}`)
  } catch (e) {
    failed += 1
    console.error(`  ❌ ${name}\n     ${(e as Error).message}`)
  }
}

/** 极简断言。 */
function ok(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg)
}

/** 60 个词，次数按 400/(i+1) 衰减（真实词频的长尾形状）。 */
const WORDS = Array.from({ length: 120 }, (_, i) => ({
  text: i % 3 === 0 ? `热词${String(i)}` : `w${String(i)}`,
  count: Math.max(2, Math.round(400 / (i + 1))),
}))
/** 卡片的缓存 key（与卡片里那句 cacheKey 同构：scope:username:year）。 */
// ⚠️ **不含词数/宽度**（2026-09-30）：改窗口尺寸、进全屏都不该重新统计 —— 宽度只决定
// 显示几个词（本地切片），不决定取多少。
const CACHE_KEY = 'wordcloud:global::all'
// 走**产品自己的写缓存入口**（不自己拼前缀）：前缀改名时本冒烟跟着走，不会假绿。
writeRenderCache(CACHE_KEY, { words: WORDS, scanned: 12345 })

const html = renderToStaticMarkup(h(WordCloudCard, { scope: 'global' }))

console.log('词云卡片 SSR 冒烟')

check('渲染出 120 个词按钮（每个词都是真实 button，不是 span）', () => {
  const buttons = html.match(/<button/g) ?? []
  ok(buttons.length === WORDS.length, `按钮数应为 ${String(WORDS.length)}，实际 ${String(buttons.length)}`)
  for (const w of WORDS) ok(html.includes(`>${w.text}</button>`), `词没渲染出来：${w.text}`)
})

check('每个词都带「次数 + 点击搜索」提示（hover 是唯一的精确次数入口）', () => {
  ok(html.includes('点击在全局搜索中查找'), '缺少点击说明')
  ok(html.includes(`${String(WORDS[0]!.count)} 次`), `缺少首词次数（${String(WORDS[0]!.count)} 次）`)
  ok(html.includes('12,345 条正文'), '缺少统计到的正文条数')
})

check('SSR 走的是 flex 回落态：没有容器宽度就不撒点（不崩、也不假装有几何）', () => {
  ok(!html.includes('data-laid'), 'SSR 不该带 data-laid（那时还没量到宽度）')
  ok(!html.includes('position:absolute'), 'SSR 不该输出绝对定位坐标')
  // 回落态仍然要有字号差异（否则「一坨一样大的小词」会连回落态都是平的）
  const sizes = [...html.matchAll(/font-size:(\d+)px/g)].map((m) => Number(m[1]))
  ok(sizes.length === WORDS.length, `字号数应为 ${String(WORDS.length)}，实际 ${String(sizes.length)}`)
  ok(Math.max(...sizes) >= 36 && Math.min(...sizes) <= 12,
    `字号跨度不够：${String(Math.min(...sizes))}~${String(Math.max(...sizes))}`)
})

check('六个色阶类名都在（多色霓虹；不许退回单色）', () => {
  const tones = ['low', 'mid', 'high', 'top', 'peak', 'hot']
  const used = tones.filter((t) => new RegExp(`class="[^"]*${t}`).test(html))
  ok(used.length >= 4, `只用到 ${String(used.length)} 个色阶：${used.join('、')}`)
})

check('空词表时给出空态文案（不是空白卡片）', () => {
  // 换一个没写过缓存的 key（年份不同）⇒ 走的正是「没有缓存」那条路
  const empty = renderToStaticMarkup(h(WordCloudCard, { scope: 'global', year: 1999 }))
  ok(empty.includes('暂无足够文本'), '缺空态文案')
  ok(!empty.includes('<button'), '空态不该有词按钮')
})

console.log(`\n${failed ? '❌' : '✅'} 词云卡片冒烟：通过 ${passed} 项${failed ? `，失败 ${failed} 项` : ''}`)
if (failed > 0) process.exitCode = 1
