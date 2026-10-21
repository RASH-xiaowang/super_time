/**
 * ACL「先校验、已收紧就跳过」的判据单测（2026-10-21 性能专项）。
 *
 * 背景：`restrictWechatState` 每次启动都对数据根执行
 * `icacls /inheritance:r /grant:r (OI)(CI)F`，Windows 必须把新 ACE 递归传播给
 * 已存在的全部子对象 —— 本机 `decoded_images` 48,539 文件/3.81GiB ⇒ 2.65s，
 * 占「后端 ready」的 87%，且跑在主进程事件循环上。
 *
 * 这里不碰真实 ACL（那会改机器状态、也跑不进 CI 的受限账户）：
 *   ① `parseAclLockedForUser` 用 `icacls` 的真实输出形状做纯函数断言；
 *   ② `restrictWechatState` 的「跳不跳过」用注入的假实现断言。
 * 真正的平台行为仍由 `secure-fs.spec.ts` 用真 icacls 读回验证。
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
// @ts-expect-error —— 宿主层是 CommonJS，无类型声明
import { parseAclLockedForUser, restrictWechatState } from '../secure-fs.js'

/** 本机真实回显形状：`路径 DOMAIN\user:(OI)(CI)(F)` + 本地化汇总行。 */
const REAL_ACL = [
  'C:\\Users\\Administrator\\AppData\\Roaming\\super-time-electron\\wechat-data SK-20260906XION\\Administrator:(OI)(CI)(F)',
  '',
  'Successfully processed 1 files; Failed processing 0 files',
].join('\r\n')

const IDENTITY = { name: 'SK-20260906XION\\Administrator', sid: 'S-1-5-21-111-222-333-1001' }

describe('parseAclLockedForUser：只读判断「已收紧」', () => {
  it('真实形状（路径 + 域名\\用户 + (OI)(CI)(F) + 汇总行）判为已收紧', () => {
    expect(parseAclLockedForUser(REAL_ACL, IDENTITY)).toBe(true)
  })

  it('本地化汇总行不影响判断（只认 ACE 行）', () => {
    const zh = 'C:\\d SK-20260906XION\\Administrator:(OI)(CI)(F)\r\n已成功处理 1 个文件; 处理 0 个文件'
    expect(parseAclLockedForUser(zh, IDENTITY)).toBe(true)
  })

  it('SID 形态的主体同样认（icacls 解析不出名字时会回显 SID）', () => {
    const acl = 'C:\\d S-1-5-21-111-222-333-1001:(OI)(CI)(F)'
    expect(parseAclLockedForUser(acl, IDENTITY)).toBe(true)
  })

  it('裸用户名形态也认（授权按用户名而不是 SID 时）', () => {
    const acl = 'C:\\d Administrator:(OI)(CI)(F)'
    expect(parseAclLockedForUser(acl, { name: 'Administrator', sid: '' })).toBe(true)
  })

  it('还有继承来的 ACE（(I)）⇒ 不算已收紧', () => {
    const acl = 'C:\\d SK-20260906XION\\Administrator:(I)(OI)(CI)(F)'
    expect(parseAclLockedForUser(acl, IDENTITY)).toBe(false)
  })

  it('多条显式 ACE ⇒ 不算已收紧（宁可重跑一次，不放过无法识别的主体）', () => {
    const acl = [
      'C:\\d SK-20260906XION\\Administrator:(OI)(CI)(F)',
      'C:\\d BUILTIN\\Users:(OI)(CI)(R)',
    ].join('\r\n')
    expect(parseAclLockedForUser(acl, IDENTITY)).toBe(false)
  })

  it('权限不完整：缺 (OI) / 缺 (CI) / 只有 (F) 都不算', () => {
    expect(parseAclLockedForUser('C:\\d SK-20260906XION\\Administrator:(CI)(F)', IDENTITY)).toBe(false)
    expect(parseAclLockedForUser('C:\\d SK-20260906XION\\Administrator:(OI)(F)', IDENTITY)).toBe(false)
    expect(parseAclLockedForUser('C:\\d SK-20260906XION\\Administrator:(F)', IDENTITY)).toBe(false)
  })

  it('主体不是当前身份 ⇒ 不算', () => {
    const acl = 'C:\\d SK-20260906XION\\someoneelse:(OI)(CI)(F)'
    expect(parseAclLockedForUser(acl, IDENTITY)).toBe(false)
  })

  it('空输出 / 只有汇总行 ⇒ 不算', () => {
    expect(parseAclLockedForUser('', IDENTITY)).toBe(false)
    expect(parseAclLockedForUser('Successfully processed 1 files; Failed processing 0 files', IDENTITY)).toBe(false)
  })
})

describe('restrictWechatState：已收紧就跳过递归传播', () => {
  /** 造一组纯内存依赖，记录每个入口被调了几次。 */
  function harness(opts: { locked: boolean, dirResult?: { ok: boolean, detail?: string } }) {
    const calls = { restrictDir: 0, restrictFile: 0, isDirAclLocked: 0 }
    const deps = {
      existsSync: (p: string) => p.endsWith('secrets.json'), // 只让一个敏感文件"存在"
      isDirAclLocked: () => { calls.isDirAclLocked += 1; return opts.locked },
      restrictDir: () => { calls.restrictDir += 1; return opts.dirResult ?? { ok: true } },
      restrictFile: () => { calls.restrictFile += 1; return { ok: true } },
    }
    return { calls, deps }
  }

  it('两个目录都已收紧 ⇒ 一次递归都不做，但文件级收紧照做', () => {
    const h = harness({ locked: true })
    const r = restrictWechatState({ stateDir: 'S', dataRoot: 'D' }, h.deps)
    expect(r.ok).toBe(true)
    expect(r.failures).toEqual([])
    expect(r.skipped).toEqual(['S', 'D'])
    expect(h.calls.restrictDir, '已收紧还重写整棵子树就是这次要消掉的 2.6s').toBe(0)
    expect(h.calls.restrictFile, '文件级收紧很便宜，且新文件可能没有显式 ACE').toBe(2)
    expect(typeof r.elapsedMs).toBe('number')
    expect(r.elapsedMs).toBeGreaterThanOrEqual(0)
  })

  it('未收紧 ⇒ 两个目录都真的执行收紧', () => {
    const h = harness({ locked: false })
    const r = restrictWechatState({ stateDir: 'S', dataRoot: 'D' }, h.deps)
    expect(r.ok).toBe(true)
    expect(r.skipped).toEqual([])
    expect(h.calls.restrictDir).toBe(2)
  })

  it('SUPERTIME_FORCE_ACL=1 ⇒ 即使已收紧也强制重跑（事故恢复/诊断开关）', () => {
    const h = harness({ locked: true })
    const r = restrictWechatState({ stateDir: 'S', dataRoot: 'D' }, { ...h.deps, env: { SUPERTIME_FORCE_ACL: '1' } })
    expect(r.skipped).toEqual([])
    expect(h.calls.restrictDir).toBe(2)
  })

  it('收紧失败聚合成 failures（启动不因此中断）', () => {
    const h = harness({ locked: false, dirResult: { ok: false, detail: 'boom' } })
    const r = restrictWechatState({ stateDir: 'S', dataRoot: 'D' }, h.deps)
    expect(r.ok).toBe(false)
    expect(r.failures).toEqual(['S: boom', 'D: boom'])
  })

  it('空路径不参与（不报错也不调 icacls）', () => {
    const h = harness({ locked: false })
    const r = restrictWechatState({}, h.deps)
    expect(r.ok).toBe(true)
    expect(h.calls.isDirAclLocked).toBe(0)
    expect(h.calls.restrictDir).toBe(0)
  })
})
