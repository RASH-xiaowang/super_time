/**
 * 「文件 → 笔记 → 图谱」链路守卫。
 *
 * ## 背景（2026-10-17）
 *
 * 改前「生成摘要」只把摘要写进文件元数据（`kb_files.summary`），**不会变成笔记** ——
 * 于是这条链路是断的：用户导入并解析了 195 块内容、生成了摘要，
 * 笔记库却永远是空的、知识图谱里只有文件章节节点。
 *
 * 实测（本机）：文件 195 块已就绪、摘要已生成，笔记库 0 条 —— 界面上没有任何入口
 * 能把「已解析的文件」变成「可编辑的笔记」。
 *
 * 这里钉四件事：
 *  ① 后端 `saveNote` 支持 `sourceKind: 'file'` + `sourceFileId`；
 *  ② 文件详情有「存为笔记」按钮，且没有摘要时禁用（不造空笔记）；
 *  ③ 笔记库空态给出「从文件沉淀」出口（不是只说「新建第一条」）；
 *  ④ `MergedSections` 的 `render` 能拿到 `go` 回调（否则空态跳不了分段）。
 * @vitest-environment node
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))

function findRoot(start: string): string {
  let d = start
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(d, 'main.js')) && existsSync(join(d, 'package.json'))) return d
    d = dirname(d)
  }
  throw new Error('找不到仓库根')
}
const ROOT = findRoot(HERE)
const BACKEND = join(ROOT, 'src', 'backend', 'wechat-data', 'src')
const notes = readFileSync(join(BACKEND, 'query', 'notes.ts'), 'utf8')
const typesKb = readFileSync(join(BACKEND, 'types-kb.ts'), 'utf8')
const detail = readFileSync(join(HERE, 'kb-files-detail.tsx'), 'utf8')
const saveNote = readFileSync(join(HERE, 'kb-save-note.ts'), 'utf8')
const kbPanel = readFileSync(join(HERE, 'KnowledgeBase.tsx'), 'utf8')
const merged = readFileSync(join(HERE, 'MergedSections.tsx'), 'utf8')

describe('文件 → 笔记：后端支持 file 来源', () => {
  it('saveNote 接受 sourceKind: file 与 sourceFileId', () => {
    expect(notes, 'saveNote 不接受 file 来源').toMatch(/sourceKind\?: 'manual' \| 'ask' \| 'file'/)
    expect(notes, 'saveNote 不接受 sourceFileId').toMatch(/sourceFileId\?: number/)
  })

  it('source_file_id 列会迁移（老库没有这一列）', () => {
    expect(notes, '没有迁移 source_file_id 列').toMatch(/ALTER TABLE notes ADD COLUMN source_file_id/)
  })

  it('读回来时 file 来源与 sourceFileId 都要还原', () => {
    expect(notes, "rowToNote 没还原 'file'").toMatch(/rawKind === 'file' \? 'file'/)
    expect(notes, 'rowToNote 没还原 sourceFileId').toMatch(/note\.sourceFileId = fileId/)
  })

  it('KnowledgeNote 与 KnowledgeSnapshot 的类型都含 file', () => {
    const hits = [...typesKb.matchAll(/sourceKind: 'manual' \| 'ask' \| 'file'/g)]
    expect(hits.length, '两处 sourceKind 类型都要含 file（KnowledgeNote + KnowledgeSnapshot）').toBeGreaterThanOrEqual(2)
  })
})

describe('文件 → 笔记：界面入口', () => {
  it('文件详情有「存为笔记」按钮', () => {
    expect(detail, '详情面板没有「存为笔记」按钮').toContain('存为笔记')
    expect(detail, '没有接 onSaveAsNote').toMatch(/onSaveAsNote/)
  })

  it('没有摘要时禁用（不造空笔记）', () => {
    expect(detail, '没有摘要时没禁用').toMatch(/disabled=\{busySummaryId === selected\.id \|\| summaryText === ''\}/)
    expect(detail, '缺少禁用原因').toContain('先生成摘要，再存为笔记')
  })

  it('存为笔记走 sourceKind: file + sourceFileId', () => {
    expect(saveNote).toMatch(/sourceKind: 'file'/)
    expect(saveNote).toMatch(/sourceFileId: f\.id/)
  })

  it('笔记库空态给出「从文件沉淀」出口', () => {
    expect(kbPanel, '空态没有「从文件沉淀」').toContain('从文件沉淀')
    expect(kbPanel, '没有接 onGoFiles').toMatch(/onGoFiles/)
  })

  it('MergedSections 的 render 能拿到 go 回调（否则空态跳不了分段）', () => {
    expect(merged, 'render 签名没有 go 参数').toMatch(/render: \(go: \(key: string\) => void\) => ReactNode/)
    expect(merged, '没有把 go 传给 render').toMatch(/current\.render\(go\)/)
  })
})
