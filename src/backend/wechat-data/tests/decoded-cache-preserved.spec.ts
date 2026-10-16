/**
 * 「保存普通设置**不许**清空解码缓存」的守卫（2026-09-29）。
 *
 * ## 这个 bug 长什么样
 *
 * `saveConfig` 判断「图片密钥是否变了」时读的是 `current[field]`，而 `current` 上的密钥字段
 * 在这之前就已经被 `delete` 掉了（config.json 恒不留密钥 —— 那是有意的设计）。
 * ⇒ 左边恒为空串、右边是真密钥 ⇒ 判据**每次都成立** ⇒ `clearDecodedImages` 把整个
 * `decoded_images` 递归删掉。而应用**每次启动都会保存一次配置**，于是：
 * 文章封面、远程图片、已解码图片的落盘缓存**活不过一次运行**。
 *
 * 真机证据（`[key-compare]`，修前/修后）：
 * ```
 * 修前 aesChanged=true((空) vs 16位/e…)   patchKeys=db_dir,api_enabled,…（**没有**密钥字段）
 * 修后 aesChanged=false(16位/e… vs 16位/e…)
 * ```
 *
 * 本文件把两个方向都钉住：**普通设置不该清**、**真换密钥必须清**。
 * @vitest-environment node
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { saveConfig } from '../src/config/wechat-config.ts'

const scratch: string[] = []
afterEach(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true })
  scratch.length = 0
})

/**
 * 造一个数据根：`<root>/decrypted`（数据根）+ `<root>/decoded_images/article-covers/cached.img`。
 * @param secrets - 要不要预先放一份 secrets.json（模拟"密钥已经落盘"的常态）。
 */
function makeRoot(secrets?: Record<string, unknown>): { root: string; decrypted: string; cached: string } {
  const root = mkdtempSync(join(tmpdir(), 'wx-cfgcache-'))
  scratch.push(root)
  const decrypted = join(root, 'decrypted')
  mkdirSync(decrypted, { recursive: true })
  writeFileSync(join(root, 'config.json'), JSON.stringify({ db_dir: 'D:/wx/db_storage' }))
  if (secrets !== undefined) writeFileSync(join(root, 'secrets.json'), JSON.stringify(secrets))
  const coverDir = join(root, 'decoded_images', 'article-covers')
  mkdirSync(coverDir, { recursive: true })
  const cached = join(coverDir, 'cached.img')
  writeFileSync(cached, Buffer.alloc(64, 7))
  return { root, decrypted, cached }
}

describe('saveConfig 与解码缓存', () => {
  it('保存**普通设置**时不许清空 decoded_images（这是"缓存活不过一次运行"的根因）', () => {
    const { decrypted, cached } = makeRoot({ image_aes_key: '0123456789abcdef', image_xor_key: 60 })
    const r = saveConfig(decrypted, { api_port: 5032, api_enabled: true })
    expect(r.ok).toBe(true)
    expect(existsSync(cached), '普通设置保存把解码缓存删了 ⇒ 落盘缓存又活不过一次运行').toBe(true)
  })

  it('**真的换了图片密钥**时必须清（这条不能被上一条改坏）', () => {
    const { decrypted, cached } = makeRoot({ image_aes_key: '0123456789abcdef', image_xor_key: 60 })
    const r = saveConfig(decrypted, { image_aes_key: 'fedcba9876543210' })
    expect(r.ok).toBe(true)
    expect(existsSync(cached), '换了密钥还不清 ⇒ 旧密钥解出来的图会被当成有效的').toBe(false)
  })

  it('密钥没变时保存普通设置 + 同时重申同一把密钥，也不许清', () => {
    const { decrypted, cached } = makeRoot({ image_aes_key: '0123456789abcdef', image_xor_key: 60 })
    const r = saveConfig(decrypted, { db_dir: 'D:/wx/db_storage', image_aes_key: '0123456789abcdef' })
    expect(r.ok).toBe(true)
    expect(existsSync(cached), '同一把密钥再写一遍不算"变了"').toBe(true)
  })
})
