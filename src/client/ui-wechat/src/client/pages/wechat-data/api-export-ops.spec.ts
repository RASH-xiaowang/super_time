import { describe, expect, it, vi } from 'vitest'
import { setWechatRemote, type WechatRemote } from './api-core.ts'
import { apiCreateBackup } from './api-export-ops.ts'

describe('备份导出 API', () => {
  it('普通目录备份把 jobId 原样交给后端，并解包写入结果', async () => {
    const createBackup = vi.fn().mockResolvedValue({
      ok: true,
      value: { ok: true, name: 'backup-20261104' },
    })
    setWechatRemote({ createBackup } as unknown as WechatRemote)

    await expect(apiCreateBackup({ jobId: 'backup-plain-test' }))
      .resolves.toEqual({ ok: true, name: 'backup-20261104' })
    expect(createBackup).toHaveBeenCalledWith({ jobId: 'backup-plain-test' })
  })
})
