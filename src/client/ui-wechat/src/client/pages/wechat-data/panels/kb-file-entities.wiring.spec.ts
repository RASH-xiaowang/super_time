/**
 * 「文件详情 → 提取实体 → 知识图谱」接线守卫。
 *
 * 这一条链路的退化方式不会让界面打不开：按钮可能悄悄改回整库抽取、
 * 关掉出网后仍然可点、空结果被当成成功，或者实体边只画一个箭头。
 * 这里把按钮入口、单文件参数、错误反馈与图谱双向边一起钉住。
 *
 * @vitest-environment node
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
const detail = readFileSync(join(HERE, 'kb-files-detail.tsx'), 'utf8')
const panel = readFileSync(join(HERE, 'kb-files-panel.tsx'), 'utf8')
const actions = readFileSync(join(HERE, 'kb-save-note.ts'), 'utf8')

describe('文件详情：提取实体按钮', () => {
  it('按钮接的是单文件抽取，并显式限制为 1 个文件', () => {
    expect(detail).toContain('提取实体')
    expect(detail).toContain('onExtractEntities(selected)')
    expect(actions).toMatch(/apiExtractKbEntities\(kbId, \{ fileIds: \[f\.id\], limit: 1 \}\)/)
    expect(actions).not.toMatch(/apiExtractKbEntities\(kbId\)/)
  })

  it('关闭「参与语义检索」时不可点击，并说明内容不出网', () => {
    expect(detail).toMatch(/disabled=\{busyEntityId === selected\.id \|\| !selected\.includeInRag\}/)
    expect(detail).toContain('内容不得离开本机')
  })

  it('忙碌态与摘要分开，抽取中只改自己的按钮文案', () => {
    expect(detail).toMatch(/busyEntityId === selected\.id \? '提取中…' : '提取实体'/)
    expect(actions).toContain('useExtractFileEntities(kbId')
    expect(panel).toContain('onExtractEntities={extractEntities}')
    expect(panel).toContain('busyEntityId={busyEntityId}')
    expect(panel).toContain('entityError={selectedId === null ? null : (entityErrors.get(selectedId) ?? null)}')
  })

  it('成功与失败各有明确反馈；空结果由后端失败回执带原因', () => {
    expect(actions).toContain('已提取 ${r.saved} 个实体，已同步到知识图谱')
    expect(actions).toContain("r.error ?? r.failed[0]?.error ?? '实体提取失败'")
    expect(actions, '单文件按钮不应把 0 条当成功再自行报错').not.toContain('r.saved === 0')
  })
})

describe('知识图谱：实体连线双向可查', () => {
  it('mention / suggest 边带 bidirectional 标记', () => {
    const model = readFileSync(join(HERE, 'graph-model.ts'), 'utf8')
    expect(model).toMatch(/e\.kind === 'mention' \|\| e\.kind === 'suggest' \? \{ bidirectional: true \}/)
  })
})
