/**
 * 诊断日志（<userData>/wechat/logs/app.log）增量读取。
 *
 * 为什么从日志里取：后端 worker 是独立的 utilityProcess，主进程/渲染层都看不到它的
 * 内部计数。它自己写进诊断日志的几条打点，是本 harness 唯一无需改产品代码就能拿到的
 * 后端侧缓存/内存证据：
 *   · `[mem] rss=…`       —— worker 每 60s 自报内存（W3-1.2 内存哨兵）
 *   · `[wechat] 慢调用 …` —— 后端调用 >1000ms 的慢调用（`SLOW_LOG_MS`，见 wechat-host.js）
 *   · `[cover-trace] …`   —— 远程封面缓存的分层命中计数（内存/落盘图/落盘无封面/出网）
 *   · `[prewarm] …`       —— 启动预热（分片数 / fts 命中）
 *   · `[renderer] [error]` —— 渲染层 console error（掉帧/异常侧写）
 *
 * 注意：日志行里可能有会话名/路径等真实数据，本采集器**只提取数字字段与计数**，
 * 不把原始行写进基线 JSON（`raw` 一律不落盘）。
 */

import { open } from 'node:fs/promises'

const MARKERS = [
  ['mem', /\[mem\] rss=/g],
  ['memWarn', /\[mem-warn\]/g],
  ['prewarm', /\[prewarm\]/g],
  ['snsPrewarmFail', /\[sns-prewarm\] 预热失败/g],
  ['coverTrace', /\[cover-trace\]/g],
  ['snsImageMiss', /\[sns-image\] .*失败/g],
  ['slowCall', /\[wechat\] 慢调用 /g],
  ['rendererError', /\[renderer\] \[error\]/g],
  ['wechatSync', /\[wechat-sync\] updated:/g],
  ['queueReject', /REMOTE_BUSY|QUEUE_WAIT_TIMEOUT/g],
  ['bootPhase', /\[boot-phase\]/g],
]

/** 把日志里的 "123MB"/"1.2GB" 换成 MB 数值。 */
function toMb (value, unit) {
  const n = Number(value)
  if (!Number.isFinite(n)) return null
  return unit === 'GB' ? Math.round(n * 1024) : Math.round(n)
}

export class LogTail {
  /** @param {string} path */
  constructor (path) {
    this.path = path
    this.offset = 0
    this.partial = ''
    this.error = null
    /** 各 marker 的累计计数（跨整个运行）。 */
    this.totals = {}
    for (const [name] of MARKERS) this.totals[name] = 0
    /** 累计的慢调用（method, ms）。 */
    this.slowCalls = []
    /** 累计的 worker 自报内存（MB）。 */
    this.memSamples = []
    /** 累计读取行数。 */
    this.lines = 0
    /** 启动分段（`[boot-phase] <label> t=<ms>`，按出现顺序；探针打点见 wechat-worker/host/supervisor）。 */
    this.bootPhases = []
  }

  /** 读自上次以来的新增内容并解析；返回本次增量（不抛错）。 */
  async readDelta () {
    const delta = { lines: 0, markers: {}, slowCalls: [], memSamples: [], bootPhases: [], bytes: 0 }
    let handle
    try {
      handle = await open(this.path, 'r')
      const st = await handle.stat()
      if (st.size <= this.offset) return delta
      const length = st.size - this.offset
      const buf = Buffer.alloc(length)
      await handle.read(buf, 0, length, this.offset)
      this.offset = st.size
      delta.bytes = length
      const text = this.partial + buf.toString('utf8')
      const lines = text.split(/\r?\n/)
      this.partial = lines.pop() ?? ''
      for (const line of lines) {
        if (line === '') continue
        delta.lines += 1
        this.lines += 1
        for (const [name, re] of MARKERS) {
          const n = (line.match(re) ?? []).length
          if (n > 0) { this.totals[name] += n; delta.markers[name] = (delta.markers[name] ?? 0) + n }
        }
        const mem = line.match(/\[mem\] rss=([\d.]+)(MB|GB) heapUsed=([\d.]+)(MB|GB) heapTotal=([\d.]+)(MB|GB) external=([\d.]+)(MB|GB)(?: arrayBuffers=([\d.]+)(MB|GB))?/)
        if (mem) {
          const sample = {
            rssMb: toMb(mem[1], mem[2]),
            heapUsedMb: toMb(mem[3], mem[4]),
            heapTotalMb: toMb(mem[5], mem[6]),
            externalMb: toMb(mem[7], mem[8]),
          }
          if (mem[9] !== undefined) sample.arrayBuffersMb = toMb(mem[9], mem[10])
          // 受控缓存占用（worker 哨兵拼在行尾的 `caches=label=当前/上限,…`）。
          const caches = line.match(/caches=(\S+)/)
          if (caches) sample.caches = caches[1]
          this.memSamples.push(sample)
          if (this.memSamples.length > 500) this.memSamples.shift()
          delta.memSamples.push(sample)
        }
        const slow = line.match(/\[wechat\] 慢调用 (\S+) 耗时 (\d+)ms/)
        if (slow) {
          const call = { method: slow[1], ms: Number(slow[2]) }
          this.slowCalls.push(call)
          if (this.slowCalls.length > 500) this.slowCalls.shift()
          delta.slowCalls.push(call)
        }
        const boot = line.match(/\[boot-phase\] (\S+) t=(\d+)/)
        if (boot) {
          const phase = { label: boot[1], t: Number(boot[2]) }
          this.bootPhases.push(phase)
          if (this.bootPhases.length > 200) this.bootPhases.shift()
          delta.bootPhases.push(phase)
        }
      }
    } catch (e) {
      this.error = String(e.message || e).slice(0, 160)
    } finally {
      if (handle) { try { await handle.close() } catch { /* ignore */ } }
    }
    return delta
  }

  /** 当前累计快照（不含原始日志文本）。 */
  snapshot () {
    return {
      path: this.path,
      lines: this.lines,
      totals: { ...this.totals },
      lastMemSample: this.memSamples.length > 0 ? this.memSamples[this.memSamples.length - 1] : null,
      memSampleCount: this.memSamples.length,
      slowCalls: this.slowCalls.slice(-20),
      slowCallCount: this.slowCalls.length,
      bootPhases: this.bootPhases.slice(-60),
      error: this.error,
    }
  }
}
