import type { DatabaseSync } from './db-open.ts';
import type { MessageListMutationResult, MessageListRule, MessageListRuleInput, MessageListRuleSnapshot } from '../types.ts';
/** AI 回复默认规则的账号作用域；普通规则不传，仍保持全局人工规则语义。 */
export interface MessageListRuleScope {
    accountKey?: string;
    chatUsername?: string;
}
/** 规则匹配：精确对 > 同会话通配对象 > 任意会话指定对象 > 全局通配。 */
export declare function matchMessageListRuleAt(db: DatabaseSync, chatName: string, targetName: string, scope?: MessageListRuleScope): MessageListRule | undefined;
/** 按当前规则表匹配一条规则；库不存在/读失败时返回 undefined。 */
export declare function matchMessageListRule(decryptedDir: string, chatName: string, targetName: string, scope?: MessageListRuleScope): MessageListRule | undefined;
/** 规则列表（最新更新在前）。 */
export declare function listMessageListRules(decryptedDir: string): MessageListRuleSnapshot;
/** 删除一条规则；已有记录的地址快照不受影响。 */
export declare function deleteMessageListRule(decryptedDir: string, id: number): MessageListMutationResult;
/**
 * 新建 / 更新规则，并为尚无地址快照的同类 pending 记录补上地址。
 * @param decryptedDir - 解密数据根。
 * @param input - 规则入参；`id` 缺省 = 新建。
 */
export declare function saveMessageListRule(decryptedDir: string, input: MessageListRuleInput): MessageListMutationResult;
export interface EnsureExactMessageListRuleInput {
    webhookUrl: string;
    chatName: string;
    targetName: string;
    /** 默认 AI 规则的作用域；人工规则不传，继续作为全局规则参与匹配。 */
    accountKey?: string;
    chatUsername?: string;
    /** 可选：仅回填该前缀的 AI 记录，避免同名会话跨账号串写。 */
    sourceRefPrefix?: string;
    greetingText?: string;
    note?: string;
    enabled?: boolean;
}
export type EnsureExactMessageListRuleResult = {
    ok: true;
    id: number;
    created: boolean;
    backfilled: number;
} | {
    ok: false;
    error: string;
};
/**
 * 仅当精确的「会话名 + 触发对象」规则不存在时创建，绝不覆盖人工规则。
 *
 * 默认 Webhook 自动绑定和 AI 回复开关共用此入口。人工精确规则优先且永不更新；
 * 账号作用域内由系统创建的同名规则会跟随默认地址更新。回填只处理已有正文或
 * 附件、且尚无地址快照的 AI pending 记录，状态始终保持 pending。
 */
export declare function ensureExactMessageListRule(decryptedDir: string, input: EnsureExactMessageListRuleInput): EnsureExactMessageListRuleResult;
/** 按 id 读取规则（桌面端探测已保存地址用）。 */
export declare function getMessageListRule(decryptedDir: string, id: number): MessageListRule | undefined;
