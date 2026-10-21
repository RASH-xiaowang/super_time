import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const dbPath = 'C:/Users/Administrator/AppData/Roaming/super-time-electron/wechat-data/decrypted/favorite/favorite.db'
const accountRoot = 'D:/Tencent/Documents/xwechat_files/wxid_umyqa86if3lm22_f312'

function tagText(xml, tag) {
  const start = xml.indexOf(`<${tag}>`)
  if (start < 0) return ''
  const contentStart = start + tag.length + 2
  const end = xml.indexOf(`</${tag}>`, contentStart)
  return end < 0 ? '' : xml.slice(contentStart, end).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim()
}

function dataItems(xml) {
  const out = []
  let pos = 0
  for (;;) {
    const start = xml.indexOf('<dataitem', pos)
    if (start < 0) break
    const end = xml.indexOf('</dataitem>', start)
    const body = end < 0 ? xml.slice(start) : xml.slice(start, end)
    const open = body.slice(0, body.indexOf('>') + 1)
    out.push({
      dataType: Number((/datatype="(\d+)"/.exec(open) ?? [])[1] ?? 0),
      dataId: (/dataid="([^"]+)"/.exec(open) ?? [])[1] ?? '',
      title: tagText(body, 'datatitle'),
      desc: tagText(body, 'datadesc'),
      format: tagText(body, 'datafmt').toLowerCase(),
      size: Number(tagText(body, 'fullsize') || 0),
      fullMd5: (tagText(body, 'fullmd5') || (/dataid="([^"]+)"/.exec(open) ?? [])[1] || '').toLowerCase(),
      thumbMd5: tagText(body, 'thumbfullmd5').toLowerCase(),
      sourceDataPath: tagText(body, 'sourcedatapath'),
      cdnDataUrl: tagText(body, 'cdn_dataurl'),
      cdnDataKey: tagText(body, 'cdn_datakey'),
      cdnThumbUrl: tagText(body, 'cdn_thumburl'),
      cdnThumbKey: tagText(body, 'cdn_thumbkey'),
      cdnEncryVer: tagText(body, 'cdn_encryver'),
      sourceId: tagText(body, 'sourceid'),
      fromNewMsgId: tagText(body, 'fromnewmsgid'),
    })
    pos = end < 0 ? xml.length : end + 10
  }
  return out
}

function walkFiles(root) {
  const out = []
  const walk = (dir) => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.isFile()) {
        try {
          const stat = statSync(path)
          out.push({ path, name: basename(path), size: stat.size, mtime: stat.mtimeMs })
        } catch {}
      }
    }
  }
  walk(root)
  return out
}

const db = new DatabaseSync(dbPath, { readOnly: true })
const rows = db.prepare('SELECT local_id,type,update_time,fromusr,realchatname,content FROM fav_db_item ORDER BY local_id DESC').all()
db.close()

const msgFiles = walkFiles(join(accountRoot, 'msg', 'file'))
const byName = new Map()
for (const file of msgFiles) {
  const key = file.name.toLowerCase()
  const list = byName.get(key) ?? []
  list.push(file)
  byName.set(key, list)
}

console.log('msg/file count', msgFiles.length)
for (const row of rows) {
  const items = dataItems(row.content ?? '')
  for (const [index, item] of items.entries()) {
    if (item.dataType !== 8) continue
    const name = item.title || item.desc
    const hits = byName.get(name.toLowerCase()) ?? []
    const exact = item.size > 0 ? hits.filter((hit) => hit.size === item.size) : []
    const sha = exact[0]
      ? createHash('md5').update(readFileSync(exact[0].path)).digest('hex')
      : undefined
    console.log(JSON.stringify({
      id: row.local_id,
      index,
      name,
      format: item.format,
      size: item.size,
      fullMd5: item.fullMd5,
      hits: hits.length,
      exact: exact.map((hit) => hit.path),
      hash: sha,
    }))
  }
}
