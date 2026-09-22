
/**
 * 密钥获取与全库/全图解密（图片密钥自动获取、验证、解密状态） 的 @Remote 处理器（M21 自 `gateway.ts` 搬出）。
 *
 * 机制：类里保留 @Remote 装饰器与签名（协议层按名字枚举），方法体一行转发；
 * 处理器体在这里，依赖由 `rc` 显式给出。
 */
import { scanV2Templates, trustedXorForVerifiedAesKey } from '../keys/image-key-resolver.ts'
import { fetchImageKey, normalizeAccountDir } from '../keys/service.ts'
import { getConfig } from '../query/config.ts'
import { decryptAllDbs } from '../query/decrypt-all.ts'
import { decryptAllImageDats } from '../query/decrypt-images.ts'
import { resolveImageKeyPair } from '../query/image-key.ts'
import { invalidateWechatMeta } from '../query/meta.ts'
import { AutoImageKeyResult, DecryptAllResult, DecryptImagesResult, DecryptStatus, OperationCategory, OperationStatus, VerifyImageKeyResult } from '../types.ts'
import { existsSync } from 'node:fs'

export interface createKeysDecryptRemotesInputs {
  rawWechatBase: (decrypted: string) => string
  dirs: () => { decrypted: string; decoded: string }
  op: (category: OperationCategory, action: string, status: OperationStatus, target?: string, detail?: string) => void
  decryptState: DecryptStatus
}

export function createKeysDecryptRemotes(rc: createKeysDecryptRemotesInputs) {
  const rawWechatBase = rc.rawWechatBase
  return {
    async autoGetImageKey(options: { accountDir?: string; pid?: number }): Promise<AutoImageKeyResult> {
      const accountDir = normalizeAccountDir(options.accountDir ?? '')
      if (accountDir && existsSync(accountDir)) {
        const cfg = getConfig(rc.dirs().decrypted)
        const savedAes = typeof cfg['image_aes_key'] === 'string' ? cfg['image_aes_key'].trim() : ''
        if (savedAes) {
          const scan = scanV2Templates(accountDir)
          if (scan.templates.length > 0) {
            const xor = trustedXorForVerifiedAesKey(savedAes, scan)
            if (xor !== null) {
              const result: AutoImageKeyResult = { ok: true, aesKey: savedAes, xorKey: xor, verified: true }
              const template = scan.templates[0]
              if (template) result.templatePath = template.path
              rc.op('keys', 'auto_get_image_key', 'ok', accountDir, '使用已保存并验证的图片密钥')
              return result
            }
          }
        }
      }
      const fetchOpts: { accountDir?: string; pid?: number } = { accountDir }
      if (options.pid !== undefined) fetchOpts.pid = options.pid
      const r = await fetchImageKey(fetchOpts)
      rc.op('keys', 'auto_get_image_key', r.ok ? 'ok' : 'fail', accountDir, r.error ?? (r.verified ? '内存扫描成功' : ''))
      return r
    },

    verifyImageKey(): VerifyImageKeyResult {
      const cfg = getConfig(rc.dirs().decrypted)
      const aesKey = typeof cfg['image_aes_key'] === 'string' ? cfg['image_aes_key'].trim() : ''
      if (!aesKey) { rc.op('keys', 'verify_image_key', 'fail', '', '尚未配置图片 AES 密钥'); return { verified: false, error: '尚未配置图片 AES 密钥' } }
      const rawRoot = rawWechatBase(rc.dirs().decrypted)
      if (!rawRoot) { rc.op('keys', 'verify_image_key', 'fail', '', '未配置数据库目录，无法定位账号数据'); return { verified: false, error: '未配置数据库目录，无法定位账号数据' } }
      const scan = scanV2Templates(rawRoot)
      if (scan.templates.length === 0) { rc.op('keys', 'verify_image_key', 'fail', '', '未找到 V2 图片模板（_t.dat）'); return { verified: false, error: '未找到 V2 图片模板（_t.dat）' } }
      const xor = trustedXorForVerifiedAesKey(aesKey, scan)
      const result: VerifyImageKeyResult = {
        verified: xor !== null,
        aesKey,
        xorKey: xor ?? Number(cfg['image_xor_key'] ?? 0),
      }
      const template = scan.templates[0]
      if (template) result.templatePath = template.path
      rc.op('keys', 'verify_image_key', result.verified ? 'ok' : 'fail', '', result.error ?? (result.verified ? '已通过' : '验证失败'))
      return result
    },

    async decryptAllDatabases(): Promise<DecryptAllResult> {
      if (rc.decryptState.active) { rc.op('sync', 'decrypt_databases', 'fail', '', '已有解密任务进行中'); return { ok: false, total: 0, okCount: 0, failed: [], error: '已有解密任务进行中' } }
      const cfg = getConfig(rc.dirs().decrypted)
      const rawDbDir = typeof cfg['db_dir'] === 'string' ? cfg['db_dir'] : ''
      rc.decryptState.op = 'databases'
      rc.decryptState.active = true
      rc.decryptState.done = 0
      rc.decryptState.total = 0
      rc.decryptState.failed = 0
      rc.decryptState.skipped = 0
      rc.decryptState.message = ''
      try {
        const r = await decryptAllDbs(rawDbDir, rc.dirs().decrypted, (done, total, failed, message) => {
          rc.decryptState.done = done
          rc.decryptState.total = total
          rc.decryptState.failed = failed
          rc.decryptState.message = message
        })
        // 全部解密库被原子替换：进程内元数据/统计缓存必须整体失效。
        invalidateWechatMeta()
        rc.op('sync', 'decrypt_databases', r.ok ? 'ok' : 'fail', '', r.error ?? `成功 ${r.okCount}/${r.total}${r.failed.length > 0 ? `，失败 ${r.failed.length}` : ''}`)
        return r
      } finally {
        rc.decryptState.active = false
        rc.decryptState.message = ''
      }
    },

    async decryptAllImages(options: { concurrency?: number }): Promise<DecryptImagesResult> {
      if (rc.decryptState.active) { rc.op('sync', 'decrypt_images', 'fail', '', '已有解密任务进行中'); return { ok: false, total: 0, okCount: 0, failed: 0, skipped: 0, errors: [], error: '已有解密任务进行中' } }
      const { aesKey, xorKey } = resolveImageKeyPair(rc.dirs().decrypted)
      const rawRoot = rawWechatBase(rc.dirs().decrypted)
      if (!rawRoot) { rc.op('sync', 'decrypt_images', 'fail', '', '未配置数据库目录，无法定位图片数据'); return { ok: false, total: 0, okCount: 0, failed: 0, skipped: 0, errors: [], error: '未配置数据库目录，无法定位图片数据' } }
      const concurrency = Math.floor(options.concurrency ?? 8) || 8
      rc.decryptState.op = 'images'
      rc.decryptState.active = true
      rc.decryptState.done = 0
      rc.decryptState.total = 0
      rc.decryptState.failed = 0
      rc.decryptState.skipped = 0
      rc.decryptState.message = ''
      try {
        const result = await decryptAllImageDats(rawRoot, rc.dirs().decoded, aesKey, xorKey, concurrency,
          (processed, total, failed, message) => {
            rc.decryptState.done = processed
            rc.decryptState.total = total
            rc.decryptState.failed = failed
            rc.decryptState.message = message
          })
        rc.decryptState.skipped = result.skipped
        rc.op('sync', 'decrypt_images', result.failed === 0 ? 'ok' : 'fail', '', `成功 ${result.okCount}/${result.total}${result.failed > 0 ? `，失败 ${result.failed}` : ''}`)
        return { ok: true, ...result }
      } finally {
        rc.decryptState.active = false
        rc.decryptState.message = ''
      }
    },

  }
}
