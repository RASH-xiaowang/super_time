/** 图片容器里的宽高。 */
export interface ImageDimensions {
    width: number;
    height: number;
}
/** 朋友圈 XML `<size>` 给出的原图预期（单位：像素 / 字节）。 */
export interface SnsOriginalExpectation {
    width?: number;
    height?: number;
    bytes?: number;
}
/** 一张候选图片的质量判定结果。 */
export interface SnsOriginalEvaluation {
    bytes: number;
    width?: number;
    height?: number;
    dimensionsKnown: boolean;
    accepted: boolean;
    reason?: string;
}
/** 可供替换比较的最小质量形状。 */
export interface SnsOriginalQuality {
    bytes: number;
    width?: number;
    height?: number;
}
/** 没有 XML 尺寸时，短边低于这个值的一律视为预览图。 */
export declare const SNS_ORIGINAL_MIN_SHORT_EDGE = 320;
/** 没有 XML 尺寸时，长边低于这个值的一律视为预览图。 */
export declare const SNS_ORIGINAL_MIN_LONG_EDGE = 480;
/** 与 XML `<size>` 比对时允许的尺寸容差（横竖旋转按长短边排序后比较）。 */
export declare const SNS_ORIGINAL_DIMENSION_TOLERANCE = 0.85;
/** 尺寸读不出时，候选字节数至少要有 XML 声明大小的这个比例。 */
export declare const SNS_ORIGINAL_UNKNOWN_BYTES_RATIO = 0.5;
/**
 * 读取图片宽高。支持 JPEG/PNG/WebP/GIF/BMP 与带 `ispe` 的 HEIC/AVIF。
 * @param bytes - 图片字节。
 * @returns 宽高；格式不支持或头部残缺时返回 `null`（不猜）。
 */
export declare function readImageDimensions(bytes: Uint8Array): ImageDimensions | null;
/**
 * 判断一份字节是否够格当朋友圈原图。
 *
 * 规则：
 *   · 有 XML `<size>`：按长短边排序后与期望尺寸比较，允许横竖旋转，容差 15%；
 *   · 没有 XML `<size>`：短边 < 320 或长边 < 480 的已知小图直接拒绝；
 *   · 读不出尺寸：有 XML 字节数时至少要有它的一半，否则保留 legacy 兼容。
 *
 * @param bytes - 候选图片字节。
 * @param expected - XML `<size>` 的预期；没有时按绝对下限判断。
 * @returns 是否接受及可读的拒绝原因。
 */
export declare function evaluateSnsOriginal(bytes: Uint8Array, expected?: SnsOriginalExpectation): SnsOriginalEvaluation;
/**
 * 比较两张候选图谁更适合作为原图缓存。
 * @returns 正数表示 `candidate` 更好，负数表示 `current` 更好，0 表示没有明确高下。
 */
export declare function compareSnsOriginalQuality(candidate: SnsOriginalQuality, current: SnsOriginalQuality): number;
