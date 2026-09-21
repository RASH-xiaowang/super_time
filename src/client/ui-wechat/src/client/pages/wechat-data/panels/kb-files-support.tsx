/**
 * `KbFiles.tsx` 的「类型/常量/纯助手：首帧渲染缓存、解析状态徽标表、登记失败原因措辞、字节与相对时间格式化、高亮片段渲染」部分（M21 拆分）。
 *
 * 从原模块原样搬出，**行为逐字节不变**；原文件继续以 `export *` 转发
 * ⇒ 所有既有 import 一行都不用改。
 *
 * @module kb-files-support
 */

import {
  apiAddKbFiles, apiBuildKbVectorIndex, apiDeleteKbFile, apiGetKbFileChunks, apiGetKbFiles, apiGetKbVectorIndex,
  apiOpenFileDialog, apiSearchKb, apiSetKbFileRag, apiSummarizeKbFile,
  readRenderCache, writeRenderCache,
} from '../api.ts'
import type { KbFileChunk, KbFileMeta, KbFileParseState, KbFileRegisterResult, KbSearchResult, KbVectorIndexView } from '../types.ts'
import { KB_ACCEPTED_EXTS } from '../types.ts'
import { Badge, Button, Card, EmptyState, PanelHeader, SearchInput, Toolbar, useDebouncedValue } from '../ui/kit.tsx'
import { kbCacheKey, useKbScope } from './kb-scope.ts'
import css from './kbfiles.module.css'

/** 首帧渲染缓存：上次成功读到的那份文件列表（冷启动先出内容，再由请求结果校正）。 */
export interface KbFilesCache {
  items: KbFileMeta[]
  total: number
}

/**
 * 读渲染缓存。
 *
 * 键有两个约束，缺一不可：
 *   · 必须带库 id（`kbCacheKey`）—— 否则切库后的首帧画的是**上一个库**的文件列表：
 *     首帧是同步读缓存渲染的，真数据要等一次 RPC 才到，那一段空窗里用户看到的
 *     正是别的库的文件。拼法只有 `kbCacheKey` 一处，别在这里手写 `kb-files:` + id；
 *   · 必须与 `api.ts` 的 `invalidateKbFileCaches()` 用**同一个前缀** —— 上传 / 删除 /
 *     开关之后由它失效这一层，前缀不一致就会出现「列表刷新了、缓存还是旧的」。
 * @param kbId - 知识库 id。
 * @returns 上次成功渲染的那份列表缓存。
 */
export function cachedFiles(kbId: number): KbFilesCache | null {
  return readRenderCache<KbFilesCache>(kbCacheKey('kb-files', kbId))
}

/**
 * 向量索引状态 → 一句人话。
 *
 * 四种「只有关键词」必须分开说，因为**出路不一样**：
 *   · 没配向量模型 ⇒ 去「数据配置 → AI 大模型」；
 *   · 从没建过 ⇒ 点一下按钮就行（首次会出网）；
 *   · 换过嵌入模型 ⇒ 必须重算，而且会**再次出网**，不能混在「点一下就行」里；
 *   · 结构升级 ⇒ 同上。
 * 合成一句「未就绪」等于什么都没说（这条面板以前就吃过「读失败被显示成确实没有」的亏）。
 * @param view - `getKbVectorIndex` 的返回；`null` = 还没读到。
 * @returns 文案 + 色调。
 */
export function indexLabel(view: KbVectorIndexView | null): { text: string; tone: 'ok' | 'warn' | 'muted' } {
  if (view === null) return { text: '索引状态读取中…', tone: 'muted' }
  if (!view.configured) return { text: '未配置向量模型 · 只有关键词检索', tone: 'muted' }
  const s = view.status
  if (s.ready) return { text: `语义索引 ${s.rows.toLocaleString('zh-CN')} 块 · ${s.model}`, tone: 'ok' }
  if (s.staleReason === 'no-index') return { text: '还没有语义索引', tone: 'warn' }
  if (s.staleReason === 'model-mismatch') {
    return { text: `索引由 ${s.models[0] || '未知模型'} 生成、本库现在用 ${view.model} · 需重建`, tone: 'warn' }
  }
  return { text: '语义索引不可用 · 需重建', tone: 'warn' }
}

/** Badge 支持的色调（与 kit.tsx 的 Tone 一致；那份类型没有 export，这里就地声明）。 */
export type BadgeTone = 'default' | 'cyan' | 'green' | 'red' | 'amber' | 'purple' | 'blue'

/** 一个解析状态在界面上的三层表达：徽标文案 / 色调 / 「这意味着什么」。 */
export interface ParseLook {
  label: string
  tone: BadgeTone
  /** 人话解释。**绝不写「文件损坏」** —— 见文件头注 ②。 */
  hint: string
  /** 是否需要用户注意（解析失败 / 本机不支持），用于状态筛选的「需注意」档。 */
  attention: boolean
  /** 是否仍在处理中（后端队列会推进它；进程被强关时，重启会把 `parsing` 打回 `queued` 再续跑）。 */
  pending: boolean
}

/**
 * 解析状态 → 界面表达。八个状态一个都不能合并进另一档：
 *   · `unsupported` 与 `failed` 合并 = 把「等升级」说成「换文件」；
 *   · `sparse_only` 并进 `failed` = 把一个**仍能被关键词搜到**的文件说成坏的；
 *   · 三个中间态（`parsing` / `chunking` / `embedding`）对用户是同一件事（在跑），
 *     所以文案分开、色调一致，不额外做进度条 —— 后端没有可读的进度信号，
 *     画一根假的进度条比不画更糟。
 */
export const PARSE_LOOK: Record<KbFileParseState, ParseLook> = {
  queued: { label: '排队中', tone: 'cyan', hint: '已排队，等待解析。', attention: false, pending: true },
  parsing: { label: '解析中', tone: 'cyan', hint: '正在解析正文…', attention: false, pending: true },
  chunking: { label: '分块中', tone: 'cyan', hint: '正在把正文切成检索用的文本块…', attention: false, pending: true },
  embedding: { label: '向量化中', tone: 'cyan', hint: '正在生成向量（这一步会把文本块发到模型服务）。', attention: false, pending: true },
  ready: { label: '已就绪', tone: 'green', hint: '正文已解析入库，可以被问答与关键词检索到。', attention: false, pending: false },
  sparse_only: {
    label: '仅关键词',
    tone: 'amber',
    // 这一档**不是失败态**：没有向量只影响语义检索，关键词检索照旧命中。
    hint: '正文已解析，但没有做成向量（没有可用的模型 Key、断网、或「禁止 AI 出网」被打开）。这类文件仍能被关键词搜到。',
    attention: false,
    pending: false,
  },
  unsupported: {
    label: '未解析',
    tone: 'amber',
    // 接入 B 档（PDF / Word / Excel）之后，这一档的成因**不再只有一种**：图片类是「本机
    // 不做 OCR」、扫描件 PDF 是「里面没有文字」、空工作簿是「没有数据」、组件缺失是
    // 「这台机器没装解析组件」。所以这里不写任何一种具体原因 —— 真正的原因由后端写在
    // `parseError` 里，在下面那句「说明」中展示（只有它知道是哪一种）。
    // 曾经这里写的是「本机没有解析器，等解析器接入」：那会让一个扫描件用户
    // 一直等一个**本期明确不做**的功能。
    hint: '正文没能进库，所以这个文件现在只能按文件名搜到（搜内容搜不到）。具体原因见下面的「说明」。这不是失败 —— 文件本身没有被改动。',
    attention: true,
    pending: false,
  },
  failed: {
    label: '解析失败',
    tone: 'red',
    hint: '解析器读这个文件时出错了，所以它现在搜不到内容。可以删掉后换一个文件再试。',
    attention: true,
    pending: false,
  },
}

/** 解析进行中时的轮询间隔：对本地库的一次查询很轻，也够让状态变化看起来是即时的。 */
export const PARSE_POLL_MS = 1500
/**
 * 就地展开时一次读多少个正文块。
 *
 * 后端上限是 200（`MAX_CHUNK_PAGE`），这里取 60：一屏读得完、首屏不至于卡，
 * 剩下的靠「继续加载」往后接。单文件上限是两万块，所以**必须**分页 ——
 * 一次全取会把几十万字塞进 DOM，面板当场失去响应。
 */
export const CHUNK_PAGE = 60

/**
 * 这一块的章节标题要不要显示。
 *
 * 长段被硬切时后端给的是 `父 › 本段（续 N）`，母题为空时就只剩一个光秃秃的 `（续 2）`。
 * 带母题的那种要留（它告诉你这是哪一节被切断了），只有裸标记没有信息量 ——
 * 与后端 `entities.ts:normalizeHeading` 同一判断，这里只到「够不够格当标题」这一层。
 * @param heading - 块的原始 heading（可为空串）。
 * @returns 要不要渲染这一行元信息。
 */
export function headingWorthShowing(heading: string): boolean {
  if (heading === '') return false
  return !/^（续\s*\d+）$/.test(heading.trim())
}

/**
 * 轮询的总时长上限。到点停下（用户仍可点「刷新」手动续上）。
 *
 * 为什么不「一直轮到没有 pending 为止」：执行器和界面不在同一个生命周期里 ——
 * 进程被强关时，停在 `parsing` 的那一行不会再有谁去推进它，于是「一直轮询」就退化成
 * 一个永不停止的定时器。两分钟足够覆盖本机上限（32MB）文件的解析，
 * 又短到不会让一个坏掉的定时器悄悄跑一整晚。
 */
export const PARSE_POLL_MAX_MS = 120_000

/** 登记失败原因（`code`）→ 一句人话。`code` 可判定，因此界面按分支说话而不是猜文案。 */
export const REGISTER_REASON: Record<NonNullable<KbFileRegisterResult['code']>, string> = {
  'bad-kb': '知识库不存在',
  'bad-path': '路径读不到',
  'not-accepted': '这个类型暂不支持',
  'too-large': '文件超过大小上限',
  'too-many': '一次添加的文件太多',
  duplicate: '内容与库里已有的文件相同',
  'read-failed': '读取文件失败',
  'store-failed': '写入知识库失败',
}

/**
 * 把登记失败翻译成一句人话。
 *
 * `duplicate` 单独处理：去重按**内容指纹**（sha256）而不是文件名，所以文案要说
 * 「内容与…相同」——说成「文件名重复」会把「同名不同内容」和「改名重传」都指错。
 * @param r - 单个文件的登记结果。
 * @returns 一句给用户看的原因。
 */
export function reasonText(r: KbFileRegisterResult): string {
  if (r.code === 'duplicate') {
    const name = r.duplicateOf?.name
    return name ? `内容与库里已有的「${name}」相同` : '内容与库里已有的某个文件相同'
  }
  if (r.code === 'not-accepted') return `类型不支持（支持 ${KB_ACCEPTED_EXTS.length} 种扩展名）`
  if (r.code) return REGISTER_REASON[r.code]
  return r.error?.trim() || '未能加入'
}

/**
 * 把字节数格式化成人看的单位。
 *
 * 就地声明而不是放进 `kb-model.ts`：那里是**笔记正文**的纯函数集（分块 / 分标签 /
 * 链接解析），文件大小是这一屏独有的展示需求，混进去会让那个模块的名字越来越不成立。
 * @param n - 字节数（负数 / 非有限值一律显示 0 B）。
 * @returns 如 `1.4 MB`。
 */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let v = n
  let i = 0
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1 }
  // 小数点后位数跟着量级走：`1.4 MB` 有意义，`768.0 B` 没有。
  return `${i === 0 ? Math.round(v) : v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`
}

/**
 * 从绝对路径取文件名（跨平台）。
 *
 * 不能用 `path.basename`：渲染进程里没有 node 的 `path`（`nodeIntegration` 关闭），
 * 而且后端返回的 `srcPath` 一定是 Windows 路径，`/` 也要一并处理。
 * @param p - 绝对路径。
 * @returns 文件名；路径为空时返回空串。
 */
export function baseName(p: string): string {
  const s = p.trim()
  if (s === '') return ''
  const cut = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'))
  return cut >= 0 ? s.slice(cut + 1) : s
}

/**
 * 摘要里的命中词高亮。
 *
 * 区间是**后端算好的、偏移相对这段摘要**（`marks`），这里只按区间渲染、
 * **不再找一遍词**：前端自己再找会出现「后端按 bigram 命中、前端按字面找」的错位，
 * 用户看到的就是「搜到了，但一个词都没高亮」。
 *
 * 用游标推进而不是逐个区间 `slice` 拼接：多词查询时两个词的区间可能相邻或重叠
 * （「甲乙」与「乙丙」同时命中），各切各的会让重叠处少字。
 * @param props.text - 摘要原文。
 * @param props.marks - 相对摘要的高亮区间（后端给的顺序即升序）。
 * @returns 带 `<mark>` 的片段。
 */
export function SnippetText({ text, marks }: { text: string; marks: ReadonlyArray<{ start: number; end: number }> }): React.JSX.Element {
  if (marks.length === 0) return <>{text}</>
  const nodes: React.ReactNode[] = []
  let at = 0
  marks.forEach((m, i) => {
    const s = Math.max(m.start, at)
    const e = Math.max(m.end, s)
    if (s > at) nodes.push(text.slice(at, s))
    if (e > s) nodes.push(<mark className={css.hitMark} key={`mk-${i}`}>{text.slice(s, e)}</mark>)
    at = e
  })
  if (at < text.length) nodes.push(text.slice(at))
  return <>{nodes}</>
}

/** 状态筛选档。`attention` 只收「解析失败 / 未解析」，不含 `sparse_only`（它不是问题）。 */
export type StateFilter = 'all' | 'pending' | 'attention' | 'ready'

export const FILTERS: ReadonlyArray<{ key: StateFilter; label: string }> = [
  { key: 'all', label: '全部' },
  { key: 'ready', label: '已就绪' },
  { key: 'attention', label: '需注意' },
  { key: 'pending', label: '处理中' },
]

/** 一次「添加文件」的回执（部分成功是常态，所以失败项逐条留下）。 */
export interface AddReport {
  added: number
  failed: number
  failures: ReadonlyArray<{ name: string; reason: string }>
}
