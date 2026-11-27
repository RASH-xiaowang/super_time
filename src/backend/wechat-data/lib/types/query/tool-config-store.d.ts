import type { DatabaseSync } from './db-open.ts';
import { taskErrorText } from './task-center-utils.ts';
import type { LocalToolFixedValue, LocalToolKind } from '../types-local-tools.ts';
/** 一条自定义工具（整行都是数据）。 */
export interface CustomToolRecord {
    name: string;
    title: string;
    description: string;
    kind: Exclude<LocalToolKind, 'builtin'>;
    target: string;
    fixed: Record<string, LocalToolFixedValue>;
    answer: string;
    expose: string[];
    enabled: boolean;
    updatedAt: number;
}
/** 一条内置工具覆盖（只允许改标题/说明/启停）。 */
export interface ToolOverrideRecord {
    title: string;
    description: string;
    enabled: boolean;
}
/** 读到的全部配置。 */
export interface ToolConfigSnapshot {
    custom: CustomToolRecord[];
    overrides: ReadonlyMap<string, ToolOverrideRecord>;
}
/** 空快照（库还不存在时用；调用方不必判 null）。 */
export declare const EMPTY_TOOL_CONFIG: ToolConfigSnapshot;
/** 建表（每个写连接都会执行一次；`IF NOT EXISTS` 幂等）。 */
export declare function ensureToolConfigSchema(db: DatabaseSync): void;
/**
 * 读全部工具配置。
 *
 * 库不存在时返回空快照而**不建库**：只打开工具页不该凭空造出一个任务库文件。
 * @param decryptedDir - 解密数据根。
 * @returns 自定义工具 + 内置覆盖。
 */
export declare function readToolConfig(decryptedDir: string): ToolConfigSnapshot;
/**
 * 写入一条自定义工具（按 name upsert）。
 * @param decryptedDir - 解密数据根。
 * @param record - 已校验过的整行。
 */
export declare function upsertCustomTool(decryptedDir: string, record: CustomToolRecord): void;
/** 删除一条自定义工具；返回是否真的删掉了。 */
export declare function deleteCustomTool(decryptedDir: string, name: string): boolean;
/**
 * 写入内置工具的覆盖（标题/说明/启停）。
 *
 * 只接受已存在的内置工具名 —— 否则这条覆盖会变成一条「看不见也删不掉」的幽灵行。
 * @param decryptedDir - 解密数据根。
 * @param name - 内置工具调用名。
 * @param patch - 要覆盖的字段。
 */
export declare function upsertToolOverride(decryptedDir: string, name: string, patch: {
    title: string;
    description: string;
    enabled: boolean;
}): void;
/** 把一条覆盖恢复成内置默认（删掉覆盖行）。 */
export declare function clearToolOverride(decryptedDir: string, name: string): void;
/** 错误文本（与任务中心同口径，避免第二份实现）。 */
export declare const toolConfigErrorText: typeof taskErrorText;
