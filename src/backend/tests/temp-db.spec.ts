/**
 * N26：临时库夹具助手（`helpers/temp-db.ts`）——「先关闭、再重试」的顺序必须真的成立。
 *
 * ## 这些用例在钉什么
 *
 * ① **连接登记册**：经助手打开的库，即使用例代码**故意不 close**（模拟断言抛错提前返回、
 *    catch 分支忘了 close 这些真实漏法），`cleanup()` 也要能把目录删掉。这一条是本助手
 *    存在的主要理由 —— 把「删不掉」从时序运气变成流水线。
 * ② **反面（诊断的实测记录）**：不经助手的裸连接不 close 时，目录**确定性**删不掉，
 *    且退避重试**救不回来**。这条不是为了「让用例通过」，而是把 N26 的病因钉在用例里：
 *    若哪天有人把重试当成万能药，这条会提醒他问题不在重试。
 * ③ **收尾时机**：用例体抛错时也要关连接 + 删目录（`withTempWorkspace` 的 finally）。
 * ④ **退避重试本身**：注入假的删除实现，确定性地验证「前几次失败照样最终成功、次数有界、
 *    非瞬态错误码不重试」。
 *
 * ## 环境限定（如实标注）
 *
 * ②③④ 依赖 **Windows** 的「打开的文件不能被删除」语义（本机 win32）。在类 Unix 上
 * 未关闭的连接不会阻止 unlink，②会变成恒真的空转 —— 因此它带 `process.platform` 前置判断，
 * 非 Windows 上显式跳过（而不是悄悄绿掉）。
 *
 * @vitest-environment node
 */
import { existsSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'

import {
  TEMP_DIR_PREFIX,
  closeAllTrackedDbs,
  createTempWorkspace,
  openTrackedDb,
  removeDirWithRetry,
  withTempWorkspace,
} from './helpers/temp-db.ts'

const isWindows = process.platform === 'win32'

describe('N26：临时库夹具助手', () => {
  it('目录前缀保持 wx-（验收口径是 %TEMP%\\wx-* 不再新增残留）', async () => {
    const ws = createTempWorkspace('n26-probe')
    try {
      expect(ws.dir).toContain(`${TEMP_DIR_PREFIX}n26-probe-`)
    } finally {
      await ws.cleanup()
    }
  })

  it('助手能建库、能登记连接，cleanup 后目录消失', async () => {
    const ws = createTempWorkspace('n26-ok')
    const db = ws.db('a.db')
    db.exec('CREATE TABLE t (x INTEGER)')
    db.prepare('INSERT INTO t VALUES (?)').run(1)
    expect(db.prepare('SELECT COUNT(*) AS c FROM t').get()).toEqual({ c: 1 })
    expect(existsSync(ws.dir)).toBe(true)

    const r = await ws.cleanup()
    expect(r.ok, `删目录失败（${r.code}）`).toBe(true)
    expect(existsSync(ws.dir), 'cleanup 之后目录还在').toBe(false)
  })

  it('**用例忘了 close（含 catch 里忘了 close）时，cleanup 仍能删掉目录**', async () => {
    const ws = createTempWorkspace('n26-leak')
    // 模拟真实的漏法：断言抛错提前返回 / catch 分支忘了 close —— 连接被有意留在打开状态
    const leaked = ws.db('wechat_rag_vectors.db')
    leaked.exec('CREATE TABLE vectors (x INTEGER)')
    const db2 = ws.db('wechat_search.db')
    db2.exec('CREATE TABLE message_meta (x INTEGER)')
    expect(leaked.isOpen).toBe(true)

    const r = await ws.cleanup()
    expect(leaked.isOpen, 'cleanup 没有关闭登记过的连接').toBe(false)
    expect(r.ok, `登记册没关干净 ⇒ 删目录失败（${r.code}）`).toBe(true)
    expect(existsSync(ws.dir)).toBe(false)
  })

  it.skipIf(!isWindows)('反面实测：**不经助手的裸连接**不 close 时，重试也删不掉（病因不是 GC 时序）', async () => {
    const ws = createTempWorkspace('n26-raw')
    try {
      // 绕过助手的登记册：直接开一条裸连接（模拟老写法）
      const raw = new DatabaseSync(ws.path('raw.db'))
      raw.exec('CREATE TABLE t (x INTEGER)')

      const r = await removeDirWithRetry(ws.dir, { attempts: 4, delayMs: 1 })
      expect(r.ok, '裸连接还开着却能删掉 —— 本用例的前提（Windows 锁文件）在这个环境不成立').toBe(false)
      expect(r.code).toBe('EPERM')
      expect(existsSync(ws.dir), '失败时目录应原样留在 %TEMP%（fail 有痕迹，不是静默）').toBe(true)

      // 关掉之后立刻就能删 —— 证明瓶颈就是「连接是否关闭」，与重试次数无关
      raw.close()
      const again = await removeDirWithRetry(ws.dir, { attempts: 1, delayMs: 1 })
      expect(again.ok, `close() 之后仍删不掉（${again.code}）`).toBe(true)
    } finally {
      await ws.cleanup()
    }
  })

  it('用例体抛错时也会收尾（连接关闭 + 目录删除）', async () => {
    let seen = ''
    await expect(withTempWorkspace('n26-throw', async (ws) => {
      seen = ws.dir
      const db = ws.db('x.db')
      db.exec('CREATE TABLE t (x INTEGER)')
      throw new Error('用例体失败')
    })).rejects.toThrow('用例体失败')
    expect(seen, '工作区没有传给用例体').not.toBe('')
    // 目录能删掉本身就是「连接已关闭」的充分证据（Windows 上未关闭就删不掉）
    expect(existsSync(seen), '用例失败后目录没被清掉').toBe(false)
  })

  it('cleanup 幂等：重复调用不抛错，且第二次也能报告「目录已不存在」', async () => {
    const ws = createTempWorkspace('n26-idem')
    ws.db('a.db')
    const first = await ws.cleanup()
    const second = await ws.cleanup()
    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)
    // 第二次没有连接可关（登记册已清空）
    expect(ws.closeAll()).toBe(0)
  })

  it('退避重试：瞬态失败会重试到成功，且失败次数有界', async () => {
    let calls = 0
    const transient = await removeDirWithRetry('whatever', {
      attempts: 5,
      rm: () => { calls += 1; if (calls < 3) { const e = new Error('locked') as NodeJS.ErrnoException; e.code = 'EBUSY'; throw e } },
      wait: async () => { /* 不真的等 */ },
    })
    expect(transient).toEqual({ ok: true, attempts: 3 })

    calls = 0
    const giveUp = await removeDirWithRetry('whatever', {
      attempts: 4,
      rm: () => { calls += 1; const e = new Error('locked') as NodeJS.ErrnoException; e.code = 'EPERM'; throw e },
      wait: async () => { /* 不真的等 */ },
    })
    expect(giveUp).toEqual({ ok: false, attempts: 4, code: 'EPERM' })
    expect(calls, '重试次数必须等于 attempts（有界）').toBe(4)

    // 非瞬态错误码不重试：重试一万次也不会变好
    calls = 0
    const denied = await removeDirWithRetry('whatever', {
      attempts: 4,
      rm: () => { calls += 1; const e = new Error('denied') as NodeJS.ErrnoException; e.code = 'EACCES'; throw e },
      wait: async () => { /* 不真的等 */ },
    })
    expect(denied).toEqual({ ok: false, attempts: 1, code: 'EACCES' })
    expect(calls).toBe(1)
  })

  it('按路径开的库（辅助函数里只有目录字符串的场景）也能被登记册兜住', async () => {
    const ws = createTempWorkspace('n26-bypath')
    // 模拟 oracle 这类只拿到路径的辅助函数：不走 ws.db，直接按路径开（会被登记册收编）
    const byPath = openTrackedDb(ws.path('wechat_rag_vectors.db'))
    byPath.exec('CREATE TABLE vectors (x INTEGER)')
    expect(byPath.isOpen).toBe(true)

    const r = await ws.cleanup()
    expect(byPath.isOpen, '按路径开的连接没有被登记册关掉').toBe(false)
    expect(r.ok, `删目录失败（${r.code}）`).toBe(true)
    expect(existsSync(ws.dir)).toBe(false)
  })

  it('closeAllTrackedDbs 关闭登记册里的连接，已关过的跳过且幂等', () => {
    const ws = createTempWorkspace('n26-array')
    const a = ws.db('a.db')
    const b = ws.db('b.db')
    b.close()
    expect(closeAllTrackedDbs(), '只应关掉还开着的那条').toBe(1)
    expect(closeAllTrackedDbs(), '幂等：再关一次是 0').toBe(0)
    expect(a.isOpen).toBe(false)
    void ws.cleanup()
  })
})
