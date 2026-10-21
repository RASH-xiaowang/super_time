import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { createWechatBackend } = require('../src/backend/wechat-host')

const backend = await createWechatBackend({ userDataPath: 'C:/Users/Administrator/AppData/Roaming/super-time-electron' })
try {
  const result = await backend.call('getFavorites', [{ limit: 120, offset: 0 }])
  const rows = result.value?.favorites ?? []
  const targets = rows.filter((favorite) => [2, 3, 4, 8, 14, 19, 6].includes(favorite.type))
  const counts = new Map()
  for (const favorite of targets) {
    for (const part of favorite.items ?? []) {
      if (!part.md5 && !part.fullMd5 && !part.thumbMd5) continue
      const kind = part.kind === 'voice' ? 'audio'
        : part.kind === 'video' ? 'video'
          : part.kind === 'file' ? 'file'
            : part.kind === 'image' ? 'image'
              : 'unknown'
      const params = {
        ...(part.fullMd5 ? { fullMd5: part.fullMd5 } : {}),
        ...(part.thumbMd5 ? { thumbMd5: part.thumbMd5 } : {}),
        ...(part.md5 ? { md5: part.md5 } : {}),
        kind,
        ...(part.ext ? { ext: part.ext } : {}),
      }
      const media = await backend.call('getFavoriteMediaDataUrl', [params])
      const ok = media.ok && typeof media.value?.url === 'string'
      counts.set(part.kind, (counts.get(part.kind) ?? 0) + (ok ? 1 : 0))
      console.log(JSON.stringify({
        id: favorite.localId,
        type: favorite.type,
        kind: part.kind,
        md5: part.fullMd5 ?? part.md5,
        ok,
        format: media.value?.format,
        bytes: media.value?.url?.length,
        error: media.error?.message ?? media.value?.error,
      }))
    }
  }
  console.log('hit-counts', Object.fromEntries(counts))
} finally {
  backend.dispose()
  setTimeout(() => process.exit(0), 50)
}
