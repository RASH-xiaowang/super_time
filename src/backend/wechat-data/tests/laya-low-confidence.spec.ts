/**
 * 「信息不足」标注的判据与接线。
 *
 * 这条守卫守的是一件**很容易被顺手删掉**的事：极短消息（「啥」「好，」）上，同一模型对同一条
 * 消息的选项分布接近均匀（实测 Top1 常年 40–60%）—— 那一栏的答案随机性很大。标注不是「结果不准」
 * 的免责声明，而是**给用户一个可执行的提示**：该看的是上下文，不是这三个字。
 *
 * 判据本身是纯函数，所以这里不需要模型夹具；接线那两条按源码断言（先剥注释）。
 * @vitest-environment node
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { LOW_CONFIDENCE_MAX_CHARS, isLowConfidenceText } from '../src/laya/analysis.ts'

const HERE = dirname(fileURLToPath(import.meta.url))

describe('isLowConfidenceText', () => {
  it('① 极短消息算「信息不足」：标点与空白不算内容', () => {
    for (const t of ['啥', '好，', '好', '嗯。', '在吗', '在？', '???', ' ok ', '明天见', '那你说。', '，。！？…']) {
      expect(isLowConfidenceText(t), `${t} 应当算信息不足`).toBe(true)
    }
  })

  it('② 有实质内容的消息不算（阈值之上就不标，避免满屏「仅供参考」）', () => {
    for (const t of ['明天下午三点见', '你把那个文件发我一下', '收到，我马上就去处理']) {
      expect(isLowConfidenceText(t), `${t} 不该被标`).toBe(false)
    }
    // 阈值边界：恰好 LOW_CONFIDENCE_MAX_CHARS 个字算短，多一个字不算
    expect(isLowConfidenceText('一'.repeat(LOW_CONFIDENCE_MAX_CHARS))).toBe(true)
    expect(isLowConfidenceText('一'.repeat(LOW_CONFIDENCE_MAX_CHARS + 1))).toBe(false)
  })

  it('③ 空文本不算「信息不足」（那是「没文本」，不是「文本短」）', () => {
    for (const t of ['', '   ', '\n\t', '  \n  ']) {
      expect(isLowConfidenceText(t), `${JSON.stringify(t)} 不该被标`).toBe(false)
    }
  })

  it('④ 语音转写后的长文本不该因为「来自语音」而被标（只看文本本身）', () => {
    expect(isLowConfidenceText('我明天下午三点到公司，你到时候下来接我一下')).toBe(false)
    expect(isLowConfidenceText('好的')).toBe(true)
  })
})

describe('接线（源码断言，先剥注释）', () => {
  const strip = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
  // tests/ → wechat-data → backend → src → 仓库根（四层）
  const ROOT = join(HERE, '..', '..', '..', '..')
  const CLIENT_PANELS = join(ROOT, 'src', 'client', 'ui-wechat', 'src', 'client', 'pages', 'wechat-data', 'panels')
  const analysis = strip(readFileSync(join(HERE, '..', 'src', 'laya', 'analysis.ts'), 'utf8'))
  const hook = strip(readFileSync(join(CLIENT_PANELS, 'use-inline-analysis.ts'), 'utf8'))
  const panel = strip(readFileSync(join(CLIENT_PANELS, 'ChatAnalysisPanel.tsx'), 'utf8'))

  it('⑤ 逐条分析要给成功条目打标（失败条目不标：失败没有判断可言）', () => {
    const at = analysis.indexOf('items: items.map(')
    expect(at, '找不到打标那一句 —— 改名时请同步本用例').toBeGreaterThan(-1)
    const line = analysis.slice(at, analysis.indexOf('\n', at))
    expect(line.includes('it.ok ?'), '只标成功条目').toBe(true)
    expect(line.includes('isLowConfidenceText(it.sourceText)'), '判据用共享的纯函数').toBe(true)
  })

  it('⑥ 客户端要把它透传到界面（否则后端标了也看不见）', () => {
    expect(hook.includes('lowConfidence?: boolean'), '客户端镜像类型要有这个字段').toBe(true)
    expect(hook.includes('lowConfidence: it.lowConfidence === true'), '映射要带上它').toBe(true)
    expect(panel.includes('done.lowConfidence === true'), '面板要按它渲染').toBe(true)
    expect(panel.includes('信息不足，仅供参考'), '这句提示不能被删').toBe(true)
  })
})
