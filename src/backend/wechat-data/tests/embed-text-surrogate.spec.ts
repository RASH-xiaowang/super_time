// @vitest-environment node
/**
 * 送去 embedding 的文本必须可安全序列化（2026-11-20）。
 *
 * ## 守的是一个「让整个构建永远失败」的真机 bug
 *
 * `String.prototype.slice` 按 UTF-16 **码元**截断，emoji 占两个码元（代理对）。
 * 切在中间就留下一个孤立高代理项（`\ud83d`），JSON 里是非法 Unicode 标量，
 * 硅基流动直接回 `HTTP 400 { code: 20015, message: 'The parameter is invalid' }`。
 *
 * 而 `runBuildVectorIndex` 的语义是「任一批失败 ⇒ 阶段一整体抛错 ⇒ 一行都不写」。
 * 真机实测：403,350 条消息里有 **25 行的截断位置正好切断代理对** ——
 * 这 25 行使消息域向量索引**永远建不成**，于是它长期停在 2026-09-15 那份 dim=64 的
 * 旧数据上（同时还报就绪）。
 */
import { describe, expect, it } from 'vitest'
import { truncateForEmbedding } from '../src/query/embed-text.ts'

/** 是否含孤立代理项（外部校验用，不复用实现内部函数）。 */
function hasLoneSurrogate(s: string): boolean {
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i)
    if (c >= 0xd800 && c <= 0xdbff) {
      const n = s.charCodeAt(i + 1)
      if (!(n >= 0xdc00 && n <= 0xdfff)) return true
      i += 1
    } else if (c >= 0xdc00 && c <= 0xdfff) return true
  }
  return false
}

/** 模拟「序列化后送给严格 UTF-8 端点」：孤立代理项会被 JSON 保留为 `\udXXX`。 */
function hasInvalidScalar(s: string): boolean {
  return hasLoneSurrogate(s) || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s)
}

describe('truncateForEmbedding：不切断代理对', () => {
  it('切在 emoji 中间 ⇒ 丢掉那个高代理项（真机那 25 行的形态）', () => {
    // '搭不挑人\n' 5 字 + emoji 占 2 码元；max=6 正好切在 emoji 的中间
    const src = '搭不挑人\n😀继续'
    const out = truncateForEmbedding(src, 6)
    expect(hasInvalidScalar(out), `产出孤立代理项：${JSON.stringify(out)}`).toBe(false)
    expect(out).toBe('搭不挑人\n')
  })

  it('切在正常位置时行为与 slice 一致（不多嘴删字）', () => {
    expect(truncateForEmbedding('abcdef', 4)).toBe('abcd')
    expect(truncateForEmbedding('你好世界', 2)).toBe('你好')
  })

  it('不超长时原样返回（含完整 emoji）', () => {
    const src = '有 emoji 😀 也要完整'
    expect(truncateForEmbedding(src, 200)).toBe(src)
    expect(hasInvalidScalar(truncateForEmbedding(src, 200))).toBe(false)
  })

  it('清掉库里解码出的孤立代理项（即使没触发截断）', () => {
    expect(truncateForEmbedding('前\ud83d后', 200)).toBe('前后')
    expect(truncateForEmbedding('前\udc00后', 200)).toBe('前后')
  })

  it('完整的代理对必须保留（不许把 emoji 当脏数据删掉）', () => {
    const out = truncateForEmbedding('开头😀结尾', 200)
    expect(out).toContain('😀')
  })

  it('真实形态：200 字窗口里含 emoji 且正好切在边界', () => {
    // 198 个汉字 + emoji（2 码元）= 200 码元；max=199 会切断它
    const src = '字'.repeat(198) + '😀' + '尾巴'
    for (const max of [199, 200, 201]) {
      const out = truncateForEmbedding(src, max)
      expect(hasInvalidScalar(out), `max=${String(max)} 产出非法字符`).toBe(false)
    }
  })

  it('max ≤ 0 视为不截断，但仍清孤立代理项', () => {
    expect(truncateForEmbedding('abc', 0)).toBe('abc')
    expect(truncateForEmbedding('a\ud83db', 0)).toBe('ab')
  })
})
