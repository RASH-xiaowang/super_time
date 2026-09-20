/**
 * 推断层的**界面接线**守卫（`docs/KB-MODEL-CONFIG.md` P4 / V6）。
 *
 * 本仓库没有 DOM/React 测试环境（vitest 只跑纯逻辑模块），而这一层最容易退化的恰恰是
 * 四处**看不见的接线**：
 *   ① 按钮没接到 Remote（或接错库）—— 点了没反应，页面不报错；
 *   ② 建议改成「随打字自动触发」—— 同一句话会被发出去几十次，而这在界面上完全正常；
 *   ③ 插入用了字符串拼接而不是光标位置 —— 用户停在句中，链接被扔到文末；
 *   ④ 抽完实体没清知识缓存 —— 后端明明写进了 `kb_doc_entities`，图谱上却一个点都不多，
 *      用户只能重开面板，而他会以为「抽取失败」。第 ④ 条与 P2 那次「改完设置芯片数字不动」
 *      是同一类事故，只是这次藏在跨面板的那一层。
 * @vitest-environment node
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))

function findRoot(start: string): string {
  let d = start
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(d, 'main.js')) && existsSync(join(d, 'package.json'))) return d
    const p = dirname(d)
    if (p === d) break
    d = p
  }
  throw new Error('找不到仓库根')
}
const ROOT = findRoot(HERE)
const SHELL_DIR = join(ROOT, 'src', 'client', 'ui-wechat', 'src', 'client', 'pages', 'wechat-data')

const dialog = readFileSync(join(HERE, 'KbModelDialog.tsx'), 'utf8')
const editor = readFileSync(join(HERE, 'KnowledgeNoteEditor.tsx'), 'utf8')
const apiSrc = readFileSync(join(SHELL_DIR, 'api.ts'), 'utf8')
const dialogCss = readFileSync(join(HERE, 'kb-model-dialog.module.css'), 'utf8')
const editorCss = readFileSync(join(HERE, 'note-editor.module.css'), 'utf8')

/** 去注释：守卫只能被代码满足，在注释里写一句「已接」不算。 */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').split(/\r?\n/).map(l => l.replace(/\/\/.*$/, '')).join('\n')
}

describe('本库模型弹层：抽取实体那一行', () => {
  const d = code(dialog)

  it('按钮接的是 apiExtractKbEntities，且跑完重读一次进度', () => {
    expect(d).toContain('apiExtractKbEntities')
    expect(d).toMatch(/const extract = useCallback/)
    expect(d).toMatch(/await apiExtractKbEntities\(kbId\)/)
    // 抽完不 load() 的话，那一行还停在「从未做过」，而操作其实成功了
    expect(d).toMatch(/setExtracting\(true\)[\s\S]{0,600}await load\(\)/)
  })

  it('没配语言模型时禁用并说明原因，而不是点了报一个红色异常', () => {
    expect(d).toMatch(/disabled=\{extracting \|\| cfg\.resolved\.chat\.model === ''\}/)
    expect(d).toContain('未配置语言模型：先在「数据配置 → AI 大模型」填写')
    // 「图谱仍会有文件与章节」这句必须在：否则用户会以为整层推断都关了，
    // 而章节那一层是本地确定性产物，与模型无关
    expect(d).toContain('那两类是本地算出来的')
  })

  it('代价写在按钮上：title 里说清「会出网」与「重跑覆盖上一次」', () => {
    const at = d.indexOf("'抽取实体'")
    expect(at, '按钮文案不见了').toBeGreaterThan(0)
    const around = d.slice(Math.max(0, at - 700), at + 200)
    expect(around, '抽取实体的按钮没写明会出网').toContain('会出网')
    expect(around).toContain('重跑会覆盖上一个结果')
  })

  it('进度说的是「还剩几个没抽」，不是「已抽几条」', () => {
    expect(d).toMatch(/个文件还没抽/)
    expect(d).toMatch(/从未做过/)
    // 抽取与重建两条长任务期间都不许关窗（否则进程还在跑、界面已经没了）
    expect(d).toMatch(/if \(!busy && !indexing && !extracting\)/)
  })

  it('进度那一行读的是缓存里可能缺失的 `entities` —— 必须兜底', () => {
    // `apiGetKbModelConfig` 命中缓存且远程失败时会**直接回吐上一份**，而那份可能是
    // P4 之前的形状（类型必填、运行期没有）。不兜就是弹层在读取失败那一帧整块崩掉。
    expect(d).toMatch(/const ent = cfg\.entities \?\? \{ ragFiles: 0, pending: 0, entities: 0, model: '' \}/)
    expect(d).not.toMatch(/cfg\.entities\.ragFiles/)
  })

  it('css.xxx 全部有定义（拼错类名不会报错，只会静默没样式）', () => {
    const defined = new Set<string>()
    for (const m of dialogCss.matchAll(/\.([A-Za-z_][\w-]*)/g)) if (m[1]) defined.add(m[1])
    const used = [...new Set([...d.matchAll(/\bcss\.([A-Za-z_$][\w$]*)/g)].map(m => m[1] as string))]
    expect(used.length).toBeGreaterThan(5)
    expect(used.filter(n => !defined.has(n)), `缺失：${used.filter(n => !defined.has(n)).join(', ')}`).toEqual([])
  })
})

describe('笔记编辑器：模型建议的链接芯片', () => {
  const e = code(editor)

  it('要**点一下**才出网：没有随打字触发的自动请求', () => {
    expect(e).toContain('apiSuggestKbLinks')
    // useEffect 里出现建议请求 = 每次重渲染都可能发一次；本文件仅有的 useEffect 是打开时重置表单
    const effects = [...e.matchAll(/useEffect\(\(\) => \{([\s\S]*?)\n  \}, \[/g)].map(m => m[1] ?? '')
    expect(effects.length).toBeGreaterThan(0)
    for (const body of effects) expect(body).not.toContain('apiSuggestKbLinks')
    expect(e).toMatch(/onClick=\{\(\) => \{ void ask\(\) \}\}/)
  })

  it('插入用的是 textarea 的光标位置，而不是拼到末尾', () => {
    expect(e).toContain('bodyRef')
    expect(e).toMatch(/selectionStart/)
    expect(e).toMatch(/body\.slice\(0, start\) \+ snippet \+ body\.slice\(end\)/)
    // 插完必须把焦点还给正文并放到插入内容之后：否则用户要再用鼠标点回去
    expect(e).toMatch(/el\?\.focus\(\)/)
    expect(e).toMatch(/setSelectionRange\(start \+ snippet\.length, start \+ snippet\.length\)/)
  })

  it('点芯片是唯一写正文的途径；已连过的目标不再出现在芯片上', () => {
    expect(e).toMatch(/onClick=\{\(\) => \{ insertLink\(c\.label\) \}\}/)
    expect(e).toMatch(/filter\(c => !linkedKeys\.has\(c\.label\.trim\(\)\.toLowerCase\(\)\)\)/)
    // 除 insertLink 之外，编辑器里不许有任何由建议驱动的 setBody
    const fromAsk = e.slice(e.indexOf('const ask ='))
    expect(fromAsk.slice(0, fromAsk.indexOf('const insertLink')), '建议返回后被自动写进正文了').not.toContain('setBody')
  })

  it('每次打开都清掉上一篇的建议（那是另一段正文的近邻）', () => {
    expect(e).toMatch(/setSug\(null\)/)
    const reset = e.slice(e.indexOf('useEffect(() => {'), e.indexOf('const links ='))
    expect(reset, '重置发生在打开之外，切库/改名时会残留').toContain('setSug(null)')
  })

  it('芯片的类名都有定义，且 disabled 判据包含「正文太短」', () => {
    const defined = new Set<string>()
    for (const m of editorCss.matchAll(/\.([A-Za-z_][\w-]*)/g)) if (m[1]) defined.add(m[1])
    const used = [...new Set([...e.matchAll(/\bcss\.([A-Za-z_$][\w$]*)/g)].map(m => m[1] as string))]
    for (const c of ['suggest', 'suggestBtn', 'suggestMeta', 'chip']) expect(used, `少了 ${c}`).toContain(c)
    expect(used.filter(n => !defined.has(n))).toEqual([])
    expect(e).toMatch(/disabled=\{asking \|\| body\.trim\(\)\.length < 8\}/)
  })
})

describe('api 层：两个新入口的缓存口径', () => {
  const a = code(apiSrc)

  it('抽取实体失效「弹层进度 + 知识数据」两层，并且只在真有新东西时广播', () => {
    const fn = a.slice(a.indexOf('export async function apiExtractKbEntities'), a.indexOf('export async function apiSuggestKbLinks'))
    expect(fn).toContain("invalidateWechatCache(kbCacheKey('kb-model', kbId))")
    expect(fn).toMatch(/if \(result\.saved > 0\) invalidateKnowledgeCaches\(\)/)
    // 只许出现一次：一行实体都没抽到时也广播，会让三个面板白重取一次数（P2 的同类事故）
    expect((fn.match(/invalidateKnowledgeCaches\(\)/g) ?? []).length).toBe(1)
  })

  it('链接建议**不缓存**（缓存会把上一次的主题留在屏幕上）', () => {
    const fn = a.slice(a.indexOf('export async function apiSuggestKbLinks'), a.indexOf('export async function apiSuggestKbLinks') + 600)
    expect(fn).toContain('remote().suggestKbLinks(')
    expect(fn).not.toContain('cachedFetch')
    expect(fn).not.toContain('cachedGet')
  })

  it('两个方法都在 Remote 接口面上（漏了运行期就是 undefined is not a function）', () => {
    expect(a).toMatch(/extractKbEntities\(options: \{ kbId: number; fileIds\?: number\[\]; limit\?: number \}\)/)
    expect(a).toMatch(/suggestKbLinks\(options: \{ kbId: number; text\?: string; topK\?: number; excludeTitle\?: string \}\)/)
  })
})
