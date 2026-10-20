/**
 * 「第三方原图服务」的守卫：把 2026-10-17 实测出来的协议细节与边界钉死。
 *
 * ## 为什么需要这组守卫
 *
 * 这条通路是本机数据上**唯一能覆盖那 81.6%** 的（`cdnbigimgurl` 占 81.6%，
 * 此前被判定为「需要登录态，不做」）。实测确认它可行：6/6 成功，拿到 2,751 KB 的真原图。
 * 但它有三个容易踩错的点，每个都值得一条断言：
 *
 * | 坑 | 后果 |
 * |---|---|
 * | 不带 `key=` 参数 | 返回 AES 密文，本地解不出（实测头 `c502e100…`） |
 * | `weixinIDFolder` 传裸 wxid | 服务端回 `400 invalid_config`（要完整目录名） |
 * | 默认开启 | 用户数据被发给非腾讯官方服务，且按流量计费 |
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const HERE = import.meta.dirname
const SRC = readFileSync(join(HERE, '..', 'src', 'query', 'wxcdn-original.ts'), 'utf8')
const AUTO = readFileSync(join(HERE, '..', 'src', 'query', 'image-auto-upgrade.ts'), 'utf8')

/** 剥掉注释再断言：注释里写着历史成因与被否掉的旧值，直接搜会误判。 */
function stripComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

const CODE = stripComments(SRC)
const AUTO_CODE = stripComments(AUTO)

describe('第三方原图服务：协议细节', () => {
  it('① 下载必须带 `key=` 参数（不带返回 AES 密文，本地解不出）', () => {
    // 实测：不带 key 时返回 3,502,640 字节的密文（头 c502e100…），
    // 用 aeskey 按 hex 解码后 AES-128-ECB 解也解不出（头 04693b23…）。
    expect(CODE, '必须设置 key 参数').toContain("url.searchParams.set('key', key)")
  })

  it('② `weixinIDFolder` 用完整目录名，不是裸 wxid', () => {
    // 实测：传裸 wxid 回 400 invalid_config，传 `wxid_xxx_<hash>` 才 200。
    expect(CODE, '要从路径取最后一段').toContain('parts[parts.length - 1]')
    expect(CODE, '要 append 到 weixinIDFolder').toContain("form.append('weixinIDFolder', folder)")
  })

  it('③ 配置文件路径是 `<rawRoot>/../all_users/config`', () => {
    expect(CODE).toContain("join(rawRoot, '..', 'all_users', 'config')")
    expect(CODE).toContain("'global_config'")
    expect(CODE).toContain("'global_config.crc'")
  })

  it('④ token 要缓存（服务端按 IP 限频 10 秒 3 次）', () => {
    expect(CODE, '要有 token 缓存').toContain('tokenCache')
    expect(CODE, '要提前 5 分钟视为过期').toContain('5 * 60 * 1000')
  })

  it('⑤ 404 要如实说「fileid 已过期」（实测同一条消息隔一段时间就 404）', () => {
    expect(CODE).toContain('这条原图已过期')
  })

  it('⑥ 额度不足要提前拦下（按流量计费，Free 50 MB/天）', () => {
    expect(CODE).toContain('今日原图额度已用完')
  })
})

describe('第三方原图服务：默认关闭', () => {
  it('⑦ 开关默认 false（用户数据要发给非腾讯官方服务）', () => {
    const cfg = readFileSync(join(HERE, '..', 'src', 'config', 'wechat-config.ts'), 'utf8')
    expect(cfg, 'defaultConfig 里 wxcdn_original_enabled 必须是 false').toContain('wxcdn_original_enabled: false')
  })

  it('⑧ 自动升级里必须检查开关才走这条路', () => {
    expect(AUTO_CODE, '要检查 isWxcdnEnabled').toContain('isWxcdnEnabled(decryptedDir)')
  })

  it('⑨ 只在「本机重解」和「CDN 直链」都失败后才走第三方', () => {
    // 顺序：本机重解（免费）→ CDN 直链（免费）→ 第三方（计费）。
    // 注意：`tryWxcdnUpgrade` 的**定义**在文件前面，所以搜调用点（带 `await`）而不是函数名。
    const localAt = AUTO_CODE.indexOf('clearDecodedImageCache(')
    const cdnAt = AUTO_CODE.indexOf('resolveImageOriginalLink(')
    const wxAt = AUTO_CODE.indexOf('await tryWxcdnUpgrade(')
    expect(localAt).toBeGreaterThan(-1)
    expect(cdnAt).toBeGreaterThan(-1)
    expect(wxAt).toBeGreaterThan(-1)
    expect(localAt, '本机重解必须最先').toBeLessThan(cdnAt)
    expect(cdnAt, '第三方必须最后（它计费）').toBeLessThan(wxAt)
  })
})
