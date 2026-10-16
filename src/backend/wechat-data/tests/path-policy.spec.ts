/**
 * P2-6 路径政策：`openPath` 不再是一个「让渲染层挑程序来跑」的原语。
 *
 * 审查的原始形状：`@Remote('openPath')` → `openNativePath(p)` →
 * `powershell.exe … Invoke-Item -LiteralPath '<p>'`。转义是好的（不是命令注入），
 * 但对 `.exe` 那是**直接执行** —— 渲染层一旦被控，就从「读到你自己的聊天数据」
 * 升级到「以你的权限跑任意程序」。导出那几条相反：`exportDir` 是渲染层给的字符串，
 * 拿到绝对路径就能往任何位置落盘。
 *
 * 这里量两件事：
 *   ① 政策本身（根内 / 根外 / 可执行扩展名 / 授予目录 / 上限 / 前缀陷阱）；
 *   ② **网关那条路真的走了政策** —— 把 vendored 的 `openNativePath` 换成探针，
 *      被拒时必须一次都没调用它（「拦在调用之前」才是拦，注释里说说了不算）。
 * @vitest-environment node
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'

/** 探针：vendored 的「交给系统打开」被调了几次、参数是什么。 */
const nativeCalls: string[] = []

vi.mock('@deepseek-ai/dsh-native-command', () => ({
  openNativePath: async (p: string): Promise<void> => {
    nativeCalls.push(String(p))
  },
}))

const { openDenialReason, writeDenialReason, grantRoot, grantedRootList } = await import('../src/query/path-policy.ts')
const { WechatDataGateway } = await import('../src/gateway.ts')

let root = ''
let decrypted = ''
let dataRoot = ''

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'wx-pathpolicy-'))
  decrypted = join(root, 'decrypted')
  dataRoot = root
  mkdirSync(decrypted, { recursive: true })
  nativeCalls.length = 0
  vi.stubEnv('DSH_WECHAT_DECRYPTED_DIR', decrypted)
  vi.stubEnv('DSH_WECHAT_DECODED_DIR', join(root, 'decoded'))
  vi.stubEnv('DSH_WECHAT_SELF_WXID', 'wxid_self')
})

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(root, { recursive: true, force: true, maxRetries: 3 })
})

describe('openDenialReason：只打开应用自己产出范围内的东西', () => {
  it('数据根内的文件与目录都放行（防空转：允许的一侧也要有用例）', () => {
    const f = join(dataRoot, 'exports', 'chat.csv')
    expect(openDenialReason(f, dataRoot)).toBeNull()
    expect(openDenialReason(join(dataRoot, 'exports'), dataRoot)).toBeNull()
    expect(openDenialReason(dataRoot, dataRoot), '数据根自己也要能打开（界面有「打开数据目录」按钮）').toBeNull()
  })

  it('根外的路径拒掉，并给出能照做的理由', () => {
    const r = openDenialReason(join(tmpdir(), 'somewhere-else', 'x.txt'), dataRoot)
    expect(r).not.toBeNull()
    expect(r ?? '').toContain('数据目录')
  })

  it('前缀陷阱：`/data-root` 之内不包含 `/data-root-evil`', () => {
    // 按字符串前缀比的实现会在这里放行（那是最经典的「以为限了根」的错法）
    const sibling = dataRoot + '-evil'
    mkdirSync(sibling, { recursive: true })
    expect(openDenialReason(join(sibling, 'x.txt'), dataRoot), '同前缀的兄弟目录被当成了根内').not.toBeNull()
  })

  it('可执行/脚本扩展名一律拒，即使就在根内、大小写都算', () => {
    const dir = join(dataRoot, 'exports')
    mkdirSync(dir, { recursive: true })
    for (const name of ['evil.exe', 'EVIL.EXE', 'a.bat', 'b.lnk', 'c.ps1', 'd.cmd']) {
      writeFileSync(join(dir, name), 'x')
      expect(openDenialReason(join(dir, name), dataRoot), `${name} 被允许交给系统「打开」`).not.toBeNull()
    }
    writeFileSync(join(dir, 'ok.txt'), 'x')
    expect(openDenialReason(join(dir, 'ok.txt'), dataRoot)).toBeNull()
  })

  it('应用往根外写过东西之后，那个目录被授予（导出对话框选的位置仍可打开）', () => {
    const outside = mkdtempSync(join(tmpdir(), 'wx-granted-'))
    try {
      expect(openDenialReason(join(outside, 'report.html'), dataRoot)).not.toBeNull()
      grantRoot(outside)
      expect(openDenialReason(join(outside, 'report.html'), dataRoot)).toBeNull()
      // 授予的是**目录**，不是任意前缀
      expect(openDenialReason(outside + '-sibling/x', dataRoot)).not.toBeNull()
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('授予有上限（导出目录由用户挑，长跑不能无限制攒）', () => {
    const dirs: string[] = []
    try {
      for (let i = 0; i < 60; i += 1) {
        const d = mkdtempSync(join(tmpdir(), `wx-grant-${String(i)}-`))
        dirs.push(d)
        grantRoot(d)
      }
      expect(grantedRootList().length).toBeLessThanOrEqual(32)
      expect(openDenialReason(join(dirs[0] ?? '', 'x.txt'), dataRoot), '最早授予的目录该被淘汰掉').not.toBeNull()
      expect(openDenialReason(join(dirs[59] ?? '', 'x.txt'), dataRoot)).toBeNull()
    } finally {
      for (const d of dirs) rmSync(d, { recursive: true, force: true })
    }
  })
})

describe('writeDenialReason：导出落盘不许进系统位置、不许是可执行格式', () => {
  it('系统关键目录一律拒（大小写不敏感）', () => {
    for (const p of [
      'C:\\Windows\\System32\\drivers\\etc\\hosts',
      'C:\\Program Files\\App\\thing.csv',
      'C:\\Users\\me\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\x.bat',
    ]) {
      expect(writeDenialReason(p, dataRoot), `${p} 被允许写入`).not.toBeNull()
    }
    expect(writeDenialReason('c:\\windows\\evil.dll', dataRoot), '小写形式的系统目录也要拒').not.toBeNull()
  })

  it('可执行/脚本扩展名做导出目标时拒', () => {
    expect(writeDenialReason(join(dataRoot, 'exports', 'x.exe'), dataRoot)).not.toBeNull()
    expect(writeDenialReason(join(dataRoot, 'exports', 'x.ps1'), dataRoot)).not.toBeNull()
  })

  it('正常导出路径放行（防空转：这条判据不能只会拒）', () => {
    expect(writeDenialReason(join(dataRoot, 'exports', 'chat_2026.csv'), dataRoot)).toBeNull()
    expect(writeDenialReason(join(dataRoot, 'exports', 'chat.zip'), dataRoot)).toBeNull()
  })
})

describe('网关那条路真的走了政策（不是只有政策函数存在）', () => {
  function makeGateway(): InstanceType<typeof WechatDataGateway> {
    const ctx = {
      reflect: { provide: () => {} },
      effect: (fn: () => undefined | (() => void)) => fn(),
      emit: () => {},
      llm: { stream: async function* () { /* 不出网 */ }, embed: async (t: string[]) => t.map(() => [0]) },
      agentDefaultModel: { currentSelection: () => ({ provider: 'stub', model: 'stub' }) },
    } as unknown as Context
    return new WechatDataGateway(ctx)
  }

  it('根外的可执行文件：被拒，且 openNativePath 一次都没被调用', async () => {
    const gw = makeGateway()
    const r = await gw.openPath({ path: 'C:\\Windows\\System32\\calc.exe' }, new AbortController().signal)
    expect(r.ok).toBe(false)
    expect(r.error ?? '').toContain('可执行')
    expect(nativeCalls, '拦截判在调用之后 = 没拦').toEqual([])
  })

  it('根内的普通文件：放行并真的调用系统打开', async () => {
    const dir = join(dataRoot, 'exports')
    mkdirSync(dir, { recursive: true })
    const f = join(dir, 'chat.csv')
    writeFileSync(f, 'a,b')
    const gw = makeGateway()
    const r = await gw.openPath({ path: f }, new AbortController().signal)
    expect(r.ok, r.error ?? '').toBe(true)
    expect(nativeCalls).toEqual([f])
  })

  it('空路径也要给出理由（不许「点了没反应」）', async () => {
    const gw = makeGateway()
    const r = await gw.openPath({ path: '   ' }, new AbortController().signal)
    expect(r.ok).toBe(false)
    expect(r.error ?? '').toContain('没有给出')
    expect(nativeCalls).toEqual([])
  })

  it('export-flows 里两处落盘前都判了政策（源码接线）', async () => {
    const src = readFileSyncSafe(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'query', 'export-flows.ts'))
    expect((src.match(/writeDenialReason\(/g) ?? []).length, '导出落盘的写前校验少了一处')
      .toBeGreaterThanOrEqual(2)
    expect((src.match(/grantRoot\(/g) ?? []).length).toBeGreaterThanOrEqual(2)
    const read = readFileSyncSafe(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'gateway-read.ts'))
    expect(read).toContain('openDenialReason(p, dataRoot)')
  })
})

function readFileSyncSafe(p: string): string {
  if (!existsSync(p)) throw new Error(`找不到被测文件（搬走了要一起改本用例）：${p}`)
  // eslint-disable-next-line no-undef
  return require('node:fs').readFileSync(p, 'utf8') as string
}
