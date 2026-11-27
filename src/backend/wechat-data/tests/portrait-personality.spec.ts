/**
 * @vitest-environment node
 *
 * 人物性格的材料：图片、聊天、朋友圈都要进样本，短占位符不算原话。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import type { MomentItem, WechatMessage } from '../src/types.ts'
import { personalityMaterial, personalityMaterialEnough, missingPortraitSections, mergePortraitText, portraitNeedsContinuation, personalityLanguageCues } from '../src/query/portrait-personality.ts'
import { readPortraitPersonality, savePortraitPersonality, portraitPersonalityDir } from '../src/query/portrait-personality-store.ts'

function message(partial: Partial<WechatMessage>): WechatMessage {
  return {
    localId: 1,
    type: 1,
    isSender: 0,
    createTime: 1,
    displayText: '你好',
    ...partial,
  }
}

function moment(text: string, mediaCount = 0): MomentItem {
  return {
    tid: text,
    username: 'wxid_a',
    author: '甲',
    text,
    ts: 1,
    time: '',
    media_count: mediaCount,
    media_desc: mediaCount > 0 ? '旅行' : '',
    images: [],
    videos: [],
    location: '',
    link_title: '',
    is_self: false,
    likes: [],
    comments: [],
  }
}

describe('personalityMaterial', () => {
  it('保留对方原话和朋友圈图文，并单独数出对方发出的图片', () => {
    const material = personalityMaterial([
      message({ localId: 1, displayText: '周末一起吃饭吗' }),
      message({ localId: 2, type: 3, renderType: 'image', displayText: '[图片]' }),
      message({ localId: 3, isSender: 1, displayText: '好啊' }),
      message({ localId: 4, renderType: 'system', displayText: '你撤回了一条消息' }),
    ], [moment('今天去海边', 2)])
    expect(material.peer).toEqual(['周末一起吃饭吗'])
    expect(material.self).toEqual(['好啊'])
    expect(material.images).toBe(1)
    expect(material.imageLocalIds).toEqual([2])
    expect(material.moments[0]).toContain('今天去海边')
    expect(material.moments[0]).toContain('2 个图片或视频')
  })

  it('原话从整段样本里均匀抽取，开头和结尾都要留下', () => {
    const messages = Array.from({ length: 120 }, (_, index) => message({
      localId: index + 1,
      createTime: index + 1,
      displayText: `第${String(index)}句`,
    }))
    const material = personalityMaterial(messages, [])
    expect(material.peer[0]).toBe('第0句')
    expect(material.peer[material.peer.length - 1]).toBe('第119句')
    expect(material.peer.length).toBe(100)
  })

  it('对方聊天图和朋友圈图会留下准备送给模型的抽样', () => {
    const messages = Array.from({ length: 20 }, (_, index) => message({
      localId: index + 1,
      createTime: index + 1,
      type: 3,
      renderType: 'image',
      displayText: '[图片]',
    }))
    const material = personalityMaterial(messages, [{
      ...moment('海边', 1),
      images: [{ thumb: '', url: '', key: '', md5: 'abc', timelineId: 't1', id: 'm1' }],
    }])
    expect(material.images).toBe(20)
    expect(material.imageLocalIds).toHaveLength(8)
    expect(material.imageLocalIds[0]).toBe(1)
    expect(material.imageLocalIds[7]).toBe(20)
    expect(material.momentImageRefs).toEqual([{ md5: 'abc', timelineId: 't1', mediaId: 'm1' }])
  })

  it('分块缺正文时算没写完，补写会接在原稿后面', () => {
    const complete = [
      '这个人：从这些记录看，他说话短，常约饭，也发海边的照片。依据来自聊天和图片。',
      '说话方式：从这些记录看，句子短，问句不多。依据来自聊天。',
      '在意什么：从这些记录看，在意见面和出行。依据来自朋友圈。',
      '和人相处：从这些记录看，会接话，也会说一起。依据来自聊天。',
      '生活画面：从这些记录看，照片里有海边和饭局。依据来自图片。',
      '言行是否一致：聊天里约饭，朋友圈也在出门，两边都看得到。依据来自聊天和朋友圈。',
      '性格观察：开放，会提不同的去处。做事，约好后会再确认。外向，会主动找人。待人，会问对方有没有空。情绪，压力词很少。',
      '还不能确定：听不到语气，也看不到实时肢体。这类材料不足，看不出来。',
    ].join('\n')
    expect(missingPortraitSections(complete)).toEqual([])
    expect(portraitNeedsContinuation(complete, 'stop')).toBe(false)
    expect(missingPortraitSections('这个人：从这些记录看，他说话短，常约人吃饭。')).toEqual([
      '说话方式',
      '在意什么',
      '和人相处',
      '生活画面',
      '言行是否一致',
      '性格观察',
      '还不能确定',
    ])
    expect(portraitNeedsContinuation('这个人：从这些记录看，他说话很短。', 'max-tokens')).toBe(true)
    expect(mergePortraitText('这个人：已有。', '')).toBe('这个人：已有。')
    expect(mergePortraitText('这个人：已有。', '在意什么：补上这一段。')).toBe('这个人：已有。\n\n在意什么：补上这一段。')
  })

  it('图片、聊天、朋友圈加起来不够时不推测', () => {
    expect(personalityMaterialEnough({ peer: ['嗯'], self: [], moments: [], images: 0 })).toBe(false)
    expect(personalityMaterialEnough({ peer: [], self: [], moments: [], images: 8 })).toBe(true)
    const cues = personalityLanguageCues(['周末一起吃饭吗？', '我们出发！', '今天有点累'])
    expect(cues.questions).toBe(1)
    expect(cues.exclaims).toBe(1)
    expect(cues.together).toBe(2)
    expect(cues.strain).toBe(1)
  })
})

describe('portrait personality store', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
    dirs.length = 0
  })

  function decrypted(): string {
    const root = mkdtempSync(join(tmpdir(), 'portrait-personality-'))
    dirs.push(root)
    return join(root, 'decrypted')
  }

  const saved = {
    ok: true,
    text: [
      '这个人：从这些记录看，他说话短，常约饭，也发海边的照片。依据来自聊天和图片。',
      '说话方式：从这些记录看，句子短，问句不多。依据来自聊天。',
      '在意什么：从这些记录看，在意见面和出行。依据来自朋友圈。',
      '和人相处：从这些记录看，会接话，也会说一起。依据来自聊天。',
      '生活画面：从这些记录看，照片里有海边和饭局。依据来自图片。',
      '言行是否一致：聊天里约饭，朋友圈也在出门，两边都看得到。依据来自聊天和朋友圈。',
      '性格观察：开放，会提不同的去处。做事，约好后会再确认。外向，会主动找人。待人，会问对方有没有空。情绪，压力词很少。',
      '还不能确定：听不到语气，也看不到实时肢体。这类材料不足，看不出来。',
    ].join('\n'),
    messages: 12,
    moments: 3,
  }

  it('成功的分析写入硬盘，下次按同一个人读回来', () => {
    const dir = decrypted()
    const savedAt = savePortraitPersonality(dir, 'wxid_a', saved)
    expect(savedAt).toEqual(expect.any(Number))
    const loaded = readPortraitPersonality(dir, 'wxid_a')
    expect(loaded?.ok).toBe(true)
    expect(loaded?.cached).toBe(true)
    expect(loaded?.text).toBe(saved.text)
    expect(loaded?.savedAt).toBe(savedAt)
    expect(readPortraitPersonality(dir, 'wxid_b')).toBeUndefined()
  })

  it('没写完或失败的结果不落盘', () => {
    const dir = decrypted()
    expect(savePortraitPersonality(dir, 'wxid_a', { ...saved, ok: false, error: 'empty' })).toBeUndefined()
    expect(savePortraitPersonality(dir, 'wxid_a', { ...saved, text: '说话方式：只有一段，后面没有。' })).toBeUndefined()
    expect(readPortraitPersonality(dir, 'wxid_a')).toBeUndefined()
  })

  it('旧版式的存档也能直接读出，不会在打开时重新生成', () => {
    const dir = decrypted()
    const folder = portraitPersonalityDir(dir)
    mkdirSync(folder, { recursive: true })
    const name = createHash('sha256').update('wxid_old', 'utf8').digest('hex').slice(0, 32)
    writeFileSync(join(folder, `${name}.json`), JSON.stringify({
      version: 2,
      username: 'wxid_old',
      savedAt: 10,
      text: '说话方式：旧存档只有这一段，打开时应该立刻读出来。',
      messages: 4,
      moments: 1,
    }))
    const loaded = readPortraitPersonality(dir, 'wxid_old')
    expect(loaded?.cached).toBe(true)
    expect(loaded?.text).toContain('立刻读出来')
    expect(readPortraitPersonality(dir, 'wxid_old')).toBe(loaded)
  })
})
