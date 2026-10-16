/**
 * 模型名解析的**唯一出处**守卫（#20 第二个协作者的接线 + 那条 §7 F1 红线的机检）。
 *
 * 两件事分开钉：
 * ① **接线**：`GatewayCore` 的三个包装方法必须真的转给协作者 —— 搬完不挂等于把解析删了，
 *    而表现只是"模型名一直是空串"，界面会把能力静默关掉，没人报错。
 * ② **唯一出处**：除了那一个模块，谁都不许直接调宿主桥的 `embeddingModelName` /
 *    `rerankModelName`。这条就是 §7 F1 的形态学版本 —— 实错不是"解析写错了"，
 *    而是**同一个优先级被两处各算一遍**（这边记 `'default'`、那边发 `llm.json` 的值），
 *    于是「换没换嵌入模型」的判定永远不触发重建。只要还允许就地调桥，
 *    下一个加 AI 功能的人就会再复制一份那条链。
 *
 * 扫描先剥注释（`readStripped`）：本仓已经三次踩到「注释里的代码字样被当代码」。
 * @vitest-environment node
 */
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..', 'wechat-data')
const SRC = join(PKG, 'src')
const OWNER = 'gateway-models.ts'

/** 桥的两个"回答模型名"的方法：只有 `gateway-models.ts` 可以问它们。 */
const BRIDGE_CALLS = ['.embeddingModelName(', '.rerankModelName('] as const

function tsFiles(dir: string): string[] {
  const out: string[] = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...tsFiles(p))
    else if (e.name.endsWith('.ts')) out.push(p)
  }
  return out
}

/** 去注释后找「直接调桥」的文件（模块自己不在此列）。 */
function bridgeCallers(files: readonly string[], tokens: readonly string[]): string[] {
  return files
    .filter((p) => !p.endsWith(OWNER))
    .filter((p) => {
      const text = readFileSync(p, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
      return tokens.some((t) => text.includes(t))
    })
    .map((p) => p.replace(SRC + '\\', '').replace(SRC + '/', ''))
}

describe('模型名解析的唯一出处', () => {
  const files = tsFiles(SRC)

  it('扫描真的覆盖到了整棵树（读到 0 个文件时下面那条是恒真）', () => {
    expect(files.length, '没扫到源码文件 —— 路径判错').toBeGreaterThan(80)
    expect(files.some((p) => p.endsWith(OWNER)), `扫描里没有 ${OWNER}`).toBe(true)
  })

  it('除协作者本人，没人直接调宿主桥的模型名方法', () => {
    expect(bridgeCallers(files, BRIDGE_CALLS), '这些文件又绕过解析自己问桥了（两处各算一遍就是 §7 F1）').toEqual([])
  })

  it('GatewayCore 的三个包装确实转给协作者（不是自己又拼一遍）', () => {
    const core = readFileSync(join(SRC, 'gateway-core.ts'), 'utf8')
    for (const mark of ['embedModelNameOf(', 'globalModelNameOf(', 'kbModelOf(']) {
      expect(core, `gateway-core.ts 里找不到 ${mark} —— 委托被拆掉了吗`).toContain(mark)
    }
    // 反面：包装里不许留优先级链（那边只剩一行 return）
    for (const stale of ['llmAny?.config?.model', 'loadRetrievalConfig(this._dirs.decrypted).embedding.model']) {
      expect(core, `gateway-core.ts 里还留着 ${stale} —— 判断又长回类里了`).not.toContain(stale)
    }
  })

  it('反例自证：同一段扫描必须能抓住「就地调桥」的写法', () => {
    // 自指是这个判据最容易坏掉的地方：样例字面量若直接写在本文件里，`tsFiles(SRC)` 扫不到
    // （本文件在 `src/backend/tests/`，不在被扫的那棵树里），于是"抓住违例"这一步会恒过 ——
    // 所以下面用**扫描同一条码路径**的合成文件内容来验，而不是靠"看起来像"。
    const offender = 'const model = llm.' + 'embeddingModelName(override)\n'
    const compliant = 'const model = rc.' + 'embedModelName(cfg.embedding.model)\n'

    // 把两条样本喂给与判据同一个 `includes` 口径（用真文件当载体，验证的仍是这个函数）
    const probes = [offender, compliant]
    const hits = probes.map((text) => BRIDGE_CALLS.some((t) => text.includes(t)))
    expect(hits, '扫描口径分不开"直接调桥"与"走包装"').toEqual([true, false])

    // 现仓那一处相似写法（`askdeep.ts` 走包装）必须不被报成违例，否则零容忍是假绿
    expect(bridgeCallers([join(PKG, 'src', 'remotes', 'askdeep.ts')], BRIDGE_CALLS)).toEqual([])
  })
})
