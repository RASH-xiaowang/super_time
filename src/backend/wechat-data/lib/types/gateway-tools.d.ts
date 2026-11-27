import type { LocalToolInput, LocalToolMutationResult, LocalToolSaveResult, LocalToolsSnapshot } from './types.ts';
import { type LocalToolConfigSaveResult } from './query/reply-tool-config.ts';
import type { LocalToolConfig, LocalToolConfigInput } from './types.ts';
import { GatewayTaskCenter } from './gateway-taskcenter.ts';
export declare abstract class GatewayTools extends GatewayTaskCenter {
    /**
     * 本机全部可用工具的清单（问答检索 / AI 回复 / 出网触发 / 本机能力 + 自定义）。
     *
     * 清单从各注册表**现算**：新增/停用/删除工具后界面自动反映，不需要改前端，
     * 也不会与「文档里写了、界面没有」漂移。结果不含凭据，也不触发任何数据读取。
     * @returns 四组工具 + 自定义工具 + 分组元信息。
     */
    getLocalTools(): LocalToolsSnapshot;
    /**
     * AI 回复工具的配置快照（天气数据源 / 使用方式 / 搜索服务 + 密钥是否已保存）。
     *
     * 卡片上写着「待配置」的工具，靠这里判定的四个配置项解锁。**密钥永不回读**：
     * 只回 `apiKeySaved`，与任务中心的凭据同一口径。
     * @returns 配置快照 + 可选项（下拉不硬编码在前端）。
     */
    getLocalToolConfig(): LocalToolConfig;
    /**
     * 保存 AI 回复工具的配置。
     *
     * 只写「出现的字段」；密钥写进 `secrets.json`（`saveConfig` 的密钥族），
     * `config.json` 里永远不留它们。保存后工具卡片的「待配置」当场变成「可用」，
     * 因为清单每次都是现读配置算出来的。
     * @param input - 要写入的字段（不可信）。
     * @returns 保存结果（成功时带新快照）。
     */
    saveLocalToolConfig(input: LocalToolConfigInput): LocalToolConfigSaveResult;
    /**
     * 新建或更新一条自定义工具。
     *
     * 校验全在 `validateCustomTool`（名字形状、目标必须存在、固定参数必须在目标 schema 里…）：
     * 一条执行不了的 alias 比拒绝保存更糟，它会在模型调用时才失败。
     * @param input - 工具配置（不可信输入）。
     * @returns 保存后的卡片；失败带可读原因。
     */
    saveLocalTool(input: LocalToolInput): LocalToolSaveResult;
    /**
     * 删除一条自定义工具。**内置工具不可删除**（只能停用）。
     * @param options - `name` 为工具调用名。
     * @returns 是否删除成功。
     */
    deleteLocalTool(options: {
        name: string;
    }): LocalToolMutationResult;
    /**
     * 启用/停用一个工具（内置或自定义）。
     *
     * 停用内置 = 写一条覆盖行；停用自定义 = 改它自己那一行的 `enabled`。
     * 安全阀：不允许把「问答题工具」全部停用 —— 那样问答会拿到零工具，
     * 模型只能说「没有能力」，而这种状态用户很难自己看出来。
     * @param options - `name` 为工具调用名，`enabled` 为目标状态。
     * @returns 是否生效。
     */
    setLocalToolEnabled(options: {
        name: string;
        enabled: boolean;
    }): LocalToolMutationResult;
    /** 停用后是否一个问答工具都不剩了（只算检索 + 自定义）。 */
    private wouldLeaveNoAskTool;
}
