/**
 * 功能授权目录守卫。
 *
 * 签发台、设置页与后台拦截都从 `src/license/features.js` / `METHOD_FEATURE` 读取，
 * 这里钉住三件事：
 *   ① 每个功能位有唯一中文名、说明和分组；
 *   ② 每个 @Remote 方法都在功能表里明确登记，避免回落到基础位；
 *   ③ 新证严格逐项放行，旧证继续按基础位兼容新增数据模块。
 * @vitest-environment node
 */
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { gatewaySource } from './gateway-source.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const requireCjs = createRequire(import.meta.url)

type Feature = { id: string, label: string, group: string, description: string, required?: boolean, direct?: boolean }
type FeatureMeta = {
  FEATURE_SCHEMA_VERSION: number
  REQUIRED_FEATURES: string[]
  FEATURE_GROUPS: Array<{ id: string, label: string, description: string }>
  FEATURE_CATALOG: Feature[]
}
type Service = {
  METHOD_FEATURE: Record<string, string>
  FEATURE_METHODS: Record<string, string[]>
  authorizeCall: (status: unknown, method: string) => { ok: boolean, code?: string, message?: string }
  authorizeFeature: (status: unknown, feature: string) => { ok: boolean, code?: string, message?: string }
}

const features = requireCjs(join(ROOT, 'src', 'license', 'features.js')) as FeatureMeta
const service = requireCjs(join(ROOT, 'src', 'license', 'service.js')) as Service

function remoteMethods(): string[] {
  return [...new Set(
    [...gatewaySource().matchAll(/@Remote\('([A-Za-z0-9_]+)'\)/g)]
      .map((match) => match[1])
      .filter((name): name is string => Boolean(name)),
  )]
}

describe('License 功能授权目录', () => {
  it('功能 ID、中文名称与分组都唯一且完整', () => {
    expect(features.FEATURE_CATALOG.length, '功能目录为空或数量异常').toBeGreaterThan(20)
    expect(new Set(features.FEATURE_CATALOG.map((feature) => feature.id)).size).toBe(features.FEATURE_CATALOG.length)
    const groupIds = new Set(features.FEATURE_GROUPS.map((group) => group.id))
    for (const feature of features.FEATURE_CATALOG) {
      expect(feature.label, `${feature.id} 缺少中文名称`).toMatch(/[\u4e00-\u9fff]/)
      expect(feature.label, `${feature.id} 的开放选项名称不应包含英文`).not.toMatch(/[A-Za-z]/)
      expect(feature.description, `${feature.id} 缺少中文说明`).toMatch(/[\u4e00-\u9fff]/)
      expect(groupIds.has(feature.group), `${feature.id} 指向不存在的分组 ${feature.group}`).toBe(true)
    }
    expect(features.REQUIRED_FEATURES).toContain('wechat-data')
  })

  it('所有 @Remote 方法都显式登记，且没有陈旧/重复条目', () => {
    const remotes = new Set(remoteMethods())
    const mapped = new Set(Object.keys(service.METHOD_FEATURE))
    expect(remotes.size, '@Remote 方法扫描数量异常').toBeGreaterThan(200)
    expect([...remotes].filter((method) => !mapped.has(method)), '未登记功能位的 Remote 方法').toEqual([])
    expect([...mapped].filter((method) => !remotes.has(method)), '登记了不存在的 Remote 方法').toEqual([])

    const seen = new Map<string, string>()
    for (const [feature, methods] of Object.entries(service.FEATURE_METHODS)) {
      expect(features.FEATURE_CATALOG.some((item) => item.id === feature), `未知功能分组 ${feature}`).toBe(true)
      for (const method of methods) {
        expect(seen.has(method), `${method} 同时登记在 ${seen.get(method)} 与 ${feature}`).toBe(false)
        seen.set(method, feature)
      }
    }
    expect(seen.size, '分组映射与 METHOD_FEATURE 数量不一致').toBe(mapped.size)
  })

  it('基础功能覆盖首次配置与数据解密链路', () => {
    for (const method of [
      'autoGetDbKey', 'verifyDatabaseKey', 'generateKeysFile', 'saveWechatConfig',
      'autoGetImageKey', 'verifyImageKey', 'decryptAllDatabases', 'decryptAllImages',
      'getDecryptStatus',
    ]) {
      expect(service.METHOD_FEATURE[method], `${method} 是基础数据访问的必需步骤`).toBe('wechat-data')
    }
  })

  it('新证逐项放行，旧证保留基础位兼容', () => {
    const v2 = {
      state: 'licensed',
      licensed: true,
      payload: { features: ['wechat-data', 'chats'], featureSchemaVersion: features.FEATURE_SCHEMA_VERSION },
    }
    expect(service.authorizeCall(v2, 'getSessions').ok, '含聊天会话功能却拒绝 getSessions').toBe(true)
    const denied = service.authorizeCall(v2, 'getAnnualReview')
    expect(denied.ok).toBe(false)
    expect(denied.code).toBe('FEATURE_DENIED')
    expect(denied.message).toContain('年度报告')

    const legacy = {
      state: 'licensed',
      licensed: true,
      payload: { features: ['wechat-data', 'ai-ask'] },
    }
    expect(service.authorizeCall(legacy, 'getAnnualReview').ok, '旧证的基础位未兼容新增数据模块').toBe(true)
    expect(service.authorizeFeature(legacy, 'image-ai').ok, '旧证未兼容已有直连能力').toBe(true)
    expect(service.authorizeCall(legacy, 'createBackup').ok, '旧证的基础位越权开放了备份功能').toBe(false)
  })
})
