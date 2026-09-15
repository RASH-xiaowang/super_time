/**
 * N6：开发态迁移不得把「数据源 + 密钥」带进新状态目录。
 *
 * 复现的现象：`SUPERTIME_USER_DATA_DIR=<空临时目录>` 启动后，该目录出现**完整真实解密库**
 * （约 282MB）。成因链是迁移原样复制 `wechat/config.json`（带 `db_dir` + `db_enc_key`），
 * 主进程再把它回灌给后端，sync 随即用密钥把真实库解密到新的 `decrypted_dir`。
 *
 * 为什么用夹具而不是本机那份真配置：仓库里的 `wechat/config.json` 已被 gitignore，
 * 干净检出上并不存在 —— 拿它做证据会让用例在 CI 上静默空转（「没有源文件所以没迁移」）。
 * 这里用 fixture 搭出「与真实文件同形状」的老配置，再注入迁移源目录，两个环境都能跑。
 *
 * @vitest-environment node
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
// @ts-expect-error —— 宿主层是 CommonJS，无类型声明
import { configure, sanitizeMigratedConfig } from '../wechat-paths.js'

const scratch: string[] = []
afterEach(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true })
  scratch.length = 0
  vi.restoreAllMocks()
})

const DB_KEY = 'b'.repeat(64)
const IMAGE_AES_KEY = 'f00dfeedcafebabe'
const API_TOKEN = 'tok-n6-secret'

/** 与真实 `wechat/config.json` 同形状的老配置（键名取自本机实测，值全部是假值）。 */
function legacyConfig() {
  return {
    dataRoot: 'D:\\old-machine\\wechat-data',
    decryptedDir: 'D:\\old-machine\\wechat-data\\decrypted',
    decodedImagesDir: 'D:\\old-machine\\wechat-data\\decoded_images',
    sourceDir: 'D:\\old-machine\\import',
    baseDir: 'D:\\Tencent\\xwechat_files\\wxid_abc',
    selfWxid: 'wxid_abc',
    silkBinary: 'D:\\old-machine\\silk.exe',
    resolved: { dataRoot: 'D:\\old-machine\\wechat-data', recordedAt: '2026-09-01T00:00:00.000Z' },
    wechatSettings: {
      db_dir: 'D:\\Tencent\\xwechat_files\\wxid_abc\\db_storage',
      db_enc_key: DB_KEY,
      image_aes_key: IMAGE_AES_KEY,
      image_xor_key: 136,
      api_token: API_TOKEN,
      api_enabled: true,
      api_port: 5033,
      cdn_enabled: false,
      cdn_local_decrypt: true,
      whisper_device: 'cuda',
      whisper_model: 'large-v3',
      whisper_models_dir: 'D:\\old-machine\\whisper',
    },
    wechatSettingsMeta: { savedAt: '2026-09-01T00:00:00.000Z', source: '数据配置·保存配置' },
  }
}

/** 搭一份「老安装目录 + 空 userData」的布局并执行迁移。 */
function migrate(legacy: object | null) {
  const legacyDir = mkdtempSync(join(tmpdir(), 'n6-legacy-'))
  const userData = mkdtempSync(join(tmpdir(), 'n6-userdata-'))
  scratch.push(legacyDir, userData)
  mkdirSync(legacyDir, { recursive: true })
  if (legacy) {
    writeFileSync(join(legacyDir, 'config.json'), JSON.stringify(legacy, null, 2), 'utf8')
    writeFileSync(join(legacyDir, 'llm.json'), JSON.stringify({ model: 'm', apiKey: 'sk-local' }), 'utf8')
  }
  configure({ userDataPath: userData, legacyAssetsDir: legacyDir })
  return {
    userData,
    cfgPath: join(userData, 'wechat', 'config.json'),
    llmPath: join(userData, 'wechat', 'llm.json'),
  }
}

describe('N6：迁移不带数据源与密钥', () => {
  it('sanitizeMigratedConfig 剔除数据源/凭据/派生路径，保留普通开关', () => {
    const { config, dropped } = sanitizeMigratedConfig(legacyConfig())
    expect(config.wechatSettings['api_port']).toBe(5033)
    expect(config.wechatSettings['api_enabled']).toBe(true)
    expect(config.wechatSettings['whisper_model']).toBe('large-v3')
    // 数据源与密钥一律不带走
    for (const k of ['db_dir', 'db_enc_key', 'image_aes_key', 'image_xor_key', 'api_token', 'whisper_models_dir']) {
      expect(Object.keys(config.wechatSettings), `镜像里不应有 ${k}`).not.toContain(k)
      expect(dropped).toContain(`wechatSettings.${k}`)
    }
    // 顶层路径字段一个都不带走（它们指向上一台机器 / 真实数据源）。
    // 断言的是**值**：配置形状仍保留这些键，只是回落成默认空值 —— 把键整个删掉会让
    // 依赖「字段齐全」的下游踩空，而空值本来就是 defaults() 的语义。
    for (const k of ['dataRoot', 'decryptedDir', 'decodedImagesDir', 'sourceDir', 'baseDir', 'selfWxid', 'silkBinary']) {
      expect(config[k], `顶层 ${k} 不应携带旧值`).toBe('')
      expect(dropped).toContain(k)
    }
    expect(config.resolved).toEqual({})
    expect(dropped).toContain('resolved')
  })

  it('sanitizeMigratedConfig 对畸形输入不抛，且不产生假字段', () => {
    expect(() => sanitizeMigratedConfig(null)).not.toThrow()
    expect(sanitizeMigratedConfig(null).config.wechatSettings).toEqual({})
    expect(sanitizeMigratedConfig({ wechatSettings: 'nope' }).config.wechatSettings).toEqual({})
    expect(sanitizeMigratedConfig(42).dropped).toEqual([])
  })

  it('迁移后的 config.json 里没有数据源与密钥（逐字节检查）', () => {
    const { cfgPath } = migrate(legacyConfig())
    expect(existsSync(cfgPath)).toBe(true)
    const text = readFileSync(cfgPath, 'utf8')
    expect(text).not.toContain(DB_KEY)
    expect(text).not.toContain(IMAGE_AES_KEY)
    expect(text).not.toContain(API_TOKEN)
    expect(text).not.toContain('db_dir')
    expect(text).not.toContain('xwechat_files')

    const raw = JSON.parse(text)
    expect(raw.wechatSettings['api_port']).toBe(5033) // 普通设置照旧生效
    expect(raw.dataRoot).toBe('') // 顶层路径回落成默认空值
    expect(raw.decryptedDir).toBe('')
    expect(raw.baseDir).toBe('')
  })

  it('剔除是有痕的：日志说明剔除了什么、并要求重新确认数据源', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    migrate(legacyConfig())
    const text = log.mock.calls.map((c) => c.join(' ')).join('\n')
    expect(text).toContain('wechatSettings.db_dir')
    expect(text).toContain('wechatSettings.db_enc_key')
    expect(text).toContain('重新确认数据源')
  })

  it('llm.json 仍照旧迁移（用户自己的模型配置，与数据源无关）', () => {
    const { llmPath } = migrate(legacyConfig())
    expect(existsSync(llmPath)).toBe(true)
    expect(JSON.parse(readFileSync(llmPath, 'utf8')).model).toBe('m')
  })

  it('已有 config.json 时不覆盖（用户当前状态优先）', () => {
    const legacyDir = mkdtempSync(join(tmpdir(), 'n6-legacy-'))
    const userData = mkdtempSync(join(tmpdir(), 'n6-userdata-'))
    scratch.push(legacyDir, userData)
    writeFileSync(join(legacyDir, 'config.json'), JSON.stringify(legacyConfig()), 'utf8')
    mkdirSync(join(userData, 'wechat'), { recursive: true })
    writeFileSync(join(userData, 'wechat', 'config.json'), JSON.stringify({ dataRoot: 'KEEP' }), 'utf8')
    configure({ userDataPath: userData, legacyAssetsDir: legacyDir })
    expect(JSON.parse(readFileSync(join(userData, 'wechat', 'config.json'), 'utf8')).dataRoot).toBe('KEEP')
  })

  it('没有老配置时不创建任何文件（全新安装不走迁移）', () => {
    const { cfgPath, llmPath } = migrate(null)
    expect(existsSync(cfgPath)).toBe(false)
    expect(existsSync(llmPath)).toBe(false)
  })

  it('老配置损坏时不抛、也不留下半个文件', () => {
    const legacyDir = mkdtempSync(join(tmpdir(), 'n6-legacy-'))
    const userData = mkdtempSync(join(tmpdir(), 'n6-userdata-'))
    scratch.push(legacyDir, userData)
    writeFileSync(join(legacyDir, 'config.json'), '{ 这不是 JSON', 'utf8')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(() => configure({ userDataPath: userData, legacyAssetsDir: legacyDir })).not.toThrow()
    const cfgPath = join(userData, 'wechat', 'config.json')
    expect(existsSync(cfgPath)).toBe(false)
    expect(warn.mock.calls.map((c) => c.join(' ')).join('\n')).toContain('开发态迁移 config.json 失败')
  })
})
