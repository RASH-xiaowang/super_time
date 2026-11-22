# apps/website/ 静态站点

GitHub Pages 直接发布本目录（见 `.github/workflows/pages.yml`，会先 `rsync --exclude 'tests/'`）。本目录保持纯静态：直接打开 `index.html` 即可预览，没有构建步骤，也不改成框架工程。

## 版本与下载

页面必须区分「本机产品版本」与「公开可下载版本」：

- 下载按钮上的版本号、安装包文件名、SHA256 与发布说明链接，必须以 GitHub Releases 的**实际最新公开 Release** 为准。
- 若仓库里的产品版本尚未作为 GitHub Release 发布，不得写成「立即下载 <产品版本>」，也不得把该文案指向 `/releases/latest`（那会把访客带到仍可能是旧包、或将来变成新包却与文案不符的入口）。
- 不要删除历史 Release。更改 Pages 工作流路径后也不要在未授权时推送。

当前页面口径（更新时请再核对一次公开 Release）：

- 公开可下载版本：**1.2.1**（`Super-Time-Setup-1.2.1.exe`，发布于 2026-11-16）
- 本机产品版本：**1.4.1**（已在仓库中，尚未作为 GitHub Release 发布）

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

直接用浏览器打开本目录下的 `index.html` 即可（纯静态，无构建步骤）。本机路径例如：

`C:\Users\Administrator\super-time-wechat\apps\website\index.html`

也可使用 `file:///C:/Users/Administrator/super-time-wechat/apps/website/index.html`。

冒烟测试（不启动 Super Time，不触碰真实微信数据）：

```
cd apps/website && NODE_PATH=../../node_modules node tests/smoke.js
```
