/**
 * SuperLanguage 授权闸门（2026-11-24）。
 *
 * SuperLanguage 不是独立的授权主体：它必须由 Super Time 部署，并在启动时向本机
 * 授权管道换取一张**短命票据**。拿不到票据 → 启动失败（fail-closed）；运行中票据
 * 失效超过宽限 → 停止领取新任务（不打断已在发送的消息）。
 *
 * 绑定信息在 exe 目录的 `instance.ini`：
 *   v=1
 *   app=superlanguage
 *   instance=<uuid>
 *   broker=\\.\pipe\supertime-app-v1-<hash>
 *   key=<64 位 hex>
 *   exeSha256=<部署时的摘要，仅诊断；运行时以自算值为准>
 *
 * 协议见 `src/backend/app-lease.js` 与 `app-broker.js`；票据是换行分隔的纯文本，
 * 因此这里不需要 JSON 解析器。
 *
 * **测试专用**：`--test-skip-license` 只给隔离回归脚本用（`tests\verify.ps1`），
 * 它会让 available() 恒为 true，绝不会在生产部署里被传入。
 * `--no-error-ui` 只抑制启动失败时的对话框（自动化用例需要立刻拿到退出码），
 * **不改变任何授权判定**。
 */
#pragma once

#include <string>

namespace feather::license {

/**
 * 初始化授权闸门。
 *
 * @param allow_unmanaged - 允许「没有 instance.ini」的独立运行（仅测试用）。
 * @returns true = 可以继续启动；false = 调用方必须退出（fail-closed）。
 */
bool initialize(bool allow_unmanaged);

/** 停线程、关管道；可重复调用。 */
void shutdown();

/** 当前是否允许领取/执行任务（票据有效，或仍在宽限期内）。 */
bool available();

/** 是否处于托管模式（找到了 instance.ini）。测试模式返回 false。 */
bool managed();

/** 机器码：ok / blocked / pending / unmanaged。 */
const char* state_code();

/** 票据到期还剩多少秒（未拿到票据时为 0）。 */
int expires_in_seconds();

/** `{"state":"ok","code":"","expires_in":540,"managed":true}`，供 /api/health 与 /api/status 使用。 */
std::string status_json();

/**
 * 接受托管主机**推送**过来的票据（跨机托管用）。
 *
 * 本机模式走命名管道自取；局域网模式没有管道可达，改由 Super Time 主动 POST
 * 到实例的 `/api/license/lease`（Bearer 保护），这里只做验签与状态更新。
 * @param claim_hex - 票据 claim 的十六进制编码。
 * @param mac_hex - HMAC-SHA256 十六进制。
 * @returns 是否被接受；拒绝原因可通过 `state_code()` / 错误码看到。
 */
bool acceptTicket(const char* claim_hex, const char* mac_hex);

/** 是否处于「等待推送」模式（instance.ini 里 broker=push）。 */
bool push_mode();

/** 启动失败时给用户看的完整中文提示（含机器码与下一步）。 */
std::wstring startup_block_message();

} // namespace feather::license
