/**
 * `get_moments_stats` 工具用例：最小 sns.db、全量/区间/年度口径与缺库。
 * @vitest-environment node
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { getMomentsStatsTool } from '../src/query/tools/moments-tools.ts'
import { runProfileTool } from '../src/query/tools/profiles.ts'
import type { ToolContext } from '../src/query/tools/types.ts'

const scratch: string[] = []
afterEach(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true })
  scratch.length = 0
})

function makeRoot(): { root: string; ctx: ToolContext } {
  const root = mkdtempSync(join(tmpdir(), 'wx-moments-tool-'))
  scratch.push(root)
  return { root, ctx: { decryptedDir: root } }
}

function epoch(y: number, mo: number, d: number, h = 12): number {
  return Math.floor(new Date(y, mo - 1, d, h, 0, 0).getTime() / 1000)
}

function makeDb(path: string, create: (db: DatabaseSync) => void): void {
  mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  try { create(db) } finally { db.close() }
}

function makeContacts(root: string): void {
  makeDb(join(root, 'contact', 'contact.db'), (db) => {
    db.exec('CREATE TABLE contact (username TEXT, remark TEXT, nick_name TEXT)')
    const insert = db.prepare('INSERT INTO contact (username, remark, nick_name) VALUES (?, ?, ?)')
    insert.run('wxid_a', '张三', '张三')
    insert.run('wxid_b', '李四', '李四')
    insert.run('wxid_like', '王五', '王五')
    insert.run('wxid_cmt', '赵六', '赵六')
  })
}

interface PostOptions {
  likes?: Array<[string, string]>
  comments?: Array<[string, string, string]>
  withGeo?: boolean
}

/** 构造一条朋友圈 XML（正文 + 时间 + 可选定位 + 点赞/评论）。 */
function postXml(ts: number, text: string, options: PostOptions = {}): string {
  let seq = 1
  const likes = (options.likes ?? []).map(([username, nickname]) => {
    const id = seq++
    return '<user_comment>'
      + `<comment_id>${String(id)}</comment_id>`
      + `<username>${username}</username><nickname>${nickname}</nickname>`
      + `<content></content><create_time>${String(ts)}</create_time><type>1</type>`
      + '</user_comment>'
  })
  const comments = (options.comments ?? []).map(([username, nickname, content]) => {
    const id = seq++
    return '<user_comment>'
      + `<comment_id>${String(id)}</comment_id>`
      + `<username>${username}</username><nickname>${nickname}</nickname>`
      + `<content>${content}</content><create_time>${String(ts)}</create_time><type>2</type>`
      + '</user_comment>'
  })
  const location = options.withGeo
    // 朋友圈 XML 的 latitude/longitude 属性与本意相反（见 moments-insights.computeGeo）。
    ? '<location city="杭州" country="中国" poiName="西湖" longitude="30.2" latitude="120.1"/>'
    : ''
  return `<contentDesc>${text}</contentDesc><createTime>${String(ts)}</createTime>${location}`
    + `<LocalExtraInfo><comment_user_list>${likes.join('')}${comments.join('')}</comment_user_list></LocalExtraInfo>`
}

function makeTimeline(root: string, posts: Array<{ tid: number; username: string; xml: string }>): void {
  makeDb(join(root, 'sns', 'db_sns', 'sns.db'), (db) => {
    db.exec('CREATE TABLE SnsTimeLine (tid INTEGER, user_name TEXT, content TEXT)')
    const insert = db.prepare('INSERT INTO SnsTimeLine (tid, user_name, content) VALUES (?, ?, ?)')
    db.exec('BEGIN')
    try {
      for (const post of posts) insert.run(post.tid, post.username, post.xml)
      db.exec('COMMIT')
    } catch (e) {
      db.exec('ROLLBACK')
      throw e
    }
  })
}

function fixture(root: string): void {
  makeContacts(root)
  makeTimeline(root, [
    {
      tid: 101,
      username: 'wxid_a',
      xml: postXml(epoch(2025, 3, 5), '三月第一帖', {
        likes: [['wxid_like', '王五']],
        comments: [['wxid_cmt', '赵六', '好']],
        withGeo: true,
      }),
    },
    {
      tid: 102,
      username: 'wxid_a',
      xml: postXml(epoch(2025, 3, 20), '三月第二帖', {
        likes: [['wxid_like', '王五']],
      }),
    },
    {
      tid: 103,
      username: 'wxid_b',
      xml: postXml(epoch(2025, 4, 10), '四月帖', {
        likes: [['wxid_like', '王五']],
        comments: [['wxid_cmt', '赵六', '不错'], ['wxid_like', '王五', '赞']],
      }),
    },
  ])
}

describe('get_moments_stats', () => {
  it('全量统计：发布/获赞/评论、TOP 与月度峰值', async () => {
    const { root, ctx } = makeRoot()
    fixture(root)

    const result = await getMomentsStatsTool.run({}, ctx)
    expect(result.ok).toBe(true)
    expect(result.facts?.[0]?.title).toBe('朋友圈（全量）')
    const body = result.facts?.[0]?.body ?? ''
    expect(body).toContain('发布 3 条，获赞 3，评论 3')
    expect(body).toContain('点赞 TOP 王五 3')
    expect(body).toContain('评论 TOP 赵六 2')
    expect(body).toContain('月度峰值 3 月 2 条')

    expect(result.hits).toHaveLength(3)
    expect(result.hits[0]?.key).toBe('moment:wxid_b:103')
    expect(result.hits[0]?.source).toBe('resource')
    expect(result.hits[0]?.trace?.kind).toBe('resource')
    expect(result.hits[0]?.trace?.resource?.resourceKind).toBe('moment')
    expect(result.hits[0]?.trace?.resource?.timelineId).toBe('103')
  })

  it('微信问答锁定群会话时按全库统计，不把会话 scope 当作者', async () => {
    const { root } = makeRoot()
    fixture(root)

    // 走完整执行守卫（wechat-ask + 群会话锁定）：会话 scope 必须被剥离，
    // 否则「朋友圈统计」会把群 id 当作者，返回一个假的 0 条。
    const result = await runProfileTool(
      'wechat-ask',
      [getMomentsStatsTool],
      'get_moments_stats',
      {},
      { decryptedDir: root, scope: { username: '123@chatroom' } },
    )
    expect(result.ok, result.error ?? '').toBe(true)
    expect(result.facts?.[0]?.title).toBe('朋友圈（全量）')
    expect(result.facts?.[0]?.body).toContain('发布 3 条')
    expect(result.hits).toHaveLength(3)
  })

  it('显式 author 优先于会话 scope；会话内问答仍可把 scope 当作者', async () => {
    const { root } = makeRoot()
    fixture(root)

    // 显式作者：即使 scope 指向另一个会话，也按作者筛选。
    const explicit = await getMomentsStatsTool.run(
      { author: '张三' },
      { decryptedDir: root, scope: { username: 'wxid_b' } },
    )
    expect(explicit.ok).toBe(true)
    expect(explicit.facts?.[0]?.title).toContain('作者 张三')
    expect(explicit.facts?.[0]?.body).toContain('发布 2 条')

    // 会话内问答的 scope.username 代表作者（该工具目前不在会话白名单，
    // 但工具层语义要保留：没有显式 author 时才使用 scope）。
    const inherited = await getMomentsStatsTool.run(
      {},
      { decryptedDir: root, scope: { username: 'wxid_b' } },
    )
    expect(inherited.ok).toBe(true)
    expect(inherited.facts?.[0]?.body).toContain('发布 1 条')
  })

  it('作者显示名解析成 username，并只统计该作者', async () => {
    const { root, ctx } = makeRoot()
    fixture(root)

    const result = await getMomentsStatsTool.run({ author: '张三' }, ctx)
    expect(result.ok).toBe(true)
    expect(result.facts?.[0]?.title).toContain('作者 张三')
    expect(result.facts?.[0]?.body).toContain('发布 2 条，获赞 2，评论 1')
    expect(result.hits).toHaveLength(2)
    expect(result.hits.every(hit => hit.trace?.resource?.username === 'wxid_a')).toBe(true)
  })

  it('区间统计按时间过滤（洞察接口不支持日期时走分页扫描）', async () => {
    const { root, ctx } = makeRoot()
    fixture(root)

    const result = await getMomentsStatsTool.run({ from: '2025-03-01', to: '2025-03-31' }, ctx)
    expect(result.ok).toBe(true)
    expect(result.facts?.[0]?.title).toBe('朋友圈（区间）')
    const body = result.facts?.[0]?.body ?? ''
    expect(body).toContain('发布 2 条，获赞 2，评论 1')
    expect(body).toContain('月度峰值 3 月 2 条')
    expect(result.hits).toHaveLength(2)
    expect(result.hits[0]?.key).toBe('moment:wxid_a:102')
    expect(result.note).toContain('扫描')
  })

  it('完整自然年用年度口径补强发布数与峰值', async () => {
    const { root, ctx } = makeRoot()
    fixture(root)

    const result = await getMomentsStatsTool.run({ from: '2025-01-01', to: '2025-12-31' }, ctx)
    expect(result.ok).toBe(true)
    expect(result.facts?.[0]?.title).toBe('朋友圈（2025 年）')
    expect(result.facts?.[0]?.body).toContain('发布 3 条')
    expect(result.facts?.[0]?.body).toContain('月度峰值 3 月 2 条')
    expect(result.note).toContain('年度统计')
  })

  it('includeGeo 附带定位统计', async () => {
    const { root, ctx } = makeRoot()
    fixture(root)

    const result = await getMomentsStatsTool.run({ includeGeo: true }, ctx)
    expect(result.ok).toBe(true)
    expect(result.facts?.[0]?.body).toContain('定位打卡 1 个点')
    expect(result.facts?.[0]?.body).toContain('城市 TOP 杭州 1')
  })

  it('top 控制排行榜条数，非法值回退/钳制', async () => {
    const { root, ctx } = makeRoot()
    fixture(root)

    const topOne = await getMomentsStatsTool.run({ top: 1 }, ctx)
    expect(topOne.facts?.[0]?.body).toContain('点赞 TOP 王五 3；评论 TOP 赵六 2')

    const fallback = await getMomentsStatsTool.run({ top: 'abc' }, ctx)
    expect(fallback.ok).toBe(true)

    const clamped = await getMomentsStatsTool.run({ top: 999 }, ctx)
    expect(clamped.ok).toBe(true)
  })

  it('没有 sns.db 时返回 not_configured，而不是 0 条', async () => {
    const { ctx } = makeRoot()
    const result = await getMomentsStatsTool.run({}, ctx)
    expect(result.ok).toBe(false)
    expect(result.errorCode).toBe('not_configured')
    expect(result.error).toContain('朋友圈库不存在（可能未解密）')
    expect(result.hits).toEqual([])
  })

  it('库存在但时间线为空时返回空结果', async () => {
    const { root, ctx } = makeRoot()
    makeTimeline(root, [])
    const result = await getMomentsStatsTool.run({}, ctx)
    expect(result.ok).toBe(true)
    expect(result.hits).toEqual([])
    expect(result.facts).toEqual([])
    expect(result.note).toContain('暂无')
  })

  it('取消信号触发后只统计已扫描部分并标记截断', async () => {
    const { root, ctx } = makeRoot()
    makeContacts(root)
    const posts: Array<{ tid: number; username: string; xml: string }> = []
    for (let i = 1; i <= 501; i += 1) {
      posts.push({
        tid: i,
        username: 'wxid_a',
        xml: postXml(epoch(2025, 6, 1) + i, `动态 ${String(i)}`),
      })
    }
    makeTimeline(root, posts)

    const controller = new AbortController()
    setImmediate(() => controller.abort())
    // 用非完整年份区间，避免落到年度全量口径。
    const result = await getMomentsStatsTool.run(
      { from: '2025-01-01', to: '2025-12-30' },
      { decryptedDir: root, signal: controller.signal },
    )
    expect(result.ok).toBe(true)
    expect(result.facts?.[0]?.title).toBe('朋友圈（区间）')
    expect(result.facts?.[0]?.body).toContain('发布 500 条')
    expect(result.note).toContain('已截断（已取消）')
  })
})
