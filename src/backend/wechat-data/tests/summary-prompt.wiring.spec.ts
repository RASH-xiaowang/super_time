/**
 * 总结 prompt 的篇幅与内容质量守卫。
 *
 * ## 背景（2026-10-17）
 *
 * 改前两处各写一句 `'请总结 X 的微信聊天内容，输出简洁的中文要点：'`，问题有三：
 *   ① **没有篇幅约束** —— 模型有时写 3 行、有时写 800 字，用户不知道会得到什么；
 *   ② **没有结构要求** —— 输出是一坨散文，扫不出重点；
 *   ③ **没有防编造约束** —— 素材稀疏时模型会"合理推测"，而这是个人聊天记录。
 *
 * 同时素材本身也有问题：`wxid_xxx:` 前缀原样喂给模型、机器人/广告挤掉真实对话。
 * 这里把「prompt 有篇幅约束」与「素材已清洗」两件事都钉住。
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
const prompt = readFileSync(join(BACKEND, 'query', 'summary-prompt.ts'), 'utf8')
const collect = readFileSync(join(BACKEND, 'query', 'daily-summary.ts'), 'utf8')
const remotes = readFileSync(join(BACKEND, 'remotes', 'summaryrec.ts'), 'utf8')

describe('总结 prompt：篇幅与结构必须明确', () => {
  it('四种格式各有**明确字数区间**（不是"简洁"这种模糊词）', () => {
    // 每种格式都要有「数字–数字 字」或「数字–数字 条」的区间
    const ranges = [...prompt.matchAll(/range: '(\d+)[–-](\d+) (字|条)/g)]
    expect(ranges.length, '四种格式的字数区间没写全').toBe(4)
    for (const m of ranges) {
      const lo = Number(m[1])
      const hi = Number(m[2])
      const unit = m[3]
      expect(hi, `区间 ${m[1]}–${m[2]} 上下界反了`).toBeGreaterThan(lo)
      // 「字」的下界要够大（少于 100 字等于没约束）；「条」的下界至少 4 条
      if (unit === '字') expect(lo, `区间 ${m[1]}–${m[2]} 字下界太小`).toBeGreaterThanOrEqual(100)
      else expect(lo, `区间 ${m[1]}–${m[2]} 条下界太小`).toBeGreaterThanOrEqual(4)
    }
  })

  it('prompt 里必须写清「只写素材里有的，不推测不编造」', () => {
    expect(prompt, '缺少防编造约束').toContain('不要推测')
    expect(prompt, '缺少防编造约束').toContain('不要编造')
  })

  it('素材不足时必须允许模型直说，而不是硬凑', () => {
    expect(prompt, '缺少"素材不足就直说"的出口').toContain('没有值得总结的对话')
  })

  it('prompt 里要带上素材规模（让模型知道该写多长）', () => {
    expect(prompt).toContain('素材规模')
    expect(prompt).toMatch(/stats\.total/)
    expect(prompt).toMatch(/stats\.sessions/)
  })

  it('两条生成链路都走同一个 prompt 构造器（不许各写一句）', () => {
    const calls = [...remotes.matchAll(/buildSummaryPrompt\(/g)]
    expect(calls.length, '每日与周期应各调一次 buildSummaryPrompt').toBeGreaterThanOrEqual(2)
    // 反例：不许再出现手写的「请总结 … 输出简洁的中文要点」
    expect(remotes, '还有手写的旧 prompt').not.toMatch(/'请总结 ' \+/)
  })

  it('maxTokens 要够写「详细」格式（400–700 字 ≈ 1000+ tokens）', () => {
    const tokens = [...remotes.matchAll(/maxTokens: (\d+)/g)].map((m) => Number(m[1]))
    expect(tokens.length).toBeGreaterThanOrEqual(2)
    for (const t of tokens) {
      expect(t, `maxTokens=${String(t)} 太小，写不下 700 字`).toBeGreaterThanOrEqual(2048)
    }
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
    expect(collect, '会话标题还在用 username').toMatch(/lines\.push\('【' \+ \(names\.get\(username\) \?\? username\) \+ '】'\)/)
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
    expect(collect).toMatch(/contactMeta\(decryptedDir\)\.names/)
  })
})
