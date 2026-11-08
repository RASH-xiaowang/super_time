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
 * 生成表缺口（2026-10-30）。
 *
 * 这些方法都已有真实 `@Remote` 声明，但不在 `typert.host.js` 的 invocation 表中。
 * 2026-10-22 先补齐了四个历史缺口；2026-10-30 又把 AI 回复与消息列表
 * 新增的方法面登记进来，确保它们参与入参形状影子校验，而不是
 * 通过抬高未覆盖上限来“通过”门禁。
 */
export declare const REMOTE_ARG_SCHEMA_OVERLAY: readonly RemoteArgSchemaOverlayEntry[];
