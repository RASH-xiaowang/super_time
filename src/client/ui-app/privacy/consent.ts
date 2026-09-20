/**
 * 隐私声明同意状态（H14）。
 *
 * 为什么放在 localStorage 而不是状态目录：与启动引导（`onboarding/store.ts`）同一套做法 ——
 * 两者都是「这个界面上的引导是否看过」的会话级元数据，且都不含任何敏感内容。
 * 密钥、数据源这类东西一律不进这里（见 M1：渲染进程曾把含明文密钥的配置写进 localStorage）。
 *
 * 为什么需要版本号：隐私声明的材料性变更（新增出网点、扩大数据读取范围）必须让用户
 * **重新同意**，而不是继承一个旧版本的「已同意」。`PRIVACY_VERSION` 与
 * `docs/PRIVACY.md` 顶部的「生效版本」一一对应。
 *
 * 本模块是**纯逻辑**（不 import react、不碰 DOM）：`localStorage` 通过可注入的 KV 传入，
 * 因此可以在 node 环境的 vitest 里确定性覆盖（仓库没有组件测试环境，见 M13/M15 的做法）。
 */

/**
 * 当前隐私声明版本：材料性变更时 +1，会要求所有用户重新同意。
 *
 * v1 → v2（2026-09-19）：**知识库文件正文**进入 embedding 出网范围。此前只有检索到的
 * 聊天片段会以向量形式出网；现在用户选进知识库、且未关闭「参与 RAG」的文件块正文
 * 也会被送去向量化。这属于数据用途的材料性变更，必须重新同意（见 `docs/PRIVACY.md` 第四节 B）。
 *
 * v2 → v3（2026-09-19）：新增 LLM 用途「知识库文件的模型摘要」。点「生成摘要」会把
 * **指定那份文件的前 8,000 字正文**发给模型 —— 此前出去的是「检索命中的片段」，
 * 现在是「用户点名的一份文件的开头」，用途不同，故按同一规矩升版。
 * 关掉「参与语义检索（会出网）」的文件在后端就被拒绝，不会走到发送那一步。
 */
export const PRIVACY_VERSION = 3

/**
 * 存储键（后缀是**存储格式**版本，不是声明版本，便于将来整体迁移）。
 *
 * 与 `PRIVACY_VERSION` 无关：强制重新同意的机制是记录里的 `version` 字段
 * （`needsConsent` 比它和当前版本），所以声明升版**不需要**换键 —— 换了反而会在
 * localStorage 里留一条永远没人清理的旧记录。
 */
export const PRIVACY_STORAGE_KEY = 'super-time-privacy-consent-v1'

export interface ConsentRecord {
  version: number
  acceptedAt: string
}

/** 最小存储接口：只要这三个方法，测试里用假对象即可。 */
export interface ConsentKv {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

/**
 * 解析本地记录。
 *
 * 任何形状不对（字段缺失、版本不是正整数、时间不是字符串）一律当作**没有同意过** ——
 * 这里的失败方向必须是「要求重新同意」，而不是「默认已同意」。
 * @param raw - localStorage 里读到的原始字符串。
 * @returns 合法的同意记录；无法解析时 null。
 */
export function parseConsent(raw: string | null): ConsentRecord | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Partial<ConsentRecord>
    if (typeof parsed.version !== 'number' || !Number.isInteger(parsed.version) || parsed.version <= 0) return null
    if (typeof parsed.acceptedAt !== 'string' || parsed.acceptedAt.length === 0) return null
    return { version: parsed.version, acceptedAt: parsed.acceptedAt }
  } catch {
    return null
  }
}

/**
 * 是否需要（重新）征得同意。
 * @param record - 已解析的记录，或 null。
 * @param currentVersion - 当前声明版本，默认本模块的 `PRIVACY_VERSION`。
 * @returns 需要同意时为 true。记录版本**低于**当前版本同样为 true（重新同意）。
 */
export function needsConsent(record: ConsentRecord | null, currentVersion: number = PRIVACY_VERSION): boolean {
  if (!record) return true
  return record.version < currentVersion
}

/** 取默认存储；不可用时返回一个不落盘的内存实现（同意状态退化为「仅本次会话有效」）。 */
function defaultKv(): ConsentKv {
  try {
    const ls = (globalThis as { localStorage?: ConsentKv }).localStorage
    if (ls && typeof ls.getItem === 'function') return ls
  } catch {
    /* 隐私模式/无 DOM 环境：退回内存实现 */
  }
  const memory = new Map<string, string>()
  return {
    getItem: (k) => (memory.has(k) ? (memory.get(k) as string) : null),
    setItem: (k, v) => { memory.set(k, v) },
    removeItem: (k) => { memory.delete(k) },
  }
}

/** 读取同意记录（读不到/解析失败 → null）。 */
export function loadConsentRecord(kv: ConsentKv = defaultKv()): ConsentRecord | null {
  try {
    return parseConsent(kv.getItem(PRIVACY_STORAGE_KEY))
  } catch {
    return null
  }
}

/**
 * 记录「已同意」并返回新记录。
 * @param now - 时间来源，默认 `new Date()`（测试注入固定时间）。
 * @param kv - 存储，默认 localStorage。
 * @returns 写入的记录（即使写入失败也返回，当前会话仍视为已同意）。
 */
export function acceptConsent(now: () => Date = () => new Date(), kv: ConsentKv = defaultKv()): ConsentRecord {
  const record: ConsentRecord = { version: PRIVACY_VERSION, acceptedAt: now().toISOString() }
  try {
    kv.setItem(PRIVACY_STORAGE_KEY, JSON.stringify(record))
  } catch {
    /* 持久化失败不阻塞当前会话 */
  }
  return record
}

/** 清除同意状态（主界面的「重新查看启动页」会让用户重新确认）。 */
export function resetConsent(kv: ConsentKv = defaultKv()): void {
  try {
    kv.removeItem(PRIVACY_STORAGE_KEY)
  } catch {
    /* ignore */
  }
}
