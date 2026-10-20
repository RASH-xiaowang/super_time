import type { ClawbotBindQr, ClawbotBindStateSnapshot, ClawbotBindingSnapshot, ClawbotEnvSnapshot, ClawbotInstanceConfig, ClawbotInstanceCreated, ClawbotInstanceDeleted, ClawbotInstancesSnapshot, ClawbotMediaResult, ClawbotMessageQuery, ClawbotMessageSnapshot, ClawbotSendResult } from './types.ts';
import { createClawbotRemotes } from './remotes/clawbot.ts';
import { GatewayDbHealth } from './gateway-db-health.ts';
/** 方法面的一层：继承链上的一环，不单独实例化。 */
export declare abstract class GatewayClawbot extends GatewayDbHealth {
    /**
     * 实例列表（多实例：一个微信号 = 一个实例；每个实例有自己的自动回复与知识库开关）。
     * @returns 实例列表快照（读失败时带 readError —— 与「一个实例都没有」不是一回事）。
     */
    listClawbotInstances(): ClawbotInstancesSnapshot;
    /**
     * 新建一个实例（初始未绑定；随后用 `createClawbotBindQr` 为它取码）。
     * @returns 新实例编号 + 最新实例列表。
     */
    createClawbotInstance(): ClawbotInstanceCreated;
    /**
     * 删除一个实例（绑定行 + 配置 + **该实例的接入会话**一起删；条数如实回报）。
     * @param options.slot - 实例编号。
     * @returns 连带删除的会话条数 + 最新实例列表。
     */
    deleteClawbotInstance(options: {
        slot: number;
    }): ClawbotInstanceDeleted;
    /**
     * 改某实例的**行为配置**（AI 自动回复 / 知识库增强；部分更新）。
     *
     * 模型不在这里选：自动回复走与「微信问答」同一条 ask 管道 ⇒
     * 统一由设置里的「对话模型」决定（见 `remotes/clawbot.ts` 的 `ask` 注入点）。
     * @param options - 实例编号 + 要改的字段。
     * @returns 落库后的完整配置。
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
     * 给实例起别名（「工作号」「客服号」；2026-10-16）。
     *
     * 与绑定状态机无关（只动 `label` 一列）⇒ 别名活过重新绑定与解绑。
     * 空串 = 清除别名（界面回落到昵称，再回落到「实例 N」）。
     * @param options.slot - 实例编号。
     * @param options.label - 新别名（空串 = 清除）。
     * @returns 落库后的绑定卡片快照。
     */
    renameClawbotInstance(options: {
        slot: number;
        label: string;
    }): ClawbotBindingSnapshot;
    /**
     * 当前绑定行（设置卡片首屏）。
     * @param options.slot - 实例编号（缺省 = 第一个实例）。
     * @returns 绑定卡片快照（含会话计数与通道状态）。
     */
    getClawbotBinding(options?: {
        slot?: number;
    }): ClawbotBindingSnapshot;
    /**
     * 申请绑定二维码（真实调用腾讯 iLink 服务；失败抛可读中文，渲染层按 message 展示）。
     * @param options.slot - 为哪个实例取码（缺省 = 第一个实例）。
     * @returns 一次性凭证 / 二维码内容 / 过期时间 / 初始四态。
     */
    createClawbotBindQr(options?: {
        slot?: number;
    }): Promise<ClawbotBindQr>;
    /**
     * 中继一次绑定状态轮询（弹窗打开期间反复调用；单次最长约 40 秒，见 remote-policy.js）。
     * @param options.slot - 哪个实例的这场扫码会话（缺省 = 第一个实例）。
     * @returns 状态与绑定卡片快照。
     */
    getClawbotBindState(options?: {
        slot?: number;
    }): Promise<ClawbotBindStateSnapshot>;
    /**
     * 解绑（断开该实例的通道；**接入会话保留**，见 PRIVACY.md 第三节）。
     * @param options.slot - 实例编号（缺省 = 第一个实例）。
     * @returns 解绑后的绑定卡片快照。
     */
    unbindClawbot(options?: {
        slot?: number;
    }): ClawbotBindingSnapshot;
    /**
     * 接入会话检索（时间 / 关键词 / 方向 / 分页 / 续传）。
     * @param options - 检索条件（关键词在服务端过滤；带 `slot` 即按实例分）。
     * @returns 会话页快照。
     */
    listClawbotMessages(options?: ClawbotMessageQuery): ClawbotMessageSnapshot;
    /**
     * 清空某实例的**接入会话**（2026-10-17）：只删消息，不动绑定与配置。
     * @param options.slot - 实例编号（缺省 = 第一个实例）。
     * @returns 删掉的条数 + 最新会话页快照（界面据此立刻刷新）。
     */
    clearClawbotMessages(options?: {
        slot?: number;
    }): {
        removed: number;
        messages: ClawbotMessageSnapshot;
    };
    /**
     * 取**内置的拟人化默认系统提示词**（2026-10-17）。
     *
     * 为什么要有它：设置视图的输入框此前是空的（「留空 = 用默认值」），用户**看不到**
     * 默认值长什么样 —— 想改也不知道从哪改起。把它暴露给界面，输入框就能预填，
     * 用户可以直接在默认值上改（而不是从零写）。
     * @returns 默认提示词全文。
     */
    getClawbotDefaultPrompt(): {
        prompt: string;
    };
    /**
     * 环境自检（精简 3 项：应用运行 / 绑定通道 / 集成状态）—— 第 ② 项读的是该实例的通道。
     * @param options.slot - 实例编号（缺省 = 第一个实例）。
     * @returns 自检快照。
     */
    checkClawbotEnv(options?: {
        slot?: number;
    }): ClawbotEnvSnapshot;
    /**
     * 发送一条消息到微信（用户主动触发；正文经腾讯服务中转，**唯一由内容驱动的出网路径**）。
     * @param options.text - 正文原文（不打码、不改写）。
     * @param options.slot - 从哪个实例发（缺省 = 第一个实例）。
     * @returns 发送结果（失败不落库，error 为可读中文）。
     */
    sendClawbotMessage(options: {
        text: string;
        slot?: number;
    }): Promise<ClawbotSendResult>;
    /**
     * 取某条消息的附件（按需下载 + 解密 + 缓存；只在用户点开时发生）。
     * @param options.id - 会话行 id。
     * @returns 取数结果（图片给小图 dataUrl；其余给本机路径）。
     */
    getClawbotMedia(options: {
        id: number;
    }): Promise<ClawbotMediaResult>;
    /**
     * 覆写 core 的启动钩子：**每个**绑定过的实例的接收通道随网关拉起（幂等；未绑定/无凭证的
     * 实例不启动，也就不会有任何出网）。收消息是宿主职责 —— 只有用户打开面板时才收等于漏消息。
     */
    protected bootClawbotChannel(): void;
    protected _clawbotRemotes?: ReturnType<typeof createClawbotRemotes>;
    /**
     * 微信 ClawBot 集成（绑定 / 接入会话 / 环境自检） 的处理器（体在 remotes/clawbot.ts）；
     * 这里只组装 ctx 与转发。组装放在本层而不是 core，是为了不让 core 越过 1000 行上限（laya 同款）。
     *
     * 事件出口在这里「对号入座」（判别联合 → 具体的 `ctx.emit` 调用）：
     * `ctx.emit` 的第一参数是 `keyof Events`，只有写死字面量才拿得到类型，
     * 所以名字的映射必须留在装配侧；try/catch 包在闭包里（事件尽力而为）。
     */
    protected clawbotRemotes(): ReturnType<typeof createClawbotRemotes>;
}
