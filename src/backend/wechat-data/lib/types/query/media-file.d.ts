/**
 * Resolve a received message file to a base64 data URL from msg/file.
 *
 * 归属要点：微信把收到的文件平铺在 `msg/file/<月份>/<原文件名>`，**目录不区分会话**，
 * 所以同一账号里同名文件可能有多个副本。旧实现只按文件名全库找、取 mtime 最新的
 * 那个，会把**别的会话**的同名文件当成这条消息的附件打开。这里用消息自带的两条
 * 线索收敛到唯一候选：
 *   1. `createTime` → 月份目录（先只在这个月里找，找不到才退回全库）；
 *   2. `fileSize`（appmsg 的 `<totallen>`）→ 精确字节数匹配，优先于 mtime。
 * 同名同大小又同月时仍只能回退 mtime —— 微信的存储路径里没有会话维度，
 * 这一档限制来自数据布局本身，无法在读取侧彻底消除。
 * @param wechatBaseDir - raw WeChat install dir (current account root).
 * @param fileName - original file name (e.g. 测试报告.pdf).
 * @param opts - 归属线索：消息里的文件字节数与接收时间。
 * @returns ImageDataUrlResult-like result.
 */
export declare function resolveMessageFileDataUrl(wechatBaseDir: string | undefined, fileName: string, opts?: {
    size?: number;
    createTime?: number;
}): {
    url?: string;
    error?: string;
};
