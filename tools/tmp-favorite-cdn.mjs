import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const dbPath = 'C:/Users/Administrator/AppData/Roaming/super-time-electron/wechat-data/decrypted/favorite/favorite.db'
const favoriteRoot = 'D:/Tencent/Documents/xwechat_files/wxid_umyqa86if3lm22_f312/business/favorite'

function tagText(xml, tag) {
  const start = xml.indexOf(`<${tag}>`)
  if (start < 0) return ''
  const contentStart = start + tag.length + 2
  const end = xml.indexOf(`</${tag}>`, contentStart)
  if (end < 0) return ''
  return xml.slice(contentStart, end).trim()
}

function dataItems(xml) {
  const out = []
  let pos = 0
  for (;;) {
    const start = xml.indexOf('<dataitem', pos)
    if (start < 0) break
    const end = xml.indexOf('</dataitem>', start)
    const body = end < 0 ? xml.slice(start) : xml.slice(start, end)
    out.push({
      head: body.slice(0, body.indexOf('>') + 1),
      fullMd5: tagText(body, 'fullmd5'),
      thumbMd5: tagText(body, 'thumbfullmd5'),
      datafmt: tagText(body, 'datafmt'),
      fullsize: tagText(body, 'fullsize'),
      sourceDataPath: tagText(body, 'sourcedatapath'),
      cdnDataUrl: tagText(body, 'cdn_dataurl'),
      cdnDataKey: tagText(body, 'cdn_datakey'),
      cdnThumbUrl: tagText(body, 'cdn_thumburl'),
      cdnThumbKey: tagText(body, 'cdn_thumbkey'),
      cdnEncryVer: tagText(body, 'cdn_encryver'),
      fromNewMsgId: tagText(body, 'fromnewmsgid'),
      sourceId: tagText(body, 'sourceid'),
      dataTitle: tagText(body, 'datatitle'),
      dataDesc: tagText(body, 'datadesc'),
    })
    pos = end < 0 ? xml.length : end + 10
  }
  return out
}

const db = new DatabaseSync(dbPath, { readOnly: true })
try {
  console.log('TABLES')
  for (const row of db.prepare("SELECT name, sql FROM sqlite_master WHERE type='table' ORDER BY name").all()) {
    console.log(row.name, row.sql)
  }
  console.log('\nROWS')
  const rows = db.prepare('SELECT local_id,type,update_time,fromusr,realchatname,content FROM fav_db_item ORDER BY local_id DESC').all()
  for (const row of rows) {
    if (![2, 3, 4, 8, 19].includes(row.type)) continue
    const items = dataItems(row.content ?? '')
    console.log(JSON.stringify({
      id: row.local_id,
      type: row.type,
      fromUsr: row.fromusr,
      chatName: row.realchatname,
      items,
    }, null, 2))
  }
} finally {
  db.close()
}

console.log('\nFAVORITE FILES')
for (const bucket of ['data', 'mid', 'thumb', 'temp']) {
  const root = join(favoriteRoot, bucket)
  if (!existsSync(root)) continue
  const descendants = readdirSync(root)
  console.log(bucket, 'children', descendants.length)
  let shown = 0
  const walk = (dir, depth) => {
    if (depth > 3 || shown >= 80) return
    for (const name of readdirSync(dir)) {
      const path = join(dir, name)
      const stat = statSync(path)
      if (stat.isDirectory()) {
        console.log(bucket, 'dir', path.slice(root.length + 1), 'children', readdirSync(path).length)
        walk(path, depth + 1)
      } else if (shown < 80) {
        console.log(bucket, 'file', path.slice(root.length + 1), stat.size)
        shown += 1
      }
    }
  }
  walk(root, 0)
}
