/**
 * H14：隐私声明必须与代码里的**真实**出网点一致。
 *
 * 为什么需要这条用例：隐私声明最容易变成一份「写的时候对、后来慢慢不对」的文档 ——
 * 新增一个 AI 功能、换一个出网点、加一个 CDN 主机，文档没人动，而读者会照它判断
 * 「关掉开关就安全了」。这里把文档与源码**双向**绑住：清单里的每一条都要在代码里找得到，
 * 而代码里的每个出网点都要在文档里出现。
 *
 * 覆盖的是「有没有写」与「名字对不对」；**不覆盖**「文案描述是否准确」——
 * 那只能靠人工审阅（同理见 M18：README 的因果解释文字守不住）。
 *
 * @vitest-environment node
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const doc = readFileSync(join(ROOT, 'docs', 'PRIVACY.md'), 'utf8')
const gateway = readFileSync(join(ROOT, 'src', 'backend', 'wechat-data', 'src', 'gateway.ts'), 'utf8')

/** 从一段（或几段）源码里抽全部 `host`（`https://x/y` → `x`）。 */
function hostsIn(src: string | readonly string[]): string[] {
  const text = Array.isArray(src) ? src.join('\n') : (src as string)
  return [...new Set([...text.matchAll(/https:\/\/([^/\s'"`)]+)/g)].map((m) => m[1]))]
}

describe('H14：隐私声明 ↔ 出网点', () => {
  it('文档存在且写明生效版本', () => {
    expect(existsSync(join(ROOT, 'docs', 'PRIVACY.md'))).toBe(true)
    expect(doc).toMatch(/## 一句话结论/)
    expect(doc).toMatch(/生效版本/)
  })

  it('生效版本与 consent.ts 的 PRIVACY_VERSION 一致', () => {
    const consent = readFileSync(join(ROOT, 'src', 'client', 'ui-app', 'privacy', 'consent.ts'), 'utf8')
    const version = /PRIVACY_VERSION\s*=\s*(\d+)/.exec(consent)?.[1]
    expect(version, 'consent.ts 里没找到 PRIVACY_VERSION').toBeTruthy()
    // 文档顶部写作「生效版本：**v1**」；两边必须一起升，否则「重新同意」的门槛是假的
    expect(doc).toMatch(new RegExp(`生效版本[：:]\\s*\\*{0,2}v${version}\\*{0,2}`))
  })

  it('gateway 里每个 privacyGate 功能名都在文档里出现（新增 AI 功能不会漏写）', () => {
    const features = [...new Set([...gateway.matchAll(/privacyGate\(\s*'([^']+)'/g)].map((m) => m[1]))]
    // 防空转：解析失效时这条用例不能靠空集合通过
    expect(features.length).toBeGreaterThanOrEqual(4)
    expect(features).toContain('ask_wechat')
    expect(features).toContain('ask_embed')
    for (const f of features) {
      expect(doc, `隐私声明没提到 AI 出站功能 ${f}`).toContain(f)
    }
  })

  it('AI 出网闸门与审计（应用内开关）在文档里有对应说明', () => {
    const panel = readFileSync(
      join(ROOT, 'src', 'client', 'ui-wechat', 'src', 'client', 'pages', 'wechat-data', 'panels', 'PrivacyTrust.tsx'),
      'utf8',
    )
    // 文档要指向真实存在的机制，而不是一个想象出来的开关
    expect(panel).toContain('blockOutbound')
    expect(panel).toContain('redactSensitive')
    expect(doc).toMatch(/禁止 AI 出网/)
    expect(doc).toMatch(/敏感字段打码/)
  })

  it('文档列出的每一类出网主机都能在代码里找到', () => {
    const sources = {
      map: [
        readFileSync(join(ROOT, 'src', 'client', 'ui-wechat', 'src', 'client', 'pages', 'wechat-data', 'panels', 'world-map-data.ts'), 'utf8'),
        readFileSync(join(ROOT, 'src', 'client', 'ui-wechat', 'src', 'client', 'pages', 'wechat-data', 'panels', 'ChinaMap.tsx'), 'utf8'),
        readFileSync(join(ROOT, 'src', 'client', 'ui-wechat', 'src', 'client', 'pages', 'wechat-data', 'panels', 'province-map-data.ts'), 'utf8'),
      ],
      whisper: readFileSync(join(ROOT, 'src', 'backend', 'wechat-data', 'src', 'query', 'whisper.ts'), 'utf8'),
      llm: readFileSync(join(ROOT, 'src', 'backend', 'wechat-host.js'), 'utf8'),
    }
    for (const [kind, src] of Object.entries(sources)) {
      const hosts = hostsIn(src)
      expect(hosts.length, `${kind} 的来源文件里没抽出主机名`).toBeGreaterThan(0)
      for (const host of hosts) {
        expect(doc, `隐私声明没列出 ${kind} 的出网主机 ${host}`).toContain(host)
      }
    }
  })

  it('头像那条路径真实存在，且文档点到了它', () => {
    // 头像地址来自微信数据本身（不是代码常量），所以这里守的是「路径存在 + 文档提到它」，
    // 而不是像地图/whisper 那样比对主机名。
    const avatar = readFileSync(join(ROOT, 'src', 'backend', 'wechat-data', 'src', 'query', 'avatar.ts'), 'utf8')
    expect(avatar.length).toBeGreaterThan(0)
    expect(doc).toContain('avatar.ts')
    expect(doc).toMatch(/头像/)
  })

  it('CSP 仍允许任意 https 图片时，文档必须如实写出这条外发通道', () => {
    const csp = readFileSync(join(ROOT, 'src', 'client', 'ui-app', 'index.html'), 'utf8')
    const imgSrc = /img-src([^;]*)/.exec(csp)?.[1] ?? ''
    if (/https:/.test(imgSrc)) {
      expect(doc, 'CSP 的 img-src 是 https: 通配，文档必须说明渲染层可向任意 https 主机发图片请求')
        .toContain('img-src https:')
    }
  })

  it('文档声称的「会出网」代码位置确实有网络调用', () => {
    const fetchers = ['article-cover.ts', 'media-image.ts', 'sns-video.ts', 'whisper.ts']
    for (const name of fetchers) {
      const src = readFileSync(join(ROOT, 'src', 'backend', 'wechat-data', 'src', 'query', name), 'utf8')
      // 直接 fetch( 或经重试封装的 fetchWithRetry( 都算出网调用（N13 之后这四个点都改走后者）
      expect(/fetchWithRetry\(|fetch\(/.test(src), `${name} 里没有出网调用（fetch/fetchWithRetry）`).toBe(true)
      expect(doc, `隐私声明没提到 ${name}`).toContain(name)
    }
  })

  it('文档如实写明 AI 之外的出网点目前没有内置开关', () => {
    // 这是最容易被写成「我们已经全都防住了」的一句话，必须明确否认
    expect(doc).toMatch(/没有开关|无内置开关|无开关/)
    expect(doc).toMatch(/防火墙|断网/)
  })
})
