import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'

function bridge(getPathForFile: (file: unknown) => string) {
  const invoke = vi.fn()
  let exposed: { kbFiles: { getPathForFile: (file: unknown) => string } } | undefined
  const exposeInMainWorld = (_name: string, value: typeof exposed) => { exposed = value }
  runInNewContext(readFileSync('preload.js', 'utf8'), { require: () => ({ contextBridge: { exposeInMainWorld }, ipcRenderer: { invoke }, webUtils: { getPathForFile } }) })
  return { api: exposed!, invoke }
}
describe('KB native File bridge', () => {
  it('resolves the native File without adding an IPC or bypassing registration gates', () => {
    const file = {}; const resolve = vi.fn(() => 'C:/fixture.txt')
    const { api, invoke } = bridge(resolve)
    expect(api.kbFiles.getPathForFile(file)).toBe('C:/fixture.txt')
    expect(resolve).toHaveBeenCalledWith(file)
    expect(invoke).not.toHaveBeenCalled()
    expect(Object.isFrozen(api.kbFiles)).toBe(true)
  })
  it('preserves the synthetic-File empty-path result', () => {
    expect(bridge(() => '').api.kbFiles.getPathForFile({})).toBe('')
  })
  it('lets malformed File errors reach per-item UI handling rather than inventing a path', () => {
    expect(() => bridge(() => { throw new TypeError('File required') }).api.kbFiles.getPathForFile('fake')).toThrow('File required')
  })
})
