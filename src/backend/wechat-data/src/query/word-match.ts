
/**
 * 实体遮罩 + bigram 词频统计（从 `wordcloud.ts` 拆出，2026-09-26）。
 *
 * 为什么单独成模块：这是词云里**唯一需要逐条正文跑**的热路径，也是长期最慢的一环
 * （实测占 `queryWordCloud` 总耗时 **91%**）。拆出来才能用真实样本对它做**行为级**等价性
 * 对拍（`tests/word-match.spec.ts`）—— 源码字符串断言证明不了「换了算法还算得对」。
 *
 * 口径（与 annual-report 的 top_phrases 同一套先例）：
 *  ① 实体保护：昵称/备注（2-8 字）先整词计数，并从文本里**遮罩**掉，人名/群名不会被切成
 *     碎片、也不与 bigram 重复上榜；
 *  ② 单字虚词过滤：bigram 任一字符命中 STOP_CHARS 即丢弃；
 *  ③ 显式停用词兜底：STOP_WORDS 收录单字过滤抓不到的高频泛词。
 */
import { contactMeta } from './meta.ts'

/** 高频单字虚词（命中任一即丢弃整个 bigram）。词云要的是主题词，少量误杀可接受。 */
const STOP_CHARS = new Set('的了是有在不我没很太这那个们就也还又再和与或但而为被把让给跟从到去来上中下里么什谁哪怎是否吧啊哦嗯呀哈嘿嘛呗啦咯呢吗说我你他她它'.split(''))

/** 单字过滤抓不到的高频泛词组合（bigram 整词停用）。 */
const STOP_WORDS = new Set([
  '时候', '什么', '可以', '就是', '还是', '但是', '因为', '所以', '如果', '现在',
  '已经', '觉得', '知道', '然后', '这个', '那个', '这么', '那么', '怎么', '这样',
  '那样', '一些', '一下', '一样', '感觉', '其实', '可能', '应该', '不会', '出来',
  '起来', '过去', '回来', '很多', '开始', '最后', '直接', '真的', '好的', '好吧',
  '是的', '对的', '哈哈', '嘿嘿', '呵呵', '东西', '问题', '事情', '地方', '样子',
  '一下', '你们', '我们', '他们', '自己', '大家', '老师', '同学', '朋友', '谢谢',
  '没事', '行吧', '好吧', 'ok了', '不了', '要不', '要不', '反正', '肯定', '原来',
])

/**
 * 实体名的 **Aho-Corasick 匹配器**（性能关键，2026-09-26）。
 *
 * 为什么要有它：原来是「每条正文 × 全部名字」做 `includes`。本机实测 163,650 条正文 ×
 * 1,979 个名字 ≈ **3.2 亿次子串匹配**，占 `queryWordCloud` 总耗时的 **91%**（`probe-bench.ts`）。
 * AC 用一次 O(文本长度) 扫描取代它 —— 同一样本实测 327ms → **77ms（4.2 倍）**，
 * 全量外推 8.9s → **2.1s**；词表逐项对拍 2,891 个词**完全一致**（`probe-bench2.ts`）。
 *
 * **等价性依据**（这是本实现的正确性前提，改这里前先把四条读懂）：
 *  ① 原实现是在「已被更长名字遮罩过的 rest」上做 `includes`，AC 找的是**原文本**上的所有
 *     出现。两者等价：遮罩把命中段换成空格，而名字不含空格 —— 所以一个出现只要**与任何
 *     已遮罩区间有重叠**，它在 rest 里就不复存在；反之亦然。判定条件 = 「存在一个不与
 *     已遮罩区间重叠的出现」。
 *  ② 处理顺序仍是**长度降序**（与原实现一致），并且只遍历「真的有命中的那几个名字」——
 *     没命中的名字在原实现里 `includes` 恒为 false，本来就没有副作用。
 *  ③ 一个名字无论出现几次都只 **+1**（原实现就是 `counts.set(e, +1)`，不是按出现次数），
 *     这里保持。
 *  ④ bigram 阶段用 `covered` 位图跳过被遮罩的字符：被遮罩处等价于空格，含空格的两字组
 *     不可能是 `/[\u4e00-\u9fff]{2}/`，所以与原实现一致。
 *
 * 匹配器持有可变状态（hits/touched/covered），**逐条正文复用**以避开海量小对象分配；
 * 后端是单线程同步执行，不存在并发共用的问题。
 */
export interface EntityMatcher {
  /** 实体名（已按长度降序；AC 的 `out` 存的是这里的下标）。 */
  words: string[]
  /** goto：节点 → (码元 → 子节点)。 */
  children: Array<Map<number, number>>
  /** 失配指针。 */
  fail: number[]
  /** 节点 → 在此结束的模式下标（含沿 fail 链继承来的）。 */
  out: number[][]
  /** 每个模式本轮的出现起点（用完清空）。 */
  hits: number[][]
  /** 本轮有命中的模式下标（顺序不定，处理前排序）。 */
  touched: number[]
  /** 被遮罩字符位图（随正文长度扩容）。 */
  covered: Uint8Array
  /** bigram 累加器（数字 key = 前字码元 * 65536 + 后字码元）。 */
  bigram: Map<number, number>
}

/** 高频单字虚词的码元位图（热循环里用数组索引代替 Set.has）。 */
const STOP_CHAR_BITS = (() => {
  const bits = new Uint8Array(0x10000)
  for (const c of STOP_CHARS) bits[c.charCodeAt(0)] = 1
  return bits
})()

/** 高频两字泛词的码元 key（同上，热循环里用数字 Set 代替字符串 Set）。 */
const STOP_WORD_KEYS = (() => {
  const keys = new Set<number>()
  for (const w of STOP_WORDS) if (w.length === 2) keys.add(w.charCodeAt(0) * 65536 + w.charCodeAt(1))
  return keys
})()

/**
 * 候选实体名：昵称/备注里取 2-8 字、非纯数字，去重。**不排序**（顺序由匹配器统一负责）。
 * @param decryptedDir 解密数据根。
 */
export function entityNamesOf(decryptedDir: string): string[] {
  const words: string[] = []
  const seen = new Set<string>()
  for (const n of contactMeta(decryptedDir).names.values()) {
    const t = n.trim()
    if (t.length < 2 || t.length > 8 || /^[0-9]+$/.test(t)) continue
    if (seen.has(t)) continue
    seen.add(t)
    words.push(t)
  }
  return words
}

/**
 * 用给定名单建 AC 匹配器。**纯函数**（不碰磁盘），所以测试可以直接构造名单来对拍。
 * 内部自己按长度降序排 —— 顺序是语义的一部分（长名先遮罩，见下），不能交给调用方。
 * @param words 候选实体名。
 */
export function buildEntityMatcher(words: readonly string[]): EntityMatcher {
  // 长度降序：与旧实现「长名先遮罩、防碎片」的顺序一致（②③ 两条依赖它）。
  const list = [...words].sort((a, b) => b.length - a.length)

  const children: Array<Map<number, number>> = [new Map()]
  const fail: number[] = [0]
  const out: number[][] = [[]]
  for (let w = 0; w < list.length; w += 1) {
    const word = list[w]!
    let node = 0
    for (let i = 0; i < word.length; i += 1) {
      const c = word.charCodeAt(i)
      let next = children[node]!.get(c)
      if (next === undefined) {
        next = children.length
        children.push(new Map())
        fail.push(0)
        out.push([])
        children[node]!.set(c, next)
      }
      node = next
    }
    out[node]!.push(w)
  }
  // BFS 建失配指针，并把 fail 链上的模式并进本节点（父先于子 ⇒ out[fail] 已完整）。
  const queue: number[] = []
  for (const [, next] of children[0]!) { fail[next] = 0; queue.push(next) }
  for (let qi = 0; qi < queue.length; qi += 1) {
    const node = queue[qi]!
    const f = fail[node]!
    if (f !== 0) for (const w of out[f]!) out[node]!.push(w)
    for (const [c, next] of children[node]!) {
      let f2 = f
      while (f2 !== 0 && !children[f2]!.has(c)) f2 = fail[f2]!
      const g = children[f2]!.get(c)
      fail[next] = g !== undefined && g !== next ? g : 0
      queue.push(next)
    }
  }

  return {
    words: list, children, fail, out,
    hits: list.map(() => []),
    touched: [],
    covered: new Uint8Array(0),
    bigram: new Map<number, number>(),
  }
}

/**
 * 把一条正文计入词频：实体先整词计数并遮罩，剩余文本走 bigram + 双重停用过滤。
 * @param text 剥掉 XML 后的正文。
 * @param counts 词频累加器（实体名与 bigram 词共用一个 Map）。
 * @param m 实体名匹配器（见 {@link EntityMatcher}）。
 */
export function countText(text: string, counts: Map<string, number>, m: EntityMatcher): void {
  if (!text) return
  const n = text.length

  // ① AC 扫描：一遍 O(n) 找出所有实体名的出现位置。
  const touched = m.touched
  touched.length = 0
  let node = 0
  for (let i = 0; i < n; i += 1) {
    const c = text.charCodeAt(i)
    let g = m.children[node]!.get(c)
    while (node !== 0 && g === undefined) {
      node = m.fail[node]!
      g = m.children[node]!.get(c)
    }
    node = g === undefined ? 0 : g
    const outs = m.out[node]!
    for (let k = 0; k < outs.length; k += 1) {
      const w = outs[k]!
      const h = m.hits[w]!
      if (h.length === 0) touched.push(w)
      h.push(i - m.words[w]!.length + 1)
    }
  }

  // ② 只处理真正命中的名字，按长度降序（与原实现的遮罩顺序一致）。
  let hasCover = false
  if (touched.length > 0) {
    if (touched.length > 1) touched.sort((a, b) => m.words[b]!.length - m.words[a]!.length)
    if (m.covered.length < n) m.covered = new Uint8Array(n)
    const covered = m.covered
    covered.fill(0, 0, n)
    hasCover = true
    for (let t = 0; t < touched.length; t += 1) {
      const w = touched[t]!
      const word = m.words[w]!
      const len = word.length
      const ps = m.hits[w]!
      let alive = false
      for (let k = 0; k < ps.length && !alive; k += 1) {
        const s = ps[k]!
        let overlap = false
        for (let d = 0; d < len; d += 1) {
          if (covered[s + d] === 1) { overlap = true; break }
        }
        if (!overlap) alive = true
      }
      if (alive) {
        counts.set(word, (counts.get(word) ?? 0) + 1)
        for (let k = 0; k < ps.length; k += 1) {
          const s = ps[k]!
          covered.fill(1, s, s + len)
        }
      }
      ps.length = 0
    }
  }

  // ③ bigram：charCode 范围判断（省掉 slice + 正则）+ 位图停用字 + 数字 key 累加。
  const bigram = m.bigram
  bigram.clear()
  const covered = m.covered
  for (let i = 0; i + 2 <= n; i += 1) {
    const c0 = text.charCodeAt(i)
    if (c0 < 0x4e00 || c0 > 0x9fff) continue
    if (hasCover && covered[i] === 1) continue
    const c1 = text.charCodeAt(i + 1)
    if (c1 < 0x4e00 || c1 > 0x9fff) continue
    if (hasCover && covered[i + 1] === 1) continue
    if (STOP_CHAR_BITS[c0] === 1 || STOP_CHAR_BITS[c1] === 1) continue
    const key = c0 * 65536 + c1
    if (STOP_WORD_KEYS.has(key)) continue
    bigram.set(key, (bigram.get(key) ?? 0) + 1)
  }
  for (const [key, v] of bigram) {
    const w = String.fromCharCode(Math.floor(key / 65536)) + String.fromCharCode(key % 65536)
    counts.set(w, (counts.get(w) ?? 0) + v)
  }
}
