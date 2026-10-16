/**
 * 词云（wordcloud） 的 @Remote 处理器（2026-09-25，界面优化阶段 4）。
 *
 * 机制：类里保留 @Remote 装饰器与签名（协议层按名字枚举），方法体一行转发；
 * 处理器体在这里，依赖由 `rc` 显式给出。
 */
import { WordCloudOptions, WordCloudResult } from '../query/wordcloud.ts';
export interface createWordcloudRemotesInputs {
    dirs: () => {
        decrypted: string;
        decoded: string;
    };
}
export declare function createWordcloudRemotes(rc: createWordcloudRemotesInputs): {
    getWordCloud(options?: WordCloudOptions): Promise<WordCloudResult>;
};
