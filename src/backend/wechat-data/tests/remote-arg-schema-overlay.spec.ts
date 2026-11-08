/**
 * Source-side schemas for Remotes missing from the generated invocation table.
 *
 * Import the overlay directly so this test does not depend on a stale
 * `lib/typert.host.js` build.
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import { REMOTE_ARG_SCHEMA_OVERLAY } from '../src/remote-arg-schema-overlay.ts'

interface SchemaLike {
  safeParse: (value: unknown) => { success: boolean }
}

const EXPORT_METHODS = [
  'exportSnsVideo', 'exportSnsImage', 'exportChatImage', 'exportChatVideo', 'exportChatFile',
  'exportFileImage', 'exportFileVideo', 'exportFileAttachment',
  'exportFavoriteImage', 'exportFavoriteVideo', 'exportFavoriteFile',
] as const

const VALID_ARGS: Record<(typeof EXPORT_METHODS)[number], Record<string, unknown>> = {
  exportSnsVideo: { md5: 'a'.repeat(32), key: 'seed', dest: 'saved.mp4' },
  exportSnsImage: { md5: 'a'.repeat(32), token: 'token', seed: 'seed', dest: 'saved.jpg' },
  exportChatImage: { username: 'wxid_chat', localId: 1, dest: 'saved.jpg' },
  exportChatVideo: { username: 'wxid_chat', localId: 2, dest: 'saved.mp4' },
  exportChatFile: { username: 'wxid_chat', localId: 3, dest: 'saved.pdf' },
  exportFileImage: { md5: 'b'.repeat(32), dest: 'saved.png' },
  exportFileVideo: { md5: 'c'.repeat(32), dest: 'saved.mov' },
  exportFileAttachment: { fileName: 'report.pdf', size: 1024, md5: 'd'.repeat(32), dest: 'report.pdf' },
  exportFavoriteImage: { fullMd5: 'e'.repeat(32), kind: 'image', dest: 'favorite.png' },
  exportFavoriteVideo: { fullMd5: 'f'.repeat(32), kind: 'video', dest: 'favorite.mp4' },
  exportFavoriteFile: { fullMd5: '1'.repeat(32), kind: 'file', dest: 'favorite.pdf' },
}

describe('Remote argument schema overlay: original exports', () => {
  const byMethod = new Map(REMOTE_ARG_SCHEMA_OVERLAY.map((entry) => [entry.method, entry]))

  it('registers each single-resource export with exactly one options schema', () => {
    for (const method of EXPORT_METHODS) {
      const entry = byMethod.get(method)
      expect(entry, `${method} 不在 overlay`).toBeDefined()
      expect(entry?.parameters, `${method} 应当只有一个 options 参数`).toHaveLength(1)
    }
  })

  it('accepts valid options and rejects a missing destination', () => {
    for (const method of EXPORT_METHODS) {
      const schema = byMethod.get(method)?.parameters[0]?.codec.schema as SchemaLike
      expect(schema.safeParse(VALID_ARGS[method]).success, `${method} 拒绝了合法参数`).toBe(true)
      const invalidArgs = Object.fromEntries(
        Object.entries(VALID_ARGS[method]).filter(([key]) => key !== 'dest'),
      )
      expect(schema.safeParse(invalidArgs).success, `${method} 错误接受了缺少 dest 的参数`).toBe(false)
    }
  })
})
