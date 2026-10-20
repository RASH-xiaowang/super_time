/**
 * 微信 ClawBot 集成 的 @Remote 处理器（A 方案，2026-10-12；iLink 通道同日接入）。
 *
 * 机制：类里保留 `@Remote` 装饰器与签名（协议层按名字枚举），方法体一行转发；
 * 处理器体在这里，依赖由 `rc` 显式给出（与 `remotes/opslog.ts` 同范式）。
 *
 * 十二个对外方法。**实例管理四个**（多实例，2026-10-13）：`listClawbotInstances` /
 * `createClawbotInstance` / `deleteClawbotInstance` / `setClawbotInstanceConfig`；
 * **绑定与会话八个**（均带可选 `slot`，缺省 = 第一个实例）：`getClawbotBinding` /
 * `createClawbotBindQr` / `getClawbotBindState` / `unbindClawbot` / `listClawbotMessages` /
 * `checkClawbotEnv` / `sendClawbotMessage` / `getClawbotMedia`。
 *
 * ## 多实例（2026-10-13）
 *
 * **一实例一条长轮询**：通道注册表是 `Map<slot, ClawbotChannel>`（见工厂里的 `channelFor`）。
 * 一条串行循环会让几个号互相饿死，而且「这一批消息属于哪个号」根本无从分辨 ——
 * 游标（`sync_buf`）、落库（`clawbot_message.slot`）、事件与附件队列全部按实例分开。
 * 扫码会话同理按 slot 分开（用户可能同时给两个号取码）。
 * 实例与配置的**存储语义**在 `query/clawbot/clawbot-instance.ts`（配置的唯一入口）；本文件只管通道、事件与转发。
 * 工厂里的两个**内部方法**（不加 `@Remote`、不进 `docs/API.md`）：`bindClawbotWechat`
 * （扫码确认后回写身份 + 凭证并拉起通道）与 `ensureClawbotChannel`（启动钩子）；
 * 重量级主体都提成了**模块级函数**：`sendClawbotText`（发送）、`mediaFor`（取媒体）、
 * `insertClawbotMessages`（落库 + 刷新令牌）、`snapshotOf`（快照）——
 * 一是让工厂不越过 `function-size-ratchet` 的 250 行线，二是这些函数都能被单测直驱。
 *
 * ## 绑定流程（一次调用 = 一次上游请求，循环由界面驱动）
 *
 * `createClawbotBindQr`（取码 + 落库 `binding` 态）→ 弹窗打开期间反复调
 * `getClawbotBindState`（每次中继一次 40s 长轮询；标签页在途请求不叠加 ——
 * 同一个在途 promise 直接复用）→ `confirmed` 时落身份/凭证、发事件、拉起通道。
 * 关掉弹窗 = 停止调用：后端不留无人消费的轮询循环。
 *
 * ## 发送（可发可收）
 *
 * `sendClawbotMessage` 是**唯一由内容驱动的出网路径**：正文 = 你在输入框里写的原文，
 * 逐条主动触发；只有服务端 `ret=0` 才落库（`direction='out'`）并发事件 ——
 * 失败不写「已发出」的假记录。会话令牌（`context_token`）取自最近一条入站消息，
 * 由通道在每批消息落库时刷新到绑定行。
 *
 * ## 事件两条（命名沿用 `<域>/<动作>` 惯例）
 *
 * - `clawbot/message`：写入消息后，`{ lastId, delta, slot }` —— **不承载正文**，
 *   前端按 `lastId` 拉增量、按 `slot` 判断是不是当前实例；
 * - `clawbot/binding-changed`：绑定状态迁移后，`{ from, to, wxid }`。
 * emit 一律 try/catch（事件推不出去不该让业务失败，与 `wechat-ask/delta` 同策略）。
 *
 * ## 出网纪律
 *
 * 本文件**不直接出网**：全部网络调用经 `query/clawbot/clawbot-ilink.ts`（唯一接缝，
 * `clawbot-outbound.spec.ts` 逐文件扫描）。请求体只含控制面信息（凭证/游标）与
 * **用户主动发送的正文**（`sendClawbotMessage`，逐条触发）。
 *
 * @module remotes/clawbot
 */
import type { ClawbotBindQr, ClawbotBindStateSnapshot, ClawbotBindingSnapshot, ClawbotBindingStatus, ClawbotEnvSnapshot, ClawbotInstanceConfig, ClawbotInstanceCreated, ClawbotInstanceDeleted, ClawbotInstancesSnapshot, ClawbotMediaResult, ClawbotMessageQuery, ClawbotMessageSnapshot, ClawbotSendResult, OperationCategory, OperationStatus } from '../types.ts';
import type { BindingCredentials } from '../query/clawbot/clawbot-binding.ts';
import { type ClawbotAskFn, type ReplyableMessage } from '../query/clawbot/clawbot-auto-reply.ts';
import { ensureClawbotMedia } from '../query/clawbot/clawbot-media.ts';
import type { WeixinMessage } from '../query/clawbot/clawbot-ilink.ts';
import { getUpdates as ilinkGetUpdates, pollBindStatus as ilinkPollBindStatus, requestBindQr as ilinkRequestBindQr, sendTextMessage as ilinkSendTextMessage } from '../query/clawbot/clawbot-ilink.ts';
/** `clawbot/binding-changed` 的参数（不含任何会话内容）。 */
export interface ClawbotBindingChangedArgs {
    from: ClawbotBindingStatus;
    to: ClawbotBindingStatus;
    wxid: string | null;
}
/**
 * `clawbot/message` 的参数（幂等提示：只带位置、数量与**实例编号**，不带正文）。
 *
 * `slot` 是多实例之后加的：事件是广播给整个渲染层的，前端必须能判断
 * 「这条提示是不是我当前看的那个号」—— 否则 A 号来消息会去刷 B 号的列表。
 */
export interface ClawbotMessageEventArgs {
    lastId: number;
    delta: number;
    /** 这批消息属于哪个实例（多实例，2026-10-13）。 */
    slot: number;
}
/**
 * 事件出口的形状：**名字与载荷成对**（判别联合）。
 *
 * 为什么不做成 `(name, args)` 两个参数：`ctx.emit` 的第一参数是 `keyof Events`、
 * 载荷类型按名字决定，把两个联合类型分开传会立刻丢掉相关性（要么强转、要么判空）。
 * 成对传递后，装配侧一个 `switch` 就能逐条对号入座，类型全程闭合。
 */
export type ClawbotEmitEvent = {
    name: 'clawbot/binding-changed';
    args: ClawbotBindingChangedArgs;
} | {
    name: 'clawbot/message';
    args: ClawbotMessageEventArgs;
};
export type ClawbotEmit = (event: ClawbotEmitEvent) => void;
/** iLink 依赖的**注入点**（测试全部注入假实现 ⇒ 零出网；生产缺省走真实客户端）。 */
export interface ClawbotIlinkDeps {
    requestBindQr: typeof ilinkRequestBindQr;
    pollBindStatus: typeof ilinkPollBindStatus;
    getUpdates: typeof ilinkGetUpdates;
    sendTextMessage: typeof ilinkSendTextMessage;
    sleep: (ms: number) => Promise<void>;
}
export interface createClawbotRemotesInputs {
    dirs: () => {
        decrypted: string;
    };
    op: (category: OperationCategory, action: string, status: OperationStatus, target?: string, detail?: string) => void;
    emit: ClawbotEmit;
    /** 可选覆盖（测试注入假 fetch/假客户端；不传 = 真实 iLink 客户端 + 真 setTimeout）。 */
    ilink?: Partial<ClawbotIlinkDeps>;
    /** 可选覆盖媒体取数与补扫清点（测试注入假实现；不传 = 真实下载解密 + 真实库清点）。 */
    media?: {
        ensure?: typeof ensureClawbotMedia;
        listPending?: (limit: number) => number[];
    };
    /**
     * ask 能力注入点（装配层把 `askDeep.askWechat` 包一层传进来）。
     *
     * 为什么注入而不是在本文件 import 问答管道：管道理面同时住着**模型解析**
     * （设置里的「对话模型」）与**隐私闸**，抄一份到这里就等于开了一条不受闸门管的旁路。
     * 注入一份调用 ⇒ 自动回复与手动问答走**同一条路**（在自动回复批次把
     * `askDeep.askWechat` 包一层接进来）。
     * 缺省（不传）= 自动回复不可用：收到消息只落库。
     */
    ask?: ClawbotAskFn;
}
/**
 * 自动回复的 ask 能力（**家**在 `query/clawbot/clawbot-auto-reply.ts` —— query 层不许反过来依赖 remotes）；
 * 这里 re-export 保持既有导入路径不变。
 */
export type { ClawbotAskFn } from '../query/clawbot/clawbot-auto-reply.ts';
/** 媒体取数的注入点（测试注入假实现 ⇒ 零出网）。 */
export interface ClawbotMediaDeps {
    ensure: typeof ensureClawbotMedia;
}
/** 图片内联上限：超过只给本机路径（防把大 base64 搬过 IPC）。 */
export declare const CLAWBOT_INLINE_MAX_BYTES: number;
/**
 * 一批消息落库（`mapWeixinMessage` → 逐条插入；`msg_id` 去重由插入兜底），
 * 把**最新的会话令牌**刷新到绑定行（发送路径下一个动作要用），并收集**新插入的附件行 id**
 * （交给自动取回队列）。
 *
 * 模块级函数（接收通道的 `insertMessages` 依赖指向它）；依赖两项显式传入。
 * @param decryptedDir - 解密数据根。
 * @param slot - 这一批属于哪个实例（**必填**：多实例下忘了传就会写进别的号的会话里）。
 * @param msgs - 协议帧数组。
 * @returns `{ lastId, delta, mediaIds, inbound }`；一条都没写入（全跳过/全重复）时为 null。
 *   `inbound` 是**本批新落库的消息**（含方向与类型）—— 自动回复据此挑选候选，
 *   省掉「落完库再查一次刚刚插了哪些」那一趟。
 */
export declare function insertClawbotMessages(decryptedDir: string, slot: number, msgs: readonly WeixinMessage[]): {
    lastId: number;
    delta: number;
    mediaIds: number[];
    inbound: ReplyableMessage[];
} | null;
export declare function createClawbotRemotes(rc: createClawbotRemotesInputs): {
    /**
     * 实例列表（设置视图的实例卡）：每个微信号一条，带各自的行为配置与会话计数。
     * @returns 实例列表快照（读失败时带 readError，界面必须与「一个实例都没有」分开显示）。
     */
    listClawbotInstances(): ClawbotInstancesSnapshot;
    /**
     * 新建一个实例（初始 `unbound`，等扫码绑定）。
     *
     * slot 由存储层按「绑定行自增 id」分配（**只增不复用**，见 `query/clawbot/clawbot-instance.ts`）。
     * @returns 新实例编号 + 最新列表（界面据此立刻对它取码，不用去猜哪条是新的）。
     */
    createClawbotInstance(): ClawbotInstanceCreated;
    /**
     * 删除一个实例：绑定行 + 配置 + **该实例的接入会话**一起删。
     *
     * 连带删会话是有意的（列表按实例遍历，实例没了那些行再也显示不出来），
     * 所以返回删掉的条数 —— 界面必须在确认框里如实告知「将删除 N 条接入会话」。
     * @param options.slot - 实例编号。
     * @returns 连带删掉的会话条数 + 最新列表。
     */
    deleteClawbotInstance(options: {
        slot: number;
    }): ClawbotInstanceDeleted;
    /**
     * 改某实例的行为配置（**部分更新**：只覆盖传进来的字段，缺省保持原值）。
     * @param options.slot - 实例编号。
     * @param options.autoReply / kbEnabled / kbId / systemPrompt / splitReply - 要改的字段。
     * @returns 落库后的完整配置（含归一后的 kbId）。
     */
    setClawbotInstanceConfig(options: {
        slot: number;
        autoReply?: boolean;
        kbEnabled?: boolean;
        kbId?: number | null;
        systemPrompt?: string;
        splitReply?: boolean;
    }): ClawbotInstanceConfig;
    /**
     * **内部**（不加 `@Remote`）：见 {@link createBindFlow} 的 `bindClawbotWechat`。
     */
    bindClawbotWechat: (identity: {
        wxid: string;
        userName?: string | null;
        avatar?: string | null;
    }, credentials?: BindingCredentials | null, slot?: number) => ClawbotBindingSnapshot;
    /**
     * **内部**（不加 `@Remote`）：网关启动时把**每个已绑定实例**的通道拉起来。
     *
     * 条件：该实例 `bound` 且凭证齐备 —— 其他状态一律不启动（**也就不会出网**）。
     * 幂等：通道自己保证重复 `start()` 无副作用。顺带做一次附件**启动补扫**：
     * 上次运行没取完、或当时网络不通的那批，在这里补齐（缓存命中的只是一次 stat）。
     */
    ensureClawbotChannel: () => void;
    /**
     * 接入会话检索（时间 / 关键词 / 方向 / 分页 / 续传）；`slot` 缺省 = 第一个实例。
     * @param options - 检索条件（关键词在服务端过滤；带 `slot` 就是按实例分）。
     * @returns 会话页快照。
     */
    listClawbotMessages(options?: ClawbotMessageQuery): ClawbotMessageSnapshot;
    /**
     * 清空某实例的**接入会话**（2026-10-17 用户要求「增加对话历史清除按钮，可以删除对话历史
     * 以防止污染回复」）。
     *
     * 只删消息，**不动绑定与配置**（那是另一回事）；返回删掉的条数与最新快照
     * （界面据此立刻刷新，不用再发一次 list）。
     * @param options.slot - 实例编号（缺省 = 第一个实例）。
     * @returns 删掉的条数 + 最新会话页快照。
     */
    clearClawbotMessages(options?: {
        slot?: number;
    }): {
        removed: number;
        messages: ClawbotMessageSnapshot;
    };
    /**
     * 环境自检（M-C 精简版，只查 3 项）—— 第 ② 项读**该实例**通道的真实运行态。
     * @param options.slot - 实例编号（缺省 = 第一个实例）。
     * @returns 自检快照。
     */
    checkClawbotEnv(options?: {
        slot?: number;
    }): ClawbotEnvSnapshot;
    /**
     * 发送一条消息到微信（**唯一由内容驱动的出网路径**，用户逐条主动触发）。
     *
     * 主体在 {@link sendClawbotText}（前置校验 / 上游发送 / 成功才落库）；
     * 这里只负责「成功发一条实时事件」——失败不写「已发出」的假记录。
     * @param options.text - 正文原文（不打码、不改写；打码开关只作用于展示层）。
     * @param options.slot - 从哪个实例发（缺省 = 第一个实例）。
     * @returns 发送结果（见 {@link ClawbotSendResult}）。
     */
    sendClawbotMessage(options: {
        text: string;
        slot?: number;
    }): Promise<ClawbotSendResult>;
    /**
     * 取某条消息的附件（**只在用户点开时发生**）：按需下载 + 解密 + 落盘缓存。
     *
     * 按消息 id 取（id 全局唯一），所以**不需要 slot**。缓存命中不再联网；
     * 主机白名单与体积上限都在 `query/clawbot/clawbot-media.ts` 里判。
     * @param options.id - 会话行 id。
     * @returns 取数结果（见 {@link ClawbotMediaResult}）。
     */
    getClawbotMedia(options: {
        id: number;
    }): Promise<ClawbotMediaResult>;
    /**
     * 当前绑定行（设置卡片首屏）。
     * @param options.slot - 实例编号（缺省 = 第一个已绑定实例，其次第一个实例）。
     * @returns 绑定卡片快照（含会话计数与通道状态）。
     */
    getClawbotBinding(options?: {
        slot?: number;
    }): ClawbotBindingSnapshot;
    /**
     * 申请绑定二维码（真实调用腾讯 iLink 服务；需要联网，失败时原样抛错让界面提示）。
     * @param options.slot - 为哪个实例取码（缺省 = 第一个实例）。
     * @returns 一次性凭证 / 二维码内容 / 过期时间 / 初始四态。
     */
    createClawbotBindQr(options?: {
        slot?: number;
    }): Promise<ClawbotBindQr>;
    /**
     * 中继一次绑定状态轮询（弹窗打开期间反复调用；在途请求不叠加）。
     *
     * 没有进行中的会话（从未申请 / 重启丢会话 / 已完成）⇒ `idle`；
     * `confirmed` / `expired` 是终态，重复调用直接返回、不再打上游。
     * @param options.slot - 哪个实例的这场会话（缺省 = 第一个实例）。
     * @returns 状态与绑定卡片快照。
     */
    getClawbotBindState(options?: {
        slot?: number;
    }): Promise<ClawbotBindStateSnapshot>;
    /**
     * 解绑：停该实例的通道、清凭证（`unbindBinding`）、**保留接入会话**（D-4）。
     * @param options.slot - 实例编号（缺省 = 第一个实例）。
     * @returns 解绑后的绑定卡片快照。
     */
    unbindClawbot(options?: {
        slot?: number;
    }): ClawbotBindingSnapshot;
    /**
     * 给实例起别名（「工作号」「客服号」；2026-10-16）。
     *
     * 与绑定状态机**无关**：只动 `label` 一列，所以别名活过重新绑定与解绑。
     * 空串 = 清除别名（界面回落到昵称，再回落到「实例 N」）。
     * @param options.slot - 实例编号。
     * @param options.label - 新别名（空串 = 清除）。
     * @returns 落库后的绑定卡片快照（界面据此立刻更新轨上的名字）。
     */
    renameClawbotInstance(options: {
        slot: number;
        label: string;
    }): ClawbotBindingSnapshot;
};
