/**
 * 打包环境下的朋友圈视频密钥流自检（H12 验收的最后一格）。
 *
 * 要回答的问题很窄：`check:sns-video` 那 18 项断言跑的是**开发态**，而打包版真正加载的是
 * `dist/win-unpacked/resources/app.asar.unpacked/.../weflow-isaac64/` 里那份 3.8MB WASM。
 * 残留风险只有一句：「打包环境下这份资产 + 胶水能不能实例化，并产出与开发态**逐字节相同**的密钥流」。
 *
 * 这里不重复解密的业务断言，只做两件事，另一件交给 runner：
 *   ① 本文件：用**真实模块**（`query/sns-keystream.ts`，不是复刻的胶水）生成固定种子的密钥流，
 *      在两种运行时下各跑一次，把 sha256 交出去；
 *   ② runner：另外直接对两份资产文件求 sha256 —— 开发态那份与打包 `app.asar.unpacked` 那份
 *      必须逐字节相同。于是「同一份字节 × 同版本 Electron 运行时」这两件事一起成立，
 *      而不需要真的从 `Super Time.exe` 里跑（打包后的 exe 把应用烤进了 asar，
 *      命令行传脚本路径不会替换它 —— 实测它会照常启动主程序去查更新）。
 *
 * 由 `scripts/packaged-sns-video-check.js` 用 esbuild 打成临时 ESM，
 * 分别在 `node` 与 `node_modules/electron/dist/electron.exe` 里跑。
 */
import { createHash } from 'node:crypto'
import { SNS_HEAD_ENCRYPTED_BYTES, wxIsaac64Keystream } from '../src/backend/wechat-data/src/query/sns-keystream.ts'

/** 任取一个 `<enc key>` 形状的种子：这里要的是确定性，不是某条真实视频。 */
const SEED = '4096'

const wantElectron = process.argv.includes('--mode=electron')
const versions = process.versions as NodeJS.ProcessVersions & { electron?: string }
if (wantElectron && versions.electron === undefined) {
  throw new Error('这一遍必须在 Electron 运行时下跑（process.versions.electron 取不到）')
}
if (!wantElectron && versions.electron !== undefined) {
  throw new Error('开发态那一遍应当跑在纯 node 下，实际是 Electron ' + String(versions.electron))
}

const stream = await wxIsaac64Keystream(SEED, SNS_HEAD_ENCRYPTED_BYTES)
if (stream.length !== SNS_HEAD_ENCRYPTED_BYTES) {
  throw new Error(`密钥流长度 ${String(stream.length)}，应为 ${String(SNS_HEAD_ENCRYPTED_BYTES)}`)
}

console.log('SNS-KEYSTREAM ' + JSON.stringify({
  mode: wantElectron ? 'electron' : 'node',
  sha256: createHash('sha256').update(stream).digest('hex'),
  bytes: stream.length,
  runtime: versions.electron ?? 'node ' + process.versions.node,
}))
process.exit(0)
