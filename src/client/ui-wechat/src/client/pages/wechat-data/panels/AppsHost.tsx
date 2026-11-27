/**
 * 应用托管面板（2026-11-24）。
 *
 * Super Time 是唯一授权主机：这里展示「授权有没有、席位剩几个、实例在不在跑」，
 * 并提供部署 / 启停 / 能力 / 日志入口。**不显示任何令牌或票据密钥** —— 主进程只回掩码。
 *
 * 授权失效时页面仍然可读（否则用户看不到原因），只是部署/启动按钮会被主进程拒绝；
 * 面板把拒绝码翻译成可操作的下一步，而不是笼统的「失败」。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AppInstanceView, AppsSummary } from '../../../electron-api.ts'
import {
  Badge,
  Button,
  Dialog,
  Drawer,
  EmptyState,
  ErrorState,
  LoadingState,
  PanelHeader,
  Toolbar,
} from '../ui/kit.tsx'
import {
  apiAppsCreate,
  apiAppsDeploy,
  apiAppsLogs,
  apiAppsOpenDir,
  apiAppsPushTicket,
  apiAppsRemove,
  apiAppsRestart,
  apiAppsSeedCaps,
  apiAppsStart,
  apiAppsStop,
  apiAppsSummary,
  apiAppsUpdate,
  emptyAppsSummary,
  onAppsEvent,
} from '../api-apps.ts'
import { useTransientNotice } from './hooks.tsx'
import { fmtLocaleMs } from '../utils/format.ts'
import css from './apps-host.module.css'

/** 能力位的中文名；未知位原样显示，便于对账新签发的证书。 */
const CAP_LABELS: Record<string, string> = {
  search: '会话搜索',
  send: '文本发送',
  attachments: '附件发送',
  mention: '群成员 @',
}

type Notice = { kind: 'ok' | 'warn' | 'err', text: string }

function relativeTime(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '从未'
  const delta = Date.now() - ms
  if (delta < 60_000) return '刚刚'
  if (delta < 3_600_000) return String(Math.floor(delta / 60_000)) + ' 分钟前'
  if (delta < 86_400_000) return String(Math.floor(delta / 3_600_000)) + ' 小时前'
  return String(Math.floor(delta / 86_400_000)) + ' 天前'
}

/** 实例运行态 → 徽标。顺序有意：未授权优先于「已停止」，避免误导用户去点启动。 */
function instanceBadge(instance: AppInstanceView, licensed: boolean): { label: string, tone: 'green' | 'amber' | 'red' | 'default' } {
  if (!licensed) return { label: '授权受限', tone: 'red' }
  if (!instance.enabled) return { label: '已停用', tone: 'default' }
  if (!instance.live?.deployed) return { label: '未部署', tone: 'amber' }
  if (instance.live?.running) return { label: '运行中', tone: 'green' }
  return { label: '已停止', tone: 'default' }
}

/** 把主进程的拒绝码翻译成「下一步做什么」。 */
function denialHint(code: string, fallback: string): string {
  switch (code) {
    case 'FEATURE_DENIED':
      return '当前许可证未包含「应用托管」；请在签发台签一张带该功能位的证书后重新导入。'
    case 'LICENSE_REQUIRED':
      return '尚未导入许可证；请先在「设置 → 授权」中导入。'
    case 'EXPIRED':
      return '许可证已过期；续费并导入新证后实例会自动恢复。'
    case 'DEVICE_MISMATCH':
      return '许可证与本机设备不匹配；请导出激活请求后重新签发。'
    case 'SEAT_EXHAUSTED':
      return '席位已用满；请释放一个实例，或在签发台提高席位数。'
    case 'EXE_MISSING':
      return '未找到 SuperLanguage.exe；请先构建 apps/superlanguage 或安装随包版本。'
    default:
      return fallback
  }
}

function useAppsHost() {
  const [summary, setSummary] = useState<AppsSummary>(() => emptyAppsSummary())
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const { notice, flash } = useTransientNotice<Notice>(4000)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [createName, setCreateName] = useState('')
  /** 部署位置：本机 / 局域网另一台电脑（跨机托管）。 */
  const [createMode, setCreateMode] = useState<'local' | 'lan'>('local')
  const [createHost, setCreateHost] = useState('')
  const [createDir, setCreateDir] = useState('')
  const [logs, setLogs] = useState<{ id: string, name: string, text: string } | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      if (timer.current !== null) clearTimeout(timer.current)
    }
  }, [])

  const refresh = useCallback(async (options: { silent?: boolean } = {}): Promise<void> => {
    if (options.silent !== true) setLoading(true)
    try {
      const next = await apiAppsSummary()
      if (!mounted.current) return
      setSummary(next)
      setError(next.ok ? '' : '')
    } catch (e) {
      if (mounted.current) setError('读取应用托管状态失败：' + (e instanceof Error ? e.message : String(e)))
    } finally {
      if (mounted.current) setLoading(false)
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  // 主进程的租约/退出事件：实例每 10 分钟续期一次，这里合并成一次刷新，避免抖动。
  useEffect(() => {
    const off = onAppsEvent(() => {
      if (timer.current !== null) return
      timer.current = setTimeout(() => {
        timer.current = null
        void refresh({ silent: true })
      }, 800)
    })
    return off
  }, [refresh])

  const act = useCallback(async (
    id: string,
    run: () => Promise<{ ok: boolean, error?: string, code?: string }>,
    success: string,
  ): Promise<void> => {
    setBusyId(id)
    try {
      const result = await run()
      flash(result.ok
        ? { kind: 'ok', text: success }
        : { kind: 'err', text: denialHint(result.code ?? '', result.error ?? '操作失败') })
      await refresh({ silent: true })
    } catch (e) {
      flash({ kind: 'err', text: '操作失败：' + (e instanceof Error ? e.message : String(e)) })
    } finally {
      if (mounted.current) setBusyId(null)
    }
  }, [flash, refresh])

  const create = useCallback(async (): Promise<void> => {
    const name = createName.trim()
    if (name === '') return
    setBusyId('create')
    try {
      const result = await apiAppsCreate({
        name,
        mode: createMode,
        ...(createMode === 'lan' ? { host: createHost.trim(), dir: createDir.trim() } : {}),
      })
      if (result.ok) {
        setCreating(false)
        setCreateName('')
        setCreateHost('')
        setCreateDir('')
        setCreateMode('local')
        flash({ kind: 'ok', text: createMode === 'lan' ? '实例已登记；下一步是「部署」到目标电脑' : '实例已创建；下一步是「部署」' })
        await refresh({ silent: true })
      } else {
        flash({ kind: 'err', text: denialHint(result.code ?? '', result.error ?? '创建失败') })
      }
    } finally {
      if (mounted.current) setBusyId(null)
    }
  }, [createDir, createHost, createMode, createName, flash, refresh])

  const openLogs = useCallback(async (instance: AppInstanceView): Promise<void> => {
    setBusyId(instance.id)
    try {
      const result = await apiAppsLogs(instance.id)
      setLogs({
        id: instance.id,
        name: instance.name,
        text: typeof result.text === 'string' ? result.text : '',
      })
    } finally {
      if (mounted.current) setBusyId(null)
    }
  }, [])

  /**
   * 部署。故意单独一条（不走通用 `act`）：要把「启动器是否一起落地」讲清楚 ——
   * 局域网实例的目标电脑上，用户只需要双击那一份 `.cmd`。
   */
  const deploy = useCallback(async (instance: AppInstanceView): Promise<void> => {
    setBusyId(instance.id)
    try {
      const result = await apiAppsDeploy(instance.id)
      if (!result.ok) {
        flash({ kind: 'err', text: denialHint(result.code ?? '', result.error ?? '部署失败') })
        return
      }
      const launcher = result.launcher === true
      if (instance.mode === 'lan') {
        flash(launcher
          ? {
            kind: 'ok',
            text: '已部署到目标电脑（exe + 启动器 + 授权绑定）。在目标机上双击 superlanguage-launch-watch.cmd 即可常驻',
          }
          : {
            kind: 'warn',
            text: '已部署，但启动器没复制成功：' + String(result.launcherError ?? '未知原因'),
          })
      } else {
        flash({ kind: 'ok', text: launcher ? '部署完成（含局域网启动器）' : '部署完成' })
      }
      await refresh({ silent: true })
    } catch (e) {
      flash({ kind: 'err', text: '部署失败：' + (e instanceof Error ? e.message : String(e)) })
    } finally {
      if (mounted.current) setBusyId(null)
    }
  }, [flash, refresh])

  return {
    summary, loading, error, notice, busyId, creating, createName, logs,
    createMode, createHost, createDir,
    setCreating, setCreateName, setCreateMode, setCreateHost, setCreateDir, setLogs,
    refresh, act, deploy, create, openLogs, flash,
  }
}

function LicensePanel(props: { summary: AppsSummary }): React.JSX.Element {
  const { summary } = props
  if (!summary.licensed) {
    return (
      <div className={css.licenseLocked} role="status">
        <div className={css.licenseLockedTitle}>应用托管不可用</div>
        <p className={css.licenseLockedText}>
          {denialHint(summary.code, summary.error || '当前授权不允许托管应用')}
        </p>
        <p className={css.licenseLockedMeta}>
          授权状态：{summary.license?.state ?? 'unknown'}
          {summary.license?.daysToExpiry !== null && summary.license?.daysToExpiry !== undefined
            ? ' · 剩余 ' + String(summary.license.daysToExpiry) + ' 天'
            : ''}
        </p>
      </div>
    )
  }
  const entitlement = summary.entitlement
  return (
    <div className={css.statRow}>
      <div className={css.statCell}>
        <span className={css.statLabel}>席位</span>
        <b className={css.statValue}>{summary.seats.used} / {summary.seats.max}</b>
      </div>
      <div className={css.statCell}>
        <span className={css.statLabel}>运行中</span>
        <b className={css.statValue}>{summary.instances.filter((item) => item.live?.running).length}</b>
      </div>
      <div className={css.statCell}>
        <span className={css.statLabel}>授权到期</span>
        <b className={css.statValue}>
          {summary.license?.expiresAt
            ? new Date(summary.license.expiresAt).toLocaleDateString('zh-CN')
            : '永久'}
        </b>
      </div>
      <div className={css.statCell}>
        <span className={css.statLabel}>授权管道</span>
        <b className={css.statValue} data-ok={summary.broker.running ? 'true' : undefined}>
          {summary.broker.running ? '监听中' : '未启动'}
        </b>
      </div>
      {entitlement !== null && (
        <div className={css.statCell}>
          <span className={css.statLabel}>每小时上限</span>
          <b className={css.statValue}>{entitlement.maxJobsPerHour}</b>
        </div>
      )}
    </div>
  )
}

function InstanceCard(props: {
  instance: AppInstanceView
  summary: AppsSummary
  busy: boolean
  onAct: (id: string, run: () => Promise<{ ok: boolean, error?: string, code?: string }>, success: string) => Promise<void>
  onDeploy: (instance: AppInstanceView) => Promise<void>
  onLogs: (instance: AppInstanceView) => Promise<void>
}): React.JSX.Element {
  const { instance, summary, busy } = props
  const badge = instanceBadge(instance, summary.licensed)
  const entitlementCaps = summary.entitlement?.caps ?? []
  const queue = (instance.live?.details as { queue?: { queued?: number, running?: number, succeeded?: number, failed?: number } } | undefined)?.queue
  const wechat = (instance.live?.details as { wechat?: { running?: boolean, logged_in?: boolean } } | undefined)?.wechat

  const toggleCap = (cap: string, enabled: boolean): void => {
    const next = enabled
      ? [...new Set([...instance.caps, cap])]
      : instance.caps.filter((item) => item !== cap)
    void props.onAct(instance.id, () => apiAppsUpdate({
      id: instance.id,
      patch: { caps: next },
    }), '能力已更新')
  }

  return (
    <article className={css.card} data-disabled={!instance.enabled || undefined}>
      <header className={css.cardHead}>
        <div className={css.cardTitleRow}>
          <h3 className={css.cardTitle}>{instance.name}</h3>
          <Badge tone={badge.tone}>{badge.label}</Badge>
          <span className={css.seat}>席位 {instance.seat}</span>
        </div>
        <div className={css.cardActions}>
          <Button size="sm" variant="outline" disabled={busy || !summary.licensed} onClick={() => {
            void props.onDeploy(instance)
          }}>
            部署
          </Button>
          {instance.live?.running
            ? (
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => {
                void props.onAct(instance.id, () => apiAppsStop(instance.id), '已停止')
              }}>
                停止
              </Button>
            )
            : (
              <Button size="sm" variant="primary" disabled={busy || !summary.licensed} onClick={() => {
                void props.onAct(instance.id, () => apiAppsStart(instance.id), '已启动')
              }}>
                启动
              </Button>
            )}
          <Button size="sm" variant="ghost" disabled={busy || !summary.licensed} onClick={() => {
            void props.onAct(instance.id, () => apiAppsRestart(instance.id), '已重启')
          }}>
            重启
          </Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => { void props.onLogs(instance) }}>
            日志
          </Button>
          {instance.mode === 'lan' && (
            <Button
              size="sm"
              variant="outline"
              disabled={busy || !summary.licensed}
              title="局域网实例的票据由本机推送；这里可以立即补推一次，不必等续期周期"
              onClick={() => {
                void props.onAct(instance.id, () => apiAppsPushTicket(instance.id), '票据已推送')
              }}
            >
              推送票据
            </Button>
          )}
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => {
            void apiAppsOpenDir(instance.id)
          }}>
            目录
          </Button>
          <Button size="sm" variant="danger" disabled={busy} onClick={() => {
            void props.onAct(instance.id, () => apiAppsRemove(instance.id), '实例已删除（队列数据保留）')
          }}>
            删除
          </Button>
        </div>
      </header>

      <dl className={css.meta}>
        <div>
          <dt>位置</dt>
          <dd title={instance.dir}>
            {instance.mode === 'lan' ? '局域网 · ' + (instance.host || '未填写 IP') : '本机'}
          </dd>
        </div>
        <div><dt>程序</dt><dd>{instance.exeVersion || '未知版本'}{instance.exeSha256 ? ' · ' + instance.exeSha256.slice(0, 8) : ''}</dd></div>
        <div><dt>最近续期</dt><dd title={fmtLocaleMs(instance.lastLeaseAt)}>{relativeTime(instance.lastLeaseAt)}</dd></div>
        <div><dt>队列</dt><dd>{queue ? String(queue.queued ?? 0) + ' 待发 / ' + String(queue.running ?? 0) + ' 执行中' : '—'}</dd></div>
        <div><dt>微信</dt><dd>{wechat ? (wechat.logged_in ? '已登录' : wechat.running ? '未登录' : '未运行') : '—'}</dd></div>
        <div><dt>令牌</dt><dd>{instance.live?.tokenMasked || '未部署'}</dd></div>
      </dl>

      {instance.lastError !== '' && (
        <p className={css.lastError} title={instance.lastError}>{instance.lastError}</p>
      )}

      <div className={css.capsRow}>
        <span className={css.capsLabel}>能力</span>
        {entitlementCaps.length === 0 && <span className={css.muted}>许可证未开放任何能力</span>}
        {entitlementCaps.map((cap) => {
          const checked = instance.caps.includes(cap)
          return (
            <label key={cap} className={css.capCheck}>
              <input
                type="checkbox"
                checked={checked}
                disabled={busy || !summary.licensed}
                onChange={(event) => { toggleCap(cap, event.target.checked) }}
              />
              <span>{CAP_LABELS[cap] ?? cap}</span>
            </label>
          )
        })}
        <Button size="sm" variant="ghost" disabled={busy || !summary.licensed} onClick={() => {
          void props.onAct(instance.id, () => apiAppsSeedCaps(instance.id), '能力已按许可证重新对齐')
        }}>
          按授权重置
        </Button>
        <span className={css.quota}>每小时上限 {instance.maxJobsPerHour}</span>
      </div>
    </article>
  )
}

export function AppsHostPanel(): React.JSX.Element {
  const host = useAppsHost()
  const instances = host.summary.instances
  const noticeClass = host.notice === null
    ? ''
    : host.notice.kind === 'ok'
      ? css.noticeOk
      : host.notice.kind === 'warn'
        ? css.noticeWarn
        : css.noticeErr

  const runningCount = useMemo(
    () => instances.filter((item) => item.live?.running).length,
    [instances],
  )

  return (
    <section className={css.root}>
      <PanelHeader
        title="应用托管"
        actions={(
          <div className={css.headActions}>
            <Button size="sm" variant="outline" onClick={() => { void host.refresh() }} disabled={host.loading}>
              {host.loading ? '刷新中…' : '刷新'}
            </Button>
            <Button
              size="sm"
              variant="primary"
              disabled={!host.summary.licensed || host.summary.seats.used >= host.summary.seats.max}
              title={!host.summary.licensed
                ? denialHint(host.summary.code, host.summary.error)
                : host.summary.seats.used >= host.summary.seats.max
                  ? '席位已用满，请先释放一个实例'
                  : '新建一个 SuperLanguage 实例'}
              onClick={() => { host.setCreating(true) }}
            >
              新增实例
            </Button>
          </div>
        )}
      />

      {host.notice !== null && (
        <div className={`${css.notice} ${noticeClass}`} role={host.notice.kind === 'err' ? 'alert' : 'status'}>
          {host.notice.text}
        </div>
      )}

      <LicensePanel summary={host.summary} />

      {host.summary.ok && host.summary.sourceExe === '' && (
        <div className={`${css.notice} ${css.noticeWarn}`} role="status">
          未找到 SuperLanguage.exe。开发环境请先运行 <code>apps/superlanguage/build.bat</code>
          ，发布包应把它放在 <code>resources/apps/superlanguage/</code>。
        </div>
      )}

      <Toolbar
        left={(
          <span className={css.muted}>
            {instances.length} 个实例 · {runningCount} 个运行中
            {host.summary.license?.licenseId ? ' · 证书 ' + host.summary.license.licenseId.slice(0, 8) : ''}
          </span>
        )}
      />

      {host.error !== '' && (
        <ErrorState message="读取应用托管状态失败" detail={host.error} onRetry={() => { void host.refresh() }} />
      )}

      {host.loading && instances.length === 0 ? (
        <LoadingState label="读取实例清单…" />
      ) : instances.length === 0 ? (
        <EmptyState
          icon="🧩"
          title="还没有托管的实例"
          action={(
            <Button
              size="sm"
              variant="primary"
              disabled={!host.summary.licensed}
              onClick={() => { host.setCreating(true) }}
            >
              新建第一个实例
            </Button>
          )}
        />
      ) : (
        <div className={css.list}>
          {instances.map((instance) => (
            <InstanceCard
              key={instance.id}
              instance={instance}
              summary={host.summary}
              busy={host.busyId === instance.id}
              onAct={host.act}
              onDeploy={host.deploy}
              onLogs={host.openLogs}
            />
          ))}
        </div>
      )}

      <Dialog
        open={host.creating}
        onClose={() => { host.setCreating(false) }}
        title="新建托管实例"
        footer={(
          <div className={css.dialogFooter}>
            <Button size="sm" variant="ghost" onClick={() => { host.setCreating(false) }}>取消</Button>
            <Button
              size="sm"
              variant="primary"
              disabled={host.busyId === 'create' || host.createName.trim() === ''}
              onClick={() => { void host.create() }}
            >
              {host.busyId === 'create' ? '创建中…' : '创建'}
            </Button>
          </div>
        )}
      >
        <label className={css.field}>
          <span>实例名称</span>
          <input
            className={css.input}
            value={host.createName}
            maxLength={40}
            placeholder="例如：客服号 A / 营销号 B"
            onChange={(event) => { host.setCreateName(event.target.value) }}
            onKeyDown={(event) => { if (event.key === 'Enter') void host.create() }}
          />
        </label>
        <label className={css.field}>
          <span>部署位置</span>
          <select
            className={css.input}
            value={host.createMode}
            onChange={(event) => { host.setCreateMode(event.target.value === 'lan' ? 'lan' : 'local') }}
          >
            <option value="local">本机（这台电脑上的微信）</option>
            <option value="lan">局域网另一台电脑</option>
          </select>
          <span className={css.hint}>
            {host.createMode === 'lan'
              ? '跨机实例：exe 复制到目标电脑的共享目录；票据由本机推送（走局域网 HTTP），目标电脑需允许共享写入。'
              : '本机实例：目录在本机，票据走本机命名管道（最安全）。'}
          </span>
        </label>
        {host.createMode === 'lan' && (
          <>
            <label className={css.field}>
              <span>目标电脑 IPv4</span>
              <input
                className={css.input}
                value={host.createHost}
                placeholder="例如：192.168.1.20"
                onChange={(event) => { host.setCreateHost(event.target.value) }}
              />
            </label>
            <label className={css.field}>
              <span>目标电脑上的共享目录</span>
              <input
                className={css.input}
                value={host.createDir}
                placeholder="\\\\PC-B\\SuperTimeApps\\inst-客服A"
                onChange={(event) => { host.setCreateDir(event.target.value) }}
              />
              <span className={css.hint}>
                只给运行账号读写；部署会把 SuperLanguage.exe 与授权绑定写进这个目录。
                目标电脑上要跑一次启动器（见「应用托管」页底说明），本机才能远程拉起实例。
              </span>
            </label>
          </>
        )}
        <p className={css.hint}>
          创建只会登记席位与目录；点击「部署」后才复制程序并写入授权绑定。
        </p>
      </Dialog>

      <Drawer
        open={host.logs !== null}
        onClose={() => { host.setLogs(null) }}
        title={host.logs === null ? '实例日志' : host.logs.name + ' · 日志'}
        width={720}
      >
        <pre className={css.logBox}>{host.logs?.text || '（暂无日志）'}</pre>
      </Drawer>
    </section>
  )
}
