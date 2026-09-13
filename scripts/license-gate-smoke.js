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
const { authorizeCall, hasFeature, getLicenseStatus, isUsableStatus } = require('../src/license/service')

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

assert(authorizeCall(licensed, 'getSessions').ok, '正式证允许基础查询')
assert(authorizeCall(licensed, 'askWechat').ok, '正式证允许 ai-ask')
assert(!authorizeCall(licensed, 'generateDailySummary').ok, '无 ai-summary 时拒绝每日总结')
assert(!authorizeCall(expired, 'getSessions').ok, '过期拒绝一切业务调用')
assert(authorizeCall(expired, 'getSessions').code === 'EXPIRED', '过期 code=EXPIRED')
assert(!authorizeCall(unlicensed, 'getSessions').ok, '无证拒绝一切业务调用')
assert(authorizeCall(unlicensed, 'getSessions').code === 'LICENSE_REQUIRED', '无证 code=LICENSE_REQUIRED')
assert(!isUsableStatus(unlicensed) && isUsableStatus(licensed), 'isUsableStatus 只认 licensed')
// 旧版的试用态即使被伪造进状态对象也不得放行
assert(!isUsableStatus({ state: 'trial', licensed: false }), '伪造的 trial 态不放行')
assert(!authorizeCall({ state: 'trial', licensed: false, code: 'TRIAL' }, 'getSessions').ok, '伪造的 trial 态被拒绝')
assert(hasFeature(licensed, 'export') && !hasFeature(licensed, 'backup'), 'hasFeature 按 features 列表')
assert(hasFeature(licensed, 'wechat-data'), 'hasFeature 命中 wechat-data')

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
} finally {
  fs.rmSync(tmp, { recursive: true, force: true })
}

console.log('\n门禁测试全部通过')
