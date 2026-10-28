# website/ 静态站点

GitHub Pages 直接发布本目录（见 `.github/workflows/pages.yml`，会先 `rsync --exclude 'tests/'`）。

## 客户案例数据

案例卡片由 `index.html` 中 `#caseData` 的 JSON 数组渲染，筛选与展开交互由页面脚本统一处理。新增案例时只需追加一个对象：

| 字段 | 说明 |
| --- | --- |
| `order` | 展示序号 |
| `category` | 筛选用场景键，需与筛选按钮的 `data-filter` 一致 |
| `categoryLabel` | 卡片上的场景标签 |
| `title` / `summary` | 案例标题与一句话摘要 |
| `client.role` / `client.scale` | 客户类型与数据规模 |
| `pain` | 核心痛点 |
| `solution` | 解决方案条目数组 |
| `effect` | 使用成效说明 |
| `metrics` | 2–3 个关键指标，每项包含 `value` 与 `label` |

客户名称、群名与原始消息应先脱敏；指标需保留真实统计口径，并注明结果会随数据规模、设备与配置变化。

## 本地预览

直接双击 `index.html` 即可（纯静态，无构建步骤）。
