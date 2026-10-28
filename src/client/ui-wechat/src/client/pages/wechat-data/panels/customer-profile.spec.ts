// @vitest-environment node
/**
 * 客户画像标签边界。
 *
 * 这些规则是页面上“可核验”三个字的底线：阈值、关系优先级、空数据和资金/社交事实
 * 都必须稳定；任何一条漂移都会让同一位客户在不同入口显示不同结论。
 */
import { describe, expect, it } from 'vitest'
import type { Contact360Snapshot, WechatContact } from '@deepseek-ai/dsh-wechat-data/types'
import {
  buildCustomerTags,
  customerActivity,
  customerDisplayName,
  customerIdentityOf,
  customerRelation,
  mergeCustomerCandidates,
  type CustomerIdentity,
} from './customer-profile.ts'

const NOW = 1_800_000_000
const DAY = 24 * 60 * 60

function snapshot(lastDaysAgo: number | null, overrides: Partial<Contact360Snapshot> = {}): Contact360Snapshot {
  return {
    username: 'wxid_customer',
    displayName: '客户甲',
    messages: {
      count: 30,
      firstTime: NOW - 120 * DAY,
      lastTime: lastDaysAgo === null ? null : NOW - lastDaysAgo * DAY,
    },
    moments: { count: 0 },
    funds: { transfers: 0, redpackets: 0 },
    commonGroups: [],
    updatedAt: NOW,
    ...overrides,
  }
}

function contact(username: string, category: string, overrides: Partial<WechatContact> = {}): WechatContact {
  return {
    username,
    nickName: `昵称-${username}`,
    remark: '',
    displayName: `客户-${username}`,
    category,
    ...overrides,
  }
}

function identity(overrides: Partial<CustomerIdentity> = {}): CustomerIdentity {
  return {
    username: 'wxid_customer',
    displayName: '客户甲',
    category: 'friend',
    categories: ['friend'],
    ...overrides,
  }
}

describe('客户目录合并', () => {
  it('合并好友 + 群成员身份，保留更具体分类与全部群，不产生重复客户', () => {
    const rows = mergeCustomerCandidates([
      [contact('wxid_a', 'friend', { groupUsernames: ['room_1'] })],
      [contact('wxid_a', 'member', { groupUsernames: ['room_1', 'room_2'] })],
      [contact('room_1@chatroom', 'group')],
      [contact('gh_official', 'official')],
    ])
    expect(rows).toHaveLength(1)
    expect(rows[0]?.categories).toEqual(['friend', 'member'])
    expect(rows[0]?.category).toBe('friend')
    expect(rows[0]?.groupUsernames).toEqual(['room_1', 'room_2'])
  })

  it('目录身份转成共享视图时保留备注、昵称和所属群', () => {
    const [row] = mergeCustomerCandidates([[contact('wxid_a', 'friend', {
      remark: '重要客户',
      nickName: '甲',
      groupName: '客户群',
      groupUsernames: ['room_1'],
    })]])
    expect(row).toBeDefined()
    const view = customerIdentityOf(row!)
    expect(view.remark).toBe('重要客户')
    expect(view.nickName).toBe('甲')
    expect(view.groupName).toBe('客户群')
  })

  it('昵称只剩控制字符时回退到备注或微信号，不把不可见字符画成标题', () => {
    const [row] = mergeCustomerCandidates([[contact('wxid_blank', 'friend', {
      displayName: '\u007f\u200b\u2060',
      remark: '王总',
      nickName: '正常昵称',
    })]])
    expect(row).toBeDefined()
    expect(row?.displayName).toBe('王总')
    expect(customerDisplayName(customerIdentityOf(row!))).toBe('王总')
    expect(customerDisplayName(identity({
      displayName: '\u007f\u200b',
      remark: '',
      nickName: '',
      username: 'wxid_fallback',
    }))).toBe('wxid_fallback')
  })
})

describe('关系标签', () => {
  it('本人优先于群主，群主优先于普通群成员', () => {
    const member = identity({ category: 'member', categories: ['member'] })
    expect(customerRelation(member, { isSelf: true, isGroupOwner: true })).toBe('self')
    expect(customerRelation(member, { isGroupOwner: true })).toBe('group-owner')
    expect(customerRelation(member, { source: 'group-member' })).toBe('member')
  })

  it('无通讯录分类的单聊使用诚实的“单聊联系人”兜底', () => {
    expect(customerRelation(identity({ category: undefined, categories: [] }), { source: 'session' })).toBe('session')
  })
})

describe('活跃度时间边界', () => {
  it('7/30/90 天的端点仍属于较活跃档', () => {
    expect(customerActivity(snapshot(7), { nowSec: NOW }).code).toBe('active-7d')
    expect(customerActivity(snapshot(30), { nowSec: NOW }).code).toBe('active-30d')
    expect(customerActivity(snapshot(90), { nowSec: NOW }).code).toBe('inactive-30d')
  })

  it('超过边界一天后进入下一档', () => {
    expect(customerActivity(snapshot(7.01), { nowSec: NOW }).code).toBe('active-30d')
    expect(customerActivity(snapshot(30.01), { nowSec: NOW }).code).toBe('inactive-30d')
    expect(customerActivity(snapshot(90.01), { nowSec: NOW }).code).toBe('inactive-90d')
  })

  it('没有消息或没有最近联系时间时不伪造活跃标签', () => {
    expect(customerActivity(snapshot(null), { nowSec: NOW }).code).toBe('none')
    expect(customerActivity(snapshot(1, { messages: { count: 0, firstTime: null, lastTime: NOW - DAY } }), { nowSec: NOW }).code).toBe('none')
  })
})

describe('标签事实与证据', () => {
  it('每条标签都带非空依据并声明本机规则来源', () => {
    const tags = buildCustomerTags(identity({ category: 'member' }), snapshot(1, {
      messages: { count: 500, firstTime: NOW - 200 * DAY, lastTime: NOW - DAY },
      moments: { count: 3 },
      funds: { transfers: 2, redpackets: 1 },
      commonGroups: [
        { username: 'room_1', name: '客户群一', memberCount: 20 },
        { username: 'room_2', name: '客户群二', memberCount: 30 },
      ],
    }), { nowSec: NOW, isGroupOwner: true })
    expect(tags.map((tag) => tag.code)).toEqual([
      'relation-group-owner',
      'active-7d',
      'high-frequency',
      'has-transfer',
      'has-redpacket',
      'has-common-group',
      'multi-group-overlap',
      'has-moments',
    ])
    for (const tag of tags) {
      expect(tag.evidence.trim()).not.toBe('')
      expect(tag.source).toBe('local-rule')
    }
  })

  it('少于 20 条时给“样本较少”，0 条时给“暂无聊天记录”', () => {
    const small = buildCustomerTags(identity(), snapshot(2, {
      messages: { count: 3, firstTime: NOW - DAY * 4, lastTime: NOW - DAY * 2 },
    }), { nowSec: NOW })
    expect(small.map((tag) => tag.code)).toContain('small-sample')
    const none = buildCustomerTags(identity(), snapshot(null, {
      messages: { count: 0, firstTime: null, lastTime: null },
    }), { nowSec: NOW })
    expect(none.map((tag) => tag.code)).toContain('no-chat-history')
    expect(none.map((tag) => tag.code)).not.toContain('small-sample')
    expect(none.map((tag) => tag.code)).not.toContain('active-7d')
  })

  it('快照加载失败时仍保留关系标签，不凭空生成统计结论', () => {
    const tags = buildCustomerTags(identity(), null, { source: 'directory' })
    expect(tags).toHaveLength(1)
    expect(tags[0]?.category).toBe('关系')
  })
})
