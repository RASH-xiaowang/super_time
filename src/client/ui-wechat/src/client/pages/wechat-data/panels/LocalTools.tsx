/**
 * 本地工具（2026-11-24）。
 *
 * 本项目能「被调用」的工具都在这一页：微信数据检索（问答用）、AI 回复可调用的工具、
 * 出网触发通道（RPA 厂商）、本机能力（转写 / OCR / 读图 / 索引 / 解密 / 导出 / 备份），
 * 以及**用户自己建的**自定义工具。
 *
 * ## 为什么清单来自后端
 *
 * 每个工具都有自己的注册表（`query/tools/registry.ts`、`query/reply-tools/registry.ts`、
 * `query/rpa/registry.ts`），自定义工具住在 `tool_custom` 表。清单由后端**现算**，
 * 所以新增/停用/删除之后，卡片与「问答链路真正拿到的工具集」永远是同一份数据 ——
 * 不需要改前端，也不会出现「README 写了、界面没有」那种两套事实。
 *
 * ## 可写性的边界（按钮就按这个画）
 *
 *   · 默认工具（代码定义）：**不能删**，只能停用与改说明 —— 执行体是代码，界面改不了。
 *   · 自定义工具（数据定义）：可增可删可改，执行方式是两种模板（预设封装 / 固定回答）。
 *   · 出网通道 / 本机能力：不给启停 —— 前者在任务信息里配地址与凭据，后者是按钮背后的一次调用。
 *
 * ## 为什么卡片里要显示「调用名 + 参数 + 源文件」
 *
 * 这一页的读者是**要排查「为什么某个能力没生效」的人**：调用名能对上日志 / 模型输出，
 * 参数能看出必填项，源文件能直接跳过去改。只写一句中文说明的卡片帮不上忙。
 */
import { useCallback, useMemo, useState } from 'react'
import { apiDeleteLocalTool, apiGetLocalTools, apiSetLocalToolEnabled } from '../api.ts'
import type { LocalToolsSnapshot, LocalToolGroupId, LocalToolItem } from '@deepseek-ai/dsh-wechat-data/types'
import { useFreshData } from './use-fresh-data.ts'
import { EmptyState, ErrorState, LoadingState, SearchInput, Segmented, Toolbar } from '../ui/kit.tsx'
import { useConfirm } from '../ui/confirm.tsx'
import { useTransientNotice, useWechatDataUpdated } from './hooks.tsx'
import { LocalToolEditor, type AliasTarget } from './local-tool-editor.tsx'
import { LocalToolConfigDrawer } from './local-tool-config.tsx'
import kitCss from '../ui/kit.module.css'
import css from './local-tools.module.css'

type GroupFilter = 'all' | LocalToolGroupId

/** 卡片底部动作（按可写性出现；默认工具没有「删除」）。 */
function CardActions({ item, onEdit, onToggle, onDelete, onConfigure }: {
  item: LocalToolItem
  onEdit: () => void
  onToggle: () => void
  onDelete: () => void
  /** 该工具有额外配置项时（目前只有天气与网页搜索），给一个直达入口。 */
  onConfigure?: () => void
}): React.JSX.Element {
  return (
    <span className={css.actions}>
      {onConfigure !== undefined && (
        <button type="button" className={css.actBtn} data-primary="true" onClick={onConfigure}>配置</button>
      )}
      <button type="button" className={css.actBtn} onClick={onToggle}>
        {item.enabled ? '停用' : '启用'}
      </button>
      {!item.builtin && (
        <>
          <button type="button" className={css.actBtn} onClick={onEdit}>编辑</button>
          <button type="button" className={css.actBtn} data-danger="true" onClick={onDelete}>删除</button>
        </>
      )}
    </span>
  )
}

/** 哪些工具有额外配置项（与后端 `saveLocalToolConfig` 支持的字段一一对应）。 */
const CONFIGURABLE: Readonly<Record<string, 'weather' | 'search'>> = {
  weather: 'weather',
  search_web: 'search',
}

/** 一张工具卡片。 */
function ToolCard({ item, onEdit, onToggle, onDelete, onConfigure }: {
  item: LocalToolItem
  onEdit: () => void
  onToggle: () => void
  onDelete: () => void
  onConfigure?: () => void
}): React.JSX.Element {
  const params = item.params
  return (
    <article className={css.card} data-tool-id={item.id} data-group={item.group} data-status={item.status} data-disabled={item.enabled ? undefined : 'true'}>
      <header className={css.head}>
        <span className={css.name}>{item.name}</span>
        {item.online && <span className={css.chip} data-kind="online" title="这次调用会访问网络">出网</span>}
        <span className={css.chip} data-kind={item.enabled ? item.status : 'needs-config'}>
          {!item.enabled ? '已停用' : item.status === 'ready' ? '可用' : '待配置'}
        </span>
        {!item.builtin && <span className={css.chip} data-kind="custom" title="用户自定义工具">自定义</span>}
      </header>
      {item.callName !== undefined && <code className={css.call} title="模型/接口里的调用名">{item.callName}</code>}
      {item.statusNote !== undefined && <p className={css.note}>⚠ {item.statusNote}</p>}
      {params.length > 0 && (
        <div className={css.params} aria-label={`${item.name} 的参数`}>
          {params.map((param) => (
            <span key={param.name} className={css.param} data-required={param.required || undefined}
              title={[param.type, param.required ? '必填' : '可选', param.note ?? ''].filter((part) => part !== '').join(' · ')}>
              {param.name}
              {param.required ? '*' : ''}
            </span>
          ))}
        </div>
      )}
      <footer className={css.foot}>
        <span className={css.source} title={item.source}>{item.source.replace('src/backend/wechat-data/src/', '')}</span>
        <CardActions item={item} onEdit={onEdit} onToggle={onToggle} onDelete={onDelete} {...(onConfigure === undefined ? {} : { onConfigure })} />
      </footer>
    </article>
  )
}

/**
 * 本地工具面板。
 * @returns 工具条 + 卡片网格 + 新建/编辑抽屉。
 */
export function LocalToolsPanel(): React.JSX.Element {
  const load = useCallback((): Promise<LocalToolsSnapshot> => apiGetLocalTools(), [])
  const { data, loading, error, reload } = useFreshData<LocalToolsSnapshot>('local-tools', load)
  // 回复工具的就绪状态跟着本机配置走：设置里改完天气/搜索，回来这张卡就该变。
  useWechatDataUpdated(() => { void reload() })
  const confirm = useConfirm()
  // 提示语自动消失（L20）：面板里不许再手写 setTimeout 管提示。
  const { notice, flash } = useTransientNotice()
  const [search, setSearch] = useState('')
  const [group, setGroup] = useState<GroupFilter>('all')
  /** `undefined` = 关闭；`null` = 新建；否则 = 编辑这条。 */
  const [editing, setEditing] = useState<LocalToolItem | null | undefined>(undefined)
  /** 配置抽屉：`undefined` = 关闭；否则是打开时聚焦的那一段。 */
  const [configuring, setConfiguring] = useState<'weather' | 'search' | undefined>(undefined)

  const items = data?.items ?? []
  const query = search.trim().toLowerCase()
  const filtered = useMemo(() => {
    return items.filter((item) => {
      if (group !== 'all' && item.group !== group) return false
      if (query === '') return true
      return item.name.toLowerCase().includes(query)
        || (item.callName ?? '').toLowerCase().includes(query)
        || item.summary.toLowerCase().includes(query)
        || item.description.toLowerCase().includes(query)
    })
  }, [items, group, query])

  /** 可被封装的内置检索工具（自定义 alias 的目标）。 */
  const targets = useMemo<AliasTarget[]>(() => items
    .filter((item) => item.builtin && item.group === 'retrieval' && item.enabled && item.callName !== undefined)
    .map((item) => ({ name: item.callName as string, label: item.name, params: item.params })), [items])

  /** 已被占用的调用名（内置 + 自定义）：自动生成与重复校验都看它。 */
  const takenNames = useMemo(() => new Set(items.map((item) => item.callName).filter((name): name is string => name !== undefined)), [items])

  const groups = data?.groups ?? []
  const counts = useMemo(() => {
    const map = new Map<LocalToolGroupId, number>()
    for (const item of items) map.set(item.group, (map.get(item.group) ?? 0) + 1)
    return map
  }, [items])

  const toggle = async (item: LocalToolItem): Promise<void> => {
    const name = item.callName ?? ''
    try {
      const result = await apiSetLocalToolEnabled({ name, enabled: !item.enabled })
      if (!result.ok) { flash(result.error ?? '操作失败'); return }
      flash(item.enabled ? `已停用「${item.name}」，问答链路不再提供它` : `已启用「${item.name}」`)
      await reload()
    } catch (e) {
      flash((e as Error).message)
    }
  }

  const remove = async (item: LocalToolItem): Promise<void> => {
    const ok = await confirm({
      title: `删除工具「${item.name}」？`,
      message: '删除后它不再出现在任何链路的工具集里。默认工具不能删除，只能停用。',
      tone: 'danger',
    })
    if (!ok) return
    try {
      const result = await apiDeleteLocalTool({ name: item.callName ?? '' })
      if (!result.ok) { flash(result.error ?? '删除失败'); return }
      flash(`已删除「${item.name}」`)
      await reload()
    } catch (e) {
      flash((e as Error).message)
    }
  }

  return (
    <div className={css.panel}>
      <Toolbar
        left={(
          <>
            <SearchInput
              className={css.searchGrow}
              value={search}
              onChange={setSearch}
              placeholder="搜索工具名 / 调用名 / 说明"
              ariaLabel="搜索本地工具"
            />
            <span className={kitCss.textCaption}>
              {loading && data === null ? '读取中…' : `共 ${String(items.length)} 个工具 · 显示 ${String(filtered.length)} 个`}
            </span>
          </>
        )}
        right={(
          <span className={css.toolbarRight}>
            <Segmented
              value={group}
              onChange={(value) => { setGroup(value as GroupFilter) }}
              ariaLabel="工具分组"
              options={[
                { value: 'all', label: `全部 (${String(items.length)})` },
                ...groups.map((meta) => ({
                  value: meta.id,
                  label: `${meta.label} (${String(counts.get(meta.id) ?? 0)})`,
                })),
              ]}
            />
            <button type="button" className={css.btn} data-primary="true" onClick={() => { flash(''); setEditing(null) }}>
              ＋ 新建工具
            </button>
          </span>
        )}
      />

      {notice && <div className={css.notice} role="status">{notice}</div>}
      {error !== null && error !== '' && <div className={kitCss.error} role="alert">工具清单读取失败：{error}</div>}
      {loading && data === null && <LoadingState variant="compact" label="读取工具清单…" />}

      {data !== null && (
        <div className={css.grid}>
          {filtered.length === 0 ? (
            <div className={css.emptyWrap}>
              <EmptyState
                icon="🧰"
                title="没有匹配的工具"
                desc={query === '' ? '这个分组下暂时没有工具。' : '换个关键词，或把分组切回「全部」再试。'}
              />
            </div>
          ) : (
            filtered.map((item) => {
              const section = item.callName === undefined ? undefined : CONFIGURABLE[item.callName]
              return (
                <ToolCard
                  key={item.id}
                  item={item}
                  onEdit={() => { flash(''); setEditing(item) }}
                  onToggle={() => { void toggle(item) }}
                  onDelete={() => { void remove(item) }}
                  {...(section === undefined ? {} : { onConfigure: () => { flash(''); setConfiguring(section) } })}
                />
              )
            })
          )}
        </div>
      )}

      {data === null && !loading && error === '' && (
        <ErrorState message="拿不到工具清单（后端可能还在启动）" />
      )}

      <LocalToolEditor
        open={editing !== undefined}
        item={editing ?? null}
        targets={targets}
        taken={takenNames}
        onClose={() => { setEditing(undefined) }}
        onSaved={(item) => { flash(`已保存「${item.name}」，下一次提问就能用它`); void reload() }}
      />

      <LocalToolConfigDrawer
        open={configuring !== undefined}
        {...(configuring === undefined ? {} : { focus: configuring })}
        onClose={() => { setConfiguring(undefined) }}
        onSaved={() => { flash('配置已保存，工具卡片状态已更新'); void reload() }}
      />
    </div>
  )
}
