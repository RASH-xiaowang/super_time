/**
 * 「一次 AI 回复如何进入消息队列」的单一决策点。
 *
 * 私聊与群聊的队列语义本来就不同，但此前这两件事分散在 runner 与投递端各算一遍：
 *
 *  · **入队**（`runner-pipeline.ts`）：私聊把 `targetName` 写成对方，群聊写成
 *    提问者（投递端要拿它当提及对象）；
 *  · **@ 谁**（`provider.ts` / `message-list-dispatch.ts`）：只要判定是群聊，
 *    就把 `targetName` 当 mention 用。
 *
 * 两处各自判断 `@chatroom`，结果是同一条长回复被拆成 3 段时，3 段都继承
 * `targetName=提问者`，于是对同一个人 **@ 了 3 次** —— 群里看就是刷屏。
 *
 * 这里把两条规则收敛成纯函数，runner 与投递端都只调用它们：
 *
 *  · **私聊**：一条记录；发送目的与触发对象都是对方；**永不发 mention**。
 *  · **群聊**：一批记录（`segmentIndex` 1..N，共享 `segmentGroupRef`）；
 *    发送目的是群，触发对象是提问者；**只有批次首条 @ 他**，后续段落是群里
 *    自然的接话，不再重复点名。
 *
 * 为什么挂在「记录 + 段号」而不是给库加一列：批次信息本来就写在
 * `segment_index`/`segment_count` 上，投递时每条记录自带段号，判定不需要
 * 额外状态；旧记录（段号 0/缺省）自然落在「首条」分支，行为与改版前一致。
 *
 * @module query/ai-reply/queue-plan
 */
import type { MessageListRecord } from '../../types.ts';
/** 队列种类：只有这两种会进入 AI 回复的自动投递。 */
export type ChatReplyQueueKind = 'private' | 'group';
/** 判定所需的记录字段（`FeatherRecordShape` 与消息列表记录都可直接传入）。 */
export interface QueueRecordShape {
    chatName: string;
    targetName: string;
    source: string;
    chatUsername: string;
    /** 组内段号；0/缺省表示这条记录不属于分段批次（视为首条）。 */
    segmentIndex?: number;
}
/**
 * 会话属于哪种队列。只看 username 后缀：昵称/备注里出现「群」字不能当判据。
 * @param chatUsername - 会话 `WechatSession.username`。
 * @returns `group` 表示 `...@chatroom`，其余一律按单聊处理。
 */
export declare function chatReplyQueueKind(chatUsername: string): ChatReplyQueueKind;
/**
 * 判断一条消息列表记录是否代表群聊。
 *
 * 稳定依据是 `chatUsername=...@chatroom`。外部入站协议用 `target=群名 +
 * mention=成员` 时没有 username，只能在该 source 下按「会话名与触发对象不同」
 * 兜底。Feather 的发送目标名来自消息列表，不能把手工私聊的备注差异猜成群聊；
 * 因此没有 `@chatroom` 时只允许显式入站记录按历史协议兜底。
 * @param record - 待判定的消息列表记录（至少含这些字段）。
 * @returns 是否按群聊语义投递。
 */
export declare function isGroupMessageListRecord(record: QueueRecordShape): boolean;
/**
 * 这条记录应在群里 @ 谁。
 *
 * 三个「不发」条件，缺一不可：
 *  ① 不是群聊 —— 私聊没有 @ 语义；
 *  ② 触发对象为空或与会话同名 —— 那等于 @ 整个群，没有意义（也是群聊没解析到
 *     提问者时的回落形态）；
 *  ③ 段号 > 1 —— **同一批次的后续消息不再重复点名**。
 * @param record - 待投递的消息列表记录。
 * @returns 要 @ 的成员名；空串表示请求体里不带 `mention`。
 */
export declare function mentionOfRecord(record: QueueRecordShape): string;
/** 入队所需输入：一次自动回复的会话身份与提问者。 */
export interface ChatReplyQueueEntryInput {
    /** 会话 `WechatSession.username`（群聊以 `@chatroom` 结尾）。 */
    chatUsername: string;
    /** 会话展示名；空串时回落 username。 */
    chatName: string;
    /** 群聊里点了名的那位成员（展示名）；私聊忽略。 */
    mentionName?: string;
    /** 同上，wxid；私聊忽略。 */
    mentionUsername?: string;
}
/** 入队结果：直接对应 `message_list_records` 的四列会话身份。 */
export interface ChatReplyQueueEntry {
    chatName: string;
    chatUsername: string;
    targetName: string;
    targetUsername: string;
}
/**
 * 决定一次回复以什么身份进入消息队列。
 *
 *  · 私聊：`target` = 对方会话（与 `chatName` 同值），投递端不会发 mention；
 *  · 群聊：`target` = 提问者（`mention` 的来源），`chatName` 仍是群（发送目的地）；
 *    提问者缺失时回落群名，投递端据此判定「不 @」而不是 @ 整个群。
 * @param input - 会话身份与提问者。
 * @returns 两条规则共用的四列取值。
 */
export declare function queueEntryOf(input: ChatReplyQueueEntryInput): ChatReplyQueueEntry;
/** 便于测试与调用方复用的记录类型别名（避免各处重复 `Pick`）。 */
export type QueuePlanRecord = Pick<MessageListRecord, 'chatName' | 'targetName' | 'source' | 'chatUsername' | 'segmentIndex'>;
