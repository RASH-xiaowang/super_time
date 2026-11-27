// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readReplyToolsConfig, getConfig } from '../src/config/wechat-config.ts'
describe('server-only reply provider settings', () => {
  it('reads dedicated keys through existing Secrets without exposing them to config snapshots', () => {
    const root = mkdtempSync(join(tmpdir(), 'reply-tools-config-')); const decrypted = join(root, 'decrypted'); mkdirSync(decrypted)
    try {
      writeFileSync(join(root, 'config.json'), JSON.stringify({ reply_weather_provider: 'open-meteo', reply_weather_access: 'commercial', reply_search_provider: 'brave', reply_search_api_key: 'accidental-secret' }))
      writeFileSync(join(root, 'secrets.json'), JSON.stringify({ reply_weather_api_key: 'synthetic-weather', reply_search_api_key: 'synthetic-search', db_enc_key: 'synthetic-db-key' }))
      expect(readReplyToolsConfig(decrypted)).toMatchObject({ weatherProvider: 'open-meteo', weatherAccess: 'commercial', weatherApiKey: 'synthetic-weather', searchProvider: 'brave', searchApiKey: 'synthetic-search' })
      const snapshot = getConfig(decrypted)
      expect(snapshot).not.toHaveProperty('reply_search_api_key'); expect(snapshot).not.toHaveProperty('reply_weather_api_key')
      expect(JSON.stringify(snapshot)).not.toContain('synthetic-weather')
      expect(JSON.stringify(snapshot)).not.toContain('synthetic-search')
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})
