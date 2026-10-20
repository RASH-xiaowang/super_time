/**
 * `sync-watch.ts` 的行为守卫（2026-10-13，WAL 实时推送）。
 *
 * 这一族决定「微信一写 WAL，后端要立刻拍一次同步而不是等下一个 10s 轮询拍」。
 * 坏形状都是**静默**的：
 *  · 防抖被拿掉 ⇒ 一个写入簇触发一串节拍，把单线程 worker 打成风暴；
 *  · 限频被拿掉 ⇒ 活跃会话期间节拍无上界（每个节拍是 42 stat + 一次 WAL 补丁 + 一次推送）；
 *  · 目录变化不重挂 ⇒ 数据根迁移/报错恢复后监听挂在旧目录上，实时性悄悄消失；
 *  · stop 不清定时器/不关监听 ⇒ 组件卸载后监听还活着，写任何文件都会调一个死回调。
 *
 * 集成用例用**真 fs.watch**（本机/CI 都是 NTFS）：写一个文件 → onTrigger 必须有界到达，
 * 这是「WAL 写入 → 推送」链路里唯一依赖操作系统的半环，mock 掉就等于没测。
 * @vitest-environment node
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { startSyncWatch, WATCH_DEBOUNCE_MS, WATCH_MIN_GAP_MS, type SyncWatcherLike } from '../src/query/sync-watch.ts'

interface FakeWatcher extends SyncWatcherLike {
  dir: string
  closed: boolean
  fire(evt: string, fname: string | null): void
  err(e: Error): void
}

function makeFakeWatch(): { watchDir: (dir: string, onChange: (evt: string, fname: string | null) => void) => FakeWatcher; watchers: FakeWatcher[] } {
  const watchers: FakeWatcher[] = []
  const watchDir = (dir: string, onChange: (evt: string, fname: string | null) => void): FakeWatcher => {
    const w: FakeWatcher = {
      dir,
      closed: false,
      fire: onChange,
      err: () => {},
      close() { this.closed = true },
      on(_e: 'error', cb: (err: Error) => void) { this.err = cb },
    }
    watchers.push(w)
    return w
  }
  return { watchDir, watchers }
}

const scratch: string[] = []
const handles: Array<{ stop(): void }> = []
afterEach(() => {
  for (const h of handles.splice(0)) h.stop()
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
  vi.useRealTimers()
})

function tempDir(tag: string): string {
  const dir = mkdtempSync(join(tmpdir(), `wx-watch-${tag}-`))
  scratch.push(dir)
  return dir
}

async function waitFor(predicate: () => boolean, ms = 3000): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return predicate()
}

describe('WAL 监听的触发纪律（注入假 watch + 假时钟）', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  it('一个写入簇经 WATCH_DEBOUNCE_MS 防抖合并成一次触发（防抖前零触发）', () => {
    const fw = makeFakeWatch()
    const onTrigger = vi.fn()
    const h = startSyncWatch({ onTrigger }, { watchDir: fw.watchDir })
    handles.push(h)
    h.refresh('C:/wx/raw')
    expect(fw.watchers).toHaveLength(1)
    fw.watchers[0]!.fire('change', 'MSG0.db-wal')
    vi.advanceTimersByTime(100)
    fw.watchers[0]!.fire('change', 'MSG1.db-wal')
    vi.advanceTimersByTime(100)
    fw.watchers[0]!.fire('rename', 'MSG0.db')
    expect(onTrigger, '防抖窗口内不许触发').not.toHaveBeenCalled()
    vi.advanceTimersByTime(WATCH_DEBOUNCE_MS)
    expect(onTrigger, '一个簇只该合并成一次').toHaveBeenCalledTimes(1)
  })

  it('WATCH_MIN_GAP_MS 内的第二次触发被限频跳过；越过窗口后恢复', () => {
    const fw = makeFakeWatch()
    const onTrigger = vi.fn()
    const h = startSyncWatch({ onTrigger }, { watchDir: fw.watchDir })
    handles.push(h)
    h.refresh('C:/wx/raw')
    fw.watchers[0]!.fire('change', 'MSG0.db-wal')
    vi.advanceTimersByTime(WATCH_DEBOUNCE_MS)
    expect(onTrigger).toHaveBeenCalledTimes(1)
    // 触发时刻是 t=WATCH_DEBOUNCE_MS；下面这次距上次不足 WATCH_MIN_GAP_MS ⇒ 跳过。
    // 用「限频窗口的一半」推进，保证无论常量取多少都落在窗口内。
    vi.advanceTimersByTime(Math.floor(WATCH_MIN_GAP_MS / 2))
    fw.watchers[0]!.fire('change', 'MSG0.db-wal')
    vi.advanceTimersByTime(WATCH_DEBOUNCE_MS)
    expect(onTrigger, '限频窗口内的触发必须跳过').toHaveBeenCalledTimes(1)
    // 再推一个完整窗口 ⇒ 距上次已超过 WATCH_MIN_GAP_MS ⇒ 恢复
    vi.advanceTimersByTime(WATCH_MIN_GAP_MS)
    fw.watchers[0]!.fire('change', 'MSG0.db-wal')
    vi.advanceTimersByTime(WATCH_DEBOUNCE_MS)
    expect(onTrigger, '越过窗口后必须恢复').toHaveBeenCalledTimes(2)
  })

  it('refresh 换目录 ⇒ 旧监听关闭、新目录重挂；同目录重复 refresh 是空操作', () => {
    const fw = makeFakeWatch()
    const onTrigger = vi.fn()
    const onAttached = vi.fn()
    const h = startSyncWatch({ onTrigger, onAttached }, { watchDir: fw.watchDir })
    handles.push(h)
    h.refresh('C:/wx/raw')
    h.refresh('C:/wx/raw')
    expect(fw.watchers, '同目录重复 refresh 不该重挂').toHaveLength(1)
    expect(onAttached, '新挂载成功必须上报一次（探针/诊断日志靠它确认挂在哪个目录）').toHaveBeenCalledTimes(1)
    h.refresh('D:/wx/raw2')
    expect(fw.watchers).toHaveLength(2)
    expect(fw.watchers[0]?.closed, '旧目录的监听必须关掉').toBe(true)
    expect(fw.watchers[1]?.dir).toBe('D:/wx/raw2')
    expect(onAttached).toHaveBeenCalledTimes(2)
    fw.watchers[1]!.fire('change', 'x.db-wal')
    vi.advanceTimersByTime(WATCH_DEBOUNCE_MS)
    expect(onTrigger, '新目录的事件必须能触发').toHaveBeenCalledTimes(1)
  })

  it('监听报错只上报一次并摘掉自己；refresh 重挂后自愈', () => {
    const fw = makeFakeWatch()
    const onTrigger = vi.fn()
    const onWatchError = vi.fn()
    const h = startSyncWatch({ onTrigger, onWatchError }, { watchDir: fw.watchDir })
    handles.push(h)
    h.refresh('C:/wx/raw')
    fw.watchers[0]!.err(new Error('句柄失效'))
    fw.watchers[0]!.err(new Error('再来一次'))
    expect(onWatchError, '同一段故障只报一次').toHaveBeenCalledTimes(1)
    expect(fw.watchers[0]?.closed, '报错的监听必须摘掉').toBe(true)
    h.refresh('C:/wx/raw')
    expect(fw.watchers, 'refresh 必须重挂').toHaveLength(2)
    fw.watchers[1]!.err(new Error('新监听又坏了'))
    expect(onWatchError, '重挂后的新故障要重新报一次').toHaveBeenCalledTimes(2)
  })

  it('watchDir 抛错（挂载失败）⇒ 上报一次、不崩溃；后续 refresh 照常重试', () => {
    const onTrigger = vi.fn()
    const onWatchError = vi.fn()
    const h = startSyncWatch({ onTrigger, onWatchError }, {
      watchDir: () => { throw new Error('ENOSPC') },
    })
    handles.push(h)
    h.refresh('C:/wx/raw')
    expect(onWatchError).toHaveBeenCalledTimes(1)
    expect(String(onWatchError.mock.calls[0]?.[0])).toContain('挂载失败')
  })

  it('stop ⇒ 未到防抖的定时器清掉、监听关闭（卸载后一个死回调都不留）', () => {
    const fw = makeFakeWatch()
    const onTrigger = vi.fn()
    const h = startSyncWatch({ onTrigger }, { watchDir: fw.watchDir })
    h.refresh('C:/wx/raw')
    fw.watchers[0]!.fire('change', 'MSG0.db-wal')
    h.stop()
    vi.advanceTimersByTime(10_000)
    expect(onTrigger, 'stop 后防抖定时器不许再触发').not.toHaveBeenCalled()
    expect(fw.watchers[0]?.closed, 'stop 必须关闭监听').toBe(true)
  })
})

describe('WAL 监听的半环集成（真 fs.watch，NTFS）', () => {
  it('真实目录里写一个新文件 ⇒ onTrigger 有界到达（这就是「WAL 写入 → 立刻拍一拍」的物理链路）', async () => {
    vi.useRealTimers()
    const dir = tempDir('real')
    const onTrigger = vi.fn()
    const h = startSyncWatch({ onTrigger })
    handles.push(h)
    h.refresh(dir)
    // 让 OS 的监听真正就位（watch() 返回后事件表要一小段建立时间）
    await new Promise((resolve) => setTimeout(resolve, 150))
    writeFileSync(join(dir, 'MSG0.db-wal'), 'frame')
    const hit = await waitFor(() => onTrigger.mock.calls.length >= 1, 3000)
    expect(hit, '真 fs.watch 下写文件 3s 内必须触发一次').toBe(true)
    expect(onTrigger).toHaveBeenCalledTimes(1)
  })
})

describe('sync.ts 的接线（源码锚点）', () => {
  const SRC = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../src/query/sync.ts'), 'utf8')

  it('哨兵：sync.ts 真的读到了（读空 ⇒ 下面的断言全恒真）', () => {
    expect(SRC.length).toBeGreaterThan(500)
  })

  it('同步循环接上监听器：触发经合并器拍 tick、每拍重挂到当前 raw 根、disposer 停止监听', () => {
    expect(SRC, '必须把监听触发接到 tick 上（否则监听只是摆设）').toContain('startSyncWatch({')
    expect(SRC, 'tick 运行期间的 WAL 触发不许丢：必须走合并器').toContain('createSyncTrigger({ run: tick })')
    expect(SRC, '合并器得真被监听器调用（否则白合并）').toContain('onTrigger: () => { triggerSync.trigger() }')
    expect(SRC, '每拍必须 refresh 到当前 raw 根（目录变了/报错后靠它重挂）').toContain('syncWatch.refresh(raw)')
    expect(SRC, 'disposer 必须停掉监听（否则卸载后监听还活着）').toContain('syncWatch.stop()')
  })

  it('轮询兜底必须保留，且监听没挂上时用更短间隔（宁可慢，不可错）', () => {
    expect(SRC, '兜底轮询不许删').toContain('SYNC_INTERVAL_MS')
    expect(SRC, '监听不可用时轮询是唯一新鲜度来源，必须能切到快档').toContain('SYNC_FALLBACK_FAST_MS')
    expect(SRC, '快/慢档必须由「监听是否真的挂上」决定').toContain('syncWatch.attached()')
  })
})
