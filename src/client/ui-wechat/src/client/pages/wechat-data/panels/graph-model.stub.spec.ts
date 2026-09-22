/**
 * L14：知识库 stub 节点（被 `[[目标]]` 引用、但没有对应笔记）—— **既有实现的行为锁定**。
 *
 * 结论先说：这一条在源码里**已经是实现**而不是 stub 占位（L14 行给的 `graph-model.ts:26`
 * 是文档写下时的行号，现在那一行是 `isFriend?: boolean`）。为避免「已被实现」随下次重构
 * 悄悄退化，这里用 `buildKnowledgeNetwork` 把契约钉住：id 命名空间 `kb:`、
 * `kind/stub/community/weight/backLinks/excerpt`、**不参与 nodeLimit 截断**、以及 wiki 边不断链。
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import { edgeDensityCap } from './graph-budget.ts'
import { DEFAULT_GRAPH_SETTINGS, buildKnowledgeNetwork } from './graph-model.ts'
import type { KnowledgeSnapshot } from '../types.ts'

/** 2 篇笔记 + 3 个 stub（其中 rust 被 6 处引用，用于验证 weight 封顶）。 */
function snapshot(): KnowledgeSnapshot {
  const note = (id: number, title: string, extra: Partial<KnowledgeSnapshot['notes'][number]> = {}): KnowledgeSnapshot['notes'][number] => ({
    id, title, excerpt: '', tags: [], sourceKind: 'manual' as const,
    createdAt: id, updatedAt: id, outLinks: 1, backLinks: 0, ...extra,
  })
  return {
    notes: [note(1, '笔记一', { outLinks: 3 }), note(2, '笔记二', { backLinks: 1, sourceKind: 'ask', sourceUsername: 'wxid_a' })],
    stubs: [
      { key: 'kubectl', label: 'kubectl', refCount: 3, referencedBy: [1] },
      { key: 'observability', label: 'observability', refCount: 1, referencedBy: [2] },
      { key: 'rust', label: 'rust', refCount: 6, referencedBy: [1, 2] },
    ],
    edges: [
      { source: 'note:1', target: 'kb:kubectl', weight: 1, kind: 'wiki' },
      { source: 'note:1', target: 'kb:rust', weight: 2, kind: 'wiki' },
      { source: 'note:2', target: 'kb:observability', weight: 1, kind: 'wiki' },
      { source: 'note:1', target: 'note:2', weight: 1, kind: 'wiki' },
    ],
    sessionNames: { wxid_a: '甲' },
    docFiles: [],
    docSections: [],
    docEntities: [],
    summary: { noteCount: 2, linkCount: 4, stubCount: 3, orphanCount: 0, askCount: 1, manualCount: 1, fileCount: 0, sectionCount: 0, entityCount: 0 },
  }
}

const SETTINGS = { ...DEFAULT_GRAPH_SETTINGS, mode: 'knowledge' as const, nodeLimit: 50 }

describe('L14 知识库 stub 节点', () => {
  it('每个未解析的 [[目标]] 都成为 kb: 前缀的 stub 节点（不与他人 id 撞）', () => {
    const g = buildKnowledgeNetwork(snapshot(), SETTINGS)
    const stubs = g.nodes.filter(n => n.kind === 'stub')
    expect(stubs.map(n => n.id)).toEqual(['kb:kubectl', 'kb:observability', 'kb:rust'])
    expect(stubs.map(n => n.label)).toEqual(['kubectl', 'observability', 'rust'])
    expect(stubs.every(n => n.stub === true)).toBe(true)
  })

  it('画布依赖的字段：中性灰（community = -1）、截断掉的小圆点、反链数与提示文案', () => {
    const g = buildKnowledgeNetwork(snapshot(), SETTINGS)
    for (const n of g.nodes.filter(x => x.kind === 'stub')) {
      expect(n.community).toBe(-1) // 画布据它取中性灰，而不是分进某个圈子
      expect(n.radius).toBe(12)
    }
    const byId = new Map(g.nodes.map(n => [n.id, n]))
    expect(byId.get('kb:kubectl')).toMatchObject({ weight: 100, backLinks: 3, excerpt: '被 3 处引用，尚无同名笔记' })
    expect(byId.get('kb:observability')).toMatchObject({ weight: 60, backLinks: 1 })
    // refCount 越高越显眼，但封顶（40 + min(refCount*20, 200)）
    expect(byId.get('kb:rust')).toMatchObject({ weight: 160, backLinks: 6 })
  })

  it('wiki 边不断链：指向 stub 的边在两侧节点都存在时保留', () => {
    const g = buildKnowledgeNetwork(snapshot(), SETTINGS)
    const ids = new Set(g.nodes.map(n => n.id))
    const wiki = g.edges.filter(e => e.kind === 'wiki')
    expect(wiki).toHaveLength(4)
    expect(wiki.every(e => ids.has(e.source) && ids.has(e.target))).toBe(true)
    expect(wiki.filter(e => e.target.startsWith('kb:')).map(e => e.target))
      .toEqual(['kb:kubectl', 'kb:rust', 'kb:observability'])
  })

  it('stub 不参与 nodeLimit 截断（笔记被截到 1 篇时，3 个缺口提示仍在）', () => {
    const g = buildKnowledgeNetwork(snapshot(), { ...SETTINGS, nodeLimit: 1 })
    expect(g.nodes.filter(n => n.kind === 'note')).toHaveLength(1)
    expect(g.nodes.filter(n => n.kind === 'stub')).toHaveLength(3)
    // 被截掉的笔记所连的边随之消失，但不影响 stub 自身的存在
    expect(g.edges.every(e => e.kind === 'wiki')).toBe(true)
  })

  it('没有知识快照时不造任何 stub（防空转：断言对象真的由数据产生）', () => {
    const empty = buildKnowledgeNetwork(null, SETTINGS)
    expect(empty.nodes).toEqual([])
    // 同一份设置 + 真快照 ⇒ 有 stub，证明上一条不是「怎么调都空」
    expect(buildKnowledgeNetwork(snapshot(), SETTINGS).nodes.length).toBeGreaterThan(0)
  })
})

/* ── 节点来源约束：只来自知识库，不得混入通讯录数据 ─────────────────────────
 *
 * 产品约束（2026-09-18）：知识图谱的节点必须**全部**来源于知识库内容。
 * 早先 `mode='fused'` 会把笔记的来源会话（人/群）拉进同一张图 —— 那是通讯录数据；
 * 该模式已整体删除，`buildKnowledgeNetwork` 也不再接收社交快照（参数从签名上收掉）。
 *
 * 这里锁的不是「某个模式的行为」，而是**从输出反查数据来源**：喂进最容易诱使实现去连人的
 * 那类数据（`sourceKind='ask'` + `sourceUsername` 的问答笔记），产出的节点 id 必须全部落在
 * 知识库的命名空间内，且不存在任何 `source` 边。
 * 若将来有人把社交快照重新接回图里，这条会立刻变红。
 *
 * ⚠ 2026-09-19 文档实体层落地后，命名空间从 2 个变 4 个（多了 `file:` 与 `doc:`）。
 * 白名单**跟着放宽，但防回归的目的不减反增**：这条守卫的原文写的是「防通讯录数据回流」，
 * 而它当初实现成「只准 note:/kb:」，比自己的目的宽 —— 于是把同样属于知识库的文件也一并挡了。
 * 现在改成两半：正向只准四个知识库前缀，反向**显式**列出一切社交侧的 kind 与前缀并断言其不存在。
 * 这样放宽命名空间不会顺手把「防人/群回流」这道闸一起放松。
 */
export function notesWithSourceFriend(): KnowledgeSnapshot {
  const note = (id: number, title: string, extra: Partial<KnowledgeSnapshot['notes'][number]> = {}): KnowledgeSnapshot['notes'][number] => ({
    id, title, excerpt: '', tags: [], sourceKind: 'manual' as const,
    createdAt: id, updatedAt: id, outLinks: 0, backLinks: 0, ...extra,
  })
  return {
    notes: [note(1, '来自问答的笔记', { sourceKind: 'ask', sourceUsername: 'wxid_a' }), note(2, '手写笔记')],
    stubs: [{ key: 'rust', label: 'rust', refCount: 2, referencedBy: [1] }],
    edges: [{ source: 'note:1', target: 'kb:rust', weight: 1, kind: 'wiki' }],
    sessionNames: { wxid_a: '甲' },
    docFiles: [],
    docSections: [],
    docEntities: [],
    summary: { noteCount: 2, linkCount: 1, stubCount: 1, orphanCount: 0, askCount: 1, manualCount: 1, fileCount: 0, sectionCount: 0, entityCount: 0 },
  }
}

/** 知识库侧允许的五个节点命名空间（`ent:` 是 2026-09-20 的推断层）。 */
const KB_NAMESPACES = ['note:', 'kb:', 'file:', 'doc:', 'ent:']
/** 社交侧的节点 kind —— 一个都不该出现在知识图谱里。 */
const SOCIAL_KINDS = ['person', 'group', 'self']
/** 社交侧可能出现的 id 形态（无前缀的 username、`self`、公众号 gh_ 等）。 */
const SOCIAL_ID_PATTERNS = [/^wxid_/, /^gh_/, /^self$/, /^msg:/, /^chat:/, /^contact:/]

describe('知识图谱节点只来自知识库（不含任何知识库之外的数据）', () => {
  it('节点 id 全部落在五个知识库命名空间内（这份夹具只产出 note / stub 两类）', () => {
    const g = buildKnowledgeNetwork(notesWithSourceFriend(), SETTINGS)
    expect(g.nodes.length).toBeGreaterThan(0)
    expect(g.nodes.map(n => n.id).every(id => KB_NAMESPACES.some(p => id.startsWith(p)))).toBe(true)
    expect([...new Set(g.nodes.map(n => n.kind))].sort()).toEqual(['note', 'stub'])
  })

  it('反向守卫：没有任何社交 kind、没有裸 username 节点、没有 source 边', () => {
    const g = buildKnowledgeNetwork(notesWithSourceFriend(), SETTINGS)
    // 这一条是这道闸的**本意**。文档实体层放宽命名空间时，绝不能把它一起放松。
    expect(g.nodes.some(n => SOCIAL_KINDS.includes(n.kind))).toBe(false)
    expect(g.nodes.map(n => n.id).filter(id => SOCIAL_ID_PATTERNS.some(re => re.test(id)))).toEqual([])
    expect(g.nodes.map(n => n.id)).not.toContain('wxid_a')
    expect(g.edges.some(e => e.kind === 'source')).toBe(false)
    expect(g.edges.some(e => e.kind === 'intimacy' || e.kind === 'common' || e.kind === 'class' || e.kind === 'initial')).toBe(false)
    // 「跳回来源聊天」仍在，但它活在笔记详情里(KnowledgeBase 的 onOpenChat)，不是图谱节点
    expect(g.nodes.some(n => n.id === 'note:1')).toBe(true)
  })

  it('防空转:节点确实由知识库内容决定(笔记与 stub 清空 ⇒ 空图)', () => {
    const empty = buildKnowledgeNetwork(
      { ...notesWithSourceFriend(), notes: [], stubs: [], edges: [] },
      SETTINGS,
    )
    expect(empty.nodes).toEqual([])
    // 同一份设置 + 真快照 ⇒ 有节点，证明上一条不是「怎么调都空」
    expect(buildKnowledgeNetwork(notesWithSourceFriend(), SETTINGS).nodes.length).toBeGreaterThan(0)
  })
})

/**
 * 2 篇笔记 + 2 份文件 + 2 个章节（其一跨两份文件）+ 各类边。
 * 模块级：文档层与实体层两组用例共用同一份夹具。
 */
function withDocs(): KnowledgeSnapshot {
  const base = notesWithSourceFriend()
  return {
    ...base,
    edges: [
      ...base.edges,
      { source: 'file:37', target: 'doc:里程碑', weight: 2, kind: 'contain' },
      { source: 'file:38', target: 'doc:里程碑', weight: 1, kind: 'contain' },
      { source: 'file:37', target: 'doc:简介', weight: 1, kind: 'contain' },
      { source: 'note:2', target: 'file:37', weight: 1, kind: 'mention' },
    ],
    docFiles: [
      { id: 37, label: '项目计划书.docx', ext: 'docx', chunkCount: 7, charCount: 4200, parseState: 'ready' },
      { id: 38, label: '验收标准.md', ext: 'md', chunkCount: 3, charCount: 900, parseState: 'ready' },
    ],
    docSections: [
      { key: '里程碑', label: '里程碑', files: [{ id: 37, count: 2 }, { id: 38, count: 1 }], occurrences: 3 },
      { key: '简介', label: '简介', files: [{ id: 37, count: 1 }], occurrences: 1 },
    ],
    summary: { ...base.summary, fileCount: 2, sectionCount: 2 },
  }
}

/* ── 文档实体层（2026-09-19）─────────────────────────────────────────────
 * 图谱原本只画笔记，用户登记的文件一个点都看不见。这一层补的是「文件与文件里的
 * 章节」，所以守卫要钉住四件容易静默退化的事：
 *   ① 一文件一节点，**绝不按 chunk** —— 后端就算误传了块级数据，这里也不该炸图；
 *   ② 章节跨文件合并后是**一个**节点，否则「哪些资料讲同一块内容」还是看不见；
 *   ③ mention 边是推断层，额度只能吃观测层剩下的，绝不能挤掉真实 [[链接]]；
 *   ④ 首帧读的是 localStorage 渲染缓存，旧形状的快照**没有** docFiles 字段 ——
 *      类型上必填、运行期会缺，不兜就是整张图崩。
 */
describe('文档实体层进图', () => {
  it('文件与章节各成节点，id 前缀是 file: / doc:，kind 分别是 file / section', () => {
    const g = buildKnowledgeNetwork(withDocs(), SETTINGS)
    const byId = new Map(g.nodes.map(n => [n.id, n]))
    expect(byId.get('file:37')?.kind).toBe('file')
    expect(byId.get('file:37')?.label).toBe('项目计划书.docx')
    expect(byId.get('file:37')?.fileMeta?.chunkCount).toBe(7)
    expect(byId.get('doc:里程碑')?.kind).toBe('section')
    // 跨两份文件的章节是**一个**节点，带两份来源
    expect(byId.get('doc:里程碑')?.sectionFileIds).toEqual([37, 38])
    expect([...new Set(g.nodes.map(n => n.kind))].sort()).toEqual(['file', 'note', 'section', 'stub'])
  })

  it('contain 与 mention 两类边都进图，且节点仍全部落在知识库命名空间内', () => {
    const g = buildKnowledgeNetwork(withDocs(), SETTINGS)
    expect(g.edges.filter(e => e.kind === 'contain')).toHaveLength(3)
    expect(g.edges.filter(e => e.kind === 'mention')).toHaveLength(1)
    const ids = new Set(g.nodes.map(n => n.id))
    expect(g.edges.every(e => ids.has(e.source) && ids.has(e.target))).toBe(true)
    expect(g.nodes.some(n => SOCIAL_KINDS.includes(n.kind))).toBe(false)
  })

  it('文档族不吃掉笔记额度：nodeLimit=1 时笔记只剩 1 篇，但文档节点照旧存在', () => {
    const g = buildKnowledgeNetwork(withDocs(), { ...SETTINGS, nodeLimit: 1 })
    expect(g.nodes.filter(n => n.kind === 'note')).toHaveLength(1)
    expect(g.nodes.filter(n => n.kind === 'file').length).toBeGreaterThan(0)
  })

  it('旧形状的渲染缓存快照（没有 docFiles / docSections）不会让图崩', () => {
    // 类型上这两个字段是必填的，但 localStorage 里那份缓存可能是改动之前写下的。
    const stale = { ...withDocs() } as unknown as Record<string, unknown>
    delete stale.docFiles
    delete stale.docSections
    const g = buildKnowledgeNetwork(stale as unknown as KnowledgeSnapshot, SETTINGS)
    expect(g.nodes.filter(n => n.kind === 'note')).toHaveLength(2)
    expect(g.nodes.filter(n => n.kind === 'file')).toHaveLength(0)
  })

  it('mention 边是推断层：观测层占满额度时它被裁掉，而 [[链接]] 一条不少', () => {
    const base = withDocs()
    // 造一批真实 [[链接]] 把额度吃满，再看 mention 是否被裁而不是把 wiki 边挤掉
    const many = Array.from({ length: 30 }, (_, i) => ({ ...base.notes[0], id: 100 + i, title: `笔记${i}` }))
    const wikiEdges = many.map(n => ({ source: `note:${n.id}`, target: 'kb:rust', weight: 1, kind: 'wiki' as const }))
    const g = buildKnowledgeNetwork({
      ...base,
      notes: many,
      edges: [...wikiEdges, ...base.edges.filter(e => e.kind !== 'wiki')],
    }, { ...SETTINGS, nodeLimit: 30 })
    const wiki = g.edges.filter(e => e.kind === 'wiki')
    const mention = g.edges.filter(e => e.kind === 'mention')
    expect(wiki.length).toBeGreaterThan(0)
    // 推断层可以被裁到 0，但真实链接一条都不能少
    expect(wiki.length).toBe(wikiEdges.filter(e => g.nodes.some(n => n.id === e.source)).length)
    expect(mention.length).toBeLessThanOrEqual(wiki.length)
  })
})

/* ── 模型实体层（2026-09-20，P4）─────────────────────────────────────────
 * 文件与章节是**观测**（文档里确实有），实体是模型**说**文档里有。这个区别必须落在图上，
 * 否则一次幻觉会以「图谱里有这条线」的形式被用户当成引用依据转述出去。
 * 四件要钉住的事：
 *   ① 实体节点在 `ent:` 命名空间、kind 是 entity、community -1（资料不是圈子）；
 *   ② 连到实体的 suggest 边是推断层，只能吃观测层剩下的额度，且与 mention 同族；
 *   ③ 实体的额度只有文档族的一半 —— 模型多抽一批词，不能把用户自己的文件挤出图；
 *   ④ 旧渲染缓存没有 docEntities 字段（类型必填、运行期会缺），不许崩整张图。
 */
describe('模型实体层进图（推断层的推断层）', () => {
  /** 在文档层之上再加两份文件抽出的三个实体（其一跨两份文件）。 */
  function withEntities(): KnowledgeSnapshot {
    const base = withDocs()
    return {
      ...base,
      docEntities: [
        { key: 'person:张三', label: '张三', kind: 'person', files: [{ id: 37, weight: 90 }, { id: 38, weight: 60 }], occurrences: 2, model: 'deepseek/deepseek-chat', at: 1 },
        { key: 'topic:交付节奏', label: '交付节奏', kind: 'topic', files: [{ id: 37, weight: 50 }], occurrences: 1, model: 'deepseek/deepseek-chat', at: 1 },
      ],
      edges: [
        ...base.edges,
        { source: 'file:37', target: 'ent:person:张三', weight: 90, kind: 'suggest' },
        { source: 'file:38', target: 'ent:person:张三', weight: 60, kind: 'suggest' },
        { source: 'file:37', target: 'ent:topic:交付节奏', weight: 50, kind: 'suggest' },
      ],
      summary: { ...base.summary, entityCount: 2 },
    }
  }

  it('实体节点是 ent: 前缀、kind=entity、中性灰，详情带「模型」字样', () => {
    const g = buildKnowledgeNetwork(withEntities(), SETTINGS)
    const n = g.nodes.find(x => x.id === 'ent:person:张三')
    expect(n?.kind).toBe('entity')
    expect(n?.label).toBe('张三')
    expect(n?.community).toBe(-1)
    expect(n?.sectionFileIds).toEqual([37, 38])
    // 两个分支（跨文件 / 单文件）都必须自报「模型推断」：跨文件那一支少说这几个字，
    // 就会被读成「这几份文件里都写着它」—— 而这是这一层最容易造成误引的读法。
    expect(n?.excerpt).toContain('模型推断')
    expect(n?.excerpt).toContain('deepseek/deepseek-chat')
    // 类别词翻成中文：详情里说「模型推断的人名」而不是裸的 person
    const single = g.nodes.find(x => x.id === 'ent:topic:交付节奏')
    expect(single?.excerpt).toContain('模型推断')
    expect(single?.excerpt).toContain('主题词')
    expect([...new Set(g.nodes.map(x => x.kind))].sort()).toEqual(['entity', 'file', 'note', 'section', 'stub'])
  })

  it('suggest 边进图、两端不断链，且节点仍全部落在知识库命名空间内', () => {
    const g = buildKnowledgeNetwork(withEntities(), SETTINGS)
    const ids = new Set(g.nodes.map(n => n.id))
    const suggest = g.edges.filter(e => e.kind === 'suggest')
    expect(suggest).toHaveLength(3)
    expect(suggest.every(e => ids.has(e.source) && ids.has(e.target))).toBe(true)
    expect(g.nodes.some(n => SOCIAL_KINDS.includes(n.kind))).toBe(false)
    expect(g.nodes.map(n => n.id).filter(id => SOCIAL_ID_PATTERNS.some(re => re.test(id)))).toEqual([])
  })

  it('suggest 与 mention 同属推断层：观测层占满额度时被裁的是它们', () => {
    const base = withEntities()
    const many = Array.from({ length: 30 }, (_, i) => ({ ...base.notes[0], id: 100 + i, title: `笔记${i}` }))
    const wikiEdges = many.map(n => ({ source: `note:${n.id}`, target: 'kb:rust', weight: 1, kind: 'wiki' as const }))
    const g = buildKnowledgeNetwork({
      ...base,
      notes: many,
      edges: [...wikiEdges, ...base.edges.filter(e => e.kind !== 'wiki')],
    }, { ...SETTINGS, nodeLimit: 30 })
    const wiki = g.edges.filter(e => e.kind === 'wiki')
    const inferred = g.edges.filter(e => e.kind === 'mention' || e.kind === 'suggest')
    expect(wiki.length).toBeGreaterThan(0)
    expect(wiki.length).toBe(wikiEdges.filter(e => g.nodes.some(n => n.id === e.source)).length)
    expect(inferred.length).toBeLessThanOrEqual(wiki.length)
    // 边总数不许越过绘制层的密度上限 —— 越过的话画布会从尾部再裁一刀，
    // 而那一刀裁掉谁由数组顺序决定，等于把「谁被画出来」交给运气。
    expect(g.edges.length).toBeLessThanOrEqual(edgeDensityCap(g.nodes.length))
  })

  it('实体不吃文档族的额度：抽一堆长尾词，文件与章节一个不少', () => {
    const base = withEntities()
    const flood = Array.from({ length: 40 }, (_, i) => ({
      key: `topic:词${i}`, label: `词${i}`, kind: 'topic',
      files: [{ id: 37, weight: 1 }], occurrences: 1, model: 'm', at: 1,
    }))
    const g = buildKnowledgeNetwork({ ...base, docEntities: [...base.docEntities, ...flood] }, SETTINGS)
    expect(g.nodes.filter(n => n.kind === 'file').length).toBe(2)
    expect(g.nodes.filter(n => n.kind === 'section').length).toBe(2)
    // 实体额度 = 文档族额度的一半（nodeLimit 50 → doc 25 → ent 12）
    expect(g.nodes.filter(n => n.kind === 'entity').length).toBeLessThanOrEqual(Math.max(10, Math.floor(Math.max(20, Math.floor(50 / 2)) / 2)))
    // 防空转：确实裁掉了一部分，而不是「上限算错所以全留着」
    expect(g.nodes.filter(n => n.kind === 'entity').length).toBeLessThan(42)
  })

  it('旧形状的渲染缓存（没有 docEntities）不会让图崩，其余四类节点照旧', () => {
    const stale = { ...withEntities() } as unknown as Record<string, unknown>
    delete stale.docEntities
    const g = buildKnowledgeNetwork(stale as unknown as KnowledgeSnapshot, SETTINGS)
    expect(g.nodes.filter(n => n.kind === 'entity')).toHaveLength(0)
    expect(g.nodes.filter(n => n.kind === 'file')).toHaveLength(2)
    expect(g.nodes.filter(n => n.kind === 'section')).toHaveLength(2)
    expect(g.edges.filter(e => e.kind === 'suggest')).toHaveLength(0)
  })
})
