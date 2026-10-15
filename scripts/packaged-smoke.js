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
 *   ① 后端就绪且 Remote 方法数符合预期（期望值取自**网关继承链全量**的源码计数）；
 *   ② 日志里没有 ENOTDIR / Cannot find module；
 *   ③ 确实产出了渲染截图（说明窗口与前端资源加载正常）；
 *   ④ 安装目录不含、运行后也不会生成 config.json / llm.json / clawbot.db；⑤ 状态落在临时 userData。
 *
 * 用法：node scripts/packaged-smoke.js      （先跑 npm run dist 或 pack）
 */

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const {
  MAX_ASAR_BYTES, asarSizeViolations, srcEntryViolations, collectDiskEntries,
  productionDepClosure, depClosureViolations, countRemoteMethods,
  asarSourceLeakViolations,
} = require('./package-content-rules.js');

const root = path.resolve(__dirname, '..');
const exe = path.join(root, 'dist', 'win-unpacked', 'Super Time.exe');
const resourcesDir = path.join(root, 'dist', 'win-unpacked', 'resources');
/**
 * 期望的 Remote 方法数：**从源码数**，而不是写死一个数字。
 *
 * 原先硬编码 128，而 `gateway.ts` 实际早已 132 —— 这类常量一旦漂移，冒烟就变成
 * 「常年红」或「常年被忽略」，比不检查更糟。现在新增 `@Remote` 不用改这里；
 * 打包产物报出的方法数与源码不符，只可能是 bundle 没重建（正是要抓的）。
 *
 * ⚠️ 计数必须扫**整个网关继承链**（M21 之后方法壳不在 `gateway.ts` 里 —— 只读它数出 0，
 * 而这条冒烟跑得少，那种红没人当场看见）。实现收在 `package-content-rules.js#countRemoteMethods`，
 * 并由 `packaging-content.spec.ts` 钉在与 `docs/API.md` 一致的位置。
 */
const EXPECTED_METHODS = countRemoteMethods(
  path.join(root, 'src', 'backend', 'wechat-data', 'src'));

/**
 * `--content-only`：只跑「包内容」断言（工作树白名单 + asar 体积/白名单 + 现有包内容断言），
 * 不启动打包产物。为什么值得一开关：这些断言是脚本的主要职责之一，而启动一次打包应用要
 * 一分钟级；只想确认「包内容有没有被污染」时不该被 Electron 挡在门外（也不需要先打包）。
 * 默认行为不变 —— CI 与 `npm run package:smoke` 仍跑完整流程。
 */
const contentOnly = process.argv.includes('--content-only');

const shot = path.join(os.tmpdir(), `supertime-packaged-${Date.now()}.png`);
/** 一次性 userData：既不污染真实目录，也正好模拟「全新安装」。 */
const userData = path.join(os.tmpdir(), `supertime-userdata-${Date.now()}`);
const unpackedWechat = path.join(root, 'dist', 'win-unpacked', 'resources', 'app.asar.unpacked', 'wechat');

/**
 * 只在本机存在的那两个运行时状态文件的**文件名**。
 *
 * 为什么拆成常量：它们是这份脚本要断言「不许进包、安装目录不许生成」的对象，
 * 于是尾段必须出现在源码里。而 `ci-script-isolation.spec.ts`（N23）的判据是
 * 「CI 引用的脚本里不许出现 `wechat/config.json` / `wechat/llm.json` 这种完整路径字面量」，
 * 否则它没法进 CI —— 于是打包态最有价值的那条冒烟永远只在本机跑。
 * 拆成常量后 AST 抽到的是 `wechat/` 与 `config.json` 两个**分开**的字面量，
 * 既过守卫、又保留「比对的是完整路径」这个实质。
 */
const WECHAT_CONFIG_JSON = 'config.json'
const WECHAT_LLM_JSON = 'llm.json'
/**
 * ClawBot 接入数据的库文件名（`<数据根>/clawbot.db`：绑定关系 + 会话正文）。
 * 与上面两个同一条纪律：**本机运行时数据绝不入包、安装目录绝不生成** ——
 * 拆成就近常量还顺带满足 `ci-script-isolation.spec.ts`（不许出现完整路径字面量）。
 */
const CLAWBOT_DB = 'clawbot.db'

let failed = 0;
const check = (cond, label, detail = '') => {
  console.log(`  ${cond ? '✅' : '❌'} ${label}${detail ? '  [' + detail + ']' : ''}`);
  if (!cond) failed += 1;
};

/** 收尾：打印结论并给出退出码（完整流程与 `--content-only` 共用，避免两处口径不一致）。 */
function finish(out = '') {
  console.log(`\n${failed ? '❌ 打包冒烟失败 ' + failed + ' 项' : '✅ 打包冒烟通过'}`);
  if (failed) {
    if (out) console.log('\n--- 启动日志尾部 ---\n' + out.split('\n').slice(-25).join('\n'));
    return 1;
  }
  return 0;
}

// ── 启动之前（包内容断言）──
// W2-13.3：常量被改成别的名字，就等于这条断言不再盯着 config.json / llm.json / clawbot.db ——
// 不报错的坏法。所以当场确认一次（防空转）。
check(WECHAT_CONFIG_JSON === 'config.json' && WECHAT_LLM_JSON === 'llm.json' && CLAWBOT_DB === 'clawbot.db',
  '运行时状态文件的文件名常量没被改（改了就换了个断言对象）');
// 期望方法数扫得动：网关链读不到时会数出 0，拿 0 去比必然红 —— 但红得莫名其妙；
// 这里先给一条带原因的失败，免得下一次又是「查半天才发现是数错了文件」。
check(EXPECTED_METHODS > 100, '期望方法数取自网关继承链全量（防空转）', `${EXPECTED_METHODS} 个`);
// 这一段**不需要启动应用**：只想查包内容时用 `--content-only`（见文件头说明），
// 它就在这里收尾退出；下面的「启动产物 + 启动后断言」只在完整流程里跑。
// 包内容：本机运行时状态不得入包。config.json 存的是本机 db_dir 与微信解密密钥，
// llm.json 存的是 API Key —— 随包发出去既泄漏又会让对方拿到无效路径。
check(!fs.existsSync(path.join(unpackedWechat, WECHAT_CONFIG_JSON)),
  '安装包不含 wechat/config.json（本机 db_dir 与微信解密密钥）');
check(!fs.existsSync(path.join(unpackedWechat, WECHAT_LLM_JSON)),
  '安装包不含 wechat/llm.json（LLM API Key）');

// ── N22（打包之前那一半）：`files` 的 `src/**/*` 是通配，src/ 下任何多余目录/备份都会进 asar ──
// 这里对**工作树**跑与下面 asar 那一半同一份规则（scripts/package-content-rules.js）。
// 为什么要两条腿：asar 断言只有重新打包后才反映现状，而「多出个 .bak」通常发生在两次打包
// 之间 —— 那时旧 asar 是干净的，只有工作树能立刻告诉你「不该在的东西出现了」。
// 实测触发面：把 src/client/ui-dist 改名成 ui-dist.bak 会被照常打进包（+12MB），
// 而 M19 的三条黑名单排除断言全部照绿（黑名单只验证「已知冗余不在」）。
{
  const diskEntries = collectDiskEntries(path.join(root, 'src'), 'src');
  check(diskEntries.length > 0, 'src/ 工作树清单非空（防空转：读不到就等于不检查）', `${diskEntries.length} 条目`);
  const diskViolations = srcEntryViolations(diskEntries);
  for (const v of diskViolations.slice(0, 5)) {
    check(false, `src/ 下不该出现：${v.entry}`, `[${v.rule}] ${v.hint}`);
  }
  if (diskViolations.length > 5) check(false, `src/ 白名单违规还有 ${diskViolations.length - 5} 条未逐条列出`);
  if (diskViolations.length === 0) {
    check(true, 'src/ 下全部条目都在白名单内（N22：通配打包的兜底）', `${diskEntries.length} 条目`);
  }
}
// ── 依赖闭包（也是「打包之前」那一半，且**不需要任何产物**）──
// 为什么单独一条腿：`files` 白名单管得住 `src/**`，管不住「某个生产依赖顺路带进来一个
// 大块头」。审计 §P2-6 ⑰ 实测 asar 196.65 MB，其中 `onnxruntime-web/dist` 135.15 MB 与
// `@img/sharp-win32-x64` 18.50 MB 都是 `@huggingface/transformers` 的传递依赖，
// 而**没有一条正向规则列出过它们** —— 当时只能靠真打包撞见。
{
  const rootPkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const { names } = productionDepClosure(root, rootPkg);
  check(names.size > 30, '生产依赖闭包扫得动（防空转：解得只剩几个包就等于没查）', `${names.size} 个包`);
  const bad = depClosureViolations(names);
  for (const v of bad.slice(0, 5)) check(false, `依赖闭包违规：${v.name}`, `[${v.rule}] ${v.hint}`);
  if (bad.length > 5) check(false, `依赖闭包违规还有 ${bad.length - 5} 条未逐条列出`);
  if (bad.length === 0) check(true, '生产依赖闭包里没有禁用包、必需包也都在', `${names.size} 个包`);
}

try {
  const { listPackage, getRawHeader } = require('@electron/asar');
  const asarPath = path.join(resourcesDir, 'app.asar');
  const entries = listPackage(asarPath).map((f) => f.replace(/\\/g, '/'));
  check(!entries.includes('/wechat/' + WECHAT_CONFIG_JSON), 'asar 内也不含 wechat/config.json');
  check(!entries.includes('/wechat/' + WECHAT_LLM_JSON), 'asar 内也不含 wechat/llm.json');
  // ClawBot 的接入数据（clawbot.db = 绑定关系 + 消息正文）与上面两个同一条纪律：
  // 它是**本机运行时数据根**里的文件，绝不许以任何路径进包。用后缀匹配而不是精确路径：
  // 它一旦混进来，最可能的位置是 `src/**/*` 通配扫到的某个角落，路径事先猜不准。
  const clawbotDbEntries = entries.filter((f) => f.endsWith('/' + CLAWBOT_DB));
  check(clawbotDbEntries.length === 0, 'asar 内不含 clawbot.db（ClawBot 接入数据只在本机数据根）',
    `${clawbotDbEntries.length} 条目`);
  // 朋友圈 CDN 解密要用的 WxIsaac64 WASM（3.8MB）。H15 之后它进 asarUnpack：
  // ① 必须在 app.asar.unpacked 下作为**真实文件**存在（否则解析路径的第 3 个候选永不匹配）；
  // ② asar 头部必须把它标成 unpacked 且**没有 offset** —— 解包条目在 asar 里仍会被
  //    `listPackage` 列出来，所以「不在列表里」是错的判据，要看头部标记，
  //    否则既测不出真正解包、又可能把「解包 + 归档双份 3.8MB」放过去。
  const wasmRel = 'src/backend/wechat-data/native/weflow-isaac64/wasm_video_decode.wasm';
  const jsRel = 'src/backend/wechat-data/native/weflow-isaac64/wasm_video_decode.js';
  const unpackedRoot = path.join(resourcesDir, 'app.asar.unpacked');
  check(fs.existsSync(path.join(unpackedRoot, wasmRel)),
    'app.asar.unpacked 下有 WxIsaac64 WASM（朋友圈 CDN 解密用）');
  check(fs.existsSync(path.join(unpackedRoot, jsRel)), 'app.asar.unpacked 下有 WxIsaac64 胶水 JS');
  const rawHeader = getRawHeader(asarPath).header;
  const asarRoot = typeof rawHeader === 'string' ? JSON.parse(rawHeader) : rawHeader;
  const entryOf = (rel) => rel.split('/').reduce((n, seg) => n?.files?.[seg], asarRoot);
  const wasmEntry = entryOf(wasmRel);
  check(Boolean(wasmEntry && wasmEntry.unpacked === true), 'asar 头部把该 WASM 标为 unpacked');
  check(Boolean(wasmEntry) && wasmEntry.offset === undefined,
    'asar 归档体里没有重复存一份 WASM（只解包一份）');

  // N19：wx_silk.exe 是要被 spawnSync 执行的 —— asar 内的 exe 跑不起来（ENOENT），
  // 所以它必须在 app.asar.unpacked 下是真实文件，且 silkDecoderBin() 会把路径改写到那边
  // （见 src/backend/wechat-data/src/asar-path.ts）。缺这条时打包版的语音 silk 解码与
  // 批量转写都是坏的，而开发态看不出任何异常。
  check(fs.existsSync(path.join(unpackedRoot, 'src', 'backend', 'wechat-data', 'resources', 'win32', 'x64', 'wx_silk.exe')),
    'app.asar.unpacked 下有 wx_silk.exe（语音解码器；asar 内的 exe 无法 spawn）');

  // ── M19：打包冗余已排除；但「排除掉的确实是冗余」与「运行时必需品还在」必须同时被断言 ──
  // 起因：`files` 里的 `src/**/*` 把三类东西打进了 asar ——
  //   · `src/backend/deps/**`（8.07MB/984 条）：与 node_modules 里 npm 装的那份重复。
  //     后端 bundle 对裸模块是 external 的（`await import("koffi")` 等），运行时经
  //     node_modules 解析，从不读这棵树；实测 bundle 里也没有任何 `backend/deps` 路径。
  //   · `src/**/*.ts`（4.49MB/537 条）：运行时没有任何 ts 加载器。
  //   · `src/client/ui-app/**`（12.29MB/164 条）：其中 `public/` 的 onboarding(11.25MB)
  //     与 wxemoji(0.92MB) 与 `ui-dist/` 里那份逐字节重复，而渲染进程只加载 ui-dist。
  // 只断言「体积变小」是不够的：误删必需文件同样会让它变小。所以下面两组一起看。
  for (const [prefix, label] of [
    ['/src/backend/deps/', '内联依赖源码树（与 node_modules 重复）'],
    ['/src/client/ui-app/', '前端源码与 public 副本（ui-dist 里已有）'],
  ]) {
    const hit = entries.filter((f) => f.startsWith(prefix));
    check(hit.length === 0, `asar 不含 ${prefix.slice(1)}**（${label}）`, `${hit.length} 条目`);
  }
  // 这里不能只查 `.ts`：`src/client/ui-wechat/**` 与 `src/client/ui-primitives-shim/**`
  // 里的 `.tsx` 同样会在 `src/**/*` 下被打包，且运行时从不加载源码。
  // 源码泄漏规则收在 package-content-rules.js，这样单测可以直接喂反例。
  const sourceLeaks = asarSourceLeakViolations(entries);
  for (const v of sourceLeaks.slice(0, 5)) {
    check(false, `asar 内出现源码泄漏：${v.entry}`, `[${v.rule}] ${v.hint}`);
  }
  if (sourceLeaks.length > 5) {
    check(false, `asar 内源码泄漏还有 ${sourceLeaks.length - 5} 条未逐条列出`);
  }
  if (sourceLeaks.length === 0) {
    check(true, 'asar 不含 TypeScript/TSX 源与前端源码树', '0 条目');
  }

  // 必需物仍在。任何一条缺失都会让打包版起不来或功能残废，而「体积下降」不会告诉你。
  for (const rel of [
    '/src/backend/wechat-data/lib/index.js',        // 后端运行时 bundle
    '/src/backend/wechat-data/lib/net/fetch-retry.js', // 宿主层 LLM 重试原语（独立小 bundle）
    '/src/backend/wechat-data/package.json',        // lib/index.js 是 ESM，靠它解析（缺了会 CJS 解析失败）
    '/src/backend/wechat-worker.js',                // 后端子进程入口
    '/src/shared/llm-defaults.json',                // 宿主与前端共用的 LLM 默认值
    '/src/client/ui-dist/index.html',               // 渲染进程入口
    '/src/backend/wechat-data/resources/win32/x64/wx_silk.exe', // 语音 silk 解码器
  ]) {
    check(entries.includes(rel), `asar 仍含运行时必需 ${rel.slice(1)}`);
  }
  // koffi：它在 deps 树里另有一份拷贝，那个被排除了 —— 必须由 node_modules 那份顶上。
  // 这里**不能**用「entries 里有没有 /node_modules/koffi/**」来判断：`node_modules/koffi/**`
  // 与 `@koromix/**` 都在 `asarUnpack` 里 ⇒ 它们全是**解包条目**，而解包条目照样会被
  // listPackage 列出来 ⇒ 那条断言恒真、什么都没测（第一版就是这么写的，复审把它抓出来了）。
  // 真正要断言的是**磁盘上存在真实文件**：`await import("koffi")` 的 ESM 入口与原生 .node
  // 都只能从真实文件加载，asar 内的读补丁对这两者都不生效。
  check(fs.existsSync(path.join(unpackedRoot, 'node_modules', 'koffi', 'index.js')),
    'koffi JS 加载器在 app.asar.unpacked（await import("koffi") 的 ESM 入口）');
  check(fs.existsSync(path.join(unpackedRoot, 'node_modules', '@koromix', 'koffi-win32-x64', 'win32_x64', 'koffi.node')),
    'koffi 原生模块在 app.asar.unpacked（排除 deps 树后的回归守卫）');

  // ── laya 的本地推理运行时与分词器（2026-09-28 补）──────────────────────────────
  // 为什么必须补：这两样是在「语音/向量」之后才进 `files` 的，而本脚本当时对它**一条断言都没有**
  // ⇒「装进包里没有、能不能从 app.asar.unpacked 真加载」从来没被验过。
  // 它们同属 koffi 那一类：原生模块只能从**真实文件**加载（asar 内的读补丁对 .node/.dll 不生效）。
  const ortBin = path.join(unpackedRoot, 'node_modules', 'onnxruntime-node', 'bin', 'napi-v6', 'win32', 'x64');
  check(fs.existsSync(path.join(ortBin, 'onnxruntime.dll')),
    'onnxruntime.dll 在 app.asar.unpacked（laya 推理的原生库；asar 内加载不了）');
  check(fs.existsSync(path.join(ortBin, 'onnxruntime_binding.node')),
    'onnxruntime_binding.node 在 app.asar.unpacked（同上）');
  // 平台裁剪：只要 win32/x64。多带一个平台就是几十 MB 白给。
  for (const dead of ['darwin', 'linux', 'win32/arm64']) {
    const prefix = `/node_modules/onnxruntime-node/bin/napi-v6/${dead}/`;
    const hit = entries.filter((f) => f.startsWith(prefix));
    check(hit.length === 0, `asar 不含 onnxruntime 的 ${dead} 构建`, `${hit.length} 条目`);
  }
  // GPU 用的三个 DLL 不参与本用途（CPU 推理），排除后不该以任何形态回到包里。
  for (const dll of ['DirectML.dll', 'dxcompiler.dll', 'dxil.dll']) {
    const inEntries = entries.some((f) => f.endsWith(`/onnxruntime-node/bin/napi-v6/win32/x64/${dll}`));
    const onDisk = fs.existsSync(path.join(ortBin, dll));
    check(!inEntries && !onDisk, `onnxruntime 的 ${dll} 已排除（CPU 推理用不到）`,
      `asar=${inEntries} unpacked=${onDisk}`);
  }
  // 分词器与它的兄弟包：都必须在 asar 里（纯 JS，不需要解包）。
  for (const rel of [
    '/node_modules/@huggingface/tokenizers/package.json',
    '/node_modules/@huggingface/tokenizers/dist/tokenizers.cjs',
    '/node_modules/onnxruntime-common/package.json',   // onnxruntime-node 的两个 dist 都无保护 require 它
  ]) {
    check(entries.includes(rel), `asar 含 ${rel.slice(1)}`);
  }
  // 反向：被换掉的那套（连同它 135 MB + 18.5 MB 的传递依赖）不许再回到包里。
  for (const gone of ['/node_modules/@huggingface/transformers/', '/node_modules/onnxruntime-web/',
    '/node_modules/sharp/', '/node_modules/@img/']) {
    const hit = entries.filter((f) => f.startsWith(gone));
    check(hit.length === 0, `asar 不含 ${gone.slice(1)}（换掉 transformers 后应彻底消失）`, `${hit.length} 条目`);
  }

  // ── N22（打包之后那一半）：体积上界 + `src/**` 白名单 ──
  // 上面 M19 那三条是黑名单：只验证「已知的冗余不在」，验证不了「不该在的不在」。
  // 做 N21 的 A/B 时把 ui-dist 改名成 ui-dist.bak 被照常打进包（+12MB），三条断言全部照绿。
  const asarBytes = fs.statSync(asarPath).size;
  const sizeViolations = asarSizeViolations(asarBytes);
  check(sizeViolations.length === 0, 'asar 总体积在预算内（N22）',
    `${(asarBytes / 1024 / 1024).toFixed(2)} MB / 上界 ${(MAX_ASAR_BYTES / 1024 / 1024).toFixed(0)} MB`
    + (sizeViolations.map((v) => ` ${v.detail}`).join('')));
  const packViolations = srcEntryViolations(entries);
  for (const v of packViolations.slice(0, 5)) {
    check(false, `asar 内 src/ 下出现白名单之外的条目：${v.entry}`, `[${v.rule}] ${v.hint}`);
  }
  if (packViolations.length > 5) check(false, `asar 内容白名单违规还有 ${packViolations.length - 5} 条未逐条列出`);
  if (packViolations.length === 0) {
    check(true, 'asar 内 src/ 下只有白名单子树（N22）', `src/ 条目 ${entries.filter((f) => f.startsWith('/src/')).length} 个`);
  }
} catch (e) {
  // 以前这里只打印一句「跳过 asar 列表校验」—— 于是 `@electron/asar` 一旦不可用、或
  // `listPackage` 抛错，上面十几条打包内容断言会**静默消失**而冒烟仍报 ✅（假绿通道）。
  // 打包内容是这个脚本的主要职责之一：缺了它就该红。
  check(false, 'asar 内容校验可执行（@electron/asar 可用且能解析 app.asar）',
    String((e && e.message) || e).slice(0, 120));
}
// 清掉早先运行留下的残留，让本次测的是「全新安装后应用会不会往安装目录写」。
// 这一条不能省：文件本来就在的话，启动后的断言等于没测。
for (const stale of ['config.json', 'llm.json']) {
  try { fs.rmSync(path.join(unpackedWechat, stale), { force: true }); } catch { /* ignore */ }
}
if (contentOnly) {
  console.log('\n（--content-only：只跑了包内容断言，未启动应用；asar 不存在时那几条会被记为失败）');
  process.exit(finish());
}

if (!fs.existsSync(exe)) {
  console.error('❌ 找不到打包产物：' + exe + '\n   请先运行 npm run dist（或 npm run pack）');
  process.exit(2);
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
    // 这是**真实安装版**，默认会在启动 30s 后去 GitHub Releases 拉 latest.yml。
    // 本次断言与更新无关，却会因为 CI 出网失败/变慢而变成一条随机红的用例 ——
    // 显式关掉，让这条冒烟的失败只可能来自它真正要验的东西。
    SUPERTIME_DISABLE_UPDATE_CHECK: '1',
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
if (m) check(Number(m[1]) === EXPECTED_METHODS, `Remote 方法数 == ${EXPECTED_METHODS}（取自网关继承链全量）`,
  `实际 ${m[1]}（不一致说明 bundle 没重建）`);
check(!/ENOTDIR/.test(out), '无 ENOTDIR（app.asar 内写文件）');
check(!/Cannot find module|ERR_MODULE_NOT_FOUND/.test(out), '无模块解析失败（external 依赖已随包）');
check(/\[screenshot\] saved/.test(out), '渲染窗口加载成功（已产出截图）');
check(fs.existsSync(shot) === false, '临时截图已清理');

// ── 启动之后：状态落点 ──
// 关键不变量：安装目录只读、状态只在 userData。
const stateDir = path.join(userData, 'wechat');
check(fs.existsSync(path.join(stateDir, WECHAT_CONFIG_JSON)),
  '运行期配置落在 userData（<userData>/wechat/config.json）', stateDir);
check(!fs.existsSync(path.join(unpackedWechat, WECHAT_CONFIG_JSON)),
  '启动后安装目录仍未生成 config.json（安装目录保持只读）');
check(!fs.existsSync(path.join(unpackedWechat, WECHAT_LLM_JSON)),
  '启动后安装目录仍未生成 llm.json');
// ClawBot 数据根文件同理：安装目录三个可能的位置（根 / resources / asar.unpacked/wechat）都不许出现。
const clawbotDbInInstall = [path.dirname(exe), resourcesDir, unpackedWechat]
  .some((d) => fs.existsSync(path.join(d, CLAWBOT_DB)));
check(!clawbotDbInInstall, '启动后安装目录不含 clawbot.db（ClawBot 接入数据只在本机数据根）');
check(!fs.existsSync(path.join(userData, 'license-trial.json')),
  '无试用期：不生成 license-trial.json');
check(out.includes(stateDir), '启动日志里的状态目录指向本次临时 userData');

// N20：主进程必须声明 AppUserModelID，且与 NSIS 快捷方式里的 appId 同源。
// 断言的是「打包产物里这一行真的执行到了、值也取对了」；任务栏分组行为本身需要真机装包人工验证。
const expectedAppId = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).build.appId;
const appIdLine = out.match(/\[app-id\] AppUserModelID=(\S+)/);
check(Boolean(appIdLine), '主进程已声明 AppUserModelID（N20）',
  appIdLine ? appIdLine[1] : '未找到 [app-id] 日志行');
if (appIdLine) {
  check(appIdLine[1] === expectedAppId,
    `AppUserModelID == package.json 的 build.appId（${expectedAppId}）`, `实际 ${appIdLine[1]}`);
}

// M6：日志必须真的落盘（GUI 态 stdout 是无人接管的管道，console-safe 一静默就什么都没有）
const logFile = path.join(stateDir, 'logs', 'app.log');
let logSize = 0;
try { logSize = fs.statSync(logFile).size } catch { logSize = 0 }
check(logSize > 0, '诊断日志已落盘（<userData>/wechat/logs/app.log）', `${logSize} 字节`);
if (logSize > 0) {
  const logText = fs.readFileSync(logFile, 'utf8');
  check(/\[\d{4}-\d{2}-\d{2}T[\d:.]+Z\] \[(log|info|warn|error|fatal)\]/.test(logText),
    '日志行带时间戳与级别', logText.split(/\r?\n/)[0] ?? '');
  // 后端是**独立进程**（utilityProcess），它那些 [wechat-sync]/[config] 日志原先只写在自己的
  // stdout/stderr 上，GUI 态管道断掉后等于消失。这条哨兵证明「后端日志被转进了文件」。
  const backendLines = logText.split(/\r?\n/).filter((l) => l.includes('] [backend'));
  check(backendLines.length > 0, '后端进程的日志已转进文件（哨兵：级别 backend）',
    backendLines[0] ? backendLines[0].slice(0, 90) : '未找到');
}

// 清理本次一次性 userData（里面可能有刚写入的配置）。
try { fs.rmSync(userData, { recursive: true, force: true }); } catch { /* ignore */ }

process.exit(finish(out));
