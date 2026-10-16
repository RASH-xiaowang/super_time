
/**
 * 设置面板的**状态与副作用**（M21 第三十一刀自 Settings.tsx 拆出）。
 *
 * 面板原来 1000 多行里有一大半是 state / effect / 回调；真正属于「界面」的只有 return 里那棵 JSX。
 * 这里把逻辑区整体搬进来（含全部 useEffect / useCallback / 派生计算），面板侧改成
 * `const { … } = useSettingsState({ inDialog, initialSection, onNavigateOut })` + 原样 JSX ——
 * **JSX 一行未改**，所以渲染结果与副作用时机都和从前一致。
 * 为什么用钩子而不是「状态容器组件」：这些状态要跨「左导航 / 各卡片 / 底部保存条」共享，
 * 拆组件就得把几十个状态提成道具；钩子只是换个文件放，状态仍然只有一份。
*/
import { apiAutoGetDbKey, apiAutoGetImageKey, apiCancelWhisperDownload, apiDecryptAllDatabases, apiDecryptAllImages, apiDetectWechatAccounts, apiCopyDiagLogPath, apiDiagLogInfo, apiPreviewDiagLog, apiDownloadWhisperModel, apiExportDiagLog, apiGenerateKeysFile, apiGetDecryptStatus, apiGetWechatConfigFull, apiGetWechatKeysInfo, apiGetWechatPathConfig, apiGetWhisperStatus, apiInstallWhisperEngine, apiRevealDiagLog, apiSaveWechatConfig, apiFetchOriginalImagesBatch, apiPlanOriginalFetch, apiTranscribeVoiceBatch, apiUpgradeDecodedImages, apiVerifyDatabaseKey, apiVerifyImageKey, pickDirectory, readRenderCache, writeRenderCache } from '../api.ts'
import { forgetAllImages } from '../image-cache.ts'
import { fmtBytes } from '../utils/format.ts'
import { useTransientNotice } from './hooks.tsx'
import { PollRegistry, createPollRegistry } from './poll-registry.ts'
import { CachedSettingsConfig, cacheableConfig, Notice, runWhenIdle, SETTINGS_CONFIG_CACHE_KEY, SETTINGS_SCAN_TTL_MS, SETTINGS_SECRET_FIELDS, StepState, STEP_ICONS, STEPS } from './settings-common.tsx'
import { IconPersonalizationOutline16, IconRefreshOutline14, IconSettingsOutline14, IconSparkle16 } from '@deepseek-ai/dsh-client-ui-primitives'
import { ImageUpgradeResult, OriginalBatchResult, OriginalFetchPlan, WechatAccount, WechatConfigFull, WhisperStatus } from '@deepseek-ai/dsh-wechat-data/types'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

/** SSR 下退化成 useEffect，客户端仍保留首帧落位的 layout 时序。 */
const useIsomorphicLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect

/** 面板的入参（与 SettingsPanelProps 同形，这里单列以免与面板互相 import）。 */
export interface SettingsStateOptions {
  inDialog?: boolean
  initialSection?: string
  onNavigateOut?: (tab: string) => void
}

// M21：面板与状态钩子共用的「短时缓存」（同样的查询不该在两侧各打一次）。
let detectCache: { at: number; accounts: readonly WechatAccount[]; info: { version?: string; install_dir?: string }; total: number } | null = null
let whisperStatusCache: { at: number; status: WhisperStatus } | null = null

/** 下载进度的形状（`whisperDownloading` 的值类型，模块级复用三处）。 */
type WhisperProgress = { model: string; file: string; received: number; total: number }

/**
 * 每 500ms 拉一次后端状态，把下载进度同步到面板（W3-5.5）。
 *
 * 为什么模块级：模型与引擎两路的轮询代码一字不差，抽出来才有一处可改的地方；
 * 也让 hook 的行数预算不被这段与状态无关的样板吃掉。
 * @param set - `setWhisperDownloading`。
 * @returns 停掉轮询的函数（调用方在 finally 里调）。
 */
/**
 * 「远程访问（手机）」这一节的导航条目。
 *
 * 放在**模块级**而不是 `useSettingsState` 里面：那个 hook 已经在函数行数棘轮上
 * （只许变小），而这一条是纯静态数据（图标是常量 SVG、文案不依赖任何状态），
 * 没有理由占 hook 的行数。
 *
 * 排在「数据边界与出网」之后：两者是同一类问题（我的数据会不会被这台机器之外的东西读到），
 * 只是方向相反 —— 前者管**出站**，这一节管**入站**。
 */
const NAV_REMOTE = {
  key: 'remote' as const,
  group: '智能与隐私',
  label: '远程访问（手机）',
  icon: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="7" y="2.5" width="10" height="19" rx="2" /><path d="M11 18.5h2" />
    </svg>
  ),
  value: '局域网链接 · 令牌（默认关闭）',
}

type SettingsNavKey = (typeof STEPS)[number]['key']
  | 'ai' | 'boundary' | 'remote' | 'license' | 'update' | 'backup' | 'health' | 'hook' | 'advanced'
type SettingsNavItem = { key: SettingsNavKey; group: string; label: string; icon: React.ReactNode; value: string; dot?: 'done' | 'warning' | 'ongoing' }

function createSettingsNavItems(
  stepStates: Record<(typeof STEPS)[number]['key'], StepState>,
  stepValueOf: (key: (typeof STEPS)[number]['key']) => string,
): SettingsNavItem[] {
  return [
    ...STEPS.map((s) => ({
      key: s.key,
      group: '配置向导',
      label: s.label,
      icon: STEP_ICONS[s.key],
      value: stepValueOf(s.key),
      dot: (stepStates[s.key] === 'done' ? 'done' : stepStates[s.key] === 'note' ? 'warning' : 'ongoing') as SettingsNavItem['dot'],
    })),
    { key: 'ai', group: '智能与隐私', label: 'AI 大模型', icon: <IconSparkle16 size={14} />, value: '问答模型与向量模型' },
    { key: 'boundary', group: '智能与隐私', label: '数据边界与出网', icon: STEP_ICONS.boundary, value: '本地/出网边界 · 审计' },
    NAV_REMOTE,
    { key: 'license', group: '授权与更新', label: '软件授权', icon: <IconPersonalizationOutline16 size={14} />, value: '许可证状态' },
    { key: 'update', group: '授权与更新', label: '软件更新', icon: <IconRefreshOutline14 size={14} />, value: '自动更新 · 手动检查' },
    { key: 'backup', group: '维护与自检', label: '备份恢复', icon: STEP_ICONS.backup, value: '本地快照 · 创建/恢复' },
    { key: 'health', group: '维护与自检', label: '数据库健康', icon: STEP_ICONS.health, value: '占用与完整性检查' },
    { key: 'hook', group: '维护与自检', label: '原图链路自检', icon: STEP_ICONS.hook, value: '本地解码自检' },
    { key: 'advanced', group: '高级', label: '高级设置', icon: <IconSettingsOutline14 size={14} />, value: '输出目录 · 启动引导' },
  ]
}

function pollWhisperDownload(set: (v: WhisperProgress | null) => void, polls: () => PollRegistry): () => void {
  return polls().start(() => {
    void apiGetWhisperStatus()
      .then((s) => { if (s.downloading) set({ model: s.downloading.model, file: s.downloading.file, received: s.downloading.received, total: s.downloading.total }) })
      .catch(() => { /* 忽略单次轮询失败 */ })
  }, 500)
}

/**
 * 造出「停止下载」的处理器（W3-5.5）。
 *
 * 为什么要有这个按钮：模型 1.5–3.1 GB，点错模型就是十几分钟的等待，而这期间
 * 用户唯一能做的就是等（或强杀进程）。已下载部分保留为 `.part`，下次续传仍有效 ——
 * 所以取消是无损的，不应该让人不敢点。
 * @param getJobId - 读当前下载标识（空串 = 没有下载在跑，此时点击是静默的）。
 * @param setMsg - 面板消息槽。
 * @returns 可直接绑到按钮上的处理器。
 */
function whisperDownloadCanceller(getJobId: () => string, setMsg: (m: { kind: 'ok' | 'err'; text: string } | null) => void): () => Promise<void> {
  return async () => {
    const jobId = getJobId()
    if (!jobId) return
    try {
      const r = await apiCancelWhisperDownload({ jobId })
      setMsg(r.ok
        ? { kind: 'ok', text: '✓ 已请求停止（当前这一块下完就停，已下载的部分保留，下次可续传）' }
        : { kind: 'err', text: '✗ ' + (r.message ?? '取消失败') })
    } catch (e) {
      setMsg({ kind: 'err', text: '✗ ' + (e as Error).message })
    }
  }
}

/** 取消不是失败：后端用「已取消」措辞回，界面就不该把它画成红色错误（W3-5.5）。 */
function isCanceled(text: string | undefined): boolean {
  return (text ?? '').includes('已取消')
}
/** 诊断日志预览的形状（W2-12.4）。 */
export interface DiagPreview {
  text: string
  /** 整份报告的真实字符数（可能大于 `text.length`，那是截断造成的）。 */
  chars: number
  truncated: boolean
  files: string[]
}

/**
 * 诊断日志的脱敏预览 + 复制路径（W2-12.4）。
 *
 * 导出之前先给用户看一眼将要交付的那份文件：`redact` 只保证密钥一类被换掉，
 * 但「有没有别的敏感内容」（聊天内容、路径、用户名）是**用户自己**才有资格判断的事。
 *
 * 模块级 hook：`useSettingsState` 已经八百多行，这一摊（状态 + 三个动作）
 * 塞进去只会让它更长，而且这一摊与其它设置项没有任何耦合。
 * @param notify - 本面板唯一的提示入口。
 * @returns 预览内容与三个动作。
 */
function useDiagPreview(notify: (kind: 'ok' | 'err', text: string) => void): {
  diagPreview: DiagPreview | null
  previewDiagLog: () => Promise<void>
  closeDiagPreview: () => void
  copyDiagLogPath: () => Promise<void>
} {
  const [diagPreview, setDiagPreview] = useState<DiagPreview | null>(null)
  const previewDiagLog = useCallback(async (): Promise<void> => {
    const r = await apiPreviewDiagLog()
    if (!r.ok) { notify('err', '读取诊断日志预览失败：' + (r.error ?? '未知原因')); return }
    setDiagPreview({ text: r.text ?? ' ', chars: r.chars ?? 0, truncated: r.truncated === true, files: r.files ?? [] })
  }, [notify])
  const closeDiagPreview = useCallback((): void => { setDiagPreview(null) }, [])
  const copyDiagLogPath = useCallback(async (): Promise<void> => {
    const r = await apiCopyDiagLogPath()
    if (!r.ok) { notify('err', '复制日志路径失败：' + (r.error ?? '未知原因')); return }
    notify('ok', '日志路径已复制到剪贴板')
  }, [notify])
  return { diagPreview, previewDiagLog, closeDiagPreview, copyDiagLogPath }
}

/**
 * M1 密钥搬家提示的确认动作（W2-12.3）。**模块级**：它只是「调一次保存接口再重取」，
 * 不依赖任何 hook 状态 —— 放进 `useSettingsState` 只会让那个八百多行的函数更长。
 *
 * 写失败要说话，且**不**在本地先把提示藏起来：用户以为关掉了、刷新一下又回来，
 * 比不提示更烦。
 * @param load - 重新取配置的回调（确认位写回成功后才调）。
 * @param report - 失败时给用户的一句话。
 * @returns 是否写成功。
 */
async function writeSecretMigrationAck(load: () => Promise<void>, report: (text: string) => void): Promise<boolean> {
  try {
    const r = await apiSaveWechatConfig({ patch: { secret_migration_notice_ack: true } })
    if (!r.ok) { report('提示关不掉：' + (r.error ?? '未知原因')); return false }
    await load()
    return true
  } catch (e) {
    report('提示关不掉：' + (e as Error).message)
    return false
  }
}

export function useSettingsState({ inDialog = false, initialSection, onNavigateOut }: SettingsStateOptions = {}) {
  const cachedCfg = readRenderCache<CachedSettingsConfig>(SETTINGS_CONFIG_CACHE_KEY)
  const [cfg, setCfg] = useState<CachedSettingsConfig | WechatConfigFull | null>(cachedCfg)
  // M15：面板内所有轮询都登记在这里，**卸载时统一清掉**。
  // 原实现把 interval 建在 async 处置函数里、只在 finally 清 —— 下载/转写要跑几分钟，
  // 用户中途切走面板时它会一直每 400~500ms 打 IPC，并在已卸载的组件上 setState。
  const pollsRef = useRef<PollRegistry | null>(null)
  const polls = (): PollRegistry => pollsRef.current ?? (pollsRef.current = createPollRegistry())
  useEffect(() => () => { pollsRef.current?.stopAll() }, [])
  const [cfgLoading, setCfgLoading] = useState(false)
  const [keysInfo, setKeysInfo] = useState<{ keyFormat?: string; keyCount: number; loaded: boolean }>({ keyCount: 0, loaded: false })
  const [accounts, setAccounts] = useState<readonly WechatAccount[]>([])
  const [detectInfo, setDetectInfo] = useState<{ version?: string; install_dir?: string }>({})
  const [detecting, setDetecting] = useState(false)
  const [detectMsg, setDetectMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  const [dbDir, setDbDir] = useState(cachedCfg?.db_dir ?? '')
  // 密钥字段不从渲染缓存预填（缓存里不该有它们，见 SETTINGS_SECRET_FIELDS）：
  // 未加载完时保持空值，而后端会把「空串/默认值」当成「没给」而不是「要清空」。
  const [dbKey, setDbKey] = useState('')
  const [imgAes, setImgAes] = useState('')
  const [imgXor, setImgXor] = useState('136')
  // 富提示（kind/details + 关闭按钮）也迁到公共控制器（L20 的最后一处手写版）。
  // 改前是 `setMessage(x); setTimeout(() => setMessage(null), N)` —— 句柄丢了，
  // 「连出两条提示时第一条的定时器把第二条提前清掉」与「卸载后仍写 state」两个已知缺陷都在。
  const { notice: message, flash, clear } = useTransientNotice<Notice>(5000)
  const [saving, setSaving] = useState(false)
  const [saveMsg, setSaveMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  const [pathConfigPath, setPathConfigPath] = useState('')
  const [dbGetting, setDbGetting] = useState(false)
  const [imgGetting, setImgGetting] = useState(false)
  const [dbOpMsg, setDbOpMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  const [imgOpMsg, setImgOpMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  const [decrypting, setDecrypting] = useState(false)
  const [dbProgress, setDbProgress] = useState<{ active: boolean; done: number; total: number; failed: number; message: string }>({ active: false, done: 0, total: 0, failed: 0, message: '' })
  const [imgDecrypting, setImgDecrypting] = useState(false)
  const [imgProgress, setImgProgress] = useState<{ active: boolean; done: number; total: number; failed: number; skipped: number; message: string }>({ active: false, done: 0, total: 0, failed: 0, skipped: 0, message: '' })
  const [imgDetailOpen, setImgDetailOpen] = useState(false)
  const [imgDecryptDetail, setImgDecryptDetail] = useState<{ errors: Array<{ file: string; error: string }>; skippedDetails: Array<{ file: string; reason: string }> }>({ errors: [], skippedDetails: [] })
  const [imgConcurrency, setImgConcurrency] = useState(8)
  const [imgUpgrading, setImgUpgrading] = useState(false)
  const [imgUpgradeProgress, setImgUpgradeProgress] = useState<{ active: boolean; done: number; total: number; message: string }>({ active: false, done: 0, total: 0, message: '' })
  const [imgUpgradeResult, setImgUpgradeResult] = useState<ImageUpgradeResult | null>(null)
  /**
   * 详情弹窗的标题。解密与升级共用同一个弹窗（`imgDecryptDetail` 的形状本来就一样），
   * 但「跳过原因」在两条路径上说的不是一件事 —— 标题必须跟着变，否则用户会以为自己点错了。
   */
  const [imgDetailTitle, setImgDetailTitle] = useState('图片解密详情')
  /**
   * 「联网补齐原图」的四个状态。
   *
   * `origPlan` 是**先扫描再取回**的那份盘点：用户问得出「为什么这张没有原图」，而答案分三类
   * （本机已有 / 可联网取 / 只有微信登录态才拿得到）。不给这个数，界面上只能给一句「取不到」。
   */
  const [origPlan, setOrigPlan] = useState<OriginalFetchPlan | null>(null)
  const [origBusy, setOrigBusy] = useState<'scan' | 'fetch' | null>(null)
  const [origProgress, setOrigProgress] = useState<{ active: boolean; done: number; total: number; failed: number; message: string }>({ active: false, done: 0, total: 0, failed: 0, message: '' })
  const [origResult, setOrigResult] = useState<OriginalBatchResult | null>(null)
  /** 本次最多取几张（0 = 不限）。默认 500：全量是几千张、可能几 GB，先取一批是稳妥的默认。 */
  const [origLimit, setOrigLimit] = useState(500)
  const [dbDirMsg, setDbDirMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  const [voiceOpMsg, setVoiceOpMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  const [whisperDirMsg, setWhisperDirMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  const [whisperDevice, setWhisperDevice] = useState<'cpu' | 'gpu'>(cachedCfg?.whisper_device ?? 'cpu')
  const [whisperModel, setWhisperModel] = useState(cachedCfg?.whisper_model ?? 'medium')
  const [whisperThreads, setWhisperThreads] = useState(cachedCfg?.whisper_threads ?? 0)
  const [whisperModelsDir, setWhisperModelsDir] = useState(cachedCfg?.whisper_models_dir ?? '')
  const [whisperStatus, setWhisperStatus] = useState<WhisperStatus | null>(null)
  const [whisperStatusLoading, setWhisperStatusLoading] = useState(false)
  const [whisperDownloading, setWhisperDownloading] = useState<{
    model: string
    file: string
    received: number
    total: number
  } | null>(null)
  /** W3-5.5：本次下载的标识。按钮读取与 API 调用都必须拿到同一个值，
   * 因此不放进渲染 state：`setState` 的提交是异步的，闭包里读到的是旧值。 */
  const whisperJobId = useRef('')
  const whisperJobSeq = useRef(0)
  const [whisperTranscribing, setWhisperTranscribing] = useState<{ active: boolean; done: number; total: number; failed: number; skipped: number; current: string }>({ active: false, done: 0, total: 0, failed: 0, skipped: 0, current: '' })
  /**
   * 左侧导航当前选中项。
   *
   * 语义已从「右侧只渲染这一节」改成**目录高亮**：15 节全部堆叠在同一个滚动区里连续滚动
   * （滚到一节末尾自然接下一节），这里只表示「现在看的是哪一节」，由滚动位置反推。
   */
  const [activeKey, setActiveKey] = useState<string>(() => initialSection ?? 'detect')
  /** 右侧内容区：所有节共用的滚动容器。 */
  const paneRef = useRef<HTMLDivElement | null>(null)
  /** 程序化滚动期间（≤800ms）让滚动侦测让位，否则平滑滚动路过的一串中间节会把高亮带跑。 */
  const spyLockUntil = useRef(0)
  const spyRaf = useRef(0)

  /** 滚到某一节（左导航点击 / 弹窗内跳转 / 弹窗以某节打开时的落点）。 */
  const scrollToSection = useCallback((key: string, smooth: boolean): void => {
    const box = paneRef.current
    const el = box ? box.querySelector<HTMLElement>(`[data-settings-section="${key}"]`) : null
    if (!box || !el) return
    const top = Math.max(0, box.scrollTop + (el.getBoundingClientRect().top - box.getBoundingClientRect().top) - 12)
    // 顶部留 12px：贴死在容器上沿时，卡片自身边框看起来像被截断
    //
    // 近距离用平滑滚动（有方向感）；跨好几节的远距离直接跳 —— 整份文档高八千多像素，
    // 从第一节到「操作日志」的平滑动画实测 1.5 秒还没走完，点导航却要等着滚动是很拖沓的。
    const animate = smooth && Math.abs(top - box.scrollTop) <= box.clientHeight * 2
    // 落位期间锁住滚动侦测：一是平滑滚动路过的中间节会把高亮带跑，二是末尾几节顶不到
    // 容器上沿（下方内容不够高，滚动被夹住），不锁的话「点谁高亮谁」会被截断规则改掉。
    spyLockUntil.current = Date.now() + (animate ? 900 : 400)
    box.scrollTo({ top, behavior: animate ? 'smooth' : 'instant' })
  }, [])

  /** 左导航点击：切高亮 + 滚到那一节。 */
  const goToSection = useCallback((key: string): void => {
    setActiveKey(key)
    scrollToSection(key, true)
  }, [scrollToSection])

  /**
   * 内容区滚动 → 把左导航高亮切到「当前所在节」。
   * 程序化滚动进行中直接让位（见 `spyLockUntil`），其余按滚动位置反推。
   */
  const onPaneScroll = useCallback((): void => {
    if (spyRaf.current !== 0) return
    spyRaf.current = window.requestAnimationFrame(() => {
      spyRaf.current = 0
      if (Date.now() < spyLockUntil.current) return
      const box = paneRef.current
      if (!box) return
      const secs = Array.from(box.querySelectorAll<HTMLElement>('[data-settings-section]'))
      if (secs.length === 0) return
      // 触底时直接选最后一节：「某节顶端对齐容器顶端」对末尾几节做不到（下方内容不够高）
      if (box.scrollTop + box.clientHeight >= box.scrollHeight - 2) {
        const last = secs.at(-1)?.dataset.settingsSection
        if (last) setActiveKey((prev) => (prev === last ? prev : last))
        return
      }
      const boxTop = box.getBoundingClientRect().top
      // 判定线取容器上沿下方 24px：跨过它的最后一节就是当前节。用固定小偏移而不是
      // 「视口 1/4」这类大偏移，短节（如高级设置）才不会被整节跳过。
      let cur = secs[0]?.dataset.settingsSection ?? ''
      for (const el of secs) {
        if (el.getBoundingClientRect().top - boxTop <= 24) cur = el.dataset.settingsSection ?? cur
      }
      // 同值直接返回：本组件一渲染就是 15 节全部重渲，别让滚动白白触发整屏重渲
      setActiveKey((prev) => (prev === cur ? prev : cur))
    })
  }, [])

  useEffect(() => () => { if (spyRaf.current !== 0) window.cancelAnimationFrame(spyRaf.current) }, [])

  // 弹窗以某一节打开时（如从「数据边界与出网」入口进来），把那一节直接落到位。
  // 用 layout effect 落在首帧之前，避免打开时先闪一下第一屏再滚过去。
  //
  // 各节内容是异步加载的：落在首帧那一刻，上方几节往往还没长到最终高度，落点会被顶偏，
  // 所以内容继续沉降的这段时间里补正两次。用户一旦自己滚过，就再也不动他 —— 补正把他
  // 拽回原处比落点偏几像素糟糕得多。
  const userScrolled = useRef(false)
  useIsomorphicLayoutEffect(() => {
    if (!initialSection) return
    const land = (): void => { if (!userScrolled.current) scrollToSection(initialSection, false) }
    land()
    const t1 = window.setTimeout(land, 400)
    const t2 = window.setTimeout(land, 1100)
    return () => { window.clearTimeout(t1); window.clearTimeout(t2) }
  }, [])
  /**
   * 富提示写入（本面板唯一的 notify 入口）。
   *
   * 时长按改前原样保留两档：带 details（失败明细清单）12s、其余 5s。
   * 为什么用 `flash(value, ms)` 而不是给 hook 加一个新形态：控制器已经有「写入 + 各自计时 +
   * 重启用新时长」的语义，富提示只是 value 变成了对象（`useTransientNotice<T>` 本来就是泛型）。
   */
  const notify = (kind: 'ok' | 'err', text: string, details?: readonly string[]): void => {
    const rich = Boolean(details && details.length > 0)
    flash({ kind, text, ...(rich ? { details } : {}) }, rich ? 12000 : 5000)
  }

  /** 诊断日志（M6）：GUI 态 stdout 会被丢弃，用户报障时靠这份落盘日志。 */
  const [diagInfo, setDiagInfo] = useState<{ dir: string; bytes: number } | null>(null)
  const refreshDiag = useCallback(async (): Promise<void> => {
    const r = await apiDiagLogInfo()
    if (r.ok && r.dir) {
      setDiagInfo({ dir: r.dir, bytes: (r.files ?? []).reduce((n, f) => n + (f.size || 0), 0) })
    }
  }, [])
  useEffect(() => { void refreshDiag() }, [refreshDiag])
  const exportDiagLog = useCallback(async (): Promise<void> => {
    const r = await apiExportDiagLog()
    if (r.canceled) return
    if (!r.ok) { notify('err', '导出诊断日志失败：' + (r.error ?? '未知原因')); return }
    await refreshDiag()
    notify('ok', `诊断日志已导出（${Math.max(1, Math.round((r.bytes ?? 0) / 1024))} KB）`)
  }, [notify, refreshDiag])
  const revealDiagLog = useCallback(async (): Promise<void> => {
    const r = await apiRevealDiagLog()
    if (!r.ok) notify('err', '打开日志目录失败：' + (r.error ?? '未知原因'))
  }, [notify])
  const { diagPreview, previewDiagLog, closeDiagPreview, copyDiagLogPath } = useDiagPreview(notify)
  const load = useCallback(async (): Promise<void> => {
    setCfgLoading(true)
    try {
      const c = await apiGetWechatConfigFull()
      setCfg(c)
      writeRenderCache(SETTINGS_CONFIG_CACHE_KEY, cacheableConfig(c))
      setDbDir(c.db_dir)
      setDbKey(c.db_enc_key)
      setImgAes(c.image_aes_key)
      setImgXor(String(c.image_xor_key))
      setWhisperDevice(c.whisper_device)
      setWhisperModel(c.whisper_model)
      setWhisperThreads(c.whisper_threads)
      setWhisperModelsDir(c.whisper_models_dir)
      const k = await apiGetWechatKeysInfo()
      setKeysInfo(k)
    } catch (e) {
      notify('err', (e as Error).message)
    } finally {
      setCfgLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  // 老版本写下的渲染缓存里带着密钥：读到就立刻用去掉密钥的版本覆盖（自愈）。
  // 必须独立于 load()：加载失败时那条路径不会回写，残留的明文副本就会一直留在磁盘上。
  useEffect(() => {
    const raw = readRenderCache<Record<string, unknown>>(SETTINGS_CONFIG_CACHE_KEY)
    if (raw && SETTINGS_SECRET_FIELDS.some((k) => k in raw)) {
      writeRenderCache(SETTINGS_CONFIG_CACHE_KEY, cacheableConfig(raw as unknown as WechatConfigFull))
    }
  }, [])

  // 获取「路径配置中心」wechat/config.json 的绝对路径，用于点击打开。
  useEffect(() => {
    void apiGetWechatPathConfig().then(setPathConfigPath)
  }, [])

  const refreshWhisper = async (): Promise<void> => {
    const cached = whisperStatusCache
    if (cached && Date.now() - cached.at < SETTINGS_SCAN_TTL_MS) {
      setWhisperStatus(cached.status)
      return
    }
    setWhisperStatusLoading(true)
    try {
      const s = await apiGetWhisperStatus()
      whisperStatusCache = { at: Date.now(), status: s }
      setWhisperStatus(s)
    } catch (e) {
      notify('err', (e as Error).message)
    } finally {
      setWhisperStatusLoading(false)
    }
  }

  useEffect(() => { runWhenIdle(() => { void refreshWhisper() }) }, [])

  const detect = async (force = false): Promise<void> => {
    const cached = detectCache
    if (!force && cached && Date.now() - cached.at < SETTINGS_SCAN_TTL_MS) {
      setAccounts(cached.accounts)
      setDetectInfo(cached.info)
      setDetectMsg({ kind: 'ok', text: `✓ 检测完成（缓存），发现 ${cached.total} 个微信账号` })
      return
    }
    setDetecting(true)
    try {
      const r = await apiDetectWechatAccounts()
      setAccounts(r.accounts)
      const info: { version?: string; install_dir?: string } = {}
      if (r.version) info.version = r.version
      if (r.install_dir) info.install_dir = r.install_dir
      setDetectInfo(info)
      detectCache = { at: Date.now(), accounts: r.accounts, info, total: r.total }
      setDetectMsg({ kind: 'ok', text: `✓ 检测完成，发现 ${r.total} 个微信账号` })
    } catch (e) {
      setDetectMsg({ kind: 'err', text: '✗ ' + (e as Error).message })
    } finally {
      setDetecting(false)
    }
  }

  // 进入【数据配置】页自动执行一次微信账号检测（空闲时执行 + 60s 缓存）。
  useEffect(() => { runWhenIdle(() => { void detect() }) }, [])

  // 账号检测可能需要扫描安装目录/内存：进入页签已自动执行一次，
  // 之后仍可在步骤 1「检测账号」按钮上手动刷新。
  const useAccount = (a: WechatAccount): void => {
    setDbDir(a.db_dir)
    setDbDirMsg({ kind: 'ok', text: `✓ 已填入账号 ${a.wxid} 的数据库目录，请继续校验密钥` })
    setDbOpMsg(null)
  }

  const pickDbDir = async (): Promise<void> => {
    try {
      const dir = await pickDirectory()
      if (dir) {
        setDbDir(dir)
        setDbDirMsg({ kind: 'ok', text: '✓ 已选择数据库目录，请继续校验密钥' })
      }
    } catch (e) {
      setDbDirMsg({ kind: 'err', text: '✗ ' + (e as Error).message })
    }
  }

  const pickWhisperDir = async (): Promise<void> => {
    try {
      const dir = await pickDirectory()
      if (dir) {
        setWhisperModelsDir(dir)
        setWhisperDirMsg({ kind: 'ok', text: '✓ 已选择模型目录，保存后生效（刷新状态识别模型）' })
      }
    } catch (e) {
      setWhisperDirMsg({ kind: 'err', text: '✗ ' + (e as Error).message })
    }
  }

  /** W3-5.5：模型与引擎两路共用的「停止下载」按钮。 */
  const cancelWhisperDownload = whisperDownloadCanceller(() => whisperJobId.current, setWhisperDirMsg)

  const whisperDownload = async (m: { id: string; name: string }): Promise<void> => {
    if (whisperDownloading || whisperJobId.current) { setWhisperDirMsg({ kind: 'err', text: '✗ 已有模型下载任务进行中' }); return }
    setWhisperDirMsg(null)
    const jobId = `whisper-${String((whisperJobSeq.current += 1))}`
    whisperJobId.current = jobId
    setWhisperDownloading({ model: m.id, file: '', received: 0, total: 0 })
    const stopPoll = pollWhisperDownload(setWhisperDownloading, polls)
    try {
      const r = await apiDownloadWhisperModel({ model: m.id, jobId })
      if (r.ok) {
        setWhisperDirMsg({ kind: 'ok', text: `✓ 模型 ${m.name} 下载完成${r.bytes ? `（${fmtBytes(r.bytes)}）` : ''}，已就绪` })
        await refreshWhisper()
      } else if (isCanceled(r.error)) {
          setWhisperDirMsg({ kind: 'ok', text: '✓ ' + r.error })
      } else {
        setWhisperDirMsg({ kind: 'err', text: '✗ 模型下载失败：' + (r.error ?? '未知错误') })
      }
    } catch (e) {
      setWhisperDirMsg({ kind: 'err', text: '✗ 模型下载失败：' + (e as Error).message })
    } finally {
      stopPoll()
      whisperJobId.current = ''
      setWhisperDownloading(null)
    }
  }

  const batchTranscribe = async (): Promise<void> => {
    if (whisperTranscribing.active) { setVoiceOpMsg({ kind: 'err', text: '✗ 已有转写任务进行中' }); return }
    setVoiceOpMsg(null)
    setWhisperTranscribing({ active: true, done: 0, total: 0, failed: 0, skipped: 0, current: '' })
    const stop = pollTranscribe()
    try {
      const r = await apiTranscribeVoiceBatch({})
      const errs = r.errors.slice(0, 20).map(e => `[${e.svrId}] ${e.error}`)
      if (r.error) {
        setVoiceOpMsg({ kind: 'err', text: '✗ ' + r.error })
      } else if (!r.ok && r.failed > 0) {
        setVoiceOpMsg({ kind: 'err', text: `✗ 转写完成，${r.failed} 条失败（详见列表）` })
        notify('err', `批量转写完成：成功 ${r.done}，失败 ${r.failed}`, errs)
      } else {
        setVoiceOpMsg({ kind: 'ok', text: `✓ 批量转写完成：成功 ${r.done}/${r.total}（跳过 ${r.skipped}，失败 ${r.failed}）` })
        if (errs.length > 0) notify('err', `批量转写完成，${r.failed} 条失败`, errs)
      }
      setWhisperTranscribing({ active: false, done: r.done, total: r.total, failed: r.failed, skipped: r.skipped, current: '' })
    } catch (e) {
      setVoiceOpMsg({ kind: 'err', text: '✗ ' + (e as Error).message })
    } finally {
      stop()
      setWhisperTranscribing(prev => ({ ...prev, active: false }))
    }
  }

  const pollTranscribe = (): (() => void) => polls().start(() => {
      void apiGetWhisperStatus()
        .then((s) => {
          if (s.transcribing.active || s.transcribing.done > 0) {
            setWhisperTranscribing({
              active: s.transcribing.active,
              done: s.transcribing.done,
              total: s.transcribing.total,
              failed: s.transcribing.failed,
              skipped: s.transcribing.skipped,
              current: s.transcribing.current,
            })
          }
        })
        .catch(() => { /* 忽略单次轮询失败 */ })
  }, 500)

  const nativeTranscribe = (): void => {
    setVoiceOpMsg({ kind: 'ok', text: '✓ 微信原生转写文本会在浏览聊天消息时自动复用数据库文字，无需额外批量任务' })
  }

  const skipTranscribe = (): void => {
    setVoiceOpMsg({ kind: 'ok', text: '✓ 已跳过批量转写；聊天页可继续为单条语音转写' })
  }

  const installEngine = async (): Promise<void> => {
    if (whisperDownloading || whisperJobId.current) { setWhisperDirMsg({ kind: 'err', text: '✗ 已有下载任务进行中' }); return }
    if (whisperStatus?.engine) return
    setWhisperDirMsg(null)
    const jobId = `whisper-${String((whisperJobSeq.current += 1))}`
    whisperJobId.current = jobId
    setWhisperDownloading({ model: 'engine', file: '', received: 0, total: 0 })
    const stopPoll = pollWhisperDownload(setWhisperDownloading, polls)
    try {
      const r = await apiInstallWhisperEngine({ jobId })
      if (r.ok) {
        await refreshWhisper()
        setWhisperDirMsg({ kind: 'ok', text: '✓ whisper.cpp 引擎已就绪，可开始批量转写' })
      } else if (isCanceled(r.error)) {
        setWhisperDirMsg({ kind: 'ok', text: '✓ ' + r.error })
      } else {
        setWhisperDirMsg({ kind: 'err', text: '✗ 引擎下载失败：' + (r.error ?? '未知错误') })
      }
    } catch (e) {
      setWhisperDirMsg({ kind: 'err', text: '✗ 引擎下载失败：' + (e as Error).message })
    } finally {
      stopPoll()
      whisperJobId.current = ''
      setWhisperDownloading(null)
    }
  }

  const save = async (): Promise<void> => {
    setSaving(true)
    try {
      const r = await apiSaveWechatConfig({
        patch: {
          db_dir: dbDir,
          db_enc_key: dbKey,
          image_aes_key: imgAes,
          image_xor_key: Number(imgXor) || 136,
          whisper_device: whisperDevice,
          whisper_model: whisperModel,
          whisper_threads: Math.max(0, Math.min(whisperThreads, 64)),
          whisper_models_dir: whisperModelsDir,
        },
      })
      if (r.ok) {
        setSaveMsg({ kind: 'ok', text: '✓ 配置已保存' })
        await load()
        await refreshWhisper()
      }
      else setSaveMsg({ kind: 'err', text: '✗ ' + (r.error ?? '保存失败') })
    } catch (e) {
      setSaveMsg({ kind: 'err', text: '✗ ' + (e as Error).message })
    } finally {
      setSaving(false)
    }
  }

  const autoGetDb = async (): Promise<void> => {
    setDbGetting(true)
    setDbOpMsg(null)
    try {
      const opts: { dbPath?: string; wechatInstallDir?: string } = {}
      if (dbDir) opts.dbPath = dbDir.replace(/\\+$/, '') + '/session/session.db'
      if (detectInfo.install_dir) opts.wechatInstallDir = detectInfo.install_dir
      const r = await apiAutoGetDbKey(opts)
      if (r.ok && r.key) {
        setDbKey(r.key)
        // 拿到就立刻落盘。这一步的产物**就是密钥本身**，再要求用户点一次「保存配置」没有意义 ——
        // 忘了点就会以为配好了、其实没存。只写这一个字段（不是整张表单），
        // 免得把用户还没打算提交的其他改动一起写进去。
        const saved = await apiSaveWechatConfig({ patch: { db_enc_key: r.key } })
          .then((x) => x.ok)
          .catch(() => false)
        const saveTag = saved ? '已自动保存' : '自动保存失败，请点「保存配置」'
        const keysFile = (cfg?.resolved?.keys_file) ?? ''
        if (keysFile && dbDir) {
          const g = await apiGenerateKeysFile({ dbDir, keysFile, encKeyHex: r.key, keyFormat: 'wx_key_v4.1' })
          setDbOpMsg({ kind: saved ? 'ok' : 'err', text: `✓ 已获取数据库密钥（${saveTag}） · 已生成密钥映射 ${g.verified}/${g.total} 个数据库` })
          const k = await apiGetWechatKeysInfo()
          setKeysInfo(k)
        } else {
          setDbOpMsg({ kind: saved ? 'ok' : 'err', text: `✓ 已自动获取数据库密钥（${r.source ?? 'key_v4_memory'}） · ${saveTag}` })
        }
      } else {
        setDbOpMsg({ kind: 'err', text: '✗ ' + (r.error ?? '自动获取失败') })
      }
    } catch (e) {
      setDbOpMsg({ kind: 'err', text: '✗ ' + (e as Error).message })
    } finally {
      setDbGetting(false)
    }
  }

  const autoGetImg = async (): Promise<void> => {
    setImgGetting(true)
    setImgOpMsg(null)
    try {
      const imgOpts: { accountDir?: string } = {}
      if (dbDir) {
        // db_dir 指向 db_storage,而 V2 模板缓存位于账号根目录的 msg/attach 下。
        const dir = dbDir.replace(/[\\/]+$/, '')
        imgOpts.accountDir = (dir.split(/[\\/]/).pop() ?? '').toLowerCase() === 'db_storage' ? dir.replace(/[\\/][^\\/]+$/, '') : dir
      }
      const r = await apiAutoGetImageKey(imgOpts)
      if (r.ok && r.aesKey !== undefined && r.xorKey !== undefined) {
        setImgAes(r.aesKey)
        setImgXor(String(r.xorKey))
        // 同数据库密钥：拿到就落盘，且只写这两个字段
        const saved = await apiSaveWechatConfig({ patch: { image_aes_key: r.aesKey, image_xor_key: r.xorKey } })
          .then((x) => x.ok)
          .catch(() => false)
        setImgOpMsg(saved
          ? { kind: 'ok', text: '✓ 已自动获取图片密钥（V2 验证） · 已自动保存' }
          : { kind: 'err', text: '✓ 已获取图片密钥，但自动保存失败，请点「保存配置」' })
      } else {
        setImgOpMsg({ kind: 'err', text: '✗ ' + (r.error ?? '自动获取图片密钥失败') })
      }
    } catch (e) {
      setImgOpMsg({ kind: 'err', text: '✗ ' + (e as Error).message })
    } finally {
      setImgGetting(false)
    }
  }

  const verifyDb = async (): Promise<void> => {
    if (!dbDir) { setDbOpMsg({ kind: 'err', text: '✗ 请先选择数据库目录' }); return }
    if (!dbKey.trim()) { setDbOpMsg({ kind: 'err', text: '✗ 请输入 PBKDF2 口令' }); return }
    try {
      const dbPath = dbDir.replace(/\\+$/, '') + '/session/session.db'
      const v = await apiVerifyDatabaseKey({ dbPath, encKeyHex: dbKey.trim() })
      if (v.valid) {
        const keysFile = (cfg?.resolved?.keys_file) ?? ''
        if (keysFile) {
          const g = await apiGenerateKeysFile({ dbDir, keysFile, encKeyHex: dbKey.trim(), keyFormat: 'wx_key_v4.1' })
          setDbOpMsg({ kind: 'ok', text: `✓ 校验通过 (wx_key_v4.1) · 已生成密钥映射 ${g.verified}/${g.total} 个数据库` })
          const k = await apiGetWechatKeysInfo()
          setKeysInfo(k)
        } else {
          setDbOpMsg({ kind: 'ok', text: '✓ 校验通过 (wx_key_v4.1)' })
        }
      } else {
        setDbOpMsg({ kind: 'err', text: '✗ 密钥不正确' })
      }
    } catch (e) {
      setDbOpMsg({ kind: 'err', text: '✗ ' + (e as Error).message })
    }
  }

  const verifyImg = async (): Promise<void> => {
    if (!imgAes.trim()) { setImgOpMsg({ kind: 'err', text: '✗ 请先填写图片 AES 密钥' }); return }
    try {
      const r = await apiVerifyImageKey()
      if (r.verified) {
        setImgOpMsg({ kind: 'ok', text: `✓ 图片密钥验证通过（XOR 0x${(r.xorKey ?? 0).toString(16).toUpperCase()}）` })
      } else {
        setImgOpMsg({ kind: 'err', text: '✗ ' + (r.error ?? '图片密钥不正确') })
      }
    } catch (e) {
      setImgOpMsg({ kind: 'err', text: '✗ ' + (e as Error).message })
    }
  }

  /** 轮询解密进度(op 匹配或仍在进行中才应用),返回停止函数。 */
  const pollDecrypt = (apply: (s: {
    active: boolean
    done: number
    total: number
    failed: number
    skipped: number
    message: string
  }) => void): (() => void) => polls().start(() => {
    void apiGetDecryptStatus()
      .then((s) => {
        if (s.active || s.done > 0) apply(s)
      })
      .catch(() => { /* 忽略单次轮询失败 */ })
  }, 400)

  const decryptAll = async (): Promise<void> => {
    setDecrypting(true)
    setDbProgress({ active: true, done: 0, total: 0, failed: 0, message: '准备中…' })
    const stop = pollDecrypt((s) => {
      setDbProgress({ active: s.active, done: s.done, total: s.total, failed: s.failed, message: s.message })
    })
    try {
      const r = await apiDecryptAllDatabases()
      const failedItems = r.failed.map(f => `${f.db} — ${f.error}`)
      if (r.ok) {
        notify('ok', `解密完成：成功 ${r.okCount}/${r.total} 个数据库`, failedItems)
      } else if (r.error) {
        notify('err', r.error, failedItems)
      } else {
        notify('err', `解密完成，但 ${r.failed.length} 个数据库失败`, failedItems)
      }
      setDbProgress({ active: false, done: r.okCount + r.failed.length, total: r.total, failed: r.failed.length, message: '' })
    } catch (e) {
      notify('err', (e as Error).message)
    } finally {
      stop()
      setDbProgress((prev) => ({ ...prev, active: false }))
      setDecrypting(false)
    }
  }

  const decryptImgs = async (): Promise<void> => {
    setImgDecrypting(true)
    setImgProgress({ active: true, done: 0, total: 0, failed: 0, skipped: 0, message: '准备中…' })
    const stop = pollDecrypt((s) => {
      setImgProgress({ active: s.active, done: s.done, total: s.total, failed: s.failed, skipped: s.skipped, message: s.message })
    })
    try {
      const concurrency = Number.isFinite(imgConcurrency) && imgConcurrency >= 1 && imgConcurrency <= 32 ? imgConcurrency : 8
      const r = await apiDecryptAllImages({ concurrency })
      setImgDetailTitle('图片解密详情')
      setImgDecryptDetail({ errors: r.errors ?? [], skippedDetails: r.skippedDetails ?? [] })
      const failedItems = r.errors.map(f => `${f.file} — ${f.error}`)
      if (r.ok) {
        notify('ok', `图片解密完成：成功 ${r.okCount}/${r.total}（跳过 ${r.skipped}，失败 ${r.failed}）`, failedItems)
      } else {
        notify('err', r.error ?? '图片解密失败', failedItems)
      }
      setImgProgress({ active: false, done: r.okCount + r.failed + r.skipped, total: r.total, failed: r.failed, skipped: r.skipped, message: '' })
    } catch (e) {
      notify('err', (e as Error).message)
    } finally {
      stop()
      setImgProgress((prev) => ({ ...prev, active: false }))
      setImgDecrypting(false)
    }
  }

  /**
   * 扫描「还有多少张原图能靠免登录直链补回来」——**纯本机扫描，不联网**（约 1.3 秒）。
   */
  const scanOriginals = async (): Promise<void> => {
    setOrigBusy('scan')
    setOrigResult(null)
    try {
      setOrigPlan(await apiPlanOriginalFetch())
    } catch (e) {
      notify('err', (e as Error).message)
    } finally {
      setOrigBusy(null)
    }
  }

  /**
   * 批量取回原图（免登录直链）。**只有用户点这一下才会联网**，没有任何后台自动调用。
   *
   * 已有解密类任务在跑时后端**一条请求都不发**（回 `blocked` 说明原因），
   * 这里如实把那句话显示出来，而不是假装成功。
   */
  const fetchOriginals = async (): Promise<void> => {
    setOrigBusy('fetch')
    setOrigResult(null)
    setOrigProgress({ active: true, done: 0, total: 0, failed: 0, message: '正在扫描全库…' })
    const stop = pollDecrypt((s) => {
      setOrigProgress({ active: s.active, done: s.done, total: s.total, failed: s.failed, message: s.message })
    })
    try {
      const r = await apiFetchOriginalImagesBatch({ limit: origLimit })
      setOrigResult(r)
      const mb = (r.bytes / 1024 / 1024).toFixed(1)
      const failedItems = r.errors.map(e => `${e.username || e.md5} — ${e.error}`)
      if (r.blocked !== undefined) {
        notify('err', r.blocked)
      } else {
        notify(r.failed === 0 ? 'ok' : 'err',
          `已取回 ${r.fetched}/${r.attempted} 张（${mb} MB）`
          + (r.remaining > 0 ? `，还剩 ${r.remaining} 张候选，再点一次继续` : '')
          + (r.failed > 0 ? `，失败 ${r.failed}` : ''), failedItems)
      }
      // 取回的原图落进的是解码缓存的主槽，而内存里那份 LRU 很可能还是旧缩略图（跨面板不失效）
      // —— 不清的话用户切回会话看到的仍是糊的，「取回成功」看起来像没发生。
      if (r.fetched > 0) forgetAllImages()
      // 重新盘一次：报告里的「可补 / 已取回」必须跟着变，否则第二次点会看到一个过期数字。
      try { setOrigPlan(await apiPlanOriginalFetch()) } catch { /* 报告刷新失败不影响已取回的图 */ }
      setOrigProgress({ active: false, done: r.attempted, total: r.attempted, failed: r.failed, message: '' })
    } catch (e) {
      notify('err', (e as Error).message)
    } finally {
      stop()
      setOrigProgress((prev) => ({ ...prev, active: false }))
      setOrigBusy(null)
    }
  }

  /**
   * 升级老解码缓存：把**已经解出来**的图，按本机现存最好的一档重解一遍（不联网）。
   *
   * 为什么单列一个动作而不是并进「批量解密」：批量解密只处理**还没有缓存**的图
   * （`hasCached` 命中就跳过），而这里要处理的恰恰是**已经有缓存、但那份不是最好的**——
   * 用户「明明在微信里看过原图、这里还是糊的」就是这一批。两者同走后端的忙闲闸门，
   * 同时点会被后端拒掉（前端由此各自持一个进度块，不会串台）。
   */
  const upgradeImgs = async (): Promise<void> => {
    setImgUpgrading(true)
    setImgUpgradeResult(null)
    setImgUpgradeProgress({ active: true, done: 0, total: 0, message: '正在扫描解码缓存…' })
    const stop = pollDecrypt((s) => {
      setImgUpgradeProgress({ active: s.active, done: s.done, total: s.total, message: s.message })
    })
    try {
      const r = await apiUpgradeDecodedImages()
      setImgUpgradeResult(r)
      setImgDetailTitle('原图升级详情')
      setImgDecryptDetail({ errors: r.errors ?? [], skippedDetails: r.skippedDetails ?? [] })
      const failedItems = r.errors.map(f => `${f.file} — ${f.error}`)
      if (r.error) {
        notify('err', r.error, failedItems)
      } else if (r.upgraded === 0) {
        // 「一张都没升级」有两种完全不同的原因，必须分开说：本来就够好（不用管）与
        // 本机没有更大的源（只能回微信里点开原图）。合成一句「完成」会让人以为工具坏了。
        notify('ok', `检查 ${r.total} 张：无需升级 ${r.unchanged}，本机无源 ${r.noSource}${r.failed > 0 ? `，失败 ${r.failed}` : ''}`, failedItems)
      } else {
        notify('ok', `已升级 ${r.upgraded} 张为原图（检查 ${r.total}：无需升级 ${r.unchanged}，本机无源 ${r.noSource}，失败 ${r.failed}）`, failedItems)
      }
      // 真的换了图才清内存缓存：`MessageImage` 首帧走的是全应用共用那一份内存 LRU，
      // 它跨面板切换**不会失效** —— 不清的话用户看到的首帧仍是那张旧的缩略图，
      // 「升级成功」就表现为「什么都没发生」。一张都没升级时不清，免得白跑一屏取图。
      if (r.upgraded > 0) forgetAllImages()
      setImgUpgradeProgress({ active: false, done: r.total, total: r.total, message: '' })
    } catch (e) {
      notify('err', (e as Error).message)
    } finally {
      stop()
      setImgUpgradeProgress((prev) => ({ ...prev, active: false }))
      setImgUpgrading(false)
    }
  }

  const keyOk = keysInfo.loaded && keysInfo.keyCount > 0
  const dbFiles = accounts.reduce((sum, a) => sum + (a.db_files ?? 0), 0)
  const current = (a: WechatAccount): boolean => dbDir !== '' && dbDir.toLowerCase() === a.db_dir.toLowerCase()

  const stepStates: Record<(typeof STEPS)[number]['key'], StepState> = {
    detect: accounts.length > 0 || dbDir.trim() !== '' ? 'done' : 'todo',
    dbkey: keyOk || dbKey.trim() !== '' ? 'done' : 'todo',
    imgkey: imgAes.trim() !== '' ? 'done' : 'todo',
    img: imgAes.trim() !== '' ? 'done' : 'todo',
    voice: whisperStatus?.engine ? 'done' : 'note',
  }

  const stepLabel = (state: StepState): string => state === 'done' ? '已完成' : state === 'note' ? '说明' : '待配置'

  // ── 左右结构：左侧导航项 + 右侧只渲染当前一节 ──
  // 原来 5 张速览卡横排在顶部、5 个分节在下面一路堆叠，一屏看不全、还要靠滚动找；
  // 改成竖排导航项（状态与摘要就在项上），右侧一次只显示一节。
  const stepValueOf = (key: (typeof STEPS)[number]['key']): string => key === 'detect'
    ? `${accounts.length} 个账号`
    : key === 'dbkey'
      ? (keyOk ? `${keysInfo.keyCount} 个密钥` : '未配置')
      : key === 'imgkey'
        ? (imgAes.trim() ? '已就绪' : '未配置')
        : key === 'img'
          ? (imgAes.trim() ? '可批量解密' : '未配置')
          : (whisperStatus?.engine ? '引擎就绪' : '待配置')

  const navItems = createSettingsNavItems(stepStates, stepValueOf)

  /**
   * 弹窗内各面板的跳转：能落在本弹窗某节的就切节（不关弹窗），
   * 其余的（文件资产 / 存储分析）交回宿主，由它关弹窗再切主内容区。
   */
  const SECTION_OF_TAB: Readonly<Record<string, string>> = {
    settings: 'detect', privacytrust: 'boundary',
    backup: 'backup', health: 'health', hook: 'hook',
  }
  const innerNavigate = useCallback((tab: string): void => {
    const key = SECTION_OF_TAB[tab]
    if (key) { goToSection(key); return }
    onNavigateOut?.(tab)
  }, [onNavigateOut, goToSection])

  return {
    accounts, ackSecretMigration: async () => { await writeSecretMigrationAck(load, (t) => setSaveMsg({ kind: 'err', text: t })) }, activeKey, autoGetDb, autoGetImg, batchTranscribe,
    cfg, cfgLoading, clear, current,
    dbDir, dbDirMsg, dbFiles, dbGetting, dbKey, dbOpMsg,
    dbProgress, decryptAll, decryptImgs, decrypting, detect, detectInfo, fetchOriginals,
    detectMsg, detecting, diagInfo, exportDiagLog, goToSection, imgAes,
    imgConcurrency, imgDecryptDetail, imgDecrypting, imgDetailOpen, imgDetailTitle, imgGetting, imgOpMsg,
    imgProgress, imgUpgradeProgress, imgUpgradeResult, imgUpgrading, imgXor, innerNavigate, installEngine, keyOk, keysInfo,
    message, nativeTranscribe, navItems, onPaneScroll, origBusy, origLimit, origPlan, origProgress, origResult, paneRef, pathConfigPath,
    pickDbDir, pickWhisperDir, refreshWhisper, revealDiagLog, save, saveMsg,
    saving, scanOriginals, closeDiagPreview, copyDiagLogPath, diagPreview, previewDiagLog, secretMigration: cfg?.secret_migration ?? null, setDbDir, setDbKey, setImgAes, setImgConcurrency, setImgDetailOpen, setOrigLimit,
    setImgXor, setWhisperDevice, setWhisperModel, setWhisperModelsDir, setWhisperThreads, skipTranscribe,
    upgradeImgs, useAccount, userScrolled, verifyDb, verifyImg,
    cancelWhisperDownload, voiceOpMsg, whisperDevice, whisperDirMsg, whisperDownload, whisperDownloading, whisperModel,
    whisperModelsDir, whisperStatus, whisperStatusLoading, whisperThreads, whisperTranscribing,
  }
}
