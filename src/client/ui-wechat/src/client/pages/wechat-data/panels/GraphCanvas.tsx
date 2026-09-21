/**
 * 图谱画布（React 壳）：接管 ResizeObserver / 指针交互 / 相机 / 头像加载 / 布局调度 / 导出。
 *
 * 分工：绘制与相机数学在 `graph-canvas.ts`（纯函数、可单测），布局在 `graph-layout.ts`
 * （FA2 + Worker + 指纹缓存），本文件只做「把两者接到 React 与事件上」。
 *
 * 对外契约（`GraphCanvasHandle` 与同名 props）与改前的 `EchartsGraphCanvas.tsx` 完全一致，
 * 面板 `Graph.tsx` 只换 import —— 换掉画布实现不该顺带改动面板的行为面。
 *
 * 四处**有意的**行为差异（原因都在对应代码处展开）：
 *   ① 头像是批量拉取（`apiGetAvatarsLocal` 一次请求）而不是逐节点 60 次 RPC；
 *   ② 「适应视图」只动相机，不重排布局；
 *   ③ 「重新布局」从确定性初值重算（`runLayout({fresh:true})`），否则按下去画面不会变；
 *   ④ 悬停命中测试在 rAF 帧里做一次，而不是每个 mousemove 事件都扫一遍节点。
 */

export * from './graph-canvas-support.ts'
export * from './graph-canvas-host.tsx'
