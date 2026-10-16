import type { ClawbotMessageInput } from './clawbot-message.ts';
/** iLink 服务主机（唯一出网目的地；换主机 = 改隐私声明与出网台账）。 */
export declare const ILINK_BASE_URL = "https://ilinkai.weixin.qq.com";
/** 二维码**显示**倒计时（5 分钟）。真实过期以服务端轮询到的 `expired` 为准。 */
export declare const CLAWBOT_QR_TTL_MS: number;
/**
 * 状态轮询单次超时。
 *
 * 实测服务端无变化时挂起约 **30 秒**才回 `{status:'wait'}`，40s 留出服务器抖动余量
 * （WeClaw 同值）。超时不重试 —— 调用方保留原状态、下一次继续轮询即可。
 */
export declare const QR_POLL_TIMEOUT_MS = 40000;
/** 消息长轮询单次超时（WeClaw：35s 服务端窗口 + 5s 余量）。 */
export declare const GET_UPDATES_TIMEOUT_MS = 40000;
/** 发送单次超时（WeClaw sendTimeout；普通请求，不是长轮询）。 */
export declare const SEND_TIMEOUT_MS = 15000;
/** 协议常量：消息方向 / 状态 / 条目类型（与 WeClaw types.go 对齐）。 */
export declare const MESSAGE_TYPE_BOT = 2;
export declare const MESSAGE_STATE_FINISH = 2;
export declare const ITEM_TYPE_TEXT = 1;
/**
 * 最小 fetch 形状（只声明用到的字段）。
 *
 * 生产缺省用全局 `fetch`；测试注入假实现后整个模块零出网 —— 这是让协议层
 * 能在 node vitest 里被完整驱动的关键，也是「接入后 spec 不许真实联网」的保证。
 */
export interface FetchLike {
    (url: string, init?: {
        method?: string;
        headers?: Record<string, string>;
        body?: string;
        signal?: AbortSignal;
    }): Promise<{
        ok: boolean;
        status: number;
        text(): Promise<string>;
    }>;
}
/** 注入点：假 fetch（测试）/ 时间源。 */
export interface IlinkOptions {
    fetchImpl?: FetchLike;
}
/** 绑定确认后服务端下发的会话凭证（存进绑定表的凭证列，不进渲染层）。 */
export interface IlinkCredentials {
    botToken: string;
    ilinkBotId: string;
    ilinkUserId: string;
    baseUrl: string;
}
/** 取码结果：`token` 用于轮询状态，`payload` 是要被画成二维码的 URL。 */
export interface IlinkBindQr {
    token: string;
    payload: string;
}
/**
 * 一次状态轮询的结果。
 *
 * - `wait` / `scaned` / `expired`：服务端明确状态；
 * - `confirmed`：附带凭证（调用方落库 + 拉起接收通道）；
 * - `unknown`：服务端回了没见过的状态串（保留原状态继续轮询，不猜测）；
 * - `error`：网络错 / 超时 / 响应缺字段（同上：保留原状态）。
 */
export type IlinkPollResult = {
    status: 'wait' | 'scaned' | 'expired' | 'unknown';
} | {
    status: 'confirmed';
    credentials: IlinkCredentials;
} | {
    status: 'error';
    error: string;
};
/**
 * CDN 媒体引用（字段名线上原样；WeClaw types.go 同名）。
 *
 * `aes_key` 是 base64，**解码出来是 hex 字符串**，再 hex 解码才是 16 字节密钥
 * （WeClaw `DownloadFileFromCDN` 的两步解析；别省任何一步）。
 */
export interface MediaInfo {
    encrypt_query_param?: string;
    aes_key?: string;
    encrypt_type?: number;
}
/**
 * 消息条目（帧形状抄 WeClaw types.go，**字段名保持线上原样** snake_case）。
 *
 * 为什么不做 camelCase 归一：这是协议帧，用线上原名读，字段对不上时一眼能看出来；
 * 归一成内部形状反而会把「读错键名」伪装成「服务端没发这个字段」。
 */
export interface MessageItem {
    type?: number;
    text_item?: {
        text?: string;
    };
    image_item?: {
        url?: string;
        media?: MediaInfo;
        mid_size?: number;
    };
    voice_item?: {
        text?: string;
        media?: MediaInfo;
        voice_size?: number;
        playtime?: number;
    };
    video_item?: {
        media?: MediaInfo;
        video_size?: number;
    };
    file_item?: {
        file_name?: string;
        len?: string;
        media?: MediaInfo;
    };
}
/** 一条微信侧消息帧（字段名同上：线上原样）。 */
export interface WeixinMessage {
    message_id?: number;
    from_user_id?: string;
    to_user_id?: string;
    /** 1 = 用户发来；2 = bot 侧（本版本我们不发送，出现即为异常但如实处理）。 */
    message_type?: number;
    item_list?: MessageItem[];
    /**
     * 会话上下文令牌（发送回复时**必须**带上）。
     *
     * 由服务端随消息下发；WeClaw 的回复路径把它原样带回 `sendmessage`。
     * 我们对 1:1 绑定只保留**最近一条入站消息**的令牌（存绑定行），发送时取用。
     */
    context_token?: string;
}
/** `getupdates` 的响应（字段名与服务端一致、语义抄 WeClaw monitor.go）。 */
export interface IlinkUpdates {
    ret: number;
    errCode: number;
    errMsg: string;
    messages: WeixinMessage[];
    /** 下一次长轮询要带上的同步游标（空串 = 服务端没给新的）。 */
    buf: string;
    longPollingTimeoutMs: number;
}
/**
 * 向腾讯服务申请一次性绑定二维码。
 *
 * 响应形状（实拨确认）：`{ qrcode, qrcode_img_content, ret }`；`qrcode_img_content`
 * 就是要画成二维码的 URL（手机微信扫它打开绑定页）。
 * @param opts - 注入点（假 fetch）。
 * @param signal - 调用方生命周期信号（接收通道 stop 时用于中断在飞请求）。
 * @returns 一次性凭证与二维码内容。
 * @throws 网络错 / HTTP 非 200 / 响应缺字段（渲染层按 message 展示）。
 */
export declare function requestBindQr(opts?: IlinkOptions): Promise<IlinkBindQr>;
/**
 * 轮询一次绑定状态（单次，不循环）。
 *
 * 循环留给调用方：界面在二维码弹窗打开期间按节奏调用，关掉即停 —— 不在后端常驻
 * 一个无人消费的轮询循环。超时按 `error` 返回（调用方保留原状态继续），
 * 与 WeClaw「超时是长轮询的正常形态」的口径一致。
 * @param token - {@link requestBindQr} 返回的一次性凭证。
 * @param opts - 注入点（假 fetch）。
 * @returns 状态结果（见 {@link IlinkPollResult}）。
 */
export declare function pollBindStatus(token: string, opts?: IlinkOptions): Promise<IlinkPollResult>;
/**
 * 消息长轮询（单次）。
 *
 * 认证头与请求体形状照 WeClaw `Client.GetUpdates`：`AuthorizationType: ilink_bot_token` +
 * `Bearer <botToken>` + `X-WECHAT-UIN`（每次请求新随机值）；body 只有同步游标与渠道
 * 版本号 —— **不含任何本地数据**。
 * @param credentials - 绑定确认后的凭证（baseUrl 会先过 {@link resolveBaseUrl} 校验）。
 * @param buf - 上一次响应给的同步游标（空串 = 从头）。
 * @param opts - 注入点（假 fetch）。
 * @returns 响应（ret/errcode 由调用方按 WeClaw 语义处理）。
 * @throws 网络错 / HTTP 非 200 / 响应非法 JSON；`baseurl` 越域也会抛（拒绝发送）。
 */
export declare function getUpdates(credentials: IlinkCredentials, buf: string, opts?: IlinkOptions, signal?: AbortSignal): Promise<IlinkUpdates>;
/**
 * 把一条消息帧映射成待落库的行；没有可展示内容时返回 null（该帧被跳过）。
 *
 * 内容选取（与界面 msgType 取值对齐）：
 * - 文本 → 原文；图片/视频 → 占位说明；文件 → `[文件] 名字`；
 * - 语音 → 微信的**语音转写文本**（有则用），没有就 `[语音]`；
 * - 帧里没有任何已知条目 → null（不落空行）。
 *
 * 非文本条目同时抽**媒体引用**（怎么取 + 元数据），供界面按需下载解密；
 * 抽不到（既没有明文 URL 也没有加密参数）就归 null —— 界面只显示占位说明。
 *
 * `ts` 用**接收时间**：协议帧没有时间戳字段（实测与 WeClaw 类型一致），
 * 接收时间至少单调、可用于展示与排序。
 * @param msg - 消息帧。
 * @param now - 时间源（测试注入）。
 * @returns 落库输入（`msgId` 用于去重：服务端清游标后会重发）。
 */
export declare function mapWeixinMessage(msg: WeixinMessage, now?: () => number): ClawbotMessageInput | null;
/** 发送结果（服务端确认后的原始码；`ret !== 0` = 被拒）。 */
export interface IlinkSendResult {
    ret: number;
    errMsg: string;
}
/** 要发送的一条文本消息（正文 = 用户输入原文，不做任何改写/打码）。 */
export interface IlinkOutgoingText {
    /** 微信侧用户 id（binding 的 `ilink_user_id`）。 */
    toUserId: string;
    /** 正文原文。 */
    text: string;
    /** 最近一条入站消息带来的会话令牌（取不到就没法发，调用方拦在前头）。 */
    contextToken: string;
    /** 相关性 id；缺省随机 uuid（测试可注入以对形状断言）。 */
    clientId?: string;
}
/**
 * 发送一条文本消息（**用户主动触发**的唯一出网内容路径）。
 *
 * 帧形状照 WeClaw `messaging/sender.go#SendTextReply`：`from_user_id` = 本 bot、
 * `to_user_id` = 微信侧用户、`message_type=2 / message_state=2`、`item_list` 一个文本条目、
 * `context_token` 原样带回（来自最近入站消息）；业务侧 `base_info` 为**空对象**。
 * 正文按用户输入原文发送 —— 不打码、不转 Markdown（打码开关只作用于**展示层**）。
 * @param credentials - 绑定确认后的凭证（baseUrl 会先过 {@link resolveBaseUrl} 校验）。
 * @param out - 接收方 / 正文 / 会话令牌。
 * @param opts - 注入点（假 fetch / 假 clientId 由 out 给）。
 * @returns 原始 `ret` / `errmsg`（由调用方决定成功与否与文案）。
 * @throws 网络错 / HTTP 非 200 / baseurl 越域；`ret !== 0` **不抛**（它是业务拒绝，有 errmsg）。
 */
export declare function sendTextMessage(credentials: IlinkCredentials, out: IlinkOutgoingText, opts?: IlinkOptions): Promise<IlinkSendResult>;
