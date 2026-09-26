/**
 * `moments-export.ts` 的判据（第三批 #18 第三步）。
 *
 * 重点全在 `buildExportOptions` 这颗纯函数上：它决定**导出的文件里有什么**，
 * 而它的形状一旦漂移，界面上毫无征兆 —— 屏幕上筛的是「只看我的、九月、有图的」，
 * 导出来可能是全部。所以这里逐键钉「给了才带、没给就不许这个键出现」，
 * 并钉住两个最容易混的口径：`username`（微信用户名，深链带进来的）与
 * `authorName`（作者显示名，作者牌选中的）不许互相顶替。
 * @module moments-export-spec
 */
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { buildExportOptions, type ExportForm, type ExportScope } from './moments-export.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const FILE = 'src/client/ui-wechat/src/client/pages/wechat-data/panels/moments-export.ts'

const FORM: ExportForm = { format: 'html', from: '', to: '', dir: '', images: false, zip: false }
const SCOPE: ExportScope = { search: '', media: 'all', month: null, mine: 'all' }

describe('buildExportOptions：逐键「给了才带」', () => {
  it('什么都没筛 ⇒ 只剩 format（少一个键 = 后端按全量口径导）', () => {
    expect(buildExportOptions(FORM, SCOPE)).toEqual({ format: 'html' })
  })

  it('每个筛选项单独生效', () => {
    expect(buildExportOptions(FORM, { ...SCOPE, search: '  南宁  ' })).toEqual({ format: 'html', q: '南宁' })
    expect(buildExportOptions(FORM, { ...SCOPE, media: 'image' })).toEqual({ format: 'html', media: 'image' })
    expect(buildExportOptions(FORM, { ...SCOPE, month: '2026-09' })).toEqual({ format: 'html', month: '2026-09' })
    expect(buildExportOptions(FORM, { ...SCOPE, mine: 'mine' })).toEqual({ format: 'html', mine: 'mine' })
    expect(buildExportOptions({ ...FORM, images: true }, SCOPE)).toEqual({ format: 'html', images: true })
    expect(buildExportOptions({ ...FORM, zip: true }, SCOPE)).toEqual({ format: 'html', zip: true })
    expect(buildExportOptions({ ...FORM, dir: 'D:/out' }, SCOPE)).toEqual({ format: 'html', dir: 'D:/out' })
  })

  it('media/mine 的 all 是「不设筛」，不许当成值发出去', () => {
    const o = buildExportOptions(FORM, { ...SCOPE, media: 'all', mine: 'all' })
    expect(Object.hasOwn(o, 'media'), 'media=all 被发出去了').toBe(false)
    expect(Object.hasOwn(o, 'mine'), 'mine=all 被发出去了').toBe(false)
  })

  it('空搜索串不产生 q 键（否则后端按「匹配空串」筛一遍）', () => {
    expect(Object.hasOwn(buildExportOptions(FORM, { ...SCOPE, search: '   ' }), 'q')).toBe(false)
  })

  it('username 与 authorName 是两个口径，不许互相顶替', () => {
    const o = buildExportOptions(FORM, { ...SCOPE, username: 'wxid_zhang', authorName: '张三' })
    expect(o).toEqual({ format: 'html', username: 'wxid_zhang', authorName: '张三' })
    // 只给一个时另一个不许出现
    expect(buildExportOptions(FORM, { ...SCOPE, authorName: '张三' })).toEqual({ format: 'html', authorName: '张三' })
    expect(buildExportOptions(FORM, { ...SCOPE, username: 'wxid_zhang' })).toEqual({ format: 'html', username: 'wxid_zhang' })
    expect(buildExportOptions(FORM, { ...SCOPE, username: null, authorName: null })).toEqual({ format: 'html' })
  })

  it('日期两端按本地时区取整天，且是秒', () => {
    const o = buildExportOptions({ ...FORM, from: '2026-09-03', to: '2026-09-04' }, SCOPE)
    expect(o.from).toBe(Math.floor(new Date('2026-09-03T00:00:00').getTime() / 1000))
    expect(o.to).toBe(Math.floor(new Date('2026-09-04T23:59:59').getTime() / 1000))
    // 同一天设成 from=to 时必须覆盖那一整天（结束那头取 00:00 会把当天整个筛掉，
    // 朋友圈列表那边已经因为这个错过一次）
    const one = buildExportOptions({ ...FORM, from: '2026-09-03', to: '2026-09-03' }, SCOPE)
    expect((one.to as number) - (one.from as number)).toBe(86399)
  })

  it('format 原样透传（用户选 md/json 时不许被改写成 html）', () => {
    for (const f of ['md', 'json', 'csv', 'html']) expect(buildExportOptions({ ...FORM, format: f }, SCOPE).format).toBe(f)
  })
})

describe('接线：导出只有这一条路', () => {
  const panel = readFileSync(join(HERE, 'moments-panel.tsx'), 'utf8')

  it('面板走钩子，且不再自己持有表单状态', () => {
    expect(panel).toContain('useMomentsExport')
    for (const gone of ['const [expFormat', 'const [exportOpen', 'apiExportMoments', 'apiDecryptAllDatabases', 'pickDirectory']) {
      expect(panel, `「${gone}」又回到面板里了 ⇒ 导出口径又要长第二份拼装`).not.toContain(gone)
      expect(readFileSync(FILE, 'utf8'), `本层里也找不到「${gone}」⇒ 上面那条判据的对象是编的`).toContain(gone)
    }
  })

  it('全仓只有这一层真的调 `apiExportMoments`', () => {
    const callers = readdirSync(HERE, { withFileTypes: true })
      .filter((e) => e.isFile() && /\.(ts|tsx)$/.test(e.name) && !e.name.includes('.spec.'))
      .filter((e) => readFileSync(join(HERE, e.name), 'utf8').includes('apiExportMoments('))
      .map((e) => e.name)
    expect(callers, `调用点不该散开：${callers.join(', ') || '（一个都没有 ⇒ 判据在空转）'}`).toEqual(['moments-export.ts'])
  })
})
