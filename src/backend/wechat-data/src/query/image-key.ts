/**
 * 解码微信图片时「用哪对密钥」的**唯一**判定处。
 *
 * 优先级：`config.json`/`secrets.json`（用户在「数据配置」里保存的）> `keys.json`
 * （`autoGetImageKey` 自动获取到的）。前者赢是刻意的 —— 手工填的密钥必须能压住自动扫出来的，
 * 否则用户发现扫错了就没有纠正的余地。
 *
 * 为什么要单独有这个文件：`keys.json` 这一路回退一度只写在本文件里、却没有任何解码入口调用它，
 * 于是「优先 config.json，回退 keys.json」（`wechat-data/README.md` 朋友圈媒体一节）实际只剩
 * 前半句 —— esbuild 把整个函数当死代码摇掉了（产物 `lib/index.js` 里搜不到这个名字）。
 * 现在 gateway 的 6 个媒体解码入口与 `query/export.ts` 都走这里；原先那 7 份重复的
 * `cfg['image_aes_key']` 取数、以及三种互相矛盾的 xor 兜底常数（`136` / `0` / `0xff`）
 * 一并收在这里。**新增解码入口时不要再自己读 cfg**。
 *
 * 归属校验：`keys.json` 只有 `'default'` 一个槽位（写入方见 `keys/service.ts`），同机换过账号时
 * 那里面可能是**上一个账号**的图密钥；而拿错的图密钥去解不会报错，只会解出一张垃圾图。
 * 所以记录里写了归属（`image_key_derived_wxid`）且与当前账号明确不同时，宁可当成「没有密钥」
 * 让界面提示重新配钥。任一侧信息缺失、或形状不是 `wxid_…`（老账号目录用别名）时一律放行 ——
 * 那等于「没有证据」，不能据此把用户本来能用的密钥判死。
 */
import { join } from 'node:path'
import { getConfig, resolveSelfUsername } from './config.ts'
import { getAccountKeysFromStore } from '../keys/key-store.ts'
import { cleanWxid } from '../keys/image-key-resolver.ts'
import type { StoredAccountKeys } from '../keys/types.ts'

/** 图片 XOR 字节的内置默认值：与 `defaultConfig()` 同源，解码点不要再各写一份。 */
const DEFAULT_IMAGE_XOR_KEY = 136

/** `keys.json` 里自动获取结果所在的槽位（`keys/service.ts` 写入时用的是同一个字面量）。 */
const AUTO_KEY_SLOT = 'default'

/** 形状上是否像一个 wxid（`wxid_` 前缀且后面还有内容）；别名目录名一律不算。 */
function isWxidLike(value: string): boolean {
  return /^wxid_.+/.test(value)
}

/**
 * 库存的自动密钥是否属于当前账号。
 * @param stored - `keys.json` 里的那条记录。
 * @param decrypted - 解密数据根（用来解析当前账号）。
 * @returns true = 可以用（含「证据不足以判定」的放行）；false = 明确属于别的账号。
 */
function storedKeyOwnedBySelf(stored: StoredAccountKeys, decrypted: string): boolean {
  // 两条来源字段：kvcomm 派生路径记的是 wxid 本身，内存扫描路径记的是它来自哪个账号目录。
  const owner = cleanWxid(stored.image_key_derived_wxid) || cleanWxid(stored.image_key_source_wxid_dir)
  if (!isWxidLike(owner)) return true
  const self = cleanWxid(resolveSelfUsername(decrypted))
  if (!isWxidLike(self)) return true
  return owner === self
}

/**
 * 取当前生效的图片 AES 密钥与 XOR 字节。
 * @param decrypted - 解密数据根（定位 config.json / secrets.json / keys.json）。
 * @returns `aesKey` 为 `undefined` 表示「没有可用密钥」—— 解码方据此报未配置，
 *   而不是拿空密钥硬解；`xorKey` 恒有值（缺省用内置默认 136）。
 */
export function resolveImageKeyPair(decrypted: string): { aesKey: string | undefined; xorKey: number } {
  const cfg = getConfig(decrypted)
  const xorKey = Number(cfg['image_xor_key'] ?? DEFAULT_IMAGE_XOR_KEY)
  const fromConfig = typeof cfg['image_aes_key'] === 'string' ? cfg['image_aes_key'].trim() : ''
  if (fromConfig !== '') return { aesKey: fromConfig, xorKey }

  const stored = getAccountKeysFromStore(AUTO_KEY_SLOT, join(decrypted, '..'))
  const fromStore = typeof stored.image_aes_key === 'string' ? stored.image_aes_key.trim() : ''
  if (fromStore === '' || !storedKeyOwnedBySelf(stored, decrypted)) return { aesKey: undefined, xorKey }

  // 自动密钥是配对着派生的（kvcomm 的 code 同时决定 AES 与 XOR），所以用它自带的 XOR 字节
  const storedXor = Number(stored.image_xor_key)
  return {
    aesKey: fromStore,
    xorKey: Number.isFinite(storedXor) && storedXor >= 0 && storedXor <= 255 ? storedXor : xorKey,
  }
}
