/**
 * Shared metadata cache: mtime-based invalidation for contact/shard maps.
 * @vitest-environment node
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { cachedBySig, contactMeta, shardCatalog, invalidateWechatMeta, bumpDataGeneration, dataGenerationSig } from '../src/query/meta.ts'
import { getDbStatus } from '../src/query/status.ts'
import { gatewayClassSource } from '../../tests/gateway-source.ts'

const scratch: string[] = []
afterEach(() => {
  invalidateWechatMeta()
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true })
  scratch.length = 0
})

function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wx-meta-'))
  scratch.push(dir)
  return dir
}

function makeDb(path: string, create: (db: DatabaseSync) => void): void {
  mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  try { create(db) } finally { db.close() }
}

function bumpMtime(path: string): void {
  const t = new Date(Date.now() + 1000)
  utimesSync(path, t, t)
}

describe('contactMeta cache', () => {
  it('reloads after contact.db changes (name map reflects new remark)', () => {
    const root = tempRoot()
    const p = join(root, 'contact', 'contact.db')
    makeDb(p, (db) => {
      db.exec('CREATE TABLE contact (username TEXT, remark TEXT, nick_name TEXT)')
      db.prepare('INSERT INTO contact VALUES (?,?,?)').run('wxid_a', '旧备注', '旧nick')
    })
    expect(contactMeta(root).names.get('wxid_a')).toBe('旧备注')
    makeDb(p, (db) => {
      db.exec('CREATE TABLE IF NOT EXISTS contact (username TEXT, remark TEXT, nick_name TEXT)')
      db.exec('DELETE FROM contact')
      db.prepare('INSERT INTO contact VALUES (?,?,?)').run('wxid_a', '新备注', '新nick')
    })
    bumpMtime(p)
    expect(contactMeta(root).names.get('wxid_a')).toBe('新备注')
  })

  it('reads pinned and biz types from the same contact.db pass', () => {
    const root = tempRoot()
    const p = join(root, 'contact', 'contact.db')
    makeDb(p, (db) => {
      db.exec('CREATE TABLE contact (username TEXT, remark TEXT, nick_name TEXT, flag INTEGER)')
      db.prepare('INSERT INTO contact VALUES (?,?,?,?)').run('wxid_a', 'A', '', 0x800)
      db.exec('CREATE TABLE biz_info (username TEXT, type INTEGER)')
      db.prepare('INSERT INTO biz_info VALUES (?,?)').run('gh_1', 1)
    })
    const meta = contactMeta(root)
    expect(meta.pinned.has('wxid_a')).toBe(true)
    expect(meta.bizTypes.get('gh_1')).toBe(1)
  })
})

describe('shardCatalog cache', () => {
  it('discovers tables across files and picks up newly added shards', () => {
    const root = tempRoot()
    const dir = join(root, 'message')
    mkdirSync(dir, { recursive: true })
    const a = join(dir, 'message_0.db')
    const b = join(dir, 'message_1.db')
    makeDb(a, (db) => { db.exec('CREATE TABLE Msg_a (id INTEGER)') })
    makeDb(b, (db) => { db.exec('CREATE TABLE Msg_b (id INTEGER)') })

    let cat = shardCatalog(root)
    expect(cat.length).toBe(2)
    const hasA = cat.some(s => s.tables.has('Msg_a'))
    const hasB = cat.some(s => s.tables.has('Msg_b'))
    expect(hasA).toBe(true)
    expect(hasB).toBe(true)

    const c = join(dir, 'message_2.db')
    makeDb(c, (db) => { db.exec('CREATE TABLE Msg_c (id INTEGER)') })
    // Directory mtime changes when a new file appears; the cache must refresh.
    bumpMtime(dir)
    cat = shardCatalog(root)
    expect(cat.some(s => s.tables.has('Msg_c'))).toBe(true)
  })

  it('只重写其中一个分片时，未变的分片复用同一个 ShardMeta 对象（M8 分片粒度）', () => {
    const root = tempRoot()
    const dir = join(root, 'message')
    mkdirSync(dir, { recursive: true })
    const a = join(dir, 'message_0.db')
    const b = join(dir, 'message_1.db')
    makeDb(a, (db) => { db.exec('CREATE TABLE Msg_a (id INTEGER)') })
    makeDb(b, (db) => { db.exec('CREATE TABLE Msg_b (id INTEGER)') })

    const before = shardCatalog(root)
    const beforeA = before.find(s => s.file === a)
    const beforeB = before.find(s => s.file === b)
    expect(beforeA).toBeTruthy()
    expect(beforeB).toBeTruthy()

    // 只有 message_1.db 被重写。实时同步两种模式最终都走 atomicReplace 原子替换目标文件，
    // mtime 必然变化 —— 这里显式 bump 让它确定。
    makeDb(b, (db) => {
      db.exec('CREATE TABLE IF NOT EXISTS Msg_b (id INTEGER)')
      db.exec('CREATE TABLE Msg_b2 (id INTEGER)')
    })
    bumpMtime(b)

    const after = shardCatalog(root)
    const afterA = after.find(s => s.file === a)
    const afterB = after.find(s => s.file === b)

    // 关键断言：**对象同一性**。没有按文件粒度的缓存时，这里会是一个新加载的对象
    // （整条目录级条目失效 → 全部分片重新 loadShardMeta）。
    expect(afterA).toBe(beforeA)
    // 变了的那一个必须是新对象、且反映新结构（否则就是缓存过旧）
    expect(afterB).not.toBe(beforeB)
    expect(afterB?.tables.has('Msg_b2')).toBe(true)
  })
})

describe('cachedBySig', () => {
  it('serves the cached value for the same signature without re-running the loader', () => {
    let calls = 0
    const loader = (): string => { calls += 1; return 'v' }
    expect(cachedBySig('k', 'sig1', loader)).toBe('v')
    expect(cachedBySig('k', 'sig1', loader)).toBe('v')
    expect(calls).toBe(1)
  })

  it('recomputes when the signature changes', () => {
    let calls = 0
    const loader = (): number => { calls += 1; return calls }
    expect(cachedBySig('k2', 's1', loader)).toBe(1)
    expect(cachedBySig('k2', 's2', loader)).toBe(2)
    expect(calls).toBe(2)
  })

  it('evicts when invalidateWechatMeta is called', () => {
    let calls = 0
    const loader = (): number => { calls += 1; return calls }
    expect(cachedBySig('k3', 'sx', loader)).toBe(1)
    invalidateWechatMeta()
    expect(cachedBySig('k3', 'sx', loader)).toBe(2)
    expect(calls).toBe(2)
  })

  it('accepts a per-key maxAgeMs and still caches by signature', () => {
    let calls = 0
    const loader = (): number => { calls += 1; return calls }
    expect(cachedBySig('k-ttl', 's1', loader, 30_000)).toBe(1)
    expect(cachedBySig('k-ttl', 's1', loader, 30_000)).toBe(1)
    expect(calls).toBe(1)
  })
})

describe('数据世代签名（M8：给「依赖整棵树」的条目显式失效）', () => {
  it('bumpDataGeneration 让签名变化（单调递增，不存在「变了但签名没变」）', () => {
    const a = dataGenerationSig()
    bumpDataGeneration()
    const b = dataGenerationSig()
    expect(b).not.toBe(a)
    bumpDataGeneration()
    expect(dataGenerationSig()).not.toBe(b)
  })

  it('用它当签名的条目只在 bump 之后重算（未 bump 时命中缓存）', () => {
    // 直接验证契约：同一个 sig 连续取两次命中；bump 之后必须重算。
    let calls = 0
    const loader = (): number => { calls += 1; return calls }
    expect(cachedBySig('gen-cache', dataGenerationSig(), loader, 30_000)).toBe(1)
    expect(cachedBySig('gen-cache', dataGenerationSig(), loader, 30_000)).toBe(1)
    bumpDataGeneration()
    expect(cachedBySig('gen-cache', dataGenerationSig(), loader, 30_000)).toBe(2)
  })

  it('getDbStatus（整树统计）随 bump 失效 —— 不再只靠 5s TTL', () => {
    // 原先用常量签名 'fs-status-v1'，只能等 TTL；去掉「事件后整表清空」后，
    // 常量签名会让它在同步落地后最长 5s 内返回旧快照。现在按世代失效。
    const root = tempRoot()
    mkdirSync(join(root, 'contact'), { recursive: true })
    const first = getDbStatus(root)
    expect(getDbStatus(root)).toBe(first) // 未 bump：同一对象（命中）
    bumpDataGeneration()
    expect(getDbStatus(root)).not.toBe(first) // bump 后重算
  })
})

describe('接线：同步事件必须推进数据世代，且不得改回整体清空（M8）', () => {
  /**
   * 为什么需要这条源码级守卫：上面的用例都是**直接调** `bumpDataGeneration()` 的，
   * 删掉 `gateway.ts` 里那句调用它们照样全绿 —— 而「事件没推进世代」正是这次改造最怕的
   * 无声退化（整树统计类条目会退回只剩 TTL，且没人看得出来）。
   * 仓库里 `llm-retry.spec.ts` 的「不得有裸 fetch」是同款守卫。
   */
  // M21 结构刀：构造器（含实时同步接线）住在 gateway-core.ts ⇒ 读组成网关类的两个文件
  const src = gatewayClassSource()

  /**
   * 截出同步回调那一段（从 `startRealtimeSync(` 到紧随其后的 `ctx.effect(() => stopSync`），
   * 并**剥掉注释**：不剥的话，注释里提到 `bumpDataGeneration()` 会让「推进了世代」这条
   * 在删掉调用之后仍然通过（反之注释里提到旧写法也会让另一条误报）。
   */
  function syncCallbackSource(): string {
    const start = src.indexOf('startRealtimeSync(')
    expect(start, '网关类里找不到 startRealtimeSync(').toBeGreaterThan(-1)
    const end = src.indexOf('ctx.effect(() => stopSync', start)
    expect(end, '网关类里找不到 stopSync 的 effect 注册（同步回调的结束标志）').toBeGreaterThan(start)
    return src.slice(start, end)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split(/\r?\n/).map((l) => l.replace(/\/\/.*$/, '')).join('\n')
  }

  it('同步回调里推进了数据世代', () => {
    expect(syncCallbackSource()).toContain('bumpDataGeneration()')
  })

  it('同步回调里没有改回整体清空（那会让没变的分片也被重载）', () => {
    expect(syncCallbackSource()).not.toContain('invalidateWechatMeta()')
  })

  it('全量解密那条路径仍然整体清空（整棵树都被换掉）', () => {
    // 保证 invalidateWechatMeta 不是死代码：它由 decryptAllDatabases 使用。
    expect(src).toContain('invalidateWechatMeta()')
  })
})
