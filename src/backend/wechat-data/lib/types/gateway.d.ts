/**
 * WechatDataGateway —— st_control 解密数据的 Host Remote 服务（装配层 / 叶子）。
 *
 * 状态、构造与共享辅助在 `gateway-core.ts`；方法面按域分三层壳（`gateway-read.ts` /
 * `gateway-ask-ops.ts` / `gateway-data-ops.ts`）。装饰器标记落在最派生原型上，
 * 所以对外接口与拆分前逐名相同（守卫：`gateway-remote-surface.spec.ts`）。
 */
export type { StreamJob } from './gateway-support.ts';
import { GatewayDataOps } from './gateway-data-ops.ts';
export declare class WechatDataGateway extends GatewayDataOps {
}
export default WechatDataGateway;
