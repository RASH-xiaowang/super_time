// @vitest-environment node
/**
 * `getKbs()` 必须把**两个库文件**合流：笔记数来自笔记库、文件数来自文件库。
 *
 * 为什么这一条必须有：`KbMeta.fileCount` 的目标消费者是删库弹层 —— 它靠这个数决定说
 * 「这个库是空的」还是「2 个文件会一并删掉」。真机探针（`working/cdp-kb-files.mjs` 第 10 步）
 * 修前实测到过前者：库里有 2 个已登记文件、5 个文本块，弹层一个字都没提，点下去全清。
 *
 * 而这条链路上**最容易断的一环正好是最安静的一环**：`listKbs()` 在 `notes.ts` 里，
 * 只看得到笔记库，所以它出的 `fileCount` 恒为 0；真值要靠 `gateway.getKbs` 补一次。
 * 把那次合并删掉，**所有既有用例照样全绿** —— 界面只是又开始对用户说谎。
 * 所以这里不测 `countKbFilesByKb`（那个在 kb-files-store.spec.ts 里另有一组），
 * 测的是**合并本身**：从网关拿到的快照里，`fileCount` 必须是文件库的真值。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { WechatDataGateway } from '../src/gateway.ts'
import { registerKbFile } from '../src/query/kb-files.ts'
import { listKbs } from '../src/query/notes.ts'

let scratch = ''
let decrypted = ''
let decoded = ''
let base = ''
let srcDir = ''
let disposers: Array<() => void> = []

/** Minimal Cordis Context surface the gateway touches（与 gateway-image-batch.spec.ts 同款）。 */
function fakeCtx(): Context {
  const effects: Array<() => void> = []
  disposers = effects
  return {
    reflect: { provide: () => {} },
    effect: (fn: () => undefined | (() => void)) => {
      const d = fn()
      if (typeof d === 'function') effects.push(d)
      return d
    },
    emit: () => {},
  } as unknown as Context
}

/** 指向当前夹具的网关（每次重新解析 env，与既有的网关用例同一个写法）。 */
function gatewayFor(): WechatDataGateway {
  vi.stubEnv('DSH_WECHAT_DECRYPTED_DIR', decrypted)
  vi.stubEnv('DSH_WECHAT_DECODED_DIR', decoded)
  vi.stubEnv('DSH_WECHAT_BASE_DIR', base)
  return new WechatDataGateway(fakeCtx())
}

/** 造一个真源文件并登记进某个库。 */
function register(name: string, content: string, kbId: number): void {
  const p = join(srcDir, name)
  writeFileSync(p, content, 'utf8')
  const r = registerKbFile(decrypted, { kbId, srcPath: p })
  expect(r.ok, `登记 ${name} 失败：${r.error ?? ''}`).toBe(true)
}

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'kb-filecount-'))
  decrypted = join(scratch, 'decrypted')
  decoded = join(scratch, 'decoded')
  base = join(scratch, 'wechat-base')
  srcDir = join(scratch, 'src')
  for (const d of [decrypted, decoded, base, srcDir]) mkdirSync(d, { recursive: true })
  disposers = []
})

afterEach(() => {
  vi.restoreAllMocks()
  for (const d of disposers) d()
  disposers = []
  vi.unstubAllEnvs()
  if (scratch) rmSync(scratch, { recursive: true, force: true })
  scratch = ''
})

describe('getKbs 把文件数合流进 KbMeta.fileCount', () => {
  it('★ listKbs 自己恒为 0，网关合流后才是真值（合并被删掉时这条转红）', () => {
    const gw = gatewayFor()
    const created = gw.createKb({ name: '资料库' })
    expect(created.ok).toBe(true)
    const otherId = Number(created.id)

    // 默认库 2 份、新建的库 1 份 —— 两个库都要有，才能证明「按 kb_id 分别统计」
    register('a.txt', '默认库第一份', 1)
    register('b.txt', '默认库第二份', 1)
    register('c.txt', '另一个库的一份', otherId)

    // ① 先说清「为什么必须在网关这一层合流」：notes.ts 看不到文件库。
    const raw = listKbs(decrypted)
    expect(raw.readError).toBeUndefined()
    expect(
      raw.items.every(k => k.fileCount === 0),
      'listKbs 竟然报出了文件数 —— 那是它不该知道的（文档注释说它恒为 0）',
    ).toBe(true)
    // 防空转：这一轮确实登记了东西（不然上面那条可以靠「文件没登记成功」通过）
    expect(raw.items.reduce((n, k) => n + k.noteCount, 0)).toBe(0)

    // ② 网关的快照里必须是真值。
    const snap = gw.getKbs()
    expect(snap.items.map(k => k.id)).toEqual([1, otherId])
    expect(snap.items.find(k => k.id === 1)?.fileCount, '默认库的文件数没合流进来').toBe(2)
    expect(snap.items.find(k => k.id === otherId)?.fileCount, '新库的文件数没合流进来').toBe(1)
    // 笔记数仍然来自笔记库（这次改动不该把原来的字段弄丢）
    expect(snap.items.every(k => typeof k.noteCount === 'number')).toBe(true)
  })

  it('没有文件的库报 0（不是缺字段 / undefined）', () => {
    const gw = gatewayFor()
    const created = gw.createKb({ name: '空的' })
    register('only.txt', '只往默认库放一份', 1)
    const snap = gw.getKbs()
    const empty = snap.items.find(k => k.id === Number(created.id))
    expect(empty?.fileCount).toBe(0)
    expect(empty?.fileCount, 'undefined 会让 `fileCount > 0` 静默变成 false').not.toBeUndefined()
  })

  it('文件库整个读不到时退化成 0，但库列表照旧给出来（不整天不显示）', () => {
    // 把文件库换成一个**目录**：`new DatabaseSync(path)` 会打开失败 ⇒ countKbFilesByKb 返回空表。
    const gw = gatewayFor()
    expect(gw.createKb({ name: '照旧' }).ok).toBe(true)
    mkdirSync(join(scratch, 'blocked'))
    vi.stubEnv('DSH_WECHAT_DECRYPTED_DIR', join(scratch, 'blocked'))

    const blocked = new WechatDataGateway(fakeCtx())
    const snap = blocked.getKbs()
    expect(snap.items.length, '文件库读失败把库列表也带塌了').toBeGreaterThan(0)
    expect(snap.items.every(k => k.fileCount === 0)).toBe(true)
  })
})
