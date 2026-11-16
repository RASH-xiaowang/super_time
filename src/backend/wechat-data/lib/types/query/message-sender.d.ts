/**
 * 单聊接收方向消息的发送者字段。
 *
 * 为什么单聊也要写 `sender`（看起来「会话本身就是对方」）：
 *  · 前端首屏会先画渲染缓存，缓存必须能**自证属于哪个会话**。群聊行本来就有发送者，
 *    单聊行此前一个发送者都没有，于是 `msg-scope.ts` 的归属校验对单聊缓存等于空转 ——
 *    缓存被写成别人的会话也识别不出来（2026-09 报障的原形状）。
 *  · 显示层（消息信息、引用上下文、任务图片、素材收集）也需要知道「这条是谁说的」，
 *    此前只能一律写「对方」。
 *
 * 显示名只认联系人表里的真名；查不到就退回「对方」。不能把 wxid 或「未知联系人」
 * 塞进 `senderName` —— 导出、任务图片、引用上下文都直接显示它。
 *
 * @module message-sender
 */
import type { WechatMessage } from '../types.ts';
/**
 * 给单聊「收到方向」的消息补上发送者身份与企业名。
 * @param msg - 正在构造的消息（原地写入 `sender` / `senderName` / `senderEnterpriseName`）。
 * @param talker - 会话 `WechatSession.username`（单聊里对端就是它）。
 * @param contactNames - contact.db 解析出的 username → 显示名。
 * @param enterpriseNames - 企业微信联系人 → 企业名。
 */
export declare function fillDirectChatSender(msg: WechatMessage, talker: string, contactNames: ReadonlyMap<string, string>, enterpriseNames: ReadonlyMap<string, string>): void;
