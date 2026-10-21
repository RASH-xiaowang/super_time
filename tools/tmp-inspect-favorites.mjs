import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const dbPath = 'C:/Users/Administrator/AppData/Roaming/super-time-electron/wechat-data/decrypted/favorite/favorite.db'
const favoriteRoot = 'D:/Tencent/Documents/xwechat_files/wxid_umyqa86if3lm22_f312/business/favorite'

const md5 = (bytes) => createHash('md5').update(bytes).digest('hex')
const hex = (bytes) => Buffer.from(bytes).toString('hex')

function tagOf(buf, offset) {
  return {
    offset,
    head: hex(buf.subarray(offset, Math.min(offset + 40, buf.length))),
    ascii: buf.subarray(offset, Math.min(offset + 120, buf.length)).toString('latin1').replace(/[^\x20-\x7e]/g, '.'),
  }
}

function inspect(path) {
  const buf = readFileSync(path)
  console.log('\n===', path)
  console.log('size', buf.length, 'md5', md5(buf), 'head', hex(buf.subarray(0, 64)))
  for (const signature of ['ffd8ffe0', 'ffd8ffe1', '89504e470d0a1a0a', '0000001c66747970', '25504446']) {
    const at = hex(buf).indexOf(signature)
    console.log('sig', signature, at === -1 ? 'none' : at / 2)
  }
  const targets = ['2657e57c91df0e5ba37abe6e5bea3b58', '0a4a21c1436a465f13a4854b20cecb7c']
  for (let offset = 0; offset <= Math.min(80, buf.length); offset++) {
    const digest = md5(buf.subarray(offset))
    if (targets.includes(digest)) console.log('TARGET HASH at offset', offset, digest)
  }
  for (const target of targets) {
    const at = hex(buf).indexOf(target)
    if (at !== -1) console.log('TARGET HEX at', at / 2, target)
  }
}

if (existsSync(dbPath)) {
  const db = new DatabaseSync(dbPath, { readOnly: true })
  const cols = db.prepare('PRAGMA table_info(fav_db_item)').all()
  console.log('columns', cols.map((c) => c.name).join(','))
  const row = db.prepare('SELECT local_id,type,update_time,fromusr,realchatname,content FROM fav_db_item WHERE local_id = ?').get(68)
  console.log('row68', JSON.stringify(row, null, 2))
  db.close()
}

for (const dir of ['data', 'mid', 'thumb']) {
  const root = join(favoriteRoot, dir)
  if (!existsSync(root)) continue
  for (const bucket of readdirSync(root)) {
    const bucketPath = join(root, bucket)
    if (!statSync(bucketPath).isDirectory()) continue
    for (const name of readdirSync(bucketPath)) {
      const path = join(bucketPath, name)
      const size = statSync(path).size
      if (dir !== 'data' || [732055, 732086, 16969].includes(size)) inspect(path)
    }
  }
}
