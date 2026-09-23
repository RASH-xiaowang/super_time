/**
 * `update.js` 的类型面 —— **手写**声明（H11 的 `llm-retry.d.ts` 同一套路），不是构建产物。
 *
 * 为什么不交给 tsc 从 JSDoc 生成：宿主 JSDoc 里那些 `@returns {object}` / `@param {{…}}`
 * 一旦变成真声明，就比 `any` 更窄**而且错** —— 实测会把测试面的错误数从 74 顶到 120
 * （`store.profiles` 每一行都成了 `object`，读任何字段都报 TS2339）。
 * 生成能保住「形状对得上」，保不住「形状别写错」，所以这里由人写、由
 * `tests/host-decl-alignment.spec.ts` 盯着**双向差集**：漏一个导出＝地图缺一块，
 * 多一个导出＝发明了一个运行时不存在的成员（类型全绿、运行时无定义，最坏的那种）。
 *
 * 只声明模块真正对外提供的东西；实现内部细节不在这里露面。
 */

/**
 * 应用自动更新（electron-updater + GitHub Releases）。
 *
 * ## 链路
 *
 * ```
 * 安装版启动 → 延迟 30s autoUpdater.checkForUpdates()
 *   → 读 Releases 上的 latest.yml，与本机版本比对
 *   → 有新版本：后台自动下载（autoDownload）
 *   → 下载完成：退出应用时自动装（autoInstallOnAppQuit）
 *              用户也可以在「设置 → 软件更新」点「重启并安装」
 * ```
 *
 * ## 为什么用 electron-updater 而不是自己比版本号
 *
 * 它读的是 electron-builder **打包时**写进 `resources/app-update.yml` 的 feed 配置
 * （与安装包出自同一份 `build.publish`，两边不会各自漂移）。版本比对、增量下载、
 * 静默安装、安装后重启都是它做掉的。自己拿 GitHub API 比对版本号只能做到
 * 「提示有新版本」，**装不了** —— 用户仍要自己去 Releases 下载并手工覆盖安装。
 *
 * ## 为什么 autoUpdater 由调用方注入
 *
 * 真的 `autoUpdater` 需要 Electron 运行时**且**打包产物里的 `app-update.yml` 才肯工作，
 * 单测跑不起来。所以这里只做「事件 → 状态」的收敛与推送，`autoUpdater` 由 main.js
 * 注入；测试喂一个假 EventEmitter 即可覆盖全部状态迁移（见 tests/update.spec.ts）。
 *
 * ## 日志前缀的归属
 *
 * 本模块打出去的每一行都**不带** `[update]` 前缀，前缀由注入的 `log` 统一加
 * （main.js 的适配器负责）。原因是同一个适配器还要转发 electron-updater 自己的
 * 消息（那些消息没有前缀），只有在这里不加、在适配器加，两路才都能得到恰好一个前缀。
 *
 * ## 为什么必须判 `isPackaged`
 *
 * 未打包时 electron-updater 找不到 `app-update.yml` 会抛
 * `ENOENT ... app-update.yml`；而且开发态本来就不该去拉线上的更新。
 * 这里把「不支持」也当成一个**正常状态**回给界面（`reason: 'dev'`），
 * 界面据此显示「开发态不检查更新」而不是一条吓人的报错。
 *
 * @module update
 */
/** 自动检查的延迟：等窗口画完、后端就绪再出网，不与启动期抢带宽与事件循环。 */
export const DEFAULT_AUTO_CHECK_DELAY_MS: number;
/**
 * 显式关闭自动检查的环境变量（值为 `'1'`）。
 *
 * 给自动化用：打包冒烟（packaged-smoke）会启动**真实安装版**，若它每次都去 GitHub
 * 拉一次 latest.yml，CI 就多了一个会因网络抖动的失败点。这类脚本显式设 `=1`。
 */
export const DISABLE_UPDATE_CHECK_ENV: "SUPERTIME_DISABLE_UPDATE_CHECK";
/** Release 说明的展示上限：GitHub Release 的 body 可以很长，整段过 IPC 没有意义。 */
export const MAX_RELEASE_NOTES_CHARS: 2000;
/**
 * 下载进度的推送阶梯（百分点）。
 *
 * `download-progress` 每秒可触发几十次；逐条转发会把 IPC 打满，而界面上 0.3% 的
 * 抖动本来也看不见。只推「整数百分比变了」的那些帧 —— 一次下载最多 100 条消息。
 * 阶段切换**必须**推（否则界面停在「正在下载」那一格不动）。
 */
export const PROGRESS_STEP_PERCENT: 1;
/**
 * 把一条 electron-updater 事件收敛成新状态（纯函数，可脱离 Electron 测试）。
 *
 * @param {ReturnType<typeof blankUpdateState>} state 当前状态。
 * @param {{ type: string, info?: any, progress?: any, error?: unknown, reason?: string, manual?: boolean, at?: string }} event
 * @returns {ReturnType<typeof blankUpdateState>} 新状态（不修改入参）。
 */

/**
 * electron-updater 推给 `applyUpdateEvent` 的那条事件。
 *
 * **每个字段都是可选的**，这不是偷懒：本函数是「把不可信的外部事件收敛成状态」那一层，
 * `update.spec.ts` 里就有拿 `{}`（连 `type` 都没有）走 default 分支的用例。把 `type` 标成
 * 必填等于宣称「调用者保证有 type」，而这一层的存在理由恰恰是不能这么假定。
 * `info` / `progress` 保持 `any`：形状由 electron-updater 决定，本模块只往里读字段。
 */
export interface UpdaterEvent {
  type?: string
  info?: any
  progress?: any
  error?: unknown
  reason?: string
  manual?: boolean
  at?: string
}

/** 下载进度（electron-updater 的形态）。 */
export interface UpdaterProgress {
  percent?: number
  transferred?: number
  total?: number
  bytesPerSecond?: number
}

/** `createUpdateService` 的注入面：全部可选，缺省就是「什么都不接」的静默服务。 */
export interface UpdateServiceOptions {
  autoUpdater?: any
  isPackaged?: boolean
  currentVersion?: string
  diagLog?: { write: (level: string, args: unknown[]) => void }
  [k: string]: unknown
}

export function applyUpdateEvent(state: ReturnType<typeof blankUpdateState>, event: UpdaterEvent): ReturnType<typeof blankUpdateState>;
/** 空状态。`currentVersion` 由调用方给（main.js 取的是打包的 version）。 */
export function blankUpdateState(currentVersion?: string): {
    phase: string;
    currentVersion: string;
    version: any;
    releaseName: any;
    releaseNotes: any;
    releaseDate: any;
    progress: any;
    error: any;
    reason: any;
    checkedAt: any;
    manual: boolean;
};
/**
 * 建一个更新服务。
 *
 * @param {{
 *   autoUpdater: any,                       electron-updater 的 autoUpdater（测试可注入假的）
 *   isPackaged: boolean,                    Electron 的 app.isPackaged
 *   currentVersion?: string,                当前版本（展示用）
 *   log?: (level: string, args: unknown[]) => void,
 *   onState?: (state: object) => void,      状态每次变化时回调（main.js 用它广播给渲染进程）
 *   env?: Record<string, string | undefined>,
 *   autoCheckDelayMs?: number,
 * }} opts
 * @returns {{
 *   getState: () => object,
 *   isSupported: () => boolean,
 *   check: (o?: { manual?: boolean }) => Promise<object>,
 *   install: () => { ok: boolean, error?: string },
 *   scheduleAutoCheck: () => void,
 *   dispose: () => void,
 * }} 更新服务。
 */
export function createUpdateService(opts?: UpdateServiceOptions): {
    getState: () => object;
    isSupported: () => boolean;
    check: (o?: {
        manual?: boolean;
    }) => Promise<object>;
    install: () => {
        ok: boolean;
        error?: string;
    };
    scheduleAutoCheck: () => void;
    dispose: () => void;
};
/**
 * 把 electron-updater 抛出的原始错误翻成一句能指导动作的话。
 *
 * 这几类错在部署现场各有各的成因，而原始 message 全是英文技术串
 * （`ENOENT ... app-update.yml`、`HttpError: 404`）—— 直接丢给用户等于没说。
 * @param {unknown} err
 * @returns {string}
 */
export function describeUpdateError(err: unknown): string;
/** 进度归一化：`percent` 夹到 [0,100]，其余数值字段非有限数一律置 null（界面据此决定显示什么）。 */
export function normalizeProgress(p?: UpdaterProgress): {
    percent: number;
    transferred: any;
    total: any;
    bytesPerSecond: any;
};
/**
 * Release 说明归一化。electron-updater 对 GitHub provider 给的是字符串，
 * 对多版本差分的 provider 给的是 `{ version, note }[]` —— 两种都收进来。
 * @param {unknown} notes
 * @returns {string|null}
 */
export function normalizeReleaseNotes(notes: unknown): string | null;
/** 日志适配：diagLog 只有 `write(level, args)`，而 electron-updater 要 info/warn/error/debug 四个方法。 */
export function toUpdaterLogger(log?: { write: (level: string, args: unknown[]) => void }): {
    info: (...args: any[]) => void;
    warn: (...args: any[]) => void;
    error: (...args: any[]) => void;
    debug: () => void;
};
