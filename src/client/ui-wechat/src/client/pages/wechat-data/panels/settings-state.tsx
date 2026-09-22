
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
import { apiAutoGetDbKey, apiAutoGetImageKey, apiDecryptAllDatabases, apiDecryptAllImages, apiDetectWechatAccounts, apiDiagLogInfo, apiDownloadWhisperModel, apiExportDiagLog, apiGenerateKeysFile, apiGetDecryptStatus, apiGetWechatConfigFull, apiGetWechatKeysInfo, apiGetWechatPathConfig, apiGetWhisperStatus, apiInstallWhisperEngine, apiRevealDiagLog, apiSaveWechatConfig, apiSetCdnImageEnabled, apiSetCdnImageLocalDecrypt, apiTranscribeVoiceBatch, apiVerifyDatabaseKey, apiVerifyImageKey, pickDirectory, readRenderCache, writeRenderCache } from '../api.ts'
import { fmtBytes } from '../utils/format.ts'
import { useTransientNotice } from './hooks.tsx'
import { PollRegistry, createPollRegistry } from './poll-registry.ts'
import { CachedSettingsConfig, cacheableConfig, Notice, runWhenIdle, SETTINGS_CONFIG_CACHE_KEY, SETTINGS_SCAN_TTL_MS, SETTINGS_SECRET_FIELDS, StepState, STEP_ICONS, STEPS } from './settings-common.tsx'
import { IconPersonalizationOutline16, IconRefreshOutline14, IconSettingsOutline14, IconSparkle16 } from '@deepseek-ai/dsh-client-ui-primitives'
import { WechatAccount, WechatConfigFull, WhisperStatus } from '@deepseek-ai/dsh-wechat-data/types'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

/** 面板的入参（与 SettingsPanelProps 同形，这里单列以免与面板互相 import）。 */
export interface SettingsStateOptions {
  inDialog?: boolean
  initialSection?: string
  onNavigateOut?: (tab: string) => void
}

// M21：面板与状态钩子共用的「短时缓存」（同样的查询不该在两侧各打一次）。
let detectCache: { at: number; accounts: readonly WechatAccount[]; info: { version?: string; install_dir?: string }; total: number } | null = null
let whisperStatusCache: { at: number; status: WhisperStatus } | null = null

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
  const [cdnEnabled, setCdnEnabled] = useState(cachedCfg?.cdn_enabled ?? true)
  const [cdnLocal, setCdnLocal] = useState(cachedCfg?.cdn_local_decrypt ?? true)
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
  const [cdnMsg, setCdnMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
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
        const last = secs[secs.length - 1].dataset.settingsSection
        if (last) setActiveKey((prev) => (prev === last ? prev : last))
        return
      }
      const boxTop = box.getBoundingClientRect().top
      // 判定线取容器上沿下方 24px：跨过它的最后一节就是当前节。用固定小偏移而不是
      // 「视口 1/4」这类大偏移，短节（如高级设置）才不会被整节跳过。
      let cur = secs[0].dataset.settingsSection ?? ''
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
  useLayoutEffect(() => {
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
      setCdnEnabled(c.cdn_enabled)
      setCdnLocal(c.cdn_local_decrypt)
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

  const whisperDownload = async (m: { id: string; name: string }): Promise<void> => {
    if (whisperDownloading) { setWhisperDirMsg({ kind: 'err', text: '✗ 已有模型下载任务进行中' }); return }
    setWhisperDirMsg(null)
    setWhisperDownloading({ model: m.id, file: '', received: 0, total: 0 })
    const stopPoll = polls().start(() => {
      void apiGetWhisperStatus()
        .then((s) => {
          if (s.downloading) {
            setWhisperDownloading({
              model: s.downloading.model,
              file: s.downloading.file,
              received: s.downloading.received,
              total: s.downloading.total,
            })
          }
        })
        .catch(() => { /* 忽略单次轮询失败 */ })
    }, 500)
    try {
      const r = await apiDownloadWhisperModel({ model: m.id })
      if (r.ok) {
        setWhisperDirMsg({ kind: 'ok', text: `✓ 模型 ${m.name} 下载完成${r.bytes ? `（${fmtBytes(r.bytes)}）` : ''}，已就绪` })
        await refreshWhisper()
      } else {
        setWhisperDirMsg({ kind: 'err', text: '✗ 模型下载失败：' + (r.error ?? '未知错误') })
      }
    } catch (e) {
      setWhisperDirMsg({ kind: 'err', text: '✗ 模型下载失败：' + (e as Error).message })
    } finally {
      stopPoll()
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
    if (whisperDownloading) { setWhisperDirMsg({ kind: 'err', text: '✗ 已有下载任务进行中' }); return }
    if (whisperStatus?.engine) return
    setWhisperDirMsg(null)
    setWhisperDownloading({ model: 'engine', file: '', received: 0, total: 0 })
    const stopPoll = polls().start(() => {
      void apiGetWhisperStatus()
        .then((s) => {
          if (s.downloading) {
            setWhisperDownloading({
              model: s.downloading.model,
              file: s.downloading.file,
              received: s.downloading.received,
              total: s.downloading.total,
            })
          }
        })
        .catch(() => { /* 忽略单次轮询失败 */ })
    }, 500)
    try {
      const r = await apiInstallWhisperEngine()
      if (r.ok) {
        await refreshWhisper()
        setWhisperDirMsg({ kind: 'ok', text: '✓ whisper.cpp 引擎已就绪，可开始批量转写' })
      } else {
        setWhisperDirMsg({ kind: 'err', text: '✗ 引擎下载失败：' + (r.error ?? '未知错误') })
      }
    } catch (e) {
      setWhisperDirMsg({ kind: 'err', text: '✗ 引擎下载失败：' + (e as Error).message })
    } finally {
      stopPoll()
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
          // cdn_enabled / cdn_local_decrypt 是**真实生效**的开关（N24）：
          // 前者拦下发往 CDN 的取图/取视频请求，后者决定远端字节是否本地解密（见 query/cdn-policy.ts）
          cdn_enabled: cdnEnabled,
          cdn_local_decrypt: cdnLocal,
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
      setImgDecrypting(false)
    }
  }

  const toggleCdn = async (enabled: boolean): Promise<void> => {
    try { await apiSetCdnImageEnabled({ enabled }); setCdnEnabled(enabled); setCdnMsg({ kind: 'ok', text: `✓ 已${enabled ? '开启' : '关闭'}自动获取原图` }) }
    catch (e) { setCdnMsg({ kind: 'err', text: '✗ ' + (e as Error).message }) }
  }

  const toggleCdnLocal = async (local: boolean): Promise<void> => {
    try { await apiSetCdnImageLocalDecrypt({ localDecrypt: local }); setCdnLocal(local); setCdnMsg({ kind: 'ok', text: local ? '✓ 原图解密方式：本地解密' : '✓ 原图解密方式：服务端解密' }) }
    catch (e) { setCdnMsg({ kind: 'err', text: '✗ ' + (e as Error).message }) }
  }

  const keyOk = keysInfo.loaded && keysInfo.keyCount > 0
  const dbFiles = accounts.reduce((sum, a) => sum + (a.db_files ?? 0), 0)
  const current = (a: WechatAccount): boolean => dbDir !== '' && dbDir.toLowerCase() === a.db_dir.toLowerCase()

  const stepStates: Record<(typeof STEPS)[number]['key'], StepState> = {
    detect: accounts.length > 0 || dbDir.trim() !== '' ? 'done' : 'todo',
    dbkey: keyOk || dbKey.trim() !== '' ? 'done' : 'todo',
    imgkey: imgAes.trim() !== '' ? 'done' : 'todo',
    img: cdnEnabled ? 'done' : 'todo',
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
          ? (cdnEnabled ? '已启用' : '未启用')
          : (whisperStatus?.engine ? '引擎就绪' : '待配置')

  type NavKey = (typeof STEPS)[number]['key']
    | 'ai' | 'boundary' | 'license' | 'update' | 'backup' | 'health' | 'hook' | 'advanced'
  /**
   * 左导航条目（13 节，分五组）。
   *
   * 分组口径是**用户意图**，不是历史沿革：配置向导 5 步是首次配置要走的流程；
   * 「智能与隐私」是 AI 与出网这两项要改行为的地方；「授权与更新」是软件本身的授权与版本；
   * 「维护与自检」是数据侧的备份与体检动作；「高级」放低频开关。
   *
   * 原先的「授权与维护」是一个 6 项的杂物组（授权 / 更新 / 备份 / 健康 / 自检 / 日志混在一起），
   * 找东西得逐条读；拆成「授权与更新」+「维护与自检」后看组名就够了。
   *
   * 另有两节 2026-09 迁回主界面（不在本列表里）：隐私体检与操作日志 ——
   * 它们是只读数据视图（扫描结果、风险 TOP10、审计长表），不是配置也不是维护动作。
   */
  const navItems: Array<{ key: NavKey; group: string; label: string; icon: React.ReactNode; value: string; dot?: 'done' | 'warning' | 'ongoing' }> = [
    ...STEPS.map((s) => ({
      key: s.key as NavKey,
      group: '配置向导',
      label: s.label,
      icon: STEP_ICONS[s.key],
      value: stepValueOf(s.key),
      dot: (stepStates[s.key] === 'done' ? 'done' : stepStates[s.key] === 'note' ? 'warning' : 'ongoing') as 'done' | 'warning' | 'ongoing',
    })),
    { key: 'ai', group: '智能与隐私', label: 'AI 大模型', icon: <IconSparkle16 size={14} />, value: '问答模型与向量模型' },
    { key: 'boundary', group: '智能与隐私', label: '数据边界与出网', icon: STEP_ICONS.boundary, value: '本地/出网边界 · 审计' },
    { key: 'license', group: '授权与更新', label: '软件授权', icon: <IconPersonalizationOutline16 size={14} />, value: '许可证状态' },
    { key: 'update', group: '授权与更新', label: '软件更新', icon: <IconRefreshOutline14 size={14} />, value: '自动更新 · 手动检查' },
    { key: 'backup', group: '维护与自检', label: '备份恢复', icon: STEP_ICONS.backup, value: '本地快照 · 创建/恢复' },
    { key: 'health', group: '维护与自检', label: '数据库健康', icon: STEP_ICONS.health, value: '占用与完整性检查' },
    { key: 'hook', group: '维护与自检', label: '原图链路自检', icon: STEP_ICONS.hook, value: '本地解码自检' },
    { key: 'advanced', group: '高级', label: '高级设置', icon: <IconSettingsOutline14 size={14} />, value: '输出目录 · 启动引导' },
  ]

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
    accounts, activeKey, autoGetDb, autoGetImg, batchTranscribe, cdnEnabled,
    cdnLocal, cdnMsg, cfg, cfgLoading, clear, current,
    dbDir, dbDirMsg, dbFiles, dbGetting, dbKey, dbOpMsg,
    dbProgress, decryptAll, decryptImgs, decrypting, detect, detectInfo,
    detectMsg, detecting, diagInfo, exportDiagLog, goToSection, imgAes,
    imgConcurrency, imgDecryptDetail, imgDecrypting, imgDetailOpen, imgGetting, imgOpMsg,
    imgProgress, imgXor, innerNavigate, installEngine, keyOk, keysInfo,
    message, nativeTranscribe, navItems, onPaneScroll, paneRef, pathConfigPath,
    pickDbDir, pickWhisperDir, refreshWhisper, revealDiagLog, save, saveMsg,
    saving, setDbDir, setDbKey, setImgAes, setImgConcurrency, setImgDetailOpen,
    setImgXor, setWhisperDevice, setWhisperModel, setWhisperModelsDir, setWhisperThreads, skipTranscribe,
    toggleCdn, toggleCdnLocal, useAccount, userScrolled, verifyDb, verifyImg,
    voiceOpMsg, whisperDevice, whisperDirMsg, whisperDownload, whisperDownloading, whisperModel,
    whisperModelsDir, whisperStatus, whisperStatusLoading, whisperThreads, whisperTranscribing,
  }
}
