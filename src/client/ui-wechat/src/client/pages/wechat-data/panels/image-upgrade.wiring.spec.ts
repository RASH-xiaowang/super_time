/**
 * 「升级为原图」的接线守卫（源码锚点，先剥注释；断言均为精确切片，不用「锚点往后 N 字符」的窗口）。
 *
 * 钉的都是「接错了也不报错」的地方：
 *   ① 客户端包装必须是**透传**且**不走结果缓存** —— 它是一次改变本机状态的动作，
 *      缓存返回值会让第二次点击什么都不做（与「取原图」同一条理由）；
 *   ② 「一张都没升级」的两种原因（本来就够好 / 本机没有更大的源）必须**分开报**：
 *      合成一句「完成」会让用户以为工具坏了，而下一步动作完全不同；
 *   ③ 升级期间要同时禁用「批量解密」与「立即升级」两个按钮：后端是**同一条忙闲闸门**，
 *      两个都能点就会有人点了第二下拿到「已有解密任务进行中」，看起来像功能出错。
 */
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readStripped, sliceBetween } from '../../../test-helpers/wiring-kit.ts'

const HERE = import.meta.dirname
const read = (rel: string): string => readStripped(join(HERE, rel))

const state = read('./settings-state.tsx')
const steps = read('./settings-steps.tsx')
const settings = read('./Settings.tsx')
const api = read('../api-config.ts')

describe('升级为原图 · 客户端接线', () => {
  const fn = sliceBetween(state, 'const upgradeImgs = ', '\n  const keyOk', 'upgradeImgs 回调体')

  it('① 回调走后端升级入口，并把详情弹窗标题改成升级', () => {
    expect(fn.includes('apiUpgradeDecodedImages('), '必须调后端升级入口').toBe(true)
    expect(fn.includes("setImgDetailTitle('原图升级详情')"),
      '解密与升级共用同一个详情弹窗，标题必须跟着变').toBe(true)
  })

  it('② 「已升级 0 张」要把「无需升级」与「本机无源」分开说', () => {
    // 只切**那一个分支**：`r.noSource` 在成功分支里也会出现，全函数 `includes` 会是假绿
    // （实测：把这条分支里的 noSource 删掉，全函数仍然含这个字符串 —— 变异不咬）。
    const a = fn.indexOf('r.upgraded === 0')
    expect(a, '找不到「一张都没升级」那条分支').toBeGreaterThan(-1)
    const b = fn.indexOf('\n      }', a)
    const branch = b > a ? fn.slice(a, b) : fn.slice(a)
    expect(branch.includes('r.unchanged'), '要报「本来就够好」的数量').toBe(true)
    expect(branch.includes('r.noSource'), '要报「本机没有更大的源」的数量').toBe(true)
  })

  it('③ 结束时收起进度（异常路径也要），并把后端给的整体错误显示出来', () => {
    expect(/finally \{[\s\S]{0,120}setImgUpgrading\(false\)/.test(fn),
      '必须用 finally 收尾，否则抛异常后按钮永久卡在「升级中…」').toBe(true)
    expect(fn.includes('r.error'), '后端整体失败（如已有解密任务在跑）要把原因说出来').toBe(true)
  })

  it('④ apiUpgradeDecodedImages 是透传且不走结果缓存', () => {
    const wrapper = api.slice(api.indexOf('export async function apiUpgradeDecodedImages'))
    expect(wrapper.startsWith('export async function apiUpgradeDecodedImages'), '找不到包装函数').toBe(true)
    const body = wrapper.slice(0, wrapper.indexOf('\n}'))
    expect(body.includes('upgradeDecodedImages()'), '必须是透传').toBe(true)
    expect(body.includes('cachedGet'), '这是一次改变本机状态的动作，缓存结果会让第二次点击什么都不做').toBe(false)
  })

  it('⑤ 卡片里有入口，且升级期间两个按钮互斥（后端是同一条忙闲闸门）', () => {
    const section = sliceBetween(steps, 'export function SettingsImgDecodeSection', 'export interface SettingsVoiceSectionProps', '图片解码卡片')
    const props = sliceBetween(steps, 'export interface SettingsImgDecodeSectionProps', 'export function SettingsImgDecodeSection', '卡片道具')
    expect(props.includes('upgradeImgs: () => Promise<void>'), '道具里要有 upgradeImgs').toBe(true)
    expect(section.includes('void upgradeImgs()'), '入口必须真的接上回调').toBe(true)
    expect(section.includes('立即升级'), '按钮文案').toBe(true)
    expect(section.includes('disabled={imgUpgrading || imgDecrypting}'),
      '升级中要禁用自己与批量解密（后端是同一条闸门，两个都能点就会有一下拿到「已有解密任务进行中」）').toBe(true)
    expect(section.includes('void decryptImgs() }} disabled={imgDecrypting || imgUpgrading}'),
      '批量解密那一路同样要在升级期间禁用').toBe(true)
  })

  it('⑥ 面板把状态与回调透传给卡片', () => {
    expect(settings.includes('imgUpgradeResult={imgUpgradeResult}')).toBe(true)
    expect(settings.includes('upgradeImgs={upgradeImgs}')).toBe(true)
    expect(settings.includes('title={imgDetailTitle}'), '详情弹窗标题要跟着最后跑的动作走').toBe(true)
  })

  it('⑦ 真的换了图就清掉内存缓存（否则首帧仍是旧缩略图，「升级成功」看起来像没发生）', () => {
    expect(/if \(r\.upgraded > 0\) forgetAllImages\(\)/.test(fn),
      '升级成功后必须清一次全应用共用的图片内存缓存；一张都没升级时不清，免得白跑一屏取图').toBe(true)
  })
})
