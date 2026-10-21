/**
 * 任务信息面板真实桌面端验收（2026-10-20）。
 *
 * 这份脚本验证的是**浏览器里真正能看到、能点到的行为**，而不是组件源码：
 *  · 深链进入「任务信息」，左右两栏与空态都可见；
 *  · 左栏搜索任务名/关键词/会话/对象，清除按钮与无匹配空态可用；
 *  · 右栏由服务端搜索触发记录，覆盖 `%` / `_` 字面量和失败错误；
 *  · 编辑 = **右侧抽屉**（`role="dialog"`）：标题含任务名、Webhook 地址字段、
 *    群聊「仅匹配@我的文本」、三种关闭方式（× / Esc / 点遮罩），并留存抽屉截图
 *    `.tmp-e2e/task-center-edit-drawer.png`；
 *  · 触发方式选择器由后端厂商目录（`listRpaVendors`）驱动：选项含 Webhook / 八爪鱼 RPA /
 *    影刀 RPA；切到八爪鱼填旧 aria（`八爪鱼 FlowId`/`八爪鱼 API Key`）→ 读回
 *    `triggerConfig.flowId` + `triggerSecretSet.apiKey`；切到影刀填 `AccessKeyId`/
 *    `AccessKeySecret`/`应用 UUID` → 读回 `triggerConfig.robotUuid` + 两个 secretSet；
 *    再切回八爪鱼仍能读到旧 FlowId 并保存（切换厂商不清空已填）；凭据原文不出现在列表返回值；
 *  · 任务行摘要显示「八爪鱼 RPA · <flowId>」；
 *
 * 数据隔离：每次使用一个临时 `SUPERTIME_USER_DATA_DIR`，不读写真实微信数据。
 * 触发记录直接写进临时任务库，是为了稳定造出「同一毫秒 + 跨页」的边界；任务则经
 * Remote 创建/删除，确保验收走真实的 IPC → worker → SQLite 写路径。
 *
 * 运行：node scripts/task-center-e2e.mjs
 * 退出码：0 = 全部通过；1 = 有断言失败；2 = 缺少 playwright / electron.exe。
 */
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const EXE = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const EVIDENCE_DIR = join(ROOT, '.tmp-e2e')

/** 两栏触发记录的页大小（与 `use-task-center-triggers.ts` 的 `TRIGGER_PAGE_SIZE` 一致）。 */
const PAGE_SIZE = 100
/** 夹具总数：首屏 100 + 第二页 20，覆盖游标边界。 */
const TRIGGER_TOTAL = 120
/** 固定的合成时间，避免跨日导致界面文案不稳定。 */
const BASE_AT = Date.UTC(2026, 9, 19, 8, 0, 0)

let _electron
try {
  ;({ _electron } = await import('playwright'))
} catch (error) {
  console.error('[前置] 缺少 playwright：', error.message)
  console.error('       npm i --no-save playwright    # 驱动 Electron 不需要下载浏览器二进制')
  process.exit(2)
}
if (!existsSync(EXE)) {
  console.error('[前置] 找不到 electron.exe：', EXE, '（先跑 npm ci）')
  process.exit(2)
}

const results = []
const check = (ok, label, detail = '') => {
  results.push({ ok: !!ok, label, detail: String(detail) })
}
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms) })

const userData = mkdtempSync(join(tmpdir(), 'super-time-task-center-e2e-'))
const wechatData = join(userData, 'wechat-data')
const decrypted = join(wechatData, 'decrypted')
const taskDb = join(wechatData, 'wechat_task_center.db')
const screenshotPath = join(EVIDENCE_DIR, 'task-center-e2e.png')
let app = null

/** 等后端 Remote 就绪：首屏挂载通常早于 worker init。 */
async function waitForRemote(win) {
  return win.evaluate(async () => {
    const deadline = Date.now() + 60_000
    let lastError = ''
    for (;;) {
      const result = await window.electronAPI.wechat.listMethods()
      const methods = result?.value ?? result
      if (Array.isArray(methods) && methods.includes('listTaskInfos')) {
        const call = await window.electronAPI.wechat.call('listTaskInfos', [])
        if (call?.ok === true) return { ok: true, methods: methods.length }
        lastError = call?.error?.message ?? JSON.stringify(call?.error ?? '')
      } else {
        lastError = result?.error?.message ?? '后端方法面尚未就绪'
      }
      if (Date.now() > deadline) return { ok: false, error: lastError }
      await new Promise((resolve) => { setTimeout(resolve, 250) })
    }
  })
}

/**
 * 调 Remote 并解开 `{ ok, value }` 信封。
 * @param win - Electron 页面。
 * @param method - Remote 方法名。
 * @param args - 位置参数数组。
 * @returns 业务返回值；信封失败时抛错。
 */
async function remote(win, method, args = []) {
  const result = await win.evaluate(async ({ methodName, parameters }) => {
    const response = await window.electronAPI.wechat.call(methodName, parameters)
    if (response?.ok === true) return { ok: true, value: response.value }
    const error = response?.error
    return {
      ok: false,
      error: typeof error === 'string' ? error : (error?.message ?? JSON.stringify(error ?? null)),
    }
  }, { methodName: method, parameters: args })
  if (!result.ok) throw new Error(`${method} 调用失败：${result.error}`)
  return result.value
}

/** 打开首次配置向导时点「稍后再说」；没有向导也无妨。 */
async function dismissOnboarding(win) {
  const later = win.getByRole('button', { name: '稍后再说', exact: true })
  try {
    await later.waitFor({ state: 'visible', timeout: 5_000 })
    await later.click()
  } catch { /* 没有向导 */ }
}

/**
 * 深链打开任务信息。`WechatDataPanel` 只在挂载时读 hash，因此必须 reload 一次，
 * 不能只改 location.hash 等 React 自己响应。
 */
async function openTaskCenterByHash(win) {
  await win.evaluate(() => { location.hash = '#taskinfo' })
  await win.reload({ waitUntil: 'domcontentloaded' })
  await win.waitForLoadState('domcontentloaded')
  await dismissOnboarding(win)
  await win.getByRole('heading', { name: '任务信息', exact: true }).waitFor({ state: 'visible', timeout: 30_000 })
}

/** 等左栏出现某任务名，或等给定文案出现。 */
async function waitForTaskName(win, name, timeout = 20_000) {
  await win.getByText(name, { exact: true }).first().waitFor({ state: 'visible', timeout })
}

/** 右栏总数只在服务端响应落地后变化，是区分「旧列表仍在」与「搜索已完成」的可靠信号。 */
async function waitForTriggerTotal(win, loaded, total, timeout = 20_000) {
  await win.getByText(`${String(loaded)} / ${String(total)} 条`, { exact: true }).waitFor({
    state: 'visible',
    timeout,
  })
}

/**
 * 向临时任务库插一条触发记录。
 *
 * 后端连接使用 WAL；`withWritableDb` 每次开/关连接，因此脚本在两次 Remote 调用之间
 * 用独立连接写入即可。前 118 条故意使用同一毫秒，专门打复合游标；最后两条晚 1ms，
 * 用来验证批删后任务行的最近触发时间会回退到剩余记录。
 */
function insertTriggers(taskId, taskName) {
  mkdirSync(wechatData, { recursive: true })
  const db = new DatabaseSync(taskDb)
  try {
    db.exec('PRAGMA journal_mode=WAL')
    db.exec(`CREATE TABLE IF NOT EXISTS task_triggers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL,
      task_name TEXT NOT NULL DEFAULT '',
      chat_username TEXT NOT NULL DEFAULT '',
      chat_name TEXT NOT NULL DEFAULT '',
      target_username TEXT NOT NULL DEFAULT '',
      target_name TEXT NOT NULL DEFAULT '',
      keyword TEXT NOT NULL DEFAULT '',
      text TEXT NOT NULL DEFAULT '',
      images TEXT NOT NULL DEFAULT '[]',
      message_local_id INTEGER NOT NULL,
      message_sort_seq INTEGER NOT NULL,
      triggered_at INTEGER NOT NULL,
      callback_status TEXT NOT NULL DEFAULT 'pending',
      callback_at INTEGER,
      callback_error TEXT NOT NULL DEFAULT '',
      UNIQUE(task_id, message_local_id)
    )`)
    const insert = db.prepare(`INSERT INTO task_triggers
      (task_id, task_name, chat_username, chat_name, target_username, target_name,
       keyword, text, images, message_local_id, message_sort_seq, triggered_at,
       callback_status, callback_error)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?, ?, ?, ?)`)
    db.exec('BEGIN')
    try {
      for (let i = 1; i <= TRIGGER_TOTAL; i += 1) {
        const text = i === 1
          ? '搜索边界 100% literal #1'
          : (i === 2
            ? '搜索边界 under_score literal #2'
            : (
              i === TRIGGER_TOTAL
                ? '分页关键词 跨页边界'
                : `分页记录 #${String(i)} ${i % 2 === 0 ? '偶数批次' : '奇数批次'}`
            ))
        const callbackStatus = i === 3 ? 'failed' : (i % 3 === 0 ? 'sent' : 'pending')
        const callbackError = i === 3 ? '远程端点返回 503' : ''
        // #119/#120 晚 1ms，批删后用 `last_triggered_at` 的回退证明统计确实重算。
        const triggeredAt = i > TRIGGER_TOTAL - 2 ? BASE_AT + 1 : BASE_AT
        insert.run(
          taskId, taskName, 'wxid_task_chat', '验收群聊', 'wxid_target', '验收对象',
          i === 1
            ? '100%'
            : (i === 2 ? 'under_score' : (i === TRIGGER_TOTAL ? '跨页边界' : '分页关键词')),
          text, 1000 + i, 2000 + i, triggeredAt, callbackStatus, callbackError,
        )
      }
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  } finally {
    db.close()
  }
}

/** 触发记录行数（数据库事实，用来与界面分页对照）。 */
function countTriggers(taskId) {
  const db = new DatabaseSync(taskDb)
  try {
    const row = db.prepare('SELECT COUNT(*) AS n FROM task_triggers WHERE task_id = ?').get(taskId)
    return Number(row?.n ?? 0)
  } finally {
    db.close()
  }
}

/** 取排序最前（最新）的若干触发记录 id（行按 triggered_at DESC, id DESC 排列）。 */
function latestTriggerIds(taskId, count) {
  const db = new DatabaseSync(taskDb)
  try {
    return db.prepare(
      'SELECT id FROM task_triggers WHERE task_id = ? ORDER BY triggered_at DESC, id DESC LIMIT ?',
    ).all(taskId, count).map((row) => Number(row.id))
  } finally {
    db.close()
  }
}

/** 任务行里缓存的历史统计（批删记录后必须与记录表一致）。 */
function taskStats(taskId) {
  const db = new DatabaseSync(taskDb)
  try {
    const row = db.prepare(
      'SELECT trigger_count, last_triggered_at FROM task_info WHERE id = ?',
    ).get(taskId)
    return {
      count: Number(row?.trigger_count ?? 0),
      lastAt: row?.last_triggered_at == null ? null : Number(row.last_triggered_at),
    }
  } finally {
    db.close()
  }
}

/** 任务库中剩余触发记录的最大时间戳（批删后 `last_triggered_at` 应与它一致）。 */
function latestTriggerAt(taskId) {
  const db = new DatabaseSync(taskDb)
  try {
    const row = db.prepare(
      'SELECT MAX(triggered_at) AS at FROM task_triggers WHERE task_id = ?',
    ).get(taskId)
    return Number(row?.at ?? 0)
  } finally {
    db.close()
  }
}

try {
  mkdirSync(EVIDENCE_DIR, { recursive: true })
  app = await _electron.launch({
    executablePath: EXE,
    args: [ROOT],
    cwd: ROOT,
    env: {
      ...process.env,
      SUPERTIME_SKIP_ONBOARDING: '1',
      SUPERTIME_TEST_MODE: '1',
      SUPERTIME_USER_DATA_DIR: userData,
      DSH_WECHAT_DATA_DIR: wechatData,
      DSH_WECHAT_DECRYPTED_DIR: decrypted,
    },
  })
  const win = await app.firstWindow()
  win.setDefaultTimeout(30_000)
  const pageErrors = []
  win.on('pageerror', (error) => { pageErrors.push(String(error.message).slice(0, 300)) })
  win.on('console', (message) => {
    if (message.type() === 'error') pageErrors.push(`console: ${message.text().slice(0, 300)}`)
  })
  await win.waitForLoadState('domcontentloaded')
  await dismissOnboarding(win)

  const ready = await waitForRemote(win)
  check(ready.ok, '真实 Electron + preload + 后端 Remote 已就绪', ready.ok ? `${ready.methods} 个方法` : ready.error)
  if (!ready.ok) throw new Error(`后端未就绪：${ready.error}`)

  // ① 空态与深链：先证明两栏是真的空，而不是加载失败。
  await openTaskCenterByHash(win)
  await win.getByRole('region', { name: '任务信息', exact: true }).waitFor({ state: 'visible' })
  await win.getByRole('region', { name: '任务触发记录', exact: true }).waitFor({ state: 'visible' })
  await win.getByText('还没有任务信息', { exact: true }).waitFor({ state: 'visible' })
  await win.getByText('还没有任何触发记录', { exact: true }).waitFor({ state: 'visible' })
  check(true, '深链进入任务信息并显示左右两栏空态')

  // ② 经真实 Remote 新建两个任务，再用界面搜索验证客户端过滤。
  const taskA = await remote(win, 'saveTaskInfo', [{
    name: '华东客户跟进',
    chatUsername: 'wxid_task_chat',
    chatName: '验收群聊',
    chatType: 'group',
    targetUsername: 'wxid_target',
    targetName: '验收对象',
    keywords: ['报价', '合同'],
    photoLimit: 2,
    callbackUrl: '',
    status: 'incomplete',
  }])
  const taskB = await remote(win, 'saveTaskInfo', [{
    name: '华南售后提醒',
    chatUsername: 'wxid_service_chat',
    chatName: '售后群',
    chatType: 'group',
    targetUsername: 'wxid_service_target',
    targetName: '售后小李',
    keywords: ['退款'],
    callbackUrl: '',
    status: 'incomplete',
  }])
  check(taskA.ok === true && taskB.ok === true, 'Remote 创建两个任务成功', `id=${taskA.id}/${taskB.id}`)
  if (!taskA.ok || !taskB.ok) throw new Error('夹具任务创建失败')

  // UI 的事件刷新有 150ms 防抖；直接刷新一次，先把快照拉齐再断搜索。
  await win.getByRole('button', { name: '刷新任务信息', exact: true }).click()
  await waitForTaskName(win, '华东客户跟进')
  await waitForTaskName(win, '华南售后提醒')

  // 搜索框的 aria-label 已由 SearchInput 提供；用 `data-search-input` + 位置兜住
  // Electron 对 `aria-label` 与 placeholder 的近似匹配差异，仍按左右栏顺序取。
  const taskSearch = win.locator('[data-search-input]').first()
  await taskSearch.fill('华东')
  await waitForTaskName(win, '华东客户跟进')
  check(await win.getByText('华南售后提醒', { exact: true }).count() === 0, '左栏按任务名过滤')

  await taskSearch.fill('wxid_service_target')
  await win.getByText('华南售后提醒', { exact: true }).waitFor({ state: 'visible' })
  check(await win.getByText('华东客户跟进', { exact: true }).count() === 0, '左栏搜索覆盖会话/对象 username')

  await taskSearch.fill('不存在关键词')
  await win.getByText('没有匹配的任务', { exact: true }).waitFor({ state: 'visible' })
  check(true, '左栏无匹配时显示明确空态')
  await win.getByRole('button', { name: '清除搜索' }).click()
  await waitForTaskName(win, '华东客户跟进')
  check(true, '左栏清除按钮恢复全部任务')

  // ②b 编辑右侧抽屉（2026-10-21）：行内「编辑」→ role="dialog" 抽屉，配置项都在抽屉里。
  const taskPane = win.getByRole('region', { name: '任务信息', exact: true })
  const editButton = win.getByRole('button', { name: '编辑「华东客户跟进」', exact: true })
  await editButton.click()
  const editDrawer = win.getByRole('dialog')
  await editDrawer.waitFor({ state: 'visible' })
  const drawerText = await editDrawer.innerText()
  check(
    /编辑任务 · 华东客户跟进/.test(drawerText),
    '点「编辑」打开右侧抽屉且标题含任务名',
    drawerText.split('\n').slice(0, 3).join(' | '),
  )
  const webhookField = editDrawer.getByLabel('Webhook 地址', { exact: true })
  await webhookField.waitFor({ state: 'visible' })
  const webhookPlaceholder = await webhookField.getAttribute('placeholder')
  check(
    webhookPlaceholder === 'https://example.com/rpa/callback',
    '抽屉里显示 Webhook 地址字段',
    webhookPlaceholder ?? '无 placeholder',
  )
  const mentionMeOnly = editDrawer.getByLabel(/仅匹配@我的文本/)
  await mentionMeOnly.waitFor({ state: 'visible' })
  check(await mentionMeOnly.isChecked() === false, '群聊任务默认不勾选「仅匹配@我的文本」')
  await mentionMeOnly.check()
  await editDrawer.getByRole('button', { name: '保存', exact: true }).click()
  await win.getByText('任务配置已保存', { exact: true }).waitFor({ state: 'visible', timeout: 20_000 })
  const tasksAfterMention = await remote(win, 'listTaskInfos', [])
  const savedMentionTask = tasksAfterMention.items?.find((task) => task.id === taskA.id)
  check(savedMentionTask?.mentionMeOnly === true, '勾选后经真实后端读回 mentionMeOnly=true')

  // 触发方式选择器由后端厂商目录（listRpaVendors）驱动：选项里应能看到内置 Webhook 与各厂商。
  const vendorSelect = editDrawer.getByLabel('触发方式', { exact: true })
  await vendorSelect.waitFor({ state: 'visible' })
  const vendorOptions = await vendorSelect.locator('option').allTextContents()
  check(
    vendorOptions.includes('Webhook') && vendorOptions.includes('八爪鱼 RPA') && vendorOptions.includes('影刀 RPA'),
    '触发方式选择器按厂商目录渲染',
    vendorOptions.join(' / '),
  )

  // ②c 八爪鱼：切到「八爪鱼 RPA」后出现 FlowId / API Key（旧 aria 保持不变）；保存后行内摘要与 Remote 都要反映。
  await vendorSelect.selectOption({ label: '八爪鱼 RPA' })
  const flowIdField = editDrawer.getByLabel('八爪鱼 FlowId', { exact: true })
  const apiKeyField = editDrawer.getByLabel('八爪鱼 API Key', { exact: true })
  await flowIdField.waitFor({ state: 'visible' })
  await apiKeyField.waitFor({ state: 'visible' })
  check(
    (await apiKeyField.getAttribute('type')) === 'password',
    'API Key 输入框为 password（不回显）',
  )
  const apiKeyPlaceholder = await apiKeyField.getAttribute('placeholder')
  check(
    typeof apiKeyPlaceholder === 'string' && apiKeyPlaceholder.includes('填写'),
    '未配置 Key 时 placeholder 提示填写',
    apiKeyPlaceholder ?? '无 placeholder',
  )
  await flowIdField.fill('6ad859ccee2df270d53fc6e5')
  await apiKeyField.fill('e2e-bazhuayu-key-001')
  await editDrawer.screenshot({ path: join(EVIDENCE_DIR, 'task-center-edit-drawer.png') })
  await editDrawer.getByRole('button', { name: '保存', exact: true }).click()
  // 等**后端真的落库**再断言：上一条「任务配置已保存」提示可能还没消失，不能拿提示条当完成信号。
  const bazhuayuDeadline = Date.now() + 20_000
  let tasksAfterBazhuayu = await remote(win, 'listTaskInfos', [])
  let savedBazhuayuTask = tasksAfterBazhuayu.items?.find((task) => task.id === taskA.id)
  while (
    !(savedBazhuayuTask?.triggerMethod === 'bazhuayu' && savedBazhuayuTask?.triggerSecretSet?.apiKey === true)
    && Date.now() < bazhuayuDeadline
  ) {
    await sleep(250)
    tasksAfterBazhuayu = await remote(win, 'listTaskInfos', [])
    savedBazhuayuTask = tasksAfterBazhuayu.items?.find((task) => task.id === taskA.id)
  }
  check(
    savedBazhuayuTask?.triggerMethod === 'bazhuayu'
      && savedBazhuayuTask?.triggerConfig?.flowId === '6ad859ccee2df270d53fc6e5'
      && savedBazhuayuTask?.triggerSecretSet?.apiKey === true
      // 兼容别名仍是通用配置的派生视图（旧 E2E/旧代码读它们）。
      && savedBazhuayuTask?.bazhuayuFlowId === '6ad859ccee2df270d53fc6e5'
      && savedBazhuayuTask?.bazhuayuApiKeySet === true,
    '八爪鱼触发方式经真实后端读回 triggerConfig/triggerSecretSet 与兼容别名',
    `method=${savedBazhuayuTask?.triggerMethod} flow=${savedBazhuayuTask?.triggerConfig?.flowId} keySet=${savedBazhuayuTask?.triggerSecretSet?.apiKey}`,
  )
  check(
    !JSON.stringify(tasksAfterBazhuayu).includes('e2e-bazhuayu-key-001'),
    'API Key 原文不出现在任务列表返回值里',
  )

  // ②d 影刀：切到「影刀 RPA」后出现目录声明的动态字段（账号与鉴权 / 流程与参数 / 高级）。
  await vendorSelect.selectOption({ label: '影刀 RPA' })
  const accessKeyIdField = editDrawer.getByLabel(/AccessKeyId/)
  const accessKeySecretField = editDrawer.getByLabel(/AccessKeySecret/)
  const robotUuidField = editDrawer.getByLabel(/应用 UUID/)
  await accessKeyIdField.waitFor({ state: 'visible' })
  await accessKeySecretField.waitFor({ state: 'visible' })
  await robotUuidField.waitFor({ state: 'visible' })
  check(
    (await accessKeySecretField.getAttribute('type')) === 'password',
    '影刀 AccessKeySecret 为 password（凭据不回显）',
  )
  check(
    await editDrawer.getByText('账号与鉴权', { exact: true }).count() >= 1
      && await editDrawer.getByText('流程与参数', { exact: true }).count() >= 1,
    '影刀动态字段按描述符分组渲染（账号与鉴权 / 流程与参数）',
  )
  await accessKeyIdField.fill('e2e-yingdao-ak-id')
  await accessKeySecretField.fill('e2e-yingdao-ak-secret')
  await robotUuidField.fill('73d9a119-7ec7-4226-b679-506afefae667')
  await editDrawer.getByRole('button', { name: '保存', exact: true }).click()
  const yingdaoDeadline = Date.now() + 20_000
  let tasksAfterYingdao = await remote(win, 'listTaskInfos', [])
  let savedYingdaoTask = tasksAfterYingdao.items?.find((task) => task.id === taskA.id)
  while (
    !(savedYingdaoTask?.triggerMethod === 'yingdao'
      && savedYingdaoTask?.triggerConfig?.robotUuid === '73d9a119-7ec7-4226-b679-506afefae667'
      && savedYingdaoTask?.triggerSecretSet?.accessKeyId === true)
    && Date.now() < yingdaoDeadline
  ) {
    await sleep(250)
    tasksAfterYingdao = await remote(win, 'listTaskInfos', [])
    savedYingdaoTask = tasksAfterYingdao.items?.find((task) => task.id === taskA.id)
  }
  check(
    savedYingdaoTask?.triggerMethod === 'yingdao'
      && savedYingdaoTask?.triggerConfig?.robotUuid === '73d9a119-7ec7-4226-b679-506afefae667'
      && savedYingdaoTask?.triggerSecretSet?.accessKeyId === true
      && savedYingdaoTask?.triggerSecretSet?.accessKeySecret === true,
    '影刀触发方式经真实后端读回 triggerConfig/triggerSecretSet',
    `method=${savedYingdaoTask?.triggerMethod} robot=${savedYingdaoTask?.triggerConfig?.robotUuid} ak=${savedYingdaoTask?.triggerSecretSet?.accessKeyId}`,
  )
  check(
    !JSON.stringify(tasksAfterYingdao).includes('e2e-yingdao-ak-secret'),
    '影刀凭据原文不出现在任务列表返回值里',
  )

  // ②e 切回「八爪鱼 RPA」：仍能读到上次填的旧配置并保存（切换厂商不清空已填）。
  await vendorSelect.selectOption({ label: '八爪鱼 RPA' })
  const flowIdAgain = editDrawer.getByLabel('八爪鱼 FlowId', { exact: true })
  await flowIdAgain.waitFor({ state: 'visible' })
  check(
    (await flowIdAgain.inputValue()) === '6ad859ccee2df270d53fc6e5',
    '切回八爪鱼仍可读上次填写的 FlowId',
  )
  await editDrawer.getByRole('button', { name: '保存', exact: true }).click()
  const backDeadline = Date.now() + 20_000
  let tasksBack = await remote(win, 'listTaskInfos', [])
  let backTask = tasksBack.items?.find((task) => task.id === taskA.id)
  while (!(backTask?.triggerMethod === 'bazhuayu' && backTask?.triggerConfig?.flowId === '6ad859ccee2df270d53fc6e5') && Date.now() < backDeadline) {
    await sleep(250)
    tasksBack = await remote(win, 'listTaskInfos', [])
    backTask = tasksBack.items?.find((task) => task.id === taskA.id)
  }
  check(
    backTask?.triggerMethod === 'bazhuayu' && backTask?.triggerConfig?.flowId === '6ad859ccee2df270d53fc6e5',
    '切回八爪鱼后保存，旧 FlowId 仍持久',
    `method=${backTask?.triggerMethod} flow=${backTask?.triggerConfig?.flowId}`,
  )

  await editDrawer.getByRole('button', { name: '关闭', exact: true }).click()
  await editDrawer.waitFor({ state: 'hidden' })
  await taskPane.getByText(/八爪鱼 RPA · 6ad859ccee2df270d53fc6e5/).waitFor({ state: 'visible', timeout: 20_000 })
  check(true, '任务行摘要显示「八爪鱼 RPA · <flowId>」')
  check(
    await win.getByRole('button', { name: '编辑「华东客户跟进」', exact: true }).count() === 1,
    '抽屉关闭后任务行「编辑」入口仍在',
  )

  // 抽屉的另外两种关闭语义（× 已在上一步用过）：Esc 与点遮罩。
  await editButton.click()
  await editDrawer.waitFor({ state: 'visible' })
  await win.keyboard.press('Escape')
  await editDrawer.waitFor({ state: 'hidden' })
  check(true, 'Esc 可关闭编辑抽屉')
  await editButton.click()
  await editDrawer.waitFor({ state: 'visible' })
  await win.mouse.click(8, 8)
  await editDrawer.waitFor({ state: 'hidden' })
  check(true, '点抽屉外遮罩可关闭编辑抽屉')
  check(
    await win.getByRole('button', { name: '编辑「华东客户跟进」', exact: true }).count() === 1,
    '遮罩关闭后任务行「编辑」入口仍在',
  )

  // ③ 直接造 120 条同毫秒触发记录，验证首屏 100 + 复合游标加载更多。
  insertTriggers(taskA.id, '华东客户跟进')
  const dbTotal = countTriggers(taskA.id)
  check(dbTotal === TRIGGER_TOTAL, '夹具触发记录已写入临时任务库', `count=${dbTotal}`)
  await win.getByRole('button', { name: '刷新任务信息', exact: true }).click()
  await win.getByText(`100 / ${TRIGGER_TOTAL} 条`, { exact: true }).waitFor({ state: 'visible', timeout: 20_000 })
  const initialRows = await win.locator('[role="button"][aria-label^="查看 "]').count()
  check(initialRows === PAGE_SIZE, `右栏首屏只取 ${PAGE_SIZE} 条`, `rows=${initialRows}`)

  const loadMore = win.getByRole('button', { name: new RegExp(`^加载更多（已 ${PAGE_SIZE} / ${TRIGGER_TOTAL}）`) })
  await loadMore.waitFor({ state: 'visible' })
  await loadMore.click()
  await win.getByText(`${TRIGGER_TOTAL} / ${TRIGGER_TOTAL} 条`, { exact: true }).waitFor({ state: 'visible', timeout: 20_000 })
  const afterRows = await win.locator('[role="button"][aria-label^="查看 "]').count()
  check(afterRows === TRIGGER_TOTAL, `游标加载更多补齐 ${TRIGGER_TOTAL} 条`, `rows=${afterRows}`)
  check(await win.getByRole('button', { name: /^加载更多/ }).count() === 0, '没有下一页时「加载更多」消失')

  // ③b 无感刷新：多页列表和滚动位置不能缩回第一页；搜索框草稿也不能被回源清空。
  const triggerBody = win.locator('section[aria-label="任务触发记录"] [class*="paneBody"]')
  await triggerBody.evaluate((el) => { el.scrollTop = Math.min(420, el.scrollHeight - el.clientHeight) })
  const scrollBeforeRefresh = await triggerBody.evaluate((el) => el.scrollTop)
  const taskSearchBeforeRefresh = await taskSearch.inputValue()
  const triggerSearchBeforeRefresh = await win.getByLabel('搜索触发记录', { exact: true }).inputValue()
  await win.getByRole('button', { name: '刷新任务信息', exact: true }).click()
  await win.waitForFunction(
    (expected) => document.querySelectorAll('[role="button"][aria-label^="查看 "]').length === expected,
    TRIGGER_TOTAL,
    { timeout: 20_000 },
  )
  await win.waitForTimeout(250)
  const rowsAfterRefresh = await win.locator('[role="button"][aria-label^="查看 "]').count()
  const scrollAfterRefresh = await triggerBody.evaluate((el) => el.scrollTop)
  check(rowsAfterRefresh === TRIGGER_TOTAL, '刷新后多页记录保持已加载范围', `rows=${rowsAfterRefresh}`)
  check(
    Math.abs(scrollAfterRefresh - scrollBeforeRefresh) <= 2,
    '刷新后触发记录滚动位置不跳',
    `before=${scrollBeforeRefresh} after=${scrollAfterRefresh}`,
  )
  check(
    await taskSearch.inputValue() === taskSearchBeforeRefresh
      && await win.getByLabel('搜索触发记录', { exact: true }).inputValue() === triggerSearchBeforeRefresh,
    '刷新后两个搜索框内容保持',
  )
  check(await win.getByText('已刷新最新数据', { exact: true }).count() === 0, '刷新不再弹出成功提示')
  await win.screenshot({ path: join(EVIDENCE_DIR, 'task-center-search-layout.png'), fullPage: true })

  // ④ 服务端搜索：字面量 `%` / `_`、回调错误、跨页关键词。
  const triggerSearch = win.getByLabel('搜索触发记录', { exact: true })
  await triggerSearch.fill('100%')
  await waitForTriggerTotal(win, 1, 1)
  const percentRow = win.getByText(/搜索边界 100% literal #1/)
  await percentRow.waitFor({ state: 'visible', timeout: 20_000 })
  const percentMeta = await win.locator('section[aria-label="任务触发记录"]').innerText()
  check(await win.getByText('1 / 1 条', { exact: true }).count() === 1, '% 按普通字符搜索（不是 SQL 通配符）', percentMeta.split('\n').slice(0, 5).join(' | '))

  await triggerSearch.fill('under_score')
  await waitForTriggerTotal(win, 1, 1)
  const underscoreRow = win.getByText(/搜索边界 under_score literal #2/)
  await underscoreRow.waitFor({ state: 'visible', timeout: 20_000 })
  check(await win.getByText('1 / 1 条', { exact: true }).count() === 1, '_ 按普通字符搜索（不是 SQL 单字符通配）')

  await triggerSearch.fill('远程端点返回 503')
  // 失败原因是记录弹窗字段，不在列表行里；等 `_` 夹具消失后再断结果总数。
  await win.getByText(/搜索边界 under_score literal #2/).waitFor({ state: 'hidden', timeout: 20_000 })
  await waitForTriggerTotal(win, 1, 1)
  await win.getByText('分页记录 #3 奇数批次', { exact: true }).waitFor({ state: 'visible', timeout: 20_000 })
  check(true, '右栏服务端搜索覆盖回调错误字段')

  await triggerSearch.fill('分页关键词')
  // #3 的 keyword 命中；#4–#119 的 keyword 命中；#120 的 text 命中，共 118 条。
  const keywordTotal = TRIGGER_TOTAL - 2
  await waitForTriggerTotal(win, PAGE_SIZE, keywordTotal)
  const keywordLoadMore = win.getByRole('button', { name: new RegExp(`^加载更多（已 ${PAGE_SIZE} / ${keywordTotal}）`) })
  await keywordLoadMore.waitFor({ state: 'visible', timeout: 20_000 })
  check(true, '右栏搜索命中条件使用真实总数而非当前页长度', `count=${keywordTotal}`)
  await keywordLoadMore.click()
  await waitForTriggerTotal(win, keywordTotal, keywordTotal)
  const keywordRows = await win.locator('[role="button"][aria-label^="查看 "]').count()
  check(keywordRows === keywordTotal, '搜索结果继续分页且跨页去重', `rows=${keywordRows}`)

  await triggerSearch.fill('肯定不存在的记录')
  await win.getByText('没有匹配的触发记录', { exact: true }).waitFor({ state: 'visible', timeout: 20_000 })
  check(true, '右栏无匹配时显示明确空态')
  await win.getByRole('button', { name: '清除搜索' }).last().click()
  await waitForTriggerTotal(win, PAGE_SIZE, TRIGGER_TOTAL)
  check(true, '右栏清除搜索后恢复全部记录第一页')

  // ⑤ 任务批量删除：左栏全选只覆盖当前搜索命中项，任务 B 消失、任务 A 保留。
  await win.getByRole('button', { name: '刷新任务信息', exact: true }).click()
  await waitForTaskName(win, '华东客户跟进')
  await waitForTaskName(win, '华南售后提醒')
  await taskSearch.fill('华南')
  await win.getByRole('button', { name: '批量', exact: true }).first().click()
  await taskPane.getByRole('button', { name: '全选', exact: true }).click()
  check(
    await taskPane.getByText('已选 1 条', { exact: true }).count() === 1,
    '任务全选只选中当前搜索命中的一行',
  )
  await taskPane.getByRole('button', { name: '删除所选 (1)', exact: true }).click()
  const taskBatchDialog = win.getByRole('alertdialog')
  await taskBatchDialog.waitFor({ state: 'visible' })
  const taskBatchText = await taskBatchDialog.innerText()
  check(
    /已产生的触发记录会保留/.test(taskBatchText) && /任务配置会被删除/.test(taskBatchText),
    '任务批删确认框写明配置删除、历史记录保留',
    taskBatchText.replace(/\s+/g, ' ').slice(0, 180),
  )
  await taskBatchDialog.getByRole('button', { name: '批量删除', exact: true }).click()
  await win.getByText('已删除 1 个任务', { exact: true }).waitFor({ state: 'visible', timeout: 20_000 })
  check(await taskPane.getByText('华南售后提醒', { exact: true }).count() === 0, '任务批删后目标任务消失')
  const tasksAfterBatchDelete = await remote(win, 'listTaskInfos', [])
  check(
    tasksAfterBatchDelete.items?.some((task) => task.id === taskA.id)
      && !tasksAfterBatchDelete.items?.some((task) => task.id === taskB.id),
    '任务批删只移除所选配置，未选任务保留',
    `ids=${tasksAfterBatchDelete.items?.map((task) => task.id).join(',')}`,
  )
  await taskSearch.fill('')
  await waitForTaskName(win, '华东客户跟进')

  // ⑥ 触发记录批量删除：只删最新两条 #119/#120，保留 `100%` / `under_score` 搜索夹具，
  // 由真实 Remote 落库并重算任务统计；删后总数从 120 变 118。
  const removedTriggerIds = latestTriggerIds(taskA.id, 2)
  check(removedTriggerIds.length === 2, '已从数据库定位两条待批删触发记录', `ids=${removedTriggerIds.join(',')}`)
  await taskPane.getByText('华东客户跟进', { exact: true }).click()
  await waitForTriggerTotal(win, PAGE_SIZE, TRIGGER_TOTAL)
  const triggerPane = win.getByRole('region', { name: '任务触发记录', exact: true })
  await triggerPane.getByRole('button', { name: '批量', exact: true }).click()
  await triggerPane.getByRole('button', { name: '全选', exact: true }).click()
  await triggerPane.getByRole('button', { name: '清空', exact: true }).click()
  check(
    await triggerPane.getByText('已选 0 条', { exact: true }).count() === 1,
    '触发记录批量操作条支持清空选择',
  )
  // 外层行是带 aria-checked 的 checkbox，内部还有一个原生 input；只数外层行，
  // 否则同一记录会被 Playwright 的角色查询算两次。
  const triggerRows = triggerPane.locator('div[role="checkbox"]')
  check(
    await triggerRows.count() === PAGE_SIZE,
    '触发记录首屏为每条记录提供复选框',
    `count=${await triggerRows.count()}`,
  )
  // 记录行语义名用的是时间文案，id 不在 DOM 上；按数据库里的最新两条文本点击对应复选框。
  const newestTexts = removedTriggerIds.map((id) => {
    const db = new DatabaseSync(taskDb)
    try {
      const row = db.prepare('SELECT text FROM task_triggers WHERE id = ?').get(id)
      return String(row?.text ?? '')
    } finally {
      db.close()
    }
  })
  for (const text of newestTexts) {
    const row = triggerRows.filter({ hasText: text })
    await row.waitFor({ state: 'visible' })
    await row.click()
  }
  check(
    await triggerPane.getByText('已选 2 条', { exact: true }).count() === 1,
    '触发记录批量选择可勾选多条',
  )
  await triggerPane.getByRole('button', { name: '删除所选 (2)', exact: true }).click()
  const triggerBatchDialog = win.getByRole('alertdialog')
  await triggerBatchDialog.waitFor({ state: 'visible' })
  const triggerBatchText = await triggerBatchDialog.innerText()
  check(
    /删除后不可恢复/.test(triggerBatchText)
      && /不会删除微信里的原始消息/.test(triggerBatchText)
      && /触发次数与最近触发时间会按剩余记录重算/.test(triggerBatchText),
    '触发记录批删确认框说明不可恢复、消息保留与统计重算',
    triggerBatchText.replace(/\s+/g, ' ').slice(0, 220),
  )
  await triggerBatchDialog.getByRole('button', { name: '批量删除', exact: true }).click()
  await win.getByText('已删除 2 条触发记录', { exact: true }).waitFor({ state: 'visible', timeout: 20_000 })
  const remainingTotal = TRIGGER_TOTAL - removedTriggerIds.length
  await waitForTriggerTotal(win, PAGE_SIZE, remainingTotal)
  check(countTriggers(taskA.id) === remainingTotal, '触发记录批删后数据库剩余 118 条', `count=${countTriggers(taskA.id)}`)
  const statsAfterDelete = taskStats(taskA.id)
  check(statsAfterDelete.count === remainingTotal, '任务行触发次数按剩余记录重算', `triggerCount=${statsAfterDelete.count}`)
  check(
    statsAfterDelete.lastAt === BASE_AT && statsAfterDelete.lastAt === latestTriggerAt(taskA.id),
    '任务行最近触发时间按剩余记录重算',
    `lastTriggeredAt=${statsAfterDelete.lastAt}`,
  )
  await taskPane.getByText('118 次触发', { exact: false }).first().waitFor({ state: 'visible', timeout: 20_000 })
  check(true, '任务行同步显示批删后的触发次数')
  check(
    await triggerPane.getByRole('button', { name: '批量', exact: true }).count() === 1,
    '触发记录批删成功后自动退出批量模式',
  )

  // ⑦ 抽屉表单内删除：确认框语义 + 任务消失 + 触发记录仍保留且可搜索。
  await taskPane.getByText('华东客户跟进', { exact: true }).click()
  await waitForTriggerTotal(win, PAGE_SIZE, remainingTotal)
  await win.getByRole('button', { name: '编辑「华东客户跟进」', exact: true }).click()
  await editDrawer.waitFor({ state: 'visible' })
  const editForm = editDrawer.getByRole('form', { name: '编辑任务：华东客户跟进', exact: true })
  await editForm.waitFor({ state: 'visible' })
  // 用户报障截图里的入口：编辑抽屉底部的删除按钮，而不是任务行内的删除入口。
  await editForm.getByRole('button', { name: '删除任务「华东客户跟进」', exact: true }).click()
  const dialog = win.getByRole('alertdialog')
  await dialog.waitFor({ state: 'visible' })
  const dialogText = await dialog.innerText()
  check(/历史事实/.test(dialogText) && /任务配置会被删除/.test(dialogText), '删除确认框写明任务配置删除、历史记录保留', dialogText.replace(/\s+/g, ' ').slice(0, 180))
  await dialog.getByRole('button', { name: '删除任务', exact: true }).click()
  await win.getByText('任务已删除', { exact: true }).waitFor({ state: 'visible', timeout: 20_000 })
  check(await taskPane.getByText('华东客户跟进', { exact: true }).count() === 0, '确认删除后左栏任务消失')
  check(await win.getByRole('dialog').count() === 0, '任务被删后编辑抽屉自动关闭')
  check(countTriggers(taskA.id) === remainingTotal, '删除任务不级联删除历史触发记录', `count=${countTriggers(taskA.id)}`)

  // 删除后右栏回到全部记录；行内仍保留任务名快照，历史正文也仍能独立命中。
  await win.getByText('华东客户跟进', { exact: true }).first().waitFor({ state: 'visible', timeout: 20_000 })
  check(true, '删除任务后历史触发记录仍显示任务名快照')
  await triggerSearch.fill('100%')
  await waitForTriggerTotal(win, 1, 1)
  await win.getByText(/搜索边界 100% literal #1/).waitFor({ state: 'visible', timeout: 20_000 })
  check(true, '删除任务后历史触发记录仍能按旧正文搜到')

  await win.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {})
  check(pageErrors.length === 0, '全程无 pageerror / console error', pageErrors.slice(0, 3).join(' | '))
} catch (error) {
  const detail = error instanceof Error ? error.message : String(error)
  console.error('[task-center-e2e] 执行失败：', detail)
  check(false, '端到端流程未能跑完', detail.split('\n')[0])
  try {
    const win = app ? await app.firstWindow() : null
    if (win) {
      await win.screenshot({ path: join(EVIDENCE_DIR, 'task-center-e2e-fail.png'), fullPage: true })
      const body = await win.locator('body').innerText().catch(() => '')
      console.error('[task-center-e2e] 页面可见文本：', body.replace(/\s+/g, ' ').slice(0, 800))
    }
  } catch { /* 诊断失败不覆盖原错误 */ }
} finally {
  try { await app?.close() } catch { /* 已退出 */ }
  for (let i = 0; i < 20 && existsSync(userData); i += 1) {
    try { rmSync(userData, { recursive: true, force: true }) } catch { await sleep(250) }
  }
}

let failed = 0
for (const result of results) {
  if (!result.ok) failed += 1
  console.log(`${result.ok ? 'PASS' : 'FAIL'}  ${result.label}${result.detail ? `  -> ${result.detail}` : ''}`)
}
console.log(failed === 0
  ? `\n任务信息端到端验收通过（${results.length} 项）`
  : `\n任务信息端到端验收失败：${failed} / ${results.length} 项`)
process.exitCode = failed === 0 ? 0 : 1
