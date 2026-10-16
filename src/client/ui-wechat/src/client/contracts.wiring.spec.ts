/**
 * 客户端共享契约的单一来源守卫。
 *
 * `ui-wechat` 与 `ui-app` 是两个 typecheck program，以前这些形状在 electron-api、
 * 设置面板、LicenseGate、http-remote 等处各抄一份。字段只在一侧变化时不会产生
 * 编译错误，却会让「桌面端能用、手机端拿不到字段」这类偏差静默出现。
 * 现在 `contracts.ts` 是唯一声明处，其余文件只 import / re-export。
 *
 * @vitest-environment node
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
const CLIENT_ROOT = join(HERE, '..', '..', '..')
const read = (...parts: string[]): string => readFileSync(join(...parts), 'utf8')

const contracts = read(HERE, 'contracts.ts')
const electronApi = read(HERE, 'electron-api.ts')
const settingsSections = read(HERE, 'pages', 'wechat-data', 'panels', 'settings-sections.tsx')
const remoteSettings = read(HERE, 'pages', 'wechat-data', 'panels', 'settings-remote-access.tsx')
const httpRemote = read(CLIENT_ROOT, 'ui-app', 'http-remote.ts')
const wechatEvents = read(CLIENT_ROOT, 'ui-app', 'wechat-events.ts')
const licenseGate = read(CLIENT_ROOT, 'ui-app', 'license', 'LicenseGate.tsx')

const SHARED = [
  'RemoteEnvelope',
  'BackendEvent',
  'LicenseStatus',
  'RemoteAccessState',
  'RemoteAccessRotation',
  'UpdateState',
] as const

describe('客户端契约只有 contracts.ts 一个声明处', () => {
  it('canonical 文件真的导出了全部共享形状（否则这条守卫自己就空了）', () => {
    for (const name of SHARED) {
      expect(contracts, `contracts.ts 缺少 ${name}`).toMatch(new RegExp(`export\\s+(?:type|interface)\\s+${name}\\b`))
    }
  })

  it('ui-wechat 的桥类型面只 import，不再重新声明共享形状', () => {
    expect(electronApi).toContain("from './contracts.ts'")
    for (const name of SHARED) {
      expect(electronApi, `electron-api.ts 重新声明了 ${name}`)
        .not.toMatch(new RegExp(`export\\s+(?:type|interface)\\s+${name}\\s*[={]`))
    }
  })

  it('设置面板从契约取 License / Update / RemoteAccess 类型', () => {
    expect(settingsSections).toContain("from '../../../contracts.ts'")
    expect(settingsSections).toContain('LicenseStatus')
    expect(settingsSections).toContain('UpdateState')
    expect(remoteSettings).toContain("from '../../../contracts.ts'")
    expect(remoteSettings).toContain('RemoteAccessState')
  })

  it('ui-app 的 HTTP / 事件 / License 也复用同一份契约', () => {
    expect(httpRemote).toContain("@deepseek-ai/dsh-client-ui-wechat/contracts")
    expect(httpRemote).not.toMatch(/\binterface\s+Envelope\b/)
    expect(wechatEvents).toContain("@deepseek-ai/dsh-client-ui-wechat/contracts")
    expect(wechatEvents).not.toMatch(/\binterface\s+BackendEvent\b/)
    expect(licenseGate).toContain("@deepseek-ai/dsh-client-ui-wechat/contracts")
    expect(licenseGate).not.toMatch(/\btype\s+LicenseStatus\s*=/)
  })
})
