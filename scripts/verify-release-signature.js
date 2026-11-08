#!/usr/bin/env node
'use strict';

/**
 * 正式发布的签名与更新元数据门禁。
 *
 * 本地 `npm run pack` 允许未签名（测试用）；只有这条脚本通过，才允许上传到
 * GitHub Releases。校验对象是最终内存里的同一批文件，避免“签了 A、传了 B”。
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { readAsarEntry, verifyPackagedResources } = require('./check-release-artifacts.js');
const {
  formatViolations,
  packageMetadataViolations,
} = require('./release-hardening-rules.js');

const root = path.resolve(__dirname, '..');
const POWERSHELL_CANDIDATES = ['pwsh.exe', 'powershell.exe'];
let powerShellHost = '';

/** PowerShell 单引号字符串转义。 */
function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/**
 * `Get-AuthenticodeSignature` 属于 Microsoft.PowerShell.Security。部分 Windows
 * PowerShell 5.1 环境的模块自动加载会失败，而 GitHub Windows runner 与本地开发机
 * 都提供 PowerShell 7。优先 `pwsh`，不可用时才退回 `powershell.exe`。
 * @returns {string}
 */
function resolvePowerShellHost() {
  if (powerShellHost !== '') return powerShellHost;
  for (const candidate of POWERSHELL_CANDIDATES) {
    try {
      execFileSync(candidate, ['-NoProfile', '-NonInteractive', '-Command', 'exit 0'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      powerShellHost = candidate;
      return candidate;
    } catch {
      // 继续尝试下一个宿主；全部失败时在调用处给出明确错误。
    }
  }
  throw new Error(`找不到可用的 PowerShell（尝试过：${POWERSHELL_CANDIDATES.join(', ')}）`);
}

/**
 * 读取一个 PE 文件的 Authenticode 状态。
 * @param {string} file
 * @returns {{ status: string, statusMessage: string, signer: string, timestamp: string }}
 */
function readAuthenticode(file) {
  const script = [
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    '$OutputEncoding = [System.Text.Encoding]::UTF8',
    `$sig = Get-AuthenticodeSignature -LiteralPath ${psQuote(file)}`,
    'if ($null -eq $sig) { throw "Get-AuthenticodeSignature returned null" }',
    '[pscustomobject]@{',
    '  status = [string]$sig.Status;',
    '  statusMessage = [string]$sig.StatusMessage;',
    '  signer = if ($null -eq $sig.SignerCertificate) { "" } else { [string]$sig.SignerCertificate.Subject };',
    '  timestamp = if ($null -eq $sig.TimeStamperCertificate) { "" } else { [string]$sig.TimeStamperCertificate.Subject }',
    '} | ConvertTo-Json -Compress',
  ].join('\n');
  const raw = execFileSync(resolvePowerShellHost(), [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    script,
  ], { encoding: 'utf8', windowsHide: true }).replace(/^\uFEFF/, '').trim();
  return JSON.parse(raw);
}

/** 从 app-update.yml 读发布者名称（兼容标量与列表两种 electron-builder 输出）。 */
function readPublisherNames(ymlText) {
  const text = String(ymlText ?? '').replace(/\r\n/g, '\n');
  const lines = text.split('\n');
  const at = lines.findIndex((line) => /^publisherName:\s*/i.test(line));
  if (at < 0) return [];
  const inline = lines[at].replace(/^publisherName:\s*/i, '').trim();
  if (inline !== '') {
    return [inline.replace(/^['"]|['"]$/g, '').trim()].filter(Boolean);
  }
  const names = [];
  for (let i = at + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^\S/.test(line)) break;
    const match = /^\s*-\s*(.+?)\s*$/.exec(line);
    if (match) names.push(match[1].replace(/^['"]|['"]$/g, '').trim());
  }
  return names.filter(Boolean);
}

/** 读取 latest.yml 中与更新安全相关的字段。 */
function readLatestYml(ymlText) {
  const text = String(ymlText ?? '').replace(/\r\n/g, '\n');
  const version = /^version:\s*([^\s#]+)\s*$/m.exec(text)?.[1] ?? '';
  const pathField = /^\s*path:\s*([^\n#]+?)\s*$/m.exec(text)?.[1]?.trim() ?? '';
  const sha512 = /^\s*sha512:\s*([A-Za-z0-9+/=]+)\s*$/m.exec(text)?.[1] ?? '';
  return { version, path: pathField, sha512 };
}

/** 证书 Subject 是否包含配置中声明的发布者。 */
function signerMatchesPublisher(signer, publisher) {
  const normalize = (value) => String(value ?? '')
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/["']/g, '');
  const actual = normalize(signer);
  const expected = normalize(publisher);
  return expected !== '' && actual.includes(expected);
}

function sha512Base64(file) {
  return crypto.createHash('sha512').update(fs.readFileSync(file)).digest('base64');
}

/**
 * electron-builder 在 latest.yml / GitHub Releases 中使用去掉空格的文件名
 * （`Super Time Setup 1.2.3.exe` → `Super-Time-Setup-1.2.3.exe`）。门禁必须按
 * 实际发布名比较，而不是拿本地磁盘名直接对比。
 * @param {string} file
 * @returns {string}
 */
function releaseAssetName(file) {
  return path.basename(String(file)).replace(/ /g, '-');
}

function main() {
  if (process.platform !== 'win32') {
    throw new Error('release signature verification is Windows-only');
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const version = String(pkg.version ?? '');
  const dist = path.join(root, 'dist');
  const resources = path.join(dist, 'win-unpacked', 'resources');
  const exe = path.join(dist, 'win-unpacked', 'Super Time.exe');
  const installer = path.join(dist, `Super Time Setup ${version}.exe`);
  const blockmap = `${installer}.blockmap`;
  const latestYml = path.join(dist, 'latest.yml');
  const appUpdateYml = path.join(resources, 'app-update.yml');

  const problems = [];
  for (const [label, file] of [
    ['应用 exe', exe],
    ['安装包', installer],
    ['更新块图', blockmap],
    ['latest.yml', latestYml],
    ['app-update.yml', appUpdateYml],
  ]) {
    if (!fs.existsSync(file)) problems.push({ entry: label, rule: 'missing-release-file', hint: file });
  }
  if (problems.length > 0) {
    throw new Error(`[release] 缺少最终发布文件：\n${formatViolations(problems)}`);
  }

  const contentProblems = verifyPackagedResources(resources, () => {});
  if (contentProblems.length > 0) {
    throw new Error(`[release] 打包内容门禁失败：\n${formatViolations(contentProblems)}`);
  }

  const asarPath = path.join(resources, 'app.asar');
  try {
    const metadata = JSON.parse(readAsarEntry(asarPath, 'package.json').toString('utf8'));
    problems.push(...packageMetadataViolations(metadata));
  } catch (error) {
    problems.push({
      entry: 'package.json',
      rule: 'unreadable-package-metadata',
      hint: `无法读取 app.asar 内的 package.json：${error?.message ?? error}`,
    });
  }

  const publisherNames = readPublisherNames(fs.readFileSync(appUpdateYml, 'utf8'));
  if (publisherNames.length === 0) {
    throw new Error('[release] app-update.yml 缺少 publisherName，自动更新不会校验发布者');
  }

  for (const [label, file] of [['应用 exe', exe], ['安装包', installer]]) {
    const signature = readAuthenticode(file);
    if (String(signature.status).toLowerCase() !== 'valid') {
      problems.push({
        entry: label,
        rule: 'authenticode',
        hint: `${signature.status || 'unknown'}：${signature.statusMessage || '签名无效'}`,
      });
      continue;
    }
    if (String(signature.timestamp || '').trim() === '') {
      problems.push({ entry: label, rule: 'timestamp', hint: '签名缺少可信时间戳' });
    }
    if (!publisherNames.some((name) => signerMatchesPublisher(signature.signer, name))) {
      problems.push({
        entry: label,
        rule: 'publisher',
        hint: `证书主体与 publisherName 不匹配：${publisherNames.join(' | ')}`,
      });
    }
  }

  const latest = readLatestYml(fs.readFileSync(latestYml, 'utf8'));
  if (latest.version !== version) {
    problems.push({ entry: 'latest.yml', rule: 'update-version', hint: `期望 ${version}，实际 ${latest.version || '(空)'}` });
  }
  const expectedAssetName = releaseAssetName(installer);
  if (path.basename(latest.path) !== expectedAssetName) {
    problems.push({ entry: 'latest.yml', rule: 'update-path', hint: `期望 ${expectedAssetName}，实际 ${latest.path || '(空)'}` });
  }
  if (latest.sha512 === '') {
    problems.push({ entry: 'latest.yml', rule: 'update-digest', hint: '缺少 sha512' });
  } else if (latest.sha512 !== sha512Base64(installer)) {
    problems.push({ entry: 'latest.yml', rule: 'update-digest', hint: 'sha512 与当前安装包不一致' });
  }

  if (problems.length > 0) {
    throw new Error(`[release] 签名/更新门禁失败：\n${formatViolations(problems)}`);
  }
  console.log(`✅ 发布签名门禁通过：${path.basename(installer)}`);
  console.log(`   发布者：${publisherNames.join(' | ')}`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`❌ ${error?.message ?? error}`);
    process.exit(1);
  }
}

module.exports = {
  readAuthenticode,
  resolvePowerShellHost,
  readPublisherNames,
  readLatestYml,
  releaseAssetName,
  signerMatchesPublisher,
  sha512Base64,
};
