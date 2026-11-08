'use strict';

/**
 * 一次性微信原生 OCR worker。
 *
 * 只接收父进程的一条消息，调用社区兼容包装 `wcocr.dll`，把微信插件返回的
 * 原始 JSON 字符串回传。正文不进 stdout/stderr/日志；调用结束必定执行
 * `stop_ocr()` 并注销 Koffi 回调。父进程负责超时后 kill 整个进程。
 */

const fs = require('node:fs');
const crypto = require('node:crypto');

const WCROCK_SHA256 = 'a349ce3dd72014cadf2e11882334292d76010b91fbe32ac28e015943f2055a90';

function post(message) {
  try {
    process.parentPort?.postMessage(message);
  } catch {
    /* 父进程已退出 */
  }
}

function errorText(error) {
  if (!error) return '微信原生 OCR 调用失败。';
  const message = typeof error.message === 'string' ? error.message : String(error);
  return message.startsWith('微信原生 OCR') ? message : '微信原生 OCR 调用失败：' + message;
}

function verifyWrapper(file) {
  const bytes = fs.readFileSync(file);
  const actual = crypto.createHash('sha256').update(bytes).digest('hex');
  if (actual !== WCROCK_SHA256) {
    throw new Error('随包 OCR 组件完整性校验失败，请重新安装 Super Time。');
  }
}

function runOcr(payload) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('微信原生 OCR 请求参数无效。');
  }
  const { wxocrDll, wechatDir, wrapperDllPath, imagePath } = payload;
  for (const [name, value] of Object.entries({ wxocrDll, wechatDir, wrapperDllPath, imagePath })) {
    if (typeof value !== 'string' || value.trim() === '') {
      throw new Error('微信原生 OCR 请求缺少 ' + name + '。');
    }
  }
  verifyWrapper(wrapperDllPath);

  const koffi = require('koffi');
  const lib = koffi.load(wrapperDllPath);
  const callbackProto = koffi.proto('void', ['str']);
  const callbackPtr = koffi.pointer(callbackProto);
  const wechatOcr = lib.func('wechat_ocr', 'bool', ['str16', 'str16', 'str', callbackPtr]);
  const stopOcr = lib.func('stop_ocr', 'void', []);
  let result = null;
  let callback = null;
  try {
    callback = koffi.register((value) => { result = value; }, callbackPtr);
    const ok = wechatOcr(wxocrDll, wechatDir, imagePath, callback);
    if (!ok) throw new Error('微信原生 OCR 启动失败，请确认微信已登录并更新到 4.x。');
    if (typeof result !== 'string' || result === '') {
      throw new Error('微信原生 OCR 没有返回识别结果。');
    }
    return result;
  } finally {
    try { stopOcr(); } catch { /* 收尾失败不覆盖原始错误 */ }
    if (callback !== null) {
      try { koffi.unregister(callback); } catch { /* 已注销 */ }
    }
  }
}

process.parentPort?.once('message', (event) => {
  const message = event && event.data !== undefined ? event.data : event;
  let response;
  if (!message || message.type !== 'ocr') {
    response = { type: 'error', message: '微信原生 OCR 请求格式无效。' };
  } else {
    try {
      response = { type: 'result', json: runOcr(message.payload) };
    } catch (error) {
      response = { type: 'error', message: errorText(error) };
    }
  }
  post(response);
  setTimeout(() => process.exit(0), 25);
});
