export declare const WXGF_MAX_PARTITIONS = 2;
export declare const WXGF_MAX_NAL_UNITS = 4096;
export declare const WXGF_FFMPEG_MAX_PIXELS = 50000000;
export declare const WXGF_FFMPEG_TIMEOUT_MS = 20000;
/** 测试注入点：换掉 ffmpeg 进程调用。 */
export interface WxgfFfmpegSpawnResult {
    status: number | null;
    stdout: Buffer;
    stderr: Buffer;
}
export type WxgfFfmpegSpawn = (exe: string, args: readonly string[], input: Buffer, timeoutMs: number) => WxgfFfmpegSpawnResult;
/**
 * 定位 ffmpeg：`DSH_WECHAT_FFMPEG` 环境变量优先，其次 PATH。
 * @returns 绝对路径；找不到返回 ''。
 */
export declare function findFfmpegExecutable(): string;
/**
 * 按「起始码 + VPS」切出 wxgf 里的各个 HEVC 分区。
 *
 * 头部与码流之间的元数据（如 ICC）里会出现形似起始码的字节，所以不能直接取第一个起始码；
 * 每个分区前是 4 字节大端长度，长度对不上说明文件被截断或不是这种布局——**整个放弃**，
 * 不把残缺的码流交给解码器。
 * @param data - wxgf 载荷（已解密的字节）。
 * @returns 分区列表；不可信时返回空表。
 */
export declare function wxgfHevcPartitions(data: Uint8Array): Uint8Array[];
/**
 * 数出码流里的编码图像：VCL NAL 且 `first_slice_segment_in_pic_flag` 为 1。
 * NAL 多到不像一张图片时不再往下数，按多帧处理（上限保护）。
 */
export declare function hevcPictureCount(stream: Uint8Array): number;
/**
 * 用 ffmpeg 把静态、不透明的 wxgf 转成 JPEG（DLL 不可用时的兜底）。
 * @param payload - wxgf 载荷。
 * @param deps - 测试注入点（spawn / 可执行定位 / 缓存开关）。
 * @returns JPEG 字节与宽高；任何一步不成立返回 `{ error }`。
 */
export declare function transcodeWxgfWithFfmpeg(payload: Uint8Array, deps?: {
    spawn?: WxgfFfmpegSpawn;
    findExe?: () => string;
    useCache?: boolean;
}): {
    bytes: Uint8Array;
    jpegWidth: number;
    jpegHeight: number;
} | {
    error: string;
};
