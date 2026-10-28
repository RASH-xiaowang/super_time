/**
 * 「附加参数」列表的服务端校验。
 *
 * 与前端 `task-center-param-list.ts` 保持同一套规则：参数名唯一、值来源白名单、
 * 固定值非空、自定义模板只引用 record/task 白名单字段。拆出本文件是为了让
 * `template.ts` 继续满足单文件行数约束。
 */
import type { RpaField, RpaParamEntry } from '../../types-rpa.ts';
/**
 * 校验并归一化「附加参数」列表。
 *
 * 规则：参数名非空/去重；`source` 必须在描述符允许集合内；`fixed` 必须有固定值；
 * `template` 必须非空且只引用白名单字段。空列表合法。
 */
export declare function validateParamListField(field: RpaField, raw: unknown, errors: string[]): RpaParamEntry[] | undefined;
