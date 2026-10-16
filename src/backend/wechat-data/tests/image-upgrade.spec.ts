/**
 * 「升级解码缓存」：把老缓存里由低档 `.dat` 解出的图重解成本机最好的那一份。
 *
 * 这条链上最容易坏、又坏得静默的五件事：
 *   ① **判据是「严格更大」**，所以「不降级」与「幂等」都是它的推论 —— 一旦有人把它改成
 *      「有源就写」，第二次跑会把 CDN 取回的原图覆盖成本机那份较小的，而且没人会报错；
 *   ② 老缓存里的那份**可能出现在两个槽位**（全局 `<decoded>/<md5>.<ext>` 与
 *      `<decoded>/<username>/<md5>.<ext>`）—— 只升级其中一个，另一条读图路径仍然是糊的；
 *   ③ `remote-images/` 里的文件名**同样是 32 位十六进制**（它是 url 的 md5）——
 *      不排除就会把一堆本机根本没有 `.dat` 的条目算进待升级集合，界面上的数字全是假的；
 *   ④ `.hevc` 占位**不参与**「现存最好」的门槛（它不可渲染），但升级成功时**要被清掉** ——
 *      留着它，`decodeImageDataUrl` 在转码不可用时仍然会因它早退；
 *   ⑤ `_h` 解不开时要**退回**聊天版，而不是整条判失败（与逐条读图的档位回退同构）。
 *
 * 用例全部用**自己的临时目录**（`mkdtempSync`），绝不往仓库里写东西。
 * @vitest-environment node
 */
import { createCipheriv } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { at } from '../../tests/helpers/strict-index.ts'
import { upgradeDecodedImageCache } from '../src/query/image-upgrade.ts'

const HERE = dirname(fileURLToPath(import.meta.url))

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) { try { rmSync(d, { recursive: true, force: true }) } catch { /* 已删 */ } }
})

/** V2 魔数（与实现里的常量一致；这里显式写出来，免得改实现时两边一起动而没被发现）。 */
const V2_MAGIC = [0x07, 0x08, 0x56, 0x32, 0x08, 0x07]
const AES_KEY = 'f3aa7c698e166e83'
const XOR_KEY = 0x88

/** 造一份真实布局的 V2 `.dat`（与 `wxam-image.spec.ts` 同款夹具，保持两处一致）。 */
function makeV2Dat(plain: Buffer, aesKey: string, xorKey: number): Uint8Array {
  const aesSize = 1024
  const head = Buffer.alloc(aesSize + 16, 0)
  plain.subarray(0, aesSize).copy(head)
  head.fill(0x10, aesSize) // 合法 PKCS7 填充（16 字节全 0x10）
  const cipher = createCipheriv('aes-128-ecb', Buffer.from(aesKey, 'ascii'), null)
  cipher.setAutoPadding(false)
  const ct = Buffer.concat([cipher.update(head), cipher.final()])
  const tailPlain = plain.subarray(aesSize)
  const tail = Buffer.from(tailPlain).map(b => b ^ xorKey)
  const meta = Buffer.alloc(15)
  V2_MAGIC.forEach((b, i) => { meta[i] = b })
  meta.writeUInt32LE(aesSize, 6)
  meta.writeUInt32LE(tail.length, 10)
  meta[14] = 0x01
  return Buffer.concat([meta, ct, tail])
}

/**
 * 一段可渲染的 PNG：魔数 + `body` 个填充字节。
 * 长度必须 **> 1024**（V2 的 AES 段是固定 1024 字节的头，夹具太短就不真实）；
 * 解码产物长度与它**逐字节相等**，所以「谁更大」可以直接用这里的 `body` 比。
 */
function png(tag: number, body = 1200): Buffer {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(body, tag),
  ])
}

/** 一段 wxgf 载荷（魔数 + 填充），够 `decodeDatBytes` 认出 wxgf。 */
function wxgfPayload(body = 1200): Buffer {
  const b = Buffer.alloc(body, 0x5a)
  b.write('wxgf', 0, 'latin1')
  return b
}

const ORIGINAL_MD5 = 'a'.repeat(32)

/**
 * 一次造好「微信原始目录 + 解码缓存目录」。
 * @param opts.cached - `md5 → 写进哪个槽位的字节`（键形如 `<md5>` / `<md5>.t` / `<user>/<md5>`）。
 * @param opts.dats - `md5 → 写进 msg/attach 的档位文件`（键形如 `<md5>_h` / `<md5>` / `<md5>_t`）。
 */
function fixture(opts: {
  cached?: Record<string, Buffer>
  dats?: Record<string, Buffer>
  hevc?: string[]
}): { root: string; decoded: string; img: string } {
  const root = mkdtempSync(join(tmpdir(), 'upg-raw-'))
  const decoded = mkdtempSync(join(tmpdir(), 'upg-out-'))
  dirs.push(root, decoded)
  const img = join(root, 'msg', 'attach', 'd0f5b6b1c8a94f0e9b7c3a1d2e4f6a8b', '2026-03', 'Img')
  mkdirSync(img, { recursive: true })
  for (const [key, plain] of Object.entries(opts.dats ?? {})) {
    writeFileSync(join(img, key + '.dat'), makeV2Dat(plain, AES_KEY, XOR_KEY))
  }
  for (const [key, bytes] of Object.entries(opts.cached ?? {})) {
    const slash = key.lastIndexOf('/')
    const dir = slash < 0 ? decoded : join(decoded, key.slice(0, slash))
    mkdirSync(dir, { recursive: true })
    const name = slash < 0 ? key : key.slice(slash + 1)
    // 槽位后缀写进文件名：`<md5>|t` = 缩略槽，`<md5>` = 主槽
    const [md5, slot] = name.split('|')
    writeFileSync(join(dir, md5 + (slot === 't' ? '.t' : '') + '.png'), bytes)
  }
  for (const key of opts.hevc ?? []) {
    const slash = key.lastIndexOf('/')
    const dir = slash < 0 ? decoded : join(decoded, key.slice(0, slash))
    mkdirSync(dir, { recursive: true })
    const name = slash < 0 ? key : key.slice(slash + 1)
    writeFileSync(join(dir, name + '.hevc'), Buffer.alloc(4096, 0x00))
  }
  return { root, decoded, img }
}

/** 跑一次升级（用例里几乎都用相同的参数）。 */
async function upgrade(root: string, decoded: string, cb?: (p: number, t: number, f: number, m: string) => void) {
  return upgradeDecodedImageCache(root, decoded, AES_KEY, XOR_KEY, cb)
}

describe('升级解码缓存：判据与槽位', () => {
  it('① 低档缓存被换成 `_h` 原图', async () => {
    const chat = png(0x22)
    const original = png(0x11, 8000)
    const { root, decoded } = fixture({
      cached: { [`${ORIGINAL_MD5}|`]: chat },
      dats: { [`${ORIGINAL_MD5}_h`]: original, [ORIGINAL_MD5]: chat },
    })

    const res = await upgrade(root, decoded)

    expect(res.total).toBe(1)
    expect(res.upgraded, '应当升级 1 张').toBe(1)
    expect(readFileSync(join(decoded, ORIGINAL_MD5 + '.png')).equals(original),
      '必须换成 `_h` 原图那一份').toBe(true)
    expect(at(res.details ?? [], 0).from, '明细里的「升级前」是原缓存的字节数').toBe(chat.length)
    expect(at(res.details ?? [], 0).to).toBe(original.length)
  })

  it('② 幂等：第二遍什么都不动（判据是「严格更大」，不是「有源就写」）', async () => {
    const original = png(0x11, 8000)
    const { root, decoded } = fixture({
      cached: { [`${ORIGINAL_MD5}|`]: png(0x22) },
      dats: { [`${ORIGINAL_MD5}_h`]: original },
    })

    await upgrade(root, decoded)
    const after = readFileSync(join(decoded, ORIGINAL_MD5 + '.png'))
    const second = await upgrade(root, decoded)

    expect(second.upgraded).toBe(0)
    expect(second.unchanged).toBe(1)
    expect(readFileSync(join(decoded, ORIGINAL_MD5 + '.png')).equals(after), '第二遍不得改写').toBe(true)
  })

  it('③ 不降级：缓存里那份更大时保持不动（例如它是 CDN 取回的原图）', async () => {
    const bigger = png(0x33, 20000)
    const { root, decoded } = fixture({
      cached: { [`${ORIGINAL_MD5}|`]: bigger },
      dats: { [`${ORIGINAL_MD5}_h`]: png(0x11, 8000) },
    })

    const res = await upgrade(root, decoded)

    expect(res.upgraded).toBe(0)
    expect(res.unchanged).toBe(1)
    expect(readFileSync(join(decoded, ORIGINAL_MD5 + '.png')).equals(bigger)).toBe(true)
  })

  it('④ 只有 `.t.` 缩略槽时补写主槽（之后读图才走得到它）', async () => {
    const original = png(0x11, 8000)
    const { root, decoded } = fixture({
      cached: { [`${ORIGINAL_MD5}|t`]: png(0x22, 400) },
      dats: { [`${ORIGINAL_MD5}_h`]: original },
    })

    const res = await upgrade(root, decoded)

    expect(res.upgraded).toBe(1)
    expect(existsSync(join(decoded, ORIGINAL_MD5 + '.png')), '必须补出主槽').toBe(true)
    expect(readFileSync(join(decoded, ORIGINAL_MD5 + '.png')).equals(original)).toBe(true)
    expect(existsSync(join(decoded, ORIGINAL_MD5 + '.t.png')), '缩略兜底槽留着无害，不必删').toBe(true)
  })

  it('⑤ 两个槽位都出现过的 md5：两个目录都要写（只写一个另一条读图路径还是糊的）', async () => {
    const original = png(0x11, 8000)
    const { root, decoded } = fixture({
      cached: { [`${ORIGINAL_MD5}|`]: png(0x22), [`wxid_a/${ORIGINAL_MD5}|`]: png(0x22, 900) },
      dats: { [`${ORIGINAL_MD5}_h`]: original },
    })

    const res = await upgrade(root, decoded)

    expect(res.upgraded).toBe(1)
    expect(readFileSync(join(decoded, ORIGINAL_MD5 + '.png')).equals(original)).toBe(true)
    expect(readFileSync(join(decoded, 'wxid_a', ORIGINAL_MD5 + '.png')).equals(original),
      '会话子目录那一份同样要升级').toBe(true)
  })

  it('⑥ 本机没有这个 md5 的 `.dat` → 计入 noSource 并写清原因', async () => {
    const { root, decoded } = fixture({ cached: { [`${ORIGINAL_MD5}|`]: png(0x22) } })

    const res = await upgrade(root, decoded)

    expect(res.upgraded).toBe(0)
    expect(res.noSource).toBe(1)
    expect(res.failed, '「本机没源」不是「失败」').toBe(0)
    expect((res.skippedDetails ?? []).some(d => d.reason.includes('本机没有'))).toBe(true)
  })

  it('⑦ `remote-images/` 不算消息图片的缓存（它的文件名也是 32 位十六进制）', async () => {
    const { root, decoded } = fixture({ dats: { [`${ORIGINAL_MD5}_h`]: png(0x11, 8000) } })
    const remote = join(decoded, 'remote-images')
    mkdirSync(remote, { recursive: true })
    const remoteFile = join(remote, ORIGINAL_MD5 + '.jpg')
    writeFileSync(remoteFile, png(0x44, 300))

    const res = await upgrade(root, decoded)

    expect(res.total, '远端代理的缓存条目不该进入待升级集合').toBe(0)
    expect(readFileSync(remoteFile).equals(png(0x44, 300)), '也不该被改写').toBe(true)
  })

  it('⑧ `_h` 解不开时退回聊天版（与逐条读图的档位回退同构）', async () => {
    const chat = png(0x22)
    const { root, decoded } = fixture({
      cached: { [`${ORIGINAL_MD5}|t`]: png(0x55, 200) },
      dats: { [`${ORIGINAL_MD5}_h`]: Buffer.from('not-an-image-at-all'), [ORIGINAL_MD5]: chat },
    })

    const res = await upgrade(root, decoded)

    expect(res.upgraded, '坏的那一档不该让整条判失败').toBe(1)
    expect(readFileSync(join(decoded, ORIGINAL_MD5 + '.png')).equals(chat)).toBe(true)
  })

  it('⑨ `.hevc` 占位不参与「现存最好」的门槛（它不可渲染）', async () => {
    // 占位文件造得比聊天版解码产物还大 —— 若实现把它算进门槛，这一张就永远不会被升级。
    const chat = png(0x22)
    const { root, decoded } = fixture({
      dats: { [ORIGINAL_MD5]: chat },
      hevc: [ORIGINAL_MD5],
    })

    const res = await upgrade(root, decoded)

    expect(res.upgraded).toBe(1)
    expect(readFileSync(join(decoded, ORIGINAL_MD5 + '.png')).equals(chat)).toBe(true)
    expect(existsSync(join(decoded, ORIGINAL_MD5 + '.hevc')), '升级成功后要把占位清掉').toBe(false)
  })

  it('⑩ wxgf 原图在转码不可用时判失败，且**不**覆盖缓存（宁可留旧的，也不留半个）', async () => {
    const prev = process.env.DSH_WECHAT_WXGF
    process.env.DSH_WECHAT_WXGF = '0'
    try {
      const cached = png(0x22)
      const { root, decoded } = fixture({
        cached: { [`${ORIGINAL_MD5}|`]: cached },
        dats: { [`${ORIGINAL_MD5}_h`]: wxgfPayload(8000) },
      })

      const res = await upgrade(root, decoded)

      expect(res.failed).toBe(1)
      expect(res.upgraded).toBe(0)
      expect(at(res.errors, 0).error).toContain('wxgf')
      expect(readFileSync(join(decoded, ORIGINAL_MD5 + '.png')).equals(cached)).toBe(true)
    } finally {
      if (prev === undefined) delete process.env.DSH_WECHAT_WXGF
      else process.env.DSH_WECHAT_WXGF = prev
    }
  })

  it('⑪ 进度回调：每条一次，最后一次的 processed 等于总数', async () => {
    const md5a = 'a'.repeat(32)
    const md5b = 'b'.repeat(32)
    const { root, decoded } = fixture({
      cached: { [`${md5a}|`]: png(0x22), [`${md5b}|`]: png(0x22) },
      dats: { [`${md5a}_h`]: png(0x11, 8000), [`${md5b}_h`]: png(0x11, 8000) },
    })
    const seen: Array<{ p: number; t: number }> = []

    const res = await upgrade(root, decoded, (p, t) => { seen.push({ p, t }) })

    expect(res.total).toBe(2)
    expect(seen.length).toBe(2)
    expect(at(seen, 1).p).toBe(2)
    expect(at(seen, 1).t).toBe(2)
  })
})

describe('接线不变量（行为测试够不到的那几条）', () => {
  const src = (rel: string): string => readFileSync(join(HERE, '..', 'src', rel), 'utf8')

  it('⑫ attach 的遍历只有一份实现（批量解密与升级必须看同一批文件）', () => {
    const upgradeCode = src('query/image-upgrade.ts')
    const batchCode = src('query/decrypt-images.ts')
    expect(upgradeCode.includes('collectImageDatFiles'), '升级要复用批量解密的遍历入口').toBe(true)
    expect(batchCode.includes('function walkDataDats'), '遍历实现留在批量解密里').toBe(true)
    expect(batchCode.includes('await collectImageDatFilesAsync(rawRoot)'),
      '批量解密必须走可让出的遍历驱动器（整棵 attach 树不该钉住 worker）').toBe(true)
    expect(upgradeCode.includes('walkDataDats'), '升级不该自己再递归一遍 attach').toBe(false)
    expect(upgradeCode.includes("'attach'"), '升级模块里不该出现第二份 msg/attach 路径拼接').toBe(false)
  })

  it('⑬ 档位排序也只有一份（升级取「最好的一档」用的是共享实现）', () => {
    const upgradeCode = src('query/image-upgrade.ts')
    expect(upgradeCode.includes('groupImageDatsByMd5'), '升级要复用共享的归并/排序').toBe(true)
    expect(/'_h\.dat'|_t\.dat'/.test(upgradeCode), '不许在升级模块里再写一份后缀判断').toBe(false)
  })
})
