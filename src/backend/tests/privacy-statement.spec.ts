/**
 * H14：隐私声明必须与代码里的**真实**出网点一致。
 *
 * 为什么需要这条用例：隐私声明最容易变成一份「写的时候对、后来慢慢不对」的文档 ——
 * 新增一个 AI 功能、换一个出网点、加一个 CDN 主机，文档没人动，而读者会照它判断
 * 「数据会不会出去」。这里把文档与源码**双向**绑住：清单里的每一条都要在代码里找得到，
 * 而代码里的每个出网点都要在文档里出现。
 *
 * **2026-09-30**：应用内的出网开关已全部移除，于是这份声明少了一整节「如何关闭出网」的
 * 开关说明，改成如实写明「应用内没有任何出网开关，要断网只能靠系统防火墙 / 断网」。
 * 这条口径本身也被下面的用例钉住（文档里不许再出现被移除开关的名字）。
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
import { grp } from './helpers/strict-index.ts'

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
  return [...new Set([...text.matchAll(/https:\/\/([^/\s'"`)]+)/g)].map((m) => grp(m, 1, '出网地址')))]
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
      ...[...code.matchAll(/makeChatAsker\([^)]*?'([^']+)'/g)].map((m) => m[1]),
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

  it('隐私面板只剩「敏感字段打码」一个开关，文档与它对齐（出网开关已移除）', () => {
    const panel = readFileSync(
      join(ROOT, 'src', 'client', 'ui-wechat', 'src', 'client', 'pages', 'wechat-data', 'panels', 'PrivacyTrust.tsx'),
      'utf8',
    )
    // 文档要指向真实存在的机制，而不是一个想象出来的开关
    expect(panel).toContain('redactSensitive')
    // 2026-09-30：出网开关已全部移除 ⇒ 面板里不许再出现它们（双保险，与
    // `outbound-site-coverage.spec.ts` 的产品代码扫描同向）。
    expect(panel, '面板里又出现了已移除的出网开关').not.toContain('blockOutbound')
    expect(panel, '面板里又出现了已移除的出网开关').not.toContain('blockMapTiles')
    expect(doc).toMatch(/敏感字段打码/)
    expect(doc, '文档要明写「应用内已没有任何出网开关」').toMatch(/没有任何出网开关|已无出网开关|出网开关已(全部)?移除/)
  })

  it('文档列出的每一类出网主机都能在代码里找到', () => {
    const sources = {
      map: [
        readFileSync(join(ROOT, 'src', 'backend', 'wechat-data', 'src', 'query', 'map-geo.ts'), 'utf8'),
        readFileSync(join(ROOT, 'src', 'client', 'ui-wechat', 'src', 'client', 'pages', 'wechat-data', 'panels', 'ChinaMap.tsx'), 'utf8'),
        readFileSync(join(ROOT, 'src', 'client', 'ui-wechat', 'src', 'client', 'pages', 'wechat-data', 'panels', 'province-map-data.ts'), 'utf8'),
      ],
      whisper: readFileSync(join(ROOT, 'src', 'backend', 'wechat-data', 'src', 'query', 'whisper.ts'), 'utf8'),
      llm: [
        readFileSync(join(ROOT, 'src', 'backend', 'llm-bridge.js'), 'utf8'),
        // LLM 默认值单源化后，默认出网主机只住在 shared/llm-defaults.json；
        // 不能为了这条扫描把字面地址抄回桥接层。
        readFileSync(join(ROOT, 'src', 'shared', 'llm-defaults.json'), 'utf8'),
      ],
      // ClawBot 绑定通道（2026-10-12 接入）：主机在代码里写死，文档必须逐字列出。
      ilink: readFileSync(join(ROOT, 'src', 'backend', 'wechat-data', 'src', 'query', 'clawbot', 'clawbot-ilink.ts'), 'utf8'),
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

  it('img-src 只许画本机来源，且文档与它互相咬合（M23）', () => {
    // 先去掉 HTML 注释、再从 meta 的 content 里取 CSP：注释里会正当出现 `https:` 与 `img-src`
    // 这两个词（它们解释的正是「为什么不许再写回来」），按整份文件匹配会把注释当成策略本身。
    const html = readFileSync(join(ROOT, 'src', 'client', 'ui-app', 'index.html'), 'utf8').replace(/<!--[\s\S]*?-->/g, '')
    const csp = /http-equiv="Content-Security-Policy"\s+content="([^"]*)"/.exec(html)?.[1] ?? ''
    expect(csp, 'index.html 里找不到 CSP 的 meta 标签').not.toBe('')
    const imgSrc = /img-src([^;]*)/.exec(csp)?.[1] ?? ''
    expect(imgSrc, 'CSP 里没有 img-src 这一节').not.toBe('')
    // 这一条就是 M23 的验收本身：远程 scheme 通配一旦回来，「关掉两个开关就不再为图片出网」
    // 立刻变成假话（渲染层的 <img> 又能向任意主机发请求），而除了这里没人会发现。
    expect(imgSrc, 'img-src 里又出现远程 scheme 通配了：远程图片要走后端 query/remote-image.ts ——' + imgSrc)
      .not.toMatch(/\b(?:https?|ws|wss):/)
    expect(doc, 'img-src 已经收紧，文档不该继续声称渲染层可向任意 https 主机发图片请求')
      .not.toContain('img-src https:')
    expect(doc, '文档要正面写明「图片只来自本机」').toContain('img-src 只放行本机来源')
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

  it('文档如实写明应用内已没有任何出网开关，并说清"断网才是彻底方案"', () => {
    // 2026-09-30：这条从「开关都齐了」反转成「开关全没了」。两个方向都要守 ——
    // 否则文档会往两边骗人：明明没有开关却说有（用户以为关掉就安全），
    // 或者明明删了还留着过期说法（用户去找一个不存在的按钮）。
    expect(doc, '语音模型下载的审计功能名没在文档里点名').toContain('voice_model_download')
    expect(doc, '地图底图仍要在文档里可读地写出').toMatch(/地图底图/)
    expect(doc, '仍要说清"断网/防火墙才是最彻底的方案"').toMatch(/防火墙|断网/)
    // 反向：被移除的开关的名字不许再出现在文档里（否则读者会去找它们）
    for (const stale of ['blockOutbound', 'blockMapTiles', 'cdn_enabled', 'cdn_local_decrypt',
      '禁止 AI 出网', '禁止地图底图出网', '自动获取原图（CDN）', '原图解密方式']) {
      expect(doc, `文档里还留着一个已被移除的开关：${stale}`).not.toContain(stale)
    }
  })

  /**
   * 精排（rerank）这个出网点的两条硬纪律。
   *
   * 为什么用源码断言而不是行为断言：`makeRerankFn` 只有走完整问答才可达，
   * 而那需要一套带搜索索引的夹具（成本高且脆）。这两条恰恰是**形状级**的约束
   * ——「gate 的 texts 里有没有候选文档」看源码一眼可判，看行为要跑一整轮。
   */
  it('精排：候选文档必须与查询一起过闸', () => {
    const code = stripComments(gateway)
    // #20 之后实现住在 `gateway-llm-factory.ts#makeRerankFnOf`，类里只剩一个委托 ——
    // 这份联合是"实现搬到哪儿都算"的口径，所以这里**两处都找**，认那一段真过闸的实现；
    // 找不到就红（委托本身不再被当成"接线还在"的证据，那正是这条判据要防的静默失效）。
    const starts = [...code.matchAll(/\n(?:export function makeRerankFnOf| {2}(?:private|protected) makeRerankFn\()/g)]
    const bodies = starts.map((m) => code.slice(m.index, m.index + 1600))
    const body = bodies.find((b) => b.includes("privacyGate('ask_rerank'")) ?? ''
    expect(body, '找不到精排的过闸实现（makeRerankFn / makeRerankFnOf 里都没有那一步？）').not.toBe('')
    // ① gate 的入参必须同时含 query 与全部 documents。只 gate query 等于把 N 条正文
    //    裸发出去，而审计表还会记成「已脱敏」—— 那是**假的安全感**，比没有更糟。
    //    （2026-09-30 起闸门只做脱敏与审计，这一条的价值反而更高：它成了精排唯一的接缝。）
    expect(body).toMatch(/privacyGate\(\s*'ask_rerank'[\s\S]{0,160}\[query, \.\.\.documents\]/)
    // ② 功能名与文档对齐（上面那条通用断言已覆盖「文档含此名」，这里钉的是「用的就是这个名字」，
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

  it('实体抽取与链接建议：功能名各自独立、建议**不写**任何数据', () => {
    const code = stripComments(gateway)
    for (const [method, feature] of [['extractKbEntities', 'kb_extract'], ['suggestKbLinks', 'kb_link_suggest']] as const) {
      const body = implBody(code, method)
      expect(body.length, `gateway/remotes 里没有 ${method}（接线被删了？）`).toBeGreaterThan(0)
      expect(doc, `隐私声明没列出 ${feature}`).toContain(feature)
      // 功能名必须真的流到审计里（gate/asker 的入参），只在别处出现一次不算过闸
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

  /**
   * v13/v14（2026-10-14/15）：**入站监听面**及其访问控制必须被如实登记。
   *
   * 为什么单独立一组判据：前面所有条目守的都是「出网」（本机向外发请求），
   * 而 v13 首次引入了反方向 —— 本机**监听端口**、局域网里别的设备连进来读数据；
   * v14 把登录凭据从长期令牌改为一次性配对码。
   * 「我的聊天会不会被这台机器之外的东西看到」这个问题，入站方向的答案更直接，
   * 所以它必须和出网点一样逐条写清，而且**文档说的默认值必须与代码里的默认值一致**
   * （RELEASE-PLAN 的教训②：文档最危险的不是缺失而是过期）。
   */
  it('文档登记了入站监听面：默认关闭、持配对码、白名单、且写明是明文 HTTP', () => {
    expect(doc, '第四节少了入站监听那一节（H）').toMatch(/### H\. 入站监听/)
    // 默认关闭是这一条最重要的性质：翻成默认开启就等于偷偷监听
    expect(doc, '入站那一节没写明「默认关闭」').toContain('默认关闭')
    expect(doc, '入站那一节没写明端口').toContain('5032')
    // 明文 HTTP 是这条链路最大的代价，不许从文档里消失（否则用户会以为它加密）
    expect(doc, '入站那一节没写清这条链路是明文 HTTP、无 TLS').toMatch(/明文 HTTP/)
    // 「手机上不能干什么」要点名，否则读者会以为手机与桌面等价
    for (const withheld of ['API Key', '许可证', '备份', '白名单']) {
      expect(doc, `入站那一节没点名「${withheld}」不开放远程访问`).toContain(withheld)
    }
    // 防火墙这一条要如实说明「应用没有管理员权限、不能替你加规则」
    expect(doc, '入站那一节没如实说明防火墙规则要用户自己放行').toMatch(/netsh advfirewall/)
  })

  it('文档如实描述 v14 的一次性配对码：长期 token 不再进 QR/URL/UI', () => {
    for (const expected of ['一次性配对码', '5 分钟', '最多 5 次试错', '?t=<配对码>', '不进二维码']) {
      expect(doc, `第四节 H 没有写明「${expected}」`).toContain(expected)
    }
    expect(doc, '长期 api_token 仍被描述为会进入二维码/地址栏').not.toContain('?t=<令牌>')
  })

  it('文档说「默认关闭」，代码里的默认值就必须是关（两向都守）', () => {
    const cfg = readFileSync(
      join(ROOT, 'src', 'backend', 'wechat-data', 'src', 'config', 'wechat-config.ts'), 'utf8')
    expect(cfg, '配置默认值里 api_enabled 不是 false —— 文档的「默认关闭」会变成假话')
      .toContain('api_enabled: false')
    expect(cfg, 'api_enabled 的默认值被翻回 true 了（入站监听面必须默认关闭）')
      .not.toContain('api_enabled: true')
    // 读回配置的口径也要一致：缺省时按「关」处理，而不是按「开」
    const remotes = readFileSync(
      join(ROOT, 'src', 'backend', 'wechat-data', 'src', 'remotes', 'config.ts'), 'utf8')
    expect(remotes, "remotes/config.ts 读 api_enabled 时的缺省值不是 false")
      .toMatch(/api_enabled'\]\s*\?\?\s*false/)
  })

  it('同意屏把入站面**单独**列出来，且不混进「共 N 个出网点」的计数', () => {
    const gate = readFileSync(
      join(ROOT, 'src', 'client', 'ui-app', 'privacy', 'PrivacyConsentGate.tsx'), 'utf8')
    expect(gate, '同意屏没有入站面清单（重新同意时用户看不到这一条）').toContain('INBOUND')
    expect(gate, '入站面清单没有被渲染出来（只定义不用等于没写）').toMatch(/INBOUND\.map/)
    // 「默认关闭 · 可关」这一档标记必须存在：出网侧自 2026-09-30 起已无开关，
    // 入站是本屏唯一有真开关的一条，标记混用会让人以为它也关不掉
    expect(gate).toContain("off: '默认关闭 · 可关'")
    // 计数那句话不许把入站面算进「出网点」—— 方向相反，混算就是假话
    expect(gate, '出网点计数被改成了包含入站面的口径').toContain('共 {OUTBOUND.length} 个出网点')
  })
})
