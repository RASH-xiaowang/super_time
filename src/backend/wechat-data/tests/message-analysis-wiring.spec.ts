// @vitest-environment node
/**
 * 消息分析的「模型接线」守卫。
 *
 * 现场缺陷：`createAnalysisRemotes` 需要 `ctx` 才能读「设置里的当前对话模型」，
 * 而 `gateway-analysis-ops.ts` 装配时漏传 ⇒ 面板上直接显示
 * `Cannot read properties of undefined (reading 'agentDefaultModel')`。
 * 这类漏注入在类型层面是合法的（字段可选），所以必须由测试守住。
 *
 * 两层保障：
 *  ① 网关必须把 `() => this._ctx` 传进去（源码形状断言）；
 *  ② 即使拿不到 `ctx`，生成器也只返回一句可展示的原因，绝不抛 TypeError。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createDefaultAnalysisGenerator } from '../src/query/analysis/generator.ts'

const SRC = join(import.meta.dirname, '..', 'src')

describe('网关装配：必须注入 ctx', () => {
  it('gateway-analysis-ops.ts 把 this._ctx 传给 createAnalysisRemotes', () => {
    const code = readFileSync(join(SRC, 'gateway-analysis-ops.ts'), 'utf8')
    expect(code).toMatch(/createAnalysisRemotes\(\{[\s\S]*?ctx:\s*\(\)\s*=>\s*this\._ctx/)
  })

  it('remotes/analysis.ts 的 ctx 字段是可选但被注释说明必需性', () => {
    const code = readFileSync(join(SRC, 'remotes', 'analysis.ts'), 'utf8')
    expect(code).toContain('ctx?: () => Context')
    expect(code).toContain('网关注入时必须是')
  })
})

describe('生成器：拿不到 ctx 时降级而不是崩溃', () => {
  it('ctx 返回 undefined ⇒ ok:false + 可展示原因', async () => {
    const generate = createDefaultAnalysisGenerator({ ctx: () => undefined })
    const result = await generate({
      system: 's',
      prompt: 'p',
      accountKey: 'wxid_self',
      chatUsername: 'wxid_peer',
    })
    expect(result.ok).toBe(false)
    expect(result.error).toBeTruthy()
    // 关键：错误必须是「人话」，不能把 TypeError 的堆栈文案漏给用户。
    expect(result.error).not.toContain('Cannot read properties')
    expect(result.error).not.toContain('undefined')
  })

  it('没有 agentDefaultModel（未配置模型）⇒ 同样返回可展示原因', async () => {
    const generate = createDefaultAnalysisGenerator({ ctx: () => ({}) as never })
    const result = await generate({
      system: 's',
      prompt: 'p',
      accountKey: 'wxid_self',
      chatUsername: 'wxid_peer',
    })
    expect(result.ok).toBe(false)
    expect(result.error).toBe('未配置对话模型')
  })
})
