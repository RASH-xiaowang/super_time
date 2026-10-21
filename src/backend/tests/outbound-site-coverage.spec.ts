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
    control: '腾讯系主机白名单（文章页只允许 mp.weixin.qq.com）',
    anchor: 'src/backend/wechat-data/src/query/article-cover.ts', marker: 'wechatArticleUrlAllowed(',
    why: '读公众号文章的 og:image 所在的 HTML。地址来自消息 XML；文章页域名收窄为 '
      + 'mp.weixin.qq.com，站外地址在发请求之前就拒绝，http 再升级为 https。',
  },
  {
    site: 'src/backend/wechat-data/src/query/article-cover.ts#fetchBytes',
    control: '腾讯系主机白名单（封面图走 CDN 后缀清单）',
    anchor: 'src/backend/wechat-data/src/query/article-cover.ts', marker: 'wechatCdnHostAllowed(',
    why: '真正把封面字节取回来的是这一条：og:image 提取出的地址先归一成 https，'
      + '再按图片 CDN 白名单判定后才发请求；结果落盘缓存后下次不再联网。',
  },
  {
    site: 'src/backend/wechat-data/src/query/image-original.ts#fetchImageOriginalToCache',
    control: '腾讯系主机白名单', anchor: 'ANY', marker: 'wechatCdnHostAllowed',
    why: '按消息自带的免登录直链取聊天图片原图，不发聊天内容；主机不在白名单内一个字节都不发。',
  },
  {
    site: 'src/backend/wechat-data/src/query/wxcdn-original.ts#ensureToken',
    control: '用户显式开关（`wxcdn_enabled`，默认 false）',
    anchor: 'src/backend/wechat-data/src/query/wxcdn-original.ts', marker: 'TOKEN_URL',
    why: '第三方原图服务换 token：把本机 `all_users/config/global_config` 发给 `wxcdn.c3o.re`。'
      + '该服务不是腾讯官方，所以**默认关闭**，只有用户显式打开 `wxcdn_enabled` 才会走到这里'
      + '（判据在 `image-auto-upgrade.ts` 的 `isWxcdnEnabled`）。',
  },
  {
    site: 'src/backend/wechat-data/src/query/wxcdn-original.ts#downloadOriginalByFileid',
    control: '用户显式开关（`wxcdn_enabled`，默认 false）+ 额度检查',
    anchor: 'src/backend/wechat-data/src/query/wxcdn-original.ts', marker: 'DOWNLOAD_URL',
    why: '按 `cdnbigimgurl` 的 fileid 取原图（服务端解密）。按流量计费（Free 50 MB/天），'
      + '所以发请求前先查剩余额度；这是本机数据上唯一能覆盖那 81.6% 的通路。',
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
    site: 'src/backend/llm-http.js#llmRequest',
    control: '内容型调用在 llm-bridge 上游过 privacyGate；探针/余额只发凭据或固定测试串',
    anchor: 'ANY', marker: 'privacyGate(',
    why: '所有 LLM 出网请求现在都经这一条统一传输：chat/stream/embed/rerank 的正文与候选文档'
      + '由各自网关在上游过 privacyGate；模型列表、连接测试与余额查询只发用户自己配置的'
      + ' base_url、Bearer Key 或固定测试串（不发聊天内容）。地址统一经过 parseLlmBaseUrl'
      + ' 的 http(s) 校验，且拒绝 URL 凭据与 query/hash；余额无 Key 时调用方直接不发请求。',
  },
  {
    site: 'src/backend/wechat-data/src/query/clawbot/clawbot-ilink.ts#requestJson',
    control: '主机写死（腾讯 iLink 服务）+ 接收侧只发控制面、发送侧只发你主动写的那条正文',
    anchor: 'src/backend/wechat-data/src/query/clawbot/clawbot-ilink.ts', marker: 'ilinkai.weixin.qq.com',
    why: '微信 ClawBot 绑定通道（2026-10-12 接入）：取码 / 状态轮询 / 消息长轮询 / 发送四条都经这一个函数。'
      + '接收侧请求体里只有同步游标与渠道版本号；发送侧（`sendTextMessage`）body = 路由字段 + '
      + '一条文本条目，正文 = 面板输入框原文、由用户逐条触发（没有自动/定时发送）。'
      + '服务端回传的 `baseurl` 会在 `resolveBaseUrl` 再收敛一层（只许 https 的 weixin.qq.com 域）。'
      + '逐条口径见 docs/PRIVACY.md 的 G2 节。',
  },
  {
    site: 'src/backend/wechat-data/src/query/clawbot/clawbot-media.ts#downloadBytes',
    control: '主机写死（腾讯 iLink CDN）+ 收到附件消息即自动取回（无人值守；正文型 url 先过腾讯系白名单）',
    anchor: 'src/backend/wechat-data/src/query/clawbot/clawbot-media.ts', marker: 'novac2c.cdn.weixin.qq.com',
    why: 'ClawBot 媒体可见（2026-10-12 接入；同日改自动取回）：收到带附件的消息后由队列'
      + '自动下载 + 解密 + 落 `<数据根>/clawbot-media/`（无人值守；失败在下一次同步 / 启动补扫重试）。'
      + '加密引用走固定 CDN 基址；图片自带的明文 URL 先过 `wechatCdnHostAllowed` 才发请求。'
      + '单份上限 32MB；逐条口径见 docs/PRIVACY.md 的 G2 节。',
  },
  {
    site: 'src/backend/wechat-data/src/query/task-center-callback.ts#postTaskCallback',
    control: '用户显式配置的回调地址；仅已完善任务投递',
    anchor: 'src/backend/wechat-data/src/query/task-center-callback.ts', marker: 'fetchWithRetry(',
    why: '任务触发回调（2026-10-19）：用户在「任务信息」里为每个任务逐条填写回调地址，'
      + '任务标记「已完善」后，后台在每次微信新消息同步落地时立即扫描（另有每 10 秒兜底）；命中关键词就把**这一条**触发记录'
      + '（触发时间 / 会话 / 触发对象 / 关键词 / 文本 / 该对象最近 N 张图片）以 JSON POST 到该地址。'
      + '地址只允许 http/https；未完善任务不扫描、不投递，失败只记状态（2 次尝试 / 15s 超时）。'
      + '逐条口径见 docs/PRIVACY.md 的 G3 节。',
  },
  {
    site: 'src/backend/wechat-data/src/query/task-center-callback.ts#postBazhuayuTrigger',
    control: '用户显式为每个任务配置 FlowId + API Key、触发方式=八爪鱼 RPA 才发生；主机固定；仅已完善任务',
    anchor: 'src/backend/wechat-data/src/query/task-center-callback.ts', marker: 'api-rpa.bazhuayu.com',
    why: '任务触发方式「八爪鱼 RPA」（2026-10-21）：用户在任务编辑抽屉里把该任务的触发方式切到八爪鱼，'
      + '并逐任务填写 FlowId 与 API Key；只有「任务已完善 + 该方式配置齐全」时才会走到这里。'
      + '目的地写死为 `https://api-rpa.bazhuayu.com/api/bots/scheduling/start`（应用不内置其它 RPA 主机），'
      + '用 `X-Api-Key` 请求头携带该任务的 Key（Key 只存本机任务库、不进列表返回值）。'
      + '参数只有 room_name=会话名 / content=触发文本（先过与 Webhook 同一个隐私闸，功能名 task_callback）/ '
      + 'at_name=触发对象，**不发图片**，也不发任务 id/名称与 username；失败只记状态（2 次尝试 / 15s 超时）。'
      + '默认触发方式仍是 webhook，既有任务行为不变；逐条口径见 docs/PRIVACY.md 的 G3 节。',
  },
  {
    site: 'src/backend/wechat-data/src/query/map-geo.ts#fetchMapGeoJson',
    control: '固定 GeoJSON 主机 + 路径/参数白名单', anchor: 'ANY', marker: 'isAllowedMapGeoUrl',
    why: '不含你的数据；渲染层只传候选地址，后端按固定主机与路径形状过滤后才发请求。',
  },
  {
    site: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/overview-export.ts#imageToDataUrl',
    control: 'http(s) 走后端图片代理（白名单 + 审计 + 缓存）；本函数只直接 fetch blob:/file:',
    anchor: 'src/client/ui-wechat/src/client/pages/wechat-data/api-media.ts', marker: 'apiGetRemoteImageUrl',
    why: '把面板里已有的图转成 data URL 供导出用：远程地址交给后端白名单代理，'
      + '只有 blob:/file: 这类本机地址允许在渲染层直接读取。',
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
    site: 'src/client/ui-app/http-remote.ts#probeSession',
    control: '同源相对路径（不是出网点）',
    anchor: 'src/client/ui-app/http-remote.ts', marker: "'/api/status'",
    why: '探测当前会话：`GET /api/status`，回三态 ok / gone / unreachable。令牌门用它决定「直接进」还是'
      + '「先要令牌」，SSE 断线时用它区分「服务没在跑」与「没权限」—— 把后者当成前者会把用户'
      + '关进一个此刻走不通的令牌门（2026-10-14 真机反例）。不带任何数据。',
  },
  {
    site: 'src/client/ui-app/handoff-boot.ts#native',
    control: '同源相对路径 + 交接会话 Cookie（不是出网点）',
    anchor: 'src/client/ui-app/handoff-boot.ts', marker: "'/api/native/'",
    why: '「打开网页」交接态的原生能力代理：`POST /api/native/<action>`，同源相对路径、没有主机名。'
      + '服务端只对 fullAccess 会话放行；交接结束（停服）后这些端点连同 Cookie 一起失效。',
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
      'src/backend/llm-http.js#llmRequest',
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
