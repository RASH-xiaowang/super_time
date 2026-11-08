/**
 * 问答历史（`ask-history.ts`）：记录、列表/搜索/筛选/排序/分页、删除、清空。
 *
 * 这个模块的边界与 `export-history.ts` 不同，用例把它钉住：
 *   · 导出历史记的是「文件在哪」（可操作口径）；
 *   · 本模块记的是**问答正文本身**（内容口径）—— 所以「没检索到原文」这种
 *     **没调用模型**的轮次也必须留下，否则用户回看历史会以为当时根本没问过。
 *
 * 另外三条容易写错的语义：
 *   ① 问题与回答都空的记录不落库（避免攒一堆空行）；
 *   ② 搜索必须转义 LIKE 的 `%` / `_`（用户搜 "2026_09" 时下划线不是通配符）；
 *   ③ 聚合计数按**未分页**的命中集合算（否则页签数字会随翻页变化）。
 * @vitest-environment node
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from '../src/query/db-open.ts'
import { clearAskHistory, deleteAskHistory, listAskHistory, recordAsk } from '../src/query/ask-history.ts'

const scratch: string[] = []
afterEach(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true })
  scratch.length = 0
})

/** 造一个数据根 + decrypted 目录；返回 decryptedDir。 */
function makeRoot(): string {
  const dataRoot = join(mkdtempSync(join(tmpdir(), 'wx-askhist-')), 'wechat-data')
  const decrypted = join(dataRoot, 'decrypted')
  mkdirSync(decrypted, { recursive: true })
  scratch.push(join(dataRoot, '..'))
  return decrypted
}

/** 一条最简问答（只给用例关心的字段）。 */
function seed(dec: string, over: Partial<Parameters<typeof recordAsk>[1]> = {}): number | null {
  return recordAsk(dec, {
    question: '最近一次转账给我的是谁？',
    answer: '房东说了收到转账 13.00 元 [1]',
    ...over,
  })
}

function protobufString(field: number, value: string): Buffer {
  const bytes = Buffer.from(value, 'utf8')
  return Buffer.concat([Buffer.from([(field << 3) | 2, bytes.length]), bytes])
}

function seedEnterpriseContact(
  dec: string,
  username: string,
  name: string,
  enterprise: string,
): void {
  mkdirSync(join(dec, 'contact'), { recursive: true })
  const db = new DatabaseSync(join(dec, 'contact', 'contact.db'))
  try {
    db.exec('CREATE TABLE contact (username TEXT, remark TEXT, nick_name TEXT, extra_buffer BLOB)')
    db.exec('CREATE TABLE openim_wording (wording_id TEXT, wording TEXT)')
    db.prepare('INSERT INTO openim_wording VALUES (?, ?)').run('wording-ent', enterprise)
    db.prepare('INSERT INTO contact VALUES (?, ?, ?, ?)').run(
      username,
      name,
      name,
      protobufString(2, 'wording-ent'),
    )
  } finally {
    db.close()
  }
}

describe('问答历史：记录与读取', () => {
  it('记录一次问答后能完整读回来（问题/回答/模型/范围/耗时/状态）', () => {
    const dec = makeRoot()
    const id = seed(dec, {
      source: 'ask',
      username: 'wxid_room',
      usernameName: '项目群',
      from: '2026-09-01',
      to: '2026-09-07',
      model: 'deepseek · chat',
      intent: 'entity_lookup',
      terms: ['转账', '房东'],
      basis: '共 12 条 / 2 个会话 / 2026-08-01 ~ 2026-09-07',
      citedIndexes: [1],
      elapsedMs: 4321,
      ts: 1_760_000_000_000,
    })
    expect(id).toBeGreaterThan(0)
    const snap = listAskHistory(dec, {})
    expect(snap.total).toBe(1)
    const row = snap.items[0]!
    expect(row.id).toBe(id)
    expect(row.ts).toBe(1_760_000_000_000)
    expect(row.question).toBe('最近一次转账给我的是谁？')
    expect(row.answer).toContain('13.00')
    expect(row.source).toBe('ask')
    expect(row.username).toBe('wxid_room')
    expect(row.usernameName).toBe('项目群')
    expect(row.from).toBe('2026-09-01')
    expect(row.to).toBe('2026-09-07')
    expect(row.model).toBe('deepseek · chat')
    expect(row.intent).toBe('entity_lookup')
    expect(row.terms).toEqual(['转账', '房东'])
    expect(row.citedIndexes).toEqual([1])
    expect(row.basis).toContain('2026-08-01')
    expect(row.status).toBe('ok')
    expect(row.elapsedMs).toBe(4321)
  })

  it('读取企微会话历史时按当前联系人元数据补充企业名', () => {
    const dec = makeRoot()
    const username = 'wxid_history@openim'
    seedEnterpriseContact(dec, username, '张三', '甲方公司')
    seed(dec, {
      username,
      usernameName: '张三（企业：甲方公司）',
    })

    const row = listAskHistory(dec, {}).items[0]!
    expect(row.username).toBe(username)
    expect(row.usernameName).toBe('张三（企业：甲方公司）')
    expect(row.usernameEnterpriseName).toBe('甲方公司')
  })

  it('引用以 JSON 往返：读回来仍是可点击跳转所需的完整对象', () => {
    const dec = makeRoot()
    seed(dec, {
      citations: [{ name: '房东', time: '2026-09-05 20:11', snippet: '收到转账 13.00 元', username: 'wxid_a', local_id: 42, sender: '张三' }],
    })
    const row = listAskHistory(dec, {}).items[0]!
    expect(row.citations).toHaveLength(1)
    expect(row.citations[0]).toEqual({
      name: '房东', time: '2026-09-05 20:11', snippet: '收到转账 13.00 元',
      username: 'wxid_a', local_id: 42, sender: '张三',
    })
  })

  it('「没检索到原文」这种未调模型的轮次也要落库（status=insufficient）', () => {
    const dec = makeRoot()
    seed(dec, { answer: '本机记录里没有检索到与这个问题相关的原文，因此不作回答。', insufficient: true })
    const row = listAskHistory(dec, {}).items[0]!
    expect(row.status).toBe('insufficient')
    expect(row.answer).toContain('没有检索到')
  })

  it('「不予采用」记 withheld；带 error 记 fail（error 优先）', () => {
    const dec = makeRoot()
    seed(dec, { withheld: true })
    seed(dec, { error: '未配置默认模型' })
    const byStatus = new Map(listAskHistory(dec, {}).items.map(i => [i.status, i]))
    expect(byStatus.get('withheld')!.answer).toContain('13.00')
    expect(byStatus.get('fail')!.error).toBe('未配置默认模型')
  })

  it('运行时六态显式映射：blocked/failed 记 fail，needs_clarification 记 insufficient，degraded 记 ok', () => {
    const dec = makeRoot()
    seed(dec, { question: 'blocked', runtimeStatus: 'blocked', statusReason: '缺少知识库' })
    seed(dec, { question: 'failed', runtimeStatus: 'failed', synthesisError: '模型超时', answer: '' })
    seed(dec, { question: 'clarify', runtimeStatus: 'needs_clarification', statusReason: '对象不明确' })
    seed(dec, { question: 'degraded', runtimeStatus: 'degraded', statusReason: '工具部分失败' })
    const rows = new Map(listAskHistory(dec, {}).items.map(row => [row.question, row]))
    expect(rows.get('blocked')).toMatchObject({ status: 'fail', error: '缺少知识库' })
    expect(rows.get('failed')).toMatchObject({ status: 'fail', error: '模型超时' })
    expect(rows.get('clarify')).toMatchObject({ status: 'insufficient' })
    expect(rows.get('degraded')).toMatchObject({ status: 'ok', error: '' })
  })

  it('原始运行状态与原因写入 retrieval；degraded 带显式标记，不靠猜测', () => {
    const dec = makeRoot()
    seed(dec, {
      question: '降级', runtimeStatus: 'degraded', statusReason: '语义检索通道失败',
      retrieval: { candidates: 9, kept: 2, scope: '本机记录', recency: false },
    })
    const row = listAskHistory(dec, {}).items[0]!
    expect(row.retrieval).toMatchObject({
      candidates: 9,
      runtimeStatus: 'degraded',
      statusReason: '语义检索通道失败',
      degraded: true,
    })
  })

  it('未知运行状态显式记 fail，不默认成 ok', () => {
    const dec = makeRoot()
    seed(dec, { question: '未知', runtimeStatus: 'mystery' })
    const row = listAskHistory(dec, {}).items[0]!
    expect(row.status).toBe('fail')
    expect(row.error).toContain('未知运行状态')
  })

  it('显式 error 优先于运行状态：即使状态是 ok/degraded 也记 fail', () => {
    const dec = makeRoot()
    seed(dec, { question: '降级但报错', runtimeStatus: 'degraded', error: '写回失败' })
    seed(dec, { question: '成功但报错', runtimeStatus: 'ok', error: '后处理失败' })
    const rows = new Map(listAskHistory(dec, {}).items.map(row => [row.question, row]))
    expect(rows.get('降级但报错')).toMatchObject({ status: 'fail', error: '写回失败' })
    expect(rows.get('成功但报错')).toMatchObject({ status: 'fail', error: '后处理失败' })
  })

  it('读取到未知历史状态时显式报 fail，不把损坏记录伪装成 ok', () => {
    const dec = makeRoot()
    seed(dec, { question: '旧记录' })
    const db = new DatabaseSync(join(dec, '..', 'wechat_privacy.db'))
    try {
      db.prepare("UPDATE ask_history SET status = 'future_state', error = ''").run()
    } finally {
      db.close()
    }
    const row = listAskHistory(dec, {}).items[0]!
    expect(row.status).toBe('fail')
    expect(row.error).toContain('未知历史状态')
    expect(row.error).toContain('future_state')
  })

  it('证据与工具 trace 只落有界摘要，不落 snippet、完整参数或正文', () => {
    const dec = makeRoot()
    seed(dec, {
      question: '摘要', runtimeStatus: 'degraded',
      evidence: {
        status: 'degraded',
        items: [{ snippet: '不应落库的正文', locator: { path: 'C:/secret.txt' } }],
        facts: [{ title: '金额', body: '不应落库的事实正文' }],
        stats: {
          count: 1, messages: 1, kb: 0, sessions: 1, candidateCount: 3,
          factCount: 1, failedTools: ['search_files'], attemptedTools: 2, successfulTools: 1,
        },
      },
      toolCalls: [{
        index: 0, round: 1, name: 'search_files', ok: false, attempts: 2, retries: 1,
        elapsedMs: 120, errorCode: 'E_TIMEOUT', hits: 0, facts: 0,
        argumentsSummary: '{"query":"不应落库的完整参数"}',
      }],
      resources: [{
        evidenceId: 'res:search_files:file:f1',
        tool: 'search_files',
        key: 'file:f1',
        name: '合同.pdf',
        time: '2026-10-20 09:00',
        snippet: '不应落库',
        locator: { type: 'resource', tool: 'search_files', key: 'file:f1', resourceKind: 'file', sourceId: 's1' },
      }],
    })
    const row = listAskHistory(dec, {}).items[0]!
    const evidence = row.retrieval?.['evidence'] as Record<string, unknown>
    const toolCalls = row.retrieval?.['toolCalls'] as Record<string, unknown>
    const resources = row.retrieval?.['resources'] as Record<string, unknown>
    expect(evidence).toMatchObject({ count: 1, messages: 1, facts: 1, failedTools: ['search_files'] })
    expect(toolCalls).toMatchObject({ total: 1, truncated: false })
    expect(resources).toEqual({
      total: 1,
      tools: ['search_files'],
      items: [{
        evidenceId: 'res:search_files:file:f1',
        tool: 'search_files',
        key: 'file:f1',
        name: '合同.pdf',
        time: '2026-10-20 09:00',
        resourceKind: 'file',
        sourceId: 's1',
      }],
      truncated: false,
    })
    const serialized = JSON.stringify(row.retrieval)
    expect(serialized).not.toContain('不应落库')
    expect(serialized).not.toContain('argumentsSummary')
    expect(serialized).not.toContain('snippet')
  })

  it('完整运行轨迹往返：分段思考、两轮工具、回答整理与核对阶段都能恢复', () => {
    const dec = makeRoot()
    seed(dec, {
      question: '轨迹往返',
      reasoningSegments: [
        { key: 'reasoning:tool:1', round: 1, phase: 'tool_selection', text: '先确认要查哪类消息', seq: 1 },
        { key: 'reasoning:tool:2', round: 2, phase: 'tool_selection', text: '再补查上下文', seq: 2 },
        { key: 'reasoning:synthesis', phase: 'synthesis', text: '把两轮结果合并成回答', seq: 3 },
      ],
      stages: [
        { key: 'answer:intent', label: '理解问题', status: 'done' },
        {
          key: 'tool:search:1', label: 'search_messages', status: 'done', round: 1,
          phase: 'completed', callId: 'call-1', toolName: 'search_messages',
          argumentsSummary: '不应进入历史轨迹的参数', elapsedMs: 12, hits: 2,
        },
        {
          key: 'tool:context:2', label: 'get_message_context', status: 'done', round: 2,
          phase: 'completed', callId: 'call-2', toolName: 'get_message_context',
          argumentsSummary: '也不应进入历史轨迹的参数', elapsedMs: 18, hits: 1,
        },
        { key: 'answer:synthesize', label: '综合生成', status: 'done' },
        { key: 'answer:verify', label: '核对结果', status: 'done', detail: '金额与时间均来自原文' },
      ],
      toolCalls: [
        {
          index: 0, round: 1, callId: 'call-1', name: 'search_messages', ok: true,
          deduplicated: false, attempts: 1, retries: 0, elapsedMs: 12, hits: 2, facts: 0,
          argumentsSummary: '不应进入轨迹的参数',
        },
        {
          index: 1, round: 2, callId: 'call-2', name: 'get_message_context', ok: true,
          deduplicated: true, attempts: 0, retries: 0, elapsedMs: 18, hits: 1, facts: 1,
          argumentsSummary: '也不应进入轨迹的参数',
        },
      ],
    })

    const trace = listAskHistory(dec, {}).items[0]!.runtimeTrace
    expect(trace).toBeDefined()
    expect(trace).toMatchObject({ version: 1, truncated: false, toolCallTotal: 2 })
    expect(trace!.reasoningSegments.map(segment => segment.round)).toEqual([1, 2, undefined])
    expect(trace!.reasoningSegments[2]).toMatchObject({
      key: 'reasoning:synthesis',
      phase: 'synthesis',
      text: '把两轮结果合并成回答',
    })
    expect(trace!.stages.map(stage => stage.key)).toEqual([
      'answer:intent',
      'tool:search:1',
      'tool:context:2',
      'answer:synthesize',
      'answer:verify',
    ])
    expect(trace!.stages.find(stage => stage.key === 'answer:verify')).toMatchObject({
      label: '核对结果',
      status: 'done',
      detail: '金额与时间均来自原文',
    })
    expect(trace!.toolCalls).toEqual([
      {
        index: 0, round: 1, callId: 'call-1', name: 'search_messages', ok: true,
        deduplicated: false, attempts: 1, retries: 0, elapsedMs: 12, hits: 2, facts: 0,
      },
      {
        index: 1, round: 2, callId: 'call-2', name: 'get_message_context', ok: true,
        deduplicated: true, attempts: 0, retries: 0, elapsedMs: 18, hits: 1, facts: 1,
      },
    ])
    expect(JSON.stringify(trace)).not.toContain('不应进入历史轨迹的参数')
    expect(JSON.stringify(trace)).not.toContain('argumentsSummary')
  })

  it('没有分段思考时把旧式 reasoning 记为回答整理段，保证旧调用方也能回看', () => {
    const dec = makeRoot()
    seed(dec, { question: '旧式思考', reasoning: '这是一段旧版单段思考' })
    expect(listAskHistory(dec, {}).items[0]!.runtimeTrace?.reasoningSegments).toEqual([{
      key: 'reasoning:legacy',
      phase: 'synthesis',
      text: '这是一段旧版单段思考',
      seq: 1,
    }])
  })

  it('损坏的 runtime_trace 只丢轨迹，不影响问题、回答、引用与状态读取', () => {
    const dec = makeRoot()
    seed(dec, {
      question: '坏轨迹',
      answer: '主记录仍然可读 [1]',
      citations: [{ name: '甲', time: '2026-10-01 10:00', snippet: '原文', username: 'wxid_a', local_id: 7 }],
      reasoningSegments: [{ key: 'r', phase: 'synthesis', text: '会被破坏', seq: 1 }],
    })
    const db = new DatabaseSync(join(dec, '..', 'wechat_privacy.db'))
    try {
      db.prepare("UPDATE ask_history SET runtime_trace = '{broken'").run()
    } finally {
      db.close()
    }
    const row = listAskHistory(dec, {}).items[0]!
    expect(row).toMatchObject({
      question: '坏轨迹',
      answer: '主记录仍然可读 [1]',
      status: 'ok',
    })
    expect(row.citations[0]).toMatchObject({ username: 'wxid_a', local_id: 7 })
    expect(row.runtimeTrace).toBeUndefined()
  })

  it('超长轨迹按段数、总思考字数和 JSON 预算截断，并明确标记 truncated', () => {
    const dec = makeRoot()
    seed(dec, {
      question: '预算',
      reasoningSegments: Array.from({ length: 40 }, (_, i) => ({
        key: `r-${String(i)}`,
        round: i + 1,
        phase: 'tool_selection',
        text: `第${String(i)}段` + '想'.repeat(2_000),
        seq: i + 1,
      })),
      stages: Array.from({ length: 200 }, (_, i) => ({
        key: `stage-${String(i)}`,
        label: `步骤 ${String(i)}`,
        status: 'done',
        detail: `detail-${String(i)}-` + '细'.repeat(2_000),
      })),
      toolCalls: Array.from({ length: 40 }, (_, i) => ({
        index: i,
        round: i + 1,
        callId: `call-${String(i)}`,
        name: 'search_messages',
        ok: true,
        attempts: 1,
        retries: 0,
        elapsedMs: i,
        hits: i,
        facts: 0,
      })),
    })
    const trace = listAskHistory(dec, {}).items[0]!.runtimeTrace!
    expect(trace.truncated).toBe(true)
    expect(trace.reasoningSegments.length).toBeLessThanOrEqual(24)
    expect(trace.reasoningSegments.reduce((sum, segment) => sum + segment.text.length, 0))
      .toBeLessThanOrEqual(24_000)
    expect(trace.stages.length).toBeLessThanOrEqual(120)
    expect(trace.toolCalls.length).toBeLessThanOrEqual(24)
    expect(trace.toolCallTotal).toBe(40)
    expect(JSON.stringify(trace).length).toBeLessThanOrEqual(64_000)
  })

  it('旧库没有 runtime_trace 时自动补列，旧记录可读且新记录能立即写入轨迹', () => {
    const dec = makeRoot()
    const legacyDb = new DatabaseSync(join(dec, '..', 'wechat_privacy.db'))
    try {
      legacyDb.exec(`CREATE TABLE ask_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        question TEXT NOT NULL,
        answer TEXT NOT NULL,
        source TEXT NOT NULL,
        username TEXT,
        username_name TEXT,
        from_day TEXT,
        to_day TEXT,
        model TEXT,
        intent TEXT,
        terms TEXT,
        citations TEXT,
        cited_indexes TEXT,
        basis TEXT,
        status TEXT NOT NULL,
        error TEXT,
        retrieval TEXT,
        elapsed_ms INTEGER
      )`)
      legacyDb.prepare(`INSERT INTO ask_history
        (ts, question, answer, source, username, username_name, from_day, to_day, model,
         intent, terms, citations, cited_indexes, basis, status, error, retrieval, elapsed_ms)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(
          1_000, '旧记录', '旧回答', 'ask', '', '', '', '', '', '',
          '[]', '[]', '[]', '', 'ok', '', '', 10,
        )
    } finally {
      legacyDb.close()
    }

    const oldRow = listAskHistory(dec, {}).items[0]!
    expect(oldRow).toMatchObject({ question: '旧记录', answer: '旧回答' })
    expect(oldRow.runtimeTrace).toBeUndefined()
    const migrated = new DatabaseSync(join(dec, '..', 'wechat_privacy.db'))
    try {
      const columns = migrated.prepare('PRAGMA table_info(ask_history)').all() as Array<{ name?: string }>
      expect(columns.some(column => column.name === 'runtime_trace')).toBe(true)
    } finally {
      migrated.close()
    }

    seed(dec, {
      question: '新记录',
      reasoningSegments: [{ key: 'r', phase: 'synthesis', text: '补列后写入', seq: 1 }],
    })
    const newest = listAskHistory(dec, { q: '新记录' }).items[0]!
    expect(newest.runtimeTrace?.reasoningSegments[0]?.text).toBe('补列后写入')
  })

  it('超长 retrieval 退化为最小状态摘要，运行状态不会丢', () => {
    const dec = makeRoot()
    seed(dec, {
      question: '超长', runtimeStatus: 'degraded', statusReason: '仍有证据',
      retrieval: { blob: 'x'.repeat(20_000) },
    })
    const row = listAskHistory(dec, {}).items[0]!
    expect(row.retrieval).toMatchObject({
      runtimeStatus: 'degraded', statusReason: '仍有证据', truncated: true,
    })
    expect(JSON.stringify(row.retrieval).length).toBeLessThan(2_000)
  })

  it('retrieval 无法序列化（循环引用）时仍保留运行状态与原因', () => {
    const dec = makeRoot()
    const circular: Record<string, unknown> = {}
    circular['self'] = circular
    seed(dec, {
      question: '循环', runtimeStatus: 'degraded', statusReason: '元数据损坏',
      retrieval: circular,
    })
    const row = listAskHistory(dec, {}).items[0]!
    expect(row.status).toBe('ok')
    expect(row.retrieval).toMatchObject({
      runtimeStatus: 'degraded', statusReason: '元数据损坏', serializationFailed: true,
    })
  })

  it('问题与回答都空的记录不落库（返回 null，不留空行）', () => {
    const dec = makeRoot()
    expect(recordAsk(dec, { question: '   ', answer: '' })).toBe(null)
    expect(listAskHistory(dec, {}).total).toBe(0)
  })

  it('问题为空但有回答仍然落库（问题可能来自快捷入口）', () => {
    const dec = makeRoot()
    expect(seed(dec, { question: '' })).toBeGreaterThan(0)
    expect(listAskHistory(dec, {}).total).toBe(1)
  })

  it('超长回答按上限截断（防一行撑爆库），正常长度的回答逐字保存', () => {
    const dec = makeRoot()
    const long = 'x'.repeat(25_000)
    seed(dec, { question: '长回答', answer: long })
    const row = listAskHistory(dec, {}).items[0]!
    expect(row.answer.length).toBe(20_000)
    const normal = 'a'.repeat(1_500)
    seed(dec, { question: '正常回答', answer: normal })
    const got = listAskHistory(dec, { q: '正常回答' }).items[0]!
    expect(got.answer.length).toBe(1_500)
  })
})

describe('问答历史：搜索 / 筛选 / 排序 / 分页', () => {
  it('搜索同时命中问题与回答', () => {
    const dec = makeRoot()
    seed(dec, { question: '关于合同的事', answer: '合同已签 [1]', ts: 1000 })
    seed(dec, { question: '别的', answer: '提到了合同的补充条款 [1]', ts: 2000 })
    seed(dec, { question: '无关', answer: '无关内容', ts: 3000 })
    expect(listAskHistory(dec, { q: '合同' }).total).toBe(2)
  })

  it('LIKE 的 % 与 _ 被转义：搜 "2026_09" 不匹配 "2026X09"', () => {
    const dec = makeRoot()
    seed(dec, { question: '关于 2026_09 的报价', answer: 'A', ts: 1000 })
    seed(dec, { question: '关于 2026X09 的报价', answer: 'B', ts: 2000 })
    const snap = listAskHistory(dec, { q: '2026_09' })
    expect(snap.total).toBe(1)
    expect(snap.items[0]!.question).toContain('2026_09')
  })

  it('状态筛选生效，且聚合计数按未分页的命中集合算', () => {
    const dec = makeRoot()
    seed(dec, { question: 'q1', ts: 1000 })
    seed(dec, { question: 'q2', ts: 2000 })
    seed(dec, { question: 'q3', ts: 3000, insufficient: true })
    const filtered = listAskHistory(dec, { status: 'ok', limit: 1 })
    expect(filtered.total).toBe(2)
    expect(filtered.items).toHaveLength(1)
    expect(filtered.statusCounts['ok']).toBe(2)
    expect(filtered.statusCounts['insufficient']).toBeUndefined()
    const all = listAskHistory(dec, {})
    expect(all.statusCounts['ok']).toBe(2)
    expect(all.statusCounts['insufficient']).toBe(1)
  })

  it('来源筛选 + 来源计数（面板问答 / 会话内问答分开看）', () => {
    const dec = makeRoot()
    seed(dec, { question: 'a', source: 'ask', ts: 1000 })
    seed(dec, { question: 'b', source: 'session', ts: 2000 })
    seed(dec, { question: 'c', source: 'session', ts: 3000 })
    const onlySession = listAskHistory(dec, { sources: ['session'] })
    expect(onlySession.total).toBe(2)
    expect(onlySession.sourceCounts['session']).toBe(2)
    expect(listAskHistory(dec, {}).sourceCounts['ask']).toBe(1)
  })

  it('会话筛选只返回该会话的记录，分页计数也随范围收口', () => {
    const dec = makeRoot()
    seed(dec, { question: 'A1', source: 'session', username: 'wxid_a', ts: 1000 })
    seed(dec, { question: 'A2', source: 'session', username: 'wxid_a', ts: 2000 })
    seed(dec, { question: 'B1', source: 'session', username: 'wxid_b', ts: 3000 })
    seed(dec, { question: '全局', source: 'ask', username: '', ts: 4000 })

    const scoped = listAskHistory(dec, { username: 'wxid_a', limit: 1 })
    expect(scoped.total).toBe(2)
    expect(scoped.items).toHaveLength(1)
    expect(scoped.items.every(item => item.username === 'wxid_a')).toBe(true)
    expect(scoped.sourceCounts).toEqual({ session: 2 })
    expect(listAskHistory(dec, {}).total).toBe(4)
  })

  it('默认最新优先；order=asc 可翻成最早优先', () => {
    const dec = makeRoot()
    seed(dec, { question: '旧', ts: 1000 })
    seed(dec, { question: '新', ts: 3000 })
    seed(dec, { question: '中', ts: 2000 })
    expect(listAskHistory(dec, {}).items.map(i => i.question)).toEqual(['新', '中', '旧'])
    expect(listAskHistory(dec, { order: 'asc' }).items.map(i => i.question)).toEqual(['旧', '中', '新'])
  })

  it('分页：limit 生效、offset 跳过、total 是命中总数', () => {
    const dec = makeRoot()
    for (let i = 0; i < 5; i += 1) seed(dec, { question: `q${i}`, ts: 1000 + i })
    const p1 = listAskHistory(dec, { limit: 2 })
    expect(p1.items).toHaveLength(2)
    expect(p1.total).toBe(5)
    const p2 = listAskHistory(dec, { limit: 2, offset: 4 })
    expect(p2.items).toHaveLength(1)
    expect(p2.items[0]!.question).toBe('q0')
  })

  it('时间范围筛选按 ts 闭区间', () => {
    const dec = makeRoot()
    seed(dec, { question: '早', ts: 1000 })
    seed(dec, { question: '中', ts: 2000 })
    seed(dec, { question: '晚', ts: 3000 })
    expect(listAskHistory(dec, { from: 2000, to: 3000 }).items.map(i => i.question)).toEqual(['晚', '中'])
  })
})

describe('问答历史：删除与清空', () => {
  it('按 id 删除，只删指定的那条', () => {
    const dec = makeRoot()
    const a = seed(dec, { question: 'a', ts: 1000 })!
    seed(dec, { question: 'b', ts: 2000 })
    const r = deleteAskHistory(dec, [a])
    expect(r.removed).toBe(1)
    expect(listAskHistory(dec, {}).items.map(i => i.question)).toEqual(['b'])
  })

  it('空 id 列表 / 非法 id 不删任何东西', () => {
    const dec = makeRoot()
    seed(dec, { question: 'a' })
    expect(deleteAskHistory(dec, []).removed).toBe(0)
    expect(deleteAskHistory(dec, [0, -3, Number.NaN]).removed).toBe(0)
    expect(listAskHistory(dec, {}).total).toBe(1)
  })

  it('清空全部返回删除条数，且清完还能继续写入', () => {
    const dec = makeRoot()
    seed(dec, { question: 'a', ts: 1000 })
    seed(dec, { question: 'b', ts: 2000 })
    expect(clearAskHistory(dec).removed).toBe(2)
    expect(listAskHistory(dec, {}).total).toBe(0)
    expect(seed(dec, { question: 'c', ts: 3000 })).toBeGreaterThan(0)
    expect(listAskHistory(dec, {}).total).toBe(1)
  })

  it('删除后 id 不复用（AUTOINCREMENT），不会把新记录顶到旧 id 上', () => {
    const dec = makeRoot()
    const a = seed(dec, { question: 'a', ts: 1000 })!
    deleteAskHistory(dec, [a])
    const b = seed(dec, { question: 'b', ts: 2000 })!
    expect(b).toBeGreaterThan(a)
  })
})

describe('问答历史：按数据根隔离', () => {
  it('两个数据根各存各的（换账号/换数据目录不会串味）', () => {
    const dec1 = makeRoot()
    const dec2 = makeRoot()
    seed(dec1, { question: '只在根 1' })
    expect(listAskHistory(dec1, {}).total).toBe(1)
    expect(listAskHistory(dec2, {}).total).toBe(0)
  })

  it('空库读取返回空快照而不是抛错（面板不该因为没历史而崩）', () => {
    const dec = makeRoot()
    const snap = listAskHistory(dec, {})
    expect(snap).toEqual({ items: [], total: 0, statusCounts: {}, sourceCounts: {} })
  })
})
