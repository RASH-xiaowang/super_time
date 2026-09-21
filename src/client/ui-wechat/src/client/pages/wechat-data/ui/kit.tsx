/**
 * 本地微信数据管理 · UI Kit
 *
 * 面板重构的共享组件层：设计令牌来自 scifi-theme.css 的 --nm-* 变量，交互
 * 原语基于 Radix（Dialog/Tabs/ToggleGroup/Tooltip/Select），表格内核基于 TanStack Table。
 * （长列表虚拟化已移除：见 RELEASE-PLAN 的 M14 —— 现方案是 usePagedList 增量挂载。）
 * 负责外观与交互，不包含任何业务数据逻辑；现有面板的懒加载/实时行为不变。
 */

/**
 * 统一按钮入口。
 *
 * 实现唯一放在 `ui-primitives-shim/Button.tsx`（不在此处再造一个 Button，
 * 否则又会变成两套）。从这里再导出，是为了让面板只认一个 import 面：
 * 需要按钮时 `import { Button } from '../ui/kit.tsx'`。
 *
 * 迁移背景：面板里仍有 271 个裸 `<button>`，配套的自定义类至少有
 * `.catBtn`(9 个文件) / `.tabBtn`(6) / `.linkBtn`(6) / `.statChip`(6) / `.miniBtn`(3) …，
 * 禁用态出现过 0.4/0.45/0.5/0.55/0.6 五种透明度，且几乎都没有 :focus-visible。
 */
export { Button } from '@deepseek-ai/dsh-client-ui-primitives'
export type { ButtonVariant } from '@deepseek-ai/dsh-client-ui-primitives'

export * from './kit-shell.tsx'
export * from './kit-table.tsx'
export * from './kit-overlay.tsx'
export * from './kit-fields.tsx'
export * from './kit-foldable.tsx'
