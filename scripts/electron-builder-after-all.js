'use strict';

/**
 * electron-builder 的 afterAllArtifactBuild 钩子：验证最终 exe 的 Electron
 * fuses。内容检查在 afterPack 做；这里检查 fuses 必须在打包完成后才读得到。
 */
const fs = require('node:fs');
const path = require('node:path');
const { FuseV1Options, getCurrentFuseWire } = require('@electron/fuses');

const DISABLED = 48;
const ENABLED = 49;

module.exports = async function afterAllArtifactBuild(buildResult) {
  if (process.platform !== 'win32') return [];
  const exe = path.join(buildResult.outDir, 'win-unpacked', 'Super Time.exe');
  if (!fs.existsSync(exe)) {
    throw new Error(`[hardening] 找不到打包后的 exe：${exe}`);
  }

  const wire = await getCurrentFuseWire(exe);
  const expected = [
    [FuseV1Options.RunAsNode, DISABLED, 'RunAsNode'],
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable, DISABLED, 'EnableNodeOptionsEnvironmentVariable'],
    [FuseV1Options.EnableNodeCliInspectArguments, DISABLED, 'EnableNodeCliInspectArguments'],
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation, ENABLED, 'EnableEmbeddedAsarIntegrityValidation'],
    [FuseV1Options.OnlyLoadAppFromAsar, ENABLED, 'OnlyLoadAppFromAsar'],
    [FuseV1Options.EnableCookieEncryption, ENABLED, 'EnableCookieEncryption'],
  ];
  const wrong = expected.filter(([key, want]) => wire[key] !== want);
  if (wrong.length > 0) {
    throw new Error(
      '[hardening] Electron fuses 不符合发布基线：'
      + wrong.map(([key, want, name]) => `${name}=${String(wire[key])}（期望 ${want}）`).join('；')
    );
  }
  console.log('[hardening] Electron fuses 基线通过');
  return [];
};
