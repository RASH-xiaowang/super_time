/**
 * 「本库模型」弹层 —— 三个角色各自可覆盖（`docs/KB-MODEL-CONFIG.md` §5.2）。
 *
 * 为什么不塞进 `KbRail.tsx`：那个文件已经在管列表、菜单、新建、重命名、删除五件事，
 * 再加一个带三次远程读取 + 轮询的表单会让「谁负责什么」糊掉。这里单独一个组件，
 * rail 只负责决定「什么时候把它打开」。
 *
 * 三条界面纪律：
 *   ① **代价写在保存前**：换嵌入模型会让本库已建的向量作废重算（= 再次出网、再次花 token），
 *      那句话必须出现在用户点保存之前，而不是之后弹一个「已重建」；
 *   ② **引用串与生效值同时显示**：只给一个模型名，用户看不出这个库是跟着全局走还是自己指定了；
 *   ③ **不写凭据**：这里只能改「用哪个模型名」，端点与 Key 永远在「数据配置 → AI 大模型」，
 *      否则就会造出「A 家地址 + B 家模型」这种 401 陷阱的新变体。
 */
import { useCallback, useEffect, useState } from 'react'
import { apiBuildKbVectorIndex, apiExtractKbEntities, apiGetKbModelConfig, apiGetKbVectorIndex, apiSetKbModelConfig } from '../api.ts'
import type { KbModelConfigView, KbVectorIndexView } from '../types.ts'
import { Button, Dialog } from '../ui/kit.tsx'
import { useTransientNotice } from './hooks.tsx'
import { formatRelative } from './kb-model.ts'
import css from './kb-model-dialog.module.css'
import kitCss from '../ui/kit.module.css'

/** 三个角色在界面上的名字与实际字段名的对应。 */
const ROLES: Array<{ key: 'chat' | 'embed' | 'rerank'; label: string; hint: string }> = [
  { key: 'chat', label: '语言模型', hint: '文件摘要与（后续）实体抽取、链接建议用它' },
  { key: 'embed', label: '嵌入模型', hint: '本库向量索引用它 · 换它要重建' },
  { key: 'rerank', label: '重排序模型', hint: '把召回的候选按相关性精排 · 留空则用本地加权' },
]

/** 一行角色的编辑态：'' = 继承全局。 */
type Draft = Record<'chat' | 'embed' | 'rerank', string>

/** 从 `m:<名>` 拆出裸模型名（界面输入框里不该让用户看见前缀）。 */
function inlineName(ref: string): string {
  return ref.startsWith('m:') ? ref.slice(2) : ''
}

/**
 * @param props - 目标库与关闭回调。
 * @returns 弹层元素。
 */
export function KbModelDialog({ kbId, kbName, onClose }: {
  kbId: number
  kbName: string
  onClose: () => void
}): React.JSX.Element {
  const [cfg, setCfg] = useState<KbModelConfigView | null>(null)
  const [idx, setIdx] = useState<KbVectorIndexView | null>(null)
  const [draft, setDraft] = useState<Draft>({ chat: '', embed: '', rerank: '' })
  const [busy, setBusy] = useState(false)
  const [indexing, setIndexing] = useState(false)
  const [extracting, setExtracting] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  // 成功回执走公共 hook（自己写 setTimeout 清位的做法已被门禁挡下：
  // 卸载后仍会触发一次 setState，且各面板的停留时长会漂）。
  const { notice, flash } = useTransientNotice()

  const load = useCallback(async (): Promise<void> => {
    try {
      const [c, v] = await Promise.all([apiGetKbModelConfig(kbId), apiGetKbVectorIndex(kbId)])
      setCfg(c)
      setIdx(v)
      setDraft({ chat: inlineName(c.settings.chatRef), embed: inlineName(c.settings.embedRef), rerank: inlineName(c.settings.rerankRef) })
    } catch (e) {
      setErr((e as Error).message)
    }
  }, [kbId])

  useEffect(() => { void load() }, [load])

  // 建索引在飞时跟着轮询进度；停下的判据是**后端的 job 消失**，不是本地按钮态。
  const jobOn = idx?.job ? `${idx.kbId}:${idx.job.done}` : ''
  useEffect(() => {
    if (jobOn === '') return
    const t = setInterval(() => { void apiGetKbVectorIndex(kbId).then(setIdx).catch(() => { /* 下一轮再试 */ }) }, 1500)
    return () => { clearInterval(t) }
  }, [jobOn, kbId])

  const save = useCallback(async (): Promise<void> => {
    setBusy(true)
    setErr(null)
    try {
      const r = await apiSetKbModelConfig(kbId, {
        chatRef: draft.chat.trim() === '' ? '' : `m:${draft.chat.trim()}`,
        embedRef: draft.embed.trim() === '' ? '' : `m:${draft.embed.trim()}`,
        rerankRef: draft.rerank.trim() === '' ? '' : `m:${draft.rerank.trim()}`,
      })
      if (r.ok === false) { setErr(r.error); return }
      flash('已保存。下一次调用本库的模型时生效（不必重启）。')
      await load()
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }, [draft, kbId, load])

  const rebuild = useCallback(async (): Promise<void> => {
    setIndexing(true)
    setErr(null)
    try {
      const r = await apiBuildKbVectorIndex(kbId, true)
      if (!r.ok) setErr(r.error ?? '重建失败')
      else flash(`本库索引已重建：${r.embedded} 块 · ${r.elapsed_ms}ms`)
      setIdx(await apiGetKbVectorIndex(kbId))
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setIndexing(false)
    }
  }, [kbId])

  /**
   * 抽一轮实体（一轮最多 20 个文件，见后端 `extractKbEntities` 的 `limit`）。
   *
   * 抽完必须 `load()` 一次：这一行的文案（还剩几个没抽）来自 `getKbModelConfig`，
   * 而 api 层刚把那一层缓存清掉 —— 不重读就等于操作成功了、界面却纹丝不动。
   */
  const extract = useCallback(async (): Promise<void> => {
    setExtracting(true)
    setErr(null)
    try {
      const r = await apiExtractKbEntities(kbId)
      if (r.error) setErr(r.error)
      // 部分失败是常态（一个文件超时不该让整轮消失），所以失败数单独说，不当成错误横幅
      if (r.files > 0) {
        flash(r.saved > 0
          ? `已抽出 ${r.saved} 条实体 · ${r.files - r.failed.length}/${r.files} 个文件成功`
          : `这一轮没有新增实体 · ${r.files} 个文件`)
      }
      await load()
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setExtracting(false)
    }
  }, [kbId, load])

  /** 换嵌入模型的代价：只有「本库已有向量」且「名字真的变了」才说。 */
  const embedChanged = cfg !== null
    && inlineName(cfg.settings.embedRef) !== draft.embed.trim()
    && (idx?.status.rows ?? 0) > 0

  return (
    <Dialog
      open
      onClose={() => { if (!busy && !indexing && !extracting) onClose() }}
      title={`模型 · ${kbName}`}
      footer={(
        <>
          <Button variant="pill" onClick={() => { onClose() }} disabled={busy}>关闭</Button>
          <Button variant="primary" onClick={() => { void save() }} disabled={busy || cfg === null}>
            {busy ? '保存中…' : '保存'}
          </Button>
        </>
      )}
    >
      <p className={css.lead}>
        这里只改「本库用哪个模型名」。端点与 API Key 仍在
        <strong> 数据配置 → AI 大模型 </strong>
        里统一管理 —— 按库各存一份凭据会拼出「A 家地址 + B 家 Key」那种必然 401 的组合。
      </p>

      {cfg === null && !err && <div className={css.loading}>读取中…</div>}

      {cfg !== null && ROLES.map(role => {
        const resolved = cfg.resolved[role.key]
        const globalName = cfg.global[role.key]
        return (
          <div className={css.row} key={role.key}>
            <div className={css.rowHead}>
              <span className={css.rowLabel}>{role.label}</span>
              <span className={css.rowHint}>{role.hint}</span>
            </div>
            <div className={css.rowBody}>
              <input
                className={css.input}
                value={draft[role.key]}
                placeholder={globalName === '' ? '（全局也没配 · 留空即无）' : `留空 = 继承全局：${globalName}`}
                aria-label={`${role.label}（本库覆盖，留空继承全局）`}
                onChange={e => { setDraft({ ...draft, [role.key]: e.target.value }) }}
              />
              <span className={css.effective} data-src={resolved.source}>
                实际使用：{resolved.model === '' ? '（未配置）' : resolved.model}
                {resolved.source === 'inline' ? ' · 本库指定' : ' · 继承全局'}
              </span>
            </div>
          </div>
        )
      })}

      <div className={css.indexBox}>
        <div className={css.indexHead}>
          <span>语义索引</span>
          <span className={css.indexState} data-ready={idx?.status.ready ? '1' : undefined}>
            {idx === null ? '读取中…' : idx.status.ready
              ? `已建 ${idx.status.rows.toLocaleString('zh-CN')} 块 · ${idx.status.models.join('/')} · ${idx.status.built_at ?? '时间未记录'}`
              : `不可用（${idx.status.staleReason}）· 本库现有 ${(idx.status.models.join('/') || '无')}`}
          </span>
        </div>
        {embedChanged && (
          <p className={css.warn}>
            换了嵌入模型会让本库已建的 {idx?.status.rows.toLocaleString('zh-CN')} 块向量作废：
            旧向量在新模型的向量空间里没有意义，重建会把这批正文<strong>再次发送出网</strong>。
          </p>
        )}
        <div className={css.indexActions}>
          <Button
            variant={idx !== null && !idx.status.ready ? 'primary' : 'pill'}
            onClick={() => { void rebuild() }}
            disabled={indexing || idx?.configured === false}
            title={idx?.configured === false ? '未配置向量模型：先在「数据配置 → AI 大模型」填写' : '清空本库向量并按当前模型重算（会出网）'}
          >
            {indexing ? '重建中…' : '重建本库索引'}
          </Button>
          {idx !== null && !idx.configured && (
            <span className={css.muted}>未配置向量模型，本库只有关键词检索可用。</span>
          )}
        </div>
      </div>

      {cfg !== null && (() => {
        // `?? ` 不是防御性冗余：`apiGetKbModelConfig` 走的是缓存读，命中后若远程失败会
        // 直接回吐**上一次写进去的那份**。那份可能是 P4 之前的形状 —— 类型上 entities 必填、
        // 运行期会缺，不兜就是整个弹层崩在读取失败的那一帧上（与图谱 `docEntities ?? []` 同一取舍）。
        const ent = cfg.entities ?? { ragFiles: 0, pending: 0, entities: 0, model: '' }
        return (
          <div className={css.indexBox}>
            <div className={css.indexHead}>
              <span>实体抽取</span>
              <span className={css.indexState} data-ready={ent.ragFiles > 0 && ent.pending === 0 ? '1' : undefined}>
                {ent.ragFiles === 0
                  ? '没有「参与语义检索」的文件'
                  : ent.entities === 0
                    ? `从未做过（${ent.ragFiles} 个文件可抽）`
                    : `${ent.entities} 条 · ${ent.pending} 个文件还没抽 · ${ent.model || '模型未记录'}${cfg.settings.entitiesAt > 0 ? ` · ${formatRelative(cfg.settings.entitiesAt, Date.now())}` : ''}`}
              </span>
            </div>
            <div className={css.indexActions}>
              <Button
                variant="pill"
                onClick={() => { void extract() }}
                disabled={extracting || cfg.resolved.chat.model === ''}
                title={cfg.resolved.chat.model === '' ? '未配置语言模型：先在「数据配置 → AI 大模型」填写' : '把每个文件的正文发给语言模型抽实体（会出网）· 重跑会覆盖上一个结果'}
              >
                {extracting ? '抽取中…' : '抽取实体'}
              </Button>
              {cfg.resolved.chat.model === '' && (
                <span className={css.muted}>未配置语言模型，抽不了实体；图谱仍会有文件与章节（那两类是本地算出来的）。</span>
              )}
            </div>
          </div>
        )
      })()}

      {notice && <div className={css.notice} role="status">{notice}</div>}
      {err && <div className={kitCss.error} role="alert">⚠️ {err}</div>}
    </Dialog>
  )
}
