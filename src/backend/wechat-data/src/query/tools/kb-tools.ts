/**
 * 知识库与语义检索工具（2026-10-16 新增）。
 *
 * 两个工具：
 *   · `search_kb` —— 在**当前知识库**的文件里做关键词检索（合同、报表、笔记…）；
 *   · `search_semantic` —— 在**聊天消息**上做向量语义检索（「意思相近但用词不同」）。
 *
 * ## 为什么语义检索要独立成工具
 *
 * 关键词检索（`search_messages`）对「转账」这种**词面明确**的问题很好，
 * 但对「我最近是不是有点焦虑」这类**语义**问题完全无效 —— 聊天里没人写「焦虑」。
 * 向量检索能召回「最近好累」「睡不着」这类语义相近的消息。
 *
 * 两者是**互补**的，不是替代关系：所以做成两个工具让模型按问题性质选，
 * 而不是在一条流水线里固定混用（混用时权重怎么定是个没有正确答案的问题）。
 *
 * @module query/tools/kb-tools
 */
import { searchKb } from '../kb-search.ts'
import { searchDense, vectorIndexStatus, type EmbedFn } from '../retrieval/embedding.ts'
import { argInt, argString, type RetrievalTool, type ToolResult } from './types.ts'

/** 知识库文件检索。 */
export const searchKbTool: RetrievalTool = {
  name: 'search_kb',
  category: 'kb',
  description:
    '在**当前知识库的文件**里检索（合同、报表、笔记、PDF 等）。'
    + '适用于「合同里怎么写的」「报表里的数字」「我笔记里记过什么」这类问题。'
    + '注意：它查的是**导入的文件**，不是聊天记录 —— 问聊天内容请用 search_messages。',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '检索词（多个词用空格分隔）' },
      limit: { type: 'number', description: '最多返回几条（默认 12，上限 60）' },
    },
    required: ['query'],
  },
  run: (args, ctx): ToolResult => {
    const started = Date.now()
    const q = argString(args['query']).trim()
    if (!q) return { tool: 'search_kb', ok: false, error: '缺少 query', hits: [] }
    if (ctx.kbId === undefined || ctx.kbId <= 0) {
      return { tool: 'search_kb', ok: false, error: '当前没有选中知识库', hits: [] }
    }
    const limit = argInt(args['limit'], 12, 1, 60)
    try {
      // `onlyRag: true` 与问答路径一致：只搜「允许参与 RAG」的文件。
      const res = searchKb(ctx.decryptedDir, ctx.kbId, { query: q, topK: limit, onlyRag: true })
      if (res.error) return { tool: 'search_kb', ok: false, error: res.error, hits: [] }
      const hits = res.hits.map(h => ({
        key: `kb:${String(ctx.kbId)}:${String(h.chunkId)}`,
        name: h.fileName,
        time: '',
        snippet: h.text.slice(0, 300),
        source: 'kb' as const,
        score: h.score,
      }))
      return {
        tool: 'search_kb', ok: true, hits,
        note: `「${q}」→ ${hits.length} 个文件块（${res.stats.elapsedMs}ms）`,
        elapsedMs: Date.now() - started,
      }
    } catch (e) {
      return { tool: 'search_kb', ok: false, error: (e as Error).message, hits: [] }
    }
  },
}

/**
 * 语义检索（向量）。
 *
 * `embedFn` 由调用方注入（它含隐私闸门）—— 工具本身**不构造** embedding 函数：
 * 那需要读配置、过闸门、写审计，属于装配层的事，不该藏在工具里。
 * 没注入时如实返回「未配置向量模型」，而不是静默退化成关键词检索
 * （静默退化会让「语义检索没生效」变成一个查不出来的问题）。
 */
export function makeSearchSemanticTool(embedFn?: EmbedFn, embedModel = ''): RetrievalTool {
  return {
    name: 'search_semantic',
    category: 'message',
    description:
      '在聊天记录上做**语义检索**（向量相似度）：找「意思相近」的消息，即使字面不同。'
      + '适用于「我最近是不是很累」「有没有人抱怨过 X」这类**词面不明确**的问题。'
      + '与 search_messages 互补：那个按关键词精确匹配，这个按语义相近。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '用自然语言描述要找什么（不必是聊天里出现过的词）' },
        limit: { type: 'number', description: '最多返回几条（默认 12，上限 60）' },
      },
      required: ['query'],
    },
    run: async (args, ctx): Promise<ToolResult> => {
      const started = Date.now()
      const q = argString(args['query']).trim()
      if (!q) return { tool: 'search_semantic', ok: false, error: '缺少 query', hits: [] }
      if (!embedFn) return { tool: 'search_semantic', ok: false, error: '未配置向量模型（embedding）', hits: [] }
      const st = vectorIndexStatus(ctx.decryptedDir)
      if (!st.ready) return { tool: 'search_semantic', ok: false, error: '向量索引未就绪', hits: [] }
      const limit = argInt(args['limit'], 12, 1, 60)
      try {
        const res = await searchDense(ctx.decryptedDir, q, embedFn, {
          topK: limit,
          minSimilarity: 0.2,
          candidatePool: 2000,
          ...(ctx.scope?.username ? { username: ctx.scope.username } : {}),
        })
        const hits = res.docs.map((d, i) => ({
          key: d.docKey,
          name: d.name,
          time: d.create_time ? new Date(d.create_time * 1000).toISOString().slice(0, 16).replace('T', ' ') : '',
          snippet: d.snippet || d.text.slice(0, 200),
          ...(d.sender ? { sender: d.sender } : {}),
          source: 'msg' as const,
          score: res.scores[i] ?? 0,
        }))
        return {
          tool: 'search_semantic', ok: true, hits,
          note: `语义检索「${q}」→ ${hits.length} 条${embedModel ? `（${embedModel}）` : ''}`,
          elapsedMs: Date.now() - started,
        }
      } catch (e) {
        return { tool: 'search_semantic', ok: false, error: (e as Error).message, hits: [] }
      }
    },
  }
}

/** 知识库工具集（语义检索需要注入 embedFn，所以由调用方组装）。 */
export const KB_TOOLS: readonly RetrievalTool[] = [searchKbTool]
