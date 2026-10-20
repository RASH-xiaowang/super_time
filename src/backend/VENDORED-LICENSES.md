# Vendored dependencies & licenses

`src/backend/deps/` 下的依赖均迁移自
`D:\deepseek-harness`（DeepSeek Harness 仓库），用于让「Super Time」后端在
Super Time 中脱离 pnpm workspace 直接运行：

> **完整清单以 [`deps/PROVENANCE.json`](deps/PROVENANCE.json) 为准**（版本 + 整棵目录的内容 sha256 +
> 文件数，由 `npm run check:deps-provenance` 复算比对，`deps-provenance.spec.ts` 同一份逻辑守住）。
> 本表是给人看的一页摘要。里面还有两个 `kind: "in-repo"` 的条目 ——
> `@deepseek-ai/dsh-client-ui-primitives`（指向 [`../client/ui-primitives-shim`](../client/ui-primitives-shim)）
> 与 `@deepseek-ai/dsh-wechat-data`（就是本目录的 [`wechat-data`](wechat-data)）：
> 它们是**这个仓库自己的包**、以 `file:` 依赖安装，不是 vendor 进来的第三方副本，因此不在下表里。

| 包 | 版本 | 来源目录 | 许可证 |
|---|---|---|---|
| @deepseek-ai/cordis | 4.0.2 | vendor/cordis | MIT |
| @deepseek-ai/cosmokit | 1.8.3 | vendor/cosmokit | MIT |
| @deepseek-ai/dsh-typert-protocol | 0.1.3-alpha.1 | packages/typert/protocol | MIT |
| @deepseek-ai/dsh-native-command | 0.1.3-alpha.1 | packages/util/native-command | MIT |
| @deepseek-ai/dsh-home-paths | 0.1.3-alpha.1 | packages/util/home-paths | MIT |
| @deepseek-ai/dsh-invariants | 0.1.3-alpha.1 | packages/runtime-diagnostics/invariants | MIT |
| @deepseek-ai/dsh-llm | 0.1.3-alpha.1 | packages/llm/llm | MIT |
| @deepseek-ai/dsh-brand | 0.1.3-alpha.1 | packages/util/brand | MIT |
| @deepseek-ai/dsh-timeout | 0.1.3-alpha.1 | packages/util/timeout | MIT |
| @deepseek-ai/dsh-util-crypto | 0.1.3-alpha.1 | packages/util/crypto | MIT |
| @deepseek-ai/dsh-util-values | 0.1.3-alpha.1 | packages/util/values | MIT |
| @deepseek-ai/schemastery | 3.18.2 | vendor/schemastery | MIT |
| @standard-schema/spec | 1.1.0 | node_modules/.pnpm | MIT |
| fzstd | 0.1.1 | node_modules/.pnpm | MIT |
| koffi | 3.1.1 | node_modules/.pnpm | MIT |
| @koromix/koffi-win32-x64 | 3.1.1 | node_modules/.pnpm | MIT |
| zod | 4.4.3 | node_modules/.pnpm | MIT |

以上包均只保留运行/类型所需内容，并去除了 `workspace:` 协议与构建脚本；
根 `package.json` 通过 `file:` 依赖引用，`.npmrc` 设置 `install-links=true`
使 `npm install` 将其复制到 `node_modules`（而非符号链接），以便 electron-builder
打包。完整上游 LICENSE 文本随各包保留在 `deps/<pkg>/LICENSE*` 中。

## 原生组件：img_helper.dll（原图自动下载，实验；默认关闭）

| 组件 | 来源 | 路径 | 许可证 |
|---|---|---|---|
| `img_helper.dll`（x64，23,040 B） | 上游 WeFlow-X（`github.com/hicccc77/weflow-x`） | `wechat-data/native/img_helper/win32-x64/img_helper.dll` | MIT（Copyright (c) 2026 cc） |

- 逐字节副本（未修改）：SHA-256 `79596be6f0da84f25a763973f6d1a439bcd8df2c0300891f6d419984f16cfc91`，
  后端在 `koffi.load()` 之前复核；不一致直接拒绝加载。
- 打包态随 `asarUnpack`（`src/backend/wechat-data/native/**`）落到 `app.asar.unpacked`。
- 导出、运行边界与上游 PDB 行号见
  [`wechat-data/native/img_helper/PROVENANCE.md`](wechat-data/native/img_helper/PROVENANCE.md)；
  MIT 许可证全文在同目录 [`LICENSE`](wechat-data/native/img_helper/LICENSE)。
- ⚠️ 该组件**只在你显式打开**「设置 → 图片解码 → 微信原图自动下载」时才会被加载；
  默认不 `koffi.load()`、不注入。
