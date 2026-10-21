/**
 * 「任务信息 / 任务触发记录」域的共享类型（2026-10-19）。
 *
 * 这一域是用户显式创建的**触发式任务**：某会话（单聊/群聊 + 群内目标用户）的消息命中
 * 关键词时，记一条「触发记录」（触发时间 / 触发群聊 / 触发对象 / 触发图片 / 触发文本），
 * 已完善（`ready`）的任务再按**触发方式**把这条记录送出去：Webhook 回调（整条记录 POST
 * 到用户填的地址），或八爪鱼 RPA（调 `bots/scheduling/start`，参数映射见
 * {@link TaskBazhuayuStartPayload}）。
 *
 * 与相邻概念的分工（别混）：
 *  · `wechat-tasks.ts` 的待办：从聊天**文本规则**提取的 TODO，没有目标/关键词/回调；
 *  · `chat-collect.ts` 的收集任务：创建时**快照**最近 N 条文本 + M 张图，没有触发语义；
 *  · 本域：任务本身只有配置，触发记录由**后续新消息**产生，图片是触发时按
 *    「该对象最近 M 张」现取的。
 *
 * 前后端共用：`build:types` 会把本文件生成到 `lib/types/`，渲染层只从
 * `@deepseek-ai/dsh-wechat-data/types` 取类型，不 import 后端实现。
 */
/** 任务状态：待完善（不能触发/回调） / 已完善（可用）。 */
export type TaskInfoStatus = 'incomplete' | 'ready';
/** 任务所属会话类型。 */
export type TaskInfoChatType = 'private' | 'group';
/**
 * 任务的下游触发方式（2026-10-21）：
 *  · `webhook`  —— 把整条触发记录 JSON POST 到用户填写的回调地址（原有能力）；
 *  · `bazhuayu` —— 调八爪鱼 RPA 的 `bots/scheduling/start`，参数只取
 *    会话名 / 触发文本 / 触发对象（见 {@link TaskBazhuayuStartPayload}）。
 * 旧库没有该列时按 `webhook` 处理，保证既有任务行为不变。
 */
export type TaskTriggerMethod = 'webhook' | 'bazhuayu';
/** 一条触发记录的回调投递状态。 */
export type TaskTriggerCallbackStatus = 'pending' | 'sent' | 'failed' | 'skipped';
/** 一条任务配置。 */
export interface TaskInfo {
    id: number;
    /** 任务名（用户可改；缺省由会话名 + 关键词生成）。 */
    name: string;
    /** 被监听的会话 username（单聊对象或群）。 */
    chatUsername: string;
    /** 会话显示名（创建时快照；群名/昵称后续变化不回写）。 */
    chatName: string;
    /** 会话类型：群聊必须指定目标用户。 */
    chatType: TaskInfoChatType;
    /** 触发对象：单聊 = 会话对象本身；群聊 = 群内被监听的那个成员。 */
    targetUsername: string;
    /** 触发对象显示名。 */
    targetName: string;
    /** 触发关键词（任意一个命中即触发）。 */
    keywords: string[];
    /** 触发时携带「该对象最近 M 张图片」的张数（0 = 不带图片）。 */
    photoLimit: number;
    /** 仅匹配结构化 @ 登录账号的群消息；单聊始终为 false。 */
    mentionMeOnly: boolean;
    /** 下游触发方式（缺省 / 旧库 = `webhook`）。 */
    triggerMethod: TaskTriggerMethod;
    /** Webhook 地址（http/https）。触发方式为 `webhook` 时，已完善任务必填。 */
    callbackUrl: string;
    /**
     * 八爪鱼 RPA 流程 id（触发方式为 `bazhuayu` 时已完善必填）。
     *
     * 这不是凭据，可以随任务列表返回；API Key **不返回**，只回 {@link bazhuayuApiKeySet}。
     */
    bazhuayuFlowId: string;
    /**
     * 是否已保存八爪鱼 API Key。
     *
     * 列表 / 编辑表单只需要知道「配没配」；Key 本身只在本机任务库里，投递时由后端读出，
     * 不进 Remote 返回值（列表会被只读会话读到，不该把凭据带出去）。
     */
    bazhuayuApiKeySet: boolean;
    status: TaskInfoStatus;
    createdAt: number;
    updatedAt: number;
    /** 最近一次触发时间（毫秒）。 */
    lastTriggeredAt?: number;
    /** 触发记录总数（列表徽标用；以记录表为准，这里是缓存值）。 */
    triggerCount: number;
}
/** 新建/更新任务的入参（`id` 缺省 = 新建）。 */
export interface TaskInfoInput {
    id?: number;
    name?: string;
    chatUsername: string;
    chatName?: string;
    chatType: TaskInfoChatType;
    targetUsername?: string;
    targetName?: string;
    keywords: string[];
    photoLimit?: number;
    mentionMeOnly?: boolean;
    /** 下游触发方式；缺省 = 新建按 `webhook`、更新沿用旧值。 */
    triggerMethod?: TaskTriggerMethod;
    callbackUrl?: string;
    /** 八爪鱼流程 id；缺省（更新）= 沿用旧值，空串 = 清空。 */
    bazhuayuFlowId?: string;
    /**
     * 八爪鱼 API Key；缺省（更新）= **保留已保存的 Key**，空串 = 清空，非空 = 覆盖。
     * 编辑表单不显示 Key 本身，所以「没改动」必须能与「清空」区分开。
     */
    bazhuayuApiKey?: string;
    status?: TaskInfoStatus;
}
/** 任务列表快照。 */
export interface TaskInfoSnapshot {
    items: TaskInfo[];
    total: number;
    /** 读库失败（与「确实没有任务」区分；见 `query/task-center.ts` 的读错误口径）。 */
    readError?: string;
}
/** 任务写操作结果。 */
export interface TaskInfoMutationResult {
    ok: boolean;
    id?: number;
    status?: TaskInfoStatus;
    error?: string;
}
/** 任务或触发记录的批量删除结果。 */
export interface TaskBatchMutationResult {
    ok: boolean;
    /** 实际删除的行数；重复或不存在的 id 不计入。 */
    removed: number;
    error?: string;
}
/** 触发记录里的一张图片（只存引用，弹窗用 `apiGetImageDataUrl` 按需解码）。 */
export interface TaskTriggerImage {
    /** 消息 local_id（与 `username` 一起定位图片）。 */
    localId: number;
    /** 图片消息时间（毫秒）。 */
    createTime: number;
    /** 发送者显示名。 */
    sender: string;
    /** 图片 md5（有则带上，便于排查/去重）。 */
    md5?: string;
}
/** 一条任务触发记录。 */
export interface TaskTriggerRecord {
    id: number;
    taskId: number;
    /** 触发时的任务名快照（任务改名/删除后记录仍可读）。 */
    taskName: string;
    chatUsername: string;
    chatName: string;
    targetUsername: string;
    targetName: string;
    /** 命中的关键词（保留用户配置里的原文）。 */
    keyword: string;
    /** 触发文本（命中那条消息的可读正文）。 */
    text: string;
    images: TaskTriggerImage[];
    /** 命中消息的 local_id / sort_seq（去重与跳回会话用）。 */
    messageLocalId: number;
    messageSortSeq: number;
    triggeredAt: number;
    callbackStatus: TaskTriggerCallbackStatus;
    callbackAt?: number;
    callbackError?: string;
}
/** 触发记录查询。 */
export interface TaskTriggerQuery {
    /** 只看某个任务（缺省 = 全部任务的记录）。 */
    taskId?: number;
    /**
     * 在正文、任务名、会话/对象、关键词与回调错误里做包含搜索。
     *
     * 后端 trim 后最多取 100 字；`%` / `_` 按普通字符匹配，不作为 SQL 通配符。
     */
    search?: string;
    /** 最多返回多少条（后端夹取 1..200，默认 100）。 */
    limit?: number;
    /**
     * 上一页最后一条记录的稳定游标；缺省 = 第一页。
     *
     * 用 `(triggeredAt, id)` 而非仅时间：同一毫秒内可能有多条记录，单列游标会漏页。
     */
    cursor?: TaskTriggerCursor;
}
/** 触发记录倒序列表的复合游标（`triggeredAt` 相同则按 id 继续）。 */
export interface TaskTriggerCursor {
    triggeredAt: number;
    id: number;
}
/** 触发记录快照。 */
export interface TaskTriggerSnapshot {
    items: TaskTriggerRecord[];
    /** 当前筛选条件下的记录总数（不是本页条数）。 */
    total: number;
    /** 下一页游标；没有更多记录时省略。 */
    nextCursor?: TaskTriggerCursor;
    readError?: string;
}
/** 一次触发扫描的结果。 */
export interface TaskTriggerScanResult {
    ok: boolean;
    /** 参与扫描的已完善任务数。 */
    tasks: number;
    /** 实际检查的新消息数。 */
    scanned: number;
    /** 新建的触发记录数。 */
    created: number;
    /** 顺手投递成功的回调数。 */
    dispatched: number;
    error?: string;
    /** 单个任务失败不连坐：逐条原因（只保留前 10 条）。 */
    errors?: string[];
}
/** 手动重试一次回调的结果。 */
export interface TaskCallbackDispatchResult {
    ok: boolean;
    status: TaskTriggerCallbackStatus;
    error?: string;
}
/** 回调请求体（后端按此形状 POST JSON；不持久化，只发出去）。 */
export interface TaskCallbackPayload {
    taskId: number;
    taskName: string;
    recordId: number;
    triggeredAt: number;
    triggeredAtText: string;
    chat: {
        username: string;
        name: string;
        type: TaskInfoChatType;
    };
    target: {
        username: string;
        name: string;
    };
    keyword: string;
    text: string;
    images: Array<{
        localId: number;
        createTime: number;
        sender: string;
        md5?: string;
        /** `data:image/...;base64,...`（解码失败时缺省，但会带上 error）。 */
        dataUrl?: string;
        error?: string;
    }>;
}
/**
 * 八爪鱼 RPA 的「启动流程」请求体（2026-10-21，触发方式 = `bazhuayu`）。
 *
 * 字段形状来自八爪鱼开放接口 `POST /api/bots/scheduling/start` 的示例；三个业务参数
 * 由触发记录映射：
 *  · `Params.room_name` ← 会话名（群聊名 / 单聊对象名，`TaskTriggerRecord.chatName`）；
 *  · `Params.content`   ← 触发文本（过隐私闸后的 `text`）；
 *  · `Params.at_name`   ← 触发对象显示名（`TaskTriggerRecord.targetName`）；单聊任务创建时
 *    没有目标成员，回落会话名 `chatName`（单聊里「触发的用户对象」就是会话本人）。
 *
 * 说明：RPA 方式**不发图片**（接口没有对应参数），`photoLimit` 对它不生效。
 */
export interface TaskBazhuayuStartPayload {
    FlowId: string;
    /** 固定 `ByNewestContent`：让流程取最新一条内容，而不是指定版本。 */
    FlowContentRetrievalMode: 'ByNewestContent';
    /** 固定空串（接口必填但暂不支持指定版本）。 */
    SpecifiedPublicationVersion: string;
    /** 固定空串（接口必填但暂不支持指定机器人）。 */
    SpecifiedBot: string;
    Params: {
        room_name: string;
        content: string;
        at_name: string;
    };
    /** 固定 `OpenApi`：来源是本应用的外部 API 触发。 */
    UserStartSource: 'OpenApi';
}
