/**
 * 微信原图自动下载（实验）：让微信自己在接收新图片时下载高清原图。
 *
 * ## 它补的是哪一段
 *
 * 本仓库原有的「原图」通路有三条（本机 `_h.dat` 重解 / 消息里的免登录直链 / 第三方服务），
 * 但都覆盖不了「本机只有缩略图、XML 只有 `cdnbigimgurl`」的那部分：聊天图片走 mmtls 私有 RPC，
 * 卡片里没有可直取的 HTTP 直链（详见 `original-harvester.ts` / `wxcdn-original.ts` 的实测注释）。
 *
 * 微信**自己**能下载原图（默认只下缩略图）。本模块复用上游 WeFlow-X（MIT）的
 * `img_helper.dll`（`native/img_helper/`），把它注入正在运行的微信进程，接管「收到图片」
 * 之后的下载策略：注入之后，**新收到 / 新同步到的图片**会由微信按原图下载。
 * 本应用自己不实现 mmtls、不接触登录凭据、不向微信服务器发任何请求。
 *
 * ## 边界（必须让用户知道，界面照实显示）
 *
 *   · 只影响**注入之后**新收到的图片；历史图片不会补下载（仍可在微信里点开一次原图，
 *     由「原图自动收割」接住）。
 *   · 注入是**进程内**的：正常停止会调用 `UninstallImgHelper`；应用被强杀/崩溃时微信可能
 *     保持被修改状态，直到微信重启。本模块在数据根写 marker，下次启动如实回报
 *     `cleanupUnconfirmed`，并在微信未重启时拒绝重复注入。
 *   · 仅 win32-x64；微信版本兼容性未声明（上游 provenance 的 `testedWechatVersions` 为空），
 *     失败会落到 `IMAGE_AUTODOWNLOAD_*` 错误码。
 *   · 组件加载前复核 SHA-256（与清单钉死值一致，见 `native/img_helper/PROVENANCE.md`）。
 *
 * ## 与「原图自动收割」的分工
 *
 * 收割是只读的（盯 `_h.dat` 落盘）；本模块是仓库里**唯一会修改微信进程内存**的可选功能，
 * 默认关闭，必须由用户在设置里显式打开。
 *
 * 依赖方向：query 层 → config 层（与 `keys/*` 同一口径）；不 import gateway/remotes/types。
 */
/** 一次动作（与 `@Remote('wechatImageAutoDownload')` 的入参对齐）。 */
export type WechatImageAutoDownloadAction = 'start' | 'stop' | 'status';
/** 运行状态机。 */
export type WechatImageAutoDownloadState = 'unsupported' | 'idle' | 'waiting_wechat' | 'starting' | 'running' | 'stopping' | 'failed';
/** 给界面看的完整状态（`getWechatImageAutoDownloadStatus` 的返回值）。 */
export interface WechatImageAutoDownloadStatus {
    /** 当前平台/组件是否具备开启条件（win32-x64 + 组件存在）。 */
    supported: boolean;
    /** 配置里的持久开关（用户上次是否打开）。 */
    enabled: boolean;
    /** 本进程是否在轮询（注入成功后 30s 一次重挂/探活）。 */
    watching: boolean;
    /** 当前是否已成功注入微信进程。 */
    hooked: boolean;
    /** 运行状态机。 */
    state: WechatImageAutoDownloadState;
    /** 错误码（`IMAGE_AUTODOWNLOAD_*`）；空串 = 无错误。 */
    code: string;
    /** 人类可读说明（错误时可直接显示）。 */
    message: string;
    /** 被注入的微信进程 pid；未注入为 null。 */
    pid: number | null;
    /** 本机检测到的微信版本（可能为空串）。 */
    wechatVersion: string;
    /** 白名单里的会话数；0 = 全部会话（与上游组件语义一致）。 */
    whitelistCount: number;
    /** 组件绝对路径（找不到为空串）。 */
    helperPath: string;
    /** 组件 SHA-256（清单钉死值）。 */
    helperSha256: string;
    /** 本次进程内是否已完成组件完整性复核。 */
    helperVerified: boolean;
    /**
     * 上次退出可能没来得及还原注入（marker 存在且微信进程未重启）。
     * 为 true 时界面应提示用户重启微信，本模块也会拒绝重复注入。
     */
    cleanupUnconfirmed: boolean;
    /** 最近一次失败时间戳（毫秒）；从未失败为 0。 */
    lastErrorAt: number;
}
/** 组件完整性钉死值（`native/img_helper/win32-x64/img_helper.dll`）。 */
export declare const IMAGE_AUTODOWNLOAD_HELPER_SHA256 = "79596be6f0da84f25a763973f6d1a439bcd8df2c0300891f6d419984f16cfc91";
/** 与 dll 绑定的三个导出（只在这里出现，便于测试替换）。 */
export interface ImageAutoDownloadHelper {
    /** `InitImgHelper(pid, whitelist)`；失败返回 false。 */
    init: (pid: number, whitelist: Buffer | null) => boolean;
    /** `UninstallImgHelper()`；释放注入并还原字节。 */
    uninstall: () => void;
    /** `GetImgHelperError()` 的字符串结果（失败原因）。 */
    error: () => string;
}
/**
 * 可替换的运行时依赖（生产走真实实现；单测注入假的，避免加载 koffi / 注入进程）。
 * 只暴露本模块真正用到的面。
 */
export interface ImageAutoDownloadDeps {
    platform: string;
    arch: string;
    /** 找微信主进程 pid；没运行返回 null。 */
    findPid: () => number | null;
    /** 加载组件（校验 + koffi 绑定）；失败抛错。 */
    loadHelper: () => Promise<ImageAutoDownloadHelper>;
    /** 解析组件绝对路径；找不到返回空串。 */
    resolveHelperPath: () => string;
    readConfig: (decryptedDir: string) => Record<string, unknown>;
    saveConfig: (decryptedDir: string, patch: Record<string, unknown>) => {
        ok: boolean;
        error?: string;
    };
    /** 本机微信版本（仅用于状态展示）。 */
    wechatVersion: () => string;
    now: () => number;
    setTimer: (fn: () => void, ms: number) => unknown;
    clearTimer: (handle: unknown) => void;
    onExit: (fn: () => void) => void;
}
/** 把任意配置值收成安全的会话白名单（去重、限长、限条数）。 */
export declare function sanitizeWhitelist(value: unknown): string[];
/**
 * 组件要的白名单形态：`a\0b\0\0`（NUL 分隔、双 NUL 结尾）；空列表 = 全部会话（null）。
 * @param whitelist - 已净化的 username 列表。
 * @returns 传给 `InitImgHelper` 的第二个参数。
 */
export declare function buildWhitelistBuffer(whitelist: readonly string[]): Buffer | null;
/** 计算当前状态快照（纯读，不改状态机）。 */
export declare function getWechatImageAutoDownloadStatus(decryptedDir: string): WechatImageAutoDownloadStatus;
/**
 * 打开自动下载（先落盘开关，再开始注入并挂 30s 轮询）。
 * @param decryptedDir - 解密数据根。
 * @returns 最新状态快照。
 */
export declare function startWechatImageAutoDownload(decryptedDir: string): Promise<WechatImageAutoDownloadStatus>;
/**
 * 启动恢复的延迟（毫秒）。
 *
 * 为什么不在 init 里同步恢复：`startWechatImageAutoDownload` 会先同步跑一轮进程发现
 * （`deps.findPid()` = PowerShell/CIM 查询，本机实测 217ms，超时上限 10s），
 * 而它正好落在「后端 ready」的返回路径上 —— 实测把后端 ready 从 ~120ms 拖到 ~340ms，
 * 并且这 217ms 是**主线程同步阻塞**，会和首屏查询抢同一个事件循环。
 *
 * 延后到首屏之后：开关与支持性仍在 boot 里判断（毫秒级），真正的 marker 校验 + 注入
 * 放到这个延迟之后。语义不变（仍在启动阶段自动恢复），只是不再挡 ready/首屏。
 */
export declare const BOOT_RESUME_DELAY_MS = 1200;
/**
 * 开启自动下载并尽力还原微信进程（幂等）。
 * @returns 最新状态快照。
 */
export declare function stopWechatImageAutoDownload(): Promise<WechatImageAutoDownloadStatus>;
/**
 * `@Remote('wechatImageAutoDownload')` 的实现体：一次性动作 + 状态。
 * @param decryptedDir - 解密数据根。
 * @param action - `start` 打开开关并接入 / `stop` 关闭并还原 / `status` 只读。
 * @returns 最新状态快照。
 */
export declare function wechatImageAutoDownload(decryptedDir: string, action: WechatImageAutoDownloadAction): Promise<WechatImageAutoDownloadStatus>;
/**
 * 后端启动时调用：上次开关是打开的，就自动恢复注入（失败不阻断启动）。
 * @param decryptedDir - 解密数据根。
 * @returns `null` = 无需/不能自动恢复；否则带一个同步 stop 钩子（宿主 dispose 时调用）。
 */
export declare function startWechatImageAutoDownloadOnBoot(decryptedDir: string): {
    enabled: boolean;
    stop: () => void;
} | null;
/**
 * 单测缝合点：替换依赖 + 重置状态。仅测试使用。
 *
 * 生产代码不得调用 —— 它会把进程内的注入状态清空（不清真实微信进程）。
 */
export declare const __testing: {
    setDeps(partial: Partial<ImageAutoDownloadDeps>): void;
    reset(): void;
    tick: () => Promise<void>;
    state: () => {
        root: string;
        timer: boolean;
        hookedPid: number | null;
        state: WechatImageAutoDownloadState;
        code: string;
        message: string;
        cleanupUnconfirmed: boolean;
        helperVerified: boolean;
    };
};
