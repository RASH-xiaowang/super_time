/**
 * “大肥鱼”插件适配层。
 *
 * 当前支持两种已确认的发送协议：
 *  · `/send/text`：`{talker,text}`；
 *  · `/webhook/<token>`：`{target,message,mention?,attachments?}`。
 *
 * 两者都只在消息列表记录落库后由 dispatch 调用。未知路径继续走通用消息列表
 * JSON，不猜测字段或鉴权语义。
 *
 * 适配器只接收已经由消息列表隐私闸处理后的正文，不读取原始聊天记录，
 * 也不自行出网。真正 POST 由消息列表 dispatch 完成。
 */
import type { MessageListRecord } from '../../types.ts';
/** 大肥鱼 `/webhook/<token>` 发送端点；资源上传子路径不算发送端点。 */
export declare function isFeatherWebhookEndpoint(url: string): boolean;
/** 大肥鱼附件上传子路径；它不是发送消息的 Webhook。 */
export declare function isFeatherResourceEndpoint(url: string): boolean;
/** 发送端按 UTF-16 code unit 计数；超限时给出可执行的拆分/缩短提示。 */
export declare function featherTextCapacityError(value: string, label: string, kind: 'name' | 'message'): string | undefined;
export interface FeatherCapacityInput {
    target: string;
    message?: string;
    mention?: string;
    /** 最终要交给 `fetch` 的 JSON 对象；传入时按它的真实序列化结果检查。 */
    request?: unknown;
}
/** 发送请求的四项硬约束：target、mention、message 与整个 JSON body。 */
export declare function featherRequestCapacityError(input: FeatherCapacityInput): string | undefined;
type FeatherRecordShape = Pick<MessageListRecord, 'chatName' | 'targetName' | 'text' | 'source' | 'chatUsername'>;
/**
 * 记录落库/补全前的容量闸门。只有命中大肥鱼发送端点时才套用字段上限；
 * 通用 Webhook 仍保留自己的协议空间。
 */
export declare function featherRecordCapacityError(record: FeatherRecordShape, webhookUrl: string): string | undefined;
/**
 * 判断一条消息列表记录是否代表群聊。
 *
 * 实现已移到 `queue-plan.ts`：入队与投递必须用同一个判据，否则
 * 「写入时按群聊记提问者、投递时按私聊当目的地」这类错位会静默发生。
 */
export { isGroupMessageListRecord } from './queue-plan.ts';
/**
 * 将消息列表记录转成桥接发送请求。该函数不直接出网，便于单测检查
 * “只有消息列表记录能成为发送正文”的约束。
 */
export declare function dshBridgeRequestOf(record: MessageListRecord): {
    ok: boolean;
    error?: string;
    request?: {
        talker: string;
        text: string;
    };
};
/**
 * 将已落库的 AI 回复转成 `/webhook/<token>` 发送请求。
 *
 * `target` 使用联系人显示名（与接口示例一致），`message` 使用已过隐私闸的正文。
 * token 只存在于用户配置的 URL 中，本适配器不会读取、复制或记录它。
 */
export declare function featherRequestOf(record: MessageListRecord, gatedText?: string, attachments?: string[], resourceIds?: string[]): {
    ok: boolean;
    error?: string;
    request?: {
        target: string;
        message?: string;
        mention?: string;
        attachments?: string;
        resource_ids?: string[];
        type?: 'attachments';
    };
};
