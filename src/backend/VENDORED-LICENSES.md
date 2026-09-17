# Vendored dependencies & licenses

`src/backend/deps/` 下的依赖均迁移自
`D:\deepseek-harness`（DeepSeek Harness 仓库），用于让「Super Time」后端在
Super Time 中脱离 pnpm workspace 直接运行：

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
