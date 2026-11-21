import type { RetryFetch } from '../net/fetch-retry.ts';
/** 推送地址长度上限（够长，但别让一条脏数据把任务表撑爆）。 */
export declare const SUMMARY_WEBHOOK_URL_MAX = 2000;
/** 推送对象（微信里的会话名）长度上限，与消息列表的 `target` 同口径。 */
export declare const SUMMARY_WEBHOOK_TARGET_MAX = 200;
/**
 * 总结正文**不限长**（2026-11-18）。
 *
 * 此前这里有一个 2 万字的截断，理由写的是「防模型抽风把请求体撑爆」。但它的实际后果是
 * **静默吃掉一段内容** —— 而总结本来就要「该说的都说完」，截断往往正好砍在结论上。
 * 现在整段照发；真发不出去（对端拒收超长请求体）会以非 2xx 回来并如实报错，
 * 那是可见的失败，不是悄悄少一段。
 */
/** 推送依赖（测试注入 fetch）。 */
export interface SummaryWebhookDeps {
    fetchImpl?: RetryFetch;
}
/** 一次推送的结果。`skipped` 表示任务没配地址、本来就不该发。 */
export interface SummaryWebhookPushResult {
    ok: boolean;
    /** 脱敏后的地址（`/webhook/***`），可以直接给界面看。 */
    endpoint: string;
    /** 任务没配地址时为 true（此时 ok 也为 true：什么都不做就是成功）。 */
    skipped?: boolean;
    status?: number;
    error?: string;
}
/** 规范化结果。 */
export interface SummaryWebhookUrlCheck {
    ok: boolean;
    /** `kind:'set'` 时的规范化地址；其它情况为空串。 */
    url: string;
    /**
     * 保存时怎么处理这一列：
     *   · `set` —— 写入 `url`
     *   · `clear` —— 显式关掉推送（写空串）
     *   · `keep` —— 不动已保存的值（SQL 里落 NULL）
     */
    kind: 'set' | 'clear' | 'keep';
    error?: string;
}
/**
 * 校验并规范化用户填写的推送地址。
 *
 * 三条输入形态各有含义，别合并：
 *   · 空串 → `clear`（用户清空输入框 = 关掉推送）；
 *   · 脱敏占位 `http://host:port/webhook/***` → `keep`。界面上「已配置」只回显脱敏地址
 *     （token 就是凭据，不该出现在 DOM/截图里），用户没改它就直接保存时必须**保持原值**，
 *     否则 `***` 会被当成真 token 存进去，把原地址覆盖掉 —— 之后推送静默失效。
 *   · 正常地址 → `set`（http/https、无内嵌凭据、路径必须是 `/webhook/<token>`）。
 * @param raw - 界面上填的原始文本。
 * @returns ok + 处理方式；不合法时 `error` 说明原因。
 */
export declare function normalizeSummaryWebhookUrl(raw: unknown): SummaryWebhookUrlCheck;
/**
 * 把一段总结推送到已保存的 Webhook。
 *
 * 不抛错：所有失败都折进返回值 —— 调用方是「总结已经生成」的那条路径，
 * 不能让一次推送异常把成功结果吞掉。
 * @param input - 推送地址 / 目标会话名 / 正文。
 * @param deps - 可选注入 fetch（测试）。
 * @returns 推送结果（含脱敏地址与失败原因）。
 */
export declare function pushSummaryToWebhook(input: {
    webhookUrl: string;
    target: string;
    message: string;
}, deps?: SummaryWebhookDeps): Promise<SummaryWebhookPushResult>;
