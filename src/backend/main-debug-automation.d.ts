/**
 * `main-debug-automation.js` 的手写类型声明。
 *
 * 只暴露 `main.js` 与单测需要的那一小块契约，不承诺页面内部 DOM 结构；
 * 与其它宿主层 `.d.ts` 一样由 `host-decl-alignment.spec.ts` 做双向差集校验。
 */

export const DEFAULT_DELAY_MS: number;
export function clickLabels(env?: NodeJS.ProcessEnv): string[];
export function scrollTarget(env?: NodeJS.ProcessEnv): number;

export interface ScreenshotWebContents {
  executeJavaScript(code: string): Promise<unknown>;
  capturePage(): Promise<{ toPNG(): Buffer }>;
}

export function runScreenshotAutomation(options: {
  window?: { webContents?: ScreenshotWebContents };
  env?: NodeJS.ProcessEnv;
  writeFileSync?: (path: string, data: Buffer) => void;
  sleep?: (ms: number) => Promise<void>;
}): Promise<{ started: boolean }>;

export function installScreenshotAutomation(options: {
  getWindow: () => { webContents?: ScreenshotWebContents } | null | undefined;
  app: { quit(): void };
  env?: NodeJS.ProcessEnv;
  initialDelayMs?: number;
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
}): unknown | null;
