/**
 * 布局坐标的**作用域隔离**与持久化（纯函数，node 环境可跑）。
 *
 * 为什么单独一个文件而不是塞进 `graph-layout.spec.ts`：那份用例开头就写明了
 * 「localStorage 与 Worker 在 node 里不存在，也刻意不碰 —— 它们分别属于持久化与调度两条
 * 旁路，不是布局本身的口径」。本文件测的正是那条旁路，把它绑在布局口径上会同时污染两边。
 *
 * 为什么这条旁路值得单独锁：
 *   ① 节点 id（`note:7` / `kb:项目组`）**不带库前缀**（设计稿 §4.4 刻意如此），
 *      两库之间 id 是撞的 —— 共用一张扁平坐标表时，甲库调好的形状会被当成乙库的初值。
 *      症状轻微到「切库后形状有点像上一个库」，静态检查完全抓不到。
 *   ② `localStorage` 有写坏 / 被占满 / 隐私模式三种失败；这里全部走「当成没有历史布局」，
 *      任何一种抛出都会让面板整个挂掉。
 *   ③ LRU 上限是「配额」纪律：总占用 = 单图上限 × 作用域数，而渲染进程的 localStorage 里
 *      还住着消息缓存（真机实测过会被占满）。
 *
 * localStorage 用一个 5 行的桩（本模块只用到 getItem / setItem）。桩必须在每个用例前装，
 * 因为 `graph-layout.ts` 是在**函数体里**读全局的，不在模块顶层。
 *
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_KB_ID, POSITION_SCOPES_MAX, SOCIAL_SCOPE, kbScope } from '../kb-scope-keys.ts'
import { loadSavedPositions, savePositions } from './graph-layout.ts'

const KEY_V2 = 'dsh-graph-layout-v2'
/** 写 v1 用（模拟老版本留下的扁平表）。 */
const KEY_V1 = 'dsh-graph-layout-v1'

let store: Map<string, string>

/**
 * 装一个只实现 getItem / setItem 的 localStorage 桩，并返回底层表（用例里直接查文件内容）。
 *
 * 用 `Object.defineProperty` 而不是直接赋值：较新的 Node 在 `globalThis` 上预置了
 * `localStorage` 访问器（Web Storage），直接赋值在 ESM 严格模式下会抛；
 * 而「本作用域不存在」那个用例要把它置空 —— `delete` 对不可配置属性同样会抛。
 */
function installStorage(seed: Record<string, string> = {}): Map<string, string> {
  store = new Map(Object.entries(seed))
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    writable: true,
    value: {
      getItem: (k: string): string | null => store.get(k) ?? null,
      setItem: (k: string, v: string): void => { store.set(k, v) },
      removeItem: (k: string): void => { store.delete(k) },
    },
  })
  return store
}

/** 把 localStorage 整个撤掉（模拟 SSR / 被禁用 / 隐私模式）。 */
function removeStorage(): void {
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, writable: true, value: undefined })
}

/** 造一份坐标表。 */
function positions(entries: Array<[string, number, number]>): Map<string, { x: number; y: number }> {
  return new Map(entries.map(([id, x, y]) => [id, { x, y }]))
}

/** 读 v2 文件（桩里存的是字符串）。 */
function fileV2(): Record<string, unknown> {
  const raw = store.get(KEY_V2)
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {}
}

/** v2 文件里真正的作用域（排掉 __lru）。 */
function scopesInFile(): string[] {
  return Object.keys(fileV2()).filter(k => k !== '__lru')
}

beforeEach(() => { installStorage() })

describe('作用域隔离：一个作用域一份布局', () => {
  it('★ 两个库各写各的，互不覆盖', () => {
    savePositions(kbScope(1), positions([['note:7', 10, 20]]))
    savePositions(kbScope(2), positions([['note:7', -300, 400]]))

    expect(loadSavedPositions(kbScope(1)).get('note:7')).toEqual({ x: 10, y: 20 })
    expect(loadSavedPositions(kbScope(2)).get('note:7')).toEqual({ x: -300, y: 400 })
  })

  it('★ 同位 id 不串：甲库的坐标绝不会被当成乙库的初值', () => {
    savePositions(kbScope(1), positions([['note:7', 11, 22], ['kb:项目组', 33, 44], ['self', 0, 0]]))
    savePositions(kbScope(2), positions([['note:7', 77, 88]]))

    const b = loadSavedPositions(kbScope(2))
    // 乙库只写了 1 条 —— 不能因为 id 相同就把甲库的另外两条也带过来
    expect(b.size).toBe(1)
    expect(b.has('kb:项目组')).toBe(false)
    expect(b.has('self')).toBe(false)
    expect(loadSavedPositions(kbScope(1)).size).toBe(3)
  })

  it('社交图谱与知识图谱也是两份（它们同样共用节点 id 空间）', () => {
    savePositions(SOCIAL_SCOPE, positions([['self', 1, 2]]))
    savePositions(kbScope(DEFAULT_KB_ID), positions([['self', 900, 900]]))
    expect(loadSavedPositions(SOCIAL_SCOPE).get('self')).toEqual({ x: 1, y: 2 })
    expect(loadSavedPositions(kbScope(DEFAULT_KB_ID)).get('self')).toEqual({ x: 900, y: 900 })
  })

  it('没写过的作用域是空表，不是「另一个作用域的表」', () => {
    savePositions(kbScope(1), positions([['note:1', 1, 1]]))
    expect(loadSavedPositions(kbScope(9)).size).toBe(0)
    expect(loadSavedPositions('').size).toBe(0)
  })

  it('确定性：同一份坐标写两次、读两次，结果逐位相等', () => {
    const input = positions([['a', 1.5, -2.25], ['b', 0, 0], ['c', 12345.678, -98765.4321]])
    savePositions(kbScope(3), input)
    const first = loadSavedPositions(kbScope(3))
    savePositions(kbScope(3), input)
    const second = loadSavedPositions(kbScope(3))
    expect([...second]).toEqual([...first])
    // 落盘不清洗数值：取整是**画布**的职责（positionsForPersist），这层只负责搬运
    expect(second.get('c')).toEqual({ x: 12345.678, y: -98765.4321 })
  })

  it('落盘是「读-改-写」：先前写过的其它作用域不会因为本次写入而消失', () => {
    savePositions(kbScope(1), positions([['a', 1, 1]]))
    savePositions(kbScope(2), positions([['b', 2, 2]]))
    savePositions(kbScope(3), positions([['c', 3, 3]]))
    expect(scopesInFile().sort()).toEqual([kbScope(1), kbScope(2), kbScope(3)].sort())
    expect(loadSavedPositions(kbScope(1)).get('a')).toEqual({ x: 1, y: 1 })
  })
})

describe('v1 → v2 迁移：只读回退，不改写', () => {
  const v1 = { 'self': { x: 5, y: 6 }, 'friend:alice': { x: -70, y: 80 } }

  it('★ 只有「社交图谱」与默认库读得到 v1（别的库读 v1 等于认领别人的形状）', () => {
    installStorage({ [KEY_V1]: JSON.stringify(v1) })
    expect(loadSavedPositions(SOCIAL_SCOPE).get('self')).toEqual({ x: 5, y: 6 })
    expect(loadSavedPositions(kbScope(DEFAULT_KB_ID)).size).toBe(2)
    // 非默认库 / 别的名字：不回退
    expect(loadSavedPositions(kbScope(2)).size).toBe(0)
    expect(loadSavedPositions(kbScope(17)).size).toBe(0)
    expect(loadSavedPositions('kb').size).toBe(0)
  })

  it('★ 回退是只读的：读完不写 v2（升级交给下一次落盘）', () => {
    installStorage({ [KEY_V1]: JSON.stringify(v1) })
    loadSavedPositions(kbScope(DEFAULT_KB_ID))
    expect(store.has(KEY_V2)).toBe(false)
    // v1 也不动 —— 它是别的库唯一的形状来源，删掉等于让它们全部重排
    expect(store.get(KEY_V1)).toBe(JSON.stringify(v1))

    // 下一次落盘自然升级：v2 里出现该作用域，且 v1 仍然留着
    savePositions(kbScope(DEFAULT_KB_ID), positions([['self', 9, 9]]))
    expect(loadSavedPositions(kbScope(DEFAULT_KB_ID)).get('self')).toEqual({ x: 9, y: 9 })
    expect(store.get(KEY_V1)).toBe(JSON.stringify(v1))
  })

  it('v2 命中时不再看 v1（新值优先，否则改了形状下次进入又变回去）', () => {
    installStorage({ [KEY_V1]: JSON.stringify(v1) })
    savePositions(SOCIAL_SCOPE, positions([['self', -1, -1]]))
    expect(loadSavedPositions(SOCIAL_SCOPE).get('self')).toEqual({ x: -1, y: -1 })
    expect(loadSavedPositions(SOCIAL_SCOPE).has('friend:alice')).toBe(false)
  })

  it('★ 空的 v2 表算「有」，不再回退 v1（否则「清空布局」会被 v1 顶回来）', () => {
    installStorage({ [KEY_V1]: JSON.stringify(v1) })
    savePositions(SOCIAL_SCOPE, new Map())
    expect(fileV2()[SOCIAL_SCOPE]).toEqual({})
    expect(loadSavedPositions(SOCIAL_SCOPE).size).toBe(0)
  })
})

describe('配额：作用域上限与 LRU', () => {
  /** 写第 i 个库（1 起）。 */
  const writeKb = (i: number): void => { savePositions(kbScope(i), positions([[`note:${i}`, i, i]])) }

  it('上限是 8（与 kb-scope-keys.ts 的常量同源，不是这里另写一个数）', () => {
    expect(POSITION_SCOPES_MAX).toBe(8)
  })

  it('★ 超出上限时淘汰「最久未写」的那个，新的那个一定留着', () => {
    for (let i = 1; i <= POSITION_SCOPES_MAX + 1; i++) writeKb(i)
    const kept = scopesInFile()
    expect(kept).toHaveLength(POSITION_SCOPES_MAX)
    // 第 1 个库被淘汰；最后写的那个必须还在
    expect(kept).not.toContain(kbScope(1))
    expect(kept).toContain(kbScope(POSITION_SCOPES_MAX + 1))
    expect(loadSavedPositions(kbScope(POSITION_SCOPES_MAX + 1)).size).toBe(1)
  })

  it('★ 重新写一个旧作用域会把它提到首位（淘汰的是别人，不是它）', () => {
    // 先写满 +1 个：`kb:1` 被挤掉，文件里是 kb:2 … kb:9
    for (let i = 1; i <= POSITION_SCOPES_MAX + 1; i++) writeKb(i)
    expect(scopesInFile()).not.toContain(kbScope(1))
    // 现在回头再写 kb:1 —— 它必须回来，而这次被淘汰的是当时最旧的 kb:2
    savePositions(kbScope(1), positions([['note:1', 111, 111]]))
    const kept = scopesInFile()
    expect(kept).toHaveLength(POSITION_SCOPES_MAX)
    expect(kept).toContain(kbScope(1))
    expect(kept).not.toContain(kbScope(2))
    expect(loadSavedPositions(kbScope(1)).get('note:1')).toEqual({ x: 111, y: 111 })
  })

  it('LRU 顺序写在文件里（不靠对象键序），且长度与作用域数一致', () => {
    writeKb(1)
    writeKb(2)
    writeKb(3)
    expect(fileV2().__lru).toEqual([kbScope(3), kbScope(2), kbScope(1)])
  })

  it('淘汰只丢坐标，不丢 v1（下次进入重新布局，笔记本身在主库）', () => {
    installStorage({ [KEY_V1]: JSON.stringify({ self: { x: 5, y: 6 } }) })
    for (let i = 1; i <= POSITION_SCOPES_MAX + 2; i++) writeKb(i)
    expect(scopesInFile()).not.toContain(kbScope(1))
    expect(store.get(KEY_V1)).toBeDefined()
  })
})

describe('坏数据一律当成「没有历史布局」', () => {
  it('非有限坐标被逐条丢掉（坏值会把整张图带进 NaN）', () => {
    savePositions(kbScope(1), positions([['good', 1, 2]]))
    // 手工塞坏值：模拟旧版本写坏的 / 被人改过的文件
    store.set(KEY_V2, JSON.stringify({
      __lru: [kbScope(1)],
      [kbScope(1)]: {
        good: { x: 1, y: 2 },
        nan: { x: 'NaN', y: 0 },
        inf: { x: 0, y: null },
        missing: {},
        ok: { x: -3, y: 4 },
      },
    }))
    const loaded = loadSavedPositions(kbScope(1))
    expect([...loaded.keys()].sort()).toEqual(['good', 'ok'])
  })

  it('v2 不是 JSON / 是数组 / 是 null：读成空表而不是抛错', () => {
    for (const bad of ['{not json', '[]', 'null', '"12"', '123']) {
      installStorage({ [KEY_V2]: bad })
      expect(loadSavedPositions(kbScope(1)).size, bad).toBe(0)
    }
  })

  it('__lru 是坏的（非数组 / 混入非字符串）：不影响坐标读取，也不影响下次写入', () => {
    installStorage({
      [KEY_V2]: JSON.stringify({ __lru: 'nope', [SOCIAL_SCOPE]: { a: { x: 1, y: 1 } } }),
    })
    expect(loadSavedPositions(SOCIAL_SCOPE).get('a')).toEqual({ x: 1, y: 1 })
    savePositions(kbScope(1), positions([['b', 2, 2]]))
    expect(fileV2().__lru).toEqual([kbScope(1), SOCIAL_SCOPE])
  })

  it('根对象里的未知键不会被当成作用域读出来（除非它下面真有一条有限坐标）', () => {
    installStorage({
      [KEY_V2]: JSON.stringify({ __lru: [], meta: 'hello', [SOCIAL_SCOPE]: { a: { x: 1, y: 1 } } }),
    })
    // `meta` 是字符串 → sanitizeTable 给出空表；空表也算「有」，所以它会被读成一个空作用域，
    // 但**绝不会**冒出 `a` 这条坐标
    expect(loadSavedPositions(SOCIAL_SCOPE).get('a')).toEqual({ x: 1, y: 1 })
    expect(loadSavedPositions('meta').size).toBe(0)
  })

  it('setItem 抛错（配额满 / 隐私模式）不影响调用方：不抛，且下次读是空表', () => {
    installStorage()
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      writable: true,
      value: {
        getItem: (): string | null => null,
        setItem: (): void => { throw new Error('QuotaExceededError') },
      },
    })
    expect(() => savePositions(kbScope(1), positions([['a', 1, 1]]))).not.toThrow()
    expect(loadSavedPositions(kbScope(1)).size).toBe(0)
  })

  it('localStorage 整个不存在（SSR / 被禁用）：读空表、写不抛', () => {
    removeStorage()
    expect(loadSavedPositions(kbScope(1)).size).toBe(0)
    expect(() => savePositions(kbScope(1), positions([['a', 1, 1]]))).not.toThrow()
  })
})
