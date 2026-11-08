#!/usr/bin/env node
/**
 * License 门禁单元测试：无证/过期/缺功能 一律拒绝，且**不存在试用期**。
 *
 * 应用不再有内置试用：未导入许可证时状态是 `unlicensed`，
 * 并且在 userData 里不写任何试用状态文件（旧版会写 license-trial.json）。
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { authorizeCall, authorizeFeature, hasFeature, getLicenseStatus, isUsableStatus } = require('../src/license/service')
const { PRODUCT_ID, validatePayload } = require('../src/license/schema')

function assert(cond, msg) {
  if (!cond) {
    console.error('FAIL:', msg)
    process.exit(1)
  }
  console.log('ok:', msg)
}

const licensed = {
  state: 'licensed',
  licensed: true,
  code: 'OK',
  payload: { features: ['wechat-data', 'ai-ask', 'export'] },
}
const expired = { state: 'expired', licensed: false, code: 'EXPIRED' }
const unlicensed = { state: 'unlicensed', licensed: false, code: 'LICENSE_REQUIRED' }
const licensedV2 = {
  state: 'licensed',
  licensed: true,
  code: 'OK',
  payload: {
    features: ['wechat-data', 'chats', 'ai-ask'],
    featureSchemaVersion: 2,
  },
}

assert(authorizeCall(licensed, 'getSessions').ok, '正式证允许基础查询')
assert(authorizeCall(licensed, 'askWechat').ok, '正式证允许 ai-ask')
assert(!authorizeCall(licensed, 'generateDailySummary').ok, '无 ai-summary 时拒绝每日总结')
assert(!authorizeCall(expired, 'getSessions').ok, '过期拒绝一切业务调用')
assert(authorizeCall(expired, 'getSessions').code === 'EXPIRED', '过期 code=EXPIRED')
assert(!authorizeCall(unlicensed, 'getSessions').ok, '无证拒绝一切业务调用')
assert(authorizeCall(unlicensed, 'getSessions').code === 'LICENSE_REQUIRED', '无证 code=LICENSE_REQUIRED')
// 新版证书严格按逐项功能位判定；
assert(authorizeCall(licensedV2, 'getSessions').ok, '新版证书含“聊天会话”时允许查询会话')
assert(!authorizeCall(licensedV2, 'getAnnualReview').ok, '新版证书未含年度报告时拒绝年度报告')
assert(authorizeCall(licensedV2, 'getAnnualReview').message.includes('年度报告'), '拒绝理由使用中文功能名')
assert(!authorizeFeature(licensedV2, 'image-ai').ok, '新版证书未含图片智能理解时拒绝直连 IPC 功能')
// 旧证没有功能目录版本，基础位继续兼容新增的数据模块（不改变已签发客户的用法）。
assert(authorizeCall(licensed, 'getAnnualReview').ok, '旧证的基础位兼容新增数据功能')
assert(authorizeFeature(licensed, 'image-ai').ok, '旧证的基础位兼容已有直连能力')
assert(!isUsableStatus(unlicensed) && isUsableStatus(licensed), 'isUsableStatus 只认 licensed')
// 旧版的试用态即使被伪造进状态对象也不得放行
assert(!isUsableStatus({ state: 'trial', licensed: false }), '伪造的 trial 态不放行')
assert(!authorizeCall({ state: 'trial', licensed: false, code: 'TRIAL' }, 'getSessions').ok, '伪造的 trial 态被拒绝')
assert(hasFeature(licensed, 'export') && !hasFeature(licensed, 'backup'), 'hasFeature 按 features 列表')
assert(hasFeature(licensed, 'wechat-data'), 'hasFeature 命中 wechat-data')
const v2MissingBase = validatePayload({
  product: PRODUCT_ID,
  licenseId: 'LIC-V2-NO-BASE',
  edition: 'pro',
  issuedTo: { name: '测试客户' },
  device: { fingerprint: 'f'.repeat(40) },
  issuedAt: '2026-01-01T00:00:00.000Z',
  features: ['chats'],
  featureSchemaVersion: 2,
  seats: 1,
})
assert(!v2MissingBase.ok && v2MissingBase.reason.includes('wechat-data'), '新版许可证缺少基础功能位时结构校验拒绝')
const v2UnknownFeature = validatePayload({
  product: PRODUCT_ID,
  licenseId: 'LIC-V2-UNKNOWN-FEATURE',
  edition: 'pro',
  issuedTo: { name: '测试客户' },
  device: { fingerprint: 'f'.repeat(40) },
  issuedAt: '2026-01-01T00:00:00.000Z',
  features: ['wechat-data', 'typo-feature'],
  featureSchemaVersion: 2,
  seats: 1,
})
assert(!v2UnknownFeature.ok && v2UnknownFeature.reason.includes('unknown_feature'), '新版许可证包含未登记功能位时结构校验拒绝')

// ── 真实状态：空 userData 必须落到 unlicensed，且不落任何试用文件 ──
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'st-license-gate-'))
try {
  const st = getLicenseStatus(tmp, '1.0.0')
  assert(st.state === 'unlicensed', `无证时 state=unlicensed（实际 ${st.state}）`)
  assert(st.licensed === false, '无证时 licensed=false')
  assert(st.code === 'LICENSE_REQUIRED', `无证时 code=LICENSE_REQUIRED（实际 ${st.code}）`)
  assert(st.trial === undefined, '状态里不再有 trial 字段')
  const written = fs.readdirSync(tmp)
  assert(!written.includes('license-trial.json'), '不写 license-trial.json')
  assert(written.length === 0, `userData 保持空目录（实际 ${JSON.stringify(written)}）`)

  // 遗留的试用文件不得产生任何授权效果
  fs.writeFileSync(path.join(tmp, 'license-trial.json'), JSON.stringify({ startedAt: new Date().toISOString() }))
  const st2 = getLicenseStatus(tmp, '1.0.0')
  assert(st2.state === 'unlicensed' && !st2.licensed, '遗留 license-trial.json 不产生授权')
  assert(!authorizeCall(st2, 'getSessions').ok, '遗留试用文件下业务调用仍被拒绝')

  // ── H6 的第一条验收：损坏的 license.json ⇒ 拒绝 + 能给用户看的中文 ──────────
  // 读代码时这条是安全的（`store.readLicenseFile` 把 `JSON.parse` 包在 try 里、异常回 null；
  // `getLicenseStatus` 见没有 payload/signature 就落到 unlicensed；`ipc-wechat.js` 的 catch 也拒绝）。
  // 但 H6 的验收要求「构造损坏的 license.json」真的跑一遍 —— 许可闸门是那种「异常时必须关死」的门，
  // 只在源码里看它关得上的门，跟没验过一样。
  // 载荷**合 schema**、只有签名是乱填的：这才真正走到验签那一步（而不是被 schema 先挡下来）
  const validPayload = {
    product: PRODUCT_ID,
    licenseId: 'LIC-SMOKE-0001',
    edition: 'pro',
    issuedTo: { name: '冒烟客户' },
    device: { fingerprint: 'f'.repeat(40) },
    issuedAt: '2026-01-01T00:00:00.000Z',
    expiresAt: '2099-01-01T00:00:00.000Z',
    features: ['wechat-data'],
    seats: 1,
  }
  const corrupt = [
    ['空文件', ''],
    ['只写了半个 JSON', '{"payload": {"features": '],
    ['根本不是 JSON', 'license = true'],
    ['JSON 但不是对象', '"just a string"'],
    ['顶层是数组', '[]'],
    ['有 payload 没有 signature', JSON.stringify({ payload: { features: ['wechat-data'] } })],
    ['signature 不是字符串', JSON.stringify({ payload: { features: ['wechat-data'] }, signature: 42 })],
    ['payload 是 null', JSON.stringify({ payload: null, signature: 'x' })],
    ['载荷合 schema 但签名乱填', JSON.stringify({ payload: validPayload, signature: 'bogus' })],
  ]
  for (const [label, content] of corrupt) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-license-corrupt-'))
    try {
      fs.writeFileSync(path.join(dir, 'license.json'), content, 'utf8')
      const st = getLicenseStatus(dir, '1.0.0')
      assert(!isUsableStatus(st), `${label}：不得判为可用（实际 state=${st.state}）`)
      const g = authorizeCall(st, 'getSessions')
      assert(!g.ok, `${label}：业务调用必须被拒`)
      assert(/[\u4e00-\u9fff]/.test(g.message), `${label}：拒绝理由要能给用户看的中文（实际「${g.message}」）`)
      // 错误码必须是真实拒绝码之一（乱填签名那条按实现顺序落到验签或设备校验，两者都算拒）
      assert(['LICENSE_REQUIRED', 'INVALID_PAYLOAD', 'BAD_SIGNATURE', 'DEVICE_MISMATCH', 'EXPIRED', 'NOT_BEFORE', 'VERSION'].includes(g.code),
        `${label}：必须带回可信的错误码（实际 ${JSON.stringify(g.code)}）`)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }

  // `license.json` 被一个目录占了位：`readFileSync` 会抛 EISDIR，是 store 层 catch 的另一条入口
  const dirCase = fs.mkdtempSync(path.join(os.tmpdir(), 'st-license-dir-'))
  try {
    fs.mkdirSync(path.join(dirCase, 'license.json'))
    const st3 = getLicenseStatus(dirCase, '1.0.0')
    assert(!isUsableStatus(st3) && !authorizeCall(st3, 'getSessions').ok, 'license.json 是目录时同样拒绝（不抛到调用方）')
  } finally {
    fs.rmSync(dirCase, { recursive: true, force: true })
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true })
}

console.log('\n门禁测试全部通过')
