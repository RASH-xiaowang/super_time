# 字体合规与发布边界

本文记录 Super Time 使用字体的策略、已完成审计、随包资产边界和新增字体的登记流程。
结论面向**闭源商业分发**，但不构成法律意见；如遇客户法务审查，请以本文列出的证据和
实际发布产物为准。

## 1. 当前结论

- **UI 不随包分发字体文件**。应用只通过 `system-ui`、`ui-monospace`、`sans-serif`、
  `monospace` 等通用字体族引用操作系统提供的字体，不复制、不嵌入、不上传字体文件。
- **导出内容不嵌入字体**。聊天记录 HTML、图谱 SVG、Canvas 海报和 PNG 只写字体族名，
  由打开导出文件的设备选择本机字体；PNG/JPG 是字形栅格化结果，不是字体软件再分发。
- **PDF.js 标准字体已从发布包排除**。知识库 PDF 解析只调用 `getTextContent()`，
  不渲染 PDF 字形；`pdfjs-dist/standard_fonts/**` 中的 LiberationSans 是
  GPLv2 + 字体例外，不能按 `pdfjs-dist` 的 Apache-2.0 直接处理，因此发布包不再包含
  该目录。`cmaps/**` 仍保留，否则无 ToUnicode 的中文 PDF 会抽不出字。
- **官网、授权工具和开发文档**同样只使用系统字体族名，不加载 Google Fonts 等远程字体。
- **海报合成工具**只接受用户显式提供的 OFL 字体（默认查找 Noto Sans SC /
  Source Han Sans SC），不再硬编码微软雅黑路径。

因此，当前安装包中**不应存在任何 UI 字体文件**。操作系统自带的 Segoe UI、微软雅黑、
苹方等字体受各自系统/厂商 EULA 约束，但本项目没有把它们打包或再分发给最终用户。

## 2. 为什么没有随包字体

闭源商业软件使用系统字体与再分发字体文件是两件事：

| 行为 | 当前是否发生 | 风险判断 |
|---|---|---|
| CSS/Canvas 写 `system-ui` 或通用字体族 | 是 | 不构成字体文件再分发；渲染时使用用户已获授权的系统字体 |
| 安装包携带 `.ttf/.otf/.woff/.pfb` | 否（已加门禁） | 需要单独核对字体许可证、版权声明与再分发条款 |
| HTML/SVG 导出只写字体族名 | 是 | 接收方设备决定最终字形；不携带字体文件 |
| PNG/JPG 导出已栅格化文字 | 是 | 输出的是图片，不是字体软件；仍需避免把专有字体文件当资产分发 |
| 远程加载 Google Fonts / CDN 字体 | 否 | 会带来许可、隐私与离线可用性问题，门禁直接禁止 |

> 如果业务要求“在所有机器上渲染结果完全一致”，就必须自托管一份明确允许商业再分发的
> 字体（推荐 Noto Sans SC 或 Source Han Sans SC，均为 OFL-1.1），并把字体文件、许可证、
> 来源与校验和一起纳入发布资产。不要把 Windows 自带的微软雅黑、Segoe UI 或 macOS 的
> 苹方复制进安装包。

## 3. 已统一的字体族

运行时代码不再点名下列专有字体：

| 旧写法 | 新写法 | 用途 |
|---|---|---|
| Segoe UI / Microsoft YaHei / PingFang SC / Helvetica | `system-ui, sans-serif` | UI、Canvas、SVG、HTML 导出 |
| Cascadia Code / Consolas / Menlo / SFMono | `ui-monospace, monospace` | 日志、路径、代码片段 |
| Arial / Helvetica Neue | `system-ui, sans-serif` | 首帧占位页、调试横幅、拒绝页 |

`system-ui` 与 `ui-monospace` 是 CSS 通用族，不是字体文件，也不是某个厂商的字体名称。
在 Windows 上它们通常解析到系统 UI 字体；在缺少相应字体的设备上由 `sans-serif` /
`monospace` 兜底。版式可能有细微差异，但不会把字体软件带进发布包。

## 4. PDF.js 标准字体

`pdfjs-dist` 的 `standard_fonts/` 目录实际包含：

- `LiberationSans-*.ttf`：Red Hat 的 **GPLv2 + 字体例外**，不是 OFL；
- `Foxit*.pfb`：PDFium 的 BSD-3-Clause 式许可；
- 两份许可证文本：`LICENSE_LIBERATION`、`LICENSE_FOXIT`。

本应用只解析 PDF 文本层，不调用 `render()`，也不传 `standardFontDataUrl`。因此
`electron-builder` 配置显式排除了整个 `node_modules/pdfjs-dist/standard_fonts/**`。
这既移除了 GPL 字体的分发义务，也减少了约 0.8 MB 包体。文本抽取仍依赖：

- `node_modules/pdfjs-dist/legacy/build/pdf.mjs`
- `node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs`
- `node_modules/pdfjs-dist/cmaps/**`

PDF.js 自身仍是 Apache-2.0，`node_modules/pdfjs-dist/LICENSE` 会随包保留。
`pdf.mjs` 内部还有一个约 1.1 KB 的 CFF 测试字形（`_loadTestFont`），它是上游 PDF.js
构建代码的一部分，不会被单独提取为字体资产；如果法务要求安装包内“零字形字节”，
需要单独裁剪上游 PDF.js 构建并重新跑 PDF 回归，不能只改扩展名。

## 5. 新增字体资产的登记流程

新增任何随包字体前，必须同时满足：

1. 许可证明确允许**商业使用与再分发**，推荐 OFL-1.1、Apache-2.0、MIT、BSD-3-Clause、
   CC0-1.0；不接受来源不明、仅“免费下载”或仅允许个人使用的字体；
2. 字体原文件、许可证全文、来源 URL、版本和 SHA-256 一并入仓；
3. 在 [`scripts/font-assets.json`](../scripts/font-assets.json) 登记：

```json
{
  "path": "assets/fonts/NotoSansSC-Regular.otf",
  "license": "OFL-1.1",
  "licenseFile": "assets/fonts/OFL-NotoSansSC.txt",
  "sourceUrl": "https://github.com/notofonts/noto-cjk",
  "version": "2.004",
  "commercialUse": true,
  "sha256": "<64 位小写十六进制>"
}
```

4. 只有 manifest 中登记的字体文件才允许出现在业务源码目录；未登记文件会被门禁拒绝；
5. 新增 `@font-face` 时同步更新本文件与第三方声明；
6. 修改后运行 `npm run font:check`，打包后运行 `npm run font:check:packaged`。

## 6. 自动门禁

| 命令 | 检查范围 |
|---|---|
| `npm run font:check` | 业务源码、官网、工具、Web 资产：专有字体名、远程字体、未登记字体文件、`@font-face` |
| `npm run font:check:packaged` | `app.asar` / `app.asar.unpacked`：任何字体文件、PDF.js 标准字体目录 |
| `npm run build:all` | 构建完成后自动跑 `font:check`，源码回归不会等到发版才发现 |
| `npm run package:smoke` | 打包态先跑 `font:check:packaged`，再执行既有打包冒烟 |
| `electron-builder afterPack` | 正式 `pack` / `dist` 在生成安装器前直接检查实际 `resources/`，失败即中止签名与发布 |

门禁扫描的是**实际产物**而不是口头约定。若未来确实需要随包字体，必须先把字体加入
manifest、补齐许可证文件，再同步修改门禁的发布包规则；不能通过改名或删断言绕过。

## 7. 仍需人工确认的边界

- Windows/macOS 系统字体的 EULA 由操作系统授权决定；本项目只引用字体族名，不再分发文件。
- 如果对外提供“完全一致的排版”作为合同义务，建议改用自托管 OFL 字体并重新做视觉验收。
- 第三方 PDF、图片、截图里可能包含字体引用或字形，这属于用户内容/上游资产，不是本项目的
  UI 字体资产；发布宣传材料时应单独核对素材授权。
- 本次门禁针对新构建的 `app.asar` / `app.asar.unpacked`。发布前必须重新运行
  `npm run dist`，不要继续分发 `dist/` 中早于标准字体排除规则的旧安装器。
- 本文和门禁降低的是工程侧可检测风险，不替代针对具体发行地区、客户合同和字体厂商 EULA
  的法律意见。
