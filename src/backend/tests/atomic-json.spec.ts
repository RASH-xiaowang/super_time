/**
 * M2：配置写入必须是原子的，且「解析不了的原文件」不能被无声覆盖。
 *
 * 为什么值得单独测：直接 `writeFileSync` 到目标路径时，写一半被杀进程/磁盘满会留下
 * **截断的 JSON**；而 config.json 里有数据根路径与密钥字段，读到截断内容会静默回落
 * 默认值（用户看到「配置莫名丢了」），并且**下一次保存就把残缺内容覆盖掉**。
 * 这里覆盖两份等价实现：宿主层 `src/backend/wechat-paths.js`（CJS）与后端
 * `src/backend/wechat-data/src/query/config.ts`（走 esbuild bundle）。
 * @vitest-environment node
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
// @ts-expect-error —— 宿主层是 CommonJS，无类型声明
import { preserveIfUnparseable as hostPreserve, writeFileAtomic as hostWrite } from '../wechat-paths.js'
import { preserveIfUnparseable as tsPreserve, saveConfig, writeFileAtomic as tsWrite } from '../wechat-data/src/query/config.ts'

const scratch: string[] = []
afterEach(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true })
  scratch.length = 0
})

/** 每个用例一个独立目录：配置路径是「解密目录的兄弟文件」，共用父目录会互相串。 */
function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'atomic-json-'))
  scratch.push(root)
  return root
}

const IMPLS = [
  { name: 'wechat-paths.js（宿主层）', write: hostWrite as (p: string, t: string) => void, preserve: hostPreserve as (p: string) => void },
  { name: 'query/config.ts（后端）', write: tsWrite as (p: string, t: string) => void, preserve: tsPreserve as (p: string) => void },
] as const

describe('原子写与损坏文件保留', () => {
  for (const impl of IMPLS) {
    it(`${impl.name}：写入内容正确且不留 .tmp- 残留`, () => {
      const p = join(tempRoot(), 'config.json')
      impl.write(p, JSON.stringify({ a: 1 }, null, 2))
      expect(JSON.parse(readFileSync(p, 'utf8'))).toEqual({ a: 1 })
      expect(readdirSync(join(p, '..')).filter((f) => f.includes('.tmp-'))).toEqual([])
    })

    it(`${impl.name}：合法 JSON 不被改名`, () => {
      const p = join(tempRoot(), 'config.json')
      impl.write(p, '{"ok":true}')
      impl.preserve(p)
      expect(JSON.parse(readFileSync(p, 'utf8'))).toEqual({ ok: true })
    })

    it(`${impl.name}：损坏的 JSON 被改名保留（内容一字不丢）`, () => {
      const root = tempRoot()
      const p = join(root, 'config.json')
      const broken = '{"dataRoot":"D:\\\\wechat\\\\data", "db_enc_key": "abcd' // 截断的 JSON
      writeFileSync(p, broken, 'utf8')
      impl.preserve(p)
      // 原文件已被移走，留有 .corrupt-* 备份且内容与损坏前逐字节相同
      expect(existsSync(p)).toBe(false)
      const backups = readdirSync(root).filter((f) => f.startsWith('config.json.corrupt-'))
      expect(backups).toHaveLength(1)
      expect(readFileSync(join(root, backups[0]), 'utf8')).toBe(broken)
    })

    it(`${impl.name}：目标不存在时不报错（首次运行）`, () => {
      const p = join(tempRoot(), 'config.json')
      expect(() => impl.preserve(p)).not.toThrow()
    })
  }

  it('saveConfig（后端）覆盖损坏配置前会先备份', () => {
    const root = tempRoot()
    const decrypted = join(root, 'decrypted')
    const p = join(root, 'config.json') // configPath = <decrypted>/../config.json
    writeFileSync(p, '{ not json', 'utf8')

    const res = saveConfig(decrypted, { db_dir: 'D:\\Tencent\\x\\db_storage' })
    expect(res.ok).toBe(true)
    // 新配置可解析且带上了补丁
    expect(JSON.parse(readFileSync(p, 'utf8'))['db_dir']).toBe('D:\\Tencent\\x\\db_storage')
    // 残缺内容留了备份，而不是被无声覆盖
    const backups = readdirSync(root).filter((f) => f.startsWith('config.json.corrupt-'))
    expect(backups).toHaveLength(1)
    expect(readFileSync(join(root, backups[0]), 'utf8')).toBe('{ not json')
  })
})
