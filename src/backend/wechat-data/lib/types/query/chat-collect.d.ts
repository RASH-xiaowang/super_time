import type { ChatCollectTaskResult, ChatCollectTaskSnapshot } from '../types.ts';
/** 一次收集任务创建时的外部参数（网关层只负责补密钥与自身 wxid）。 */
export interface ChatCollectOptions {
    username: string;
    displayName?: string;
    /** 保留文本条数（1..200，默认 20）。 */
    textLimit?: number;
    /** 保留图片张数（0..24，默认 6）。 */
    imageLimit?: number;
    /** 登录账号 wxid（用于把 isSender 标成「我」）。 */
    selfUsername?: string;
    /** 微信账号根目录（解密图片用），空 = 只读已解码缓存。 */
    wechatBaseDir?: string;
    aesKey?: string;
    xorKey?: number;
}
/**
 * 读取收集任务列表（最新在前）。
 * @param decryptedDir - 解密数据根。
 * @returns 任务快照；读库失败时带 `readError`（与「确实没有任务」区分）。
 */
export declare function listChatCollectTasks(decryptedDir: string): ChatCollectTaskSnapshot;
/**
 * 收集某个会话最近的文本与图片，创建任务并落盘。
 * @param decryptedDir - 解密数据根（库路径 = 它的父目录）。
 * @param decodedDir - 图片解码缓存根。
 * @param options - 会话 / 数量 / 图片密钥。
 * @returns 创建结果（失败带 error，不抛异常）。
 */
export declare function createChatCollectTask(decryptedDir: string, decodedDir: string, options: ChatCollectOptions): Promise<ChatCollectTaskResult>;
