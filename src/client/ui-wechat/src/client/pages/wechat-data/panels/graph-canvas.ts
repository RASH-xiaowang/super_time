/**
 * 图谱绘制层：把一张图（节点 + 边 + 坐标）画到 `CanvasRenderingContext2D` 上，并导出为矢量 SVG。
 *
 * 为什么自己画而不是继续用 ECharts `series.graph`：
 *   ① 节点要显示**头像**。ECharts 的 `symbol:'image://'` 画的是方图，只能先把每张头像重新编码成
 *      「圆形裁剪 + PNG data URL」再喂给它 —— 等于为了一个圆形多存/多解一份位图，而且换尺寸就得重编；
 *      自己画则是 `clip()` 一次，缩放、描边环、选中光环都是原生操作。
 *   ② 悬停高亮、社区聚焦淡出、标签防重叠这些局部状态，用 ECharts 只能整图 `setOption` 再靠它内部
 *      合并，每帧要重建整份数据项；这里是「读一遍数组、画一遍」，代价与状态数量无关。
 *   ③ SVG 导出：ECharts 得另起一个 SVGRenderer 实例重画一遍；这里同一份 `Scene` 直接序列化成
 *      矢量（边是 `<line>`、环是 `<circle>`、头像夹 `<clipPath>`），导出与屏幕所见同源，不会走样。
 *
 * 视觉规格取自两个参考实现：图底/连线/枢纽标签策略来自 graphify 的 vis-network 导出
 * （`graphify/exporters/html.py`），头像圆盘 + 社区色描边环、悬停把非邻居混色淡出、标签带
 * 描边光晕来自 llm_wiki 的 sigma 视图与 tree 视图（`tree_html.py` 的 `paint-order: stroke fill`）。
 *
 * 本模块不 import react，也不碰 DOM 之外的东西（只接 ctx + 数据）：相机数学、命中测试、
 * 尺寸映射、标签排布都是可直接单测的纯函数。
 */

export * from './graph-canvas-theme.ts'
export * from './graph-canvas-geometry.ts'
export * from './graph-canvas-render.ts'
