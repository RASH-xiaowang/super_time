/**
 * 分段发送（`splitReplyText`）的样例守卫（2026-10-17）。
 *
 * 用户要求「如果内容太长可以分段发送」—— 微信里一条几千字读起来很累，且容易被折叠。
 * 切法优先级：① 空行分段 → ② 句末标点 → ③ 硬切。**不能按固定字数切**：
 * 那会把一句话拦腰截断，读起来像两条不相干的消息。
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import { CLAWBOT_REPLY_CHUNK_CHARS, DEFAULT_CLAWBOT_SYSTEM_PROMPT, splitReplyText } from '../src/query/clawbot/clawbot-prompt.ts'

describe('splitReplyText：长回复按语义分段', () => {
  it('短文本原样返回（不分段）', () => {
    expect(splitReplyText('好的，收到')).toEqual(['好的，收到'])
    expect(splitReplyText('')).toEqual([])
    expect(splitReplyText('   ')).toEqual([])
  })

  it('刚好等于上限不分段；超一点就分', () => {
    const exact = 'a'.repeat(CLAWBOT_REPLY_CHUNK_CHARS)
    expect(splitReplyText(exact)).toEqual([exact])
    const over = 'a'.repeat(CLAWBOT_REPLY_CHUNK_CHARS + 1)
    expect(splitReplyText(over).length).toBe(2)
  })

  it('优先按空行分段（模型被要求「按语义分段，段间空一行」）', () => {
    // 用短上限触发分段（默认 300 字下这段文本不会分）。
    const text = '第一件事说完了。\n\n第二件事也说完了。\n\n第三件事。'
    expect(splitReplyText(text, 10)).toEqual(['第一件事说完了。', '第二件事也说完了。', '第三件事。'])
  })

  it('单段超限时按句末标点切（不拦腰截断一句话）', () => {
    // 每句 20 字，上限 50 ⇒ 每段装 2 句（40 字），第 3 句起新段。
    const s = '这是一句话内容刚好二十个字。'
    const text = s.repeat(5)
    const parts = splitReplyText(text, 50)
    expect(parts.length).toBeGreaterThan(1)
    // 每段都必须是完整句子（以句号结尾），且不超过上限。
    for (const p of parts) {
      expect(p.endsWith('。'), `段「${p}」不是完整句子`).toBe(true)
      expect(p.length).toBeLessThanOrEqual(50)
    }
    // 拼回去等于原文（不丢字）。
    expect(parts.join('')).toBe(text)
  })

  it('一长串没有标点的文本硬切（罕见，但不能丢字）', () => {
    const text = 'x'.repeat(700)
    const parts = splitReplyText(text, 300)
    expect(parts.length).toBe(3)
    expect(parts.join('')).toBe(text)
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(300)
  })

  it('中英标点都认（。！？；!?;）', () => {
    const text = 'Hello! World? Yes; Ok.'
    const parts = splitReplyText(text, 8)
    expect(parts.length).toBeGreaterThan(1)
    // 切分后每段 trim（去掉句首空格）⇒ 拼回去时**空格会丢**（可接受：中文没有词间空格，
    // 英文丢一个空格不影响可读性；保留空格反而会让段首多一个空格）。
    expect(parts.join('')).toBe('Hello!World?Yes;Ok.')
    // 每段都以标点结尾（不拦腰截断）—— 注意 `Yes;Ok.` 是**一段**（`Yes;` 只有 4 字符，
    // 与 `Ok.` 合起来 7 字符仍在上限 8 内），所以它整体以 `.` 结尾。
    for (const p of parts) expect(/[。！？；!?;.]$/.test(p), `段「${p}」不以标点结尾`).toBe(true)
  })
})

describe('DEFAULT_CLAWBOT_SYSTEM_PROMPT：拟人化默认提示词', () => {
  it('要求像真人发微信那样说话（口语、简短、自然）', () => {
    expect(DEFAULT_CLAWBOT_SYSTEM_PROMPT).toContain('像真人发微信那样')
    expect(DEFAULT_CLAWBOT_SYSTEM_PROMPT).toContain('口语')
  })

  it('禁止报告腔与客服腔（用户报的「回复太生硬」正是这两种）', () => {
    expect(DEFAULT_CLAWBOT_SYSTEM_PROMPT).toContain('综上所述')
    expect(DEFAULT_CLAWBOT_SYSTEM_PROMPT).toContain('客服腔')
  })

  it('禁止引用角标与 Markdown（微信里显示不出来）', () => {
    expect(DEFAULT_CLAWBOT_SYSTEM_PROMPT).toContain('[1]')
    expect(DEFAULT_CLAWBOT_SYSTEM_PROMPT).toContain('Markdown')
  })

  it('要求不编造、不确定就说不确定（「回复内容合理」的底线）', () => {
    expect(DEFAULT_CLAWBOT_SYSTEM_PROMPT).toContain('不要猜、不要编')
    expect(DEFAULT_CLAWBOT_SYSTEM_PROMPT).toContain('不确定')
  })

  it('要求长内容按语义分段（配合分段发送）', () => {
    expect(DEFAULT_CLAWBOT_SYSTEM_PROMPT).toContain('按语义分段')
  })

  it('要求每条不超过 30 字（2026-10-17 用户要求「每次回复不能超过 30 字」）', () => {
    // ⚠️ 提示词里的字数与 `CLAWBOT_REPLY_CHUNK_CHARS` 必须**一致** ——
    // 不一致时模型按旧字数写、切段按新字数切，会出现「一条被切成半句话」。
    expect(DEFAULT_CLAWBOT_SYSTEM_PROMPT).toContain('每条不超过 30 字')
    expect(CLAWBOT_REPLY_CHUNK_CHARS).toBe(30)
  })

  it('禁止解释自己（2026-10-17 真机实测：模型写了「（注：实在没有可引用的记录，就不编号了）」）', () => {
    expect(DEFAULT_CLAWBOT_SYSTEM_PROMPT).toContain('不要解释你自己')
    expect(DEFAULT_CLAWBOT_SYSTEM_PROMPT).toContain('元信息')
  })

  it('禁止「在的」当万能开场（2026-10-17 真机实测：6/12 场景都以它开头）', () => {
    // 真人不会对每个问题都先回「在的」—— 它只在对方问「在吗」时才用。
    expect(DEFAULT_CLAWBOT_SYSTEM_PROMPT).toContain('不要用万能开场')
    expect(DEFAULT_CLAWBOT_SYSTEM_PROMPT).toContain('「在的」只在对方问「在吗 / 在不在」时用')
  })

  it('要求先回应对方说的内容（2026-10-17 真机实测：一上来就说「我这边没查到」像客服）', () => {
    expect(DEFAULT_CLAWBOT_SYSTEM_PROMPT).toContain('先回应对方说的内容')
  })

  it('要求闲聊就闲聊、不是每句话都需要回答（2026-10-17 真机实测）', () => {
    expect(DEFAULT_CLAWBOT_SYSTEM_PROMPT).toContain('闲聊就闲聊')
    expect(DEFAULT_CLAWBOT_SYSTEM_PROMPT).toContain('不是每句话都需要回答')
  })

  it('允许语气词与情绪（真人的微信有「哈哈」「～」「嗯嗯」）', () => {
    expect(DEFAULT_CLAWBOT_SYSTEM_PROMPT).toContain('可以有情绪和语气词')
  })
})

describe('30 字上限下的真实分段（2026-10-17 用户报「不分段」）', () => {
  it('184 字的回复被切成多条，每条 ≤30 字（真机截图里的那条）', () => {
    // 真机截图里的原文（184 字，一条发出）。
    const text = '我们做的是探迹智能销售云，主要给 To B 销售用，从线索挖掘、商机触达、客户管理到成单分析，整条走完。\n\n产品分几块：AI 拓客、AI 集客、AI 触达、AI CRM。\n\n另外还有按行业分的版本，像家装、机械设备、电子元器件、美业服务、制造业、国际物流、知识产权、资质服务、法律服务、招投标这些。\n\n你们是哪个行业的？我看看有没有对口的方案。'
    const parts = splitReplyText(text)
    expect(parts.length, '184 字应该被切成多条（30 字上限下至少 6 条）').toBeGreaterThanOrEqual(6)
    for (const p of parts) {
      expect(p.length, `段「${p}」超过 30 字`).toBeLessThanOrEqual(30)
    }
    // 不丢字（拼回去等于原文去掉空白）。
    expect(parts.join('').replace(/\s/g, '')).toBe(text.replace(/\s/g, ''))
  })

  it('短回复不分段（「好的，收到」原样一条）', () => {
    expect(splitReplyText('好的，收到')).toEqual(['好的，收到'])
  })

  it('超限单句优先在次级标点（逗号）处切，不产生「楚。」这种碎片（2026-10-17 真机实测）', () => {
    // 真机实测：32 字的句子在 30 字上限下被切成 `…我真不清` + `楚。`，读起来像乱码。
    const s = '你说的那个方案，我这边没查到相关内容，出不出得来初稿我真不清楚。'
    const parts = splitReplyText(s)
    expect(parts.length).toBeGreaterThan(1)
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(30)
    // 关键：**不许出现只有 1~2 字的碎片**（那是纯按字数切的症状）。
    for (const p of parts) {
      expect(p.length, `段「${p}」太短（纯按字数切的碎片）`).toBeGreaterThanOrEqual(5)
    }
    // 拼回去不丢字。
    expect(parts.join('')).toBe(s)
  })
})
