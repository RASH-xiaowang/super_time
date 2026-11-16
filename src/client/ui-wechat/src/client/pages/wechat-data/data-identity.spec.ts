/**
 * 数据目录身份（换账号 / 换数据目录）的**行为**判据。
 *
 * ## 这里守的四件事
 *
 *   ① 身份变化判定：只有目录或密钥真的变了才算变化，同一目录的大小写 / 分隔符差异不算；
 *   ② 保存后确实调用了三层失效（快照/持久缓存、图片内存缓存、头像复位信号）——
 *      「清了缓存」这句话必须有可观察的动作，不能只写在注释里；
 *   ③ 渲染缓存键带目录指纹：换目录后同一个 talker 的旧消息**天然读不到**，
 *      否则用户会先看到上一个账号的聊天记录一帧；
 *   ④ 前缀失效能穿透命名空间：`invalidateAndNotify('chat-msgs:')` 要能清掉
 *      `acct-<指纹>:chat-msgs:…`，否则「删消息 / 换账号」清不干净。
 *
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  applyDataIdentityAfterSave,
  dataDirFingerprint,
  dataIdentityChanged,
  getDataIdentitySnapshot,
  invalidateAndNotify,
  normalizeDataDir,
  readRenderCache,
  rememberDataIdentity,
  scopedRenderCacheKey,
  snapshotHit,
  snapshotSet,
  subscribeSnapshot,
  writeRenderCache,
  type DataIdentityCacheOps,
} from './cache.ts'

const BASE = {
  db_dir: 'D:\\WeChat\\acct-a',
  db_enc_key: 'db-key-1',
  image_aes_key: 'img-aes-1',
  image_xor_key: 136,
} as const

const CHAT_KEY = 'chat-msgs:v2:wxid_alice'

/** 当前 localStorage 里的渲染缓存键（含 `wxdata-render-cache:` 前缀）。 */
function renderKeys(): string[] {
  const keys: string[] = []
  for (let i = 0; i < localStorage.length; i += 1) {
    const key = localStorage.key(i)
    if (key !== null) keys.push(key)
  }
  return keys.filter((key) => key.startsWith('wxdata-render-cache:'))
}

function makeOps(): Required<DataIdentityCacheOps> {
  return { invalidateAll: vi.fn(), forgetImages: vi.fn(), notifyAvatar: vi.fn() }
}

beforeEach(() => {
  localStorage.clear()
  // 每个用例从同一份基线开始：remember 会同时重置「当前目录」与比较基线。
  rememberDataIdentity(BASE)
})

describe('目录归一化与指纹', () => {
  it('Windows 路径的大小写 / 反斜杠 / 尾部斜杠不产生新身份', () => {
    expect(normalizeDataDir('  D:\\WeChat\\Acct-A\\  ')).toBe('d:/wechat/acct-a')
    expect(dataDirFingerprint('D:\\WeChat\\Acct-A\\')).toBe(dataDirFingerprint('d:/wechat/acct-a'))
    expect(dataDirFingerprint(undefined)).toBe(dataDirFingerprint(''))
  })

  it('不同目录得到不同指纹，且指纹是 8 位十六进制（不泄露目录明文）', () => {
    const a = dataDirFingerprint('D:/WeChat/acct-a')
    const b = dataDirFingerprint('D:/WeChat/acct-b')
    expect(a).toMatch(/^[0-9a-f]{8}$/)
    expect(a).not.toBe(b)
  })

  it('dataIdentityChanged：目录或三类密钥变化才算变化（仅分隔符差异不算）', () => {
    expect(dataIdentityChanged(BASE, BASE)).toBe(false)
    expect(dataIdentityChanged({ ...BASE, db_dir: 'd:/wechat/ACCT-A/' }, BASE)).toBe(false)
    expect(dataIdentityChanged({ ...BASE, db_dir: 'D:/WeChat/acct-b' }, BASE)).toBe(true)
    expect(dataIdentityChanged({ ...BASE, db_enc_key: 'db-key-2' }, BASE)).toBe(true)
    expect(dataIdentityChanged({ ...BASE, image_aes_key: 'img-aes-2' }, BASE)).toBe(true)
    expect(dataIdentityChanged({ ...BASE, image_xor_key: 137 }, BASE)).toBe(true)
    // 数字 / 字符串形式相同不算变化（表单里是字符串，保存的是数字）。
    expect(dataIdentityChanged({ ...BASE, image_xor_key: '136' }, BASE)).toBe(false)
  })

  it('没有基线时，只有「空配置」才算没变化（首次保存空值不该白清一次缓存）', () => {
    const empty = { db_dir: '', db_enc_key: '', image_aes_key: '', image_xor_key: 0 }
    expect(dataIdentityChanged(empty, null)).toBe(false)
    expect(dataIdentityChanged({ ...empty, db_dir: 'D:/WeChat/acct-a' }, null)).toBe(true)
    expect(dataIdentityChanged({ ...empty, db_enc_key: 'k' }, null)).toBe(true)
  })
})

describe('保存后的缓存失效', () => {
  it('目录 / 密钥没变时什么都不做（避免每次点保存都白清一次）', () => {
    const ops = makeOps()
    const before = getDataIdentitySnapshot()
    expect(applyDataIdentityAfterSave(BASE, ops)).toBe(false)
    expect(ops.invalidateAll).not.toHaveBeenCalled()
    expect(ops.forgetImages).not.toHaveBeenCalled()
    expect(ops.notifyAvatar).not.toHaveBeenCalled()
    expect(getDataIdentitySnapshot()).toBe(before)
  })

  it('目录变化时调用三层失效并推进身份（keep-alive 据此重挂）', () => {
    const ops = makeOps()
    const before = getDataIdentitySnapshot()
    expect(applyDataIdentityAfterSave({ ...BASE, db_dir: 'E:/WeChat/acct-b' }, ops)).toBe(true)
    expect(ops.invalidateAll).toHaveBeenCalledTimes(1)
    expect(ops.forgetImages).toHaveBeenCalledTimes(1)
    expect(ops.notifyAvatar).toHaveBeenCalledTimes(1)
    expect(getDataIdentitySnapshot()).not.toBe(before)
    // 已切换到新基线：同样的配置再保存一次不再失效。
    expect(applyDataIdentityAfterSave({ ...BASE, db_dir: 'E:/WeChat/acct-b' }, ops)).toBe(false)
    expect(ops.invalidateAll).toHaveBeenCalledTimes(1)
  })

  it('只换密钥（目录不变）同样要失效 —— 图片必须按新密钥重解', () => {
    const ops = makeOps()
    expect(applyDataIdentityAfterSave({ ...BASE, image_aes_key: 'img-aes-2' }, ops)).toBe(true)
    expect(ops.forgetImages).toHaveBeenCalledTimes(1)
  })

  it('默认实现会清掉持久渲染缓存（会话 / 旧账号消息都不再命中）', () => {
    writeRenderCache('sessions:v1', [{ id: 's1' }])
    writeRenderCache(CHAT_KEY, { messages: [1] })
    expect(renderKeys().length).toBe(2)

    expect(applyDataIdentityAfterSave({ ...BASE, db_dir: 'F:/WeChat/acct-c' })).toBe(true)
    expect(renderKeys()).toEqual([])
  })

  it('默认实现硬清内存快照并通知订阅者回源（不把旧账号以 stale 名义再画一帧）', () => {
    snapshotSet('sessions:x', { rows: ['旧账号'] })
    let notified = 0
    const unsubscribe = subscribeSnapshot('sessions:x', () => { notified += 1 })
    expect(snapshotHit('sessions:x')).toEqual({ rows: ['旧账号'] })

    expect(applyDataIdentityAfterSave({ ...BASE, db_dir: 'G:/WeChat/acct-d' })).toBe(true)
    expect(snapshotHit('sessions:x'), '换账号后旧快照仍可命中').toBeUndefined()
    expect(notified, '换账号后没有通知订阅者重新取数').toBeGreaterThanOrEqual(1)
    unsubscribe()
  })
})

describe('渲染缓存键的目录命名空间', () => {
  it('所有渲染缓存键都带指纹（消息 / 会话 / 群洞察 / 朋友圈一视同仁）', () => {
    const fp = dataDirFingerprint(BASE.db_dir)
    expect(scopedRenderCacheKey(CHAT_KEY)).toBe(`acct-${fp}:${CHAT_KEY}`)
    for (const key of ['sessions:v1', 'group-insights:wxid_room', 'monitor:wxid_friend', 'moments:all', 'kb-list:k1']) {
      expect(scopedRenderCacheKey(key), `${key} 没有带目录指纹`).toBe(`acct-${fp}:${key}`)
    }
  })

  it('写入后 localStorage 键含目录指纹；换目录后同逻辑键读不到旧账号数据', () => {
    const oldFp = dataDirFingerprint(BASE.db_dir)
    writeRenderCache(CHAT_KEY, { messages: ['旧账号'] })
    const stored = `wxdata-render-cache:acct-${oldFp}:${CHAT_KEY}`
    expect(renderKeys()).toContain(stored)
    expect(readRenderCache(CHAT_KEY)).toEqual({ messages: ['旧账号'] })

    // 只换目录、不做持久层清理，专门验证「键本身就读不到」这一道保险。
    applyDataIdentityAfterSave({ ...BASE, db_dir: 'E:/WeChat/acct-b' }, makeOps())
    expect(readRenderCache(CHAT_KEY), '换目录后仍读到了旧账号的消息缓存').toBeNull()
    // 旧条目仍在磁盘上（由失效逻辑负责清），但当前身份的键已经不同。
    expect(renderKeys()).toContain(stored)
  })

  it('升级前写入的无前缀条目不再命中，且读/写都会顺手清掉（不白占配额）', () => {
    const legacy = `wxdata-render-cache:${CHAT_KEY}`
    const envelope = JSON.stringify({ at: Date.now(), v: { messages: ['上一个版本'] } })
    localStorage.setItem(legacy, envelope)
    expect(readRenderCache(CHAT_KEY), '旧版无前缀缓存仍然被读到了').toBeNull()
    expect(localStorage.getItem(legacy), '旧版无前缀缓存没有被清掉').toBeNull()

    localStorage.setItem(legacy, envelope)
    writeRenderCache(CHAT_KEY, { messages: ['新版本'] })
    expect(localStorage.getItem(legacy), '写入新键时没有顺手清掉同逻辑键的旧条目').toBeNull()
    expect(readRenderCache(CHAT_KEY)).toEqual({ messages: ['新版本'] })
  })

  it('前缀失效能穿透目录命名空间，且不误伤其它缓存族', () => {
    const oldFp = dataDirFingerprint(BASE.db_dir)
    writeRenderCache(CHAT_KEY, { messages: [1] })
    writeRenderCache('sessions:v1', [{ id: 's1' }])
    expect(renderKeys()).toContain(`wxdata-render-cache:acct-${oldFp}:${CHAT_KEY}`)
    expect(renderKeys()).toContain(`wxdata-render-cache:acct-${oldFp}:sessions:v1`)

    invalidateAndNotify('chat-msgs:')
    expect(renderKeys().filter((key) => key.includes(CHAT_KEY)), '带指纹的消息缓存没被前缀清掉').toEqual([])
    expect(readRenderCache('sessions:v1'), '前缀失效误伤了会话缓存').toEqual([{ id: 's1' }])
  })
})
