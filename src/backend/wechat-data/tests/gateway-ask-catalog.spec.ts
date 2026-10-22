// @vitest-environment node
/**
 * 问答目录缓存的失效口径。
 *
 * 目录读取失败必须降级为空目录而不是让提问失败；切换解密目录后必须重读，
 * 否则会把上一个账号的 username 映射带进新账号。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

const catalog = vi.hoisted(() => ({
  entityCalls: [] as string[],
  sessionCalls: [] as string[],
  entityFailure: false,
}))

vi.mock('../src/query/search.ts', () => ({
  knownEntityNames: (directory: string) => {
    catalog.entityCalls.push(directory)
    if (catalog.entityFailure) throw new Error('contact.db unavailable')
    return [`entity:${directory}`]
  },
  knownSessionCatalog: (directory: string) => {
    catalog.sessionCalls.push(directory)
    return [{ username: `wxid_${directory}`, name: `会话 ${directory}` }]
  },
}))

import { AskCatalogCache } from '../src/gateway-ask-catalog.ts'

afterEach(() => {
  catalog.entityCalls.length = 0
  catalog.sessionCalls.length = 0
  catalog.entityFailure = false
})

describe('AskCatalogCache', () => {
  it('同一目录只读一次，切换目录后重新读取', () => {
    let directory = 'account-a'
    const cache = new AskCatalogCache(() => directory)

    expect(cache.entitiesForCurrentDirectory()).toEqual(['entity:account-a'])
    expect(cache.sessionsForCurrentDirectory()).toEqual([
      { username: 'wxid_account-a', name: '会话 account-a' },
    ])
    expect(cache.entitiesForCurrentDirectory()).toEqual(['entity:account-a'])
    expect(catalog.entityCalls).toEqual(['account-a'])
    expect(catalog.sessionCalls).toEqual(['account-a'])

    directory = 'account-b'
    expect(cache.sessionsForCurrentDirectory()).toEqual([
      { username: 'wxid_account-b', name: '会话 account-b' },
    ])
    expect(catalog.sessionCalls).toEqual(['account-a', 'account-b'])
  })

  it('目录损坏时缓存空结果，不把异常抛进问答主链路', () => {
    catalog.entityFailure = true
    const cache = new AskCatalogCache(() => 'broken')

    expect(cache.entitiesForCurrentDirectory()).toEqual([])
    expect(cache.entitiesForCurrentDirectory()).toEqual([])
    expect(catalog.entityCalls).toEqual(['broken'])
  })
})
