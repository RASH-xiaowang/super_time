'use strict';

/**
 * electron-builder 的 beforePack 只能加载一个可 require 的模块。
 * SuperLanguage 暂存脚本是独立的 ESM 命令，这里在打包前把它跑完。
 */
const path = require('node:path');
const { spawnSync } = require('node:child_process');

module.exports = async function beforePack() {
  const script = path.join(__dirname, 'stage-superlanguage.mjs');
  const result = spawnSync(process.execPath, [script], { stdio: 'inherit' });
  if (result.status !== 0) {
    throw new Error('stage-superlanguage 失败，退出码 ' + String(result.status));
  }
};
