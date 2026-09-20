/**
 * 删库文案的回归用例（`kb-delete-copy.ts` 是纯函数，所以这层能真的跑起来）。
 *
 * 为什么这几句话值得一整套用例：它们是「删掉这个库会丢什么」的唯一说明，而**说错的代价
 * 是数据**。真机探针（`working/cdp-kb-files.mjs` 第 10 步）在修前实测到：库里有 2 个已登记
 * 文件、5 个文本块，弹层写的是「这个库是空的，删除它不会丢任何笔记」——用户以为没事，
 * 点下去 blob / 分块 / FTS / 向量全被清掉。而当时前端、后端的用例**全是绿的**。
 *
 * 所以这里钉的不是「串长什么样」，而是三件会让用户**判断错**的事：
 *   ① 有文件时不许说「空的 / 不会丢」；
 *   ② 文件数与笔记数并列出现（不能被笔记数盖掉）；
 *   ③ 「文件侧没清点成」（`undefined`）不能被说成「0 个文件」——那是两句相反的话，
 *      后端从 T2 起就刻意把 `undefined` 与 `0` 分开（见 `KbMutationResult` 的注释）。
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import {
  canMoveInstead,
  contentParts,
  deleteDialogLead,
  deleteReceipt,
  purgeButtonLabel,
} from './kb-delete-copy.ts'

/** 修前那句错话：有文件时它一个字都不该出现。 */
const EMPTY_CLAIM_RE = /空的|不会丢/

describe('删库弹层：库里有什么就说什么', () => {
  it('两者都为零时才说「空的」「不会丢任何内容」', () => {
    const lead = deleteDialogLead({ noteCount: 0, fileCount: 0 })
    expect(lead).toContain('没有笔记也没有文件')
    expect(lead).toContain('不会丢任何内容')
    expect(purgeButtonLabel({ noteCount: 0, fileCount: 0 })).toBe('一并删除')
    expect(canMoveInstead({ noteCount: 0, fileCount: 0 })).toBe(false)
  })

  it('★ 0 条笔记 / 2 个文件：不许说「空的」，且要点名文件数（探针实测的那一格）', () => {
    const counts = { noteCount: 0, fileCount: 2 }
    const lead = deleteDialogLead(counts)
    expect(lead, '有文件却说了「空的」——修前就是这么骗过用户的').not.toMatch(EMPTY_CLAIM_RE)
    expect(lead).toContain('2 个文件')
    // 按钮上也要有：用户是**在点之前**看这一眼
    expect(purgeButtonLabel(counts)).toContain('2 个文件')
    // 0 条笔记时能走「移到别的库」：后端 kbFilesOnKbDelete 连文件一起迁（§7.1）
    expect(canMoveInstead(counts), '只按 noteCount 判断 ⇒ 纯文件库只剩「一并删除」一个出口').toBe(true)
  })

  it('笔记与文件都有时，两者并列出现（不能被笔记数盖掉）', () => {
    const counts = { noteCount: 3, fileCount: 1 }
    const lead = deleteDialogLead(counts)
    expect(lead).toContain('3 条笔记')
    expect(lead).toContain('1 个文件')
    expect(lead).toContain(' 和 ')
    expect(purgeButtonLabel(counts)).toBe('一并删除（3 条笔记 / 1 个文件）')
  })

  it('只有笔记时维持原样（这次改动不该把老文案搅动）', () => {
    const counts = { noteCount: 4, fileCount: 0 }
    expect(deleteDialogLead(counts)).toBe('这个库里有 4 条笔记。删除知识库时它们要一起删掉，还是移到别的库？')
    expect(purgeButtonLabel(counts)).toBe('一并删除（4 条笔记）')
    expect(canMoveInstead(counts)).toBe(true)
  })

  it('contentParts 只列非零项（零项不出现在句子里）', () => {
    expect(contentParts({ noteCount: 0, fileCount: 0 })).toEqual([])
    expect(contentParts({ noteCount: 2, fileCount: 0 })).toEqual(['2 条笔记'])
    expect(contentParts({ noteCount: 0, fileCount: 5 })).toEqual(['5 个文件'])
    expect(contentParts({ noteCount: 1, fileCount: 1 })).toEqual(['1 条笔记', '1 个文件'])
  })
})

describe('删库回执：把结果说全（§10 边界 7）', () => {
  it('purge：笔记与文件两侧都报数', () => {
    const r = deleteReceipt({ kbName: '探针文件库', action: 'purge', removedNotes: 3, removedFiles: 2 })
    expect(r).toContain('「探针文件库」')
    expect(r).toContain('3 条笔记')
    expect(r).toContain('2 个文件')
    expect(r).toContain('一并删掉')
  })

  it('purge 且库里本来就没有文件：说 0 个文件（清点过，确实是 0）', () => {
    const r = deleteReceipt({ kbName: '空库', action: 'purge', removedNotes: 0, removedFiles: 0 })
    expect(r).toContain('0 个文件已一并删掉')
    expect(r).not.toContain('没清点成')
  })

  it('★ 文件侧没清点成（undefined）不许说成「0 个文件」——两句相反的话', () => {
    const r = deleteReceipt({ kbName: '空库', action: 'purge', removedNotes: 0 })
    expect(r, '把「没清点」说成了「一个都没有」').not.toContain('0 个文件')
    expect(r).toContain('没清点成')
    expect(r).toContain('「文件」分段')
  })

  it('★ reassign 撞上目标库同内容文件：逐字写「N 个文件与目标库内容重复，未迁移」', () => {
    const r = deleteReceipt({
      kbName: '工作',
      action: 'reassign',
      targetName: '生活',
      movedNotes: 2,
      movedFiles: 1,
      removedFiles: 1,
    })
    expect(r).toContain('2 条笔记已移到「生活」')
    expect(r).toContain('1 个文件已移到「生活」')
    expect(r).toContain('1 个文件与目标库内容重复，未迁移')
  })

  it('reassign 目标库名拿不到时退化成「目标库」，且不吐 undefined', () => {
    const r = deleteReceipt({ kbName: '工作', action: 'reassign', movedNotes: 1, movedFiles: 0, removedFiles: 0 })
    expect(r).toContain('已移到目标库')
    expect(r).not.toContain('undefined')
    // 拼接处不留空格（「移到 「生活」」是排版事故，不是风格偏好）
    expect(r, '拼接处多了一个空格').not.toMatch(/移到\s+目标库/)
  })

  it('reassign 没有任何文件时也明说一句（别让用户惦记文件去哪了）', () => {
    const r = deleteReceipt({ kbName: '工作', action: 'reassign', targetName: '生活', movedNotes: 1, movedFiles: 0, removedFiles: 0 })
    expect(r).toContain('没有文件需要处理')
  })

  it('防空转：回执里不许出现 undefined / NaN / null 字样', () => {
    const combos = [
      { kbName: 'A', action: 'purge' as const, removedNotes: 1, removedFiles: 1 },
      { kbName: 'A', action: 'purge' as const },
      { kbName: 'A', action: 'reassign' as const, movedNotes: 0, movedFiles: 2, removedFiles: 3 },
      { kbName: 'A', action: 'reassign' as const },
    ]
    for (const c of combos) {
      const r = deleteReceipt(c)
      expect(r, `回执泄漏了内部值：${r}`).not.toMatch(/undefined|NaN|null/)
      expect(r, `回执没以句号收尾：${r}`).toMatch(/。$/)
    }
  })
})
