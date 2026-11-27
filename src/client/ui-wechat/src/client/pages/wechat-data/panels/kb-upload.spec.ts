import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { createKbUploadManager, KB_UPLOAD_MAX_BYTES, prepareUploads } from './kb-upload.ts'
import type { KbFileAddResult } from '../types.ts'
const file = (name = 'one.txt') => ({ name, path: 'C:/' + name })
const ok = (): KbFileAddResult => ({ ok: true, added: 1, failed: 0, results: [{ ok: true }] })
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r }); return { promise, resolve } }

describe('KB upload metadata validation (backend remains authoritative)', () => {
  it('isolates mixed supported, unsupported, missing-path and directory errors', () => {
    const rows = prepareUploads([file('a.TXT'), file('b.exe'), { name: 'c.md' }, { name: 'folder', error: '不支持文件夹' }])
    expect(rows.map(row => row.status)).toEqual(['queued', 'failed', 'failed', 'failed'])
    expect(rows[3]?.detail).toBe('不支持文件夹')
  })
  it('shares the backend 32 MiB bound and allows exactly the bound', () => {
    const backend = readFileSync('src/backend/wechat-data/src/query/kb-files-store.ts', 'utf8')
    expect(backend).toContain('MAX_FILE_BYTES = 32 * 1024 * 1024')
    expect(prepareUploads([{ ...file(), size: KB_UPLOAD_MAX_BYTES }, { ...file('two.txt'), size: KB_UPLOAD_MAX_BYTES + 1 }]).map(r => r.status)).toEqual(['queued', 'failed'])
  })
  it('keeps the existing empty-file policy; no made-up MIME whitelist', () => {
    expect(prepareUploads([{ ...file(), size: 0 }])[0]?.status).toBe('queued')
    expect(prepareUploads([file('txt')])[0]?.status).toBe('failed')
    expect(prepareUploads([file('.txt')])[0]?.status).toBe('failed')
  })
  it('deduplicates case-insensitive Windows paths and separator variants, not names', () => {
    const rows = prepareUploads([{ name: 'a.txt', path: 'C:\\Data\\a.txt' }, { name: 'a.txt', path: 'c:/data/A.txt' }, { name: 'a.txt', path: 'D:/a.txt' }])
    expect(rows.map(r => r.status)).toEqual(['queued', 'failed', 'queued'])
    expect(rows[1]?.detail).toContain('本批次')
  })
})

describe('KB upload registration queue', () => {
  it('holds one synchronous lock, uses bounded sequential RPC and snapshots do not mutate', async () => {
    const first = deferred<KbFileAddResult>()
    const register = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue(ok())
    const manager = createKbUploadManager(register)
    const run = manager.start(1, [file(), file('two.txt')])
    const before = manager.getSnapshot().batches.get(1)!
    expect(before.items.map(i => i.status)).toEqual(['processing', 'queued'])
    expect(await manager.start(1, [file()])).toBe(false)
    expect(await manager.start(2, [file()])).toBe(false)
    expect(register).toHaveBeenCalledTimes(1)
    first.resolve(ok()); await run
    expect(register.mock.calls.map(call => call[1])).toEqual([['C:/one.txt'], ['C:/two.txt']])
    expect(before.items.map(i => i.status)).toEqual(['processing', 'queued'])
    expect(manager.getSnapshot().activeKb).toBeNull()
  })
  it('handles mixed validation and per-file transport failures without dropping the batch', async () => {
    const register = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(ok())
    const manager = createKbUploadManager(register)
    await manager.start(1, [file(), file('bad.exe'), file('last.md')])
    const batch = manager.getSnapshot().batches.get(1)!
    expect(batch.items.map(i => i.status)).toEqual(['failed', 'failed', 'added'])
    expect(batch.items[0]?.detail).toContain('未确认')
    expect(batch.items[0]?.retryable).toBe(true)
    expect(batch.items[1]?.retryable).toBe(false)
    await manager.start(1, [batch.items[0]!])
    expect(manager.getSnapshot().batches.get(1)?.items[0]?.status).toBe('added')
  })
  it('stops pending work but retains a successful in-flight registration and receipts', async () => {
    const pending = deferred<KbFileAddResult>()
    const register = vi.fn(() => pending.promise)
    const manager = createKbUploadManager(register)
    const run = manager.start(1, [file(), file('two.txt')])
    manager.cancel(1)
    expect(manager.getSnapshot().activeKb).toBe(1)
    expect(manager.getSnapshot().batches.get(1)?.message).toContain('当前请求仍会完成')
    pending.resolve(ok()); await run
    expect(register).toHaveBeenCalledTimes(1)
    expect(manager.getSnapshot().batches.get(1)?.items.map(i => i.status)).toEqual(['added', 'cancelled'])
    expect(manager.getSnapshot().batches.get(1)?.items[1]?.retryable).toBe(true)
  })
  it('locks before the picker resolves, including rapid keyboard/mouse activation', async () => {
    const selected = deferred<{ canceled: boolean; files: string[] }>()
    const register = vi.fn().mockResolvedValue(ok())
    const manager = createKbUploadManager(register)
    const pick = vi.fn(() => selected.promise)
    const run = manager.pick(1, pick)
    expect(await manager.pick(1, pick)).toBe(false)
    expect(pick).toHaveBeenCalledTimes(1)
    selected.resolve({ canceled: false, files: ['C:/one.txt', 'c:/ONE.txt'] }); await run
    expect(register).toHaveBeenCalledTimes(1)
  })
  it('releases lock after native cancellation and dialog errors, then can retry', async () => {
    const register = vi.fn().mockResolvedValue(ok())
    const manager = createKbUploadManager(register)
    await manager.pick(1, async () => ({ canceled: true, files: [] }))
    expect(manager.getSnapshot().activeKb).toBeNull()
    await manager.pick(1, async () => { throw new Error('dialog failed') })
    expect(manager.getSnapshot().batches.get(1)?.message).toBe('dialog failed')
    expect(manager.getSnapshot().activeKb).toBeNull()
    await manager.start(1, [file()])
    expect(register).toHaveBeenCalledTimes(1)
  })
  it('does not register a late picker result after scope cancellation', async () => {
    const selected = deferred<{ canceled: boolean; files: string[] }>()
    const register = vi.fn()
    const manager = createKbUploadManager(register)
    const run = manager.pick(1, () => selected.promise)
    manager.cancel(1)
    selected.resolve({ canceled: false, files: ['C:/one.txt'] }); await run
    expect(register).not.toHaveBeenCalled()
    expect(manager.getSnapshot().activeKb).toBeNull()
  })
  it('keeps content-duplicate errors non-retryable and preserves server error detail', async () => {
    const manager = createKbUploadManager(async () => ({ ok: false, added: 0, failed: 1, results: [{ ok: false, code: 'duplicate', error: '内容与库里已有文件相同' }] }))
    await manager.start(1, [file()])
    expect(manager.getSnapshot().batches.get(1)?.items[0]).toMatchObject({ status: 'failed', retryable: false, detail: '内容与库里已有文件相同' })
  })
  it('shows top-level errors when no per-item reply is returned', async () => {
    const manager = createKbUploadManager(async () => ({ ok: false, added: 0, failed: 1, results: [], error: '知识库不存在' }))
    await manager.start(1, [file()])
    expect(manager.getSnapshot().batches.get(1)?.items[0]?.detail).toBe('知识库不存在')
  })
  it('retains per-KB receipts across subscription teardown and clears only on explicit dismissal', async () => {
    const manager = createKbUploadManager(async () => ok())
    const listener = vi.fn(); const off = manager.subscribe(listener)
    await manager.start(1, [file()]); off()
    await manager.start(2, [file('two.md')])
    expect(manager.getSnapshot().batches.get(1)?.items[0]?.status).toBe('added')
    manager.dismiss(2)
    expect(manager.getSnapshot().batches.has(1)).toBe(true)
    expect(manager.getSnapshot().batches.has(2)).toBe(false)
  })
  it('empty files are registered honestly as no-body rather than fake upload percent', async () => {
    const manager = createKbUploadManager(async () => ok())
    await manager.start(1, [{ ...file(), size: 0 }])
    expect(manager.getSnapshot().batches.get(1)?.items[0]?.detail).toContain('空文件')
  })
})
