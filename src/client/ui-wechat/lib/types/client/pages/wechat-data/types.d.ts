/**
 * WeChat data types — re-exported from the host WechatDataGateway package so
 * the browser panels and the Remote client share one vocabulary.
 */
export type { WechatSession, WechatMessage, WechatContact, ContactBook, SessionsSnapshot, MessagesSnapshot, ContactsSnapshot, } from '@deepseek-ai/dsh-wechat-data/types';
/** Monitor status (kept local; not yet in the host vocabulary). */
export interface MonitorStatus {
    running: boolean;
    status: string;
    [key: string]: unknown;
}
//# sourceMappingURL=types.d.ts.map