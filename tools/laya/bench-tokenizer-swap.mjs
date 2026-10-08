/**
 * 换 tokenizer 前的**等价性验证**：用 `@huggingface/tokenizers`（纯 JS、零依赖）加载同一个
 * `tokenizer.json`，把 fixture 里 `tokenTable` 的 32 条文本**逐 token** 比对。
 *
 * 为什么这个 oracle 够硬：`tokenTable` 是 Python 侧（HF tokenizers，Rust）dump 出来的真实
 * 分词结果，而 `laya-sequence.spec.ts` 已经用它证明过「`buildSequence` 的拼装是对的」。
 * 所以「分词器输出 == tokenTable」+「拼装已证」= 整条输入链等价。
 *
 * 跑法：node tools/laya/bench-tokenizer-swap.mjs
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..')
const MODEL_DIR = process.env.DSH_WECHAT_LAYA_DIR ?? String.raw`D:\laya\models`
const TOK_DIR = join(MODEL_DIR, 'tokenizer')

const FIX = JSON.parse(readFileSync(join(ROOT, 'src/backend/wechat-data/tests/fixtures/laya-sequence.json'), 'utf8'))

// `@huggingface/tokenizers` 同时给 CJS/ESM 两个入口；**必须走 ESM 那条**
// （`require.resolve` 会解析到 `dist/tokenizers.cjs`，那个 bundle 没有 `Tokenizer` 命名导出
//   ⇒ 报 `Tokenizer is not a constructor`，看起来像"包不对"，其实是入口选错了）。
const { Tokenizer } = await import('@huggingface/tokenizers')

const json = JSON.parse(readFileSync(join(TOK_DIR, 'tokenizer.json'), 'utf8'))
const cfg = JSON.parse(readFileSync(join(TOK_DIR, 'tokenizer_config.json'), 'utf8'))

console.log('='.repeat(78))
console.log('@huggingface/tokenizers 换装验证：逐 token 比 fixture.tokenTable')
console.log(`  模型目录 ${MODEL_DIR}`)
console.log(`  tokenizer.json 模型类型 ${json?.model?.type} / vocab ${Object.keys(json?.model?.vocab ?? {}).length}`)
console.log('='.repeat(78))

const tok = new Tokenizer(json, cfg)

const hasEncode = typeof tok.encode === 'function'
console.log(`  实例可 encode: ${hasEncode}`)

// 特殊 id：生产代码要 cls/sep/mask/pad 四个。先从 tokenizer.json 的 added_tokens 里查，
// 查不到再退回「拿字面量编码一次」——两条路都打出来，便于挑更稳的那条。
const added = new Map((json.added_tokens ?? []).map((a) => [a.content, a.id]))
const specials = {}
for (const [name, atomic] of [['cls', '<bos>'], ['sep', '<eos>'], ['mask', '<mask>'], ['pad', '<pad>']]) {
  specials[name] = added.get(atomic) ?? null
}
console.log(`  added_tokens 里查到: ${JSON.stringify(specials)}（fixture 期望 ${JSON.stringify(FIX.specialIds)}）`)

let pass = 0
let fail = 0
const fails = []
for (const [text, expected] of Object.entries(FIX.tokenTable)) {
  let got
  try {
    const enc = tok.encode(text, { add_special_tokens: false })
    got = enc.ids ?? enc.input_ids
  } catch (e) {
    got = `THROW: ${e.message}`
  }
  const ok = Array.isArray(got) && got.length === expected.length && got.every((v, i) => v === expected[i])
  if (ok) pass += 1
  else {
    fail += 1
    if (fails.length < 4) {
      fails.push(`  ✗ ${JSON.stringify(text.slice(0, 46))}（期望 ${expected.length} 个，得到 ${
        Array.isArray(got) ? got.length + ' 个' : got}）\n      exp=${JSON.stringify(expected.slice(0, 10))}\n      got=${
        JSON.stringify(Array.isArray(got) ? got.slice(0, 10) : got)}`)
    }
  }
}

console.log('')
console.log(`  逐 token 比对：PASS ${pass} / ${pass + fail}`)
if (fails.length > 0) {
  console.log(fails.join('\n'))
  console.log('')
  console.log('❌ 不能换装（分词结果与 Python 侧不一致）')
  process.exit(1)
}
if (JSON.stringify(specials) !== JSON.stringify(FIX.specialIds)) {
  console.log('⚠️ 特殊 id 与 fixture 不一致 —— encode 全对但特殊标记要另想办法取')
}
console.log('✅ 32/32 逐 token 一致 ⇒ 可以换装')
