/**
 * Contact profile drawer wiring: keep the structured card layout instead of
 * regressing to the old single-column label/value rows.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const HERE = import.meta.dirname
const TSX = readFileSync(join(HERE, 'Contacts.tsx'), 'utf8')
const CSS = readFileSync(join(HERE, 'contacts.module.css'), 'utf8')

describe('contact profile drawer layout', () => {
  it('renders identity, facts, recent activity and common-group cards', () => {
    expect(TSX).toContain('className={css.profileHero}')
    expect(TSX).toContain('<ProfileSectionTitle>资料</ProfileSectionTitle>')
    expect(TSX).toContain('className={css.profileFacts}')
    expect(TSX).toContain('<ProfileSectionTitle')
    expect(TSX).toContain('>最近聊天</ProfileSectionTitle>')
    expect(TSX).toContain('>共同群聊</ProfileSectionTitle>')
    expect(TSX).toContain('profile360.commonGroups.map')
    expect(TSX).toContain('className={css.profileGroupCard}')
    expect(TSX).not.toContain('className={css.profileRow}')
  })

  it('uses a two-column facts grid that collapses on narrow sheets', () => {
    expect(CSS).toMatch(/\.profileFacts\s*\{[\s\S]*?grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/)
    expect(CSS).toMatch(/@media \(max-width: 430px\)\s*\{[\s\S]*?\.profileFacts,[\s\S]*?grid-template-columns:\s*minmax\(0,\s*1fr\)/)
    expect(CSS).toContain('.profileGroupCard')
  })
})
