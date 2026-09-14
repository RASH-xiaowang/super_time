/**
 * Minimal ZIP writer (no external deps): STORE method with deflate via
 * node:zlib, used for .xlsx (OOXML) and export ZIP packaging.
 *
 * 两种用法，按输出规模选：
 *   · `zipFiles(entries)` —— 全部内容已在内存里时用（xlsx、单会话打包）。
 *   · `ZipFileWriter`     —— 内容需要现场产出/体量不可控时用（整账号归档）：
 *     逐条目写盘，**峰值内存 = 单个条目**而不是所有条目之和。
 *
 * 为什么要后一种：整账号归档（exportAllSessions）最多 1000 个会话、每个最多 5 万条，
 * 原实现把每个会话的文本全堆进 entries、再由 zipFiles 一次性 concat，
 * 最坏情形常驻数 GB，且全程同步压缩/写盘会把承载全部查询的后端进程钉住。
 *
 * `ZipFileWriter` 与 `zipFiles` 对同一组条目产出**逐字节相同**的输出
 * （同样的本地头、同样的 STORE/DEFLATE 选择、同样的中央目录与 EOCD 顺序），
 * 由 tests/export-zip.spec.ts 断言，避免「换成流式后归档格式悄悄变了」。
 */
import { createWriteStream, promises as fsp } from 'node:fs'
import type { WriteStream } from 'node:fs'
import { once } from 'node:events'
import { deflateRawSync } from 'node:zlib'

const CRC_TABLE = ((): number[] => {
  const table = new Array<number>(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

/** CRC32 起始值（用于分块累计）。 */
function crc32Start(): number {
  return 0xffffffff
}

/** 把一块数据并入 CRC32 累计值。 */
function crc32Update(c: number, buf: Buffer): number {
  let acc = c
  for (let i = 0; i < buf.length; i += 1) {
    const byte = buf[i] ?? 0
    acc = (CRC_TABLE[(acc ^ byte) & 0xff] ?? 0) ^ (acc >>> 8)
  }
  return acc
}

/** 收尾得到最终 CRC32。 */
function crc32Finish(c: number): number {
  return (c ^ 0xffffffff) >>> 0
}

function crc32(buf: Buffer): number {
  return crc32Finish(crc32Update(crc32Start(), buf))
}

function u16(v: number): Buffer {
  const b = Buffer.alloc(2)
  b.writeUInt16LE(v)
  return b
}

function u32(v: number): Buffer {
  const b = Buffer.alloc(4)
  b.writeUInt32LE(v >>> 0)
  return b
}

/** STORE(0) / DEFLATE(8) 的选择：压缩不比原文短就用 STORE（与旧实现同判据）。 */
function packEntry(raw: Buffer): { data: Buffer; method: number } {
  const deflated = deflateRawSync(raw)
  return deflated.length >= raw.length ? { data: raw, method: 0 } : { data: deflated, method: 8 }
}

/** Build a ZIP archive from named entries (string or bytes payloads). */
export function zipFiles(entries: Array<{ name: string; data: string | Uint8Array }>): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  const names = new Set<string>()
  for (const entry of entries) {
    const name = entry.name.replace(/\\/g, '/')
    if (names.has(name)) continue
    names.add(name)
    const raw = typeof entry.data === 'string' ? Buffer.from(entry.data, 'utf8') : Buffer.from(entry.data)
    const { data, method } = packEntry(raw)
    const crc = crc32(raw)
    const nameBuf = Buffer.from(name, 'utf8')
    const local = Buffer.concat([
      u32(0x04034b50), u16(20), u16(0), u16(method), u16(0), u16(0),
      u32(crc), u32(data.length), u32(data.length), u16(nameBuf.length), u16(0),
      nameBuf, data,
    ])
    locals.push(local)
    centrals.push(Buffer.concat([
      u32(0x02014b50), u16(20), u16(20), u16(0), u16(method), u16(0), u16(0),
      u32(crc), u32(data.length), u32(data.length), u16(nameBuf.length), u16(0), u16(0), u16(0), u16(0),
      u32(0), u32(offset), nameBuf,
    ]))
    offset += local.length
  }
  const centralStart = offset
  const central = Buffer.concat(centrals)
  const eocd = Buffer.concat([
    u32(0x06054b50), u16(0), u16(0), u16(centrals.length), u16(centrals.length),
    u32(central.length), u32(centralStart), u16(0),
  ])
  return Buffer.concat([...locals, central, eocd])
}

/**
 * 逐条目写盘的 ZIP 写入器。
 *
 * 生命周期：`create()` → 若干 `addFile()` → `close()`；任一步出错就 `abort()`
 * （它会关流并删掉半成品文件，避免留下一个看起来完整、实际截断的归档）。
 */
export class ZipFileWriter {
  private readonly out: WriteStream
  private readonly filePath: string
  private offset = 0
  private readonly centrals: Buffer[] = []
  private readonly names = new Set<string>()
  private closed = false
  private aborted = false
  /** 写流报出的错误（见 write() 里「drain 掩盖 error」的说明）。 */
  private streamError: Error | null = null

  private constructor(filePath: string, out: WriteStream) {
    this.filePath = filePath
    this.out = out
  }

  /** 打开目标文件准备写入（覆盖已有文件）。 */
  static async create(filePath: string): Promise<ZipFileWriter> {
    const out = createWriteStream(filePath)
    const w = new ZipFileWriter(filePath, out)
    // 必须挂 error handler：写流在 destroy 或磁盘出错时会 emit 'error'，
    // 无人监听会升级成未捕获异常。但**光挂 handler 不够** —— 见 streamError 的说明。
    out.on('error', (e: Error) => {
      if (!w.streamError) w.streamError = e
    })
    // 等 open 完成，让「打不开文件」这类错误在这里就暴露，而不是第一条写入时。
    await once(out, 'open')
    return w
  }

  /**
   * 底层写入：更新偏移量并等待背压。
   *
   * 这里有个坑（评审实测出来的）：写流出错时（例如 ENOSPC）Node 会先 emit `drain`
   * 再 emit `error`。若只写 `if (!write()) await once('drain')`，那次 drain 会把
   * 挂起的等待**当成成功**放行，而流其实已经毁了 —— 之后每次 write() 都返回 false
   * 且再也不会有 drain，于是**永久挂起**：用户看不到报错、RPC 一直等到超时、
   * 临时文件也不会被清理。所以要同时等 drain 与 close/error，并在事后复查标志位。
   */
  private async write(buf: Buffer): Promise<void> {
    // 先查状态再等：destroy() 触发的 'close'/'error' 很可能**在我们挂 once 监听之前**
    // 就已经发出（abort 与随后的写入相隔一个 await），此时 once 永远等不到新事件 → 挂起。
    if (this.streamError) throw this.streamError
    if (this.aborted || this.out.destroyed || this.out.writableEnded) {
      throw new Error('写入流已关闭，归档未完成')
    }
    this.offset += buf.length
    let needDrain: boolean
    try {
      needDrain = !this.out.write(buf)
    } catch (e) {
      this.streamError = e as Error
      throw this.streamError
    }
    if (this.streamError) throw this.streamError
    if (needDrain) await this.waitDrainOrDeath()
    if (this.streamError) throw this.streamError
  }

  /**
   * 等背压解除，或被 close/error 打断。
   *
   * 手写监听而不是 `Promise.race([once(...)])`：once() 不暴露它的监听器，
   * race 里没赢的那两个会永远挂着 —— 每次背压写入就多留 2 个监听器，
   * 长生命周期流上会累积到触发 `MaxListenersExceededWarning`
   * （评审实测 24 会话×3000 条就到 close 25 / error 50，1000 会话会到千级）。
   */
  private async waitDrainOrDeath(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const cleanup = (): void => {
        this.out.off('drain', onDrain)
        this.out.off('close', onClose)
        this.out.off('error', onError)
      }
      const onDrain = (): void => {
        cleanup()
        resolve()
      }
      const onClose = (): void => {
        cleanup()
        reject(this.streamError ?? new Error('写入流已关闭，归档未完成'))
      }
      const onError = (e: Error): void => {
        cleanup()
        reject(this.streamError ?? e)
      }
      this.out.once('drain', onDrain)
      this.out.once('close', onClose)
      this.out.once('error', onError)
      // 挂监听之后**再查一次状态**：destroy/close 的事件可能在我们挂之前就已发出，
      // 此时三个 once 都会等一个永不再来的事件（这坑第一版补丁踩过，靠回归测试才发现）。
      if (this.streamError || this.aborted || this.out.destroyed) onClose()
    })
  }

  /**
   * 追加一个条目。
   * @param name - 归档内路径（反斜杠会转成正斜杠）。
   * @param data - 字符串（UTF-8）或字节。
   * @returns 是否真的写入（同名条目会被跳过，与 zipFiles 行为一致）。
   */
  async addFile(name: string, data: string | Uint8Array): Promise<boolean> {
    const safeName = name.replace(/\\/g, '/')
    if (this.names.has(safeName)) return false
    this.names.add(safeName)
    const raw = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data)
    const { data: packed, method } = packEntry(raw)
    const crc = crc32(raw)
    const nameBuf = Buffer.from(safeName, 'utf8')
    const entryOffset = this.offset
    await this.write(Buffer.concat([
      u32(0x04034b50), u16(20), u16(0), u16(method), u16(0), u16(0),
      u32(crc), u32(packed.length), u32(packed.length), u16(nameBuf.length), u16(0),
      nameBuf,
    ]))
    await this.write(packed)
    this.centrals.push(Buffer.concat([
      u32(0x02014b50), u16(20), u16(20), u16(0), u16(method), u16(0), u16(0),
      u32(crc), u32(packed.length), u32(packed.length), u16(nameBuf.length), u16(0), u16(0), u16(0), u16(0),
      u32(0), u32(entryOffset), nameBuf,
    ]))
    return true
  }

  /**
   * 写中央目录与 EOCD 并关闭文件。
   *
   * 非 ZIP64：偏移或长度超过 4GiB 时明确报错，而不是产出一个损坏的归档。
   */
  /** 诊断：写流上的监听器总数。背压等待不应累积监听器（曾经的泄漏点）。 */
  get listenerCount(): number {
    return this.out.listenerCount('drain') + this.out.listenerCount('close') + this.out.listenerCount('error')
  }

  async close(): Promise<void> {
    if (this.closed) return
    // 已经 abort 过就不能再 close：流已 destroy，写入会挂起（评审实测 >3s 无响应）。
    // 注意顺序：ZIP64 判定必须在置 closed 之前 —— abort() 对 closed 的实例是空操作，
    // 先置 closed 会让这条失败路径既不 destroy 也不删文件（评审实测：文件残留、
    // destroyed=false 句柄泄漏，且再调 close() 还会静默返回成功）。
    if (this.aborted) throw new Error('归档已中止，不能再 close')
    const centralStart = this.offset
    const central = Buffer.concat(this.centrals)
    if (centralStart + central.length >= 0xffffffff) {
      // 用 >= 而不是 >：偏移恰好等于 0xFFFFFFFF 时，该值在 ZIP 里是 ZIP64 的哨兵值，
      // 会被读取方当成「需要 ZIP64 中央目录」而解析失败。
      await this.abort()
      throw new Error('归档超过 4GiB，当前实现不支持 ZIP64；请分批导出')
    }
    this.closed = true
    const eocd = Buffer.concat([
      u32(0x06054b50), u16(0), u16(0), u16(this.centrals.length), u16(this.centrals.length),
      u32(central.length), u32(centralStart), u16(0),
    ])
    await this.write(central)
    await this.write(eocd)
    this.out.end()
    await once(this.out, 'close')
  }

  /**
   * 中止：关流并删除半成品文件（失败路径必须调用，否则留下截断的归档）。
   *
   * 幂等；对已 close 的归档是**空操作** —— 否则出错后的 catch 会把一个已经成功
   * 落盘的归档删掉（评审实测复现过：close 之后再 abort，文件被 DELETED）。
   */
  async abort(): Promise<void> {
    if (this.closed) return
    if (this.aborted) return
    this.aborted = true
    try {
      this.out.destroy()
    } catch {
      /* 已关闭 */
    }
    try {
      await fsp.rm(this.filePath, { force: true })
    } catch {
      /* 删不掉不致命 */
    }
  }
}
