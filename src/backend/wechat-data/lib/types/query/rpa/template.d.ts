/**
 * 多厂商触发的**模板 / 校验 / 参数映射**层（2026-10-21）。
 *
 * 核心管道（`dispatch.ts`）只认描述符，不认识任何具体厂商；厂商差异全部落在
 * `RpaVendorDescriptor` 里（字段、鉴权、映射、请求模板、响应规则）。本文件负责把这些
 * 声明式数据翻译成一次可发出的请求，并提供**保存/标记已完善**两处共用的校验：
 *
 *  · `defaultConfigFor` / `defaultSecretsFor` —— 新任务的默认配置 / 凭据占位；
 *  · `validateVendorConfig` —— 按字段类型 / select 选项 / pattern / URL 校验并补默认值；
 *  · `missingReadyFields` —— 「标记已完善」还缺哪些必填项（返回中文字段名）；
 *  · `renderRequest` —— 占位符渲染 + 三种语义参数按 `mapping.style` 装进厂商容器。
 *
 * 安全边界：占位符只允许 `config` / `secret` / `record` / `invocation` / `mapped` 五个根，
 * **只做字符串插值与整值替换，禁止 eval/任意表达式**；未知占位符或缺值抛可读错误，
 * 不静默留空（否则会把空参数发给厂商）。`${auth.token}` 在渲染阶段原样保留，交给
 * `auth.ts` 统一替换（凭据不进模板上下文之外的任何地方）。
 */
import type { RpaField, RpaTriggerConfig, RpaTriggerSecretInput, RpaTriggerSecretSet, RpaVendorDescriptor } from '../../types-rpa.ts';
import type { RpaHttpRequest, RpaInvocationContext } from './types.ts';
/** 非敏感配置字段（写 `trigger_config`；`secret` 字段不算）。 */
export declare function configFieldList(descriptor: RpaVendorDescriptor): RpaField[];
/**
 * 全部凭据字段：描述符顶层 `fields` 里标了 `secret` 的，加上每个鉴权模式声明的凭据字段。
 *
 * 两种写法都是契约允许的（内置 webhook/八爪鱼把 secret 写在 `fields`，其余厂商多写在
 * `auth.modes[].fields`），这里合并去重，保存/投递/UI 从此只有一份口径。
 * @param descriptor - 厂商描述符。
 * @returns 凭据字段列表（按出现顺序，key 唯一）。
 */
export declare function secretFieldList(descriptor: RpaVendorDescriptor): RpaField[];
/** 输入框的可访问名（E2E/SSR 依赖）：`ariaLabel` 优先，缺省用 label。 */
export declare function fieldAriaLabel(field: RpaField): string;
/**
 * 解析库里的 `trigger_config` JSON（坏数据按空对象容错，不影响任务可读）。
 * @param raw - SQLite 列值（可能是 undefined / 非字符串）。
 * @returns 只保留 string/number/boolean/字符串字典的值。
 */
export declare function parseConfigJson(raw: unknown): RpaTriggerConfig;
/**
 * 把运行时入参（可能不是对象 / 值类型不对）规整成配置对象：只保留白名单值。
 *
 * 用于「保存任务」把 `triggerConfig` 入参与旧字段合并：非法值丢弃后交给
 * {@link validateVendorConfig} 按描述符重新校验。
 * @param raw - 运行时入参。
 * @returns 白名单化后的配置对象。
 */
export declare function normalizeConfigInput(raw: unknown): RpaTriggerConfig;
/** 解析库里的 `trigger_secret` JSON（只保留非空字符串值；原文永不返回调用方快照）。 */
export declare function parseSecretJson(raw: unknown): Record<string, string>;
/** 凭据原文 → 「是否已配置」快照（值非空即 true；这是唯一能出库的凭据信息）。 */
export declare function secretSetOf(secrets: Record<string, string>): RpaTriggerSecretSet;
/**
 * 新任务的默认配置：描述符 `defaultValue` 存在的字段填默认；map 字段生成三键。
 * @param descriptor - 厂商描述符。
 * @returns 只含非敏感字段的初始配置。
 */
export declare function defaultConfigFor(descriptor: RpaVendorDescriptor): RpaTriggerConfig;
/**
 * 凭据输入草稿：所有凭据字段都以空串出现（编辑表单从不回读原文）。
 *
 * `existing` 是已保存的「是否已配置」快照，供 UI 决定 placeholder（「已保存，留空保持不变」）；
 * 本函数刻意不把它变成值，避免任何路径把凭据口径混淆成字符串。
 * @param descriptor - 厂商描述符。
 * @param existing - 已保存凭据的布尔快照（只影响调用方展示）。
 * @returns key → 空串。
 */
export declare function defaultSecretsFor(descriptor: RpaVendorDescriptor, existing: RpaTriggerSecretSet): Record<string, string>;
/**
 * 合并「本次输入的凭据」与「已保存凭据」。
 *
 * 语义（与存储层一致）：缺省（未出现的键）= 保留旧值；`''` = 清空该键；非空 = 覆盖。
 * 未知键忽略（切换厂商后旧凭据不会混进新厂商）。
 * @param descriptor - 厂商描述符。
 * @param saved - 已保存凭据原文（只在后端内存里出现）。
 * @param input - 本次输入的凭据（可能 undefined）。
 * @returns 合并后的凭据、布尔快照与校验错误。
 */
export declare function applySecretInput(descriptor: RpaVendorDescriptor, saved: Record<string, string>, input: RpaTriggerSecretInput | undefined): {
    secrets: Record<string, string>;
    set: RpaTriggerSecretSet;
    errors: string[];
};
/**
 * 校验并归一化一个非敏感配置对象（新任务/更新任务保存时调用）。
 *
 * 规则：类型按 `field.type`；`select` 必须在 `options` 内；`pattern` 只校验非空值；
 * `url` / `baseUrl` 非空时必须是 http/https 绝对地址（Webhook 兼容旧文案）。未知键丢弃。
 * @param descriptor - 厂商描述符。
 * @param config - 入参配置（运行时未受类型保护）。
 * @returns 归一化后的配置（含默认值）与中文错误列表；errors 非空 = 整单保存失败。
 */
export declare function validateVendorConfig(descriptor: RpaVendorDescriptor, config: RpaTriggerConfig): {
    config: RpaTriggerConfig;
    errors: string[];
};
/**
 * 「标记已完善」还缺哪些字段（空数组 = 可以标记已完善）。
 *
 * `required` 只在这里生效（保存待完善任务允许留空）。secret 字段看已保存快照
 * `secretSet[key]`；调用方若刚输入了新凭据，先合并进快照再调本函数。
 * @param descriptor - 厂商描述符。
 * @param config - 当前配置（缺省字段按默认值补齐）。
 * @param secretSet - 已配置凭据布尔快照。
 * @returns 缺失字段的中文名（按字段声明顺序）。
 */
export declare function missingReadyFields(descriptor: RpaVendorDescriptor, config: RpaTriggerConfig, secretSet: RpaTriggerSecretSet): string[];
/** 旧列（2026-10-21 前的专用字段）→ 通用配置的迁移输入。 */
export interface RpaLegacyConfigColumns {
    callbackUrl?: string;
    bazhuayuFlowId?: string;
}
/** 读旧任务时把专用列迁移成通用配置（通用列已经有值时不要调用）。 */
export declare function migrateLegacyConfig(method: string, legacy: RpaLegacyConfigColumns): RpaTriggerConfig;
/** 读旧任务时把 `bazhuayu_api_key` 迁移成通用凭据（只对 bazhuayu 有意义）。 */
export declare function migrateLegacySecrets(method: string, apiKey: string): Record<string, string>;
/**
 * 写库时的**双写**旧列（降级可读：旧版本应用仍能按 webhook/八爪鱼读取）。
 *
 * 新厂商没有旧列可写，三个旧列一律空串（旧版本应用会显示"待完善"，符合降级预期）。
 * @param method - 触发方式 id。
 * @param config - 通用配置。
 * @param secrets - 通用凭据原文（只取旧列认识的 `apiKey`）。
 * @returns 三个旧列的值。
 */
export declare function legacyColumnsFor(method: string, config: RpaTriggerConfig, secrets: Record<string, string>): {
    callbackUrl: string;
    bazhuayuFlowId: string;
    bazhuayuApiKey: string;
};
/**
 * 触发方式 id 归一：空/非字符串 → 缺省值；字符串原样保留（未知 id 由注册表判定）。
 * 旧库 `trigger_method` 只有 `webhook`/`bazhuayu`；厂商 id 原样透传。
 * @param raw - 列值或入参。
 * @param fallback - 缺省值（新建 = webhook、更新 = 旧行值）。
 * @returns 触发方式 id。
 */
export declare function normalizeTriggerMethod(raw: unknown, fallback?: string): string;
/**
 * 按点分路径取值，支持数组下标：`data.jobUuid`、`value[0].Key`。
 * @param root - 已解析 JSON。
 * @param path - 路径；空串返回 root。
 * @returns 取到的值；路径不存在返回 undefined。
 */
export declare function readJsonPath(root: unknown, path: string): unknown;
/**
 * 通用占位符渲染（`auth.ts` 的换 token 请求也复用它）。
 *
 * 字符串：整值占位符 → 原值（对象/数组/数字保留类型）；内联 → 字符串插值。
 * 数组/对象：递归。`${auth.token}` 原样保留（由 applyAuth 统一替换）。
 * @param template - 模板值。
 * @param roots - 允许的占位符根。
 * @returns 渲染后的值。
 * @throws 未知占位符 / 缺值 / 内联对象时抛可读错误。
 */
export declare function renderTemplate(template: unknown, roots: Record<string, unknown>): unknown;
/**
 * 生成 `mapped` 根：三个语义值按映射 key 装进厂商容器（`mapping.style` 五种形态），
 * 再把「附加参数」（`mapping.extrasField`，若有）按值来源解析后追加进去。
 * @param descriptor - 厂商描述符。
 * @param ctx - 投递上下文（含配置 / 触发记录 / 任务名）。
 * @returns `object` / 数组 / JSON 字符串 / form 串（视 style）。
 * @throws 语义值缺失或附加参数模板无法解析时抛可读错误。
 */
export declare function resolveMapped(descriptor: RpaVendorDescriptor, ctx: RpaInvocationContext): unknown;
/**
 * 按描述符渲染一次请求（`buildRequest` 钩子存在时由适配器覆盖，不会走到这里）。
 * @param descriptor - 厂商描述符。
 * @param ctx - 投递上下文。
 * @returns 可鉴权、可发送的 HTTP 请求。
 */
export declare function renderRequest(descriptor: RpaVendorDescriptor, ctx: RpaInvocationContext): RpaHttpRequest;
