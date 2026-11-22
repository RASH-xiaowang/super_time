/**
 * 总结 prompt 的内容质量守卫。
 *
 * ## 背景（2026-10-17）
 *
 * 改前两处各写一句 `'请总结 X 的微信聊天内容，输出简洁的中文要点：'`，问题有三：
 *   ① **没有结构要求** —— 输出是一坨散文，扫不出重点；
 *   ② **没有防编造约束** —— 素材稀疏时模型会"合理推测"，而这是个人聊天记录。
 * 同时素材本身也有问题：`wxid_xxx:` 前缀原样喂给模型、机器人/广告挤掉真实对话。
 * 这里把「结构/诚实性」与「素材已清洗」两件事钉住。
 *
 * ## 篇幅：2026-11-18 起**不再限字数**
 *
 * 10-17 那一版给每种格式钉了硬区间（`150–250 字` / `400–700 字` / `6–10 条`）并要求
 * `maxTokens >= 2048`。实测代价更大：素材多时被硬砍掉结论、素材少时被下界逼着凑字数
 * （与「不编造」直接打架）。用户要求「不要限制总结的字数」，于是：
 *   · prompt 里不出现字数区间，改成「按素材量决定」；
 *   · 三处生成调用都不传 `maxTokens`；
 *   · Webhook 推送不再截断正文。
 * 下面把这三条钉住 —— 它们最容易在某次「顺手加个上限」时被加回来。
 * @vitest-environment node
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))

function findRoot(start: string): string {
  let d = start
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(d, 'main.js')) && existsSync(join(d, 'package.json'))) return d
    d = dirname(d)
  }
  throw new Error('找不到仓库根')
}
const ROOT = findRoot(HERE)
const BACKEND = join(ROOT, 'src', 'backend', 'wechat-data', 'src')

/**
 * 去注释后再断言。
 *
 * 必要而非洁癖：这几个文件的**头注释里专门记着旧写法**（「此前是 `150–250 字`」、
 * 「过去这里是 `maxTokens: 1024`」），裸词断言会把它们当成违规命中 —— 本文件第一版
 * 就被自己的注释骗红过一次。仓库里 `outbound-site-coverage.spec.ts` 的 `codeOf()` 同理。
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

const prompt = stripComments(readFileSync(join(BACKEND, 'query', 'summary-prompt.ts'), 'utf8'))
const collect = readFileSync(join(BACKEND, 'query', 'daily-summary.ts'), 'utf8')
const remotes = stripComments(readFileSync(join(BACKEND, 'remotes', 'summaryrec.ts'), 'utf8'))
const taskRemotes = stripComments(readFileSync(join(BACKEND, 'remotes', 'summary.ts'), 'utf8'))
const webhook = stripComments(readFileSync(join(BACKEND, 'query', 'summary-webhook.ts'), 'utf8'))

describe('总结 prompt：篇幅不限，但结构与诚实性必须明确', () => {
  it('四种格式都不写字数区间（篇幅交给素材量决定）', () => {
    const ranges = [...prompt.matchAll(/range:\s*'[^']*'/g)]
    expect(ranges, '还在写死字数区间').toHaveLength(0)
    // 防空转：区间形状（数字–数字 字/条）在 prompt 文件里也不该出现。
    expect(prompt, 'prompt 里还有「N–M 字」这类硬上限').not.toMatch(/\d+\s*[–-]\s*\d+\s*(字|条)/)
  })

  it('篇幅的判据是「按素材量决定」，并且明确禁止凑长度与漏信息', () => {
    expect(prompt, '缺少「按素材量决定篇幅」').toContain('按素材量决定')
    expect(prompt, '没禁止为凑长度重复/铺垫').toContain('不要为了凑长度')
    expect(prompt, '没禁止漏掉重要信息').toContain('漏掉重要信息')
  })

  it('structure 仍然逐格式给全（去掉的只是字数，不是结构）', () => {
    for (const fmt of ['brief', 'detailed', 'bullets', 'story']) {
      expect(prompt, `缺少 ${fmt} 的 shape`).toContain(`${fmt}: {`)
    }
    expect((prompt.match(/shape: '/g) ?? []).length, '四种格式的结构要求没写全').toBe(4)
  })

  it('prompt 里必须写清「只写素材里有的，不推测不编造」', () => {
    expect(prompt, '缺少防编造约束').toContain('不要推测')
    expect(prompt, '缺少防编造约束').toContain('不要编造')
  })

  it('素材不足时必须允许模型直说，而不是硬凑', () => {
    expect(prompt, '缺少"素材不足就直说"的出口').toContain('没有值得总结的对话')
  })

  it('prompt 里要带上素材规模（模型据此判断该写多长）', () => {
    expect(prompt).toContain('素材规模')
    expect(prompt).toMatch(/stats\.total/)
    expect(prompt).toMatch(/stats\.sessions/)
  })

  it('三条生成链路都走同一个 prompt 构造器（不许各写一句）', () => {
    // 每日 + 周期
    expect([...remotes.matchAll(/buildSummaryPrompt\(/g)].length, '每日与周期应各调一次 buildSummaryPrompt')
      .toBeGreaterThanOrEqual(2)
    // 定时任务：2026-11-18 起也走同一条（此前自带一份含「3-5 句话以内」的格式表）
    expect(taskRemotes, '定时任务没走共用构造器').toContain('buildSummaryPrompt({')
    expect(taskRemotes, '定时任务还留着手写的格式表').not.toMatch(/3-5 句话以内/)
    // 反例：不许再出现手写的「请总结 … 输出简洁的中文要点」
    expect(remotes, '还有手写的旧 prompt').not.toMatch(/'请总结 ' \+/)
  })

  it('三处生成调用都不传 maxTokens（不再硬截输出）', () => {
    for (const [name, src] of [['summaryrec', remotes], ['summary', taskRemotes]] as const) {
      const caps = [...src.matchAll(/maxTokens:\s*(\d+)/g)].map((m) => Number(m[1]))
      // 推荐回复有自己独立的预算（与总结无关），只拦总结调用上的。
      const summaryCaps = caps.filter((n) => n === 1024 || n === 2048)
      expect(summaryCaps, `${name} 里还有总结用的 maxTokens 硬上限`).toHaveLength(0)
    }
  })

  it('Webhook 推送不截断正文（长总结照原样发）', () => {
    expect(webhook, '推送还在截断正文').not.toMatch(/SUMMARY_WEBHOOK_MESSAGE_MAX/)
    expect(webhook, '推送还在 slice 正文').not.toMatch(/message\.slice\(/)
    expect(webhook, '结果里还留着 truncated 字段').not.toContain('truncated')
  })
})

describe('总结素材：必须清洗后再喂模型', () => {
  it('群消息的 `wxid_xxx:` 前缀要换成可读名字', () => {
    expect(collect, '缺少发送者前缀清洗').toMatch(/function cleanSenderPrefix/)
    expect(collect, '清洗函数没被调用').toMatch(/cleanSenderPrefix\(text, names\)/)
    // 拿不到显示名时退回「某人」，而不是把 wxid 原样留着
    expect(collect).toContain("'某人'")
  })

  it('会话标题也用显示名（`【wxid_xxx】` 对模型毫无意义）', () => {
    expect(collect, '会话标题还在用 username').toMatch(/lines\.push\('【' \+ displayNameForUsername\(username, names\) \+ '】'\)/)
  })

  it('机器人 / 广告 / 系统播报要丢掉（它们会挤掉真实对话）', () => {
    expect(collect, '缺少噪声过滤').toMatch(/function isNoiseMessage/)
    expect(collect, '噪声过滤没被调用').toMatch(/isNoiseMessage\(cleaned\)/)
    // 三类都要覆盖：系统播报 / 机器人回执 / 结构化业务模板
    expect(collect, '没过滤系统播报').toContain('撤回了一条消息')
    expect(collect, '没过滤机器人回执').toContain('收到请求')
    expect(collect, '没过滤结构化业务模板').toContain('金额')
  })

  it('显示名映射来自 contactMeta（不是自己再查一遍库）', () => {
    expect(collect).toMatch(/const meta = contactMeta\(decryptedDir\)/)
    expect(collect).toMatch(/const names = mergeDisplayNames\(decryptedDir, identity\.usernames\)/)
    expect(collect, '联系人元数据仍负责企业名').toContain('meta.enterpriseNames')
  })
})
