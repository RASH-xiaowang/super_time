/** License Studio 渲染进程 */
const FEATURES = [
  'wechat-data',
  'ai-ask',
  'ai-summary',
  'export',
  'backup',
  'privacy-audit',
  'voice-transcribe',
]

const $ = (id) => /** @type {HTMLElement} */ (document.getElementById(id))
const input = (id) => /** @type {HTMLInputElement} */ ($(id))

function setStatus(el, text, kind) {
  el.textContent = text
  el.className = 'status' + (kind ? ` ${kind}` : '')
}

async function refreshKeys() {
  const el = $('keyInfo')
  try {
    const k = await window.studioAPI.keys()
    const match = k.matchClient && k.matchPrivate
    el.innerHTML = [
      `私钥: <span class="${k.hasPrivate ? 'mono ok' : 'mono err'}">${k.hasPrivate ? '已就绪' : '缺失'}</span>`,
      `<div class="mono">${k.privatePath}</div>`,
      `公钥一致性: <span class="${match ? 'mono ok' : 'mono err'}">${match ? '客户端 ≡ vendor-keys' : '不一致！会导致 signature_invalid'}</span>`,
      `<div class="mono">matchPrivate=${k.matchPrivate} matchClient=${k.matchClient}</div>`,
    ].join('<br/>')
  } catch (err) {
    el.textContent = String(err)
    el.className = 'mono err'
  }
}

function buildFeatureChecks() {
  const box = $('features')
  box.innerHTML = ''
  for (const f of FEATURES) {
    const label = document.createElement('label')
    const cb = document.createElement('input')
    cb.type = 'checkbox'
    cb.value = f
    cb.checked = true
    cb.dataset.feature = f
    label.appendChild(cb)
    label.appendChild(document.createTextNode(f))
    box.appendChild(label)
  }
}

function readForm() {
  const features = Array.from(document.querySelectorAll('#features input:checked'))
    .map((el) => /** @type {HTMLInputElement} */ (el).value)
  return {
    fingerprint: input('fingerprint').value.trim(),
    hostname: input('hostname').value.trim(),
    appVersionMin: input('appVersionMin').value.trim() || '1.0.0',
    name: input('name').value.trim(),
    company: input('company').value.trim(),
    email: input('email').value.trim(),
    edition: (/** @type {HTMLSelectElement} */ (document.getElementById('edition')).value) || 'pro',
    days: Number(input('days').value || 0),
    seats: Number(input('seats').value || 1),
    features,
    notes: input('notes').value.trim(),
  }
}

function init() {
  buildFeatureChecks()
  void refreshKeys()

  $('btnRefreshKeys').addEventListener('click', () => { void refreshKeys() })

  $('btnSyncPub')?.addEventListener('click', async () => {
    const r = await window.studioAPI.syncClientPub()
    await refreshKeys()
    if (r?.ok) {
      alert('已同步客户端公钥。\n请重启 Super Time 主程序后再导入许可证。')
    } else {
      alert(r?.error || '同步失败')
    }
  })

  $('btnGen').addEventListener('click', async () => {
    const r = await window.studioAPI.generateKeys()
    if (r?.ok) void refreshKeys()
    else if (!r?.canceled) alert(r?.error || '生成失败')
  })

  $('btnImportReq').addEventListener('click', async () => {
    const r = await window.studioAPI.importRequest()
    if (r?.ok) {
      input('fingerprint').value = r.request.fingerprint
      input('hostname').value = r.request.hostname || ''
      if (r.request.appVersion) input('appVersionMin').value = r.request.appVersion
      setStatus($('issueStatus'), `已导入激活请求\n${r.path}`, 'ok')
    } else if (!r?.canceled) {
      setStatus($('issueStatus'), r?.error || '导入失败', 'err')
    }
  })

  $('btnIssue').addEventListener('click', async () => {
    const form = readForm()
    const st = $('issueStatus')
    setStatus(st, '签发中…')
    const r = await window.studioAPI.issue(form)
    if (r?.ok) {
      setStatus(st, `✓ 已保存\n${r.path}\nlicenseId=${r.payload.licenseId}\n到期=${r.payload.expiresAt ?? '永久'}`, 'ok')
    } else if (r?.canceled) {
      setStatus(st, '已取消保存')
    } else {
      setStatus(st, r?.error || '签发失败', 'err')
    }
  })

  $('btnVerify').addEventListener('click', async () => {
    const st = $('verifyStatus')
    setStatus(st, '校验中…')
    const r = await window.studioAPI.verifyFile()
    if (r?.ok) {
      const p = r.payload
      setStatus(st, `✓ 签名与结构有效\n客户: ${p.issuedTo?.name ?? ''} ${p.issuedTo?.company ?? ''}\n版本: ${p.edition} · 席位: ${p.seats}\n到期: ${p.expiresAt ?? '永久'}\n功能: ${(p.features || []).join(', ')}`, 'ok')
    } else if (r?.canceled) {
      setStatus(st, '已取消')
    } else {
      setStatus(st, r?.error || '校验失败', 'err')
    }
  })
}

init()
