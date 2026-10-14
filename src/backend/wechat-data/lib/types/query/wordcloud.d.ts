export interface WordCloudOptions {
    scope?: 'global' | 'chat' | 'moments';
    username?: string;
    year?: number;
    limit?: number;
}
export interface WordCloudWord {
    text: string;
    count: number;
}
export interface WordCloudResult {
    words: WordCloudWord[];
    scanned: number;
    /**
     * 这次是**被取消**的（`scanned` 只覆盖扫完的那一部分）—— W2-9.4。
     *
     * 取消不抛错：用户是自己切换了年份/会话，不该看到一句红色报错。
     * 界面据此**不写**这份结果（它是半成品），而调用方拿它去比缓存时也据此拒写。
     */
    canceled?: boolean;
}
/**
 * 计算词云词频（带进程内缓存）。
 *
 * 实测（2026-09-26，本机 163,647 条正文 / 349 张会话表）：不加缓存时 global 一次 **15.3 秒**，
 * 且每次切回总览页都重算。它**原先同步返回** ⇒ 跑的这十几秒里后端 RPC 队列被整条堵住，
 * 同屏的「世界板块」（自身只要 13ms）实测被推迟到 **17,008ms** 才拿到数据 ——
 * 用户看到的就是「世界板块和全部热词都卡住」。
 *
 * 三道修：① 实体遮罩改 Aho-Corasick（见 `EntityMatcher`），把 15 秒压到 ~2 秒；
 * ② 按数据指纹缓存 30 秒，切回来 0ms；
 * ③ **让出事件循环**（2026-09-28 补）：即使压到 ~2 秒，一次冷算仍是**同步**占满整个
 * 后端 worker —— 实测被拖慢的不是词云自己，而是同屏其它请求。所以这里改成
 * `async` + `cachedBySigAsync`，并在分片之间 / 每 `YIELD_EVERY_ROWS` 行让出，
 * 与 `overview-insights.ts` / `storage.ts` 等九个模块同一条纪律
 * （判据：`tests/query-yield-discipline.spec.ts` 的 P1-2 清单）。
 *
 * 契约变化：返回值由 `WordCloudResult` 变为 `Promise<WordCloudResult>` ——
 * `remotes/wordcloud.ts` 与 `gateway-read.ts` 的转发层同步改成 async；
 * 渲染侧 `apiGetWordCloud` 本来就是 `await`，无需改动。
 * @param decryptedDir 解密数据根。
 * @param options scope/username/year/limit。
 */
export declare function queryWordCloud(decryptedDir: string, options?: WordCloudOptions): Promise<WordCloudResult>;
