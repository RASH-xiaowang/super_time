/**
 * 每库模型设置（`wechat_kb_models.db`）的回归用例。
 *
 * 守的是三件事，按危害排序：
 *   ① **读路径不能有写副作用**：`getKbs` 每次刷新都会问一遍「哪些库有自定义」，
 *      如果那次问话顺手把文件建出来，一个从未配过模型的装机就会多出一个空 db；
 *   ② **非法引用不许被静默纠正成「继承」**：那等于用户打错一个模型名，
 *      配置悄悄变回全局，而界面上显示「已保存」；
 *   ③ **按库隔离**：写甲库不能让乙库的解析结果变化（串味是这一层最贵的缺陷）。
 * @vitest-environment node
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  kbModelOverrideCounts,
  kbModelsOnKbDelete,
  normalizeModelRef,
  readKbModelSettings,
  resolveModelRef,
  touchKbEntitiesAt,
  writeKbModelSettings,
} from '../src/query/kb/model-config.ts'
import { kbModelsDbPath } from '../src/query/kb-paths.ts'

let root = ''
let decrypted = ''

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'wx-kbmodels-'))
  // ⚠ 产物路径是 `dirname(decryptedDir)` ⇒ decryptedDir 必须是子目录，
  // 否则多个用例的临时文件会互相看见（同一个坑在 kb-files 那边踩过一次）。
  decrypted = join(root, 'decrypted')
  mkdirSync(decrypted, { recursive: true })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('引用串的语法', () => {
  it('空 / 全空格 ⇒ 继承（规范化成空串）', () => {
    expect(normalizeModelRef('')).toBe('')
    expect(normalizeModelRef('   ')).toBe('')
    expect(normalizeModelRef(undefined)).toBe('')
    expect(normalizeModelRef(null)).toBe('')
  })

  it('m:<模型名> ⇒ 保留并去掉首尾空格', () => {
    expect(normalizeModelRef('m:bge-m3')).toBe('m:bge-m3')
    expect(normalizeModelRef('  m:BAAI/bge-reranker-v2-m3  ')).toBe('m:BAAI/bge-reranker-v2-m3')
  })

  it('其它形状一律拒绝（不静默变成「继承」）', () => {
    expect(normalizeModelRef('bge-m3')).toBeNull()
    expect(normalizeModelRef('p:silicon')).toBeNull()
    expect(normalizeModelRef('m:')).toBeNull()
    expect(normalizeModelRef('m:    ')).toBeNull()
    expect(normalizeModelRef(42)).toBeNull()
    // 上限：挡住把整段文本粘进输入框（这个值最终会出现在请求体与审计里）
    expect(normalizeModelRef('m:' + 'x'.repeat(121))).toBeNull()
    expect(normalizeModelRef('m:' + 'x'.repeat(120))).toBe('m:' + 'x'.repeat(120))
  })
})

describe('resolveModelRef：库级覆盖怎么叠在全局之上', () => {
  it('继承 ⇒ 用全局解析出来的名字', () => {
    expect(resolveModelRef('', 'deepseek-chat')).toEqual({ model: 'deepseek-chat', source: 'inherit', ref: '' })
  })

  it('点名 ⇒ 用点名的，并如实标 source=inline', () => {
    expect(resolveModelRef('m:bge-m3', 'text-embedding-3')).toEqual({ model: 'bge-m3', source: 'inline', ref: 'm:bge-m3' })
  })

  it('全局也没配 ⇒ 空串（调用方据此静默关闭该能力，不报错）', () => {
    expect(resolveModelRef('', '').model).toBe('')
    // 点名了但点的是空 —— 规范化层就拦住了，这里兜一层不抛错
    expect(resolveModelRef('m:  ', 'fallback').model).toBe('fallback')
  })
})

describe('设置的读写', () => {
  it('文件不存在时返回全继承，且**不创建文件**（读路径不许有写副作用）', () => {
    const file = kbModelsDbPath(decrypted)
    expect(existsSync(file)).toBe(false)
    const s = readKbModelSettings(decrypted, 1)
    expect(s).toEqual({ kbId: 1, chatRef: '', embedRef: '', rerankRef: '', entitiesAt: 0, updatedAt: 0 })
    expect(existsSync(file), '读一次就凭空建出了设置库').toBe(false)
    expect(kbModelOverrideCounts(decrypted).size).toBe(0)
  })

  it('部分更新：只改 embed_ref，另两个角色保持原值', () => {
    writeKbModelSettings(decrypted, 1, { chatRef: 'm:deepseek-reasoner' })
    const r = writeKbModelSettings(decrypted, 1, { embedRef: 'm:bge-m3' })
    expect(r.ok).toBe(true)
    const s = readKbModelSettings(decrypted, 1)
    expect(s.chatRef).toBe('m:deepseek-reasoner')
    expect(s.embedRef).toBe('m:bge-m3')
    expect(s.rerankRef).toBe('')
    expect(s.updatedAt).toBeGreaterThan(0)
  })

  it('非法引用 ⇒ 整次写入被拒，原值一个字都没变', () => {
    writeKbModelSettings(decrypted, 1, { embedRef: 'm:bge-m3' })
    const bad = writeKbModelSettings(decrypted, 1, { embedRef: 'bge-m3', rerankRef: 'm:ok-rerank' })
    expect(bad.ok).toBe(false)
    const s = readKbModelSettings(decrypted, 1)
    expect(s.embedRef).toBe('m:bge-m3')
    // 同一批里的另一项也不能被写进去（不是逐项提交）
    expect(s.rerankRef).toBe('')
  })

  it('写回空串 = 取消该角色的覆盖（回到继承）', () => {
    writeKbModelSettings(decrypted, 1, { rerankRef: 'm:bge-reranker-v2' })
    writeKbModelSettings(decrypted, 1, { rerankRef: '' })
    expect(readKbModelSettings(decrypted, 1).rerankRef).toBe('')
    expect(kbModelOverrideCounts(decrypted).has(1)).toBe(false)
  })

  it('kbId 非法 ⇒ 拒绝写入、读回全继承', () => {
    expect(writeKbModelSettings(decrypted, 0, { embedRef: 'm:x' }).ok).toBe(false)
    expect(readKbModelSettings(decrypted, -3).kbId).toBe(0)
  })
})

describe('按库隔离（这一层最贵的缺陷就是串味）', () => {
  it('写甲库不能让乙库的解析结果变化', () => {
    writeKbModelSettings(decrypted, 1, { embedRef: 'm:a-only' })
    expect(readKbModelSettings(decrypted, 2).embedRef).toBe('')
    expect(resolveModelRef(readKbModelSettings(decrypted, 2).embedRef, 'global-embed').model).toBe('global-embed')
    expect(resolveModelRef(readKbModelSettings(decrypted, 1).embedRef, 'global-embed').model).toBe('a-only')
  })

  it('override 计数按库统计，改过的才算', () => {
    writeKbModelSettings(decrypted, 1, { chatRef: 'm:x', embedRef: 'm:y' })
    writeKbModelSettings(decrypted, 2, { rerankRef: 'm:z' })
    writeKbModelSettings(decrypted, 3, { rerankRef: '' })
    const m = kbModelOverrideCounts(decrypted)
    expect(m.get(1)).toBe(2)
    expect(m.get(2)).toBe(1)
    expect(m.has(3)).toBe(false)
  })

  it('删库级联：那一行跟着消失，别的库不受影响', () => {
    writeKbModelSettings(decrypted, 1, { embedRef: 'm:a' })
    writeKbModelSettings(decrypted, 2, { embedRef: 'm:b' })
    expect(kbModelsOnKbDelete(decrypted, 1)).toBe(true)
    expect(readKbModelSettings(decrypted, 1).embedRef).toBe('')
    expect(readKbModelSettings(decrypted, 2).embedRef).toBe('m:b')
    // 再删一次（行已经不在）⇒ false，不是抛错
    expect(kbModelsOnKbDelete(decrypted, 1)).toBe(false)
  })
})

describe('entities_at：抽实体的时间戳', () => {
  it('记一笔就能读回来，且不动三个引用', () => {
    writeKbModelSettings(decrypted, 1, { chatRef: 'm:keep-me' })
    expect(touchKbEntitiesAt(decrypted, 1, 1_700_000_000_000)).toBe(true)
    const s = readKbModelSettings(decrypted, 1)
    expect(s.entitiesAt).toBe(1_700_000_000_000)
    expect(s.chatRef).toBe('m:keep-me')
    // 抽实体**不算多一个模型覆盖**：它只是留痕。计数应该仍是那 1 项（chatRef），
    // 而不是因为写了 entities_at 就变成「2 项自定义」。
    expect(kbModelOverrideCounts(decrypted).get(1)).toBe(1)
  })

  it('从未写过设置的库也能记上时间（自动建行）', () => {
    expect(touchKbEntitiesAt(decrypted, 7, 123)).toBe(true)
    expect(readKbModelSettings(decrypted, 7)).toMatchObject({ entitiesAt: 123, embedRef: '' })
  })

  it('kbId 非法 ⇒ 直接拒', () => {
    expect(touchKbEntitiesAt(decrypted, 0, 1)).toBe(false)
  })
})
