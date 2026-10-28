/** 签名直链的路径前缀（后端拼 URL、宿主层路由都读它）。 */
export declare const RPA_MEDIA_PATH_PREFIX = "/api/rpa-media/";
/** 令牌版本号（写进令牌第一段；将来换算法时用它区分新旧）。 */
export declare const RPA_MEDIA_TOKEN_VERSION = "v1";
/**
 * 默认有效期（毫秒）：1 小时。
 *
 * 取值的两边约束：太短会让排队中的云机器人拿到链接时已经过期（八爪鱼/来也这类
 * 云通道可能排几分钟到几十分钟），太长则等于给局域网里拿到 URL 的人更长的窗口。
 * 一小时覆盖常见排队，且链接只暴露那一张图片本身。
 */
export declare const RPA_MEDIA_DEFAULT_TTL_MS: number;
/** 有效期上限（毫秒）：24 小时 —— 配置写多大都不越过它。 */
export declare const RPA_MEDIA_MAX_TTL_MS: number;
/**
 * 允许经签名直链读取的扩展名（与 `src/backend/media-protocol.js` 的 `MIME_BY_EXT` 同集合）。
 *
 * 为什么两处各写一份：宿主层的 `resolveDecodedFile` 是**真正决定能读到哪个文件**的那一道，
 * 这里的判定只负责「不给非图片路径签令牌」。两份都是白名单，收紧任何一份都不会放行文件。
 */
export declare const RPA_MEDIA_IMAGE_EXTS: readonly string[];
/** 令牌载荷（签名内容与验签结果都是它）。 */
export interface RpaMediaTokenPayload {
    /** 触发记录 id（排查用；也把令牌绑到某一条记录上）。 */
    recordId: number;
    /** decoded 根内的相对图片路径（`/` 分隔，如 `wxid_ab/cd….jpg`）。 */
    rel: string;
    /** 绝对过期时间（毫秒时间戳）。 */
    expiresAt: number;
}
/**
 * 由 `api_token` 派生签名密钥（HMAC-SHA256 的 key）。
 *
 * 为什么不是直接拿 `api_token` 当 key：那是**另一条链路**（手机配对/会话）的凭据，
 * 派生一层可以让两边即使将来换算法也互不影响；前缀串是域分隔，避免与其它用途撞上。
 * @param apiToken - `secrets.json` 里的 `api_token`（空串 = 未启用入站面，调用方应先拒）。
 * @returns 32 字节密钥。
 */
export declare function rpaMediaTokenKey(apiToken: string): Buffer;
/**
 * 相对路径是否可以作为直链目标。
 *
 * 只接受 decoded 根内的图片相对路径：拒绝空串、`\`、NUL、绝对路径、盘符、`..`/`.`
 * 与空段，并要求扩展名在白名单里。这是**签令牌前**的判定；宿主层取文件时还会用
 * `resolveDecodedFile` 再判一次（纵深防御，任一处收紧都不会放行）。
 * @param rel - 候选相对路径。
 * @returns 可以作为直链目标时为 true。
 */
export declare function isSafeRpaMediaRel(rel: unknown): rel is string;
/**
 * 给一张图片签一个直链令牌。
 * @param key - {@link rpaMediaTokenKey} 的产物。
 * @param payload - 记录 id / 相对路径 / 过期时间。
 * @returns `v1.<载荷>.<签名>`（URL 安全，可直接拼进参数）。
 */
export declare function signRpaMediaToken(key: Buffer, payload: RpaMediaTokenPayload): string;
/**
 * 校验令牌（宿主层每次请求都会走这里）。
 *
 * 失败一律返回 null（不区分「格式错 / 签名错 / 过期」—— 对未授权的请求人，
 * 区分它们只会泄漏信息）；调用方按 404 处理。
 * @param key - 与签发方同一把密钥。
 * @param token - 路径里那一段。
 * @param nowMs - 当前时间（测试注入）。
 * @returns 合法且未过期时的载荷；否则 null。
 */
export declare function verifyRpaMediaToken(key: Buffer, token: string, nowMs: number): RpaMediaTokenPayload | null;
/**
 * 拼出可直接放进 RPA 参数的绝对地址。
 * @param baseUrl - 基址（如 `http://192.168.1.10:5032`，末尾斜杠可有可无）。
 * @param token - {@link signRpaMediaToken} 的产物。
 * @returns 绝对 URL。
 */
export declare function rpaMediaUrl(baseUrl: string, token: string): string;
