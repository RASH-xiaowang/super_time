# website/ 静态站点

GitHub Pages 直接发布本目录（见 `.github/workflows/pages.yml`，会先 `rsync --exclude 'tests/'`）。

## 使用场景数据

场景卡片由 `index.html` 中 `#scenarioData` 的 JSON 数组渲染，筛选与展开交互由页面脚本统一处理。新增场景时只需追加一个对象：

| 字段 | 说明 |
| --- | --- |
| `order` | 展示序号 |
| `category` | 筛选用场景键，需与筛选按钮的 `data-filter` 一致 |
| `categoryLabel` | 卡片上的场景标签 |
| `title` / `summary` | 场景标题与一句话摘要 |
| `audience` | 适用对象 |
| `prerequisites` | 系统、数据、账号或外部服务的使用前提 |
| `problem` | 常见问题 |
| `capabilities` | 2–3 个涉及的当前能力 |
| `approach` | 操作路径条目数组 |
| `boundary` | 明确限制与不保证的事项 |

这些卡片是场景说明，不是客户案例或客户证言。禁止编造客户名称、使用经历、耗时、提效比例或成功结果；如确有可核验的客户素材，应先取得公开授权并保留统计口径，再另设带来源的案例区块。

## 本地预览

直接双击 `index.html` 即可（纯静态，无构建步骤）。
