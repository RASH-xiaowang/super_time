export { jpegDimensions } from './jpeg-dimensions.ts';
/**
 * 原生解码库的最小接口。
 *
 * 抽成接口而不是直接暴露 koffi：① 调用点只需「跑一次、拿到输出长度」；
 * ② 单测可以注入假实现，不必依赖本机装没装微信、更不必真去调原生代码。
 */
export interface WxgfNative {
    /** 跑一次转码。`output` 由调用方按需分配；真实输出长度写回 `outSize`（int32 LE）。 */
    run(input: Buffer, output: Buffer, outSize: Buffer, opt: Buffer): {
        ret: number;
        size: number;
    };
    /** 诊断用的来源标识（DLL 路径或假实现的标签）。 */
    readonly label: string;
}
/** 转码结果：成功给出像素字节与宽高（宽高供诊断/测试，不参与接口）；失败给一句原因。 */
export type WxgfTranscodeResult = {
    bytes: Uint8Array;
    jpegWidth: number;
    jpegHeight: number;
    ms: number;
} | {
    error: string;
};
/** 转码器签名（调用方可通过参数注入替身）。 */
export type WxgfTranscoder = (payload: Uint8Array) => WxgfTranscodeResult;
/**
 * 找到微信安装目录下的解码库路径。
 *
 * 安装根来自注册表（`config/detect.ts` 的 `weixinInstallPath`），DLL 在**版本子目录**下。
 * 本机可能存在多个版本目录，且 `readdir` 顺序不保证 ⇒ 这里**自己按版本号倒序扫**
 * （而不是取 `weixinVersion()` 返回的第一个），并挑第一个真的有 DLL 的目录。
 * @returns DLL 绝对路径；未安装 / 目录里没有该 DLL 时返回 ''。
 */
export declare function resolveVoipEnginePath(): string;
/**
 * 造一个转码器。
 * @param native - `undefined` = 用真 DLL（惰性加载）；`null` = 强制不可用；对象 = 注入替身（单测）。
 * @returns 转码器；**永不抛**，失败一律返回 `{ error }`。
 */
export declare function createWxgfTranscoder(native?: WxgfNative | null, ffmpegFallback?: WxgfTranscoder | null): WxgfTranscoder;
/** 默认转码器（真 DLL，惰性加载）。 */
export declare const transcodeWxgf: WxgfTranscoder;
/**
 * 转码能力是否可用（惰性探测并缓存）。
 *
 * 注意：**首次调用会真的去加载 DLL**（约 1.5s）。只在需要判断「要不要报降级文案」时调，
 * 不要放进每张图的解码路径（那里直接调 {@link transcodeWxgf}，失败自然降级）。
 * @returns 可用为 true。
 */
export declare function isWxgfTranscodeAvailable(): boolean;
