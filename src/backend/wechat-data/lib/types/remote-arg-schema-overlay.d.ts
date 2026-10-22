/** 与 Typert 调用表同形的最小参数部分（只保留守卫真正读取的字段）。 */
export interface RemoteArgSchemaOverlayEntry {
    method: string;
    parameters: Array<{
        codec: {
            mode: 'strict';
            schema: unknown;
        };
    }>;
}
/**
 * 生成表缺口（2026-10-22）。
 *
 * 四个方法都已有真实 `@Remote` 声明，但不在 `typert.host.js` 的 invocation 表中：
 * - `getSelfProfile` / `listRpaVendors`：零参数；
 * - `getFileImageDataUrls`：批量文件图片，`keys` 必填、`thumbFirst` 可选；
 * - `revealTaskTriggerSecret`：任务 id 必填。
 */
export declare const REMOTE_ARG_SCHEMA_OVERLAY: readonly RemoteArgSchemaOverlayEntry[];
