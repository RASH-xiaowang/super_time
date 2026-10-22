/**
 * ClawBot **多实例**（slot）与**每实例配置**守卫（M1，2026-10-13）。
 *
 * 守五件事：
 *   ① slot 语义：一 slot 一行绑定；**只增不复用**（复用会把上个实例的残留配置串给新实例）；
 *   ② 配置隔离与持久：配置按 slot 分开，且**活过重新绑定**（绑定行被覆盖、偏好不该丢）；
 *   ③ 删除的边界：删实例连带删它自己的会话与配置，**别的实例一条都不许动**；
 *   ④ 同 wxid 接管：同一个微信号只服务一个实例，后绑的接管、前一个被收敛且**凭证清空**；
 *   ⑤ 老库迁移：没有 `slot` 列的旧库补齐后，原来那唯一一行 = slot 1，旧消息也归 1。
 *
 * 变异自证见 `working/m1-mutation.py`（每条断言都必须能被咬红）。
 * @vitest-environment node
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_CLAWBOT_SLOT, clawbotDbPath, ensureClawbotStore } from '../src/query/clawbot/clawbot-db.ts'
import { completeBinding, readBinding, readBindingInternal, renameBinding, unbindBinding } from '../src/query/clawbot/clawbot-binding.ts'
import { insertClawbotMessage, listClawbotMessages, suppressClawbotMessageIds } from '../src/query/clawbot/clawbot-message.ts'
import { AUTO_REPLY_KB_REQUIRED_MESSAGE, createClawbotInstance, defaultInstanceConfig, deleteClawbotInstance, listClawbotInstances, readInstanceConfig, resolveInstanceConfigForSave, saveInstanceConfig } from '../src/query/clawbot/clawbot-instance.ts'
import { enqueueOrMergeReplyRun, saveReplyParts } from '../src/query/clawbot/clawbot-reply-store.ts'
import { addClawbotTokenUsage } from '../src/query/clawbot/clawbot-token.ts'

const scratch: string[] = []
afterEach(() => {
  for (const dir of scratch) {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* Windows 清理尽力而为 */ }
  }
  scratch.length = 0
})

function root(): string {
  const base = mkdtempSync(join(tmpdir(), 'wx-clawbot-inst-'))
  scratch.push(base)
  const dir = join(base, 'decrypted')
  mkdirSync(dir)
  return dir
}

/** 直接开库读一行（绕开被测代码，用来验「库里真的写了什么」）。 */
function raw<T>(dir: string, sql: string, ...params: Array<string | number>): T | undefined {
  const db = new DatabaseSync(clawbotDbPath(dir))
  const r = db.prepare(sql).get(...params) as T | undefined
  db.close()
  return r
}

const CREDS = { botToken: 'bt', ilinkBotId: 'ib', ilinkUserId: 'iu', baseUrl: 'https://x' }

/** 某实例在删除涉及的全部 slot 级表中的行数。 */
function slotCounts(dir: string, slot: number): Record<string, number> {
  const count = (table: string): number =>
    Number(raw<{ n?: number }>(dir, `SELECT COUNT(*) AS n FROM ${table} WHERE slot = ?`, slot)?.n ?? -1)
  return {
    binding: count('clawbot_binding'),
    config: count('clawbot_instance_config'),
    messages: count('clawbot_message'),
    tombstones: count('clawbot_message_tombstone'),
    tokenUsage: count('clawbot_token_usage'),
    replyRuns: count('clawbot_reply_run'),
    replyOutbox: count('clawbot_reply_outbox'),
  }
}

/** 给一个实例造齐删除必须触达的全部状态。 */
function seedDeletionSurface(dir: string, slot: number): void {
  saveInstanceConfig(dir, slot, { autoReply: true, kbEnabled: true, kbId: slot + 10 })
  const messageId = insertClawbotMessage(dir, {
    slot,
    ts: 1000 + slot,
    direction: 'in',
    content: `来自 ${slot}`,
    msgType: 'text',
    msgId: 100 + slot,
  })
  if (messageId === null) throw new Error('测试消息未落库')
  suppressClawbotMessageIds(dir, slot, [900 + slot])
  addClawbotTokenUsage(dir, slot, { inputTokens: 7, outputTokens: 3 })
  const run = enqueueOrMergeReplyRun(dir, {
    slot,
    targetMessageId: messageId,
    question: `问题 ${slot}`,
    debounceMs: 0,
  })
  saveReplyParts(dir, run.id, [`回复 ${slot}`])
}

describe('clawbot 多实例：slot 与配置', () => {
  it('库不存在：空列表且**不带** readError；配置读回默认（自动回复关、知识库关）', () => {
    const dir = root()
    const snap = listClawbotInstances(dir, { since: 0 })
    expect(snap.instances, '新装用户应是「一个实例都没有」，不是错误').toEqual([])
    expect(snap.readError).toBeUndefined()
    expect(readInstanceConfig(dir, 3).config).toEqual(defaultInstanceConfig(3))
  })

  it('新库里第一个实例是 slot 1（与旧的单绑定形态一致）；再建则是 slot 2', () => {
    const dir = root()
    // 触发建库：写一次配置会因「实例不存在」被拒，这里用建实例之外的路径 —— 读绑定不建库，
    // 所以先用「建实例」把库拉起来（空库上 ensureSchema 会补出 slot 1）。
    const second = createClawbotInstance(dir)
    expect(second.slot, '空库上建实例：ensureSchema 已补出 slot 1，新建的应是 2').toBe(2)
    const snap = listClawbotInstances(dir, { since: 0 })
    expect(snap.instances.map((i) => i.slot), '两个实例都要在列表里，按 slot 升序').toEqual([1, 2])
    expect(snap.instances[0]?.status).toBe('unbound')
    expect(DEFAULT_CLAWBOT_SLOT).toBe(1)
  })

  it('配置按实例隔离，且**活过重新绑定**（绑定行被覆盖、偏好不该丢）', () => {
    const dir = root()
    createClawbotInstance(dir) // slot 2
    const saved = saveInstanceConfig(dir, 1, { autoReply: true, kbEnabled: true, kbId: 7 })
    expect(saved).toEqual({ slot: 1, autoReply: true, kbEnabled: true, kbId: 7, systemPrompt: '', splitReply: true })
    expect(readInstanceConfig(dir, 2).config, 'slot 2 没配过，必须还是默认值（不许被 slot 1 的配置串到）')
      .toEqual(defaultInstanceConfig(2))

    // 部分更新：只关自动回复，知识库设置保持
    const patched = saveInstanceConfig(dir, 1, { autoReply: false })
    expect(patched).toEqual({ slot: 1, autoReply: false, kbEnabled: true, kbId: 7, systemPrompt: '', splitReply: true })

    // 重新绑定（身份与凭证被覆盖）之后，配置仍在
    completeBinding(dir, { wxid: 'wxid_a', userName: '甲' }, CREDS, 1)
    expect(readInstanceConfig(dir, 1).config, '重新绑定把配置清了 = 用户每次扫码都要重设一遍')
      .toEqual({ slot: 1, autoReply: false, kbEnabled: true, kbId: 7, systemPrompt: '', splitReply: true })
  })

  it('配置只能挂在已存在的实例上（拒绝造出「没有实例的配置」）', () => {
    const dir = root()
    createClawbotInstance(dir) // 建库
    expect(() => saveInstanceConfig(dir, 99, { autoReply: true })).toThrow(/不存在/)
  })

  it('自动回复硬门禁：显式开启但没有有效知识库 ⇒ 拒绝保存；清空知识库 ⇒ 自动关闭', () => {
    const dir = root()
    createClawbotInstance(dir) // 建库（slot 1 由 ensureSchema 补出）

    // 显式要求开启 autoReply、但当前没有知识库：必须给可读原因，并且不能落库成开启态。
    expect(() => saveInstanceConfig(dir, 1, { autoReply: true })).toThrow(AUTO_REPLY_KB_REQUIRED_MESSAGE)
    expect(readInstanceConfig(dir, 1).config).toEqual(defaultInstanceConfig(1))

    // 先准备知识库再开启：允许，且 kbId 原样保留。
    const withKb = saveInstanceConfig(dir, 1, { kbEnabled: true, kbId: 7 })
    expect(withKb).toMatchObject({ autoReply: false, kbEnabled: true, kbId: 7 })
    expect(saveInstanceConfig(dir, 1, { autoReply: true })).toMatchObject({ autoReply: true, kbEnabled: true, kbId: 7 })

    // 关闭知识库导致现有自动回复失去运行条件：自动把 autoReply 置 false，并允许保存。
    const disabled = saveInstanceConfig(dir, 1, { kbEnabled: false })
    expect(disabled).toMatchObject({ autoReply: false, kbEnabled: false, kbId: 7 })
    expect(readInstanceConfig(dir, 1).config.autoReply, '不能留下「开着但必然不发送」的矛盾状态').toBe(false)

    // 重新开启知识库不会把 autoReply 悄悄打开；用户仍要显式再开一次。
    expect(saveInstanceConfig(dir, 1, { kbEnabled: true })).toMatchObject({ autoReply: false, kbEnabled: true, kbId: 7 })
  })

  it('配置归一矩阵：纯函数对 patch × 当前状态给出同一结论', () => {
    const current = { slot: 1, autoReply: true, kbEnabled: true, kbId: 7, systemPrompt: '', splitReply: true }
    // 显式开启 + 有效知识库 ⇒ 开。
    expect(resolveInstanceConfigForSave({ slot: 1, current, patch: { autoReply: true } }))
      .toMatchObject({ autoReply: true, kbEnabled: true, kbId: 7 })
    // 显式开启 + 同时清空知识库 ⇒ 抛错，不做“先清库再开”的静默半状态。
    expect(() => resolveInstanceConfigForSave({
      slot: 1,
      current,
      patch: { autoReply: true, kbId: null },
    })).toThrow(AUTO_REPLY_KB_REQUIRED_MESSAGE)
    // 关闭知识库 + 未显式要求开 ⇒ 自动收敛为关。
    expect(resolveInstanceConfigForSave({ slot: 1, current, patch: { kbEnabled: false } }))
      .toMatchObject({ autoReply: false, kbEnabled: false, kbId: 7 })
    // 关闭知识库 + 同一次 patch 明确要求开 ⇒ 拒绝，不能靠“保留旧库 id”绕过门禁。
    expect(() => resolveInstanceConfigForSave({
      slot: 1,
      current,
      patch: { autoReply: true, kbEnabled: false },
    })).toThrow(AUTO_REPLY_KB_REQUIRED_MESSAGE)
    // 旧库遗留的矛盾配置（已开但无库）在任意保存时收敛为关。
    expect(resolveInstanceConfigForSave({
      slot: 1,
      current: { ...current, kbEnabled: false, kbId: null },
      patch: { systemPrompt: '  新提示词  ' },
    })).toMatchObject({ autoReply: false, kbEnabled: false, kbId: null, systemPrompt: '新提示词' })
  })

  it('别名（label）：可改可清，且**活过重新绑定与解绑**（2026-10-16）', () => {
    const dir = root()
    createClawbotInstance(dir) // 建库（slot 1 由 ensureSchema 补出）
    expect(readBinding(dir, 1).binding.label, '没起过别名时是 null（界面回落到昵称）').toBeNull()

    expect(renameBinding(dir, 1, '  工作号  ').label, '首尾空白要去掉').toBe('工作号')
    expect(listClawbotInstances(dir, { since: 0 }).instances[0]?.label, '列表要带上别名').toBe('工作号')

    // 别名是用户偏好，不是绑定状态机的一部分 ⇒ 重新绑定与解绑都不该动它。
    completeBinding(dir, { wxid: 'wxid_a', userName: '甲' }, CREDS, 1)
    expect(readBinding(dir, 1).binding.label, '重新绑定把别名清了 = 用户每次扫码都要重起一遍').toBe('工作号')
    unbindBinding(dir, 1)
    expect(readBinding(dir, 1).binding.label, '解绑把别名清了 = 用户重新绑定后认不出哪个号').toBe('工作号')

    // 空串 / 全空白 = 清除别名（不是「起一个空名字」）。
    expect(renameBinding(dir, 1, '   ').label).toBeNull()
    expect(readBinding(dir, 1).binding.label).toBeNull()
  })

  it('别名：超长截断到 40 字符；实例不存在时拒绝', () => {
    const dir = root()
    createClawbotInstance(dir)
    expect(renameBinding(dir, 1, 'x'.repeat(80)).label, '别名是展示用的，截断比拒绝更友好').toHaveLength(40)
    expect(() => renameBinding(dir, 99, '甲')).toThrow(/不存在/)
  })

  it('别名按实例隔离：改 slot 1 不动 slot 2', () => {
    const dir = root()
    createClawbotInstance(dir) // slot 2
    renameBinding(dir, 1, '工作号')
    renameBinding(dir, 2, '客服号')
    const bySlot = new Map(listClawbotInstances(dir, { since: 0 }).instances.map((i) => [i.slot, i.label]))
    expect(bySlot.get(1)).toBe('工作号')
    expect(bySlot.get(2)).toBe('客服号')
  })

  it('删实例：七类 slot 状态一起删，**别的实例一条不动**', () => {
    const dir = root()
    createClawbotInstance(dir) // slot 2
    seedDeletionSurface(dir, 1)
    seedDeletionSurface(dir, 2)

    const r = deleteClawbotInstance(dir, 1)
    expect(r.removedMessages, '删掉的条数要如实回报（界面在确认框里要说这个数）').toBe(1)
    expect(slotCounts(dir, 1), '实例 1 的绑定/配置/消息/墓碑/token/回复状态必须全部清空').toEqual({
      binding: 0,
      config: 0,
      messages: 0,
      tombstones: 0,
      tokenUsage: 0,
      replyRuns: 0,
      replyOutbox: 0,
    })
    expect(readInstanceConfig(dir, 1).config, '实例 1 的配置行要一起删（否则新实例可能捡到残留）')
      .toEqual(defaultInstanceConfig(1))
    expect(slotCounts(dir, 2), '实例 2 的七类状态都不许被删').toEqual({
      binding: 1,
      config: 1,
      messages: 1,
      tombstones: 1,
      tokenUsage: 1,
      replyRuns: 1,
      replyOutbox: 1,
    })
    expect(readInstanceConfig(dir, 2).config, '实例 2 的配置值也要原样保留')
      .toEqual({ slot: 2, autoReply: true, kbEnabled: true, kbId: 12, systemPrompt: '', splitReply: true })
    expect(listClawbotMessages(dir, { slot: 2 }).total, '实例 2 的会话不许被删').toBe(1)
  })

  it('删实例中途失败：七类状态全部回滚，不留半删除窗口', () => {
    const dir = root()
    createClawbotInstance(dir) // slot 2
    seedDeletionSurface(dir, 1)
    seedDeletionSurface(dir, 2)
    const beforeTarget = slotCounts(dir, 2)
    const beforeOther = slotCounts(dir, 1)

    const db = new DatabaseSync(clawbotDbPath(dir))
    db.exec(`CREATE TRIGGER fail_instance_delete
      BEFORE DELETE ON clawbot_binding
      WHEN OLD.slot = 2
      BEGIN
        SELECT RAISE(ABORT, 'delete blocked');
      END`)
    db.close()

    expect(() => deleteClawbotInstance(dir, 2)).toThrow(/delete blocked/)
    expect(slotCounts(dir, 2), '失败后目标实例的所有关联行必须原样保留').toEqual(beforeTarget)
    expect(slotCounts(dir, 1), '回滚不得影响别的实例').toEqual(beforeOther)
  })

  it('删除唯一实例后保持空库：后续 schema 初始化不得重建默认实例', () => {
    const dir = root()
    deleteClawbotInstance(dir, 1)

    expect(listClawbotInstances(dir, { since: 0 }).instances, '删空后的实例列表必须为空').toEqual([])
    expect(Number(raw<{ n?: number }>(dir, 'SELECT COUNT(*) AS n FROM clawbot_binding')?.n ?? -1),
      '绑定表里不能留下自愈补出的默认行').toBe(0)

    ensureClawbotStore(dir)
    ensureClawbotStore(dir)

    expect(listClawbotInstances(dir, { since: 0 }).instances, '任意 schema 写路径重入后仍应保持空库').toEqual([])
    expect(Number(raw<{ n?: number }>(dir, 'SELECT COUNT(*) AS n FROM clawbot_binding')?.n ?? -1),
      '持久初始化标记必须阻止默认实例被再次补出').toBe(0)
  })

  it('slot **不复用**：删掉 2 之后再建，拿到的是 3（否则新实例会捡到残留配置）', () => {
    const dir = root()
    createClawbotInstance(dir) // 2
    const third = createClawbotInstance(dir) // 3
    expect(third.slot).toBe(3)
    deleteClawbotInstance(dir, 3)
    const again = createClawbotInstance(dir)
    expect(again.slot, '复用 3 的话，上一轮 3 的残留在语义上会变成新实例的').toBe(4)
  })

  it('同一微信号只服务一个实例：后绑的接管，前一个被收敛且**凭证清空**', () => {
    const dir = root()
    createClawbotInstance(dir) // slot 2
    completeBinding(dir, { wxid: 'wxid_same', userName: '甲' }, CREDS, 1)
    completeBinding(dir, { wxid: 'wxid_same', userName: '甲' }, CREDS, 2)

    expect(readBinding(dir, 1).binding.status, '同一个号出现在两个实例上 ⇒ 前一个必须被收敛').toBe('unbound-by-user')
    expect(readBinding(dir, 2).binding.status).toBe('bound')
    const oldCreds = readBindingInternal(dir, 1).credentials
    expect(oldCreds, '凭证必须清空（存储侧的「解绑即停轮询」保证）').toBeNull()
    expect(readBindingInternal(dir, 2).credentials, '接管方的凭证要完好').not.toBeNull()
  })

  it('会话按实例隔离：列表与续传位（maxId）都只看本实例', () => {
    const dir = root()
    createClawbotInstance(dir)
    insertClawbotMessage(dir, { slot: 1, ts: 2000, direction: 'in', content: '一', msgType: 'text', msgId: 11 })
    const m2 = insertClawbotMessage(dir, { slot: 2, ts: 2001, direction: 'in', content: '二', msgType: 'text', msgId: 11 })
    expect(m2, '同一个 msg_id 在**不同实例**上不算重复（服务端按会话下发号段）').not.toBeNull()

    const one = listClawbotMessages(dir, { slot: 1 })
    expect(one.items.map((i) => i.content)).toEqual(['一'])
    expect(one.total).toBe(1)
    expect(one.maxId, 'maxId 跨实例取会让续传位虚高、增量被跳过').toBeLessThan(Number(m2))
    expect(listClawbotMessages(dir, { slot: 2 }).items.map((i) => i.content)).toEqual(['二'])
    expect(listClawbotMessages(dir, { slot: 2 }).items[0]?.slot).toBe(2)
    expect(listClawbotMessages(dir, {}).items.map((i) => i.content), '不传 slot = 第一个实例').toEqual(['一'])
  })

  it('实例列表带上配置与会话计数（设置视图一张卡所需的全部信息）', () => {
    const dir = root()
    insertClawbotMessage(dir, { slot: 1, ts: 5000, direction: 'in', content: 'x', msgType: 'text' })
    saveInstanceConfig(dir, 1, { autoReply: true, kbEnabled: true, kbId: 9 })
    const inst = listClawbotInstances(dir, { since: 0 }).instances[0]
    expect(inst?.slot).toBe(1)
    expect(inst?.config.autoReply).toBe(true)
    expect(inst?.totalMessages).toBe(1)
    expect(inst?.todayMessages).toBe(1)
    expect(inst?.channel, '没注入通道查询时给「未运行」，不许瞎报运行中').toEqual({ running: false, error: null })
  })

  it('补全实例信息（2026-10-17）：botId 是公开标识、lastMessageAt 取 MAX(ts)', () => {
    const dir = root()
    // 绑定一个实例（带凭证 ⇒ ilink_bot_id 落库）。
    completeBinding(dir, { wxid: 'wx-1' }, { botToken: 'bt', ilinkBotId: 'bot-abc', ilinkUserId: 'wx-1', baseUrl: '' }, 1)
    // 先插晚的、再插早的：lastMessageAt 必须取 MAX(ts) 而不是「最后一行的 ts」。
    insertClawbotMessage(dir, { slot: 1, ts: 9000, direction: 'in', content: '晚' })
    insertClawbotMessage(dir, { slot: 1, ts: 1000, direction: 'in', content: '早' })
    const inst = listClawbotInstances(dir, { since: 0 }).instances[0]
    expect(inst?.botId, 'botId 是公开标识（非凭证），实例卡要能显示它').toBe('bot-abc')
    expect(inst?.lastMessageAt, 'lastMessageAt 取 MAX(ts)，不是最后一行的 ts').toBe(9000)
    // 未绑定的实例：botId 为 null（不编造），lastMessageAt 为 0（还没有消息）。
    const fresh = createClawbotInstance(dir)
    const freshInst = listClawbotInstances(dir, { since: 0 }).instances.find((i) => i.slot === fresh.slot)
    expect(freshInst?.botId).toBeNull()
    expect(freshInst?.lastMessageAt).toBe(0)
  })

  it('botId 只挑非敏感列：实例列表快照里不许出现 bot_token（凭证）', () => {
    const dir = root()
    completeBinding(dir, { wxid: 'wx-1' }, { botToken: 'SECRET-TOKEN', ilinkBotId: 'bot-abc', ilinkUserId: 'wx-1', baseUrl: '' }, 1)
    const snap = listClawbotInstances(dir, { since: 0 })
    // 整个快照序列化后不许含凭证 —— botId 是公开标识，bot_token 才是密钥。
    expect(JSON.stringify(snap)).not.toContain('SECRET-TOKEN')
    expect(JSON.stringify(snap)).toContain('bot-abc')
  })
})

describe('clawbot 多实例：老库迁移', () => {
  /** 造一个**改动之前**的库：两张表都没有 `slot` 列，且各有一行数据。 */
  function legacyDb(dir: string): void {
    const db = new DatabaseSync(clawbotDbPath(dir))
    db.exec(`CREATE TABLE clawbot_binding (
      id INTEGER PRIMARY KEY AUTOINCREMENT, status TEXT NOT NULL DEFAULT 'unbound', qr_token TEXT,
      qr_expires_at INTEGER, wxid TEXT, user_name TEXT, avatar TEXT, bound_at INTEGER, unbound_at INTEGER,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, bot_token TEXT, ilink_bot_id TEXT,
      ilink_user_id TEXT, base_url TEXT, sync_buf TEXT, send_context_token TEXT)`)
    db.exec(`CREATE TABLE clawbot_message (
      id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, direction TEXT NOT NULL, msg_type TEXT,
      content TEXT, created_at INTEGER NOT NULL, msg_id INTEGER, media_kind TEXT, media_ref TEXT,
      media_key TEXT, media_name TEXT, media_size INTEGER)`)
    db.prepare("INSERT INTO clawbot_binding(status, wxid, user_name, created_at, updated_at) VALUES ('bound', 'wxid_old', '老用户', 1, 1)").run()
    db.prepare("INSERT INTO clawbot_message(ts, direction, msg_type, content, created_at) VALUES (900, 'in', 'text', '老消息', 1)").run()
    db.close()
  }

  it('补齐 slot 列后：原来那唯一一行 = slot 1，旧消息也归 1（一条不丢）', () => {
    const dir = root()
    legacyDb(dir)
    // 任一写路径都会先 ensureClawbotSchema（补列），这里用一次解绑触发它
    const after = completeBinding(dir, { wxid: 'wxid_old', userName: '老用户' }, null, 1)
    expect(after.slot).toBe(1)
    expect(readBinding(dir, 1).binding.userName, '老库的身份不许丢').toBe('老用户')
    expect(listClawbotMessages(dir, { slot: 1 }).items.map((i) => i.content)).toEqual(['老消息'])
    expect(readInstanceConfig(dir, 1).config).toEqual(defaultInstanceConfig(1))
  })

  it('老库不会被「补出」多余实例：表里本来只有一行，补完还是一行', () => {
    const dir = root()
    legacyDb(dir)
    completeBinding(dir, { wxid: 'wxid_old' }, null, 1)
    expect(listClawbotInstances(dir, { since: 0 }).instances.map((i) => i.slot)).toEqual([1])
  })

  it('读路径也要补列：老库缺 label 时**读**不许报「no such column」（2026-10-16 真机踩到）', () => {
    // 真机症状：升级后打开面板显示「实例列表读取失败：绑定列表读取失败：no such column: label」。
    // 成因：`ensureClawbotSchema` 原先只在**写路径**调用，而 `SELECT_COLUMNS` 写死了 `label` ——
    // 用户什么都没做错，只是升级了版本，而**读**是打开面板的第一件事，写路径的自愈根本轮不到。
    const dir = root()
    legacyDb(dir)
    // 先补出 slot 列（老库连 slot 都没有），但**不补 label** —— 模拟「升级到多实例之后、
    // 别名功能之前」那一版建的库。
    const db = new DatabaseSync(clawbotDbPath(dir))
    db.exec('ALTER TABLE clawbot_binding ADD COLUMN slot INTEGER NOT NULL DEFAULT 1')
    db.exec('UPDATE clawbot_binding SET slot = id')
    db.close()

    // 纯读路径（不经过任何写）：必须自愈，不许把「缺列」报成「读失败」。
    const snap = listClawbotInstances(dir, { since: 0 })
    expect(snap.readError, '读路径没补列 ⇒ 老库升级后打开面板就是一片红').toBeUndefined()
    expect(snap.instances.map((i) => i.slot)).toEqual([1])
    expect(snap.instances[0]?.label, '补出来的 label 列是 NULL（= 没起别名）').toBeNull()
    expect(snap.instances[0]?.userName, '老库的身份不许丢').toBe('老用户')
    expect(readBinding(dir, 1).readError).toBeUndefined()
  })
})
