/**
 * 「已配置模型」这条链路的**宿主层接线**守卫（源码级）。
 *
 * 为什么单独一份：`llm-profiles.spec.ts` 只证明**存储层**本身对（懒迁移、成套切换、
 * 增删规则）。如果 main.js 忘了注册 IPC、或 preload 忘了暴露方法、或界面拿到的
 * 是另一个名字，存储层的 22 条用例照样全绿 —— 而用户点芯片是毫无反应。
 *
 * 另外钉两条设计契约：
 *   ① 切换走**独立**通道（`wechat:llm-profiles` 的 activate），不是复用「保存整个表单」——
 *      混在一起会逼着界面为了换个模型先构造一份完整表单，正是「要点两次、还容易把别家
 *      Key 一起提交」的老毛病；
 *   ② 每次写盘都要把「当前生效值」摊平到顶层（老读者 `loadLlmConfig` 与旧版本只认顶层）。
 * @vitest-environment node
 */
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

/** 读源码并去掉注释 —— 否则注释里提到旧做法会让断言误判。 */
function codeOf(...parts: string[]): string {
  const src = readFileSync(join(ROOT, ...parts), 'utf8')
  return src.replace(/\/\*[\s\S]*?\*\//g, '').split(/\r?\n/).map(l => l.replace(/\/\/.*$/, '')).join('\n')
}

const paths = codeOf('src', 'backend', 'wechat-paths.js')
// M21：wechat:* 频道搬去了 src/backend/ipc-wechat.js ⇒ 读「main.js + 全部 ipc-*.js」的联合
const main = [codeOf('main.js'), readdirSync(join(ROOT, 'src', 'backend'))
  .filter((f) => /^ipc-[a-z]+\.js$/.test(f)).sort()
  .map((f) => readFileSync(join(ROOT, 'src', 'backend', f), 'utf8')).join('\n')].join('\n')
const preload = codeOf('preload.js')

describe('模型配置集：存储层导出', () => {
  it('四个能力都从 wechat-paths.js 导出（否则 main.js 解构到 undefined）', () => {
    for (const name of ['loadLlmStore', 'activateLlmProfile', 'upsertLlmProfile', 'deleteLlmProfile']) {
      expect(paths, `wechat-paths.js 没导出 ${name}`).toMatch(new RegExp(`\\n\\s+${name},`))
    }
  })

  it('写完盘一律把「当前生效值」摊平到顶层（旧版本读同一份文件也不会坏）', () => {
    const at = paths.indexOf('function persistLlmStore(')
    expect(at).toBeGreaterThan(-1)
    const body = paths.slice(at, at + 600)
    expect(body).toContain('writeLlmFile({ ...flat, profiles: store.profiles, activeProfileId: store.activeProfileId })')
  })

  it('「至少保留一条」是存储层的规则，不靠界面自觉', () => {
    const at = paths.indexOf('function deleteLlmProfile(')
    expect(paths.slice(at, at + 900)).toMatch(/至少保留一条/)
  })
})

describe('模型配置集：主进程接线', () => {
  it('main.js 从 wechat-paths 解构了这四个函数', () => {
    const at = main.indexOf('require(\'./src/backend/wechat-paths\')')
    expect(at).toBeGreaterThan(-1)
    const block = main.slice(Math.max(0, at - 700), at)
    for (const name of ['loadLlmStore', 'activateLlmProfile', 'upsertLlmProfile', 'deleteLlmProfile']) {
      expect(block, `main.js 没解构 ${name}`).toContain(name)
    }
  })

  it('注册了 wechat:llm-profiles 通道，四个 op 都接上', () => {
    expect(main).toContain("ipcMain.handle('wechat:llm-profiles'")
    const at = main.indexOf("ipcMain.handle('wechat:llm-profiles'")
    const body = main.slice(at, at + 1400)
    expect(body).toMatch(/op === 'list'[\s\S]{0,80}?loadLlmStore\(\)/)
    expect(body).toMatch(/op === 'activate'[\s\S]{0,80}?activateLlmProfile\(/)
    expect(body).toMatch(/op === 'save'[\s\S]{0,80}?upsertLlmProfile\(/)
    expect(body).toMatch(/op === 'delete'[\s\S]{0,80}?deleteLlmProfile\(/)
    // 未知 op 明确报错，不静默当成 list
    expect(body).toContain('未知的模型配置操作')
  })

  it('切换是轻动作：activate 分支不碰「保存整个表单」那条路径', () => {
    const at = main.indexOf("ipcMain.handle('wechat:llm-profiles'")
    const body = main.slice(at, at + 1400)
    expect(body).not.toContain('saveLlmConfig')
  })

  it('旧的 wechat:llm-save / wechat:llm-get 仍在（向后兼容）', () => {
    expect(main).toContain("ipcMain.handle('wechat:llm-get'")
    expect(main).toContain("ipcMain.handle('wechat:llm-save'")
  })
})

describe('模型配置集：preload 暴露面', () => {
  it('四个方法都暴露给渲染层，且都打在同一条 IPC 上', () => {
    const at = preload.indexOf("getLlmConfig:")
    expect(at).toBeGreaterThan(-1)
    const block = preload.slice(at, at + 1300)
    for (const m of ['getLlmProfiles', 'activateLlmProfile', 'saveLlmProfile', 'deleteLlmProfile']) {
      expect(block, `preload 没暴露 ${m}`).toContain(`${m}:`)
    }
    const calls = block.match(/invoke\('wechat:llm-profiles'/g) ?? []
    expect(calls.length, '四个方法的 IPC 通道数不对').toBe(4)
    for (const op of ['list', 'activate', 'save', 'delete']) {
      expect(block, `缺少 op: ${op}`).toContain(`op: '${op}'`)
    }
  })

  it('旧的三个方法仍在（老渲染端不会因为新增配置集而失效）', () => {
    for (const m of ['getLlmConfig:', 'saveLlmConfig:', 'listLlmModels:']) {
      expect(preload, `preload 丢了 ${m}`).toContain(m)
    }
  })
})
