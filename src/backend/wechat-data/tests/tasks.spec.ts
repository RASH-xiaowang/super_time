/**
 * WeChat task store CRUD over a temp data root.
 * @vitest-environment node
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { deleteTask, insertTask, listTasks, setTaskStatus } from '../src/query/wechat-tasks.ts'

const scratch: string[] = []
afterEach(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true })
  scratch.length = 0
})

function root(): string {
  const base = mkdtempSync(join(tmpdir(), 'wx-tasks-'))
  scratch.push(base)
  const dir = join(base, 'decrypted')
  mkdirSync(dir)
  return dir
}

describe('wechat task store', () => {
  it('inserts, lists, sets status and deletes tasks', () => {
    const dir = root()
    const inserted = insertTask(dir, { title: '周五前交报告' })
    expect(inserted.ok).toBe(true)
    expect(inserted.id).toBeGreaterThan(0)
    const tasks = listTasks(dir)
    expect(tasks.total).toBe(1)
    expect(tasks.items[0]?.title).toBe('周五前交报告')
    expect(tasks.items[0]?.status).toBe('open')
    expect(setTaskStatus(dir, inserted.id as number, 'done').ok).toBe(true)
    expect(listTasks(dir).items[0]?.status).toBe('done')
    expect(deleteTask(dir, inserted.id as number).ok).toBe(true)
    expect(listTasks(dir).total).toBe(0)
  })
})
