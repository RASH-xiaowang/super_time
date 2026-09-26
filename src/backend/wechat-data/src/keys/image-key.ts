/**
 * 图片 AES 密钥的归一化（P3-4，第四批）。
 *
 * ## 为什么这一处值得有主人
 *
 * `aesKey` 在配置里是**字符串**（`image_aes_key`，16 个 ASCII 字符），在内存里可能已经是
 * `Buffer`。把它变成解密用的字节这件事，散在 6 处，而这 6 处**对空串的处理不一致**：
 * 4 处写的是 `typeof aesKey === 'string' && aesKey.length > 0 ? Buffer.from(aesKey, 'ascii') : …`，
 * 2 处漏了 `length > 0`。漏了的那里，空串会变成**长度为 0 的 key**，
 * 而 `createDecipheriv('aes-128-ecb', <0 字节>)` 不是「解不开」，是直接抛
 * `Invalid key length` —— 用户看到的是「这张图取不出来」，真实原因是「还没配密钥」，
 * 而这两句话在界面上完全不一样（一条该催他去「数据配置」，一条像是坏了）。
 *
 * ## 口径
 *
 * 「没有密钥」统一表示成 `null`，由各调用方走自己原本的「退化成 XOR / 不尝试 AES」分支；
 * 这里**不**决定退化策略，只保证「空串、空 Buffer、undefined」都落到同一个 null。
 */

/**
 * 把配置里的图片 AES 密钥归一化成解密要用的字节。
 * @param aesKey - 配置字符串 / 已就绪的字节 / 缺失。
 * @returns 密钥字节；空串、全空白、空字节串、`null`/`undefined` 一律 `null`（= 没有密钥）。
 */
export function normalizeAesKey(aesKey: string | Buffer | Uint8Array | null | undefined): Buffer | null {
  if (aesKey === null || aesKey === undefined) return null
  if (typeof aesKey === 'string') {
    // 只 trim 判定、不 trim 取值：密钥本身是 16 个 ASCII 字符，首尾空白是配置写坏了，
    // 而把它裁掉再去解密会得到「密钥长度不对」的另一种错。
    if (aesKey.trim().length === 0) return null
    return Buffer.from(aesKey, 'ascii')
  }
  if (aesKey.length === 0) return null
  return Buffer.isBuffer(aesKey) ? aesKey : Buffer.from(aesKey)
}
