/**
 * Resolve a received message file to a base64 data URL from msg/file.
 *
 * 归属要点：微信把收到的文件平铺在 `msg/file/<月份>/<原文件名>`，**目录不区分会话**，
 * 所以同一账号里同名文件可能有多个副本。旧实现只按文件名全库找、取 mtime 最新的
 * 那个，会把**别的会话**的同名文件当成这条消息的附件打开。这里用消息自带的两条
 * 线索收敛到唯一候选：
 *   1. `createTime` → 月份目录（先只在这个月里找，找不到才退回全库）；
 *   2. `fileSize`（appmsg 的 `<totallen>`）→ 精确字节数匹配，优先于 mtime。
 * 同名同大小又同月时，若消息带 `fileMd5`，则读取候选内容逐个比对 MD5；
 * 只有未提供 MD5 时才保留旧的 mtime 兜底。给了 MD5 但没有任何候选匹配，
 * 必须明确失败，不能拿另一份同名文件冒充。
 * @param wechatBaseDir - raw WeChat install dir (current account root).
 * @param fileName - original file name (e.g. 测试报告.pdf).
 * @param opts - 归属线索：文件字节数、接收时间与附件 MD5。
 * @returns ImageDataUrlResult-like result.
 */
export declare function resolveMessageFileDataUrl(wechatBaseDir: string | undefined, fileName: string, opts?: {
    size?: number;
    createTime?: number;
    fileMd5?: string;
}): {
    url?: string;
    error?: string;
};
