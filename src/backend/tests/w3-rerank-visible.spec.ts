// @vitest-environment node
/**
 * W3-6.3：检索诊断里的「精排是否启用」必须是**字段**，不是文案。
 *
 * ## 这笔账为什么值得单立一条
 *
 * 用户看到一条回答，最常问的两个问题是「为什么是这些来源」和「为什么排第一的是它」。
 * 前者早就有漏斗与通道命中数；后者的答案**完全取决于有没有跑精排** ——
 * LLM 精排与本机加权排出来的第一名经常不是同一条。而它此前只被拼进 `basis` 的
 * 一句**中文文本**里：前端想显示它就得 parse 那句话，于是谁也不会去显示。
 *
 * 判据三侧：
 *   ① 类型上有 `retrieval.rerank` 这个字段（不是文本）；
 *   ② 后端真的把它填进去，且对判别联合的 `used:false` 那一支给 0 而不是 undefined
 *      （undefined 会在界面上显示成 "候选 undefined → 取 undefined"）；
 *   ③ 前端真的渲染它，且在未启用时用**告警色调**（与「稠密通道未生效」同款）——
 *      「降级了」这件事必须让人看见，不能和「正常用了精排」一个颜色。
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (p: string): string => readFileSync(p, 'utf8')
const TYPES = 'src/backend/wechat-data/src/types-ask-export.ts'
const ASK = 'src/client/ui-wechat/src/client/pages/wechat-data/panels/Ask.tsx'
const DEEP = 'src/backend/wechat-data/src/remotes/askdeep.ts'

describe('W3-6.3：精排状态进字段、进界面', () => {
  it('① 类型上有独立字段', () => {
    const t = read(TYPES)
    expect(t, 'retrieval 里没有 rerank 字段').toMatch(/rerank\?: \{ used: boolean; candidates: number; kept: number; model\?: string; note\?: string \}/)
  })

  it('② 后端填它，且 used=false 那一支给 0 而不是 undefined', () => {
    const d = read(DEEP)
    expect(d, 'askdeep 没把 rerank 写进 retrieval').toContain('rerank: {')
    // 判别联合：used=false 时没有 candidates/kept，读的时候必须兜底。
    expect(d, 'used=false 时把 undefined 流出去了').toMatch(/candidates: out\.rerankInfo\.used \? out\.rerankInfo\.candidates : 0/)
    expect(d).toMatch(/kept: out\.rerankInfo\.used \? out\.rerankInfo\.kept : 0/)
    // model / note 也要按判别联合的分支取，否则 TS 上都过不去（这条防的是「以后有人把它改回去」）。
    expect(d).toMatch(/out\.rerankInfo\.used && out\.rerankInfo\.model/)
    expect(d).toMatch(/!out\.rerankInfo\.used && out\.rerankInfo\.note/)
  })

  it('③ 前端渲染它，且未启用时用告警色调', () => {
    const a = read(ASK)
    expect(a, 'RetrMeta 没有读 retrieval.rerank').toContain('retrieval.rerank')
    // 未启用 ⇒ 告警色调（与「稠密通道未生效」同一个 className 变量）。
    expect(a, '未启用精排没有标成降级').toMatch(/retrieval\.rerank\.used \? '' : ` \$\{rcss\.retrWarn\}`/)
    expect(a, '降级文案没有说清是本机加权').toContain('精排未启用（本机加权）')
    expect(a, '启用时没说候选→取了多少').toContain('精排 ${retrieval.rerank.model')
  })
})