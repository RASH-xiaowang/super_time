/**
 * 单聊「聊天信息」抽屉（P2-6）的接线守卫。
 *
 * 起因：群聊版（chats-group-info）2026-09 就位，单聊入口一直缺席（chat-panel-visual-audit P2-6）。
 * 2026-09-25 补齐时有四处「接线错了也不报错、但语义就变了」的地方，各钉一条：
 *   ① 按钮若也给群聊，会出现两个「信息」入口抢同一个动作区；
 *   ② 抽屉若拿不到当前会话，360 统计会退化成「没有范围」；
 *   ③ 数据必须来自 apiGetContact360（现成 Remote），不许自造查询路径；
 *   ④ 「导出聊天记录」必须联动既有导出对话框（exportSession 是真实能力），
 *      挂个不工作的按钮比没有入口更糟。
 * 源码锚点断言 + 先剥注释（本仓既有做法），断言的字符串均为单行，不受行尾影响。
 * @vitest-environment node
 */
import { readFileSync } from 'node:fs'
import { readChatsSource } from '../../../test-helpers/chats-source.ts'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
const strip = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
// M21 拆了 Chats.tsx ⇒ 读联合（断言未改）
const chats = strip(readChatsSource())
const panel = readFileSync(join(HERE, 'chats-contact-info-view.tsx'), 'utf8')

describe('单聊「聊天信息」的接线', () => {
  it('头部按钮只在单聊出现（群聊由群信息按钮管，两个入口不能抢同一个动作区）', () => {
    const at = chats.indexOf('title="聊天信息"')
    expect(at, '找不到聊天信息按钮 —— 改名后请同步本用例').toBeGreaterThan(-1)
    const around = chats.slice(Math.max(0, at - 300), at)
    expect(around.includes("curSession.type !== 'group'"), '聊天信息按钮应当只对单聊出现').toBe(true)
  })

  it('抽屉挂在消息流右侧，且把当前会话传进去（360 统计的范围靠它）', () => {
    const at = chats.indexOf('<ChatsContactInfoView')
    expect(at, '找不到 ChatsContactInfoView 的挂载点 —— 改名后请同步本用例').toBeGreaterThan(-1)
    const around = chats.slice(at, at + 320)
    expect(around.includes('session={curSession}'), '抽屉必须拿到当前会话（否则统计范围退化成「没有范围」）').toBe(true)
    expect(around.includes('open={contactInfoOpen}'), '抽屉的开关必须接 state（否则关不掉）').toBe(true)
  })

  it('数据来自 apiGetContact360（现成 Remote），组件不自带第二套查询路径', () => {
    expect(panel.includes('apiGetContact360'), '360 统计必须走 apiGetContact360').toBe(true)
    expect(panel.includes('session.username'), '取数必须按当前会话的 username').toBe(true)
  })

  it('「导出聊天记录」联动既有导出对话框（真实能力，不是死按钮）', () => {
    const at = chats.indexOf('<ChatsContactInfoView')
    const around = chats.slice(at, at + 360)
    expect(around.includes('setExportOpen(true)'), 'onExport 必须打开导出对话框（exportSession 的入口）').toBe(true)
  })

  it('组件自带 private-only 守卫：session 是群聊时渲染 null（防线不只在按钮上）', () => {
    expect(panel.includes("session.type === 'group'"), '组件内部必须有 private-only 守卫').toBe(true)
  })

  it('群聊入口不受影响：群信息按钮仍然 group-only', () => {
    const at = chats.indexOf('title="群聊信息"')
    expect(at, '找不到群聊信息按钮（被误删？）').toBeGreaterThan(-1)
    const around = chats.slice(Math.max(0, at - 300), at)
    expect(around.includes("curSession.type === 'group'"), '群信息按钮应当仍只对群聊出现').toBe(true)
  })
})
