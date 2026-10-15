/**
 * 变异登记 · 聊天信息抽屉的**实时刷新**（2026-10-13，M496 起）。
 *
 * 这一批守的是「抽屉开着时，数据落地后界面会不会自己变」（2026-10-13 修掉的缺陷：
 * 单聊 360 与群聊信息都只在打开时取一次数，「消息总数 / 最近联系 / 群成员数 / 群公告」
 * 停在打开那一刻）。坏形状都是**静默**的：
 *   · 订阅被摘掉 ⇒ 事件来了不重取，界面停在旧数上（没有报错，用户只能靠目测发现）；
 *   · 落地闸取反 ⇒ 事件后切了会话，旧响应盖到新会话的抽屉头上（A 群的人出现在 B 群里）；
 *   · 状态袋不再调刷新钩子 ⇒ 刷新件成了死代码，全表照绿。
 *
 * 每条都把「坏形状」注回去，要求指定 spec 的用例**当场变红**。
 *
 * @module mutations-registry/batch3j
 */
export const MUTATIONS_BATCH3J = [
  {
    id: 'M496-chats-contact-info-loses-live-subscription',
    why: '单聊「聊天信息」抽屉不再订阅宿主数据事件 ⇒ 抽屉开着时新消息解密落地，「消息总数 / 最近联系」停在打开那一刻（与群聊抽屉同族缺陷，2026-10-13 修掉）。判据：chats-contact-info-view.spec.ts 的「开着时宿主数据事件 ⇒ 静默重取并重绘统计」。',
    file: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/chats-contact-info-view.tsx',
    from: 'useWechatDataUpdated(refreshContact360)',
    to: '',
    spec: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/chats-contact-info-view.spec.ts',
  },
  {
    id: 'M497-chats-group-info-loses-host-push-subscription',
    why: '群信息刷新件丢掉「宿主数据事件」这条订阅（只留缓存刷新广播）⇒ 新数据解密落地后抽屉不重取，广播只在缓存后台复验真正变化时才来一条，界面停在旧数上。判据：chats-info-live.spec.ts 的「开着时宿主数据事件 ⇒ 按当前会话静默重取并写回」。',
    file: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/chats-info-live.ts',
    from: 'useWechatDataUpdated(refresh)',
    to: '',
    spec: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/chats-info-live.spec.ts',
  },
  {
    id: 'M498-chats-info-refresh-guard-inverted',
    why: '落地闸的相等比较写成不相等 ⇒ 事件后没切会话的正常刷新被丢弃（界面永不更新）、切了会话的旧响应反而落地（A 群的数据盖到 B 群抽屉头上）。判据：chats-info-live.spec.ts 的「落地闸 infoRefreshApplies」象限用例。',
    file: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/chats-info-live.ts',
    from: 'fetchedFor === currentTalker',
    to: 'fetchedFor !== currentTalker',
    spec: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/chats-info-live.spec.ts',
  },
  {
    id: 'M499-chats-group-info-state-bag-drops-live-hook',
    why: '群信息状态袋不再调用 useGroupInfoLive ⇒ 刷新件整套成死代码（面板侧没有任何别的接线点），抽屉又回到「打开时取一次」的旧缺陷，而它自己的 spec 全绿。判据：chats-group-info-view.wiring.spec.ts 的「状态袋接上 useGroupInfoLive」。',
    file: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/chats-group-info.tsx',
    from: 'useGroupInfoLive({ open: groupInfoOpen, talkerRef, sessionAlive, sessionEpochRef, setGroupInfo, setGroupInfoErr })',
    to: '',
    spec: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/chats-group-info-view.wiring.spec.ts',
  },
]
