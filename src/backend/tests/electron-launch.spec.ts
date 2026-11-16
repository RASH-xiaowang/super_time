/**
 * `scripts/launch-app.mjs --dry-run` 的真实行为判据。
 *
 * `--dry-run` 是这条启动路径唯一的可测面：它只解析 Electron 路径与应用目录，
 * 并如实报告 `ELECTRON_RUN_AS_NODE` 是否会被摘掉，**不启动任何窗口**。
 *
 * @vitest-environment node
 */
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const LAUNCHER = join(ROOT, 'scripts', 'launch-app.mjs')

describe('launch-app --dry-run', () => {
  it('输出解析结果，并如实报告 ELECTRON_RUN_AS_NODE 的摘除行为', () => {
    const result = spawnSync(process.execPath, [LAUNCHER, '--dry-run'], {
      encoding: 'utf8',
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    })
    // 退出码 2 表示干净检出上还没装 Electron；JSON 仍应输出，可继续断言解析结果。
    expect([0, 2], String(result.stderr ?? '')).toContain(result.status)

    const info = JSON.parse(String(result.stdout ?? '')) as {
      electron: string
      exists: boolean
      appDir: string
      hadRunAsNode: boolean
      stripped: boolean
    }
    expect(info.electron, '没有解析出 Electron 路径').toMatch(/electron(?:\.exe)?$/i)
    expect(info.appDir).toBe(ROOT)
    expect(info.hadRunAsNode, '没有如实报告环境里的 ELECTRON_RUN_AS_NODE').toBe(true)
    expect(info.stripped, 'dry-run 声称没摘 ELECTRON_RUN_AS_NODE').toBe(true)
  })
})
