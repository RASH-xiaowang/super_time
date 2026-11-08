/**
 * 后端内部的多厂商触发契约（**不进** `lib/types` 的公开面）。
 *
 * 公开描述符在 `../types-rpa.ts`（可序列化、前端可见）；本文件只放**运行时**才需要的
 * 形状：触发上下文、请求/响应、适配器钩子。厂商适配器（`vendors/*.ts`）实现
 * {@link RpaVendorAdapter}；核心管道（`dispatch.ts`）只认这个接口，不认识具体厂商。
 */
import type { RpaVendorDescriptor, RpaTriggerConfig } from '../../types-rpa.ts';
import type { TaskTriggerImage } from '../../types.ts';
import type { RetryFetch } from '../../net/fetch-retry.ts';
/**
 * 一张触发图片的**投递形态**（2026-10-23）：引用 + 短时签名直链。
 *
 * 为什么不是字节：RPA 厂商的触发接口只有字符串参数（见 `types-rpa.ts` 的 `RpaParamSource`）。
 * 只有「图片链接」那三种值来源会读它；Webhook 仍走 `record.images` 自己的解码路径。
 */
export interface RpaImageLink {
    /** 消息 local_id（与触发记录里的引用同源）。 */
    localId: number;
    createTime: number;
    sender: string;
    /** 图片 md5（有则带上：机器人侧可据此去重/核对）。 */
    md5?: string;
    /** 短时签名直链；解不出来时缺省（并带 `error`）。 */
    url?: string;
    /** 这张为什么没带上（解码失败 / 未启用局域网访问 / 路径越界）。 */
    error?: string;
}
/** 一条触发记录在投递时的只读快照（`text` 已过隐私闸）。 */
export interface RpaRecordContext {
    username: string;
    chatName: string;
    chatType: 'private' | 'group';
    targetName: string;
    targetUsername: string;
    /** 已过隐私闸的触发文本。 */
    text: string;
    keyword: string;
    triggeredAt: number;
    /** 触发图片引用（Webhook 按需解码；RPA 的图片类来源按需签短时直链）。 */
    images: TaskTriggerImage[];
}
/** 一次投递的完整上下文（模板占位符的顶层根）。 */
export interface RpaInvocationContext {
    taskId: number;
    recordId: number;
    /** 幂等键：`<taskId>:<recordId>`（多数厂商只能拿它做应用层去重）。 */
    idempotencyKey: string;
    taskName: string;
    record: RpaRecordContext;
    /**
     * 触发图片的签名直链（与 `record.images` 一一对应、顺序相同）。
     *
     * 由 `task-center-callback.ts` 在投递前预计算（解码是异步的，而参数解析是同步的）；
     * 只有 `imagesJson` / `imageCount` / `firstImageUrl` 三种值来源会读它。
     */
    imageLinks: RpaImageLink[];
    config: RpaTriggerConfig;
    secrets: Record<string, string>;
}
/** 厂商钩子可用的解码依赖（仅 Webhook 适配器需要图片）。 */
export interface RpaBuildDeps {
    decodedDir: string;
    decodeImage: (username: string, localId: number, options?: {
        fileOnly?: boolean;
    }) => Promise<{
        url?: string;
        file?: string;
    }>;
}
/**
 * 已组装好的 HTTP 请求。
 *
 * 普通请求用字符串 `body`；multipart 等二进制请求把原始字节放在 `bodyBytes`，
 * `sendRequest` 会优先发送它。使用可重放的字节而不用一次性流，保证自动重试仍能
 * 发送完全相同的请求体。
 */
export interface RpaHttpRequest {
    /** GET 只用于「换 token」（影刀等）；业务触发请求仍是 POST/PUT。 */
    method: 'GET' | 'POST' | 'PUT';
    url: string;
    headers: Record<string, string>;
    body: string;
    /** 二进制请求体（multipart）；存在时优先于 `body`。 */
    bodyBytes?: Uint8Array;
    contentType: string;
    /** Optional binary response mode used by the Feather resource uploader. */
    responseType?: 'text' | 'bytes';
    /** Hard cap when responseType is bytes; prevents an untrusted URL from exhausting memory. */
    maxResponseBytes?: number;
}
/** 一次 HTTP 响应（body 文本，由厂商解析器决定业务成败）。 */
export interface RpaHttpResponse {
    status: number;
    bodyText: string;
    /** Present only when the request set `responseType: 'bytes'`. */
    bodyBytes?: Uint8Array;
}
/** 厂商适配器解析后的投递结果。 */
export interface RpaSendResult {
    ok: boolean;
    /** 失败是否值得自动重试（无幂等键的厂商必须为 false）。 */
    retryable: boolean;
    message?: string;
    externalTaskId?: string;
}
/**
 * 一个厂商适配器：描述符 + 可选钩子。
 *
 * 绝大多数厂商只需要 `descriptor`（声明式模板）；只有「可选字段拼装」「自定义签名」
 * 「非标准响应」才实现钩子，且钩子写在本厂商文件里，核心不改。
 */
export interface RpaVendorAdapter {
    descriptor: RpaVendorDescriptor;
    /** 覆盖模板组装（如 Webhook 需要带图片的整条记录、影刀 accountName/分组二选一）。 */
    buildRequest?: (ctx: RpaInvocationContext, deps: RpaBuildDeps) => RpaHttpRequest | Promise<RpaHttpRequest>;
    /** 自定义鉴权/签名（阿里云 RPC 签名）：在请求发出前改写 headers/body。 */
    signRequest?: (req: RpaHttpRequest, ctx: RpaInvocationContext) => void;
    /** 覆盖响应解析（如 UiPath 返回 Job 数组、MCP 需要二次 JSON 解析）。 */
    parseResponse?: (res: RpaHttpResponse, ctx: RpaInvocationContext) => RpaSendResult;
}
/** 投递依赖（测试注入 fetch；生产省略 = 全局 fetch）。 */
export interface RpaDispatchDeps {
    fetchImpl?: RetryFetch;
    /** 调用方的中止信号：租约续期失败时中止在途 fetch。 */
    signal?: AbortSignal;
    /**
     * 首次真正尝试出网前调用；可异步落一条 `sent_unconfirmed` 标记。
     *
     * 抛出/拒绝表示标记未能持久化，此时 `sendRequest` 不会调用 fetch。
     */
    onOutboundAttempt?: () => void | Promise<void>;
}
/** 通用管道对一条记录给出的结果（由 callback 层再包成 TaskCallbackDispatchResult）。 */
export interface RpaDispatchOutcome {
    status: 'sent' | 'failed' | 'skipped';
    error?: string;
    externalTaskId?: string;
}
