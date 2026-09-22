/**
 * H11 第四档顺带钉下的一条不变量：**两套向量库共用同一份点积实现**。
 *
 * 为什么值得单独一条守卫（而不只是「顺手抽了个函数」）：`vector-math.ts` 存在的唯一理由就是
 * 「SimHash 64 位粗筛 → 精确余弦」这一套在消息域与知识库域各有一份，而各写一份的后果是
 * **某天只改了一处** —— 表现是某个域的检索质量悄悄下降，不报错、也没有用例能看出来。
 * 点积那一步原先就是各写一份的（`for (…) dot += v[i] * qv[i]`），本轮收口 `noUncheckedIndexedAccess`
 * 时收进了 {@link dotProduct}；没有这条守卫，下一次有人「就地展开更快」就会把它重新复制回去。
 * @vitest-environment node
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { dotProduct } from '../src/query/vector-math.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const src = (rel: string): string => readFileSync(join(HERE, '..', 'src', rel), 'utf8')

describe('vector-math：点积只有一份实现', () => {
  it('长度不等时按短的算（换过 embedding 模型时的旧口径）', () => {
    const a = Float32Array.from([1, 2, 3, 4])
    const b = Float32Array.from([10, 20, 30])
    expect(dotProduct(a, b)).toBe(1 * 10 + 2 * 20 + 3 * 30)
    expect(dotProduct(b, a)).toBe(dotProduct(a, b))
    expect(dotProduct(a, Float32Array.from([]))).toBe(0)
  })

  it('与朴素逐元素实现一致（含 Int8Array × Float32Array 的 SimHash 用法）', () => {
    const v = Float32Array.from([0.5, -0.25, 0.125, 0, 1])
    const p = Int8Array.from([-1, 1, -1, 1, -1])
    let naive = 0
    for (let i = 0; i < v.length; i += 1) naive += (p[i] ?? 0) * (v[i] ?? 0)
    expect(dotProduct(p, v)).toBeCloseTo(naive, 12)
  })

  for (const [label, rel] of [
    ['消息域', 'query/retrieval/embedding.ts'],
    ['知识库域', 'query/kb-vectors.ts'],
  ] as const) {
    it(`${label} 走共享的 dotProduct，不再自己写一层循环`, () => {
      const code = src(rel)
      const imp = code.match(/import\s*\{([\s\S]*?)\}\s*from\s*'[^']*vector-math\.ts'/)
      const names = imp ? (imp[1] ?? '') : ''
      expect(names, `${rel} 没有从 vector-math.ts 引入 dotProduct`).toContain('dotProduct')
      // 手写的稠密点积：`dot += x[i] * y[i]` —— 复制一份就是「只改了一处」的开始。
      expect(code, `${rel} 又把手写的点积循环内联回来了`).not.toMatch(/dot\s*\+=\s*\w+\[\w+\]\s*\*/)
    })
  }

  it('vector-math 自己也只剩这一处 `dot +=`（SimHash 复用它，不另写一份）', () => {
    const code = src('query/vector-math.ts')
    expect((code.match(/dot\s*\+=/g) ?? []).length, '点累加只应出现在 dotProduct 里').toBe(1)
  })
})
