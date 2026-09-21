/**
 * 「知识库 · 文件」右栏详情（`KbFilesPanel` 的子视图，M21 拆分）。
 *
 * 从 `KbFiles.tsx` 原样搬出，**行为逐字节不变**：出网开关、摘要覆盖范围、
 * 就地展开的正文、明细清单都在这里；状态与取数仍由容器 `kb-files-panel.tsx` 持有,
 * 本模块只收道具、只渲染。文案与判据一条都没改 —— 相关的接线守卫
 * （`kb-files.wiring.spec.ts`）读的是「桶 + 面板 + 本模块」的联合，断言未放宽。
 *
 * 为什么摘要的覆盖范围必须写出来：只喂了前 8,000 字却标成「摘要」，会让人把
 * 一份长文件的局部概括当成整份的结论引用出去。
 * @module kb-files-detail
 */
import clsx from 'clsx'
import { Badge, Button, Card, EmptyState } from '../ui/kit.tsx'
import type { KbFileChunk, KbFileMeta } from '../types.ts'
import { PARSE_LOOK, formatBytes, headingWorthShowing } from './kb-files-support.tsx'
import { formatRelative } from './kb-model.ts'
import kitCss from '../ui/kit.module.css'
import css from './kbfiles.module.css'

/** 正文阅读区的状态（容器持有，这里只渲染）。 */
export interface KbFileReaderState {
  fileId: number
  items: KbFileChunk[]
  total: number
  totalChars: number
  loading: boolean
  error: string | null
}

/** 右栏详情的道具。回调都是容器里那几个 useCallback 的原样，语义未变。 */
export interface KbFileDetailPaneProps {
  /** 列表为空时整块被样式表隐藏（这里只负责把类名挂上）。 */
  hidden: boolean
  loading: boolean
  selected: KbFileMeta | null
  busyId: number | null
  busySummaryId: number | null
  summaryError: string | null
  reader: KbFileReaderState | null
  /** 相对时间的基准（容器随每次加载更新，避免滚动时时间自己跳）。 */
  now: number
  onSummarize: (f: KbFileMeta) => void
  onChunks: (fileId: number) => void
  onCloseReader: () => void
  onReveal: (f: KbFileMeta) => void
  onRemove: (f: KbFileMeta) => void
  onMoreReader: () => void
  onToggleRag: (f: KbFileMeta, next: boolean) => void
}

export function KbFileDetailPane({
  hidden, loading, selected, busyId, busySummaryId, summaryError, reader, now,
  onSummarize, onChunks, onCloseReader, onReveal, onRemove, onMoreReader, onToggleRag,
}: KbFileDetailPaneProps): React.JSX.Element {
  /**
   * 摘要三字段的归一化。
   *
   * 必须在这里兜一次而不是直接用 `selected.summary`：文件列表是**渲染缓存**的
   * （`readRenderCache`），而缓存里可能存着这次改动之前写下的旧形状 —— 那三列
   * 在类型上是必填的，运行期却是 `undefined`。直接判 `!== ''` 会把 `undefined`
   * 当成「有摘要」渲染出一个空壳，而对 `undefined` 调 `.toLocaleString()` 会让
   * 整个详情区崩掉。
   */
  const summaryText = selected?.summary ?? ''
  const summaryModel = selected?.summaryModel ?? ''
  const summaryAt = selected?.summaryAt ?? 0
  const summaryCovered = selected?.summaryCoveredChars ?? 0
  /*
   * 右：详情。列表为空时整块被 detailPaneHidden 隐藏（见样式表），
   * 所以这里还能渲染出来的空态只可能是「有列表但还没选中」。
   * ⚠️ 别改用 `data-*` 标记：kit 的 Card 只接受 title/extra/footer/children/
   * flush/className，**不会把额外 props 透传到 DOM**，写了会被静默丢掉。
   */
  return (
    <Card className={clsx(css.detailPane, hidden && css.detailPaneHidden)}>
      {selected ? (
        <div className={css.detail}>
          <div className={css.detailHead}>
            <h3 className={css.detailTitle}>{selected.name}</h3>
            <div className={css.detailActions}>
              {/* 摘要会出网，所以它的可用性直接跟着那个文件级开关走：
                  关掉「参与语义检索（会出网）」的文件，内容不得离开本机 ——
                  这里禁用并写明原因，而不是让人点下去拿一条后端错误。
                  真正的判定仍在后端（两处各判一套迟早不一致，而不一致的方向
                  一定是界面比后端宽松）。 */}
              <Button
                variant="pill"
                onClick={() => { void onSummarize(selected) }}
                disabled={busySummaryId === selected.id || !selected.includeInRag}
                title={selected.includeInRag
                  ? '把这份文件的前若干字正文发给你配置的模型，换回一段要点（会出网）'
                  : '该文件已关闭「参与语义检索（会出网）」，按此设置它的内容不得离开本机，因此不能生成摘要'}
              >
                {busySummaryId === selected.id ? '生成中…' : summaryText === '' ? '生成摘要' : '重新生成'}
              </Button>
              {/* 默认就是展开的，所以这个按钮的常态是「收起」。**不设 disabled**：
                  读取途中用户也应该能把它关掉，而不是被锁在等待里。
                  加载状态由阅读区自己说（见下面的 readerLoading 一行）。 */}
              <Button
                variant="pill"
                onClick={() => { if (reader === null) void onChunks(selected.id); else onCloseReader() }}
              >
                {reader === null ? '查看正文' : '收起正文'}
              </Button>
              <Button variant="pill" onClick={() => { void onReveal(selected) }}>在资源管理器中定位</Button>
              <Button
                variant="danger"
                disabled={busyId === selected.id}
                onClick={() => { void onRemove(selected) }}
              >
                {busyId === selected.id ? '处理中…' : '移除'}
              </Button>
            </div>
          </div>

          <div className={css.detailMeta}>
            <Badge tone={PARSE_LOOK[selected.parseState].tone}>{PARSE_LOOK[selected.parseState].label}</Badge>
            <span>加入于 {formatRelative(selected.createdAt, now)}</span>
            {selected.updatedAt !== selected.createdAt
              ? <span>更新于 {formatRelative(selected.updatedAt, now)}</span>
              : null}
          </div>

          {/* 解析结论：三档颜色分别对应「已就绪 / 要留意 / 出错」。
              `unsupported` 与 `failed` 的文案不同、颜色也不同（见文件头注 ②）。 */}
          <div
            className={
              selected.parseState === 'failed' ? css.hintBad
                : selected.parseState === 'unsupported' || selected.parseState === 'sparse_only' ? css.hintWarn
                  : selected.parseState === 'ready' ? css.hintOk
                    : css.hintNote
            }
          >
            {PARSE_LOOK[selected.parseState].hint}
          </div>
          {/* 后端给的原文原因（不可用原因 / 降级说明）。它与上面那句是**两层**：
              上面是「这个状态意味着什么」，这里是「这一次具体为什么」。 */}
          {selected.parseError ? <div className={css.hintNote}>说明：{selected.parseError}</div> : null}

          {/* 出网开关。这是全应用里唯一按文件粒度的出网控制，所以要说清
              「关掉 ≠ 搜不到」——否则用户会以为关掉就等于把文件踢出知识库。 */}
          <div className={css.switchRow}>
            <input
              id={`kb-file-rag-${selected.id}`}
              className={css.switchBox}
              type="checkbox"
              role="switch"
              checked={selected.includeInRag}
              disabled={busyId === selected.id}
              onChange={(e) => { void onToggleRag(selected, e.target.checked) }}
            />
            <label className={css.switchText} htmlFor={`kb-file-rag-${selected.id}`}>
              <span className={css.switchTitle}>参与语义检索（会出网）</span>
              <span className={css.switchDesc}>
                打开后，这个文件的文本块可能被发到模型服务做向量；关掉它就完全不出网。
                两种情况下都仍然能被关键词搜到，只是关掉后不再参与「意思相近」的检索。
                设置里的「禁止 AI 出网」是同一道闸门，开着时这里即使打开也不会出网。
              </span>
            </label>
          </div>

          <div className={css.divider} />

          {/* 摘要（模型生成，会出网）。放在正文之前：先看结论再看原文。
              没有摘要且没出过时整块不渲染 —— 入口就是上面那个按钮，
              再摆一个空壳只会让详情区多一段没信息量的字。 */}
          {(summaryText !== '' || summaryError !== null) && (
            <div className={css.summary}>
              <div className={css.summaryHd}>
                <span>摘要</span>
                {summaryText !== '' && (
                  <span className={css.summaryMeta}>
                    {summaryModel !== '' ? `${summaryModel} · ` : ''}
                    {summaryAt > 0 ? formatRelative(summaryAt, now) : '时间未记录'}
                    {/* 覆盖范围必须写出来：只喂了前 8,000 字却标成「摘要」，
                        会让人把一份长文件的局部概括当成整份的结论。 */}
                    {summaryCovered > 0 && summaryCovered < selected.charCount
                      ? ` · 基于前 ${summaryCovered.toLocaleString('zh-CN')} 字（全文 ${selected.charCount.toLocaleString('zh-CN')} 字）`
                      : summaryCovered > 0 ? ' · 覆盖全文' : ''}
                  </span>
                )}
              </div>
              {summaryError && <div className={kitCss.error} role="alert">⚠️ {summaryError}</div>}
              {summaryText !== ''
                ? <p className={css.summaryText}>{summaryText}</p>
                : <p className={css.summaryEmpty}>没有生成成功，原因见上。这份文件的内容没有被改动过。</p>}
            </div>
          )}

          {/* 就地展开的正文。放在「明细」之前：想读内容的人不会想先看完指纹和路径。 */}
          {reader !== null && reader.fileId === selected.id && (
            <div className={css.reader}>
              <div className={css.readerHd}>
                <span>正文</span>
                <span className={css.readerMeta}>
                  已读 {reader.items.length} / {reader.total} 块 · {reader.totalChars.toLocaleString('zh-CN')} 字
                </span>
              </div>
              {/* 必须说清看的是什么：这是解析出来的文本，也就是「问答」和「正文检索」
                  实际读到的东西；表格、图片、页眉页脚在解析阶段已经丢掉。
                  不说这句，用户会拿它当原稿核对，而两者可以给出不同的结论。 */}
              <p className={css.readerNote}>
                这是解析出来的文本，也就是问答与正文检索实际读到的内容 ——
                表格、图片与页眉页脚在解析时已经丢掉。要核对原稿请用「在资源管理器中定位」。
              </p>
              {reader.error && <div className={kitCss.error} role="alert">{reader.error}</div>}
              {reader.loading && reader.items.length === 0 && (
                <div className={css.readerLoading} role="status">读取正文…</div>
              )}
              {reader.items.length === 0 && !reader.loading && reader.error === null && (
                <div className={css.readerEmpty}>
                  这个文件还没有正文块 —— 解析没成功或还在排队时，展开就是空的。
                </div>
              )}
              <div className={css.readerBody}>
                {reader.items.map(c => (
                  <div key={c.ordinal} className={css.chunk}>
                    {(headingWorthShowing(c.heading) || c.page > 0) && (
                      <div className={css.chunkMeta}>
                        {c.page > 0 ? <span>第 {c.page} 页</span> : null}
                        {headingWorthShowing(c.heading) ? <span>{c.heading}</span> : null}
                      </div>
                    )}
                    <p className={css.chunkText}>{c.text}</p>
                  </div>
                ))}
              </div>
              {reader.items.length < reader.total && (
                <Button variant="pill" onClick={() => { void onMoreReader() }} disabled={reader.loading}>
                  {reader.loading ? '读取中…' : `继续加载（还有 ${reader.total - reader.items.length} 块）`}
                </Button>
              )}
            </div>
          )}

          <div className={css.sectionLabel}>明细</div>
          <dl className={css.kv}>
            <dt className={css.kvKey}>大小</dt>
            <dd className={css.kvVal}>{formatBytes(selected.sizeBytes)}（{selected.sizeBytes.toLocaleString('zh-CN')} 字节）</dd>
            <dt className={css.kvKey}>文本块</dt>
            <dd className={css.kvVal}>
              {selected.chunkCount} 块{selected.charCount > 0 ? ` · ${selected.charCount.toLocaleString('zh-CN')} 字` : ''}
            </dd>
            <dt className={css.kvKey}>解析器</dt>
            <dd className={css.kvVal}>{selected.parser || '（尚未使用）'}</dd>
            <dt className={css.kvKey}>内容指纹</dt>
            <dd className={clsx(css.kvVal, css.mono)} title={selected.sha256}>{selected.sha256 || '（空）'}</dd>
            <dt className={css.kvKey}>原始路径</dt>
            {/* 只登记、从不变动：这句话要跟路径放在一起，看路径的人才会放心。 */}
            <dd className={clsx(css.kvVal, css.mono)} title={selected.srcPath}>
              {selected.srcPath || '（空）'}
              <div className={css.hintNote}>仅登记，不会被修改或删除。</div>
            </dd>
          </dl>
        </div>
      ) : loading ? null : (
        <EmptyState
          icon="📄"
          title="选一个文件看详情"
          desc="点左侧任意文件，解析状态、文本块数、是否出网与原始路径会显示在这里。"
        />
      )}
    </Card>
  )
}
