/**
 * WeChat message XML content parsing — rewritten from st_control
 * modules/messages/parse.rs + media/rich.rs. Produces the PC-style display
 * text and a rich media descriptor for the 16 message types.
 */
/**
 * Strip all XML tags from a string, collapsing whitespace.
 * Tags are removed without inserting a separator (mirrors st_control’s
 * strip_xml_tags) so system-message placeholders keep their original
 * spacing.
 * @param xml - raw XML string.
 * @returns the tag-stripped, whitespace-collapsed text.
 */
export function stripXmlTags(xml) {
    if (!xml)
        return '';
    return xml
        .replace(/<[^>]*>/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}
/**
 * Extract the text of the first occurrence of a tag.
 * Handles CDATA-wrapped content (<![CDATA[...]]>) which wechat appmsg uses
 * for title/des/thumburl — the plain text regex would stop at the first '<'.
 * @param xml - raw XML string.
 * @param tag - tag name to extract.
 * @returns the tag's inner text ('' when absent).
 */
export function xmlTagText(xml, tag) {
    const open = '<' + tag;
    const si = xml.indexOf(open);
    if (si < 0)
        return '';
    const gt = xml.indexOf('>', si);
    if (gt < 0)
        return '';
    const close = '</' + tag;
    const ei = xml.indexOf(close, gt);
    if (ei < 0)
        return '';
    return stripCdata(xml.slice(gt + 1, ei));
}
/** Unwrap a CDATA-wrapped string, returning the raw content. */
function stripCdata(value) {
    const t = value.trim();
    const m = t.match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/);
    return m ? (m[1] ?? '') : value;
}
/** Extract the value of an attribute from a tag. */
function xmlAttr(xml, tag, attr) {
    const m = xml.match(new RegExp(`<\\s*${tag}[^>]*\\b${attr}=\\s*["']([^"']*)["']`));
    return m ? m[1] ?? '' : '';
}
/** Parse the appmsg block (type 49) into its rich subtype. */
function parseAppmsg(xml) {
    const app = xml;
    const typeStr = xmlAttr(app, 'type', 'type') || xmlAttr(app, 'appmsg', 'type');
    const appType = Number(typeStr || xmlTagText(app, 'type') || 0);
    const title = xmlTagText(app, 'title');
    const des = xmlTagText(app, 'des') || xmlTagText(app, 'desc');
    const url = xmlTagText(app, 'url');
    const thumb = xmlTagText(app, 'thumburl') || xmlTagText(app, 'tpthumburl') || xmlAttr(app, 'img', 'cdnthumburl') || '';
    const source = xmlTagText(app, 'sourcedisplayname') || xmlTagText(app, 'sourcedisplaynick') || '';
    const base = {};
    if (source)
        base.source = source;
    if (thumb)
        base.thumb = thumb;
    switch (appType) {
        case 6: {
            const fileRich = { type: 'file', title, desc: des, url, ...base };
            const size = xmlTagText(app, 'totallen');
            const ext = xmlTagText(app, 'fileext');
            if (size)
                fileRich.fileSize = size;
            if (ext)
                fileRich.fileExt = ext;
            return fileRich;
        }
        case 5:
            return { type: 'link', title, desc: des, url, ...base };
        case 57:
            return { type: 'quote', title: title || des, desc: xmlTagText(app, 'refer') || des, ...base };
        case 33:
            return { type: 'miniapp', title, desc: des, ...base };
        case 51:
            return { type: 'channels', title, desc: des, ...base };
        case 19: {
            const rt = xmlTagText(app, 'recorditem');
            const records = rt ? parseChatlogRecords(rt) : [];
            const chatlog = { type: 'chatlog', title: title || '群聊的聊天记录' };
            if (des)
                chatlog.desc = des;
            if (records.length > 0)
                chatlog.records = records;
            return { ...chatlog, ...base };
        }
        case 2000: {
            // wcpayinfo: feedesc carries the amount (￥0.01); the state label is
            // derived client-side from paysubtype + is_self (st_control mapping).
            const amount = xmlTagText(app, 'feedesc') || title || '';
            const paySub = xmlTagText(app, 'paysubtype');
            const transfer = { type: 'transfer', title: amount };
            if (paySub)
                transfer.paysubtype = paySub;
            return { ...transfer, ...base };
        }
        case 2001: {
            // wcpayinfo.feedesc carries the red packet amount (￥8.88).
            const amount = xmlTagText(app, 'feedesc') || '';
            const greet = title || des || '';
            const rp = { type: 'redpacket', title: '微信红包' };
            if (greet)
                rp.desc = greet;
            if (amount)
                rp.amount = amount.replace(/^\\s*[Y￥]/, '');
            return { ...rp, ...base };
        }
        default:
            // fallback to the type attr if present
            if (title)
                return { type: 'appmsg', title, desc: des, url, ...base };
            return null;
    }
}
/**
 * Parse an appmsg recorditem (merged chat log) into inner records.
 * Mirrors WeChatDataAnalysis frontend parseChatHistoryRecord: datatype /
 * datafmt classify each dataitem; nested recordxml/recorditem recurses.
 * @param recordXml - the recorditem inner XML (<recordinfo>...</recordinfo>).
 * @param depth - recursion guard for nested chat histories.
 * @returns the inner messages (empty when not parseable).
 */
function parseChatlogRecords(recordXml, depth = 0) {
    if (depth > 3)
        return [];
    const ri = xmlTagText(recordXml, 'recordinfo');
    if (!ri)
        return [];
    const dl = xmlTagText(ri, 'datalist');
    if (!dl)
        return [];
    const imageFmts = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'heic', 'heif'];
    const audioFmts = ['silk', 'amr', 'aud', 'mp3', 'wav', 'm4a', 'aac', 'ogg', 'opus'];
    const videoFmts = ['mp4', 'mov', 'm4v', 'avi', 'mkv', 'webm'];
    const out = [];
    let pos = 0;
    let idx = 0;
    for (;;) {
        const s = dl.indexOf('<dataitem', pos);
        if (s < 0)
            break;
        const e = dl.indexOf('</dataitem>', s);
        if (e < 0)
            break;
        const item = dl.slice(s, e + 11);
        pos = e + 11;
        const datatype = xmlAttr(item, 'dataitem', 'datatype');
        const name = xmlTagText(item, 'sourcename');
        const head = xmlTagText(item, 'sourceheadurl');
        const time = xmlTagText(item, 'sourcetime');
        const datatitle = xmlTagText(item, 'datatitle');
        const datadesc = xmlTagText(item, 'datadesc');
        const datafmt = xmlTagText(item, 'datafmt').trim().toLowerCase().replace(/^\./, '');
        const duration = xmlTagText(item, 'duration');
        const datasize = xmlTagText(item, 'datasize');
        const link = xmlTagText(item, 'link') || xmlTagText(item, 'dataurl') || xmlTagText(item, 'url');
        const externurl = xmlTagText(item, 'externurl');
        const cdnurlstring = xmlTagText(item, 'cdnurlstring');
        const encrypturlstring = xmlTagText(item, 'encrypturlstring');
        const fullmd5 = xmlTagText(item, 'fullmd5');
        const thumbfullmd5 = xmlTagText(item, 'thumbfullmd5');
        const md5 = xmlTagText(item, 'md5') || xmlTagText(item, 'emoticonmd5');
        const fromnewmsgid = xmlTagText(item, 'fromnewmsgid');
        const srcMsgLocalid = xmlTagText(item, 'srcMsgLocalid') || xmlTagText(item, 'srcMsgLocalId');
        const srcMsgCreateTime = xmlTagText(item, 'srcMsgCreateTime');
        const nestedRaw = xmlTagText(item, 'recordxml') || xmlTagText(item, 'recorditem');
        if (!name && !datatitle && !datadesc && !link) {
            idx += 1;
            continue;
        }
        let renderType = 'text';
        if (datatype === '17')
            renderType = 'chatHistory';
        else if (datatype === '5' || link)
            renderType = 'link';
        else if (datatype === '4' || videoFmts.includes(datafmt))
            renderType = 'video';
        else if (datatype === '3' || audioFmts.includes(datafmt))
            renderType = 'voice';
        else if (datatype === '47' || datatype === '37')
            renderType = 'emoji';
        else if (datatype === '2' || imageFmts.includes(datafmt))
            renderType = 'image';
        let content = datatitle || datadesc;
        if (!content) {
            if (renderType === 'video')
                content = '[视频]';
            else if (renderType === 'image')
                content = '[图片]';
            else if (renderType === 'voice')
                content = '[语音]';
            else if (renderType === 'emoji')
                content = '[表情]';
            else if (renderType === 'chatHistory')
                content = '[聊天记录]';
            else
                content = '[消息]';
        }
        const rec = {
            name,
            time,
            text: content,
        };
        if (head)
            rec.head = head;
        if (datatype)
            rec.datatype = datatype;
        rec.renderType = renderType;
        if (datatitle)
            rec.datatitle = datatitle;
        if (datafmt)
            rec.datafmt = datafmt;
        if (duration)
            rec.duration = duration;
        if (datasize)
            rec.datasize = datasize;
        if (link) {
            rec.link = link;
            rec.url = link;
        }
        if (externurl)
            rec.externurl = externurl;
        if (cdnurlstring)
            rec.cdnurlstring = cdnurlstring;
        if (encrypturlstring)
            rec.encrypturlstring = encrypturlstring;
        if (fullmd5)
            rec.fullmd5 = fullmd5;
        if (thumbfullmd5)
            rec.thumbfullmd5 = thumbfullmd5;
        if (md5)
            rec.md5 = md5;
        if (fromnewmsgid)
            rec.fromnewmsgid = fromnewmsgid;
        if (srcMsgLocalid) {
            const v = Number(srcMsgLocalid);
            if (v > 0)
                rec.srcMsgLocalid = v;
        }
        if (srcMsgCreateTime) {
            const v = Number(srcMsgCreateTime);
            if (v > 0)
                rec.srcMsgCreateTime = v;
        }
        rec.recordIndex = idx;
        if (renderType === 'chatHistory' && nestedRaw) {
            const nested = parseChatlogRecords(nestedRaw, depth + 1);
            if (nested.length > 0)
                rec.nested = nested;
        }
        if (renderType === 'image')
            rec.isImage = true;
        out.push(rec);
        idx += 1;
    }
    return out;
}
/**
 * Parse one message content into display text + rich descriptor.
 * @param msgType - normalized message type.
 * @param content - raw message content.
 * @param isGroup - whether the message belongs to a group chat.
 * @returns display text plus an optional rich media descriptor.
 */
export function parseMessageContent(msgType, content, isGroup) {
    let body = content;
    if (isGroup) {
        const pos = body.indexOf(':\n');
        if (pos > 0) {
            const head = body.slice(0, pos);
            const tail = body.slice(pos + 2);
            if (head.length <= 64 && !head.includes('<') && !head.includes(' ') && !tail.trimStart().startsWith('<?xml')) {
                body = tail;
            }
        }
    }
    switch (msgType) {
        case 1: {
            const text = body.replace(/^\n+/, '');
            if (text.includes('<mmreader>')) {
                return { text: '', rich: { type: 'newsfeed', title: xmlTagText(text, 'title'), desc: xmlTagText(text, 'digest'), url: xmlTagText(text, 'url') } };
            }
            if (text.startsWith('<msg>') || text.startsWith('<?xml')) {
                const stripped = stripXmlTags(text);
                if (stripped)
                    return { text: stripped };
            }
            return { text };
        }
        case 3:
            return { text: '', rich: { type: 'image' } };
        case 34: {
            const md5 = xmlAttr(body, 'voicemsg', 'md5') || xmlTagText(body, 'md5');
            return { text: '', rich: { type: 'voice', title: xmlTagText(body, 'voicemsg'), md5 } };
        }
        case 42:
            return { text: '', rich: { type: 'contact', nickname: xmlAttr(body, 'contact', 'nickname'), username: xmlAttr(body, 'contact', 'username') } };
        case 43:
            return { text: '', rich: { type: 'video' } };
        case 47:
            return { text: '', rich: { type: 'emoji', title: xmlAttr(body, 'emoji', 'md5') || xmlTagText(body, 'emoji') } };
        case 48:
            return { text: '', rich: { type: 'location', title: xmlAttr(body, 'location', 'label') || xmlTagText(body, 'location'), url: xmlAttr(body, 'location', 'infourl') } };
        case 49: {
            const rich = parseAppmsg(body);
            if (rich) {
                const text = rich.type === 'file' ? `[文件] ${rich.title ?? ''}`
                    : rich.type === 'link' ? `[链接] ${rich.title ?? ''}`
                        : rich.type === 'quote' ? (rich.title ?? '')
                            : rich.type === 'miniapp' ? `[小程序] ${rich.title ?? ''}`
                                : rich.type === 'channels' ? `[视频号] ${rich.title ?? ''}`
                                    : rich.type === 'chatlog' ? `[聊天记录] ${rich.title ?? ''}`
                                        : rich.type === 'transfer' ? '[转账]'
                                            : rich.type === 'redpacket' ? '[红包]'
                                                : '';
                return { text, rich };
            }
            const title = xmlTagText(body, 'title');
            return title ? { text: `[链接] ${title}` } : { text: '' };
        }
        case 50:
            return { text: '[语音通话]' };
        case 10000:
            return { text: stripXmlTags(body) || body.trim() };
        case 10002: {
            const stripped = stripXmlTags(body).trim();
            return { text: stripped || '撤回了一条消息' };
        }
        default: {
            if (body && !body.includes('<') && body.length <= 500)
                return { text: body };
            return { text: '' };
        }
    }
}
//# sourceMappingURL=parse.js.map