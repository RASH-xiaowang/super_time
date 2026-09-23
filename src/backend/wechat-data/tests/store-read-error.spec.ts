/**
 * N1：write store 的两个前提 —— 「数据根还不存在」与「库读不到」。
 *
 * 条目原文：`wechat-tasks.ts` 的 `openStore` 无 `mkdirSync`（与笔记库同类），
 * 且 `listTasks` 的 `catch` 把「打不开库」直接退化成空列表 —— 「待办为空」与
 * 「库读不到」在界面上**无法区分**，用户按「暂无待办」去排查会查错方向。
 *
 * 这里钉三件事（对应验收标准的①，以及条目正文的「读失败必须可区分」）：
 *   ① 全新 userData（连数据根都不存在）下**写入成功** —— 改前 `insertTask` 返回
 *      `{ok:false, error:'unable to open database file'}`，用户第一次记待办就写不进去；
 *   ② 打不开库时返回值带 `readError`、且 console 留痕；「确无数据」时**不带**；
 *   ③ 「建目录失败」不许变成新的判定依据：错误仍是 SQLite 的那句（不是 EEXIST/ENOTDIR），
 *      也没变成抛错 —— 即「保持既有失败语义不变」。
 *
 * **可逆变异**（实施记录里记了 A/B）：把任一 `catch` 改回 `return { items: [], total: 0 }`
 * 或把 `mkdirSync` 的 try/catch 去掉，本文件的用例即转红。
 *
 * 说明：这三个 store 里 `notes.ts` 原本就有 `mkdirSync`（N1 判定的参照实现），
 * 用例把它一并纳入，免得「同族里改了一半」被漏掉。
 * @vitest-environment node
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { insertTask, listTasks } from '../src/query/wechat-tasks.ts'
import { buildKnowledgeGraph, DEFAULT_KB_ID, listKbs, listNotes, saveNote } from '../src/query/notes.ts'
import { listSummaryRecords, listSummaryTasks, saveSummaryTask } from '../src/query/summary-tasks.ts'

/** SQLite 打不开库时的那句原文（三处 catch 都必须原样透出它，不能被别的错误顶替）。 */
const CANTOPEN = 'unable to open database file'

const scratch: string[] = []
afterEach(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true })
  scratch.length = 0
  vi.restoreAllMocks()
})

/** 造一个临时基目录（`decrypted` 与各 store 库都是它的子路径）。 */
function base(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wx-store-n1-'))
  scratch.push(dir)
  return dir
}

/** 一个只写过日志的 console.warn 替身（避免污染测试输出，同时用于断言「留痕」）。 */
function silenceWarn(): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(console, 'warn').mockImplementation(() => { /* 静音 */ })
}

/**
 * 空数据根：`decrypted/` 建好、库文件还没有 ⇒ 读它得到「确无数据」（且顺手把库建出来）。
 * @returns decrypted 目录。
 */
function emptyRoot(): string {
  const decrypted = join(base(), 'decrypted')
  mkdirSync(decrypted, { recursive: true })
  return decrypted
}

/**
 * 坏数据根：把库文件的位置占成一个**目录** ⇒ 每次打开都失败（父目录存在，mkd 是空操作）。
 * 必须与「空数据根」分开：读一次空根就会把库文件建出来，之后再想占位就是 EEXIST。
 * @param dbFile - 库文件名（`wechat_tasks.db` / `wechat_notes.db` / `daily_summary.db`）。
 * @returns decrypted 目录。
 */
function brokenRoot(dbFile: string): string {
  const root = base()
  const decrypted = join(root, 'decrypted')
  mkdirSync(decrypted, { recursive: true })
  mkdirSync(join(root, dbFile))
  return decrypted
}

/** 某次 warn 调用的首个实参是否含给定子串。 */
function warnedWith(spy: ReturnType<typeof vi.spyOn>, needle: string): boolean {
  return spy.mock.calls.some(call => String(call[0]).includes(needle))
}

/** 建/取一个最小的摘要任务载荷（只用必填字段）。 */
function summaryTask(overrides: Record<string, unknown> = {}): Parameters<typeof saveSummaryTask>[1] {
  return {
    groupUsername: 'g@chatroom',
    groupName: '某个群',
    targetUsers: [],
    format: 'brief',
    customPrompt: '',
    scheduleTime: '08:00',
    enabled: true,
    ...overrides,
  }
}

describe('N1 数据根不存在时仍能写入（三个 store 同一语义）', () => {
  it('全新 userData（无 decrypted/）：待办、摘要任务、笔记都能写入并读回', () => {
    const root = base()
    // 刻意什么都不建：改前 openStore 直接 new DatabaseSync 会得到 unable to open database file
    const decrypted = join(root, 'userData', 'decrypted')
    expect(existsSync(join(root, 'userData'))).toBe(false)

    const inserted = insertTask(decrypted, { title: '周五前交报告' })
    expect(inserted.ok).toBe(true)
    expect(existsSync(join(root, 'userData', 'wechat_tasks.db'))).toBe(true)

    const saved = saveSummaryTask(decrypted, summaryTask())
    expect(saved.ok).toBe(true)
    expect(existsSync(join(root, 'userData', 'daily_summary.db'))).toBe(true)

    // 笔记库（N1 的参照实现，早就有 mkdirSync）走同一条路径
    const note = saveNote(decrypted, DEFAULT_KB_ID, { title: '会议纪要' })
    expect(note.ok).toBe(true)

    // 读回：写进去的都在，且**都不是**「读失败」形态
    const tasks = listTasks(decrypted)
    expect(tasks.total).toBe(1)
    expect(tasks.items[0]?.title).toBe('周五前交报告')
    expect(tasks.readError).toBeUndefined()

    expect(listSummaryTasks(decrypted).items.length).toBe(1)
    expect(listNotes(decrypted, DEFAULT_KB_ID).total).toBe(1)
  })

  it('写入失败时仍是既有的 {ok:false,error} 形态（不变成抛错）', () => {
    silenceWarn()
    const root = base()
    // 数据根的父路径被一个普通文件占住 ⇒ 建目录与开库都会失败
    writeFileSync(join(root, 'blocker'), 'not a directory')
    const decrypted = join(root, 'blocker', 'decrypted')

    const inserted = insertTask(decrypted, { title: 't' })
    expect(inserted.ok).toBe(false)
    expect(String(inserted.error)).toContain(CANTOPEN)
    expect(saveSummaryTask(decrypted, summaryTask()).ok).toBe(false)
    expect(saveNote(decrypted, DEFAULT_KB_ID, { title: 'n' }).ok).toBe(false)
  })
})

describe('N1 读失败与「确无数据」可区分', () => {
  it('待办库：确无数据不带 readError，打不开库带 readError 且留痕', () => {
    const warn = silenceWarn()

    // ① 确无数据：空列表 + total 0，且**没有** readError
    const decrypted = emptyRoot()
    const empty = listTasks(decrypted)
    expect(empty.items).toEqual([])
    expect(empty.total).toBe(0)
    expect(empty.readError).toBeUndefined()
    expect(warn).not.toHaveBeenCalled()

    // ② 库读不到：把库文件的位置占成一个目录（父目录存在 ⇒ mkdir 是空操作）
    const broken = listTasks(brokenRoot('wechat_tasks.db'))
    // 与①**逐项相同的空形态** —— 唯一的区分点就是 readError
    expect(broken.items).toEqual([])
    expect(broken.total).toBe(0)
    expect(typeof broken.readError).toBe('string')
    expect(broken.readError).toContain(CANTOPEN)
    expect(warnedWith(warn, '待办库读取失败')).toBe(true)
  })

  it('笔记库：listNotes 与 buildKnowledgeGraph 都要能区分', () => {
    const warn = silenceWarn()

    const decrypted = emptyRoot()
    expect(listNotes(decrypted, DEFAULT_KB_ID).readError).toBeUndefined()
    expect(buildKnowledgeGraph(decrypted, DEFAULT_KB_ID, new Map()).readError).toBeUndefined()
    // 库列表同理：空根目录下「一个库都没有」不能靠 readError 掩盖 ——
    // 迁移会把默认库建出来，所以这里应当是一个**非空**列表且无 readError。
    expect(listKbs(decrypted).readError).toBeUndefined()
    expect(listKbs(decrypted).items.map(k => k.id)).toEqual([DEFAULT_KB_ID])

    const broken = brokenRoot('wechat_notes.db')
    const notes = listNotes(broken, DEFAULT_KB_ID)
    expect(notes.total).toBe(0)
    expect(notes.readError).toContain(CANTOPEN)

    // 知识图谱整张为空，是最容易让用户以为「数据丢了」的那种
    const graph = buildKnowledgeGraph(broken, DEFAULT_KB_ID, new Map())
    expect(graph.notes).toEqual([])
    expect(graph.summary.noteCount).toBe(0)
    expect(graph.readError).toContain(CANTOPEN)
    expect(warnedWith(warn, '笔记库读取失败')).toBe(true)
    expect(warnedWith(warn, '知识图谱读取失败')).toBe(true)
  })

  it('摘要库：任务与记录两条读路径都要能区分', () => {
    const warn = silenceWarn()

    const decrypted = emptyRoot()
    expect(listSummaryTasks(decrypted).readError).toBeUndefined()
    expect(listSummaryRecords(decrypted).readError).toBeUndefined()

    const broken = brokenRoot('daily_summary.db')
    expect(listSummaryTasks(broken).readError).toContain(CANTOPEN)
    expect(listSummaryRecords(broken).readError).toContain(CANTOPEN)
    expect(listSummaryRecords(broken, 7).readError).toContain(CANTOPEN)
    expect(warnedWith(warn, '摘要任务读取失败')).toBe(true)
    expect(warnedWith(warn, '摘要记录读取失败')).toBe(true)
  })
})

describe('N1 建目录失败不改判定（保持既有失败语义）', () => {
  it('建目录抛错被咽下：病因仍是「库打不开」，且不抛给调用方', () => {
    const warn = silenceWarn()
    const root = base()
    writeFileSync(join(root, 'blocker'), 'not a directory')
    const decrypted = join(root, 'blocker', 'decrypted') // dirname 命中一个文件 ⇒ mkdirSync 抛 EEXIST

    // 若把 openStore 的 try/catch 去掉（改成直接 mkdirSync），这一行会抛出而使用例失败
    const snap = listTasks(decrypted)
    // 病因必须是 SQLite 那句，不能变成 EEXIST/ENOTDIR（否则用户会按「目录权限」查错方向）
    expect(snap.readError).toContain(CANTOPEN)
    expect(snap.readError).not.toContain('EEXIST')
    expect(snap.readError).not.toContain('ENOTDIR')
    // 建目录失败本身也留了痕
    expect(warnedWith(warn, '数据根目录创建失败')).toBe(true)

    expect(listSummaryTasks(decrypted).readError).toContain(CANTOPEN)
    expect(listNotes(decrypted, DEFAULT_KB_ID).readError).toContain(CANTOPEN)
    // 库列表读不到时也必须是「带 readError 的空列表」，
    // 否则调用方会去新建一个默认库，把真正的问题（库打不开）盖掉。
    expect(listKbs(decrypted).readError).toContain(CANTOPEN)
    expect(listKbs(decrypted).items).toEqual([])
  })

  it('同一个不可建目录的数据根上，写入失败仍是 {ok:false,error} 而不是抛错', () => {
    silenceWarn()
    const root = base()
    writeFileSync(join(root, 'blocker'), 'not a directory')
    const decrypted = join(root, 'blocker', 'decrypted')

    const inserted = insertTask(decrypted, { title: 't' })
    expect(inserted.ok).toBe(false)
    expect(inserted.error).toContain(CANTOPEN)
    // 也没有把「半开的库」留下来
    expect(existsSync(join(root, 'blocker', 'wechat_tasks.db'))).toBe(false)
  })
})
