/**
 * 后端事件 → DOM CustomEvent 的映射表判据。
 *
 * ## 为什么这张表值得单独钉
 *
 * 它是「手机与桌面共用同一套面板」的**唯一前提**：面板订阅的是 `dsh-*` 这些 DOM 事件名，
 * 而两个传输层（IPC 的 `wechat:event`、SSE 的 data 帧）送来的都是后端事件名。
 * 映射错一个字母，症状是「界面完全正常、数据不动」—— 上一轮 WAL 实时性事故就是这个形状，
 * 而且它**只在一条传输路上复现**（桌面好、手机坏，或反过来），现场极难定位。
 *
 * 所以这里做三件事：
 *   ① 逐条钉住 7 个映射（后端名 → DOM 名 → 带不带 detail）；
 *   ② **反向**核对：表里每个 DOM 事件名都真的有面板在订阅（防止映射到一个没人听的名字，
 *      那种「转发了但没人收」同样是静默失效）；
 *   ③ 钉住 detail 口径：带 detail 的那几条取 `args[0]`、取不到给 `null` 而不是 `undefined`
 *      （既有面板是按 `?? null` 写的，给 undefined 会让「有 detail 但值为空」与「没有 detail」
 *      在监听侧无法区分）。
 *
 * @vitest-environment node
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { EVENT_MAP, dispatchWechatEvent } from './wechat-events.ts'
import type { BackendEvent } from './wechat-events.ts'

const CLIENT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** 假的派发目标：记下每一次派发，供断言。 */
function fakeTarget(): { events: Array<{ type: string, detail: unknown }>, dispatchEvent: (e: CustomEvent<unknown>) => boolean } {
  const events: Array<{ type: string, detail: unknown }> = []
  return {
    events,
    dispatchEvent: (e: CustomEvent<unknown>) => {
      events.push({ type: e.type, detail: e.detail })
      return true
    },
  }
}

/** 递归收集 src/client 下所有 .ts/.tsx 源码（跳过构建产物）。 */
function clientSources(): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir)) {
      if (e === 'ui-dist' || e === 'node_modules') continue
      const p = join(dir, e)
      const st = statSync(p)
      if (st.isDirectory()) { walk(p); continue }
      if (/\.(ts|tsx)$/.test(e) && !/\.spec\.tsx?$/.test(e)) out.push(readFileSync(p, 'utf8'))
    }
  }
  walk(CLIENT)
  return out
}

describe('事件映射表：7 条，逐条钉住', () => {
  it('哨兵：表非空，且就是那 7 条（多一条少一条都要在这里过一遍脑子）', () => {
    expect(EVENT_MAP.length).toBe(7)
    expect(EVENT_MAP.map((e) => e.from).sort()).toEqual([
      'clawbot/binding-changed',
      'clawbot/message',
      'laya-analysis/progress',
      'search-index/progress',
      'wechat-ask/delta',
      'wechat-data/updated',
      'wechat-export/progress',
    ])
  })

  it('每条的 DOM 事件名与「带不带 detail」都对得上抽出内联 if-else 之前的口径', () => {
    const expected: ReadonlyArray<readonly [string, string, boolean]> = [
      ['wechat-data/updated', 'dsh-wechat-data-updated', false],
      ['wechat-ask/delta', 'dsh-wechat-ask-delta', true],
      ['wechat-export/progress', 'dsh-wechat-export-progress', true],
      ['laya-analysis/progress', 'dsh-laya-analysis-progress', true],
      ['search-index/progress', 'dsh-search-index-progress', true],
      ['clawbot/message', 'dsh-clawbot-message', true],
      ['clawbot/binding-changed', 'dsh-clawbot-binding-changed', true],
    ]
    for (const [from, to, detail] of expected) {
      const entry = EVENT_MAP.find((e) => e.from === from)
      expect(entry, `映射表里少了后端事件 ${from}`).toBeTruthy()
      expect(entry?.to, `${from} 映射到了错误的 DOM 事件名`).toBe(to)
      expect(Boolean(entry?.detail), `${from} 的 detail 口径变了（原来是 ${String(detail)}）`).toBe(detail)
    }
  })

  it('表里每个 DOM 事件名都真的有面板在订阅（映射到没人听的名字 = 静默失效）', () => {
    const src = clientSources().join('\n')
    for (const e of EVENT_MAP) {
      // 订阅方写法是 addEventListener('dsh-…') / useWechatDataUpdated 一类；
      // 这里只要求事件名在**映射表之外**还出现过（即真的有消费方）。
      const occurrences = src.split(e.to).length - 1
      expect(occurrences, `${e.to} 只在映射表里出现、没有任何面板订阅它`).toBeGreaterThan(1)
    }
  })
})

describe('dispatchWechatEvent 的行为', () => {
  it('带 detail 的那几条取 args[0]；args 缺失时给 null 而不是 undefined', () => {
    const t = fakeTarget()
    dispatchWechatEvent({ name: 'wechat-ask/delta', args: [{ id: 'a1', text: '全文' }] }, t)
    expect(t.events).toEqual([{ type: 'dsh-wechat-ask-delta', detail: { id: 'a1', text: '全文' } }])

    const t2 = fakeTarget()
    dispatchWechatEvent({ name: 'clawbot/message' }, t2)
    expect(t2.events[0]?.type).toBe('dsh-clawbot-message')
    expect(t2.events[0]?.detail, '取不到 args[0] 时应当是 null（既有面板按 ?? null 写的）').toBeNull()
  })

  it('不带 detail 的那条不会把 args 泄漏成 detail（与抽出内联 if-else 之前逐字一致）', () => {
    // 原来那行是 `new CustomEvent('dsh-wechat-data-updated')`（不传 init）。
    // 注意 DOM 并不区分「没传 detail」与「detail: null」——`detail` 是原型上的访问器，
    // 不传时读出来也是 null —— 所以这里钉的是**可观测**的那一半：args 不许被当成 detail 转发。
    const t = fakeTarget()
    dispatchWechatEvent({ name: 'wechat-data/updated', args: [{ unexpected: true }] }, t)
    expect(t.events.length).toBe(1)
    expect(t.events[0]?.type).toBe('dsh-wechat-data-updated')
    expect(t.events[0]?.detail, 'wechat-data/updated 把 args 泄漏成 detail 了').toBeNull()
  })

  it('表里没有的事件一律忽略（后端会推只给主进程用的事件，渲染层不该乱转发）', () => {
    const t = fakeTarget()
    for (const ev of [
      { name: 'wechat-backend/status', args: [{ state: 'ready' }] },
      { name: 'remote-access/heartbeat', args: [] },
      { name: 'remote-access/ready', args: [{ port: 5032 }] },
      { name: 'update:event', args: [] },
    ] as BackendEvent[]) {
      expect(dispatchWechatEvent(ev, t), `${ev.name} 不该被转发`).toBeNull()
    }
    expect(t.events, '忽略的事件竟然还是派发了').toEqual([])
  })

  it('形状不可信时不抛（args 不是数组、ev 是 null、name 不是字符串）', () => {
    const t = fakeTarget()
    expect(dispatchWechatEvent(null, t)).toBeNull()
    expect(dispatchWechatEvent(undefined, t)).toBeNull()
    expect(dispatchWechatEvent({ name: 123 } as unknown as BackendEvent, t)).toBeNull()
    // args 不是数组时按缺失处理，仍然要派发（事件本身是有效的）
    expect(dispatchWechatEvent({ name: 'wechat-ask/delta', args: 'nope' } as unknown as BackendEvent, t))
      .toBe('dsh-wechat-ask-delta')
    expect(t.events.length).toBe(1)
    expect(t.events[0]?.detail).toBeNull()
  })

  it('返回值就是派发出去的 DOM 事件名（调用方据此判断有没有转发）', () => {
    const t = fakeTarget()
    expect(dispatchWechatEvent({ name: 'search-index/progress', args: [{ done: 1 }] }, t))
      .toBe('dsh-search-index-progress')
  })
})
