/**
 * 「附加参数」支持的全部值来源。
 *
 * 所有 RPA 厂商描述符共用这一份顺序；新增来源时只改这里与 `types-rpa.ts` 的联合类型，
 * 避免八爪鱼 / 影刀 / UiPath 等厂商的白名单逐渐漂移。
 */
import type { RpaParamSource } from '../../types-rpa.ts';
export declare const RPA_PARAM_SOURCES: readonly RpaParamSource[];
