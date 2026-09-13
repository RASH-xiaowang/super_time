/**
 * whisper 模型/引擎目录的落点校验。
 *
 * 守的是一条不变量：**安装目录只读，模型与引擎落在可写目录**。
 * 早先模型目录就是「项目/安装目录里的 wechat/whisper」，于是
 *   · 下载一个新模型会往安装位置写（装到 Program Files 时直接失败）；
 *   · 旧配置里那句 `whisper_models_dir: D:\super-time-wechat\wechat\whisper`
 *     会被一直沿用，把本机路径留在安装目录、并随整个目录被拷到别的电脑。
 * 现在默认目录是 `<数据根>/whisper`，随包资产在首次使用时镜像进去。
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  bundledWhisperAssetsDir,
  defaultWhisperModelsDir,
  resolveWhisperModelsDir,
} from '../src/backend/wechat-data/src/query/whisper.ts'

let passed = 0
/** 断言通过时打一行 ✅（与 rag:check 的输出风格一致）。 */
function ok(cond: unknown, label: string): void {
  assert.ok(cond, label)
  passed += 1
  console.log(`  ✅ ${label}`)
}

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const root = join(repoRoot, '.tmp-whisper-paths-check')
rmSync(root, { recursive: true, force: true })
const decrypted = join(root, 'decrypted')
mkdirSync(decrypted, { recursive: true })

try {
  const bundled = bundledWhisperAssetsDir()
  const expected = join(root, 'whisper')

  console.log('随包资产')
  ok(bundled.endsWith(join('wechat', 'whisper')), `随包资产目录指向 wechat/whisper（${bundled}）`)
  const hasBundledModel = existsSync(join(bundled, 'ggml-tiny.bin'))
  ok(hasBundledModel || existsSync(join(bundled, 'bin', 'whisper-cli.exe')),
    '随包资产里至少有预置模型或引擎（否则镜像无从谈起）')

  console.log('默认目录：数据根下的可写目录')
  ok(defaultWhisperModelsDir(decrypted) === expected, `默认模型目录 == <数据根>/whisper`)

  console.log('随包资产镜像')
  if (hasBundledModel) {
    const src = join(bundled, 'ggml-tiny.bin')
    const dst = join(expected, 'ggml-tiny.bin')
    ok(existsSync(dst), '预置 ggml-tiny.bin 已镜像到可写目录')
    ok(existsSync(join(expected, 'bin', 'whisper-cli.exe')), '引擎 bin/ 已镜像到可写目录')
    if (existsSync(dst)) {
      ok(statSync(dst).size === statSync(src).size,
        `镜像后大小一致（${statSync(dst).size} 字节）`)
    }
    ok(expected !== bundled, '镜像目标不是（只读的）随包资产目录本身')
  } else {
    console.log('  ·  跳过（本地没有预置模型，镜像逻辑与上一条同源）')
  }

  console.log('旧配置里的只读/无效钉法一律忽略')
  ok(resolveWhisperModelsDir(bundled, decrypted) === expected,
    '钉在随包资产目录上的 whisper_models_dir 被忽略，回落可写目录')
  ok(resolveWhisperModelsDir('C:\\App\\resources\\app.asar\\wechat\\whisper', decrypted) === expected,
    '仍落在 app.asar 内的路径被忽略（打包态残留）')
  ok(resolveWhisperModelsDir('   ', decrypted) === expected, '空白配置按未配置处理')

  console.log('用户自定义目录仍然生效')
  const custom = join(root, 'my-models')
  ok(resolveWhisperModelsDir(custom, decrypted) === custom, '自定义模型目录被原样尊重')

  console.log(`\n✅ 断言通过 ${passed} 项`)
} finally {
  rmSync(root, { recursive: true, force: true })
}
