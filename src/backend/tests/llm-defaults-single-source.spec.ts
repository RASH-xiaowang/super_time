/**
 * LLM 默认值只允许有一个来源：`src/shared/llm-defaults.json`。
 *
 * 原先同一组默认地址、接口路径与超时被后端存储、宿主桥、前端无桥回退、探针分别抄了
 * 多份。任何一侧单独改值，其它链路仍会继续用旧值，且现有行为测试不会红 —— 只有把
 * 「有没有又在别处硬编码」钉成源码守卫，这份漂移才会在提交前被抓到。
 *
 * @vitest-environment node
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..', '..')

const DEFAULTS = JSON.parse(
  readFileSync(join(ROOT, 'src', 'shared', 'llm-defaults.json'), 'utf8'),
) as Record<string, unknown>

function read(...parts: string[]): string {
  return readFileSync(join(ROOT, ...parts), 'utf8')
}

/** 取 CJS 文件里某个顶层函数体（同一份脚本里用来做不依赖 tsc 的源码判据）。 */
function functionBody(src: string, name: string): string {
  const start = src.indexOf(`function ${name}(`)
  if (start < 0) throw new Error(`${name} 没找到`)
  // 参数里可能有 `= {}` 默认值，所以函数体从右括号之后找，而不是从声明后的第一个 `{` 找。
  const open = src.indexOf('{', src.indexOf(')', start) + 1)
  let depth = 0
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1
    if (src[i] === '}') {
      depth -= 1
      if (depth === 0) return src.slice(open, i + 1)
    }
  }
  throw new Error(`${name} 的大括号没配平`)
}

describe('LLM 默认值的唯一来源', () => {
  it('共享 JSON 里字段完整，且后端 defaultLlmConfig 只展开这份 JSON', () => {
    const keys = [
      'provider', 'model', 'apiKey', 'apiUrl', 'apiPath', 'embeddingModel',
      'embedPath', 'embeddingApiUrl', 'embeddingApiKey', 'rerankModel',
      'rerankPath', 'rerankApiUrl', 'rerankApiKey', 'rerankTimeoutMs', 'timeoutMs',
    ]
    expect(Object.keys(DEFAULTS).sort()).toEqual([...keys].sort())

    // 实现已于 2026-10-15 迁入 llm-config-store.js；wechat-paths.js 只保留兼容转发。
    const body = functionBody(read('src', 'backend', 'llm-config-store.js'), 'defaultLlmConfig')
    expect(body).toContain('{ ...LLM_DEFAULTS }')
    expect(body).not.toContain('https://api.openai.com/v1')
    expect(body).not.toContain("'/chat/completions'")
    expect(body).not.toContain("'/embeddings'")
    expect(body).not.toContain("'/rerank'")
  })

  it('统一解析函数不再自己写死默认值，宿主桥只做三层输入装配', () => {
    const store = read('src', 'backend', 'llm-config-store.js')
    const at = store.indexOf('const LLM_RESOLVE_FIELDS = [')
    const end = store.indexOf('];', at)
    expect(at, 'LLM_RESOLVE_FIELDS 表没找到').toBeGreaterThanOrEqual(0)
    expect(end, 'LLM_RESOLVE_FIELDS 表没有收尾').toBeGreaterThan(at)
    const table = store.slice(at, end)
    expect(table).toContain('LLM_DEFAULTS.provider')
    expect(table).toContain('LLM_DEFAULTS.apiUrl')
    expect(table).toContain('LLM_DEFAULTS.apiPath')
    expect(table).toContain('LLM_DEFAULTS.embedPath')
    expect(table).toContain('LLM_DEFAULTS.rerankPath')
    expect(table).toContain('LLM_DEFAULTS.rerankTimeoutMs')
    expect(table).toContain('LLM_DEFAULTS.timeoutMs')
    expect(table).not.toContain('https://api.openai.com/v1')
    expect(table).not.toContain("'/chat/completions'")
    expect(table).not.toContain("'/embeddings'")
    expect(table).not.toContain("'/rerank'")

    const bridgeBody = functionBody(read('src', 'backend', 'llm-bridge.js'), 'llmConfigFromEnv')
    expect(bridgeBody).toContain('resolveLlmConfig(')
    expect(bridgeBody).toContain('wechatPaths.loadLlmConfig()')
    expect(bridgeBody).toContain('process.env')
    expect(bridgeBody).not.toContain('LLM_DEFAULTS.')
  })

  it('前端无桥回退与两类探针路径都读共享默认值', () => {
    const access = read('src', 'client', 'ui-wechat', 'src', 'client', 'pages', 'wechat-data', 'llm-config.ts')
    expect(access).toMatch(/import llmDefaults from ['"].*shared\/llm-defaults\.json['"]/)
    expect(access).toContain('return { ...llmDefaults }')
    expect(access).not.toContain('https://api.openai.com/v1')

    const probe = read('src', 'client', 'ui-wechat', 'src', 'client', 'pages', 'wechat-data', 'panels', 'llm-probe.tsx')
    expect(probe).toContain('llmDefaults.embedPath')
    expect(probe).toContain('llmDefaults.rerankPath')
    expect(probe).not.toContain("|| '/embeddings'")
    expect(probe).not.toContain("|| '/rerank'")

    const balance = read('src', 'backend', 'llm-balance.js')
    expect(balance).toContain('resolveLlmConfig({ env: process.env })')
    expect(balance).toContain('resolved.embedPath')
    expect(balance).toContain('resolved.rerankPath')
    expect(balance).not.toContain('LLM_DEFAULTS.embedPath')
    expect(balance).not.toContain('LLM_DEFAULTS.rerankPath')
  })

  it('示例配置的协议路径与超时与共享默认值一致（厂商地址允许不同）', () => {
    const example = JSON.parse(read('wechat', 'llm.example.json')) as Record<string, unknown>
    expect(example.apiPath).toBe(DEFAULTS.apiPath)
    expect(example.timeoutMs).toBe(DEFAULTS.timeoutMs)
  })

  it('打包白名单与打包冒烟都认共享目录/文件', () => {
    const rules = read('scripts', 'package-content-rules.js')
    expect(rules).toContain("'src/shared/'")

    const smoke = read('scripts', 'packaged-smoke.js')
    expect(smoke).toContain("'/src/shared/llm-defaults.json'")
  })
})
