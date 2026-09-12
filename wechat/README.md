# 微信+路径配置

所有路径配置统一记录在 `wechat/config.json`，启动时由
`src/backend/wechat-paths.js` 自动应用并回写实际解析结果。

## 配置字段

| 字段 | 环境变量 | 说明 |
|---|---|---|
| `dataRoot` | `DSH_WECHAT_DATA_DIR` | 数据根目录（默认 `<userData>/wechat-data`） |
| `decryptedDir` | `DSH_WECHAT_DECRYPTED_DIR` | 解密库目录（默认 `<dataRoot>/decrypted`） |
| `decodedImagesDir` | `DSH_WECHAT_DECODED_DIR` | 解码图片缓存（默认 `<dataRoot>/decoded_images`） |
| `sourceDir` | `DSH_WECHAT_SOURCE_DIR` | 一次性导入的旧快照源目录 |
| `baseDir` | `DSH_WECHAT_BASE_DIR` | 原始微信账号根目录（`.dat` 回退用） |
| `selfWxid` | `DSH_WECHAT_SELF_WXID` | 当前微信账号 wxid（多账号时指定） |
| `silkBinary` | `DSH_WECHAT_SILK_BIN` | wx_silk 解码器可执行文件路径 |
| `wechatSettings` | — | 「数据配置」保存的微信设置镜像（数据库目录/密钥/图片密钥/开关等），启动时自动应用 |
| `wechatSettingsMeta` | — | 最近一次保存的记录来源与时间 |
| `resolved` | — | 启动时自动回写的实际解析结果，请勿手改 |

字段留空（`""`）表示使用默认值；只有非空字段才会映射为环境变量。

## 使用

```bash
# 查看当前配置与实际解析路径
npm run config:wechat show

# 设置某个路径
npm run config:wechat set dataRoot D:\\wechat-data
npm run config:wechat set decryptedDir D:\\wechat-data\\decrypted
npm run config:wechat set baseDir D:\\Tencent\\WeChat

# 清空自定义路径（恢复默认）
npm run config:wechat reset
```

修改后重启应用即可生效；启动完成后 `wechat/config.json` 的 `resolved`
节会自动记录本次实际使用的路径。在【数据配置】点击「保存配置」时，
界面上的全部设置（数据库目录、密钥、图片密钥、功能开关等）会同步写入
`wechatSettings` 节；下次启动自动回写后端。
