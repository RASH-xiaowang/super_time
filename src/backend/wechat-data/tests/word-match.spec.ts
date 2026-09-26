
/**
 * 词云词频统计（`word-match.ts`）的**行为级等价性对拍**。
 *
 * 为什么必须有这份 spec：2026-09-26 把实体遮罩从「逐条正文 × 全部名字做 includes」换成了
 * Aho-Corasick，性能提升 5 倍（实测 15.3s → 3.0s）。但**源码断言证明不了"换个算法还算得对"**，
 * 所以这里把**旧实现原样复刻成 oracle**（`legacyCountText`），在一批覆盖了边界形态的语料上
 * 逐词对拍 —— 两个实现算出的词表必须**逐项完全相同**。
 *
 * 复刻 oracle 而不是删掉它，是因为这份对拍本身就是「等价性」这个论断的证据：
 * 一旦有人再改匹配器，对拍会立刻告诉他改错了。
 */
import { describe, expect, it } from 'vitest'
import { at } from '../../tests/helpers/strict-index.ts'
import { buildEntityMatcher, countText } from '../src/query/word-match.ts'

/** 停用词表（与 word-match.ts 同口径；oracle 需要它才能算出同样的 bigram）。 */
const STOP_CHARS = new Set('的了是有在不我没很太这那个们就也还又再和与或但而为被把让给跟从到去来上中下里么什谁哪怎是否吧啊哦嗯呀哈嘿嘛呗啦咯呢吗说我你他她它'.split(''))
const STOP_WORDS = new Set([
  '时候', '什么', '可以', '就是', '还是', '但是', '因为', '所以', '如果', '现在',
  '已经', '觉得', '知道', '然后', '这个', '那个', '这么', '那么', '怎么', '这样',
  '那样', '一些', '一下', '一样', '感觉', '其实', '可能', '应该', '不会', '出来',
  '起来', '过去', '回来', '很多', '开始', '最后', '直接', '真的', '好的', '好吧',
  '是的', '对的', '哈哈', '嘿嘿', '呵呵', '东西', '问题', '事情', '地方', '样子',
  '你们', '我们', '他们', '自己', '大家', '老师', '同学', '朋友', '谢谢',
  '没事', '行吧', '不了', '要不', '反正', '肯定', '原来',
])

/**
 * **旧实现的原样复刻**（改动前的 `countText`）：按长度降序遍历全部名字做 `includes`，
 * 命中就 +1 并把全部出现换成空格；随后 bigram 在遮罩后的 `rest` 上跑。
 */
function legacyCountText(text: string, counts: Map<string, number>, names: readonly string[]): void {
  if (!text) return
  let rest = text
  const ordered = [...names].sort((a, b) => b.length - a.length)
  for (const e of ordered) {
    if (rest.includes(e)) {
      counts.set(e, (counts.get(e) ?? 0) + 1)
      rest = rest.split(e).join(' ')
    }
  }
  for (let i = 0; i + 2 <= rest.length; i += 1) {
    const bi = rest.slice(i, i + 2)
    if (!/[\u4e00-\u9fff]{2}/.test(bi)) continue
    if (STOP_WORDS.has(bi)) continue
    if (STOP_CHARS.has(bi[0]!) || STOP_CHARS.has(bi[1]!)) continue
    counts.set(bi, (counts.get(bi) ?? 0) + 1)
  }
}

/** 对拍：同一批语料、同一份名单，两个实现各跑一遍，返回两个词表。 */
function duel(corpus: readonly string[], names: readonly string[]): {
  legacy: Map<string, number>
  ac: Map<string, number>
} {
  const legacy = new Map<string, number>()
  const ac = new Map<string, number>()
  const matcher = buildEntityMatcher(names)
  for (const t of corpus) {
    legacyCountText(t, legacy, names)
    countText(t, ac, matcher)
  }
  return { legacy, ac }
}

/** 断言两个词表逐项相等，失败时打印差异明细。 */
function expectSameWords(a: Map<string, number>, b: Map<string, number>, label: string): void {
  const keys = new Set([...a.keys(), ...b.keys()])
  const diffs: string[] = []
  for (const k of keys) {
    const x = a.get(k) ?? 0
    const y = b.get(k) ?? 0
    if (x !== y) diffs.push(`${k}: 旧=${x} 新=${y}`)
  }
  expect(diffs, `${label}：词表不一致\n${diffs.slice(0, 20).join('\n')}`).toEqual([])
}

const NAMES = ['张三', '李四', '张三丰', '王五王五', 'Alice', '赵六']

describe('等价性：AC 版与旧实现必须算出同一份词表', () => {
  it('① 最基础：一条含人名的正文', () => {
    const { legacy, ac } = duel(['张三说这个项目不错'], NAMES)
    expectSameWords(legacy, ac, '基础')
    expect(ac.get('张三'), '人名要被计入').toBe(1)
    expect(ac.has('张三说'), '人名会被遮罩，不该进 bigram').toBe(false)
  })

  it('② 重叠：长名吃掉短名（「张三丰」遮罩后「张三」不复存在）', () => {
    const { legacy, ac } = duel(['张三丰来了'], NAMES)
    expectSameWords(legacy, ac, '重叠')
    expect(ac.get('张三丰'), '长名优先').toBe(1)
    expect(ac.has('张三'), '短名不该再被计入').toBe(false)
  })

  it('③ 多次出现只 +1（口径是"出现在几条正文里"，不是词频）', () => {
    const { legacy, ac } = duel(['李四李四李四'], NAMES)
    expectSameWords(legacy, ac, '多次出现')
    expect(ac.get('李四')).toBe(1)
  })

  it('④ 跨条累加：两条正文各出现一次 ⇒ 2', () => {
    const { legacy, ac } = duel(['李四在吗', '李四好'], NAMES)
    expectSameWords(legacy, ac, '跨条累加')
    expect(ac.get('李四')).toBe(2)
  })

  it('⑤ 相邻人名：两个名字紧挨着，中间不该生出 bigram', () => {
    const { legacy, ac } = duel(['张三李四'], NAMES)
    expectSameWords(legacy, ac, '相邻人名')
  })

  it('⑥ 相邻人名：两个名字紧挨着，中间不该生出 bigram', () => {
    const { legacy, ac } = duel(['张三李四'], NAMES)
    expectSameWords(legacy, ac, '相邻人名')
  })

  it('⑦ 英文与数字名：Alice 也要能被遮罩', () => {
    const { legacy, ac } = duel(['Alice和赵六一起'], NAMES)
    expectSameWords(legacy, ac, '英文名')
    expect(ac.get('Alice')).toBe(1)
  })

  it('⑧ 无名字的正文：只剩 bigram（遮罩不该影响纯文本统计）', () => {
    const { legacy, ac } = duel(['明天下午三点开会讨论方案'], NAMES)
    expectSameWords(legacy, ac, '无名字')
    expect(ac.get('明天')).toBe(1)
  })

  it('⑨ 停用词与单字虚词照旧被过滤', () => {
    const { legacy, ac } = duel(['这个时候可以的'], NAMES)
    expectSameWords(legacy, ac, '停用词')
    expect(ac.has('时候')).toBe(false)
  })

  it('⑩ 空文本、纯标点、纯数字（都要平静地什么都不做）', () => {
    const { legacy, ac } = duel(['', '   ', '，。！？', '1234567890', '  　  '], NAMES)
    expectSameWords(legacy, ac, '空与标点')
    expect(ac.size, '这批语料不该产出任何词').toBe(0)
  })

  it('⑪ 名字在句首/句尾（遮罩不影响边界外的相邻关系）', () => {
    const { legacy, ac } = duel(['张三明天来吗', '明天的会议李四'], NAMES)
    expectSameWords(legacy, ac, '边界')
  })

  it('⑫ 随机长语料粗筛（含重复字、混合标点、嵌套人名）', () => {
    // 刻意只用 2-3 字的名字：**同一名字在同一文本里重叠出现**是唯一已知的差异点
    // （见下面「已知行为差异」一节），随机语料里避开它才能断言全等。
    const chunks = ['项目', '进度', '张三', '明天', '李四', '方案', '张三丰', '，', '。', '可以']
    const corpus: string[] = []
    let seed = 20260926
    const rnd = (): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648
      return seed / 2147483648
    }
    for (let i = 0; i < 400; i += 1) {
      let s = ''
      const len = 1 + Math.floor(rnd() * 12)
      for (let j = 0; j < len; j += 1) s += at(chunks, Math.floor(rnd() * chunks.length))
      corpus.push(s)
    }
    const { legacy, ac } = duel(corpus, NAMES)
    expectSameWords(legacy, ac, '随机语料')
    expect(ac.size, '防空转：这批语料必须真的产出词').toBeGreaterThan(5)
  })

  it('⑬ 一个人的名字同时是另一个人的前缀（顺序敏感性）', () => {
    const names = ['小明', '小明明', '明明']
    const { legacy, ac } = duel(['小明明昨天来过', '明明没来'], names)
    expectSameWords(legacy, ac, '前缀关系')
  })
})

/**
 * 唯一已知的行为差异：**同一名字在同一文本里重叠出现**时，旧实现会留下残余字符。
 *
 * 旧实现用 `rest.split(e).join(' ')`：`split` 是**从左到右不重叠**匹配，且把每个命中压成
 * **一个**空格（不是等长填充）。于是像 `王五王五王五` 这种（名字 4 字、出现三次 ⇒ 重叠），
 * 只遮掉前 4 个字符，**剩下的 `王五` 会作为普通文本留下**并参与 bigram。
 *
 * 新实现按 AC 的匹配区间整段遮罩，残余不再进入 bigram。两条口径哪个对：
 * 实体保护的本意是「人名**整词**计数、且它的任何部分都不该作为词上榜」—— 残余的 `王五`
 * 本来就是长名的一部分，把它当成一个独立词条反而是旧实现的副作用。所以这里**刻意**
 * 选新行为，并用本用例把它钉住（免得后人以为是 bug 又改回去）。
 *
 * 实测影响面：本机全量 163,650 条正文、2,891 个词的两实现对拍**零差异**
 * （`working/probe-bench2.txt`）—— 真实聊天里人名重叠出现极罕见。此节的用例是人为构造的
 * 边界形态，用来固定这个已知差异。
 */
describe('已知行为差异：重叠出现时不再留下残余字符（刻意）', () => {
  it('旧的会多出一个名字残余词，新的不会', () => {
    const text = '王五王五王五'
    const names = ['王五王五']
    const legacy = new Map<string, number>()
    const ac = new Map<string, number>()
    legacyCountText(text, legacy, names)
    countText(text, ac, buildEntityMatcher(names))
    expect(legacy.get('王五王五'), '两边都把完整名计一次').toBe(1)
    expect(ac.get('王五王五')).toBe(1)
    expect(legacy.has('王五'), '旧实现：split/join 的残余会进 bigram').toBe(true)
    expect(ac.has('王五'), '新实现：残余属于被遮罩区间，不进 bigram').toBe(false)
  })

  it('但「不重叠的多次出现」两边完全一致（这是常态，必须一致）', () => {
    const { legacy, ac } = duel(['王五王五真忙', '王五王五和王五王五'], ['王五王五'])
    expectSameWords(legacy, ac, '不重叠重复')
    expect(ac.get('王五王五')).toBe(2)
  })
})

describe('匹配器的结构性契约', () => {
  it('名字按长度降序存放（遮罩顺序是语义的一部分）', () => {
    const m = buildEntityMatcher(['张三', '张三丰', '欧阳修远', '李四'])
    const lens = m.words.map((w) => w.length)
    expect(lens).toEqual([...lens].sort((a, b) => b - a))
  })

  it('传入的数组不被就地修改（纯函数）', () => {
    const input = ['张三', '张三丰']
    const copy = [...input]
    buildEntityMatcher(input)
    expect(input).toEqual(copy)
  })

  it('out 继承了 fail 链（否则「名字是另一个名字的后缀」会漏检）', () => {
    // 「明明」是「小明明」的后缀：扫到「小明明」结尾时必须同时给出两个模式
    const m = buildEntityMatcher(['小明明', '明明'])
    const counts = new Map<string, number>()
    countText('小明明', counts, m)
    expect(counts.get('小明明'), '长名优先').toBe(1)
    expect(counts.get('明明'), '被长名遮罩 ⇒ 不计').toBeUndefined()
  })

  it('重复调用不串味（hits/touched 必须逐条清空）', () => {
    const m = buildEntityMatcher(['张三'])
    const c = new Map<string, number>()
    countText('张三来', c, m)
    const after = c.get('张三')
    expect(after).toBe(1)
    // 第二条不含任何名字：实体计数必须不变（若 hits 没清空，这里会误 +1）
    countText('李四来', c, m)
    expect(c.get('张三'), '第二条不含名字，实体计数不得变化').toBe(after)
    expect(m.hits.every((h) => h.length === 0), 'hits 必须逐条清空').toBe(true)
    expect(m.touched.length, 'touched 必须逐条清空').toBe(0)
  })

  it('空名单也要能跑（contactMeta 为空时的降级路径）', () => {
    const m = buildEntityMatcher([])
    const c = new Map<string, number>()
    countText('明天开会', c, m)
    expect(c.get('明天')).toBe(1)
  })

  it('跨条复用同一匹配器时长文本不互相污染（covered 容量按需增长）', () => {
    const m = buildEntityMatcher(['张三'])
    const c = new Map<string, number>()
    const long = '张三' + '今天天气很好我们要不要一起出去走走看看风景'.repeat(20)
    countText(long, c, m)
    countText('张三', c, m)
    expect(c.get('张三'), '两条各一次 ⇒ 2').toBe(2)
    expect(c.has('今天'), '第二轮的长文本不能残留影响').toBe(true)
  })
})
