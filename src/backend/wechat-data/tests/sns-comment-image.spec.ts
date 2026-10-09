/**
 * 朋友圈**评论图**（`<imageinfo>`）的解析与接线（2026-10-09）。
 *
 * ## 要钉住的是什么
 *
 * 现场实测（探针 `sns-comment-image-probe.manual.spec.ts`，真库真网）：
 *
 *   · 评论图的裸 `<url>`（不带 `token`/`idx=1`）**5/5 HTTP 400、0 字节**；
 *   · 经 `snsCdnUrl` 补上 `?token=…&idx=1` 后 **5/5 HTTP 200**（`x-enc=1`，密文）；
 *   · 解密后 EOI 距末尾 **24 字节**（与朋友圈图片同形 ⇒ 现有裁尾块逻辑已覆盖）。
 *
 * 而解析器原来只取 `url`/`thumb_url`/`md5`/`media_id`，**唯独没取 `token` 与 `key`** ——
 * 渲染层拿裸地址去要图必然落空（本机又没有评论图文件，实测 md5 0 命中 ⇒ 只能显示 [图]）。
 * 这几条把「解析出来的 token 真能拼出 200 那种地址」钉住，而不是只断言「字段存在」。
 *
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import { parseSnsLikesComments } from '../src/query/moments.ts'
import { snsCdnUrl } from '../src/query/sns-cdn-url.ts'

/** 一条带图评论的完整 XML（字段与顺序照真库 2026-10-09 实测的形状）。 */
const commentXml = (imageinfo: string): string => `<SnsTimeLine><Content><![CDATA[
<SnsXml><![CDATA[<LocalExtraInfo>
<comment_user_list>
<user_comment>
<comment_id>1001</comment_id>
<username>wxid_aaa</username>
<nickname>甲</nickname>
<content>好看</content>
<create_time>1757000000</create_time>
<ref_comment_id>0</ref_comment_id>
<type>2</type>
${imageinfo}
</user_comment>
</comment_user_list>
</LocalExtraInfo>]]></SnsXml>
]]></Content></SnsTimeLine>`

const FULL_IMAGEINFO = `<imageinfo>
<url>http://shmmsns.qpic.cn/mmcomment/R13K8mNPAooU4icA1dQAEw3FVuAEHTh/0</url>
<token>r3MUdKBTQtok&amp;BVGyMoJg7qz1zGmgBLI6WBZBuciaIUAlJfSAiasWdXCPIibfk</token>
<key>7823697104014778623</key>
<enc_idx>1</enc_idx>
<thumb_url>http://shmmsns.qpic.cn/mmcomment/R13K8mNPAooU4icA1dQAEw3FVuAEHTh/60</thumb_url>
<thumb_url_token>r3MUdKBTQtok&amp;BVGyMoJg7qz1zGmgBLI6WBZBuciaIUAlJfDj8UUJrk</thumb_url_token>
<thumb_key>7823697104014778623</thumb_key>
<thumb_enc_idx>1</thumb_enc_idx>
<width>2560</width>
<height>1920</height>
<file_size>217889</file_size>
<media_id>14988773592003588802</media_id>
<md5>c9c95e39e23e3d90179b55ca52577e36</md5>
</imageinfo>`

const onlyImage = (xml: string): { url?: string; thumb?: string; md5?: string; mediaId?: string; token?: string; seed?: string } | undefined =>
  parseSnsLikesComments(xml).comments[0]?.image

describe('评论图 <imageinfo> 解析', () => {
  it('解析出 token 与 key（缺了就取不到图：实测裸地址 5/5 返 400）', () => {
    const img = onlyImage(commentXml(FULL_IMAGEINFO))
    expect(img?.url).toBe('http://shmmsns.qpic.cn/mmcomment/R13K8mNPAooU4icA1dQAEw3FVuAEHTh/0')
    expect(img?.token).toBe('r3MUdKBTQtok&BVGyMoJg7qz1zGmgBLI6WBZBuciaIUAlJfSAiasWdXCPIibfk')
    expect(img?.seed).toBe('7823697104014778623')
  })

  it('token 里的 &amp; 要反转义成 &（不解压就会把参数名发错，CDN 返 400）', () => {
    const img = onlyImage(commentXml(FULL_IMAGEINFO))
    // 真实 token 里没有 &，但库里的查询串一律写成实体；这里用合成 token 盯住这条规则。
    expect(img?.token).not.toContain('&amp;')
    expect(img?.token).toContain('&')
  })

  it('<thumb_url> / <thumb_url_token> 不会被误当成 <url> / <token>', () => {
    const img = onlyImage(commentXml(FULL_IMAGEINFO))
    // 两个地址的尺寸段不同（/0 与 /60），取错就是取到了缩略图那条。
    expect(img?.url).toContain('/0')
    expect(img?.url).not.toContain('/60')
    expect(img?.thumb).toContain('/60')
  })

  it('解析出的 token 能拼出实测那种 200 地址（?token=…&idx=1 + https）', () => {
    const img = onlyImage(commentXml(FULL_IMAGEINFO))
    const built = snsCdnUrl(img?.url ?? '', img?.token)
    expect(built.startsWith('https://')).toBe(true)
    expect(built).toContain('?token=')
    expect(built).toContain('&idx=1')
  })

  it('没有 token 时拼出的地址缺 token ⇒ 后端拿不到图（所以字段必须补齐，不是可选）', () => {
    const img = onlyImage(commentXml(`<imageinfo>
<url>http://shmmsns.qpic.cn/mmcomment/XXX/0</url>
<key>111</key>
<md5>abc</md5>
</imageinfo>`))
    expect(img?.token).toBeUndefined()
    expect(snsCdnUrl(img?.url ?? '', img?.token)).not.toContain('token=')
  })

  it('缺 key 时 seed 为空，且不会误取 <thumb_key>', () => {
    const img = onlyImage(commentXml(`<imageinfo>
<url>http://shmmsns.qpic.cn/mmcomment/XXX/0</url>
<token>T</token>
<thumb_key>999</thumb_key>
</imageinfo>`))
    expect(img?.seed).toBeUndefined()
  })

  it('没有 <imageinfo> 的评论就不带 image 键（渲染层据此显示 [图] 占位）', () => {
    const img = onlyImage(commentXml(''))
    expect(img).toBeUndefined()
  })
})
