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
 * 计算词云词频。
 * @param decryptedDir 解密数据根。
 * @param options scope/username/year/limit。
 */
export declare function queryWordCloud(decryptedDir: string, options?: WordCloudOptions): WordCloudResult;
