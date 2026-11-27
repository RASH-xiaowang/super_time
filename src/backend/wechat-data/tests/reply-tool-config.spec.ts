/**
 * 「AI 回复工具」配置的读写守卫（2026-11-24）。
 *
 * 这一族的关键不是能不能写进去，而是三条**不会报错**的错法：
 *  ① 密钥被写进 `config.json`（那是会被整目录拷贝、交给支持人员看的文件）；
 *  ② 密钥通过 `getWechatConfig` 被读回渲染层（会进截图与「复制诊断信息」）；
 *  ③ 保存成功但工具仍判定「未配置」（读快照与判就绪用了两套口径）。
 *
 * 所以这里逐条钉：密钥落在 secrets.json、config 快照里没有原文、写入后工具卡片立刻变「可用」、
 * 以及非法取值被拒。
 * @vitest-environment node
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { getConfig } from '../src/config/wechat-config.ts'
import { readLocalToolConfig, saveLocalToolConfig } from '../src/query/reply-tool-config.ts'
import { queryLocalTools } from '../src/query/local-tools.ts'

const scratch: string[] = []

afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** 造一个解密数据根（config.json / secrets.json 在它的父目录）。 */
function dataRoot(): { decrypted: string; root: string } {
  const root = mkdtempSync(join(tmpdir(), 'wx-reply-config-'))
  scratch.push(root)
  const decrypted = join(root, 'wechat-data', 'decrypted')
  mkdirSync(decrypted, { recursive: true })
  return { decrypted, root: join(root, 'wechat-data') }
}

describe('配置快照：只回「是否已保存」，永不回读密钥', () => {
  it('全新数据根 ⇒ 两项都未保存、未选择', () => {
    const { decrypted } = dataRoot()
    const config = readLocalToolConfig(decrypted)
    expect(config.weather).toEqual({ provider: '', access: '', apiKeySaved: false })
    expect(config.search).toEqual({ provider: '', apiKeySaved: false })
    // 可选项来自后端（前端不硬编码字面量）
    expect(config.weatherProviders.map((option) => option.value)).toContain('open-meteo')
    expect(config.searchProviders.map((option) => option.value)).toContain('brave')
  })

  it('secrets.json 里已有的密钥 ⇒ 只显示「已保存」', () => {
    const { decrypted, root } = dataRoot()
    writeFileSync(join(root, 'secrets.json'), JSON.stringify({ reply_search_api_key: 'synthetic-key' }), 'utf8')
    const config = readLocalToolConfig(decrypted)
    expect(config.search.apiKeySaved).toBe(true)
    expect(JSON.stringify(config)).not.toContain('synthetic-key')
  })
})

describe('保存：密钥落 secrets.json，config.json 不留原文', () => {
  it('保存整套配置后：config.json 无密钥、secrets.json 有密钥、快照判定就绪', () => {
    const { decrypted, root } = dataRoot()
    const saved = saveLocalToolConfig(decrypted, {
      weatherProvider: 'open-meteo',
      weatherAccess: 'commercial',
      weatherApiKey: 'synthetic-weather',
      searchProvider: 'brave',
      searchApiKey: 'synthetic-search',
    })
    expect(saved.ok).toBe(true)
    expect(saved.config?.weather.apiKeySaved).toBe(true)
    expect(saved.config?.search.apiKeySaved).toBe(true)

    const configJson = readFileSync(join(root, 'config.json'), 'utf8')
    expect(configJson, '密钥被写进了 config.json').not.toContain('synthetic-weather')
    expect(configJson, '密钥被写进了 config.json').not.toContain('synthetic-search')
    const secrets = JSON.parse(readFileSync(join(root, 'secrets.json'), 'utf8')) as Record<string, unknown>
    expect(secrets['reply_weather_api_key']).toBe('synthetic-weather')
    expect(secrets['reply_search_api_key']).toBe('synthetic-search')
  })

  it('getWechatConfig 不把回复密钥读回渲染层', () => {
    const { decrypted } = dataRoot()
    saveLocalToolConfig(decrypted, { weatherProvider: 'open-meteo', weatherAccess: 'noncommercial', weatherApiKey: 'synthetic-weather' })
    const snapshot = getConfig(decrypted)
    expect(snapshot).not.toHaveProperty('reply_weather_api_key')
    expect(snapshot).not.toHaveProperty('reply_search_api_key')
    expect(JSON.stringify(snapshot)).not.toContain('synthetic-weather')
  })

  it('保存后工具卡片当场从「待配置」变「可用」（同一份配置口径）', () => {
    const { decrypted } = dataRoot()
    const before = queryLocalTools(decrypted).items.find((item) => item.callName === 'weather')
    expect(before?.status, '未配置时应当标待配置').toBe('needs-config')

    expect(saveLocalToolConfig(decrypted, { weatherProvider: 'open-meteo', weatherAccess: 'noncommercial' }).ok).toBe(true)
    const after = queryLocalTools(decrypted).items.find((item) => item.callName === 'weather')
    expect(after?.status, '非商用模式不需要 Key，配好数据源就该可用').toBe('ready')

    // 非商用 → 商用但没 Key ⇒ 又回到待配置（判据不能只看 provider）
    expect(saveLocalToolConfig(decrypted, { weatherAccess: 'commercial' }).ok).toBe(true)
    expect(queryLocalTools(decrypted).items.find((item) => item.callName === 'weather')?.status).toBe('needs-config')
  })

  it('搜索配好服务与 Key 才就绪；只配服务仍待配置', () => {
    const { decrypted } = dataRoot()
    expect(saveLocalToolConfig(decrypted, { searchProvider: 'brave' }).ok).toBe(true)
    expect(queryLocalTools(decrypted).items.find((item) => item.callName === 'search_web')?.status).toBe('needs-config')
    expect(saveLocalToolConfig(decrypted, { searchApiKey: 'synthetic-search' }).ok).toBe(true)
    expect(queryLocalTools(decrypted).items.find((item) => item.callName === 'search_web')?.status).toBe('ready')
  })
})

describe('校验：非法取值拒绝，空密钥不覆盖已有', () => {
  it('不支持的枚举值被拒（含拼错的厂商名）', () => {
    const { decrypted } = dataRoot()
    expect(saveLocalToolConfig(decrypted, { weatherProvider: 'openweather' }).ok).toBe(false)
    expect(saveLocalToolConfig(decrypted, { weatherAccess: 'free' }).ok).toBe(false)
    expect(saveLocalToolConfig(decrypted, { searchProvider: 'google' }).ok).toBe(false)
  })

  it('密钥含空白字符 / 过长被拒（粘错时能看出原因）', () => {
    const { decrypted } = dataRoot()
    expect(saveLocalToolConfig(decrypted, { searchApiKey: 'a b' }).ok).toBe(false)
    expect(saveLocalToolConfig(decrypted, { searchApiKey: 'a\nb' }).error).toContain('空格或换行')
    expect(saveLocalToolConfig(decrypted, { searchApiKey: 'x'.repeat(201) }).ok).toBe(false)
  })

  it('空密钥 = 不修改（界面不回显原文，不能把「没改」当成「清空」）', () => {
    const { decrypted } = dataRoot()
    expect(saveLocalToolConfig(decrypted, { searchProvider: 'brave', searchApiKey: 'synthetic-search' }).ok).toBe(true)
    expect(saveLocalToolConfig(decrypted, { searchApiKey: '   ' }).ok).toBe(true)
    expect(readLocalToolConfig(decrypted).search.apiKeySaved, '空串把已保存的密钥抹掉了').toBe(true)
  })

  it('取消数据源会同时清掉使用方式（避免选回来时立刻要求 Key）', () => {
    const { decrypted } = dataRoot()
    saveLocalToolConfig(decrypted, { weatherProvider: 'open-meteo', weatherAccess: 'commercial' })
    saveLocalToolConfig(decrypted, { weatherProvider: '' })
    const config = readLocalToolConfig(decrypted)
    expect(config.weather.provider).toBe('')
    expect(config.weather.access).toBe('')
  })

  it('什么都没改也回成功（用户点了保存但没动输入框）', () => {
    const { decrypted } = dataRoot()
    expect(saveLocalToolConfig(decrypted, {}).ok).toBe(true)
    expect(existsSync(join(decrypted, '..', 'config.json'))).toBe(false)
  })
})
