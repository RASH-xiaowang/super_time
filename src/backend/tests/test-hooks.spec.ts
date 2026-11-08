/**
 * 调试自动化钩子的生产门控。
 *
 * @vitest-environment node
 */
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const require = createRequire(import.meta.url)
const { isPackagedTestHooksEnabled } = require('../test-hooks.js') as {
  isPackagedTestHooksEnabled: (options?: { isPackaged?: boolean, packageMetadata?: object }) => boolean
}

describe('生产测试钩子门控', () => {
  it('开发态允许；正式打包态默认拒绝', () => {
    expect(isPackagedTestHooksEnabled({ isPackaged: false })).toBe(true)
    expect(isPackagedTestHooksEnabled({ isPackaged: true })).toBe(false)
    expect(isPackagedTestHooksEnabled({ isPackaged: true, packageMetadata: {} })).toBe(false)
    expect(isPackagedTestHooksEnabled({ isPackaged: true, packageMetadata: { supertimeTestHooks: '1' } })).toBe(false)
  })

  it('只有构建期显式标记的打包态测试包才允许', () => {
    expect(isPackagedTestHooksEnabled({
      isPackaged: true,
      packageMetadata: { supertimeTestHooks: true },
    })).toBe(true)
  })

  it('正式构建配置不写测试标记，pack 脚本使用独立测试配置', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>
      build: { extraMetadata?: { supertimeTestHooks?: boolean } }
    }
    expect(pkg.build.extraMetadata?.supertimeTestHooks).not.toBe(true)
    expect(pkg.scripts.pack).toContain('electron-builder.test.config.js')

    const testConfig = require('../../../electron-builder.test.config.js') as {
      extraMetadata?: { supertimeTestHooks?: boolean }
    }
    expect(testConfig.extraMetadata?.supertimeTestHooks).toBe(true)
  })

  it('main.js 的截图与安全探针都经过同一个门控', () => {
    const main = readFileSync(join(ROOT, 'main.js'), 'utf8')
    expect(main).toContain('isPackagedTestHooksEnabled({')
    expect(main).toContain("if (testHooksEnabled && process.env.SUPERTIME_SECURITY_PROBE === '1')")
    expect(main).toContain('if (testHooksEnabled) installScreenshotAutomation(')
  })
})
