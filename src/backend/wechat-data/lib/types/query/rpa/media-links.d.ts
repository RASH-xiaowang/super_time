import type { RpaBuildDeps, RpaImageLink, RpaRecordContext } from './types.ts';
import type { RpaTriggerConfig, RpaVendorDescriptor } from '../../types-rpa.ts';
/**
 * 生成一个签名直链。
 *
 * 由装配层（`remotes/task-center.ts`）按当前配置构造：读 `api_token` 派生密钥、挑一个
 * 可达基址、拼出 URL。**不抛异常**：拿不到地址时返回 `{ error }`，由调用方写进那一张图片。
 * @param rel - decoded 根内的相对路径（调用方已过 `isSafeRpaMediaRel`）。
 * @returns 成功时 `{ url }`；不可用时 `{ error }`。
 */
export type RpaMediaLinkFactory = (rel: string) => {
    url: string;
} | {
    error: string;
};
/**
 * 这次投递的参数里有没有需要签名直链的来源（`imagesJson` / `firstImageUrl`）。
 *
 * 投递前用它决定要不要解码图片并签直链：没用到图片的任务（绝大多数）不该为此付
 * 解码 + 落盘的代价，也不该在没打开局域网访问时平白多出一条错误。`imageCount`
 * 刻意**不在这里**：它只取 `record.images.length`，既不需要解码，也不需要监听面。
 * 判定按**原始配置**走（`extrasField` 的缺省值是空列表，不需要先合并默认值）。
 * @param descriptor - 厂商描述符。
 * @param config - 任务配置（`triggerConfig`）。
 * @returns 用到需要直链的来源时为 true。
 */
export declare function usesImageParamSources(descriptor: RpaVendorDescriptor, config: RpaTriggerConfig): boolean;
/**
 * 逐张生成投递形态的图片条目（与 `record.images` 顺序一一对应）。
 *
 * 用 `fileOnly` 解码：链接只能指向**磁盘上真实存在的文件**，所以拿不到文件路径就如实写
 * `error`，不回退成 data URL（那等于又回到 base64，与这一层的目的相反）。
 * @param record - 触发记录快照（含图片引用清单）。
 * @param deps - 解码依赖（解码缓存根 + 解码函数）。
 * @param media - 链接工厂；缺省时每张都写「未打开局域网访问」。
 * @returns 与 `record.images` 等长的条目数组。
 */
export declare function buildRpaImageLinks(record: RpaRecordContext, deps: RpaBuildDeps, media?: RpaMediaLinkFactory): Promise<RpaImageLink[]>;
/**
 * `imagesJson` 值来源的取值：整份图片清单的 JSON。
 *
 * 形状固定为 `[{localId, createTime, sender, md5?, url?, error?}]` —— 机器人侧按数组解析；
 * 没带上的那张在同一个数组里用 `error` 说明原因（不静默少一张，否则对端无从察觉）。
 * @param links - `buildRpaImageLinks` 的结果。
 * @returns JSON 字符串（空清单为 `[]`）。
 */
export declare function imagesJsonOf(links: readonly RpaImageLink[]): string;
/**
 * `firstImageUrl` 值来源的取值：第一张**成功生成链接**的地址。
 *
 * 为什么不是「第一张的地址」：第一张可能解码失败，这时发空串比发一个取不到的地址更诚实
 * （单图工作流最常用这个来源）。一张都没成功时返回空串。
 * @param links - `buildRpaImageLinks` 的结果。
 * @returns 绝对 URL 或空串。
 */
export declare function firstImageUrlOf(links: readonly RpaImageLink[]): string;
