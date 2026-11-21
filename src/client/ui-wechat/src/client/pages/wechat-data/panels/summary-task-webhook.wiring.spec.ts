/**
 * 定时总结抽屉的 Webhook 接线（2026-11-18）。
 *
 * 为什么是源码级断言：抽屉要在 jsdom 里真渲染得先备齐 `apiGetSessions` /
 * `apiGetContacts` / `useConfirm` / 样式模块一整套桩，而这里要守的只是「三处接线没漏」
 * —— 漏了任何一处都不报错，只是静默失效：
 *   ① 表单里有开关、地址与推送对象，且**开关独立于内容**（勾上就能填，不是「先有地址才能勾」）；
 *   ② `save` 按开关决定提交内容，并挡住「勾了却没填」；
 *   ③ `run` 区分「推送失败」与「总结失败」（都报「运行失败」会让人以为总结白跑了）。
 * 仓库对这类「接线是否正确」一贯用源码断言（见 `whisper-download-wiring.spec.ts`）。
 * @vitest-environment node
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = readFileSync(join(HERE, 'SummaryTaskDrawer.tsx'), 'utf8')

describe('SummaryTaskDrawer 的推送接线', () => {
  it('表单状态里有开关、地址与推送对象，并带默认值', () => {
    expect(SRC).toMatch(/webhookOn:\s*boolean/)
    expect(SRC).toMatch(/webhookUrl:\s*string/)
    expect(SRC).toMatch(/webhookTarget:\s*string/)
    expect(SRC).toMatch(/webhookOn:\s*false/)
    expect(SRC).toMatch(/webhookUrl:\s*''/)
    expect(SRC).toMatch(/webhookTarget:\s*''/)
  })

  it('勾选框绑定独立开关，而不是「地址是否非空」', () => {
    // 回归：最初 `checked={form.webhookUrl.trim() !== ''}` + onChange 写回原空串，
    // 于是勾选被自己立刻否掉 —— 永远勾不上。判据必须与内容解耦。
    expect(SRC).toMatch(/checked=\{form\.webhookOn\}/)
    expect(SRC).not.toMatch(/checked=\{form\.webhookUrl\.trim\(\)\s*!==\s*''\}/)
  })

  it('输入框跟着开关显隐（勾上就能填，不要求先有内容）', () => {
    expect(SRC).toMatch(/\{form\.webhookOn\s*&&/)
    expect(SRC).toMatch(/aria-label="Webhook 推送地址"/)
    expect(SRC).toMatch(/aria-label="Webhook 推送对象"/)
  })

  it('编辑已有任务时回填三个字段（否则改一次就丢配置）', () => {
    expect(SRC).toMatch(/webhookOn:\s*\(t\.webhookUrl\s*\|\|\s*''\)\.trim\(\)\s*!==\s*''/)
    expect(SRC).toMatch(/webhookUrl:\s*t\.webhookUrl\s*\|\|\s*''/)
    expect(SRC).toMatch(/webhookTarget:\s*t\.webhookTarget\s*\|\|\s*''/)
  })

  it('保存时按开关决定提交地址，并挡住「勾了却没填」', () => {
    expect(SRC).toMatch(/webhookUrl:\s*form\.webhookOn\s*\?\s*form\.webhookUrl\.trim\(\)\s*:\s*''/)
    expect(SRC).toMatch(/webhookTarget:\s*form\.webhookOn\s*\?\s*form\.webhookTarget\.trim\(\)\s*:\s*''/)
    expect(SRC).toMatch(/webhookOn\s*&&\s*form\.webhookUrl\.trim\(\)\s*===\s*''/)
    expect(SRC).toMatch(/请填写推送地址/)
  })

  it('取消勾选会清空地址与对象（显式关掉推送）', () => {
    expect(SRC).toMatch(/webhookOn:\s*on/)
    expect(SRC).toMatch(/webhookUrl:\s*'',\s*webhookTarget:\s*''/)
  })

  it('运行结果区分「推送失败」与「总结失败」', () => {
    expect(SRC).toMatch(/r\.webhook/)
    expect(SRC).toMatch(/已生成，但推送失败/)
  })

  it('任务列表给配了推送的任务一个可见标记', () => {
    expect(SRC).toMatch(/t\.webhookUrl\s*!==\s*''/)
    expect(SRC).toMatch(/推送/)
  })
})
