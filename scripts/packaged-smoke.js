#!/usr/bin/env node
'use strict';

/**
 * 打包产物冒烟：启动 `dist/win-unpacked/Super Time.exe`，检查启动日志与渲染结果。
 *
 * 为什么单独需要它：有一类缺陷**开发态永远看不到**，只在 asar 打包后才暴露 ——
 *   · 后端 bundle 依赖被 external 化后，asar 内是否还能解析（缺包会 ERR_MODULE_NOT_FOUND）；
 *   · 运行期状态若写进安装目录，装到 Program Files 时无写权限、升级/卸载会丢配置，
 *     更严重的是**整个安装目录被拷到别的电脑时会把本机 db_dir 与微信解密密钥带过去**
 *     （对方开机直接拿它去解密，报「数据库目录不存在 (D:\Tencent\...\db_storage)」）。
 *     因此本脚本用一次性 userData 启动，断言：状态只落 userData、安装目录零写入。
 * 这条脚本用应用自带的 SUPERTIME_SCREENSHOT 钩子启动→截图→退出，断言：
 *   ① 后端就绪且 Remote 方法数符合预期；② 日志里没有 ENOTDIR / Cannot find module；
 *   ③ 确实产出了渲染截图（说明窗口与前端资源加载正常）；
 *   ④ 安装目录不含、运行后也不会生成 config.json / llm.json；⑤ 状态落在临时 userData。
 *
 * 用法：node scripts/packaged-smoke.js      （先跑 npm run dist 或 pack）
 */

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const exe = path.join(root, 'dist', 'win-unpacked', 'Super Time.exe');
/** 期望的 Remote 方法数（新增方法时要同步这里）。 */
const EXPECTED_METHODS = 128;

if (!fs.existsSync(exe)) {
  console.error('❌ 找不到打包产物：' + exe + '\n   请先运行 npm run dist（或 npm run pack）');
  process.exit(2);
}

const shot = path.join(os.tmpdir(), `supertime-packaged-${Date.now()}.png`);
/** 一次性 userData：既不污染真实目录，也正好模拟「全新安装」。 */
const userData = path.join(os.tmpdir(), `supertime-userdata-${Date.now()}`);
const unpackedWechat = path.join(root, 'dist', 'win-unpacked', 'resources', 'app.asar.unpacked', 'wechat');

let failed = 0;
const check = (cond, label, detail = '') => {
  console.log(`  ${cond ? '✅' : '❌'} ${label}${detail ? '  [' + detail + ']' : ''}`);
  if (!cond) failed += 1;
};

// ── 启动之前 ──
// 包内容：本机运行时状态不得入包。config.json 存的是本机 db_dir 与微信解密密钥，
// llm.json 存的是 API Key —— 随包发出去既泄漏又会让对方拿到无效路径。
check(!fs.existsSync(path.join(unpackedWechat, 'config.json')),
  '安装包不含 wechat/config.json（本机 db_dir 与微信解密密钥）');
check(!fs.existsSync(path.join(unpackedWechat, 'llm.json')),
  '安装包不含 wechat/llm.json（LLM API Key）');
try {
  const { listPackage } = require('@electron/asar');
  const entries = listPackage(path.join(root, 'dist', 'win-unpacked', 'resources', 'app.asar'))
    .map((f) => f.replace(/\\/g, '/'));
  check(!entries.includes('/wechat/config.json'), 'asar 内也不含 wechat/config.json');
  check(!entries.includes('/wechat/llm.json'), 'asar 内也不含 wechat/llm.json');
  // 朋友圈 CDN 解密要用的 WxIsaac64 WASM（3.8MB）必须在包里，否则「未缓存视频」全播不了
  check(entries.includes('/src/backend/wechat-data/native/weflow-isaac64/wasm_video_decode.wasm'),
    'asar 内含 WxIsaac64 WASM（朋友圈 CDN 解密用）');
  check(entries.includes('/src/backend/wechat-data/native/weflow-isaac64/wasm_video_decode.js'),
    'asar 内含 WxIsaac64 胶水 JS');
} catch {
  console.log('  ·  跳过 asar 列表校验（@electron/asar 不可用）');
}
// 清掉早先运行留下的残留，让本次测的是「全新安装后应用会不会往安装目录写」。
// 这一条不能省：文件本来就在的话，启动后的断言等于没测。
for (const stale of ['config.json', 'llm.json']) {
  try { fs.rmSync(path.join(unpackedWechat, stale), { force: true }); } catch { /* ignore */ }
}

// ── 启动打包产物（截图后自动退出）──
const r = spawnSync(exe, [], {
  cwd: path.dirname(exe),
  encoding: 'utf8',
  timeout: 180_000,
  env: {
    ...process.env,
    SUPERTIME_SCREENSHOT: shot,
    SUPERTIME_USER_DATA_DIR: userData,
  },
});
const out = `${r.stdout || ''}\n${r.stderr || ''}`;
try { fs.rmSync(shot, { force: true }); } catch { /* ignore */ }

const m = out.match(/Remote 方法数:\s*(\d+)/);
if (/已有实例在运行/.test(out)) {
  console.error('\n❌ 已有 Super Time 实例在运行（单实例锁）——请先关闭它再跑打包冒烟');
  process.exit(2);
}
check(Boolean(m), '后端就绪并打印方法数', m ? `方法数=${m[1]}` : '未找到日志');
if (m) check(Number(m[1]) === EXPECTED_METHODS, `Remote 方法数 == ${EXPECTED_METHODS}`,
  `实际 ${m[1]}（新增 Remote 后请更新脚本里的 EXPECTED_METHODS）`);
check(!/ENOTDIR/.test(out), '无 ENOTDIR（app.asar 内写文件）');
check(!/Cannot find module|ERR_MODULE_NOT_FOUND/.test(out), '无模块解析失败（external 依赖已随包）');
check(/\[screenshot\] saved/.test(out), '渲染窗口加载成功（已产出截图）');
check(fs.existsSync(shot) === false, '临时截图已清理');

// ── 启动之后：状态落点 ──
// 关键不变量：安装目录只读、状态只在 userData。
const stateDir = path.join(userData, 'wechat');
check(fs.existsSync(path.join(stateDir, 'config.json')),
  '运行期配置落在 userData（<userData>/wechat/config.json）', stateDir);
check(!fs.existsSync(path.join(unpackedWechat, 'config.json')),
  '启动后安装目录仍未生成 config.json（安装目录保持只读）');
check(!fs.existsSync(path.join(unpackedWechat, 'llm.json')),
  '启动后安装目录仍未生成 llm.json');
check(!fs.existsSync(path.join(userData, 'license-trial.json')),
  '无试用期：不生成 license-trial.json');
check(out.includes(stateDir), '启动日志里的状态目录指向本次临时 userData');

// 清理本次一次性 userData（里面可能有刚写入的配置）。
try { fs.rmSync(userData, { recursive: true, force: true }); } catch { /* ignore */ }

console.log(`\n${failed ? '❌ 打包冒烟失败 ' + failed + ' 项' : '✅ 打包冒烟通过'}`);
if (failed) {
  console.log('\n--- 启动日志尾部 ---\n' + out.split('\n').slice(-25).join('\n'));
  process.exit(1);
}
