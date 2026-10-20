/**
 * 调用闸优先级的分类判据。
 *
 * 只钉三条不变式：交互读/取消动作排最前、长任务排最后、未知方法回普通档。
 * 其余分类靠 `remote-policy` 自己的「长任务台账 == 真实方法面」判据守住。
 * @vitest-environment node
 */
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const {
  INTERACTIVE_METHODS,
  HEAVY_PRIORITY,
  INTERACTIVE_PRIORITY,
  NORMAL_PRIORITY,
  OFFLINE_HEAVY_METHODS,
  QUEUE_BYPASS_METHODS,
  shouldBypassCallQueue,
  downgradeHeavyByArgs,
  callPriorityFor,
} = require('../call-priority.js') as {
  INTERACTIVE_METHODS: ReadonlySet<string>
  HEAVY_PRIORITY: number
  INTERACTIVE_PRIORITY: number
  NORMAL_PRIORITY: number
  OFFLINE_HEAVY_METHODS: ReadonlySet<string>
  QUEUE_BYPASS_METHODS: ReadonlySet<string>
  shouldBypassCallQueue: (method: unknown) => boolean
  downgradeHeavyByArgs: (method: unknown, args: unknown) => boolean
  callPriorityFor: (method: unknown, args?: unknown) => number
}

describe('callPriorityFor', () => {
  it('首屏读与取消动作进交互档', () => {
    expect(INTERACTIVE_METHODS.size).toBeGreaterThan(0)
    expect(callPriorityFor('getSessions')).toBe(INTERACTIVE_PRIORITY)
    expect(callPriorityFor('getOverview')).toBe(INTERACTIVE_PRIORITY)
    expect(callPriorityFor('cancelExportJob')).toBe(INTERACTIVE_PRIORITY)
  })

  it('RPC 长窗口台账里的方法进重活档', () => {
    expect(callPriorityFor('exportAllSessions')).toBe(HEAVY_PRIORITY)
    expect(callPriorityFor('fetchOriginalImagesBatch')).toBe(HEAVY_PRIORITY)
    expect(callPriorityFor('askWechat')).toBe(HEAVY_PRIORITY)
  })

  it('未知/非字符串方法回普通档（不猜测）', () => {
    expect(callPriorityFor('noSuchRemoteMethod')).toBe(NORMAL_PRIORITY)
    expect(callPriorityFor(null)).toBe(NORMAL_PRIORITY)
    expect(callPriorityFor(undefined)).toBe(NORMAL_PRIORITY)
  })

  /**
   * 在线取图降级（2026-10-16 首次，2026-10-19 本地优先后放宽）。
   *
   * 真机依据（2026-10-16）：并发发 10 张朋友圈图，前 5 张 32/61/435/614/646ms
   * **串行累加**，后 5 张 29ms **全部 `重任务排队已满`** —— 因为重活车道只有
   * `heavyLimit = concurrency - 1 = 1`，而 `HEAVY_QUEUE_MAX = 4`。
   *
   * 2026-10-19：朋友圈取图改成「本地优先」后，在线路径会先查长期归档/解码缓存，
   * 缺 CDN 三件套也不该再按 12–21s 的重活占 1+4 车道；只有**无网**才保持重活。
   */
  describe('按入参降级（在线取图不占重活名额）', () => {
    /** 在线 + 三件套齐 ⇒ 后端优先走本地归档/CDN。 */
    const cdnArgs = { offline: false, url: 'http://x/0', token: 't', seed: 's' }

    it('名单里的方法在在线时降到普通档（含缺三件套的老数据）', () => {
      expect(OFFLINE_HEAVY_METHODS.size).toBeGreaterThan(0)
      expect(callPriorityFor('getSnsImageDataUrl', cdnArgs)).toBe(NORMAL_PRIORITY)
      expect(callPriorityFor('getSnsVideoCoverDataUrl', cdnArgs)).toBe(NORMAL_PRIORITY)
      // 本地优先后：即使缺 CDN 三件套，在线也先查归档/缓存，不再按重活排队。
      expect(callPriorityFor('getSnsImageDataUrl', { offline: false })).toBe(NORMAL_PRIORITY)
      expect(callPriorityFor('getSnsImageDataUrl', { offline: false, url: 'http://x/0' })).toBe(NORMAL_PRIORITY)
      expect(callPriorityFor('getSnsImageDataUrl', { offline: false, url: 'http://x/0', token: 't' })).toBe(NORMAL_PRIORITY)
    })

    it('无网时仍是重活档（那条路是 12–21s 的 CPU 密集解密）', () => {
      expect(callPriorityFor('getSnsImageDataUrl', { ...cdnArgs, offline: true })).toBe(HEAVY_PRIORITY)
      expect(callPriorityFor('getSnsVideoCoverDataUrl', { ...cdnArgs, offline: true })).toBe(HEAVY_PRIORITY)
    })

    it('入参缺失/不是对象时**不降级**（宁可保守当重活，也不让无网解密堵住交互请求）', () => {
      expect(callPriorityFor('getSnsImageDataUrl')).toBe(HEAVY_PRIORITY)
      expect(callPriorityFor('getSnsImageDataUrl', null)).toBe(HEAVY_PRIORITY)
      expect(callPriorityFor('getSnsImageDataUrl', 'x')).toBe(HEAVY_PRIORITY)
    })

    it('名单外的方法不受影响（降级只对白名单生效）', () => {
      expect(downgradeHeavyByArgs('exportAllSessions', cdnArgs)).toBe(false)
      expect(callPriorityFor('exportAllSessions', cdnArgs)).toBe(HEAVY_PRIORITY)
      expect(callPriorityFor('askWechat', cdnArgs)).toBe(HEAVY_PRIORITY)
    })

    it('降级名单必须是长任务台账的子集（否则这条判据在空转）', () => {
      for (const m of OFFLINE_HEAVY_METHODS) {
        expect(callPriorityFor(m, { offline: true }), `${m} 不在长任务台账里`).toBe(HEAVY_PRIORITY)
      }
    })
  })
})

/**
 * 免排队通道（2026-10-18）：世界地图底图本地优先读随包 GeoJSON，毫秒级、
 * 不占 worker CPU / 数据库时间；启动瞬间排队满时若被 REMOTE_BUSY 拒绝，
 * 界面会误报「底图不可用」（真机复现，同一时刻直连返回 239 个 feature）。
 */
describe('shouldBypassCallQueue', () => {
  it('世界地图底图与地区快照免排队；普通/未知方法仍排队', () => {
    expect(QUEUE_BYPASS_METHODS.size).toBeGreaterThan(0)
    expect(shouldBypassCallQueue('getMapGeoJson')).toBe(true)
    expect(shouldBypassCallQueue('getRegionMap')).toBe(true)
    expect(shouldBypassCallQueue('getSessions')).toBe(false)
    expect(shouldBypassCallQueue('noSuchMethod')).toBe(false)
  })

  it('非字符串不误判', () => {
    expect(shouldBypassCallQueue(null)).toBe(false)
    expect(shouldBypassCallQueue(undefined)).toBe(false)
  })
})
