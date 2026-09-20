/**
 * 「已配置模型」切换条的**接线**守卫（源码级）。
 *
 * 为什么需要：仓库没有 DOM/hook 测试环境（M13/M14 的既定结论），而这条链路最容易静默断掉
 * 的恰恰是最关键的一步 —— **点击芯片到底走的是「切换」还是「只改草稿」**。
 * 两者在源码上都只是 `setLlmConfig(...)` 而已，但语义完全相反：
 *   · 走 `apiActivateLlmProfile` → 一次 IPC、写盘、下一次提问立即生效；
 *   · 只改草稿 → 用户以为切好了，实际什么都没变（还要再点一次保存，且会把别家的 Key 一起提交）。
 * 另外三条产品契约也钉在这里：芯片上**绝不渲染 API Key**、新增与编辑是两条路径、
 * 换厂商必须清空 Key（那是历史上「A 家地址 + B 家 Key」401 陷阱的根因）。
 * @vitest-environment node
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))

/** 读源码并去掉注释 —— 否则注释里提到旧做法会让断言误判。 */
function codeOf(file: string): string {
  const src = readFileSync(join(HERE, file), 'utf8')
  return src.replace(/\/\*[\s\S]*?\*\//g, '').split(/\r?\n/).map(l => l.replace(/\/\/.*$/, '')).join('\n')
}

const card = codeOf('AiModelConfig.tsx')
const llmApi = codeOf('../llm-config.ts')
const api = codeOf('../api.ts')

describe('已配置模型：切换条接线', () => {
  it('卡片里有切换条与新增入口', () => {
    expect(card).toContain('data-llm-profiles')
    expect(card).toContain('data-add-llm-profile')
    expect(card).toContain('已配置模型')
  })

  it('点击芯片真的走切换（不是只改草稿）', () => {
    expect(card).toContain('data-activate-llm-profile={p.id}')
    expect(card).toMatch(/onClick=\{\(\) => \{ void switchTo\(p\) \}\}/)
    // 切换必须真写盘：一次 IPC 落到 apiActivateLlmProfile
    expect(card).toMatch(/await apiActivateLlmProfile\(p\.id\)/)
  })

  it('切换后明确告诉用户「立即生效」（不必重启 —— 后端每次请求都重读 llm.json）', () => {
    expect(card).toContain('下一次提问立即生效')
  })

  it('「使用中」的那条芯片是禁用的（点了也没意义，且要防重复写盘）', () => {
    expect(card).toMatch(/disabled=\{profileBusy \|\| active\}/)
    expect(card).toMatch(/aria-current=\{active \|\| undefined\}/)
  })

  it('首次挂载只读一次快照（不可用两次读取拼出「徽标 A、切换条 B」）', () => {
    expect(card).toMatch(/await apiGetLlmProfiles\(\)/)
    expect(card).not.toMatch(/await apiGetLlmConfig\(\)/)
  })
})

describe('已配置模型：芯片上不出现 API Key', () => {
  it('芯片只渲染名称 / 模型名 / 使用状态', () => {
    const start = card.indexOf('profiles.map(')
    const end = card.indexOf('{profiles.length === 0', start)
    expect(start, '找不到芯片渲染块').toBeGreaterThan(-1)
    expect(end, '找不到芯片渲染块的结尾').toBeGreaterThan(start)
    const chip = card.slice(start, end)
    // Key 会以明文出现在切换条上（被随手看到、被截图）—— 这是不能接受的
    expect(chip, '芯片里不许出现 apiKey').not.toContain('apiKey')
    expect(chip).toContain('data-activate-llm-profile')
    expect(chip).toContain('data-delete-llm-profile')
  })
})

describe('已配置模型：新增与编辑是两条路径', () => {
  it('「新增配置」进入草稿态，且可取消', () => {
    expect(card).toMatch(/onClick=\{startNewProfile\}/)
    expect(card).toMatch(/setDraftNew\(true\)/)
    expect(card).toContain('data-cancel-new-profile')
    expect(card).toMatch(/onClick=\{cancelNewProfile\}/)
  })

  it('草稿态保存 → 另存为一条新配置（不覆盖现有配置）', () => {
    expect(card).toMatch(/if \(draftNew\) \{[\s\S]{0,200}?await apiSaveLlmProfile\(\{ config: llmConfig \}\)/)
  })

  it('编辑态保存 → 更新使用中的那一份（走 apiSaveLlmConfig）', () => {
    expect(card).toMatch(/await apiSaveLlmConfig\(llmConfig\)/)
    // 保存后重新拉一次配置集，让切换条与「使用中」保持一致
    expect(card).toMatch(/apiSaveLlmConfig\(llmConfig\)[\s\S]{0,400}?await apiGetLlmProfiles\(\)/)
  })

  it('删除走确认框，并说明「会一起删掉里面的 Key」', () => {
    expect(card).toMatch(/await confirm\(\{/)
    expect(card).toMatch(/await apiDeleteLlmProfile\(p\.id\)/)
    expect(card).toMatch(/API Key 也会一起删掉|API Key 会一起删掉/)
  })

  it('删除按钮只在两条以上时出现（只剩一条时后端也会拒绝）', () => {
    expect(card).toMatch(/\{profiles\.length > 1 && \(/)
  })

  it('写盘类动作共用单飞闸（profileBusy）', () => {
    for (const marker of ['if (profileBusy) return', 'if (profileBusy || p.id === activeProfileId) return', 'setProfileBusy(true)']) {
      expect(card, `缺少单飞闸：${marker}`).toContain(marker)
    }
  })
})

describe('模板与厂商：换厂商必须清空 Key（401 陷阱的根因）', () => {
  it('按 host 判断是否换厂商，换了就清空 API Key', () => {
    expect(card).toContain('sameHost')
    expect(card).toMatch(/const changedVendor = !sameHost\(/)
    expect(card).toMatch(/\.\.\.\(changedVendor \? \{ apiKey: '' \} : \{\}\)/)
  })

  it('提示文案区分「换厂商需重填 Key」与「同厂商保留 Key」', () => {
    expect(card).toContain('换厂商需重新填写该家的 API Key')
    expect(card).toContain('同厂商，API Key 保留')
  })
})

describe('前端访问层：实现搬到了 llm-config.ts 并在 api.ts 转发', () => {
  it('llm-config.ts 里七个入口齐全', () => {
    expect(existsSync(join(HERE, '..', 'llm-config.ts'))).toBe(true)
    for (const fn of [
      'apiGetLlmConfig', 'apiSaveLlmConfig', 'apiFetchLlmModels',
      'apiGetLlmProfiles', 'apiActivateLlmProfile', 'apiSaveLlmProfile', 'apiDeleteLlmProfile',
    ]) {
      expect(llmApi, `llm-config.ts 缺少 ${fn}`).toContain(`export async function ${fn}(`)
    }
  })

  it('api.ts 继续转发（既有 4 个面板的 from ../api.ts 一行都不用改）', () => {
    expect(api).toMatch(/export \{[\s\S]{0,400}?\} from '\.\/llm-config\.ts'/)
    for (const name of ['apiGetLlmConfig', 'apiSaveLlmConfig', 'apiFetchLlmModels']) {
      expect(api, `api.ts 没再转发 ${name}`).toContain(name)
    }
    // 实现不该还留在 api.ts（否则两份会漂）
    expect(api).not.toContain('function apiGetLlmConfig(')
  })

  it('四条配置集接口都走主进程 IPC（不是 Remote）—— 配置要在后端起来之前就存在', () => {
    expect(llmApi).toContain("electronAPI?.wechat")
    for (const m of ['getLlmProfiles', 'activateLlmProfile', 'saveLlmProfile', 'deleteLlmProfile']) {
      expect(llmApi, `llm-config.ts 没有调用 ${m}`).toContain(`api.${m}`)
    }
    expect(llmApi).not.toContain('remote().')
  })
})

/**
 * 三个角色（语言 / 嵌入 / 重排序）的界面与字段成套性（`docs/KB-MODEL-CONFIG.md` 的 P1 / V5）。
 *
 * 这里守的是**能被静默丢掉**的东西：表单提交的是 `configOf()` 挑出来的对象，
 * 少列一个字段 = 编辑一条已存配置时把它悄悄清成默认值；界面上看不出任何异常，
 * 用户下次打开才发现「精排模型怎么空了」。
 */
describe('三个角色：分组卡与字段成套', () => {
  it('三张分组卡都在，且各自说明了自己是干什么的', () => {
    expect(card).toContain('嵌入模型')
    expect(card).toContain('重排序模型')
    // 换嵌入模型的代价必须写在卡上，而不是等用户点保存才弹窗拦
    expect(card).toContain('需要重建')
    // 精排「填了即启用」是决策 D3：界面要说清留空会退回本地加权
    expect(card).toContain('本地的加权排序')
  })

  it('七个角色字段接进了表单；两个接口路径**刻意不暴露**但必须被带着走', () => {
    for (const k of ['embeddingModel', 'embeddingApiUrl', 'embeddingApiKey',
      'rerankModel', 'rerankApiUrl', 'rerankApiKey', 'rerankTimeoutMs']) {
      expect(card, `表单里没有 ${k} 的输入`).toContain(`setLlmConfig({ ...llmConfig, ${k}:`)
      expect(llmApi, `WechatLlmConfig 里没有 ${k}`).toContain(k)
    }
    // 路径与 apiPath 同口径：界面上从不暴露（用户不需要知道是 /rerank 还是 /v2/rerank），
    // 但必须出现在类型与 configOf 的清单里 —— 少一处，编辑一条已存配置就把它清成默认值。
    for (const k of ['embedPath', 'rerankPath']) {
      expect(card, `${k} 不该有输入框`).not.toContain(`setLlmConfig({ ...llmConfig, ${k}:`)
      expect(llmApi, `WechatLlmConfig 丢了 ${k}`).toContain(k)
    }
    const from = card.indexOf('function configOf')
    expect(from).toBeGreaterThan(0)
    const body = card.slice(from, from + 900)
    // 编辑一条已存配置时，表单提交的就是 configOf 挑出来的那个对象 ——
    // 少列一个键 = 该键被清成默认值，而界面上没有任何提示。所以逐个点名。
    // （四个 chat 字段是显式写的 `provider: p.provider`，八个角色字段走循环 ⇒ 两种写法各查各的。）
    for (const k of ['provider', 'model', 'apiKey', 'apiUrl']) {
      expect(body, `configOf 漏挑 ${k}`).toContain(`${k}: p.${k}`)
    }
    for (const k of ['embeddingModel', 'embedPath', 'embeddingApiUrl', 'embeddingApiKey',
      'rerankModel', 'rerankPath', 'rerankApiUrl', 'rerankApiKey']) {
      expect(body, `configOf 漏挑 ${k}`).toContain(`'${k}'`)
    }
    // 超时是数值，与上面那些字符串键不同型 ⇒ 必须分开写
    expect(body).toContain('picked.rerankTimeoutMs = p.rerankTimeoutMs')
    // 不许整体展开 profile：那会把 id/label/usedAt 一起提交进「配置」里
    expect(body).not.toMatch(/\.\.\.p\b/)
  })

  it('独立凭据留空 = 回落 chat 那一对，界面上把这条语义写在字段标题里', () => {
    expect(card).toContain('留空复用上面的 Key')
    expect(card).toContain('留空复用 API 地址')
    // 回落的**行为**在 `src/backend/tests/llm-embed-model.spec.ts` 里测（那里能真发一次假请求），
    // 本文件不跨目录去读 wechat-host.js —— 靠数 `../..` 层数定位文件的断言，挪一次文件就红。
  })
})
