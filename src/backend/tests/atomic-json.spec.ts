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

    /**
     * 「原子写」的真实判别器（确定性，不靠采样）。
     *
     * 复审指出：只断言「内容正确、无 .tmp- 残留」在 happy path 上与直接 writeFileSync
     * 完全一致，测不出机制是否存在。而采样型跨进程判据在本机负载下会抖（未变异代码
     * 10 跑 4 红）。这里改用一个确定事实：**tmp+rename 会换掉目标的文件 ID**，
     * 原地 writeFileSync 则复用同一个文件 ID。
     *
     * 边界说明：这条依赖文件系统**提供有意义的 ino**（NTFS / ext4 都提供）。若某个文件系统
     * 恒返回 0，本用例会**变红**（`0 !== 0` 不成立）而不是假绿 —— 即失败方向是「保守报错」，
     * 可以接受。`copyFileSync` 之类「原地覆盖」的做法同样会被它抓出来（ino 不变）。
     */
    it(`${impl.name}：覆盖是「替换」而不是「原地改写」（文件 ID 变化）`, () => {
      const p = join(tempRoot(), 'config.json')
      impl.write(p, '{"v":1}')
      const before = statSync(p).ino
      impl.write(p, '{"v":2}')
      expect(JSON.parse(readFileSync(p, 'utf8'))).toEqual({ v: 2 })
      expect(statSync(p).ino, 'tmp+rename 应当产生新的文件 ID').not.toBe(before)
    })

    it(`${impl.name}：对照 —— 原地 writeFileSync 的文件 ID 不变（证明上条有判别力）`, () => {
      const p = join(tempRoot(), 'config.json')
      writeFileSync(p, '{"v":1}')
      const before = statSync(p).ino
      writeFileSync(p, '{"v":2}')
      expect(statSync(p).ino).toBe(before)
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
    const child = spawn(process.execPath, [writer, target, payloadFile], { stdio: ['ignore', 'pipe', 'pipe'] })
    let childErr = ''
    child.stderr.on('data', (d) => { childErr += String(d) })

    let torn = 0
    // 先确定性地采一次「旧内容」：否则子进程可能在第一次轮询前就写完了，
    // 断言会退化成「一次样本都没有」的空转（实测确实抖过）。
    let sawOld = 0
    // 「写入确实经过同目录临时文件」的探针。为什么必须有它：`torn` 与「文件 ID 变化」
    // 都挡不住一类**语义上非原子**的实现 —— 先把目标改名挪走、再原地写一份新的
    // （目标会瞬时消失、新内容可能被读到一半），它的文件 ID 必然变化、也不会被采样到
    // 中间尺寸，但**永远不会出现 `.tmp-` 文件**。复审实测这类实现下原先两条判据 10 跑 0 红。
    let sawTmp = 0
    if (statSync(target).size === old) sawOld += 1
    while (child.exitCode === null) {
      try {
        const n = statSync(target).size
        if (n === old) sawOld += 1
        // 只把「存在但既不是旧内容也不是完整新内容」算作写了一半（含被截断成 0）。
        // **目标短暂不可见不计**：rename 替换目标时名字可能瞬间消失，那是另一种性质；
        // 把它算进去会让这条用例在负载下抖（复审实测未变异代码 10 跑 4 红）。
        else if (n !== full) torn += 1
      } catch { /* 目标瞬时不可见：不计 */ }
      try {
        if (readdirSync(dir).some((f) => f.includes('.tmp-'))) sawTmp += 1
      } catch { /* 列目录失败不影响主判据 */ }
      await new Promise<void>((resolve) => { setImmediate(resolve) })
    }

    // 子进程必须真的写成功：否则下面的断言会以「内容还是旧值」的形式失败，红因误导。
    expect(child.exitCode, '子进程退出码（stderr: ' + childErr.slice(0, 300) + '）').toBe(0)
    expect(torn).toBe(0)
    // 防止「一次样本都没采到」的空转：`sawOld` 在循环前被确定性地置过一次（见上面的预采样）。
    // 不要写 `expect(sawFull + 1).toBeGreaterThan(0)` 这种恒真式 —— 复审指出它起不到守卫作用。
    expect(sawOld).toBeGreaterThan(0)
    expect(sawTmp, '写入必须出现同目录临时文件（tmp+rename 的判别）').toBeGreaterThan(0)
    expect(readFileSync(target, 'utf8')).toHaveLength(full)
  }, 30_000)
})

describe('M1：密钥不再写在 config.json 里', () => {
  const SECRET = { db_enc_key: 'a'.repeat(64), image_aes_key: '***REMOVED-SECRET***' }

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

describe('M1 复审后的边界：不固化默认值、不静默清空、损坏留痕', () => {
  it('只保存普通字段时，不会把默认值（空串 / 136）固化进 secrets.json', () => {
    const root = tempRoot()
    const decrypted = join(root, 'decrypted')
    saveConfig(decrypted, { db_dir: 'D:\\\\wx' }) // 完全没提密钥字段
    // 不该凭空造出 secrets.json（否则 secrets 永远有值 → config.json 的手工修改被永久忽略）
    expect(existsSync(join(root, 'secrets.json'))).toBe(false)
  })

  it('secrets.json 里没有的密钥字段，仍以 config.json 的手工修改为准', () => {
    const root = tempRoot()
    const decrypted = join(root, 'decrypted')
    saveConfig(decrypted, { db_dir: 'D:\\\\wx' })            // 不产生 secrets.json
    // 用户手工改 config.json 的 image_xor_key
    const cfgFile = join(root, 'config.json')
    const cfg = JSON.parse(readFileSync(cfgFile, 'utf8'))
    cfg['image_xor_key'] = 60
    writeFileSync(cfgFile, JSON.stringify(cfg), 'utf8')
    expect(getConfig(decrypted)['image_xor_key']).toBe(60)   // 手工修改生效
  })

  it('用户显式保存过的密钥字段，secrets.json 优先', () => {
    const root = tempRoot()
    const decrypted = join(root, 'decrypted')
    saveConfig(decrypted, { image_aes_key: '***REMOVED-SECRET***' })
    expect(getConfig(decrypted)['image_aes_key']).toBe('***REMOVED-SECRET***')
  })

  it('合并语义：patch 只带一个密钥字段时，secrets.json 里其它密钥不被抹掉', () => {
    // 变异「secrets 整体覆盖（丢合并）」原先一条都不红 —— 这条是它的判别器。
    const root = tempRoot()
    const decrypted = join(root, 'decrypted')
    saveConfig(decrypted, { db_enc_key: 'a'.repeat(64) })
    saveConfig(decrypted, { image_aes_key: '***REMOVED-SECRET***' })
    const secrets = JSON.parse(readFileSync(join(root, 'secrets.json'), 'utf8'))
    expect(secrets['db_enc_key']).toBe('a'.repeat(64))
    expect(secrets['image_aes_key']).toBe('***REMOVED-SECRET***')
  })

  it('secrets.json 里的空串不算「有值」，仍回退到 config.json', () => {
    // 变异「空串也算有值（不再回退）」原先全绿 —— 这条是它的判别器。
    const root = tempRoot()
    const decrypted = join(root, 'decrypted')
    writeFileSync(join(root, 'secrets.json'), JSON.stringify({ db_enc_key: '' }), 'utf8')
    writeFileSync(join(root, 'config.json'), JSON.stringify({ db_dir: 'D:\\\\wx', db_enc_key: 'manual-key' }), 'utf8')
    expect(getConfig(decrypted)['db_enc_key']).toBe('manual-key')
  })

  it('secrets.json 也是「替换」写入（文件 ID 变化），不是原地改写', () => {    const root = tempRoot()
    const decrypted = join(root, 'decrypted')
    saveConfig(decrypted, { db_enc_key: 'a'.repeat(64) })
    const secretsFile = join(root, 'secrets.json')
    const before = statSync(secretsFile).ino
    saveConfig(decrypted, { db_enc_key: 'b'.repeat(64) })
    expect(JSON.parse(readFileSync(secretsFile, 'utf8'))['db_enc_key']).toBe('b'.repeat(64))
    expect(statSync(secretsFile).ino, '密钥文件也必须走 tmp+rename').not.toBe(before)
  })

  it('secrets.json 损坏 + config.json 里还有真密钥 → 救回并写进 secrets.json', () => {
    // 这条是我自己第二轮改出来的**回归**：加「损坏就不写」的条件后，`carried`
    // （从 config.json 读出来的真值）也被一起挡掉，而后面已经执行了
    // `delete current[field]` —— 结果密钥从 config.json 被抹掉、又没落进 secrets.json，
    // 净丢失。真值来源有两个（显式 patch / config.json 未迁移值），有任一个就必须写。
    const root = tempRoot()
    const decrypted = join(root, 'decrypted')
    const key = 'a'.repeat(64)
    writeFileSync(join(root, 'config.json'), JSON.stringify({ db_dir: 'D:\\\\wx', db_enc_key: key }), 'utf8')
    writeFileSync(join(root, 'secrets.json'), '{ broken', 'utf8')

    const res = saveConfig(decrypted, { api_port: 5033 })
    expect(res.ok).toBe(true)
    expect(JSON.parse(readFileSync(join(root, 'secrets.json'), 'utf8'))['db_enc_key']).toBe(key)
    // 损坏原文要先留痕，不能无声覆盖
    const backups = readdirSync(root).filter((f) => f.startsWith('secrets.json.corrupt-'))
    expect(backups).toHaveLength(1)
    expect(readFileSync(join(root, backups[0]), 'utf8')).toBe('{ broken')
    expect(readFileSync(join(root, 'config.json'), 'utf8')).not.toContain(key)
    expect(getConfig(decrypted)['db_enc_key']).toBe(key)
  })

  it('secrets.json 损坏 + 无处可救 → 不写（保住原文），config.json 也不留字段', () => {
    // 与上一条配对：手上真的没有真值时才拒写。此时 config.json 本来就没有密钥字段，
    // 所以「不写」不会造成丢失；损坏原文留在原地、还有救回机会。
    const root = tempRoot()
    const decrypted = join(root, 'decrypted')
    const broken = '{"db_enc_key":"aaaaaaaa'
    writeFileSync(join(root, 'secrets.json'), broken, 'utf8')
    writeFileSync(join(root, 'config.json'), JSON.stringify({ db_dir: 'D:\\\\wx' }), 'utf8')

    expect(saveConfig(decrypted, { api_port: 5033 }).ok).toBe(true)
    expect(readFileSync(join(root, 'secrets.json'), 'utf8')).toBe(broken)
    expect(readdirSync(root).filter((f) => f.startsWith('secrets.json.corrupt-'))).toHaveLength(0)
  })

  it('secrets.json 损坏时：保存普通字段不会清空它，原文保留', () => {
    const root = tempRoot()
    const decrypted = join(root, 'decrypted')
    saveConfig(decrypted, { db_enc_key: 'a'.repeat(64) })
    const secretsFile = join(root, 'secrets.json')
    const broken = '{"db_enc_key":"aaaaaaaa' // 截断
    writeFileSync(secretsFile, broken, 'utf8')

    const res = saveConfig(decrypted, { api_port: 5033 }) // 只改普通字段
    expect(res.ok).toBe(true)
    // 关键：损坏原文仍在（没有被默认值覆盖掉），也就还有救回来的机会
    expect(readFileSync(secretsFile, 'utf8')).toBe(broken)
    expect(readdirSync(root).filter((f) => f.startsWith('secrets.json.corrupt-'))).toHaveLength(0)
  })

  it('secrets.json 损坏 + 用户重新填写密钥 → 覆盖前先把损坏原文留痕', () => {
    const root = tempRoot()
    const decrypted = join(root, 'decrypted')
    saveConfig(decrypted, { db_enc_key: 'a'.repeat(64) })
    const secretsFile = join(root, 'secrets.json')
    writeFileSync(secretsFile, '{ broken', 'utf8')

    saveConfig(decrypted, { db_enc_key: 'b'.repeat(64) }) // 显式重新填写
    expect(JSON.parse(readFileSync(secretsFile, 'utf8'))['db_enc_key']).toBe('b'.repeat(64))
    const backups = readdirSync(root).filter((f) => f.startsWith('secrets.json.corrupt-'))
    expect(backups).toHaveLength(1)
    expect(readFileSync(join(root, backups[0]), 'utf8')).toBe('{ broken')
  })

  it('patch 里全是空串/默认值（界面未加载完就点保存）时，secrets.json 一字不动', () => {
    // 这是第二轮复审的 C1：`Settings.tsx` 的保存按钮在配置还没读回来时也能点，
    // 而它**无条件**把 4 个密钥字段放进 patch（未加载时是 '' 与 136）。把「显式空串」
    // 当成「用户要清空」就会把真密钥整体抹成空值 —— 原文件是合法 JSON，连备份都没有。
    // 下面的 patch 逐字照抄 `Settings.tsx` 的 save()。
    const root = tempRoot()
    const decrypted = join(root, 'decrypted')
    const dbKey = 'a'.repeat(64)
    saveConfig(decrypted, { db_enc_key: dbKey, image_aes_key: '***REMOVED-SECRET***', api_token: 'tok-real' })
    const secretsFile = join(root, 'secrets.json')
    const before = readFileSync(secretsFile, 'utf8')

    const res = saveConfig(decrypted, {
      db_dir: '', db_enc_key: '', image_aes_key: '', image_xor_key: 136, api_enabled: true,
      api_token: '', api_port: 5032, cdn_enabled: true, cdn_local_decrypt: true,
      whisper_device: 'cpu', whisper_model: 'medium', whisper_threads: 0, whisper_models_dir: '',
    })
    expect(res.ok).toBe(true)
    expect(readFileSync(secretsFile, 'utf8')).toBe(before) // 一字未动（连重写都没有）
    const cfgNow = getConfig(decrypted)
    expect(cfgNow['db_enc_key']).toBe(dbKey)
    expect(cfgNow['image_aes_key']).toBe('***REMOVED-SECRET***')
    expect(cfgNow['api_token']).toBe('tok-real')
  })

  it('升级安装：默认值 image_xor_key:136 不会被钉进 secrets.json，config.json 的手工修改仍有效', () => {
    // 第二轮复审的 M1：老版本会把默认值一起写进 config.json，若把它当成真值搬到 secrets，
    // `getConfig` 的「secrets 优先」就会让 config.json 里对它的手工修改**永久失效**
    // （复审实测：钉住 136 之后手工改成 60，读回来还是 136）。
    const root = tempRoot()
    const decrypted = join(root, 'decrypted')
    const dbKey = 'a'.repeat(64)
    writeFileSync(join(root, 'config.json'), JSON.stringify({ db_dir: 'D:\\\\wx', db_enc_key: dbKey, image_xor_key: 136 }), 'utf8')

    saveConfig(decrypted, {}) // 任意一次保存（空的 patch 也算）
    const secrets = JSON.parse(readFileSync(join(root, 'secrets.json'), 'utf8'))
    expect(secrets['db_enc_key']).toBe(dbKey) // 真密钥照常搬迁
    expect('image_xor_key' in secrets).toBe(false) // 默认值不搬
    // config.json 里恒不留密钥字段（否则默认值 136 会被落盘，启动期的「还有旧密钥吗」
    // 判据每次都误判为真，多跑一次空 patch 保存并顺带抹掉宿主镜像里的普通设置）
    expect(readFileSync(join(root, 'config.json'), 'utf8')).not.toContain('image_xor_key')
    expect(getConfig(decrypted)['image_xor_key']).toBe(136) // 缺字段时由内置默认兜住

    // 手工在 config.json 里加回 60 → 立刻生效（这条路径仍然可用，只是会被下一次保存采纳）
    const cfgFile = join(root, 'config.json')
    const raw = JSON.parse(readFileSync(cfgFile, 'utf8'))
    raw['image_xor_key'] = 60
    writeFileSync(cfgFile, JSON.stringify(raw), 'utf8')
    expect(getConfig(decrypted)['image_xor_key']).toBe(60)
  })

  it('secrets.json 里遗留的默认值不压住 config.json 的真值（老版本钉住状态的自愈）', () => {
    // 第一版 M1 会把默认值写进 secrets.json（复审实测过）。读回时若仍按「secrets 非空优先」，
    // 那个 136 就会永久压住用户在 config.json 里填的 60。
    const root = tempRoot()
    const decrypted = join(root, 'decrypted')
    writeFileSync(join(root, 'secrets.json'), JSON.stringify({ image_xor_key: 136 }), 'utf8')
    writeFileSync(join(root, 'config.json'), JSON.stringify({ db_dir: 'D:\\\\wx', image_xor_key: 60 }), 'utf8')
    expect(getConfig(decrypted)['image_xor_key']).toBe(60)
  })

  it('非默认的 image_xor_key 仍会被正常搬迁（上一条不是「永远不搬」）', () => {    const root = tempRoot()
    const decrypted = join(root, 'decrypted')
    writeFileSync(join(root, 'config.json'), JSON.stringify({ db_dir: 'D:\\\\wx', image_xor_key: 60 }), 'utf8')
    saveConfig(decrypted, {})
    expect(JSON.parse(readFileSync(join(root, 'secrets.json'), 'utf8'))['image_xor_key']).toBe(60)
    expect(readFileSync(join(root, 'config.json'), 'utf8')).not.toContain('image_xor_key')
    expect(getConfig(decrypted)['image_xor_key']).toBe(60)
  })
})

describe('写入对瞬态句柄占用的韧性', () => {
  it('目标被别的进程短暂占用时会重试成功（一次占用不该让保存失败）', async () => {
    const dir = tempRoot()
    const target = join(dir, 'config.json')
    writeFileSync(target, 'OLD')
    // 子进程先持有句柄 40ms 再释放；父进程的重试窗口是 5×20ms —— 应当等到释放后成功。
    // 用子进程而不是本进程的 setTimeout：写路径里的同步小睡会阻塞本进程的定时器。
    const holder = spawn(process.execPath, ['-e', `
      const fs = require('node:fs');
      const fd = fs.openSync(process.argv[1], 'r');
      setTimeout(() => { fs.closeSync(fd); }, 40);
      setTimeout(() => process.exit(0), 200);
    `, target], { stdio: 'ignore' })
    await new Promise<void>((resolve) => { setTimeout(resolve, 10) }) // 让子进程先把句柄拿到

    expect(() => tsWrite(target, 'NEW')).not.toThrow()
    expect(readFileSync(target, 'utf8')).toBe('NEW')
    holder.kill()
  })
})