/**
 * 词云布局算法的行为判据（2026-09-30 重做「全部热词」时配套）。
 *
 * 为什么这些断言值得写：布局是**几何**，它的失败形态全是「看起来只是有点怪」——
 * 两个词叠在一起、大词跑到角落、刷新一次位置全变。没有一条会因为类型错或构建失败而红。
 * 这里把四条硬不变量钉住：**不重叠 / 不出界 / 确定性 / 大词居中**。
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import {
  CLOUD_FONT_STEPS,
  CLOUD_TONES,
  boxesDisjoint,
  cloudFontStep,
  cloudLimitForStage,
  cloudLimitForWidth,
  cloudStageHeight,
  cloudTone,
  estimateTextWidth,
  layoutWordCloud,
  toCloudWords,
  type CloudTone,
} from './wordcloud-layout.ts'

/** 造一批词：次数按指数衰减（真实词频是长尾，这个分布最接近）。 */
function makeWords(n: number): Array<{ text: string; count: number; size: number; tone: CloudTone }> {
  const words = Array.from({ length: n }, (_, i) => ({
    text: i % 3 === 0 ? `词${String(i)}号` : `w${String(i)}`,
    count: Math.max(2, Math.round(400 / (i + 1))),
  }))
  const max = words[0]!.count
  const min = words[words.length - 1]!.count
  const span = Math.max(1, max - min)
  return words.map((w, i) => {
    const step = cloudFontStep(i, words.length, w.count, min, span)
    return { ...w, size: CLOUD_FONT_STEPS[step]!, tone: cloudTone(step, i) }
  })
}

const STAGE = { width: 1160, height: 320 }

describe('字号曲线：长尾数据也要拉得开', () => {
  it('名次越靠后字号档越小（单调不增）', () => {
    const counts = Array.from({ length: 40 }, (_, i) => Math.max(2, 300 / (i + 1)))
    const min = counts[counts.length - 1]!
    const span = Math.max(1, counts[0]! - min)
    const steps = counts.map((c, i) => cloudFontStep(i, counts.length, c, min, span))
    for (let i = 1; i < steps.length; i += 1) {
      expect(steps[i]!, `第 ${String(i)} 个词的档位反而更大`).toBeLessThanOrEqual(steps[i - 1]!)
    }
    expect(steps[0]).toBe(CLOUD_FONT_STEPS.length - 1)
    expect(steps[steps.length - 1]).toBe(0)
  })

  it('**这是重做前的病根**：长尾里不能有九成词挤在最低档', () => {
    // 60 个词、次数从 400 衰减到 2 —— 旧曲线 (count-min)/span 会让 50+ 个词都落在 12px。
    const counts = Array.from({ length: 60 }, (_, i) => Math.max(2, Math.round(400 / (i + 1))))
    const min = counts[counts.length - 1]!
    const span = Math.max(1, counts[0]! - min)
    const steps = counts.map((c, i) => cloudFontStep(i, counts.length, c, min, span))
    const atFloor = steps.filter((s) => s === 0).length
    expect(atFloor, `最低档占了 ${String(atFloor)}/60 —— 又会变成「一坨一样大的小词」`).toBeLessThan(20)
    // 同时最低档必须真的有人（否则说明曲线把尾部抬得过高，词云会糊）
    expect(atFloor).toBeGreaterThan(3)
  })
})

/**
 * **卡片同款映射**（`toCloudWords`）：这些断言必须跑在「卡片实际用的那一份映射」上。
 *
 * 为什么单独一组：2026-10-12 之前卡片自己写映射，而它把 `cloudFontStep()` 的
 * **档位下标**当像素值用（`Math.min(cloudFontCap(...), cloudFontStep(...))`，两个量纲取 min
 * ⇒ 永远是下标），布局再把下标兜到 `CLOUD_FONT_MIN` ⇒ **120 个词全是 9~12px 一样大**。
 * 上面那几组之所以全绿，是因为它们**自己**写了 `CLOUD_FONT_STEPS[step]` —— 测的是曲线，
 * 不是卡片。用户看到的是「这个板块的内容太少了」（截图里只有一条扁带上的几个小词）。
 * 所以这组盯的是三件事：**字号是像素且在阶梯上 / 大小对比够 / 撒点后全在画布内**。
 */
describe('卡片同款映射：字号必须是像素，且撒点后全在画布内', () => {
  /** 60 个词、次数 400→2（与上面「病根」同一形状的长尾）。 */
  const RAW = Array.from({ length: 60 }, (_, i) => ({
    text: i % 3 === 0 ? `词${String(i)}号` : `w${String(i)}`,
    count: Math.max(2, Math.round(400 / (i + 1))),
  }))

  it('字号是**像素**而不是档位下标（下标当像素用 = 整片词云一样大）', () => {
    const words = toCloudWords(RAW)
    expect(words).toHaveLength(RAW.length)
    const sizes = words.map((w) => w.size)
    expect(sizes[0], '首词必须落在阶梯顶档').toBe(CLOUD_FONT_STEPS[CLOUD_FONT_STEPS.length - 1])
    expect(sizes[sizes.length - 1], '尾词必须落在阶梯底档').toBe(CLOUD_FONT_STEPS[0])
    for (const w of words) {
      expect(
        CLOUD_FONT_STEPS,
        `${w.text} 的字号是 ${String(w.size)}，不在阶梯上 ⇒ 多半是把档位下标当像素传了`,
      ).toContain(w.size)
    }
  })

  it('大小对比 ≥3×（「一坨一样大的小词」正是重做前与本次回归的病）', () => {
    const sizes = toCloudWords(RAW).map((w) => w.size)
    const ratio = Math.max(...sizes) / Math.min(...sizes)
    expect(ratio, `最大/最小只有 ${String(ratio)}×`).toBeGreaterThanOrEqual(3)
  })

  it('单调不增 + 色阶合法 + 空输入不炸', () => {
    const words = toCloudWords(RAW)
    for (let i = 1; i < words.length; i += 1) {
      expect(words[i]!.size, `第 ${String(i)} 个词反而更大`).toBeLessThanOrEqual(words[i - 1]!.size)
    }
    for (const w of words) expect(CLOUD_TONES).toContain(w.tone)
    expect(toCloudWords([])).toEqual([])
  })

  /**
   * 三个真实舞台宽度各撒一次，全部词都必须落在画布内。
   *
   * 这一条同时钉住「舞台高度必须与布局高度同源」：词被放到 `y + height > 画布高` 的位置上时，
   * 只要容器给了正确高度就还看得见；容器矮了（旧代码里舞台没有高度、只剩 48px）就被
   * `overflow:hidden` 裁掉 —— 那是「上百个词只看见几个」的直接机制。
   */
  it('撒点之后全部落在画布内（舞台拿到这个高度就不会被 overflow 裁掉）', () => {
    for (const width of [700, 1160, 2350]) {
      const height = cloudStageHeight(width)
      const picked = RAW.slice(0, cloudLimitForWidth(width))
      const r = layoutWordCloud(toCloudWords(picked), { width, height })
      expect(r.placed.length, `${String(width)}px 宽只落位 ${String(r.placed.length)} 个词`).toBeGreaterThan(20)
      expect(r.dropped / picked.length, `${String(width)}px 宽丢了 ${String(r.dropped)}/${String(picked.length)}`).toBeLessThan(0.5)
      for (const p of r.placed) {
        expect(p.x, `${p.text} 越过左边界`).toBeGreaterThanOrEqual(0)
        expect(p.y, `${p.text} 越过上边界`).toBeGreaterThanOrEqual(0)
        expect(p.x + p.width, `${p.text} 越过右边界`).toBeLessThanOrEqual(width + 1)
        expect(p.y + p.height, `${p.text} 越过下边界（舞台高度与布局高度不同源时会看不见）`).toBeLessThanOrEqual(height + 1)
      }
    }
  })
})

describe('宽度估算：不测 DOM 也能算（SSR / Node 可用）', () => {  it('中文比英文宽，且随字号线性变化', () => {
    expect(estimateTextWidth('中文词', 20)).toBeGreaterThan(estimateTextWidth('abc', 20))
    expect(estimateTextWidth('中文词', 40)).toBeGreaterThan(estimateTextWidth('中文词', 20) * 1.9)
    expect(estimateTextWidth('', 20)).toBe(0)
  })

  it('宽度随字数增长，且留了余量（重叠比留白糟）', () => {
    // 三个汉字在 20px 下不可能只有 60px 宽（1em/字 = 60px），估算必须 ≥ 它
    expect(estimateTextWidth('三个字', 20)).toBeGreaterThanOrEqual(60)
  })
})

describe('色阶：六阶都在用，且同尺寸的相邻词会换色', () => {
  it('cloudTone 只返回合法色阶；同档第 4 个词换到下一色', () => {
    for (let step = 0; step < CLOUD_FONT_STEPS.length; step += 1) {
      for (let i = 0; i < 12; i += 1) {
        expect(CLOUD_TONES).toContain(cloudTone(step, i))
      }
    }
    const a = cloudTone(3, 2)
    const b = cloudTone(3, 3)
    expect(b, '同档相邻词必须换色，否则密集区糊成一条同色带').not.toBe(a)
  })

  it('越界的档位不抛错（夹到端点）', () => {
    expect(CLOUD_TONES).toContain(cloudTone(-5, 0))
    expect(CLOUD_TONES).toContain(cloudTone(99, 1))
  })
})

describe('撒点：不重叠 / 不出界 / 确定性 / 大词居中', () => {
  const words = makeWords(60)
  const result = layoutWordCloud(words, STAGE)

  it('每个词都完整落在画布内（含 6px 内边距）', () => {
    expect(result.placed.length).toBeGreaterThan(40)
    for (const p of result.placed) {
      expect(p.x, `${p.text} 越出左边界`).toBeGreaterThanOrEqual(6)
      expect(p.y, `${p.text} 越出上边界`).toBeGreaterThanOrEqual(6)
      expect(p.x + p.width, `${p.text} 越出右边界`).toBeLessThanOrEqual(STAGE.width - 6)
      expect(p.y + p.height, `${p.text} 越出下边界`).toBeLessThanOrEqual(STAGE.height - 6)
    }
  })

  it('任意两个词都不重叠（含 4px 间距）', () => {
    result.placed.forEach((p, i) => {
      const others = result.placed.filter((_, j) => j !== i)
      expect(boxesDisjoint(p, others, 4), `${p.text} 与别的词叠在一起`).toBe(true)
    })
  })

  it('确定性：同一份输入两次布局逐字段相同（没有随机数）', () => {
    expect(layoutWordCloud(words, STAGE)).toEqual(result)
  })

  it('词表已降序时，最大的词落在画布中带（词云的视觉核心）', () => {
    // 2026-09-30 加"铺满"两步（等比放大 + 位置微调）之后，词会离开精确中心；
    // 判据改成**纵向中带**：最大的词仍在中间，而不是被推到上下边缘去。
    const first = result.placed[0]!
    const cyFirst = first.y + first.height / 2
    expect(Math.abs(cyFirst - STAGE.height / 2), '最大的词被推到边上了').toBeLessThan(STAGE.height * 0.3)
    expect(first.size, '首个词的尺寸应当是最大的一档').toBe(Math.max(...result.placed.map((p) => p.size)))
  })

  it('铺满：整团要占满画布（四周不留大片空白）', () => {
    // 「铺满」是 2026-09-30 用户明确要的（「周围也铺满，不要留有空白」）。
    // 词数用**卡片真实会请求的那个数**（`cloudLimitForWidth`），否则测的是一个不存在的场景。
    // 判据用**外接框占可用区的比例**：两条轴都要 ≥ 82%，否则就是中间一坨、四周空。
    for (const width of [700, 900, 1160, 1600]) {
      const height = cloudStageHeight(width)
      const r = layoutWordCloud(makeWords(cloudLimitForWidth(width)), { width, height })
      const spanX = Math.max(...r.placed.map((p) => p.x + p.width)) - Math.min(...r.placed.map((p) => p.x))
      const spanY = Math.max(...r.placed.map((p) => p.y + p.height)) - Math.min(...r.placed.map((p) => p.y))
      expect(spanX / (width - 12), `宽 ${String(width)}：横向只占 ${String(Math.round((spanX / (width - 12)) * 100))}%`)
        .toBeGreaterThan(0.82)
      expect(spanY / (height - 12), `宽 ${String(width)}：纵向只占 ${String(Math.round((spanY / (height - 12)) * 100))}%`)
        .toBeGreaterThan(0.82)
      expect(r.dropped, `宽 ${String(width)}：按真实词数请求时不该丢词`).toBeLessThanOrEqual(2)
    }
  })

  it('整体水平居中：拉不满时余量两边平分（全屏下不许贴左）', () => {
    // 2026-09-30 用户报「全屏状态下没有整体水平居中」：宽画布下拉开倍数被 SPREAD_CAP 截住，
    // 若把外接框左边缘钉在 pad 上，整团就贴在左边。判据：左右余量之差 ≤ 2px。
    for (const width of [1600, 2354]) {
      const height = cloudStageHeight(width)
      const r = layoutWordCloud(makeWords(cloudLimitForWidth(width)), { width, height })
      const left = Math.min(...r.placed.map((p) => p.x))
      const right = width - Math.max(...r.placed.map((p) => p.x + p.width))
      expect(Math.abs(left - right), `宽 ${String(width)}：左余 ${String(left)} / 右余 ${String(right)}`)
        .toBeLessThanOrEqual(2)
      const top = Math.min(...r.placed.map((p) => p.y))
      const bottom = height - Math.max(...r.placed.map((p) => p.y + p.height))
      expect(Math.abs(top - bottom), `宽 ${String(width)}：上余 ${String(top)} / 下余 ${String(bottom)}`)
        .toBeLessThanOrEqual(2)
    }
  })

  it('画布太小：**绝不重叠**（能缩就放下，缩不下的才计入 dropped）', () => {
    // 2026-09-30：小舞台改成"等比缩放 + 9px 下限"后，原本放不下的词现在能缩着放下 ⇒ dropped 可以为 0。
    // 真正的硬约束始终是：**放下的词不重叠、不出界**；放不下的必须计入 dropped（不许静默丢弃）。
    const words = Array.from({ length: 20 }, (_, i) => ({
      text: '词' + String(i), count: 20 - i, size: CLOUD_FONT_STEPS[i % CLOUD_FONT_STEPS.length]!, tone: 'mid' as const,
    }))
    const r = layoutWordCloud(words, { width: 160, height: 120 })
    expect(r.placed.length + r.dropped).toBe(words.length)
    for (const w of r.placed) {
      expect(w.x).toBeGreaterThanOrEqual(0)
      expect(w.y).toBeGreaterThanOrEqual(0)
      expect(w.x + w.width).toBeLessThanOrEqual(160 + 1)
      expect(w.y + w.height).toBeLessThanOrEqual(120 + 1)
    }
    for (let i = 0; i < r.placed.length; i++) {
      for (let j = i + 1; j < r.placed.length; j++) {
        const a = r.placed[i]!
        const b = r.placed[j]!
        const overlap = a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
        expect(overlap, `词重叠：${a.text} / ${b.text}`).toBe(false)
      }
    }
  })

  it('词数拉到上界（200）也不重叠，且丢弃比例 < 10%', () => {
    // limit 允许到 200（见卡片的 Math.min(Math.max(1, limit ?? 60), 200)）——
    // 词越多越难塞，这里钉住「不会因为塞不下而丢掉一大片」。
    // 实测（本文件「诊断输出」每次都会打印）：60 词丢 0 / 120 词丢 0 / 200 词丢 11、42ms。
    const many = makeWords(200)
    const r = layoutWordCloud(many, { width: 1160, height: 360 })
    expect(r.placed.length / many.length, `丢了 ${String(r.dropped)}/200，太多了`).toBeGreaterThan(0.9)
    r.placed.forEach((p, i) => {
      expect(boxesDisjoint(p, r.placed.filter((_, j) => j !== i), 4)).toBe(true)
    })
  })

  it('竖排词把宽高对调（沿用的是同一个盒模型）', () => {
    // 画布又窄又高、词又是长词时，横排放不下 ⇒ 必须真的出现竖排（否则这轮回落等于没实现）
    const long = makeWords(30).map((w) => ({ ...w, text: `${w.text}很长很长` }))
    const tall = layoutWordCloud(long, { width: 220, height: 420 })
    const verticals = tall.placed.filter((p) => p.vertical)
    expect(verticals.length, '窄画布 + 长词一个竖排都没排出来，回落逻辑没生效').toBeGreaterThan(0)
    for (const p of verticals) expect(p.height).toBeGreaterThan(p.width)
    expect(tall.placed.every((p) => p.width > 0 && p.height > 0)).toBe(true)
  })
})

describe('画布高度', () => {
  it('随宽度增长（比 16:9 更扁）并夹在 [200, 420]', () => {
    expect(cloudStageHeight(200)).toBe(200)
    expect(cloudStageHeight(600)).toBe(204)
    expect(cloudStageHeight(1160)).toBe(394)
    expect(cloudStageHeight(1600)).toBe(420)
    expect(cloudStageHeight(4000)).toBe(420)
  })
})

describe('词数跟着画布尺寸走（固定词数会一边丢词、一边留白）', () => {
  it('常见宽度换算出来的词数（与实测吻合：这块画布装得下这么多）', () => {
    expect(cloudLimitForWidth(700)).toBe(72)
    expect(cloudLimitForWidth(900)).toBe(93)
    expect(cloudLimitForWidth(1160)).toBe(120)
    expect(cloudLimitForWidth(1600)).toBe(165)
    expect(cloudLimitForWidth(2354)).toBe(243) // 全屏
  })

  /**
   * 夹取范围：上限 400（后端硬上界），下限**只给退化画布兜底**。
   *
   * ⚠️ 2026-10-12 由 60 下调到 24。那个 60 是「所有词都 9~12px」的年代定的
   * （词小 ⇒ 少给几个也铺得满）；字号修对之后，60 在 420×200 上会丢 25/60 ——
   * 请求数比容量还大等于白请求（丢掉的那部分正是用户看到的「内容少」）。
   */
  it('夹在 [24, 400]：再窄也不至于请求超过容量、再宽也不超过后端上界', () => {
    expect(cloudLimitForWidth(100)).toBe(24)
    expect(cloudLimitForWidth(4000)).toBe(400)
    expect(cloudLimitForWidth(0)).toBe(120) // 还没量到宽度 ⇒ 默认值
    expect(cloudLimitForWidth(-5, 80)).toBe(80) // 量不到时用传入的 fallback
    expect(cloudLimitForWidth(5000, 300)).toBe(400) // 宽度够大时按宽度算，fallback 让位
    expect(cloudLimitForWidth(5000, 9999)).toBe(400) // fallback 也要夹住
  })

  /**
   * **面积那一道**（2026-10-12 补）：宽度只看一维，极窄画布上会超订。
   *
   * 实测（词长按真实数据取 2/3/4 字混合）：420×200 按宽度要 60 个、只装得下 35；
   * 520×200 要 60、装 45 —— 丢掉的 20~25 个正是「这个板块的内容太少了」的第二重来源。
   * 现在 `cloudLimitForStage` 取「宽度换算」与「面积换算（/2300）」的**较小值**，
   * 而 700px 以上与既有校准值**逐个相同**（下面的断言就是钉这一点）。
   */
  it('面积那一道只压极窄画布，宽画布不许被它改动', () => {
    expect(cloudLimitForStage(420, 200)).toBe(37)
    expect(cloudLimitForStage(520, 200)).toBe(45)
    // 700px 起与「只按宽度」逐个一致（校准值不许漂）
    for (const width of [700, 900, 1160, 1600, 2354]) {
      const height = cloudStageHeight(width)
      expect(cloudLimitForStage(width, height), `${String(width)}px 上面积那一道把词数改掉了`)
        .toBe(cloudLimitForWidth(width))
    }
    // 量不到尺寸时仍然只用 fallback（别拿 0 去算面积）
    expect(cloudLimitForStage(0, 0)).toBe(120)
    expect(cloudLimitForStage(1160, 0, 60)).toBe(60)
  })
})

/**
 * 诊断：把布局打成一张 ASCII 缩略图。
 *
 * 几何断言只能证明「不重叠、不出界」，证明不了「看起来像不像词云」—— 而形状恰恰是这次
 * 重做的目的。本环境没有浏览器、没法截图，所以把盒子按尺寸符号画出来人工复核一眼：
 * 应当**中间密（大符号）、四周稀（小符号）**，看起来像一团，而不是几行等高的字。
 * 这一条不断言形状（那不是机器能判的），只保证打印不抛错。
 */
describe('诊断输出', () => {
  it('打印一幅 ASCII 缩略图（人工复核形状：中心密、四周稀）', () => {
    // 覆盖率的对照：同一画布下词越多越满 —— 这是"铺满"的真正变量（不是把位置拉开）。
    // 词数取真实值（`cloudLimitForWidth`），另放一个"同样宽度但只给 60 词"作对照。
    const cases: Array<[number, number]> = [
      [cloudLimitForWidth(700), 700],
      [cloudLimitForWidth(1160), 1160],
      [cloudLimitForWidth(1600), 1600],
      [cloudLimitForWidth(2354), 2354],
      [60, 1160],
    ]
    for (const [n, width] of cases) {
      const r = layoutWordCloud(makeWords(n), { width, height: cloudStageHeight(width) })
      const grid: string[][] = Array.from({ length: 20 }, () => Array.from({ length: 96 }, () => ' '))
      const symbol = (size: number): string => (size >= 30 ? '#' : size >= 25 ? 'O' : size >= 21 ? '+' : size >= 16 ? ':' : '.')
      for (const p of r.placed) {
        const c0 = Math.max(0, Math.floor((p.x / r.width) * 96))
        const c1 = Math.min(95, Math.floor(((p.x + p.width) / r.width) * 96))
        const r0 = Math.max(0, Math.floor((p.y / r.height) * 20))
        const r1 = Math.min(19, Math.floor(((p.y + p.height) / r.height) * 20))
        for (let y = r0; y <= r1; y += 1) for (let x = c0; x <= c1; x += 1) grid[y]![x] = symbol(p.size)
      }
      const filled = grid.flat().filter((c) => c !== ' ').length
      console.log(`[词云|布局] n=${String(n)} width=${String(width)} ⇒ ${String(r.placed.length)} 词 / 丢 ${String(r.dropped)}；缩略覆盖 ${String(filled)}/1920`)
      for (const row of grid) console.log(`[词云|布局] |${row.join('')}|`)
      expect(r.placed.length).toBeGreaterThan(0)
    }
  })
})
