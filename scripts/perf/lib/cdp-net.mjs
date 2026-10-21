/**
 * CDP Network 采集器。
 *
 * 为什么不用 `performance.getEntriesByType('resource')`：实测本仓库渲染层在该 Electron
 * 配置下（sandbox:true + file:// 文档）Resource Timing 恒返回 0 条 —— 连文档自己的
 * `assets/*.js` 与 `wechat-media://` 图片都不进条目。CDP Network 域能看到同一批请求
 * （file:// 的 Script/Stylesheet、自定义协议、http(s)），因此本采集器作为资源加载时长的
 * **等价量具**；报告里会同时给出两者的读数与差异原因。
 *
 * 事件三件套：requestWillBeSent → （responseReceived）→ loadingFinished/loadingFailed。
 */

const SCHEME_KEYS = ['file:', 'wechat-media:', 'http:', 'https:', 'data:', 'blob:', 'devtools:', 'other']

/** 从 URL 提取协议桶（未知形态归到 other）。 */
function schemeOf (url) {
  try {
    const u = new URL(url)
    return SCHEME_KEYS.includes(u.protocol) ? u.protocol : u.protocol || 'other'
  } catch {
    return 'other'
  }
}

export class CdpNetwork {
  /**
   * @param {import('playwright').CDPSession} session
   */
  constructor (session) {
    this.session = session
    this.inflight = new Map()
    this.counters = {
      requests: 0,
      finished: 0,
      failed: 0,
      byScheme: {},
      byType: {},
      status: {},
      fromDiskCache: 0,
      fromMemoryCache: 0,
      encodedBytes: 0,
      encodedBytesByScheme: {},
      redirects: 0,
    }
    /** 已完成请求的时延日志（seq 单调，用于按游标取增量）。 */
    this.durations = []
    this.seq = 0
    this._bind()
  }

  _inc (map, key) { map[key] = (map[key] || 0) + 1 }

  _bind () {
    this.session.on('Network.requestWillBeSent', (e) => {
      const url = e?.request?.url ?? ''
      const scheme = schemeOf(url)
      this._inc(this.counters.byScheme, scheme)
      this._inc(this.counters.byType, e?.type ?? 'other')
      this.counters.requests += 1
      if (e?.redirectResponse) this.counters.redirects += 1
      this.inflight.set(e.requestId, { url, scheme, type: e.type ?? 'other', ts: e.timestamp, redirected: Boolean(e.redirectResponse) })
    })
    this.session.on('Network.responseReceived', (e) => {
      const rec = this.inflight.get(e.requestId)
      const status = e?.response?.status
      if (rec) rec.status = status
      if (typeof status === 'number') this._inc(this.counters.status, String(status))
      if (e?.response?.fromDiskCache) this.counters.fromDiskCache += 1
      if (e?.response?.fromMemoryCache) this.counters.fromMemoryCache += 1
      if (rec) rec.response = { fromDiskCache: Boolean(e?.response?.fromDiskCache), fromMemoryCache: Boolean(e?.response?.fromMemoryCache), protocol: e?.response?.protocol }
    })
    this.session.on('Network.loadingFinished', (e) => {
      this.counters.finished += 1
      const bytes = Number(e?.encodedDataLength) || 0
      this.counters.encodedBytes += bytes
      const rec = this.inflight.get(e.requestId)
      this.inflight.delete(e.requestId)
      if (!rec) return
      this.counters.encodedBytesByScheme[rec.scheme] = (this.counters.encodedBytesByScheme[rec.scheme] || 0) + bytes
      const ms = Math.max(0, (e.timestamp - rec.ts) * 1000)
      this.seq += 1
      // data: URL 的"尾部"就是图片字节（base64），不属于可报告的定位信息 —— 只留占位符，
      // 避免把用户头像/图片片段写进基线 JSON 与报告。
      const urlTail = rec.scheme === 'data:' ? '<data-url>' : rec.url.slice(-70)
      this.durations.push({ seq: this.seq, ms, scheme: rec.scheme, type: rec.type, status: rec.status ?? null, urlTail })
      if (this.durations.length > 8000) this.durations.splice(0, this.durations.length - 8000)
    })
    this.session.on('Network.loadingFailed', (e) => {
      this.counters.failed += 1
      const rec = this.inflight.get(e.requestId)
      this.inflight.delete(e.requestId)
      if (!rec) return
      this.seq += 1
      const urlTail = rec.scheme === 'data:' ? '<data-url>' : rec.url.slice(-70)
      this.durations.push({ seq: this.seq, ms: 0, scheme: rec.scheme, type: rec.type, status: null, urlTail, failed: true })
      if (this.durations.length > 8000) this.durations.splice(0, this.durations.length - 8000)
    })
  }

  /** 当前累计计数 + 游标（seq）。 */
  mark () {
    return {
      seq: this.seq,
      requests: this.counters.requests,
      finished: this.counters.finished,
      failed: this.counters.failed,
      byScheme: { ...this.counters.byScheme },
      byType: { ...this.counters.byType },
      status: { ...this.counters.status },
      fromDiskCache: this.counters.fromDiskCache,
      fromMemoryCache: this.counters.fromMemoryCache,
      encodedBytes: this.counters.encodedBytes,
      encodedBytesByScheme: { ...this.counters.encodedBytesByScheme },
      inflight: this.inflight.size,
    }
  }

  /**
   * 相对游标的增量。`mark()` 前后各调一次即可得到一轮（面板/滚动）的请求画像。
   * @param {ReturnType<CdpNetwork['mark']>} before
   */
  deltaSince (before) {
    const now = this.mark()
    const dur = this.durations.filter((d) => d.seq > before.seq)
    const ok = dur.filter((d) => !d.failed).map((d) => d.ms).sort((a, b) => a - b)
    const pick = (q) => (ok.length === 0 ? 0 : ok[Math.min(ok.length - 1, Math.max(0, Math.ceil(ok.length * q) - 1))])
    const bySchemeDelta = {}
    for (const k of new Set([...Object.keys(before.byScheme), ...Object.keys(now.byScheme)])) {
      const d = (now.byScheme[k] || 0) - (before.byScheme[k] || 0)
      if (d !== 0) bySchemeDelta[k] = d
    }
    const byTypeDelta = {}
    for (const k of new Set([...Object.keys(before.byType), ...Object.keys(now.byType)])) {
      const d = (now.byType[k] || 0) - (before.byType[k] || 0)
      if (d !== 0) byTypeDelta[k] = d
    }
    const statusDelta = {}
    for (const k of new Set([...Object.keys(before.status), ...Object.keys(now.status)])) {
      const d = (now.status[k] || 0) - (before.status[k] || 0)
      if (d !== 0) statusDelta[k] = d
    }
    const slowest = dur.filter((d) => !d.failed).sort((a, b) => b.ms - a.ms).slice(0, 5)
    /** 按协议分别给时延与字节（file: 是本地 chunk/资源，data:/wechat-media: 是图片解码链路，http(s) 是出网）。 */
    const bySchemeDetail = {}
    for (const scheme of SCHEME_KEYS) {
      const xs = dur.filter((d) => d.scheme === scheme && !d.failed).map((d) => d.ms).sort((a, b) => a - b)
      if (xs.length === 0) continue
      const pk = (q) => Math.round(xs[Math.min(xs.length - 1, Math.max(0, Math.ceil(xs.length * q) - 1))] * 10) / 10
      bySchemeDetail[scheme] = {
        count: xs.length,
        p50Ms: pk(0.5),
        p95Ms: pk(0.95),
        maxMs: Math.round(xs[xs.length - 1] * 10) / 10,
        encodedBytes: (now.encodedBytesByScheme?.[scheme] ?? 0) - (before.encodedBytesByScheme?.[scheme] ?? 0),
      }
    }
    return {
      requests: now.requests - before.requests,
      finished: now.finished - before.finished,
      failed: now.failed - before.failed,
      byScheme: bySchemeDelta,
      byType: byTypeDelta,
      status: statusDelta,
      fromDiskCache: now.fromDiskCache - before.fromDiskCache,
      fromMemoryCache: now.fromMemoryCache - before.fromMemoryCache,
      encodedBytes: now.encodedBytes - before.encodedBytes,
      bySchemeDetail,
      inflightAtEnd: now.inflight,
      duration: {
        count: ok.length,
        p50Ms: Math.round(pick(0.5) * 10) / 10,
        p95Ms: Math.round(pick(0.95) * 10) / 10,
        maxMs: ok.length === 0 ? 0 : Math.round(ok[ok.length - 1] * 10) / 10,
      },
      slowest: slowest.map((d) => ({ ms: Math.round(d.ms * 10) / 10, scheme: d.scheme, type: d.type, status: d.status, urlTail: d.urlTail })),
    }
  }
}
