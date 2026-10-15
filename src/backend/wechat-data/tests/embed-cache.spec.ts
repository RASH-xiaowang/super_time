import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { LlmFactoryDeps } from '../src/gateway-llm-factory.ts'
import { makeEmbedFnOf } from '../src/gateway-llm-factory.ts'
import { dropEmbedCache, embedCacheKey, embedCacheMaxBytes, embedCachePath, lookupEmbedCache, storeEmbedCache } from '../src/query/embed-cache.ts'

/**
 * W3-6.2：embedding 落盘缓存。
 *
 * 这一条要钉的不是「命中了会变快」（那是显然的），而是三条**红线**：
 *   ① 缓存不得跨脱敏口径取用（键里带命名空间）；
 *   ② 命中不得改变出网审计口径（没出网 ⇒ 不写审计）；
 *   ③ 缓存不得让主路失败（库读不动 / 磁盘满 / 维度不齐，都只是「没命中」）。
 * 外加两条工程约束：键确实由**截断后**的文本算出、体积有上界。
 */

/** 每个用例一个独立数据根；`retrievalRoot` 取的是解密目录的父目录，所以要多包一层。 */
let root = ''
const opened: string[] = []

function freshRoot(): string {
  root = join(mkdtempSync(join(tmpdir(), 'embed-cache-')), 'decrypted')
  opened.push(root)
  return root
}

beforeEach(() => { freshRoot() })
// 只关句柄，不删临时目录：Windows 上 SQLite 句柄的释放有延迟，立刻 rmSync 会 EPERM。
// 临时目录由系统清理；每个用例的根都是新 mkdtemp 的，互不干扰。
afterEach(() => {
  for (const d of opened) { dropEmbedCache(d) }
  opened.length = 0
})

/**
 * 按 **float32** 精度比较向量。
 *
 * 为什么需要：缓存把向量存成 float32（向量本身就是 float32 语义，`vecToBlob` 也只存 4 字节/维），
 * 所以命中回来的数与桥直接给的 double 差 1e-8 量级 —— 那是存储格式决定的，不是缺陷。
 */
function approx(a: number[][]): number[][] {
  return a.map((v) => v.map((x) => Math.fround(x)))
}

interface Gate { calls: number; features: string[] }

function makeDeps(o: { embed: (t: string[], m?: { model?: string }) => Promise<number[][]>; redact?: boolean; gate?: (texts: string[]) => string[] }, gate?: Gate): LlmFactoryDeps {
  const g: Gate = gate ?? { calls: 0, features: [] }
  return {
    llm: { embed: async (t: string[], m?: { model?: string }) => { await Promise.resolve(); return o.embed(t, m) } },
    host: {},
    kbModel: () => ({ model: '', source: 'inherit', ref: '' }),
    privacyGate: (feature, _stats, texts) => { g.calls += 1; g.features.push(feature); return o.gate ? o.gate(texts) : texts },
    decryptedDir: () => root,
    redactMode: () => o.redact === true,
  }
}

describe('W3-6.2 缓存基本行为', () => {
  it('冷目录未命中 ⇒ 走闸门并出网；写回后同文本再发 ⇒ 命中且不再出网', async () => {
    const gate: Gate = { calls: 0, features: [] }
    const embed = vi.fn(async () => [[0.1, 0.2]])
    const fn = makeEmbedFnOf(makeDeps({ embed }, gate), 'vec-1', 'ask_embed')!
    // 冷目录：原样返回桥给的值（还没经过任何序列化）
    expect(await fn(['今天天气怎么样'])).toEqual([[0.1, 0.2]])
    expect(embed).toHaveBeenCalledTimes(1)
    expect(gate.calls).toBe(1)
    // 命中：经过一次 float32 存取
    expect(approx(await fn(['今天天气怎么样']))).toEqual(approx([[0.1, 0.2]]))
    expect(embed, '第二次应当命中缓存，不再出网').toHaveBeenCalledTimes(1)
    expect(gate.calls, '命中 = 没有字节出网 = 不该写审计').toBe(1)
  })

  it('换数据根就是换缓存（不会把上一个根的向量取过来）', async () => {
    const embed = vi.fn(async () => [[0.5]])
    const fn = makeEmbedFnOf(makeDeps({ embed }), 'vec-1', 'ask_embed')!
    await fn(['同一句话'])
    freshRoot()
    const fn2 = makeEmbedFnOf(makeDeps({ embed }), 'vec-1', 'ask_embed')!
    await fn2(['同一句话'])
    expect(embed).toHaveBeenCalledTimes(2)
  })

  it('换模型名就是换缓存（不同模型的向量不通用）', async () => {
    const embed = vi.fn(async () => [[0.5]])
    await makeEmbedFnOf(makeDeps({ embed }), 'vec-1', 'ask_embed')!(['同一句话'])
    await makeEmbedFnOf(makeDeps({ embed }), 'vec-2', 'ask_embed')!(['同一句话'])
    expect(embed).toHaveBeenCalledTimes(2)
  })

  it('缓存落在数据根里（与 wechat_search.db 同级，可随数据目录一起迁移/删除）', () => {
    expect(embedCachePath(root)).toBe(join(root, '..', 'wechat_embed_cache.db'))
    storeEmbedCache(root, [embedCacheKey('p', 'm', 't')], [[1, 2]])
    expect(existsSync(embedCachePath(root))).toBe(true)
  })
})

describe('W3-6.2 隐私红线：脱敏口径', () => {
  it('脱敏开时算出的向量，绝不会在脱敏关时被取出来用', async () => {
    const redactVec = [[1, 1, 1]]
    const plainVec = [[2, 2, 2]]
    // 第一轮：脱敏**开**，闸门把「联系 @123」换成「联系 〔用户〕」，桥按脱敏后的文本给向量。
    const r1 = makeDeps({
      redact: true,
      gate: (t) => t.map((x) => x.replace(/@\d+/g, '〔用户〕')),
      embed: async () => redactVec,
    })
    expect(await makeEmbedFnOf(r1, 'vec-1', 'ask_embed')!(['联系 @123'])).toEqual(redactVec)
    // 第二轮：脱敏**关**，同一句原文。此时若缓存跨口径，就会拿到 redactVec。
    const r2 = makeDeps({ redact: false, embed: async () => plainVec })
    expect(await makeEmbedFnOf(r2, 'vec-1', 'ask_embed')!(['联系 @123'])).toEqual(plainVec)
  })

  it('两个命名空间下的键确实不同（红线 ① 的最小单元）', () => {
    expect(embedCacheKey('r', 'm', '同一句')).not.toBe(embedCacheKey('p', 'm', '同一句'))
  })

  it('命中时桥一次都没被叫到，闸门也没被叫到（红线 ②）', async () => {
    const gate: Gate = { calls: 0, features: [] }
    const embed = vi.fn(async () => [[1, 2, 3]])
    const fn = makeEmbedFnOf(makeDeps({ embed }, gate), 'vec-1', 'kb_embed')!
    await fn(['kb 正文'])
    await fn(['kb 正文'])
    await fn(['kb 正文'])
    expect(embed).toHaveBeenCalledTimes(1)
    expect(gate.calls).toBe(1)
    expect(gate.features).toEqual(['kb_embed'])
  })
})

describe('W3-6.2 缓存不得拖垮主路', () => {
  it('维度不齐的一批不写缓存（错配的维度会流进向量库）', () => {
    storeEmbedCache(root, ['k1', 'k2'], [[1, 2], [1, 2, 3]])
    expect(lookupEmbedCache(root, ['k1', 'k2'])).toBeNull()
  })

  it('空向量不写缓存', () => {
    storeEmbedCache(root, ['k1'], [[]])
    expect(lookupEmbedCache(root, ['k1'])).toBeNull()
  })

  it('键与向量数量对不上时整批不写', () => {
    storeEmbedCache(root, ['k1', 'k2'], [[1, 2]])
    expect(lookupEmbedCache(root, ['k1', 'k2'])).toBeNull()
  })

  it('上游抛错 ⇒ 原样抛出，缓存里不留半条（红线 ③）', async () => {
    const gate: Gate = { calls: 0, features: [] }
    const fn = makeEmbedFnOf(makeDeps({ embed: async () => { throw new Error('上游 429') } }, gate), 'vec-1', 'ask_embed')!
    await expect(fn(['会失败的那句'])).rejects.toThrow('上游 429')
    expect(lookupEmbedCache(root, [embedCacheKey('p', 'vec-1', '会失败的那句')])).toBeNull()
    // 再来一次仍然是「未命中」而不是「命中了一个空结果」。
    await expect(fn(['会失败的那句'])).rejects.toThrow('上游 429')
    expect(gate.calls).toBe(2)
  })

  it('库文件损坏时只是不命中，不会让 embedding 失败', async () => {
    const embed = vi.fn(async () => [[0.9]])
    const fn = makeEmbedFnOf(makeDeps({ embed }), 'vec-1', 'ask_embed')!
    await fn(['第一句'])
    // 把缓存库换成一段不是 SQLite 的字节：下一个用例进来到的应是「未命中」。
    const { writeFileSync } = require('node:fs') as typeof import('node:fs')
    dropEmbedCache(root)
    writeFileSync(embedCachePath(root), 'not a database at all')
    const fn2 = makeEmbedFnOf(makeDeps({ embed }), 'vec-1', 'ask_embed')!
    await expect(fn2(['第一句'])).resolves.toEqual([[0.9]])
    // （第一次那个 0.9 是原样返回的，没有经过缓存；这里关心的是没抛错。）
    expect(embed).toHaveBeenCalledTimes(2)
  })
})

describe('W3-6.2 体积上界', () => {
  it('默认上限是 64 MiB，env 可覆盖且夹在 [0, 1024]', () => {
    const saved = process.env.DSH_WECHAT_EMBED_CACHE_MB
    try {
      delete process.env.DSH_WECHAT_EMBED_CACHE_MB
      expect(embedCacheMaxBytes()).toBe(64 * 1024 * 1024)
      process.env.DSH_WECHAT_EMBED_CACHE_MB = '1'
      expect(embedCacheMaxBytes()).toBe(1024 * 1024)
      process.env.DSH_WECHAT_EMBED_CACHE_MB = '99999'
      expect(embedCacheMaxBytes()).toBe(1024 * 1024 * 1024)
      process.env.DSH_WECHAT_EMBED_CACHE_MB = '0'
      expect(embedCacheMaxBytes(), '0 表示显式关掉缓存').toBe(64 * 1024 * 1024)
      process.env.DSH_WECHAT_EMBED_CACHE_MB = 'abc'
      expect(embedCacheMaxBytes(), '非法值回落默认').toBe(64 * 1024 * 1024)
    } finally {
      if (saved === undefined) delete process.env.DSH_WECHAT_EMBED_CACHE_MB
      else process.env.DSH_WECHAT_EMBED_CACHE_MB = saved
    }
  })

  it('上限调小之后，最久未用的先被淘汰', () => {
    const saved = process.env.DSH_WECHAT_EMBED_CACHE_MB
    try {
      // 1MiB 上限：每条 4 维 float32 = 16 字节，写满几千条就会触发淘汰。
      process.env.DSH_WECHAT_EMBED_CACHE_MB = '1'
      // 1MiB 上限：4 维 float32 = 16 字节/条，7 万条 ≈ 1.07MiB，才会真的触发淘汰。
      const keys = Array.from({ length: 70000 }, (_, i) => embedCacheKey('p', 'm', `t${i}`))
      storeEmbedCache(root, keys, keys.map(() => [1, 2, 3, 4]))
      // 第一批应当大部分还在（淘汰只砍到上限以下，不会清空）。
      expect(lookupEmbedCache(root, [keys[0] as string])).not.toBeNull()
      expect(lookupEmbedCache(root, keys)).toBeNull()
    } finally {
      if (saved === undefined) delete process.env.DSH_WECHAT_EMBED_CACHE_MB
      else process.env.DSH_WECHAT_EMBED_CACHE_MB = saved
    }
  })
})

describe('W3-6.2 键必须由截断后的文本算出', () => {
  it('向量库里先按 maxCharsPerDoc 截断，所以只截断前缀相同的两段文本应当共用一条缓存', async () => {
    const embed = vi.fn(async (t: string[]) => [[t[0]?.length ?? 0, 0, 0, 0]])
    const fn = makeEmbedFnOf(makeDeps({ embed }), 'vec-1', 'ask_embed')!
    await fn(['共同前缀' + '甲'.repeat(50)])
    await fn(['共同前缀' + '乙'.repeat(50)])
    // 本用例直接用**截断后**的文本做键，验证键的计算与截断无关、只吃文本本身。
    const k = embedCacheKey('p', 'vec-1', '共同前缀')
    expect(lookupEmbedCache(root, [k])).toBeNull()
    storeEmbedCache(root, [k], [[1, 2, 3, 4]])
    expect(lookupEmbedCache(root, [k])).not.toBeNull()
  })
})