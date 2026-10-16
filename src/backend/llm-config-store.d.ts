/**
 * `llm-config-store.js` 的类型面 —— **手写**声明，不是构建产物。
 *
 * LLM 配置仓库从 `wechat-paths.js` 拆出后独立对外提供服务，但宿主 CommonJS
 * 不在现有 TypeScript 构建里。此声明与 `wechat-paths.d.ts` 共用 LLM 配置类型，
 * 并由 `tests/host-decl-alignment.spec.ts` 对 `module.exports` 做双向差集。
 * 只声明公开入口；读取、归一化与落盘的内部流程不在这里露面。
 */
import type {
  LlmConfig,
  LlmStore,
  UpsertLlmProfileInput,
} from './wechat-paths';

/** `createLlmConfigStore` 的注入面：路径来源只通过这一个函数注入。 */
export interface LlmConfigStoreOptions {
  getConfigPath: () => string;
}

/**
 * `resolveLlmConfig` 的产物：与旧 `llmConfigFromEnv()` 返回值完全同形。
 * 文件层用 `apiUrl`，解析产物统一对外叫 `baseUrl`。
 */
export interface ResolvedLlmConfig extends Omit<LlmConfig, 'apiUrl'> {
  baseUrl: string;
}

/** `resolveLlmConfig` 的三层输入。 */
export interface LlmConfigResolveInputs {
  overrides?: unknown;
  file?: Partial<LlmConfig> | null;
  env?: NodeJS.ProcessEnv | null;
}

/** LLM 配置仓库：读取、保存与 profile 切换的宿主层门面。 */
export interface LlmConfigStore {
  defaultLlmConfig(): LlmConfig;
  loadLlmConfig(): LlmConfig;
  saveLlmConfig(config: Partial<LlmConfig>): LlmConfig;
  loadLlmStore(): LlmStore;
  activateLlmProfile(id: string): LlmStore;
  upsertLlmProfile(options?: UpsertLlmProfileInput): LlmStore;
  deleteLlmProfile(id: string): LlmStore;
  LLM_PROFILE_FIELDS: string[];
}

/**
 * 创建一个 LLM 配置仓库。所有文件路径经 `getConfigPath` 注入，
 * 不依赖 `wechat-paths.js` 的内部状态。
 */
export function createLlmConfigStore(options: LlmConfigStoreOptions): LlmConfigStore;

/**
 * 合并 overrides > file > env > shared defaults 四层，产出桥接层使用的扁平配置。
 * `file.apiUrl` 映射为返回值的 `baseUrl`；空串与 0 都按「该层未提供」继续回落。
 */
export function resolveLlmConfig(inputs?: LlmConfigResolveInputs): ResolvedLlmConfig;
