/**
 * 图片加载流程的接线守卫。
 *
 * 起因（2026-09-26 用户截图）：一个会话里 8 条图片消息同屏，整屏都是「图片加载中…」——
 * 每条都要先闪一次文字占位，而滚回来/切回会话还要**重新取一次**（组件卸载就把状态丢了）。
 *
 * 四条不变量：
 *   A. **不再有文字占位**：默认一个字的提示都不出现，只有超过慢阈值才补一句弱文案；
 *   B. **首帧先查缓存**：命中时这一帧就是图片，不闪占位（滚回来/切回会话都走这条路）；
 *   C. **预取要批量、要低优先**：视口内那几张是用户正看着的，预取不能抢它的后端与 IPC；
 *   D. **失败不进缓存**：预取失败只是「这次没取到」，下次滚到还要再试一次。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
const read = (...p: string[]): string => readFileSync(join(HERE, ...p), 'utf8')

const MEDIA = read('chats-media.tsx')
const HOOK = read('use-image-preload.ts')
const CACHE = read('..', 'image-cache.ts')
const CSS = read('chats.module.css')
const VIEW = read('chats-view.tsx')

describe('图片加载流程', () => {
  it('① 默认没有文字占位（「图片加载中…」那行必须消失，骨架取而代之）', () => {
    // 用「JSX 文本节点」的形态断言，而不是裸词：解释这段历史的注释里也会出现
    // 「图片加载中…」这几个字，裸词匹配会把注释算进去（本轮的守卫在别处已栽过两次）。
    expect(MEDIA, '文字占位不该再渲染出来（用户报的就是它）').not.toContain('图片加载中…</span>')
    expect(MEDIA, '占位换成骨架').toContain('css.msgImageSkeleton')
    // 2026-10-17：**呼吸动画已去掉**（用户要求「这样的加载样式全部修改」）。
    // 改前这里断言 `@keyframes wxImgPulse` 存在 —— 一屏几十张图同时呼吸，
    // 视觉噪音极大而信息量是零。现在只留静态底色，判据反过来：不许再有那个动画。
    expect(CSS, '骨架不许再有呼吸动画（一屏几十张同时呼吸，噪音极大）').not.toContain('@keyframes wxImgPulse')
    expect(CSS, '骨架必须保留定尺寸占位（否则图片到达时布局跳变）').toMatch(/\.msgImageSkeleton\s*\{[^}]*width:\s*160px/)
  })

  it('② 首帧同步查缓存（lazy 初值）——命中时这一帧就是图片', () => {
    // 形态要求：`useState(() => recallImage(...))`。写成 effect 里 setState 就晚一帧，
    // 那一帧仍然会画出占位 —— 正是要消掉的东西。
    expect(MEDIA, 'state 必须用惰性初值同步查缓存').toMatch(/useState<string \| null>\(\(\) => recallImage\(/)
    expect(MEDIA, 'thumb 标记也要跟着缓存走（否则「本机只有缩略图」那句会凭空消失）')
      .toMatch(/useState\(\(\) => recallImage\([^)]*\)\?\.thumb/)
  })

  it('③ 取回后写缓存，且命中缓存时不发请求', () => {
    expect(MEDIA, '成功结果要写进缓存（下次就不再取）').toContain('rememberImage(selfName, m.localId,')
    expect(MEDIA, '命中缓存应当直接返回、一个请求都不发').toMatch(/const hit = recallImage\(selfName, m\.localId\)/)
    // 只有「取原图」那次（nonce 变化）必须重取 —— 否则用户点了没反应
    expect(MEDIA, '取原图要能强制重取').toMatch(/hit !== undefined && nonce === 0/)
  })

  it('④ 预取走批量入口 + 空闲调度（不与视口内的请求抢后端）', () => {
    // 断言「调用形态」而不是裸名字：本文件的注释里也解释了为什么用它，
    // 裸词匹配下把调用换成逐张入口照样绿（本轮变异测试第三次抓到这类假阳性）。
    expect(HOOK, '预取要用批量入口（后端一次 IN 就能查完整批路径）').toContain('await apiGetImageDataUrlsBatch(chunk)')
    expect(HOOK, '预取不许退回逐张入口（每张一次库开合）').not.toContain('await apiGetImageDataUrl({')
    expect(HOOK, '预取要低优先：排在空闲时').toContain('requestIdleCallback')
    expect(HOOK, '只预取图片消息').toContain("renderKindOf(m) !== 'image'")
    expect(HOOK, '滚动中不打断（防抖）').toContain('PREFETCH_DEBOUNCE_MS')
    expect(HOOK, '已有缓存的不重复预取').toContain('recallImage(talker, m.localId) !== undefined')
    expect(VIEW, '面板要把可见窗口喂给它').toContain('useImagePreload({')
  })

  it('⑤ 预取有余量且跨重跑去重（滚动会不停重跑 effect）', () => {
    expect(HOOK, '要有可见窗口余量，否则滚一屏就错过').toMatch(/export const LOOKAHEAD = \d+/)
    expect(HOOK, '在飞去重').toContain('inflight')
    expect(HOOK, '换会话要作废在途结果').toContain('epoch')
  })

  it('⑥ 预取失败不写缓存（「这次没取到」不许被记成「已知没图」）', () => {
    const at = HOOK.indexOf('} catch {')
    expect(at, '找不到预取的失败分支').toBeGreaterThan(-1)
    expect(HOOK.slice(at, at + 400), '失败分支里不许写缓存').not.toContain('rememberImage')
    // 组件自己那条路径相反：那是用户正看着的图，失败必须说话
    expect(MEDIA, '组件路径失败要显示原因（不能静默）').toContain("setImgErr(r.error ?? '图片不可用')")
  })

  it('⑦ 就绪后淡入，抹平「骨架 → 图片」的突变', () => {
    expect(MEDIA, '要记就绪态').toContain("data-loaded={loaded ? '1' : undefined}")
    expect(CSS, '就绪后才有淡入动画（不能一上来就 opacity: 0，那样图会短暂不可见）')
      .toContain('.msgImage[data-loaded]')
  })

  it('⑧ 缓存按字节计容量、单条过大不入（一张原图不该挤掉整屏缩略图）', () => {
    expect(CACHE, '要有总量上限').toMatch(/export const MAX_BYTES = \d+/)
    expect(CACHE, '要有单条上限').toMatch(/export const MAX_ENTRY_BYTES = \d+/)
    expect(CACHE, '超限要从最久未用开始淘汰（字节或条数任一超陔）').toContain('while ((bytes > maxBytes || store.size > maxEntries)')
    expect(CACHE, '空 url 不入缓存').toContain("if (value.url === '') return")
  })
})
