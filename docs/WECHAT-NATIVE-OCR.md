# 微信原生 OCR 接入说明

本文记录 Super Time 对聊天图片做文字识别时的原生链路、隐私边界、打包约束与
故障排查。这里的 OCR **只使用微信 4.x 自带的 `WeChatOcr` 插件**，不使用 Windows
自带 OCR，也不调用云端 AI 识图。聊天图片右侧另有一个独立的 `AI` 入口；只有用户
点击它时才会把图片交给当前配置的多模态大模型，详见下文「AI JSON 独立入口」。

## 已验证结论

2026-11-03 在本机验证通过：

| 项目 | 值 |
|---|---|
| Windows | Windows x64 |
| 微信 | `4.1.15.13` |
| OCR 插件 | `WeChatOcr\8096` |
| 插件 DLL | `%APPDATA%\Tencent\xwechat\XPlugin\Plugins\WeChatOcr\8096\extracted\wxocr.dll` |
| 微信版本目录 | `D:\Tencent\Weixin\4.1.15.13`（含 `mmmojo_64.dll`） |
| 兼容包装 DLL | `wcocr.dll` |
| 冒烟结果 | `errcode=0`、31 行、367 个字符、1484 x 1081 |

仓库内冒烟脚本：

```powershell
node scripts/wechat-ocr-native-smoke.js `
  --image <本地图片路径> `
  --wrapper <wcocr.dll 路径>
```

不传 `--wrapper` 时默认使用：

```text
src/backend/wechat-data/native/wcocr/win32-x64/wcocr.dll
```

脚本只输出 `errcode`、行数、字符数、耗时、插件版本和微信版本；**不会输出 OCR
正文或完整响应 JSON**。识别失败或 `errcode != 0` 时退出码为 1。

## 调用链

```text
聊天图片消息
  └─ 用户点击图片旁的“?”
       └─ 后端 OCR 服务
            ├─ 将图片内容写入受控临时文件
            ├─ 独立子进程加载 wcocr.dll
            ├─ wcocr.dll 启动/连接微信 WeChatOcr 插件
            ├─ 微信 wxocr.dll 在本机完成 OCR
            ├─ 返回 JSON：errcode / width / height / ocr_response[]
            └─ 删除临时文件，stop_ocr() 后退出子进程
                 └─ 渲染层展示 ocr_response[].text
```

微信 OCR 需要同时满足：

1. 安装的是 Windows x64 微信 4.x；
2. `%APPDATA%\Tencent\xwechat` 下存在已下载的 `WeChatOcr` 插件及模型；
3. 微信版本目录内有 `mmmojo_64.dll`；
4. `wcocr.dll`、`wxocr.dll`、微信客户端三者的位数和版本兼容。

`WeChatOcr` 是 OCR 插件，不等同于“小微 AI”对话能力。Super Time 只用它把图片
转换成文字，不把 OCR 结果发送给任何云端模型。

## AI JSON 独立入口

图片右侧的动作栈固定为：

```text
?
AI
```

- `?`：微信原生 OCR，图片只在本机交给 `WeChatOcr`，不上传。
- `AI`：读取当前生效的 `wechat/llm.json`，把同一张图片作为多模态内容发给用户配置的
  大模型，并要求模型按内容提炼字段、只返回一个结构化 JSON 对象：

```json
{
  "姓名": "张三",
  "性别": "男",
  "民族": "汉",
  "出生日期": "1990年1月2日",
  "住址": "示例省示例市示例区示例路1号",
  "公民身份号码": "110101199001021234"
}
```

身份证固定使用上述 6 个中文字段，并忽略拼音、壮文等注音行；住址等跨行内容必须
合并为完整字符串。其它证件（护照、驾驶证、行驶证、营业执照、港澳台通行证、
外国人永久居留证、社保卡、银行卡等）额外输出 `证件类型`，其余字段使用证件上的
正式名称并保留完整号码、日期和签发信息。不属于证件的图片按场景提炼字段。模型
不得再用 `text` + `lines` 包装整段 OCR 原文。

AI 链路复用 OCR 层的图片来源白名单：只接受 `data:image/*;base64` 与
`wechat-media://decoded/<rel>`，不接受任意本地路径或远端 URL。图片上限 20 MB；
data URL 的临时文件在成功、失败和超时路径都会删除。模型输出允许带 Markdown
代码围栏，但服务端只提取并解析 JSON 对象，界面以 `pre` 文本节点展示，不按 HTML
渲染。当前模型不支持图片输入时，界面会提示切换到多模态模型，不会静默降级成
微信 OCR 或其它引擎。

AI 请求是**显式点击才发生**的内容出网点：弹窗会写明“图片会发送给当前配置的
多模态模型处理”。日志不记录图片内容、识别正文或完整模型响应。

## 路径发现

### OCR 插件

不能写死 `xplugin` 的实际大小写：本机目录实际是 `XPlugin\Plugins`。服务应按
大小写不敏感的方式查找：

```text
%APPDATA%\Tencent\xwechat\XPlugin\Plugins\WeChatOcr\<插件版本>\extracted\wxocr.dll
```

存在多个版本时选择版本号最大的目录。不要使用微信安装目录里的
`WeChatOcr.bin` 作为 `koffi.load()` 目标；它是插件包，不是可直接加载的 DLL。

### 微信版本目录

从注册表读取：

```text
HKCU\Software\Tencent\Weixin
  InstallPath = D:\Tencent\Weixin
```

`InstallPath` 可能是安装根目录，也可能直接是版本目录。应在它的子树中寻找包含
`mmmojo_64.dll` 的版本目录，并在多个候选中选择版本号最大的目录。本机实际为
`D:\Tencent\Weixin\4.1.15.13`。

## 原生包装 DLL

微信的 `wxocr.dll` 只导出 `WeChatMain`、`GetHandleVerifier`、
`GetMergeOffsetInner`，不能直接当稳定 API 使用。接入使用
[`swigger/wechat-ocr`](https://github.com/swigger/wechat-ocr) 的兼容包装：

```c
bool wechat_ocr(
  LPCTSTR wxocrDll,
  LPCTSTR wechatDir,
  const char* imagePath,
  void (*callback)(const char* json)
);

void stop_ocr(void);
```

Koffi 声明回调时，函数参数必须传 callback 的**指针类型**，不能直接传
`koffi.proto(...)`：

```js
const callbackProto = koffi.proto('void', ['str'])
const callbackPointer = koffi.pointer(callbackProto)
const wechatOcr = lib.func('wechat_ocr', 'bool', [
  'str16',
  'str16',
  'str',
  callbackPointer,
])
```

包装层会创建 MMMojo 线程。每次调用结束都必须执行 `stop_ocr()`，再注销 Koffi
回调。OCR 应在独立子进程中运行：主 Electron 进程和长期运行的后端
`utilityProcess` 不应直接承载这个同步原生调用，否则一次插件卡死可能拖住整个后端。

## 响应形状

包装层返回的 JSON 主要字段：

```json
{
  "errcode": 0,
  "width": 1484,
  "height": 1081,
  "ocr_response": [
    {
      "left": 0,
      "top": 0,
      "right": 0,
      "bottom": 0,
      "rate": 0,
      "text": "..."
    }
  ]
}
```

服务层只需要向界面暴露 `errcode`、图片尺寸、文本行及每行坐标。不要把原始 JSON
直接写日志；聊天图片可能包含身份证、银行卡、地址、手机号等敏感信息。

## 打包检查

当前 `package.json` 的配置满足以下条件：

1. `build.files` 包含 `src/**/*`，且只排除了 `src/**/*.ts`、`src/**/*.tsx` 和
   client 源码；因此 `src/backend/wechat-data/native/**` 下的 DLL 会被收进包。
2. `build.asarUnpack` 明确包含
   `src/backend/wechat-data/native/**`；其中的 DLL 会作为真实文件落到：

   ```text
   resources/app.asar.unpacked/src/backend/wechat-data/native/...
   ```

3. `node_modules/koffi/**` 和 `node_modules/@koromix/**` 也在 `asarUnpack` 中，
   Koffi 自身可以正常加载。

**关键约束：** `koffi.load()` 最终交给 Windows 动态加载器，不能读取 asar
归档内路径。打包态必须把默认 DLL 路径解析为：

```text
<process.resourcesPath>\app.asar.unpacked\src\backend\wechat-data\native\wcocr\win32-x64\wcocr.dll
```

或使用后端现有的 `unpackedAware()` / `onDiskPath()`。仅把文件写进
`asarUnpack`、但把归档内路径交给 `koffi.load()`，仍然会在安装包中失败。

后端本身已经是 `utilityProcess`。`utilityProcess.fork()` 可以读取 asar 内的
worker JS，所以隔离 OCR 的 worker 脚本无需只因此项就解包；但 worker 内加载的
原生 DLL 必须走 `app.asar.unpacked` 的真实路径。若改用原生
`child_process.fork/spawn` 启动磁盘上的 JS，则该 JS 也必须被 `asarUnpack`
覆盖。

## 隐私边界

- 点击 `?` 时，图片只在本机交给微信原生 OCR 插件处理，不发送到 Super Time 之外的服务。
- 点击 `AI` 时，图片会发送到用户当前配置的大模型端点；这是独立、显式触发的出网路径。
- 临时图片应放在应用私有目录，文件名随机化；识别结束、超时或失败后立即删除。
- 日志只记录错误码、耗时、尺寸和行数，不记录图片内容、OCR 正文或完整 JSON。
- 内存缓存建议以 `username + localId + 图片标识` 为键，并在会话切换、退出或用户
  手动清除时释放。
- 用户主动点击“?”才触发 OCR；不对全部聊天图片自动后台识别。
- 必须在 UI 中说明“文字由本机微信 OCR 识别”，避免用户误以为内容被上传到了 AI
  云端。
- `AI` 入口必须在弹窗里说明图片会交给当前配置的大模型，不能把它与本地 OCR 混为一谈。

## 上游与再分发风险

- 微信客户端、`wxocr.dll` 及其 OCR 模型属于腾讯的微信安装内容。本项目运行时读取
  用户已安装的插件，不应把微信插件或模型打包进发行版。
- `github.com/swigger/wechat-ocr` 的仓库在本次核查时**没有声明许可证**，也没有
  LICENSE 文件。不能把它标成 MIT，也不能仅凭公开仓库就视为允许再分发其
  `wcocr.dll` 二进制或源码。
- 若发行包需要包含 `wcocr.dll`，发布前必须取得上游明确的再分发授权，或替换为
  自行实现且许可证清晰的兼容包装。在授权解决前，该二进制应视为发布阻塞风险，
  不应在第三方许可清单中写成 MIT。

## 冒烟与故障排查

### 找不到 `wxocr.dll`

- 确认微信版本为 4.x，并在微信里成功使用过一次“提取文字”，让插件完成下载。
- 检查 `%APPDATA%\Tencent\xwechat` 下的 `XPlugin\Plugins\WeChatOcr`。
- 目录名大小写可能不同；不要只匹配小写 `xplugin`。
- 注意 `extracted` 位于插件版本目录下，例如 `WeChatOcr\8096\extracted`。

### 找不到 `mmmojo_64.dll` / 微信版本目录

- 检查 `HKCU\Software\Tencent\Weixin` 的 `InstallPath`。
- 安装根目录和版本目录都应当探测；版本目录通常是 `4.x.y.z` 子目录。
- 确认微信为 x64；不要与 32 位微信或旧版 3.x 混用。

### `wechat_ocr` 返回 `false`

- 确认 `wxocrDll`、`wechatDir` 都是真实磁盘路径。
- 确认 `wxocr.dll` 与微信版本匹配，插件没有下载到一半或被清理。
- 确认没有同时运行多个不兼容的包装实例；失败时仍应调用 `stop_ocr()`。
- 若 Koffi 报 `Type <anonymous_N> cannot be used as a parameter`，检查回调参数是
  `koffi.pointer(koffi.proto(...))`，而不是直接传 proto。

### 安装包内失败、开发态正常

- 用进程内日志确认实际 `koffi.load()` 路径；它应当包含
  `resources\app.asar.unpacked\`，不能包含 `resources\app.asar\`。
- 解包后检查文件是否实际存在，而不是只依赖 Electron 对 `fs.existsSync` 的 asar
  补丁。
- 检查打包产物是 x64，且 `wcocr.dll` 与 `wxocr.dll` 位数一致。

### 进程卡住或退出慢

- OCR 必须放在独立子进程并设置超时；超时后终止子进程，不能无限等待。
- 正常路径和异常路径都要调用 `stop_ocr()`；不要把它放在只在成功分支执行的代码里。
- 不要为了方便调试而打印完整回调 JSON。

## 冒烟验证

```powershell
node scripts/wechat-ocr-native-smoke.js `
  --image C:\temp\ocr-test.png `
  --wrapper C:\temp\wcocr.dll
```

通过时输出类似：

```json
{"ok":true,"errcode":0,"lines":31,"textChars":367,"elapsedMs":339,"pluginVersion":"8096","wechatVersion":"4.1.15.13"}
```

字符数会随测试图片变化；关键判据是 `ok=true`、`errcode=0` 且进程正常退出。
