import type { LocalToolParam, LocalToolsSnapshot } from '../types-local-tools.ts';
/**
 * 从 JSON Schema 提取参数摘要。
 * @param parameters - 工具的 `parameters`（JSON Schema 对象）。
 * @returns 参数列表（保持 schema 里的声明顺序）；没有 properties 时为空数组。
 */
export declare function paramSummaries(parameters: Record<string, unknown> | undefined): LocalToolParam[];
/**
 * 组装「本地工具」快照。
 *
 * 每次调用都**现读**注册表与覆盖表：工具页的增删改、以及问答链路读到的工具集，
 * 用的是同一份数据 —— 所以「前端改完立即生效」不需要任何额外的缓存失效协议。
 * 自定义工具排在检索组之后（它们天然属于「问答工具」这一族）。
 * @param decryptedDir - 解密数据根（回复工具的就绪状态与工具配置都读它）。
 * @returns 四组工具 + 自定义工具 + 分组元信息。
 */
export declare function queryLocalTools(decryptedDir: string): LocalToolsSnapshot;
