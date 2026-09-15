/**
 * 首次配置向导的判定口径。
 *
 * 守两件事：
 *   ① 与设置弹窗的 stepStates 口径一致（两边不一致会让用户看到「向导说没配好、设置里是绿的」）；
 *   ② 语音转写**不阻塞**「配置完成」—— 它是可选增强，引擎没装不该把用户永远卡在未完成。
 *
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import { emptyFacts, firstPendingStep, SETUP_STEPS, setupProgress, stepDone, type SetupFacts } from './setup-guide.ts'

/** 造一份事实：默认全未完成，按需覆盖。 */
function facts(over: Partial<SetupFacts> = {}): SetupFacts {
  return { ...emptyFacts(), ...over }
}

describe('单步判定（口径对齐 Settings 的 stepStates）', () => {
  it('检测账号：有账号或已填目录即完成', () => {
    expect(stepDone('detect', facts())).toBe(false)
    expect(stepDone('detect', facts({ accounts: 1 }))).toBe(true)
    expect(stepDone('detect', facts({ dbDir: 'D:\\xwechat_files\\wxid_a\\db_storage' }))).toBe(true)
    expect(stepDone('detect', facts({ dbDir: '   ' }))).toBe(false)
  })

  it('数据库密钥：密钥文件已加载且有密钥，或手填了密钥', () => {
    expect(stepDone('dbkey', facts())).toBe(false)
    expect(stepDone('dbkey', facts({ keysLoaded: true, keyCount: 22 }))).toBe(true)
    expect(stepDone('dbkey', facts({ keysLoaded: false, keyCount: 22 }))).toBe(false)
    expect(stepDone('dbkey', facts({ keysLoaded: true, keyCount: 0 }))).toBe(false)
    expect(stepDone('dbkey', facts({ dbKey: 'abc' }))).toBe(true)
  })

  it('图片密钥：填了 AES 密钥即完成', () => {
    expect(stepDone('imgkey', facts())).toBe(false)
    expect(stepDone('imgkey', facts({ imgAes: '00112233' }))).toBe(true)
  })

  it('图片解码：以 CDN 开关为准', () => {
    expect(stepDone('img', facts())).toBe(false)
    expect(stepDone('img', facts({ cdnEnabled: true }))).toBe(true)
  })
})

describe('整体进度', () => {
  it('全未完成 → 0/4', () => {
    expect(setupProgress(facts())).toEqual({ done: 0, total: 4, complete: false })
  })

  it('部分完成按实际计数', () => {
    const p = setupProgress(facts({ accounts: 2, keysLoaded: true, keyCount: 22 }))
    expect(p).toEqual({ done: 2, total: 4, complete: false })
  })

  it('四项齐了才算完成', () => {
    const p = setupProgress(facts({ accounts: 1, keysLoaded: true, keyCount: 22, imgAes: 'a', cdnEnabled: true }))
    expect(p).toEqual({ done: 4, total: 4, complete: true })
  })

  it('语音引擎未就绪不影响「完成」（它是可选项）', () => {
    const p = setupProgress(facts({ accounts: 1, keysLoaded: true, keyCount: 1, imgAes: 'a', cdnEnabled: true, voiceReady: false }))
    expect(p.complete).toBe(true)
  })

  it('步骤定义就是这四项，顺序与设置里的配置向导一致', () => {
    expect(SETUP_STEPS.map((s) => s.key)).toEqual(['detect', 'dbkey', 'imgkey', 'img'])
  })
})

describe('继续配置的落点', () => {
  it('落到第一个未完成的步骤', () => {
    expect(firstPendingStep(facts())).toBe('detect')
    expect(firstPendingStep(facts({ accounts: 1 }))).toBe('dbkey')
    expect(firstPendingStep(facts({ accounts: 1, keysLoaded: true, keyCount: 3 }))).toBe('imgkey')
    expect(firstPendingStep(facts({ accounts: 1, keysLoaded: true, keyCount: 3, imgAes: 'a' }))).toBe('img')
  })

  it('全部完成时回落第一步（不会返回 undefined）', () => {
    expect(firstPendingStep(facts({ accounts: 1, keysLoaded: true, keyCount: 1, imgAes: 'a', cdnEnabled: true }))).toBe('detect')
  })
})
