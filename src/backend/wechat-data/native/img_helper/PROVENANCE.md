# img_helper.dll（原图自动下载组件）provenance

## 这是什么

一个 23,040 字节的 Windows x64 原生 DLL，导出三个 C ABI：

| 导出 | 原型 | 作用 |
|---|---|---|
| `InitImgHelper` | `bool InitImgHelper(uint32 pid, const char* whitelist)` | 把一段 shellcode 注入目标微信进程（依据 `Weixin.dll` 内符号 `mars::cdn::CdnCore::` / `_startDownloadMedia` 定位），之后目标应用收到图片时按自身策略下载高清原图 |
| `UninstallImgHelper` | `void UninstallImgHelper()` | 释放远程分配并还原被备份的原始字节 |
| `GetImgHelperError` | `const char* GetImgHelperError()` | 返回上一次错误的人类可读说明 |

`whitelist` 为空指针 / 空串 = 对所有会话生效；否则是 **NUL 分隔、双 NUL 结尾** 的会话 username 列表
（`a\0b\0\0`）。

## 来源与许可

- 上游：`WeFlow-X`（内部工程名 `mmtools`），`https://github.com/hicccc77/weflow-x`
- 上游路径：`resources/image/win32/x64/img_helper.dll`
- 许可：**MIT**（Copyright (c) 2026 cc (WeFlow-X)），全文见同目录 [`LICENSE`](LICENSE)
- 本仓库引入方式：与上游 HEAD **逐字节相同**的二进制副本（无修改），随包放在
  `native/img_helper/win32-x64/img_helper.dll`；`electron-builder` 的 `asarUnpack`
  已覆盖 `src/backend/wechat-data/native/**`，打包态落在 `app.asar.unpacked` 下。

## 完整性

| 项 | 值 |
|---|---|
| SHA-256 | `79596be6f0da84f25a763973f6d1a439bcd8df2c0300891f6d419984f16cfc91` |
| 字节数 | 23,040 |
| 编译器 | MSVC 14.44（x64 C++） |
| PE 时间戳 | 2026-04-28T23:22:20Z |
| 导入 | `KERNEL32` / `MSVCP140` / `VCRUNTIME140` / `api-ms-win-crt-*`（无 WeChat SDK 依赖） |
| 上游 PDB | `D:\a\mmtools\mmtools\img_helper\x64\Release\img_helper.pdb` |

运行期会在 `koffi.load()` 之前用 `node:crypto` 复核上面这份 SHA-256；不一致直接拒绝加载
（`IMAGE_AUTODOWNLOAD_COMPONENT_INTEGRITY`）。

## 已知边界（在代码注释与隐私说明里同样写明）

- **仅 Windows x64**；需要微信 PC 版正在运行（`Weixin.exe`）。
- **只影响注入之后新收到 / 新同步到的图片**；历史图片不会补下载（仍需在微信里点开原图，
  由「原图自动收割」接走）。
- 微信版本兼容性未声明：上游 provenance 的 `testedWechatVersions` 为空。组件找不到目标符号时
  `InitImgHelper` 返回 false，错误文本经 `GetImgHelperError()` 透出。
- 注入是进程内的：应用正常停止会调用 `UninstallImgHelper`；应用被强杀时微信可能保持被修改状态
  直到微信重启 —— 本仓库用 marker 文件记录并在下次启动如实回报，见
  `src/backend/wechat-data/src/query/wechat-image-autodownload.ts`。
- 该组件不联网；它只是让**微信**走它自己的下载路径。
