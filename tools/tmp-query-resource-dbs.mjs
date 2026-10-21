import { DatabaseSync } from 'node:sqlite'

const decrypted = 'C:/Users/Administrator/AppData/Roaming/super-time-electron/wechat-data/decrypted'
const dbPaths = [
  `${decrypted}/message/message_resource.db`,
  `${decrypted}/message/media_0.db`,
  `${decrypted}/hardlink/hardlink.db`,
  `${decrypted}/favorite/favorite_fts.db`,
]
const wanted = [
  '40d67076f7a5a586b138f1ca78a88869',
  '1b7a65cb6e6f7c1b3e21916be2c1c23a',
  'a6bcc54899af67bc819f2890a6d0246b',
  '6392866cb18b3a95d52833978aa533fa',
  '9d7df800-0b9f-4ba2-bd58-99f8dad36589',
  '20213366897',
]

for (const path of dbPaths) {
  console.log('\n=== DB', path)
  let db
  try {
    db = new DatabaseSync(path, { readOnly: true })
  } catch (error) {
    console.log('open failed', error.message)
    continue
  }
  try {
    const tables = db.prepare("SELECT name, sql FROM sqlite_master WHERE type='table' ORDER BY name").all()
    console.log('TABLES', tables.map((t) => t.name).join(', '))
    for (const table of tables) {
      const info = db.prepare(`PRAGMA table_info("${String(table.name).replace(/"/g, '""')}")`).all()
      const columns = info.map((c) => c.name)
      const textCols = columns.filter((c) => !/^\d+$/.test(String(c)))
      if (textCols.length === 0) continue
      let count = 0
      try {
        count = Number(db.prepare(`SELECT COUNT(*) AS n FROM "${String(table.name).replace(/"/g, '""')}"`).get()?.n ?? 0)
      } catch {}
      console.log('TABLE', table.name, 'rows', count, 'cols', columns.join(','))
      for (const needle of wanted) {
        for (const column of textCols) {
          const q = `SELECT * FROM "${String(table.name).replace(/"/g, '""')}" WHERE CAST("${String(column).replace(/"/g, '""')}" AS TEXT) LIKE ? LIMIT 5`
          let rows
          try {
            rows = db.prepare(q).all(`%${needle}%`)
          } catch {
            continue
          }
          if (rows.length === 0) continue
          console.log('HIT', needle, 'column', column)
          for (const row of rows) console.log(JSON.stringify(row))
        }
      }
    }
  } finally {
    db.close()
  }
}
