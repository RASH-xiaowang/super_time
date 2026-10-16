/**
 * 取数策略推广**台账**（2026-10-03 收尾：PENDING 已清空）。
 *
 * 用户要求："数据改为每次打开都会直接请求获取，不需要本地缓存了，只有在（后端不可用的）时候才使用本地缓存。"
 *
 * 这条规则在 17 个面板里被复制粘贴成同一模式，逐个推广最容易发生两件事：
 *  ① 已转换的面板**悄悄退回**（又加回 `useState(() => readRenderCache(...))` 预填）；
 *  ② 推广**半途停住**而没人发现。
 * 所以把名单写进判据，并把 `PENDING` 做成**带形状**（预填数）的登记。
 *
 * ## 五类（互不重叠）
 *
 *  · `CONVERTED`：已用共用 `useFreshData`；
 *  · `INLINE_CONVERTED`：语义已就位但实现**内联**（早于 hook，不谎报）；
 *  · `MANUAL_BY_DESIGN`：**缓存优先 + 手动刷新**（取数是重活，不得挂载即取）；
 *  · `CONVERTED_KEEPING_CACHE_READ`：已转换，但**按设计保留一处缓存读**；
 *  · `PENDING`：待推广（本轮已清空）。
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (f: string): string =>
  readFileSync(new URL('./' + f, import.meta.url), 'utf8')

/** 已改用共用 `useFreshData` 的取数入口。 */
const CONVERTED = [
  'Calls.tsx',            // 通话记录
  'MediaAssets.tsx',      // 媒体资产
  'OfficialAssets.tsx',   // 公众号文章
  'AssetInsights.tsx',    // 收藏表情统计
  'MomentsInsights.tsx',  // 朋友圈洞察
  'Tasks.tsx',            // 待办日程（shouldCache 保住 N1 契约：读失败的结果不进缓存）
  'Hook.tsx',             // 原图链路自检（cfg 走 hook；health/storage 刻意不缓存）
  'Backup.tsx',           // 备份恢复（items 走 hook；refresh = reload）
  'Graph.tsx',            // 社交图谱 + 知识图谱各一个 hook（知识侧失败不污染社交侧 error）
] as const

/**
 * **语义已就位、但实现是内联的**（早于共用 hook）。
 *
 * `moments-data.ts` 是这条策略的第一个落地处：当时还没有 `useFreshData`，所以
 * 「打开即查、失败回退缓存并标注」直接写在它的 `load` 里。登记在这里是为了
 * **不谎报**"已经用上 hook"；它同样受"不得预填"约束。
 */
const INLINE_CONVERTED = ['moments-data.ts'] as const

/**
 * **按设计「缓存优先 + 手动刷新」**的面板（**不适用**「打开即查最新」）。
 *
 *  · `Health.tsx`：取数是**全库健康遍历**，「不进入页签即自动执行，初始仅展示渲染缓存，
 *    由『重新检查』按钮按需触发全量统计」。
 *  · `Privacy.tsx`：源码写着「全库敏感信息扫描较重：**不再在打开页签时自动执行**，
 *    由用户点击『开始扫描』触发；已有渲染缓存时直接展示缓存，避免白屏」。
 *
 * 对它俩套「打开即查 + 不预填」会让进页签变成一次全量扫描、首屏还空白 —— 比现状更差。
 */
const MANUAL_BY_DESIGN = ['Health.tsx', 'Privacy.tsx'] as const

/**
 * **已转换、但按设计保留一处缓存读**。
 *
 * `PrivacyTrust.tsx`：`state` / `rows` 走 `useFreshData`（打开即查最新，三处本地写走 `override`）；
 * 而 `privacy-scan` **必须**继续读渲染缓存 —— 源码说明「扫描是重活，结果沿用渲染缓存，
 * 要最新去『隐私体检』页手动扫」，挂上取数 hook 会让打开本页触发全库敏感扫描。
 */
const CONVERTED_KEEPING_CACHE_READ: ReadonlyArray<{ file: string; prefills: number }> = [
  { file: 'PrivacyTrust.tsx', prefills: 1 },
] as const

/**
 * 待推广面板：**带形状**登记（`prefills` 由本文件断言）。
 * 2026-10-03 已清空 —— 17 个面板全部有了明确归类。
 */
const PENDING: ReadonlyArray<{ file: string; prefills: number; note: string }> = [] as const

/** 预填写法：`useState<T>(() => readRenderCache<T>('key'))`。 */
const PREFILL = /useState<[^>]*>\(\(\) => readRenderCache/

describe('取数策略推广台账：打开即查最新、失败才回退缓存', () => {
  it('已转换的面板：用了共用 hook，且不再预填缓存', () => {
    for (const f of CONVERTED) {
      const src = read(f)
      expect(src, `${f} 没有用共用 hook useFreshData`).toContain('useFreshData')
      expect(PREFILL.test(src), `${f} 又出现了"打开即预填缓存"的写法`).toBe(false)
    }
  })

  it('内联实现的面板：语义已就位（不预填 + 失败标注），但没用 hook —— 不谎报', () => {
    for (const f of INLINE_CONVERTED) {
      const src = read(f)
      expect(PREFILL.test(src), `${f} 又出现了"打开即预填缓存"的写法`).toBe(false)
      expect(src, `${f} 失败回退时必须在错误里标注"本地缓存"`).toContain('本地缓存')
    }
  })

  it('已转换但保留缓存读的面板：用了 hook，且预填数正好等于设计所需', () => {
    for (const { file, prefills } of CONVERTED_KEEPING_CACHE_READ) {
      const src = read(file)
      expect(src, `${file} 没有用共用 hook useFreshData`).toContain('useFreshData')
      const n = (src.match(/useState<[^>]*>\(\(\) => readRenderCache/g) ?? []).length
      expect(n, `${file} 的缓存读数量变了（多一处＝漏转，少一处＝设计被改）`).toBe(prefills)
    }
  })

  it('未转换的面板仍在 PENDING 里，且**预填数与登记一致**（转换后请登记到 CONVERTED）', () => {
    for (const { file, prefills } of PENDING) {
      const src = read(file)
      const n = (src.match(/useState<[^>]*>\(\(\) => readRenderCache/g) ?? []).length
      expect(n, `${file} 看起来已经转换了 —— 请把它从 PENDING 移到 CONVERTED`).toBe(prefills)
    }
  })

  it('按设计缓存优先的面板：不得挂载即自动取数，且保留手动刷新入口', () => {
    for (const f of MANUAL_BY_DESIGN) {
      const src = read(f)
      const autoLoad = /useEffect\(\(\) => \{ void load\(\) \}, \[load\]\)/.test(src)
      expect(autoLoad, `${f} 不该在挂载时自动取数（它是重活，走刷新按钮）`).toBe(false)
      expect(src, `${f} 必须保留显式刷新入口`).toMatch(/重新检查|重新统计|刷新|开始扫描|扫描/)
    }
  })

  it('五类名单互不重叠（同一文件不能被登记两次）', () => {
    const pendingFiles = PENDING.map((p) => p.file)
    const keepFiles = CONVERTED_KEEPING_CACHE_READ.map((p) => p.file)
    const all = [...CONVERTED, ...INLINE_CONVERTED, ...MANUAL_BY_DESIGN, ...pendingFiles, ...keepFiles]
    const dup = all.filter((f, i) => all.indexOf(f) !== i)
    expect(dup, `重复登记：${dup.join(', ')}`).toEqual([])
  })

  it('推广已完成：PENDING 为空（否则说明还有面板没归类）', () => {
    expect(PENDING.length, '还有面板未登记：请归类到五类之一').toBe(0)
  })
})
