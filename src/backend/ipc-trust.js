'use strict';

/**
 * Electron IPC sender validation for the trusted desktop window.
 *
 * The renderer is sandboxed, but that only proves the OS sandbox exists; it does
 * not say which webContents is talking to the main process. Any future window,
 * frame, or webContents can otherwise invoke privileged channels such as
 * `wechat:call`, `remote-access:rotate`, or `license:import`.
 *
 * The guard is fail-closed: missing window, missing frame, non-main frame,
 * sender mismatch, or an unexpected entry URL all reject the request.
 */

const { pathToFileURL } = require('node:url');

/**
 * Normalize a file URL for comparison. Query strings and hashes are ignored
 * because the application entry is a local HTML file; only its identity matters.
 *
 * @param {unknown} value
 * @returns {string|null}
 */
function canonicalFileUrl(value) {
  if (typeof value !== 'string') return null;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'file:') return null;
    // Windows file paths are case-insensitive. Lower-casing the whole URL is
    // stricter than necessary for pathname comparison, but entry files never
    // contain a case-sensitive segment in this application.
    return `file://${parsed.host.toLowerCase()}${parsed.pathname.toLowerCase()}`;
  } catch {
    return null;
  }
}

/**
 * Build the guard used by all ipc-*.js registrars.
 *
 * @param {object} options
 * @param {() => Electron.BrowserWindow | null | undefined} options.getMainWindow
 * @param {string} options.entryUrl - canonical URL of the single trusted entry.
 * @param {Console} [options.logger]
 */
function createIpcTrust(options = {}) {
  const getMainWindow = options.getMainWindow;
  const entryUrl = canonicalFileUrl(options.entryUrl);
  const logger = options.logger || console;

  if (typeof getMainWindow !== 'function' || !entryUrl) {
    throw new Error('createIpcTrust requires getMainWindow and a file entryUrl');
  }

  function validate(event) {
    if (!event || typeof event !== 'object') {
      return { ok: false, reason: 'missing-event' };
    }

    const win = getMainWindow();
    const contents = win && win.webContents;
    if (!contents) {
      return { ok: false, reason: 'no-main-window' };
    }
    if (event.sender !== contents) {
      return { ok: false, reason: 'sender-mismatch' };
    }

    const frame = event.senderFrame;
    if (!frame || frame !== contents.mainFrame || frame.isMainFrame === false) {
      return { ok: false, reason: 'frame-mismatch' };
    }

    const actual = canonicalFileUrl(frame.url);
    if (actual !== entryUrl) {
      return { ok: false, reason: 'entry-url-mismatch' };
    }

    return { ok: true };
  }

  function reject(channel, reason) {
    logger.warn(`[ipc-trust] rejected ${channel}: ${reason}`);
    return {
      ok: false,
      error: {
        message: 'IPC 调用来源校验失败，已拒绝',
        code: 'IPC_SENDER_REJECTED',
        details: { channel, reason },
      },
    };
  }

  return {
    isTrusted(event) {
      return validate(event).ok;
    },

    /** Wrap an ipcMain.handle handler. */
    wrap(channel, handler) {
      return (event, ...args) => {
        const check = validate(event);
        if (!check.ok) return reject(channel, check.reason);
        return handler(event, ...args);
      };
    },

    /** Wrap an ipcMain.on listener. */
    wrapOn(channel, listener) {
      return (event, ...args) => {
        const check = validate(event);
        if (!check.ok) {
          logger.warn(`[ipc-trust] rejected ${channel}: ${check.reason}`);
          return;
        }
        return listener(event, ...args);
      };
    },
  };
}

module.exports = {
  canonicalFileUrl,
  createIpcTrust,
  fileUrlFor: (filePath) => pathToFileURL(filePath).href,
};
