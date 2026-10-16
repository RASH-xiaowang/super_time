/**
 * 网格算术与文件命名的行为判据（#22 第三处：文件面板虚拟化时把这两族搬成纯函数）。
 *
 * 挑这几条的理由：列数换算与"哪一格属于第几行"是这族里唯一会**安静算错**的地方
 * （算错不会崩，只会"最后一行不见了"或"同一格画两遍"）；命名那一族决定界面上看得见的两行字，
 * 而 `fileKey` 少剥一个后缀就会把缩略图与原图当成两个文件。
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import type { FileItem } from '@deepseek-ai/dsh-wechat-data/types'
import { columnsForWidth, gridColumnCount, gridRowCount, gridRowRange, resolveGridColumns } from './files-grid.ts'
import { CAT_LABEL, fileDisplayName, fileKey, fileSource, fileTitle, isHashLike } from './files-naming.ts'

describe('网格算术', () => {
  it('从解析后的 gridTemplateColumns 数列（浏览器给的是「200px 200px 200px」）', () => {
    expect(gridColumnCount('200px 200px 200px')).toBe(3)
    expect(gridColumnCount('158.5px 158.5px')).toBe(2)
    expect(gridColumnCount('repeat(4, minmax(200px, 1fr))')).toBe(4)
  })

  it('列数「不知道」时返回 0 而不是 1 —— 1 是一个合法的列数，不能拿来当兜底信号', () => {
    expect(gridColumnCount('')).toBe(0)
    expect(gridColumnCount('none')).toBe(0)
    expect(gridColumnCount('auto auto')).toBe(0)
  })

  it('按宽度换算列数（auto-fill 的语义就是塞得下几列塞几列），边界不出现 0 列', () => {
    expect(columnsForWidth(1000, 200)).toBe(5)
    expect(columnsForWidth(999, 200)).toBe(4)
    expect(columnsForWidth(120, 200)).toBe(1)
    expect(columnsForWidth(0, 200)).toBe(1)
    expect(columnsForWidth(600, 0)).toBe(1)
  })

  it('两个来源合成：算出来的样式优先，拿不到才按宽度估', () => {
    expect(resolveGridColumns('200px 200px 200px', 5000, 200)).toBe(3)
    expect(resolveGridColumns('none', 1000, 200)).toBe(5)
  })

  it('行数与每行的区间：最后一行不满列也要截到条目数（否则渲染时越界、或最后几格永远画不出来）', () => {
    expect(gridRowCount(0, 4)).toBe(0)
    expect(gridRowCount(10, 4)).toBe(3)
    expect(gridRowCount(10, 0)).toBe(10)
    expect(gridRowRange(0, 10, 4)).toEqual({ start: 0, end: 4 })
    expect(gridRowRange(2, 10, 4)).toEqual({ start: 8, end: 10 })
    expect(gridRowRange(9, 10, 4)).toEqual({ start: 36, end: 10 })
  })
})

describe('文件命名与来源', () => {
  const f = (over: Partial<FileItem> = {}): FileItem =>
    ({ md5: 'a'.repeat(32), fileName: '', category: 'image', fileSize: 0, modifyTime: 0, ...over } as FileItem)

  it('fileKey 剥掉 .dat 与 _t/_h/_b 后缀（同一张图的原图与缩略要落进同一个缓存槽）', () => {
    expect(fileKey(f({ fileName: 'x.dat' }))).toBe('x')
    expect(fileKey(f({ fileName: 'X.dat' }))).toBe('X')
    expect(fileKey(f({ fileName: 'abc_t' }))).toBe('abc')
    expect(fileKey(f({ fileName: 'abc_thumb1' }))).toBe('abc')
    expect(fileKey(f({ fileName: 'report.pdf' }))).toBe('report.pdf')
    expect(fileKey(f({ fileName: '', md5: 'deadbeef' }))).toBe('deadbeef')
  })

  it('哈希名判得出来：32 位十六进制、或无点且 16 位以上字母数字；正常文件名不算哈希', () => {
    expect(isHashLike(f({ fileName: 'a'.repeat(32) }))).toBe(true)
    expect(isHashLike(f({ fileName: 'K7QX2M9P4RTZ8W1D' }))).toBe(true)
    expect(isHashLike(f({ fileName: '会议纪要.pdf' }))).toBe(false)
    expect(isHashLike(f({ fileName: 'a_b.png' }))).toBe(false)
  })

  it('可读名直接用；哈希名换成「类目 · 来自 会话 · 月日」（界面上永远不给用户一串哈希）', () => {
    expect(fileDisplayName(f({ fileName: '合同.docx' }))).toBe('合同.docx')
    const hashed = fileDisplayName(f({ fileName: 'a'.repeat(32), category: 'video', sessionName: '项目群', modifyTime: 1_700_000_000 }))
    expect(hashed.startsWith('视频 · 来自 项目群 · ')).toBe(true)
    expect(fileDisplayName(undefined)).toBe('(未知)')
    expect(CAT_LABEL.image).toBe('图片')
  })

  it('来源串：会话名优先 message_resource 口径，缺失才用附件目录口径；空值不留分隔符', () => {
    expect(fileSource(f({ sessionName: '甲', sourceTalker: '乙', sourceMonth: '2026-09' }))).toBe('甲 · 2026-09')
    expect(fileSource(f({ sourceTalker: '乙' }))).toBe('乙')
    expect(fileSource(f({ sourceMonth: '2026-09' }))).toBe('2026-09')
    expect(fileSource(f({}))).toBe('')
  })

  it('tooltip 给全名 + 来源 + 原始文件名（只在二者不同时重复给）', () => {
    const readable = f({ fileName: '合同-终版-2026.docx', sessionName: '法务群', sourceMonth: '2026-09' })
    const t = fileTitle(readable)
    expect(t).toContain('合同-终版-2026.docx')
    expect(t).toContain('来源：法务群 · 2026-09')
    expect(t.split('\n')).toHaveLength(2)
    // 哈希名时 display 与 raw 是两回事，raw 必须还给用户（要复制）
    const hashed = fileTitle(f({ fileName: 'b'.repeat(32), modifyTime: 1_700_000_000 }))
    expect(hashed).toContain('b'.repeat(32))
    expect(hashed.split('\n').length).toBeGreaterThanOrEqual(2)
  })
})
