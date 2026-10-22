// @vitest-environment node
/**
 * 知识库命中的可点击溯源。
 *
 * 这里钉住三件事：
 *   · `search_kb` 的每个 hit 都带完整 trace（文件/块/页码/面包屑）；
 *   · evidence 把这些字段无损映射成 `AskCitation.kb`；
 *   · trace 缺失时才用 key/name 兜底，且资源类证据不伪造 citation。
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildEvidenceBundle, type CitationShape } from '../src/query/answer-runtime/evidence.ts'
import { createToolCallTrace } from '../src/query/answer-runtime/trace.ts'
import { openStore } from '../src/query/kb-files.ts'
import { bigramTokens } from '../src/query/search-scaffold.ts'
import { allTools, runTool } from '../src/query/tools/index.ts'
import type { ToolResult } from '../src/query/tools/types.ts'

const scratch: string[] = []
afterEach(() => {
  for (const d of scratch.splice(0)) rmSync(d, { recursive: true, force: true })
})

const KB_ID = 3
const FILE_ID = 11
const HEADING = '付款条款 › 第二期'
const UNIQUE = '蓝鲸付款节点'

/** 真 schema + 真 FTS：trace 的来源必须是 `searchKb()` 的真实命中。 */
function makeKbFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'ask-evidence-trace-'))
  scratch.push(root)
  const decrypted = join(root, 'decrypted')
  mkdirSync(decrypted, { recursive: true })
  const db = openStore(decrypted)
  db.prepare(
    'INSERT INTO kb_files (id, kb_id, name, ext, src_path, sha256, blob_name, size_bytes, '
    + "parse_state, parser, parse_error, chunk_count, char_count, include_in_rag, created_at, updated_at) "
    + "VALUES (?, ?, ?, ?, '', ?, '', 0, 'ready', '', '', 1, 0, 1, 1, 1)",
  ).run(FILE_ID, KB_ID, '采购合同.pdf', 'pdf', 'a'.repeat(64))
  const text = `第二期应在验收后支付，节点：${UNIQUE}。`
  const inserted = db.prepare(
    'INSERT INTO kb_chunks (file_id, kb_id, ordinal, text, tokens, char_count, page, heading) '
    + 'VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(FILE_ID, KB_ID, 4, text, bigramTokens(text), text.length, 2, HEADING)
  db.prepare('INSERT INTO kb_chunks_fts(rowid, tokens, heading_tokens) VALUES (?, ?, ?)')
    .run(Number(inserted.lastInsertRowid), bigramTokens(text), bigramTokens(HEADING))
  db.close()
  return decrypted
}

function hit(overrides: Partial<ToolResult['hits'][number]> = {}): ToolResult['hits'][number] {
  return {
    key: `kb:${String(KB_ID)}:${String(FILE_ID)}`,
    name: '采购合同.pdf',
    time: '',
    snippet: '第二期应在验收后支付',
    source: 'kb',
    ...overrides,
  }
}

function kbCitation(result: unknown): CitationShape['kb'] {
  const citation = result as CitationShape | undefined
  expect(citation?.kb).toBeDefined()
  return citation?.kb
}

describe('search_kb → ToolHit.trace', () => {
  it('每个命中都带完整可点击溯源，且与真实检索结果一致', async () => {
    const decrypted = makeKbFixture()
    const r = await runTool(allTools, 'search_kb', { query: UNIQUE }, {
      decryptedDir: decrypted,
      kbId: KB_ID,
    })
    expect(r.ok).toBe(true)
    expect(r.hits.length).toBeGreaterThan(0)
    const first = r.hits[0]
    expect(first?.trace).toEqual({
      kind: 'kb',
      kbId: KB_ID,
      fileId: FILE_ID,
      chunkId: first?.trace?.chunkId,
      ordinal: 4,
      page: 2,
      heading: HEADING,
    })
    expect(first?.trace?.chunkId).toBeGreaterThan(0)
    expect(first?.key).toBe(`kb:${String(KB_ID)}:${String(first?.trace?.chunkId)}`)
  })
})

describe('tool trace：失败正文', () => {
  it('errorMessage 脱敏并截断到 300 字', () => {
    const trace = createToolCallTrace({
      index: 0,
      round: 1,
      callId: 'call_error',
      name: 'search_messages',
      ok: false,
      errorClass: 'unauthorized',
      errorCode: 'upstream_failure',
      errorMessage: `authorization: Bearer very-secret-token token=top-secret ${'长'.repeat(400)}`,
    })

    expect(trace.errorMessage).toBeDefined()
    expect(trace.errorMessage).not.toContain('very-secret-token')
    expect(trace.errorMessage).not.toContain('top-secret')
    expect(Array.from(trace.errorMessage ?? '').length).toBeLessThanOrEqual(300)
    expect(trace.errorMessage?.endsWith('…')).toBe(true)
  })
})

describe('evidence：KB citation 八字段', () => {
  it('trace 完整时映射 kbId/fileId/fileName/fileExt/chunkId/ordinal/page/heading', () => {
    const bundle = buildEvidenceBundle([{
      tool: 'search_kb',
      ok: true,
      hits: [hit({
        key: 'kb:3:77',
        trace: {
          kind: 'kb',
          kbId: 3,
          fileId: 11,
          chunkId: 77,
          ordinal: 4,
          page: 2,
          heading: HEADING,
        },
      })],
    }])
    expect(kbCitation(bundle.items[0]?.citation)).toEqual({
      kbId: 3,
      fileId: 11,
      fileName: '采购合同.pdf',
      fileExt: 'pdf',
      chunkId: 77,
      ordinal: 4,
      page: 2,
      heading: HEADING,
    })
    expect(bundle.items[0]?.locator).toMatchObject({
      type: 'kb',
      kbId: 3,
      fileId: 11,
      chunkId: 77,
      ordinal: 4,
      page: 2,
      heading: HEADING,
      fileExt: 'pdf',
    })
  })

  it('trace 缺失时从 key/name 兜底，数值缺项如实给 0', () => {
    const bundle = buildEvidenceBundle([{
      tool: 'search_kb',
      ok: true,
      hits: [hit({ key: 'kb:5:88', name: '归档.ZIP' })],
    }])
    expect(kbCitation(bundle.items[0]?.citation)).toEqual({
      kbId: 5,
      fileId: 0,
      fileName: '归档.ZIP',
      fileExt: 'zip',
      chunkId: 88,
      ordinal: 0,
      page: 0,
      heading: '',
    })
  })

  it('key 无法解析但 trace 完整时仍生成正确 citation', () => {
    const bundle = buildEvidenceBundle([{
      tool: 'search_kb',
      ok: true,
      hits: [hit({
        key: 'unstable-key',
        trace: {
          kind: 'kb',
          kbId: 9,
          fileId: 12,
          chunkId: 34,
          ordinal: 1,
          page: 3,
          heading: '附件',
        },
      })],
    }])
    expect(kbCitation(bundle.items[0]?.citation)).toMatchObject({
      kbId: 9,
      fileId: 12,
      chunkId: 34,
      ordinal: 1,
      page: 3,
      heading: '附件',
    })
    expect(bundle.items[0]?.evidenceId).toBe('kb:9:34')
  })

  it('key 与 trace 指向不同块时拒绝，不生成可点击引用', () => {
    const bundle = buildEvidenceBundle([{
      tool: 'search_kb',
      ok: true,
      hits: [hit({
        key: 'kb:3:77',
        trace: {
          kind: 'kb',
          kbId: 4,
          fileId: 11,
          chunkId: 78,
          ordinal: 4,
          page: 2,
          heading: HEADING,
        },
      })],
    }])

    expect(bundle.items).toEqual([])
    expect(bundle.status).toBe('failed')
    expect(bundle.stats.malformedHits).toBe(1)
  })

  it('非法/缺失 KB 定位不得降级成非规范 evidenceId', () => {
    const bundle = buildEvidenceBundle([{
      tool: 'search_kb',
      ok: true,
      hits: [
        hit({ key: 'kb:unstable', name: '坏键.pdf' }),
        hit({ key: 'kb:3:0', name: '零块.pdf' }),
        hit({ key: 'wxid_a:1', name: '伪装成 KB 的消息.pdf' }),
      ],
    }])

    expect(bundle.items).toEqual([])
    expect(bundle.status).toBe('failed')
    expect(bundle.stats.malformedHits).toBe(3)
    expect(bundle.stats.malformedResults).toBe(1)
  })

  it('输出侧边界：只接受当前会话消息，或当前 kbId 的知识库证据', () => {
    const crossSession = buildEvidenceBundle([{
      tool: 'search_messages',
      ok: true,
      hits: [{
        key: 'wxid_other:1',
        name: '其他会话',
        time: '',
        snippet: '不是当前会话的正文',
        source: 'msg',
      }],
    }], { allowedUsername: 'wxid_locked' })
    expect(crossSession.items).toEqual([])
    expect(crossSession.status).toBe('blocked')
    expect(crossSession.stats.rejectedCount).toBe(1)
    expect(crossSession.missing).toContain('scope')

    const wrongKb = buildEvidenceBundle([{
      tool: 'search_kb',
      ok: true,
      hits: [hit({
        key: 'kb:8:5',
        trace: { kind: 'kb', kbId: 8, fileId: 1, chunkId: 5, ordinal: 0, page: 0, heading: '' },
      })],
    }], { kbOnly: true, allowedKbId: 7 })
    expect(wrongKb.items).toEqual([])
    expect(wrongKb.status).toBe('blocked')
    expect(wrongKb.stats.rejectedCount).toBe(1)

    const nonKb = buildEvidenceBundle([{
      tool: 'search_kb',
      ok: true,
      hits: [{
        key: 'wxid_a:1',
        name: '项目群',
        time: '',
        snippet: '消息不能进入自动回复证据',
        source: 'msg',
      }],
    }], { kbOnly: true, allowedKbId: 7 })
    expect(nonKb.items).toEqual([])
    expect(nonKb.status).toBe('failed')
    expect(nonKb.stats.malformedHits).toBe(1)
  })
})

describe('evidence：消息与资源边界', () => {
  function result(tool: ToolResult['tool'], hits: ToolResult['hits']): ToolResult {
    return { tool, ok: true, hits }
  }

  it('消息 hit 的 username/local_id 来自 trace，且与 key 一致', () => {
    const bundle = buildEvidenceBundle([result('search_messages', [{
      key: 'wxid_lisi:42',
      name: '李四',
      time: '2026-10-20 10:00',
      snippet: '合同已经确认',
      source: 'msg',
      trace: { kind: 'msg', username: 'wxid_lisi', localId: 42 },
    }])])
    expect(bundle.items[0]?.citation).toMatchObject({
      username: 'wxid_lisi',
      local_id: 42,
      source: 'msg',
    })
    expect(bundle.items[0]?.locator).toEqual({
      type: 'message',
      username: 'wxid_lisi',
      localId: 42,
      key: 'wxid_lisi:42',
    })
  })

  it('稳定 key 无法解析时由 trace 兜底，不丢消息定位', () => {
    const bundle = buildEvidenceBundle([result('search_messages', [{
      key: 'unstable-message-key',
      name: '李四',
      time: '',
      snippet: '合同已经确认',
      source: 'msg',
      trace: { kind: 'msg', username: 'wxid_lisi', localId: 42 },
    }])])
    expect(bundle.items[0]?.citation).toMatchObject({ username: 'wxid_lisi', local_id: 42 })
  })

  it('文件等资源类命中不伪造 AskCitation，只保留 resource locator', () => {
    const bundle = buildEvidenceBundle([result('search_files', [{
      key: 'file:合同.pdf:0',
      name: '合同.pdf',
      time: '2026-10-20 09:00',
      snippet: '120 KB',
      source: 'msg',
    }])])
    const item = bundle.items[0]
    expect(item?.citation).toBeUndefined()
    expect(item?.locator).toMatchObject({ type: 'resource', tool: 'search_files' })
  })

  it('资源 trace 完整映射进 locator：收藏媒体类型不占用朋友圈 mediaId', () => {
    const bundle = buildEvidenceBundle([result('search_favorites', [{
      key: 'fav:7',
      name: '报价清单.xlsx',
      time: '2026-10-20 09:00',
      snippet: '文件 · 1.5 KB',
      source: 'resource',
      trace: {
        kind: 'resource',
        resource: {
          resourceKind: 'favorite',
          stableKey: 'fav:7',
          time: '2026-10-20 09:00',
          favoriteId: 7,
          serverId: '9007199254740993',
          sourceId: '9007199254740994',
          category: '文件',
          fileName: '报价清单.xlsx',
          size: 1536,
          md5: 'full-md5',
          mediaKind: 'file',
        },
      },
    }])])
    const item = bundle.items[0]
    expect(item).toMatchObject({
      evidenceId: 'res:search_favorites:fav:7',
      source: 'resource',
      key: 'fav:7',
      locator: {
        type: 'resource',
        tool: 'search_favorites',
        stableKey: 'fav:7',
        resourceKind: 'favorite',
        favoriteId: 7,
        serverId: '9007199254740993',
        sourceId: '9007199254740994',
        category: '文件',
        fileName: '报价清单.xlsx',
        size: 1536,
        md5: 'full-md5',
        mediaKind: 'file',
      },
    })
    expect(item?.citation).toBeUndefined()
    expect(item?.locator.type === 'resource' ? item.locator.mediaId : undefined).toBeUndefined()
    expect(bundle.stats.sourceCounts).toEqual({ msg: 0, kb: 0, agg: 0, resource: 1 })
    expect(bundle.stats.messages).toBe(0)
    expect(bundle.stats.sessions).toBe(0)
  })
})

describe('evidence：去重与预算不回退', () => {
  it('同块重复命中合并为一条，并保留合并后的完整 citation', () => {
    const trace = {
      kind: 'kb' as const,
      kbId: 3,
      fileId: 11,
      chunkId: 77,
      ordinal: 4,
      page: 2,
      heading: HEADING,
    }
    const bundle = buildEvidenceBundle([
      {
        tool: 'search_kb',
        ok: true,
        hits: [hit({ key: 'kb:3:77', snippet: '合同短片段说明', trace })],
      },
      {
        tool: 'search_hybrid',
        ok: true,
        hits: [hit({
          key: 'kb:3:77',
          snippet: '更长更完整的片段',
          trace,
        })],
      },
    ])
    expect(bundle.items).toHaveLength(1)
    expect(bundle.items[0]?.snippet).toBe('更长更完整的片段')
    expect(bundle.items[0]?.tools).toEqual(['search_hybrid', 'search_kb'])
    expect(kbCitation(bundle.items[0]?.citation)).toMatchObject({
      fileId: 11,
      ordinal: 4,
      page: 2,
    })
    expect(bundle.stats.duplicateCount).toBe(1)
  })

  it('先命中无 trace、后命中带 trace 时，合并不会丢掉可点击字段', () => {
    const bundle = buildEvidenceBundle([
      {
        tool: 'search_kb',
        ok: true,
        hits: [hit({ key: 'kb:6:55', name: '旧来源.pdf', snippet: '合同短片段说明' })],
      },
      {
        tool: 'search_hybrid',
        ok: true,
        hits: [hit({
          key: 'kb:6:55',
          name: '旧来源.pdf',
          snippet: '更长更完整的片段',
          trace: {
            kind: 'kb',
            kbId: 6,
            fileId: 21,
            chunkId: 55,
            ordinal: 7,
            page: 4,
            heading: '附录 › 二',
          },
        })],
      },
    ])
    expect(bundle.items).toHaveLength(1)
    expect(bundle.items[0]?.locator).toMatchObject({
      type: 'kb',
      fileId: 21,
      ordinal: 7,
      page: 4,
      heading: '附录 › 二',
    })
    expect(kbCitation(bundle.items[0]?.citation)).toMatchObject({
      kbId: 6,
      fileId: 21,
      chunkId: 55,
      ordinal: 7,
      page: 4,
      heading: '附录 › 二',
    })
  })

  it('条数预算仍按得分保留，KB citation 不因截断丢失', () => {
    const bundle = buildEvidenceBundle([
      {
        tool: 'search_kb',
        ok: true,
        hits: [
          hit({ key: 'kb:3:1', score: 0.1, snippet: '合同条款低分' }),
          hit({ key: 'kb:3:2', score: 0.9, snippet: '合同条款高分' }),
        ],
      },
    ], { maxItems: 1 })
    expect(bundle.items).toHaveLength(1)
    expect(bundle.items[0]?.key).toBe('kb:3:2')
    expect(bundle.items[0]?.citation).toBeTruthy()
    expect(bundle.stats.droppedByBudget).toBe(1)
  })
})

describe('evidence：范围能力不足与越界阻断分离', () => {
  it('list_sessions 不支持范围时降级，不丢弃同轮已取得的 8 条会话消息', () => {
    const messages = Array.from({ length: 8 }, (_, index) => ({
      key: `wxid_sellwine:${String(index + 1)}`,
      name: 'z_卖酒',
      time: `2026-10-${String(15 + index).padStart(2, '0')} 10:00`,
      snippet: `目标会话的第 ${String(index + 1)} 条消息`,
      source: 'msg' as const,
      trace: { kind: 'msg' as const, username: 'wxid_sellwine', localId: index + 1 },
    }))
    const bundle = buildEvidenceBundle([
      {
        tool: 'list_sessions',
        ok: false,
        error: '会话列表不支持当前固定会话或日期范围',
        errorCode: 'unsupported_scope',
        hits: [],
      },
      {
        tool: 'get_session_messages',
        ok: true,
        hits: messages,
      },
    ])

    expect(bundle.status).toBe('degraded')
    expect(bundle.items).toHaveLength(8)
    expect(bundle.stats).toMatchObject({
      messages: 8,
      failedTools: ['list_sessions'],
      unsupportedScopeResults: 1,
      scopeBlockedResults: 0,
      rejectedCount: 0,
    })
    expect(bundle.missing).toEqual(['list_sessions'])
  })

  it('只有 unsupported_scope 且没有可用证据时是 failed，不伪装成越界阻断', () => {
    const bundle = buildEvidenceBundle([{
      tool: 'list_sessions',
      ok: false,
      error: '会话列表不支持当前固定会话或日期范围',
      errorCode: 'unsupported_scope',
      hits: [],
    }])

    expect(bundle.status).toBe('failed')
    expect(bundle.items).toEqual([])
    expect(bundle.missing).toEqual(['evidence', 'list_sessions'])
    expect(bundle.stats.unsupportedScopeResults).toBe(1)
    expect(bundle.stats.scopeBlockedResults).toBe(0)
  })

  it('真正的越界仍阻断，且拒绝原因写入 rejectionNotes', () => {
    const bundle = buildEvidenceBundle([{
      tool: 'search_messages',
      ok: false,
      error: 'kb-only 已阻止访问本机微信数据',
      errorCode: 'data_scope_blocked',
      hits: [],
    }])

    expect(bundle.status).toBe('blocked')
    expect(bundle.missing).toContain('scope')
    expect(bundle.stats.scopeBlockedResults).toBe(1)
    expect(bundle.stats.rejectionNotes?.[0]).toContain('search_messages：kb-only')
  })
})
