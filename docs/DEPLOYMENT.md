# 部署与发布

面向"要把这套东西交到别人手上"的人：从源码到安装包、从安装包到能验证它装对了。
实施状态与未闭环项一律以 [`RELEASE-PLAN.md`](RELEASE-PLAN.md) 为准，本文只写**怎么做**与**做完怎么验**。

## 1. 前置

| 项 | 要求 |
|---|---|
| 构建机 | Windows 10/11 x64 + Node 22（与 CI 同版） |
| 依赖 | `npm ci`（含 `file:` 内联依赖，不能用 `npm install`） |
| 签发私钥 | 只在签发机上需要，且**不在仓库里**：默认 `~/.supertime/license-private.pem`（`SUPERTIME_LICENSE_PRIVATE_KEY` 可指路；指向仓库内会被拒）。`vendor-keys/` 只留公钥 |
| Electron 二进制 | 跑冒烟需要真窗口；CI 里由「准备 Electron 二进制」一步预热 |

## 2. 构建

```bash
npm run build:ui        # vite 打前端，入口是 src/client/ui-app/ui-entry.tsx → ui-dist/
npm run build:backend   # esbuild 打后端 → src/backend/wechat-data/lib/index.js
npm run build:types     # tsc 生成 lib/types/**.d.ts（前端只从这里取后端类型）
npm run docs:api        # 由 gateway.ts 的 @Remote 生成 docs/API.md
```

`lib/index.js` 与 `lib/types/**` 是**入库产物**（不是构建缓存）：CI 会重建并要求 `git diff` 为空。
所以改后端 `src` 的那次提交必须把 `lib/`（方法面变了还要 `docs/API.md`）一起提上去。

## 3. 打包

```bash
npm run pack   # 目录版（dist/win-unpacked/），调试装配用
npm run dist   # NSIS 安装器（前置 build:ui）
```

`package.json` 里 `build` 段的三条要点：

- **`files` 排掉 `src/backend/deps/**` 与所有 `src/**/*.ts`**：那是构建期源码/内联依赖，不进产物；
- **`asarUnpack` 列的东西必须解包**，否则运行时炸：
  `koffi`（win32 FFI）、`@koromix`（silk 解码）、`onnxruntime-node` 的 napi 二进制、
  `wechat-data/native/**`（朋友圈视频解密 WASM）、`wechat-data/resources/**`（`wx_silk.exe` ——
  **不能从 asar 里执行**）、`wechat/whisper/**` 与 `wechat/README.md`；
- **`signExecutable: false`**：当前不签代码签名证书（登记在 `RELEASE-PLAN.md`，与自动更新链路一并收口）。
  未签名的安装器在 Windows 上会有 SmartScreen 提示，分发时要写进给用户的说明里。

输出目录是 `dist/`。产物三件套：`Setup.exe`、`.blockmap`、`latest.yml`。

## 4. 许可证与首发

```bash
npm run license-keygen                                   # 生成签发密钥对（公钥同步进 src/license/public-key.js）
npm run license-issue -- --from-request ./activation-request.json \
  --name "客户机" --days 365 --edition pro --out ./out/license.json
```

- 用户在启动页「导出激活请求」拿到 `activation-request.json`（内含设备指纹）；
- 也支持按指纹直签：`--fingerprint <指纹>`；参数见 [`../scripts/license-issue.js`](../scripts/license-issue.js)；
- 私钥必须与开发机隔离：位置解析在 `scripts/license-key-path.js`，**默认落在用户目录、指向仓库内的路径一律拒**
  （不只是 gitignore —— 仓库目录会被备份/归档整个带走）；`build.files` 里也没有它。

冒烟：`npm run license-smoke`（签发 → 导入 → 校验）与 `npm run license-gate:smoke`
（无证/过期/伪造/`license.json` 损坏一律拒，且拒绝理由是可读中文）。

## 5. 装完之后怎么验

按"越靠后越接近真实用户"的顺序：

```bash
npm run package:smoke                 # 起打包产物：asar 内容、状态落点、随包资产、方法数
npm run security-guard:smoke:packaged # 打包态下开窗与外部导航一律被拒
npm run check:backend-restart         # 杀掉后端 worker → 自动重建 → 功能恢复
npm run ui:e2e-smoke                  # 真窗口冒烟（Playwright 驱动真实 Electron）
```

CI 里已经跑着的两条真机 e2e（都不需要许可证与私钥）：
`npm run e2e:h14-consent`（隐私同意必须早于授权）、`npm run e2e:export-progress`（导出进度与中止）。

发布链的验收口径**不是**"作业 success"，而是三条可回读的事实：
`/releases/latest` 指向本 tag、三个资产齐备、`latest.yml` 回读与本地产物逐字节一致。
`.github/workflows/release.yml` 里的「发布验收」一步就是做这三件事（含同 tag 重复 Release 收敛、
缺资产补传、草稿态转正式发布）——历史上这里出过两次"灰的绿"，别把它当装饰。

## 6. 发版

1. 改版本号（`package.json` + `CHANGELOG.md`，版本策略见 CHANGELOG 开头）；
2. 提交后打 tag：`git tag v<版本> && git push origin v<版本>`；
3. `release.yml` 由 tag 触发，`npm run dist -- --publish always` 建 Release 并上传；
4. 回读第 5 节那三条事实（作业日志里的一步，失败即红）。

只有 tag 触发才发布：每次 push 都发会让 `latest.yml` 反复被覆盖，客户端可能下到半成品。

## 7. 装到用户机器上之后

- 数据与配置落点、如何完全卸载：见 [`../README.md`](../README.md)「数据放在哪里」与
  [`PRIVACY.md`](PRIVACY.md)（安装目录只读，升级/卸载不动 `<userData>`）；
- 首次启动会依次经过引导 → 隐私同意 → 授权三站；
- 需要解密时微信必须**正在运行**（只读扫描 `Weixin.exe` 进程内存取密钥），
  否则要在「数据配置」里手工填密钥；
- 想完全离线：设置里关掉「AI 出网」与「自动获取原图（CDN）」；
  地图底图 GeoJSON 与语音模型下载是另外的出网点，逐条清单在 `PRIVACY.md`。

## 8. 还没闭环的部署项（不要当成已完成）

- 代码签名证书与 SmartScreen 信誉：未做（见 `RELEASE-PLAN.md` 的签名条目）；
- 自动更新的服务端策略（灰度、回滚）：只有 `latest.yml` 这一条链路，没有分阶段发布；
- 公开发布的前置条件与逐条状态：一律以 [`RELEASE-PLAN.md`](RELEASE-PLAN.md) 顶部为准。
