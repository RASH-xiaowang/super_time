---
feature: emoticon-data-url
status: delivered
updated: 2026-09-12
branch: feat/chat-message-module
commits: 9989a92..4a4832c
---

# 表情真图链路（getEmoticonDataUrl）

## Report

**What was built** — 新增 Remote `getEmoticonDataUrl({ md5 })`：优先读 `decoded_images`，否则扫 `msg/attach` 找 `<md5>_t.dat`/`.dat` 并用既有 XOR/V1/V2 解密；成功写回缓存。gateway 注册 + 运行期 `lib/index.js` 同构注入 + host 结果缓存。前端 `MessageEmoticon` 按 md5 拉真图，聊天 emoji/sticker 分派；失败回退占位。

**Verification** — `createWechatBackend().methodNames()` 含 `getEmoticonDataUrl`；真实 md5 `e58e70f8…` 调用返回 `data:image/jpeg;base64`（约 1ms）；`npm run build:ui` PASS；Electron 6 进程存活。

**Journey log**
1. 运行期只读 `lib/index.js`，源码改完必须同步注入（用 `build/patch-emoticon-remote.py`）。
2. bundle 内 `scoreDatPath` 去冲突名为 `scoreDatPath$1`。
3. 扫 attach 深度限 4、命中数限 8，避免全量扫盘。

## [S1] Problem

聊天里的自定义表情长期只有「😊 [表情]」占位：后端 `getEmoticons` 只给 md5 清单，
没有「按 md5 解出图片」的 Remote；文件实际在 `msg/attach/<hash>/<date>/Img/<md5>.dat`。

## [S2] Design

### 后端

- 新增 `decodeEmoticonDataUrl(decrypted, decoded, base, md5, aesKey, xorKey)`：
  1. 读 `decoded_images/<md5>.<ext>`；
  2. 扫 `msg/attach` 找 `<md5>_t.dat` / `<md5>.dat`（优先缩略图）；
  3. 复用 `decodeDatBytes`（XOR/V1/V2）；成功写回 decoded 缓存。
- Gateway `@Remote('getEmoticonDataUrl')({ md5 })` → `ImageDataUrlResult`。
- 运行期只读 `lib/index.js`：同步注入同名函数与 Remote 装饰器（与 `getFileImageDataUrl` 同构）。
- `wechat-host` 将 `getEmoticonDataUrl` 加入 `CACHEABLE_METHODS`。

### 前端

- `apiGetEmoticonDataUrl`（带 cachedGet）。
- `MessageEmoticon`：有图渲染大表情；失败/加载回退占位芯片。
- `MessageBody` 的 `emoji` / `sticker` 按 md5 调用；sticker 有 CDN `thumb` 时优先 thumb。

## [S3] Out of Scope

- 不改 `parse.ts` 分类；不做 GIF 动图特殊播放器；不恢复 check 脚本。

## Tasks

- [x] T1: 后端 decode + gateway Remote + bundle 注入 — acceptance: createWechatBackend 方法表含 getEmoticonDataUrl，真实 md5 调用返回 data:image (covers: S2)
- [x] T2: 前端 API + MessageEmoticon + emoji/sticker 分派 — acceptance: build:ui 通过 (covers: S2; depends: T1)
- [x] T3: 重启应用并提交 — acceptance: electron 存活 (covers: S2; depends: T2)
