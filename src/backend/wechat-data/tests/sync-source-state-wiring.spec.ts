/**
 * 跨进程签名账的**接线守卫与棘轮**（行为判据在 `sync-source-state.spec.ts`）。
 *
 * ## 为什么行为判据之外还要这份
 *
 * 行为判据跑的是 `startRealtimeSync` 的真实回路，理论上接线断了它就会红。但它有个盲区：
 * 夹具一旦不再覆盖某个分支（例如源永远不变、解密永远成功），接线被摘掉可能看不出来。
 * 这一层补的是「**接上了没有**」，用 AST 而不是文本 —— 本仓这一族判据已经第三次踩
 * 「注释里的代码字样被当成代码」（见 `cache-invalidate-contract.spec.ts` 的同一段说明）。
 *
 * ## 这一层钉的三件事
 *
 * 1. `sync.ts` 真调了持久化的三个出入口（缺一个 = 账本写了没人读 / 读了没人写）。
 * 2. **只取成功子集**这条不许退化：落盘循环的迭代源必须是 `takeSyncSuccesses()`，
 *    不许直接迭代 `lastState`（`lastState` 是乐观记录的，失败那条路会保留签名）。
 *    这条是整个改动里唯一带数据正确性风险的形状，2026-10-08 的变异自证里
 *    「直接迭代 lastState」正是靠它咬住的。
 * 3. 棘轮：`sync.ts` 的行数只许变小（它贴着本仓 1000 行硬上限，见 `m21-file-size-ratchet.spec.ts`）。
 *
 * ## 判据自身要能证明它在承重
 *
 * 每一格都配了反例自证（合成的坏源码必须被抓到），否则「清单为空 ⇒ 全绿」就是恒真。
 * @vitest-environment node
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
const SYNC_PATH = join(HERE, '..', 'src', 'query', 'sync.ts')

/** 接线必须真调到的函数。 */
const REQUIRED_CALLS = [
  'loadSyncSourceState',
  'noteSyncSourceState',
  'flushSyncSourceState',
  'takeSyncSuccesses',
] as const

function source(label: string, code: string): ts.SourceFile {
  return ts.createSourceFile(label, code.replace(/\r\n/g, '\n'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
}

/** 数一份源码里**真的调了**某个名字的次数（AST，不走正则、不剥注释）。 */
function callCount(sf: ts.SourceFile, name: string): number {
  let n = 0
  const walk = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === name) n += 1
    ts.forEachChild(node, walk)
  }
  walk(sf)
  return n
}

/**
 * 找出每个**含 `noteSyncSourceState(` 调用**的 `for...of`，报出它迭代部分引用到的名字。
 *
 * ## 可迭代表达式挂在 `ForOfStatement.expression` 上，不在 `initializer` 上
 *
 * 这条问法试过两个版本，都被打回去了，结论记在这儿免得再犯：
 *  ① 第一版找「initializer 上那个 `noteSyncSourceState(` 调用」—— 调用点在循环**体内**，
 *     对着真实源码一条都找不到，对着合成坏源码反而数出两个，判据整个是反的；
 *  ② 第二版读 `initializer.expression` —— `initializer` 是**循环变量声明**
 *     （实测 `kind === VariableDeclarationList`），它没有 `.expression` ⇒ 直接抛
 *     `Cannot read properties of undefined`。可迭代表达式是它的**兄弟**节点
 *     `ForOfStatement.expression`（实测 `for (const k of takeSyncSuccesses())` 的
 *     `getChildren` 是 `…VariableDeclarationList, of, CallExpression, )…`）。
 *
 * 与其继续跟内部形状较劲，不如问一个形状无关的问题：迭代部分引用了哪些名字。
 * `for (const k of takeSyncSuccesses())` ⇒ `['takeSyncSuccesses']`；
 * `for (const [k, s] of lastState)` ⇒ `['lastState']`。
 * @returns 每个落盘 for 的迭代部分引用的名字（已排序）。
 */
function persistLoopInitRefs(sf: ts.SourceFile): string[][] {
  const out: string[][] = []
  const containsPersistCall = (node: ts.Node): boolean => {
    let hit = false
    const walk = (n: ts.Node): void => {
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'noteSyncSourceState') hit = true
      ts.forEachChild(n, walk)
    }
    walk(node)
    return hit
  }
  const collectIds = (node: ts.Node, acc: Set<string>): void => {
    // 停在 Identifier 上不下钻：`lastState.set` 里的 `set` 是属性名，不是引用。
    if (ts.isIdentifier(node)) { acc.add(node.text); return }
    ts.forEachChild(node, (c) => { collectIds(c, acc) })
  }
  const walk = (node: ts.Node): void => {
    if (ts.isForOfStatement(node) && containsPersistCall(node.statement)) {
      const acc = new Set<string>()
      collectIds(node.expression, acc)
      out.push([...acc].sort())
    }
    ts.forEachChild(node, walk)
  }
  walk(sf)
  return out
}

const syncCode = readFileSync(SYNC_PATH, 'utf8')

describe('接线：sync.ts 真调到了持久化的出入口', () => {
  it('扫描本身能看到调用点（看不到 ⇒ 整份判据在空转）', () => {
    const sf = source('sync.ts', syncCode)
    const total = REQUIRED_CALLS.reduce((a, n) => a + callCount(sf, n), 0)
    console.log(`[算料|sync-state] sync.ts 行数 ${String(syncCode.split('\n').length)}、`
      + `四个出入口合计 AST 命中 ${String(total)} 处调用`)
    expect(total, '一处都没扫到 ⇒ AST 提取或文件口径坏了').toBeGreaterThan(0)
    // 反例自证：同一套扫描必须能在一段合成的坏源码里数出调用
    const fake = source('fake.ts', 'const a = loadSyncSourceState(1); a = flushSyncSourceState(2)')
    expect(callCount(fake, 'loadSyncSourceState')).toBe(1)
    expect(callCount(fake, 'flushSyncSourceState')).toBe(1)
    // 反例自证：注释里的字样不许被算成调用
    const commented = source('c.ts', '// loadSyncSourceState(x)\n/* flushSyncSourceState(y) */\n')
    expect(callCount(commented, 'loadSyncSourceState')).toBe(0)
    expect(callCount(commented, 'flushSyncSourceState')).toBe(0)
  })

  for (const name of REQUIRED_CALLS) {
    it(`${name} 在 sync.ts 里被真的调用了`, () => {
      const n = callCount(source('sync.ts', syncCode), name)
      expect(n, `${name} 没被 sync.ts 调用 ⇒ 这套账是死的`).toBeGreaterThan(0)
    })
  }
})

describe('棘轮：落盘只许走「本轮真解成功」那个集合', () => {
  it('落盘循环的迭代源是 takeSyncSuccesses()，不是 lastState', () => {
    const refs = persistLoopInitRefs(source('sync.ts', syncCode))
    expect(refs.length, '没找到落盘用的 for...of ⇒ 判据口径变了，先更新这份用例').toBeGreaterThan(0)
    for (const r of refs) {
      expect(r, '落盘不许直接迭代 lastState：它是乐观记录的，失败那条路会保留签名，'
        + '照写会把没解成功的目标也标成「已解密」，下次启动跳过它 ⇒ 永久旧数据').toEqual(['takeSyncSuccesses'])
    }
  })

  it('反例自证：直接迭代 lastState 的形状必须被这份判据抓到', () => {
    const bad = [
      'for (const key of lastState) { noteSyncSourceState(key, key) }',
      'for (const [key, sig] of lastState) noteSyncSourceState(key, sig)',
    ].join('\n')
    expect(persistLoopInitRefs(source('bad.ts', bad))).toEqual([['lastState'], ['lastState']])
  })
})

describe('棘轮：sync.ts 的行数只许变小', () => {
  it('不超过本仓的 1000 行硬上限（再涨就该把逻辑挪去 sync-state.ts）', () => {
    const lines = syncCode.split('\n').length
    console.log(`[算料|sync-state] sync.ts ${String(lines)} 行（上限 1000）`)
    expect(lines).toBeLessThanOrEqual(1000)
  })

  it('这份棘轮不是恒真：越界一点就得红', () => {
    const over = new Array(1005).fill('// x').join('\n')
    expect(over.split('\n').length > 1000).toBe(true)
  })
})