# Super Time 路径配置

本目录是**随包分发的只读资产目录**，只放语音转写的引擎与预置模型：

```
wechat/README.md
wechat/whisper/ggml-tiny.bin      预置模型（约 75 MB）
wechat/whisper/bin/whisper-cli.exe + *.dll
```

**运行时绝不往这里写文件**。安装版装到 `Program Files` 时没有写权限，而且整个
安装目录被拷到另一台电脑时，写在这里的任何东西（尤其是本机 `db_dir` 与微信解密
密钥）都会被一起带走 —— 对方开机直接拿它去解密，报「数据库目录不存在
（D:\Tencent\...\wxid_xxx\db_storage）」。

## 配置落在哪

运行期状态一律落在 **userData**：

| 文件 | 说明 |
|---|---|
| `<userData>/wechat/config.json` | 路径配置 + 「数据配置」保存的微信设置镜像 |
| `<userData>/wechat/llm.json` | 微信问答的模型配置（API Key 在这里） |

`userData` 在 Windows 上分别是：

- 开发态（`npm start` / `electron .`）：`%APPDATA%\super-time-electron`
- 安装版：`%APPDATA%\Super Time`（`main.js` 显式隔离，避免吃到开发态或旧版本遗留的数据）

语音转写的模型/引擎目录默认是 `<数据根>/whisper`（即可写目录），首次使用时把
`wechat/whisper` 里的引擎与预置模型镜像进去（同卷走硬链接，跨卷才真复制），
之后安装目录只被读取。要换其它模型就下载到这个可写目录里。

## config.json 字段

| 字段 | 环境变量 | 说明 |
|---|---|---|
| `dataRoot` | `DSH_WECHAT_DATA_DIR` | 数据根目录（默认 `<userData>/wechat-data`） |
| `decryptedDir` | `DSH_WECHAT_DECRYPTED_DIR` | 解密库目录（默认 `<dataRoot>/decrypted`） |
| `decodedImagesDir` | `DSH_WECHAT_DECODED_DIR` | 解码图片缓存（默认 `<dataRoot>/decoded_images`） |
| `sourceDir` | `DSH_WECHAT_SOURCE_DIR` | 一次性导入的旧快照源目录 |
| `baseDir` | `DSH_WECHAT_BASE_DIR` | 原始微信账号根目录（`.dat` 回退用） |
| `selfWxid` | `DSH_WECHAT_SELF_WXID` | 当前微信账号 wxid（多账号时指定） |
| `silkBinary` | `DSH_WECHAT_SILK_BIN` | wx_silk 解码器可执行文件路径 |
| `wechatSettings` | — | 「数据配置」保存的微信设置镜像，启动时自动应用 |
| `wechatSettingsMeta` | — | 最近一次保存的来源与时间 |
| `resolved` | — | 启动时自动回写的实际解析结果，请勿手改 |

字段留空（`""`）表示使用默认值；只有非空字段才会映射为环境变量。

`wechatSettings` 里**不记录派生字段**（`decrypted_dir`、`decoded_image_dir`、
`keys_file`、`whisper_models_dir`、`whisper_bin`）—— 它们随安装位置与数据根变化，
后端每次启动都会按当前机器重新解析；一旦镜像进去，就只会把上一台机器或上一次
安装位置的绝对路径再推回后端。

## 开发态迁移

开发态首次启动时，本目录下的 `config.json` / `llm.json`（老版本的位置）会被
**复制**到 `<userData>/wechat/`，让老配置继续生效；此后只读写 userData 那份，
项目里这两个文件不再被使用。打包态**不做任何继承**。
