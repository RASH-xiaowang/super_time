/**
 * 出网点台账：**枚举调用点**，而不是「找 privacy 接缝」。
 *
 * ## 2026-09-30 改判据：从「每个点都要有闸门」改成「每个点都要有着落」
 *
 * 应用内的出网开关**已全部移除**（`blockOutbound` / `blockMapTiles` / `cdn_enabled` /
 * `cdn_local_decrypt`），所以「每个出网点都必须被某个开关管着」这个前提不成立了。
 * 但这份台账的真正价值从来不是开关，而是**枚举本身**：产品代码里每一个真正发请求的地方
 * 都必须有人写清楚「它在发什么、现在凭什么可以发」。于是登记项从 `gate`（开关）改成
 * `control`（现在的约束：主机白名单 / 授权档位 / 只有你点击才会发生 / 公开数据 / 无闸门），
 * 并且：
 *   · 有锚点的（白名单、CSP、审计接缝）仍要求那个字面量**在代码里真实存在**；
 *   · 没有锚点的必须**明写**「无应用内闸门」——这条不许含糊，它是「数据会不会出去」的答案。
 *
 * ## 为什么还留着它（而不是连台账一起删）
 *
 * 上一版抓到的三类静默失效（P0-2：引擎下载、laya 模型下载、主进程模型列表）都不是
 * 「闸门写错了」，而是**根本没人知道那里有一个出网点**。枚举这件事与开关无关。
 *
 * 扫描范围与判据：
 *   1. AST 枚举产品代码里每一个出网调用点（`fetch` / `fetchWithRetry` / `http(s).request`），
 *      键成 `文件#所在函数`（不依赖行号）；
 *   2. 每个点必须在这里有一条登记；
 *   3. 台账与实测集合 `toEqual` ⇒ 新增一个出网点、或删掉一个，都会当场变红。
 * @vitest-environment node
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

/** 一条登记：出网点 → 现在约束它的是什么 + 代码锚点（没有则明写「无」）+ 为什么。 */
interface LedgerEntry {
  /** `文件相对路径#函数名` —— 台账的主键。 */
  site: string
  /** 控制类型（人类可读，便于扫）。 */
  control: string
  /** 锚点所在文件（`ANY` = 产品代码任意处）；没有锚点时写 `NONE`。 */
  anchor: string
  /** 必须真实存在的锚点字面量（剥注释后）。**没有锚点时为 `''`**。 */
  marker: string
  /** 这个点在发什么、为什么可以接受。 */
  why: string
}

const LEDGER: LedgerEntry[] = [
  {
    site: 'src/backend/wechat-data/src/query/article-cover.ts#fetchText',
    control: '无应用内闸门（只取消息里给出的文章地址）',
    anchor: 'NONE', marker: '',
    why: '读公众号文章的 og:image 所在的 HTML。地址来自消息 XML；应用内已无开关，'
      + '域名收敛要另做（现只在 `article-cover.ts` 里把 http 升级为 https）。',
  },
  {
    site: 'src/backend/wechat-data/src/query/article-cover.ts#fetchBytes',
    control: '无应用内闸门（同上）',
    anchor: 'NONE', marker: '',
    why: '同上：真正把封面字节取回来的是这一条，结果落盘缓存后下次不再联网。',
  },
  {
    site: 'src/backend/wechat-data/src/query/image-original.ts#fetchImageOriginalToCache',
    control: '腾讯系主机白名单', anchor: 'ANY', marker: 'wechatCdnHostAllowed',
    why: '按消息自带的免登录直链取聊天图片原图，不发聊天内容；主机不在白名单内一个字节都不发。',
  },
  {
    site: 'src/backend/wechat-data/src/query/media-image.ts#fetchEmoticonRemote',
    control: '腾讯系主机白名单 + 仅 http(s)（2026-09-30 补齐）',
    anchor: 'src/backend/wechat-data/src/query/media-image.ts', marker: 'wechatCdnHostAllowed(',
    why: '表情图走消息 XML 里的 `cdnurl`。取到后落 `<decoded>/<md5>.<ext>`，之后（含离线）只走本地。'
      + '此前这条链只判协议、等于「XML 写哪个主机就去取哪个」，现已与聊天原图/远程图片同一把尺子。',
  },
  {
    site: 'src/backend/wechat-data/src/query/remote-image.ts#fetchRemoteImage',
    control: '腾讯系主机白名单 + 仅 https', anchor: 'ANY', marker: 'wechatCdnHostAllowed',
    why: 'M23 的远程图片代取：只允许白名单主机，落盘后渲染层不再直接出网。',
  },
  {
    site: 'src/backend/wechat-data/src/query/sns-video.ts#fetchSnsMediaBytes',
    control: '腾讯系主机白名单（播放/封面在 remotes/media.ts 判，导出在 loadSnsVideoBytes 判）',
    anchor: 'src/backend/wechat-data/src/query/sns-video.ts', marker: 'wechatCdnHostAllowed(',
    why: '朋友圈视频/封面字节从微信 CDN 取回，取回后按 `<enc key>` 本机解密。'
      + '三条入口（播放 / 封面 / 导出）现在都过白名单，且都判在发请求之前。',
  },
  {
    site: 'src/backend/wechat-data/src/query/whisper.ts#installWhisperEngine',
    control: '无应用内闸门（只有你点击「下载引擎」才会发生）', anchor: 'NONE', marker: '',
    why: 'whisper.cpp 引擎 zip 从 GitHub releases 拉 —— 下的是文件，不是你聊天内容。',
  },
  {
    site: 'src/backend/wechat-data/src/query/whisper.ts#streamUrlToFile',
    control: '无应用内闸门（只有你点击「下载模型」/「下载本地决策模型」才会发生）', anchor: 'NONE', marker: '',
    why: 'whisper 模型（HF / hf-mirror）与 laya 模型（约 1.26 GB）共用这条流式下载原语。',
  },
  {
    site: 'src/backend/wechat-host.js#fetchCompletion',
    control: '脱敏 + 审计接缝（`privacyGate`）', anchor: 'ANY', marker: 'privacyGate(',
    why: '对话补全：发的是**内容**，出站前过一次 `privacyGate`（敏感字段打码 + 写审计）。',
  },
  {
    site: 'src/backend/wechat-host.js#stream',
    control: '脱敏 + 审计接缝（`privacyGate`）', anchor: 'ANY', marker: 'privacyGate(',
    why: '流式对话补全：同上一条，只是走 SSE。',
  },
  {
    site: 'src/backend/wechat-host.js#embed',
    control: '脱敏 + 审计接缝（`privacyGate`，功能名 ask_embed / kb_embed）',
    anchor: 'ANY', marker: 'makeEmbedFn(',
    why: '向量化的输入是消息正文或文件正文 ⇒ 审计里必须分得开是哪一类。',
  },
  {
    site: 'src/backend/wechat-host.js#rerank',
    control: "脱敏 + 审计接缝（privacyGate('ask_rerank')，整批一起过）",
    anchor: 'ANY', marker: "privacyGate('ask_rerank'",
    why: '精排把候选文档与查询一起发给重排序模型。',
  },
  {
    site: 'src/backend/ipc-wechat.js#wechat:llm-models',
    control: '无应用内闸门（只有你点击「获取模型列表」才会发生）', anchor: 'NONE', marker: '',
    why: '向用户自己填的 base_url 发 GET /models，带 `Bearer <API Key>`；不发聊天内容。'
      + '2026-09-30 前这里有一次 fail-closed 的出网拦截，随开关一起移除。',
  },
  {
    site: 'src/backend/llm-balance.js#getJson',
    // 这一处与上面那条不同：它**不只是**点击触发 —— 左下角余额条每 5 分钟也会调一次
    // （用户要求「余额实时显示」）。台账口径：有真实锚点时 `control` 里**不能**出现
    // 「无应用内闸门」这个词（那条短语是留给 anchor:'NONE' 的），所以这里写清实际约束。
    control: '地址须为 http(s)、余额查询须有 API Key（渲染侧没 Key 直接不调用）——没有出网开关，'
      + '左下角那条是 5 分钟的定时请求',
    anchor: 'src/backend/llm-balance.js', marker: 'async function getJson(',
    why: '只向**用户自己配置的** apiUrl 发请求，只带 `Bearer <API Key>`：'
      + '连接测试打 `{base}/models`，余额查询按厂商惯例打 `{origin}/user/balance`（DeepSeek）'
      + '或 `{base}/user/info`（SiliconFlow 等）。'
      + '**不发任何聊天内容**；清空 API Key 后调用方直接不出网（渲染侧 `SidebarBalance` 会自己隐藏）。'
      + '厂商不提供余额接口时（如 OpenAI）明确报错并显示「余额 —」，不猜数字。'
      + '逐条口径见 docs/PRIVACY.md 的 A2 节。',
  },
  {
    site: 'src/backend/llm-balance.js#postJson',
    // 与上面那条同属「模型端点探针」，但这一处发的是 **POST 最小请求**：
    // 向量与精排没有"只看不花钱"的探测接口，所以各发一条固定测试串。
    control: '地址须为 http(s)、该端点须填了模型名（渲染侧没模型名按钮就是禁用的）——没有出网开关',
    anchor: 'src/backend/llm-balance.js', marker: 'async function postJson(',
    why: '只向**用户自己配置的**向量 / 精排端点发一条**固定测试串**（`连接测试`，约 3 / 6 个 token），'
      + 'body 里只有 model + 这句测试串：不含聊天内容、不含查询词、不含文件名。'
      + '带的是对应端点的 `Bearer <Key>`（`embeddingApiKey` / `rerankApiKey`，留空回落 `apiKey`）。'
      + '逐条口径见 docs/PRIVACY.md 的 A2 节。',
  },
  {
    site: 'src/backend/wechat-data/src/query/clawbot-ilink.ts#requestJson',
    control: '主机写死（腾讯 iLink 服务）+ 接收侧只发控制面、发送侧只发你主动写的那条正文',
    anchor: 'src/backend/wechat-data/src/query/clawbot-ilink.ts', marker: 'ilinkai.weixin.qq.com',
    why: '微信 ClawBot 绑定通道（2026-10-12 接入）：取码 / 状态轮询 / 消息长轮询 / 发送四条都经这一个函数。'
      + '接收侧请求体里只有同步游标与渠道版本号；发送侧（`sendTextMessage`）body = 路由字段 + '
      + '一条文本条目，正文 = 面板输入框原文、由用户逐条触发（没有自动/定时发送）。'
      + '服务端回传的 `baseurl` 会在 `resolveBaseUrl` 再收敛一层（只许 https 的 weixin.qq.com 域）。'
      + '逐条口径见 docs/PRIVACY.md 的 G2 节。',
  },
  {
    site: 'src/backend/wechat-data/src/query/clawbot-media.ts#downloadBytes',
    control: '主机写死（腾讯 iLink CDN）+ 收到附件消息即自动取回（无人值守；正文型 url 先过腾讯系白名单）',
    anchor: 'src/backend/wechat-data/src/query/clawbot-media.ts', marker: 'novac2c.cdn.weixin.qq.com',
    why: 'ClawBot 媒体可见（2026-10-12 接入；同日改自动取回）：收到带附件的消息后由队列'
      + '自动下载 + 解密 + 落 `<数据根>/clawbot-media/`（无人值守；失败在下一次同步 / 启动补扫重试）。'
      + '加密引用走固定 CDN 基址；图片自带的明文 URL 先过 `wechatCdnHostAllowed` 才发请求。'
      + '单份上限 32MB；逐条口径见 docs/PRIVACY.md 的 G2 节。',
  },
  {
    site: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/world-map-data.ts#fetchFirstJson',
    control: '公开的行政区划数据（固定镜像源）', anchor: 'ANY', marker: 'WORLD_GEO_URLS',
    why: '不含你的数据；URL 是代码里的常量清单，不由消息内容或用户输入决定。',
  },
  {
    site: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/overview-export.ts#imageToDataUrl',
    control: '渲染层 CSP `connect-src`', anchor: 'src/client/ui-app/index.html',
    marker: "connect-src 'self' data: blob: file:",
    why: '把面板里已有的图转成 data URL 供导出用：`src` 是本机/`data:` 地址。',
  },
  // —— 2026-10-14：手机浏览器态的三条 `fetch`。**它们不是出网点** ——
  // 打的全是同源相对路径（`/api/...`），也就是本机那个局域网远程访问服务；
  // 一个字节都不会离开这台机器（手机侧看是「发给电脑」，电脑侧看是本地回环/局域网地址）。
  // 登记在这里是因为台账的口径是「每个 fetch 调用点都要说清它凭什么可以发」，
  // 而这三条恰恰最需要说清：它们是渲染层里唯一一批**不带主机名**的 fetch，
  // 将来谁把它改成绝对地址（比如写死某个 IP），这条登记就是提醒要看一眼的地方。
  {
    site: 'src/client/ui-app/http-remote.ts#callRemote',
    control: '同源相对路径 + 会话 Cookie（不是出网点）',
    anchor: 'src/client/ui-app/http-remote.ts', marker: "credentials: 'same-origin'",
    why: '浏览器态调后端：`POST /api/wechat/call`，同源相对路径、没有主机名。'
      + '服务端那一边过的是与桌面 IPC 同一道闸门（`call-gates.js`）+ 方法白名单。',
  },
  {
    site: 'src/client/ui-app/http-remote.ts#authenticate',
    control: '同源相对路径（不是出网点）',
    anchor: 'src/client/ui-app/http-remote.ts', marker: "'/api/auth'",
    why: '令牌换会话：`POST /api/auth`。令牌由桌面端生成、只在这一次请求里出现，'
      + '随后由 `stripTokenFromUrl` 从地址栏抹掉；比对在服务端用定长比较完成。',
  },
  {
    site: 'src/client/ui-app/http-remote.ts#hasSession',
    control: '同源相对路径（不是出网点）',
    anchor: 'src/client/ui-app/http-remote.ts', marker: "'/api/status'",
    why: '探测当前会话是否有效：`GET /api/status`。令牌门用它决定「直接进」还是「先要令牌」，'
      + 'SSE 断线时也用它区分「网络抖动」与「会话失效」。不带任何数据。',
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
  // 剥注释：注释里写的 `privacyGate('x')` 不算接缝（本仓有过一次差点被它骗到）。
  const src = readFileSync(join(ROOT, file), 'utf8').replace(/\r\n/g, '\n')
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

describe('出网点台账：每个 fetch/http 调用点都必须登记，并写清它凭什么可以发', () => {
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

  it('每条登记的锚点在代码里真实存在（没有锚点的必须明写「无应用内闸门」）', () => {
    const haystack = (anchor: string): string => (anchor === 'ANY'
      ? scannedFiles().map((f) => codeOf(f)).join('\n')
      : codeOf(anchor))
    for (const l of LEDGER) {
      expect(l.why.length, `${l.site} 没写清楚这个点在发什么`).toBeGreaterThan(8)
      const noGate = l.anchor === 'NONE'
      expect(l.control.includes('无应用内闸门'), `${l.site} 没有锚点就必须明写「无应用内闸门」，现在是「${l.control}」`)
        .toBe(noGate)
      if (noGate) {
        expect(l.marker, `${l.site} 声明没有闸门，却又写了锚点`).toBe('')
        continue
      }
      expect(l.marker, `${l.site} 的登记没有锚点字面量`).not.toBe('')
      expect(haystack(l.anchor), `${l.site} 登记的锚点「${l.marker}」在 ${l.anchor} 里找不到`).toContain(l.marker)
    }
  })

  it('台账里每条 `anchor` 指向的文件确实存在（改名/搬文件要一起改台账）', () => {
    for (const l of LEDGER) {
      if (l.anchor === 'ANY' || l.anchor === 'NONE') continue
      expect(existsSync(join(ROOT, l.anchor)), `登记的锚点文件不存在：${l.anchor}`).toBe(true)
    }
  })

  /**
   * 与「移除全部出网开关」配套的一条防回归：产品代码里不许再出现那两个开关的判定/字段。
   *
   * 剥注释后再查 —— 注释里正当会写「`blockOutbound` 已随开关一起删除」（本仓刻意保留
   * 这段历史说明），所以只有**活代码**里出现才算回归。
   */
  it('出网开关不许回来（剥注释后的产品代码里不许再出现它们的名字）', () => {
    const tokens = ['blockOutbound', 'blockMapTiles', 'cdn_enabled', 'cdn_local_decrypt',
      'cdnFetchAllowed', 'localDecryptEnabled', 'privacyBlocked', 'outboundBlocked']
    const offenders: string[] = []
    for (const f of scannedFiles()) {
      const code = codeOf(f)
      for (const t of tokens) {
        if (code.includes(t)) offenders.push(`${f}: ${t}`)
      }
    }
    expect(offenders, '移除掉的出网开关又出现在产品代码里了').toEqual([])
    expect(existsSync(join(ROOT, 'src/backend/wechat-data/src/query/cdn-policy.ts')),
      'CDN 开关的判定模块又回来了').toBe(false)
    expect(existsSync(join(ROOT, 'src/client/ui-wechat/src/client/pages/wechat-data/map-tiles-flag.ts')),
      '地图底图开关的渲染层镜像又回来了').toBe(false)
  })
})
