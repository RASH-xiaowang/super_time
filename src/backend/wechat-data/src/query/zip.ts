/**
 * Minimal ZIP writer (no external deps): STORE method with deflate via
 * node:zlib, used for .xlsx (OOXML) and export ZIP packaging.
 *
 * 三种用法，按输出规模选：
 *   · `zipFiles(entries)`          —— 全部内容已在内存里时用（小 xlsx、单会话打包）。
 *   · `ZipFileWriter.addFile`      —— 内容需要**现场产出**、但单条内容可以整块拿到时用。
 *   · `ZipFileWriter.addStream`    —— 单条内容**本身**就大到不能整块持有（10 万行 xlsx）：
 *     调用方给一个分块源，压缩结果先落临时文件，峰值 = 一块 + 一个句柄。
 *
 * 为什么要流式：整账号归档（exportAllSessions）最多 1000 个会话、每个最多 5 万条，
 * 原实现把每个会话的文本全堆进 entries、再由 zipFiles 一次性 concat，
 * 最坏情形常驻数 GB，且全程同步压缩/写盘会把承载全部查询的后端进程钉住。
 *
 * `ZipFileWriter` 与 `zipFiles` 对同一组条目产出**逐字节相同**的输出
 * （同样的本地头、同样的 STORE/DEFLATE 选择、同样的中央目录与 EOCD 顺序），
 * 由 tests/export-zip.spec.ts 断言，避免「换成流式后归档格式悄悄变了」。
 * `addStream` 用的是同一种归档格式（本地头里写真实长度，不引入 data descriptor），
 * 但压缩块边界与整块 deflate 不同，所以只保证**解出来的条目内容**一致（由
 * tests/export-stream.spec.ts 断言）。
 */
import { createReadStream, createWriteStream, promises as fsp } from 'node:fs'
import type { WriteStream } from 'node:fs'
import { once } from 'node:events'
import { Readable } from 'node:stream'
import { finished } from 'node:stream/promises'
import { pipeline } from 'node:stream/promises'
import { createDeflateRaw, deflateRawSync } from 'node:zlib'

/** STORE：不压缩。 */
const METHOD_STORE = 0
/**
 * DEFLATE：流式条目的唯一选择。
 *
 * 为什么不沿用「压缩不比原文短就用 STORE」的判据：那个判据要在写本地头**之前**
 * 比较两种编码的长度，而流式路径在写完之前拿不到压缩长度。为了不引入 data descriptor
 * （会改归档格式），流式条目无条件用 DEFLATE —— 对文本型内容（xlsx 的 XML）压缩率
 * 极高，选错的代价只是几字节。
 */
const METHOD_DEFLATE = 8

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

/**
 * 整块 CRC32（导出/测试用来校验归档里的条目）。
 * @param buf - 待计算的数据。
 * @returns CRC32 值。
 */
export function crc32(buf: Buffer): number {
  return crc32Finish(crc32Update(crc32Start(), buf))
}

/** 块大小：流式条目的内存上界由它决定（压缩结果先落临时文件再拷进归档）。 */
const COPY_CHUNK_SIZE = 64 * 1024

/**
 * 进度事件（导出/备份这类长耗时环节共用）。
 *
 * `total = 0` 表示总量未知 —— 只有流式环节才会这样（压缩/写盘过程中算不出总字节数），
 * 调用方据此显示「不定量进度」而不是把它当成 0%。
 */
export interface StreamProgress {
  /** 阶段标识：collect | sessions | format | compress | write | media | files。 */
  phase: string
  /** 已完成量（条/行/字节，按 phase 而定）。 */
  done: number
  /** 总量；0 = 未知。 */
  total: number
}

/** 导出/备份入口的可选控制参数：进度上报 + 取消。 */
export interface StreamControl {
  onProgress?: (p: StreamProgress) => void
  /** 取消令牌；aborted 后各入口会尽快中止并清理半成品。 */
  signal?: AbortSignal
}

/**
 * 取消（与普通失败区分：调用方据此决定「用户取消」不该弹错误框）。
 * `name` 用 'AbortError' 与平台惯例一致。
 */
export class CancelledError extends Error {
  constructor(message = '操作已取消') {
    super(message)
    this.name = 'AbortError'
  }
}

/**
 * 已取消就抛错（在各耗时循环的边界调用）。
 * @param signal - 取消令牌。
 */
export function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new CancelledError()
}

/**
 * 上报一次进度。
 *
 * 回调由调用方（RPC 层/前端）提供，**它自己抛错不该让导出失败** —— 否则前端一个
 * 进度条 bug 就能把用户的导出搞挂；事件尽力而为（与 gateway 的 delta 推送同策略）。
 * @param ctrl - 控制参数（可缺省）。
 * @param phase - 阶段标识。
 * @param done - 已完成量。
 * @param total - 总量（0 = 未知）。
 */
export function reportProgress(ctrl: StreamControl | undefined, phase: string, done: number, total: number): void {
  try {
    ctrl?.onProgress?.({ phase, done, total })
  } catch {
    /* 进度是通知，不是契约 */
  }
}

/**
 * 原子落地用的临时文件名。
 *
 * 带进程内自增序号，不只是 pid：改成 async 之后同一进程里两个同名导出可以并发交错，
 * 只用 pid 的话两次导出会抢同一个临时文件、互相写坏。
 * @param filePath - 最终目标路径。
 * @returns 同目录下的临时路径（`.partial-<pid>-<seq>` 后缀，便于残留检查）。
 */
let partialSeq = 0
export function partialPath(filePath: string): string {
  partialSeq += 1
  return filePath + '.partial-' + String(process.pid) + '-' + String(partialSeq)
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
  return deflated.length >= raw.length ? { data: raw, method: METHOD_STORE } : { data: deflated, method: METHOD_DEFLATE }
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
 * 带背压与错误传播的文件沉降层。
 *
 * 为什么单独抽一层：ZIP 条目与加密备份（.wcb）都要「大块流式写文件 + 失败即中断 +
 * 不留半成品」，而这套写法被评审实测踩出两个坑（`drain` 掩盖 `error` 导致永久挂起、
 * `once()` 监听器累积）。复制第二份等于把坑复制第二份，所以两处共用这一份实现。
 */
export class StreamWriter {
  private readonly out: WriteStream
  private readonly filePath: string
  private offsetValue = 0
  private closedFlag = false
  private abortedFlag = false
  /** 写流报出的错误（见 write() 里「drain 掩盖 error」的说明）。 */
  private streamError: Error | null = null

  private constructor(filePath: string, out: WriteStream) {
    this.filePath = filePath
    this.out = out
  }

  /** 打开目标文件准备写入（覆盖已有文件）。 */
  static async create(filePath: string): Promise<StreamWriter> {
    const out = createWriteStream(filePath)
    const w = new StreamWriter(filePath, out)
    // 必须挂 error handler：写流在 destroy 或磁盘出错时会 emit 'error'，
    // 无人监听会升级成未捕获异常。但**光挂 handler 不够** —— 见 streamError 的说明。
    out.on('error', (e: Error) => {
      if (!w.streamError) w.streamError = e
    })
    // 等 open 完成，让「打不开文件」这类错误在这里就暴露，而不是第一条写入时。
    await once(out, 'open')
    return w
  }

  /** 已写入的字节数。 */
  get offset(): number {
    return this.offsetValue
  }

  /** 是否已正常收尾（end 之后 abort 是空操作）。 */
  get closed(): boolean {
    return this.closedFlag
  }

  /** 是否已中止。 */
  get aborted(): boolean {
    return this.abortedFlag
  }

  /** 写流报出的错误（尚未抛出时调用方用它提前失败，而不是等一次写入再失败）。 */
  get failed(): Error | null {
    return this.streamError
  }

  /** 写流上的监听器总数（诊断用：背压等待不应累积监听器）。 */
  get listenerCount(): number {
    return this.out.listenerCount('drain') + this.out.listenerCount('close') + this.out.listenerCount('error')
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
  async write(buf: Buffer): Promise<void> {
    // 先查状态再等：destroy() 触发的 'close'/'error' 很可能**在我们挂 once 监听之前**
    // 就已经发出（abort 与随后的写入相隔一个 await），此时 once 永远等不到新事件 → 挂起。
    if (this.streamError) throw this.streamError
    if (this.abortedFlag || this.out.destroyed || this.out.writableEnded) {
      throw new Error('写入流已关闭，归档未完成')
    }
    this.offsetValue += buf.length
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
      if (this.streamError || this.abortedFlag || this.out.destroyed) onClose()
    })
  }

  /**
   * 收尾并关闭文件。
   *
   * 用 `finished()` 而不是 `once('close')`：后者对流**已经关闭**的情况会永远等下去。
   */
  async end(): Promise<void> {
    if (this.closedFlag) return
    if (this.abortedFlag) throw new Error('写入流已中止，不能再收尾')
    this.closedFlag = true
    this.out.end()
    await finished(this.out, { readable: false })
  }

  /**
   * 中止：关流并删除半成品文件（失败路径必须调用，否则留下截断的文件）。
   *
   * 幂等；对已收尾的写入是**空操作** —— 否则出错后的 catch 会把一个已经成功
   * 落盘的文件删掉（评审实测复现过：close 之后再 abort，成品被 DELETED）。
   */
  async abort(): Promise<void> {
    if (this.closedFlag || this.abortedFlag) return
    this.abortedFlag = true
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

/**
 * 逐条目写盘的 ZIP 写入器。
 *
 * 生命周期：`create()` → 若干 `addFile()`/`addStream()` → `close()`；任一步出错就
 * `abort()`（它会关流并删掉半成品文件，避免留下一个看起来完整、实际截断的归档）。
 */
export class ZipFileWriter {
  private readonly sink: StreamWriter
  private readonly filePath: string
  private readonly centrals: Buffer[] = []
  private readonly names = new Set<string>()
  private readonly entryTemps = new Set<string>()
  private entrySeq = 0
  private closed = false

  private constructor(filePath: string, sink: StreamWriter) {
    this.filePath = filePath
    this.sink = sink
  }

  /** 打开目标文件准备写入（覆盖已有文件）。 */
  static async create(filePath: string): Promise<ZipFileWriter> {
    const sink = await StreamWriter.create(filePath)
    return new ZipFileWriter(filePath, sink)
  }

  /** 当前写入偏移（中央目录里要记每个条目的起始位置）。 */
  private get offset(): number {
    return this.sink.offset
  }

  /** 诊断：写流上的监听器总数。背压等待不应累积监听器（曾经的泄漏点）。 */
  get listenerCount(): number {
    return this.sink.listenerCount
  }

  private write(buf: Buffer): Promise<void> {
    return this.sink.write(buf)
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
   * 追加一个「内容现场产出」的条目：分块做流式 deflate。
   *
   * 为什么需要它：`addFile` 要求整条内容的字节都在内存里（`deflateRawSync` 也要整块输入），
   * 所以 10 万行的 xlsx（sheet XML ≈ 10MB 以上、还要再叠上所有行数组）峰值仍与行数线性。
   * 这里把产出方给的分块**先流式压到临时文件**，拿到真实的 CRC/长度后再补本地头、
   * 分块拷进归档 —— 峰值只与「一块」相关，与条目总大小无关。
   *
   * 为什么不直接用 data descriptor 边压边写：那会改动归档格式（本地头里长度写 0 +
   * 置 bit 3），而 `zipFiles`/`addFile` 产出的格式不能被悄悄换掉。多一次磁盘往返
   * 只发生在流式条目上，换的是「格式不变」。
   *
   * @param name - 归档内路径（反斜杠会转成正斜杠）。
   * @param source - 分块源（字符串按 UTF-8，或字节）；可为同步/异步迭代器。
   * @param ctrl - 可选的进度/取消（每块都会检查取消）。
   * @returns 是否真的写入（同名条目会被跳过，与 zipFiles 行为一致）。
   */
  async addStream(
    name: string,
    source: Iterable<string | Uint8Array> | AsyncIterable<string | Uint8Array>,
    ctrl?: StreamControl,
  ): Promise<boolean> {
    const safeName = name.replace(/\\/g, '/')
    if (this.names.has(safeName)) return false
    this.names.add(safeName)
    if (this.closed) throw new Error('归档已收尾，不能再追加条目')
    if (this.sink.failed) throw this.sink.failed
    if (this.sink.aborted) throw new Error('归档已中止，不能再追加条目')
    this.entrySeq += 1
    const tmp = this.filePath + '.entry-' + String(this.entrySeq)
    this.entryTemps.add(tmp)
    let crc = crc32Start()
    let rawSize = 0
    try {
      // 局部变量在生成器里累加：闭包持有的是同一个绑定，pipeline 结束后即为终值。
      async function* raw(): AsyncGenerator<Buffer> {
        for await (const chunk of source) {
          throwIfCancelled(ctrl?.signal)
          const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : Buffer.from(chunk)
          crc = crc32Update(crc, buf)
          rawSize += buf.length
          reportProgress(ctrl, 'compress', rawSize, 0)
          yield buf
        }
      }
      await pipeline(Readable.from(raw(), { objectMode: false }), createDeflateRaw(), createWriteStream(tmp))
      const csize = (await fsp.stat(tmp)).size
      const crcFinal = crc32Finish(crc)
      const nameBuf = Buffer.from(safeName, 'utf8')
      const entryOffset = this.offset
      await this.write(Buffer.concat([
        u32(0x04034b50), u16(20), u16(0), u16(METHOD_DEFLATE), u16(0), u16(0),
        u32(crcFinal), u32(csize), u32(rawSize), u16(nameBuf.length), u16(0),
        nameBuf,
      ]))
      let copied = 0
      // 分块拷贝压缩结果，而不是一次 readFileSync：这就是「写盘也不随条目大小涨内存」。
      for await (const chunk of createReadStream(tmp, { highWaterMark: COPY_CHUNK_SIZE }) as AsyncIterable<Buffer>) {
        throwIfCancelled(ctrl?.signal)
        await this.write(chunk)
        copied += chunk.length
        reportProgress(ctrl, 'write', copied, csize)
      }
      this.centrals.push(Buffer.concat([
        u32(0x02014b50), u16(20), u16(20), u16(0), u16(METHOD_DEFLATE), u16(0), u16(0),
        u32(crcFinal), u32(csize), u32(rawSize), u16(nameBuf.length), u16(0), u16(0), u16(0), u16(0),
        u32(0), u32(entryOffset), nameBuf,
      ]))
      return true
    } finally {
      // 无论成功/失败都要删条目临时文件：卡在这里的残留会出现在用户的导出目录里。
      this.entryTemps.delete(tmp)
      try {
        await fsp.rm(tmp, { force: true })
      } catch {
        /* 删不掉不致命（下次导出也不会复用它） */
      }
    }
  }
  /**
   * 写中央目录与 EOCD 并关闭文件。
   *
   * 非 ZIP64：偏移或长度超过 4GiB 时明确报错，而不是产出一个损坏的归档。
   */
  async close(): Promise<void> {
    if (this.closed) return
    // 已经 abort 过就不能再 close：流已 destroy，写入会挂起（评审实测 >3s 无响应）。
    // 注意顺序：ZIP64 判定必须在置 closed 之前 —— abort() 对 closed 的实例是空操作，
    // 先置 closed 会让这条失败路径既不 destroy 也不删文件（评审实测：文件残留、
    // destroyed=false 句柄泄漏，且再调 close() 还会静默返回成功）。
    if (this.sink.aborted) throw new Error('归档已中止，不能再 close')
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
    await this.sink.end()
  }

  /**
   * 中止：关流并删除半成品文件（失败路径必须调用，否则留下截断的归档）。
   *
   * 幂等；对已 close 的归档是**空操作** —— 否则出错后的 catch 会把一个已经成功
   * 落盘的归档删掉（评审实测复现过：close 之后再 abort，文件被 DELETED）。
   */
  async abort(): Promise<void> {
    if (this.closed) return
    await this.sink.abort()
    // 流式条目中途留下的压缩临时文件也要一并清掉（它们和归档同目录，会被用户看到）。
    for (const tmp of this.entryTemps) {
      try {
        await fsp.rm(tmp, { force: true })
      } catch {
        /* 删不掉不致命 */
      }
    }
    this.entryTemps.clear()
  }
}
