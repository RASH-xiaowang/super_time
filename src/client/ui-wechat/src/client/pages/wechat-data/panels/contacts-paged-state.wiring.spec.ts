/**
 * Contacts 的浏览态与搜索态必须共用同一个 pager，不能再维护第二套
 * contacts/total/loading/error（两套状态会在隐藏、刷新与筛选切换时互相覆盖）。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const HERE = import.meta.dirname
const source = readFileSync(join(HERE, 'Contacts.tsx'), 'utf8')
const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
const panelStart = code.indexOf('export function ContactsPanel')
const panelEnd = code.indexOf('function CapNote', panelStart)
const panel = code.slice(panelStart, panelEnd)

describe('Contacts paged state 单一来源', () => {
  it('浏览与搜索都从 pager 读 items/total/loading/error', () => {
    expect(panelStart).toBeGreaterThan(-1)
    expect(panelEnd).toBeGreaterThan(panelStart)
    expect(panel).toContain('const pager = usePagedList<ContactRow>')
    expect(panel).toContain('const contacts = pager.items')
    expect(panel).toContain('const total = pager.total')
    expect(panel).toContain('const loading = pager.loading')
    expect(panel).toContain('const error = pager.error')
    expect(panel).toContain('pager.reset()')
  })

  it('ContactsPanel 内不再有镜像的第二份 paged state', () => {
    expect(panel).not.toMatch(/const \[contacts,\s*setContacts\]/)
    expect(panel).not.toMatch(/const \[total,\s*setTotal\]/)
    expect(panel).not.toMatch(/const \[loading,\s*setLoading\]/)
    expect(panel).not.toMatch(/const \[error,\s*setError\]/)
  })

  it('搜索只改变同一 pager 的页大小/上限，不再另发一条直取全量的取数链', () => {
    expect(panel.match(/apiGetContacts\(/g)).toHaveLength(1)
    expect(panel).toContain('pageSize: searching ? CONTACTS_SEARCH_PAGE_SIZE')
    expect(panel).toContain('maxItems: searching ? 0 : CONTACTS_MAX_ITEMS')
  })

  it('实时刷新只保留 usePagedList 内部订阅，隐藏时头像预热也停', () => {
    expect(panel).not.toContain('useWechatDataUpdated')
    expect(panel).toContain('useAvatarPrewarm(contacts, avatarCache, AVATAR_CACHE_MAX, active && !searching)')
  })
})
