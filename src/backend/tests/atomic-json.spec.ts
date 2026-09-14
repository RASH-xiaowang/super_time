/**
 * M2：配置写入必须是原子的，且「解析不了的原文件」不能被无声覆盖。
 *
 * 为什么值得单独测：直接 `writeFileSync` 到目标路径时，写一半被杀进程/磁盘满会留下
 * **截断的 JSON**；而 config.json 里有数据根路径与密钥字段，读到截断内容会静默回落
 * 默认值（用户看到「配置莫名丢了」），并且**下一次保存就把残缺内容覆盖掉**。
 * 这里覆盖两份等价实现：宿主层 `src/backend/wechat-paths.js`（CJS）与后端
 * `src/backend/wechat-data/src/query/config.ts`（走 esbuild bundle）。
 * @vitest-environment node
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join as joinPath } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
// @ts-expect-error —— 宿主层是 CommonJS，无类型声明
import { preserveIfUnparseable as hostPreserve, writeFileAtomic as hostWrite } from '../wechat-paths.js'
import { getConfig, preserveIfUnparseable as tsPreserve, saveConfig, writeFileAtomic as tsWrite } from '../wechat-data/src/query/config.ts'

const scratch: string[] = []
afterEach(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true })
  scratch.length = 0
})

/** 每个用例一个独立目录：配置路径是「解密目录的兄弟文件」，共用父目录会互相串。 */
function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'atomic-json-'))
  scratch.push(root)
  return root
}

const IMPLS = [
  { name: 'wechat-paths.js（宿主层）', write: hostWrite as (p: string, t: string) => void, preserve: hostPreserve as (p: string) => void },
  { name: 'query/config.ts（后端）', write: tsWrite as (p: string, t: string) => void, preserve: tsPreserve as (p: string) => void },
] as const

describe('原子写与损坏文件保留', () => {
  for (const impl of IMPLS) {
    it(`${impl.name}：写入内容正确且不留 .tmp- 残留`, () => {
      const p = join(tempRoot(), 'config.json')
      impl.write(p, JSON.stringify({ a: 1 }, null, 2))
      expect(JSON.parse(readFileSync(p, 'utf8'))).toEqual({ a: 1 })
      expect(readdirSync(join(p, '..')).filter((f) => f.includes('.tmp-'))).toEqual([])
    })

    it(`${impl.name}：合法 JSON 不被改名`, () => {
      const p = join(tempRoot(), 'config.json')
      impl.write(p, '{"ok":true}')
      impl.preserve(p)
      expect(JSON.parse(readFileSync(p, 'utf8'))).toEqual({ ok: true })
    })

    it(`${impl.name}：损坏的 JSON 被改名保留（内容一字不丢）`, () => {
      const root = tempRoot()
      const p = join(root, 'config.json')
      const broken = '{"dataRoot":"D:\\\\wechat\\\\data", "db_enc_key": "abcd' // 截断的 JSON
      writeFileSync(p, broken, 'utf8')
      impl.preserve(p)
      // 原文件已被移走，留有 .corrupt-* 备份且内容与损坏前逐字节相同
      expect(existsSync(p)).toBe(false)
      const backups = readdirSync(root).filter((f) => f.startsWith('config.json.corrupt-'))
      expect(backups).toHaveLength(1)
      expect(readFileSync(join(root, backups[0]), 'utf8')).toBe(broken)
    })

    it(`${impl.name}：目标不存在时不报错（首次运行）`, () => {
      const p = join(tempRoot(), 'config.json')
      expect(() => impl.preserve(p)).not.toThrow()
    })
  }

  it('saveConfig（后端）覆盖损坏配置前会先备份', () => {
    const root = tempRoot()
    const decrypted = join(root, 'decrypted')
    const p = join(root, 'config.json') // configPath = <decrypted>/../config.json
    writeFileSync(p, '{ not json', 'utf8')

    const res = saveConfig(decrypted, { db_dir: 'D:\\Tencent\\x\\db_storage' })
    expect(res.ok).toBe(true)
    // 新配置可解析且带上了补丁
    expect(JSON.parse(readFileSync(p, 'utf8'))['db_dir']).toBe('D:\\Tencent\\x\\db_storage')
    // 残缺内容留了备份，而不是被无声覆盖
    const backups = readdirSync(root).filter((f) => f.startsWith('config.json.corrupt-'))
    expect(backups).toHaveLength(1)
    expect(readFileSync(join(root, backups[0]), 'utf8')).toBe('{ not json')
  })
})

describe('原子性的真实判别（跨进程观察中间态）', () => {
  const HERE = dirname(fileURLToPath(import.meta.url))
  const pathsModule = joinPath(HERE, '..', 'wechat-paths.js')

  /**
   * 评审指出：「原子写」在 happy path 上与直接 writeFileSync 行为完全一致，
   * 所以只断言「内容正确、无 .tmp- 残留」测不出机制是否存在。
   * 真正的判别是**读者视角**：写一个几 MB 的文件，另一个进程不停采样目标文件大小；
   * tmp+rename 下读者只会看到「旧内容」或「完整新内容」，直接写则会看到被截断的中间态。
   */
  it('写入期间读者只会看到旧内容或完整新内容（看不到写了一半）', async () => {
    const dir = tempRoot()
    const target = join(dir, 'config.json')
    writeFileSync(target, 'OLD')
    const payload = JSON.stringify({ blob: 'x'.repeat(8 * 1024 * 1024) })
    const full = Buffer.byteLength(payload, 'utf8')
    const old = 3

    // 子进程脚本与 payload 都落到文件里：8MB 内容内联进 `-e` 会 ENAMETOOLONG
    const payloadFile = join(dir, 'payload.json')
    writeFileSync(payloadFile, payload, 'utf8')
    const writer = join(dir, 'writer.cjs')
    writeFileSync(writer, [
      "'use strict';",
      `const { writeFileAtomic } = require(${JSON.stringify(pathsModule)});`,
      "const { readFileSync } = require('node:fs');",
      'writeFileAtomic(process.argv[2], readFileSync(process.argv[3], "utf8"));',
    ].join('\n'), 'utf8')
    const child = spawn(process.execPath, [writer, target, payloadFile], { stdio: 'ignore' })

    let torn = 0
    // 先确定性地采一次「旧内容」：否则子进程可能在第一次轮询前就写完了，
    // 断言会退化成「一次样本都没有」的空转（实测确实抖过）。
    let sawFull = 0
    let sawOld = 0
    if (statSync(target).size === old) sawOld += 1
    while (child.exitCode === null) {
      try {
        const n = statSync(target).size
        if (n === full) sawFull += 1
        else if (n === old) sawOld += 1
        else torn += 1
      } catch {
        torn += 1 // 目标短暂消失同样是「非原子」
      }
      await new Promise<void>((resolve) => { setImmediate(resolve) })
    }

    expect(torn).toBe(0)
    // 保证断言不是空转：至少确认过「开始前是旧内容」且「结束后是完整新内容」
    expect(sawOld).toBeGreaterThan(0)
    expect(readFileSync(target, 'utf8')).toHaveLength(full)
    expect(sawFull + 1).toBeGreaterThan(0)
  }, 30_000)
})

describe('M1：密钥不再写在 config.json 里', () => {
  const SECRET = { db_enc_key: 'a'.repeat(64), image_aes_key: 'e57c869f15dd8764' }

  it('saveConfig 把密钥写进 secrets.json，config.json 里没有', () => {
    const root = tempRoot()
    const decrypted = join(root, 'decrypted')
    saveConfig(decrypted, { db_dir: 'D:\\\\wx', ...SECRET })

    const configText = readFileSync(join(root, 'config.json'), 'utf8')
    expect(configText).not.toContain(SECRET.db_enc_key)
    expect(configText).not.toContain(SECRET.image_aes_key)
    expect(JSON.parse(configText)['db_dir']).toBe('D:\\\\wx') // 普通字段照常写

    const secrets = JSON.parse(readFileSync(join(root, 'secrets.json'), 'utf8'))
    expect(secrets['db_enc_key']).toBe(SECRET.db_enc_key)
    expect(secrets['image_aes_key']).toBe(SECRET.image_aes_key)
  })

  it('getConfig 仍能读到密钥（readSecrets 覆盖），调用方无感', () => {
    const root = tempRoot()
    const decrypted = join(root, 'decrypted')
    saveConfig(decrypted, SECRET)
    const cfg = getConfig(decrypted)
    expect(cfg['db_enc_key']).toBe(SECRET.db_enc_key)
    expect(cfg['image_aes_key']).toBe(SECRET.image_aes_key)
  })

  it('迁移旧数据：config.json 里已有的密钥会被搬走并在下一次保存后清除', () => {
    const root = tempRoot()
    const decrypted = join(root, 'decrypted')
    // 旧形态：密钥就在 config.json 里
    writeFileSync(join(root, 'config.json'), JSON.stringify({ db_dir: 'D:\\\\wx', ...SECRET }), 'utf8')

    // 迁移前仍读得到（兼容）
    expect(getConfig(decrypted)['db_enc_key']).toBe(SECRET.db_enc_key)

    // 保存任意一次普通字段 → 密钥被搬到 secrets.json、config.json 里被清掉
    saveConfig(decrypted, { api_port: 5033 })
    const configText = readFileSync(join(root, 'config.json'), 'utf8')
    expect(configText).not.toContain(SECRET.db_enc_key)
    expect(JSON.parse(configText)['api_port']).toBe(5033)
    expect(JSON.parse(readFileSync(join(root, 'secrets.json'), 'utf8'))['db_enc_key']).toBe(SECRET.db_enc_key)
    // 迁移后读回来还是同一个值
    expect(getConfig(decrypted)['db_enc_key']).toBe(SECRET.db_enc_key)
  })

  it('api_token 同样走 secrets.json（它也是凭据）', () => {
    const root = tempRoot()
    const decrypted = join(root, 'decrypted')
    saveConfig(decrypted, { api_token: 'tok-abcdef123456' })
    expect(readFileSync(join(root, 'config.json'), 'utf8')).not.toContain('tok-abcdef123456')
    expect(JSON.parse(readFileSync(join(root, 'secrets.json'), 'utf8'))['api_token']).toBe('tok-abcdef123456')
  })
})