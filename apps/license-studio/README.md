# Super Time 授权签发台（Win32）

本目录是厂商本机使用的 **Windows 原生 Win32** 许可证签发工具，不再使用 Electron 作为默认入口。

功能与原先签发台对齐：

- 管理 / 生成 Ed25519 密钥对（私钥必须在仓库之外，默认 `~/.supertime/`）
- 导入客户激活请求或手填设备指纹
- 按功能目录签发 `license.json`
- 用当前公钥校验已签发许可证

签名、载荷结构和私钥位置规则**不在 C++ 里重写**，而是调用同目录的 `engine.js`，由它复用仓库根的 `src/license` 与 `scripts/license-key-path`。这样签发结果与主应用、`npm run license-keygen` / `license-issue` 保持兼容。

## 应用托管（2026-11-24）

功能目录里新增「应用托管」分组与「应用托管实例」功能位（id `apps-superlanguage`）。
勾选后：

- **「席位（= 应用实例数上限）」同时是这张证允许绑定的 SuperLanguage 实例数**。Super Time
  自身按设备指纹绑定，不使用这个数字。
- 点「应用托管额度…」可以再单独指定：实例数（`0` = 跟随席位）、每小时任务上限、允许的能力
  （会话搜索 / 文本发送 / 附件发送 / 群成员 @）。语义与校验在 `engine.js` 的
  `buildAppsSection` 与 `src/license/service.js` 的 `getAppEntitlement` 里，
  界面只负责编辑，算错也签不出非法证。
- 没勾「应用托管实例」时该按钮是灰的；硬塞额度会被 engine 拒绝
  （`未勾选「SuperLanguage 应用托管」，不能填写应用额度`）。
- 高级 / 自动化调用 `engine.js issue` 时，表单可直接带 `apps` 字段：

```json
{
  "features": ["wechat-data", "apps-superlanguage"],
  "seats": 3,
  "apps": { "superlanguage": { "maxInstances": 3, "caps": ["search", "send"], "maxJobsPerHour": 60 } }
}
```

> ⚠️ **新版证书按清单逐项授权**（`featureSchemaVersion = 2`），不再享受旧证「基础位兼容
> 所有数据模块」的待遇：漏勾哪一项，客户那边就真的没有那一项。界面默认全选，
> 点过「仅基础」之后签发前请再核对一遍。

## 启动

先编译（只需一次，或源码变更后）：

```bat
apps\license-studio\build.bat
```

然后任选其一：

- 双击 `tools\LicenseStudio.cmd`
- 在仓库根执行 `npm run license-studio`
- 直接运行 `apps\license-studio\build\LicenseStudio.exe`


## 构建产物

`build/` 下的 `LicenseStudio.exe` 以及 `.obj` / `.res` / `.pdb` 都是本地产物，**不要提交**（本目录 `.gitignore` 已覆盖）。

## 密钥与安全

- 不要把私钥、证书或客户许可证提交进仓库。
- 「生成密钥对」会覆盖仓库外的私钥，并把公钥写到 `vendor-keys/` 与 `src/license/public-key.js`；旧证将全部失效。使用前请确认。
- 隔离测试应通过 `--test-root <仓外目录>` 把私钥、vendor 公钥和客户端公钥重定向到临时目录，不要改真实密钥。
