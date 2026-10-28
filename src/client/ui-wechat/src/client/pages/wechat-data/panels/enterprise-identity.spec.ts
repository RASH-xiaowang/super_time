import { describe, expect, it } from 'vitest'
import { directChatEnterpriseName, identityLabel, isEnterpriseWechatUser, sessionDisplayNameWithEnterprise, withEnterprise } from './enterprise-identity.ts'

describe('enterprise identity display helpers', () => {
  it('recognizes enterprise-WeChat users but not ordinary or kefu accounts', () => {
    expect(isEnterpriseWechatUser('wxid_peer@openim')).toBe(true)
    expect(isEnterpriseWechatUser(' WXID_PEER@OPENIM ')).toBe(true)
    expect(isEnterpriseWechatUser('wxid_regular')).toBe(false)
    expect(isEnterpriseWechatUser('wxid_service@kefu.openim')).toBe(false)
  })

  it('appends the enterprise without replacing the person name', () => {
    expect(withEnterprise('张三', '深度求索')).toBe('张三（企业：深度求索）')
    expect(withEnterprise('张三', '')).toBe('张三')
    expect(withEnterprise(' 张三 ', ' 深度求索 ')).toBe('张三（企业：深度求索）')
    expect(withEnterprise('张三（企业：深度求索）', '深度求索')).toBe('张三（企业：深度求索）')
    expect(withEnterprise('张三（企业：旧企业）', '深度求索')).toBe('张三（企业：深度求索）')
  })

  it('fills a missing direct-chat session enterprise from loaded messages', () => {
    expect(directChatEnterpriseName('wxid_peer@openim', [
      { senderEnterpriseName: '' },
      { senderEnterpriseName: ' 深度求索 ' },
    ])).toBe('深度求索')
    expect(directChatEnterpriseName('wxid_regular', [
      { senderEnterpriseName: '深度求索' },
    ])).toBeUndefined()
    expect(directChatEnterpriseName('wxid_service@kefu.openim', [
      { senderEnterpriseName: '深度求索' },
    ])).toBeUndefined()
  })

  it('does not duplicate an enterprise that equals the display name', () => {
    expect(withEnterprise('深度求索', '深度求索')).toBe('深度求索')
  })

  it('resolves the ask scope label from the selected session', () => {
    const sessions = [
      { username: 'wxid_enterprise@openim', displayName: '张三', enterpriseName: '深度求索' },
      { username: 'wxid_regular', displayName: '李四' },
    ]
    expect(sessionDisplayNameWithEnterprise(sessions, 'wxid_enterprise@openim')).toBe('张三（企业：深度求索）')
    expect(sessionDisplayNameWithEnterprise(sessions, 'wxid_missing')).toBe('wxid_missing')
    expect(sessionDisplayNameWithEnterprise(sessions, '')).toBe('')
  })

  it('formats direct and group citation identities independently', () => {
    expect(identityLabel({
      name: '张三',
      enterpriseName: '甲方公司',
      sender: '李四',
      senderEnterpriseName: '乙方公司',
    })).toBe('张三（企业：甲方公司） · 李四（企业：乙方公司）')
  })
})
