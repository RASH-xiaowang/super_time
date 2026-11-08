'use strict';

/**
 * electron-builder 的 afterPack 钩子：在生成安装器/发布之前检查最终 asar。
 * 这里不复用 CLI 的退出码，直接抛异常让 electron-builder 停止后续签名/发布。
 */
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { verifyPackagedResources } = require('./check-release-artifacts.js');
const { formatViolations } = require('./release-hardening-rules.js');

module.exports = async function afterPack(context) {
  const resourcesDir = path.join(context.appOutDir, 'resources');
  const problems = verifyPackagedResources(resourcesDir, () => {});
  if (problems.length > 0) {
    throw new Error(
      `[hardening] 发行包泄露门禁失败（${problems.length} 项）\n${formatViolations(problems)}`
    );
  }
  const { verifyPackagedFonts } = await import(
    pathToFileURL(path.join(__dirname, 'font-compliance-check.mjs')).href
  );
  const fontProblems = verifyPackagedFonts(resourcesDir);
  if (fontProblems.violations.length > 0) {
    const details = fontProblems.violations
      .map((item) => `  - [${item.rule}] ${item.file} — ${item.detail}`)
      .join('\n');
    throw new Error(
      `[hardening] 字体合规门禁失败（${fontProblems.violations.length} 项）\n${details}`
    );
  }
  console.log(`[hardening] 发行包内容与字体门禁通过（${fontProblems.entries.length} 个 asar 条目）`);
};
