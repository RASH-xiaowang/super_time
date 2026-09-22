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
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { gatewaySource } from './gateway-source.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const doc = readFileSync(join(ROOT, 'docs', 'PRIVACY.md'), 'utf8')
// M21：KB/域方法体在 remotes/、隐私闸与出网接缝在 gateway-core.ts ⇒ 读「类 + 域处理器」的联合
const gateway = gatewaySource()

/**
 * 去掉注释（行注释 + 块注释），用于源码级断言。
 *
 * 为什么要剥：`toContain` / 正则类断言最容易被「注释里写了一句」骗过 ——
 * 把代码删掉、注释留下，用例照样绿。
 * @param src - 源码文本。
 * @returns 剥掉注释后的文本。
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

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

  it('gateway 里每个出网功能名都在文档里出现（新增 AI 功能不会漏写）', () => {
    const code = stripComments(gateway)
    const features = [...new Set([
      ...[...code.matchAll(/privacyGate\(\s*'([^']+)'/g)].map((m) => m[1]),
      // embedding 的功能名是**参数**（消息侧 `ask_embed` / 知识库侧 `kb_embed`），
      // 不以字面量形式出现在 `privacyGate(` 后面，所以要从 `makeEmbedFn` 的调用点取。
      ...[...code.matchAll(/makeEmbedFn\([^)]*?'([^']+)'/g)].map((m) => m[1]),
      // 2026-09-20：抽取/建议这两类把功能名传给 `makeChatAsker`，而 gate 在它内部
      // 用变量调用 —— 上面两条正则都抓不到。**只抓得到一半的守卫等于没有守卫**：
      // 下一次新增 AI 功能如果走的也是这条路，文档漏写会静默通过。
      // `privacyBlocked(` 那一支同时能抓到「早退前先判拦截」的调用点。
      ...[...code.matchAll(/makeChatAsker\([^)]*?'([^']+)'/g)].map((m) => m[1]),
      ...[...code.matchAll(/privacyBlocked\(\s*'([^']+)'/g)].map((m) => m[1]),
    ])].filter((f): f is string => Boolean(f))
    // 防空转：解析失效时这条用例不能靠空集合通过
    expect(features.length).toBeGreaterThanOrEqual(4)
    expect(features).toContain('ask_wechat')
    expect(features).toContain('ask_embed')
    expect(features).toContain('kb_embed')
    for (const f of features) {
      expect(doc, `隐私声明没提到 AI 出站功能 ${f}`).toContain(f)
    }
  })

  it('知识库建索引必须走**独立**的审计功能名 kb_embed（否则审计里分不开哪类数据出网）', () => {
    const code = stripComments(gateway)
    // 只多一个字符串常量是不够的：必须看到 makeEmbedFn(..., 'kb_embed') 这个**真实调用点**
    // （`stripComments` 先剥注释，防止在注释里写一句就骗过这条断言）。
    expect(code, '知识库建索引没有用独立的 kb_embed 功能名').toMatch(/makeEmbedFn\([^)]*'kb_embed'/)
    // 默认值仍是消息侧的 ask_embed（改坏了会让消息侧审计被错记成知识库）
    expect(code, 'makeEmbedFn 的默认功能名不再是 ask_embed').toMatch(/=\s*'ask_embed'/)
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

  /**
   * 精排（rerank）这个出网点的两条硬纪律。
   *
   * 为什么用源码断言而不是行为断言：`makeRerankFn` 只有走完整问答才可达，
   * 而那需要一套带搜索索引的夹具（成本高且脆）。这两条恰恰是**形状级**的约束
   * ——「gate 的 texts 里有没有候选文档」看源码一眼可判，看行为要跑一整轮。
   */
  it('精排：候选文档必须与查询一起过闸，且拦截判在出网之前', () => {
    const code = stripComments(gateway)
    const from = code.search(/\n  (?:private|protected) makeRerankFn/)
    expect(from, 'gateway 里没有 makeRerankFn（精排接线被删了？）').toBeGreaterThan(0)
    const body = code.slice(from, from + 1600)
    // ① gate 的入参必须同时含 query 与全部 documents。只 gate query 等于把 N 条正文
    //    裸发出去，而审计表还会记成「已脱敏」—— 那是**假的安全感**，比没有更糟。
    expect(body).toMatch(/privacyGate\(\s*'ask_rerank'[\s\S]{0,160}\[query, \.\.\.documents\]/)
    // ② 出站拦截判在最前：早于「没配模型」那类早退（顺序错了，用户看到的是「AI 不可用」，
    //    把「拦截真的生效了」这件事盖掉 —— 第 59 轮实测过的同类误导）。
    const blockedAt = body.indexOf('privacyBlocked(\'ask_rerank\')')
    const gateAt = body.indexOf('privacyGate(\'ask_rerank\'')
    expect(blockedAt, '精排没判出站拦截').toBeGreaterThan(-1)
    expect(blockedAt, '出站拦截必须判在过闸之前').toBeLessThan(gateAt)
    // ③ 功能名与文档对齐（上面那条通用断言已覆盖「文档含此名」，这里钉的是「用的就是这个名字」，
    //    防止改成 `kb_rerank` 之后文档与审计各说各话）。
    expect(doc).toContain('ask_rerank')
  })

  /**
   * 实体抽取与链接建议（P4）的三条纪律。
   *
   * 与精排那一条同一个理由：这两处也只有走完整界面才可达，而约束本身是**形状级**的。
   * 第三条尤其要紧 —— 「只出建议、不自动写正文」是整个推断层不污染图谱的前提，
   * 它一旦破功，症状是用户的笔记里出现他没写过的链接，而没人会想到去看代码。
   */
  /**
   * M21：KB 域方法体搬进 `remotes/*.ts` 后，`@Remote('x')` 处只剩一行转发 ⇒
   * 这些断言要看**被转发到的那份实现**（联合读里它在后面，取最后一次出现）。
   */
  const implBody = (code: string, method: string): string => {
    const at = code.lastIndexOf(`${method}(`)
    if (at < 0) return ''
    const rest = code.slice(at)
    const end = rest.indexOf('\n    },')
    return end > 0 ? rest.slice(0, end) : rest.slice(0, 2600)
  }

  it('实体抽取与链接建议：拦截判在早退前、功能名各自独立、建议**不写**任何数据', () => {
    const code = stripComments(gateway)
    for (const [method, feature] of [['extractKbEntities', 'kb_extract'], ['suggestKbLinks', 'kb_link_suggest']] as const) {
      const body = implBody(code, method)
      expect(body.length, `gateway/remotes 里没有 ${method}（接线被删了？）`).toBeGreaterThan(0)
      const blockedAt = body.indexOf(`privacyBlocked('${feature}'`)
      expect(blockedAt, `${method} 没判出站拦截`).toBeGreaterThan(-1)
      // 「没配模型」这类早退必须在拦截**之后**：顺序错了，被拦下的那次会显示成
      // 「AI 不可用」，用户会去翻配置而不是想「是不是我自己关掉的」。
      const modelAt = body.indexOf(`=== ''`)
      expect(modelAt, `${method} 里没有「未配置模型」的早退（那正是这条守卫要判的顺序）`).toBeGreaterThan(-1)
      expect(blockedAt, '出站拦截必须判在未配置早退之前').toBeLessThan(modelAt)
      expect(doc, `隐私声明没列出 ${feature}`).toContain(feature)
      // 功能名必须真的流到审计里（gate/asker 的入参），只在 privacyBlocked 里出现一次不算过闸
      expect(body).toMatch(new RegExp(`makeChatAsker\\([^)]*'${feature}'|makeEmbedFn\\([^)]*'${feature}'`))
    }
    // 建议走的是 embedding 通道，但审计名**不许**蹭 `kb_embed`：那个名字在文档里指的是
    // 「文件正文进向量索引」。混记之后「我把哪一类数据发出去了」在审计表里就分不开
    // —— 与上面 `kb_embed` 那条守卫同一个理由。
    expect(code, '链接建议没有独立的审计功能名（蹭了 kb_embed？）')
      .toMatch(/(?:this|rc)\.makeEmbedFn\([^)]*'kb_link_suggest'/)
    // 恰好一处**调用点**（`this.` 把签名那一处排除掉）：两处就会让人分不清哪个是真的在过闸
    expect(code.match(/(?:this|rc)\.makeEmbedFn\([^)]*'kb_link_suggest'/g) ?? []).toHaveLength(1)
    // 建议是**只读**的：这个方法里不许出现任何写路径
    const sBody = implBody(code, 'suggestKbLinks')
    for (const writer of ['saveNote', 'saveDocEntities', 'setKbModel', 'writeKb', 'deleteNote', 'touchKbEntitiesAt', 'INSERT INTO']) {
      expect(sBody, `suggestKbLinks 里出现了写路径 ${writer}（建议不该改任何数据）`).not.toContain(writer)
    }
  })
})
