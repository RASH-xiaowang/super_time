/**
 * XML 原语里的 CDATA（真窗口夹具逼出来的一条真缺陷）。
 *
 * 症状：朋友圈卡片与收藏卡片上显示的是 `<![CDATA[今天…]]]>` 这一整串，而不是正文。
 * 根因不是一个笔误，是**同一份原语被抄了三份**：共享的 `parse-xml.ts#xmlTagText` 一直有剥 CDATA，
 * 而 `moments.ts` / `favorites.ts` 各自留了一份本地副本 —— 那两份没有。
 * 微信的 SNS 与收藏 content 里正文/昵称/标题基本都是 CDATA 包的（与消息 XML 同一个生产者），
 * 所以这不是"理论上会错"，是"每条都错，只是没人把 CDATA 那串当回事"。
 *
 * 因此这里两样都要有：**行为判据**（喂真形状的数据，看回来的字段干净不干净）
 * 与**接线判据**（只要有人再抄一份本地 `xmlTagText` 而不剥 CDATA，就让门禁红）。
 * @vitest-environment node
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join, resolve, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parseSnsXml } from '../src/query/moments.ts'
import { queryFavorites } from '../src/query/favorites.ts'

/** 仓库根：tests → wechat-data → backend → src → 根（4 层）。 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')

describe('parseSnsXml 剥 CDATA', () => {
  it('正文、昵称、链接标题这些 CDATA 包着的字段回来的是内容本身', () => {
    const xml = '<msg><id><![CDATA[123_456]]></id><username><![CDATA[wxid_a]]></username>'
      + '<createTime>1700000000</createTime><contentDesc><![CDATA[今天 天气 & 心情]]></contentDesc>'
      + '<source><username><![CDATA[wxid_a]]></username><nickname><![CDATA[张三 & 李四]]></nickname></source></msg>'
    const r = parseSnsXml(xml)
    expect(r.text).toBe('今天 天气 & 心情')
    expect(r.nickname).toBe('张三 & 李四')
    expect(r.text).not.toContain('CDATA')
  })

  it('没有 CDATA 的字段原样取（不许把普通文本裁掉）', () => {
    const r = parseSnsXml('<msg><createTime>1700000000</createTime><contentDesc>普通正文</contentDesc></msg>')
    expect(r.text).toBe('普通正文')
  })

  it('CDATA 里带实体也照常还原（剥壳与转义是两步，缺一不可）', () => {
    expect(parseSnsXml('<msg><contentDesc><![CDATA[A &amp; B]]></contentDesc></msg>').text).toBe('A & B')
  })
})

describe('queryFavorites 剥 CDATA（整条链，含 SQLite）', () => {
  let dir = ''
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'st-fav-cdata-'))
    // 后端读的是 `<解密根>/favorite/favorite.db`（与 `queryFavorites` 的取径一致）
    mkdirSync(join(dir, 'favorite'), { recursive: true })
    const db = new DatabaseSync(join(dir, 'favorite', 'favorite.db'))
    db.exec('CREATE TABLE fav_db_item (local_id INTEGER, type INTEGER, update_time INTEGER, content TEXT)')
    db.prepare('INSERT INTO fav_db_item VALUES (?,?,?,?)').run(1, 5, 1700000000,
      '<favorite><type5><title><![CDATA[链接 & 标题]]></title><desc><![CDATA[一段 描述]]></desc><url><![CDATA[https://x/a?u=1&v=2]]></url></type5></favorite>')
    db.close()
  })
  afterAll(() => {
    for (let i = 0; i < 12 && readdirSync(dir); i += 1) {
      try { rmSync(dir, { recursive: true, force: true }); break } catch { /* 句柄还没放 */ }
    }
  })

  it('标题/描述/URL 都不带 CDATA 外壳', () => {
    const r = queryFavorites(dir)
    const first = r.favorites[0]
    expect(first?.title).toBe('链接 & 标题')
    expect(first?.desc).toBe('一段 描述')
    expect(first?.url).toBe('https://x/a?u=1&v=2')
    // `content` 是**原样保留**的 XML（详情抽屉要展示原文），所以只检查解析出来的那几格
    expect([first?.title, first?.desc, first?.url].join('|')).not.toContain('CDATA')
  })
})

describe('本地副本不许再漏 CDATA（接线判据）', () => {
  /** 手写源码里自己定义 `xmlTagText` 的文件（vendored 与生成物不算）。 */
  function localTagTextFiles(): string[] {
    const out: string[] = []
    const walk = (d: string): void => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        if (e.name === 'node_modules' || e.name === 'dist' || e.name === 'lib' || e.name.startsWith('.')) continue
        const p = join(d, e.name)
        if (e.isDirectory()) walk(p)
        else if (/\.(?:ts|tsx)$/.test(e.name) && !e.name.endsWith('.d.ts') && !/\.spec\./.test(e.name)) {
          if (/function xmlTagText\s*\(/.test(readFileSync(p, 'utf8'))) out.push(relative(ROOT, p).replace(/\\/g, '/'))
        }
      }
    }
    walk(join(ROOT, 'src/backend/wechat-data/src'))
    walk(join(ROOT, 'src/client/ui-wechat/src'))
    return out
  }

  const files = localTagTextFiles()

  it('哨兵：确实扫到了那几份本地副本（否则下面的判据是恒真）', () => {
    expect(files.length, '一份本地 xmlTagText 都没找到 ⇒ 扫描口径坏了').toBeGreaterThanOrEqual(2)
    expect(files.some((f) => f.endsWith('moments.ts')), 'moments.ts 的副本没进清单').toBe(true)
    expect(files.some((f) => f.endsWith('favorites.ts')), 'favorites.ts 的副本没进清单').toBe(true)
    expect(files.some((f) => f.endsWith('favorites-parse.ts')), '客户端兜底解析那份没进清单').toBe(true)
  })

  it('每一份本地 xmlTagText 都必须过 stripCdata', () => {
    const bad = files.filter((f) => {
      const text = readFileSync(join(ROOT, f), 'utf8')
      const body = /function xmlTagText\s*\([\s\S]*?\n}/.exec(text)?.[0] ?? ''
      return !/stripCdata|CDATA/.test(body)
    })
    expect(bad, `这些文件抄了一份不剥 CDATA 的 xmlTagText：\n  ${bad.join('\n  ')}`).toEqual([])
  })

  it('反例自证：不剥 CDATA 的那一份必须被同一段判据挑出来', () => {
    const broken = 'function xmlTagText(xml: string, tag: string): string | null {\n  return xml.slice(1, 2)\n}'
    const body = /function xmlTagText\s*\([\s\S]*?\n}/.exec(broken)?.[0] ?? ''
    expect(body.length, '前提：这段样例没被提取出来').toBeGreaterThan(0)
    expect(/stripCdata|CDATA/.test(body), '样例里居然有 CDATA 处理 ⇒ 反例无效').toBe(false)
    // 而修好的形状必须放过
    const good = 'function xmlTagText(xml: string, tag: string): string | null {\n  return stripCdata(xml.slice(1, 2))\n}'
    expect(/stripCdata|CDATA/.test(/function xmlTagText\s*\([\s\S]*?\n}/.exec(good)?.[0] ?? '')).toBe(true)
  })
})
