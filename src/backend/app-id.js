'use strict';

/**
 * 应用身份（AppUserModelID，N20）。
 *
 * ## 为什么需要
 *
 * Windows 用「窗口所属进程的 AppUserModelID」+「快捷方式里写的 AppUserModelID」这对值
 * 决定任务栏的**分组与固定**行为。NSIS 安装器给快捷方式写的是 `package.json` 的
 * `build.appId`（`com.supertime.electron`），而主进程此前**从未调用**
 * `app.setAppUserModelId()` —— Electron 于是用默认身份（exe 路径派生），两者不一致。
 * 用户在任务栏上「固定到任务栏」之后再启动，可能出现两个图标（或固定项显示成另一个图标）。
 *
 * ## 为什么从 manifest 取而不是写死
 *
 * 两处必须恒等才有意义：快捷方式那份由 electron-builder 从 `build.appId` 生成，
 * 主进程这份必须是**同一个来源**，否则改 `appId` 时只有一边跟着变。
 * manifest 在打包态仍在 asar 内（`files` 白名单含 `package.json`），`require` 可用。
 *
 * @module app-id
 */

/** 取不到 manifest 时的兜底身份（与 package.json 的 build.appId 保持一致）。 */
const FALLBACK_APP_ID = 'com.supertime.electron';

/**
 * 从 manifest 对象里取 appId。
 *
 * 只认非空字符串：`build.appId` 缺失、写成空串或别的类型时退回兜底值 —— 返回
 * `undefined` 会让 `setAppUserModelId(undefined)` 抛错（比身份不一致更糟）。
 * @param manifest - 已解析的 package.json 内容。
 * @returns AppUserModelID。
 */
function appIdFromManifest(manifest) {
  const id = manifest && manifest.build && manifest.build.appId;
  return typeof id === 'string' && id.trim() ? id.trim() : FALLBACK_APP_ID;
}

/** 本应用的身份；主进程与守卫用例共用同一个来源。 */
const APP_ID = (() => {
  try {
    return appIdFromManifest(require('../../package.json'));
  } catch {
    return FALLBACK_APP_ID;
  }
})();

module.exports = { FALLBACK_APP_ID, appIdFromManifest, APP_ID };
