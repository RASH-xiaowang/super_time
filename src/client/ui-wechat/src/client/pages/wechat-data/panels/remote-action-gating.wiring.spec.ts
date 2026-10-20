/**
 * 远程动作门控台账（M10 的审计矩阵，做成活的闸门而不是一次性报告）。
 *
 * ## 为什么要有这一条
 *
 * 后端把 195 个 `@Remote` 方法二分成「可远程」与「仅桌面」（`http-remote-policy.js`），
 * 但**白名单只管服务端会不会答应，不管界面上还留不留那个入口**。两者一脱节，
 * 症状就是手机上出现一个按下去只会吃到 `METHOD_NOT_ALLOWED_REMOTE` 的按钮 ——
 * 而 `capabilities.ts` 文件头写的正是「这比报错更难排查」。
 *
 * ## 判据的形状
 *
 * 面板文件里**直接调用**了某个 `api*`，而该 `api*` 落到至少一个仅桌面方法 ⇒ 这个文件必须：
 *   ① 自己带降级标记（`desktopAction()` / `desktopActionProps()` / `desktopOnlyGate(` / `runtimeCapabilities()`），或
 *   ② 出现在下面这份台账里，并写明**由谁的哪一句覆盖**（那个 needle 必须真的搜得到）。
 *
 * ②是给「入口本身已被上层挡掉」的模块级 helper 用的（`chats-export.tsx` 的整个弹窗
 * 由聊天页那个已禁用的「导出消息」菜单项进入）。台账不是免检牌：它要求写出覆盖点，
 * 覆盖点一旦被删，这条判据就红 —— 而**新增**一个未登记的文件会立刻红。
 *
 * 不做传递闭包：闭包会把「overview 引了面板、面板引了导出」都算到 overview 头上，
 * 台账会胖一倍且全是假阳性（真机走查证明它们并不发这些调用）。
 *
 * @vitest-environment node
 */
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
const WD = resolve(HERE, '..')
// HERE=panels → wechat-data → pages → client → src → ui-wechat → client → src（仓库根的 src）
const POLICY = resolve(HERE, '../../../../../../../backend/http-remote-policy.js')

/** 台账：文件 → 覆盖它的那一句（在 `file` 里必须能原样搜到）。 */
const COVERED_BY_OWNER: Readonly<Record<string, { file: string, needle: string, why: string }>> = {
  'use-original-harvest.ts': {
    file: 'settings-steps.tsx',
    needle: 'onClick={() => { void originalHarvest(',
    why: '原图自动收割只从「设置 → 图片解码」卡片触发，而设置面板本身是桌面专属（手机态进不去）',
  },
  'use-third-party-original.ts': {
    file: 'settings-steps.tsx',
    needle: 'onClick={() => { void toggleWxcdn() }}',
    why: '第三方原图服务的开关与查额度只从「设置 → 图片解码」卡片触发，设置面板本身是桌面专属',
  },
  'image-autodownload-card.tsx': {
    file: 'settings-steps.tsx',
    needle: '<ImageAutoDownloadCard />',
    why: '微信原图自动下载（实验）只从「设置 → 图片解码」卡片触发，设置面板本身是桌面专属；'
      + '它还会往本机微信进程注入组件，手机/浏览器态没有这个入口',
  },
  'chats-export.tsx': {
    file: 'chats-head-actions.tsx',
    needle: 'disabled={exporting || desktopAction()}',
    why: '导出弹窗只从聊天页「更多 → 导出消息」进入，那一项在手机态是禁用的',
  },
  'export-progress-relay.ts': {
    file: 'chats-head-actions.tsx',
    needle: 'disabled={exporting || desktopAction()}',
    why: '进度中继只服务导出任务本身',
  },
  'clawbot-bind-modal.tsx': {
    file: 'clawbot-rail.tsx',
    needle: 'disabled={busy === it.slot} {...desktopActionProps()}',
    why: '绑定弹窗只从实例轨/集成设置里的绑定按钮打开，两处都已禁用',
  },
  'KbModelDialog.tsx': {
    file: 'KbRail.tsx',
    needle: '{...desktopActionProps()}',
    why: '本库模型弹层只从 KbRail 的模型芯片打开，那颗芯片在手机态禁用',
  },
  'kb-index-build.ts': {
    file: 'kb-files-panel.tsx',
    needle: 'disabled={indexing} {...desktopActionProps()}',
    why: '建索引 hook 只被「语义索引」那颗按钮驱动，按钮已禁用',
  },
  'moments-export.ts': {
    file: 'moments-panel.tsx',
    needle: 'onClick={openExport} {...desktopActionProps()}',
    why: '朋友圈导出整条链路（含重解密）只从面板的「导出」按钮进入',
  },
  'moments-videos.ts': {
    file: 'moments-card.tsx',
    needle: 'saveVideo(v) }} {...desktopActionProps()}',
    why: '视频另存为只从卡片上的 ⭳ 按钮触发，那颗按钮已禁用',
  },
  'settings-state.tsx': {
    file: 'Settings.tsx',
    needle: 'runtimeCapabilities().desktopEquivalent !== true',
    why: '设置面板在普通浏览器态整块换视图，这份状态钩子根本不挂载；交接态则与桌面端同权限',
  },
  'settings-steps.tsx': {
    file: 'Settings.tsx',
    needle: 'runtimeCapabilities().desktopEquivalent !== true',
    why: '五步配置卡都在设置面板里，普通浏览器态由根分派挡下；交接态与桌面端同权限',
  },
  'chats-media.tsx': {
    file: 'chats-media.tsx',
    needle: 'void apiOpenPath(videoPath)',
    why: '这条 openPath 是「视频取不到」时的兜底提示路径；手机上看视频走的是白名单里的取数，'
      + '真走到这一支时用户看到的是一句读得出的失败说明',
  },
}

/** 剥掉注释（注释里提到 `apiXxx(` 不算调用）。 */
function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').split(/\r\n|\n/).map((l) => l.replace(/\/\/.*$/, '')).join('\n')
}

/** 取 `NAME_BY_FAMILY = {…}` 里的方法名集合。 */
function familySet(src: string, varName: string): Set<string> {
  const i = src.indexOf(`const ${varName} = {`)
  if (i < 0) throw new Error(`http-remote-policy.js 里找不到 ${varName}`)
  let depth = 0
  let j = src.indexOf('{', i)
  const start = j
  for (; j < src.length; j++) {
    if (src[j] === '{') depth++
    else if (src[j] === '}') { depth--; if (depth === 0) { j++; break } }
  }
  return new Set([...src.slice(start, j).matchAll(/'([A-Za-z_][\w]*)'/g)].map((m) => m[1] ?? ''))
}

const policySrc = readFileSync(POLICY, 'utf8')
const LOCAL = familySet(policySrc, 'LOCAL_ONLY_BY_FAMILY')
const SAFE = familySet(policySrc, 'REMOTE_SAFE_BY_FAMILY')

/** `apiXxx` → 它落到的 @Remote 方法名（扫 api-*.ts 里的 `remote().m(`）。 */
function apiMethodMap(): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const f of readdirSync(WD).filter((x) => /^api-[\w-]+\.ts$/.test(x))) {
    const src = readFileSync(join(WD, f), 'utf8')
    for (const part of src.split(/(?=export (?:async )?function )/)) {
      const m = /^export (?:async )?function (api\w+)/.exec(part)
      if (!m) continue
      const names = [...new Set([...part.matchAll(/\bremote\(\)\.([A-Za-z_][\w]*)\s*[<(]/g)].map((x) => x[1] ?? ''))]
      if (names.length > 0 && m[1] !== undefined) out.set(m[1], names)
    }
  }
  return out
}

export interface GatingRow { file: string; local: string[]; gated: boolean; covered: boolean }

/** 判据本体（导出是为了让反例用例能直接喂它）。 */
export function auditPanelGating(apiMethods: Map<string, string[]>): GatingRow[] {
  const dir = join(WD, 'panels')
  const rows: GatingRow[] = []
  for (const f of readdirSync(dir).filter((x) => /\.tsx?$/.test(x) && !x.includes('.spec.'))) {
    const code = stripComments(readFileSync(join(dir, f), 'utf8'))
    const local = new Set<string>()
    for (const m of code.matchAll(/\b(api[A-Z]\w*)\s*\(/g)) {
      for (const meth of apiMethods.get(m[1] ?? '') ?? []) if (LOCAL.has(meth)) local.add(meth)
    }
    if (local.size === 0) continue
    const gated = /desktopAction\(\)|desktopActionProps\(\)|desktopOnlyGate\(|runtimeCapabilities\(\)/.test(code)
    const cov = COVERED_BY_OWNER[f]
    const covered = cov !== undefined
      && readFileSync(join(dir, cov.file), 'utf8').includes(cov.needle)
    rows.push({ file: f, local: [...local].sort(), gated, covered })
  }
  return rows.sort((a, b) => a.file.localeCompare(b.file))
}

describe('远程动作门控台账（每个仅桌面动作都有人挡着）', (): void => {
  const apiMethods = apiMethodMap()
  const rows = auditPanelGating(apiMethods)

  it('哨兵：判据真的有对象（api 映射、白名单、面板命中数都非空）', (): void => {
    expect(apiMethods.size).toBeGreaterThan(150)
    expect(SAFE.size).toBeGreaterThan(100)
    expect(LOCAL.size).toBeGreaterThan(50)
    expect(rows.length).toBeGreaterThan(20)
    // 台账里每一条都必须对应一个**真的会打到仅桌面方法**的文件（否则就是白占一格的免检牌）
    for (const f of Object.keys(COVERED_BY_OWNER)) {
      expect(rows.some((r) => r.file === f), `台账里的 ${f} 已经没有仅桌面调用了 —— 把这条删掉`).toBe(true)
    }
  })

  it('① 直接调用仅桌面方法的面板，要么自己带降级，要么写明被谁覆盖', (): void => {
    const naked = rows.filter((r) => !r.gated && !r.covered).map((r) => `${r.file} → ${r.local.join(',')}`)
    expect(naked).toEqual([])
  })

  it('② 降级标记不能是空话：带标记的文件里必须真的看得到仅桌面调用被挡的位置', (): void => {
    // 这一条盯的是「文件里加了一句 desktopAction() 但和那些按钮毫无关系」的糊弄写法：
    // 至少要有 `desktopActionProps()` 的 spread、`desktopOnlyGate('` 的卡、或 `!desktopAction()` 的条件渲染之一。
    const weak = rows.filter((r) => r.gated).filter((r) => {
      const code = stripComments(readFileSync(join(WD, 'panels', r.file), 'utf8'))
      return !/desktopActionProps\(\)/.test(code) && !/desktopOnlyGate\('/.test(code) && !/!desktopAction\(\)/.test(code) && !/runtimeCapabilities\(\)\.[a-zA-Z]+/.test(code)
    }).map((r) => r.file)
    expect(weak).toEqual([])
  })

  /**
   * ③ 一个文件里挡了**多个**动作时，降级写法的条数有下限。
   *
   * 为什么需要这一条：② 只看「文件里有没有降级」，于是一个文件里挡了七个动作时，
   * 悄悄去掉一个按钮的降级是看不出来的（实测 M573 就是这么溜过去的）。
   * 下限取的是**当前实测条数**：加降级随便，减到下限以下就红。
   */
  const MIN_GATE_MARKERS: Readonly<Record<string, number>> = {
    'clawbot-settings.tsx': 7,
    'Contacts.tsx': 3,
    'kb-files-panel.tsx': 3,
    'Annual.tsx': 2,
    'clawbot-chat.tsx': 2,
    'clawbot-rail.tsx': 2,
    'moments-panel.tsx': 2,
    'NoticeBanner.tsx': 2,
    'PrivacyTrust.tsx': 2,
    'settings-sections.tsx': 2,
  }

  it('③ 多动作文件的降级条数不低于登记的下限', (): void => {
    const dir = join(WD, 'panels')
    const thin: string[] = []
    for (const [file, floor] of Object.entries(MIN_GATE_MARKERS)) {
      const code = readFileSync(join(dir, file), 'utf8')
      const n = (code.match(/desktopActionProps\(\)|desktopOnlyGate\('|!desktopAction\(\)|runtimeCapabilities\(\)\.[a-zA-Z]+/g) ?? []).length
      if (n < floor) thin.push(`${file}：登记下限 ${String(floor)}，实测 ${String(n)}`)
    }
    expect(thin).toEqual([])
    // 反例自证：下限不是恒真 —— 少一条就会被点名
    expect(Object.values(MIN_GATE_MARKERS).reduce((s, v) => s + v, 0)).toBeGreaterThan(20)
  })

  it('反例自证：把某个真实 api 改判成「仅桌面」，判据立刻把没降级的文件点名', (): void => {
    // `apiGetAssetInsights` 在收藏/表情统计里被调用，而那个文件没有任何降级写法 ——
    // 借它当靶子：假映射一喂进去，① 的判据必须立刻产出一条 naked（否则 ① 是恒真）。
    const fake = new Map(apiMethods)
    fake.set('apiGetAssetInsights', ['exportCsv'])
    const naked = auditPanelGating(fake).filter((r) => !r.gated && !r.covered)
    expect(naked.some((r) => r.file === 'AssetInsights.tsx'), JSON.stringify(naked.map((r) => r.file))).toBe(true)
  })
})
