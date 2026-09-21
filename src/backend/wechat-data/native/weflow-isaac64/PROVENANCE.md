# 资产来源：WxIsaac64 密钥流（朋友圈 CDN 媒体解密）

本目录是从参考项目 **WeChatDataAnalysis**（`D:\WeChatDataAnalysis-main`）vendored 过来的两个文件，
用于解密微信 CDN 上的朋友圈视频/封面：

| 文件 | 原路径 | 大小 |
|---|---|---|
| `wasm_video_decode.wasm` | `src/wechat_decrypt_tool/native/weflow_wasm/wasm_video_decode.wasm` | 3.8 MB |
| `wasm_video_decode.js` | 同上目录 | 175 KB |

## 它做什么

微信 CDN 上的朋友圈媒体是**客户端加密**的：下载回来头不是 `ftyp`，前
`min(131072, size)` 字节需要与 `WxIsaac64` 密钥流做 XOR 才是真正的 MP4/JPEG。
种子是朋友圈 XML 里的 `<enc key="NNNN">` 十进制数。

## 为什么不自己实现

`WxIsaac64` 名字里的 Isaac64 **不是** Jenkins 的 ISAAC-64：

- 用真实数据对照过「标准 ISAAC-64 核心 × 6 种播种 × 2 种输出顺序 × 4 种字节序」，
  与 WASM 输出零字节重合（64 位字的多重集都不相交）；
- WASM 二进制里搜不到 Jenkins 的 golden 常量 `0x9E3779B97F4A7C15`（两种字节序都没有）。

它是一套自研 PRNG，因此以这份权威实现为准。

## 验收标准

不是「代码能跑」，而是 **「解密结果的整文件 md5 必须等于朋友圈 XML 里的 `<url md5>`」**。
`npm run check:sns-video` 里用一条从该 WASM 取下的固定向量（seed=`1`、32 字节）锚住它的行为，
另外用真实数据（本机已缓存明文的视频 + 同一动态的 CDN 下载）做端到端比对。

## 许可与归属（2026-09-21 法务结论：允许随包分发）

> **2026-09-21 更新**：以下「未明确」的记述是**结论取得前**的记录，保留以存档；当日取得法务结论为
> **允许随包分发**（见 `docs/RELEASE-PLAN.md` H13，同 2026-09-21 闭环）。方案 B（不内置、用户自备）未启用。

**这是一个遗留风险点**：参考项目自己的 `THIRD_PARTY_NOTICES.md` 里**没有**登记这个 WASM 的来源与许可证，
二进制内的字符串显示它来自微信客户端（`WxIsaac64`、`wxTransSingleFmp4EncryptJs`、`WxCutFmp4Ret`，
以及 ffmpeg 相关串）。也就是说它是从微信客户端中提取/编译的产物，**再分发许可未明确**。

它当前只在本应用内部用于解密**用户自己机器上、自己的微信账号**的朋友圈媒体，
不随网络分发原始媒体内容。若本应用要对外发布，建议先确认这一资产的合规性，
或改为「不内置、由用户自行提供」的方式接入。
