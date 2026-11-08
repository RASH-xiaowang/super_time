'use strict';

/**
 * Electron 默认会话的权限边界。
 *
 * 本应用不需要摄像头、麦克风、屏幕采集、地理位置、USB/串口/HID、通知或
 * 持久化权限。只保留用户手势触发的剪贴板写入与页面内视频全屏；否则面板里的
 * “复制”和朋友圈视频全屏会被 Chromium 权限层拦掉。
 *
 * 这里只做运行时权限收口，不替代主进程的 IPC sender 校验；两者是独立防线。
 */
const SAFE_PERMISSIONS = new Set(['clipboard-sanitized-write', 'fullscreen']);

/**
 * 安装权限处理器。
 *
 * @param {object} ses - Electron Session 或同形测试桩。
 * @param {{
 *   log?: (message: string, ...args: unknown[]) => void,
 *   isTrustedContents?: (contents: unknown) => boolean,
 * }} [opts]
 * @returns {void}
 */
function installSessionHardening(ses, opts = {}) {
  if (!ses || typeof ses !== 'object') return;
  const log = typeof opts.log === 'function' ? opts.log : () => {};
  const trust = typeof opts.isTrustedContents === 'function'
    ? opts.isTrustedContents
    : () => true;
  const allowed = (contents, permission) => trust(contents)
    && SAFE_PERMISSIONS.has(String(permission || ''));

  if (typeof ses.setPermissionRequestHandler === 'function') {
    ses.setPermissionRequestHandler((contents, permission, callback) => {
      if (allowed(contents, permission)) {
        callback(true);
        return;
      }
      log('[security] 已拒绝渲染进程权限请求：%s', String(permission || 'unknown'));
      callback(false);
    });
  }

  if (typeof ses.setPermissionCheckHandler === 'function') {
    ses.setPermissionCheckHandler((contents, permission) => {
      const ok = allowed(contents, permission);
      if (!ok) log('[security] 已拒绝渲染进程权限检查：%s', String(permission || 'unknown'));
      return ok;
    });
  }

  if (typeof ses.setDevicePermissionHandler === 'function') {
    ses.setDevicePermissionHandler(() => false);
  }

  if (typeof ses.setDisplayMediaRequestHandler === 'function') {
    ses.setDisplayMediaRequestHandler((_request, callback) => {
      log('[security] 已拒绝屏幕采集请求');
      callback({});
    });
  }
}

module.exports = { SAFE_PERMISSIONS, installSessionHardening };
