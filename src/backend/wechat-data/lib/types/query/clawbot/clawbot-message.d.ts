/**
 * 微信 ClawBot 接入会话（`clawbot_message`）——写入与检索。
 *
 * ## 顺序的唯一事实是 `id`
 *
 * 事件推送只当幂等提示：前端收到 `clawbot/message` 后按 `lastId` 拉 `id > afterId` 的增量，
 * 用 `Set<id>` 去重、按 **`id`（不是 `ts`）** 合并 —— 同毫秒多条时 `ts` 排不出先后。
 * 因此 `id` 是 `AUTOINCREMENT` 且永不复用（见建表语句）。
 *
 * ## 检索的三条纪律（与 `operation-log.ts` 同源）
 *
 * 1. **关键词必须服务端过滤**：列表是分页取的，客户端过滤等于只搜当前页。
 * 2. **LIKE 必须转义** `%` `_` `\`，否则用户输入 `%` 等于全表。
 * 3. **读失败 ≠ 没有数据**：库打不开时返回 `readError`，而不是空列表；
 *    但**库不存在不算读失败**（还没接入过消息），返回空快照即可。
 *
 * @module query/clawbot/clawbot-message
 */
import type { ClawbotMessageQuery, ClawbotMessageSnapshot } from '../../types.ts';
/** 每页默认条数（与 `usePagedList` 一页一致）。 */
export declare const CLAWBOT_MESSAGE_DEFAULT_LIMIT = 100;
/**
 * 单次检索上限。
 *
 * 比 `operation-log` 的 5000 严：那条记的是元数据，这条记的是**正文**，同样的行数
 * 体积大一个量级（正文一句话就能上百字节）。2000 条已远超一屏，再多只是给 IPC 添堵。
 */
export declare const CLAWBOT_MESSAGE_MAX_LIMIT = 2000;
/** 单实例单会话最多保留多少条 clear 竞态墓碑，防止长期运行无界增长。 */
export declare const CLAWBOT_MESSAGE_TOMBSTONE_LIMIT = 10000;
/** 附件引用（**内部**：怎么取 + 展示元数据；`key` 与 `ref` 不进渲染层快照）。 */
export interface ClawbotMediaRef {
    /** 看 msgType 同源：image / voice / video / file。 */
    kind: 'image' | 'voice' | 'video' | 'file';
    /** 明文 URL，或 CDN 加密参数（看 `key` 是否为空）。 */
    ref: string;
    /** base64 的 AES key；空串 = `ref` 是明文 URL（无需解密）。 */
    key: string;
    /** 文件名（文件类；其余为 null）。 */
    name: string | null;
    /** 密文/明文体积提示（字节；未知为 null）。 */
    size: number | null;
    /** 时长（毫秒；**只有语音有**，协议 `voice_item.playtime`；其余为 null）。 */
    duration: number | null;
}
/** 一条待落库的消息（服务端收/发时构造；`createdAt` 缺省取当前时间）。 */
export interface ClawbotMessageInput {
    /** 实例编号（缺省 1 = 第一个实例，旧调用方零改动）。 */
    slot?: number;
    ts: number;
    direction: 'in' | 'out';
    msgType?: string | null;
    content: string;
    createdAt?: number;
    /**
     * 服务端消息 id（`message_id`），用于**去重**。
     *
     * 为什么必须去重：会话过期（errcode -14）时我们会清空同步游标重拉，
     * 服务端会把历史**重发**一遍 —— 没有它同一句话会在列表里出现两次。
     * 缺省/非正数 = 不去重（尽力而为：没有 id 的帧只能按新消息处理）。
     */
    msgId?: number | null;
    /**
     * 本地发送幂等键。
     *
     * 自动回复 outbox 在发送前就把它持久化；进程在「上游已接收、本地尚未记账」
     * 之间崩溃时，重试复用同一个键。发送路径据此在本地也只落一行，避免
     * 服务端幂等成功但本地会话里出现重复出站气泡。
     */
    clientId?: string | null;
    /** 附件引用（图片/语音/视频/文件）；纯文本为 null。 */
    media?: ClawbotMediaRef | null;
}
/** 批量落库时可选地在同一事务里创建自动回复 run。 */
export interface ClawbotMessageBatchOptions {
    /** 批次捕获时的会话代次；仅允许用于单 slot 批次。 */
    expectedSessionEpoch?: number;
    replyIntake?: {
        debounceMs?: number;
        maxPending?: number;
    };
}
/** 单条落库时的可选持久会话 fencing。 */
export interface ClawbotMessageInsertOptions {
    expectedSessionEpoch?: number;
}
/**
 * 写入一条接入会话消息。
 *
 * 带 `msgId` 且库里已有同一 id ⇒ **跳过**（返回 null），事件与 id 都不产生 ——
 * 去重判断与插入在同一条连接里，不存在检查后被并发插入的窗口（单写方）。
 * @param decryptedDir - 解密数据根。
 * @param input - 消息内容（正文原文；打码只在展示层做）。
 * @param options - 可选的会话代次快照；传入后在同一事务内校验后才允许写入。
 * @returns 新行的 `id`；被去重跳过时为 null。
 */
export declare function insertClawbotMessage(decryptedDir: string, input: ClawbotMessageInput, options?: ClawbotMessageInsertOptions): number | null;
/**
 * 按发送幂等键查本地消息行。
 *
 * durable outbox 重试先查这里：行已经存在说明上游上一次已成功且本地已回填，
 * 可以直接补记 outbox，不必再次请求上游。读取失败必须抛给调用方，不能把
 * 「查不到」与「库坏了」混为一谈后冒险重发。
 */
export declare function findClawbotMessageIdByClientId(decryptedDir: string, slot: number, clientId: string): number | null;
/**
 * 批量写入一帧里的多条消息：**一次开库、一次建表检查、一个事务**。
 *
 * 接收通道一帧常带多条历史消息。逐条调用 {@link insertClawbotMessage} 会为每条消息
 * 重新打开数据库并跑迁移检查，首绑回补历史时会把 I/O 放大到消息数倍。批量入口保持
 * 逐条去重的语义，同时让整帧要么全部落库、要么全部回滚（游标据此安全推进）。
 * @param decryptedDir - 解密数据根。
 * @param inputs - 同一帧内的消息（空数组不建库）。
 * @returns 与输入等长的行 id；被 `msgId` 去重跳过处为 null。
 */
export declare function insertClawbotMessagesBatch(decryptedDir: string, inputs: readonly ClawbotMessageInput[], options?: ClawbotMessageBatchOptions): Array<number | null>;
/**
 * 持久记住 clear 竞态下不能回放的旧消息 id。
 *
 * 只按当前会话代次生效：重新绑定或同 wxid 被别的实例接管会推进代次，
 * 下一次会话不受上一场 tombstone 影响。
 * @param decryptedDir - 解密数据根。
 * @param slot - 实例编号。
 * @param msgIds - 旧批次里的服务端消息 id。
 * @param nowOrOptions - 测试注入时间，或携带时间与预期会话代次的选项。
 * @returns 实际新增的 tombstone 条数。
 */
export interface SuppressClawbotMessageIdsOptions {
    now?: number;
    expectedSessionEpoch?: number;
}
export declare function suppressClawbotMessageIds(decryptedDir: string, slot: number, msgIds: readonly number[], nowOrOptions?: number | SuppressClawbotMessageIdsOptions): number;
/**
 * **内部**读一行（含媒体取数引用与密钥）—— 取媒体时用，不进渲染层快照。
 *
 * 打不开 / 行不存在都返回 null（调用方把 null 翻译成可读错误）；打不开时留一行 warn。
 * @param decryptedDir - 解密数据根。
 * @param id - 消息行 id。
 * @returns 内部行；库打不开或行不存在为 null。
 */
export declare function readClawbotMessageInternal(decryptedDir: string, id: number): ClawbotMessageInternal | null;
/**
 * 待取附件的行 id（有媒体引用、方向为入站；新 → 旧）。
 *
 * 「是否已缓存」**不在这里判** —— 那是文件系统的事（`clawbot-media.ts#findCached`）；
 * 队列对每一条调 `ensure`，命中即秒回（一次 stat）。启动补扫用它兜住
 * 「上次运行没来得及取完 / 当时网络不通」的缺口。
 * @param decryptedDir - 解密数据根。
 * @param limit - 单次补扫上限（防首次启动对空缓存全量狂扫）。
 * @returns 行 id 数组（新 → 旧）；库不存在或读不出来时为空数组（留 warn）。
 */
export declare function listClawbotMediaPending(decryptedDir: string, limit: number): number[];
/** 内部行（取媒体用；见 {@link readClawbotMessageInternal}）。 */
export interface ClawbotMessageInternal {
    id: number;
    direction: 'in' | 'out';
    msgType: string | null;
    content: string;
    media: ClawbotMediaRef | null;
}
/**
 * 检索接入会话。
 *
 * 两种模式：
 * - **浏览**（默认）：按 `id DESC`（最新在前）分页，`total` 为全量匹配数；
 * - **续传**（带 `afterId`）：只取 `id > afterId` 且按 `id ASC` 返回，
 *   供前端把实时增量按序并入列表（忽略 `offset`）。
 *
 * `maxId` 恒为表内最大值（**不受筛选影响**）——前端拿它当 `lastId`，
 * 才不会因为「当前筛选恰好没命中最新一条」而重复拉取。
 * @param decryptedDir - 解密数据根。
 * @param query - 时间区间 / 方向 / 关键词 / 续传 / 分页条件。
 * @returns 快照；库不存在返回空快照（无 `readError`），打不开才带 `readError`。
 */
export declare function listClawbotMessages(decryptedDir: string, query?: ClawbotMessageQuery): ClawbotMessageSnapshot;
/**
/**
 * 清空某实例的**接入会话**（2026-10-17 用户要求「增加对话历史清除按钮，可以删除对话历史
 * 以防止污染回复」）。
 *
 * 为什么需要它：接入会话是**累积**的（永久保留、无自动清理），而它同时是
 * 「对话读法」的展示内容与「自动回复」的上下文来源。用户换话题、或 bot 之前回错了一堆，
 * 旧消息会一直留在那里 —— 清空是唯一的「重新开始」手段。
 *
 * ⚠️ **只删消息，不动绑定与配置**：绑定（`clawbot_binding`）与行为偏好
 * （`clawbot_instance_config`）是另一回事，清历史不该把它们一起清掉。
 * ⚠️ **不可恢复**：调用方必须在确认框里说清条数（与「移除实例」同一纪律）。
 * @param decryptedDir - 解密数据根。
 * @param slot - 实例编号。
 * @returns 删掉的条数（供界面如实回报）。
 */
export declare function clearClawbotMessages(decryptedDir: string, slot?: number): {
    removed: number;
};
/**
 * 计数（设置卡片的「今日消息 / 累计消息」）—— 一条连接里同时取三个数。
 *
 * 读失败时返回全 0 并留一行 warn：这张卡片是状态展示，库级失败已由绑定行的
 * `readError` 覆盖（同一个库，两者几乎必然同时失败），不在这里再造一个错误通道。
 * @param decryptedDir - 解密数据根。
 * @param opts.since - 「今日」的起点（本地时区当天 0 点的时间戳）。
 * @returns `{ today, total, lastTs }`（`lastTs` = 最后一条消息的接收时间，0 = 还没有消息）。
 */
export declare function clawbotMessageCounts(decryptedDir: string, opts: {
    since: number;
    slot?: number;
}): {
    today: number;
    total: number;
    lastTs: number;
};
