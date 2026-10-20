/**
 * 远程访问（手机端）的**方法白名单**判据。
 *
 * ## 这份文件守的是什么
 *
 * `http-remote-policy.js` 把后端 195 个 `@Remote` 方法**显式二分**成「允许远程调用」与
 * 「仅桌面端」。二分本身不难写，难的是**让它一直成立** —— 后端方法只会越来越多，
 * 而新增一条方法时没人会想起回来改这份清单。
 *
 * 所以这里最重要的判据不是「白名单里有哪几条」，而是 ②：
 * **两份清单的并集必须恰好等于注册表全集**。它把「默认拒绝」从一句口号变成一个会红的
 * 用例 —— 第 195 个方法一出现，这条就红，作者被迫当场做一次显式选择。
 *
 * 三条判据的方向：
 *   ① 不相交（同一条方法不能既允许又拒绝，那是分类时手滑）；
 *   ② 并集 == 注册表（新方法必须先分类）；
 *   ③ 白名单 ⊆ 注册表（改名后不许留下永不命中的死条目 —— 死条目会制造假的安全感：
 *      清单看着覆盖了，实际那条方法已经不存在，而真正的同名新方法没被审过）。
 *
 * 另外逐族点名排除**最不该开放**的几类：模型 API Key、许可证、备份还原、配置写入、
 * ClawBot 发消息。这几条不是「碰巧没列进来」，而是**必须**列不进来。
 *
 * @vitest-environment node
 */
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const require = createRequire(import.meta.url)
const policy = require(join(ROOT, 'src', 'backend', 'http-remote-policy.js')) as {
  REMOTE_SAFE_METHODS: Set<string>
  LOCAL_ONLY_METHODS: Set<string>
  REMOTE_HEAVY_METHODS: Set<string>
  REMOTE_DENIED_CODE: string
  NATIVE_CAPABILITIES: Record<string, boolean>
  isRemoteSafe: (m: unknown) => boolean
  isRemoteHeavy: (m: unknown) => boolean
}
const longCalls = require(join(ROOT, 'src', 'backend', 'remote-policy.js')) as {
  LONG_CALL_METHODS: Set<string>
}

/** 从 gateway 源码里解析出**真实**的 `@Remote` 注册表（不抄清单，抄清单等于自己证明自己）。 */
function registeredMethods(): Set<string> {
  const dir = join(ROOT, 'src', 'backend', 'wechat-data', 'src')
  const out = new Set<string>()
  for (const f of readdirSync(dir)) {
    if (!/^gateway-.*\.ts$/.test(f)) continue
    const src = readFileSync(join(dir, f), 'utf8')
    for (const m of src.matchAll(/@Remote\('([^']+)'/g)) out.add(m[1] as string)
  }
  return out
}

describe('远程访问白名单：完整二分 + 逐族排除', () => {
  const registry = registeredMethods()

  it('哨兵：注册表真的解析到了（否则下面所有判据都是恒真）', () => {
    expect(registry.size, 'gateway-*.ts 里没解析出 @Remote 方法，路径或正则失效了').toBeGreaterThan(150)
    expect(registry.has('getSessions')).toBe(true)
    expect(policy.REMOTE_SAFE_METHODS.size).toBeGreaterThan(50)
    expect(policy.LOCAL_ONLY_METHODS.size).toBeGreaterThan(20)
  })

  it('① 两份清单不相交（一条方法不能既允许又拒绝）', () => {
    const both = [...policy.REMOTE_SAFE_METHODS].filter((m) => policy.LOCAL_ONLY_METHODS.has(m))
    expect(both, `这些方法同时出现在允许与拒绝两份清单里：${both.join(', ')}`).toEqual([])
  })

  it('② 并集恰好等于注册表：新增方法必须先分类，否则它既不被允许也不被点名拒绝', () => {
    const union = new Set([...policy.REMOTE_SAFE_METHODS, ...policy.LOCAL_ONLY_METHODS])
    const unclassified = [...registry].filter((m) => !union.has(m))
    expect(
      unclassified,
      `有 ${String(unclassified.length)} 个 @Remote 方法没有被分类（默认拒绝会挡住它们，`
      + '但清单必须显式表态，否则下一个人不知道这是「刻意拒绝」还是「漏了」）：'
      + unclassified.join(', '),
    ).toEqual([])
    // 反向：清单里不许有注册表中不存在的名字（③ 的并集形式）
    const ghosts = [...union].filter((m) => !registry.has(m))
    expect(ghosts, `清单里有 ${String(ghosts.length)} 个方法在注册表中不存在（改名后留下的死条目）：${ghosts.join(', ')}`).toEqual([])
  })

  it('③ 白名单是注册表的子集（死条目会制造假的安全感）', () => {
    const ghosts = [...policy.REMOTE_SAFE_METHODS].filter((m) => !registry.has(m))
    expect(ghosts).toEqual([])
  })

  it('远程重活台账 = 远程白名单 ∩ 长任务台账（三类清单只在这里取交集）', () => {
    const expected = [...policy.REMOTE_SAFE_METHODS].filter((m) => longCalls.LONG_CALL_METHODS.has(m)).sort()
    expect([...policy.REMOTE_HEAVY_METHODS].sort()).toEqual(expected)
    expect(policy.REMOTE_HEAVY_METHODS.size, '远程白名单里的长任务不该是 0，否则这条预算判据在空转').toBeGreaterThan(20)
    for (const m of policy.REMOTE_HEAVY_METHODS) {
      expect(policy.LOCAL_ONLY_METHODS.has(m), `${m} 同时是远程重活和远程拒绝项，分类冲突`).toBe(false)
      expect(policy.isRemoteHeavy(m)).toBe(true)
    }
    expect(policy.isRemoteHeavy('getSessions')).toBe(false)
    expect(policy.isRemoteHeavy('exportAllSessions')).toBe(false)
  })

  it('最不该开放的几类必须被点名拒绝（不是「碰巧没列进来」）', () => {
    const mustBlock: ReadonlyArray<readonly [string, string]> = [
      // A 凭据：这些会给出或改写模型 API Key / 数据库密钥 / 图片密钥
      ['getWechatConfig', '配置读取（可能含密钥）'],
      ['getWechatConfigFull', '完整配置读取'],
      ['saveWechatConfig', '配置写入'],
      ['getWechatKeysInfo', '密钥信息'],
      ['autoGetDbKey', '扫微信进程内存取库密钥'],
      ['autoGetImageKey', '推导图片密钥'],
      ['verifyDatabaseKey', '密钥校验'],
      ['listLlmModels', '模型配置（同族接口会回 API Key）'],
      ['setKbModelConfig', '知识库模型配置写入'],
      ['setPrivacyState', '脱敏开关（关掉它等于让后续出站不再打码）'],
      ['detectWechatAccounts', '本机账号探测'],
      // B 落盘 / 读本机任意路径
      ['createBackup', '备份'],
      ['createEncryptedBackup', '加密备份'],
      ['restoreBackup', '还原（会覆盖数据）'],
      ['deleteBackup', '删除备份文件'],
      ['exportCsv', '导出落盘'],
      ['exportAllSessions', '批量导出落盘'],
      ['addKbFiles', '入参是本机文件路径'],
      ['openPath', '打开本机资源管理器'],
      ['openConfig', '打开本机配置文件'],
      // C 重活（会与桌面端抢单线程 worker）
      ['decryptAllDatabases', '整库解密'],
      ['buildSearchIndex', '索引重建（10 分钟档）'],
      ['fetchOriginalImagesBatch', '批量取原图'],
      ['transcribeVoiceBatch', '批量转写'],
      ['downloadWhisperModel', '模型下载'],
      // D 对外后果 / 销毁问责留痕
      ['sendClawbotMessage', '能以用户身份给联系人发消息'],
      ['createClawbotBindQr', '改绑定'],
      ['unbindClawbot', '解绑'],
      ['setClawbotInstanceConfig', '改实例配置（含 AI 自动回复开关）'],
      ['clearOperationLog', '清空操作日志（问责留痕）'],
      ['clearPrivacyAudit', '清空出站审计（问责留痕）'],
    ]
    for (const [method, why] of mustBlock) {
      expect(registry.has(method), `${method} 已不在注册表里 —— 这条判据要跟着改名，不能悄悄失效`).toBe(true)
      expect(policy.LOCAL_ONLY_METHODS.has(method), `${method} 必须被点名拒绝（${why}）`).toBe(true)
      expect(policy.isRemoteSafe(method), `${method} 竟然被判为可远程调用（${why}）`).toBe(false)
    }
  })

  it('手机要能正常浏览：核心只读方法必须在白名单里', () => {
    // 少列一条的后果是「手机上某个面板报错」，用户看得见；但这条判据让它在这里就红。
    const mustAllow = [
      'getSessions', 'getMessages', 'getNewMessages', 'getContacts', 'getContact360',
      'getOverview', 'getMoments', 'getGraph', 'getFiles', 'getFavorites', 'getLedger',
      'getRecords', 'getCalls', 'getAnnual', 'getWordCloud', 'searchUnified', 'searchMessages',
      'askWechat', 'getImageDataUrl', 'getAvatar', 'getVoiceDataUrl', 'getDbHealth',
      // 2026-10-14 M10 审计：转账/红包状态是本地库的纯读（名字里的 payment 指微信账单，不是许可证）。
      // 它曾被判为 A 类凭据，症状是手机上聊天里的转账/红包卡片读不出状态。
      'getPaymentStatus',
      // 2026-10-17：内置的拟人化默认提示词是**常量**（不读库、不碰微信数据、无副作用），
      // 手机上要能看得到默认值长什么样 —— 否则设置面板的输入框永远是空的。
      'getClawbotDefaultPrompt',
    ]
    for (const m of mustAllow) {
      expect(registry.has(m), `${m} 已不在注册表里`).toBe(true)
      expect(policy.isRemoteSafe(m), `${m} 不在白名单里 ⇒ 手机上对应面板会直接报错`).toBe(true)
    }
  })

  it('未知方法一律拒绝（默认拒绝不是一句注释，而是 isRemoteSafe 的真实行为）', () => {
    expect(policy.isRemoteSafe('someMethodNobodyRegistered')).toBe(false)
    expect(policy.isRemoteSafe('')).toBe(false)
    expect(policy.isRemoteSafe(undefined)).toBe(false)
    expect(policy.isRemoteSafe(null)).toBe(false)
    expect(policy.isRemoteSafe({ toString: () => 'getSessions' })).toBe(false)
    expect(policy.isRemoteSafe('__proto__')).toBe(false)
    expect(policy.isRemoteSafe('constructor')).toBe(false)
  })

  it('原生能力清单：浏览器态全部为 false（界面据此隐藏控件，而不是点了没反应）', () => {
    const caps = policy.NATIVE_CAPABILITIES
    for (const key of ['titlebar', 'windowControls', 'dirPicker', 'capturePanel', 'shellOpen', 'license', 'diag', 'update']) {
      expect(caps, `能力清单里缺 ${key}`).toHaveProperty(key)
      expect(caps[key], `${key} 在浏览器态必须是 false`).toBe(false)
    }
    // 冻结：能力清单是口径而不是状态，谁都不该在运行期改它
    expect(Object.isFrozen(caps)).toBe(true)
  })

  it('拒绝码是界面认得的那一个（改字符串要连界面一起改）', () => {
    expect(policy.REMOTE_DENIED_CODE).toBe('METHOD_NOT_ALLOWED_REMOTE')
  })
})
