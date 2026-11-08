# wcocr.dll（微信原生 OCR 兼容包装）provenance

## 这是什么

一个 155,648 字节的 Windows x64 动态链接库，导出：

| 导出 | 原型 | 作用 |
|---|---|---|
| `wechat_ocr` | `bool wechat_ocr(LPCTSTR wxocrDll, LPCTSTR wechatDir, const char* imagePath, void(*callback)(const char*))` | 加载微信自己的 `wxocr.dll`，通过 MMMojo IPC 完成一次 OCR，并通过回调返回 JSON 字符串 |
| `stop_ocr` | `void stop_ocr()` | 释放 MMMojo 实例，必须在进程退出前调用 |

本仓库只把它当作微信 OCR 插件的调用适配层。实际识别模型、`wxocr.dll` 与
`mmmojo_64.dll` 都来自用户本机安装的微信，不随本仓库分发。

## 来源与许可

- 上游项目：`https://github.com/swigger/wechat-ocr`
- 上游发布包中的路径：`c#/wcocr.dll`
- 本仓库副本：`src/backend/wechat-data/native/wcocr/win32-x64/wcocr.dll`
- 二进制未修改。
- **许可状态：截至收录时，上游项目与发布包内均未发现 LICENSE / COPYING
  或其它明确许可声明。** 这里不对许可作推断；发布包若补充声明，应以补充分发
  与合规审查。

## 完整性

| 项 | 值 |
|---|---|
| SHA-256 | `A349CE3DD72014CADF2E11882334292D76010B91FBE32AC28E015943F2055A90` |
| 字节数 | 155,648 |

worker 在 `koffi.load()` 前复核 SHA-256；不一致时拒绝加载。

## 运行边界与风险

- 仅 Windows x64，且依赖用户已安装并登录的微信 4.x。
- 微信 OCR 插件位于
  `%APPDATA%\Tencent\xwechat\...\WeChatOcr\<版本>\extracted\wxocr.dll`；
  `mmmojo_64.dll` 位于微信版本目录（例如 `D:\Tencent\Weixin\4.1.15.13`）。
- MMMojo 会创建线程并要求退出前 `stop_ocr()`，因此调用被隔离在一次性
  Electron `utilityProcess` 中；主进程不直接加载该 DLL。
- 上游没有声明微信版本兼容范围。插件升级后若接口变化，应当重新验证包装 DLL。
