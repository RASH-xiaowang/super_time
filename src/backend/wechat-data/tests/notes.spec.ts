/**
 * 笔记库（`wechat_notes.db` / `notes` 表）的 CRUD 与语义契约。
 *
 * 这一层是「知识库」面板与「知识图谱」共用的数据源，而它的**约定**在源码里读不出来、
 * 又只能在特定数据上被打破：
 *   · 标题唯一性按归一化键判定（大小写 / 连续空白都算同名）—— 撞名会让 `[[链接]]`
 *     的解析产生歧义，而界面上只是「保存失败」；
 *   · 更新走「未提供即保持原值」的合并语义 —— 前端只改个标题就会把没传的 `source_kind`
 *     打回 'manual'，一条「问答沉淀」的笔记静默降级，详情里的「跳回来源聊天」入口随之消失；
 *   · `tags` 库里是逗号分隔字符串，取出来才切成数组（trim + 去重）；
 *   · `[[目标|显示]]` 只取目标建边，未命中的目标是**待补**（stub），不是错误；
 *   · 自引用不建边（会成自环），但计入出链数。
 *
 * 读失败路径（`readError`）不在这里：`store-read-error.spec.ts` 已按 N1 口径钉住。
 * @vitest-environment node
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { KbDeleteAction } from '../src/types.ts'
import { buildKnowledgeGraph, createKb, DEFAULT_KB_ID, DEFAULT_KB_NAME, deleteKb, deleteNote, KB_NAME_MAX, listKbs, listNotes, normalizeTitle, parseWikiLinks, renameKb, saveNote } from '../src/query/notes.ts'

const scratch: string[] = []
let clock = 1_700_000_000_000

afterEach(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true })
  scratch.length = 0
  vi.restoreAllMocks()
  clock = 1_700_000_000_000
})

/** 受控时钟：`listNotes` 按 `updated_at DESC` 排序，真实 `Date.now()` 在同一毫秒内
 *  连续保存会并列，排序落到 id 上 —— 那样断言测的就不是「按更新时间倒序」了。 */
function freezeClock(): void {
  vi.spyOn(Date, 'now').mockImplementation(() => clock)
}

/** 造一个临时的 decrypted 数据根（`wechat_notes.db` 建在它的**父目录**）。 */
function root(): string {
  const base = mkdtempSync(join(tmpdir(), 'wx-notes-'))
  scratch.push(base)
  const dir = join(base, 'decrypted')
  mkdirSync(dir)
  return dir
}

/**
 * 本仓库改造前只有一个库：所有既有用例都在**默认库**上跑，换成一处常量，
 * 多库改造就不必把这几十条断言逐个改成「库 1」，回归含义也不变。
 */
const KB = DEFAULT_KB_ID

/** 保存并返回 id（断言 ok，失败时把 error 带进失败信息）。 */
function save(dir: string, input: Parameters<typeof saveNote>[2]): number {
  clock += 1000
  const r = saveNote(dir, KB, input)
  expect(r.ok, `saveNote 失败: ${r.error ?? ''}`).toBe(true)
  return r.id as number
}

/** 同上，但显式指定库（多库用例用）。 */
function saveIn(dir: string, kbId: number, input: Parameters<typeof saveNote>[2]): number {
  clock += 1000
  const r = saveNote(dir, kbId, input)
  expect(r.ok, `saveNote 失败: ${r.error ?? ''}`).toBe(true)
  return r.id as number
}

describe('normalizeTitle / parseWikiLinks：解析口径', () => {
  it('归一化 = 去首尾空白 + 折叠内部空白 + 小写', () => {
    expect(normalizeTitle('  Project   Plan ')).toBe('project plan')
    expect(normalizeTitle('项目\t组')).toBe('项目 组')
    expect(normalizeTitle('   ')).toBe('')
  })

  it('[[目标]] 与 [[目标|显示]] 都取到目标，显示缺省等于目标', () => {
    expect(parseWikiLinks('[[A]] 和 [[B|乙]]')).toEqual([
      { target: 'A', display: 'A' },
      { target: 'B', display: '乙' },
    ])
  })

  it('空目标与跨行的 [[ 不算链接', () => {
    expect(parseWikiLinks('[[|x]]')).toEqual([])
    expect(parseWikiLinks('[[A\nB]]')).toEqual([])
  })

  it('全局正则的 lastIndex 被复位：连调两次结果一致', () => {
    const body = '[[A]] 中间 [[B]]'
    expect(parseWikiLinks(body)).toEqual(parseWikiLinks(body))
  })
})

describe('笔记 CRUD', () => {
  it('新建后可读回，标签切成数组、链接按目标提取', () => {
    const dir = root()
    const id = save(dir, { title: '项目组', body: '交付节奏见 [[里程碑|里程碑清单]]', tags: '项目, 交付' })

    const snap = listNotes(dir, KB)
    expect(snap.total).toBe(1)
    expect(snap.readError).toBeUndefined()
    const note = snap.items[0]
    expect(note?.id).toBe(id)
    expect(note?.title).toBe('项目组')
    expect(note?.tags).toEqual(['项目', '交付'])
    expect(note?.sourceKind).toBe('manual')
    // 只收目标，不收显示文本
    expect(note?.links).toEqual(['里程碑'])
    expect(note?.createdAt).toBeGreaterThan(0)
  })

  it('标签接受数组或逗号字符串，trim 后去重', () => {
    const dir = root()
    const a = save(dir, { title: 'A', tags: [' 甲 ', '乙', '甲'] })
    const b = save(dir, { title: 'B', tags: ' 甲 , 乙 ,甲' })
    const byId = new Map(listNotes(dir, KB).items.map(n => [n.id, n]))
    expect(byId.get(a)?.tags).toEqual(['甲', '乙'])
    expect(byId.get(b)?.tags).toEqual(['甲', '乙'])
  })

  it('更新保持同一个 id，并按更新时间倒序排在首位', () => {
    const dir = root()
    freezeClock()
    const a = save(dir, { title: 'A', body: 'a' })
    const b = save(dir, { title: 'B', body: 'b' })
    expect(listNotes(dir, KB).items.map(n => n.id)).toEqual([b, a])

    clock += 1000
    const r = saveNote(dir, KB, { id: a, title: 'A', body: 'a2' })
    expect(r.ok).toBe(true)
    expect(r.id).toBe(a)
    const items = listNotes(dir, KB).items
    expect(items.map(n => n.id)).toEqual([a, b])
    expect(items[0]?.body).toBe('a2')
    expect(items).toHaveLength(2)
  })

  it('更新「未提供的字段保持原值」：问答沉淀不会被降级成手写', () => {
    const dir = root()
    const id = save(dir, {
      title: '某次提问的沉淀',
      body: '正文',
      tags: '问答',
      sourceKind: 'ask',
      sourceUsername: 'wxid_a',
      sourceQuestion: '这个群谁最活跃？',
    })

    // 只改正文：来源三件套与标签都必须原样保留
    const r = saveNote(dir, KB, { id, title: '某次提问的沉淀', body: '改过的正文' })
    expect(r.ok).toBe(true)
    const note = listNotes(dir, KB).items[0]
    expect(note?.body).toBe('改过的正文')
    expect(note?.sourceKind).toBe('ask')
    expect(note?.sourceUsername).toBe('wxid_a')
    expect(note?.sourceQuestion).toBe('这个群谁最活跃？')
    expect(note?.tags).toEqual(['问答'])
  })

  it('显式传空标签才会清空（与「未提供」区分开）', () => {
    const dir = root()
    const id = save(dir, { title: 'A', tags: 'x,y' })
    expect(saveNote(dir, KB, { id, title: 'A', tags: '' }).ok).toBe(true)
    expect(listNotes(dir, KB).items[0]?.tags).toEqual([])
  })

  it('删除成功后同一 id 再删是失败（不是静默成功）', () => {
    const dir = root()
    const id = save(dir, { title: 'A' })
    expect(deleteNote(dir, KB, id).ok).toBe(true)
    expect(listNotes(dir, KB).total).toBe(0)
    expect(deleteNote(dir, KB, id).ok).toBe(false)
  })

  it('更新不存在的 id 返回失败（标题不撞名，才走得到「不存在」那条）', () => {
    const dir = root()
    save(dir, { title: 'A' })
    // 标题必须**不与已有笔记撞名**：`saveNote` 先查标题唯一性、再查行是否存在，
    // 撞名时返回的是「已存在同名笔记」，这条用例就测不到「笔记不存在」了。
    const r = saveNote(dir, KB, { id: 9999, title: '另一个标题' })
    expect(r.ok).toBe(false)
    expect(r.error).toBe('笔记不存在')
  })

  it('撞名判定优先于「行是否存在」（同一 id 上两者可能同时成立）', () => {
    const dir = root()
    const id = save(dir, { title: 'A' })
    // id 不存在 ≠ 可以复用别人的标题：撞名先被拦下
    expect(saveNote(dir, KB, { id: 9999, title: 'A' })).toMatchObject({ ok: false, error: '已存在同名笔记「A」' })
    // 而 id 存在时引用自己的标题是允许的
    expect(saveNote(dir, KB, { id, title: 'A', body: '改了正文' })).toMatchObject({ ok: true, id })
  })
})

describe('标题唯一性：按归一化键判重', () => {
  it('空标题被拒绝', () => {
    const dir = root()
    expect(saveNote(dir, KB, { title: '   ' }).ok).toBe(false)
    expect(saveNote(dir, KB, { title: '' }).error).toBe('标题不能为空')
    expect(listNotes(dir, KB).total).toBe(0)
  })

  it('大小写与连续空白不同也算同名', () => {
    const dir = root()
    save(dir, { title: 'Project Plan' })
    const dup = saveNote(dir, KB, { title: '  project   plan  ' })
    expect(dup.ok).toBe(false)
    expect(dup.error).toContain('已存在同名笔记')
    expect(listNotes(dir, KB).total).toBe(1)
  })

  it('更新自己不算撞名（同名的是自己）', () => {
    const dir = root()
    const id = save(dir, { title: '项目组' })
    // 改成只差空白/大小写的写法，归一化后仍是自己 → 必须放行
    const r = saveNote(dir, KB, { id, title: ' 项目组 ' })
    expect(r.ok).toBe(true)
    expect(listNotes(dir, KB).total).toBe(1)
  })

  it('撞名时不改动已有笔记（试写的新内容不能落库）', () => {
    const dir = root()
    save(dir, { title: 'A', body: '原正文' })
    saveNote(dir, KB, { title: 'a', body: '不该写进去' })
    const items = listNotes(dir, KB).items
    expect(items).toHaveLength(1)
    expect(items[0]?.body).toBe('原正文')
  })
})

describe('listNotes：关键词过滤与总数', () => {
  it('关键词命中标题 / 正文 / 标签任一处，total 是不分页的总数', () => {
    const dir = root()
    save(dir, { title: '会议纪要', body: '讨论了排期' })
    save(dir, { title: '项目组', body: '交付节奏' })
    save(dir, { title: '随手记', body: '无关内容', tags: '项目' })

    expect(listNotes(dir, KB).total).toBe(3)

    const q1 = listNotes(dir, KB, { query: '项目' })
    expect(q1.total, 'total 是库内总数，不随过滤变').toBe(3)
    expect(q1.items.map(n => n.title).sort()).toEqual(['随手记', '项目组'])

    const q2 = listNotes(dir, KB, { query: '排期' })
    expect(q2.items.map(n => n.title)).toEqual(['会议纪要'])

    expect(listNotes(dir, KB, { query: '不存在的词' }).items).toEqual([])
  })

  it('关键词两侧空白被裁掉；空关键词等价于不过滤', () => {
    const dir = root()
    save(dir, { title: 'A' })
    expect(listNotes(dir, KB, { query: '   ' }).items).toHaveLength(1)
    expect(listNotes(dir, KB, { query: '  A  ' }).items).toHaveLength(1)
  })

  it('limit 生效但下限被夹到 1', () => {
    const dir = root()
    save(dir, { title: 'A' })
    save(dir, { title: 'B' })
    expect(listNotes(dir, KB, { limit: 1 }).items).toHaveLength(1)
    expect(listNotes(dir, KB, { limit: 0 }).items).toHaveLength(1)
    expect(listNotes(dir, KB, { limit: -5 }).items).toHaveLength(1)
  })
})

describe('buildKnowledgeGraph：节点 / 实线边 / 待补节点', () => {
  it('命中已有标题建 wiki 边，未命中建 stub', () => {
    const dir = root()
    const a = save(dir, { title: '总览', body: '细节见 [[项目组]]，另见 [[还没写的那篇]]' })
    const b = save(dir, { title: '项目组', body: '随便写点' })

    const g = buildKnowledgeGraph(dir, KB, new Map([['wxid_a', '好友甲']]))
    expect(g.readError).toBeUndefined()
    expect(g.summary.noteCount).toBe(2)

    const wiki = g.edges.filter(e => e.kind === 'wiki')
    expect(wiki).toHaveLength(1)
    expect(wiki[0]).toMatchObject({ source: `note:${a}`, target: `note:${b}`, weight: 1 })

    const stub = g.edges.filter(e => e.kind === 'stub')
    expect(stub).toHaveLength(1)
    expect(stub[0]?.target).toBe('kb:' + normalizeTitle('还没写的那篇'))
    expect(g.stubs.map(s => s.label)).toEqual(['还没写的那篇'])
    expect(g.stubs[0]?.referencedBy).toEqual([a])
  })

  it('自引用不建边（成环），但计入出链数', () => {
    const dir = root()
    const id = save(dir, { title: '自己', body: '见 [[自己]]' })
    const g = buildKnowledgeGraph(dir, KB, new Map())
    expect(g.edges.filter(e => e.source === `note:${id}` && e.target === `note:${id}`)).toEqual([])
    expect(g.notes.find(n => n.id === id)?.outLinks).toBe(1)
    expect(g.notes.find(n => n.id === id)?.backLinks).toBe(0)
  })

  it('同一目标被引用多次时 weight 累加（边只建一条）', () => {
    const dir = root()
    const a = save(dir, { title: 'A', body: '[[B]] [[B]] [[b]]' })
    const b = save(dir, { title: 'B' })
    const g = buildKnowledgeGraph(dir, KB, new Map())
    const wiki = g.edges.filter(e => e.kind === 'wiki')
    expect(wiki).toHaveLength(1)
    expect(wiki[0]).toMatchObject({ source: `note:${a}`, target: `note:${b}`, weight: 3 })
    expect(g.notes.find(n => n.id === b)?.backLinks).toBe(1)
  })

  it('孤立节点计入 orphan，来源会话名从传入的映射取', () => {
    const dir = root()
    const solo = save(dir, { title: '孤零零' })
    const ask = save(dir, { title: '问答沉淀', sourceKind: 'ask', sourceUsername: 'wxid_a', body: '[[孤零零]]' })

    const g = buildKnowledgeGraph(dir, KB, new Map([['wxid_a', '好友甲']]))
    const orphan = g.notes.find(n => n.id === solo)
    // 被 ask 那篇链上了 → 不是孤立节点
    expect(orphan?.backLinks).toBe(1)
    expect(g.summary.orphanCount).toBe(0)
    expect(g.summary.askCount).toBe(1)
    expect(g.summary.manualCount).toBe(1)
    expect(g.sessionNames['wxid_a']).toBe('好友甲')
    expect(ask).toBeGreaterThan(0)
  })

  it('删除被引用的一篇后，指向它的链接退化为待补（不是丢失）', () => {
    const dir = root()
    const a = save(dir, { title: 'A', body: '见 [[B]]' })
    const b = save(dir, { title: 'B' })
    expect(buildKnowledgeGraph(dir, KB, new Map()).edges.filter(e => e.kind === 'wiki')).toHaveLength(1)

    expect(deleteNote(dir, KB, b).ok).toBe(true)
    const g = buildKnowledgeGraph(dir, KB, new Map())
    expect(g.edges.filter(e => e.kind === 'wiki')).toHaveLength(0)
    expect(g.edges.filter(e => e.kind === 'stub').map(e => e.target)).toEqual(['kb:' + normalizeTitle('B')])
    expect(g.stubs[0]?.referencedBy).toEqual([a])
  })
})


describe('多知识库：库内唯一 / 跨库隔离', () => {
  it('同一标题在不同库里各存一份都成功（唯一性只在库内）', () => {
    const dir = root()
    const other = createKb(dir, '工作')
    expect(other.ok).toBe(true)
    const kb2 = other.id as number

    const a = saveIn(dir, KB, { title: '项目组', body: '默认库那篇' })
    const b = saveIn(dir, kb2, { title: '项目组', body: '工作库那篇' })

    expect(a).not.toBe(b)
    expect(listNotes(dir, KB).items.map(n => n.body)).toEqual(['默认库那篇'])
    expect(listNotes(dir, kb2).items.map(n => n.body)).toEqual(['工作库那篇'])
    // total 只算本库：改前是 COUNT(*)，多库之后会显示成跨库数字
    expect(listNotes(dir, KB).total).toBe(1)
    expect(listNotes(dir, kb2).total).toBe(1)
    expect(a).toBeGreaterThan(0)
  })

  it('同一库内撞名仍然被拒（否则 [[链接]] 会有歧义）', () => {
    const dir = root()
    const work = createKb(dir, '工作')
    const kb2 = work.id as number
    saveIn(dir, kb2, { title: 'Project Plan' })
    expect(saveNote(dir, kb2, { title: '  project   plan  ' })).toMatchObject({ ok: false })
    expect(listNotes(dir, kb2).total).toBe(1)
  })

  it('[[链接]] 只在本库解析：跨库同名不会被连上', () => {
    const dir = root()
    const work = createKb(dir, '工作')
    const kb2 = work.id as number
    const target = saveIn(dir, kb2, { title: '里程碑' })
    const a = saveIn(dir, KB, { title: '总览', body: '见 [[里程碑]]' })

    // 默认库里没有「里程碑」→ 只能是待补节点，**不能**连到工作库那一篇
    const g1 = buildKnowledgeGraph(dir, KB, new Map())
    expect(g1.notes.map(n => n.id)).toEqual([a])
    expect(g1.edges.map(e => e.kind)).toEqual(['stub'])
    expect(g1.stubs.map(s => s.label)).toEqual(['里程碑'])

    // 工作库里那一篇是孤立节点：图上不存在来自默认库的边
    const g2 = buildKnowledgeGraph(dir, kb2, new Map())
    expect(g2.notes.map(n => n.id)).toEqual([target])
    expect(g2.edges).toEqual([])
  })

  it('deleteNote 带错库不会删掉别的库那一篇', () => {
    const dir = root()
    const work = createKb(dir, '工作')
    const kb2 = work.id as number
    const id = saveIn(dir, kb2, { title: '工作笔记' })

    expect(deleteNote(dir, KB, id).ok).toBe(false)
    expect(listNotes(dir, kb2).total).toBe(1)
    expect(deleteNote(dir, kb2, id).ok).toBe(true)
    expect(listNotes(dir, kb2).total).toBe(0)
  })

  it('saveNote 用另一库的 id 更新 → 「笔记不存在」，不串库', () => {
    const dir = root()
    const work = createKb(dir, '工作')
    const kb2 = work.id as number
    const id = saveIn(dir, kb2, { title: '工作笔记', body: '原文' })

    expect(saveNote(dir, KB, { id, title: '工作笔记', body: '被改了' })).toMatchObject({ ok: false, error: '笔记不存在' })
    expect(listNotes(dir, kb2).items[0]?.body).toBe('原文')
  })

  it('笔记 id 非法也被拒（而不是 SQLite 绑定错误）', () => {
    const dir = root()
    const id = save(dir, { title: 'A' })
    for (const bad of [0, -1, Number.NaN, undefined as unknown as number]) {
      expect(deleteNote(dir, KB, bad)).toMatchObject({ ok: false, error: '笔记标识无效' })
    }
    // 一次都没删掉，合法 id 仍然可删
    expect(listNotes(dir, KB).total).toBe(1)
    expect(deleteNote(dir, KB, id).ok).toBe(true)
    expect(listNotes(dir, KB).total).toBe(0)
  })

  it('kbId 缺失 / 非法一律拒绝，不静默落到某个库', () => {
    const dir = root()
    for (const bad of [0, -1, Number.NaN, undefined as unknown as number]) {
      expect(listNotes(dir, bad).readError).toContain('知识库标识无效')
      expect(listNotes(dir, bad).items).toEqual([])
      expect(saveNote(dir, bad, { title: 'X' }).ok).toBe(false)
      expect(deleteNote(dir, bad, 1).ok).toBe(false)
      expect(buildKnowledgeGraph(dir, bad, new Map()).notes).toEqual([])
      expect(buildKnowledgeGraph(dir, bad, new Map()).readError).toContain('知识库标识无效')
    }
    // 1.5 会被收敛成 1（合法），因此断言它**不**报「标识无效」
    expect(listNotes(dir, 1.5).readError).toBeUndefined()
  })

  it('库不存在时读到的是「库没了」而不是「库是空的」', () => {
    const dir = root()
    expect(listNotes(dir, 999).readError).toContain('知识库不存在')
    expect(listNotes(dir, 999).total).toBe(0)
    expect(buildKnowledgeGraph(dir, 999, new Map()).readError).toContain('知识库不存在')
    // 写路径同样要挡：否则会在一个「不存在的库」里生下一条笔记（kb_id 指向没人认领的库），
    // 列表里看不到、图上也画不出 —— 用户只看到一句「保存成功」。
    expect(saveNote(dir, 999, { title: '孤儿' })).toMatchObject({
      ok: false,
      error: '知识库不存在（可能已被删除），请重新选择',
    })
    expect(listKbs(dir).items.map(k => k.id)).toEqual([KB])
  })
})

describe('多知识库：增删改与计数', () => {
  it('listKbs 按 id 升序，noteCount 按库统计', () => {
    const dir = root()
    const first = listKbs(dir)
    expect(first.readError).toBeUndefined()
    expect(first.items.map(k => k.id)).toEqual([KB])
    expect(first.items[0]?.name).toBe(DEFAULT_KB_NAME)
    expect(first.items[0]?.noteCount).toBe(0)

    save(dir, { title: 'A' })
    const work = createKb(dir, '工作')
    const kb2 = work.id as number
    saveIn(dir, kb2, { title: 'B' })
    saveIn(dir, kb2, { title: 'C' })

    const list = listKbs(dir)
    expect(list.items.map(k => k.id)).toEqual([KB, kb2])
    expect(list.items.map(k => k.noteCount)).toEqual([1, 2])
    expect(list.total).toBe(2)
  })

  it('createKb 拒绝空名 / 超长 / 与既有库同名（含归一化同名）', () => {
    const dir = root()
    expect(createKb(dir, '   ')).toMatchObject({ ok: false })
    expect(createKb(dir, 'x'.repeat(KB_NAME_MAX + 1)).ok).toBe(false)
    expect(createKb(dir, '工作').ok).toBe(true)
    expect(createKb(dir, ' 工作 ')).toMatchObject({ ok: false })
    // 与**默认库**同名也算重复
    expect(createKb(dir, DEFAULT_KB_NAME)).toMatchObject({ ok: false })
    // 库名只跟库名比，跟笔记标题无关
    expect(createKb(dir, '随便一个笔记标题').ok).toBe(true)
  })

  it('renameKb 只改名字，不动任何笔记', () => {
    const dir = root()
    const work = createKb(dir, '工作')
    const kb2 = work.id as number
    const id = saveIn(dir, kb2, { title: '笔记', body: '正文' })

    expect(renameKb(dir, kb2, '项目')).toMatchObject({ ok: true, id: kb2 })
    expect(listKbs(dir).items.find(k => k.id === kb2)?.name).toBe('项目')
    const note = listNotes(dir, kb2).items[0]
    expect(note?.id).toBe(id)
    expect(note?.kbId).toBe(kb2)
    expect(note?.body).toBe('正文')
  })

  it('renameKb 撞名被拒；改成自己（或仅空白差异）可以；库不存在被拒', () => {
    const dir = root()
    const work = createKb(dir, '工作')
    const kb2 = work.id as number
    expect(renameKb(dir, kb2, DEFAULT_KB_NAME)).toMatchObject({ ok: false })
    expect(renameKb(dir, 999, '别的')).toMatchObject({ ok: false })
    expect(renameKb(dir, kb2, '工作 ').ok).toBe(true)
  })

  it('deleteKb：默认库不可删（它是迁移兜底）', () => {
    const dir = root()
    expect(deleteKb(dir, KB, { kind: 'purge' })).toMatchObject({ ok: false })
    expect(listKbs(dir).items.map(k => k.id)).toEqual([KB])
  })

  it('deleteKb reassign：笔记整体搬到目标库，源库消失', () => {
    const dir = root()
    const work = createKb(dir, '工作')
    const kb2 = work.id as number
    const a = saveIn(dir, kb2, { title: 'A' })
    const b = saveIn(dir, kb2, { title: 'B' })

    expect(deleteKb(dir, kb2, { kind: 'reassign', targetKbId: KB })).toMatchObject({ ok: true, movedNotes: 2 })
    expect(listKbs(dir).items.map(k => k.id)).toEqual([KB])
    expect(listNotes(dir, KB).items.map(n => n.id).sort()).toEqual([a, b].sort())
    // 搬过去之后要在**新库**里可被解析（kb_id 真的改了，不是只改了库表）
    expect(buildKnowledgeGraph(dir, KB, new Map()).notes).toHaveLength(2)
  })

  it('deleteKb reassign：目标库已有同名条目 → 整体拒绝，两边都不动', () => {
    const dir = root()
    const work = createKb(dir, '工作')
    const kb2 = work.id as number
    save(dir, { title: '项目组' })
    saveIn(dir, kb2, { title: ' 项目组 ' })

    const r = deleteKb(dir, kb2, { kind: 'reassign', targetKbId: KB })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('项目组')
    expect(listKbs(dir).items.map(k => k.id)).toEqual([KB, kb2])
    expect(listNotes(dir, kb2).total).toBe(1)
    expect(listNotes(dir, KB).total).toBe(1)
  })

  it('deleteKb purge：笔记一并删除，别的库不受影响', () => {
    const dir = root()
    const work = createKb(dir, '工作')
    const kb2 = work.id as number
    save(dir, { title: '留下' })
    saveIn(dir, kb2, { title: '带走' })

    expect(deleteKb(dir, kb2, { kind: 'purge' })).toMatchObject({ ok: true, removedNotes: 1 })
    expect(listKbs(dir).items.map(k => k.id)).toEqual([KB])
    expect(listNotes(dir, KB).items.map(n => n.title)).toEqual(['留下'])
  })

  it('deleteKb 的 action 缺失 / 不可识别一律拒绝（后端不给默认动作）', () => {
    const dir = root()
    const work = createKb(dir, '工作')
    const kb2 = work.id as number
    saveIn(dir, kb2, { title: 'A' })

    expect(deleteKb(dir, kb2, undefined as unknown as KbDeleteAction)).toMatchObject({ ok: false })
    expect(deleteKb(dir, kb2, { kind: 'nope' } as unknown as KbDeleteAction)).toMatchObject({ ok: false })
    // 两次都没删掉任何东西
    expect(listNotes(dir, kb2).total).toBe(1)
    expect(listKbs(dir).items.map(k => k.id)).toEqual([KB, kb2])
  })
})

describe('多知识库：迁移幂等', () => {
  it('老库（没有 kbs / kb_id）被就地迁移：历史笔记全部落进默认库', () => {
    const dir = root()
    const file = join(dir, '..', 'wechat_notes.db')
    const db = new DatabaseSync(file)
    // 改造前的原始 schema：没有 kb_id，也没有 kbs 表
    db.exec(
      "CREATE TABLE notes (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', tags TEXT NOT NULL DEFAULT '', source_kind TEXT NOT NULL DEFAULT 'manual', source_username TEXT NOT NULL DEFAULT '', source_question TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)",
    )
    db.prepare(
      'INSERT INTO notes(title, body, tags, source_kind, source_username, source_question, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run('老笔记', '正文', '', 'manual', '', '', 1, 1)
    db.close()

    const kbs = listKbs(dir)
    expect(kbs.readError).toBeUndefined()
    expect(kbs.items.map(k => k.id)).toEqual([KB])
    expect(kbs.items[0]?.noteCount).toBe(1)

    const snap = listNotes(dir, KB)
    expect(snap.readError).toBeUndefined()
    expect(snap.items.map(n => n.title)).toEqual(['老笔记'])
    expect(snap.items[0]?.kbId).toBe(KB)

    // 再开一次库：默认库不会重复插入，笔记也不会被搬走
    expect(listKbs(dir).items).toHaveLength(1)
    expect(listKbs(dir).items[0]?.noteCount).toBe(1)
  })

  it('kbs 表存在但缺默认库行时，开库会把它补回来', () => {
    const dir = root()
    const file = join(dir, '..', 'wechat_notes.db')
    const db = new DatabaseSync(file)
    db.exec('CREATE TABLE kbs (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)')
    db.close()
    expect(listKbs(dir).items.map(k => k.id)).toEqual([KB])
    expect(listNotes(dir, KB).readError).toBeUndefined()
  })
})
