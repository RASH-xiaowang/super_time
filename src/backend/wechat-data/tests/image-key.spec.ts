/**
 * Effective image-key resolution: config.json wins, keys.json (key store)
 * is the fallback so auto-recovered keys work before the user saves config.
 *
 * 2026-09-20 起这一路**真的接上了**：此前 `resolveImageKeyPair` 没有任何解码入口调用它
 * （产物 `lib/index.js` 里搜不到这个名字，被 esbuild 当死代码摇掉），于是 README 承诺的
 * 「回退 keys.json」只剩前半句。所以现在除了原有的三条，还要钉：
 *   ④ 库存的密钥**属于别的账号**时不许用（同机换账号会解出垃圾图，且不报错）；
 *   ⑤ 属于当前账号时要用 —— 且两侧 wxid 的后缀写法不同也能对上（目录名带 `_后缀`）；
 *   ⑥ 归属信息缺失或形状不是 wxid（老账号目录用别名）时**放行**：那是「没有证据」，
 *      不能据此把用户本来能用的密钥判死（放行 = 本次改动之前的行为）。
 * @vitest-environment node
 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveImageKeyPair } from '../src/query/image-key.ts'
import { saveConfig } from '../src/query/config.ts'
import { upsertAccountKeysInStore } from '../src/keys/key-store.ts'
import { imageKeySlotFor } from '../src/keys/service.ts'

const scratch: string[] = []
/** 本文件用 env 指定「当前账号」，用例之间必须还原，否则会串到别的 spec。 */
const SELF_ENV = 'DSH_WECHAT_SELF_WXID'
const originalSelf = process.env[SELF_ENV]
afterEach(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true })
  scratch.length = 0
  if (originalSelf === undefined) delete process.env[SELF_ENV]
  else process.env[SELF_ENV] = originalSelf
})

function dataRoot(): { root: string; decrypted: string } {
  const root = mkdtempSync(join(tmpdir(), 'wx-imgkey-'))
  scratch.push(root)
  const decrypted = join(root, 'decrypted')
  mkdirSync(decrypted)
  return { root, decrypted }
}

describe('resolveImageKeyPair', () => {
  it('falls back to the key store when config.json has no image key', () => {
    const { root, decrypted } = dataRoot()
    upsertAccountKeysInStore('default', { image_aes_key: '0123456789abcdef', image_xor_key: '60', image_key_verified: true }, root)
    const img = resolveImageKeyPair(decrypted)
    expect(img.aesKey).toBe('0123456789abcdef')
    expect(img.xorKey).toBe(60)
  })
  it('prefers config.json over the key store', () => {
    const { root, decrypted } = dataRoot()
    upsertAccountKeysInStore('default', { image_aes_key: '0123456789abcdef', image_xor_key: '60', image_key_verified: true }, root)
    saveConfig(decrypted, { image_aes_key: 'cccccccccccccccc', image_xor_key: 0xab })
    const img = resolveImageKeyPair(decrypted)
    expect(img.aesKey).toBe('cccccccccccccccc')
    expect(img.xorKey).toBe(0xab)
  })

  it('returns an absent key + default xor when neither source has an image key', () => {
    const { decrypted } = dataRoot()
    const img = resolveImageKeyPair(decrypted)
    // undefined 而不是 ''：解码入口拿到的就是「没有密钥」，不会再出现空串被当成密钥传下去
    expect(img.aesKey).toBeUndefined()
    expect(img.xorKey).toBe(136)
  })

  it('忽略属于别的账号的库存密钥（同机换账号不能拿上一位的钥匙硬解）', () => {
    const { root, decrypted } = dataRoot()
    process.env[SELF_ENV] = 'wxid_current'
    upsertAccountKeysInStore('default', {
      image_aes_key: '0123456789abcdef',
      image_xor_key: '60',
      image_key_verified: true,
      image_key_derived_wxid: 'wxid_previous',
    }, root)
    const img = resolveImageKeyPair(decrypted)
    expect(img.aesKey).toBeUndefined()
    // xor 仍按配置口径给默认值：调用方只在 aesKey 存在时才会用到它
    expect(img.xorKey).toBe(136)
  })

  it('当前账号的库存密钥要用上，且目录名带的 _后缀不影响归属判定', () => {
    const { root, decrypted } = dataRoot()
    process.env[SELF_ENV] = 'wxid_current'
    // 内存扫描路径记的是账号目录名（`wxid_x_<后缀>`），派生路径记的是 wxid 本身：
    // 两条都要能和当前账号对上，否则就是「明明能解却报未配置」。
    upsertAccountKeysInStore('default', {
      image_aes_key: 'fedcba9876543210',
      image_xor_key: '88',
      image_key_verified: true,
      image_key_source_wxid_dir: 'wxid_current_20240101',
    }, root)
    const img = resolveImageKeyPair(decrypted)
    expect(img.aesKey).toBe('fedcba9876543210')
    expect(img.xorKey).toBe(88)
  })

  it('内存扫描那条路只记了来源目录名 —— 它也必须能区分账号', () => {
    // 上一条单独存在是**假通过**的：「目录名被当成没有归属信息而放行」与「目录名对上而使用」
    // 结果完全一样（变异掉来源字段后两条都还绿）。这一条才是判别式的：
    // 同一形状、只是账号不同，就必须判死。
    const { root, decrypted } = dataRoot()
    process.env[SELF_ENV] = 'wxid_current'
    upsertAccountKeysInStore('default', {
      image_aes_key: 'fedcba9876543210',
      image_xor_key: '88',
      image_key_verified: true,
      image_key_source_wxid_dir: 'wxid_previous_20240101',
    }, root)
    expect(resolveImageKeyPair(decrypted).aesKey).toBeUndefined()
  })

  it('归属信息缺失时放行（没有证据 ≠ 别人的密钥）', () => {
    const { root, decrypted } = dataRoot()
    process.env[SELF_ENV] = 'wxid_current'
    // 老数据：两个来源字段都没有 —— 第一条用例覆盖的正是这一路，这里再钉一次「不判死」
    upsertAccountKeysInStore('default', {
      image_aes_key: 'aabbccddeeff0011',
      image_key_verified: true,
      image_key_derived_wxid: 'alice_2024',
    }, root)
    expect(resolveImageKeyPair(decrypted).aesKey).toBe('aabbccddeeff0011')
  })

  it('当前账号解析成别名（不是 wxid 形状）时也放行', () => {
    // 老账号的数据目录用人名命名，`wxidFromDbDir` 会把它原样返回；此时「对不上」不能
    // 当成「是别人的钥匙」—— 否则这类安装从此再也解不出图（本项改动前的行为是能用）。
    const { root, decrypted } = dataRoot()
    saveConfig(decrypted, { db_dir: 'E:/xwechat_files/alice_2024/db_storage' })
    upsertAccountKeysInStore('default', {
      image_aes_key: '9988776655443322',
      image_key_verified: true,
      image_key_derived_wxid: 'wxid_previous',
    }, root)
    expect(resolveImageKeyPair(decrypted).aesKey).toBe('9988776655443322')
  })
/**
 * W2-2.2：自动图片密钥按**归属账号分槽**（写入侧）+ 老库继续可读（迁移）。
 *
 * ## 这条在守什么
 *
 * 图片密钥是每账号的：甲账号的钥匙解乙账号的图不报错，只会解出一张垃圾图。
 * 而三类自动取钥路径都把结果写进同一个全局槽 —— 一台机器上两个微信账号时，
 * **乙跑一次自动取钥就把甲的记录覆盖掉**。读取侧的归属校验这时候会正确地拒绝这把钥匙，
 * 表现就是「甲本来能用的图突然都要重新配钥」，不报错、也归因不到「乙用过一次」。
 */
describe('W2-2.2：自动密钥按账号分槽，且老库记录继续可读', () => {
  const SELF = 'wxid_alpha000'
  const OTHER = 'wxid_beta000'

  it('自己那个槽优先于全局槽', () => {
    const { root, decrypted } = dataRoot()
    process.env[SELF_ENV] = SELF
    // 全局槽里是别人的（归属明确），自己槽里是自己的
    upsertAccountKeysInStore('default', { image_aes_key: 'aaaaaaaaaaaaaaaa', image_key_derived_wxid: OTHER }, root)
    upsertAccountKeysInStore(SELF, { image_aes_key: 'bbbbbbbbbbbbbbbb', image_key_derived_wxid: SELF }, root)
    expect(resolveImageKeyPair(decrypted).aesKey).toBe('bbbbbbbbbbbbbbbb')
  })

  it('另一个账号写了全局槽，不影响本账号（原来会互相覆盖的那个）', () => {
    const { root, decrypted } = dataRoot()
    process.env[SELF_ENV] = SELF
    upsertAccountKeysInStore(SELF, { image_aes_key: 'cccccccccccccccc', image_key_derived_wxid: SELF }, root)
    // 乙跑了一次自动取钥：它只该动乙的槽（或动全局槽），绝不该让甲读不到
    upsertAccountKeysInStore(OTHER, { image_aes_key: 'dddddddddddddddd', image_key_derived_wxid: OTHER }, root)
    upsertAccountKeysInStore('default', { image_aes_key: 'eeeeeeeeeeeeeeee', image_key_derived_wxid: OTHER }, root)
    // 前提：全局槽里确实躺着乙的密钥（否则这条没测到互相覆盖）
    expect(resolveImageKeyPair(decrypted).aesKey).toBe('cccccccccccccccc')
  })

  it('老库：密钥只在全局槽、且归属就是当前账号 => 继续可读（升级不要求重新配钥）', () => {
    const { root, decrypted } = dataRoot()
    process.env[SELF_ENV] = SELF
    upsertAccountKeysInStore('default', { image_aes_key: 'ffffffffffffffff', image_key_derived_wxid: SELF }, root)
    expect(resolveImageKeyPair(decrypted).aesKey).toBe('ffffffffffffffff')
  })

  it('老库：全局槽里是别人的、自己槽里没有 => 判没有密钥，不拿别人的硬解', () => {
    const { root, decrypted } = dataRoot()
    process.env[SELF_ENV] = SELF
    upsertAccountKeysInStore('default', { image_aes_key: '1111111111111111', image_key_derived_wxid: OTHER }, root)
    expect(resolveImageKeyPair(decrypted).aesKey).toBeUndefined()
  })
})

/**
 * 写入侧的槽名选择：`imageKeySlotFor`。
 *
 * 归属判不出来时**必须**继续写全局槽 —— 那条路上归属校验仍然兜着，而为了分槽把记录丢掉
 * 比不分槽更糟。
 */
describe('W2-2.2：imageKeySlotFor 选槽', () => {
  it('有派生 wxid => 用它（与读取侧同一个 cleanWxid 口径）', () => {
    expect(imageKeySlotFor('wxid_alpha000_abcd')).toBe(imageKeySlotFor('wxid_alpha000'))
  })

  it('只有来源目录名、且形状像 wxid => 也按账号分槽', () => {
    expect(imageKeySlotFor(undefined, 'wxid_beta000')).toBe('wxid_beta000')
  })

  it('别名目录（不是 wxid 形状）=> 退回全局槽', () => {
    expect(imageKeySlotFor(undefined, 'MyAliasDir')).toBe('default')
  })

  it('什么都判不出来 => 退回全局槽', () => {
    expect(imageKeySlotFor()).toBe('default')
  })
})
/**
 * W2-2.2 的**接线**判据：三个自动取钥写入点必须走 `imageKeySlotFor`。
 *
 * 为什么单独立一份：上面的用例只能钉 `imageKeySlotFor` 自己算得对，钉不住**调用点**——
 * 而「调用点写回全局槽」正是这条要修的病。真实写入路径要微信进程与真账号目录，
 * 单测跑不到，所以按接线判（与仓库里 anchors / theme-geometry 同一套形状）。
 */
describe('W2-2.2 接线：自动密钥写入点都按账号分槽', () => {
  const service = readFileSync(new URL('../src/keys/service.ts', import.meta.url), 'utf8')

  /** 剥注释后按 `upsertAccountKeysInStore(` 切开，取每段（= 一次调用）做判断。 */
  function bareImageWrites(src: string): string[] {
    // 剥注释：注释里会解释老形状，不能把它自己判红。
    const noComment = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
    const out: string[] = []
    const parts = noComment.split('upsertAccountKeysInStore(')
    for (let i = 1; i < parts.length; i += 1) {
      const call = parts[i] ?? ''
      // 只关心写了图片密钥的那些调用；db_key 是全局的，写 default 是对的。
      if (!/image_aes_key/.test(call)) continue
      if (!/imageKeySlotFor\(/.test(call)) out.push(call.trim().slice(0, 60))
    }
    return out
  }

  it('service.ts 里没有裸写图片密钥到固定槽的调用', () => {
    expect(bareImageWrites(service),
      '这些图片密钥写入点还在写固定槽 ⇒ 同机多账号会互相覆盖').toEqual([])
  })

  it('拆掉分槽这条判据会红（不是恒真）', () => {
    // 把 imageKeySlotFor(...) 整个抹掉 = 回到「写默认槽」的老形状
    const fake = service.replace(/imageKeySlotFor\([^)]*\)/g, 'undefined')
    expect(bareImageWrites(fake).length,
      '把 imageKeySlotFor 全删掉居然没抓到 ⇒ 这条判据是空转的').toBeGreaterThan(0)
  })
})
})
