/**
 * 单聊的「推荐回复」面板：按当前会话上下文（+ 当前选中的知识库）生成候选回复。
 *
 * 与会话级 AI 面板（`SessionAsk.tsx`）是**姊妹面板**：同一处视觉语言（共用
 * `session-ask.module.css` 的面板外壳与建议卡样式）、同一处挂载位置（消息流右侧第三栏）、
 * 同一个原则 —— **读取范围恒为当前会话**，不跨会话取别处的聊天。
 *
 * 与问答的区别：这里是**一次生成、一次呈现**（不做多轮、不流式），产出物是「可以照着发
 * 的句子」。本应用只读、没有发送微信消息的代码路径，所以唯一的动作是**复制**。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { apiSuggestReplies } from '../api.ts'
import { copyTextToClipboard } from '../utils/misc.ts'
import { Select } from '../ui/kit.tsx'
import { useKbScope } from './kb-scope.ts'
import css from './session-ask.module.css'

/** 面板所需的最小会话信息（与 `WechatSession` 的前缀兼容）。 */
export interface ReplyTarget {
  username: string
  displayName?: string
}

/** `ReplySuggestProps` 的字段说明见各成员注释。 */
export interface ReplySuggestProps {
  /** 目标会话（读取范围就是它）。 */
  target: ReplyTarget
  /** 关闭面板。 */
  onClose: () => void
}

/**
 * Render the per-session「推荐回复」panel.
 * @param props - see `ReplySuggestProps`.
 * @returns panel element tree.
 */
export function ReplySuggest(props: ReplySuggestProps): React.JSX.Element {
  const { target, onClose } = props
  const { kbId: scopeKbId, kbs, readError: kbListError, loading: kbListLoading } = useKbScope()
  /**
   * 知识库选择：默认**跟随应用当前选中的库**，用户在本面板里改过之后就以本地选择为准。
   *
   * 为什么要有这个下拉：推荐回复的依据是「这段对话 + 某个库」，而库的切换器在知识库面板那边 ——
   * 在聊天页里没法换库，用户就只能吃默认那个。`0` = 不用知识库（只按对话给候选）。
   */
  const [kbOverride, setKbOverride] = useState<number | null>(null)
  const kbId = kbOverride ?? scopeKbId
  // 挂载即发一次请求（见下面的 useEffect），所以首帧就是「在取」——初值给 false 的话
  // 首帧会落到「这个会话还没有可用的对话内容」那一支，那是一句假话（SSR 冒烟钉住这条）。
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [replies, setReplies] = useState<string[]>([])
  const [basis, setBasis] = useState<{ messages: number; kb: number; degraded?: string } | null>(null)
  const [copied, setCopied] = useState<number | null>(null)
  const [copyFailed, setCopyFailed] = useState(false)

  const kbName = kbs.find(k => k.id === kbId)?.name ?? ''
  const kbOptions = [
    { value: '0', label: '不用知识库' },
    ...kbs.map(k => ({ value: String(k.id), label: k.name })),
  ]
  /**
   * 下拉触发器在「没有名字可显示」时该说什么。
   *
   * Radix Select 的选项挂在 Portal 里、收起时不挂载，所以触发器只能显示 `Select.Value`
   * 的 placeholder。共享组件给的默认值是「请选择…」，在这里是句含糊话：库列表还在路上、
   * 列表读失败、以及用户确实选了「不用知识库」是三种不同的状态，界面上却长得一样，
   * 而其中「读失败」用户是该做点什么的。分开说（并给出仍然可用的退路）。
   */
  const kbPlaceholder = kbId === 0
    ? '不用知识库'
    : kbListError !== null
      ? '知识库读取失败（可只用这段对话）'
      : kbListLoading ? '读取知识库…' : '请选择知识库'
  /**
   * 触发器实际显示什么，取决于 Radix 能不能拿到「选中项」的文字：选项挂在 Portal 里、
   * 收起时不挂载，所以选中值若不在已挂载的选项里，实测连 placeholder 都不显示，
   * 整个触发器就是一块空白（看不出是没库、在读、还是读失败了）。
   * 因此这里只在「列表里确实有这个库」时才把真值交上去，其余情况一律传空串走 placeholder。
   */
  const kbValue = kbs.some(k => k.id === kbId) ? String(kbId) : ''

  /** 请求世代：切会话/换库/「换一批」都会作废在途请求（过期响应不许写进当前面板）。 */
  const seqRef = useRef(0)

  /** 取一批候选。切会话/换库后也会重取（依赖里都带上了）。 */
  const load = useCallback((): void => {
    const seq = ++seqRef.current
    setLoading(true)
    setError(null)
    setCopied(null)
    setCopyFailed(false)
    void apiSuggestReplies({ username: target.username, kbId })
      .then((r) => {
        if (seq !== seqRef.current) return
        if (!r.ok) {
          setReplies([])
          setBasis(null)
          setError(r.error ?? '生成失败')
          return
        }
        setReplies(r.replies ?? [])
        setBasis({
          messages: r.messageCount ?? 0,
          kb: r.kbSnippetCount ?? 0,
          ...(r.degraded ? { degraded: r.degraded } : {}),
        })
      })
      .catch((e: unknown) => { if (seq === seqRef.current) setError((e as Error).message) })
      .finally(() => { if (seq === seqRef.current) setLoading(false) })
  }, [target.username, kbId])

  useEffect(() => { load() }, [load])

  /**
   * 复制某条候选 —— 等真实结果再改口径。
   *
   * 原先这里是 `void navigator.clipboard.writeText(text)` 后立刻 `setCopied(index)`：
   * `writeText` 是 Promise，被拒时（窗口失焦、权限被挡）界面上仍然显示「已复制」，
   * 而那条 reject 没人接 —— 渲染进程里就多一条未处理的 promise rejection。
   * 共享助手 `copyTextToClipboard` 已经把两条路径（异步 API 与 `execCommand` 兜底）的
   * 失败都收敛成 `false`，所以这里只需要按布尔值说真话。
   */
  const copy = (text: string, index: number): void => {
    const seq = seqRef.current
    setCopyFailed(false)
    void copyTextToClipboard(text).then((ok) => {
      // 期间换过会话或库：这一批候选已经不是当前这批，别把标记打到新的行上
      if (seq !== seqRef.current) return
      if (ok) setCopied(index)
      else setCopyFailed(true)
    })
  }

  return (
    <div className={css.panel} aria-label="推荐回复">
      <div className={css.head}>
        <div className={css.title}>推荐回复</div>
        <div className={css.headActions}>
          <button type="button" className={css.iconBtn} title="换一批" aria-label="换一批"
            disabled={loading} onClick={() => { load() }}>
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 12a9 9 0 1 1-3-6.7" /><path d="M21 4v5h-5" />
            </svg>
          </button>
          <button type="button" className={css.iconBtn} title="关闭推荐回复" aria-label="关闭推荐回复" onClick={onClose}>
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 6 6 18" /><path d="m6 6 12 12" />
            </svg>
          </button>
        </div>
      </div>

      {/* 依据（只读）：说清这次到底看了什么 —— 别笼统写「已参考」 */}
      <div className={css.scopeRow}>
        <span className={css.scopeLabel}>依据</span>
        <span className={css.scopeName} title={target.username}>
          {target.displayName || target.username}{basis ? ` · ${String(basis.messages)} 条对话` : ''}
          {basis && basis.kb > 0 ? ` · 知识库「${kbName}」${String(basis.kb)} 段` : ''}
        </span>
      </div>

      {/* 知识库选择（本面板内生效，不动应用全局作用域） */}
      <div className={css.scopeRow}>
        <span className={css.scopeLabel}>知识库</span>
        <Select
          value={kbValue}
          onChange={(v) => { setKbOverride(Number(v)) }}
          options={kbOptions}
          placeholder={kbPlaceholder}
          ariaLabel="选择知识库（本面板内生效）"
        />
      </div>

      <div className={css.body}>
        {loading && <div className={css.introSub}>正在按这段对话生成候选…</div>}
        {!loading && error !== null && (
          // 与姊妹面板 `SessionAsk` 同一套错误呈现（.error + role="alert"）：
          // 读失败 ≠ 没有条目，所以失败要显式说，而不是落到下面那句「还没有可用的对话内容」。
          <div className={css.error} role="alert">
            {error}
            <br />
            <span className={css.scopeLabel}>（被隐私设置拦下时，去「数据边界与出网」里关掉「禁止 AI 出网」）</span>
          </div>
        )}
        {!loading && error === null && replies.length > 0 && (
          <>
            <div className={css.sugList}>
              {replies.map((r, i) => (
                <div key={`${String(i)}:${r.slice(0, 12)}`} className={css.sugCard}>
                  <span className={css.sugText}>{r}</span>
                  <button type="button" className={css.iconBtn} title="复制这条回复"
                    aria-label={`复制第 ${String(i + 1)} 条回复`} onClick={() => { copy(r, i) }}>
                    {copied === i ? '已复制' : '复制'}
                  </button>
                </div>
              ))}
            </div>
            {copyFailed && (
              <div className={css.error} role="alert">复制失败：剪贴板没有被写入，请手动选中文字后复制</div>
            )}
            <div className={css.introSub}>
              {basis?.degraded ? `${basis.degraded}。` : ''}
              本应用只读，不会替你发消息 —— 复制后到微信里粘贴。
            </div>
          </>
        )}
        {!loading && error === null && replies.length === 0 && (
          <div className={css.introSub}>这个会话还没有可用的对话内容。</div>
        )}
      </div>
    </div>
  )
}
