/**
 * 朋友圈的**导出与手动重同步**：表单状态、目录选择、导出参数拼装、触发宿主重解密。
 *
 * ## 为什么单独成模块（第三批 #18 第三步）
 *
 * 导出弹窗的七个表单字段 + 四个进行中标记原先和「同步」一起摊在 `moments-panel.tsx` 里，
 * 是那个 900 多行组件的第二大块。这里把它收成两半：
 *  · **`buildExportOptions` 是纯函数** —— 「导出内容与列表当前筛选一致」这句话的全部细节
 *    （哪些条件要带、什么时候不带、日期按本地时区取整天边界）都在这一个函数里，可以查表验证；
 *  · **`useMomentsExport` 只管状态与调用**，不自己决定参数形状。
 *
 * 那条「与列表一致」的约定很容易被改坏：少带一个键的后果不是报错，而是**导出的内容与屏幕上看到的不一样**，
 * 用户只能事后发现。所以 `moments-export.spec.ts` 逐键钉正反例（给了才带、没给就不许出现这个键）。
 *
 * @module moments-export
 */
import { useCallback, useState } from 'react'
import { apiDecryptAllDatabases, apiExportMoments, pickDirectory } from '../api.ts'
import type { MediaFilter, MomentsNoticeSink } from './moments-support.tsx'

/** 弹窗里用户直接填的那几项。 */
export interface ExportForm {
  format: string
  from: string
  to: string
  dir: string
  images: boolean
  zip: boolean
}

/** 从面板当前的筛选状态透传过来的口径（导出必须与屏幕一致）。 */
export interface ExportScope {
  /** 微信用户名（深链「TA 的朋友圈」带进来的那个）；面板那边允许传 null。 */
  username?: string | null
  /** 作者显示名（作者牌选中的那个）。 */
  authorName?: string | null
  search: string
  media: MediaFilter
  month: string | null
  mine: 'all' | 'mine' | 'others'
}

/** 发给后端的导出参数：可选键**只在有值时出现**（后端按「键在不在」判断口径）。 */
export interface MomentsExportOptions {
  format: string
  username?: string
  authorName?: string
  q?: string
  images?: boolean
  media?: string
  month?: string
  mine?: string
  zip?: boolean
  from?: number
  to?: number
  dir?: string
}

/** `YYYY-MM-DD` → 本地那天 00:00 的秒；空串 = 不设界。 */
function dayStart(date: string): number | undefined {
  return date ? Math.floor(new Date(date + 'T00:00:00').getTime() / 1000) : undefined
}

/** `YYYY-MM-DD` → 本地那天 23:59 的秒；空串 = 不设界。 */
function dayEnd(date: string): number | undefined {
  return date ? Math.floor(new Date(date + 'T23:59:59').getTime() / 1000) : undefined
}

/**
 * 把「表单 + 当前筛选」拼成后端参数。**纯函数**，不碰任何状态。
 * @param form - 弹窗里的用户输入。
 * @param scope - 面板当前的筛选口径。
 * @returns 导出参数（可选键只在有值时出现）。
 */
export function buildExportOptions(form: ExportForm, scope: ExportScope): MomentsExportOptions {
  const opts: MomentsExportOptions = { format: form.format }
  if (scope.username) opts.username = scope.username
  if (scope.authorName) opts.authorName = scope.authorName
  const term = scope.search.trim()
  if (term) opts.q = term
  if (scope.media !== 'all') opts.media = scope.media
  if (scope.month) opts.month = scope.month
  if (scope.mine !== 'all') opts.mine = scope.mine
  if (form.images) opts.images = true
  if (form.zip) opts.zip = true
  const from = dayStart(form.from)
  const to = dayEnd(form.to)
  if (from !== undefined) opts.from = from
  if (to !== undefined) opts.to = to
  if (form.dir) opts.dir = form.dir
  return opts
}

/** `useMomentsExport` 的输入。 */
export interface MomentsExportInput {
  /** 面板当前的筛选口径（导出参数必须由它 + 表单一起决定，见 {@link buildExportOptions}）。 */
  scope: ExportScope
  /** 重同步完成后要重取一次列表。 */
  reload: () => Promise<unknown>
  notify: MomentsNoticeSink
}

/**
 * 导出弹窗与手动重同步的状态/动作。
 * @param input - 见 {@link MomentsExportInput}。
 * @returns 弹窗开关、表单字段、三个进行中标志、导出去向路径，以及四个动作。
 */
export function useMomentsExport(input: MomentsExportInput): {
  exportOpen: boolean
  setExportOpen: (v: boolean) => void
  expFormat: string
  setExpFormat: (v: string) => void
  expFrom: string
  setExpFrom: (v: string) => void
  expTo: string
  setExpTo: (v: string) => void
  expDir: string
  setExpDir: (v: string) => void
  expImages: boolean
  setExpImages: (v: boolean) => void
  expZip: boolean
  setExpZip: (v: boolean) => void
  syncing: boolean
  lastSync: number
  pickingDir: boolean
  exporting: boolean
  exportedPath: string | null
  setExportedPath: (v: string | null) => void
  openExport: () => void
  doSync: () => Promise<void>
  pickDir: () => Promise<void>
  doExport: () => Promise<void>
} {
  const { scope, reload, notify } = input
  const [exportOpen, setExportOpen] = useState(false)
  const [expFormat, setExpFormat] = useState('html')
  const [expFrom, setExpFrom] = useState('')
  const [expTo, setExpTo] = useState('')
  const [expDir, setExpDir] = useState('')
  const [expImages, setExpImages] = useState(false)
  const [expZip, setExpZip] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [lastSync, setLastSync] = useState(0)
  const [pickingDir, setPickingDir] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [exportedPath, setExportedPath] = useState<string | null>(null)

  // 手动重新同步：触发宿主重解密并派发更新事件（面板随后刷新）。
  // 派发那条 DOM 事件是**唯一**让其它面板也丢掉旧快照的通道，别换成直接调它们的接口。
  const doSync = useCallback(async (): Promise<void> => {
    if (syncing) return
    setSyncing(true)
    notify.clear()
    try {
      await apiDecryptAllDatabases()
      setLastSync(Date.now())
      window.dispatchEvent(new Event('dsh-wechat-data-updated'))
      void reload()
      notify.flash('已重新同步解密数据')
    } catch (e) {
      notify.hold('同步失败: ' + (e as Error).message)
    } finally {
      setSyncing(false)
    }
  }, [syncing, notify, reload])

  const pickDir = useCallback(async (): Promise<void> => {
    if (pickingDir) return
    setPickingDir(true)
    try {
      const dir = await pickDirectory()
      if (dir) setExpDir(dir)
    } finally {
      setPickingDir(false)
    }
  }, [pickingDir])

  const doExport = useCallback(async (): Promise<void> => {
    setExporting(true)
    notify.clear()
    try {
      const opts = buildExportOptions(
        { format: expFormat, from: expFrom, to: expTo, dir: expDir, images: expImages, zip: expZip },
        scope,
      )
      const r = await apiExportMoments(opts)
      notify.flash('已导出 ' + String(r.count) + ' 条动态 → ' + r.path)
      setExportedPath(r.path)
      setExportOpen(false)
    } catch (e) {
      notify.hold('导出失败: ' + (e as Error).message)
    } finally {
      setExporting(false)
    }
  }, [expFormat, expFrom, expTo, expDir, expImages, expZip, scope, notify])

  const openExport = useCallback((): void => { setExportOpen(true) }, [])

  return {
    exportOpen, setExportOpen, expFormat, setExpFormat, expFrom, setExpFrom, expTo, setExpTo,
    expDir, setExpDir, expImages, setExpImages, expZip, setExpZip,
    syncing, lastSync, pickingDir, exporting, exportedPath, setExportedPath,
    openExport, doSync, pickDir, doExport,
  }
}
