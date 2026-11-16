/**
 * 「会话运行窗口」的只读快照。
 *
 * 为什么不在 `config-store.ts` 里：那个文件已经贴着 M21 的千行上限，而这里的
 * 逻辑只服务于「删除前确认这一组没有在途生成」，不需要跟着配置读写一起长大。
 *
 * 为什么要接收调用方的连接：专用清理在 `BEGIN IMMEDIATE` 事务里判断运行状态。
 * 若改用 `readChatAiReplyStateStrict`，它会在同一进程另开一条连接并跑 schema
 * 迁移，与事务里的写锁抢 SQLITE_BUSY。这里复用同一个连接，只读三列，不写状态。
 * 读失败必须 fail-closed：宁可拒绝清理，也不能把正在生成的预约删掉。
 */
import type { DatabaseSync } from '../db-open.ts';
import type { ChatAiReplyStage } from './types.ts';
/** 运行窗口三字段；清理面板只关心「这一组是否正被某个未完成的运行占用」。 */
export interface ChatAiReplyRunWindow {
    stage: ChatAiReplyStage;
    pendingSourceRef: string;
    recordId?: number;
}
/**
 * 在调用方**已经持有的连接**上读取运行窗口。
 *
 * 调用方必须先在该连接上跑过 `ensureChatAiReplySchema`（清理事务里只跑一次），
 * 这里不再重复 DDL 探测，避免在写锁事务里反复查 `PRAGMA table_info`。
 * @param db - 调用方持有、已开启事务的连接。
 * @param decryptedDir - 解密目录（用于规范化单聊身份）。
 * @param accountKey - 账号。
 * @param chatUsername - 会话用户名（sourceRef 里记录的原值）。
 * @returns 运行窗口；读失败时返回错误而不是默认值。
 */
export declare function readChatAiReplyRunWindowOnDb(db: DatabaseSync, decryptedDir: string, accountKey: string, chatUsername: string): {
    ok: true;
    window: ChatAiReplyRunWindow;
} | {
    ok: false;
    error: string;
};
