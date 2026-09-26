/**
 * 出网点台账：**枚举调用点**，而不是「找 privacy 接缝」。
 *
 * ## 为什么要换判据（CODE-AUDIT-2026-09-26 P0-2）
 *
 * `license-outbound-coverage.spec.ts` 的判据是「按 `@Remote` 方法体扫 privacy 接缝」——
 * 它只能发现「已经过闸门的方法有没有登记功能位」，**看不见从未过闸门的地方**。
 * 三处漏网点就是这么静默存在的：
 *   · `remotes/voicellm.ts#installWhisperEngine`（向 GitHub 拉引擎 zip）——
 *     紧邻的 `downloadWhisperModel` 有闸，注释还写着「开关真的管到它了」，同族漏了一个；
 *   · `remotes/laya.ts#downloadLayaModel`（向 HuggingFace 拉 1.26 GB）—— 连依赖都没注入；
 *   · `src/backend/ipc-wechat.js` 的 `wechat:llm-models` —— 在**主进程**里 fetch，
 *     还带着用户的 `Authorization: Bearer <API Key>`，既不经过 `@Remote` 方法面，
 *     也不在 `METHOD_FEATURE` 清单里。
 *
 * ## 新判据
 *
 * 1. AST 枚举产品代码里**每一个**出网调用点（`fetch` / `fetchWithRetry` / `http(s).request`），
 *    键成 `文件#所在函数`（不依赖行号）；
 * 2. 每个点必须在下面的台账里有一条登记，登记里写明：管它的是哪个开关 / 审计功能名、
 *    以及**代码里真的存在那个闸门的标记**；
 * 3. 台账与实测集合 `toEqual` ⇒ 新增一个出网点、或把闸门删掉，都会当场变红；
 *    登记项陈了（代码里已无该点）同样变红。
 *
 * 「闸门标记存在」只证明闸在那里，不证明它管得到这个点 —— 那半由行为用例守：
 * `src/backend/wechat-data/tests/outbound-gates.spec.ts`（开关打开时**一个请求都不发**）
 * 与 `src/backend/tests/ipc-wechat.spec.ts`（`wechat:llm-models` 被拦时不 fetch）。
 * @vitest-environment node
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

/** 一条登记：出网点 → 管它的开关 + 代码里必须存在的闸门标记 + 为什么。 */
interface LedgerEntry {
  /** `文件相对路径#函数名` —— 台账的主键。 */
  site: string
  /** 闸门类型（人类可读，便于扫）。 */
  gate: string
  /** 在哪个文件里能找到闸门（`ANY` = 产品代码任意处）。 */
  gateIn: string
  /** 闸门标记（剥注释后必须出现的那个字面量）。 */
  marker: string
  /** 这个点在发什么、为什么可以接受。 */
  why: string
}

const LEDGER: LedgerEntry[] = [
  {
    site: 'src/backend/wechat-data/src/query/article-cover.ts#fetchText',
    gate: 'blockOutbound / privacyBlocked', gateIn: 'ANY', marker: "privacyBlocked('sns_cover_fetch'",
    why: '读公众号文章的 og:image 所在的 HTML —— 由「从微信 CDN 取回封面」这个功能位管着',
  },
  {
    site: 'src/backend/wechat-data/src/query/article-cover.ts#fetchBytes',
    gate: 'blockOutbound / privacyBlocked', gateIn: 'ANY', marker: "privacyBlocked('sns_cover_fetch'",
    why: '同上：真正把封面字节取回来的是这一条',
  },
  {
    site: 'src/backend/wechat-data/src/query/image-original.ts#fetchImageOriginalToCache',
    gate: 'blockOutbound / privacyBlocked', gateIn: 'ANY', marker: "privacyBlocked('image_original_fetch'",
    why: '按消息自带的免登录直链从微信 CDN 取聊天图片原图，不发聊天内容',
  },
  {
    site: 'src/backend/wechat-data/src/query/media-image.ts#fetchEmoticonRemote',
    gate: '「自动获取原图（CDN）」开关', gateIn: 'src/backend/wechat-data/src/query/media-image.ts', marker: 'cdnFetchAllowed(opts)',
    why: '表情图片走微信 CDN；开关关掉时连请求都不发（不是「发了再失败」）。判据见 cdn-policy.ts',
  },
  {
    site: 'src/backend/wechat-data/src/query/remote-image.ts#fetchRemoteImage',
    gate: 'blockOutbound / privacyBlocked', gateIn: 'ANY', marker: "privacyBlocked('remote_image_fetch'",
    why: 'M23 的远程图片代取：只允许白名单主机，落盘后渲染层不再直接出网',
  },
  {
    site: 'src/backend/wechat-data/src/query/sns-video.ts#fetchSnsMediaBytes',
    gate: 'blockOutbound / privacyBlocked', gateIn: 'ANY', marker: "privacyBlocked('sns_video_fetch'",
    why: '朋友圈视频/封面字节从微信 CDN 取回，取回后按 `<enc key>` 本机解密',
  },
  {
    site: 'src/backend/wechat-data/src/query/whisper.ts#installWhisperEngine',
    gate: 'blockOutbound / privacyBlocked', gateIn: 'ANY', marker: "privacyBlocked('whisper_engine_install'",
    why: 'P0-2 补：whisper.cpp 引擎 zip 从 GitHub releases 拉 —— 下的是文件，但仍是出网',
  },
  {
    site: 'src/backend/wechat-data/src/query/whisper.ts#streamUrlToFile',
    gate: 'blockOutbound / privacyBlocked（两个调用方各自判闸）',
    gateIn: 'ANY', marker: "privacyBlocked('voice_model_download'",
    why: '这条原语被 whisper 模型下载与 laya 模型下载共用 ⇒ 两个入口都必须先判闸：'
      + '`voice_model_download`（whisper）与 `laya_model_download`（P0-2 补）',
  },
  {
    site: 'src/backend/wechat-host.js#fetchCompletion',
    gate: 'privacyGate（所有 LLM 出口）', gateIn: 'ANY', marker: 'privacyGate(',
    why: '对话补全：发的是**内容**，必须先过 `privacyGate`（含敏感字段打码与审计）',
  },
  {
    site: 'src/backend/wechat-host.js#stream',
    gate: 'privacyGate（所有 LLM 出口）', gateIn: 'ANY', marker: 'privacyGate(',
    why: '流式对话补全：同上一条，只是走 SSE',
  },
  {
    site: 'src/backend/wechat-host.js#embed',
    gate: 'privacyGate + 功能名 ask_embed / kb_embed', gateIn: 'ANY', marker: "makeEmbedFn(",
    why: '向量化的输入是消息正文或文件正文 ⇒ 审计里必须分得开是哪一类（ask_embed / kb_embed）',
  },
  {
    site: 'src/backend/wechat-host.js#rerank',
    gate: 'privacyBlocked(ask_rerank)', gateIn: 'ANY', marker: "privacyBlocked('ask_rerank'",
    why: '精排把候选文档与查询一起发给重排序模型（B2 段）',
  },
  {
    site: 'src/backend/ipc-wechat.js#wechat:llm-models',
    gate: 'blockOutbound（主进程侧读后端真值）', gateIn: 'src/backend/ipc-wechat.js', marker: "call('getPrivacyState')",
    why: 'P0-2 补：`wechat:llm-models` 向用户填的 base_url 发 GET /models，带 `Bearer <API Key>`；'
      + '读不到隐私开关时 fail-closed（按已拦截处理）',
  },
  {
    site: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/world-map-data.ts#fetchFirstJson',
    gate: 'blockMapTiles（地图底图独立开关）', gateIn: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/world-map-data.ts',
    marker: 'mapTilesBlocked()',
    why: '公开 GeoJSON（不含你的数据）；开关在 `mapTilesBlocked()` 里判，且拉之前先问后端真值',
  },
  {
    site: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/overview-export.ts#imageToDataUrl',
    gate: '渲染层 CSP connect-src', gateIn: 'src/client/ui-app/index.html', marker: "connect-src 'self' data: blob: file:",
    why: '把面板里已有的图转成 data URL 供导出用：`src` 是本机/`data:` 地址，'
      + '而 connect-src 只放行 ' + "'self' data: blob: file:" + ' 加三个地图主机 ⇒ 渲染层无法向任意主机发请求',
  },
]

// ------------------------------------------------------------------ 扫描器

/** 扫描范围：产品代码（不含 vendored deps、构建产物、测试）。 */
function sources(): string[] {
  const out: string[] = []
  const walk = (dir: string, re: RegExp): void => {
    for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      if (['node_modules', 'deps', 'lib', 'ui-dist', 'dist', 'fixtures'].includes(e.name)) continue
      const p = join(dir, e.name)
      if (e.isDirectory()) walk(p, re)
      else if (re.test(e.name) && !/\.spec\.[tj]sx?$/.test(e.name)) out.push(p)
    }
  }
  walk(join('src', 'backend', 'wechat-data', 'src'), /\.ts$/)
  walk(join('src', 'client'), /\.(ts|tsx)$/)
  for (const f of readdirSync(join(ROOT, 'src', 'backend'))) {
    if (f.endsWith('.js')) out.push(join('src', 'backend', f))
  }
  out.push('main.js')
  return [...new Set(out.map((p) => relative(ROOT, join(ROOT, p)).split(sep).join('/')))]
}

const NET_CALLS = new Set(['fetch', 'fetchWithRetry', 'XMLHttpRequest', 'request', 'get', 'http', 'https'])

/** 找出一个文件里的出网调用点，返回 `函数名` 列表。 */
function sitesIn(file: string): string[] {
  const src = readFileSync(join(ROOT, file), 'utf8').replace(/\r\n/g, '\n')
  const kind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : file.endsWith('.js') ? ts.ScriptKind.JS : ts.ScriptKind.TS
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, kind)
  const parents = new Map<ts.Node, ts.Node>()
  const link = (n: ts.Node, p?: ts.Node): void => { if (p) parents.set(n, p); ts.forEachChild(n, (c) => link(c, n)) }
  link(sf)
  const enclosingName = (node: ts.Node): string => {
    let cur = parents.get(node)
    while (cur) {
      if ((ts.isFunctionDeclaration(cur) || ts.isMethodDeclaration(cur)) && cur.name) return cur.name.getText(sf)
      if (ts.isArrowFunction(cur) || ts.isFunctionExpression(cur)) {
        const p = parents.get(cur)
        if (p && ts.isVariableDeclaration(p)) return p.name.getText(sf)
        if (p && ts.isPropertyAssignment(p)) return p.name.getText(sf)
        // `ipcMain.handle('wechat:llm-models', async (…) => { … })`：这类回调的名字就是频道名，
        // 否则台账里会出现一堆没有区分度的 `(anonymous)`。
        if (p && ts.isCallExpression(p) && p.arguments.length > 0 && ts.isStringLiteral(p.arguments[0]!)) {
          return p.arguments[0].text
        }
        return '(anonymous)'
      }
      cur = parents.get(cur)
    }
    return '(top)'
  }
  const found: string[] = []
  const seen = new Set<ts.Node>()
  const visit = (node: ts.Node): void => {
    if (seen.has(node)) return
    seen.add(node)
    if (ts.isCallExpression(node)) {
      const e = node.expression
      const name = ts.isIdentifier(e) ? e.text : ts.isPropertyAccessExpression(e) ? e.name.text : ''
      const recv = ts.isPropertyAccessExpression(e) ? e.expression.getText(sf) : ''
      const isHttpLib = (name === 'request' || name === 'get') && /^(https?|http|https\.agent)$/.test(recv)
      if (name === 'fetch' || name === 'fetchWithRetry' || name === 'XMLHttpRequest' || isHttpLib) {
        found.push(enclosingName(node))
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return found
}

/** 实测的 `文件#函数` 集合。 */
function actualSites(): string[] {
  const out: string[] = []
  for (const f of sources()) {
    for (const fn of sitesIn(f)) out.push(`${f}#${fn}`)
  }
  return out.sort()
}

const CACHE = { files: null as string[] | null, sites: null as string[] | null }
function scannedFiles(): string[] {
  if (!CACHE.files) CACHE.files = sources()
  return CACHE.files
}
function scannedSites(): string[] {
  if (!CACHE.sites) CACHE.sites = actualSites()
  return CACHE.sites
}

function codeOf(file: string): string {
  // 剥注释：注释里写的 `privacyBlocked('x')` 不算闸门（本仓有过一次差点被它骗到）。
  const src = readFileSync(join(ROOT, file), 'utf8').replace(/\r\n/g, '\n')
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

describe('出网点台账：每个 fetch/http 调用点都必须登记，且登记指向真实存在的闸门', () => {
  const sites = scannedSites()

  it('扫描真的抓到了出网点（防空转：解析失效时这条先红）', () => {
    expect(sites.length, '一个出网调用点都没扫到 ⇒ 扫描器坏了，后面的判据都会恒真').toBeGreaterThanOrEqual(15)
    for (const known of [
      'src/backend/wechat-data/src/query/whisper.ts#streamUrlToFile',
      'src/backend/ipc-wechat.js#wechat:llm-models',
      'src/backend/wechat-host.js#fetchCompletion',
    ]) {
      expect(sites, `扫描漏了这个已知出网点：${known}`).toContain(known)
    }
  })

  it('实测出网点集合 == 台账（新增点必须登记；点消失了登记也要删）', () => {
    expect([...sites].sort()).toEqual([...LEDGER.map((l) => l.site)].sort())
  })

  it('每条登记的闸门标记在代码里真实存在（不许登记一个不存在的开关）', () => {
    const haystack = (gateIn: string): string => (gateIn === 'ANY'
      ? scannedFiles().map((f) => codeOf(f)).join('\n')
      : codeOf(gateIn))
    for (const l of LEDGER) {
      expect(l.marker, `${l.site} 的登记没有闸门标记`).not.toBe('')
      expect(l.why.length, `${l.site} 没写清楚这个点在发什么`).toBeGreaterThan(8)
      expect(haystack(l.gateIn), `${l.site} 登记的闸门「${l.marker}」在 ${l.gateIn} 里找不到`).toContain(l.marker)
    }
  })

  it('P0-2 的三个漏网点已经各有一个自己的功能名（不许退回「同族漏一个」）', () => {
    const feats = LEDGER.filter((l) => l.marker.startsWith("privacyBlocked('"))
      .map((l) => /privacyBlocked\('([^']+)'/.exec(l.marker)?.[1] ?? '')
    for (const f of ['whisper_engine_install', 'laya_model_download', 'voice_model_download']) {
      // `laya_model_download` 的闸在 remotes/laya.ts，它管的调用点是共用的 streamUrlToFile ⇒
      // 这里按「代码里真的有这个判闸」查，而不是按台账里有没有这一行查。
      const all = scannedFiles().map((f2) => codeOf(f2)).join('\n')
      expect(all, `审计功能名 ${f} 的 privacyBlocked 判闸不见了`).toContain(`privacyBlocked('${f}'`)
    }
    expect(feats.length).toBeGreaterThanOrEqual(4)
  })

  it('台账里每条 `gateIn` 指向的文件确实存在（改名/搬文件要一起改台账）', () => {
    for (const l of LEDGER) {
      if (l.gateIn === 'ANY') continue
      expect(existsSync(join(ROOT, l.gateIn)), `登记的闸门文件不存在：${l.gateIn}`).toBe(true)
    }
  })
})
