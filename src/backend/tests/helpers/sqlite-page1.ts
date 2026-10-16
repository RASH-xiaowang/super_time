/**
 * 给测试夹具写一段**规范合规**的 SQLite 页 1 头部。
 *
 * 为什么需要：`query/sync.ts#plausibleSqliteHeader`（「这次解密解对了没有」的判据）看的
 * 是头部里不能被合成的字段 —— 页大小（16-17）、读写格式（18/19，只能是 1 或 2）、
 * 三个 payload fraction（21/22/23，规范写死 64/32/32）。夹具只填页大小的话，
 * **自己造出来的好库会被自己的判据拒掉**（实测：收紧判据后一次红 7 条）。
 * 这个 helper 就是把「真库长什么样」收成一个出处，免得每个加密类夹具各写一份、各漏几维。
 *
 * 刻意**不**碰偏移 20 的 reserved：微信那类库里它是 80 而不是 0，判据也不看它。
 * @module tests/helpers/sqlite-page1
 */

/**
 * 就地写好 `buf` 前 24 字节里那些「判据会看」的字段。
 * @param buf - 页 1 的明文缓冲（至少 24 字节，通常一整页）。
 * @param pageSize - 逻辑页大小；`65536` 按 SQLite 的规定编码成 `1`。
 * @returns 无（原地修改）。
 * @throws 缓冲太短或页大小不合法时 —— 那是夹具写错，不该静默造出一个「解不开的库」。
 */
export function writeSqlitePage1Header(buf: Buffer, pageSize: number): void {
  if (buf.length < 24) throw new Error(`页 1 缓冲至少 24 字节，收到 ${String(buf.length)}`)
  const legal = pageSize === 65536 || (pageSize >= 512 && pageSize <= 65536 && (pageSize & (pageSize - 1)) === 0)
  if (!legal) throw new Error(`不是合法的 SQLite 页大小：${String(pageSize)}`)
  Buffer.from('SQLite format 3\0', 'utf8').copy(buf, 0)
  buf.writeUInt16BE(pageSize === 65536 ? 1 : pageSize, 16)
  buf[18] = 1
  buf[19] = 1
  buf[21] = 64
  buf[22] = 32
  buf[23] = 32
}
