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
 *
 * v3 → v4（2026-10-08）：**朋友圈高清原图会主动出网并落盘**。进入朋友圈面板时，若本机
 * 没有原图就去微信 CDN 取 `/0` 那一份（此前只在用户点到某张图时才会取），并把取回的原图
 * 存进 `decoded_images/sns-media/`（上限 2 GB，密钥变更时随该目录一起清空）。
 * 新增了「进入面板即自动出网」这个时机与一个新落盘位置，属材料性变更。
 *
 * v5 → v6（2026-10-10）：**新增 ClawBot 对话记录的本地留存**。ClawBot 集群管理界面把终端
 * 用户与本机 ClawBot 实例之间的**每条消息正文原文**写进 `<数据根>\clawbot.db`，**永久保留**
 * （无自动清理）。这扩展了本机落盘的数据范围 —— 此前 `wechat_privacy.db` 只存操作元数据、
 * 明确不保存会话内容；现在多了一份**含正文**的本地库。数据**不出网**（本机写入、本机查看），
 * 但采集与留存范围扩大，属材料性变更，故升版要求重新同意（见 `docs/PRIVACY.md` 第三节）。
 *
 * v7 → v8（2026-10-12）：**ClawBot 绑定通道（iLink）正式接入** —— 该集成首次出网：
 * 扫码绑定向腾讯服务申请二维码、绑定后常驻消息长轮询接收你在微信里发的消息
 * （请求只带会话凭证与同步游标，不含聊天内容）。新增出网点 + 会话凭证
 * 随绑定行落盘（`<数据根>\clawbot.db`），属材料性变更，故升版要求重新同意
 * （见 `docs/PRIVACY.md` 第四节 G2）。
 *
 * v8 → v9（2026-10-12）：**ClawBot 由「只收不发」改为「可发可收」** —— 你在「接入会话」
 * 发送框里写的**正文原文**会经腾讯 iLink 服务送达你的微信（逐条主动触发；没有自动回复、
 * 没有定时发送，也不经任何 AI 模型）。这是该链路首次**由本机向外发送内容**，属材料性变更，
 * 故升版要求重新同意（见 `docs/PRIVACY.md` 第三节 + 第四节 G2）。
 *
 * v9 → v10（2026-10-12）：**ClawBot 附件可按需查看** —— 点开会话里的图片/语音/视频/文件时，
 * 才从腾讯 CDN 取回那份加密媒体并在本机解密、落 `<数据根>\clawbot-media\` 缓存
 * （v11 起改为自动取回）。新增一条出网路径与一个落盘位置，属材料性变更，
 * 故升版要求重新同意（见 `docs/PRIVACY.md` 第四节 G2）。
 *
 * v10 → v11（2026-10-12）：**ClawBot 附件改为自动取回** —— 收到带附件的消息后，本机
 * 自动从腾讯 CDN 取回、解密并落 `<数据根>\clawbot-media\`（无人值守、只下载不上传、
 * 单份上限 32MB；失败在下一次同步 / 启动补扫重试）—— 目的是让**聊天记录连同附件
 * 一起持久化**。出网时机由「你点开」变成「收到即取」，属材料性变更，故升版要求重新同意
 * （见 `docs/PRIVACY.md` 第三节 + 第四节 G2）。
 *
 * v11 → v12（2026-10-13）：**ClawBot 多实例 + AI 自动回复** —— 打开某实例的「AI 自动回复」
 * （默认关闭）后，收到的消息正文会作为问题走问答管道并回发。这是本声明首次允许
 * **无需点击**的模型调用，属材料性变更（见 `docs/PRIVACY.md` 第四节 G2）。
 *
 * v12 → v13（2026-10-14）：**新增入站监听面 —— 局域网远程访问（手机端）**。此前本应用
 * **从不监听任何端口**；现在用户可以主动打开「设置 → 远程访问（手机）」，让本机在局域网
 * IPv4 上起一个 HTTP 服务（默认端口 5032），用手机浏览器访问同一套界面。**默认关闭**；
 * 打开后同一局域网内的设备持**令牌**即可读到微信数据，且只开放一份**方法白名单**
 * （模型 API Key / 许可证 / 诊断 / 更新 / 备份 / 配置写入 / 原生能力一律不开放）。
 * 链路是**明文 HTTP、无 TLS** —— 敌意网络里令牌与数据可被同网段嗅探。
 * 这是本声明首次包含入站监听（方向与出网点相反，但决定「别的设备能不能读到我的数据」），
 * 属材料性变更，故升版要求重新同意（见 `docs/PRIVACY.md` 第四节 H + 第五节）。
 *
 * v13 → v14（2026-10-15）：**远程访问登录改为一次性配对码**。v13 把长期 `api_token`
 * 放进二维码与地址栏；本版起，二维码/地址栏只携带 5 分钟、最多 5 次试错、成功一次
 * 即作废的配对码。长期 `api_token` 仍留在 `secrets.json`，只作为「远程访问确实启用过」
 * 的硬条件，不再进入 QR、URL 或 UI。这是同一入站面的**访问控制机制**变化，
 * 属材料性变更，故升版要求重新同意（见 `docs/PRIVACY.md` 第四节 H）。
 *
 * v17 → v18（2026-10-18）：**新增可选的「微信原图自动下载」实验功能**。此前「不注入、
 * 不挂钩微信进程」是本声明的硬承诺；本版起有一个**默认关闭**的例外：用户在
 * 「设置 → 图片解码」显式打开后，应用会把上游 WeFlow-X（MIT）的 `img_helper.dll` 注入
 * 正在运行的微信，让微信在接收**新**图片时自己下载原图；关闭/退出时请求还原，崩溃后
 * 微信可能保持被修改状态直到重启（界面会如实提示）。本应用自己不发请求、不碰凭据；
 * 只影响打开之后收到的图片。属材料性变更，故升版要求重新同意
 * （见 `docs/PRIVACY.md` §一.5 与 `src/backend/wechat-data/native/img_helper/PROVENANCE.md`）。
 * v20 → v21（2026-10-19）：**新增「任务信息 / 任务触发回调」**。用户可以显式创建任务：
 * 选一个会话（单聊，或群聊 + 群内某成员）、填一组触发关键词、可选「触发时携带该对象最近
 * N 张图片」（0–9 张）与一个**回调地址**。任务标记「已完善」后，后台在每次新消息同步落地时
 * 立即扫描（通常 1–2 秒内；另有每 10 秒兜底；不需要打开面板）：命中关键词就生成一条触发记录
 * （触发时间 / 会话 / 触发对象 / 关键词 /
 * 触发文本 / 该对象最近的照片），并把这**整条记录** POST 到用户填的地址。这是新增的
 * **内容出网点**（审计功能名 `task_callback`）：发的是这条记录的文本与按需解码的图片，
 * 地址由用户逐条填写、只允许 http/https；任务未完善时不扫描也不投递。
 * 属材料性变更，故升版要求重新同意（见 `docs/PRIVACY.md` 第四节 G3）。
 * v21 → v22（2026-10-19）：**恢复「局域网访问（手机）」扫码入口**。用户可在
 * 设置 → 维护与自检显式启用：本机在局域网 IPv4 上监听（默认 5032），生成一次性配对码与
 * 二维码；手机扫码换会话后与桌面端**同权限**（fullAccess，用户明确要求）：可读写配置、
 * 模型 Key、许可证、诊断、备份与原生文件能力都在范围内。默认关闭；关闭、退出或轮换即停服/作废会话。
 * 链路上仍是**明文 HTTP、无 TLS**。这是入站面的**访问入口恢复**，属材料性变更，
 * 故升版要求重新同意（见 `docs/PRIVACY.md` 第四节 H）。
 *
 * v22 → v23（2026-10-21）：**任务信息新增第二种触发方式「八爪鱼 RPA」**。任务仍由微信群消息
 * 命中关键词触发，投递目的地从「只支持你填的 Webhook」扩展为二选一：`webhook`（原有：把整条
 * 触发记录 JSON POST 到你填的地址）或 `bazhuayu`（新增：POST 到**固定主机**
 * `https://api-rpa.bazhuayu.com/api/bots/scheduling/start`，参数只有 room_name=会话名 /
 * content=触发文本 / at_name=触发对象，**不发图片**；你为该任务配置的 FlowId 与 API Key 一并
 * 参与，Key 作为 `X-Api-Key` 请求头发送）。API Key 只存本机
 * `<数据根>\wechat_task_center.db`、**不进任务列表返回值**（界面只知道「已保存」）。
 * 默认触发方式仍是 `webhook`，既有任务行为不变。这是新增的**内容出网点**，
 * 属材料性变更，故升版要求重新同意（见 `docs/PRIVACY.md` 第四节 G3）。
 */
export const PRIVACY_VERSION = 23

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
