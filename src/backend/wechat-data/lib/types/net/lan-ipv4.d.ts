/** 网卡地址的最小形状（只取排序要用的字段，便于单测注入）。 */
export interface NetworkAddressLike {
    address: string;
    family: string | number;
    mac?: string;
    internal?: boolean;
}
/** `os.networkInterfaces()` 的最小形状。 */
export type NetworkInterfacesLike = Readonly<Record<string, readonly (NetworkAddressLike | undefined)[] | undefined>>;
/**
 * 给一个 IPv4 地址打分：分数越高越适合作为局域网入口。
 *
 * **与 `http-server.js#lanAddressScore` 同口径**：虚拟网卡 -1000，物理网卡 +20，
 * Wi-Fi +30，APIPA（169.254.x.x）-500。
 * @param iface - 网卡名。
 * @param addr - 网卡地址。
 * @returns 分数。
 */
export declare function lanAddressScore(iface: string, addr: Pick<NetworkAddressLike, 'address' | 'mac'>): number;
/**
 * 选出宿主最可能绑定的那个 IPv4。
 *
 * 排序是**稳定**的（`Array.prototype.sort` 在 V8 里稳定）：分数相同时保留
 * `os.networkInterfaces()` 的原始顺序，与宿主完全一致。
 * @param ifaces - 网卡表；缺省读本机。
 * @returns 地址（没有可用网卡时为空串）。
 */
export declare function pickLanIPv4(ifaces?: NetworkInterfacesLike): string;
