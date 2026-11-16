/**
 * 「提交 Bug 与建议」引导弹窗。
 *
 * 桌面端入口在侧栏底部固定区（设置上方），手机端入口在「更多」sheet 的「配置」组；
 * 两边共用本组件与同一份诊断信息生成逻辑。
 *
 * ## 为什么是「引导 + 外部收集表」而不是应用内表单
 *
 * 反馈要带截图/录屏，还要能跨版本追踪，应用内表单做不全。这里只负责三件事：
 *   ① 告诉用户什么样的信息有用（复现步骤 / 现场证据 / 使用环境）；
 *   ② 一键复制诊断信息（版本与系统，**不含**聊天记录或密钥）；
 *   ③ 用 `window.open` 把收集表交给系统浏览器打开。
 *
 * 隐私边界写死在文案里：诊断信息只有版本号与平台，复制内容也做了同样的提醒。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { RuntimeVersions } from '../../../electron-api.ts'
import { runtimeCapabilities } from '../api.ts'
import { Button, Dialog } from '../ui/kit.tsx'
import { copyTextToClipboard } from '../utils/misc.ts'
import css from './bug-report.module.css'

/** 官方 Bug / 建议收集表（金山文档）。只允许 https，协议校验见 {@link openBugReportForm}。 */
export const BUG_REPORT_URL = 'https://www.kdocs.cn/l/cmLRic6J3AR4'

/** 版本字段运行时可能缺失（浏览器里根本没有 Electron 桥），所以统一按可选处理。 */
type BugReportVersions = Partial<RuntimeVersions>

/**
 * 把一个外部链接交给系统浏览器。
 *
 * 只放行 https：URL 将来若被改成 http 或 javascript:，这里静默拒绝，
 * 不给渲染进程一个可以打开任意协议的口子。
 *
 * 刻意不复用 `chats-support.openLink`：消息里的链接允许 http（历史消息里确实有），
 * 而提交收集表是固定入口，收紧到 https 才不会随另一处的策略一起放宽。
 *
 * @param raw - 待打开的外部链接。
 * @returns 是否真的发起了打开动作（浏览器拦截时 `window.open` 返回 null，无法可靠区分）。
 */
export function openExternalUrl(raw: string): boolean {
  if (typeof window === 'undefined') return false
  if (!/^https:\/\//i.test(raw)) return false
  try {
    window.open(raw, '_blank', 'noopener,noreferrer')
    return true
  } catch {
    return false
  }
}

/** 在系统浏览器中打开官方收集表。 */
export function openBugReportForm(): void {
  openExternalUrl(BUG_REPORT_URL)
}

/** 单个字段的展示值：运行时可能是 undefined / 空串 / 非字符串，统一收敛成「未知」。 */
function versionValue(value: unknown): string {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : '未知'
}

/**
 * 生成可粘贴到收集表的诊断信息（纯函数，便于单测）。
 *
 * 只拼接版本与平台字段，**刻意不读取**聊天记录、数据库路径、密钥或任何用户数据。
 * @param versions - 主进程 `app:versions` 的返回；字段可缺失，缺省显示「未知」。
 * @returns 多行纯文本，可直接粘贴。
 */
export function buildBugReportDiagnostics(versions: BugReportVersions = {}): string {
  return [
    'Super Time 微信数据 · Bug 诊断信息',
    `应用版本：${versionValue(versions.app)}`,
    `系统平台：${versionValue(versions.platform)}`,
    `系统架构：${versionValue(versions.arch)}`,
    `Electron：${versionValue(versions.electron)}`,
    `Chromium：${versionValue(versions.chrome)}`,
    `Node.js：${versionValue(versions.node)}`,
    '',
    '隐私提醒：以上仅包含版本与系统信息，不含聊天记录、数据库密钥、License 或 API Key。',
  ].join('\n')
}

/**
 * 浏览器环境下的兜底版本信息（手机浏览器走这里）。
 *
 * `window.electronAPI` 不存在时不能去调桥（那会直接抛），但复制按钮仍需给出
 * 可定位问题的环境信息：从 userAgent 里取 Chromium 系版本，平台取 `navigator.platform`。
 * @returns 能取到多少填多少的可选版本字段。
 */
function readBrowserVersions(): BugReportVersions {
  if (typeof navigator === 'undefined') return {}
  const ua = navigator.userAgent
  const chrome = /(?:Chrome|Chromium|CriOS|Edg)\/([\d.]+)/i.exec(ua)?.[1]
  const platform = navigator.platform || /Windows NT|Macintosh|Android|iPhone|iPad|Linux/i.exec(ua)?.[0] || ''
  return {
    ...(chrome ? { chrome } : {}),
    ...(platform ? { platform } : {}),
  }
}

/** 版本号只接受数字与点：交接态会把整段 UA 塞进 `chrome`，不能原样展示。 */
const NUMERIC_VERSION = /^\d+(?:\.\d+)*$/

/**
 * 合并主进程版本与浏览器兜底。桥只回一部分（手机浏览器交接态没有 platform/arch）
 * 时，缺失字段保留浏览器已知值；非版本号字符串（如 `electron: 'browser'`、
 * 整段 UA）不透传，避免诊断信息变成噪音。
 * @param info - `app:versions` 的返回值（形状不可信）。
 * @returns 可安全展示的版本字段。
 */
function mergeVersions(info: unknown): BugReportVersions {
  const merged: BugReportVersions = { ...readBrowserVersions() }
  if (info === null || typeof info !== 'object') return merged
  const raw = info as Record<string, unknown>
  for (const key of ['app', 'platform', 'arch'] as const) {
    const value = raw[key]
    if (typeof value === 'string' && value.trim() !== '') merged[key] = value.trim()
  }
  for (const key of ['electron', 'chrome', 'node'] as const) {
    const value = raw[key]
    if (typeof value === 'string' && NUMERIC_VERSION.test(value.trim())) merged[key] = value.trim()
  }
  return merged
}

/**
 * 读取一次可展示的版本信息；桥不可用或报错时退回浏览器兜底。
 *
 * 能不能碰桥走统一能力表（`capabilities.wiring` 禁止面板自己判环境）：
 * 桌面端与「打开网页」交接态都有可用桥，其余一律走浏览器兜底。
 */
async function fetchVersions(): Promise<BugReportVersions> {
  const caps = runtimeCapabilities()
  const bridge = caps.isDesktop || caps.desktopEquivalent ? window.electronAPI : undefined
  if (bridge?.getVersions) {
    try {
      return mergeVersions(await bridge.getVersions())
    } catch {
      /* 主进程未响应 / 桥被裁剪：退回浏览器能拿到的信息，不阻塞弹窗 */
    }
  }
  return readBrowserVersions()
}

/** 正文里的三条引导步骤：标题 + 一句可操作的说明。 */
const STEPS: ReadonlyArray<{ title: string; detail: string }> = [
  {
    title: '复现步骤',
    detail: '在哪个页面、做了什么操作、期望看到什么、实际发生了什么。',
  },
  {
    title: '现场证据',
    detail: '报错原文尽量完整；有截图或录屏更好，可在收集表里上传。',
  },
  {
    title: '使用环境',
    detail: '应用版本与操作系统，可点下方「复制诊断信息」一键复制。',
  },
]

/**
 * Bug 反馈引导弹窗。
 * @param props.open - 是否打开。
 * @param props.onClose - 关闭回调（取消、Esc 或点遮罩）。打开收集表后**不自动关闭**：
 *   浏览器/系统打开失败没有可靠信号，留着弹窗让用户还能复制链接与诊断信息。
 * @returns Radix Dialog；关闭时不渲染任何内容。
 */
export function BugReportDialog({ open, onClose }: {
  open: boolean
  onClose: () => void
}): React.JSX.Element {
  // 先用浏览器能立刻拿到的信息兜底：用户可能在桥返回前就点「复制诊断信息」。
  const [versions, setVersions] = useState<BugReportVersions>(() => readBrowserVersions())
  const [copyState, setCopyState] = useState<'idle' | 'ok' | 'fail'>('idle')
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const versionsRef = useRef<BugReportVersions>(versions)
  const versionsLoadedRef = useRef(false)
  // 与 effect 共享同一次在途请求：打开后立刻点复制会 await 它，而不是复制「未知」。
  const loadPromiseRef = useRef<Promise<BugReportVersions> | null>(null)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      if (copyTimer.current) clearTimeout(copyTimer.current)
    }
  }, [])

  const loadVersions = useCallback((): Promise<BugReportVersions> => {
    loadPromiseRef.current ??= fetchVersions()
    return loadPromiseRef.current
  }, [])

  // 每次打开都重新取版本：应用升级后（不重启）复制的信息也要对得上。
  useEffect(() => {
    if (!open) return
    setCopyState('idle')
    loadPromiseRef.current = null
    versionsLoadedRef.current = false
    let cancelled = false
    void loadVersions().then((value) => {
      if (cancelled) return
      versionsRef.current = value
      versionsLoadedRef.current = true
      setVersions(value)
    })
    return () => { cancelled = true }
  }, [open, loadVersions])

  const copyDiagnostics = async (): Promise<void> => {
    const current = versionsLoadedRef.current ? versionsRef.current : await loadVersions()
    if (!mountedRef.current) return
    // 让「复制失败时展示的预览」与刚复制的内容同源，避免预览缺版本字段。
    versionsRef.current = current
    versionsLoadedRef.current = true
    setVersions(current)
    const ok = await copyTextToClipboard(buildBugReportDiagnostics(current))
    if (!mountedRef.current) return
    setCopyState(ok ? 'ok' : 'fail')
    if (copyTimer.current) clearTimeout(copyTimer.current)
    copyTimer.current = setTimeout(() => {
      if (mountedRef.current) setCopyState('idle')
    }, 4000)
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="提交 Bug 与建议"
      footer={(
        <div className={css.actions}>
          <Button
            size="sm"
            variant="outline"
            onClick={() => { void copyDiagnostics() }}
            title="复制应用版本与系统信息，方便粘贴到收集表"
            aria-label="复制诊断信息"
          >
            复制诊断信息
          </Button>
          {copyState !== 'idle' && (
            <span
              className={`${css.copyState} ${copyState === 'ok' ? css.copyOk : css.copyFail}`}
              role="status"
              aria-live="polite"
            >
              {copyState === 'ok' ? '已复制诊断信息' : '复制失败，请手动复制下方诊断信息'}
            </span>
          )}
          <span className={css.spacer} />
          <Button
            size="sm"
            variant="ghost"
            onClick={onClose}
            title="关闭弹窗，暂不提交"
            aria-label="取消"
          >
            取消
          </Button>
          <Button
            size="sm"
            variant="primary"
            onClick={openBugReportForm}
            title="在系统浏览器中打开官方 Bug 收集表"
            aria-label="打开提交页面"
          >
            打开提交页面
          </Button>
        </div>
      )}
    >
      <p className={css.intro}>
        遇到问题或有好建议，欢迎提交到官方收集表。信息越完整，定位越快。
      </p>

      <ol className={css.steps}>
        {STEPS.map((step, index) => (
          <li key={step.title} className={css.step}>
            <span className={css.stepNo} aria-hidden="true">{index + 1}</span>
            <span className={css.stepBody}>
              <span className={css.stepTitle}>{step.title}</span>
              <span className={css.stepDetail}>{step.detail}</span>
            </span>
          </li>
        ))}
      </ol>

      <div className={css.privacy} role="note">
        <span className={css.privacyTitle}>隐私提醒</span>
        <span>请勿提交聊天记录原文、数据库密钥、License、API Key 等敏感信息。</span>
      </div>

      {copyState === 'fail' && (
        <pre className={css.manual} aria-label="诊断信息（可手动复制）">
          {buildBugReportDiagnostics(versions)}
        </pre>
      )}

      <p className={css.hint}>
        「打开提交页面」将在系统浏览器中打开官方收集表；若浏览器没有反应，可手动复制此链接：
        <span className={css.url}>{BUG_REPORT_URL}</span>
      </p>
    </Dialog>
  )
}
