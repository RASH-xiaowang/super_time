/**
 * `tools/remote-files.json` 的 freshness 守卫。
 *
 * 网关继承链与前端 `api.ts` 转发桶都由 `scripts/sync-remote-files.mjs` 推导；
 * 这份 manifest 是多个契约工具的共同取数口。它过期时工具会拿旧清单继续跑，
 * 所以这里直接重跑生成器的 `--check`，让过期状态在 `npm test` 就红。
 * @vitest-environment node
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const SYNC = join(ROOT, 'scripts', 'sync-remote-files.mjs')
const MANIFEST = join(ROOT, 'tools', 'remote-files.json')

describe('Remote 文件清单 manifest', () => {
  it('与当前源码推导结果一致', () => {
    const output = execFileSync(process.execPath, [SYNC, '--check'], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    expect(output).toContain('ok:')
  })

  it('两个清单都有实质内容，避免契约工具空转', () => {
    const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8')) as {
      gatewayClassFiles: string[]
      gatewayApiFiles: string[]
    }
    expect(manifest.gatewayClassFiles.length).toBeGreaterThan(5)
    expect(manifest.gatewayClassFiles.at(-1)).toBe('gateway.ts')
    expect(manifest.gatewayApiFiles.length).toBeGreaterThan(5)
    expect(manifest.gatewayApiFiles).toContain('api-core.ts')
  })
})
