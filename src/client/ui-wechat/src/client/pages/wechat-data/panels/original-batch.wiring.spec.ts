/**
 * 「联网补齐原图」的接线守卫（源码锚点，先剥注释；断言都是精确切片，不用「锚点往后 N 字符」的窗口）。
 *
 * 钉的都是「接错了也不报错」的地方：
 *   ① 两个客户端包装必须是**透传**且**不走结果缓存** —— 盘点要反映「此刻」，
 *      取回是一次改变本机状态的动作（缓存返回值会让第二次点击什么都不做）；
 *   ② 取回成功后必须清图片内存 LRU：那份缓存全应用共用、跨面板不失效，不清的话
 *      用户切回会话首帧仍是旧缩略图，「取回成功」看起来像没发生；
 *   ③ 被开关/总闸拦下时（`blocked`）必须**如实显示那句话**，不许当成成功；
 *   ④ 报告里那句「只能靠回微信点开」是这个功能唯一的「为什么拿不到」出口，不能被删。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
const strip = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
const read = (rel: string): string => strip(readFileSync(join(HERE, rel), 'utf8')).replace(/\r\n/g, '\n')

const state = read('./settings-state.tsx')
const steps = read('./settings-steps.tsx')
const settings = read('./Settings.tsx')
const api = read('../api-media.ts')
const core = read('../api-core.ts')

/** 从 `from` 锚点切到 `to` 锚点之间的片段（两端锚点都必须存在且唯一）。 */
function sliceBetween(text: string, from: string, to: string, label: string): string {
  const a = text.indexOf(from)
  expect(a, `${label}：找不到起点锚点（改名时请同步本用例）`).toBeGreaterThan(-1)
  const b = text.indexOf(to, a)
  expect(b, `${label}：找不到终点锚点`).toBeGreaterThan(a)
  return text.slice(a, b)
}

describe('联网补齐原图 · 客户端接线', () => {
  const fetchFn = sliceBetween(state, 'const fetchOriginals = ', '\n  const upgradeImgs', 'fetchOriginals 回调体')
  const scanFn = sliceBetween(state, 'const scanOriginals = ', '\n  const fetchOriginals', 'scanOriginals 回调体')

  it('① 扫描/取回各调一个后端入口，取回带 limit', () => {
    expect(scanFn.includes('apiPlanOriginalFetch('), '扫描走盘点接口').toBe(true)
    expect(fetchFn.includes('apiFetchOriginalImagesBatch('), '取回走批量接口').toBe(true)
    expect(/apiFetchOriginalImagesBatch\(\{ limit: origLimit \}\)/.test(fetchFn), '要把上限传下去').toBe(true)
  })

  it('② 取回成功（>0 张）后清图片内存缓存；被拦下时如实显示 blocked', () => {
    expect(/if \(r\.fetched > 0\) forgetAllImages\(\)/.test(fetchFn),
      '取回成功后必须清一次全应用共用的图片内存缓存（否则首帧还是旧缩略图）').toBe(true)
    expect(/if \(r\.blocked !== undefined\) \{[\s\S]{0,120}notify\('err', r\.blocked\)/.test(fetchFn),
      '被开关/总闸拦下时要显示后端那句话，不许假装成功').toBe(true)
  })

  it('③ 取回后重新盘点（否则第二次点会看到过期数字）', () => {
    expect(fetchFn.includes('setOrigPlan(await apiPlanOriginalFetch())'), '取回后要刷新盘点').toBe(true)
  })

  it('④ 两个包装都不走结果缓存', () => {
    for (const [name, call] of [['apiPlanOriginalFetch', 'planOriginalFetch()'], ['apiFetchOriginalImagesBatch', 'fetchOriginalImagesBatch(options)']] as const) {
      const w = api.indexOf('export async function ' + name)
      expect(w, `找不到 ${name} —— 改名时请同步本用例`).toBeGreaterThan(-1)
      const body = api.slice(w, api.indexOf('\n}', w))
      expect(body.includes(call), `${name} 必须是透传`).toBe(true)
      expect(body.includes('cachedGet'), `${name} 不该走结果缓存`).toBe(false)
    }
  })

  it('⑤ 镜像接口两条都在（漏了 client typecheck 会在调用处报错）', () => {
    expect(core.includes('planOriginalFetch(): Promise<RemoteResult<OriginalFetchPlan>>')).toBe(true)
    expect(/fetchOriginalImagesBatch\(options\?: \{ limit\?: number; concurrency\?: number \}\)/.test(core)).toBe(true)
  })

  it('⑥ 卡片里有「联网补齐原图」的入口、报告与进度块', () => {
    const section = sliceBetween(steps, 'export function SettingsImgDecodeSection', 'export interface SettingsVoiceSectionProps', '图片解码卡片')
    const props = sliceBetween(steps, 'export interface SettingsImgDecodeSectionProps', 'export function SettingsImgDecodeSection', '卡片道具')
    expect(section.includes('联网补齐原图'), '入口标题').toBe(true)
    expect(section.includes('void scanOriginals()'), '扫描按钮要接上回调').toBe(true)
    expect(section.includes('void fetchOriginals()'), '取回按钮要接上回调').toBe(true)
    expect(section.includes('只能靠回微信点开'), '报告必须说清「剩下那些为什么拿不到」').toBe(true)
    expect(props.includes('origPlan: OriginalFetchPlan | null')).toBe(true)
    expect(settings.includes('origPlan={origPlan}')).toBe(true)
    expect(settings.includes('fetchOriginals={fetchOriginals}')).toBe(true)
  })
})
