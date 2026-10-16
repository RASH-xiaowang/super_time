/**
 * ClawBot 绑定关系（`clawbot_binding`）守卫。
 *
 * 守四件事：四态状态机、**一对一**（永远不该出现两行 `bound`）、
 * 解绑**不**清空接入会话（D-4）、以及读失败与「尚未绑定」分开。
 * @vitest-environment node
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { clawbotDbPath } from '../src/query/clawbot/clawbot-db.ts'
import { completeBinding, markBindingQr, readBinding, readBindingInternal, saveSendContextToken, saveSyncBuf, unbindBinding } from '../src/query/clawbot/clawbot-binding.ts'
import { insertClawbotMessage, listClawbotMessages } from '../src/query/clawbot/clawbot-message.ts'

const scratch: string[] = []
afterEach(() => {
  for (const dir of scratch) {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* Windows 清理尽力而为 */ }
  }
  scratch.length = 0
})

function root(): string {
  const base = mkdtempSync(join(tmpdir(), 'wx-clawbot-bind-'))
  scratch.push(base)
  const dir = join(base, 'decrypted')
  mkdirSync(dir)
  return dir
}

/** 数一数库里有几行绑定（一对一断言用它）。 */
function countRows(dir: string): number {
  const db = new DatabaseSync(clawbotDbPath(dir))
  const n = (db.prepare('SELECT COUNT(*) AS n FROM clawbot_binding').get() as { n?: number } | undefined)?.n ?? 0
  db.close()
  return Number(n)
}

describe('clawbot 绑定：状态机', () => {
  it('库不存在：默认未绑定且**不带** readError', () => {
    const dir = root()
    const r = readBinding(dir)
    expect(r.binding.status).toBe('unbound')
    expect(r.readError).toBeUndefined()
  })

  it('申请二维码 ⇒ binding 态 + 凭证/过期时间非空；绑定成功 ⇒ wxid 回写、凭证清空', () => {
    const dir = root()
    const afterQr = markBindingQr(dir, { token: 'tok-1', expiresAt: 1_700_000_000_000 })
    expect(afterQr.status).toBe('binding')
    expect(afterQr.qrToken).toBe('tok-1')
    expect(afterQr.qrExpiresAt).toBe(1_700_000_000_000)

    const afterBind = completeBinding(dir, { wxid: 'wxid_xiaoman', userName: '小满', avatar: 'https://example.invalid/a.png' })
    expect(afterBind.status).toBe('bound')
    expect(afterBind.wxid).toBe('wxid_xiaoman')
    expect(afterBind.userName).toBe('小满')
    expect(afterBind.boundAt).toBeTypeOf('number')
    // 凭证只在 binding 态有意义：绑定成功后必须清空
    expect(afterBind.qrToken).toBeNull()
    expect(afterBind.qrExpiresAt).toBeNull()
  })

  it('一对一：整张表只有一行（重复绑/解/再绑都不增行）', () => {
    const dir = root()
    markBindingQr(dir, { token: 't1', expiresAt: 1 })
    completeBinding(dir, { wxid: 'wxid_a' })
    unbindBinding(dir)
    completeBinding(dir, { wxid: 'wxid_b' })
    expect(countRows(dir)).toBe(1)
    expect(readBinding(dir).binding.wxid).toBe('wxid_b')
  })

  /*
   * 2026-10-13 多实例反转记录：原断言叫「一对一兜底」，守的是**全局只许一行 bound**
   * （那时官方口径是一个桌面宿主对一个微信号）。多实例上线后「两个不同的号同时绑定」
   * 正是要支持的能力，全局唯一性不再是约束 ⇒ 约束从「全局」收窄到「**同一个 wxid**」，
   * 兜底精神不变（手工编辑库造出的脏状态也要自愈）。
   */
  it('兜底（多实例语义）：同一个微信号挂在两个实例上时，后绑的接管、前一个被收敛', () => {
    const dir = root()
    completeBinding(dir, { wxid: 'wxid_same' }, null, 1)
    // 手工再造一行 bound（模拟手工编辑库后的脏状态：同一个号被挂到第二个实例上）
    const db = new DatabaseSync(clawbotDbPath(dir))
    db.prepare('INSERT INTO clawbot_binding(slot, status, wxid, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run(2, 'bound', 'wxid_same', 1, 1)
    db.close()

    const after = completeBinding(dir, { wxid: 'wxid_same' }, null, 2)
    expect(after.slot).toBe(2)
    const db2 = new DatabaseSync(clawbotDbPath(dir))
    const rows = db2.prepare("SELECT slot, status FROM clawbot_binding WHERE wxid = 'wxid_same' ORDER BY slot").all() as Array<{ slot: number, status: string }>
    db2.close()
    expect(rows, '同一个微信号不该同时挂在两个实例上').toEqual([
      { slot: 1, status: 'unbound-by-user' },
      { slot: 2, status: 'bound' },
    ])
  })

  it('不同微信的实例互不影响：绑第二个号不会动第一个（多实例的核心语义）', () => {
    const dir = root()
    completeBinding(dir, { wxid: 'wxid_a' }, null, 1)
    completeBinding(dir, { wxid: 'wxid_b' }, null, 2)
    expect(readBinding(dir, 1).binding.status, '多实例下另一个号被绑走不该把我也解绑').toBe('bound')
    expect(readBinding(dir, 1).binding.wxid).toBe('wxid_a')
    expect(readBinding(dir, 2).binding.status).toBe('bound')
  })

  it('解绑：状态转 unbound-by-user、unboundAt 有值、**接入会话一行不丢**（D-4）', () => {
    const dir = root()
    completeBinding(dir, { wxid: 'wxid_a', userName: '小满' })
    insertClawbotMessage(dir, { ts: 1, direction: 'in', content: '你好' })
    insertClawbotMessage(dir, { ts: 2, direction: 'out', content: '你好，我是 Super Time' })

    const after = unbindBinding(dir)
    expect(after.status).toBe('unbound-by-user')
    expect(after.unboundAt).toBeTypeOf('number')
    // 身份保留为「上次绑定」的痕迹（界面展示用），重新绑定时被覆盖
    expect(after.wxid).toBe('wxid_a')
    // 会话不被清空
    const msgs = listClawbotMessages(dir)
    expect(msgs.total).toBe(2)
    expect(msgs.items.map(m => m.content).sort()).toEqual(['你好', '你好，我是 Super Time'].sort())
  })

  it('库打不开（损坏）⇒ readError + 默认未绑定行（读失败 ≠ 未绑定）', () => {
    const dir = root()
    writeFileSync(clawbotDbPath(dir), 'garbage-not-a-db')
    const r = readBinding(dir)
    expect(r.readError ?? '').toContain('绑定信息读取失败')
    expect(r.binding.status).toBe('unbound')
  })

  it('四态都从库里如实读出（脏状态归一成 unbound）', () => {
    const dir = root()
    markBindingQr(dir, { token: 't', expiresAt: 1 })
    expect(readBinding(dir).binding.status).toBe('binding')
    const db = new DatabaseSync(clawbotDbPath(dir))
    db.prepare("UPDATE clawbot_binding SET status = 'sideways'").run()
    db.close()
    expect(readBinding(dir).binding.status).toBe('unbound')
  })
})

describe('clawbot 绑定：凭证与同步游标（iLink 内部读）', () => {
  const CREDS = { botToken: 'bt-1', ilinkBotId: 'bot-1', ilinkUserId: 'user-1', baseUrl: 'https://ilinkai.weixin.qq.com' }

  it('completeBinding 带凭证 ⇒ readBindingInternal 读得到；公开行**不**含凭证字段', () => {
    const dir = root()
    completeBinding(dir, { wxid: 'user-1' }, CREDS)
    const internal = readBindingInternal(dir)
    expect(internal.credentials).toEqual(CREDS)
    expect(internal.binding.status).toBe('bound')
    // 公开读（进渲染层的那份）里不许出现凭证字段名 —— 快照直接 JSON 出去。
    const publicRow = readBinding(dir).binding as unknown as Record<string, unknown>
    for (const k of ['botToken', 'bot_token', 'ilinkBotId', 'baseUrl']) {
      expect(Object.keys(publicRow), `公开绑定行里出现了凭证字段 ${k}`).not.toContain(k)
    }
  })

  it('身份三项缺一 ⇒ 归 null（半截凭证发不出合法请求）；baseurl 空串是合法值（= 缺省主机）', () => {
    const dir = root()
    completeBinding(dir, { wxid: 'w' }, { ...CREDS, botToken: '' })
    expect(readBindingInternal(dir).credentials).toBeNull()

    // baseurl 空串：协议里空 = 用缺省主机，必须原样读回而不是判成「凭证不齐」。
    const dir2 = root()
    completeBinding(dir2, { wxid: 'w' }, { ...CREDS, baseUrl: '' })
    expect(readBindingInternal(dir2).credentials).toEqual({ ...CREDS, baseUrl: '' })

    const dir3 = root()
    completeBinding(dir3, { wxid: 'w' })
    expect(readBindingInternal(dir3).credentials).toBeNull()
  })

  it('saveSyncBuf / saveSendContextToken：存得回、**不动 updated_at**；空令牌跳过（不许冲掉好令牌）', () => {
    const dir = root()
    completeBinding(dir, { wxid: 'user-1' }, CREDS)
    const stamped = readBinding(dir).binding.updatedAt
    saveSyncBuf(dir, 'cursor-1')
    saveSendContextToken(dir, 'ctx-1')
    expect(readBindingInternal(dir)).toMatchObject({ syncBuf: 'cursor-1', sendContextToken: 'ctx-1' })
    expect(readBinding(dir).binding.updatedAt).toBe(stamped)
    // 空串跳过：调用方对不带令牌的帧没得存，写空会把上一枚好令牌冲掉。
    saveSendContextToken(dir, '')
    expect(readBindingInternal(dir).sendContextToken).toBe('ctx-1')
  })

  it('解绑：凭证、游标与发送令牌一并清空（即使进程内循环漏停，也发不出请求）', () => {
    const dir = root()
    completeBinding(dir, { wxid: 'user-1' }, CREDS)
    saveSyncBuf(dir, 'cursor-1')
    saveSendContextToken(dir, 'ctx-1')
    unbindBinding(dir)
    const internal = readBindingInternal(dir)
    expect(internal.credentials).toBeNull()
    expect(internal.syncBuf).toBe('')
    expect(internal.sendContextToken).toBe('')
  })

  it('重新绑定：旧会话的发送令牌不跨会话（completeBinding 清空）', () => {
    const dir = root()
    completeBinding(dir, { wxid: 'user-1' }, CREDS)
    saveSendContextToken(dir, 'ctx-old')
    completeBinding(dir, { wxid: 'user-2' }, { ...CREDS, ilinkUserId: 'user-2' })
    expect(readBindingInternal(dir).sendContextToken).toBe('')
  })

  it('readBindingInternal 的读失败语义与 readBinding 同款：不存在 ⇒ 无 readError；损坏 ⇒ readError', () => {
    const dir = root()
    const missing = readBindingInternal(dir)
    expect(missing.credentials).toBeNull()
    expect(missing.syncBuf).toBe('')
    expect(missing.readError).toBeUndefined()

    writeFileSync(clawbotDbPath(dir), 'garbage-not-a-db')
    const broken = readBindingInternal(dir)
    expect(broken.readError ?? '').toContain('绑定信息读取失败')
  })
})
