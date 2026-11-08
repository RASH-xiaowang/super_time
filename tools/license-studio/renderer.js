/** 授权签发台渲染进程：功能目录由主进程提供，避免界面与后台各维护一份。 */

const $ = (id) => /** @type {HTMLElement} */ (document.getElementById(id))
const input = (id) => /** @type {HTMLInputElement} */ ($(id))

/** @type {null | { featureCatalog: any[], featureGroups: any[], requiredFeatures: string[], editions: any[], featureSchemaVersion: number }} */
let meta = null
/** @type {Map<string, any>} */
let featureById = new Map()

function setStatus(el, text, kind) {
  el.textContent = text
  el.className = 'status' + (kind ? ` ${kind}` : '')
}

function el(tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text != null) node.textContent = String(text)
  return node
}

function featureLabel(id) {
  return featureById.get(String(id))?.label || `未知功能（${String(id)}）`
}

function editionLabel(value) {
  return meta?.editions?.find((edition) => edition.value === String(value))?.label || String(value || '—')
}

function selectedFeatureIds() {
  return Array.from(document.querySelectorAll('#features input[type="checkbox"]:checked'))
    .map((node) => /** @type {HTMLInputElement} */ (node).value)
}

function updateFeatureCount() {
  const count = selectedFeatureIds().length
  const total = meta?.featureCatalog?.length ?? 0
  $('featureCount').textContent = `已开放 ${count} / ${total} 项`
}

function setFeatureSelection(ids) {
  const picked = new Set(ids)
  for (const node of document.querySelectorAll('#features input[type="checkbox"]')) {
    const checkbox = /** @type {HTMLInputElement} */ (node)
    checkbox.checked = picked.has(checkbox.value) || checkbox.dataset.required === 'true'
  }
  updateFeatureCount()
}

function buildFeatureChecks() {
  const box = $('features')
  box.replaceChildren()
  if (!meta) {
    box.appendChild(el('p', 'empty', '功能目录读取失败'))
    return
  }

  for (const group of meta.featureGroups) {
    const features = meta.featureCatalog.filter((feature) => feature.group === group.id)
    if (!features.length) continue

    const section = el('section', 'featureGroup')
    const head = el('div', 'featureGroupHead')
    head.appendChild(el('h3', null, group.label))
    head.appendChild(el('span', null, group.description))
    section.appendChild(head)

    const grid = el('div', 'featureGrid')
    for (const feature of features) {
      const label = el('label', 'featureOption' + (feature.required ? ' required' : ''))
      label.title = `功能标识：${feature.id}`

      const checkbox = document.createElement('input')
      checkbox.type = 'checkbox'
      checkbox.value = feature.id
      checkbox.checked = true
      checkbox.dataset.feature = feature.id
      if (feature.required) {
        checkbox.dataset.required = 'true'
        checkbox.disabled = true
      }
      checkbox.addEventListener('change', updateFeatureCount)
      label.appendChild(checkbox)

      const copy = el('span')
      const name = el('span', 'featureName')
      name.appendChild(document.createTextNode(feature.label))
      if (feature.required) name.appendChild(el('span', 'requiredTag', '必选'))
      copy.appendChild(name)
      copy.appendChild(el('span', 'featureDesc', feature.description))
      label.appendChild(copy)
      grid.appendChild(label)
    }
    section.appendChild(grid)
    box.appendChild(section)
  }
  updateFeatureCount()
}

function buildEditionOptions() {
  const select = /** @type {HTMLSelectElement} */ ($('edition'))
  const current = select.value
  select.replaceChildren()
  for (const edition of meta?.editions ?? []) {
    const option = document.createElement('option')
    option.value = edition.value
    option.textContent = edition.label
    select.appendChild(option)
  }
  if (current && Array.from(select.options).some((option) => option.value === current)) {
    select.value = current
  }
}

async function refreshKeys() {
  const target = $('keyInfo')
  try {
    const keys = await window.studioAPI.keys()
    const match = keys.matchClient && keys.matchPrivate
    target.replaceChildren()
    const privateLine = el('div')
    privateLine.append('私钥：')
    privateLine.appendChild(el('span', keys.hasPrivate ? 'mono ok' : 'mono err', keys.hasPrivate ? '已就绪' : '缺失'))
    target.appendChild(privateLine)
    target.appendChild(el('div', 'mono', keys.privatePath || keys.privateError || '—'))
    const publicLine = el('div')
    publicLine.append('公钥一致性：')
    publicLine.appendChild(el('span', match ? 'mono ok' : 'mono err', match ? '客户端与 vendor-keys 一致' : '不一致，可能导致 signature_invalid'))
    target.appendChild(publicLine)
    target.appendChild(el('div', 'mono', `私钥匹配：${keys.matchPrivate ? '是' : '否'} · 客户端匹配：${keys.matchClient ? '是' : '否'}`))
  } catch (err) {
    target.textContent = String(err)
    target.className = 'mono err'
  }
}

function readForm() {
  const picked = new Set(selectedFeatureIds())
  for (const required of meta?.requiredFeatures ?? []) picked.add(required)
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
    features: (meta?.featureCatalog ?? [])
      .filter((feature) => picked.has(feature.id))
      .map((feature) => feature.id),
    notes: input('notes').value.trim(),
  }
}

function renderVerifySummary(payload) {
  const summary = $('verifySummary')
  summary.replaceChildren()
  const features = Array.isArray(payload?.features) ? payload.features : []

  const items = [
    ['客户', payload?.issuedTo?.name || '—'],
    ['公司', payload?.issuedTo?.company || '—'],
    ['版本', editionLabel(payload?.edition)],
    ['席位', payload?.seats ?? '—'],
    ['到期', payload?.expiresAt ? new Date(payload.expiresAt).toLocaleString('zh-CN') : '永久'],
    ['功能目录', payload?.featureSchemaVersion === meta?.featureSchemaVersion ? '新版（逐项授权）' : '旧版（兼容模式）'],
  ]
  for (const [name, value] of items) {
    const item = el('dl', 'verifyItem')
    item.appendChild(el('dt', null, name))
    item.appendChild(el('dd', null, value))
    summary.appendChild(item)
  }

  const featureBlock = el('div', 'verifyItem')
  featureBlock.style.gridColumn = '1 / -1'
  featureBlock.appendChild(el('dt', null, `开放功能（${features.length} 项）`))
  const tags = el('div', 'tagList')
  for (const feature of features) {
    const known = featureById.has(feature)
    tags.appendChild(el('span', known ? 'tag' : 'tag muted', featureLabel(feature)))
  }
  if (!features.length) tags.appendChild(el('span', 'tag muted', '无'))
  featureBlock.appendChild(tags)
  summary.appendChild(featureBlock)
  summary.hidden = false
}

function clearVerifySummary() {
  const summary = $('verifySummary')
  summary.hidden = true
  summary.replaceChildren()
}

async function init() {
  $('btnIssue').disabled = true
  try {
    meta = await window.studioAPI.meta()
    featureById = new Map((meta?.featureCatalog ?? []).map((feature) => [feature.id, feature]))
    buildEditionOptions()
    buildFeatureChecks()
    $('btnIssue').disabled = false
  } catch (err) {
    $('features').replaceChildren(el('p', 'empty', `功能目录读取失败：${String(err)}`))
    $('featureCount').textContent = '功能目录不可用'
    setStatus($('issueStatus'), `功能目录读取失败：${err?.message || String(err)}`, 'err')
  }
  void refreshKeys()

  $('btnRefreshKeys').addEventListener('click', () => { void refreshKeys() })

  $('btnSelectAll').addEventListener('click', () => {
    setFeatureSelection((meta?.featureCatalog ?? []).map((feature) => feature.id))
  })
  $('btnSelectData').addEventListener('click', () => {
    const ids = (meta?.featureCatalog ?? [])
      .filter((feature) => feature.group === 'base' || feature.group === 'data')
      .map((feature) => feature.id)
    setFeatureSelection(ids)
  })
  $('btnSelectCore').addEventListener('click', () => {
    setFeatureSelection(meta?.requiredFeatures ?? [])
  })

  $('btnSyncPub')?.addEventListener('click', async () => {
    const result = await window.studioAPI.syncClientPub()
    await refreshKeys()
    if (result?.ok) {
      alert('已同步客户端公钥。\n请重启 Super Time 主程序后再导入许可证。')
    } else {
      alert(result?.error || '同步失败')
    }
  })

  $('btnGen').addEventListener('click', async () => {
    const result = await window.studioAPI.generateKeys()
    if (result?.ok) void refreshKeys()
    else if (!result?.canceled) alert(result?.error || '生成失败')
  })

  $('btnImportReq').addEventListener('click', async () => {
    const result = await window.studioAPI.importRequest()
    if (result?.ok) {
      input('fingerprint').value = result.request.fingerprint
      input('hostname').value = result.request.hostname || ''
      if (result.request.appVersion) input('appVersionMin').value = result.request.appVersion
      setStatus($('issueStatus'), `已导入激活请求\n${result.path}`, 'ok')
    } else if (!result?.canceled) {
      setStatus($('issueStatus'), result?.error || '导入失败', 'err')
    }
  })

  $('btnIssue').addEventListener('click', async () => {
    const form = readForm()
    const status = $('issueStatus')
    if (!/^[a-fA-F0-9]{32,}$/.test(form.fingerprint)) {
      setStatus(status, '请先填写有效的设备指纹（至少 32 位十六进制字符）', 'err')
      return
    }
    if (!form.name) {
      setStatus(status, '请填写客户姓名', 'err')
      return
    }
    $('btnIssue').disabled = true
    setStatus(status, '签发中…')
    try {
      const result = await window.studioAPI.issue(form)
      if (result?.ok) {
        const labels = (result.payload.features || []).map(featureLabel)
        setStatus(
          status,
          `已保存许可证\n${result.path}\n许可证编号：${result.payload.licenseId}\n`
            + `到期：${result.payload.expiresAt ? new Date(result.payload.expiresAt).toLocaleString('zh-CN') : '永久'}\n`
            + `开放功能（${labels.length} 项）：${labels.join('、')}`,
          'ok',
        )
      } else if (result?.canceled) {
        setStatus(status, '已取消保存')
      } else {
        setStatus(status, result?.error || '签发失败', 'err')
      }
    } finally {
      $('btnIssue').disabled = false
    }
  })

  $('btnVerify').addEventListener('click', async () => {
    const status = $('verifyStatus')
    clearVerifySummary()
    setStatus(status, '校验中…')
    const result = await window.studioAPI.verifyFile()
    if (result?.ok) {
      const payload = result.payload
      const features = (payload.features || []).map(featureLabel)
      setStatus(
        status,
        `签名与结构有效\n客户：${payload.issuedTo?.name ?? ''} ${payload.issuedTo?.company ?? ''}\n`
          + `功能目录：${payload.featureSchemaVersion === meta?.featureSchemaVersion ? '新版（逐项授权）' : '旧版（兼容模式）'}`,
        'ok',
      )
      renderVerifySummary(payload)
      if (!features.length) setStatus(status, '签名与结构有效，但许可证未列出任何功能', 'warn')
    } else if (result?.canceled) {
      setStatus(status, '已取消')
    } else {
      setStatus(status, result?.error || '校验失败', 'err')
    }
  })
}

init()
