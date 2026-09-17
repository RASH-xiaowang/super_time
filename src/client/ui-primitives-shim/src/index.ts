/**
 * Super Time 轻量 UI 原语 shim。
 *
 * 仅迁移原 @deepseek-ai/dsh-client-ui-primitives 中实际被 Super Time 使用的：
 * Button / Input / Pill / StateDot + 全部图标；不再捆绑 shiki、katex、
 * markdown/micromark 等重量级依赖，显著降低构建体积与运行时内存。
 */
export { Button } from './Button.tsx'
export type { ButtonVariant } from './Button.tsx'
export { Input } from './Input.tsx'
export { Pill } from './Pill.tsx'
export { StateDot } from './StateDot.tsx'
export type { StateDotState } from './StateDot.tsx'
export * from './icons/index.tsx'
