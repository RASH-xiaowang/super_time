/**
 * 开发用：打印「永久配对链接」。
 *
 * 远程访问的登录凭据有两条路：
 *   ① **一次性配对码**（`http-auth.js` 的 `createPairingStore`）—— 5 分钟寿命、成功即作废，
 *      给真实用户扫码用，安全但开发时每次都要重新生成；
 *   ② **长期令牌**（`secrets.json` 的 `api_token`）—— **永不过期**，只在用户主动点「轮换」时才变。
 *      它本来就是为「永久凭据」设计的（`/api/auth` 里 `safeEquals(provided, cfg.token)` 那条分支）。
 *
 * 开发测试要的是 ②：一个固定的、重启应用也不变的链接。本脚本把它读出来拼好。
 *
 * ## 读哪一份 config.json
 *
 * 有两份，别读错：
 *   · `wechat/config.json` —— **宿主镜像**，`api_enabled` 等设置住在 `wechatSettings` 子对象里；
 *   · `wechat-data/config.json` —— **后端**那份，`api_enabled` / `api_port` 在**顶层**。
 * `http-server.js` 的 `readRemoteAccessConfig` 读的是**后端**那份（它要在后端就绪前
 * 就能判断该不该监听），所以这里也读后端那份。
 *
 * 用法：`node scripts/dev-pair-link.mjs`
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir, networkInterfaces } from 'node:os'

const DATA_ROOT = join(homedir(), 'AppData', 'Roaming', 'super-time-electron', 'wechat-data')

function readJson(p) {
  try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return null }
}

const cfg = readJson(join(DATA_ROOT, 'config.json'))
const secrets = readJson(join(DATA_ROOT, 'secrets.json'))

if (!cfg || !secrets) {
  console.error(`读不到配置。数据目录：${DATA_ROOT}`)
  process.exit(1)
}

const enabled = cfg.api_enabled === true
const port = Number(cfg.api_port) || 5032
const token = typeof secrets.api_token === 'string' ? secrets.api_token : ''

if (token === '') {
  console.error('secrets.json 里没有 api_token —— 先在「设置 → 远程访问（手机）」里启用一次。')
  process.exit(1)
}

// 取本机局域网 IPv4（与 http-server.js 的 lanAddresses 同口径：非回环、非链路本地）
const addrs = []
for (const list of Object.values(networkInterfaces())) {
  for (const ni of list ?? []) {
    if (ni.family !== 'IPv4' || ni.internal) continue
    if (ni.address.startsWith('169.254.')) continue
    addrs.push(ni.address)
  }
}

console.log(`远程访问：${enabled ? '已启用' : '⚠ 未启用（设置 → 远程访问（手机）里打开）'}`)
console.log(`端口：${port}`)
console.log(`长期令牌：${token.slice(0, 4)}…${token.slice(-4)}（${token.length} 字符，永不过期）`)
console.log('')
console.log('永久配对链接（手机与电脑需在同一局域网）：')
for (const a of addrs) console.log(`  http://${a}:${port}/?t=${token}`)
console.log(`  http://localhost:${port}/?t=${token}   ← 本机浏览器自测`)
console.log('')
console.log('说明：会话 Cookie 有 12 小时寿命，过期后重新打开上面任一链接即可（令牌本身不变）。')
