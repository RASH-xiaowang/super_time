import type { RetrievalTool } from './tools/types.ts';
import type { CustomToolRecord } from './tool-config-store.ts';
import type { LocalToolInput, LocalToolItem } from '../types-local-tools.ts';
/** 参与工具循环的自定义工具名（`alias`/`answer` 都在内）。 */
export interface CustomToolValidation {
    ok: boolean;
    record?: CustomToolRecord;
    item?: LocalToolItem;
    error?: string;
}
/**
 * 校验并归一一条工具输入。
 *
 * 校验顺序刻意按「先便宜后昂贵」：名字形状 → 是否撞内置 → 类型分支。
 * `existing` 只在更新时传，用于区分「改自己」与「撞别人」。
 * @param input - 前端提交的原始字段（不可信）。
 * @param existing - 正在更新的自定义工具（新增时缺省）。
 * @returns 校验结果；成功时带上整行记录与投影后的卡片。
 */
export declare function validateCustomTool(input: LocalToolInput | undefined, existing?: CustomToolRecord): CustomToolValidation;
/**
 * 把一条记录投影成卡片（列表与保存回执共用）。
 * @param record - 已校验的记录。
 * @returns 界面用的卡片。
 */
export declare function customItem(record: CustomToolRecord): LocalToolItem;
/**
 * 把启用的自定义工具装成真正的 `RetrievalTool`。
 *
 * 约定与内置工具一致：`run` **不抛错**，失败返回 `{ ok:false, error }`。
 * @param records - 注册表里的自定义工具（停用的会被跳过）。
 * @returns 可直接并入 `buildTools()` 结果数组的工具集。
 */
export declare function buildCustomTools(records: readonly CustomToolRecord[]): RetrievalTool[];
/**
 * 按入口的数据边界裁剪自定义工具。
 *
 * 「禁用微信数据」的入口（无人值守自动回复）里，只有 `answer`（固定文本、不读任何数据）
 * 可以保留；`alias` 可能读到消息，必须一起裁掉 —— 只裁内置工具不裁自定义工具，
 * 等于给数据边界开了一个只有自定义工具能走的旁门。
 * @param tools - 已装配的自定义工具。
 * @param wechatDataEnabled - 本入口是否允许读本机微信数据。
 * @returns 允许出现的工具（保持原顺序）。
 */
export declare function keepCustomToolsForDataBoundary(tools: readonly RetrievalTool[], wechatDataEnabled: boolean): RetrievalTool[];
