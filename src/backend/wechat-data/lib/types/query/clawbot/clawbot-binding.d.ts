import type { ClawbotBinding } from '../../types.ts';
/** 默认（从未绑定）的绑定行；时间戳用 0 表示「没有发生过」。 */
export declare function defaultBinding(slot?: number): ClawbotBinding;
/** 拆成两半：绑定行 + （可选）读失败原因。 */
export interface BindingRead {
    binding: ClawbotBinding;
    readError?: string;
}
/**
 * 读当前绑定行。
 *
 * 库不存在 ⇒ 默认未绑定（**不带 readError**：还没绑定过不是错误）；
 * 库存在但打不开 ⇒ 默认未绑定 + `readError`（界面要显示「读取失败」而不是「未绑定」）。
 */
export declare function readBinding(decryptedDir: string, slot?: number): BindingRead;
/**
 * 读**全部** slot 的绑定行（实例列表用；按 slot 升序）。
 *
 * 与 {@link readBinding} 同一套读失败语义：库不存在 ⇒ 空列表且无 readError；
 * 打不开 ⇒ 空列表 + readError（界面必须把「读不到」与「一个实例都没有」分开说）。
 * @param decryptedDir - 解密数据根。
 * @returns 绑定行数组（含 readError）。
 */
export declare function readBindings(decryptedDir: string): {
    bindings: ClawbotBinding[];
    readError?: string;
};
/**
 * 申请二维码：把绑定行推进到 `binding` 态并记下凭证与过期时间。
 *
 * 只负责**本机状态**；向腾讯服务取码是 iLink 通道的事（见 `clawbot-ilink.ts`），
 * 两者分开是为了让数据层能独立被测试、也为了出网失败时本机状态机照常工作
 * （取码抛错 = 一个字节都没发出去，绑定行不会被推进）。
 * @param decryptedDir - 解密数据根（`clawbot.db` 的父目录定位基准）。
 * @param qr - 一次性凭证与过期时间戳。
 * @returns 落库后的绑定行。
 */
export declare function markBindingQr(decryptedDir: string, qr: {
    token: string;
    expiresAt: number;
}, slot?: number): ClawbotBinding;
/**
 * 扫码确认后回写身份与**会话凭证**，进入 `bound`。
 *
 * 同时把**别的** `bound` 行收敛成 `unbound-by-user` —— 一对一约束不靠调用方自觉：
 * 手工编辑出两行 `bound` 时，这里保证「已绑定」永远只有一行。
 *
 * 凭证列（`bot_token` / `ilink_bot_id` / `ilink_user_id` / `base_url`）只走
 * {@link readBindingInternal} 读回给 worker 内部，**永远不进渲染层**；
 * 同步游标一并清零（新会话的游标从零开始）。
 * @param decryptedDir - 解密数据根。
 * @param identity - 微信身份（wxid / 昵称 / 头像，后两者可为空）。
 * @param credentials - iLink 会话凭证；缺省/null = 清空（测试里可造「只有绑定没有凭证」的态）。
 * @returns 落库后的绑定行。
 */
export declare function completeBinding(decryptedDir: string, identity: {
    wxid: string;
    userName?: string | null;
    avatar?: string | null;
}, credentials?: BindingCredentials | null, slot?: number): ClawbotBinding;
/**
 * 解绑：`bound` → `unbound-by-user`。
 *
 * **不动 `clawbot_message`**（D-4：接入会话保留，解绑只是断开通道）。
 * `wxid` / `user_name` / `avatar` 保留为「上次绑定」的痕迹（界面显示用），
 * 重新绑定时被 `completeBinding` 覆盖；**会话凭证与同步游标立刻清空** ——
 * 清空是「解绑即停轮询」的存储侧保证：即使进程内循环漏了停止位，凭证也没了。
 * @param decryptedDir - 解密数据根。
 * @returns 落库后的绑定行。
 */
export declare function unbindBinding(decryptedDir: string, slot?: number): ClawbotBinding;
/**
 * 给实例起别名（`label`；2026-10-16）。
 *
 * 与 `completeBinding` / `unbindBinding` **刻意分开**：那两条是绑定状态机的一部分
 * （会清凭证、改 status），而别名是纯用户偏好 —— 它必须活过重新绑定，也不该因为
 * 解绑而消失。所以这里只动 `label` 与 `updated_at` 两列。
 *
 * 归一：首尾空白去掉；空串 / 全空白 ⇒ 存 `NULL`（=「没起别名」，界面回落到昵称）。
 * 长度上限 40 字符（超出截断而不是抛错 —— 别名是展示用的，截断比拒绝更友好）。
 * @param decryptedDir - 解密数据根。
 * @param slot - 实例编号。
 * @param label - 新别名（空串 = 清除别名）。
 * @returns 落库后的绑定行。
 * @throws 实例不存在时抛可读中文（调用方按 message 展示）。
 */
export declare function renameBinding(decryptedDir: string, slot: number, label: string): ClawbotBinding;
/** 会话凭证（iLink 绑定确认后由服务端下发；只进 worker 内部）。 */
export interface BindingCredentials {
    botToken: string;
    ilinkBotId: string;
    ilinkUserId: string;
    baseUrl: string;
}
/** 拆成五份：绑定行（公开）+ 凭证 + 同步游标 + 发送令牌 +（可选）读失败原因。 */
export interface BindingInternalRead {
    binding: ClawbotBinding;
    /** 身份三项**齐备**才是凭证，缺一个就归 null（半截凭证发不出合法请求）。 */
    credentials: BindingCredentials | null;
    /** 同步游标（空串 = 从头/没有）。 */
    syncBuf: string;
    /** 最近一条入站消息带来的会话令牌（空串 = 还没收到过消息，**发不了**）。 */
    sendContextToken: string;
    readError?: string;
}
/**
 * 读当前绑定行 + 内部字段（凭证 / 游标 / 发送令牌）。
 *
 * 与 {@link readBinding} 同一套读失败语义（库不存在 = 默认值无 readError；打不开 = readError），
 * 区别只在多带三列 —— 给 worker 内的通道装配与发送路径用，**不要**把它接进渲染层的快照。
 * @param decryptedDir - 解密数据根。
 * @returns 内部读结果。
 */
export declare function readBindingInternal(decryptedDir: string, slot?: number): BindingInternalRead;
/**
 * 保存同步游标（消息长轮询的进度）。
 *
 * **不动 `updated_at`**：游标是会话运行态（约半分钟一次），不是绑定关系的变更 ——
 * 让它冲刷 `updated_at` 会把「最近一次绑定状态迁移」的时间搅浑。
 * @param decryptedDir - 解密数据根。
 * @param buf - 服务端下发的游标。
 */
export declare function saveSyncBuf(decryptedDir: string, buf: string, slot?: number): void;
/**
 * 保存发送用的会话令牌（最近一条入站消息带来）。
 *
 * 空串**直接跳过**：调用方（通道）对不带令牌的帧没得存，写空会把上一枚好令牌冲掉。
 * 与 {@link saveSyncBuf} 同款：不动 `updated_at`。
 * @param decryptedDir - 解密数据根。
 * @param token - 非空令牌。
 */
export declare function saveSendContextToken(decryptedDir: string, token: string, slot?: number): void;
/**
 * 读**全部** slot 的 iLink 机器人 id（`ilink_bot_id`；2026-10-17 补全实例信息）。
 *
 * 为什么单独开一个函数而不是并进 {@link readBindings}：`ilink_bot_id` 住在**凭证列组**里，
 * 而 `SELECT_COLUMNS` 是「公开列」白名单 —— 把凭证列并进去等于把 `bot_token` 也一起
 * 带进渲染层快照（那正是本仓反复强调不许发生的事）。这里只挑**一个非敏感列**出来，
 * 让实例卡能显示「这个实例挂在哪个 bot 上」。
 *
 * `ilink_bot_id` 是**公开标识**（bot 的编号），不是密钥：真正的密钥是 `bot_token`，
 * 它仍然只走 {@link readBindingInternal}。未绑定 / 老库无此列 ⇒ 该 slot 不出现在结果里。
 * @param decryptedDir - 解密数据根。
 * @returns `slot → botId` 映射（读失败返回空映射，不抛 —— 它是展示增强，不该拖垮实例列表）。
 */
export declare function readBotIds(decryptedDir: string): Record<number, string>;
