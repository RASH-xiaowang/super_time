/**
 * M1（宿主层）：`config.json` 不再镜像密钥字段。
 *
 * 为什么单独测：宿主层这次改动（`SECRET_SETTING_KEYS` 过滤）原先**零覆盖** ——
 * 全仓库只有本目录的文件引用 `wechat-paths.js`，且没有一条用例碰
 * `recordWechatSettings` / `loadWechatSettings`（复审用变异 m1 实测：去掉过滤全绿）。
 * @vitest-environment node
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
// @ts-expect-error —— 宿主层是 CommonJS，无类型声明
import { configure, loadWechatSettings, mirroredSecretValues, recordWechatSettings } from '../wechat-paths.js'

const scratch: string[] = []
afterEach(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true })
  scratch.length = 0
})

const KEY = 'a'.repeat(64)

/**
 * 每个用例一个独立 userData，并**先写入占位的 config.json / llm.json** 再 `configure()`：
 * 开发态的 `migrateLegacyState()` 会把仓库 `wechat/config.json`（本机那份含真实密钥）
 * 复制进来，既污染断言、又让真实密钥落到临时目录。
 */
function initState(): { cfg: string } {
  const root = mkdtempSync(join(tmpdir(), 'host-settings-'))
  scratch.push(root)
  mkdirSync(join(root, 'wechat'), { recursive: true })
  const cfg = join(root, 'wechat', 'config.json')
  writeFileSync(cfg, '{}', 'utf8')
  writeFileSync(join(root, 'wechat', 'llm.json'), '{}', 'utf8')
  configure({ userDataPath: root })
  return { cfg }
}

describe('M1：宿主 config.json 不再留存密钥镜像', () => {
  it('recordWechatSettings 保存普通字段，但不镜像任何密钥字段', () => {
    const { cfg } = initState()
    recordWechatSettings({ db_dir: 'D:\\Tencent\\x', api_port: 5033, db_enc_key: KEY, api_token: 'tok-1' })
    const raw = JSON.parse(readFileSync(cfg, 'utf8'))
    expect(raw.wechatSettings['db_dir']).toBe('D:\\Tencent\\x')
    expect(raw.wechatSettings['api_port']).toBe(5033)
    expect(Object.keys(raw.wechatSettings)).not.toContain('db_enc_key')
    expect(Object.keys(raw.wechatSettings)).not.toContain('api_token')
    // 逐字节确认：密钥没有以任何形式落进这个文件
    expect(readFileSync(cfg, 'utf8')).not.toContain(KEY)
    expect(readFileSync(cfg, 'utf8')).not.toContain('tok-1')
  })

  it('loadWechatSettings 不回放老安装残留的密钥镜像', () => {
    const { cfg } = initState()
    // 手工构造 M1 之前那版写下的镜像
    writeFileSync(cfg, JSON.stringify({ wechatSettings: { db_dir: 'D:\\wx', db_enc_key: 'legacy-key' } }), 'utf8')
    const s = loadWechatSettings()
    expect(s['db_dir']).toBe('D:\\wx')
    expect('db_enc_key' in s).toBe(false)
  })

  it('recordWechatSettings 是**合并**：内部的部分保存不会抹掉镜像里已有的普通设置', () => {
    // 主进程会在启动期用部分 patch 调 saveWechatConfig（旧密钥搬迁、空 patch 保存），
    // 整体替换语义会把镜像里的 db_dir/api_port 一起抹掉 —— 实测踩过两次。
    const { cfg } = initState()
    recordWechatSettings({ db_dir: 'D:\\wx', api_port: 5099 })
    recordWechatSettings({ db_enc_key: KEY }) // 只带密钥的内部保存
    recordWechatSettings({}) // 空 patch 的内部保存
    const raw = JSON.parse(readFileSync(cfg, 'utf8'))
    expect(raw.wechatSettings['db_dir']).toBe('D:\\wx')
    expect(raw.wechatSettings['api_port']).toBe(5099)
    expect(readFileSync(cfg, 'utf8')).not.toContain(KEY)
  })

  it('recordWechatSettings 合并时会顺手清掉镜像里残留的密钥（老安装自愈）', () => {
    const { cfg } = initState()
    writeFileSync(cfg, JSON.stringify({ wechatSettings: { db_dir: 'D:\\wx', db_enc_key: KEY } }), 'utf8')
    recordWechatSettings({ api_port: 5099 })
    const raw = JSON.parse(readFileSync(cfg, 'utf8'))
    expect(raw.wechatSettings['db_dir']).toBe('D:\\wx') // 既有普通字段保住（合并）
    expect(raw.wechatSettings['api_port']).toBe(5099) // 新字段进来
    expect(Object.keys(raw.wechatSettings)).not.toContain('db_enc_key') // 残留密钥清掉
    expect(readFileSync(cfg, 'utf8')).not.toContain(KEY)
  })

  it('mirroredSecretValues 只读地取出镜像里的密钥（回灌时要把它们并进 patch）', () => {
    const { cfg } = initState()
    writeFileSync(cfg, JSON.stringify({
      wechatSettings: { db_dir: 'D:\\wx', db_enc_key: KEY, image_aes_key: 'e57c869f15dd8764', api_token: '', whisper_bin: 'x' },
    }), 'utf8')
    const secrets = mirroredSecretValues()
    expect(secrets['db_enc_key']).toBe(KEY)
    expect(secrets['image_aes_key']).toBe('e57c869f15dd8764')
    // 空串不进 RPC 字段（后端还会再按「是否有意义」筛一次）
    expect('api_token' in secrets).toBe(false)
    // 纯读取：文件一字未动
    expect(JSON.parse(readFileSync(cfg, 'utf8')).wechatSettings['db_enc_key']).toBe(KEY)
  })

  it('mirroredSecretValues 在镜像缺密钥/缺 wechatSettings 时返回空对象且不抛', () => {
    const { cfg } = initState()
    writeFileSync(cfg, JSON.stringify({ wechatSettings: { db_dir: 'D:\\wx' } }), 'utf8')
    expect(mirroredSecretValues()).toEqual({})
    writeFileSync(cfg, JSON.stringify({ dataRoot: 'D:\\x' }), 'utf8')
    expect(() => mirroredSecretValues()).not.toThrow()
    expect(mirroredSecretValues()).toEqual({})
  })
})
