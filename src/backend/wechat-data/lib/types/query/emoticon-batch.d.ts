import type { EmoticonDataUrlsResult } from '../types.ts';
/**
 * 批量取表情（两趟设计）。
 *
 * ## 为什么顺序是「先本地全过一遍，再对剩下的并发取远端」
 *
 * 不能「逐条走完整链」—— 那样每条都要等一次网络往返，N 条就是 N 个往返的时间。
 * 拆成两趟之后：第一趟纯本地（查索引 + 解码，无网络，很快），把命中的直接定下来；
 * 第二趟只对剩下的并发出网，并由 {@link EMOTICON_FETCH_CONCURRENCY} 限流。
 * @param decryptedDir - 解密目录（推导原始微信目录与密钥用）。
 * @param decodedDir - 解码缓存目录（落盘与探测用）。
 * @param base - 原始微信目录（`msg/attach` 的父级）；缺省时只能纯本地 + 无目录兜底。
 * @param items - 待取的表情（自动去重、忽略空 md5）。
 * @returns 逐条结果，`md5` 回信；顺序 = 去重后的入参顺序。
 */
export declare function fetchEmoticonDataUrlsBatch(decryptedDir: string, decodedDir: string, base: string | undefined, items: ReadonlyArray<{
    md5: string;
    emojiUrl?: string;
}> | undefined): Promise<EmoticonDataUrlsResult>;
