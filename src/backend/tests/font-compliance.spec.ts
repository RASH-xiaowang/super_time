/**
 * 字体合规门禁的冒烟守卫。
 *
 * 字体合规的判据在 `scripts/font-compliance-check.mjs`：运行时代码不得点名专有字体、
 * 不得引用远程字体、随包字体必须登记许可证；打包后还要检查 app.asar。这里只钉住
 * “源码层门禁能在当前工作树跑通”，避免轻量单测完全绕开这条发布基线。
 * @vitest-environment node
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const SCRIPT = join(ROOT, 'scripts', 'font-compliance-check.mjs')

describe('字体合规门禁', () => {
  it('业务源码可通过 --source-only 检查', () => {
    const out = execFileSync(process.execPath, [SCRIPT, '--source-only'], {
      cwd: ROOT,
      encoding: 'utf8',
    })
    expect(out).toContain('字体合规检查通过')
  })

  it('字体登记表存在且形状合法', () => {
    const manifest = JSON.parse(
      readFileSync(join(ROOT, 'scripts', 'font-assets.json'), 'utf8'),
    ) as { fonts?: unknown[]; policy?: unknown }
    expect(Array.isArray(manifest.fonts)).toBe(true)
    expect(typeof manifest.policy).toBe('string')
  })
})
