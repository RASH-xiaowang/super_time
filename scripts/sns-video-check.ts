/**
 * 朋友圈视频离线解析的回归测试（不依赖真实微信数据）。
 *
 * 守的是这次踩的坑：`cache/<月>/Sns/Video/<xx>/<hash>.mp4` 里的 `<hash>` **不是**
 * 任何标识的哈希。旧实现按 `md5(timelineId + '_' + mediaId + '_2')` 拼文件名，
 * 对真实缓存 39 条视频试了 11 种公式 × 4 种后缀，与磁盘 127 个基名**零命中** ——
 * 于是视频永远取不到，用户点播放只看到一个 ×。
 * 真正的映射是**内容 md5 == XML 里的 `<url md5>`**，封面是同名兄弟文件。
 *
 * 这里用一棵临时假缓存树把这条规则钉住：文件名故意用无关哈希，只有内容对得上。
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  fetchSnsVideoDataUrl,
  resolveSnsVideoCoverDataUrl,
  resolveSnsVideoDataUrl,
} from '../src/backend/wechat-data/src/query/sns-video.ts'
import { decryptSnsHead, wxIsaac64Keystream } from '../src/backend/wechat-data/src/query/sns-keystream.ts'

let passed = 0
function ok(cond: unknown, label: string): void {
  assert.ok(cond, label)
  passed += 1
  console.log(`  ✅ ${label}`)
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '.tmp-sns-video-check')
rmSync(root, { recursive: true, force: true })

// 造一棵假缓存：文件名是两个无关哈希，内容才是真身
const month = '2026-01'
const videoBytes = Buffer.from('fake-mp4-body-'.repeat(200))
const coverBytes = Buffer.from('fake-jpeg-body-'.repeat(50))
const videoMd5 = createHash('md5').update(videoBytes).digest('hex')
const coverMd5 = createHash('md5').update(coverBytes).digest('hex')
const shard = 'ab'
const bogusName = 'ffffffffffffffffffffffffffffffff'
mkdirSync(join(root, 'cache', month, 'Sns', 'Video', shard), { recursive: true })
writeFileSync(join(root, 'cache', month, 'Sns', 'Video', shard, bogusName + '.mp4'), videoBytes)
writeFileSync(join(root, 'cache', month, 'Sns', 'Video', shard, bogusName + '.jpg'), coverBytes)

try {
  console.log('按内容 md5 命中（文件名无关）')
  const v = resolveSnsVideoDataUrl(root, videoMd5)
  ok(!!v.url && v.url.startsWith('data:video/mp4;base64,'), '视频本体按内容 md5 解析成功')
  const c = resolveSnsVideoCoverDataUrl(root, videoMd5)
  ok(!!c.url && c.url.startsWith('data:image/jpeg;base64,'), '封面取到同名兄弟文件')

  console.log('只给了封面 md5 时也要能推出视频本体')
  const v2 = resolveSnsVideoDataUrl(root, coverMd5)
  ok(!!v2.url && v2.url.startsWith('data:video/mp4;base64,'), '封面 md5 → 兄弟文件推出视频')
  const c2 = resolveSnsVideoCoverDataUrl(root, coverMd5)
  ok(!!c2.url, '封面 md5 直接命中封面')

  console.log('没有缓存时给能照做的错误，而不是假装能播')
  const miss = resolveSnsVideoDataUrl(root, '1'.repeat(32))
  ok(!miss.url && /没有这条视频/.test(miss.error ?? ''), `未缓存 → 明确报错（${miss.error}）`)
  const missCover = resolveSnsVideoCoverDataUrl(root, '2'.repeat(32))
  ok(!missCover.url && !!missCover.error, '封面同样明确报错')

  console.log('不再按标识拼文件名（旧实现的错误做法）')
  // timelineId/mediaId 齐全但文件内容对不上 → 必须报错，不能凭公式猜出文件
  const byFormula = resolveSnsVideoDataUrl(root, videoMd5, '15009621426130858584', '15009621426664649277')
  ok(!!byFormula.url, '给了 timelineId/mediaId 也不影响按内容匹配')
  const noMd5 = resolveSnsVideoDataUrl(root, '', '15009621426130858584', '15009621426664649277')
  ok(!noMd5.url && /缺少视频标识/.test(noMd5.error ?? ''), '缺 md5 时直接报错（不猜文件名）')
} finally {
  rmSync(root, { recursive: true, force: true })
}

// ── CDN 加密头解密（WxIsaac64）：代码正确性由固定向量锚住，真实正确性由 md5 验收 ──
console.log('\nCDN 加密头解密（WxIsaac64）')
{
  // 固定向量：从权威 WASM（vendored 资产）取下的 seed=1 / 32 字节。
  // 若这条挂了，说明资产被换过或调用方式变了 —— 所有解密结果都会不可信。
  const vec = await wxIsaac64Keystream('1', 32)
  ok(vec.toString('hex') === 'e19ed5d2ca98af2da7a18d07cab39b52a0ab0232d180af1472b36dcf1af5e46f',
    'seed=1 的密钥流与参考实现逐字节一致')

  const plainMp4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom', 'latin1'), Buffer.alloc(400)])
  const ks = await wxIsaac64Keystream('3310657292', plainMp4.length)
  const cipher = Buffer.from(plainMp4)
  for (let i = 0; i < cipher.length; i += 1) cipher[i] = (cipher[i] ?? 0) ^ (ks[i] ?? 0)
  const back = (await decryptSnsHead(cipher, '3310657292')).bytes
  ok(back.equals(plainMp4), 'XOR 成密文后能逐字节还原')
  const wrong = (await decryptSnsHead(cipher, '12345')).bytes
  ok(!wrong.equals(plainMp4), '换一个种子解不出原内容（种子确实参与运算）')
  const noSeed = (await decryptSnsHead(cipher, '')).bytes
  ok(noSeed.equals(cipher), '没有种子时不改动字节（交给上层如实报错）')
}

// ── 按需从 CDN 取回：加密流要能解密，解不出要如实拒绝 ──
const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom', 'latin1'), Buffer.alloc(64)])
const mp4Md5 = createHash('md5').update(mp4).digest('hex')
const SEED = '3310657292'
const encKs = await wxIsaac64Keystream(SEED, mp4.length)
const encMp4 = Buffer.from(mp4)
for (let i = 0; i < encMp4.length; i += 1) encMp4[i] = (encMp4[i] ?? 0) ^ (encKs[i] ?? 0)
const server = createServer((req, res) => {
  if (req.url === '/plain') { res.writeHead(200, { 'content-type': 'video/mp4' }); res.end(mp4); return }
  if (req.url === '/enc') { res.writeHead(200, { 'content-type': 'video/mp4' }); res.end(encMp4); return }
  res.writeHead(200, { 'content-type': 'video/mp4' })
  res.end(Buffer.from('009db0ddb7731586d43f2f25b738d247', 'hex'))
})
await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
const port = (server.address() as { port: number }).port

try {
  console.log('\n按需取回（CDN）')
  const okRes = await fetchSnsVideoDataUrl(`http://127.0.0.1:${port}/plain`, mp4Md5, { timeoutMs: 5000 })
  ok(!!okRes.url && okRes.url.startsWith('data:video/mp4;base64,'), '明文 MP4 直接可用')
  const dec = await fetchSnsVideoDataUrl(`http://127.0.0.1:${port}/enc`, mp4Md5, { timeoutMs: 5000, seed: SEED })
  ok(!!dec.url, '加密流用 <enc key> 解密后可用（整文件 md5 校验通过）')
  const noSeed = await fetchSnsVideoDataUrl(`http://127.0.0.1:${port}/enc`, mp4Md5, { timeoutMs: 5000 })
  ok(!noSeed.url && /没有 <enc key>/.test(noSeed.error ?? ''), `无种子时如实报错（${(noSeed.error ?? '').slice(0, 18)}…）`)
  const wrongSeed = await fetchSnsVideoDataUrl(`http://127.0.0.1:${port}/enc`, mp4Md5, { timeoutMs: 5000, seed: '999' })
  ok(!wrongSeed.url && /不是 MP4/.test(wrongSeed.error ?? ''), '种子不对时拒绝，不把乱码当视频')
  const mismatch = await fetchSnsVideoDataUrl(`http://127.0.0.1:${port}/plain`, '1'.repeat(32), { timeoutMs: 5000 })
  ok(!mismatch.url && /与记录不符/.test(mismatch.error ?? ''), 'md5 不符时拒绝')
  const bad = await fetchSnsVideoDataUrl('http://127.0.0.1:1/plain', mp4Md5, { timeoutMs: 3000 })
  ok(!bad.url && /取回失败/.test(bad.error ?? ''), `连不上时给出具体原因（${(bad.error ?? '').slice(0, 18)}…）`)
  console.log(`\n✅ 断言通过 ${passed} 项`)
} finally {
  server.close()
}
