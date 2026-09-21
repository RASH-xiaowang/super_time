# @deepseek-ai/dsh-wechat-data

微信数据板块后端：读取自有数据根的**本地解密库**（node:sqlite），通过 Typert Remote 暴露给浏览器「Super Time」面板。

> 迁移自 `C:\Users\28361\Desktop\ST\st_control`（Tauri + Rust + Svelte）。
> 完整核对表见 `docs/wechat-migration/migration-checklist.md`；迁移计划见 `docs/wechat-migration/MIGRATION-PLAN.md`。

## 数据依赖（运行要求）

本包**拥有自己的数据根**（`$DSH_HOME/wechat-data`，默认 `~/.dsh/wechat-data`，可用
`DSH_WECHAT_DATA_DIR` 覆盖），不读取任何外部进程目录。首次运行可选通过
`DSH_WECHAT_SOURCE_DIR` 设置一次性导入旧快照（未设置则跳过导入），
之后只读写 DSH 自己的数据根：

| 目录/文件 | 说明 | 数据根下位置 |
|---|---|---|
| decrypted | 解密库（session/message/contact/sns/favorite/emoticon…） | `<root>/decrypted` |
| decoded_images | 已解码图片缓存 | `<root>/decoded_images` |
| exports | 导出文件输出 | `<root>/exports` |
| backups | 备份快照输出（目录快照 / 加密 `.wcb`） | `<root>/backups` |
| message_edits.db | 消息编辑快照（插件写入） | `<root>/message_edits.db` |
| daily_summary.db | 每日总结任务/记录（插件写入） | `<root>/daily_summary.db` |
| wechat_search.db | 搜索索引（插件写入） | `<root>/wechat_search.db` |
| wechat_tasks.db | 待办提取存储（插件写入） | `<root>/wechat_tasks.db` |
| wechat_privacy.db | 隐私设置与 AI 审计 + 操作日志（插件写入） | `<root>/wechat_privacy.db` |
| config.json | 微信配置（读写）—— **不含密钥**（见下） | `<root>/config.json` |
| keys.json | 自动获取的密钥存储（`autoGetDbKey` / `autoGetImageKey` 写入；解图片时在 config/secrets 之后作为**回退**被读取，见 `query/image-key.ts`） | `<root>/keys.json` |
| all_keys.json | 生成的密钥信息 | `<root>/all_keys.json` |

## 密钥存储与保护（M1）

**密钥放在哪**

| 内容 | 位置 | 谁写 |
|---|---|---|
| 微信库解密密钥、图片 AES/XOR 密钥、HTTP API 令牌 | `<数据根>/secrets.json`（与后端 config.json 同级） | 后端 `query/config.ts`（`SECRET_FIELDS`） |
| 自动获取的密钥（库密钥 + 图片 AES/XOR） | `<数据根>/keys.json` | `keys/key-store.ts` |

`keys.json` 目前**只有一个 `'default'` 槽位**（`keys/service.ts` 的三处写入都用这个字面量），
不按 wxid 分账 —— 所以同机换过账号时，那里面可能是上一个账号的密钥。解码侧因此加了归属校验：
记录里写明属于别的账号（`image_key_derived_wxid`，或内存扫描路径记的 `image_key_source_wxid_dir`）
且与当前账号明确不同时，按「没有密钥」处理，而不是拿错的钥匙解出一张垃圾图（详见 `RELEASE-PLAN.md` N28）。
手工填写并保存的密钥仍走 `secrets.json`，且**优先级高于**这里自动获取的结果。
| LLM API Key | `<STATE_DIR>/llm.json` | 宿主层 `wechat-paths.js` |

`STATE_DIR` = `<userData>/wechat`（宿主配置与日志）；数据根默认 `<userData>/wechat-data`（后端配置 `config.json`、`secrets.json`、`keys.json` 都在这里）。

**为什么不在 config.json 里**：`config.json` 是「用户可以手工编辑、出问题会被整目录拷贝
或交给支持人员」的文件，密钥写进去等于凭空多一份副本（这正是 H1/N6 那条泄漏路径的载体）。
因此 `saveConfig` 会把密钥类字段**改写到 `secrets.json`**，并从 `config.json` 删除；
`getConfig` 再从 `secrets.json` 读回来，所以调用方无感。

关于这几个字段的三条行为约定（都是踩过坑才定下来的）：

- **`config.json` 里恒不保留**这四个字段：`getConfig()` 会把默认值补进合并结果，若让它落盘，
  「config.json 里还有旧密钥吗」这类判据就会永远为真（实测导致每次启动都多跑一次空保存）。
- **空串与「等于内置默认值」都不算真值**：默认的 `image_xor_key` 是 `136`、其余三个是 `''`。
  界面上「配置还没读回来就点保存」提交的就是这一组值 —— 若当成「用户要清空」，会把
  `secrets.json` 里的真密钥整体抹掉，而原文件是合法 JSON、连 `.corrupt-*` 备份都不会留。
  代价是**不再支持把某个密钥「清空 / 改回默认」**（那等价于没有密钥 / 用默认值）。
- **旧数据会自愈**：密钥还在 `config.json` 里的老安装会在下一次保存时被搬进 `secrets.json`；
  反过来，`secrets.json` 里若残留默认值（老版本写过），`getConfig` 会忽略它并回退到
  `config.json`。要手工调整请编辑 `secrets.json`，或走界面。

界面侧另有一条：渲染进程的 `localStorage` 渲染缓存**不落密钥**（那个目录不在权限收紧范围内，
放进去等于第四份明文副本）；老版本留下的带密钥缓存会在面板挂载时被重写成干净版。

**权限保护**：启动时 `src/backend/secure-fs.js` 把 `STATE_DIR` 与数据根收紧到**当前用户**
（Windows 用 `icacls /inheritance:r /grant:r <当前用户 SID>:(OI)(CI)F`，POSIX 用 0700/0600）。
目录级的 `(OI)(CI)` 继承让之后新建的文件自动继承同一权限，所以不必每写一个文件都调一次。
收紧的是**后端解析出的真实数据根**（不是写死的默认路径），所以自定义数据根同样受保护。
授权按**进程令牌里的 SID** 取（`whoami /user`）—— 实测 `process.env.USERNAME` 在部分环境里
是错的身份，照它授权会把目录锁成谁也进不去。加固失败只记日志，不会让应用起不来。

**三条必须知道的告诫**

1. **加固失败 = 完全无保护**：拿不到权限时应用照常运行，密钥仍是明文；日志里会有一行
   「密钥目录权限收紧未完全成功」。
2. **自定义数据根 / 网络盘 / 移动盘**：数据根可由配置指向任意位置。启动时会按**实际解析出的**
   根收紧（不是写死默认路径），但在 FAT32/exFAT 移动盘、或没有写 DACL 权限的网络共享上会
   静默失效。要跨机用移动盘，请自行给该盘加密。
3. **多账户 / 共享 userData**：权限收紧到**当前用户**。若把 `SUPERTIME_USER_DATA_DIR` 指到共享目录、
   或用另一个账户运行，另一个账户会读不到（或反过来把当前账户关在门外）—— 不要共享该目录。

另：对目录收紧会**连既有的子/孙文件一起**被继承规则覆盖（Windows 会把可继承 ACE 传播下去），
所以老文件并不是「还裸着」。

自举只复制一次：目标根已存在 `decrypted` 时跳过；复制跳过 SQLite `-wal`/`-shm`
运行时文件。本包**不自解密 SQLite**（SQLCipher 解密单独立项），但**可自动获取密钥**：`autoGetDbKey`
从运行中的 Weixin.exe 进程内存扫描 V4 数据库密钥（配合 Weixin.dll 内部密钥解掩码），
`autoGetImageKey` 从进程内存扫描经 V2 模板验证的图片密钥（均已迁移自 WeChatDataAnalysis，
见 `src/keys/`）。「检测本机微信账号」扫描 `xwechat_files` 数据根：常见目录
（`X:\Tencent`、`%USERPROFILE%\Documents`）、`%APPDATA%\Tencent\xwechat\config\*.ini`
记录的自定义数据根、以及注册表 `HKCU\Software\Tencent\Weixin\InstallPath`（见
`src/query/config.ts`）。

环境变量：

- `DSH_WECHAT_DATA_DIR` — 数据根（最高优先级；默认 `$DSH_HOME/wechat-data`）
- `DSH_WECHAT_SOURCE_DIR` — 可选一次性导入源目录（默认不设置；未设置则跳过导入）
- `DSH_WECHAT_DECRYPTED_DIR` / `DSH_WECHAT_DECODED_DIR` — 旧版显式固定路径（设置后绕过数据根，不再自举）
- `DSH_WECHAT_BASE_DIR` — 原始微信目录（可选，`.dat` 回退用）

## Remote 方法（gateway.ts）

| 分组 | 方法 |
|---|---|
| 会话/消息 | getSessions / getMessages / getContacts / getContact360 |
| 媒体 | getImageDataUrl / getSnsImageDataUrl / getSnsVideoCoverDataUrl / getVoiceInfo / getVideoInfo / getMediaAssets |
| 分析 | getOverview / getRecords / getLedger / getRevoked / getEmoticons / getStorageStats / getAnnual / getPrivacyScan / getGraph / getGroupInsights |
| 订阅 | getMoments / getMomentsInsights / getFavorites / getAssetInsights / getFiles / getOfficialAssets / getWechatConfig |
| 搜索/日历 | getSearchIndexStatus / buildSearchIndex / searchMessages / searchUnified / getDailyCounts |
| 写操作 | exportSessionMessages / askWechat（可选会话/日期范围）/ generateDailySummary / generatePeriodSummary / listBackups / createBackup / createEncryptedBackup / restoreBackup / deleteBackup / editChatMessage / resetEditedMessage / listEditedMessages |
| 待办 | listTasks / addTask / setTaskStatus / deleteTask / extractTasks / getHandoffReminds / syncHandoffTasks |
| 隐私控制 | getPrivacyState / setPrivacyState / getPrivacyAuditRows / clearPrivacyAudit |
| 密钥 | autoGetDbKey（V4 内存扫描）/ autoGetImageKey（V2 验证内存扫描）/ getWechatKeysInfo |
| 系统 | getDbStatus / getDbHealth / getImageDataUrl |

## 前端

浏览器端在 `packages/client/ui-pages/src/client/pages/wechat-data/`：

- `api.ts` — Remote 客户端（`setWechatRemote` 注入，无 HTTP 依赖）
- `WechatDataPanel.tsx` — 32 页签主容器
- `panels/` — 各面板 + 图片查看器/日历/搜索
- `utils/format.ts` — 迁移的格式化/图标工具

## 构建

```sh
npx tsc -b packages/host/wechat-data/tsconfig.json   # 类型检查
npx tsdown --env.DSH_BUILD_FACE host                 # 构建 lib + typert 生成
pnpm --filter @deepseek-ai/dsh-client-ui-pages run bundle
pnpm --filter @deepseek-ai/dsh-api-remotes run bundle
```

## 降级项

- 语音 silk→wav：Node 无 ffmpeg/WASM 解码器 → 返回时长 + 降级提示
- 视频/HEVC（wxgf）：需系统解码器 → 封面或占位
- 高清原图（wxgf/HEVC）：未缓存源时以缩略图 `_t/_h` 兜底；监控为本地轮询仪表盘（8 秒刷新，无进程注入）
- 备份：目录快照 / AES-256 加密 `.wcb`（本包实现加密与恢复）


## Model Experience

### AI 问答（askWechat）

#### What the model sees

`askWechat` assembles a single user message from the question plus retrieval-grounded WeChat context and a citation instruction, and streams the answer through `@deepseek-ai/dsh-llm` using the configured default model. The model sees only that assembled prompt; raw decrypted rows never enter the request.

#### Token effect

The assembled prompt and the streamed answer account for their own provider tokens through the normal dsh-llm meter; the retrieval context length is bounded by `buildAskContext`.

#### KV Cache effect

No KV cache is written or read by this package; the provider adapter owns any cache behavior.

## Known Limitations and Deferred Work

- **数据同步与解密**：本包通过 `sync.ts` 在本地监视原始分片并解密（SQLCipher 4，PBKDF2-HMAC-SHA512 + AES-256），注入自有数据根，不依赖 st_control 进程。
- **语音/视频降级**：silk→wav 与 HEVC 需系统解码器，Node 侧返回时长/封面或占位。
- **朋友圈媒体**：图片走 `cache/<月>/Sns/Img` 本地 V2 解密（密钥优先 config.json，回退 keys.json 自动获取结果）；视频展示本地 `Sns/Video` 封面（`msg/video` 缩略图兜底），视频本体暂不播放。
- **监控与原图**：监控为本地轮询仪表盘；原图走本地缓存与解码，未缓存的高清源以缩略图兜底；无进程注入/无 Hook。
- **备份**：目录快照与 AES-256 加密 `.wcb` 均为本包实现；`.wcb` 为自包含格式，非外部加密 ZIP。


## 参考文档

- [微信数据库字段字典](docs/wechat-db-fields.md)：18 个库 / 60+ 表的字段语义（会话/联系人/消息/转账红包/朋友圈/收藏/头像/硬链接等）。
