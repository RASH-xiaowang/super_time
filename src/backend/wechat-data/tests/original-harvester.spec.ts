/**
 * 「原图自动收割」的守卫：把 2026-10-17 实测出来的**边界**钉死，防止后来的人
 * 以为「再找找就能拿到」而把越界的东西加回来。
 *
 * ## 为什么需要这组守卫
 *
 * 用户提过「推翻不登录承诺，去抓包/读内存拿原图」。实测（`working/probe-*.mjs`，脚本不入库）
 * 确认了三条死路，每一条都值得留一条断言：
 *
 * | 尝试 | 实测结果 |
 * |---|---|
 * | 消息 XML 的 `tphdurl`/`tpurl` | 本机 20,431 条**全部**指向企业微信 `wwfile` 端点，匿名 GET 一律 403 |
 * | 进程内存里的 `tpauthkey`（806 处） | 拼进 URL 的 5 种变体**全部 403** —— 它是给 mmtls 私有协议用的 |
 * | 进程内存里的 JPEG（225 个） | 与数据库 48,882 个图片 md5 **交集为 0** —— 那是界面渲染缓存 |
 *
 * 所以本模块**只做一件事**：盯住微信自己落盘的 `_h.dat`。它不联网、不碰凭据、不注入进程。
 * 下面每条断言都在守这个边界。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const HERE = import.meta.dirname
const SRC = readFileSync(join(HERE, '..', 'src', 'query', 'original-harvester.ts'), 'utf8')

/** 剥掉注释再断言：注释里写着历史成因与被否掉的旧值，直接搜会误判。 */
function stripComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

const CODE = stripComments(SRC)

describe('原图自动收割：只收割微信自己落盘的原图', () => {
  it('① 只认 `_h.dat`（原图档），不碰 `_t.dat` 与聊天版', () => {
    // 判据是文件名正则：`<32位md5>_h.dat`。`_t`（缩略图）与无后缀（聊天版）都不该触发收割 ——
    // 它们本来就会被逐条读图路径解出来，重复处理只是白烧 CPU。
    // 源码里是 `new RegExp('^(' + MD5_SEGMENT + ')_h\\\\.dat$', 'i')` —— 字符串字面量里
    // 反斜杠要写两遍，所以断言里得用四个反斜杠才能匹配到那两个字符。
    expect(CODE).toContain('_h\\\\.dat$')
    expect(CODE, '不许把 `_t.dat` 也当成收割目标').not.toContain('_t\\\\.dat$')
  })

  it('② 写的是全局槽（username 传空串），与 CDN 原图同一个槽位', () => {
    // `decodeImageDataUrl` 第 1a 步优先读 `<decoded>/<md5>.<ext>`（不带用户名子目录）。
    // 收割写进同一个槽，下一次渲染直接是原图，不需要改任何显示路径。
    expect(CODE).toContain("writeDecodedCache(decodedDir, '', md5, dec.format, dec.bytes, false)")
  })

  it('③ 不联网：模块里不许出现 fetch / http 请求', () => {
    // 这是本模块与 `image-original.ts` 的根本区别：那条路要出网（且本机实测全 403），
    // 这条完全离线。加一个 fetch 进来就等于把「不联网」这个卖点弄丢了。
    expect(CODE, '收割器不许联网').not.toMatch(/\bfetch\s*\(/)
    expect(CODE).not.toMatch(/from '\.\.\/net\//)
    expect(CODE).not.toMatch(/https?:\/\//)
  })

  it('④ 不碰凭据、不注入进程：不许 import 内存扫描或 koffi', () => {
    // 2026-10-17 实测：内存里确实有 `tpauthkey`（806 处）与 `sessionkey`（128 处），
    // 但拼进 URL 的 5 种变体全部 403 —— 它们是给 mmtls 私有协议用的，不是 HTTP 凭据。
    // 所以收割器**不需要**也不该去读进程内存。
    expect(CODE).not.toMatch(/win32-memory/)
    expect(CODE).not.toMatch(/ReadProcessMemory/)
    expect(CODE).not.toMatch(/koffi/)
    expect(CODE).not.toMatch(/sessionkey|tpauthkey/i)
  })

  it('⑤ 启动只挂监控、不做全量补扫（补扫 69 秒会占满重任务队列）', () => {
    // 2026-10-17 实测教训：第一版启动时先全量扫 1,459 个 `_h.dat` 再挂监控，
    // 实测耗时 69 秒 —— 而重任务队列只有 1 个槽位，这 69 秒里任何 `status` 查询
    // 都会被「重任务队列已满」拒掉，界面上的「正在监控」永远等不到。
    // 所以启动必须**毫秒级返回**：只挂 watch，补扫交给用户显式点的「立即收割」。
    const start = CODE.indexOf('export async function startOriginalHarvester')
    expect(start, '找不到 startOriginalHarvester —— 改名时请同步本用例').toBeGreaterThan(-1)
    const body = CODE.slice(start, CODE.indexOf('export function stopOriginalHarvester'))
    // 监控回调里会调 `harvestHdDats([full], …)`（单文件收割，正常）；
    // 不许出现的是**全量补扫**那种调用（传一个收集好的数组）。
    expect(body, '启动时不许做全量补扫').not.toMatch(/harvestHdDats\(all/)
    expect(body, '启动时必须挂监控').toContain('watch(')
    expect(body, '启动必须立刻返回空结果').toContain('return { harvested: 0, failed: 0, errors: [] }')
  })

  it('⑥ 幂等：重复启动不重建监控（否则会泄漏 watcher）', () => {
    expect(CODE).toContain('if (watcher !== null && watchRoot === attach) return { harvested: 0, failed: 0, errors: [] }')
  })

  it('⑦ 读文件前确认大小稳定（微信可能还在写）', () => {
    // 微信落盘 `_h.dat` 是流式写入，`watch` 事件可能在写完之前就触发。
    // 直接读会拿到截断的字节 ⇒ 解密失败 ⇒ 这张图被记成「解不开」。
    expect(CODE).toContain('文件仍在写入，跳过')
    expect(CODE).toMatch(/statSync\(file\)\.size/)
  })

  it('⑧ 单个文件失败不影响监控（catch 后继续）', () => {
    // 监控回调里必须把收割包在 catch 里：一张图解不开不该让整个 watcher 挂掉。
    // 断言的是**代码结构**（`.catch(` + `.finally(`），不是注释里的那句话 ——
    // 注释会被 `stripComments` 剥掉，拿它当判据等于恒假。
    expect(CODE).toMatch(/\.catch\(\(\) => \{/)
    expect(CODE).toMatch(/\.finally\(\(\) => \{ inFlight\.delete\(full\) \}\)/)
  })

  it('⑨ 手动收割上报进度（1,459 个文件要 69 秒，不能干等）', () => {
    // 2026-10-17 实测：本机 1,459 个 `_h.dat` 逐个解密要 69 秒。没有进度的话
    // 界面只能显示「收割中…」干等一分钟，用户会以为卡死了。
    expect(CODE, 'harvestHdDats 必须接受 onProgress').toContain('onProgress?: (done: number, total: number, harvested: number, failed: number) => void')
    expect(CODE, '每处理完一个文件要回调').toContain('onProgress?.(done, files.length, harvested, failed)')
    expect(CODE, '状态里要有 progress 字段').toContain('progress: { done: number; total: number; harvested: number; failed: number } | null')
    expect(CODE, '要有 setHarvestProgress').toContain('export function setHarvestProgress(')
  })
})

describe('原图自动收割：网关与策略接线', () => {
  const GATEWAY = stripComments(readFileSync(join(HERE, '..', 'src', 'gateway-media-ops.ts'), 'utf8'))

  it('⑨ 收割动作挂在网关媒体域上（单一分发方法，守住行数棘轮）', () => {
    expect(GATEWAY, "网关缺 @Remote('originalHarvest')").toContain("@Remote('originalHarvest')")
    for (const action of ['start', 'stop', 'now']) {
      expect(GATEWAY, `分发方法缺 ${action} 分支`).toContain(`'${action}'`)
    }
    // `status` 必须是**独立**的 Remote：混进 originalHarvest 会被归成重任务，
    // 而收割本身占着唯一的重任务槽 —— 收割期间读进度会被队列拒掉（2026-10-17 实测）。
    expect(GATEWAY, "status 必须是独立的 @Remote('getOriginalHarvestStatus')").toContain("@Remote('getOriginalHarvestStatus')")
    expect(GATEWAY, 'originalHarvest 不许再接受 status 动作').not.toContain("'start' | 'stop' | 'status' | 'now'")
  })

  it('⑩ 长任务进超时策略（补扫要遍历数万文件）', () => {
    const policy = readFileSync(join(HERE, '..', '..', 'remote-policy.js'), 'utf8')
    expect(policy, 'originalHarvest 必须放宽超时').toContain('originalHarvest')
  })
})
