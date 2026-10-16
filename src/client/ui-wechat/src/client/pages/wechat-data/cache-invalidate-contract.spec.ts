// @vitest-environment jsdom
/**
 * 缓存失效契约（CODE-AUDIT-2026-09-26 P2-4 ③ / §七 第三批 #23）。
 *
 * ## 契约是什么
 *
 * **改完数据的写入侧只调一个函数**：`invalidateAndNotify(前缀 | 前缀[])`。
 * 它必须一次做完三件事，缺一条就会留下"看着清了其实没清"的状态：
 *  ① 清 `localStorage` 的两层（值缓存 + 渲染缓存）；
 *  ② 丢掉命中前缀的**内存快照**（下次读回源）；
 *  ③ **通知订阅者** —— 而且要看监听表，不能只看快照表：`cachedFetch` 那一族的键
 *    只活在持久层，面板照样订阅着它（只看快照表 ⇒ 一个订阅者都通知不到，③ 变成假动作）。
 *
 * ## 改前的形状（这条守卫要防它回来）
 *
 * 实测 11 处写入点、8 个接口只做了 ①：`invalidateWechatCache(prefix)` 清完就走，
 * 于是"我清过缓存了"和"正在看这一页的人看到了新数据"是两件事。
 * 最刺眼的是 `apiRestoreBackup`：整库换掉了，界面上还是恢复前的样子。
 *
 * ## 允许例外，但例外必须是"本来就三件齐全"的组合器
 *
 * `api-kb.ts` 里那几处仍直接调 `invalidateWechatCache`：它们紧跟着会调
 * `invalidateKbCaches()` / `invalidateKnowledgeCaches()`，那两个函数自己就把 ②③ 做了。
 * 所以清单不是"不许用"，而是"用了就必须同时给出通知的那一半"—— 白名单里逐条写了理由。
 * @module cache-invalidate-contract
 */
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  OVERVIEW_CACHE_PREFIX,
  cacheGet,
  cacheSet,
  invalidateAndNotify,
  readRenderCache,
  snapshotHit,
  snapshotSet,
  subscribeSnapshot,
  writeRenderCache,
} from './cache.ts'

const HERE = dirname(fileURLToPath(import.meta.url))

beforeEach(() => {
  localStorage.clear()
  // 上一用例留下的快照：`invalidateAndNotify('')` 只标陈旧不清表，所以直接按已知键清一遍。
  for (const k of ['messages:a', 'messages:b', 'sessions:x', 'moments:all', 'records:1', 'ghost:key']) snapshotSet(k, null)
})

describe('invalidateAndNotify 的三件事', () => {
  it('② 只丢命中前缀的快照，别的一动不动', () => {
    snapshotSet('messages:a', { v: 1 })
    snapshotSet('messages:b', { v: 2 })
    snapshotSet('sessions:x', { v: 3 })
    invalidateAndNotify('messages:')
    expect(snapshotHit('messages:a'), '命中的快照没被丢掉').toBeUndefined()
    expect(snapshotHit('messages:b')).toBeUndefined()
    expect(snapshotHit('sessions:x'), '没命中的键被顺手清了 ⇒ 一次改动会打冷一整页').toEqual({ v: 3 })
  })

  it('③ 通知命中键的订阅者，且不通知没命中的', () => {
    snapshotSet('messages:a', { v: 1 })
    snapshotSet('sessions:x', { v: 2 })
    const onMsg = vi.fn()
    const onSess = vi.fn()
    const off1 = subscribeSnapshot('messages:a', onMsg)
    const off2 = subscribeSnapshot('sessions:x', onSess)
    invalidateAndNotify('messages:')
    expect(onMsg).toHaveBeenCalledTimes(1)
    expect(onSess, '没落在前缀里的面板被惊动了（风暴就是这么来的）').not.toHaveBeenCalled()
    off1(); off2()
  })

  it('③ 只活在持久层的键也要被通知（只看快照表的话这一条会假动作过关）', () => {
    cacheSet('privacy:state', { v: 1 })
    const on = vi.fn()
    const off = subscribeSnapshot('privacy:state', on)
    invalidateAndNotify('privacy')
    expect(on, '订阅者在监听表里、键不在快照表 ⇒ 漏通知').toHaveBeenCalledTimes(1)
    expect(cacheGet('privacy:state')).toBeNull()
    off()
  })

  it('① 两层持久缓存都按前缀清（值缓存 + 渲染缓存）', () => {
    cacheSet('sessions:x', { v: 1 })
    writeRenderCache('sessions:x', { rows: [1] })
    cacheSet('messages:a', { v: 2 })
    writeRenderCache('messages:a', { rows: [3] })
    invalidateAndNotify('sessions:')
    expect(cacheGet('sessions:x')).toBeNull()
    expect(readRenderCache('sessions:x')).toBeNull()
    expect(cacheGet('messages:a'), '清了 sessions 却把 messages 也带走了').not.toBeNull()
    expect(readRenderCache('messages:a')).not.toBeNull()
  })

  it('总览面板的历史裸键也归同一个失效契约管', () => {
    localStorage.setItem(OVERVIEW_CACHE_PREFIX + 'base-v1', JSON.stringify({ sessions: 1 }))
    invalidateAndNotify('')
    expect(localStorage.getItem(OVERVIEW_CACHE_PREFIX + 'base-v1')).toBeNull()
  })

  it('多个前缀取并集（改一条消息要同时作废三个族）', () => {
    snapshotSet('messages:a', { v: 1 })
    snapshotSet('sessions:x', { v: 2 })
    snapshotSet('moments:all', { v: 3 })
    const onMsg = vi.fn(); const onSess = vi.fn(); const onMom = vi.fn()
    const offs = [subscribeSnapshot('messages:a', onMsg), subscribeSnapshot('sessions:x', onSess), subscribeSnapshot('moments:all', onMom)]
    invalidateAndNotify(['messages:', 'sessions:'])
    expect(onMsg).toHaveBeenCalledTimes(1)
    expect(onSess).toHaveBeenCalledTimes(1)
    expect(onMom, '不在并集里的族被顺手打冷了').not.toHaveBeenCalled()
    offs.forEach((f) => { f() })
  })

  it("'' = 全量：所有订阅者都得到通知，持久层整个清掉", () => {
    cacheSet('sessions:x', { v: 1 })
    snapshotSet('messages:a', { v: 2 })
    const on1 = vi.fn(); const on2 = vi.fn()
    const offs = [subscribeSnapshot('messages:a', on1), subscribeSnapshot('records:1', on2)]
    invalidateAndNotify('')
    expect(on1).toHaveBeenCalledTimes(1)
    expect(on2, '全量失效漏了某个订阅者 ⇒ 那一页会一直画旧数').toHaveBeenCalledTimes(1)
    expect(cacheGet('sessions:x')).toBeNull()
    offs.forEach((f) => { f() })
  })

  it('一个订阅者抛错不能挡住后面的（通知不是尽力而为）', () => {
    const bad = vi.fn(() => { throw new Error('面板炸了') })
    const good = vi.fn()
    const offs = [subscribeSnapshot('ghost:key', bad), subscribeSnapshot('ghost:key2', good)]
    expect(() => { invalidateAndNotify('ghost:') }).not.toThrow()
    expect(bad).toHaveBeenCalledTimes(1)
    expect(good, '前一个订阅者抛错就把后面的饿死了').toHaveBeenCalledTimes(1)
    offs.forEach((f) => { f() })
  })
})

describe('写入侧不许只做一半（零容忍扫描）', () => {
  /** 允许直接调 `invalidateWechatCache` 的地方：理由必须写在这儿。 */
  const ALLOW = new Set([
    'src/client/ui-wechat/src/client/pages/wechat-data/cache.ts',
    // 这三处紧跟着调 `invalidateKbCaches()` / `invalidateKnowledgeCaches()`，
    // 那两个组合器自己就把「丢快照 + 通知」做了（见 api-kb.ts:418/440 的注释）。
    'src/client/ui-wechat/src/client/pages/wechat-data/api-kb.ts',
  ])

  /**
   * 取一份源码里**真的调了** `invalidateWechatCache(` 的次数。
   * 走 AST 不走正则：本仓这一族判据已经第三次踩「注释里的代码字样被当成代码」
   * （`module-cycle-guard` 的 `from './x.ts'`、`clipboard-single-source` 的
   * `navigator.clipboard.writeText`、还有这里我自己写的一条解释性注释）。
   * @param code - 源码文本。
   * @param label - 报错时用的文件名。
   * @returns 调用次数。
   */
  const callsIt = (label: string, code: string): number => {
    const sf = ts.createSourceFile(label, code.replace(/\r\n/g, '\n'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
    let n = 0
    const walk = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'invalidateWechatCache') n += 1
      ts.forEachChild(node, walk)
    }
    walk(sf)
    return n
  }

  const files = readdirSync(HERE).filter((f) => /\.(ts|tsx)$/.test(f) && !f.includes('.spec.') && !f.endsWith('.d.ts'))
  const scanned = files.map((f) => {
    const path = 'src/client/ui-wechat/src/client/pages/wechat-data/' + f
    return [path, callsIt(f, readFileSync(join(HERE, f), 'utf8'))] as const
  })
  const hits = scanned.filter(([p, n]) => n > 0 && !ALLOW.has(p))

  it('扫描真的看得到调用点（看不到 ⇒ 判据在空转）', () => {
    const total = scanned.reduce((a, [, n]) => a + n, 0)
    console.log(`[算料|invalidate] 目录内 ${String(files.length)} 个文件、AST 命中 ${String(total)} 处调用，白名单 ${String(ALLOW.size)} 个文件`)
    expect(total, '一处都没扫到 ⇒ 提取或目录口径坏了').toBeGreaterThan(0)
    // 白名单里的文件必须**还在**用（不再用了就从清单里删，留着会掩护新写的调用点）
    for (const p of scanned) {
      if (!ALLOW.has(p[0]) || p[0] === 'src/client/ui-wechat/src/client/pages/wechat-data/cache.ts') continue
      expect(p[1], `白名单里的 ${p[0]} 已经不调了 ⇒ 把它从清单里删掉`).toBeGreaterThan(0)
    }
  })

  it('白名单之外的文件不许自己拼「只清持久层」那一半', () => {
    expect(hits.map(([p]) => p), `这些文件绕过了 invalidateAndNotify：\n  ${hits.map(([p]) => p).join('\n  ')}`).toEqual([])
  })

  it('七个改数据的接口现在都走契约（逐个点名，改名/搬走要一起来改这里）', () => {
    const read = (f: string): string => readFileSync(join(HERE, f), 'utf8')
    for (const [file, fn] of [
      ['api-export-ops.ts', 'apiRestoreBackup'],
      ['api-export-ops.ts', 'apiEditChatMessage'],
      ['api-export-ops.ts', 'apiResetEditedMessage'],
      ['api-export-ops.ts', 'apiClearSessionDraft'],
      ['api-export-ops.ts', 'apiClearAllSessionDrafts'],
      ['api-config.ts', 'apiDeleteFavoriteItems'],
      ['api-read.ts', 'apiSetPrivacyState'],
    ] as const) {
      const code = read(file)
      const at = code.indexOf(`export async function ${fn}`)
      expect(at, `${fn} 不在 ${file} 里了（改名/搬走了要同步这条清单）`).toBeGreaterThan(-1)
      const body = code.slice(at, code.indexOf('\nexport ', at + 1))
      expect(body, `${fn} 没有走 invalidateAndNotify`).toContain('invalidateAndNotify(')
    }
  })

  it('前缀词汇必须真是两层共用的那一套（否则前缀匹配是假的）', () => {
    const read = (f: string): string => readFileSync(join(HERE, f), 'utf8')
    const keys = read('api-read.ts')
    // 写入侧用的三个前缀，读取侧也必须以同样的前缀做键 —— 不然「清 messages:」清不到任何快照。
    for (const p of ['sessions:', 'messages:']) {
      expect(keys, `读取侧没有以「${p}」为前缀的缓存键 ⇒ invalidateAndNotify 的前缀口径是空的`)
        .toContain(`'${p}`)
    }
    expect(resolve(HERE).length).toBeGreaterThan(0)
  })
})
