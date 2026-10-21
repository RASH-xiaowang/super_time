/**
 * 「一键批量摘要 / 实体 + 实时处理状态」接线守卫。
 *
 * 这一组功能的退化方式都不会让页面报错：
 *   · 两个按钮接到同一个 action，用户点哪一个都只跑摘要；
 *   · 批量候选漏掉出网开关，敏感文件被静默发出去；
 *   · 串行队列变成 Promise.all，几十个模型请求一起打满限流；
 *   · 状态面板只看批量队列、不看解析状态，用户看不到真正的文档处理进度；
 *   · 完成后仍显示「处理中」，或者重试把已成功的文件再发一遍。
 *
 * @vitest-environment node
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
const read = (name: string): string => readFileSync(join(HERE, name), 'utf8')
const panel = read('kb-files-panel.tsx')
const batch = read('use-kb-batch-jobs.ts')
const actions = read('use-kb-batch-actions.ts')
const processing = read('kb-processing-panel.tsx')
const buttons = read('kb-batch-actions.tsx')
const model = read('kb-batch-jobs.ts')
const css = read('kb-processing.module.css')

describe('页头入口：两个按钮各自接对动作', () => {
  it('批量摘要 / 批量实体都渲染，并分别绑定自己的处理函数', () => {
    expect(panel).toContain('<KbBatchActionButtons')
    expect(buttons).toContain('批量摘要')
    expect(buttons).toContain('批量实体')
    expect(panel).toContain('onSummaries={() => { void batchJobs.batchSummaries() }}')
    expect(panel).toContain('onEntities={() => { void batchJobs.batchEntities() }}')
  })

  it('已有关联任务时禁用两个入口，避免叠跑出网任务', () => {
    expect(buttons).toMatch(/const busy = runningId !== null \|\| indexing/)
    expect(buttons).toMatch(/disabled=\{busy\}/)
  })

  it('确认框明确说明会出网、串行且单份失败不连坐', () => {
    expect(actions).toContain('会出网')
    expect(actions).toContain('单份失败不会中断其余文件')
    expect(actions).toContain('批量生成')
    expect(actions).toContain('批量提取')
  })
})

describe('批量候选与执行：隐私边界 + 串行 + 可恢复', () => {
  it('候选只收已解析且有正文的可出网文件，摘要默认补缺、实体取全部', () => {
    expect(model).toMatch(/f\.includeInRag\s*&& f\.parseState === 'ready'\s*&& f\.chunkCount > 0/)
    expect(model).toContain("scope === 'all-rag'")
    expect(model).toContain("action === 'entities'")
    expect(model).toContain("(f.summary ?? '').trim() === ''")
  })

  it('一次只认领一条，不把批量变成并发请求', () => {
    expect(model).toContain('findIndex(it => it.status === \'queued\')')
    expect(batch).toContain('const index = canceledRef.current ? -1 : nextBatchIndex(current)')
    expect(batch).not.toContain('Promise.all(')
  })

  it('单份失败继续、重试只回队列失败项', () => {
    expect(batch).toContain("patchBatchItem(current, index, { status: 'failed'")
    expect(model).toContain("if (it.status !== 'failed') return it")
    expect(model).toContain('return changed ? { ...run, items, canceled: false } : run')
    expect(processing).toContain('重试失败项')
  })

  it('每完成一份静默刷新列表，状态变化无需手动刷新', () => {
    expect(batch).toContain('await reload()')
    expect(panel).toMatch(/reload: useCallback\(\(\) => load\(\{ silent: true \}\), \[load\]\)/)
  })
})

describe('实时处理状态面板', () => {
  it('面板同时接收解析文件与批量队列', () => {
    expect(panel).toContain('<KbProcessingEntry')
    expect(panel).toContain('files={files}')
    expect(panel).toContain('batchJobs={batchJobs}')
    expect(processing).toContain('batch={batchJobs.run}')
    expect(panel).not.toContain('<KbParseQueueLine')
    expect(processing).toContain('解析队列')
    expect(processing).toContain('批量摘要')
    expect(processing).toContain('批量提取实体')
  })

  it('批量任务进行中时语义索引也不能再启动', () => {
    expect(panel).toMatch(/disabled=\{indexing \|\| batchJobs\.runningId !== null\}/)
  })

  it('状态用真实终态与计数，不伪造百分比', () => {
    expect(processing).toContain('aria-valuenow={tally.done}')
    expect(processing).toContain('tally.done / tally.total')
    expect(model).toContain("status === 'queued') return '排队中'")
    expect(model).toContain("status === 'running') return '处理中'")
  })

  it('所有新类名都有样式，状态面板可滚动且不撑垮主布局', () => {
    const used = [...new Set([...processing.matchAll(/\bcss\.([A-Za-z_$][\w$]*)/g)].map(m => m[1] as string))]
    expect(used.length).toBeGreaterThan(8)
    for (const c of used) expect(css, `缺少 .${c}`).toContain(`.${c}`)
    expect(css).toContain('@container kbprocessing')
  })

  it('处理状态从文件列表上方移到工具栏右侧抽屉', () => {
    const toolbar = panel.slice(panel.indexOf('<Toolbar'), panel.indexOf('</Toolbar>'))
    expect(toolbar, '处理状态入口没放进工具栏').toContain('right={(')
    expect(toolbar).toContain('<KbProcessingEntry')
    expect(panel, '旧的页面内处理面板仍在（会继续占用列表高度）').not.toContain('<KbProcessingPanel')
    expect(processing).toContain("import { Badge, Button, Drawer } from '../ui/kit.tsx'")
    expect(processing).toContain('<Drawer open onClose={close} title="文档处理状态"')
    expect(processing).toContain('aria-expanded={open}')
    expect(processing).toContain('aria-controls="kb-processing-drawer"')
    expect(css, '工具栏入口缺少样式').toContain('.entryPulse')
    expect(css).toContain('.entryBadge')
  })
})
