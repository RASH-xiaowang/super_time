/**
 * 微信 ClawBot **多实例**（`clawbot_binding.slot`）与**每实例配置**（`clawbot_instance_config`）。
 *
 * ## 为什么要有 slot（2026-10-13）
 *
 * 官方口径是「一个桌面宿主对一个微信号」，但真实用法是**同时管几个号**（工作号 / 生活号 /
 * 客服号）。于是绑定表从「只有一行」变成「一 slot 一行」：
 * slot 是实例的稳定编号（**1 起、只增不复用**——复用会把上一个实例的会话与配置串到新实例上）。
 * 绑定身份与凭证仍住在 `clawbot_binding`（那张表的生命周期是「扫码 → 绑定 → 解绑」），
 * 而**行为配置**住在 `clawbot_instance_config`（生命周期是「用户偏好」，要活过重新绑定）。
 *
 * ## 配置集中管理（本模块是唯一入口）
 *
 * 所有实例级配置的读写**只经过** {@link readInstanceConfig} / {@link saveInstanceConfig}：
 * 默认值、脏值归一、迁移登记三件事各只写一份。将来要加开关（提示词 / 冷却 / 白名单），
 * 只改本模块 + `clawbot-db.ts` 的 `INSTANCE_CONFIG_COLUMN_MIGRATIONS`，别处一行不动。
 *
 * ## 出网与自动回复
 *
 * 本模块**不出网、不调用模型**：它只回答「有哪些实例、每个实例的配置是什么」。
 * 自动回复的装配（拿统一对话模型 + 可选知识库、回发、落库）在 `remotes/clawbot.ts`
 * 与 `query/clawbot/clawbot-auto-reply.ts`；分开是为了让配置与存储能脱离模型被单测。
 *
 * ## 读失败语义（与 `clawbot-binding` / `operation-log` 同款）
 *
 * 库不存在 ⇒ 空列表 / 默认配置（**不是错误**：还没建实例）；库存在但打不开 ⇒ `readError`，
 * 界面必须把「读不到」与「一个实例都没有」分开显示。
 *
 * @module query/clawbot/clawbot-instance
 */
import type { ClawbotBinding, ClawbotChannelInfo, ClawbotInstance, ClawbotInstanceConfig, ClawbotInstancesSnapshot } from '../../types.ts'
import { DEFAULT_CLAWBOT_SLOT, clawbotDbExists, clawbotDbPath, ensureClawbotSchema } from './clawbot-db.ts'
import { readBindings, readBotIds } from './clawbot-binding.ts'
import { clawbotMessageCounts } from './clawbot-message.ts'
import { clawbotDayKey, clawbotTokenStats } from './clawbot-token.ts'
import { withDb, withWritableDb } from '../db-open.ts'

/** 未配置过的实例的默认行为：自动回复**关**、知识库**关**、提示词用内置默认、长回复分段。 */
export function defaultInstanceConfig(slot: number = DEFAULT_CLAWBOT_SLOT): ClawbotInstanceConfig {
  return { slot, autoReply: false, kbEnabled: false, kbId: null, systemPrompt: '', splitReply: true }
}

/** 拆成两半：配置 + （可选）读失败原因。 */
export interface InstanceConfigRead {
  config: ClawbotInstanceConfig
  readError?: string
}

/** 一行配置记录 → 配置（脏值收敛：布尔只认 0/1；kbId 非正数归 null）。 */
function toConfig(r: Record<string, unknown>, slot: number): ClawbotInstanceConfig {
  const kbId = Number(r['kb_id'] ?? 0)
  return {
    slot,
    autoReply: Number(r['auto_reply'] ?? 0) === 1,
    kbEnabled: Number(r['kb_enabled'] ?? 0) === 1,
    kbId: Number.isFinite(kbId) && kbId > 0 ? Math.floor(kbId) : null,
    systemPrompt: typeof r['system_prompt'] === 'string' ? r['system_prompt'] : '',
    // 缺列（老库）时给 `true`：分段是**更好的默认**，老库升级后应当享受到。
    splitReply: Number(r['split_reply'] ?? 1) === 1,
  }
}

/**
 * 读某个实例的配置。**没有行 = 默认配置**（不是错误）：实例刚建出来时本来就没有配置行。
 * @param decryptedDir - 解密数据根。
 * @param slot - 实例编号（缺省 1）。
 * @returns 配置 + 可选读失败原因。
 */
export function readInstanceConfig(decryptedDir: string, slot: number = DEFAULT_CLAWBOT_SLOT): InstanceConfigRead {
  const s = Math.max(Math.floor(slot), 1)
  if (!clawbotDbExists(decryptedDir)) return { config: defaultInstanceConfig(s) }
  try {
    return withDb(clawbotDbPath(decryptedDir), (db) => {
      const row = db.prepare('SELECT auto_reply, kb_enabled, kb_id, system_prompt, split_reply FROM clawbot_instance_config WHERE slot = ?').get(s) as Record<string, unknown> | undefined
      return { config: row ? toConfig(row, s) : defaultInstanceConfig(s) }
    })
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    console.warn('[clawbot] 实例配置读取失败（与「未配置」不同）：' + message)
    return { config: defaultInstanceConfig(s), readError: '实例配置读取失败：' + message }
  }
}

/**
 * 写某个实例的配置（**部分更新**：只覆盖传进来的字段）。
 *
 * 实例不存在时**不创建**：配置是绑定行的附属物，凭空写配置会造出一个「没有实例的配置」，
 * 而列表遍历以绑定行为准，那条配置永远不生效 —— 这种半截状态最难查，所以直接拒绝。
 * @param decryptedDir - 解密数据根。
 * @param slot - 实例编号。
 * @param patch - 要改的字段（未传的保持原值）。
 * @returns 落库后的完整配置。
 * @throws 实例不存在时抛可读中文（调用方按 message 展示）。
 */
export function saveInstanceConfig(
  decryptedDir: string,
  slot: number,
  patch: Partial<Omit<ClawbotInstanceConfig, 'slot'>>,
): ClawbotInstanceConfig {
  const s = Math.max(Math.floor(slot), 1)
  return withWritableDb(clawbotDbPath(decryptedDir), (db) => {
    ensureClawbotSchema(db)
    const exists = db.prepare('SELECT 1 AS x FROM clawbot_binding WHERE slot = ? LIMIT 1').get(s)
    if (!exists) throw new Error(`实例 ${s} 不存在（配置只能挂在已建的实例上）`)
    const row = db.prepare('SELECT auto_reply, kb_enabled, kb_id, system_prompt, split_reply FROM clawbot_instance_config WHERE slot = ?').get(s) as Record<string, unknown> | undefined
    const cur = row ? toConfig(row, s) : defaultInstanceConfig(s)
    // kbId 在这里也归一（与读路径 `toConfig` 同一口径）：0 / 负数 / NaN 都是「没有库」，
    // 不是「第 0 号库」—— 写进去再读出来会变成另一个值的东西不该落盘。
    const rawKb = patch.kbId === undefined ? cur.kbId : patch.kbId
    const kbId = rawKb === null || !Number.isFinite(rawKb) || rawKb <= 0 ? null : Math.floor(rawKb)
    const next: ClawbotInstanceConfig = {
      slot: s,
      autoReply: patch.autoReply ?? cur.autoReply,
      kbEnabled: patch.kbEnabled ?? cur.kbEnabled,
      kbId,
      // 提示词归一：首尾空白去掉；上限 4000 字（超出截断而不是抛错 —— 提示词是展示/偏好，
      // 截断比拒绝更友好；4000 字已远超任何合理的人设描述）。
      systemPrompt: (patch.systemPrompt ?? cur.systemPrompt).trim().slice(0, 4000),
      splitReply: patch.splitReply ?? cur.splitReply,
    }
    const now = Date.now()
    db.prepare(`INSERT INTO clawbot_instance_config(slot, auto_reply, kb_enabled, kb_id, system_prompt, split_reply, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(slot) DO UPDATE SET auto_reply = excluded.auto_reply, kb_enabled = excluded.kb_enabled,
        kb_id = excluded.kb_id, system_prompt = excluded.system_prompt, split_reply = excluded.split_reply,
        updated_at = excluded.updated_at`)
      .run(s, next.autoReply ? 1 : 0, next.kbEnabled ? 1 : 0, next.kbId, next.systemPrompt, next.splitReply ? 1 : 0, now, now)
    return next
  })
}

/**
 * 建一个新实例（初始 `unbound`），**slot = 新行的自增 id**。
 *
 * 为什么不取 `MAX(slot) + 1`：删掉最后一个实例之后它会**复用**那个编号，而配置与会话
 * 都按 slot 存 ⇒ 新实例直接捡到上一个实例的偏好（用户完全看不出来）。
 * `AUTOINCREMENT` 的 id 只增不复用，用它当 slot 就把这条语义交给数据库保证。
 * @param decryptedDir - 解密数据根。
 * @returns 新建的绑定行（`status='unbound'`）。
 */
export function createClawbotInstance(decryptedDir: string): ClawbotBinding {
  return withWritableDb(clawbotDbPath(decryptedDir), (db) => {
    ensureClawbotSchema(db)
    const now = Date.now()
    // 先按占位 slot 插入，再把 slot 校正成刚拿到的 id（同一个事务里完成，外部看不到中间态）。
    const ins = db.prepare('INSERT INTO clawbot_binding(slot, status, created_at, updated_at) VALUES (?, ?, ?, ?)')
      .run(DEFAULT_CLAWBOT_SLOT, 'unbound', now, now)
    const id = Number(ins.lastInsertRowid)
    db.prepare('UPDATE clawbot_binding SET slot = ? WHERE id = ?').run(id, id)
    return {
      id, slot: id,
      status: 'unbound',
      qrToken: null, qrExpiresAt: null, wxid: null, userName: null, label: null, avatar: null,
      botId: null, boundAt: null, unboundAt: null, createdAt: now, updatedAt: now,
    }
  })
}

/**
 * 删除一个实例及其全部 slot 级状态。
 *
 * 绑定、配置、消息、tombstone、回复 run/outbox 与 token 统计必须同生共死：
 * 任一步失败都要整体回滚，避免留下无法再从实例列表访问的孤儿行。界面必须在
 * 确认框里说清「将删除该实例的 N 条接入会话」，不许静默丢数据。
 * @param decryptedDir - 解密数据根。
 * @param slot - 实例编号。
 * @returns 删掉的消息条数（供界面如实回报）。
 */
export function deleteClawbotInstance(decryptedDir: string, slot: number): { removedMessages: number } {
  const s = Math.max(Math.floor(slot), 1)
  return withWritableDb(clawbotDbPath(decryptedDir), (db) => {
    ensureClawbotSchema(db)
    db.exec('BEGIN IMMEDIATE')
    try {
      const before = Number((db.prepare('SELECT COUNT(*) AS n FROM clawbot_message WHERE slot = ?').get(s) as { n?: number } | undefined)?.n ?? 0)
      // 先删子状态，最后删绑定行；任何一条失败都由同一事务回滚。
      db.prepare('DELETE FROM clawbot_reply_outbox WHERE slot = ?').run(s)
      db.prepare('DELETE FROM clawbot_reply_run WHERE slot = ?').run(s)
      db.prepare('DELETE FROM clawbot_message WHERE slot = ?').run(s)
      db.prepare('DELETE FROM clawbot_message_tombstone WHERE slot = ?').run(s)
      db.prepare('DELETE FROM clawbot_instance_config WHERE slot = ?').run(s)
      db.prepare('DELETE FROM clawbot_token_usage WHERE slot = ?').run(s)
      db.prepare('DELETE FROM clawbot_binding WHERE slot = ?').run(s)
      db.exec('COMMIT')
      return { removedMessages: before }
    } catch (e) {
      try { db.exec('ROLLBACK') } catch { /* 保留原始异常 */ }
      throw e
    }
  })
}

/**
 * 实例列表（设置视图的实例卡）——绑定行 + 配置 + 会话计数 + 通道运行态。
 *
 * `channelState` 由**装配层注入**（通道注册表住在 `remotes/clawbot.ts`，存储层不该知道它）：
 * 与「ask 能力注入」同款，让存储模块能脱离通道被单测。
 * @param decryptedDir - 解密数据根。
 * @param opts.since - 「今日消息」的起点（本地时区当天 0 点）。
 * @param opts.channelState - 取某实例的通道状态（缺省给「未运行」）。
 * @returns 实例列表快照（含 readError）。
 */
export function listClawbotInstances(
  decryptedDir: string,
  opts: { since: number, channelState?: (slot: number) => ClawbotChannelInfo },
): ClawbotInstancesSnapshot {
  const { bindings, readError } = readBindings(decryptedDir)
  if (readError !== undefined) return { instances: [], readError }
  const idle: ClawbotChannelInfo = { running: false, error: null }
  // 机器人 id 一次读全（每个实例一条 SQL 会随实例数线性增长；它是展示增强，读失败给空映射）。
  const botIds = readBotIds(decryptedDir)
  // token 统计同样一次读全（两段 GROUP BY），避免每个实例各开一次库。
  const tokenStats = clawbotTokenStats(decryptedDir, clawbotDayKey(opts.since))
  const instances: ClawbotInstance[] = bindings.map((b) => {
    const cfg = readInstanceConfig(decryptedDir, b.slot)
    const counts = clawbotMessageCounts(decryptedDir, { since: opts.since, slot: b.slot })
    const tokens = tokenStats.get(b.slot)
    return {
      slot: b.slot,
      status: b.status,
      wxid: b.wxid,
      userName: b.userName,
      label: b.label,
      avatar: b.avatar,
      botId: botIds[b.slot] ?? null,
      boundAt: b.boundAt,
      unboundAt: b.unboundAt,
      config: cfg.config,
      todayMessages: counts.today,
      totalMessages: counts.total,
      todayTokens: tokens?.todayTokens ?? 0,
      totalTokens: tokens?.totalTokens ?? 0,
      lastMessageAt: counts.lastTs,
      channel: opts.channelState ? opts.channelState(b.slot) : idle,
    }
  })
  return { instances }
}


/**
 * 把「界面可能没传」的 slot 解析成**真正要操作的实例**。
 *
 * 三条规则，从强到弱：
 *  ① 显式传了正数 ⇒ **照用**（不校验存不存在：不存在的实例由各写路径的 readError / 抛错如实
 *     暴露，而不是在这里静默改成别的实例 —— 那会把「操作 A 号」变成「操作 B 号」）；
 *  ② 否则 ⇒ **第一个 `bound` 实例**（多实例下「默认那个号」= 真正在用的号）；
 *  ③ 一个 bound 都没有 ⇒ 第一个实例（老库单行、刚解绑、尚未绑定 —— 都落到那一行）；
 *     表里一行都没有 ⇒ 回落 1（单实例时代的行为；查询与写入会各自自愈建行）。
 *
 * 为什么 ② 不能省（实测踩过）：新库自带一行**从未绑定**的默认实例（`ensureClawbotSchema`
 * 的空表兜底），若缺省只看「第一个实例」，会话面板与发送会指向那个空实例 ——
 * 用户明明绑了第二个号，界面上却写着「尚未绑定微信」。
 * @param decryptedDir - 解密数据根。
 * @param requested - 调用方指定的 slot（可空）。
 * @returns 实例编号（恒 ≥ 1）。
 */
export function resolveClawbotSlot(decryptedDir: string, requested?: number): number {
  if (typeof requested === 'number' && Number.isFinite(requested) && requested >= 1) {
    return Math.floor(requested)
  }
  const { bindings } = readBindings(decryptedDir)
  const first = bindings.find((b) => b.status === 'bound') ?? bindings[0]
  return first === undefined ? DEFAULT_CLAWBOT_SLOT : first.slot
}
