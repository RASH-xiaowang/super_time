/**
 * `wechat-host.js` 的类型面 —— **手写**声明，不是构建产物。
 *
 * 宿主适配层把 `wechat-data` 的 ESM bundle 接到 Electron 主进程：最小 Cordis
 * Context、结果缓存、SQLite 页缓存收紧与 Remote 调用折叠都在这里。宿主 CommonJS
 * 不参与现有 TS 构建，这份声明由 `tests/host-decl-alignment.spec.ts` 对
 * `module.exports` 做双向差集；bundle 内部形状保持开放，不伪造具体类名。
 */
import type { LlmBridge, LlmBridgeConfigOverrides } from './llm-bridge';

/** `createWechatBackend` 的入参。 */
export interface WechatBackendOptions {
  userDataPath?: string;
  onEvent?: (name: string, args: unknown[]) => void;
  llmConfig?: LlmBridgeConfigOverrides;
}

/** 后端 `info()` 的返回：路径、账号、方法与入参守卫账本。 */
export interface ArgGuardSnapshot {
  covered: number;
  total: number;
  uncovered: number;
  enforced: string[];
  mismatched: string[];
  largest: Array<{ method: string; maxBytes: number }>;
}

export interface WechatBackendInfo {
  root: string;
  decrypted: string;
  decoded: string;
  selfUsername: unknown;
  pathConfig: string;
  methods: string[];
  llmConfigured: boolean;
  argGuard: ArgGuardSnapshot;
}

/** 折叠后的 Remote 调用信封。 */
export interface WechatCallResult {
  ok: boolean;
  value?: unknown;
  error?: {
    message: string;
    code?: string;
    details?: unknown;
  };
}

/** `createWechatBackend` 返回的后端句柄。 */
export interface WechatBackend {
  gateway: any;
  context: any;
  methodNames(): string[];
  info(): WechatBackendInfo;
  call(method: string, args?: unknown[], callHandle?: string): Promise<WechatCallResult>;
  cancelCall(
    method: string,
    args?: unknown[],
    callHandle?: string,
  ): Promise<Record<string, unknown>>;
  _cancelJob(
    cancelMethod: string,
    jobId: string,
    cancelFn?: (input: { jobId: string }) => unknown,
  ): Promise<Record<string, unknown>>;
  dispose(): void;
}

/** 最小 Cordis Context 的入参。 */
export interface MiniContextOptions {
  llm?: LlmBridge;
  llmConfig?: LlmBridgeConfigOverrides;
  agentDefaultModel?: {
    currentSelection?: () => { provider: string; model: string } | undefined;
  };
  settings?: {
    get: (key: string) => unknown;
  };
  onEvent?: (name: string, args: unknown[]) => void;
}

/** `createMiniContext` 返回的上下文；只承诺运行时真正使用的面。 */
export interface MiniContext {
  llm: LlmBridge;
  agentDefaultModel: {
    currentSelection?: () => { provider: string; model: string } | undefined;
  };
  settings: {
    get: (key: string) => unknown;
  };
  reflect: {
    provide: (name: string, value: unknown) => unknown;
  };
  effect: (fn: () => unknown, label?: string) => unknown;
  emit: (name: string, ...args: unknown[]) => void;
  plugin: () => never;
  dispose: () => void;
}

/** 结果缓存的把手：键构造、读写、定向失效与当前大小。 */
export interface ResultCacheHandles {
  key: (method: string, callArgs: unknown[], decodeSig?: string) => string | null;
  read: (key: string | null) => unknown;
  write: (key: string | null, result: unknown) => void;
  clearStale: () => void;
  clearAll: () => void;
  size: () => number;
}

/**
 * 创建 Super Time 后端实例；bundle 与 typert 协议在首次调用时动态加载。
 */
export function createWechatBackend(options?: WechatBackendOptions): Promise<WechatBackend>;

/** LLM 桥接工厂；实现与 `llm-bridge.js` 的同一函数一致。 */
export function createLlmBridge(configOverrides?: LlmBridgeConfigOverrides): LlmBridge;

/** 创建 `wechat-data` 实际用到的最小 Cordis Context。 */
export function createMiniContext(options?: MiniContextOptions): MiniContext;

/** 导出结果缓存的键构造 / 读写 / 失效入口（单测用）。 */
export function resultCacheHandles(): ResultCacheHandles;

/** 把底层英文错误翻译成用户能照着做的一句话；表外形态原样透传。 */
export function readableCallError(method: string, err: unknown): string;
