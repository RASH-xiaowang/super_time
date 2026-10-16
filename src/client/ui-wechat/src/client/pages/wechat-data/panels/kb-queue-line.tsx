/**
 * 解析队列的一行总结（W3-7.1）：可数的口径 + 可展开的失败原因。
 *
 * 为什么单独一个组件而不是写在 KbFilesPanel 的 JSX 里：那个面板已超函数体棘轮
 * （`function-size-ratchet.spec.ts` 登记 787 行），一行 JSX 都加不得；而这段本身
 * 是自洽的（不需要面板的任何 state，只要文件列表）。
 *
 * 三条口径（都是本仓已有的纪律，不是新发明）：
 *   ① **不画假进度条**：后端没有每份文件的进度信号（`runJob` 一次只 claim 一行，
 *      没有全局队列游标），所以「正在第 x/y」这个座标**造不出来** ——
 *      `PARSE_LOOK` 的头注里就写着「画一根假的进度条比不画更糟」。这里给的是
 *      **可数**的口径：在跑/排队多少个、需要注意多少个。
 *   ② 失败必须**逐条列原因**，而不是只给一个总数：`parse_error` 是后端写进去的原句
 *      （撞锁 / 密码 / 抽不出文字），摊开用户才知道该修哪一个。
 *   ③ 空库**不显示**这一行 —— 没有队列却报状态是误导。
 */
import type { KbFileMeta, KbFileParseState } from '@deepseek-ai/dsh-wechat-data/types'
import { PARSE_LOOK } from './kb-files-support.tsx'

export interface KbParseQueueLineProps {
  files: readonly KbFileMeta[]
}

/** 一个「需要用户处理」的行：状态 + 名字 + 后端写的原句。 */
function attentionOf(f: KbFileMeta): { id: number; name: string; look: (typeof PARSE_LOOK)[KbFileParseState] } {
  return { id: f.id, name: f.name, look: PARSE_LOOK[f.parseState] }
}

export function KbParseQueueLine({ files }: KbParseQueueLineProps): React.JSX.Element | null {
  let pending = 0
  let attention = 0
  const bad: Array<{ id: number; name: string; look: (typeof PARSE_LOOK)[KbFileParseState]; err: string }> = []
  for (const f of files) {
    const look = PARSE_LOOK[f.parseState]
    if (look.pending) pending += 1
    else if (look.attention) {
      attention += 1
      bad.push({ ...attentionOf(f), err: f.parseError })
    }
  }
  if (files.length === 0) return null
  return (
    <div className="queueLine">
      <span>
        {pending > 0 ? `解析队列：${pending} 个在处理/排队` : '解析队列：空的'}
        {attention > 0 ? ` · 需要你处理 ${attention} 个` : ''}
      </span>
      {bad.length > 0 && (
        <details>
          <summary>为什么需要处理（{bad.length}）</summary>
          <ul>
            {bad.map((b) => (
              <li key={b.id}>
                <b>{b.name}</b>：{b.look.hint}
                {b.err !== '' && `（${b.err}）`}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  )
}