/**
 * S07 · 「数据边界与出网」两个开关的端到端接线。
 *
 * ── 为什么需要它 ──────────────────────────────────────────────────────────
 * 一个开关要真的管用，得同时接上好几段，而**漏掉任何一段都不会报错**：
 * 类型里加了字段但没写进存储 → 开关永远是默认值（`setPrivacyState` 静默丢弃）；
 * 存储有了但快照没带出来 → 界面读不到，按钮点了没反应；
 * 界面有了但拉取点没判 → 开关是个摆设，用户以为关掉了、其实还在出网。
 *
 * 本文件按「从界面一路查到出网点」的顺序把这两条链钉住。
 *
 * ── 两个开关为什么形态不同 ────────────────────────────────────────────────
 *  · **地图底图** 是**渲染层直连**（jsDelivr / unpkg / 阿里 DataV），后端闸门看不到它，
 *    所以必须有一个独立的位 `blockMapTiles`，并在前端拉取点判它；
 *  · **语音模型下载** 在后端，复用了已有的 `blockOutbound` 总闸 —— 不新加字段，
 *    因为「禁止出网」本就该管一切出网，而它确实只是下**文件**（不发内容给模型），
 *    所以同时登记进 license 的 `NON_AI_OUTBOUND`（那张表就是给这类方法用的）。
 * @vitest-environment node
 */
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { atLeast, findRoot, readStripped, readText, sliceBetween } from '../../../test-helpers/wiring-kit.ts'

const HERE = import.meta.dirname
const ROOT = findRoot(HERE)
const r = (...p: string[]): string => readText(join(ROOT, ...p))
const BW = ['src', 'backend', 'wechat-data', 'src']
const CW = ['src', 'client', 'ui-wechat', 'src', 'client', 'pages', 'wechat-data']

describe('S07 · 地图底图开关（blockMapTiles）贯穿全链', () => {
  it('后端：类型声明 → 读 → 写 → 快照，四处都有这个键', () => {
    const types = r(...BW, 'types-ops.ts')
    expect(types, 'PrivacyStateSnapshot 没有 blockMapTiles').toMatch(/interface PrivacyStateSnapshot \{[^}]*blockMapTiles: boolean/)

    const store = r(...BW, 'query', 'privacy-audit.ts')
    // ⚠️ 必须**切片到 `readPrivacySettings` 体内**再断言（2026-09-26 实录）：
    // `blockMapTiles: getSetting(...)` 在 `writePrivacySettings` 里还有一份（它返回更新后的
    // 快照），只对全文匹配的话，把"读"这一处删掉正则照样能匹配上 —— 变异 M25 就是这么
    // "没咬住"的（工具报 [没咬住] 才发现）。
    const readFn = sliceBetween(store, 'export function readPrivacySettings', '\n}', 'readPrivacySettings')
    expect(readFn, 'readPrivacySettings 没读它').toMatch(/blockMapTiles: getSetting\(db, 'blockMapTiles', false\)/)
    // 读写各一次 + 快照两处（成功分支与 catch 分支）
    atLeast([...store.matchAll(/blockMapTiles/g)].length, 4, 'privacy-audit 里 blockMapTiles 的出现次数')

    // 默认必须是 false：新增开关不能把老用户原本就在用的地图关掉
    expect(store, '默认值不是 false（会让老用户原本能看的世界地图突然没有底图）').toMatch(/getSetting\(db, 'blockMapTiles', false\)/)
  })

  it('前端：镜像接口 → 包装 → 开关按钮，三处都有', () => {
    expect(r(...CW, 'api-core.ts'), 'api-core 的镜像接口没同步（client typecheck 会在调用处报属性不存在）')
      .toMatch(/setPrivacyState\(options: \{[^}]*blockMapTiles\?: boolean/)
    expect(r(...CW, 'api-read.ts'), 'api-read 的包装签名没加').toMatch(/apiSetPrivacyState\(options: \{[^}]*blockMapTiles\?: boolean/)

    const panel = readStripped(join(HERE, 'PrivacyTrust.tsx'))
    expect(panel, '开关按钮没加').toContain("toggle('blockMapTiles'")
    expect(panel, 'toggle 的 key 联合里没有它').toMatch(/'redactSensitive' \| 'blockOutbound' \| 'blockMapTiles'/)
    expect(panel, '按钮没显示当前状态').toMatch(/state\.blockMapTiles \? '开' : '关'/)
  })

  it('拉取点唯一：地图族里只有 world-map-data.ts 发 fetch（所以一处关就全关）', () => {
    const mapFiles = readdirSync(HERE).filter((f) => /(world-map-data|ChinaMap|WorldMap|GeoEchartsMap|province-map-data|city-map-data)\.tsx?$/.test(f))
    atLeast(mapFiles.length, 5, '地图族的文件数')
    const fetchers: string[] = []
    for (const f of mapFiles) {
      // 剥注释：注释里举例写着 `fetch(...)` 不算调用点
      if (/\bfetch\(/.test(readStripped(join(HERE, f)))) fetchers.push(f)
    }
    expect(fetchers, `这些文件自己发了 fetch —— 闸门在 world-map-data.ts，别处绕过去就漏了：${fetchers.join(', ')}`)
      .toEqual(['world-map-data.ts'])
  })

  it('闸门真的判它，且失败方向是「放行」不是「拦截」', () => {
    const src = readStripped(join(HERE, 'world-map-data.ts'))
    expect(src, 'fetchFirstJson 没有过闸').toMatch(/async function fetchFirstJson[\s\S]{0,200}mapTilesBlocked\(\)/)
    expect(src, '没读隐私状态').toContain('apiGetPrivacyState')
    expect(src, '读到了却没判').toMatch(/\.blockMapTiles === true/)
    // 与后端隐私闸「读不到就拦」方向相反，是刻意的：那边拦的是用户内容，
    // 这边只是一份公开的行政区划 GeoJSON —— 读不到状态宁可出网也不要整张地图空白。
    // P3-9 之后这条兜底多了半句：有**过期**镜像时先拿旧副本顶着（那是后端真值的副本，
    // 比"什么都没有"更接近真相），真正什么都没有才放行。判据收成 `mirrored ?? false`，
    // 谁把它写成无条件 `false`（旧副本丢了）或无条件 `true`（兜底方向翻掉）都该红。
    expect(src, '读不到真值时的兜底方向变了（应"旧副本顶着，否则放行"）').toMatch(/catch \{\s*return mirrored \?\? false/)
  })
})

describe('S07 · 语音模型下载走 blockOutbound 总闸', () => {
  it('下载前过 privacyBlocked，功能名 voice_model_download', () => {
    const src = readStripped(join(ROOT, ...BW, 'remotes', 'voicellm.ts'))
    expect(src, '下载没过出网闸').toMatch(/downloadWhisperModel[\s\S]{0,400}rc\.privacyBlocked\('voice_model_download'/)
  })

  it('出网闸门被真的装配进去（否则 rc.privacyBlocked 是 undefined，点了就崩）', () => {
    const core = readStripped(join(ROOT, ...BW, 'gateway-core.ts'))
    expect(core, 'createVoiceLlmRemotes 的装配里没有 privacyBlocked').toMatch(/createVoiceLlmRemotes\(\{[\s\S]{0,300}privacyBlocked:/)
  })

  it('license 出网豁免表登记了它（不发内容给模型，属数据浏览）', () => {
    const lic = readStripped(join(ROOT, 'src', 'backend', 'tests', 'license-outbound-coverage.spec.ts'))
    expect(lic, 'NON_AI_OUTBOUND 里没有 downloadWhisperModel').toContain('downloadWhisperModel:')
  })

  it('隐私声明点名了这两个开关，且不再留着"还没有开关"的旧说法', () => {
    const doc = r('docs', 'PRIVACY.md')
    expect(doc, '文档没写 blockMapTiles').toContain('blockMapTiles')
    expect(doc, '文档没写 voice_model_download').toContain('voice_model_download')
    expect(doc, '文档还留着已过期的说法').not.toMatch(/无内置开关|没有内置开关/)
  })
})
