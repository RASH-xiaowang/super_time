/**
 * 批量取原图：把全库里**带免登录预签名直链**（`tphdurl` / `tpurl`）的图片原图一次取回本机。
 *
 * ## 为什么需要「批量」这一条
 *
 * 单条「取原图」早就有了，但它只有两个入口：用户在会话里**逐条**点（一条一次 RPC），
 * 或者前端预取链路顺手带一次。而本机实测（`working/probe-original-coverage.ts`）：
 * **51,983 条图片消息里 8,469 条带 `tphdurl`（16.3%）、135 条带 `tpurl`**，
 * 也就是说有几千条「本该能拿到的原图」要靠用户一条条点 —— 实际上没人会点。
 * 批量入口把这批一次做完，并且**幂等可续跑**（见下面的索引）。
 *
 * ## 三条途径与各自的约束（这是产品边界，不是实现细节）
 *
 * | 途径 | 本机覆盖率 | 能不能取 | 约束 |
 * |---|---|---|---|
 * | 本机 `.dat` 档（`_h`，含 wxgf 转码） | 971 个 `_h` | ✅ 离线 | 用户得先在微信里点开过大图 |
 * | 消息 XML 的 `tphdurl`/`tpurl` | 16.5% 有指针 | ⚠ **本机实测取不到** | 见下 |
 * | 消息 XML 的 `cdnbigimgurl`/`cdnmidimgurl` | 81.6% | ❌ **不做** | 要微信**登录态凭据** + 私有媒体 RPC |
 *
 * **第二行的实测结论（2026-09-26，`working/probe-wecom-403.ts`）**：本机 8,604 条带直链的图片
 * 消息**全部**指向企业微信的 `wwfile.work.weixin.qq.com/cgi-bin/download?f=…&t=…&p=1`，
 * 匿名 GET **一律 403**，且与消息新旧（20 分钟前的新消息同样 403）、请求头（裸 UA / 加
 * `Referer: work.weixin.qq.com` / 加图片 `Accept`）**都无关**；URL 里只有 `f`/`t`/`p` 三个参数，
 * **没有** `tpauthkey` 那类签名参数。⇒ 它不是免登录预签名直链，而是**需要企业微信登录态的服务端
 * 令牌端点**，与本应用「不登录」的边界同样冲突。所以它按「需要登录态」计，**不进候选清单**
 * （否则一次点击会白发几千个必然 403 的请求）。
 *
 * 保留这条通路的意义：**个人微信**账号的 `tpurl` 真带 `tpauthkey`（那类 GET 即明文图），
 * 换一个账号它就有产出；本机（这份数据）产出为 0，如实报出而不是假装能取。
 *
 * 后两行都不是「还没做」，是**明确的边界**：那已经不是「读本机已有的密钥」，而是「以你的身份向
 * 微信服务器发请求」，与本应用「不登录、不连微信服务器同步」的承诺冲突（口径写在
 * `query/image-original.ts` 的模块注释与 `docs/PRIVACY.md`）。所以这两类的兜底只能是
 * **让用户回微信里点开一次**（点开之后 attach 里就多出 `_h.dat`，再点「升级为原图」即可收进来）。
 *
 * ## 幂等与续跑：一份 sidecar 索引
 *
 * `<decoded>/.originals-index.json` 记「哪些 md5 已经联网取回过」。没有它的话，取回的原图与
 * 本机解码出的原图**写在同一个槽位**（`<md5>.<ext>`），下一轮批量就分不清「这张是取回来的」
 * 还是「本机解出来的」，只能重下 —— 几千张重下是几 GB 的浪费。索引只在成功落盘后写，
 * 并且批量路径**每 25 条合写一次**（每条都写会退化成 O(n²) 次 JSON 序列化）。
 */
/** 一条可联网取回的原图候选。 */
export interface ImageOriginalCandidate {
    /** 图片内容 md5（`packed_info_data` 那份，**不是** XML 的 `md5=`）。 */
    md5: string;
    /** 会话 username（拿不到时为空串；只用于报告，取回路径用不上）。 */
    username: string;
    /** 消息 local_id（报告/排障用）。 */
    localId: number;
    /** 免登录预签名直链（`tphdurl` 优先，其次 `tpurl`）。 */
    url: string;
    /** 是否带独立的高清档（有 `tphdurl`）。 */
    hasHdLink: boolean;
    /** XML 声明的原图字节数（`hdlength` → `length` → `tplength`），拿不到时 0。 */
    declaredBytes: number;
}
/**
 * 一次「能不能取到原图」的盘点结果。
 *
 * **除 `messages` 外，所有计数都是「按 md5 去重后」的**：同一张图被转发/重复发送多次只算一张
 * （取回也是按 md5 命名落盘一次），而 `messages` 是扫到的消息行数。两个口径都写出来是为了
 * 报告能同时回答「有多少条消息」与「要下多少张」。
 */
export interface OriginalFetchPlan {
    /** 扫到的图片消息条数（**按行**，未去重）。 */
    messages: number;
    /** 按 md5 去重后的图片张数。 */
    uniqueMd5: number;
    /** 本机已有 `_h` 档（离线就拥有原图，不需要联网）。 */
    alreadyHd: number;
    /** 已由本工具联网取回过（索引里），本次会跳过。 */
    alreadyFetched: number;
    /** **本次可联网补齐**的条数（= 候选清单长度）。 */
    candidates: number;
    /** 候选的 XML 声明字节数合计（预计下载量；缺声明的按 0 计，所以是下界）。 */
    declaredBytes: number;
    /** 只有 `cdnbig/mid`（需微信登录态，本应用**不取**）的条数 —— 只能靠回微信里点开。 */
    loginRequired: number;
    /**
     * `loginRequired` 里「**有直链、但那条直链是企业微信下载端点**」的那部分。
     *
     * 单列出来是为了让报告说得出「这几千张明明有 URL 却取不到」的原因：2026-09-26 实测
     * `wwfile.work.weixin.qq.com` 的链接匿名 GET 一律 403（与消息新旧、请求头都无关），
     * 它们是服务端令牌端点、不是免登录预签名直链（判据见 `cdn-hosts.ts` 的 `isWecomFileEndpoint`）。
     */
    wecomDirectLink: number;
    /** 有 md5 但三种指针都没有的条数（实测本机为 0，留着便于将来发现新形态）。 */
    noPointer: number;
}
/** 批量取回的结果。 */
export interface OriginalBatchResult {
    ok: boolean;
    /** 扫出的候选总数（受 `limit` 截断前的）。 */
    candidates: number;
    /** 本次实际尝试的条数（`limit` 之后）。 */
    attempted: number;
    fetched: number;
    failed: number;
    /** 本次落盘的总字节数。 */
    bytes: number;
    ms: number;
    errors: Array<{
        md5: string;
        username: string;
        error: string;
    }>;
    /** 因「总闸/开关」一张都没发请求时的说明（此时 `fetched`/`failed` 都是 0）。 */
    blocked?: string;
    /** 还有多少候选没取（`limit` 截断后的剩余，下次点一下继续）。 */
    remaining: number;
    /** 本轮之后，本机已有原图的张数（索引大小）—— 界面据此说「累计已补齐多少张」。 */
    indexed: number;
}
/** 读续跑索引（坏文件一律当空，不让它阻断批量）。 */
export declare function readFetchedOriginals(decodedDir: string): Set<string>;
/**
 * 记一批「已联网取回过」（**一次**读-改-写）。
 *
 * 写成批而不是写单条，是因为批量路径会连着成功几百上千条：每条都读整个文件再序列化回去，
 * 会退化成 O(n²) 的写放大。批量驱动按 {@link INDEX_FLUSH_EVERY} 条合写一次。
 * @param decodedDir - 解码缓存根。
 * @param md5s - 本次成功取回的 md5（非 32 位十六进制的会被忽略）。
 */
export declare function recordFetchedOriginals(decodedDir: string, md5s: readonly string[]): void;
/**
 * 记一条「已联网取回过」（单张路径用；内部走批量写）。
 * @param decodedDir - 解码缓存根。
 * @param md5 - 图片 md5。
 */
export declare function recordFetchedOriginal(decodedDir: string, md5: string): void;
/**
 * 扫全库，盘点「每条图片消息的原图能不能拿到」。
 *
 * 一次扫描同时产出「候选（可联网补齐）」与「只能靠微信点开」两个数 —— 界面上的覆盖率报告
 * 与批量的执行清单是**同一份数据**，不会出现「报 8000 张、实际取 7000 张」这种对不上的情况。
 *
 * 计数口径：除 `messages` 外都按 md5 去重（见 {@link OriginalFetchPlan}）。
 * @param decryptedDir - 解密数据根。
 * @param rawRoot - 微信账号原始根（用来判「本机已有 `_h`」）。
 * @param decodedDir - 解码缓存根（读续跑索引）。
 * @returns 盘点结果 + 候选清单。
 */
export declare function scanImageOriginalPlan(decryptedDir: string, rawRoot: string, decodedDir: string): {
    plan: OriginalFetchPlan;
    candidates: ImageOriginalCandidate[];
};
/**
 * 造一个「一条都没发请求」的结果。
 *
 * 供**闸门在更上层**时复用（隐私总闸 / 已有解密任务在跑）：那两处不该为了造一个空结果
 * 去 import 本模块的内部形状，也不该各自手抄一份字段（少一个字段就是界面上一处 `undefined`）。
 * @param reason - 直接显示给用户的原因。
 * @returns `fetched`/`failed` 全 0、`blocked` 为传入原因的结果。
 */
export declare function emptyOriginalBatchResult(reason: string): OriginalBatchResult;
/**
 * 批量取回原图（免登录直链）。
 *
 * 边界与开关：**关掉「自动获取原图（CDN）」时一条请求都不发**（与单张路径同一口径，见
 * `query/cdn-policy.ts`），并回 {@link CDN_DISABLED_MESSAGE}；真正发请求前还会过一次
 * 腾讯系主机白名单（在 `fetchImageOriginalToCache` 里，消息 XML 是可被离线改写的文件）。
 * 逐条失败**不中断**整批（列出原因），成功的写进续跑索引 ⇒ 下次点一下就接着走。
 * @param decryptedDir - 解密数据根。
 * @param rawRoot - 微信账号原始根。
 * @param decodedDir - 解码缓存根（原图落这里 + 写续跑索引）。
 * @param opts - `limit`（0/不传 = 不限）、`concurrency`（默认 4，封顶 8）、`cdnEnabled`、`onProgress`。
 * @returns 计数、字节数、耗时与逐条失败原因。
 */
export declare function fetchOriginalImagesBatch(decryptedDir: string, rawRoot: string, decodedDir: string, opts?: {
    limit?: number;
    concurrency?: number;
    cdnEnabled?: boolean;
    onProgress?: (done: number, total: number, fetched: number, failed: number, message: string) => void;
}): Promise<OriginalBatchResult>;
