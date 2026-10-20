/**
 * iLink 协议客户端守卫（`query/clawbot/clawbot-ilink.ts`）—— 全部用假 fetch，零出网。
 *
 * 协议事实来自 WeClaw 源码 + 本机实拨（见模块头注）。这里钉住四类**会静默坏掉**的点：
 *  ① 取码/状态响应的字段解析（少一个字段就得抛可读中文，不许把半截数据当成功）；
 *  ② 认证头与 body 形状（错一个头 / 混进内容字段，服务端不一定报错）；
 *  ③ `baseurl` 越域拒绝（服务端说去哪就去哪 = 「唯一主机」承诺失真）；
 *  ④ 消息帧 → 落库行的映射（方向 / 去重 id / 各条目类型）。
 * @vitest-environment node
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CLAWBOT_QR_TTL_MS,
  ILINK_BASE_URL,
  getUpdates,
  mapWeixinMessage,
  pollBindStatus,
  requestBindQr,
  sendTextMessage,
  type FetchLike,
  type IlinkCredentials,
} from '../src/query/clawbot/clawbot-ilink.ts'

/** 记下每次调用的一把假 fetch（返回给定 JSON）。 */
function recordingFetch(payload: unknown, status = 200): { fetchImpl: FetchLike, calls: Array<{ url: string, init: { method?: string, headers?: Record<string, string>, body?: string, signal?: AbortSignal } | undefined }> } {
  const calls: Array<{ url: string, init: { method?: string, headers?: Record<string, string>, body?: string, signal?: AbortSignal } | undefined }> = []
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, init })
    return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(payload) }
  }
  return { fetchImpl, calls }
}

const CREDS: IlinkCredentials = { botToken: 'bt', ilinkBotId: 'bot', ilinkUserId: 'user', baseUrl: '' }

afterEach(() => {
  vi.useRealTimers()
})

describe('requestBindQr', () => {
  it('解析 qrcode / qrcode_img_content，打的是固定取码地址', async () => {
    const { fetchImpl, calls } = recordingFetch({ qrcode: 'abc123', qrcode_img_content: 'https://liteapp.weixin.qq.com/q/x', ret: 0 })
    const qr = await requestBindQr({ fetchImpl })
    expect(qr).toEqual({ token: 'abc123', payload: 'https://liteapp.weixin.qq.com/q/x' })
    expect(calls[0]?.url).toBe(ILINK_BASE_URL + '/ilink/bot/get_bot_qrcode?bot_type=3')
    expect(calls[0]?.init?.method).toBe('GET')
    expect(calls[0]?.init?.body).toBeUndefined()
  })

  it('缺字段 ⇒ 抛可读中文；HTTP 非 200 ⇒ 错误里带上状态码与响应片段', async () => {
    const missing = recordingFetch({ qrcode: 'abc' })
    await expect(requestBindQr({ fetchImpl: missing.fetchImpl })).rejects.toThrow('缺少 qrcode / qrcode_img_content')

    const bad = recordingFetch({ message: 'boom' }, 500)
    await expect(requestBindQr({ fetchImpl: bad.fetchImpl })).rejects.toThrow(/HTTP 500/)
  })

  it('超时：挂住的请求在 40s 后被 AbortController 掐断（对取码是 20s）', async () => {
    vi.useFakeTimers()
    let aborted = false
    const hanging: FetchLike = (_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')) })
    })
    const p = requestBindQr({ fetchImpl: hanging })
    const assertion = expect(p).rejects.toThrow('aborted')
    await vi.advanceTimersByTimeAsync(20_000)
    await assertion
    expect(aborted).toBe(true)
  })
})

describe('pollBindStatus', () => {
  it('四态解析：wait / scaned / expired / 未知串 → unknown', async () => {
    for (const status of ['wait', 'scaned', 'expired'] as const) {
      const { fetchImpl } = recordingFetch({ ret: 0, status })
      expect(await pollBindStatus('tok', { fetchImpl })).toEqual({ status })
    }
    const odd = recordingFetch({ ret: 0, status: 'brand-new-state' })
    expect(await pollBindStatus('tok', { fetchImpl: odd.fetchImpl })).toEqual({ status: 'unknown' })
  })

  it('confirmed：解析四项凭证；缺 bot_token / ilink_bot_id ⇒ 按 error 返回（不拿来当成功）', async () => {
    const ok = recordingFetch({ ret: 0, status: 'confirmed', bot_token: 'B', ilink_bot_id: 'I', ilink_user_id: 'U', baseurl: 'https://ilinkai.weixin.qq.com' })
    expect(await pollBindStatus('tok', { fetchImpl: ok.fetchImpl })).toEqual({
      status: 'confirmed',
      credentials: { botToken: 'B', ilinkBotId: 'I', ilinkUserId: 'U', baseUrl: 'https://ilinkai.weixin.qq.com' },
    })
    const half = recordingFetch({ status: 'confirmed', bot_token: '', ilink_bot_id: 'I' })
    const r = await pollBindStatus('tok', { fetchImpl: half.fetchImpl })
    expect(r.status).toBe('error')
  })

  it('网络失败/超时是「常态」：按 error 返回而不是抛（调用方保留原状态继续）', async () => {
    const failing: FetchLike = async () => { throw new Error('ECONNRESET') }
    const r = await pollBindStatus('tok', { fetchImpl: failing })
    expect(r).toEqual({ status: 'error', error: 'ECONNRESET' })
  })

  it('token 进 URL 前做 encodeURIComponent（凭证里出现 & 之类不会拼坏地址）', async () => {
    const { fetchImpl, calls } = recordingFetch({ status: 'wait' })
    await pollBindStatus('a&b=c', { fetchImpl })
    expect(calls[0]?.url).toBe(ILINK_BASE_URL + '/ilink/bot/get_qrcode_status?qrcode=a%26b%3Dc')
  })
})

describe('getUpdates', () => {
  it('认证头与 body 形状照协议：只发游标与渠道版本，不夹带任何本地数据', async () => {
    const { fetchImpl, calls } = recordingFetch({ ret: 0, msgs: [], get_updates_buf: 'next' })
    const r = await getUpdates(CREDS, 'cursor-0', { fetchImpl })
    expect(r).toEqual({ ret: 0, errCode: 0, errMsg: '', messages: [], buf: 'next', longPollingTimeoutMs: 0 })
    const call = calls[0]
    expect(call?.url).toBe(ILINK_BASE_URL + '/ilink/bot/getupdates')
    expect(call?.init?.method).toBe('POST')
    expect(call?.init?.headers).toMatchObject({ AuthorizationType: 'ilink_bot_token', Authorization: 'Bearer bt' })
    expect(typeof call?.init?.headers?.['X-WECHAT-UIN']).toBe('string')
    expect(call?.init?.headers?.['X-WECHAT-UIN']?.length).toBeGreaterThan(0)
    expect(JSON.parse(call?.init?.body ?? '{}')).toEqual({ get_updates_buf: 'cursor-0', base_info: { channel_version: '1.0.0' } })
    // 每次请求都带 signal（超时掐断的把手）。
    expect(call?.init?.signal).toBeInstanceOf(AbortSignal)
  })

  it('解析 errcode / errmsg / msgs / longpolling_timeout_ms（-14 是会话过期的暗号）', async () => {
    const { fetchImpl } = recordingFetch({
      ret: 0, errcode: -14, errmsg: 'session expired', get_updates_buf: '', longpolling_timeout_ms: 35000,
      msgs: [{ message_id: 5, message_type: 1, item_list: [{ type: 1, text_item: { text: 'hi' } }] }],
    })
    const r = await getUpdates(CREDS, '', { fetchImpl })
    expect(r.errCode).toBe(-14)
    expect(r.errMsg).toBe('session expired')
    expect(r.longPollingTimeoutMs).toBe(35000)
    expect(r.messages).toHaveLength(1)
  })

  it('baseurl 越域 ⇒ 拒绝发送（零调用）——「唯一主机」承诺不许被服务端改写', async () => {
    const { fetchImpl, calls } = recordingFetch({ ret: 0 })
    await expect(getUpdates({ ...CREDS, baseUrl: 'https://evil.example.com' }, '', { fetchImpl })).rejects.toThrow('weixin.qq.com')
    await expect(getUpdates({ ...CREDS, baseUrl: 'http://ilinkai.weixin.qq.com' }, '', { fetchImpl })).rejects.toThrow('weixin.qq.com')
    await expect(getUpdates({ ...CREDS, baseUrl: 'not a url' }, '', { fetchImpl })).rejects.toThrow('baseurl')
    expect(calls).toHaveLength(0)
  })

  it('baseurl 是 weixin.qq.com 子域（服务端区域主机）⇒ 允许，且在它上面发请求', async () => {
    const { fetchImpl, calls } = recordingFetch({ ret: 0 })
    await getUpdates({ ...CREDS, baseUrl: 'https://region.ilinkai.weixin.qq.com/' }, '', { fetchImpl })
    expect(calls[0]?.url).toBe('https://region.ilinkai.weixin.qq.com/ilink/bot/getupdates')
  })
})

describe('sendTextMessage', () => {
  it('帧形状照协议：bot 发出 / to=微信用户 / 文本条目 / 令牌原样带回 / base_info 为空', async () => {
    const { fetchImpl, calls } = recordingFetch({ ret: 0, errmsg: '' })
    const r = await sendTextMessage(
      CREDS,
      { toUserId: 'user-9', text: '你好，来自桌面端', contextToken: 'ctx-1', clientId: 'cid-fixed' },
      { fetchImpl },
    )
    expect(r).toEqual({ ret: 0, errMsg: '' })
    const call = calls[0]
    expect(call?.url).toBe(ILINK_BASE_URL + '/ilink/bot/sendmessage')
    expect(call?.init?.method).toBe('POST')
    expect(call?.init?.headers).toMatchObject({ AuthorizationType: 'ilink_bot_token', Authorization: 'Bearer bt' })
    expect(JSON.parse(call?.init?.body ?? '{}')).toEqual({
      msg: {
        from_user_id: 'bot',
        to_user_id: 'user-9',
        client_id: 'cid-fixed',
        message_type: 2,
        message_state: 2,
        item_list: [{ type: 1, text_item: { text: '你好，来自桌面端' } }],
        context_token: 'ctx-1',
      },
      base_info: {},
    })
  })

  it('client_id 缺省是随机 uuid；ret!=0 **不抛**（业务拒绝有 errmsg，交给调用方）', async () => {
    const { fetchImpl, calls } = recordingFetch({ ret: 7, errmsg: 'rate limited' })
    const r = await sendTextMessage(CREDS, { toUserId: 'u', text: 'x', contextToken: 'c' }, { fetchImpl })
    expect(r).toEqual({ ret: 7, errMsg: 'rate limited' })
    const body = JSON.parse(calls[0]?.init?.body ?? '{}') as { msg: { client_id: string } }
    expect(body.msg.client_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  })

  it('越域 baseurl 同样拒发（发送与接收同一条主机纪律）', async () => {
    const { fetchImpl, calls } = recordingFetch({ ret: 0 })
    await expect(sendTextMessage(
      { ...CREDS, baseUrl: 'https://evil.example.com' },
      { toUserId: 'u', text: 'x', contextToken: 'c' },
      { fetchImpl },
    )).rejects.toThrow('weixin.qq.com')
    expect(calls).toHaveLength(0)
  })
})

describe('mapWeixinMessage', () => {
  const now = (): number => 1234

  it('文本 / 图片 / 视频 / 文件 / 语音（转写与兜底）各归各的 msgType', () => {
    expect(mapWeixinMessage({ message_id: 1, message_type: 1, item_list: [{ type: 1, text_item: { text: '你好' } }] }, now))
      .toEqual({ ts: 1234, direction: 'in', msgType: 'text', content: '你好', msgId: 1, media: null })
    expect(mapWeixinMessage({ message_id: 2, message_type: 1, item_list: [{ type: 2 }] }, now))
      .toEqual({ ts: 1234, direction: 'in', msgType: 'image', content: '[图片]', msgId: 2, media: null })
    expect(mapWeixinMessage({ message_id: 3, message_type: 1, item_list: [{ type: 3, voice_item: { text: '语音转写' } }] }, now))
      .toEqual({ ts: 1234, direction: 'in', msgType: 'voice', content: '语音转写', msgId: 3, media: null })
    expect(mapWeixinMessage({ message_id: 4, message_type: 1, item_list: [{ type: 3 }] }, now)?.content).toBe('[语音]')
    expect(mapWeixinMessage({ message_id: 5, message_type: 1, item_list: [{ type: 4, file_item: { file_name: '报告.pdf' } }] }, now)?.content).toBe('[文件] 报告.pdf')
    expect(mapWeixinMessage({ message_id: 6, message_type: 1, item_list: [{ type: 5 }] }, now)?.content).toBe('[视频]')
  })

  it('附件引用：图片明文 URL 与 CDN 加密参数两种形态都抽得到（含文件名与体积提示）', () => {
    // 图片：明文 URL（key 为空 ⇒ 取数直接 GET）。
    const byUrl = mapWeixinMessage({ message_id: 7, message_type: 1, item_list: [{ type: 2, image_item: { url: 'https://example.invalid/a.png', mid_size: 123 } }] }, now)
    expect(byUrl?.media).toEqual({ kind: 'image', ref: 'https://example.invalid/a.png', key: '', name: null, size: 123, duration: null })

    // 图片：加密参数（取数走 CDN + 解密）。
    const byParam = mapWeixinMessage({ message_id: 8, message_type: 1, item_list: [{ type: 2, image_item: { media: { encrypt_query_param: 'p1', aes_key: 'k1' }, mid_size: 456 } }] }, now)
    expect(byParam?.media).toEqual({ kind: 'image', ref: 'p1', key: 'k1', name: null, size: 456, duration: null })

    // 文件：名字与 len（字符串）都带上；len 不是数字时体积归 null。
    const file = mapWeixinMessage({ message_id: 9, message_type: 1, item_list: [{ type: 4, file_item: { file_name: '报表.xlsx', len: '2048', media: { encrypt_query_param: 'p2', aes_key: 'k2' } } }] }, now)
    expect(file?.media).toEqual({ kind: 'file', ref: 'p2', key: 'k2', name: '报表.xlsx', size: 2048, duration: null })
    const fileOdd = mapWeixinMessage({ message_id: 10, message_type: 1, item_list: [{ type: 4, file_item: { file_name: 'x', len: 'abc', media: { encrypt_query_param: 'p3' } } }] }, now)
    expect(fileOdd?.media?.size).toBeNull()

    // 语音 / 视频：各自取对的字段（voice_size / video_size）。
    const voice = mapWeixinMessage({ message_id: 11, message_type: 1, item_list: [{ type: 3, voice_item: { media: { encrypt_query_param: 'p4', aes_key: 'k4' }, voice_size: 900 } }] }, now)
    expect(voice?.media).toEqual({ kind: 'voice', ref: 'p4', key: 'k4', name: null, size: 900, duration: null })
    const video = mapWeixinMessage({ message_id: 12, message_type: 1, item_list: [{ type: 5, video_item: { media: { encrypt_query_param: 'p5', aes_key: 'k5' }, video_size: 4096 } }] }, now)
    expect(video?.media).toEqual({ kind: 'video', ref: 'p5', key: 'k5', name: null, size: 4096, duration: null })
  })

  it('语音时长：`voice_item.playtime`（毫秒）抽进 duration；其余类型恒为 null', () => {
    // 2026-10-17 补全：协议给了时长，之前没落库。
    const voice = mapWeixinMessage({ message_id: 20, message_type: 1, item_list: [{ type: 3, voice_item: { media: { encrypt_query_param: 'p9' }, playtime: 3200 } }] }, now)
    expect(voice?.media?.duration).toBe(3200)
    // 没给 playtime ⇒ null（不编造 0）。
    const noDur = mapWeixinMessage({ message_id: 21, message_type: 1, item_list: [{ type: 3, voice_item: { media: { encrypt_query_param: 'p10' } } }] }, now)
    expect(noDur?.media?.duration).toBeNull()
    // 图片/视频/文件即使带了 playtime 也不该被当成时长（只有语音有这一项）。
    const img = mapWeixinMessage({ message_id: 22, message_type: 1, item_list: [{ type: 2, image_item: { media: { encrypt_query_param: 'p11' }, mid_size: 5 } }] }, now)
    expect(img?.media?.duration).toBeNull()
  })

  it('跳过空文本条目继续找下一个；一无所获 ⇒ null（不落空行）', () => {
    expect(mapWeixinMessage({ message_id: 7, item_list: [{ type: 1, text_item: { text: '' } }, { type: 2 }] }, now)?.msgType).toBe('image')
    expect(mapWeixinMessage({ item_list: [{ type: 99 }, { type: 0 }] }, now)).toBeNull()
    expect(mapWeixinMessage({}, now)).toBeNull()
  })

  it('message_type=2 ⇒ 方向 out；message_id 缺失/非正 ⇒ msgId null（不去重，尽力而为）', () => {
    const out = mapWeixinMessage({ message_id: 8, message_type: 2, item_list: [{ type: 1, text_item: { text: 'x' } }] }, now)
    expect(out?.direction).toBe('out')
    expect(mapWeixinMessage({ item_list: [{ type: 1, text_item: { text: 'x' } }] }, now)?.msgId).toBeNull()
    expect(mapWeixinMessage({ message_id: 0, item_list: [{ type: 1, text_item: { text: 'x' } }] }, now)?.msgId).toBeNull()
  })

  it('二维码显示 TTL 常量是 5 分钟（界面倒计时的唯一出处）', () => {
    expect(CLAWBOT_QR_TTL_MS).toBe(5 * 60_000)
  })
})
