/**
 * 「总结不限制字数」的**界面**守卫（2026-11-19）。
 *
 * 为什么需要它：后端已经改成「篇幅按素材量决定」，但界面上有三份**各自维护**的格式清单
 * （`SummaryParts.tsx` 的下拉 hint、`SummaryTaskDrawer.tsx` 与 `DailySummary.tsx` 的卡片
 * 描述）。只改其中一两处，用户看到的仍然是「叙事（300–500 字）」—— 而界面上写着区间，
 * 就是明确承诺了字数，后端再怎么不限都没用（实测就是被这么问回来的）。
 *
 * 所以这里把判据钉在**整个 client 目录**上：任何总结格式清单都不许出现「N–M 字 / N–M 条」
 * 这类区间。用扫描而不是逐个文件断言，是因为漏掉的第四份清单正是这么漏的。
 * @vitest-environment node
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
const PANELS = HERE

/** 三份清单所在文件（后续新增清单时把文件名加进来）。 */
const FORMAT_FILES = ['SummaryParts.tsx', 'SummaryTaskDrawer.tsx', 'DailySummary.tsx']

/**
 * 剥注释后再断言。
 *
 * 这几个文件的注释里**记着旧写法**（「此前这里是 `150–250 字`」），不剥会把说明文字
 * 当成违规命中 —— 仓库里 `outbound-site-coverage.spec.ts` 的 `codeOf()` 同理。
 */
function codeOf(file: string): string {
  const src = readFileSync(join(PANELS, file), 'utf8')
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

/** 「数字–数字 字/条」—— 界面上的字数承诺。 */
const RANGE_RE = /\d+\s*[–\-—]\s*\d+\s*(字|条)/

describe('总结格式清单：界面不许承诺字数', () => {
  it('三份清单都不含字数区间', () => {
    for (const file of FORMAT_FILES) {
      const code = codeOf(file)
      const hits = code.match(new RegExp(RANGE_RE.source, 'g')) ?? []
      expect(hits, `${file} 里还在承诺字数：${hits.join('、')}（用户会以为还在限字数）`).toHaveLength(0)
    }
  })

  it('防空转：扫描确实读到了这三份清单（否则上面的判据恒真）', () => {
    for (const file of FORMAT_FILES) {
      const code = codeOf(file)
      expect(code, `${file} 里找不到格式清单 —— 改名后请同步本用例`).toMatch(/key: 'brief'/)
    }
  })

  it('每种格式仍给出**形状**提示（去掉的只是字数，不是可用性）', () => {
    const parts = codeOf('SummaryParts.tsx')
    for (const key of ['brief', 'detailed', 'bullets', 'story']) {
      expect(parts, `SummaryParts 缺少 ${key} 的 hint`).toMatch(new RegExp(`key: '${key}'[^}]*hint: '[^']+'`))
    }
    // 抽屉与旧面板用 desc 字段，同样不许为空。
    for (const file of ['SummaryTaskDrawer.tsx', 'DailySummary.tsx']) {
      const code = codeOf(file)
      for (const key of ['brief', 'detailed', 'bullets', 'story']) {
        expect(code, `${file} 缺少 ${key} 的 desc`).toMatch(new RegExp(`key: '${key}'[^}]*desc: '[^']+'`))
      }
    }
  })
})
