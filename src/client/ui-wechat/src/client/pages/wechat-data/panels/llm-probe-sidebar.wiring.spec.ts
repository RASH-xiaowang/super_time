/**
 * 「测试连接 / 查询余额」与左下角余额条的接线守卫（2026-09-30）。
 *
 * 为什么值得钉：
 *   · 「左下角余额」是**无人值守的出网点**（5 分钟一次），它必须真的挂在设置按钮下方、
 *     真的读用户自己的配置、并在未配置时不显示 —— 这几条错了都不会报错，只会静默出网或留空行；
 *   · 面板上的两个探针按钮必须走**各自的**接口（测试连接打 /models、余额打账户接口），
 *     打串了会把"只读探测"变成"往账户接口发请求"，而出网口径是逐个动作登记的。
 * @vitest-environment node
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
/** panels → wechat-data */
const WD = join(HERE, '..')
const read = (...p: string[]): string => readFileSync(join(...p), 'utf8')
/** 剥注释：本仓既有做法（注释里提到旧写法不该让断言误判）。 */
const strip = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')

const panel = strip(read(WD, 'panels', 'llm-probe.tsx'))
const sidebar = strip(read(WD, 'panels', 'SidebarBalance.tsx'))
const shell = strip(read(WD, 'WechatDataPanel.tsx'))
const llmConfig = strip(read(WD, 'llm-config.ts'))

describe('面板：三类端点各走各的接口（向量 / 精排的地址·Key·路径本来就可以不同）', () => {
  it('三条测试都调 apiTestLlmConnection，但带各自的 kind / path / model', () => {
    expect(panel).toContain('apiTestLlmConnection({ apiUrl: ep.apiUrl, apiKey: ep.apiKey, kind, path: ep.path, model: ep.model })')
    expect(panel, '按钮的 kind 要跟着自己那一块走（锚点 data-test-llm={kind}）').toContain('data-test-llm={kind}')
    // 三块面板各挂一条（chat 在主卡片里，embed/rerank 在各自己的面板体里）
    expect(read(WD, 'panels', 'AiModelConfig.tsx')).toContain('<LlmProbeButton kind="chat"')
    expect(read(WD, 'panels', 'ai-model-roles.tsx')).toContain('<LlmProbeButton kind="embed"')
    expect(read(WD, 'panels', 'ai-model-roles.tsx')).toContain('<LlmProbeButton kind="rerank"')
    expect(panel, '余额查询仍走 apiGetLlmBalance（不许与测试按钮混用）').toContain('apiGetLlmBalance({ apiUrl: cfg.apiUrl, apiKey: cfg.apiKey })')
  })

  it('端点解析：地址/Key 留空回落上一套，路径各有缺省（与后端取数同口径）', () => {
    expect(panel).toContain('cfg.embeddingApiUrl?.trim() || cfg.apiUrl')
    expect(panel).toContain('cfg.embeddingApiKey?.trim() || cfg.apiKey')
    expect(panel).toContain("cfg.embedPath?.trim() || '/embeddings'")
    expect(panel).toContain('cfg.rerankApiUrl?.trim() || cfg.apiUrl')
    expect(panel).toContain('cfg.rerankApiKey?.trim() || cfg.apiKey')
    expect(panel).toContain("cfg.rerankPath?.trim() || '/rerank'")
    expect(panel, '向量模型留空要回落到 chat model').toContain('cfg.embeddingModel?.trim() || cfg.model')
  })

  it('未填向量/精排模型时按钮点不动，并在 title 里说明后果', () => {
    expect(panel).toContain("(kind === 'embed' && !ep.model)")
    expect(panel).toContain("(kind === 'rerank' && !ep.model)")
    expect(panel, '精排未填要说清"整段跳过"').toContain('精排整段会跳过')
    expect(panel, '向量未填要说清"退回纯本地稀疏"').toContain('退化为纯本地稀疏通道')
  })

  it('代价写在按钮提示里（向量/精排各发一条最小请求，主模型只看不花钱）', () => {
    expect(panel).toContain('不产生费用')
    expect(panel).toMatch(/约 3 个 token/)
    expect(panel).toMatch(/约 6 个 token/)
  })

  it('四条按钮各有稳定锚点（真机 e2e 靠它定位）', () => {
    expect(panel, '三条测试共用 data-test-llm={kind}').toContain('data-test-llm={kind}')
    expect(panel, '余额按钮缺锚点').toContain('data-balance-llm=""')
  })

  it('三块面板由可折叠外壳包着，且各挂一条探针（结构清晰 = 面板 + 自己的测试）', () => {
    const card = read(WD, 'panels', 'AiModelConfig.tsx')
    for (const id of ['id="chat"', 'id="embed"', 'id="rerank"']) expect(card, `缺面板 ${id}`).toContain(id)
    expect(card).toContain('<LlmBalanceButton cfg={llmConfig} />')
  })

  it('api 层把两个函数与结果类型转发出去（调用方只从 ../api.ts 取）', () => {
    for (const name of ['apiTestLlmConnection', 'apiGetLlmBalance', 'formatBalance']) {
      expect(llmConfig, `llm-config.ts 缺 ${name}`).toContain(`export async function ${name}`.replace('export async function formatBalance', 'export function formatBalance'))
    }
    expect(read(WD, 'api-config.ts')).toContain('apiTestLlmConnection,')
  })
})

describe('左下角余额条：挂载位置、刷新口径、失败不吵', () => {
  it('挂在侧栏底部固定区里、**设置按钮之后**（用户要求：设置按钮下方）', () => {
    const footer = shell.slice(shell.indexOf('function SidebarFooter('), shell.indexOf('export function WechatDataPanel'))
    expect(footer).toContain('css.sidebarFooter')
    expect(footer.indexOf('设置</span>'), '找不到设置按钮').toBeGreaterThan(-1)
    expect(footer.indexOf('<SidebarBalance collapsed={!navOpen} />'), '余额条没挂在设置下方').toBeGreaterThan(footer.indexOf('设置</span>'))
  })

  it('挂载后查一次 + 每 5 分钟一次 + 点击立刻刷新', () => {
    expect(sidebar).toContain('export const BALANCE_POLL_MS = 5 * 60 * 1000')
    expect(sidebar).toMatch(/useEffect\(\(\) => \{[\s\S]{0,200}void refresh\(\)/)
    expect(sidebar).toContain('setInterval(() => { void refresh() }, BALANCE_POLL_MS)')
    expect(sidebar, '点击要能立刻刷新').toMatch(/onClick=\{\(\) => \{ void refresh\(\) \}\}/)
  })

  it('每次刷新重新读配置（换了厂商/Key 之后最迟下一次刷新跟上），且没有地址或 Key 就不出网', () => {
    expect(sidebar).toContain('await apiGetLlmConfig()')
    expect(sidebar).toMatch(/if \(!apiUrl \|\| !apiKey\) \{[\s\S]{0,60}kind: 'hidden'/)
  })

  it('失败降级成「余额 —」并只在 title 里说明（不常驻一条错误挤掉数据状态）', () => {
    expect(sidebar).toContain("state.kind === 'error'")
    expect(sidebar).toContain("'余额 —'")
    expect(sidebar).toMatch(/余额查询失败：\$\{state\.message\}/)
  })

  it('单飞：定时与点击叠在一起只跑一次', () => {
    expect(sidebar).toContain('const busy = useRef(false)')
    expect(sidebar).toMatch(/if \(busy\.current\) return/)
  })
})
