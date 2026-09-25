# wxhook「获取原图」拆解与嵌入方案

> 分析对象：`F:\wxhook-main`（C++ 注入式微信 4.x hook 工程，MinHook + httplib）
> 目标项目：Super Time（`D:\super-time-wechat`，Electron + TS，只读本机微信数据）
> 日期：2026-09-26　结论口径：**已在目标运行时（Node + koffi）实证**

---

## 0. 一句话结论

wxhook 的「获取原图」不是一件事，是**三条互不相干的路**，能不能嵌进来差得很远：

| 路 | 做什么 | 需要什么 | 能否嵌入本项目 |
|---|---|---|---|
| **A 改档下载** | 在微信启动 CDN 下载任务前，把 `task+0xD0` 从 3（缩略图档）改成 1（原图档），微信自己去下高清原图 | **DLL 注入 + MinHook + 版本相关 RVA** | ❌ 与本项目「不注入、不 hook」承诺冲突 |
| **B 抓真实 URL** | hook mmcronet / ws2_32 / xlog，抄出「微信实际发出的带签名 CDN URL」 | 同上 | ❌ 同上；且本项目已有更干净的等价物（`tphdurl` 免登录直链） |
| **C 文件侧离线** | V2 `.dat` 解密 + **wxgf→JPEG 转码** + 三档（`_t`/`.dat`/`_h`）判定 | 只读本机文件 + 调用微信安装目录里的 `VoipEngine.dll` | ✅ **唯一可直接嵌入的部分** |

**值得嵌的只有 C 里的 wxgf 转码这一件事**，而它恰好是本项目今天最大的一个洞：本机实测
**59,673 个 `.dat` 里有 5,109 个解出来是 wxgf**（主体档 4,748 + `_h` 档 361），
现在全部落到前端那句「🖼️ wxgf 原图（需系统 HEVC 解码）」。

为什么这条不算「注入」：DLL 加载进的是**我们自己的进程**，读的是**我们自己的文件**，
不碰微信进程、不写微信数据 —— 与 `docs/PRIVACY.md:43` 的「不写入、不修改、不注入、不 hook
微信进程」不冲突。这一点是整份方案能不能做的前提，详见 §7.1。

---

## 1. wxhook 侧：实现拆解

### 1.1 路径 A —— CDN 档位改写（`src/wx/cdn_probe.cpp`）

**核心事实**：同一条消息的三档（缩略/中/高清）**共用同一个 fileid**，档位由一个独立字段决定：

| 字段 | 值 | 含义 | 实测 |
|---|---|---|---|
| `task+0xD0` | 3 | `cdnthumblength` 档 | 3–9 KB |
| `task+0xD0` | **1** | `hdlength` 档 = `mars::cdn::kMediaTypeFullSizeImage` | **394,046 B，与消息 XML 的 `hdlength` 一字不差** |

关键代码：

- `cdn_probe.cpp:574-592` `IsImageCdnTaskPod()` —— **只对图片任务动手**的判据（两个）：
  1. `task+0xB0`（std::string，保存路径）含 `ImageTemp` / `_thumb_temp` / `\Img\`；
  2. `task+0x70`（fileid）以 **`305f02`** 开头。
- `cdn_probe.cpp:594-613` `FixFilekeyTailPod()` —— filekey 形如
  `<wxid>_<ts>_<seq>_<filetype>`，**末尾恰好一个数字就是档位**，必须与 `+0xD0` 同步改，
  否则两者不一致。只改 1 个字符、长度不变 ⇒ 不触碰任何指针与分配。
- `cdn_probe.cpp:615-728` `Hook_Cdn550()` —— 挂在 `FUN_0x228A550`（启动 C2C 下载前的最后准备，
  它读 `task+0xB0` 与 `task+0x380`，校验通过后调 `StartC2CDownload`）。
  **`__try/__except` 包住所有内存访问**，最坏情况只是这次下载失败，不会因指针损坏而崩微信。
- `cdn_probe.cpp:1104-1115` 安装点：`base + Wx4CdnStart550Rva`。
- 开关：`SetHdAuto(on, val)`（`cdn_probe.cpp:1491`）默认 **开启**；HTTP 面 `GET /cdn/hd?auto=1&val=1`。

**依赖**：`MinHook`（third_party/minhook）+ `Weixin.dll` 导出地址/版本内 RVA 表
（`src/wx/wx_offsets_4x.h`，按微信版本一版一张，见 `docs/compose/spec/wx4-offset-relocation-413.md`）
+ 配置开关 `cfg::WX4_INSTALL_HTTP_PROBE_HOOKS`（`src/core/config.h:142`）。

**为什么必须注入**：CDN URL 由**服务器按请求下发**，客户端无法伪造（`wx4-c2c-task-struct.md` §1）。
要让微信去下原图，只能改它进程里的任务结构。

**另一条被否掉的路**（对方案设计有借鉴价值）：wxhook 一开始试过「模拟鼠标点开大图」，
`cdn_probe.cpp:1219-1479` 实现了三种输入注入（`mouse_event` / `SendInput` / `PostMessage`），
结论是**三种都打不开 Qt 的图片查看器**（`cdn_probe.h:48-53` 注释在案）——
所以 UI 自动化路线不可靠，这也是它转向进程内改字段的原因。

### 1.2 路径 B —— 抓真实 CDN URL（同一批 hook）

三个抓取点，按可靠性递增：

| 点 | 位置 | 拿到什么 | 结果 |
|---|---|---|---|
| `ws2_32!send/WSASend` | `cdn_probe.cpp:233-276` | 明文 HTTP 体 | ❌ 只看到 `POST /mmtls/<hex>  Upgrade: mmtls` **密文** |
| `mmcronet::Request/Fetch/FetchWith` | `cdn_probe.cpp:949-971` | 第 3 参即完整 URL | ✅ 导出表地址，零猜测 |
| `xlog::Write` + **fmt 白名单** | `cdn_probe.cpp:782-920` | 日志参数里的 `ctrlinfo url` / `bakurl` | ✅ 加密之前唯一的可靠位置 |

关键证据（`cdn_probe.h:11-17`）：**URL 不落任何缓存** —— 扫进程内存 729 MB 零命中、
11 种 URL 组合全部 400/403/404。要拿到原图就得在**请求构造点**抄。

HTTP 面：`GET /http/urls?filter=cdn&limit=50`（`http_server.cpp:332`）。

> 对本项目的意义：**这条路我们不需要**。微信在消息 XML 里给 `tpurl` / `tphdurl` 时，
> 那本身就是一条**免登录预签名直链**（`query/image-original.ts` 已实现，本机覆盖 16.2%），
> 不需要抓包、不需要注入、不需要登录态。

### 1.3 路径 C —— 文件侧离线（**唯一可移植**）

三块，本项目**已有两块**：

**① V2 `.dat` 格式与密钥派生**

```
0   6   魔数 \x07\x08V2\x08\x07
6   4   AES 段长度（LE u32，实测 1024）
10  4   XOR 段长度（LE u32）
14  1   标志位（01）
15  N   AES-128-ECB 加密的头部
15+N  16  分隔尾（跳过，不参与解密，**因机而异不可硬编码**）
+16  M  单字节 XOR 的尾部
总长：file_size == 15 + aes_size + 16 + xor_size
```

密钥：`aes_key = md5(f"{code}{clean_wxid}")[:16]`（16 个 ASCII 字符直接当密钥）、
`xor_key = code & 0xFF`；`code` 来自 MMKV 文件名
`%APPDATA%\Tencent\xwechat\net\kvcomm\key_<code>_*.statistic`。
**完全离线，不需要扫内存**（wxhook 实测：扫 712 MB 内存 58 万候选 0 命中——微信只在
「正在查看图片」的窗口期把 key 载入内存）。

**② 档位判定**（微信为同一张图最多存三份）

| 文件 | 档位 | 何时存在 |
|---|---|---|
| `<md5>_t.dat` | 小缩略图 | 始终有 |
| `<md5>.dat` | 聊天显示版 | 收到消息即下载 |
| `<md5>_h.dat` | **高清原图** | **只有点开过大图才下载** |

「是否原图」最硬的判据 = **`_h.dat` 是否存在**（wxhook 用 md5 比对过：
某图 `_h.dat` 与 `.dat` 字节完全相同 ⇒ 那份 `.dat` 就是原图）。

**③ wxgf → JPEG 转码**（本项目缺的就是这块）

微信自研封装格式，头 `77 78 67 66`（"wxgf"）。解码器在**微信安装目录**的
`VoipEngine.dll`。wxhook 反汇编（`disasm_voip.py`）得到的关键点：

```
wxam_dec_wxam2pic_5:
    mov rax, [rsp + 0xa0]        ; 第 5 个参数 = 指针
    movups xmm0, [rax]           ; ★ 解引用 [rax]
    movups xmm1, [rax+0x10]      ; ★ 且读 [rax+0x10]
```

⇒ **第 5 参必须是指向 ≥0x20 字节结构的有效指针**，传 `NULL` 必然访问违规
（这就是公开示例在本版上崩掉的原因）。传一个全零的 64 字节结构即可正常工作。

两个实测细节（缺一个产物就是坏的）：
1. 输出**带 24 字节 trailer**，必须截断到**最后一个 `FF D9`**（否则 JPEG 没有 EOI）；
2. `wxam_dec_getWXGFInfo_5` 可独立取宽高，用于**交叉验证**转码结果。

**HTTP 端点**：`GET /image/decode`（`http_server.cpp:300`，按目录批量解密）、
`GET /voice/decode`、`GET /cdn/patch`、`GET /cdn/hd`、`GET /http/urls`、`GET /image/open`。

### 1.4 一个不一致（值得点出）

`docs/compose/spec/wx4-image-decrypt.md` §七.1 写着「`/image/decode` **已改走 V2 流程**」，
但代码里没有：

- `src/wx/media_files.cpp:184` → `image_decoder.cpp:252` `DecodeImageFileSync` →
  `image_decoder.cpp:60-126` `DecodeImage`，**只做整文件单字节 XOR**；
- `image_decoder.cpp:35-57` `DetectImageType` 的判据是「前 2 字节 XOR 后等于某 magic」——
  **对任意两字节都存在 key 使其成立**，是弱判据（所以旧实现"看起来成功"、产物是伪 BMP）；
- 全仓 `src/**/*.cpp` 搜不到 AES/BCrypt 引用，V2 逻辑只活在 `.workbuddy/verify/*.py` 脚本里
  （`derive_v2_key.py` / `decrypt_v2_images.py` / `wxgf_convert.py`）。

**对本项目的意义**：wxhook 的 V2 与 wxgf 逻辑是**脚本形态的参考实现**，不是可直接调用的库；
而且要嵌的是**算法与调用约定**，不是它的 C++ 代码。

---

## 2. 本项目现状与差距（附本机实测）

### 2.1 已经有的（**不要重复造**）

| 能力 | 位置 | 状态 |
|---|---|---|
| V2 密钥派生（同 wxhook 同式） | `query/image-key-resolver.ts:106`（`{ xorKey: code & 0xFF, aesKey: digest.slice(0,16) }`）、`:351-352` 的 kvcomm 文件名正则 | ✅ |
| AES+XOR 解码（V1/V2/XOR 三形态） | `query/media-image.ts:319-364` `decodeDatBytes()` | ✅ |
| 档位排序 | `media-image.ts:660-665` `scoreDatPath()`、`decrypt-images.ts:19-23`（**两份重复实现**） | ⚠️ 见 §2.2 |
| 双槽缓存（最好的一份 / 缩略兜底） | `media-image.ts:389-405` `cachedImage()`、`:672-676` `writeDecodedCache()` | ✅ |
| 免登录原图直取（`tphdurl`/`tpurl`） | `query/image-original.ts` 全篇 | ✅（覆盖 16.2%） |
| 批量解密落缓存 | `query/decrypt-images.ts` `decryptAllImageDats()` | ✅ |
| 单张 Remote / 批量 Remote / 原图直取 Remote | `gateway-data-ops.ts:545 / :567 / :622` | ✅ |

### 2.2 缺的（= 要嵌的东西）

**差距 1（主）：wxgf 只标不支持，不解码。**
`media-image.ts:356-359` 认出 wxgf 魔数后**直接返回 `format: 'hevc'`**；消费端一律跳过：

- `media-image.ts:476` `if (dec.format === 'hevc') continue`
- `media-image.ts:496`、`media-image.ts:605`（表情）、`decrypt-images.ts:16` `WRITE_EXTS` 不含 hevc
- 前端文案：`chats-media.tsx:113` 「🖼️ wxgf 原图（需系统 HEVC 解码）」、`:648-650`

**本机实测**（`msg/attach` 下 59,673 个 md5 前缀 `.dat`，只 AES 解首块判魔数）：

| 档位 | 可渲染（jpg/png/gif/webp） | **wxgf（今天报不支持）** |
|---|---|---|
| `_t.dat` | 51,982 | 0 |
| `_h.dat` | 610 | **361** |
| 主体 `.dat` | 1,972 | **4,748** |

⇒ **合计 5,109 张图**今天解不出来（含同一图两档重复计）。抽样 12 个 `_h.dat`
走完整链：wxgf 7 个 → **转码 7/7 成功**，得到 1280×1707 / 1440×1080 / 2048×1017 等真原图。

**差距 2：档位排序把「原图档」当缩略图。**

`scoreDatPath` 是 `_t=2 / _h=1 / 其他=0`，注释写「Prefer originals over thumbnails」——
**把主体 `.dat` 排在了 `_h.dat` 前面**。但实测相反：

| 抽样（同一 md5 同时有 `_h` 与主体 `.dat`） | 结果 |
|---|---|
| 本机 971 个 `_h.dat` 中，491 个同时有主体 `.dat` | 28/28 抽样 **`_h` ≥ 主体** |
| 典型差值 | `_h=2,950,827 B` vs 主体 `54,335 B`（**54 倍**）、`_h=663,995` vs `52,551` |

连带 `writeDecodedCache(..., thumb = scoreDatPath>0)`：`_h` 被判成缩略 → 写进 `<md5>.t.<ext>`
**兜底槽**，占不到「最好的一份」那个槽。

⚠️ **但这条不能单独改** —— `_h.dat` 有 37%（361/971）是 wxgf，在**没有转码**的今天，
把它排到前面等于用「解不开的 HD」挡住「能渲染的聊天版」。**排序修正必须与转码同批上线。**

**差距 3：没有「这份是不是原图」的标注。** 界面只有 `thumb: true/false`（缩略兜底与否），
没有「原图 / 聊天版 / 只有缩略图」的三态。wxhook 的判据（`_h` 存在 + md5 比对）可以直接用。

**附：一个潜在陷阱。** 本机还有第四档 `<md5>_b.dat`（气泡图，4,409 个，
位于 `msg/<日期>/Message/<md5>/Bubble/`，**不在 `msg/attach` 下**）。
现在的路径候选（`imageCandidatePaths()`，`media-image.ts:716-730`）只覆盖 `msg/attach/**`
所以取不到它，暂时安全；但 `scoreDatPath` 对**未知后缀一律返回 0**（= 当成最好的）——
哪天有人给 `Message/*/Bubble/` 加了候选路径，气泡图会**顶掉原图**。要么别加，要么把
`scoreDatPath` 改成显式白名单（未知后缀给最低优先级）。

---

## 3. 嵌入方案（三期，P0 已实证）

### P0：wxgf 转码最小闭环（**建议先做这一期**）

新增一个只做一件事的模块：**把 wxgf 字节转成 JPEG**。

1. 新增 `src/backend/wechat-data/src/query/wxam-image.ts`：
   - `resolveVoipEnginePath()`：`weixinInstallPath()`（`config/detect.ts:53`，读注册表
     `HKCU\Software\Tencent\Weixin\InstallPath`）+ `weixinVersion()`（`:75`，版本目录名）
     ⇒ `<install>/<version>/VoipEngine.dll`（本机实测 `D:\Tencent\Weixin\4.1.15.13\VoipEngine.dll`，20.8 MB）；
   - `transcodeWxgf(bytes)`：`koffi.load(dll)` 惰性单例 + 绑定 `wxam_dec_wxam2pic_5`
     （签名 `int64(int64, int, int64, int*, void*)`），第 5 参传**全零 64 字节 Buffer**，
     输出 buffer 按 `getWXGFInfo_5` 的宽高先估尺寸（**不要每次无脑 52 MB**），
     截断到最后一个 `FF D9`；返回 `{ ok, bytes, width, height } | { error }`；
   - **能力探测**：`isWxgfTranscodeAvailable()` —— DLL 不存在 / 版本目录识别不到 /
     导出找不到，都返回 false（不抛）。
2. 修改 `query/media-image.ts:356-359`：wxgf 分支先试转码，成功则返回
   `{ bytes: jpeg, format: 'jpg' }`，失败才退回 `'hevc'`（保持今天的降级行为）。
3. 修改 `query/decrypt-images.ts:16` `WRITE_EXTS` 加 `jpg`（转码产物）并把
   `skippedDetails` 的 wxgf 计数改成「转码失败」计数。
4. 前端文案（`chats-media.tsx:113 / :648-650`）：transcode 不可用时保持原话术，
   可用时不出现这句话（图直接渲染出来）。

**验证标准**：单测（真 wxgf 夹具 → jpg 且宽高非零，DLL 缺失时返回 error 不抛）+
wiring spec + 前端全量 + 全量 vitest；再用真实数据跑一遍
`_h.dat` 抽样（预期：抽样 12 个全成功，与本次 PoC 一致）。

### P1：档位与标注（必须与 P0 同批或紧随）

1. `scoreDatPath` **两份实现**（`media-image.ts:660` / `decrypt-images.ts:19`）统一成
   `_h=0 / 主体=1 / _t=2 / 其他=3`（`_h` 最优先），并抽到一个共享位置（避免第三次重复）；
2. `writeDecodedCache` 的 `thumb` 判定改为「`_t` 才算 thumb」，`_h` 解出的写**主槽**；
3. `ImageDataUrlResult` 增加 `tier: 'original' | 'chat' | 'thumb'`（外加可选
   `transcoded?: boolean`），前端在气泡角标/查看器标题上标「原图 / 高清」；
4. 新增「本机是否有原图」的轻量 Remote（只查 `_h.dat` 是否存在，不读字节），
   给界面一个「微信里点开一次可拿高清」的引导。

### P2：CDN 档位改写（**建议不做，除非产品定位改**）

若真要做，最小形态是：**独立的可选 helper**（从 wxhook 的 `cdn_probe.cpp` 抽出
「install hook → 改 `task+0xD0` → unhook」），以显式 opt-in 的方式启动，
并且必须先解决 §7.1/§7.2 两条（隐私承诺改写 + 版本漂移维护）。
**不建议**把它做进主程序：它把「只读分析工具」变成「会改微信运行时行为的工具」，
风险类别与维护成本都不是一个量级。

---

## 4. 需要新增 / 修改的代码位置

| 动作 | 文件 | 要点 |
|---|---|---|
| **新增** | `src/backend/wechat-data/src/query/wxam-image.ts` | koffi 绑 DLL + 转码 + 能力探测。放 `query/**`（M24：query 可 import `config`，见 `tests/layer-direction.spec.ts:38` 的 `ALLOWED`、`:60` 的 `QUERY_GLUE_ALLOW`） |
| **修改** | `query/media-image.ts:356-359` | wxgf 分支接转码；`:660-665` `scoreDatPath` 排序；`:672-676` `writeDecodedCache` 的 thumb 判定；`:441-507` `decodeImageDataUrl` 的 `hevc` 早退路径（`:459`）也要重试一次转码 |
| **修改** | `query/decrypt-images.ts:16-23` | 去掉重复的 `scoreDatPath`（改 import 共享实现）；`WRITE_EXTS` 加 `jpg`；跳过原因文案改「转码失败」 |
| **修改** | `types.ts` / `types-*.ts` | `ImageDataUrlResult` 加 `tier`、`transcoded` |
| **修改** | `remotes/media.ts:152` 附近 | `getImageOriginal` 之外新增「是否有原图」的轻量查询（或复用它加参数） |
| **修改** | `gateway-data-ops.ts:545/567/622` | 新 Remote 转发（**Remote 计数 169 → 170**：`docs/API.md` 由 `gen-api-docs.js` 自动更新，`OnboardingShell.tsx` 那个**手写值**要同步 —— H14 守卫会咬） |
| **修改** | `api-core.ts` / `api-read.ts` | 镜像接口 + api 函数（**新 Remote 必须同步镜像接口**，否则客户端 typecheck 红） |
| **修改** | `chats-media.tsx:113 / :648-650` | 转码可用时不再显示「需系统 HEVC 解码」 |
| **新增** | `tests/wxam-image.spec.ts`、`tests/wxam-image.wiring.spec.ts` | 算法单测（夹具）+ 接线守卫（**必须做变异测试**，项目 gate 纪律） |
| **修改** | `docs/PRIVACY.md` §一 | 增加一条「读取微信安装目录的解码库（`VoipEngine.dll`）」——见 §7.1 |
| **修改** | `src/backend/wechat-data/README.md:141,166` | 那两句「高清原图（wxgf/HEVC）以缩略图兜底」要按新事实改写 |

**⚠️ 不要改 `media-image.ts` 太多**：它已 868 行，而 M21 棘轮
（`src/backend/tests/m21-file-size-ratchet.spec.ts`）的上限是 **1000 行、白名单已清空**
（`ALLOWLIST = {}`，只许新建文件、不许把大文件再养大）。

---

## 5. 接口对接方式

**约定：原图能力不新增"取字节"的 RPC**，因为字节已经有主（`getImageDataUrl` 返回 data URL）。
新增的只是**元信息**与**一个降级说明**：

```
// 现有（不动签名，只加可选字段）
getImageDataUrl({ username, localId })
  → { url?, format?, thumb?, error?, tier?: 'original'|'chat'|'thumb', transcoded?: boolean }

// 新增（轻量，不读字节，只判断本机有没有原图档）
getImageTier({ username, localId })
  → { tier: 'original'|'chat'|'thumb'|'none', hasHdFile: boolean, hdIsWxgf: boolean,
      transcodeAvailable: boolean }
```

- `tier` 的判据（与 wxhook 同）：`_h.dat` 存在 ⇒ `original`；否则主体 `.dat` 可渲染 ⇒ `chat`；
  只有 `_t.dat` ⇒ `thumb`。
- `transcodeAvailable=false` 时前端**必须**保留今天的文案（不能假装有原图）。
- 后端组装点：`query/media-image.ts` 已有 `resolveImageResourceHint` + `findDatFiles`，
  新增的判定直接复用，不重写定位逻辑。
- 前端消费：`chats-media.tsx` 的查看器标题与气泡角标；`use-image-preload.ts` 预取的分支不变
  （转码产物照样进 `image-cache` 内存缓存，无需改动）。

---

## 6. 配置调整

| 项 | 建议 | 理由 |
|---|---|---|
| `VoipEngine.dll` 路径 | **不新增配置项**，一律从 `weixinInstallPath()`+`weixinVersion()` 推导 | 与既有的 `weixinVersion()` 用法一致（`gateway-read.ts:386-389`），少一个会写错的旋钮 |
| 转码开关 | 新增 `wxgf_transcode: true`（默认开）+ 设置页开关 | 与现有「原图解密方式 / 自动获取原图（CDN）」两个开关同族；给「不想让本应用加载微信 DLL」的用户一条退路 |
| 版本白名单 | 可选：记录**验证过的版本**（如 `4.1.15.13`），未验证版本仍尝试但记一条诊断日志 | 微信升级后导出可能变，宁可在日志里留痕，也不要静默失败 |
| 输出上限 | 复用 `MAX_ORIGINAL_BYTES`（64 MB）语义，转码输出按 `getWXGFInfo` 预估而非固定 52 MB | 固定 52 MB × 并发 = 内存尖峰 |

配置读写落点：`config/wechat-config.ts` 的默认值对象（`:65` 一带）+ 设置页
（`panels/settings-*`），并按项目惯例补一条 config 守卫。

---

## 7. 冲突点与注意事项（**这一节是重点**）

### 7.1 隐私承诺：路径 C 是合规的，但**必须补一句**

`docs/PRIVACY.md:43` 承诺「不写入、不修改、不注入、不 hook 微信进程」。
路径 C **不碰微信进程**（DLL 加载进我们自己的进程、只读我们自己的文件），所以不违反承诺；
但 §一「我们读什么」现在只列了「解密后的 SQLite / 媒体缓存」与「运行中的微信进程内存（只读）」，
**没提"从微信安装目录读一个 20.8 MB 的第三方二进制并调用它"**。建议：

- 在 §一 增一条，注明：只读、不写、不执行安装目录里的可执行文件（`Weixin.exe`），
  仅把解码库映射进本进程内存用于解自己的文件；
- 是否提升 `PRIVACY_VERSION`：**倾向不提升**（数据用途没变、无新增出网），
  与 2026-09-15 那次「纯开关层面的行为收敛不提升版本」同例；但应在 consent 页的
  「本次无变更」说明里点一句，避免用户事后觉得被绕过。

### 7.2 加载第三方专有 DLL 的三类风险

1. **不进安装包**：`VoipEngine.dll` 属于微信，**不得随包分发**（许可与体积双重原因）。
   只能就地加载。⇒ 打包白名单**不需要改**（`asarUnpack` 不用加它），
   反而要确保它**永远不会**被打进去。
2. **原生崩溃面**：DLL 内部如果崩了，**JS 层 try/catch 拦不住**，utilityProcess 会整个死。
   建议：① 只在必要时加载（惰性）；② 调用前把入参长度/指针校验清楚；
   ③ 记一条调用计数与耗时，异常时能定位；④ 给用户可见的「关闭转码」开关（§6）。
3. **版本漂移**：本次验证基于 **4.1.15.13**（`wxam_dec_wxam2pic_5` 是导出符号 —— 已用
   PE 导出表读出该 DLL 共 166 个命名导出，相关 36 个）。wxhook 自己就有整篇
   `wx4-offset-relocation-413.md` 讲版本迁移，本项目也有 skill
   `win-binary-offset-relocation`。⇒ **导出名比 RVA 稳定**（那是符号表，不是偏移），
   这是我们比 wxhook 幸运的地方；但仍应记录验证过的版本。

### 7.3 与项目纪律的冲突

| 纪律 | 影响 |
|---|---|
| **M21 单文件 1000 行**（白名单空） | `media-image.ts` 已 868 行 ⇒ 转码逻辑必须**新文件**，`media-image.ts` 只加 ≤ 十几行调用 |
| **M24 分层** | 新文件放 `query/**`（可 import `config`）；**不要**新建顶层目录（那会变成 glue，query→glue 需要改白名单，且后患更大） |
| **新 Remote 三处计数** | `docs/API.md`（自动）+ `OnboardingShell.tsx` 手写值 + `api-core.ts` 镜像接口。**H14 守卫会咬**（上一轮已经栽过一次） |
| **每个新守卫必做变异测试** | 转码守卫至少要能咬住「DLL 缺失时假装成功」「截尾到最后一个 FFD9」两处 |
| **CSS/几何守卫无关** | 本改动**不动 CSS**，不必跑几何守卫；但前端文案改动要过 `ui:smoke` |

### 7.4 顺序耦合（最容易踩的一个）

- **排序修正（`_h` 优先）不能先于转码上线**，否则 361 个 wxgf 的 `_h.dat` 会挡住
  本来能渲染的主体 `.dat`，**净效果是变差**。
- **批量解密路径（`decrypt-images.ts`）必须同批接转码**，否则用户点一次「批量解密」，
  `_h` 的 wxgf 会被记成「跳过」，缓存里仍然没有原图，看起来像"没生效"。
- **缓存槽位与排序改的是同一件事的两面**：`_h` 排到最前，就必须写主槽；
  写主槽以后，用户之后在微信里点开原图（attach 里多出更大的 `.dat`）时，
  现有的「谁先解出来谁占坑」缺陷会回来 —— `media-image.ts:376-388` 的 JSDoc（「谁先解出来谁永久占住」一条）记录了 2026-09-20
  那次修复（106 条缓存里 35 条被缩略图占住），**改槽位判定时必须保留那条不变量**。

### 7.5 不要顺手做的事

- ❌ 不要移植 wxhook 的 `/image/open`（模拟点击）——它已自证无效（三种输入注入都打不开
  Qt 查看器），且会抢占用户鼠标与前台焦点。
- ❌ 不要把 wxhook 的 `xlog fmt 白名单` 搬过来 —— 那是抓包用的，本项目走消息 XML 里的
  预签名直链（`tphdurl`），不需要抓。
- ❌ 不要把 `image_decoder.cpp` 那套 V1 XOR 逻辑搬过来 —— 它的 `DetectImageType`
  是弱判据（任何文件都能"匹配"到某个格式），本项目 `decodeDatBytes` 已经更严格。

---

## 8. 验收标准

| 期 | 命令 | 预期 |
|---|---|---|
| P0 | `vitest run src/backend/wechat-data/tests/wxam-image*.spec.ts` | 转码单测全绿；DLL 缺失/版本不符时返回 error 且**不抛** |
| P0 | 真机抽样（本文件 §2.2 的脚本改写） | `_h.dat` 抽样 12 个：wxgf 7 个 → 转码 7/7，宽高非零 |
| P0 | `build:backend` + `build:types` + 四份 typecheck | 0 错（`lib/**` 入仓，必须重建） |
| P1 | `docs:api:check` + H14 | Remote 计数一致（169 → 170） |
| P1 | 前端全量 + `ui:smoke` | 全绿；wxgf 图片不再出现「需系统 HEVC 解码」 |
| 全部 | 全量 vitest | 12 failed 全为已知环境类（沙箱 spawn 受限），零真失败 |
| 全部 | 新守卫变异测试 | 逐处咬红 + 逐字节还原 |

---

---

## 附：P0 实施记录（2026-09-26，commit 见 git log）

按本文 §3 的 P0 落地，**P1（档位语义）一并做了**（两者耦合，见 §7.4）。

### 实际改了哪些文件

| 文件 | 动作 |
|---|---|
| `src/backend/wechat-data/src/query/wxam-image.ts` | **新增**：DLL 定位（按版本号倒序扫，`DSH_WECHAT_VOIP_ENGINE` 可覆盖）、koffi 懒加载、`createWxgfTranscoder`（可注入替身）、`jpegDimensions`、能力探测 |
| `src/backend/wechat-data/src/query/media-image.ts` | `decodeDatBytes` 加可注入的 `opts.wxgf` 并在 wxgf 分支调转码；`scoreDatPath` → `datTierOf`/`datTierRank`/`isThumbTier` 并导出；`.hevc` 早退受转码能力约束 |
| `src/backend/wechat-data/src/query/decrypt-images.ts` | 删掉重复的档位实现（改用共享 API）；**按 md5 分组**；修「跳过判定只 continue 内层循环」的旧缺陷 |
| `src/client/.../chats-media.tsx` | 降级文案改写（「需系统 HEVC 解码」不再是事实） |
| `src/backend/wechat-data/tests/wxam-image.spec.ts` | **新增** 23 个用例（模块边界 11 + 接线 4 + 档位 3 + 批量 2 + 不变量 3） |

### 三处与计划不同 / 计划没预见到的

1. **并发竞态（计划没预见到）**：批量解密按档位全局排序后，同一个 md5 的 `_h` 与 `.dat` 会被**两个
   worker 同时取走** ⇒「谁先写主槽」变成竞态，实测并发 2 时 `.dat` 盖掉了 `_h`。
   修法：**按 md5 分组**，同一张图的档位回退链在同一个 worker 里按序走完。
2. **顺带修掉一个旧缺陷**：批量的「缓存命中就跳过」原先只 `continue` 了**内层** for ——
   记录写着「已存在解码缓存，无需重复解码」却照样解码，而且各档写同一个文件名、最后落盘的往往是
   `_t`（缩略图盖进主槽）。这正是 2026-09-20 那次「明明看过原图还是糊的」的另一半原因。
3. **不调 `wxam_dec_getWXGFInfo_5` 取尺寸**（计划里留了这条）：它的签名没验证过，调错会崩进程。
   改为从转码产物里**自己解析 JPEG 的 SOF**（纯 JS、可单测），并配一条守卫钉住
   「只允许绑定 `wxam_dec_wxam2pic_5` 这一个导出」。

### 真机实测（同一次扫描做 A/B 对照，生产 `decodeDatBytes`）

| 样本 | 改造前可渲染 | 现在可渲染 | 单张耗时（读盘+解密+转码） |
|---|---|---|---|
| `_h` 档抽样 60（共 971） | 36 | **60**（24 个是本次转码解开的） | 中位 32ms / max 49ms |
| 主体档抽样 60（共 6,720） | 8 | **60**（52 个） | 中位 23ms / max 68ms |

零失败。转码得到的真实尺寸与 wxhook 的记录同量级（2048×1017 / 1280×1707 / 1279×2769 …）。
脚本：`working/e2e-wxam-prod.ts`（产物 `working/e2e-wxam-out.txt`）。

### 仍未做

- **P2（CDN 改档）**：仍然不建议做（§7.1/§7.2 的理由不变）。
- ~~**旧缓存不会自动升级**~~ **已闭环**（见下节「附二」）：读取路径确实不会自己回头找更好的源
  （第 1a 步命中就返回），但新增了显式的 `upgradeDecodedImages`（设置页「升级为原图」）——
  判据是「重解结果**严格更大**才覆盖」，因此幂等、且永远不会把 CDN 取回的原图降级成本机较小那份。
  批量解密那条路**仍然**尊重「已有主槽缓存」（它的语义是「解没有的」），两者不重叠。
- **视频/朋友圈的 wxgf** 不在本次范围（视频封面另走 `media-video` 路径）。
- **打包关**：`koffi` 已在 `asarUnpack` 白名单且有 `packaged-smoke` 守卫（本次未新增依赖），
  但「打包产物里从 `app.asar` 之外加载微信 DLL」这条**未在真打包里实测过**。

## 9. 未验证 / 未知（如实标注）

1. **Electron utilityProcess 内加载 20.8 MB DLL** —— 本 PoC 是在**纯 Node 22** 下跑通的
   （koffi 加载 + 调用成功），utilityProcess 是同一运行时，但**未实测**；
   打包产物（把 DLL 从 `app.asar.unpacked` 之外的位置加载）也未实测。
2. **DLL 的依赖链** —— 本机直接加载成功说明其依赖可解析，但**没查清**它是否隐式依赖
   同目录其它微信 DLL/运行时；换一台机器（未装 VC 运行时？）表现未知。
3. **并发与内存** —— 转码 2048×1017 这类图的实际耗时与峰值内存**未测**（只测了成功率与尺寸）。
4. **非本机账号/其它微信版本** —— 只在本机 4.1.15.13 + 一个账号上验证过。
5. **HEVC 视频封面（`wxam_dec_*` 之外的路径）** 不在本方案范围。
6. **wxhook 侧未做的事**：它的 C++ `/image/decode` 至今没接 V2（§1.4），
   所以「wxhook 已经能拿原图」这个说法**只在 Python 脚本层面成立**。

---

## 附二：旧缓存升级的实施记录（2026-09-26）

起因：P0/P1 让「本机能解出 `_h` 原图」成立了，但**已经解过的图不会因此变清楚** ——
`decodeImageDataUrl` 第 1 步命中缓存就返回，不会回头看一眼 attach 里是不是多了一份更大的 `.dat`。
症状就是那句「我明明在微信里点过原图，这里还是糊的」。

### 设计要点（都写在 `query/image-upgrade.ts` 的模块注释里）

1. **判据是「严格更大」，不比档位**。老缓存没有记录自己是从哪一档解出来的，所以
   用最好的一档重解、只有结果**严格大于**缓存里现存最大的一份时才覆盖。三条性质是它的推论：
   **幂等**（第二遍解出同样字节 ⇒ 不算更大 ⇒ 不动）、**不降级**（CDN 原图比本机 `_h` 大 ⇒ 跳过）、
   **无需元数据**（老缓存也能修）。代价是「同字节数但质量更好的编码」不会被换 —— 刻意选的保守方向。
2. **只认可渲染扩展名做门槛，`.hevc` 不参与**（它不可渲染），但升级成功时**顺手清掉**同目录的
   `.hevc` 占位：`decodeImageDataUrl` 在转码能力不可用时会被它短接（`media-image.ts` 的早退判据）。
3. **写回「出现过该 md5 的每一个槽位」**：全局槽（批量解密/取原图写的）与会话子目录槽
   （逐条读图 `writeDecodedCache` 写的）都要升 —— 只升一个，另一条读图路径仍然是糊的。
4. **排除 `remote-images/`**：远端图片代理的缓存文件名**同样是 32 位十六进制**（它是 url 的 md5），
   不排除就会把一堆「本机根本没有 `.dat`」的条目算进待升级集合，界面上的数字全是假的。
5. **客户端要清内存缓存**：`image-cache.ts` 那份 LRU 是**全应用共用**的，跨面板切换不失效 ——
   不清的话用户升级完切回会话，首帧拿到的仍是旧缩略图，「升级成功」看起来像「什么都没发生」。

### 落地范围

| 位置 | 动作 |
|---|---|
| `query/image-upgrade.ts` | **新增**：扫解码缓存 → 按 md5 反查 attach → 重解 → 严格更大才覆盖 |
| `query/decrypt-images.ts` | 导出 `collectImageDatFiles` / `groupImageDatsByMd5`（遍历与档位排序**只有一份**） |
| `remotes/keysdec.ts` · `gateway-data-ops.ts` | 新 Remote `upgradeDecodedImages`（与批量解密**共用同一条忙闲闸门**） |
| `backend-rpc.js` | 进 `LONG_CALL_METHODS`（扫数万文件 + 逐条重解，量级与批量解密同档） |
| 设置页「图片解码」卡片 | 新增「立即升级」入口 + 独立进度块；解密/升级共用详情弹窗，标题跟着变 |
| 守卫 | `tests/image-upgrade.spec.ts`（13 例）、`panels/image-upgrade.wiring.spec.ts`（7 例）；变异 **15 处全咬**、逐字节还原 |

Remote 计数 169 → **170**（`docs/API.md` 自动 + `OnboardingShell.tsx` 手写值 + `api-core.ts` 镜像接口）。

### 真机实测（`working/e2e-upgrade-prod.ts`，产物 `working/e2e-upgrade-out.txt` / `e2e-upgrade-noop-out.txt`）

本机这份解码缓存是最近一次批量解密刚产出的，**已经是最好的那一档**，直接跑 `upgraded` 是 0 ——
那种结果证明不了升级链能工作。所以做成**对照实验**：先把一批图手动降级成「低档解出来的样子」
（这就是老缓存的状态），再跑升级，逐条核对是否**逐字节恢复**。

| 场景 | 结果 |
|---|---|
| 规模 | attach 下 59,674 个 `.dat` / 51,982 个 md5；缓存里 44 个缓存条目（35 主槽 + 9 缩略槽） |
| 对照实验（先降级 12 条→再升级） | `total 44 / upgraded 12 / unchanged 32 / noSource 0 / failed 0`，**12/12 逐字节恢复成原图** |
| 幂等（同一份数据再跑一遍） | `upgraded 0 / unchanged 44` —— **第二遍什么都不动** |
| 耗时 | 44 条目 ≈ **0.97 秒**（顺序执行；主要花在扫 attach 与逐条解密） |
| 不变量 | 条目数 35→35 不变、无条目变小、无残留文件 ✅ |
| 排除口径 | `total` = 44 而缓存里的文件数是 46 ⇒ `remote-images/` 那 2 条**确实被排除**（真机验证） |

其中 `1759→76327`、`3226→119629`、`1316→63278` 这类是「聊天版 → 原图」的量级差；
也有 `2102→2201`、`2541→17836` 这种原图本身就不大的（说明判据不是「大图才算升级」）。

### 仍未做（这次明确不做）

- **批量走 CDN 取原图**：本模块**不联网**。XML 里带免登录直链（实测约 16%）的那批，仍要逐条点
  「取原图」。批量版要扫消息表 + 受出网开关管，是另一件事，没有搭在这里。
- **同字节数不同质量**那一类不换（见要点 1）。
- `.t.` 兜底槽里那份不删：升级后主槽优先，它退化成纯兜底，留着无害。

---

## 附三：原图获取的完整途径、约束与兜底（2026-09-26 实测）

> 起因：用户要求「任何情况下都能拿到原图」。**在守住「不登录、不注入」承诺的前提下，
> 100% 做不到** —— 本机 98.1% 的图片原图只存在于微信服务器上，取它必须带会话凭据。
> 下面把「有哪几条路、各自覆盖多少、约束是什么、取不到怎么办」一次性写清，
> 并把不越界的那部分做到最大（本轮补上了批量取原图与失败兜底）。

### 1. 三条途径（全部实测，脚本在 `working/`）

| # | 途径 | 本机覆盖 | 能否拿到 | 约束条件 |
|---|---|---|---|---|
| ① | 本机 `.dat` 的 `_h` 档（含 wxgf→JPEG 转码） | **971 张**（1.9%） | ✅ **离线** | 用户得先在微信里点开过大图（微信只在那一刻下载原图） |
| ② | 消息 XML 的 `tphdurl` / `tpurl` + `tpauthkey` | 8,604 条**有指针**（16.5%） | ❌ **本机一条都取不到** | 见 §2 —— 这批全是企业微信端点，需要**企业微信登录态** |
| ③ | 消息 XML 的 `cdnbigimgurl` / `cdnmidimgurl` | **42,433 条**（81.6%） | ❌ **不做** | 需要微信**会话凭据**（uin/sessionkey/authkey/设备签名）+ 私有媒体 RPC |
| ④ | 表情 / 头像 / 朋友圈 / 公众号封面 | 各自独立链 | ✅ 已有（走 `remote-image` 代理与各自的取回器） | 受同一组开关与主机白名单管 |

脚本：`working/probe-original-coverage.ts`（途径分布）、`working/probe-wecom-403.ts`（②的 403 根因）。

### 2. ② 的更正：**有链接 ≠ 能取**（这是本轮最重要的一条实测）

2026-09-26 之前 `query/image-original.ts` 的注释写着「`tpurl`/`tphdurl` + `tpauthkey` 是免登录
预签名直链，实测 16.2%，GET 即明文图」。本轮实测**否掉了它**：

- 本机 8,604 条带直链的图片消息，**100% 指向 `wwfile.work.weixin.qq.com/cgi-bin/download`**
  （参数只有 `f`/`t`/`p`，**没有** `tpauthkey`）；
- 匿名 GET **一律 403 / 0 字节**，且三组对照都无关：

| 对照 | 结果 |
|---|---|
| 消息新旧 | 距今 **0.2 天**（约 20 分钟）的新消息与距今 217 天的老消息**同样 403** ⇒ 不是「链接过期」 |
| 请求头 | 裸 UA / `+Referer: https://work.weixin.qq.com/` / `+图片 Accept` 三种**都 403** ⇒ 不是「少了客户端头」 |
| 参数形状 | 无 `authkey` 类签名参数；`t` 是 576 位十六进制**服务端令牌** ⇒ 需要企业微信会话 |

⇒ 它是**需要企业微信登录态的服务端令牌端点**，与 `cdnbigimgurl` 属同一类（我们不取）。
**代码上的后果**：批量取原图按主机把这类**排除在候选之外**（判据 `cdn-hosts.ts` 的
`isWecomFileEndpoint`），否则一次点击会白发几千个必然 403 的请求；盘点里单列
`wecomDirectLink` 计数，界面因此说得出「这几千张明明有 URL 却取不到，为什么」。

**保留这条通路的意义**：个人微信账号的 `tpurl` 真带 `tpauthkey`（那类 GET 即明文图），
换一个账号它就有产出；本机这份数据产出为 0，如实报出而不是假装能取。

### 3. 兜底阶梯（逐级下降，每一级都如实告诉用户停在哪一级）

```
① 本机缓存已是原图（_h / CDN 取回过）        → 直接渲染，不联网
② 本机有更大的 .dat 但缓存还是旧的           → 「升级为原图」重解（离线，严格更大才覆盖）
③ 消息带真·免登录直链                        → 「联网补齐原图」批量取回（可续跑、受两个开关管）
④ 直链取回失败（403/超时）                   → 该条自动**清缓存并重解本机最好档**；仍不行才报错
⑤ 以上都拿不到（本机 98.1%）                 → 明确回一句：
   「这条没有免登录直链，本机也只有缩略图。请在微信里打开这张图并点「查看原图」，
     然后回来再点一次。」
   —— 点开之后 attach 里会出现 `_h.dat`，回到「升级为原图」即可收进本机（第 ② 级路径）
```

第 ④ 级是本轮新增的：原先只有「没有直链」时才试本机兜底，而**取回失败**（最常见是链接失效）
直接报错 —— 可那时本机往往已经有更大的那一份（用户点开过）。现在两条路都先试本机。

### 4. 本轮交付（代码落点）

| 位置 | 动作 |
|---|---|
| `query/image-original-batch.ts` | **新增**：全库扫出带免登录直链的候选 + 续跑索引 + 逐条失败隔离；复用单张那条链落盘 |
| `query/cdn-hosts.ts` | 新增 `isWecomFileEndpoint`（企业微信端点判据的唯一出处，附实测依据） |
| `query/image-original.ts` | 更正模块头的覆盖率论断（见 §2）；模块头补「有链接 ≠ 能取」 |
| `remotes/media.ts` | 新 Remote `planOriginalFetch` / `fetchOriginalImagesBatch`；`getImageOriginal` 的失败分支补本机兜底；成功后记续跑索引 |
| 设置页「图片解码」 | 新增「联网补齐原图」：扫描 → 报告（候选 / 本机已有 / 已取回 / 只能靠微信点开）→ 取回（带上限）→ 进度与详情 |

Remote 计数 170 → **172**。守卫：`tests/image-original-batch.spec.ts`（16 例）+
`panels/original-batch.wiring.spec.ts`（6 例），**变异 19 处全咬**、逐字节还原。

### 5. 明确不做 / 做不到（写清楚，避免被当成「还没做」）

| 项 | 结论 |
|---|---|
| `cdnbigimgurl` 那 81.6%（42,433 条） | **不做**。要微信登录态凭据 = 「以你的身份向微信服务器发请求」，与 README/PRIVACY 的承诺冲突 |
| 企业微信 `wwfile` 端点那 16.5%（8,604 条） | **不取**。实测匿名 403，同上 |
| wxhook 的 CDN 档位改写（改 `task+0xD0`） | **不做**。需 DLL 注入 + MinHook，违反「不注入、不 hook」 |
| 「任何情况下 100% 拿到原图」 | **不成立**，且不应承诺。能承诺的是：**不越界的那部分做到最大 + 拿不到的每一类都给出确切原因与下一步动作** |
| 视频 / 朋友圈的 wxgf | 不在图片这条链（视频封面另走 `media-video`） |

### 6. 交付结果（期望形态）

用户视角只有两个按钮与一句话：

- 点「**升级为原图**」→ 本机已有的原图全部生效（离线；本机 44 条缓存实测 12/12 逐字节恢复、幂等）；
- 点「**扫描**」→ 得到一行覆盖率报告：`带免登录直链的候选 N 张 · 本机已有原图 971 张 ·
  已取回过 M 张 · 只能靠回微信点开 51,011 张（其中 8,604 张是企业微信端点，实测 403）`；
- 点「**开始取回**」→ 逐个取回（可续跑、可按上限分批），失败逐条列原因；
- 拿不到的那 98.1%，界面与操作记录里都写着同一句可执行的话：**回微信里点开一次，再点「升级为原图」**。
