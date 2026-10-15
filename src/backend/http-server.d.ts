/**
 * `http-server.js` 的类型面 —— **手写**声明，不是构建产物。
 *
 * 局域网远程访问服务把桌面端同一套 Remote 方法暴露给手机浏览器。宿主 CommonJS
 * 不在现有 TS 构建里，此声明只描述模块的公开常量、纯函数与服务句柄，并由
 * `tests/host-decl-alignment.spec.ts` 对 `module.exports` 做双向差集。
 * `http.IncomingMessage`、SSE 响应等 Electron/Node 内部细节不在这里承诺。
 */

/** 默认端口（与 `config/wechat-config.ts` 同口径）。 */
export const DEFAULT_PORT: number;

/** 端口被占用时向后尝试的个数。 */
export const PORT_ATTEMPTS: number;

/** SSE 心跳间隔（毫秒）。 */
export const SSE_HEARTBEAT_MS: number;

/** 请求体上限（字节）。 */
export const MAX_BODY_BYTES: number;

/** 接收完整请求的硬时限（毫秒）。 */
export const REQUEST_TIMEOUT_MS: number;

/** 一个可用的局域网 IPv4 地址。 */
export interface LanAddress {
  address: string;
  family: string;
  iface: string;
  score: number;
}

/** 远程访问配置的三个有效字段。 */
export interface RemoteAccessConfig {
  enabled: boolean;
  port: number;
  token: string;
}

/** 登录限速器。 */
export interface AuthLimiter {
  ok(ip: string): boolean;
  fail(ip: string): void;
  succeed(ip: string): void;
  reset(): void;
}

/** 服务当前状态快照；不包含令牌原文。 */
export interface RemoteAccessState {
  running: boolean;
  port: number;
  address: string;
  preferredPort: number;
  enabled: boolean;
  hasToken: boolean;
  startedAt: number;
  [k: string]: unknown;
}

/** `createRemoteAccessServer` 的注入面。 */
export interface RemoteAccessDeps {
  getDataRoot: () => string;
  getUiDistDir: () => string;
  gatedCall: (method: string, args: unknown[]) => Promise<unknown>;
  callQueue?: unknown;
  pairings?: unknown;
  authLimiter?: AuthLimiter;
  appVersion: string;
  log?: (message: string, ...rest: unknown[]) => void;
  warn?: (message: string, ...rest: unknown[]) => void;
  bindHost?: string;
}

/** 远程访问服务句柄。 */
export interface RemoteAccessServer {
  start(): Promise<RemoteAccessState>;
  stop(): Promise<RemoteAccessState>;
  getState(): RemoteAccessState;
  pushEvent(name: string, args: unknown[]): void;
  syncWithConfig(): Promise<RemoteAccessState>;
  refreshBinding(): Promise<void>;
  isRunning(): boolean;
  issuePairingCode(): string;
}

/** 本机可用于局域网访问的 IPv4 地址（已按适配度排序）。 */
export function lanAddresses(): LanAddress[];

/** 读取远程访问配置；数据根无效或文件损坏时回落默认关闭状态。 */
export function readRemoteAccessConfig(dataRoot: string): RemoteAccessConfig;

/** Host 头只接受当前监听地址，挡住 DNS rebinding。 */
export function isHostAllowed(
  authority: string | undefined,
  expectedAddress: string,
  expectedPort: number,
): boolean;

/** 建一个令牌试错滑动窗口限速器。 */
export function createAuthLimiter(): AuthLimiter;

/** 建一个远程访问服务。 */
export function createRemoteAccessServer(deps: RemoteAccessDeps): RemoteAccessServer;
