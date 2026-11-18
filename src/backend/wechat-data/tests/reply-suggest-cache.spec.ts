// @vitest-environment node
/**
 * 推荐回复的**结果缓存**与失效条件。
 *
 * 现场诉求是「生成太慢」。慢在两头：模型生成本身，以及**重复生成** ——
 * 关掉面板再打开、切走再切回、点开详情再返回，此前每一次都重新调一次模型。
 *
 * 这份守卫钉住三件事：
 *  ① 同样的对话 + 同样的库 + 同样的模型 ⇒ 命中，不再调用模型；
 *  ② 对话变了 / 换了库 / 换了目标消息 / 换了模型 ⇒ 一定不命中（不能拿旧答案）；
 *  ③ 缓存坏数据不会让整条链路失败（当作未命中）。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  REPLY_SUGGEST_PROMPT_VERSION,
  readReplySuggestCache,
  replySuggestCacheKey,
  writeReplySuggestCache,
} from '../src/query/reply-suggest-cache.ts'

let root = ''
let decrypted = ''

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'reply-suggest-cache-'))
  decrypted = join(root, 'data', 'decrypted')
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

const LINES = ['[2026-11-18 16:00] 对方：报价多少', '[2026-11-18 16:01] 我：稍等']

function keyOf(over: Partial<Parameters<typeof replySuggestCacheKey>[0]> = {}): string {
  return replySuggestCacheKey({
    talker: 'wxid_peer',
    targetLocalId: 100,
    kbId: 0,
    model: 'opencode/kimi',
    want: 3,
    lines: LINES,
    ...over,
  })
}

describe('缓存键的失效条件', () => {
  it('同样的输入得到同一个键（这是命中的前提）', () => {
    expect(keyOf()).toBe(keyOf())
  })

  it('对话变了 ⇒ 新键（不能拿旧答案回复新消息）', () => {
    const next = keyOf({ lines: [...LINES, '[2026-11-18 16:02] 对方：快点'] })
    expect(next).not.toBe(keyOf())
  })

  it('换库 / 换目标消息 / 换模型 / 改候选条数 / 换会话 ⇒ 都是新键', () => {
    const base = keyOf()
    expect(keyOf({ kbId: 7 })).not.toBe(base)
    expect(keyOf({ targetLocalId: 101 })).not.toBe(base)
    expect(keyOf({ model: 'other/model' })).not.toBe(base)
    expect(keyOf({ want: 2 })).not.toBe(base)
    expect(keyOf({ talker: 'room@chatroom' })).not.toBe(base)
  })

  it('键里带提示词版本：改措辞后旧候选不会被误用', () => {
    expect(keyOf().startsWith('v' + String(REPLY_SUGGEST_PROMPT_VERSION))).toBe(true)
  })
})

describe('缓存的读写', () => {
  it('写入后能读回候选与留痕', () => {
    const key = keyOf()
    const trace = {
      systemPrompt: 'sys',
      userPrompt: 'user',
      contextLines: LINES,
      kbSnippets: [],
      rawOutput: '["a","b"]',
      model: 'opencode/kimi',
      elapsedMs: 1800,
      redacted: false,
    }
    writeReplySuggestCache(decrypted, key, { replies: ['a', 'b'], trace })
    const got = readReplySuggestCache(decrypted, key)
    expect(got?.replies).toEqual(['a', 'b'])
    expect(got?.trace).toEqual(trace)
  })

  it('未命中返回 undefined（调用方据此去调模型）', () => {
    expect(readReplySuggestCache(decrypted, keyOf())).toBeUndefined()
  })

  it('空候选不写入：否则会把「模型没给出可用候选」缓存成永久失败', () => {
    const key = keyOf()
    writeReplySuggestCache(decrypted, key, { replies: [] })
    expect(readReplySuggestCache(decrypted, key)).toBeUndefined()
  })

  it('覆盖写入取最新结果（同名键只留一份）', () => {
    const key = keyOf()
    writeReplySuggestCache(decrypted, key, { replies: ['旧'] })
    writeReplySuggestCache(decrypted, key, { replies: ['新'] })
    expect(readReplySuggestCache(decrypted, key)?.replies).toEqual(['新'])
  })
})
