/**
 * 问答检索工具集的判据（2026-10-16 新增）。
 *
 * ## 为什么这些判据重要
 *
 * 工具集是**给模型用的接口**。它的失效方式与普通函数不同：
 *   · 工具**从清单里消失** → 模型以为「没有这个能力」，于是用别的工具硬凑
 *     （实测：没有聚合工具时，模型从 10 条片段里「数出」14 条，真实 282 条）；
 *   · 参数**形状不对** → 模型填错，而表现是**静默返回空**（不是报错）；
 *   · `run` **抛错** → 整次问答崩掉（而工具层的约定是「不抛错」）。
 *
 * 这三类都不会被「跑一遍问答」发现（问答照样出答案，只是答案不对），
 * 所以必须单独钉住。
 *
 * @vitest-environment node
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { allTools, buildTools, runTool, toolSchemas, TOOL_NAMES } from '../src/query/tools/index.ts'
import { argInt, argString, argStringArray, findTool } from '../src/query/tools/types.ts'
import { buildAskTools, askToolContext } from '../src/remotes/ask-retrieval.ts'
import { bigramTokens, INDEX_SCHEMA_VERSION } from '../src/query/search-scaffold.ts'

const scratch: string[] = []
afterEach(() => {
  for (const d of scratch.splice(0)) { try { rmSync(d, { recursive: true, force: true }) } catch { /* ignore */ } }
})

/** 造一个最小的数据目录（含索引库与通讯录库）。 */
function makeDataDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'tools-'))
  scratch.push(root)
  const dec = join(root, 'decrypted')
  mkdirSync(join(dec, 'contact'), { recursive: true })
  mkdirSync(join(dec, 'message'), { recursive: true })
  const db = new DatabaseSync(join(root, 'wechat_search.db'))
  db.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)')
  db.exec('CREATE TABLE message_meta (rowid INTEGER PRIMARY KEY, text TEXT, username TEXT, local_id INTEGER, create_time INTEGER, sender TEXT NOT NULL DEFAULT \'\')')
  db.exec('CREATE TABLE contact_fts (username TEXT, name TEXT, remark TEXT, alias TEXT, quanpin TEXT, local_type INTEGER)')
  // 自建 BM25 索引（`search_messages` 走它；只有 message_meta 的话检索会返回空）。
  db.exec("CREATE VIRTUAL TABLE message_fts USING fts5(tokens, who, tokenize='unicode61', content='')")
  // `indexReady` 要求 schema_version 匹配，否则整条索引路径被跳过。
  db.prepare('INSERT INTO meta(key, value) VALUES(?, ?)').run('schema_version', String(INDEX_SCHEMA_VERSION))
  const ins = db.prepare('INSERT INTO message_meta VALUES (?,?,?,?,?,?)')
  const insFts = db.prepare('INSERT INTO message_fts(rowid, tokens, who) VALUES(?,?,?)')
  const rows: Array<[number, string, string, number, number, string]> = [
    [1, '微信转账 收到转账1500.00元', 'wxid_a', 1, 1700000000, ''],
    [2, '微信转账 收到转账200.00元', 'wxid_a', 2, 1700000100, ''],
    // 群消息带 sender（构建时从群前缀切出的原始 wxid）—— 检索侧据此显示「谁说的」。
    [3, '今天开会讨论合同', '123@chatroom', 3, 1700000200, 'wxid_a'],
    [4, '合同差额是2000', '123@chatroom', 4, 1700000300, 'wxid_a'],
  ]
  for (const r of rows) {
    ins.run(...r)
    // tokens 用与构建侧**同一个**切分函数（自己写一份必然与检索侧对不上）。
    insFts.run(r[0], bigramTokens(r[1]), r[2])
  }
  db.prepare('INSERT INTO contact_fts VALUES (?,?,?,?,?,?)').run('wxid_a', '房东', '房东老陈', 'chen123', 'fangdong', 3)
  db.close()
  // 通讯录库（`get_contact_detail` 走它）。
  const cdb = new DatabaseSync(join(dec, 'contact', 'contact.db'))
  cdb.exec('CREATE TABLE contact (id INTEGER, username TEXT, local_type INTEGER, alias TEXT, remark TEXT, nick_name TEXT, description TEXT)')
  cdb.prepare('INSERT INTO contact VALUES (?,?,?,?,?,?,?)').run(1, 'wxid_a', 3, 'chen123', '房东老陈', '房东', '')
  cdb.close()
  return dec
}

describe('工具集：清单与 schema', () => {
  it('工具名唯一且覆盖各类数据操作', () => {
    const names = allTools.map(t => t.name)
    expect(new Set(names).size, '有重名工具（模型按名字调用，重名会调错）').toBe(names.length)
    // 各类操作都必须有工具 —— 缺一类就意味着那类问题只能靠别的工具硬凑
    for (const n of [
      'search_messages', 'search_semantic', 'aggregate_messages',
      'list_sessions', 'get_session_messages', 'get_message_context',
      'search_contacts', 'get_contact_detail',
      'search_moments', 'search_favorites', 'search_files', 'search_records',
      'search_kb',
    ]) {
      expect(names, `缺少工具 ${n}`).toContain(n)
    }
    expect(TOOL_NAMES).toEqual(names)
  })

  it('每个工具都有面向模型的说明与合法 JSON Schema', () => {
    for (const t of allTools) {
      expect(t.description.length, `${t.name} 的说明太短（模型靠它决定何时用）`).toBeGreaterThan(20)
      expect(t.parameters['type'], `${t.name} 的 parameters 不是 object schema`).toBe('object')
      const props = t.parameters['properties']
      expect(props, `${t.name} 没有 properties`).toBeTruthy()
      expect(typeof props).toBe('object')
    }
  })

  it('投影成模型 schema 时字段齐全（name/description/parameters）', () => {
    const schemas = toolSchemas()
    expect(schemas.length).toBe(allTools.length)
    for (const s of schemas) {
      expect(typeof s.name).toBe('string')
      expect(typeof s.description).toBe('string')
      expect(typeof s.parameters).toBe('object')
    }
  })

  it('语义检索工具在没注入 embedFn 时**仍然存在**（只是执行时如实报错）', () => {
    // 从清单里消失会让模型以为「没有这个能力」，而实际是「这次没配」——
    // 两者的处置完全不同（前者换工具，后者去配置）。
    const tools = buildTools()
    expect(findTool(tools, 'search_semantic'), '没注入 embedFn 时工具不该消失').toBeTruthy()
  })
})

describe('工具执行：不可信输入与错误兜底', () => {
  it('不存在的工具名返回 ok:false 而不是抛错', async () => {
    const r = await runTool(allTools, 'no_such_tool', {}, { decryptedDir: '/nope' })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('没有这个工具')
    expect(r.hits).toEqual([])
  })

  it('参数形状不可信时不抛错（null / 数字 / 对象都当缺失处理）', async () => {
    const dec = makeDataDir()
    for (const bad of [null, 123, { a: 1 }, undefined]) {
      const r = await runTool(allTools, 'search_messages', { keywords: bad } as Record<string, unknown>, { decryptedDir: dec })
      expect(r.ok, `keywords=${JSON.stringify(bad)} 时不该 ok`).toBe(false)
      expect(r.hits).toEqual([])
    }
  })

  it('数据目录不存在时不抛错（降级成空结果，而不是崩掉整次问答）', async () => {
    const r = await runTool(allTools, 'search_messages', { keywords: ['转账'] }, { decryptedDir: join(tmpdir(), 'no-such-' + String(Date.now())) })
    // 检索类工具在数据缺失时**降级成空结果**（ok:true + hits:[]）而不是报错 ——
    // 与其余通道同策略：一个数据源不可用不该让整次问答失败。
    expect(r.hits).toEqual([])
    expect(r.ok).toBe(true)
  })

  it('需要具体数据源的工具在数据缺失时如实报错（而不是静默空结果）', async () => {
    const missing = join(tmpdir(), 'no-such-' + String(Date.now()))
    // 这几个工具没有「降级成空」的语义：库不存在就是查不了，必须说清楚。
    for (const [name, args] of [
      ['get_session_messages', { username: 'x' }],
      ['list_sessions', {}],
      ['get_contact_detail', { username: 'x' }],
    ] as Array<[string, Record<string, unknown>]>) {
      const r = await runTool(allTools, name, args, { decryptedDir: missing })
      expect(r.ok, `${name} 在数据缺失时不该 ok`).toBe(false)
      expect(r.error, `${name} 没给出失败原因`).toBeTruthy()
    }
  })

  it('工具抛错时被外层兜住（约定「不抛错」是约定，不是保证）', async () => {
    const boom = {
      name: 'search_messages' as const, category: 'message' as const,
      description: 'x'.repeat(30), parameters: { type: 'object', properties: {} },
      run: (): never => { throw new Error('boom-测试用') },
    }
    const r = await runTool([boom], 'search_messages', {}, { decryptedDir: '/nope' })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('boom-测试用')
  })
})

describe('工具执行：真实数据路径', () => {
  it('search_messages 命中并带 key/name/time/snippet', async () => {
    const dec = makeDataDir()
    const r = await runTool(allTools, 'search_messages', { keywords: ['转账'] }, { decryptedDir: dec })
    expect(r.ok).toBe(true)
    expect(r.hits.length).toBeGreaterThan(0)
    for (const h of r.hits) {
      expect(h.key).toMatch(/^.+:\d+$/)
      expect(h.name).toBeTruthy()
      expect(h.snippet).toBeTruthy()
      expect(h.source).toBe('msg')
    }
  })

  it('search_messages 的时间范围是硬过滤（填了就该生效）', async () => {
    const dec = makeDataDir()
    // 数据都在 2023-11-14；限定到 2024 年应当 0 条
    const r = await runTool(allTools, 'search_messages', { keywords: ['转账'], from: '2024-01-01', to: '2024-12-31' }, { decryptedDir: dec })
    expect(r.ok).toBe(true)
    expect(r.hits, '时间范围没生效 ⇒ 用户限定日期后仍拿到范围外的结果').toEqual([])
  })

  it('aggregate_messages 返回 facts（确定性统计）而不是 hits', async () => {
    const dec = makeDataDir()
    const r = await runTool(allTools, 'aggregate_messages', { dimension: 'keyword', keywords: ['转账'] }, { decryptedDir: dec })
    expect(r.ok).toBe(true)
    expect(r.facts, '聚合工具必须给 facts（模型据此直接回答）').toBeTruthy()
    expect(r.facts!.length).toBeGreaterThan(0)
    expect(r.facts![0]!.body).toContain('转账')
    // 聚合结果不是「原文片段」，不该混进 hits
    expect(r.hits).toEqual([])
  })

  it('aggregate_messages 的 session 维度给出按会话排名', async () => {
    const dec = makeDataDir()
    const r = await runTool(allTools, 'aggregate_messages', { dimension: 'session' }, { decryptedDir: dec })
    expect(r.ok).toBe(true)
    expect(r.facts![0]!.title).toContain('按会话统计')
    expect(r.facts![0]!.body).toContain('123@chatroom')
  })

  it('list_sessions 按消息数排序并带条数', async () => {
    const dec = makeDataDir()
    const r = await runTool(allTools, 'list_sessions', { orderBy: 'count' }, { decryptedDir: dec })
    expect(r.ok).toBe(true)
    expect(r.hits.length).toBe(2)
    expect(r.hits[0]!.snippet).toContain('条消息')
  })

  it('get_session_messages 按会话取消息（升序）', async () => {
    const dec = makeDataDir()
    const r = await runTool(allTools, 'get_session_messages', { username: '123@chatroom' }, { decryptedDir: dec })
    expect(r.ok).toBe(true)
    expect(r.hits.length).toBe(2)
    expect(r.hits[0]!.snippet).toContain('开会')
  })

  it('get_message_context 用 key 展开上下文（消息库缺失时降级成空结果）', async () => {
    const dec = makeDataDir()
    const r = await runTool(allTools, 'get_message_context', { key: '123@chatroom:3' }, { decryptedDir: dec })
    // 测试数据里没有 `message/` 下的消息库 ⇒ 窗口展开为空。
    // 这里钉的是「不抛错 + 形状正确」，窗口内容本身由 `loadMessageWindow` 的用例覆盖。
    expect(r.ok).toBe(true)
    expect(Array.isArray(r.hits)).toBe(true)
  })

  it('get_message_context 的 key 形状不对时如实报错', async () => {
    const dec = makeDataDir()
    const r = await runTool(allTools, 'get_message_context', { key: '没有冒号' }, { decryptedDir: dec })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('key 形状')
  })

  it('search_contacts 按备注/昵称/拼音都能命中', async () => {
    const dec = makeDataDir()
    for (const q of ['房东', '老陈', 'fangdong']) {
      const r = await runTool(allTools, 'search_contacts', { query: q }, { decryptedDir: dec })
      expect(r.ok, `「${q}」检索失败`).toBe(true)
      expect(r.hits.length, `「${q}」没命中`).toBeGreaterThan(0)
    }
  })

  it('get_contact_detail 给出档案（含微信号与聊天条数）', async () => {
    const dec = makeDataDir()
    const r = await runTool(allTools, 'get_contact_detail', { username: 'wxid_a' }, { decryptedDir: dec })
    expect(r.ok).toBe(true)
    expect(r.hits[0]!.snippet).toContain('chen123')
    expect(r.hits[0]!.snippet).toContain('2 条')
  })

  it('search_kb 在没选中知识库时如实报错（而不是静默搜全库）', async () => {
    const dec = makeDataDir()
    const r = await runTool(allTools, 'search_kb', { query: '合同' }, { decryptedDir: dec })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('没有选中知识库')
  })
})

describe('参数解析：不可信输入', () => {
  it('argString 只接受字符串（null/数字/对象都走兜底）', () => {
    expect(argString('a')).toBe('a')
    expect(argString(null, 'x')).toBe('x')
    expect(argString(123, 'x')).toBe('x')
    expect(argString({ a: 1 }, 'x')).toBe('x')
    // 关键：不能把 null 变成 "null"、把对象变成 "[object Object]" ——
    // 那样会拿它去查库，查不到还不报错（最难查的一类失败）
    expect(argString(null)).toBe('')
  })

  it('argInt 钳制范围并拒绝非数字', () => {
    expect(argInt(5, 1, 1, 10)).toBe(5)
    expect(argInt(100, 1, 1, 10)).toBe(10)
    expect(argInt(-5, 1, 1, 10)).toBe(1)
    expect(argInt('abc', 7, 1, 10)).toBe(7)
    expect(argInt(null, 7, 1, 10)).toBe(7)
    expect(argInt(3.9, 1, 1, 10)).toBe(3)
  })

  it('argStringArray 过滤非字符串并截断', () => {
    expect(argStringArray(['a', 'b'], 5)).toEqual(['a', 'b'])
    expect(argStringArray(['a', '', '  ', 'b'], 5)).toEqual(['a', 'b'])
    expect(argStringArray(['a', 1, null, 'b'], 5)).toEqual(['a', 'b'])
    expect(argStringArray(['a', 'b', 'c'], 2)).toEqual(['a', 'b'])
    expect(argStringArray('not-array', 5)).toEqual([])
  })
})

/**
 * 接线（2026-10-16 新增）。
 *
 * 工具集「写好了但没人调用」是这一层最容易踩的坑：它不会让任何测试变红，
 * 也不会让问答崩 —— 只是模型永远看不到这些能力。所以这里钉住**装配点**：
 * `buildAskTools` 必须真的把问答的依赖（embedFn / kbId / 实体名单）接进去。
 */
describe('工具集接线（问答装配层）', () => {
  /** 造一份最小的 `AskRetrievalInput`（只填接线用得到的字段）。 */
  function makeInput(over: Partial<Parameters<typeof buildAskTools>[0]> = {}): Parameters<typeof buildAskTools>[0] {
    return {
      decryptedDir: makeDataDir(),
      question: '我一共收到多少笔转账',
      plan: { subQueries: ['转账'], from: '', to: '', person: '' },
      scope: {},
      indexNote: '',
      scopeDescText: '全部会话',
      op: () => { /* 接线测试不关心操作日志 */ },
      makeEmbedFn: () => undefined,
      embedModelName: () => 'test-embed',
      makeRerankFn: () => undefined,
      kbModel: () => ({ model: 'test' }),
      askKnownEntities: () => ['房东'],
      ...over,
    }
  }

  it('buildAskTools 返回完整工具集（含需要注入的 search_semantic）', () => {
    const tools = buildAskTools(makeInput())
    expect(tools.map(t => t.name).sort()).toEqual([...TOOL_NAMES].sort())
    // 未配向量模型时它**仍然在清单里** —— 消失会让模型以为「没有这个能力」，
    // 而实际是「这次没配」。
    expect(tools.some(t => t.name === 'search_semantic')).toBe(true)
  })

  it('embedFn 注入后 search_semantic 能真的跑（不是只挂个名字）', async () => {
    const embedFn = async (texts: string[]): Promise<number[][]> => texts.map(() => [1, 0, 0])
    const tools = buildAskTools(makeInput({ makeEmbedFn: () => embedFn }))
    const r = await runTool(tools, 'search_semantic', { query: '转账' }, askToolContext(makeInput({ makeEmbedFn: () => embedFn })))
    // 没建向量库 ⇒ 如实报「没有可检索的向量」，而不是抛错或假装成功。
    expect(r.ok).toBe(false)
    expect(String(r.error)).toMatch(/向量|索引/)
  })

  it('askToolContext 把实体名单与规划器点出的名字合并（与管线同一口径）', () => {
    const ctx = askToolContext(makeInput({ plan: { subQueries: [], from: '', to: '', person: '张三' } }))
    expect(ctx.knownEntities).toEqual(['房东', '张三'])
    // 名单里已有的不重复
    const ctx2 = askToolContext(makeInput({ plan: { subQueries: [], from: '', to: '', person: '房东' } }))
    expect(ctx2.knownEntities).toEqual(['房东'])
  })

  it('askToolContext 带上 kbId 与 scope（工具据此限定范围）', () => {
    const ctx = askToolContext(makeInput({ kbId: 7, scope: { username: 'wxid_a', from: '2026-01-01' } }))
    expect(ctx.kbId).toBe(7)
    expect(ctx.scope).toEqual({ username: 'wxid_a', from: '2026-01-01' })
    // 不传 kbId 时**不出现该键**（而不是 undefined）—— 工具用 `'kbId' in ctx` 判有没有
    const ctx2 = askToolContext(makeInput())
    expect('kbId' in ctx2).toBe(false)
  })
})
