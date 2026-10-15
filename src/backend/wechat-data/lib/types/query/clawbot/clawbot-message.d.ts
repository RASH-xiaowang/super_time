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
    /** 附件引用（图片/语音/视频/文件）；纯文本为 null。 */
    media?: ClawbotMediaRef | null;
}
/**
 * 写入一条接入会话消息。
 *
 * 带 `msgId` 且库里已有同一 id ⇒ **跳过**（返回 null），事件与 id 都不产生 ——
 * 去重判断与插入在同一条连接里，不存在检查后被并发插入的窗口（单写方）。
 * @param decryptedDir - 解密数据根。
 * @param input - 消息内容（正文原文；打码只在展示层做）。
 * @returns 新行的 `id`；被去重跳过时为 null。
 */
export declare function insertClawbotMessage(decryptedDir: string, input: ClawbotMessageInput): number | null;
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
 * 计数（设置卡片的「今日消息 / 累计消息」）—— 一条连接里同时取两个数。
 *
 * 读失败时返回全 0 并留一行 warn：这张卡片是状态展示，库级失败已由绑定行的
 * `readError` 覆盖（同一个库，两者几乎必然同时失败），不在这里再造一个错误通道。
 * @param decryptedDir - 解密数据根。
 * @param opts.since - 「今日」的起点（本地时区当天 0 点的时间戳）。
 * @returns `{ today, total }`。
 */
export declare function clawbotMessageCounts(decryptedDir: string, opts: {
    since: number;
    slot?: number;
}): {
    today: number;
    total: number;
};
