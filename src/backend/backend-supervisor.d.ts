/**
 * `backend-supervisor.js` 的类型面 —— **手写**声明，不是构建产物。
 *
 * 后端 utilityProcess 的生命周期监管器原先住在 `main.js` 的组合根里；抽成独立
 * 模块后，其公开面（监管器、重启上限、退避序列与就绪等待上限）值得让消费方与
 * 单测拿到真实类型。本声明由 `tests/host-decl-alignment.spec.ts` 对
 * `module.exports` 做双向差集；Electron 对象保持注入面形状，不承诺内部实现。
 */

/** 依赖里要求的 Electron utilityProcess 最小面。 */
export interface BackendUtilityProcess {
  fork(
    entry: string,
    args: readonly string[],
    options: {
      serviceName: string;
      stdio: string;
      env: NodeJS.ProcessEnv;
    },
  ): unknown;
}

/** backend-rpc 返回的工作通道。 */
export interface BackendWorkerChannel {
  init(): Promise<unknown>;
  dispose(): void;
  call(method: string, args: unknown[]): Promise<unknown>;
}

/** `createBackendSupervisor` 的注入面；Electron、文件系统与定时器均可被测试替换。 */
export interface BackendSupervisorDeps {
  isPackaged: boolean;
  env?: NodeJS.ProcessEnv;
  utilityProcess: BackendUtilityProcess;
  diagLog: { write: (level: string, args: unknown[]) => void };
  resolveHangMethods: (input: { isPackaged: boolean; env: NodeJS.ProcessEnv }) => string[];
  DEBUG_HANG_ENV: string;
  createWorkerChannel: (
    child: any,
    options: any,
  ) => BackendWorkerChannel;
  onEvent: (name: string, args: unknown[]) => void;
  loadWechatSettings: () => Record<string, unknown>;
  mirroredSecretValues: () => Record<string, unknown>;
  restrictWechatState: (input: Record<string, unknown>) => { ok: boolean; failures: string[] };
  stateDir: string;
  fs: {
    existsSync: (path: string) => boolean;
    readFileSync: (path: string, encoding: string) => string;
  };
  path: {
    join: (...parts: string[]) => string;
    dirname: (path: string) => string;
  };
  applyConfig: () => void;
  recordResolved: (info: unknown) => void;
  log?: {
    log: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
  callTimeoutMs?: number;
  longTimeoutMs?: number;
  restartMax?: number;
  restartBackoffMs?: number[];
  readyWaitMs?: number;
  setTimeoutFn?: (handler: () => void, timeout?: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
  setIntervalFn?: (handler: () => void, timeout?: number) => unknown;
  clearIntervalFn?: (handle: unknown) => void;
}

/** 对外广播的后端状态快照。 */
export interface BackendStatus {
  state: string;
  restarts: number;
  lastError: unknown;
}

/** 监管器句柄：启动、恢复与停止后端，并暴露只读状态。 */
export interface BackendSupervisor {
  readonly backend: BackendWorkerChannel | null;
  readonly boot: Record<string, unknown> | null;
  readonly status: BackendStatus;
  readonly isStopping: boolean;
  waitUntilReady(timeoutMs?: number): Promise<boolean>;
  bootstrap(
    userData: string,
  ): Promise<{
    ok: boolean;
    backend?: BackendWorkerChannel;
    boot?: Record<string, unknown>;
    error?: unknown;
  }>;
  stop(): void;
  _test: {
    start: (userData: string) => Promise<BackendWorkerChannel>;
    scheduleRestart: (reason: string) => void;
    setStatus: (state: string, lastError?: unknown) => void;
  };
}

export function createBackendSupervisor(deps: BackendSupervisorDeps): BackendSupervisor;

/** 同一轮生命周期里允许的连续重启上限。 */
export const BACKEND_RESTART_MAX: number;

/** 连续重启的退避毫秒序列；越界取最后一项。 */
export const RESTART_BACKOFF_MS: number[];

/** 有调用等待后端就绪时使用的默认上限（毫秒）。 */
export const BACKEND_CALL_READY_WAIT_MS: number;
