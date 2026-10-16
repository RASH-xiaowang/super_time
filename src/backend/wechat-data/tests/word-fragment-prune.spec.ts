/**
 * 词表碎片剪枝（`pruneFragmentWords`）的行为判据 —— 2026-09-30 用户反馈
 * 「有些词的意思都不对，截错了，不是真正的词语」之后补的。
 *
 * 为什么值得一份 spec：这条判据是**相对**的（比的是同一份语料里自己的邻居），
 * 它的两类失败方向都不会报错、只会让界面变差：
 *   · 剪得太狠 —— 真词（客户 / 任务 / 记录 / 车架）被当成碎片删掉，词云变得又稀又偏；
 *   · 剪得太松 —— 「别最」「建任」这类念不出来的切片继续上榜（这正是用户截图里的问题）。
 * 所以每个用例都成对写：**该删的删掉 + 不该删的一个都不许动**。
 *
 * 语料是按真实形态**构造**的（本机没有解密库：`%APPDATA%\Super Time\wechat-data` 里
 * 只有两个无关的 db）。判据本身不含需要标定的常数（纯比较），所以构造语料足以验证
 * 「逻辑对不对」；「在真实聊天里删得够不够」要到有数据的机器上复核（见最后一节）。
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import { buildEntityMatcher, countText, pruneFragmentWords } from '../src/query/word-match.ts'

/** 跑一遍统计，返回剪枝前后的词表（剪枝就地改写 counts，所以留一份 before）。 */
function scan(corpus: readonly string[], names: readonly string[] = []): {
  counts: Map<string, number>
  before: Map<string, number>
  result: ReturnType<typeof pruneFragmentWords>
} {
  const matcher = buildEntityMatcher(names)
  const counts = new Map<string, number>()
  for (const t of corpus) countText(t, counts, matcher)
  const before = new Map(counts)
  const result = pruneFragmentWords(counts, matcher)
  return { counts, before, result }
}

/** 造语料：`times` 条同短语（同一搭配反复出现才谈得上"高频"）。 */
function repeat(phrase: string, times: number): string[] {
  return Array.from({ length: times }, () => phrase)
}

describe('夹心碎片必须被剪掉（用户截图里那类词）', () => {
  it('`级别最高`：别最 两侧都不弱于它 ⇒ 删；级别 / 最高 ⇒ 留', () => {
    const { counts } = scan([
      ...repeat('级别最高', 40),
      ...repeat('级别很高', 25),
      ...repeat('最高标准', 30),
    ])
    expect(counts.has('别最'), '「别最」是 级别+最高 的中间切片').toBe(false)
    expect(counts.get('级别'), '级别 = 40 + 25（两条短语都含它）').toBe(65)
    expect(counts.get('最高'), '最高 = 40 + 30').toBe(70)
  })

  it('`创建任务`：建任 删；创建 / 任务 留', () => {
    const { counts } = scan([
      ...repeat('创建任务', 30),
      ...repeat('已创建', 20),
      ...repeat('任务完成', 25),
    ])
    expect(counts.has('建任')).toBe(false)
    expect(counts.get('创建')).toBe(50)
    expect(counts.get('任务')).toBe(55)
  })

  it('`车型名称`：型名 删；车型 / 名称 留', () => {
    const { counts } = scan([
      ...repeat('车型名称', 20),
      ...repeat('车型很多', 15),
      ...repeat('名称填写', 18),
    ])
    expect(counts.has('型名')).toBe(false)
    expect(counts.get('车型')).toBe(35)
    expect(counts.get('名称')).toBe(38)
  })

  it('`创建记录`：中间的 建记 删，而**末端的 记录 必须留**（右侧无延续）', () => {
    const { counts } = scan([...repeat('创建记录', 20), ...repeat('已创建', 30)])
    expect(counts.has('建记'), '建记 是夹心切片').toBe(false)
    expect(counts.get('记录'), '记录 只在末端 ⇒ 不能被误杀').toBe(20)
    expect(counts.get('创建')).toBe(50)
  })

  it('混合语料（四条短语各来几十遍）：切片一律不许留，真词一个不许少', () => {
    const corpus = [
      ...repeat('级别最高', 40), ...repeat('创建任务', 30), ...repeat('车型名称', 20),
      ...repeat('评估价格', 35), ...repeat('客户信息', 30), ...repeat('车辆信息', 28),
      ...repeat('车牌号码', 22), ...repeat('预审通过', 26), ...repeat('融资方案', 24),
    ]
    const { counts } = scan(corpus)
    for (const junk of ['别最', '建任', '型名', '牌号', '审通', '估结', '牌日']) {
      expect(counts.has(junk), `切片「${junk}」还在词表里`).toBe(false)
    }
    for (const real of ['级别', '最高', '创建', '任务', '车型', '名称', '评估', '价格', '客户', '信息', '车辆', '预审', '融资', '方案']) {
      expect(counts.has(real), `真词「${real}」被误删了`).toBe(true)
    }
  })
})

describe('不许剪过头：真词只要有一侧"独立"就必须留住', () => {
  it('`客户`：左侧有不弱于它的「级客」，但右侧几乎不延续 ⇒ 留', () => {
    const { counts } = scan([
      ...repeat('高级客户', 40),
      ...repeat('客户经理', 30),
      ...repeat('顾客满意', 20),
    ])
    expect(counts.get('客户'), '客户 是真词').toBe(70)
    expect(counts.has('级客'), '级客 是 高级+客户 的切片 ⇒ 该删').toBe(false)
  })

  it('`车架` 与 `架号` 互为邻居、谁也不弱于谁 ⇒ 两个都留（3 字词被切两段，本条判据管不了）', () => {
    const { counts } = scan([...repeat('车架', 40), ...repeat('架号', 38), ...repeat('车辆', 30)])
    expect(counts.has('车架')).toBe(true)
    expect(counts.has('架号')).toBe(true)
  })

  it('`任务`：两侧邻居（责任 / 务必）都不比它强 ⇒ 留', () => {
    const { counts } = scan([...repeat('任务', 60), ...repeat('责任', 30), ...repeat('务必完成', 20)])
    expect(counts.get('任务')).toBe(60)
  })

  it('孤立的高频两字词（两侧都没有延续）一律留', () => {
    const { counts } = scan([...repeat('评估', 50)])
    expect(counts.get('评估')).toBe(50)
  })

  it('实体名即使是"局部极小"也不许删（它们不走二元组那条路）', () => {
    const { counts } = scan([...repeat('汽车商人', 60), ...repeat('商人很多', 40)], ['车商'])
    expect(counts.get('车商'), '实体名必须原样保留').toBe(60)
    // ①「汽车商人」里的 `车商` 被遮罩 ⇒ `汽车` 那个二元组跨到遮罩区，不该被计入（遮罩的本意）；
    // ②「商人很多」里的 `商人` 没被遮罩 ⇒ 照常统计，且剪枝不许动它。
    expect(counts.has('汽车'), '跨进遮罩区的二元组不算').toBe(false)
    expect(counts.get('商人'), '非实体的两字组照常统计').toBe(40)
  })

  it('ratio 收紧后删得更多（默认 1 最保守；门槛可调）', () => {
    const corpus = [...repeat('任务', 60), ...repeat('责任', 30), ...repeat('务必完成', 20)]
    const matcher = buildEntityMatcher([])
    const counts = new Map<string, number>()
    for (const t of corpus) countText(t, counts, matcher)
    expect(counts.has('任务')).toBe(true)
    // ratio=3：要求比两侧邻居强 3 倍才留 ⇒ 60 <= 责任(30)*3 且 60 <= 务完(20)*3 ⇒ 收掉
    pruneFragmentWords(counts, matcher, { ratio: 3 })
    expect(counts.has('任务'), 'ratio=3 时被收掉，这就是"收得更紧"').toBe(false)
  })

  it('空词表平静返回（不抛错、不空转）', () => {
    const matcher = buildEntityMatcher([])
    expect(pruneFragmentWords(new Map<string, number>(), matcher))
      .toEqual({ kept: 0, dropped: 0, droppedWords: [] })
  })
})

/**
 * 已知抓不到的形态（2026-09-30 如实登记，别当成"已经干净了"）。
 *
 * 这条判据用「两侧邻接二元组的强度」判断夹心，因此**单侧粘连**抓不到：`您创` 的左侧
 * 根本没有延续（`您` 几乎不出现在别的二元组的第二字位置），`车架号` 更是被切成两个
 * 谁也不弱于谁的两字组。要收干净得上左右邻接熵 / 3-gram 合并，本轮没做。
 * 这里的断言是**钉住现状**：有人改了算法把它们也收掉时，这些用例会红 —— 那时请连同
 * 本注释与 `word-match.ts` 的「已知不足」一起更新，而不是直接删断言。
 */
describe('已知不足：单侧粘连与 3 字词的两段切片（本轮有意留着）', () => {
  it('`您创`（您创建 的前缀切片）仍会留在词表里', () => {
    const { counts } = scan([...repeat('您创建的', 30), ...repeat('创建记录', 20)])
    expect(counts.get('您创'), '左邻为空 ⇒ 按当前判据必须留').toBe(30)
    expect(counts.get('创建')).toBe(50)
  })

  it('`已创`（已创建 的前缀切片）同理', () => {
    const { counts } = scan([...repeat('已创建', 30), ...repeat('创建任务', 20)])
    expect(counts.get('已创')).toBe(30)
  })

  it('`车架号` 会被切成 `车架` + `架号` 两段（都不是夹心）', () => {
    const { counts } = scan([...repeat('车架号', 30)])
    expect(counts.has('车架')).toBe(true)
    expect(counts.has('架号')).toBe(true)
  })
})
