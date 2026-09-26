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
}
/**
 * 计算词云词频（带进程内缓存）。
 *
 * 实测（2026-09-26，本机 163,647 条正文 / 349 张会话表）：不加缓存时 global 一次 **15.3 秒**，
 * 且每次切回总览页都重算。它是**同步**返回 ⇒ 跑的这十几秒里后端 RPC 队列被整条堵住，
 * 同屏的「世界板块」（自身只要 13ms）实测被推迟到 **17,008ms** 才拿到数据 ——
 * 用户看到的就是「世界板块和全部热词都卡住」。
 *
 * 两道修：① 实体遮罩改 Aho-Corasick（见 `EntityMatcher`），把 15 秒压到 ~2 秒；
 * ② 按数据指纹缓存 30 秒，切回来 0ms。
 * @param decryptedDir 解密数据根。
 * @param options scope/username/year/limit。
 */
export declare function queryWordCloud(decryptedDir: string, options?: WordCloudOptions): WordCloudResult;
