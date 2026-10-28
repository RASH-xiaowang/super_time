/**
 * 「本机局域网 IPv4」的选择逻辑（2026-10-23）。
 *
 * ## 为什么需要它
 *
 * RPA 图片直链由**后端 worker** 生成，而 HTTP 监听面由**宿主进程**绑定。宿主
 * （`src/backend/http-server.js#lanAddresses`）只绑**一个**具体 IPv4，不是 `0.0.0.0`；
 * 因此 worker 拼链接时必须挑到**同一个地址**，否则链接看起来正常、实际连不上。
 *
 * 两份实现是进程隔离导致的（worker 是独立进程，不能直接调用宿主函数），排序规则必须
 * 逐条一致：虚拟网卡/隧道/APIPA 排在物理 Wi-Fi、以太网之后。`rpa-media.spec.ts` 有一条
 * 用例在本机真实网卡上比对两边选出的地址，改一边忘另一边会红。
 *
 * @module net/lan-ipv4
 */
import { networkInterfaces } from 'node:os'

/**
 * 明显是虚拟/隧道/回环型网卡的名字特征。
 *
 * **与 `src/backend/http-server.js` 的 `VIRTUAL_IFACE_HINTS` 逐项一致**。
 */
const VIRTUAL_IFACE_HINTS: readonly RegExp[] = [
  /vethernet/i,
  /vmware/i,
  /virtualbox/i,
  /hyper-v/i,
  /docker/i,
  /wsl/i,
  /zerotier/i,
  /tailscale/i,
  /wireguard/i,
  /openvpn/i,
  /(^|[^a-z])vpn($|[^a-z])/i,
  /teredo/i,
  /isatap/i,
  /loopback/i,
  /bluetooth/i,
]

/** 网卡地址的最小形状（只取排序要用的字段，便于单测注入）。 */
export interface NetworkAddressLike {
  address: string
  family: string | number
  mac?: string
  internal?: boolean
}

/** `os.networkInterfaces()` 的最小形状。 */
export type NetworkInterfacesLike = Readonly<
  Record<string, readonly (NetworkAddressLike | undefined)[] | undefined>
>

/**
 * 给一个 IPv4 地址打分：分数越高越适合作为局域网入口。
 *
 * **与 `http-server.js#lanAddressScore` 同口径**：虚拟网卡 -1000，物理网卡 +20，
 * Wi-Fi +30，APIPA（169.254.x.x）-500。
 * @param iface - 网卡名。
 * @param addr - 网卡地址。
 * @returns 分数。
 */
export function lanAddressScore(iface: string, addr: Pick<NetworkAddressLike, 'address' | 'mac'>): number {
  let score = 0
  if (VIRTUAL_IFACE_HINTS.some((re) => re.test(iface))) score -= 1000
  if (typeof addr.mac === 'string' && addr.mac !== '' && addr.mac !== '00:00:00:00:00:00') score += 20
  if (/(^|[^a-z])(wi-?fi|wlan|wireless)([^a-z]|$)/i.test(iface)) score += 30
  if (/ethernet|以太网|本地连接/i.test(iface)) score += 20
  if (/^169\.254\./.test(addr.address)) score -= 500
  if (addr.address === '0.0.0.0') score -= 900
  return score
}

/**
 * 选出宿主最可能绑定的那个 IPv4。
 *
 * 排序是**稳定**的（`Array.prototype.sort` 在 V8 里稳定）：分数相同时保留
 * `os.networkInterfaces()` 的原始顺序，与宿主完全一致。
 * @param ifaces - 网卡表；缺省读本机。
 * @returns 地址（没有可用网卡时为空串）。
 */
export function pickLanIPv4(ifaces: NetworkInterfacesLike = networkInterfaces()): string {
  const out: Array<{ address: string; score: number }> = []
  for (const [iface, addrs] of Object.entries(ifaces)) {
    for (const a of addrs ?? []) {
      if (a === undefined) continue
      const isV4 = a.family === 'IPv4' || a.family === 4
      if (!isV4 || a.internal === true) continue
      out.push({ address: a.address, score: lanAddressScore(iface, a) })
    }
  }
  out.sort((a, b) => b.score - a.score)
  const first = out[0]
  return first === undefined ? '' : first.address
}
