/**
 * WxIsaac64 密钥流的**确定性**守卫（跑真 WASM，不联网、不碰真数据）。
 *
 * ## 为什么必须有这条
 *
 * 整文件解密此前**零自动化覆盖**：`sns-cdn-image.spec.ts` 把 `sns-keystream.ts` 整个
 * `vi.mock` 掉了，唯一真跑的是要真库 + 真网的 `sns-live-verify.manual.spec.ts`。
 * 于是「头对尾错」这类问题能一路活到用户屏幕上，而 CI 全绿。
 *
 * 这条用例把最容易静默出错的地方钉住：**生成的密钥流长度必须正好等于请求的长度**。
 * 少了它，密钥流一旦偏短，`decryptSnsAll` 的 `i < ks.length` 就会在尾部停下 ——
 * 头解对了、尾部原封不动（仍是密文），而调用方只看到「解密成功」。
 * 「一屏 9 张全挂」当年就是这么来的。
 */
import { describe, expect, it } from 'vitest'
import {
  SNS_HEAD_ENCRYPTED_BYTES,
  decryptSnsAll,
  decryptSnsHead,
  wxIsaac64Keystream,
} from '../src/query/sns-keystream.ts'

const SEED = '7789788357417345129'

/** 造一段确定性字节：JPEG 头 + 可复现的填充（跨进程一致，才能当判据）。 */
function fixture(len: number): Buffer {
  const b = Buffer.alloc(len)
  b[0] = 0xff; b[1] = 0xd8; b[2] = 0xff; b[3] = 0xe0
  // 线性同余，避免不同运行取到不同内容
  let x = 123456789
  for (let i = 4; i < len; i += 1) {
    x = (1103515245 * x + 12345) & 0x7fffffff
    b[i] = x & 0xff
  }
  b[b.length - 2] = 0xff
  b[b.length - 1] = 0xd9
  return b
}

describe('wxIsaac64Keystream：长度必须正好（真 WASM）', () => {
  it('请求多长就返回多长 —— 三个尺寸各测一次（含跨 128 KB 分块边界的）', async () => {
    for (const n of [1024, SNS_HEAD_ENCRYPTED_BYTES, SNS_HEAD_ENCRYPTED_BYTES + 1, 300000]) {
      const ks = await wxIsaac64Keystream(SEED, n)
      expect(ks.length, '密钥流长度必须等于请求长度（size=' + String(n) + '）').toBe(n)
    }
  }, 60000)
})

describe('decryptSnsAll：整份往返（真 WASM）', () => {
  it('加密再解回 ⇒ 与原文逐字节相同（含大于 128 KB 的文件）', async () => {
    for (const len of [SNS_HEAD_ENCRYPTED_BYTES + 1, 300000]) {
      const plain = fixture(len)
      const ks = await wxIsaac64Keystream(SEED, len)
      const cipher = Buffer.alloc(len)
      for (let i = 0; i < len; i += 1) cipher[i] = (plain[i] as number) ^ (ks[i] as number)
      // 往返的中间态必须**不是**明文，否则这条用例就是在测一个空转
      expect(cipher.equals(plain), '密文不该等于明文').toBe(false)
      const back = await decryptSnsAll(cipher, SEED)
      expect(back.decrypted).toBe(len)
      expect(back.bytes.equals(plain), '往返后应与原文逐字节相同（len=' + String(len) + '）').toBe(true)
    }
  }, 60000)

  it('空种子 ⇒ 原样返回且 decrypted=0（不假装解过）', async () => {
    const b = fixture(64)
    const r = await decryptSnsAll(b, '')
    expect(r.decrypted).toBe(0)
    expect(r.bytes.equals(b)).toBe(true)
  })
})

describe('decryptSnsHead：只覆盖头部（视频语义）', () => {
  it('只动前 128 KB，尾部原封不动 —— 这正是「图片不能用它」的原因', async () => {
    const len = 200000
    const plain = fixture(len)
    const ks = await wxIsaac64Keystream(SEED, len)
    const cipher = Buffer.alloc(len)
    for (let i = 0; i < len; i += 1) cipher[i] = (plain[i] as number) ^ (ks[i] as number)

    const r = await decryptSnsHead(cipher, SEED)
    expect(r.decrypted).toBe(SNS_HEAD_ENCRYPTED_BYTES)
    // 头部被还原
    expect(r.bytes.subarray(0, SNS_HEAD_ENCRYPTED_BYTES).equals(plain.subarray(0, SNS_HEAD_ENCRYPTED_BYTES))).toBe(true)
    // 尾部仍是密文 —— 与明文不同
    expect(r.bytes.subarray(SNS_HEAD_ENCRYPTED_BYTES).equals(plain.subarray(SNS_HEAD_ENCRYPTED_BYTES))).toBe(false)
  }, 60000)

  it('小于 128 KB 的文件：整份都能还原（decrypted 取实际长度）', async () => {
    const len = 5000
    const plain = fixture(len)
    const ks = await wxIsaac64Keystream(SEED, len)
    const cipher = Buffer.alloc(len)
    for (let i = 0; i < len; i += 1) cipher[i] = (plain[i] as number) ^ (ks[i] as number)
    const r = await decryptSnsHead(cipher, SEED)
    expect(r.decrypted).toBe(len)
    expect(r.bytes.equals(plain)).toBe(true)
  }, 60000)
})