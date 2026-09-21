/**
 * 「取原图」的接线守卫（源码锚点，先剥注释；断言均为单行字符串，不受行尾影响）。
 *
 * 钉的都是「接错了也不报错」的地方：
 *   ① 取回成功后必须让取图那条 effect 重跑 —— 不重跑界面会一直停在缩略图，
 *      而后端确实已经把原图落盘了，症状像「功能没生效」；
 *   ② 失败原因必须显示给用户（约 82% 的消息没有免登录直链，一句「失败」没法解释）；
 *   ③ 客户端包装不许走 `cachedGet`：这是一个会改变本机状态的动作，缓存它
 *      等于让第二次点击什么都不做。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
const strip = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
const chats = strip(readFileSync(join(HERE, 'Chats.tsx'), 'utf8'))
const api = strip(readFileSync(join(HERE, '..', 'api.ts'), 'utf8'))

describe('取原图的接线', () => {
  const at = chats.indexOf('const getOriginal')
  const body = at < 0 ? '' : chats.slice(at, chats.indexOf('\n  }', at))

  it('图片气泡下方有「取原图」入口，点击走 apiGetImageOriginal', () => {
    expect(at, '找不到 getOriginal —— 改名时请同步本用例').toBeGreaterThan(-1)
    expect(chats.includes('取原图'), '图片下方要有「取原图」按钮')
    expect(body.includes('apiGetImageOriginal('), '按钮必须调用后端直取入口').toBe(true)
  })

  it('成功后让取图 effect 重跑，并把失败原因显示出来', () => {
    expect(/if \(r\.ok\)[\s\S]{0,240}setNonce\(\(n\) => n \+ 1\)/.test(body.replace(/\r/g, '')),
      '取回原图后必须 bump nonce 触发重新取图（否则界面一直停在缩略图）').toBe(true)
    expect(body.includes('r.error ??'), '取不到时要把后端给的原因显示出来，不能只说失败').toBe(true)
  })

  it('apiGetImageOriginal 不走结果缓存', () => {
    const w = api.indexOf('export async function apiGetImageOriginal')
    expect(w, '找不到 apiGetImageOriginal —— 改名时请同步本用例').toBeGreaterThan(-1)
    const fn = api.slice(w, api.indexOf('\n}', w))
    expect(fn.includes('getImageOriginal(options)'), '必须是透传').toBe(true)
    expect(fn.includes('cachedGet'), '这是一次改变本机状态的动作，缓存结果会让第二次点击什么都不做').toBe(false)
  })
})
