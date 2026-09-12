/**
 * Contact region helpers shared by group-info and region-map.
 *
 * WeChat stores a contact's region in contact.extra_buffer as protobuf fields
 * (2=gender, 4=signature, 5=country, 6=province, 7=city). The stored values
 * are ISO alpha-2 country codes, pinyin keys or numeric keys; the bundled
 * contact-region-lookup.json plus the alias maps here resolve them to Chinese
 * labels. This module owns the protobuf decode and the shared lookup so both
 * read paths stay consistent.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
/** Decode a TEXT-or-BLOB cell to UTF-8 text. */
export function cellText(v) {
    if (v === null || v === undefined)
        return '';
    if (typeof v === 'string')
        return v;
    if (v instanceof Uint8Array)
        return new TextDecoder('utf-8', { fatal: false }).decode(v);
    if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint' || typeof v === 'symbol')
        return String(v);
    return '';
}
/** Decode a varint (protobuf) from a buffer at idx. */
export function readVarint(buf, idx) {
    let value = 0;
    let shift = 0;
    for (let i = idx; i < buf.length; i += 1) {
        const b = buf[i] ?? 0;
        value += (b & 0x7f) * Math.pow(2, shift);
        if ((b & 0x80) === 0)
            return { value, next: i + 1 };
        shift += 7;
    }
    return null;
}
/** Parse contact.extra_buffer protobuf: 2=性别, 4=签名, 5=国家, 6=省, 7=市. */
export function parseContactExtra(raw) {
    const out = {};
    let idx = 0;
    const n = raw.length;
    while (idx < n) {
        const tag = readVarint(raw, idx);
        if (!tag)
            break;
        idx = tag.next;
        const field = tag.value >> 3;
        const wire = tag.value & 0x7;
        if (wire === 0) {
            const v = readVarint(raw, idx);
            if (!v)
                break;
            idx = v.next;
            if (field === 2)
                out.gender = v.value;
            continue;
        }
        if (wire === 2) {
            const len = readVarint(raw, idx);
            if (!len)
                break;
            idx = len.next;
            const end = idx + len.value;
            if (end > n)
                break;
            const chunk = raw.subarray(idx, end);
            idx = end;
            const text = new TextDecoder('utf-8', { fatal: false }).decode(chunk).trim();
            if (field === 2)
                out.wordingId = text;
            else if (field === 4)
                out.signature = text;
            else if (field === 5)
                out.country = text;
            else if (field === 6)
                out.province = text;
            else if (field === 7)
                out.city = text;
            continue;
        }
        if (wire === 1) {
            idx += 8;
            continue;
        }
        if (wire === 5) {
            idx += 4;
            continue;
        }
        break;
    }
    return out;
}
/** Region lookup tables (copied from WeChatDataAnalysis resources). */
let _regionData = null;
function regionData() {
    if (_regionData)
        return _regionData;
    const here = import.meta.url || '';
    const fromFile = (cands) => {
        for (const c of cands) {
            try {
                if (existsSync(c))
                    return JSON.parse(readFileSync(c, 'utf8'));
            }
            catch { /* try next */ }
        }
        return null;
    };
    const dir = here.startsWith('file:') ? dirname(fileURLToPath(here)) : __dirname;
    const data = fromFile([
        join(dir, '..', '..', 'resources', 'contact-region-lookup.json'),
        join(dir, '..', '..', '..', 'resources', 'contact-region-lookup.json'),
        join(dir, '..', 'resources', 'contact-region-lookup.json'),
    ]);
    _regionData = data ?? {};
    return _regionData;
}
/** ISO 3166 alpha-2 country codes -> Chinese country name (comprehensive). */
const ALPHA2_CN = {
    cn: '中国', hk: '中国香港', mo: '中国澳门', tw: '中国台湾',
    us: '美国', gb: '英国', fr: '法国', de: '德国', it: '意大利', es: '西班牙',
    ru: '俄罗斯', jp: '日本', kr: '韩国', kp: '朝鲜', sg: '新加坡', my: '马来西亚',
    th: '泰国', ca: '加拿大', au: '澳大利亚', nz: '新西兰', ae: '阿联酋',
    sa: '沙特阿拉伯', br: '巴西', ar: '阿根廷', mx: '墨西哥', in: '印度', id: '印度尼西亚',
    vn: '越南', ph: '菲律宾', nl: '荷兰', ch: '瑞士', se: '瑞典', no: '挪威',
    dk: '丹麦', fi: '芬兰', ie: '爱尔兰', at: '奥地利', be: '比利时', pl: '波兰',
    tr: '土耳其', eg: '埃及', za: '南非', ng: '尼日利亚', ke: '肯尼亚', et: '埃塞俄比亚',
    cu: '古巴', az: '阿塞拜疆', bt: '不丹', al: '阿尔巴尼亚', ad: '安道尔', aw: '阿鲁巴',
    bm: '百慕大', gl: '格陵兰', gq: '赤道几内亚', je: '泽西岛', jo: '约旦',
    mm: '缅甸', td: '乍得', tl: '东帝汶', tt: '特立尼达和多巴哥', um: '美国本土外小岛屿',
    aq: '南极洲', cx: '圣诞岛', is: '冰岛', af: '阿富汗', ee: '爱沙尼亚',
    pt: '葡萄牙', gr: '希腊', il: '以色列', qa: '卡塔尔', kw: '科威特',
    om: '阿曼', lu: '卢森堡', mt: '马耳他', cy: '塞浦路斯', lv: '拉脱维亚',
    lt: '立陶宛', ro: '罗马尼亚', hu: '匈牙利', cz: '捷克', sk: '斯洛伐克',
    si: '斯洛文尼亚', hr: '克罗地亚', ba: '波黑', rs: '塞尔维亚', bg: '保加利亚',
    ua: '乌克兰', by: '白俄罗斯', ge: '格鲁吉亚', am: '亚美尼亚', pk: '巴基斯坦',
    bd: '孟加拉国', lk: '斯里兰卡', np: '尼泊尔', kz: '哈萨克斯坦', uz: '乌兹别克斯坦',
    mn: '蒙古', la: '老挝', kh: '柬埔寨', bn: '文莱', fj: '斐济', pg: '巴布亚新几内亚',
    cl: '智利', co: '哥伦比亚', pe: '秘鲁', ve: '委内瑞拉', uy: '乌拉圭',
    py: '巴拉圭', ec: '厄瓜多尔', bo: '玻利维亚', cr: '哥斯达黎加', pa: '巴拿马',
    gt: '危地马拉', hn: '洪都拉斯', sv: '萨尔瓦多', ni: '尼加拉瓜', do: '多米尼加',
    jm: '牙买加', ht: '海地', bb: '巴巴多斯', bs: '巴哈马',
};
/** Aliases for region values the bundled lookup misses (weird decrypted keys). */
const PROVINCE_ALIAS = {
    'Kowloon City': '九龙城区', 'Central and Western': '中西区', 'Wan Chai': '湾仔区',
    'Yau Tsim Mong': '油尖旺区', 'New York': '纽约州', England: '英格兰',
    Seoul: '首尔', Bangkok: '曼谷', Dubai: '迪拜', Paris: '巴黎', Dublin: '都柏林',
    Vienna: '维也纳', Nuremberg: '纽伦堡', Burgenland: '布尔根兰州', Kerry: '凯里郡',
    Wicklow: '威克洛郡', Offaly: '奥法利郡', 'St. Anthony': '圣安东尼', Moscow: '莫斯科', London: '伦敦',
};
const CITY_ALIAS = {
    Chow: '钦州', Yulin: '玉林', Chaoyang: '朝阳区', Haidian: '海淀区',
    Changping: '昌平区', Daxing: '大兴区', Fengtai: '丰台区', East: '东城区',
    West: '西城区', 'Pudong New District': '浦东新区', Changning: '长宁区',
    Xuhui: '徐汇区', Minhang: '闵行区', Jing: '荆州', Po: '香港仔',
    Taipa: '氹仔', Banan: '巴南区',
};
/** Resolve one region label: key -> Chinese (or Chinese -> key -> Chinese). */
export function regionLabel(category, value) {
    const raw = value.trim();
    if (!raw)
        return '';
    const data = regionData();
    const lower = raw.toLowerCase();
    if (category === 'country') {
        if (ALPHA2_CN[lower])
            return ALPHA2_CN[lower];
        const numeric = String(Number(raw) || 0);
        const byNum = data['countryNameByKey'];
        if (byNum && numeric !== '0' && typeof byNum[numeric] === 'string')
            return byNum[numeric];
    }
    const alias = category === 'province' ? PROVINCE_ALIAS : category === 'city' ? CITY_ALIAS : undefined;
    if (alias && typeof alias[raw] === 'string')
        return alias[raw];
    const nameByKey = data[category + 'NameByKey'];
    const keyByName = data[category + 'KeyByName'];
    if (nameByKey && typeof nameByKey[lower] === 'string')
        return nameByKey[lower];
    if (keyByName && typeof keyByName[raw] === 'string') {
        const key = keyByName[raw];
        if (nameByKey && typeof nameByKey[key] === 'string')
            return nameByKey[key];
    }
    return raw;
}
/** Build a compact region string (中国 → 省+市; abroad → 国家 省 市). */
export function buildRegion(country, province, city) {
    const c = regionLabel('country', country);
    const p = regionLabel('province', province);
    const ci = regionLabel('city', city);
    if (!p && !ci)
        return c;
    if (/中国|CN|china/i.test(c))
        return p + ci;
    return [c, p, ci].filter(Boolean).join(' ');
}
//# sourceMappingURL=region.js.map