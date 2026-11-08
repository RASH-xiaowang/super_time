// @vitest-environment node
/**
 * 推荐回复的知识库召回验收。
 *
 * 现场问题：最后一句是“你是干嘛的啊？”，旧实现只拿这一句做 FTS 短语检索，
 * 前面已经出现的 RPA、机器人、流程自动化等线索全部没进查询，最终误报“知识库无内容”。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { registerKbFile } from '../src/query/kb-files.ts'
import { buildKbVectorIndex } from '../src/query/kb-vectors.ts'
import { buildReplyKbQuery, collectReplyKbSnippetsHybrid } from '../src/query/reply-kb.ts'

const MODEL = 'stub-reply-embed-v1'
const KB_ID = 17

let root = ''
let decrypted = ''
let source = ''

function stubEmbed(calls: string[]) {
  return async (texts: string[]): Promise<number[][]> => {
    calls.push(...texts)
    return texts.map((text) => {
      const vector = new Array<number>(32).fill(0)
      for (const ch of text) {
        const bucket = (ch.codePointAt(0) ?? 0) % vector.length
        vector[bucket] = (vector[bucket] ?? 0) + 1
      }
      return vector
    })
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'reply-kb-'))
  decrypted = join(root, 'data', 'decrypted')
  source = join(root, 'source')
  mkdirSync(decrypted, { recursive: true })
  mkdirSync(source, { recursive: true })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('推荐回复的知识库查询', () => {
  it('短问句不会覆盖前文领域词，语义查询仍保留完整上下文', () => {
    const query = buildReplyKbQuery([
      '我：我是做RPA机器人流程自动化那块，刚才那个是工作文件',
      '我：发错工作文件了，忽略忽略',
      '对方：你是干嘛的啊？',
    ], '你是干嘛的啊？')

    expect(query.semantic).toContain('RPA机器人流程自动化')
    expect(query.semantic).toContain('你是干嘛的啊')
    expect(query.lexical).toContain('rpa')
    expect(query.lexical).toContain('流程')
    expect(query.lexical).toContain('自动')
    expect(query.lexical).toContain('机器')
    expect(query.lexical).not.toContain('你是')
  })

  it('混合检索会从更早的对话线索命中知识库，而不是只看最后一句', async () => {
    const file = join(source, 'rpa产品说明.md')
    writeFileSync(
      file,
      '# RPA 数字员工\n\nRPA 机器人流程自动化可以处理重复性办公任务，减少人工操作。\n',
      'utf8',
    )
    const registered = registerKbFile(decrypted, { kbId: KB_ID, srcPath: file })
    expect(registered.ok, registered.error).toBe(true)

    const calls: string[] = []
    const embed = stubEmbed(calls)
    const built = await buildKbVectorIndex(decrypted, KB_ID, embed, {
      model: MODEL,
      batchSize: 16,
      maxCharsPerDoc: 4000,
      maxDocsPerBuild: 1000,
    })
    expect(built.status, built.message).toBe('ok')
    const callsAfterBuild = calls.length

    const result = await collectReplyKbSnippetsHybrid({
      decryptedDir: decrypted,
      kbId: KB_ID,
      lines: [
        '我：我是做RPA机器人流程自动化那块，刚才那个是工作文件',
        '我：发错工作文件了，忽略忽略',
        '对方：你是干嘛的啊？',
      ],
      latestPeer: '你是干嘛的啊？',
      topK: 3,
      makeEmbedFn: () => embed,
      kbModel: () => ({ model: MODEL }),
    })

    expect(result.snippets.length).toBeGreaterThan(0)
    expect(result.snippets[0]).toContain('RPA')
    expect(calls.length, '向量索引就绪时应同时运行稠密通道').toBeGreaterThan(callsAfterBuild)
  })
})
