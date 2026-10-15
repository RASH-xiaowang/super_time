/**
 * 失实反馈守卫（W3-11.2）：产品**活代码**里不许再出现已被移除的出网机制的措辞。
 *
 * ## 为什么单独立一条，而不是并进出网开关那条
 *
 * `outbound-site-coverage.spec.ts` 已经钉住「`blockOutbound` 等标识符不许回来」，但
 * **中文措辞**是另一个漏法：2026-09-30 出网拦截整体移除后，产品里仍留着三处**会说给用户听**
 * 的旧文案（`Ask.tsx` 降级 chip 的 title、`kb-files-panel.tsx` 的字段说明、以及一个
 * 无调用方却仍返回「已按『出站拦截』处理：已阻止…」的死函数）。它们不是标识符，
 * 旧守卫抓不到；而它们的危害比标识符回归更大——**告诉用户一个不存在的机制正在保护他**。
 *
 * 口径：**剥注释后**再查。注释里正当会写「2026-09-30 起『出站拦截』已移除」的历史说明
 * （本仓刻意保留这类说明，免得下一个人不知道那段机制曾经存在），那不是回归；
 * 只有**活代码**（字符串字面量、JSX 属性、模板）里出现才算。
 *
 * 变异自证：往任一活代码字符串里塞回「出站拦截」→ 本文件转红。
 * @vitest-environment node
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

/** 被移除机制的措辞：出现在活代码里一律算失实反馈。 */
const STALE_PHRASES = ['出站拦截', '出站被拦截', '禁止 AI 出网', '禁止地图底图出网', '已阻止「']

function walk(dir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'dist' || e.name === 'ui-dist' || e.name.startsWith('.')) continue
    const p = join(dir, e.name)
    if (e.isDirectory()) walk(p, acc)
    else if (/\.(?:tsx|ts|js|mjs|cjs)$/.test(e.name)) acc.push(relative(ROOT, p).replace(/\\/g, '/'))
  }
  return acc
}

/** 剥注释（与 outbound-site-coverage.spec.ts 同款：注释里的历史说明不算活代码）。 */
function codeOf(file: string): string {
  const src = readFileSync(join(ROOT, file), 'utf8').replace(/\r\n/g, '\n')
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

/** 这些目录里的文件不是本仓手写产品代码（vendored / 生成物 / 依赖）。 */
function skipped(rel: string): boolean {
  if (rel.startsWith('src/backend/deps/')) return true
  if (rel.includes('/lib/')) return true          // lib/index.js 与 lib/types 是生成物
  if (rel.endsWith('.d.ts')) return true
  if (/\.spec\.(ts|tsx)$/.test(rel)) return true   // 用例里正当会写历史与反例
  if (rel.startsWith('node_modules/')) return true
  return false
}

/**
 * 产品代码清单：只扫 `src/**`。
 *
 * 为什么不扫 `scripts/**`：那批文件里有三处**正当**提到被移除开关的地方，而且都是活代码，
 * 机械上区分不开 —— `ui-acceptance.mjs` 把「禁止 AI 出网」当**搜索pattern**用来断言它
 * **不在**界面上（那是防回归本身）；`mutations-registry.*.mjs` 在变异登记的 why 里记录历史。
 * 把 scripts 扫进来只会得到三条豁免，而豁免一多这条判据就开始漏水。用户看得见的反馈只住在
 * `src/`（渲染层文案 + 后端错误消息），所以范围就划在这里。
 */
function productFiles(): string[] {
  const out: string[] = []
  const root = join(ROOT, 'src')
  for (const f of walk(root)) if (!skipped(f)) out.push(f)
  return out.sort()
}

describe('失实反馈：被移除的出网机制不许出现在活代码里', () => {
  const files = productFiles()

  it('防空转：真的扫到了产品代码', () => {
    expect(files.length, '一个产品文件都没扫到 ⇒ 扫描范围错了').toBeGreaterThan(50)
  })

  it('活代码里不许有「出站拦截」等已移除机制的措辞', () => {
    const offenders: string[] = []
    for (const f of files) {
      const code = codeOf(f)
      for (const phrase of STALE_PHRASES) {
        if (code.includes(phrase)) offenders.push(`${f}：「${phrase}」`)
      }
    }
    expect(offenders,
      '这些文件在活代码里提到已移除的出网机制（用户会被告知一个不存在的保护）：\n  '
      + offenders.join('\n  ')).toEqual([])
  })

  it('判别力自证：合成一个违例必须被抓住（否则这条判据是空的）', () => {
    const fake = 'const a = "未配置向量模型、向量索引未就绪，或「出站拦截」已开启"'
    const hit = STALE_PHRASES.filter((p) => fake.includes(p))
    expect(hit, '合成违例没被措辞清单覆盖 ⇒ 判据是空的').toEqual(['出站拦截'])
  })
})
