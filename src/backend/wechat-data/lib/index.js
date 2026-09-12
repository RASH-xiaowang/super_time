import { createRequire } from "node:module";
import { Remote, RemoteError, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import { closeSync, copyFileSync, cpSync, createReadStream, createWriteStream, existsSync, mkdirSync, openSync, promises, readFileSync, readSync, readdirSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { createCipheriv, createDecipheriv, createHash, createHmac, pbkdf2Sync, randomBytes, scryptSync } from "node:crypto";
import { decompress } from "fzstd";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFile, mkdir, open, readFile, readdir, rename, unlink } from "node:fs/promises";
import { openNativePath } from "@deepseek-ai/dsh-native-command";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";
import { tmpdir } from "node:os";
import { deflateRawSync } from "node:zlib";
//#region lib/types/query/meta.js
/**
* Shared in-process metadata caches for the WeChat read path.
*
* The decrypted snapshot is an external read-only DB tree that the realtime
* sync loop rewrites in place (atomic rename). Every cache here keys on the
* owning file's mtime+size fingerprint, so a rewritten file invalidates the
* entry naturally; callers never see data older than the file that produced
* it. A short max-age bounds fingerprint drift on the same file.
*/
const MAX_AGE_MS = 5e3;
const entries = /* @__PURE__ */ new Map();
function decode(v) {
	if (v === null || v === void 0) return "";
	if (typeof v === "string") return v;
	if (typeof v === "number" || typeof v === "boolean" || typeof v === "bigint" || typeof v === "symbol") return String(v);
	if (v instanceof Uint8Array) return new TextDecoder("utf-8", { fatal: false }).decode(v);
	return "";
}
function fileSig(path) {
	try {
		const st = statSync(path);
		return `${st.mtimeMs}:${st.size}`;
	} catch {
		return "";
	}
}
function dirSig(dir) {
	try {
		const st = statSync(dir);
		return `${st.mtimeMs}:${st.size}`;
	} catch {
		return "";
	}
}
function get(key, sig, loader, maxAgeMs = MAX_AGE_MS) {
	const hit = entries.get(key);
	if (hit && hit.sig === sig && hit.at + maxAgeMs > Date.now()) return hit.value;
	const value = loader();
	entries.set(key, {
		at: Date.now(),
		sig,
		value
	});
	return value;
}
function tableColumns$12(db, table) {
	try {
		const rows = db.prepare(`PRAGMA table_info(${table})`).all();
		return new Set(rows.map((r) => r.name));
	} catch {
		return /* @__PURE__ */ new Set();
	}
}
/**
* Read contact.db once and derive all contact metadata.
* @param decryptedDir - decrypted data root.
* @returns contact names (remark > nick > username), pinned set, biz types.
*/
function contactMeta(decryptedDir) {
	const p = join(decryptedDir, "contact", "contact.db");
	const sig = fileSig(p);
	return get("contact-meta:" + decryptedDir, sig, () => {
		const names = /* @__PURE__ */ new Map();
		const pinned = /* @__PURE__ */ new Set();
		const bizTypes = /* @__PURE__ */ new Map();
		if (!sig) return {
			names,
			pinned,
			bizTypes
		};
		try {
			const db = new DatabaseSync(p, { readOnly: true });
			try {
				const cols = tableColumns$12(db, "contact");
				const userCol = cols.has("username") ? "username" : cols.has("UserName") ? "UserName" : "";
				const remarkCol = cols.has("remark") ? "remark" : cols.has("Remark") ? "Remark" : "";
				const nickCol = cols.has("nick_name") ? "nick_name" : cols.has("NickName") ? "NickName" : "nickName";
				const flagCol = cols.has("flag") ? "flag" : cols.has("Flag") ? "Flag" : "";
				if (userCol) {
					const remarkSel = remarkCol || "''";
					const nickSel = nickCol;
					const rows = db.prepare(`SELECT ${userCol} AS u, ${remarkSel} AS r, ${nickSel} AS n, ${flagCol || "0"} AS f FROM contact`).all();
					for (const row of rows) {
						const u = decode(row.u);
						if (!u) continue;
						const remark = decode(row.r).trim();
						const nick = decode(row.n).trim();
						names.set(u, remark || nick || u);
						if ((Number(row.f ?? 0) & 2048) !== 0) pinned.add(u);
					}
				}
				const biCols = tableColumns$12(db, "biz_info");
				if (biCols.has("username") && biCols.has("type")) {
					const rows = db.prepare("SELECT username AS u, type AS t FROM biz_info").all();
					for (const row of rows) {
						const u = decode(row.u);
						if (u) bizTypes.set(u, Number(row.t ?? 0));
					}
				}
			} finally {
				db.close();
			}
		} catch {}
		return {
			names,
			pinned,
			bizTypes
		};
	});
}
/** SenderName2Id fallback (message_resource.db rowid -> wxid). */
function senderNameMap(decryptedDir) {
	const p = join(decryptedDir, "message", "message_resource.db");
	const sig = fileSig(p);
	return get("sender-names:" + decryptedDir, sig, () => {
		const map = /* @__PURE__ */ new Map();
		if (!sig) return map;
		try {
			const db = new DatabaseSync(p, { readOnly: true });
			try {
				const rows = db.prepare("SELECT rowid AS id, user_name AS u FROM SenderName2Id").all();
				for (const row of rows) {
					const u = decode(row.u).trim();
					if (u) map.set(row.id, u);
				}
			} catch {} finally {
				db.close();
			}
		} catch {}
		return map;
	});
}
function loadShardMeta(dbFile) {
	const tables = /* @__PURE__ */ new Map();
	try {
		const db = new DatabaseSync(dbFile, { readOnly: true });
		try {
			const name2id = /* @__PURE__ */ new Map();
			for (const t of ["Name2Id", "name2id"]) try {
				const rows = db.prepare("SELECT rowid AS id, user_name AS u FROM " + t).all();
				for (const row of rows) {
					const u = decode(row.u).trim();
					if (u) name2id.set(row.id, u);
				}
				if (name2id.size > 0) break;
			} catch {}
			const rows = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'Msg_%'").all();
			for (const row of rows) tables.set(row.name, {
				cols: tableColumns$12(db, row.name),
				name2id
			});
		} finally {
			db.close();
		}
	} catch {}
	return {
		file: dbFile,
		tables
	};
}
/**
* Cached message shard catalog across one or more sub-directories (message,
* bizchat, ...). Returns the Msg_% tables each file holds.
* @param decryptedDir - decrypted data root.
* @param dirs - sub-directory names to scan (default ['message']).
* @returns shard metadata keyed by file path (cache invalidated by file sigs).
*/
function shardCatalogDirs(decryptedDir, dirs) {
	const key = "shard-catalog:" + decryptedDir + ":" + dirs.join("|");
	const sigParts = [];
	const entries = [];
	for (const dirName of dirs) {
		const dir = join(decryptedDir, dirName);
		const dSig = dirSig(dir);
		if (!dSig) continue;
		sigParts.push(`${dirName}:${dSig}`);
		let files = [];
		try {
			files = readdirSync(dir).filter((f) => f.endsWith(".db") && !f.includes("_shm") && !f.includes("_wal") && !f.includes("monitor_cache") && !f.includes("fts") && !f.includes("resource") && !f.includes("media")).sort();
		} catch {
			continue;
		}
		for (const f of files) {
			const full = join(dir, f);
			const fs = fileSig(full);
			sigParts.push(`${f}:${fs}`);
			entries.push({ file: full });
		}
	}
	return get(key, sigParts.join("|"), () => entries.map((e) => loadShardMeta(e.file)));
}
/** Convenience: message-directory-only catalog (the chat hot path). */
function shardCatalog(decryptedDir) {
	return shardCatalogDirs(decryptedDir, ["message"]);
}
/** Signature string for the directories a catalog covers (cache keys). */
function shardCatalogSig(decryptedDir, dirs) {
	const parts = [];
	for (const dirName of dirs) {
		const dir = join(decryptedDir, dirName);
		parts.push(`${dirName}:${dirSig(dir)}`);
		let files = [];
		try {
			files = readdirSync(dir).filter((f) => f.endsWith(".db") && !f.includes("_shm") && !f.includes("_wal") && !f.includes("monitor_cache") && !f.includes("fts") && !f.includes("resource") && !f.includes("media")).sort();
		} catch {
			continue;
		}
		for (const f of files) parts.push(`${f}:${fileSig(join(dir, f))}`);
	}
	return parts.join("|");
}
/** Signature of one file (mtime+size); '' when absent. */
function fileSigOf(path) {
	return fileSig(path);
}
/** Generic mtime/fingerprint-bounded process cache (see {@link get}). */
function cachedBySig(key, sig, loader, maxAgeMs = MAX_AGE_MS) {
	return get(key, sig, loader, maxAgeMs);
}
/** Insert with a simple FIFO capacity bound (evicts the oldest key). */
function boundedSet(map, key, value, cap = 300) {
	if (!map.has(key) && map.size >= cap) {
		const first = map.keys().next();
		if (!first.done && first.value !== void 0) map.delete(first.value);
	}
	map.set(key, value);
}
/** Drop every cached snapshot (called after a rewrite event when needed). */
function invalidateWechatMeta() {
	entries.clear();
}
//#endregion
//#region lib/types/query/sessions.js
/**
* Session queries over st_control's decrypted session.db, rewritten from the
* Rust sessions::get_session_list. Reads ordinary SQLite via node:sqlite.
*/
/** Read SessionTable column names (wechat 4.x may add/remove columns). */
function tableColumns$11(db, table) {
	const rows = db.prepare(`PRAGMA table_info(${table})`).all();
	return new Set(rows.map((r) => r.name));
}
/** Resolve a byte/TEXT summary/draft column to a string. */
function bytesToString(v) {
	if (v === null || v === void 0) return "";
	if (typeof v === "string") return v;
	if (v instanceof Uint8Array) return new TextDecoder("utf-8", { fatal: false }).decode(v);
	if (typeof v === "number" || typeof v === "boolean" || typeof v === "bigint" || typeof v === "symbol") return String(v);
	return "";
}
/** Session titles from SessionNoContactInfoTable (display name source 2). */
function loadSessionTitles(db) {
	const map = /* @__PURE__ */ new Map();
	try {
		const rows = db.prepare("SELECT username, session_title FROM SessionNoContactInfoTable").all();
		for (const r of rows) {
			const u = bytesToString(r.username);
			if (u) map.set(u, bytesToString(r.session_title));
		}
	} catch {}
	return map;
}
/** 客服会话识别（真实企业微信/品牌客服会话，排除占位 holder）。 */
function isKefuLike(u) {
	const s = u.toLowerCase();
	return s.includes("@weclaw") || s.includes("@kefu.openim") || s.includes("opencustomerservicemsg");
}
/**
* Read the session list from the decrypted session.db.
* @param decryptedDir - st_control decrypted data root (…/data/wechat/decrypted).
* @param keyword - optional username/name filter.
* @param limit - max rows.
* @returns the session snapshot.
*/
function querySessions(decryptedDir, keyword, limit, offset) {
	return cachedBySig(`sessions:${decryptedDir}:${keyword ?? ""}:${limit ?? ""}:${offset ?? ""}`, [fileSigOf(join(decryptedDir, "session", "session.db")), fileSigOf(join(decryptedDir, "contact", "contact.db"))].join("|"), () => computeSessions(decryptedDir, keyword, limit, offset));
}
function computeSessions(decryptedDir, keyword, limit, offset = 0) {
	const db = new DatabaseSync(join(decryptedDir, "session", "session.db"), { readOnly: true });
	try {
		const cols = tableColumns$11(db, "SessionTable");
		if (!cols.has("username")) throw new Error("SessionTable 缺少 username 列");
		const sel = (name, dft) => cols.has(name) ? name : dft;
		const sql = [
			"SELECT",
			[
				sel("username", "''"),
				sel("unread_count", "0"),
				sel("summary", "NULL"),
				sel("draft", "NULL"),
				sel("is_hidden", "0"),
				sel("last_timestamp", "0"),
				sel("sort_timestamp", "last_timestamp"),
				sel("last_msg_type", "0"),
				sel("last_msg_sub_type", "0"),
				sel("last_msg_sender", "''"),
				sel("last_sender_display_name", "''"),
				// unread_first_msg_srv_id 是 int64：必须 CAST 成 TEXT，否则 node:sqlite 直接 ERR_OUT_OF_RANGE
				cols.has("unread_first_msg_srv_id") ? "CAST(unread_first_msg_srv_id AS TEXT) AS unread_srv" : "'' AS unread_srv"
			].join(", "),
			"FROM SessionTable",
			"ORDER BY",
			sel("sort_timestamp", "last_timestamp"),
			"DESC",
			"LIMIT ?"
		].join(" ");
		const meta = contactMeta(decryptedDir);
		const contactNames = meta.names;
		const sessionTitles = loadSessionTitles(db);
		const pinned = meta.pinned;
		const bizTypes = meta.bizTypes;
		const q = (keyword ?? "").trim().toLowerCase();
		const rows = db.prepare(sql).all(5e3);
		const key = (cand, dft) => cols.has(cand) ? cand : dft;
		const sessions = [];
		/** username → unread_first_msg_srv_id（TEXT），供「未读从何时开始」解析用（第 67 轮） */
		const srvIds = /* @__PURE__ */ new Map();
		for (const r of rows) {
			const username = bytesToString(r[key("username", "")]);
			const displayName = contactNames.get(username) ?? sessionTitles.get(username) ?? username;
			if (q && !username.toLowerCase().includes(q) && !displayName.toLowerCase().includes(q)) continue;
			const srv = String(r["unread_srv"] ?? "").trim();
			if (srv && srv !== "0") srvIds.set(username, srv);
			const s = {
				username,
				displayName,
				type: username.endsWith("@chatroom") ? "group" : "private",
				lastTimestamp: Number(r[key("last_timestamp", "0")] ?? 0),
				summary: bytesToString(r[key("summary", "NULL")]),
				unreadCount: Number(r[key("unread_count", "0")] ?? 0),
				draft: bytesToString(r[key("draft", "NULL")]),
				pinned: pinned.has(username),
				hidden: Number(r[key("is_hidden", "0")] ?? 0) === 1,
				lastMsgType: Number(r[key("last_msg_type", "0")] ?? 0),
				lastMsgSubType: Number(r[key("last_msg_sub_type", "0")] ?? 0),
				lastMsgSender: bytesToString(r[key("last_msg_sender", "''")]).trim(),
				lastMsgSenderName: bytesToString(r[key("last_sender_display_name", "''")]).trim()
			};
			if (username.startsWith("gh_")) {
				const bt = bizTypes.get(username) ?? 0;
				s.bizType = bt;
				s.accountKind = bt > 0 ? "service" : "official";
			} else if (isKefuLike(username)) s.accountKind = "kefu";
			sessions.push(s);
		}
		sessions.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0));
		const total = sessions.length;
		const page = limit === void 0 ? sessions : sessions.slice(offset, offset + limit);
		/*
		* 「未读从什么时候开始」（第 67 轮）：用 unread_first_msg_srv_id 反查该会话最早的一条未读消息。
		* 只对返回页里 unread>0 的会话解析，并设上限（实测 41 个未读会话全部解析约 7ms）。
		*/
		let budget = 80;
		for (const s of page) {
			if (budget <= 0) break;
			if ((s.unreadCount ?? 0) <= 0 || s.username === "brandsessionholder") continue;
			const sid = srvIds.get(s.username);
			if (!sid || sid === "0") continue;
			budget -= 1;
			const since = msgCreateTimeByServerId(decryptedDir, s.username, sid);
			if (since !== null) s.unreadSince = since;
		}
		return {
			sessions: page,
			total
		};
	} finally {
		db.close();
	}
}
//#endregion
//#region lib/types/query/region.js
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
/** Decode a TEXT-or-BLOB cell to UTF-8 text. */
function cellText$2(v) {
	if (v === null || v === void 0) return "";
	if (typeof v === "string") return v;
	if (v instanceof Uint8Array) return new TextDecoder("utf-8", { fatal: false }).decode(v);
	if (typeof v === "number" || typeof v === "boolean" || typeof v === "bigint" || typeof v === "symbol") return String(v);
	return "";
}
/** Decode a varint (protobuf) from a buffer at idx. */
function readVarint(buf, idx) {
	let value = 0;
	let shift = 0;
	for (let i = idx; i < buf.length; i += 1) {
		const b = buf[i] ?? 0;
		value += (b & 127) * Math.pow(2, shift);
		if ((b & 128) === 0) return {
			value,
			next: i + 1
		};
		shift += 7;
	}
	return null;
}
/** Parse contact.extra_buffer protobuf: 2=性别, 4=签名, 5=国家, 6=省, 7=市. */
function parseContactExtra(raw) {
	const out = {};
	let idx = 0;
	const n = raw.length;
	while (idx < n) {
		const tag = readVarint(raw, idx);
		if (!tag) break;
		idx = tag.next;
		const field = tag.value >> 3;
		const wire = tag.value & 7;
		if (wire === 0) {
			const v = readVarint(raw, idx);
			if (!v) break;
			idx = v.next;
			if (field === 2) out.gender = v.value;
			continue;
		}
		if (wire === 2) {
			const len = readVarint(raw, idx);
			if (!len) break;
			idx = len.next;
			const end = idx + len.value;
			if (end > n) break;
			const chunk = raw.subarray(idx, end);
			idx = end;
			const text = new TextDecoder("utf-8", { fatal: false }).decode(chunk).trim();
			if (field === 2) out.wordingId = text;
			else if (field === 4) out.signature = text;
			else if (field === 5) out.country = text;
			else if (field === 6) out.province = text;
			else if (field === 7) out.city = text;
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
	if (_regionData) return _regionData;
	const here = import.meta.url || "";
	const fromFile = (cands) => {
		for (const c of cands) try {
			if (existsSync(c)) return JSON.parse(readFileSync(c, "utf8"));
		} catch {}
		return null;
	};
	const dir = here.startsWith("file:") ? dirname(fileURLToPath(here)) : __dirname;
	_regionData = fromFile([
		join(dir, "..", "..", "resources", "contact-region-lookup.json"),
		join(dir, "..", "..", "..", "resources", "contact-region-lookup.json"),
		join(dir, "..", "resources", "contact-region-lookup.json")
	]) ?? {};
	return _regionData;
}
/** ISO 3166 alpha-2 country codes -> Chinese country name (comprehensive). */
const ALPHA2_CN = {
	cn: "中国",
	hk: "中国香港",
	mo: "中国澳门",
	tw: "中国台湾",
	us: "美国",
	gb: "英国",
	fr: "法国",
	de: "德国",
	it: "意大利",
	es: "西班牙",
	ru: "俄罗斯",
	jp: "日本",
	kr: "韩国",
	kp: "朝鲜",
	sg: "新加坡",
	my: "马来西亚",
	th: "泰国",
	ca: "加拿大",
	au: "澳大利亚",
	nz: "新西兰",
	ae: "阿联酋",
	sa: "沙特阿拉伯",
	br: "巴西",
	ar: "阿根廷",
	mx: "墨西哥",
	in: "印度",
	id: "印度尼西亚",
	vn: "越南",
	ph: "菲律宾",
	nl: "荷兰",
	ch: "瑞士",
	se: "瑞典",
	no: "挪威",
	dk: "丹麦",
	fi: "芬兰",
	ie: "爱尔兰",
	at: "奥地利",
	be: "比利时",
	pl: "波兰",
	tr: "土耳其",
	eg: "埃及",
	za: "南非",
	ng: "尼日利亚",
	ke: "肯尼亚",
	et: "埃塞俄比亚",
	cu: "古巴",
	az: "阿塞拜疆",
	bt: "不丹",
	al: "阿尔巴尼亚",
	ad: "安道尔",
	aw: "阿鲁巴",
	bm: "百慕大",
	gl: "格陵兰",
	gq: "赤道几内亚",
	je: "泽西岛",
	jo: "约旦",
	mm: "缅甸",
	td: "乍得",
	tl: "东帝汶",
	tt: "特立尼达和多巴哥",
	um: "美国本土外小岛屿",
	aq: "南极洲",
	cx: "圣诞岛",
	is: "冰岛",
	af: "阿富汗",
	ee: "爱沙尼亚",
	pt: "葡萄牙",
	gr: "希腊",
	il: "以色列",
	qa: "卡塔尔",
	kw: "科威特",
	om: "阿曼",
	lu: "卢森堡",
	mt: "马耳他",
	cy: "塞浦路斯",
	lv: "拉脱维亚",
	lt: "立陶宛",
	ro: "罗马尼亚",
	hu: "匈牙利",
	cz: "捷克",
	sk: "斯洛伐克",
	si: "斯洛文尼亚",
	hr: "克罗地亚",
	ba: "波黑",
	rs: "塞尔维亚",
	bg: "保加利亚",
	ua: "乌克兰",
	by: "白俄罗斯",
	ge: "格鲁吉亚",
	am: "亚美尼亚",
	pk: "巴基斯坦",
	bd: "孟加拉国",
	lk: "斯里兰卡",
	np: "尼泊尔",
	kz: "哈萨克斯坦",
	uz: "乌兹别克斯坦",
	mn: "蒙古",
	la: "老挝",
	kh: "柬埔寨",
	bn: "文莱",
	fj: "斐济",
	pg: "巴布亚新几内亚",
	cl: "智利",
	co: "哥伦比亚",
	pe: "秘鲁",
	ve: "委内瑞拉",
	uy: "乌拉圭",
	py: "巴拉圭",
	ec: "厄瓜多尔",
	bo: "玻利维亚",
	cr: "哥斯达黎加",
	pa: "巴拿马",
	gt: "危地马拉",
	hn: "洪都拉斯",
	sv: "萨尔瓦多",
	ni: "尼加拉瓜",
	do: "多米尼加",
	jm: "牙买加",
	ht: "海地",
	bb: "巴巴多斯",
	bs: "巴哈马"
};
/** Aliases for region values the bundled lookup misses (weird decrypted keys). */
const PROVINCE_ALIAS = {
	"Kowloon City": "九龙城区",
	"Central and Western": "中西区",
	"Wan Chai": "湾仔区",
	"Yau Tsim Mong": "油尖旺区",
	"New York": "纽约州",
	England: "英格兰",
	Seoul: "首尔",
	Bangkok: "曼谷",
	Dubai: "迪拜",
	Paris: "巴黎",
	Dublin: "都柏林",
	Vienna: "维也纳",
	Nuremberg: "纽伦堡",
	Burgenland: "布尔根兰州",
	Kerry: "凯里郡",
	Wicklow: "威克洛郡",
	Offaly: "奥法利郡",
	"St. Anthony": "圣安东尼",
	Moscow: "莫斯科",
	London: "伦敦"
};
const CITY_ALIAS = {
	Chow: "钦州",
	Yulin: "玉林",
	Chaoyang: "朝阳区",
	Haidian: "海淀区",
	Changping: "昌平区",
	Daxing: "大兴区",
	Fengtai: "丰台区",
	East: "东城区",
	West: "西城区",
	"Pudong New District": "浦东新区",
	Changning: "长宁区",
	Xuhui: "徐汇区",
	Minhang: "闵行区",
	Jing: "荆州",
	Po: "香港仔",
	Taipa: "氹仔",
	Banan: "巴南区"
};
/** Resolve one region label: key -> Chinese (or Chinese -> key -> Chinese). */
function regionLabel(category, value) {
	const raw = value.trim();
	if (!raw) return "";
	const data = regionData();
	const lower = raw.toLowerCase();
	if (category === "country") {
		if (ALPHA2_CN[lower]) return ALPHA2_CN[lower];
		const numeric = String(Number(raw) || 0);
		const byNum = data["countryNameByKey"];
		if (byNum && numeric !== "0" && typeof byNum[numeric] === "string") return byNum[numeric];
	}
	const alias = category === "province" ? PROVINCE_ALIAS : category === "city" ? CITY_ALIAS : void 0;
	if (alias && typeof alias[raw] === "string") return alias[raw];
	const nameByKey = data[category + "NameByKey"];
	const keyByName = data[category + "KeyByName"];
	if (nameByKey && typeof nameByKey[lower] === "string") return nameByKey[lower];
	if (keyByName && typeof keyByName[raw] === "string") {
		const key = keyByName[raw];
		if (nameByKey && typeof nameByKey[key] === "string") return nameByKey[key];
	}
	return raw;
}
/** Build a compact region string (中国 → 省+市; abroad → 国家 省 市). */
function buildRegion(country, province, city) {
	const c = regionLabel("country", country);
	const p = regionLabel("province", province);
	const ci = regionLabel("city", city);
	if (!p && !ci) return c;
	if (/中国|CN|china/i.test(c)) return p + ci;
	return [
		c,
		p,
		ci
	].filter(Boolean).join(" ");
}
//#endregion
//#region lib/types/query/group-info.js
/**
* Group chat info (群聊信息) queries over st_control's decrypted contact.db:
* chatroom name/remark, announcement (chat_room_info_detail), own alias and
* member grid (chatroom_member joined to contact for names/avatars).
*/
/** Strip the WeChat instance suffix (wxid_xxx_f312 -> wxid_xxx). */
function cleanWxid$2(username) {
	const m = username.match(/^(wxid_[A-Za-z0-9]+)(?:_[A-Za-z0-9]+)?$/);
	return m ? m[1] ?? username : username;
}
/**
* Parse the chat_room.ext_buffer member snapshot (protobuf).
* Outer message = repeated field-1 MemberInfo entries; each entry has field 1
* (member username), field 3 (role flag varint) and field 4 (inviter username);
* trailing outer fields 3/4/5 are counters/status and are ignored.
*/
function parseChatRoomExtBuffer(raw) {
	const out = [];
	let idx = 0;
	const n = raw.length;
	while (idx < n) {
		const tag = readVarint(raw, idx);
		if (!tag) break;
		idx = tag.next;
		const field = tag.value >> 3;
		const wire = tag.value & 7;
		if (wire !== 2) {
			if (wire === 0) {
				const v = readVarint(raw, idx);
				if (!v) break;
				idx = v.next;
			} else if (wire === 1) idx += 8;
			else if (wire === 5) idx += 4;
			else break;
			continue;
		}
		const len = readVarint(raw, idx);
		if (!len) break;
		idx = len.next;
		const end = idx + len.value;
		if (end > n) break;
		if (field === 1) {
			const entry = raw.subarray(idx, end);
			const item = { username: "" };
			let i = 0;
			while (i < entry.length) {
				const et = readVarint(entry, i);
				if (!et) break;
				i = et.next;
				const ef = et.value >> 3;
				const ew = et.value & 7;
				if (ew === 0) {
					const v = readVarint(entry, i);
					if (!v) break;
					i = v.next;
					if (ef === 3) item.roleFlag = v.value;
				} else if (ew === 2) {
					const el = readVarint(entry, i);
					if (!el) break;
					i = el.next;
					const ee = i + el.value;
					if (ee > entry.length) break;
					const text = new TextDecoder("utf-8", { fatal: false }).decode(entry.subarray(i, ee)).trim();
					if (ef === 1) item.username = text;
					else if (ef === 4) item.inviter = text;
					i = ee;
				} else if (ew === 1) i += 8;
				else if (ew === 5) i += 4;
				else break;
			}
			if (item.username) out.push(item);
		}
		idx = end;
	}
	return out;
}
/** Enterprise WeChat official wording map: wording_id(@im.wxwork) -> wording. */
let _openimNames = null;
function openimNames(decryptedDir) {
	if (_openimNames && _openimNames.dir === decryptedDir) return _openimNames.map;
	const map = /* @__PURE__ */ new Map();
	try {
		const db = new DatabaseSync(join(decryptedDir, "contact", "contact.db"), { readOnly: true });
		try {
			const rows = db.prepare("SELECT wording_id AS id, wording AS w FROM openim_wording").all();
			for (const r of rows) {
				const id = cellText$2(r.id).trim();
				const w = cellText$2(r.w).trim();
				if (id && w) map.set(id, w);
			}
		} catch {}
		db.close();
	} catch {}
	_openimNames = {
		dir: decryptedDir,
		map
	};
	return map;
}
/** Clean a profile text that may carry a protobuf prefix + JSON (enterprise WeChat). */
function cleanProfileText(raw) {
	const start = raw.indexOf("{");
	if (start >= 0) {
		const json = raw.slice(start);
		try {
			const obj = JSON.parse(json);
			{
				const ci = obj["custom_info"];
				if (Array.isArray(ci) && ci.length > 0) {
					const parts = [];
					for (const rawCard of ci) {
						const card = rawCard;
						const t = typeof card["title"] === "string" ? card["title"].trim() : "";
						if (t && !parts.includes(t)) parts.push(t);
						const det = card["detail"];
						if (Array.isArray(det)) for (const rawD of det) {
							const d = rawD;
							const desc = typeof d["desc"] === "string" ? d["desc"].trim() : "";
							if (!desc || /@im\.wxwork$/i.test(desc)) continue;
							if (!parts.includes(desc)) parts.push(desc);
						}
						else if (typeof det === "string" && det.trim() && !parts.includes(det.trim())) parts.push(det.trim());
					}
					return parts.join(" · ").slice(0, 120);
				}
				const sig = obj["signature"] ?? obj["desc"] ?? obj["title"];
				if (typeof sig === "string" && sig.trim()) return sig.trim().slice(0, 120);
			}
		} catch {}
	}
	return raw.replace(/^[^\u4e00-\u9fa5A-Za-z0-9{]+/, "").trim().slice(0, 120);
}
/**
* Load group info for one chatroom.
* @param decryptedDir - st_control decrypted data root.
* @param username - chatroom username (e.g. 123456789@chatroom).
* @param selfUsername - logged-in account wxid (instance suffix tolerated).
* @returns snapshot with the group (null when the chatroom is unknown).
*/
function queryGroupInfo(decryptedDir, username, selfUsername) {
	const dbPath = join(decryptedDir, "contact", "contact.db");
	let db = null;
	try {
		db = new DatabaseSync(dbPath, { readOnly: true });
		const row = db.prepare("SELECT username, nick_name, remark, chat_room_notify, flag FROM contact WHERE username=?").get(username);
		if (!row) return { group: null };
		const name = cellText$2(row["nick_name"]).trim() || username;
		const remark = cellText$2(row["remark"]).trim();
		const notify = Number(row["chat_room_notify"] ?? 1);
		const flag = Number(row["flag"] ?? 0);
		const cr = db.prepare("SELECT owner FROM chat_room WHERE username=?").get(username);
		const info = db.prepare("SELECT announcement_, announcement_editor_, announcement_publish_time_ FROM chat_room_info_detail WHERE username_=?").get(username);
		const members = [];
		let totalMembers = 0;
		const roomRow = db.prepare("SELECT id, ext_buffer FROM chat_room WHERE username=?").get(username);
		const roomId = roomRow?.id;
		const roomExt = roomRow?.ext_buffer;
		const selfClean = selfUsername ? cleanWxid$2(selfUsername) : "";
		const seenMembers = /* @__PURE__ */ new Set();
		const pushMember = (mUsername, r) => {
			if (!mUsername || seenMembers.has(mUsername)) return;
			seenMembers.add(mUsername);
			const member = {
				username: mUsername,
				name: r ? cellText$2(r["remark"]).trim() || cellText$2(r["nick_name"]).trim() || mUsername : mUsername
			};
			if (r) {
				const head = cellText$2(r["small_head_url"]).trim() || cellText$2(r["big_head_url"]).trim();
				if (head) member.head = head;
				const eb = r["extra_buffer"];
				const ebBuf = eb instanceof Uint8Array ? Buffer.from(eb) : typeof eb === "string" && eb.length > 0 ? Buffer.from(eb, "utf8") : Buffer.alloc(0);
				if (ebBuf.length > 0) {
					const extra = parseContactExtra(ebBuf);
					if (extra.signature) {
						const clean = cleanProfileText(extra.signature);
						if (clean) member.signature = clean;
					}
					if (mUsername.endsWith("@openim") && member.name === mUsername && extra.wordingId) {
						const w = openimNames(decryptedDir).get(extra.wordingId);
						if (w) member.name = w;
					}
					if (extra.gender !== void 0) member.gender = extra.gender;
					const region = buildRegion(extra.country ?? "", extra.province ?? "", extra.city ?? "");
					if (region) member.region = region;
				}
			}
			if (selfClean && cleanWxid$2(mUsername) === selfClean) member.isSelf = true;
			members.push(member);
		};
		if (roomId !== void 0) try {
			const rows = db.prepare("SELECT c.username, c.nick_name, c.remark, c.small_head_url, c.big_head_url, c.extra_buffer FROM chatroom_member m LEFT JOIN contact c ON c.id = m.member_id WHERE m.room_id = ? ORDER BY m.rowid").all(roomId);
			for (const r of rows) {
				const mUsername = cellText$2(r["username"]);
				if (mUsername) pushMember(mUsername, r);
			}
		} catch {}
		let snapCount = 0;
		const extBuf = roomExt instanceof Uint8Array ? Buffer.from(roomExt) : typeof roomExt === "string" && roomExt.length > 0 ? Buffer.from(roomExt, "utf8") : Buffer.alloc(0);
		if (extBuf.length > 0) {
			const snap = parseChatRoomExtBuffer(extBuf);
			snapCount = snap.length;
			const contactStmt = db.prepare("SELECT username, nick_name, remark, small_head_url, big_head_url, extra_buffer FROM contact WHERE username=?");
			for (const s of snap) {
				if (!s.username || seenMembers.has(s.username)) continue;
				let c;
				try {
					c = contactStmt.get(s.username);
				} catch {
					c = void 0;
				}
				pushMember(s.username, c);
			}
		}
		totalMembers = Math.max(snapCount, seenMembers.size);
		let myAlias;
		const selfRow = members.find((m) => m.isSelf);
		if (selfRow) myAlias = selfRow.name;
		const group = {
			username,
			name,
			remark,
			announcement: cellText$2(info?.announcement_ ?? "").trim(),
			totalMembers,
			members,
			settings: {
				muted: notify === 0,
				pinned: (flag & 2048) !== 0,
				savedToContacts: false,
				showMemberNickname: true
			}
		};
		if (cr) {
			const owner = cellText$2(cr.owner).trim();
			if (owner) group.owner = owner;
		}
		if (info) {
			const editor = cellText$2(info.announcement_editor_).trim();
			if (editor) group.announcementEditor = editor;
			const pubTime = Number(info.announcement_publish_time_ ?? 0);
			if (pubTime > 0) group.announcementTime = pubTime;
		}
		if (myAlias) group.myAlias = myAlias;
		return { group };
	} finally {
		try {
			db?.close();
		} catch {}
	}
}
//#endregion
//#region lib/types/query/payments.js
/**
* Payment authoritative status (转账/红包) from general.db — richer than the
* message XML: transferTable / redEnvelopeTable carry state + clocks.
*/
function readText(v) {
	if (v === null || v === void 0) return "";
	if (typeof v === "string") return v;
	if (typeof v === "number" || typeof v === "boolean" || typeof v === "bigint" || typeof v === "symbol") return String(v);
	return "";
}
/**
* Look up one payment record by its message server_id.
* @param decryptedDir - decrypted data root.
* @param serverId - server_id as string (may exceed 2^53).
* @returns authoritative status (found=false when absent).
*/
function queryPaymentStatus(decryptedDir, serverId) {
	const dbPath = join(decryptedDir, "general", "general.db");
	if (!existsSync(dbPath)) return { found: false };
	const db = new DatabaseSync(dbPath, { readOnly: true });
	try {
		const sid = serverId;
		const t = db.prepare("SELECT transfer_id AS tid, pay_sub_type AS pst, pay_receiver AS rcv, pay_payer AS pay, begin_transfer_time AS bt, last_modified_time AS lmt, invalid_time AS it, delay_confirm_flag AS dcf FROM transferTable WHERE CAST(message_server_id AS TEXT) = ? LIMIT 1").get(sid);
		if (t) return {
			found: true,
			kind: "transfer",
			serverId: sid,
			transfer: {
				transferId: readText(t.tid),
				paySubType: Number(t.pst ?? 0),
				receiver: readText(t.rcv),
				payer: readText(t.pay),
				beginTime: Number(t.bt ?? 0),
				lastModifiedTime: Number(t.lmt ?? 0),
				invalidTime: Number(t.it ?? 0),
				delayConfirm: Number(t.dcf ?? 0) !== 0
			}
		};
		const r = db.prepare("SELECT sender_user_name AS snd, hb_status AS hs, hb_type AS ht, receive_status AS rs, send_id AS sid2 FROM redEnvelopeTable WHERE CAST(message_server_id AS TEXT) = ? LIMIT 1").get(sid);
		if (r) return {
			found: true,
			kind: "redpacket",
			serverId: sid,
			redpacket: {
				sender: readText(r.snd),
				hbStatus: Number(r.hs ?? 0),
				hbType: Number(r.ht ?? 0),
				receiveStatus: Number(r.rs ?? 0),
				sendId: readText(r.sid2)
			}
		};
		return { found: false };
	} finally {
		db.close();
	}
}
//#endregion
//#region lib/types/query/contacts.js
/**
* Contact queries over st_control's decrypted contact.db, mirroring the Rust
* modules/contacts.rs: full category semantics (friend/group/official/service/
* enterprise/member/system/deleted), pinyin initials, group owner + member
* counts, member's owning group, and category stats.
*/
function tableColumns$10(db, table) {
	const rows = db.prepare(`PRAGMA table_info(${table})`).all();
	return new Set(rows.map((r) => r.name));
}
/** Stringify an SQLite cell (TEXT/NUMBER/BLOB) to a string. */
function cellString$7(v) {
	if (v === null || v === void 0) return "";
	if (typeof v === "string") return v;
	if (v instanceof Uint8Array) return new TextDecoder("utf-8", { fatal: false }).decode(v);
	if (typeof v === "number" || typeof v === "boolean" || typeof v === "bigint" || typeof v === "symbol") return String(v);
	return "";
}
/** Official-account check: gh_ prefix (source is_official_account). */
function isOfficialAccount(username) {
	return username.startsWith("gh_") || username.includes("gh_");
}
/** Builtin notification accounts (source is_builtin_account). */
function isBuiltinAccount(username) {
	const s = username.toLowerCase();
	return s === "weixin" || s === "notifymessage" || s === "cmdamount" || s === "floatbottle" || s === "fmessage" || s === "medianote" || s === "qmessage" || s.startsWith("weixin_");
}
/** Source category_of: six mutually exclusive categories by local_type + username. */
function categoryOf(localType, username, deleteFlag) {
	if (deleteFlag !== 0 || localType === 4) return "deleted";
	if (username.endsWith("@chatroom")) return "group";
	if (isOfficialAccount(username)) return "official";
	if (isBuiltinAccount(username)) return "system";
	if (username.endsWith("@kefu.openim")) return "service";
	if (username.endsWith("@openim")) return "enterprise";
	if (localType === 3) return "friend";
	return "member";
}
/** Source category_label. */
function categoryLabel(category) {
	switch (category) {
		case "friend": return "联系人";
		case "enterprise": return "企业微信联系人";
		case "group": return "群聊";
		case "service": return "服务号";
		case "official": return "公众号";
		case "member": return "群成员";
		case "system": return "系统";
		case "deleted": return "已删除";
		default: return "其他";
	}
}
/** Source initial_of: remark initial > nick initial > display first char. */
function initialOf(remarkInitial, nickInitial, display) {
	const ch = (remarkInitial || nickInitial || display).slice(0, 1).toUpperCase();
	if (/[A-Z]/.test(ch)) return ch;
	return "#";
}
function queryContacts(decryptedDir, options) {
	const limit = options?.limit;
	const offset = options?.offset ?? 0;
	return cachedBySig("contacts:" + decryptedDir + ":" + String(limit ?? "") + ":" + String(offset), fileSigOf(join(decryptedDir, "contact", "contact.db")), () => computeContacts(decryptedDir, limit, offset));
}
function computeContacts(decryptedDir, limit, offset = 0) {
	const db = new DatabaseSync(join(decryptedDir, "contact", "contact.db"), { readOnly: true });
	try {
		const cols = tableColumns$10(db, "contact");
		const sel = (c, dft) => cols.has(c) ? c : dft;
		const sql = [
			"SELECT",
			[
				sel("id", "0"),
				sel("username", "''"),
				sel("local_type", "0"),
				sel("alias", "''"),
				sel("delete_flag", "0"),
				sel("remark", "''"),
				sel("remark_pin_yin_initial", "''"),
				sel("nick_name", "''"),
				sel("pin_yin_initial", "''"),
				sel("quan_pin", "''"),
				sel("remark_quan_pin", "''"),
				sel("big_head_url", "''"),
				sel("small_head_url", "''"),
				sel("description", "''"),
				sel("is_in_chat_room", "0")
			].join(", "),
			"FROM contact"
		].join(" ");
		const rows = db.prepare(sql).all();
		const roomOwners = /* @__PURE__ */ new Map();
		const roomUsernames = /* @__PURE__ */ new Map();
		const memberCounts = /* @__PURE__ */ new Map();
		const memberRooms = /* @__PURE__ */ new Map();
		try {
			const crCols = tableColumns$10(db, "chat_room");
			const crSel = (c, dft) => crCols.has(c) ? c : dft;
			const rooms = db.prepare(`SELECT ${crSel("id", "0")} AS id, ${crSel("username", "''")} AS u, ${crSel("owner", "''")} AS o FROM chat_room`).all();
			for (const r of rooms) {
				roomUsernames.set(r.id, r.u);
				if (r.o) roomOwners.set(r.id, r.o);
			}
			const cmCols = tableColumns$10(db, "chatroom_member");
			if (cmCols.has("room_id") && cmCols.has("member_id")) {
				const members = db.prepare("SELECT room_id, member_id FROM chatroom_member").all();
				for (const m of members) {
					const rid = m.room_id;
					memberCounts.set(rid, (memberCounts.get(rid) ?? 0) + 1);
					memberRooms.set(m.member_id, rid);
				}
			}
		} catch {}
		const bizTypes = /* @__PURE__ */ new Map();
		try {
			const biCols = tableColumns$10(db, "biz_info");
			if (biCols.has("username") && biCols.has("type")) {
				const biz = db.prepare("SELECT username, type FROM biz_info").all();
				for (const b of biz) bizTypes.set(b.username, b.type);
			}
		} catch {}
		const contacts = [];
		const stats = {
			friend: 0,
			enterprise: 0,
			group: 0,
			official: 0,
			service: 0,
			member: 0,
			system: 0,
			deleted: 0
		};
		for (const r of rows) {
			const id = Number(r[sel("id", "0")] ?? 0);
			const username = cellString$7(r[sel("username", "")]);
			if (!username) continue;
			const nickName = cellString$7(r[sel("nick_name", "")]);
			const remark = cellString$7(r[sel("remark", "")]);
			const localType = Number(r[sel("local_type", "0")] ?? 0);
			let category = categoryOf(localType, username, Number(r[sel("delete_flag", "0")] ?? 0));
			if (category === "official") {
				const bt = bizTypes.get(username);
				if (bt === 1 || bt === 3 || bt === 5) category = "service";
			}
			const displayName = remark || nickName || username;
			const initial = initialOf(cellString$7(r[sel("remark_pin_yin_initial", "")]), cellString$7(r[sel("pin_yin_initial", "")]), displayName);
			stats[category] = (stats[category] ?? 0) + 1;
			const isGroup = category === "group";
			const contact = {
				username,
				nickName,
				remark,
				displayName,
				alias: cellString$7(r[sel("alias", "")]),
				category,
				localTypeLabel: categoryLabel(category),
				initial,
				quanPin: cellString$7(r[sel("quan_pin", "")]),
				remarkQuanPin: cellString$7(r[sel("remark_quan_pin", "")]),
				description: cellString$7(r[sel("description", "")]),
				inChatRoom: Number(r[sel("is_in_chat_room", "0")] ?? 0) === 1,
				localType
			};
			const avatar = cellString$7(r[sel("big_head_url", "")]) || cellString$7(r[sel("small_head_url", "")]);
			if (avatar) contact.avatarUrl = avatar;
			if (isGroup) {
				const mc = memberCounts.get(id);
				if (mc !== void 0) contact.memberCount = mc;
				const owner = roomOwners.get(id);
				if (owner) contact.owner = owner;
			} else if (category === "member") {
				const rid = memberRooms.get(id);
				if (rid !== void 0) {
					const gname = roomUsernames.get(rid) ?? "";
					if (gname) contact.groupUsername = gname;
					if (gname) contact.groupName = gname;
				}
			}
			contacts.push(contact);
		}
		contacts.sort((a, b) => (a.initial ?? "").localeCompare(b.initial ?? "") || (a.quanPin ?? "").localeCompare(b.quanPin ?? "") || a.displayName.localeCompare(b.displayName));
		const total = contacts.length;
		return {
			contacts: limit !== void 0 ? contacts.slice(offset, offset + limit) : contacts,
			total,
			stats
		};
	} finally {
		db.close();
	}
}
//#endregion
//#region lib/types/query/region-map.js
/**
* Friend-region map (世界板块地图) query.
*
* Reads decrypted contact.db, parses each contact's extra_buffer region
* (country / province / city) and builds a hierarchy
* 世界 → 国家 → 省 → 市 → 好友. Only friends (category 'friend') with a
* resolvable country are counted; contacts missing a province / city are
* nested into synthetic 「省份未填」 / 「城市未填」 buckets so the world treemap
* always drills to a friends list at the city level.
*/
/** One region node with a running count; children/friends are populated after. */
function makeNode(name, count) {
	return {
		key: name,
		name,
		count,
		children: [],
		friends: []
	};
}
/**
* Query the friend-region map.
* @param decryptedDir - decrypted data root.
* @returns the region map snapshot (world → countries → provinces → cities).
*/
function queryRegionMap(decryptedDir) {
	const dbPath = join(decryptedDir, "contact", "contact.db");
	const rows = [];
	let unknown = 0;
	try {
		const db = new DatabaseSync(dbPath, { readOnly: true });
		try {
			const cols = db.prepare("PRAGMA table_info(contact)").all().map((r) => r.name);
			const has = (c) => cols.includes(c) ? c : "NULL";
			const sql = "SELECT " + [
				has("username"),
				has("local_type"),
				has("alias"),
				has("delete_flag"),
				has("remark"),
				has("nick_name"),
				has("big_head_url"),
				has("small_head_url"),
				has("extra_buffer")
			].join(", ") + " FROM contact";
			const raw = db.prepare(sql).all();
			for (const r of raw) {
				const username = str$1(r[has("username")]);
				if (!username) continue;
				const localType = Number(r[has("local_type")] ?? 0);
				if (Number(r[has("delete_flag")] ?? 0) !== 0 || localType !== 1) continue;
				if (username.endsWith("@chatroom") || username.includes("gh_") || username.includes("@kefu.openim") || username.endsWith("@openim") || /^(weixin|notifymessage|fmessage|newsapp)/.test(username)) continue;
				const extraBuf = toBuffer(r[has("extra_buffer")]);
				const extra = extraBuf.length > 0 ? parseContactExtra(extraBuf) : null;
				const country = regionLabel("country", extra?.country ?? "");
				const province = extra?.province ? regionLabel("province", extra.province) : "";
				const city = extra?.city ? regionLabel("city", extra.city) : "";
				if (!country) {
					unknown += 1;
					continue;
				}
				const remark = str$1(r[has("remark")]).trim();
				const nick = str$1(r[has("nick_name")]).trim();
				const row = {
					username,
					displayName: remark || nick || username,
					remark,
					nickName: nick,
					country,
					province,
					city
				};
				const head = str$1(r[has("small_head_url")]).trim() || str$1(r[has("big_head_url")]).trim();
				if (head) row.avatarUrl = head;
				rows.push(row);
			}
		} finally {
			db.close();
		}
	} catch {}
	const countries = /* @__PURE__ */ new Map();
	for (const row of rows) {
		let country = countries.get(row.country);
		if (!country) {
			country = makeNode(row.country, 0);
			countries.set(row.country, country);
		}
		country.count += 1;
		const pName = row.province || "省份未填";
		let province = country.children.find((n) => n.key === pName);
		if (!province) {
			province = makeNode(pName, 0);
			country.children.push(province);
		}
		province.count += 1;
		const cName = row.city || "城市未填";
		let city = province.children.find((n) => n.key === cName);
		if (!city) {
			city = makeNode(cName, 0);
			province.children.push(city);
		}
		city.count += 1;
		city.friends.push({
			username: row.username,
			displayName: row.displayName,
			remark: row.remark,
			nickName: row.nickName,
			...row.avatarUrl ? { avatarUrl: row.avatarUrl } : {}
		});
	}
	const sortNode = (n) => {
		n.children.sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
		for (const c of n.children) sortNode(c);
	};
	const worldChildren = Array.from(countries.values());
	const world = {
		key: "世界",
		name: "世界",
		count: rows.length,
		children: worldChildren,
		friends: []
	};
	sortNode(world);
	return {
		total: rows.length,
		unknown,
		world
	};
}
/** Coerce a DB cell to string. */
function str$1(v) {
	if (v === null || v === void 0) return "";
	if (typeof v === "string") return v;
	if (v instanceof Uint8Array) return new TextDecoder("utf-8", { fatal: false }).decode(v);
	return "";
}
/** Coerce a BLOB cell to a Buffer (empty when null/other). */
function toBuffer(v) {
	if (v instanceof Uint8Array) return Buffer.from(v);
	if (typeof v === "string" && v.length > 0) return Buffer.from(v, "utf8");
	return Buffer.alloc(0);
}
//#endregion
//#region lib/types/query/parse.js
function stripCdata(value) {
  const t = value.trim();
  const m = t.match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/);
  return m ? m[1] ?? "" : value;
}
function stripXmlTags$1(xml) {
  if (!xml) return "";
  return xml.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
}
function unescapeXmlEntities(s) {
  if (!s || s.indexOf("&") < 0) return s;
  return s.replace(/&#x([0-9a-fA-F]+);/g, (_m, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (_m, d) => String.fromCodePoint(Number(d))).replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&");
}
function xmlTagText$2(xml, tag) {
  const open = "<" + tag;
  const si = xml.indexOf(open);
  if (si < 0) return "";
  const gt = xml.indexOf(">", si);
  if (gt < 0) return "";
  const close = "</" + tag;
  const ei = xml.indexOf(close, gt);
  if (ei < 0) return "";
  return stripCdata(xml.slice(gt + 1, ei));
}
function xmlAttr(xml, tag, attr) {
  const m = xml.match(new RegExp(`<\\s*${tag}[^>]*\\b${attr}=\\s*["']([^"']*)["']`));
  return m ? m[1] ?? "" : "";
}
function xmlTagOrAttr(xml, name) {
  const t = xmlTagText$2(xml, name);
  if (t) return t;
  const m = xml.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, "i"));
  return m ? m[1] ?? "" : "";
}
function extractXmlTextNodes(xml) {
  if (!xml) return "";
  const parts = [];
  for (const m of xml.matchAll(/<!\[CDATA\[([\s\S]*?)\]\]>|>([^<]+)</g)) {
    const v = (m[1] ?? m[2] ?? "").trim();
    if (v) parts.push(v);
  }
  return parts.join(" ").replace(/\s+/g, " ").trim();
}
function cleanRichText(s) {
  const v = (s ?? "").trim();
  if (!v) return "";
  if (!/&lt;|<\?xml|<msg\b|<img\b|<appmsg\b|<videomsg\b|<voicemsg\b|<emoji\b/.test(v)) return unescapeXmlEntities(v);
  const xml = v.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
  return xml.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}
function richFallbackLabel(type) {
  switch (type) {
    case "quote":
      return "";
    case "chatlog":
      return "[\u804A\u5929\u8BB0\u5F55]";
    case "unsupported":
      return "[\u8BE5\u6D88\u606F\u7C7B\u578B\u6682\u4E0D\u652F\u6301\u9884\u89C8]";
    default:
      return "";
  }
}
const RICH_TO_RENDER = {
  image: "image",
  voice: "voice",
  video: "video",
  emoji: "emoji",
  location: "location",
  contact: "contactCard",
  file: "file",
  link: "link",
  newsfeed: "link",
  quote: "quote",
  miniapp: "miniapp",
  channels: "channels",
  live: "live",
  music: "music",
  product: "product",
  card: "card",
  note: "note",
  sticker: "sticker",
  announcement: "announcement",
  solitaire: "solitaire",
  chatlog: "chatlog",
  transfer: "transfer",
  redpacket: "redpacket",
  call: "voip",
  pat: "pat",
  unsupported: "unsupported",
  appmsg: "link"
};
const TYPE_TO_RENDER = {
  1: "text",
  3: "image",
  34: "voice",
  42: "contactCard",
  43: "video",
  47: "emoji",
  48: "location",
  49: "link",
  50: "voip",
  66: "contactCard",
  1e4: "system",
  11e3: "empty",
  859832288: "pat",
  922746960: "pat",
  244135593199: "miniapp",
  244: "file",
  246: "file"
};
const RENDER_LABEL = {
  text: "\u6587\u672C",
  image: "\u56FE\u7247",
  voice: "\u8BED\u97F3",
  video: "\u89C6\u9891",
  emoji: "\u8868\u60C5",
  location: "\u4F4D\u7F6E",
  contactCard: "\u540D\u7247",
  file: "\u6587\u4EF6",
  link: "\u94FE\u63A5",
  quote: "\u5F15\u7528",
  miniapp: "\u5C0F\u7A0B\u5E8F",
  channels: "\u89C6\u9891\u53F7",
  live: "\u76F4\u64AD",
  music: "\u97F3\u4E50",
  product: "\u5546\u54C1",
  card: "\u5361\u7247",
  note: "\u7B14\u8BB0",
  sticker: "\u8868\u60C5",
  announcement: "\u7FA4\u516C\u544A",
  solitaire: "\u63A5\u9F99",
  chatlog: "\u804A\u5929\u8BB0\u5F55",
  transfer: "\u8F6C\u8D26",
  redpacket: "\u7EA2\u5305",
  voip: "\u901A\u8BDD",
  pat: "\u62CD\u4E00\u62CD",
  system: "\u7CFB\u7EDF\u6D88\u606F",
  revoke: "\u64A4\u56DE\u6D88\u606F",
  empty: "\u65E0\u5185\u5BB9\u6D88\u606F",
  unknown: "\u672A\u77E5\u6D88\u606F"
};
function classifyRender(msgType, rich, sysKind) {
  if (msgType === 1e4) return sysKind === "revoke" ? "revoke" : "system";
  const richType = rich && typeof rich.type === "string" ? rich.type : "";
  if (richType === "appmsg") return rich && rich.url ? "link" : "text";
  if (richType && RICH_TO_RENDER[richType]) return RICH_TO_RENDER[richType];
  const fallback = TYPE_TO_RENDER[msgType];
  return fallback ?? "unknown";
}
function parseSolitaire(app) {
  const info = xmlTagText$2(app, "solitaire_info");
  const members = [];
  if (!info || !info.includes("<solitaire")) return { members, declared: 0 };
  const contentStart = info.indexOf("<content>");
  if (contentStart < 0) return { members, declared: 0 };
  const contentEnd = info.indexOf("</content>", contentStart);
  const body = info.slice(contentStart + 9, contentEnd > 0 ? contentEnd : info.length);
  const re = /<i>([\s\S]*?)<\/i>/g;
  let m;
  while (m = re.exec(body)) {
    const item = m[1] ?? "";
    const username = xmlTagText$2(item, "u");
    const content = unescapeXmlEntities(xmlTagText$2(item, "c"));
    const ts = Number(xmlTagText$2(item, "t")) || 0;
    if (username || content) members.push({ idx: members.length + 1, username, content, ts });
  }
  const firstItem = body.indexOf("<i>");
  const head = body.slice(0, firstItem < 0 ? body.length : firstItem);
  const dm = /<s>(\d+)<\/s>/.exec(head);
  return { members, declared: dm ? Number(dm[1]) : 0 };
}
function stripRefMsgText(text, name) {
  if (!text) return "";
  let t = text.trim().replace(/^["“]/, "").replace(/["”]$/, "").trim();
  if (name && t.startsWith(name)) t = t.slice(name.length).replace(/^[：:]\s*/, "").trim();
  return t;
}
function quoteTypePlaceholder(type) {
  switch (type) {
    case 3:
      return "[\u56FE\u7247]";
    case 34:
      return "[\u8BED\u97F3]";
    case 43:
      return "[\u89C6\u9891]";
    case 47:
      return "[\u8868\u60C5]";
    case 48:
      return "[\u4F4D\u7F6E]";
    case 42:
      return "[\u540D\u7247]";
    case 50:
      return "[\u901A\u8BDD]";
    case 1e4:
      return "[\u7CFB\u7EDF\u6D88\u606F]";
    case 49:
      return "[\u5E94\u7528\u6D88\u606F]";
    default:
      return "";
  }
}
const QUOTE_APP_LABEL = {
  2: "\u5546\u54C1",
  3: "\u97F3\u4E50",
  4: "\u89C6\u9891\u53F7",
  5: "\u94FE\u63A5",
  6: "\u6587\u4EF6",
  8: "\u8868\u60C5",
  19: "\u804A\u5929\u8BB0\u5F55",
  24: "\u7B14\u8BB0",
  33: "\u5C0F\u7A0B\u5E8F",
  36: "\u5C0F\u7A0B\u5E8F",
  42: "\u540D\u7247",
  50: "\u7248\u672C\u4E0D\u652F\u6301",
  51: "\u89C6\u9891\u53F7",
  53: "\u63A5\u9F99",
  57: "\u5F15\u7528",
  62: "\u62CD\u4E00\u62CD",
  63: "\u76F4\u64AD",
  68: "\u94FE\u63A5",
  74: "\u6587\u4EF6",
  87: "\u7FA4\u516C\u544A",
  88: "\u76F4\u64AD",
  2e3: "\u8F6C\u8D26",
  2001: "\u7EA2\u5305",
  2003: "\u7EA2\u5305"
};
function summarizeQuotedXml(xml) {
  let text = (xml ?? "").trim();
  const pos = text.indexOf(":\n");
  if (pos > 0 && pos <= 64 && !text.slice(0, pos).includes(" ") && !text.slice(0, pos).includes("<")) text = text.slice(pos + 2).trim();
  if (!text.startsWith("<")) return unescapeXmlEntities(text);
  if (text.includes("<appmsg")) {
    const appType = Number((/<appmsg[\s\S]*?<type>(\d+)<\/type>/.exec(text) ?? [])[1] ?? 0);
    const title = cleanRichText(xmlTagText$2(text, "title"));
    if (appType === 2e3) return title ? `[\u8F6C\u8D26] ${title}` : "[\u8F6C\u8D26]";
    if (appType === 2001 || appType === 2003) return title ? `[\u7EA2\u5305] ${title}` : "[\u7EA2\u5305]";
    const label = QUOTE_APP_LABEL[appType];
    if (label) {
      const summary = title || cleanRichText(xmlTagText$2(text, "des"));
      return summary ? `[${label}] ${summary}` : `[${label}]`;
    }
  }
  const MEDIA = [
    [/<img\b/, "[\u56FE\u7247]"],
    [/<voicemsg\b/, "[\u8BED\u97F3]"],
    [/<videomsg\b/, "[\u89C6\u9891]"],
    [/<emoji\b/, "[\u8868\u60C5]"],
    [/<location\b/, "[\u4F4D\u7F6E]"],
    [/<contact\b/, "[\u540D\u7247]"],
    [/<voipmsg\b/, "[\u901A\u8BDD]"]
  ];
  for (const [re, label] of MEDIA) if (re.test(text)) return label;
  const stripped = cleanRichText(text);
  return stripped ? stripped.slice(0, 200) : "";
}
function quotedThumbUrl(raw) {
  let candidate = (raw ?? "").trim();
  if (!candidate) return "";
  const colon = candidate.indexOf(":");
  if (candidate.startsWith("wxid_") && colon > 0 && colon <= 64) candidate = candidate.slice(colon + 1).trim();
  for (const key of ["thumburl", "cdnthumburl", "cdnthumurl", "coverurl", "cover"]) {
    const v = xmlTagOrAttr(candidate, key);
    if (v) return unescapeXmlEntities(v);
  }
  return "";
}
function parseCallDuration(text) {
  const m = /(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(text);
  if (!m) return void 0;
  const a = Number(m[1] ?? 0);
  const b = Number(m[2] ?? 0);
  return m[3] === void 0 ? a * 60 + b : a * 3600 + b * 60 + Number(m[3]);
}
const CALL_ANSWERED_ELSEWHERE = /已在其它设备接听/;
function classifyCallStatus(status, connected) {
  const s = status || "";
  if (connected) return "connected";
  if (s.includes("\u5DF2\u53D6\u6D88") || s.includes("\u5BF9\u65B9\u5DF2\u53D6\u6D88")) return "cancelled";
  if (s.includes("\u5DF2\u62D2\u7EDD")) return "rejected";
  if (s.includes("\u672A\u5E94\u7B54")) return "no-answer";
  if (s.includes("\u5FD9\u7EBF")) return "busy";
  if (s.includes("\u4E2D\u65AD")) return "interrupted";
  if (s.includes("\u672A\u63A5\u542C") || s.includes("\u672A\u63A5\u901A")) return "missed";
  return "unknown";
}
function parseVoipKind(roomType) {
  const v = (roomType ?? "").trim();
  if (v === "0") return "video";
  if (v === "1") return "audio";
  return "";
}
const IMAGE_GROUP_ID = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{32})$/i;
function parseImageGroup(xml) {
  if (!xml || !xml.includes("<groupinfo")) return null;
  const start = xml.indexOf("<groupinfo");
  const end = xml.indexOf("</groupinfo", start);
  if (start < 0 || end < 0) return null;
  const block = xml.slice(start, end);
  const type = xmlTagText$2(block, "type").trim();
  const id = xmlTagText$2(block, "id").trim();
  const count = Number(xmlTagText$2(block, "count").trim());
  if (!type || !id || !IMAGE_GROUP_ID.test(id)) return null;
  if (!Number.isFinite(count) || count < 2) return null;
  return { id: id.toLowerCase(), count, type };
}
function parseAppmsgType(xml) {
  const probe = xml ?? "";
  const m = probe.match(/<appmsg\b[^>]*>([\s\S]*?)<\/appmsg>/i);
  let inner = m ? m[1] ?? "" : probe;
  inner = inner.replace(/<refermsg\b[^>]*>[\s\S]*?<\/refermsg>/gi, "").replace(/<patmsg\b[^>]*>[\s\S]*?<\/patmsg>/gi, "").replace(/<recorditem\b[^>]*>[\s\S]*?<\/recorditem>/gi, "").replace(/<weappinfo\b[^>]*>[\s\S]*?<\/weappinfo>/gi, "").replace(/<wxaappinfo\b[^>]*>[\s\S]*?<\/wxaappinfo>/gi, "");
  const t = Number(xmlTagText$2(inner, "type"));
  return Number.isFinite(t) ? t : 0;
}
function classifyLinkShare(url, sourceUsername, desc, appType) {
  const src = (sourceUsername || "").toLowerCase();
  let host = "";
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    host = "";
  }
  const isArticle = (appType === 5 || appType === 68) && (host === "mp.weixin.qq.com" || host.endsWith(".mp.weixin.qq.com") || src.startsWith("gh_"));
  const linkType = isArticle ? "official_article" : "web_link";
  const hashtags = (desc.match(/#[^#\s]+/g) ?? []).length;
  const feedLike = /exptype=masonry_feed/i.test(url);
  const coverLike = isArticle && (desc.trimStart().startsWith("#") || hashtags >= 2 || feedLike);
  return [linkType, coverLike ? "cover" : "default"];
}
function parseFileAttach(app) {
  const size = xmlTagText$2(app, "totallen") || xmlTagOrAttr(app, "filesize");
  const ext = xmlTagText$2(app, "fileext");
  const md5 = xmlTagOrAttr(app, "md5") || xmlTagOrAttr(app, "filemd5") || xmlTagOrAttr(app, "file_md5");
  return { size: size || "", ext: ext || "", md5: md5 || "" };
}
function channelsRich(app, title, des, url, thumb, source, sourceUsername, base) {
  const feed = xmlTagText$2(app, "finderFeed");
  const feedDesc = unescapeXmlEntities(
    (feed ? xmlTagText$2(feed, "desc") : "") || xmlTagText$2(app, "finderdesc") || des
  );
  const nick = unescapeXmlEntities(
    xmlTagText$2(app, "findernickname") || (feed ? xmlTagText$2(feed, "nickname") || xmlTagText$2(feed, "findernickname") : "")
  );
  const user = xmlTagText$2(app, "finderusername") || (feed ? xmlTagText$2(feed, "username") || xmlTagText$2(feed, "finderusername") : "");
  const objectId = (feed ? xmlTagOrAttr(feed, "objectid") : "") || xmlTagOrAttr(app, "objectid");
  const objectNonce = (feed ? xmlTagOrAttr(feed, "objectnonceid") : "") || xmlTagOrAttr(app, "objectnonceid");
  let displayTitle = title;
  if (!displayTitle || displayTitle.includes("\u4E0D\u652F\u6301")) displayTitle = feedDesc || des;
  const rich = {
    type: "channels",
    title: displayTitle || "[\u89C6\u9891\u53F7]",
    desc: feedDesc || displayTitle || "",
    url: url || (feed ? xmlTagText$2(feed, "url") : "") || xmlTagText$2(app, "playurl"),
    ...base
  };
  const from = nick || source;
  if (from) rich.source = from;
  if (user || sourceUsername) rich.sourceUsername = user || sourceUsername;
  if (objectId) rich.objectId = objectId;
  if (objectNonce) rich.objectNonceId = objectNonce;
  return rich;
}
function parseAppmsg(xml) {
  const app = xml;
  const appType = parseAppmsgType(app);
  const title = unescapeXmlEntities(xmlTagText$2(app, "title"));
  const des = unescapeXmlEntities(xmlTagText$2(app, "des") || xmlTagText$2(app, "desc"));
  const url = unescapeXmlEntities(xmlTagText$2(app, "url"));
  const thumb = xmlTagText$2(app, "thumburl") || xmlTagText$2(app, "tpthumburl") || xmlAttr(app, "img", "cdnthumburl") || xmlTagOrAttr(app, "cdnthumburl") || xmlTagOrAttr(app, "coverurl") || xmlTagOrAttr(app, "cover") || "";
  const source = unescapeXmlEntities(
    xmlTagText$2(app, "sourcedisplayname") || xmlTagText$2(app, "sourcedisplaynick") || xmlTagText$2(app, "appname") || ""
  );
  const sourceUsername = xmlTagText$2(app, "sourceusername") || "";
  const base = {};
  if (source) base.source = source;
  if (thumb) base.thumb = unescapeXmlEntities(thumb);
  switch (appType) {
    case 6:
    case 74: {
      const fileRich = { type: "file", title, desc: des, url, ...base };
      const attach = parseFileAttach(app);
      if (attach.size) fileRich.fileSize = attach.size;
      if (attach.ext) fileRich.fileExt = attach.ext;
      if (attach.md5) fileRich.fileMd5 = attach.md5;
      return fileRich;
    }
    case 5:
    case 68: {
      const [linkType, linkStyle] = classifyLinkShare(url, sourceUsername, des, appType);
      const link = { type: "link", title, desc: des, url, linkType, linkStyle, ...base };
      if (sourceUsername) link.sourceUsername = sourceUsername;
      return link;
    }
    case 4: {
      if (url && !/<finderFeed/i.test(app)) {
        const [linkType, linkStyle] = classifyLinkShare(url, sourceUsername, des, appType);
        const link = { type: "link", title, desc: des, url, linkType, linkStyle, ...base };
        if (sourceUsername) link.sourceUsername = sourceUsername;
        return link;
      }
      return channelsRich(app, title, des, url, thumb, source, sourceUsername, base);
    }
    case 1: {
      const plain = cleanRichText(title) || cleanRichText(des);
      if (plain) return { type: "appmsg", title: plain, desc: cleanRichText(des) === plain ? "" : cleanRichText(des), ...base };
      return null;
    }
    case 3: {
      const cover = xmlTagOrAttr(app, "songalbumurl") || xmlTagOrAttr(app, "mvCoverUrl") || thumb;
      const music = { type: "music", title, desc: des, url: url || xmlTagText$2(app, "dataurl") };
      if (cover) music.thumb = unescapeXmlEntities(cover);
      if (source) music.source = source;
      return music;
    }
    case 57: {
      const refer = xmlTagText$2(app, "refermsg");
      const replyText = cleanRichText(title) || cleanRichText(des);
      let quoted = refer ? unescapeXmlEntities(xmlTagText$2(refer, "content")).trim() : "";
      const referName = refer ? unescapeXmlEntities(xmlTagText$2(refer, "displayname")).trim() : "";
      const referType = refer ? Number(xmlTagText$2(refer, "type")) || 0 : 0;
      const referTime = refer ? Number(xmlTagText$2(refer, "createtime")) || 0 : 0;
      const referSvrId = refer ? xmlTagText$2(refer, "svrid").trim() : "";
      const refText = refer ? unescapeXmlEntities(xmlTagText$2(refer, "ref_msg_text")).trim() : "";
      if (replyText && quoted) {
        if (quoted === replyText) quoted = "";
        else if (quoted.split(/\r?\n/)[0]?.trim() === replyText) quoted = quoted.split(/\r?\n/).slice(1).join("\n").trim();
        else if (quoted.startsWith(replyText)) quoted = quoted.slice(replyText.length).trim();
      }
      let desc = summarizeQuotedXml(quoted) || stripRefMsgText(refText, referName) || quoteTypePlaceholder(referType) || des;
      let thumb2;
      if (referType === 49 || referType === 5 || referType === 68) {
        const t = quotedThumbUrl(quoted);
        if (t) thumb2 = t;
        if (!desc.startsWith("[") && quoted) desc = `[\u94FE\u63A5] ${cleanRichText(quoted)}`;
      } else if (referType === 51 || referType === 4 || referType === 63) {
        const t = quotedThumbUrl(quoted);
        if (t) thumb2 = t;
      }
      const rich = { type: "quote", title: replyText || cleanRichText(title) || cleanRichText(des), desc, ...base };
      if (thumb2) rich.thumb = thumb2;
      if (referName) rich.referName = referName;
      if (referType) rich.referType = referType;
      if (referTime) rich.referTime = referTime;
      if (referSvrId) rich.referSvrId = referSvrId;
      const referUser = refer ? (xmlTagText$2(refer, "fromusr") || xmlTagText$2(refer, "chatusr")).trim() : "";
      if (referUser) rich.referUsername = referUser;
      return rich;
    }
    case 33: {
      const weapp = xmlTagText$2(app, "weappinfo") || xmlTagText$2(app, "wxaappinfo");
      const weappUser = weapp ? xmlTagText$2(weapp, "username") : "";
      const weappNick = weapp ? xmlTagText$2(weapp, "nickname") || xmlTagText$2(weapp, "appname") : "";
      const icon = (weapp ? xmlTagOrAttr(weapp, "weappiconurl") : "") || xmlTagOrAttr(app, "weappiconurl");
      const mini = { type: "miniapp", title: title || des, desc: des, url, ...base };
      if (!mini.thumb && icon) mini.thumb = unescapeXmlEntities(icon);
      const from = source || weappNick;
      if (from) mini.source = from;
      const fromUser = weappUser || sourceUsername;
      if (fromUser) mini.sourceUsername = fromUser;
      return mini;
    }
    case 36: {
      const card = { type: "card", title, desc: des, url, ...base };
      if (sourceUsername) card.sourceUsername = sourceUsername;
      return card;
    }
    case 51:
      return channelsRich(app, title, des, url, thumb, source, sourceUsername, base);
    case 53: {
      const sol = parseSolitaire(app);
      const rich = { type: "solitaire", title, desc: des, ...base };
      if (sol.members.length > 0) {
        rich.members = sol.members;
        const info = xmlTagText$2(app, "solitaire_info");
        const by = xmlTagText$2(info, "au");
        if (by) rich.by = by;
        const sid = xmlTagText$2(info, "sid");
        if (sid) rich.sid = sid;
        if (sol.declared > 0) rich.declared = sol.declared;
      }
      return rich;
    }
    case 24:
      return { type: "note", title: title || des, desc: des && title ? des : "", ...base };
    case 8:
      return { type: "sticker", title: title || xmlTagText$2(app, "md5"), md5: xmlTagText$2(app, "md5") || xmlTagText$2(app, "emoticonmd5") || "", ...base };
    case 2:
      return { type: "product", title, desc: des, url, ...base };
    case 62: {
      const patText = unescapeXmlEntities(title || des || "\u62CD\u4E86\u62CD");
      return { type: "pat", title: patText, ...base };
    }
    case 87: {
      const rawBody = xmlTagText$2(app, "textannouncement") || xmlTagText$2(app, "announcement") || xmlTagText$2(app, "content") || des || "";
      const plain = unescapeXmlEntities(stripXmlTags$1(stripCdata(rawBody)));
      return { type: "announcement", title: title || "\u7FA4\u516C\u544A", desc: plain || "", ...base };
    }
    case 63:
    case 88: {
      const cover = xmlTagOrAttr(app, "coverurl") || xmlTagOrAttr(app, "cover") || xmlTagOrAttr(app, "livecoverurl") || thumb;
      const liveStatus = xmlTagText$2(app, "livestatus") || xmlTagText$2(app, "status") || xmlTagText$2(app, "livestate");
      const liveTitle = unescapeXmlEntities(title || xmlTagText$2(app, "live_title") || des);
      const live = { type: "live", title: liveTitle || "[\u76F4\u64AD]", desc: des, url, ...base };
      if (cover) live.thumb = unescapeXmlEntities(cover);
      if (liveStatus) live.status = liveStatus.trim();
      return live;
    }
    case 50:
      return { type: "unsupported", title: title || des || "\u5F53\u524D\u5FAE\u4FE1\u7248\u672C\u4E0D\u652F\u6301\u5C55\u793A\u8BE5\u5185\u5BB9", ...base };
    case 19: {
      const rt = xmlTagText$2(app, "recorditem");
      const records = rt ? parseChatlogRecords(rt) : [];
      const preview = des || (rt ? xmlTagText$2(rt, "desc") : "");
      const chatlog = { type: "chatlog", title: title || "\u7FA4\u804A\u7684\u804A\u5929\u8BB0\u5F55" };
      if (preview) chatlog.desc = preview;
      if (records.length > 0) chatlog.records = records;
      return { ...chatlog, ...base };
    }
    case 42: {
      const cardUser = unescapeXmlEntities((xmlTagText$2(app, "username") || xmlAttr(app, "msg", "username") || xmlTagText$2(app, "fromusername")).trim());
      const cardNick = unescapeXmlEntities((xmlTagText$2(app, "nickname") || xmlAttr(app, "msg", "nickname") || xmlTagText$2(app, "displayname") || title).trim());
      const cardAlias = unescapeXmlEntities((xmlTagText$2(app, "alias") || xmlAttr(app, "msg", "alias") || xmlTagText$2(app, "remark")).trim());
      const cardAvatar = xmlTagOrAttr(app, "headimgurl") || xmlTagOrAttr(app, "smallheadimgurl") || xmlTagOrAttr(app, "headimg") || xmlTagOrAttr(app, "avatar");
      const card = { type: "contact", title: cardNick || cardUser || des || "\u540D\u7247", nickname: cardNick, username: cardUser };
      if (cardAlias) card.alias = cardAlias;
      if (cardAvatar) card.avatar = unescapeXmlEntities(cardAvatar);
      return card;
    }
    case 2e3: {
      const feedesc = unescapeXmlEntities(xmlTagOrAttr(app, "feedesc"));
      const amount = feedesc || title || "";
      const paySub = xmlTagOrAttr(app, "paysubtype");
      const recvStatus = xmlTagOrAttr(app, "receivestatus");
      const memo = unescapeXmlEntities(xmlTagOrAttr(app, "pay_memo"));
      const transfer = { type: "transfer", title: amount };
      if (paySub) transfer.paysubtype = paySub;
      if (recvStatus) transfer.receiveStatus = recvStatus;
      if (memo) transfer.desc = memo;
      return { ...transfer, ...base };
    }
    case 2001:
    case 2003: {
      const amount = unescapeXmlEntities(xmlTagOrAttr(app, "feedesc"));
      const greet = unescapeXmlEntities(title || des || xmlTagText$2(app, "sendertitle") || xmlTagText$2(app, "receivertitle") || "");
      const cover = xmlTagText$2(app, "receiverc2cshowsourceurl");
      const rp = { type: "redpacket", title: "\u5FAE\u4FE1\u7EA2\u5305" };
      if (greet) rp.desc = greet;
      if (amount) rp.amount = amount.replace(/^\s*[Y￥]/, "");
      if (cover) rp.thumb = cover;
      if (appType !== 2001) rp.paysubtype = String(appType);
      return { ...rp, ...base };
    }
    default: {
      if (title || des) return { type: "appmsg", title: title || des, desc: des, url, ...base };
      const fallback = cleanRichText(extractXmlTextNodes(app));
      if (fallback) return { type: "appmsg", title: fallback, ...base };
      return null;
    }
  }
}
function parseChatlogRecords(recordXml, depth = 0) {
  if (depth > 3) return [];
  const ri = xmlTagText$2(recordXml, "recordinfo");
  if (!ri) return [];
  const dl = xmlTagText$2(ri, "datalist");
  if (!dl) return [];
  const imageFmts = ["jpg", "jpeg", "png", "gif", "webp", "bmp", "heic", "heif"];
  const audioFmts = ["silk", "amr", "aud", "mp3", "wav", "m4a", "aac", "ogg", "opus"];
  const videoFmts = ["mp4", "mov", "m4v", "avi", "mkv", "webm"];
  const out = [];
  let pos = 0;
  let idx = 0;
  for (; ; ) {
    const s = dl.indexOf("<dataitem", pos);
    if (s < 0) break;
    const e = dl.indexOf("</dataitem>", s);
    if (e < 0) break;
    const item = dl.slice(s, e + 11);
    pos = e + 11;
    const datatype = xmlAttr(item, "dataitem", "datatype");
    const name = unescapeXmlEntities(xmlTagText$2(item, "sourcename"));
    const head = xmlTagText$2(item, "sourceheadurl");
    const time = xmlTagText$2(item, "sourcetime");
    const datatitle = unescapeXmlEntities(xmlTagText$2(item, "datatitle"));
    const datadesc = unescapeXmlEntities(xmlTagText$2(item, "datadesc"));
    const datafmt = xmlTagText$2(item, "datafmt").trim().toLowerCase().replace(/^\./, "");
    const duration = xmlTagText$2(item, "duration");
    const datasize = xmlTagText$2(item, "datasize");
    const link = xmlTagText$2(item, "link") || xmlTagText$2(item, "dataurl") || xmlTagText$2(item, "url");
    const externurl = xmlTagText$2(item, "externurl");
    const cdnurlstring = xmlTagText$2(item, "cdnurlstring");
    const encrypturlstring = xmlTagText$2(item, "encrypturlstring");
    const fullmd5 = xmlTagText$2(item, "fullmd5");
    const thumbfullmd5 = xmlTagText$2(item, "thumbfullmd5");
    const md5 = xmlTagText$2(item, "md5") || xmlTagText$2(item, "emoticonmd5");
    const fromnewmsgid = xmlTagText$2(item, "fromnewmsgid");
    const srcMsgLocalid = xmlTagText$2(item, "srcMsgLocalid") || xmlTagText$2(item, "srcMsgLocalId");
    const srcMsgCreateTime = xmlTagText$2(item, "srcMsgCreateTime");
    const nestedRaw = xmlTagText$2(item, "recordxml") || xmlTagText$2(item, "recorditem");
    if (!name && !datatitle && !datadesc && !link) {
      idx += 1;
      continue;
    }
    let renderType = "text";
    if (datatype === "17") renderType = "chatHistory";
    else if (datatype === "5" || link) renderType = "link";
    else if (datatype === "4" || videoFmts.includes(datafmt)) renderType = "video";
    else if (datatype === "3" || audioFmts.includes(datafmt)) renderType = "voice";
    else if (datatype === "47" || datatype === "37") renderType = "emoji";
    else if (datatype === "2" || imageFmts.includes(datafmt)) renderType = "image";
    let content = datatitle || datadesc;
    if (!content) {
      if (renderType === "video") content = "[\u89C6\u9891]";
      else if (renderType === "image") content = "[\u56FE\u7247]";
      else if (renderType === "voice") content = "[\u8BED\u97F3]";
      else if (renderType === "emoji") content = "[\u8868\u60C5]";
      else if (renderType === "chatHistory") content = "[\u804A\u5929\u8BB0\u5F55]";
      else content = "[\u6D88\u606F]";
    }
    const rec = {
      name,
      time,
      text: content
    };
    if (head) rec.head = head;
    if (datatype) rec.datatype = datatype;
    rec.renderType = renderType;
    if (datatitle) rec.datatitle = datatitle;
    if (datafmt) rec.datafmt = datafmt;
    if (duration) rec.duration = duration;
    if (datasize) rec.datasize = datasize;
    if (link) {
      rec.link = link;
      rec.url = link;
    }
    if (externurl) rec.externurl = externurl;
    if (cdnurlstring) rec.cdnurlstring = cdnurlstring;
    if (encrypturlstring) rec.encrypturlstring = encrypturlstring;
    if (fullmd5) rec.fullmd5 = fullmd5;
    if (thumbfullmd5) rec.thumbfullmd5 = thumbfullmd5;
    if (md5) rec.md5 = md5;
    if (fromnewmsgid) rec.fromnewmsgid = fromnewmsgid;
    if (srcMsgLocalid) {
      const v = Number(srcMsgLocalid);
      if (v > 0) rec.srcMsgLocalid = v;
    }
    if (srcMsgCreateTime) {
      const v = Number(srcMsgCreateTime);
      if (v > 0) rec.srcMsgCreateTime = v;
    }
    rec.recordIndex = idx;
    if (renderType === "chatHistory" && nestedRaw) {
      const nested = parseChatlogRecords(nestedRaw, depth + 1);
      if (nested.length > 0) rec.nested = nested;
    }
    if (renderType === "image") rec.isImage = true;
    out.push(rec);
    idx += 1;
  }
  return out;
}
function parseChatroomTop(xml) {
  const block = xml.match(/<chatroomtopmsg\b[^>]*>[\s\S]*?<\/chatroomtopmsg>/i);
  if (!block) return "";
  const inner = block[0];
  const op = xmlTagText$2(inner, "operation").trim() || xmlAttr(inner, "operation", "operation");
  const action = op === "1" ? "\u7F6E\u9876\u4E86\u4E00\u6761\u6D88\u606F" : op === "2" ? "\u79FB\u9664\u4E86\u4E00\u6761\u7F6E\u9876\u6D88\u606F" : "";
  if (!action) return "";
  const nick = xmlTagText$2(inner, "displayname") || xmlTagText$2(inner, "operatorname") || "";
  const user = xmlTagText$2(inner, "username") || "";
  return `${nick || user || "\u6709\u4EBA"}${action}`;
}
const SYS_NOISE_TAGS = [
  "revoketime",
  "revoketime",
  "newmsgid",
  "oldmsgid",
  "clientmsgid",
  "msgid",
  "session",
  "svrid",
  "seq",
  "createtime",
  "timestamp",
  "revoker",
  "replacemsg"
];
function stripSystemNoise(xml) {
  let out = xml || "";
  for (const tag of SYS_NOISE_TAGS) {
    out = out.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?</${tag}>`, "gi"), " ");
  }
  return extractXmlTextNodes(out) || stripXmlTags$1(out);
}
function parseSystemMessage(xml) {
  const body = (xml ?? "").trim();
  if (!body) return { text: "", kind: "plain" };
  const lower = body.toLowerCase();
  const declaredType = (body.match(/<sysmsg\b[^>]*\btype\s*=\s*["']([^"']*)["']/i) ?? [])[1] ?? "";
  const isRevoke = declaredType === "revokemsg" || lower.includes("revokemsg") || /撤回了一条消息|撤回了一条|撤回了一條訊息/.test(body);
  if (isRevoke) {
    const revokeBlock = xmlTagText$2(body, "revokemsg");
    const candidates = [
      xmlTagText$2(body, "replacemsg"),
      revokeBlock ? xmlTagText$2(revokeBlock, "content") : "",
      xmlTagText$2(body, "content")
    ];
    for (const candidate of candidates) {
      const t = stripXmlTags$1(stripCdata(candidate));
      if (t && !/^\d+$/.test(t)) return { text: t, kind: "revoke" };
    }
    const cleaned = unescapeXmlEntities(stripSystemNoise(revokeBlock || body));
    return { text: cleaned || "\u64A4\u56DE\u4E86\u4E00\u6761\u6D88\u606F", kind: "revoke" };
  }
  if (declaredType === "chatroomtopmsg" || lower.includes("chatroomtopmsg")) {
    const top = parseChatroomTop(body);
    if (top) return { text: top, kind: "top" };
  }
  const template = xmlTagText$2(body, "plain") || xmlTagText$2(body, "text") || extractXmlTextNodes(body);
  return { text: unescapeXmlEntities(stripXmlTags$1(stripCdata(template))), kind: declaredType || "plain" };
}
function parseAtUsernames(source) {
  if (!source || source.indexOf("atuserlist") < 0) return [];
  const raw = stripCdata(xmlTagText$2(source, "atuserlist"));
  if (!raw) return [];
  const seen = /* @__PURE__ */ new Set();
  const out = [];
  for (const part of raw.split(/[,;，；\s]+/)) {
    const v = part.trim();
    if (!v || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}
function parseMsgsourceSignature(source) {
  if (!source || source.indexOf("<msgsource") < 0) return "";
  return unescapeXmlEntities(xmlTagText$2(source, "signature")).trim();
}
function parseEmbeddedPayload(body) {
  if (/<emoji\b/.test(body)) {
    return { text: "", rich: { type: "emoji", title: xmlAttr(body, "emoji", "md5") || xmlTagText$2(body, "emoji"), md5: xmlAttr(body, "emoji", "md5") } };
  }
  if (/<videomsg\b/.test(body)) {
    const dur = Number(xmlAttr(body, "videomsg", "playlength")) || 0;
    const rich = { type: "video" };
    if (dur > 0) rich.durationSec = dur;
    const md5 = xmlAttr(body, "videomsg", "md5");
    if (md5) rich.md5 = md5;
    return { text: "", rich };
  }
  if (/<voicemsg\b/.test(body)) {
    const ms = Number(xmlAttr(body, "voicemsg", "voicelength")) || 0;
    const rich = { type: "voice", title: xmlTagText$2(body, "voicemsg"), md5: xmlAttr(body, "voicemsg", "md5") };
    if (ms > 0) rich.durationMs = ms;
    return { text: "", rich };
  }
  if (/<location\b/.test(body)) {
    const loc = parseLocation(body);
    return { text: "", rich: loc };
  }
  if (/<contact\b/.test(body)) {
    return { text: "", rich: { type: "contact", nickname: xmlAttr(body, "contact", "nickname"), username: xmlAttr(body, "contact", "username") } };
  }
  if (/<img\b/.test(body) && !/<appmsg\b/.test(body)) {
    const rich = { type: "image" };
    const group = parseImageGroup(body);
    if (group) {
      rich.groupId = group.id;
      rich.groupCount = group.count;
    }
    const md5 = xmlAttr(body, "img", "md5");
    if (md5) rich.md5 = md5;
    return { text: "", rich };
  }
  return null;
}
function parseLocation(body) {
  const poiname = unescapeXmlEntities(stripCdata(xmlTagOrAttr(body, "poiname") || xmlTagOrAttr(body, "poiName") || xmlTagOrAttr(body, "name")));
  const label = unescapeXmlEntities(stripCdata(xmlTagOrAttr(body, "label") || xmlTagOrAttr(body, "labelname") || xmlTagOrAttr(body, "address")));
  const num = (v) => {
    const n = Number(v);
    return Number.isFinite(n) && n !== 0 ? n : void 0;
  };
  const latRaw = num(xmlTagOrAttr(body, "x") || xmlTagOrAttr(body, "latitude") || xmlTagOrAttr(body, "lat"));
  const lngRaw = num(xmlTagOrAttr(body, "y") || xmlTagOrAttr(body, "longitude") || xmlTagOrAttr(body, "lng") || xmlTagOrAttr(body, "lon"));
  const lat = latRaw !== void 0 && latRaw >= -90 && latRaw <= 90 ? latRaw : void 0;
  const lng = lngRaw !== void 0 && lngRaw >= -180 && lngRaw <= 180 ? lngRaw : void 0;
  const rich = { type: "location", title: poiname || label || "\u4F4D\u7F6E" };
  if (label && label !== (poiname || "")) rich.desc = label;
  if (lat !== void 0) rich.lat = lat;
  if (lng !== void 0) rich.lng = lng;
  const poiId = xmlTagOrAttr(body, "poiid");
  if (poiId) rich.poiId = poiId;
  const infoUrl = xmlTagOrAttr(body, "infourl");
  if (infoUrl) rich.url = unescapeXmlEntities(infoUrl);
  return rich;
}
function parseMessageContent(msgType, content, isGroup) {
  let body = content;
  if (isGroup) {
    const pos = body.indexOf(":\n");
    if (pos > 0) {
      const head = body.slice(0, pos);
      const tail = body.slice(pos + 2);
      if (head.length <= 64 && !head.includes("<") && !head.includes(" ") && !tail.trimStart().startsWith("<?xml")) {
        body = tail;
      }
    }
  }
  switch (msgType) {
    case 1: {
      const text = body.replace(/^\n+/, "");
      if (text.includes("<mmreader>")) {
        const rich = { type: "newsfeed", title: xmlTagText$2(text, "title"), desc: xmlTagText$2(text, "digest"), url: xmlTagText$2(text, "url") };
        return { text: "", rich };
      }
      if (text.startsWith("<")) {
        const embedded = parseEmbeddedPayload(text);
        if (embedded) return embedded;
        const stripped = extractXmlTextNodes(text);
        return { text: stripped || stripXmlTags$1(text) };
      }
      return { text };
    }
    case 3: {
      const rich = { type: "image" };
      const group = parseImageGroup(body);
      if (group) {
        rich.groupId = group.id;
        rich.groupCount = group.count;
      }
      const md5 = xmlAttr(body, "img", "md5");
      if (md5) rich.md5 = md5;
      return { text: "", rich };
    }
    case 34: {
      const md5 = xmlAttr(body, "voicemsg", "md5") || xmlTagText$2(body, "md5");
      const ms = Number(xmlAttr(body, "voicemsg", "voicelength")) || Number(xmlAttr(body, "voicemsg", "length")) || 0;
      const rich = { type: "voice", title: xmlTagText$2(body, "voicemsg"), md5 };
      if (ms > 0) rich.durationMs = ms;
      return { text: "", rich };
    }
    case 42:
      return { text: "", rich: { type: "contact", nickname: xmlAttr(body, "contact", "nickname") || xmlAttr(body, "msg", "nickname"), username: xmlAttr(body, "contact", "username") || xmlAttr(body, "msg", "username"), alias: xmlAttr(body, "msg", "alias") } };
    case 66:
      return {
        text: "",
        rich: {
          type: "contact",
          nickname: xmlAttr(body, "msg", "nickname") || xmlAttr(body, "contact", "nickname"),
          username: xmlAttr(body, "msg", "username") || xmlAttr(body, "contact", "username"),
          desc: xmlAttr(body, "msg", "openimdesc") || ""
        }
      };
    case 43: {
      const rich = { type: "video" };
      const dur = Number(xmlAttr(body, "videomsg", "playlength")) || 0;
      if (dur > 0) rich.durationSec = dur;
      const md5 = xmlAttr(body, "videomsg", "md5");
      if (md5) rich.md5 = md5;
      return { text: "", rich };
    }
    case 47:
      return { text: "", rich: { type: "emoji", title: xmlAttr(body, "emoji", "md5") || xmlTagText$2(body, "emoji"), md5: xmlAttr(body, "emoji", "md5") } };
    case 48:
      return { text: "", rich: parseLocation(body) };
    case 49: {
      const rich = parseAppmsg(body);
      if (rich) {
        const text = rich.type === "file" ? `[\u6587\u4EF6] ${cleanRichText(rich.title)}` : rich.type === "link" ? `[\u94FE\u63A5] ${cleanRichText(rich.title)}` : rich.type === "quote" ? cleanRichText(rich.title) : rich.type === "miniapp" ? `[\u5C0F\u7A0B\u5E8F] ${cleanRichText(rich.title)}` : rich.type === "channels" ? `[\u89C6\u9891\u53F7] ${cleanRichText(rich.title)}` : rich.type === "live" ? `[\u76F4\u64AD] ${cleanRichText(rich.title)}` : rich.type === "music" ? `[\u97F3\u4E50] ${cleanRichText(rich.title)}` : rich.type === "chatlog" ? `[\u804A\u5929\u8BB0\u5F55] ${cleanRichText(rich.title)}` : rich.type === "transfer" ? "[\u8F6C\u8D26]" : rich.type === "redpacket" ? "[\u7EA2\u5305]" : rich.type === "solitaire" ? `[\u63A5\u9F99] ${cleanRichText(rich.title)}` : rich.type === "note" ? `[\u7B14\u8BB0] ${cleanRichText(rich.title)}` : rich.type === "card" ? `[\u5361\u7247] ${cleanRichText(rich.title)}` : rich.type === "sticker" ? "[\u8868\u60C5]" : rich.type === "product" ? `[\u5546\u54C1] ${cleanRichText(rich.title)}` : rich.type === "pat" ? cleanRichText(rich.title) : rich.type === "announcement" ? cleanRichText(rich.title) || "[\u7FA4\u516C\u544A]" : rich.type === "contact" ? `[\u540D\u7247] ${cleanRichText(rich.nickname || rich.title)}` : rich.type === "unsupported" ? cleanRichText(rich.title) || currentVersionHint() : cleanRichText(rich.title) || cleanRichText(rich.desc) || richFallbackLabel(rich.type);
        return { text, rich };
      }
      const title = cleanRichText(xmlTagText$2(body, "title"));
      return title ? { text: `[\u94FE\u63A5] ${title}` } : { text: "" };
    }
    case 50: {
      const scope = /<VoIPBubbleMsg[\s\S]*?<\/VoIPBubbleMsg>/i.exec(body)?.[0] ?? body;
      const status = xmlTagText$2(scope, "msg").trim();
      const durationSec = parseCallDuration(status);
      const roomType = xmlTagText$2(scope, "room_type").trim();
      const voipKind = parseVoipKind(roomType);
      const connected = durationSec !== void 0 || CALL_ANSWERED_ELSEWHERE.test(status);
      const rich = {
        type: "call",
        title: status || "\u901A\u8BDD",
        status,
        connected,
        callStatus: classifyCallStatus(status, connected)
      };
      if (voipKind) rich.voipType = voipKind;
      if (roomType) rich.roomType = Number(roomType) || 0;
      if (durationSec !== void 0) rich.durationSec = durationSec;
      return { text: status ? `[\u901A\u8BDD] ${status}` : "[\u901A\u8BDD]", rich };
    }
    case 62: {
      const rich = parseAppmsg(body);
      if (rich) {
        const text = rich.type === "solitaire" ? `[\u63A5\u9F99] ${cleanRichText(rich.title)}` : cleanRichText(rich.title);
        return { text, rich };
      }
      return { text: extractXmlTextNodes(body) };
    }
    case 1e4: {
      const sys = parseSystemMessage(body);
      return { text: sys.text, sysKind: sys.kind };
    }
    case 10002: {
      const sys = parseSystemMessage(body);
      return { text: sys.text || "\u64A4\u56DE\u4E86\u4E00\u6761\u6D88\u606F", sysKind: "revoke" };
    }
    case 11e3:
      return { text: "" };
    default: {
      const rich = /<appmsg\b/.test(body) ? parseAppmsg(body) : null;
      if (rich) {
        const text = cleanRichText(rich.title) || cleanRichText(rich.desc) || richFallbackLabel(rich.type);
        return { text, rich };
      }
      if (body && !body.includes("<") && body.length <= 500) return { text: body };
      return { text: "" };
    }
  }
}
function currentVersionHint() {
  return "\u5F53\u524D\u5FAE\u4FE1\u7248\u672C\u4E0D\u652F\u6301\u5C55\u793A\u8BE5\u5185\u5BB9\uFF0C\u8BF7\u5347\u7EA7\u81F3\u6700\u65B0\u7248\u672C\u3002";
}
function richPlaceholder(rich) {
  switch (rich.type) {
    case "image":
      return "[\u56FE\u7247]";
    case "emoji":
      return "[\u8868\u60C5]";
    case "sticker":
      return "[\u8868\u60C5]";
    case "voice":
      return "[\u8BED\u97F3]";
    case "video":
      return "[\u89C6\u9891]";
    case "location":
      return rich.title ? `[\u4F4D\u7F6E] ${rich.title}` : "[\u4F4D\u7F6E]";
    case "contact":
      return rich.nickname ? `[\u540D\u7247] ${rich.nickname}` : "[\u540D\u7247]";
    case "newsfeed":
      return rich.title ? `[\u56FE\u6587] ${rich.title}` : "[\u56FE\u6587]";
    case "file":
      return rich.title ? `[\u6587\u4EF6] ${rich.title}` : "[\u6587\u4EF6]";
    case "link":
      return rich.title ? `[\u94FE\u63A5] ${rich.title}` : "[\u94FE\u63A5]";
    case "music":
      return rich.title ? `[\u97F3\u4E50] ${rich.title}` : "[\u97F3\u4E50]";
    case "miniapp":
      return rich.title ? `[\u5C0F\u7A0B\u5E8F] ${rich.title}` : "[\u5C0F\u7A0B\u5E8F]";
    case "channels":
      return rich.title ? `[\u89C6\u9891\u53F7] ${rich.title}` : "[\u89C6\u9891\u53F7]";
    case "live":
      return rich.title ? `[\u76F4\u64AD] ${rich.title}` : "[\u76F4\u64AD]";
    case "product":
      return rich.title ? `[\u5546\u54C1] ${rich.title}` : "[\u5546\u54C1]";
    case "card":
      return rich.title ? `[\u5361\u7247] ${rich.title}` : "[\u5361\u7247]";
    case "note":
      return rich.title ? `[\u7B14\u8BB0] ${rich.title}` : "[\u7B14\u8BB0]";
    case "announcement":
      return rich.title ? `[\u7FA4\u516C\u544A] ${rich.title}` : "[\u7FA4\u516C\u544A]";
    case "solitaire":
      return rich.title ? `[\u63A5\u9F99] ${rich.title}` : "[\u63A5\u9F99]";
    case "chatlog":
      return rich.title ? `[\u804A\u5929\u8BB0\u5F55] ${rich.title}` : "[\u804A\u5929\u8BB0\u5F55]";
    case "transfer":
      return "[\u8F6C\u8D26]";
    case "redpacket":
      return "[\u7EA2\u5305]";
    case "call":
      return rich.title ? `[\u901A\u8BDD] ${rich.title}` : "[\u901A\u8BDD]";
    case "pat":
      return rich.title || "[\u62CD\u4E00\u62CD]";
    case "quote":
      return rich.title || "[\u5F15\u7528\u6D88\u606F]";
    case "unsupported":
      return rich.title || "[\u8BE5\u6D88\u606F\u7C7B\u578B\u6682\u4E0D\u652F\u6301\u9884\u89C8]";
    case "appmsg":
      return rich.title || rich.desc || "";
    default:
      return rich.title || "";
  }
}
//#endregion
//#region lib/types/query/messages.js
const ZSTD_MAGIC$8 = Buffer.from([40, 181, 47, 253]);
function normalizeMsgType(localType) {
  if (!Number.isFinite(localType)) return 0;
  const MOD = 4294967296;
  const v = Math.trunc(localType);
  return v >= 0 ? v % MOD : (v % MOD + MOD) % MOD;
}
function msgTypeLabel(localType) {
  switch (normalizeMsgType(localType)) {
    case 1:
      return "\u6587\u672C";
    case 3:
      return "\u56FE\u7247";
    case 34:
      return "\u8BED\u97F3";
    case 42:
      return "\u540D\u7247";
    case 43:
      return "\u89C6\u9891";
    case 47:
      return "\u8868\u60C5";
    case 48:
      return "\u4F4D\u7F6E";
    case 49:
      return "\u5E94\u7528\u6D88\u606F";
    case 50:
      return "\u901A\u8BDD";
    case 66:
      return "\u4F01\u4E1A\u5FAE\u4FE1\u540D\u7247";
    case 244:
    case 246:
      return "\u6587\u4EF6";
    case 1e4:
      return "\u7CFB\u7EDF\u6D88\u606F";
    case 10002:
      return "\u64A4\u56DE\u6D88\u606F";
    case 11e3:
      return "\u65E0\u5185\u5BB9\u6D88\u606F";
    case 859832288:
    case 922746960:
      return "\u62CD\u4E00\u62CD";
    case 244135593199:
      return "\u5C0F\u7A0B\u5E8F";
    default:
      return "\u672A\u77E5\u6D88\u606F";
  }
}
function tryDecompress$3(data) {
  if (data.length >= 4 && data.subarray(0, 4).equals(ZSTD_MAGIC$8)) {
    try {
      return Buffer.from(decompress(data));
    } catch {
      return null;
    }
  }
  return null;
}
function decodeBlobText(v) {
  if (v === null || v === void 0) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean" || typeof v === "bigint" || typeof v === "symbol") return String(v);
  const raw = Buffer.from(v instanceof Uint8Array ? v : []);
  const decompressed = tryDecompress$3(raw);
  const bytes = decompressed ?? raw;
  try {
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  } catch {
    return new TextDecoder("gbk", { fatal: false }).decode(bytes);
  }
}
function cellBytes(v) {
  if (v instanceof Uint8Array) return Buffer.from(v);
  if (typeof v === "string") return Buffer.from(v, "utf8");
  return Buffer.alloc(0);
}
function senderFromContent$1(content, talker) {
  if (!content) return null;
  let printable = 0;
  for (let i = 0; i < content.length && i < 512; i += 1) {
    const c = content.charCodeAt(i);
    if (c >= 32 && c <= 126 || c >= 128) printable += 1;
  }
  if (content.length > 0 && printable / Math.min(content.length, 512) < 0.6) return null;
  const m = content.match(/([A-Za-z0-9_@.\-]{3,64}):\n/);
  if (!m) return null;
  const head = m[1] ?? "";
  if (head.includes("<")) return null;
  if (talker && head === talker) return null;
  return head;
}
function resolveSysRefs(text, contactNames) {
  const D = String.fromCharCode(36);
  let out = "";
  let rest = text;
  for (; ; ) {
    const s = rest.indexOf(D);
    if (s < 0) {
      out += rest;
      break;
    }
    const e = rest.indexOf(D, s + 1);
    if (e < 0) {
      out += rest;
      break;
    }
    const id = rest.slice(s + 1, e);
    if (/^[A-Za-z0-9_.@-]{3,64}$/.test(id) && contactNames.has(id)) {
      out += rest.slice(0, s) + " " + (contactNames.get(id) ?? id) + " ";
      rest = rest.slice(e + 1);
    } else {
      out += rest.slice(0, e + 1);
      rest = rest.slice(e + 1);
    }
  }
  return out;
}
function msgText(content) {
  if (!content) return "";
  let raw = content.replace(/^\s+/, "");
  const prefix = raw.match(/^[A-Za-z0-9_@.\-]{3,64}:\s/);
  if (prefix) raw = raw.slice(prefix[0].length).replace(/^\s+/, "");
  if (!raw.startsWith("<")) {
    if (/^[A-Za-z0-9+/=]{40,}$/.test(raw.replace(/\s+/g, ""))) return "";
    return raw.replace(/\s+/g, " ").trim().slice(0, 200);
  }
  const parts = [];
  for (const m of raw.matchAll(/<!\[CDATA\[([\s\S]*?)\]\]>|>([^<]+)</g)) {
    const v = (m[1] ?? m[2] ?? "").trim();
    if (v) parts.push(v);
    if (parts.join(" ").length > 200) break;
  }
  return parts.join(" ").replace(/\s+/g, " ").trim().slice(0, 200);
}
function needsAtUsers(talker, type, content) {
  if (!talker.endsWith("@chatroom")) return false;
  if (type !== 1 && type !== 49) return false;
  return content.includes("@");
}
function msgTableName$9(username) {
  return "Msg_" + createHash("md5").update(username, "utf8").digest("hex");
}
function msgCreateTimeByServerId(decryptedDir, talker, serverId) {
  if (!talker || !serverId || serverId === "0") return null;
  const table = msgTableName$9(talker);
  for (const shard of findShards(decryptedDir, table)) {
    try {
      const row = shard.db.prepare(`SELECT CAST(create_time AS TEXT) AS ct FROM "${table}" WHERE CAST(server_id AS TEXT) = ?`).get(serverId);
      const n = Number(row?.ct ?? 0);
      if (n > 0) return n;
    } catch {
    } finally {
      shard.db.close();
    }
  }
  return null;
}
function findShards(decryptedDir, table) {
  const out = [];
  for (const shard of shardCatalog(decryptedDir)) {
    const meta = shard.tables.get(table);
    if (!meta) continue;
    try {
      const db = new DatabaseSync(shard.file, { readOnly: true });
      out.push({ db, file: shard.file, cols: meta.cols, name2id: meta.name2id });
    } catch {
    }
  }
  return out;
}
function queryShardRows(shard, table, cursor, limit, cursorLocalId) {
  return queryShardRowsWith(shard, table, cursor, void 0, limit, false, cursorLocalId);
}
function queryShardRowsWith(shard, table, cursor, after, limit, ascending, cursorLocalId) {
  const { db, cols } = shard;
  const has = (c) => cols.has(c);
  const sel = (c, dft) => has(c) ? c : dft;
  if (!has("local_id") || !has("create_time")) return [];
  const orderCol = has("sort_seq") ? "sort_seq" : "local_id";
  const useComposite = cursor !== void 0 && cursorLocalId !== void 0 && has("sort_seq");
  const params = [];
  let whereClause = "";
  if (after !== void 0) {
    whereClause = has("sort_seq") ? "WHERE sort_seq > ?" : "WHERE local_id > ?";
    params.push(after);
  } else if (cursor !== void 0) {
    if (useComposite) {
      whereClause = "WHERE sort_seq < ? OR (sort_seq = ? AND local_id < ?)";
      params.push(cursor, cursor, cursorLocalId);
    } else {
      whereClause = has("sort_seq") ? "WHERE sort_seq < ?" : "WHERE local_id < ?";
      params.push(cursor);
    }
  }
  const serverSel = has("server_id") ? "CAST(server_id AS TEXT) AS server_id" : "'0' AS server_id";
  const sql = [
    "SELECT",
    [
      sel("local_id", "0"),
      sel("sort_seq", "local_id"),
      sel("local_type", "0"),
      sel("is_sender", "0"),
      sel("create_time", "0"),
      sel("real_sender_id", "0"),
      sel("message_content", "NULL"),
      serverSel,
      // source 是群消息 @提及（<atuserlist>）与反垃圾签名的唯一来源；
      // 缺失的库（老分片）用 NULL 兜底，解码端按空处理。
      sel("source", "NULL")
    ].join(", "),
    "FROM " + table,
    whereClause,
    "ORDER BY " + orderCol + (ascending ? " ASC" : " DESC") + ", local_id " + (ascending ? "ASC" : "DESC"),
    "LIMIT ?"
  ].filter(Boolean).join(" ");
  params.push(limit);
  const rows = db.prepare(sql).all(...params);
  return rows.map((r) => {
    const realSenderId = Number(r[sel("real_sender_id", "0")] ?? 0);
    const rawSource = r[sel("source", "NULL")];
    return {
      localId: Number(r[sel("local_id", "0")] ?? 0),
      sortSeq: Number(r[sel("sort_seq", "local_id")] ?? 0),
      localType: Number(r[sel("local_type", "0")] ?? 0),
      isSender: Number(r[sel("is_sender", "0")] ?? 0),
      createTime: Number(r[sel("create_time", "0")] ?? 0),
      senderUsername: shard.name2id.get(realSenderId) ?? "",
      content: cellBytes(r[sel("message_content", "NULL")]),
      realSenderId,
      ...rawSource !== null && rawSource !== void 0 ? { source: cellBytes(rawSource) } : {},
      ...typeof r["server_id"] === "string" ? { serverId: r["server_id"] } : {}
    };
  });
}
function toWechatMessages(rows, talker, isGroup, contactNames, selfUsername) {
  return rows.map((r) => {
    const normType = normalizeMsgType(r.localType);
    const content = decodeBlobText(r.content);
    const parsed = parseMessageContent(normType, content, isGroup);
    const prefixSender = senderFromContent$1(content, talker);
    const sender = r.senderUsername || prefixSender || "";
    const self = selfUsername && selfUsername.length > 0 ? selfUsername : "";
    const isSelf = self.length > 0 ? sender === self : !isGroup && sender.length > 0 && sender !== talker;
    const msg = {
      localId: r.localId,
      ...r.serverId ? { serverId: r.serverId } : {},
      sortSeq: r.sortSeq,
      type: normType,
      isSender: isSelf ? 1 : 0,
      createTime: r.createTime,
      msgContent: content,
      strContent: content,
      typeLabel: msgTypeLabel(r.localType)
    };
    const displayText = parsed.text || (parsed.rich ? richPlaceholder(parsed.rich) : msgText(content));
    if (displayText) msg.displayText = resolveSysRefs(displayText, contactNames);
    if (parsed.rich) msg.rich = parsed.rich;
    const render = classifyRender(normType, parsed.rich, parsed.sysKind);
    msg.renderType = render;
    msg.renderLabel = RENDER_LABEL[render] ?? "\u672A\u77E5\u6D88\u606F";
    if (parsed.sysKind) msg.sysKind = parsed.sysKind;
    if (needsAtUsers(talker, normType, content) && r.source) {
      const names = parseAtUsernames(decodeBlobText(r.source));
      if (names.length > 0) {
        msg.atUsers = names.map((username) => ({
          username,
          displayName: username === "notify@all" ? "\u6240\u6709\u4EBA" : contactNames.get(username) || username
        }));
      }
    }
    if (isGroup && sender) {
      msg.sender = sender;
      const name = contactNames.get(sender);
      if (name) msg.senderName = name;
    }
    return msg;
  });
}
function queryNewMessages(decryptedDir, talker, after, limit, selfUsername) {
  const table = msgTableName$9(talker);
  const shards = findShards(decryptedDir, table);
  if (shards.length === 0) return { messages: [], total: 0 };
  try {
    const cap = Math.min(limit ?? 200, 1e3);
    const merged = [];
    for (const shard of shards) {
      merged.push(...queryShardRowsWith(shard, table, void 0, after, cap + 1, true));
    }
    merged.sort((a, b) => a.sortSeq - b.sortSeq || a.localId - b.localId);
    const rows = merged.slice(0, cap);
    const contactNames = contactMeta(decryptedDir).names;
    const isGroup = talker.endsWith("@chatroom");
    const messages = toWechatMessages(rows, talker, isGroup, contactNames, selfUsername);
    const out = { messages, total: messages.length };
    if (selfUsername && selfUsername.length > 0) out.selfWxid = selfUsername;
    return out;
  } finally {
    for (const shard of shards) {
      try {
        shard.db.close();
      } catch {
      }
    }
  }
}
const statsCache = /* @__PURE__ */ new Map();
function shardStatsFingerprint(shards) {
  return shards.map((s) => {
    try {
      const st = statSync(s.file);
      return `${s.file}:${st.mtimeMs}:${st.size}`;
    } catch {
      return s.file + ":?";
    }
  }).join("|");
}
function messageStats$1(decryptedDir, table, shards) {
  const sig = shardStatsFingerprint(shards);
  const key = decryptedDir + ":" + table;
  const hit = statsCache.get(key);
  if (hit && hit.sig === sig) return hit.stats;
  const statsMap = /* @__PURE__ */ new Map();
  for (const shard of shards) {
    const { db, cols } = shard;
    if (!cols.has("local_type")) continue;
    try {
      const rows = db.prepare("SELECT local_type AS t, COUNT(*) AS c FROM " + table + " GROUP BY local_type").all();
      for (const r of rows) {
        const key2 = normalizeMsgType(r.t);
        statsMap.set(key2, (statsMap.get(key2) ?? 0) + r.c);
      }
    } catch {
    }
  }
  const typeStats = [...statsMap.entries()].map(([type, count]) => ({ type, label: msgTypeLabel(type), count })).sort((a, b) => b.count - a.count).slice(0, 10);
  const total = shards.reduce((a, s) => {
    try {
      return a + Number(s.db.prepare("SELECT COUNT(*) AS c FROM " + table).get()?.c ?? 0);
    } catch {
      return a;
    }
  }, 0);
  const stats = { total, typeStats };
  statsCache.set(key, { sig, stats });
  return stats;
}
function queryMessages(decryptedDir, talker, limit, cursor, selfUsername, cursorLocalId) {
  const table = msgTableName$9(talker);
  const shards = findShards(decryptedDir, table);
  if (shards.length === 0) return { messages: [], total: 0 };
  try {
    const pageSize = Math.min(limit ?? 100, 1e3);
    const limitPerShard = pageSize + 1;
    const merged = [];
    for (const shard of shards) {
      merged.push(...queryShardRows(shard, table, cursor, limitPerShard, cursorLocalId));
    }
    merged.sort((a, b) => b.sortSeq - a.sortSeq || b.localId - a.localId);
    const hasMore = merged.length > pageSize;
    const pageRows = merged.slice(0, pageSize);
    const lastRow = pageRows[pageRows.length - 1];
    const nextCursor = lastRow ? lastRow.sortSeq : 0;
    const nextCursorLocalId = lastRow ? lastRow.localId : 0;
    const contactNames = contactMeta(decryptedDir).names;
    const isGroup = talker.endsWith("@chatroom");
    const messages = toWechatMessages(pageRows.reverse(), talker, isGroup, contactNames, selfUsername);
    const stats = messageStats$1(decryptedDir, table, shards);
    const base = { messages, total: stats.total, typeStats: stats.typeStats };
    if (selfUsername && selfUsername.length > 0) base.selfWxid = selfUsername;
    return hasMore ? { ...base, hasMore, cursor: nextCursor, cursorLocalId: nextCursorLocalId } : { ...base, hasMore: false };
  } finally {
    for (const shard of shards) {
      try {
        shard.db.close();
      } catch {
      }
    }
  }
}
function queryMessageByServerId(decryptedDir, serverId) {
  const sid = serverId;
  let numeric = null;
  if (/^\d+$/.test(sid)) {
    try {
      numeric = BigInt(sid);
    } catch {
    }
  }
  const tryLookup = (predicate, param) => {
    for (const shard of shardCatalog(decryptedDir)) {
      let db;
      try {
        db = new DatabaseSync(shard.file, { readOnly: true, readBigInts: true });
      } catch {
        continue;
      }
      try {
        for (const [table, meta] of shard.tables) {
          if (!meta.cols.has("server_id") || !meta.cols.has("local_type")) continue;
          try {
            const sql = 'SELECT local_id, sort_seq, local_type, create_time, real_sender_id, message_content FROM "' + table + '" WHERE ' + predicate + " = ? AND (local_type & 4294967295) = 49 LIMIT 1";
            const row = db.prepare(sql).get(param);
            if (!row) continue;
            const normType = normalizeMsgType(Number(row["local_type"] ?? 0));
            const content = decodeBlobText(row["message_content"]);
            const parsed = parseMessageContent(normType, content, false);
            const msg = {
              localId: Number(row["local_id"] ?? 0),
              sortSeq: Number(row["sort_seq"] ?? 0),
              type: normType,
              isSender: 0,
              createTime: Number(row["create_time"] ?? 0),
              msgContent: content,
              strContent: content,
              typeLabel: msgTypeLabel(normType)
            };
            if (parsed.text) msg.displayText = parsed.text;
            if (parsed.rich) msg.rich = parsed.rich;
            const render = classifyRender(normType, parsed.rich, parsed.sysKind);
            msg.renderType = render;
            msg.renderLabel = RENDER_LABEL[render] ?? "\u672A\u77E5\u6D88\u606F";
            if (parsed.sysKind) msg.sysKind = parsed.sysKind;
            return { found: true, message: msg };
          } catch {
          }
        }
      } finally {
        db.close();
      }
    }
    return { found: false };
  };
  if (numeric !== null) {
    const hit = tryLookup("server_id", numeric);
    if (hit.found) return hit;
  }
  return tryLookup("CAST(server_id AS TEXT)", sid);
}
//#endregion
//#region lib/types/query/moments.js
/**
* Moments (朋友圈) queries over st_control's decrypted sns.db.
* Timeline rows live in SnsTimeLine (tid/user_name/content XML); the content
* XML is parsed into text/media/location/link fields mirroring the Rust
* modules/moments.rs parse_sns_xml. Author names resolve via contact.db.
*/
/** Stringify an SQLite cell (TEXT/NUMBER/BLOB) to a string. */
function cellString$6(v) {
	if (v === null || v === void 0) return "";
	if (typeof v === "string") return v;
	if (v instanceof Uint8Array) return new TextDecoder("utf-8", { fatal: false }).decode(v);
	if (typeof v === "number" || typeof v === "boolean" || typeof v === "bigint" || typeof v === "symbol") return String(v);
	return "";
}
/** Resolve the sns.db path (sns/db_sns/sns.db or sns/sns.db). */
function snsDb$2(decryptedDir) {
	for (const p of [join(decryptedDir, "sns", "db_sns", "sns.db"), join(decryptedDir, "sns", "sns.db")]) if (existsSync(p)) return p;
	return null;
}
/** Unescape common XML entities. */
function unescapeXml(s) {
	return s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&apos;/g, "'").replace(/&#39;/g, "'");
}
/** Extract text between <tag ...> and </tag>, tolerating attributes on the open tag. */
function xmlTagText$1(xml, tag) {
	const openExact = "<" + tag + ">";
	const openAttr = "<" + tag + " ";
	const start = xml.indexOf(openExact) >= 0 ? xml.indexOf(openExact) : xml.indexOf(openAttr);
	if (start < 0) return null;
	const contentStart = xml.startsWith(openExact, start) ? start + openExact.length : xml.indexOf(">", start) + 1;
	const close = xml.indexOf("</" + tag + ">", contentStart);
	if (close < 0) return null;
	return xml.slice(contentStart, close);
}
/** Extract an attribute value from a tag open (first occurrence). */
function xmlTagAttr$1(xml, tag, attr) {
	const openExact = "<" + tag + ">";
	const openAttr = "<" + tag + " ";
	const start = xml.indexOf(openExact) >= 0 ? xml.indexOf(openExact) : xml.indexOf(openAttr);
	if (start < 0) return null;
	const tagEnd = xml.indexOf(">", start);
	if (tagEnd < 0) return null;
	const tagStr = xml.slice(start, tagEnd);
	const search = attr + "=\"";
	const a = tagStr.indexOf(search);
	if (a < 0) return null;
	const v = a + search.length;
	const e = tagStr.indexOf("\"", v);
	if (e < 0) return null;
	return tagStr.slice(v, e);
}
/** Extract text of the first nested tag inside a parent tag. */
function xmlNestedText$1(xml, parent, child) {
	const open = "<" + parent + ">";
	const start = xml.indexOf(open);
	if (start < 0) return null;
	const close = xml.indexOf("</" + parent + ">", start + open.length);
	if (close < 0) return null;
	return xmlTagText$1(xml.slice(start, close + open.length + parent.length + 3), child);
}
/** Extract text of the first tag among candidates (first non-empty wins). */
function tagTextFirst(xml, tags) {
	for (const t of tags) {
		const v = xmlTagText$1(xml, t);
		if (v != null && v.trim() !== "") return unescapeXml(v).trim();
	}
	return "";
}
/** Iterate <media ...>...</media> blocks. */
function mediaBlocks(xml) {
	const out = [];
	let pos = 0;
	for (;;) {
		const rest = xml.slice(pos);
		let idx = rest.indexOf("<media>");
		const idxAttr = rest.indexOf("<media ");
		if (idxAttr >= 0 && (idx < 0 || idxAttr < idx)) idx = idxAttr;
		if (idx < 0) break;
		const tagStart = pos + idx;
		const tagClose = xml.indexOf(">", tagStart);
		if (tagClose < 0) break;
		const mediaClose = xml.indexOf("</media>", tagClose + 1);
		if (mediaClose < 0) break;
		out.push(xml.slice(tagClose + 1, mediaClose));
		pos = mediaClose + 8;
	}
	return out;
}
/** Whether a URL points at a video (video media is not an image). */
function isVideoUrl(u) {
	const l = u.toLowerCase();
	return l.includes("snsvideodownload") || l.includes("video.qq.com") || l.includes(".mp4");
}
/** Parse one moments content XML (mirror parse_sns_xml). */
function parseSnsXml(xml) {
	const text = tagTextFirst(xml, ["contentDesc", "ContentDesc"]);
	const createTime = Number.parseInt(tagTextFirst(xml, ["createTime", "CreateTime"]), 10) || 0;
	const mediaCount = xml.split("<media>").length - 1 + xml.split("<media ").length - 1;
	const hasVideo = xml.includes("<type>6</type>") || xml.includes("<type>4</type>") || xml.includes("<type>15</type>");
	const mediaDesc = mediaCount === 0 ? "" : hasVideo ? "视频" : `图片×${mediaCount}`;
	const images = [];
	const videos = [];
	const timelineId = tagTextFirst(xml, ["id", "Id"]) || void 0;
	for (const inner of mediaBlocks(xml)) {
		const url = tagTextFirst(inner, [
			"url",
			"Url",
			"cdnUrl",
			"cdnurl"
		]);
		const thumb = tagTextFirst(inner, [
			"thumb",
			"Thumb",
			"cdnThumbUrl",
			"cdnthumburl",
			"thumbUrl",
			"thumburl",
			"coverUrl",
			"coverurl"
		]);
		const key = xmlTagAttr$1(inner, "enc", "key") ?? xmlTagAttr$1(inner, "thumb", "key") ?? xmlTagAttr$1(inner, "url", "key") ?? "";
		const md5 = xmlTagAttr$1(inner, "url", "md5") ?? "";
		const mediaId = tagTextFirst(inner, ["id", "Id"]) || void 0;
		const duration = Number.parseFloat(tagTextFirst(inner, ["videoDuration"])) || 0;
		if (url && isVideoUrl(url)) {
			const videoEntry = {
				url,
				thumb,
				key,
				md5,
				duration
			};
			if (mediaId) videoEntry.id = mediaId;
			if (timelineId) videoEntry.timelineId = timelineId;
			videos.push(videoEntry);
		} else if (url) {
			const mediaEntry = {
				thumb,
				url,
				key,
				md5
			};
			if (mediaId) mediaEntry.id = mediaId;
			if (timelineId) mediaEntry.timelineId = timelineId;
			images.push(mediaEntry);
		}
	}
	return {
		text,
		createTime,
		mediaCount,
		mediaDesc,
		images,
		videos,
		location: xmlTagAttr$1(xml, "location", "poiName") ?? xmlTagAttr$1(xml, "location", "poiname") ?? "",
		city: xmlTagAttr$1(xml, "location", "city") ?? "",
		country: xmlTagAttr$1(xml, "location", "country") ?? "",
		// ⚠️ 微信把这两个属性**写反了**：南宁的真实坐标是 22.87N/108.25E，
		// 而 latitude 属性写的是 108.25。本机 490 条里 485 条 latitude > 90。
		// 这里换回来 —— 输出的 lat/lng 是能直接画地图的值。
		lat: Number(xmlTagAttr$1(xml, "location", "longitude") ?? "") || 0,
		lng: Number(xmlTagAttr$1(xml, "location", "latitude") ?? "") || 0,
		linkTitle: unescapeXml(xmlNestedText$1(xml, "ContentObject", "title") ?? "") || unescapeXml(xmlNestedText$1(xml, "contentObject", "title") ?? "") || "",
		linkUrl: unescapeXml(xmlTagText$1(xml, "contentUrl") ?? "") || unescapeXml(xmlTagText$1(xml, "ContentUrl") ?? "") || "",
		contentType: Number.parseInt(tagTextFirst(xml, ["type", "Type"]), 10) || 0,
		sourceNickName: tagTextFirst(xml, ["sourceNickName", "SourceNickName"]) || "",
		publicUserName: tagTextFirst(xml, ["publicUserName", "PublicUserName"]) || "",
		nickname: tagTextFirst(xml, [
			"nickname",
			"NickName",
			"nickName"
		]) || ""
	};
}
/**
* Parse likes + comments embedded in the moments XML LocalExtraInfo.
* <comment_user_list><user_comment>…</user_comment>…; type 1 = like, type 2 = comment.
* Reply comments reference ref_comment_id, resolved to the target comment author.
*/
function parseSnsLikesComments(xml) {
	const likes = [];
	const comments = [];
	const start = xml.indexOf("<LocalExtraInfo>");
	if (start < 0) return {
		likes,
		comments
	};
	const listEnd = xml.indexOf("</LocalExtraInfo>", start);
	const list = listEnd > 0 ? xml.slice(start, listEnd) : xml.slice(start);
	const raws = [];
	let pos = 0;
	for (;;) {
		const bi = list.indexOf("<user_comment>", pos);
		if (bi < 0) break;
		const bc = list.indexOf("</user_comment>", bi);
		if (bc < 0) break;
		const b = list.slice(bi + 14, bc);
		raws.push({
			id: xmlTagText$1(b, "comment_id") ?? "",
			username: xmlTagText$1(b, "username") ?? "",
			nickname: unescapeXml(xmlTagText$1(b, "nickname") ?? ""),
			content: unescapeXml(xmlTagText$1(b, "content") ?? ""),
			ts: Number.parseInt(xmlTagText$1(b, "create_time") ?? "0", 10) || 0,
			ref: xmlTagText$1(b, "ref_comment_id") ?? "0",
			type: Number.parseInt(xmlTagText$1(b, "type") ?? "0", 10) || 0,
			block: b
		});
		pos = bc + 15;
	}
	const byId = /* @__PURE__ */ new Map();
	for (const r of raws) if (r.id) byId.set(r.id, r);
	for (const r of raws) {
		if (r.type === 1) {
			likes.push({
				username: r.username,
				nickname: r.nickname
			});
			continue;
		}
		const refC = r.ref && r.ref !== "0" ? byId.get(r.ref) : void 0;
		const comment = {
			username: r.username,
			nickname: r.nickname,
			to_username: refC ? refC.username : "",
			to_nickname: refC ? refC.nickname : "",
			content: r.content,
			ts: r.ts
		};
		const b = r.block;
		const ii = b.indexOf("<imageinfo>");
		if (ii >= 0) {
			const ie = b.indexOf("</imageinfo>", ii);
			const ib = ie > 0 ? b.slice(ii + 11, ie) : b.slice(ii + 11);
			const image = {};
			const iu = unescapeXml(xmlTagText$1(ib, "url") ?? "");
			if (iu) image.url = iu;
			const it = unescapeXml(xmlTagText$1(ib, "thumb_url") ?? "");
			if (it) image.thumb = it;
			const imd = xmlTagText$1(ib, "md5") ?? "";
			if (imd) image.md5 = imd;
			const imid = xmlTagText$1(ib, "media_id") ?? "";
			if (imid) image.mediaId = imid;
			if (Object.keys(image).length > 0) comment.image = image;
		}
		comments.push(comment);
	}
	return {
		likes,
		comments
	};
}
/** Format a unix timestamp as a moments time label (relative days). */
function fmtTime(ts) {
	if (!ts) return "";
	const d = /* @__PURE__ */ new Date(ts * 1e3);
	const now = /* @__PURE__ */ new Date();
	const startOfDay = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
	const dayDiff = Math.round((startOfDay(now) - startOfDay(d)) / 864e5);
	const hhmm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
	if (dayDiff <= 0) return `今天 ${hhmm}`;
	if (dayDiff === 1) return `昨天 ${hhmm}`;
	if (dayDiff < 365) return `${dayDiff}天前`;
	return `${Math.floor(dayDiff / 30)}个月前`;
}
/**
* Read moments page (XML parsed; likes/comments resolved from SnsMessage_tmp3).
* @param decryptedDir - decrypted data root.
* @param offset - page offset.
* @param limit - page size.
* @param authorUsername - optional author filter.
* @returns the moments snapshot.
*/
function queryMoments(decryptedDir, offset, limit, authorUsername, selfUsername) {
	const dbPath = snsDb$2(decryptedDir);
	if (dbPath === null) return {
		moments: [],
		total: 0
	};
	const db = new DatabaseSync(dbPath, { readOnly: true });
	try {
		if (!(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='SnsTimeLine'").get() !== void 0)) return {
			moments: [],
			total: 0
		};
		const cols = new Set(db.prepare("PRAGMA table_info(SnsTimeLine)").all().map((r) => r.name));
		const tid = cols.has("tid") ? "tid" : "Id";
		const uname = cols.has("user_name") ? "user_name" : "userName";
		const content = cols.has("content") ? "content" : "Content";
		const cap = Math.min(limit ?? 50, 500);
		const off = offset ?? 0;
		const where = authorUsername ? ` WHERE ${uname} = ?` : "";
		const totalRow = db.prepare(`SELECT COUNT(*) AS n FROM SnsTimeLine${where}`).all(...authorUsername ? [authorUsername] : [])[0];
		const rows = db.prepare(`SELECT CAST(${tid} AS TEXT) AS t, ${uname} AS u, ${content} AS c FROM SnsTimeLine${where} ORDER BY ${tid} DESC LIMIT ? OFFSET ?`).all(...authorUsername ? [authorUsername] : [], cap, off);
		const names = contactMeta(decryptedDir).names;
		const self = selfUsername ?? "";
		return {
			moments: rows.map((r) => {
				const username = cellString$6(r.u);
				const xml = cellString$6(r.c);
				const parsed = parseSnsXml(xml);
				const social = parseSnsLikesComments(xml);
				const author = names.get(username) || parsed.nickname || username || "未知";
				const entry = {
					tid: cellString$6(r.t),
					username,
					author,
					text: parsed.text,
					ts: parsed.createTime,
					time: fmtTime(parsed.createTime),
					media_count: parsed.mediaCount,
					media_desc: parsed.mediaDesc,
					images: parsed.images,
					videos: parsed.videos,
					location: parsed.location,
					link_title: parsed.linkTitle,
					link_url: parsed.linkUrl,
					is_self: username === self,
					likes: social.likes,
					comments: social.comments
				};
				if (parsed.contentType) entry.contentType = parsed.contentType;
				if (parsed.sourceNickName) entry.sourceNickName = parsed.sourceNickName;
				if (parsed.publicUserName) entry.publicUserName = parsed.publicUserName;
				if (parsed.city) entry.city = parsed.city;
				if (parsed.country) entry.country = parsed.country;
				// 只有真的带坐标才输出（本机 490 条），且已按属性反置修正
				if (parsed.lat || parsed.lng) {
					entry.lat = parsed.lat;
					entry.lng = parsed.lng;
				}
				return entry;
			}),
			total: totalRow.n
		};
	} finally {
		db.close();
	}
}
/**
* Author-activity counts across the FULL moments table (SQL GROUP BY, no XML
* parse), mapped to display names, ranked by count descending.
* @param decryptedDir - decrypted data root.
* @returns author name + moment count, highest first.
*/
function queryMomentsAuthors(decryptedDir) {
	const dbPath = snsDb$2(decryptedDir);
	if (dbPath === null) return [];
	const db = new DatabaseSync(dbPath, { readOnly: true });
	try {
		if (!(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='SnsTimeLine'").get() !== void 0)) return [];
		const uname = new Set(db.prepare("PRAGMA table_info(SnsTimeLine)").all().map((r) => r.name)).has("user_name") ? "user_name" : "userName";
		const rows = db.prepare(`SELECT ${uname} AS u, COUNT(*) AS n FROM SnsTimeLine GROUP BY ${uname} ORDER BY n DESC`).all();
		const names = contactMeta(decryptedDir).names;
		return rows.map((r) => ({
			name: names.get(cellString$6(r.u)) || cellString$6(r.u) || "未知",
			count: r.n ?? 0
		}));
	} finally {
		db.close();
	}
}
//#endregion
//#region lib/types/query/favorites.js
/**
* Favorites queries over st_control's decrypted favorite.db (fav_db_item).
* Parses content XML (favitem type/desc/dataitem) into title/desc/url and
* resolves sources via contact names, mirroring st_control modules/favorites.rs.
*/
/** Coerce a DB cell to a string (null -> '', else String()). */
function cellStr$15(v) {
	if (typeof v === "string") return v;
	if (v === null || v === void 0) return "";
	if (typeof v === "number" || typeof v === "boolean" || typeof v === "bigint" || typeof v === "symbol") return String(v);
	if (v instanceof Uint8Array) return new TextDecoder("utf-8", { fatal: false }).decode(v);
	return "";
}
/** Unescape XML/HTML entities (keep newlines/tabs). */
function decodeFavText(s) {
	return s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&apos;/g, "'").replace(/&#x0A;/gi, "\n").replace(/&#10;/g, "\n").replace(/&#x0D;/gi, "\r").replace(/&#13;/g, "\r").replace(/&#x09;/gi, "	").replace(/&#9;/g, "	");
}
/** Extract text between <tag ...> and </tag> (first occurrence). */
function xmlTagText(xml, tag) {
	const openExact = "<" + tag + ">";
	const openAttr = "<" + tag + " ";
	const start = xml.indexOf(openExact) >= 0 ? xml.indexOf(openExact) : xml.indexOf(openAttr);
	if (start < 0) return null;
	const contentStart = xml.startsWith(openExact, start) ? start + openExact.length : xml.indexOf(">", start) + 1;
	const close = xml.indexOf("</" + tag + ">", contentStart);
	if (close < 0) return null;
	return xml.slice(contentStart, close);
}
/** Extract an attribute value from a tag open (first occurrence). */
function xmlTagAttr(xml, tag, attr) {
	const openExact = "<" + tag + ">";
	const openAttr = "<" + tag + " ";
	const start = xml.indexOf(openExact) >= 0 ? xml.indexOf(openExact) : xml.indexOf(openAttr);
	if (start < 0) return null;
	const tagStr = xml.slice(start, xml.indexOf(">", start));
	const search = attr + "=\"";
	const a = tagStr.indexOf(search);
	if (a < 0) return null;
	const v = a + search.length;
	const e = tagStr.indexOf("\"", v);
	if (e < 0) return null;
	return tagStr.slice(v, e);
}
/** Extract text of the first nested tag inside a parent tag. */
function xmlNestedText(xml, parent, child) {
	const open = "<" + parent + ">";
	const start = xml.indexOf(open);
	if (start < 0) return null;
	const close = xml.indexOf("</" + parent + ">", start + open.length);
	if (close < 0) return null;
	return xmlTagText(xml.slice(start, close + open.length + parent.length + 3), child);
}
/** 收藏类型标签（微信 fav type）。 */
function favTypeLabel(t) {
	switch (t) {
		case 1: return "文本";
		case 2: return "图片";
		case 3: return "语音";
		case 4: return "视频";
		case 5: return "链接";
		case 6: return "位置";
		case 7: return "音乐";
		case 8: return "文件";
		case 14: return "聊天记录";
		case 16: return "商品";
		case 18: return "笔记";
		case 19: return "小程序";
		case 20: return "视频号";
		default: return "其他";
	}
}
/** Strip XML tags for text-type fallback. */
function stripXmlTags(xml) {
	return decodeFavText(xml.replace(/<[^>]+>/g, "")).trim();
}
/** 取文本首行作为卡片标题（去掉空行、限长）。 */
function firstLineTitle(text) {
	for (const line of text.split("\n")) {
		const t = line.trim();
		if (t) return t.length > 28 ? t.slice(0, 28) + "…" : t;
	}
	return "";
}
/**
 * Parse favourites content XML into (title, desc, url).
 * 第 44 轮修正四处取错元素（真实 XML 为据）：type1 正文在 <desc> 且需解码实体；
 * type8 文件名在 <desc>；type5 空标题回退 <dataitem><datatitle>；
 * type6 是 <locitem><poiname>/<label> 元素而非 <location> 属性。
 */
function parseFavContent(favType, xml) {
	if (!xml) return {
		title: "",
		desc: "",
		url: ""
	};
	const t = "title";
	const d = "desc";
	const title = xmlTagText(xml, t) ?? "";
	const descRaw = xmlTagText(xml, d) ?? "";
	if (favType === 1) {
		const text = decodeFavText(descRaw || (xml.includes("<") ? stripXmlTags(xml) : xml));
		return {
			title: firstLineTitle(text),
			desc: text,
			url: ""
		};
	}
	if (favType === 8) {
		const name = descRaw || xmlTagText(xml, "datatitle") || "";
		return {
			title: decodeFavText(name),
			desc: decodeFavText(descRaw),
			url: ""
		};
	}
	if (favType === 5) {
		const url = (xmlTagText(xml, "url") ?? "").replace(/&amp;/g, "&");
		return {
			title: decodeFavText(title || xmlTagText(xml, "datatitle") || ""),
			desc: decodeFavText(descRaw || xmlTagText(xml, "datadesc") || ""),
			url
		};
	}
	if (favType === 14 || favType === 18) return {
		title: xmlNestedText(xml, "recordinfo", t) || title,
		desc: decodeFavText(xmlNestedText(xml, "recordinfo", d) || descRaw),
		url: ""
	};
	if (favType === 6) return {
		title: decodeFavText(xmlTagText(xml, "poiname") || title || xmlTagText(xml, "label") || ""),
		desc: decodeFavText(xmlTagText(xml, "label") || descRaw || ""),
		url: ""
	};
	return {
		title,
		desc: decodeFavText(descRaw),
		url: ""
	};
}
/** Parse `<datalist><dataitem>` entries into typed parts (mirror parse_fav_detail). */
function parseFavParts(xml) {
	const out = [];
	let pos = 0;
	for (;;) {
		const start = xml.indexOf("<dataitem", pos);
		if (start < 0) break;
		const end = xml.indexOf("</dataitem>", start);
		const body = end >= 0 ? xml.slice(start, end) : xml.slice(start);
		const datatype = Number.parseInt(xmlTagAttr(body, "dataitem", "datatype") ?? "0", 10) || 0;
		const dataid = (xmlTagAttr(body, "dataitem", "dataid") ?? "").trim().toLowerCase();
		const md5 = (xmlTagText(body, "fullmd5") ?? "").trim().toLowerCase() || dataid;
		const thumbMd5 = (xmlTagText(body, "thumbfullmd5") ?? "").trim().toLowerCase();
		const text = decodeFavText(xmlTagText(body, "datadesc") ?? "") || decodeFavText(xmlTagText(body, "datatitle") ?? "");
		const sourceName = xmlTagText(body, "datasrcname") ?? "";
		const sourceTime = xmlTagText(body, "datasrctime") ?? "";
		const sourceHead = xmlTagText(body, "sourceheadurl") ?? "";
		const metaPart = () => {
			const p = { kind: "text" };
			if (sourceName) p.sourceName = sourceName;
			if (sourceTime) p.sourceTime = sourceTime;
			if (sourceHead) p.sourceHead = sourceHead;
			return p;
		};
		const pushPart = (part) => {
			out.push(part);
		};
		if (datatype === 1) {
			if (text) {
				const p = metaPart();
				p.text = text;
				pushPart(p);
			}
		} else if (datatype === 2) {
			const p = metaPart();
			p.kind = "image";
			if (thumbMd5) p.md5 = thumbMd5;
			else if (md5) p.md5 = md5;
			if (text) p.text = text;
			pushPart(p);
		} else if (datatype === 3) {
			const p = metaPart();
			p.kind = "voice";
			if (md5) p.md5 = md5;
			pushPart(p);
		} else if (datatype === 4) {
			const p = metaPart();
			p.kind = "video";
			if (md5) p.md5 = md5;
			const dur = Number.parseFloat(xmlTagText(body, "duration") ?? "0");
			if (dur > 0) p.duration = dur;
			if (text) p.text = text;
			pushPart(p);
		} else if (datatype === 5 || datatype === 19 || datatype === 36) {
			const p = metaPart();
			p.kind = "link";
			if (text) p.text = text;
			const u = (xmlTagText(body, "stream_weburl") ?? xmlTagText(body, "url") ?? "").replace(/&amp;/g, "&");
			if (u) p.url = u;
			pushPart(p);
		} else if (datatype === 8) {
			const p = metaPart();
			p.kind = "file";
			const n = xmlTagText(body, "datatitle") ?? "";
			if (n) p.name = n;
			const e = xmlTagText(body, "datafmt") ?? "";
			if (e) p.ext = e;
			const sz = Number.parseInt(xmlTagText(body, "fullsize") ?? "0", 10);
			if (sz > 0) p.size = sz;
			pushPart(p);
		}
		pos = end >= 0 ? end + 10 : xml.length;
	}
	return out;
}
/** Format a unix timestamp as `YYYY-MM-DD HH:mm`. */
function fmtDateTime(ts) {
	if (!ts) return "";
	const d = /* @__PURE__ */ new Date(ts * 1e3);
	const p = (n) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
/**
* Read the favorites list with parsed title/desc/url/source.
* @param decryptedDir - decrypted data root.
* @param limit - max rows.
* @returns the favorites snapshot.
*/
function queryFavorites(decryptedDir, limit, offset = 0) {
	const db = new DatabaseSync(join(decryptedDir, "favorite", "favorite.db"), { readOnly: true });
	try {
		if (!(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='fav_db_item'").get() !== void 0)) return {
			favorites: [],
			total: 0
		};
		const cols = new Set(db.prepare("PRAGMA table_info(fav_db_item)").all().map((r) => r.name));
		const sel = (c, dft) => cols.has(c) ? c : dft;
		const cap = Math.min(limit ?? 200, 2e3);
		const sql = [
			"SELECT",
			[
				sel("local_id", "0"),
				sel("type", "0"),
				sel("update_time", "0"),
				sel("content", "''"),
				sel("fromusr", "''"),
				sel("realchatname", "''")
			].join(", "),
			"FROM fav_db_item",
			"ORDER BY",
			sel("update_time", "local_id"),
			"DESC",
			"LIMIT ? OFFSET ?"
		].join(" ");
		const rows = db.prepare(sql).all(cap, offset);
		const total = db.prepare("SELECT COUNT(*) AS n FROM fav_db_item").get()?.n ?? rows.length;
		const names = contactMeta(decryptedDir).names;
		return {
			favorites: rows.map((r) => {
				const type = Number(r[sel("type", "0")] ?? 0);
				const xml = cellStr$15(r[sel("content", "")] ?? "");
				const fromUsr = cellStr$15(r[sel("fromusr", "")] ?? "");
				const chatName = cellStr$15(r[sel("realchatname", "")] ?? "");
				const parsed = parseFavContent(type, xml);
				const source = chatName ? names.get(chatName) ?? chatName : fromUsr ? names.get(fromUsr) ?? fromUsr : "";
				const updateTime = Number(r[sel("update_time", "0")] ?? 0);
				return {
					localId: Number(r[sel("local_id", "0")] ?? 0),
					type,
					typeLabel: favTypeLabel(type),
					title: parsed.title,
					desc: parsed.desc,
					url: parsed.url,
					updateTime,
					time: fmtDateTime(updateTime),
					content: xml,
					fromUsr,
					chatName,
					source,
					items: parseFavParts(xml)
				};
			}),
			total
		};
	} finally {
		db.close();
	}
}
/**
* Delete favorite items by local_id (writes to favorite.db copy).
* @param decryptedDir - decrypted data root.
* @param ids - local_ids to delete.
* @returns deleted count.
*/
function deleteFavoriteItems(decryptedDir, ids) {
	if (ids.length === 0) return {
		ok: true,
		deleted: 0
	};
	const dbPath = join(decryptedDir, "favorite", "favorite.db");
	if (!existsSync(dbPath)) return {
		ok: false,
		deleted: 0,
		error: "收藏库不存在"
	};
	try {
		const db = new DatabaseSync(dbPath);
		if (!(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='fav_db_item'").get() !== void 0)) {
			db.close();
			return {
				ok: false,
				deleted: 0,
				error: "fav_db_item 表不存在"
			};
		}
		const stmt = db.prepare("DELETE FROM fav_db_item WHERE local_id = ?");
		let deleted = 0;
		for (const id of ids) deleted += Number(stmt.run(id).changes);
		db.close();
		return {
			ok: true,
			deleted
		};
	} catch (e) {
		return {
			ok: false,
			deleted: 0,
			error: e.message
		};
	}
}
//#endregion
//#region lib/types/query/files.js
/**
* Files queries over st_control's decrypted hardlink.db (v4 tables).
* File source chat is resolved best-effort from message_resource.db (packed_info)
* joined to contact.db display names, so the read-only file grid can show where a
* media asset came from instead of only a hash name.
*/
/** Coerce a DB cell to a string (null -> '', else String()). */
function cellStr$14(v) {
	if (typeof v === "string") return v;
	if (v === null || v === void 0) return "";
	if (typeof v === "number" || typeof v === "boolean" || typeof v === "bigint" || typeof v === "symbol") return String(v);
	return "";
}
const FILE_TABLES = [
	["image_hardlink_info_v4", "image"],
	["file_hardlink_info_v4", "file"],
	["video_hardlink_info_v4", "video"]
];
/** Read a byte array from a packed_info cell (object of index->byte, or Uint8Array). */
function packedBytes(v) {
	if (v instanceof Uint8Array) return v;
	if (Array.isArray(v)) return new Uint8Array(v.map(Number));
	if (v && typeof v === "object") {
		const vals = Object.values(v);
		if (vals.every((x) => typeof x === "number")) return new Uint8Array(vals.map(Number));
	}
	return new Uint8Array(0);
}
/** Extract a 32-char lowercase hex file key from packed_info. */
function fileKeyFromPacked(packed) {
	const latin = Buffer.from(packedBytes(packed)).toString("latin1");
	const m = /[0-9a-f]{32}/.exec(latin);
	return m ? m[0] : null;
}
/**
* Best-effort map from file key to { source session display name, create time }.
* Joins MessageResourceInfo.packed_info (file key) -> chat_id -> contact name.
* @param decryptedDir - decrypted data root.
* @returns map keyed by the stripped file name.
*/
function loadFileSources(decryptedDir) {
	const map = /* @__PURE__ */ new Map();
	let resDb = null;
	try {
		resDb = new DatabaseSync(join(decryptedDir, "message", "message_resource.db"), { readOnly: true });
	} catch {
		return map;
	}
	try {
		const chatMap = /* @__PURE__ */ new Map();
		const chatRows = resDb.prepare("SELECT rowid, user_name FROM ChatName2Id").all();
		for (const r of chatRows) chatMap.set(Number(r.rowid), cellStr$14(r.user_name));
		const nameMap = contactMeta(decryptedDir).names;
		const infos = resDb.prepare("SELECT chat_id, message_create_time, packed_info FROM MessageResourceInfo ORDER BY message_create_time DESC LIMIT 3000").all();
		for (const row of infos) {
			const key = fileKeyFromPacked(row.packed_info);
			if (!key || map.has(key)) continue;
			const user = chatMap.get(Number(row.chat_id)) ?? "";
			map.set(key, {
				session: nameMap.get(user) || user,
				time: Number(row.message_create_time) || 0
			});
		}
	} catch {} finally {
		resDb.close();
	}
	return map;
}
const FILE_SOURCES_TTL_MS = 3e4;
let fileSourcesCache = null;
function fileSourcesSig(decryptedDir) {
	try {
		const st = statSync(join(decryptedDir, "message", "message_resource.db"));
		return `${st.mtimeMs}:${st.size}`;
	} catch {
		return "";
	}
}
function fileSourcesCached(decryptedDir) {
	const sig = fileSourcesSig(decryptedDir);
	if (fileSourcesCache && fileSourcesCache.sig === sig && Date.now() - fileSourcesCache.at < FILE_SOURCES_TTL_MS) return fileSourcesCache.map;
	const map = loadFileSources(decryptedDir);
	fileSourcesCache = { sig, at: Date.now(), map };
	return map;
}
/**
* 附件目录 → 来源（第 84 轮）。实测：`dir2id` 的值是 8 个月份串 + 80 个 32 位十六进制串，
 * 其中 79 个 = md5(某个 username)（微信用 md5(talker) 命名附件目录）；
 * 图片表 dir1=talker 哈希 / dir2=月份，文件与视频表 dir1=月份 / dir2=0。
* @param decryptedDir - decrypted data root.
* @returns rowid → 月份 / rowid → 会话显示名。
*/
const DIR_SOURCE_TTL_MS = 3e4;
let dirSourceCache = null;
function dirSourceCached(decryptedDir) {
	let sig = "";
	try {
		const st = statSync(join(decryptedDir, "hardlink", "hardlink.db"));
		sig = `${st.mtimeMs}:${st.size}`;
	} catch {}
	if (dirSourceCache && sig !== "" && dirSourceCache.sig === sig && Date.now() - dirSourceCache.at < DIR_SOURCE_TTL_MS) return dirSourceCache;
	const month = new Map();
	const talker = new Map();
	try {
		const db = new DatabaseSync(join(decryptedDir, "hardlink", "hardlink.db"), { readOnly: true });
		try {
			const names = contactMeta(decryptedDir).names;
			const md5ToName = new Map();
			for (const [user, display] of names) {
				if (!user) continue;
				const h = createHash("md5").update(user, "utf8").digest("hex");
				if (!md5ToName.has(h)) md5ToName.set(h, display || user);
			}
			const rows = db.prepare("SELECT rowid AS rid, username FROM dir2id").all();
			for (const r of rows) {
				const rid = Number(r.rid);
				const v = cellStr$14(r.username);
				if (!rid || !v) continue;
				if (/^\d{4}-\d{2}$/.test(v)) {
					month.set(rid, v);
					continue;
				}
				if (/^[0-9a-f]{32}$/i.test(v)) {
					const name = md5ToName.get(v.toLowerCase());
					if (name) talker.set(rid, name);
				}
			}
		} finally {
			db.close();
		}
	} catch {}
	dirSourceCache = { sig, at: Date.now(), month, talker };
	return dirSourceCache;
}
/**
* Read resource files.
*
* 第 83 轮重写：原先「每张表各取 cap 行 → 拼接 → slice(offset, offset+limit)」不是分页 ——
* 第 2 页拿到的是拼接后第 30~60 行（另一张表的前 30 行），跨类目乱跳且永远翻不到第三张表。
* 实测后果：「文件资产」页签只能看到图片（2717），视频 131 / 文件 579 全库打不开。
* 现在是一条 UNION ALL + 全局 ORDER BY modify_time DESC LIMIT ? OFFSET ?，
* 并新增 category 过滤与 counts 分类计数。
* @param decryptedDir - decrypted data root.
* @param limit - page size (default 100).
* @param offset - page offset (default 0).
* @param category - optional category filter: 'image' | 'file' | 'video' (其它值/空 = 全部).
* @returns the files snapshot: page rows, the filtered total and per-category counts.
*/
function queryFiles(decryptedDir, limit, offset = 0, category) {
	const db = new DatabaseSync(join(decryptedDir, "hardlink", "hardlink.db"), { readOnly: true });
	try {
		const want = category && category !== "all" ? category : "";
		const parts = [];
		const counts = {};
		let total = 0;
		for (const [table, cat] of FILE_TABLES) {
			if (!(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table) !== void 0)) {
				counts[cat] = 0;
				continue;
			}
			let n = 0;
			try {
				n = db.prepare("SELECT COUNT(*) AS n FROM " + table).get().n;
			} catch {
				n = 0;
			}
			counts[cat] = n;
			if (want !== "" && cat !== want) continue;
			total += n;
			const cols = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((r) => r.name));
			const sel = (c, dft) => cols.has(c) ? c : dft;
			parts.push([
				"SELECT",
				[
					sel("md5", "''") + " AS md5",
					sel("file_name", "''") + " AS file_name",
					sel("file_size", "0") + " AS file_size",
					sel("modify_time", "_rowid_") + " AS modify_time",
					sel("dir1", "0") + " AS dir1",
					sel("dir2", "0") + " AS dir2",
					`'${cat}' AS category`
				].join(", "),
				"FROM",
				table
			].join(" "));
		}
		const size = limit === void 0 ? 100 : Math.max(0, limit);
		const page = Math.max(0, offset);
		const files = [];
		if (parts.length > 0) {
			try {
				const sql = `SELECT * FROM (${parts.join(" UNION ALL ")}) ORDER BY modify_time DESC LIMIT ? OFFSET ?`;
				const rows = db.prepare(sql).all(size, page);
				const dirSource = dirSourceCached(decryptedDir);
				for (const r of rows) {
					const dir1 = Number(r.dir1 ?? 0);
					const dir2 = Number(r.dir2 ?? 0);
					files.push({
						md5: cellStr$14(r.md5 ?? ""),
						fileName: cellStr$14(r.file_name ?? ""),
						fileSize: Number(r.file_size ?? 0),
						modifyTime: Number(r.modify_time ?? 0),
						category: cellStr$14(r.category ?? ""),
						sourceMonth: dirSource.month.get(dir1) ?? dirSource.month.get(dir2),
						sourceTalker: dirSource.talker.get(dir1) ?? dirSource.talker.get(dir2)
					});
				}
			} catch {}
		}
		const sources = fileSourcesCached(decryptedDir);
		for (const f of files) {
			const key = f.fileName.replace(/\.dat$/i, "").replace(/_(t|h|b|thumb.*)$/i, "");
			const src = sources.get(key);
			if (src) {
				f.sessionName = src.session;
				f.sourceTime = src.time;
			}
		}
		return {
			files,
			total,
			counts
		};
	} finally {
		db.close();
	}
}
//#endregion
//#region lib/types/query/resource-classify.js
/**
* Resource classification shared by the overview and storage aggregates.
* `packed_info` is a protobuf blob, not a filename string, so the blob must be
* parsed to a real file name before extension classification; the type-domain
* fallback keeps labels stable when no name is recoverable.
*/
/**
* Parse the field-2 UTF-8 string out of a packed_info protobuf blob.
* @param blob - the raw packed_info cell (protobuf), or null/undefined when absent.
* @returns the embedded display/file name, or '' when absent or unparseable.
*/
function readVarint$pc(blob, pos) {
	let value = 0;
	let shift = 0;
	let i = pos;
	while (i < blob.length) {
		const b = blob[i] ?? 0;
		i += 1;
		value |= (b & 127) << shift;
		if ((b & 128) === 0) return { value: value >>> 0, next: i };
		shift += 7;
		if (shift > 28) return null;
	}
	return null;
}
/** 该字符串是否「看起来是文本」：不含控制字符（换行/制表除外）且含至少一个可见字符。 */
function looksLikeText$pc(s) {
	if (!s) return false;
	if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(s)) return false;
	return /[\p{L}\p{N}]/u.test(s);
}
/**
 * 解析 packed_info 里的文件名。结构（实测）：
 *   0a <len> { 0a <len> <文件名>  12 <len> <文件名> }
 * 名字在「顶层字段1的嵌套消息」里的**内层字段1**。旧实现只在顶层找 field 2 → 恒返回空，
 * 导致 ① 存储分类退化（0x33_0003 的 2,053 个 PDF 记成「视频」、0x34_0003 的 1,940 个 docx 记成「表情」）
 * ② 大文件名大量缺失（top-100 里 70 条显示「未知文件名」/纯类型）。
 */
function parsePackedName(blob) {
	if (!blob || blob.length === 0) return "";
	const found = [];
	const walk = (start, end, level) => {
		let i = start;
		while (i < end) {
			const tag = readVarint$pc(blob, i);
			if (!tag) return;
			i = tag.next;
			const field = tag.value >>> 3;
			const wire = tag.value & 7;
			if (wire === 2) {
				const len = readVarint$pc(blob, i);
				if (!len) return;
				i = len.next;
				const stop = i + len.value;
				if (stop > end) return;
				const text = new TextDecoder("utf-8", { fatal: false }).decode(blob.subarray(i, stop));
				if (looksLikeText$pc(text)) found.push({ level, field, text: text.trim() });
				else if (level < 2) walk(i, stop, level + 1);
				i = stop;
			} else if (wire === 0) {
				const v = readVarint$pc(blob, i);
				if (!v) return;
				i = v.next;
			} else if (wire === 5) i += 4;
			else if (wire === 1) i += 8;
			else return;
		}
	};
	walk(0, blob.length, 0);
	if (found.length === 0) return "";
	const pick = found.find((f) => f.level === 1 && f.field === 1) ?? found.find((f) => f.level === 1 && f.field === 2) ?? found.find((f) => f.level === 0 && f.field === 2) ?? found[0];
	return pick ? pick.text : "";
}
/**
* Classify a resource by file extension first, then by the high type-domain bits.
* @param type - MessageResourceDetail type code.
* @param fileName - the (already-decoded) file name, or '' when unavailable.
* @returns the display category label.
*/
function classifyType(type, fileName) {
	// v8 ignore next -- String.split always yields a non-empty array, so pop() never returns undefined.
	const ext = (fileName.split(".").pop() ?? "").toLowerCase();
	if ([
		"jpg",
		"jpeg",
		"png",
		"gif",
		"webp",
		"bmp",
		"heic",
		"heif"
	].includes(ext)) return "图片";
	if ([
		"mp4",
		"mov",
		"avi",
		"mkv",
		"webm",
		"flv",
		"wmv"
	].includes(ext)) return "视频";
	if ([
		"mp3",
		"wav",
		"m4a",
		"silk",
		"amr",
		"ogg",
		"flac",
		"aac"
	].includes(ext)) return "音频";
	if ([
		"pdf",
		"doc",
		"docx",
		"xls",
		"xlsx",
		"ppt",
		"pptx",
		"txt",
		"md",
		"wps",
		"csv"
	].includes(ext)) return "文档";
	if ([
		"zip",
		"rar",
		"7z",
		"tar",
		"gz"
	].includes(ext)) return "压缩包";
	if ([
		"exe",
		"msi",
		"apk",
		"bat",
		"cmd"
	].includes(ext)) return "程序";
	const domain = type & 983040;
	if (domain === 65536) return "图片";
	if (domain === 131072 || domain === 196608) return "视频";
	if (domain === 262144) return "表情";
	return "其他";
}
/**
* Classify a packed_info blob: parse its embedded file name (when present) and
* classify by extension, falling back to the type-domain map.
* @param type - MessageResourceDetail type code.
* @param blob - the raw packed_info cell (protobuf), or null/undefined.
* @returns the display category label.
*/
function classifyPacked(type, blob) {
	return classifyType(type, parsePackedName(blob));
}
//#endregion
//#region lib/types/query/overview.js
/**
* Overview (数据总览) aggregate stats over st_control's decrypted DBs.
* Mirrors the Rust get_wechat_data_overview: one-screen asset summary.
*/
function countRows$1(path, table, where = "") {
	if (!existsSync(path)) return 0;
	try {
		const db = new DatabaseSync(path, { readOnly: true });
		if (!(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table) !== void 0)) {
			db.close();
			return 0;
		}
		const sql = `SELECT COUNT(*) AS n FROM ${table}${where ? " WHERE " + where : ""}`;
		const r = db.prepare(sql).get();
		db.close();
		return r.n;
	} catch {
		return 0;
	}
}
/** Stringify a DB cell. */
function cellStr$13(v) {
	if (typeof v === "string") return v;
	if (v === null || v === void 0) return "";
	if (typeof v === "number" || typeof v === "boolean" || typeof v === "bigint" || typeof v === "symbol") return String(v);
	if (v instanceof Uint8Array) return new TextDecoder("utf-8", { fatal: false }).decode(v);
	return "";
}
/** 朋友圈 XML 里的第一个 <nickname> 显示名。 */
function xmlNickname(xml) {
	const m = xml.match(/<nickname>([^<]*)<\/nickname>/);
	return m ? (m[1] ?? "").replace(/&amp;/g, "&") : "";
}
/**
* Count revoked-message cache rows across every message shard. The cache
* table (`_weflow_anti_revoke_deleted_cache`) lives in whichever shard holds
* it — hardcoding message_0.db misses revokes recorded in other shards.
* @param dec - decrypted data root.
* @returns the total row count across all shards.
*/
function countRevokedAcrossShards(dec) {
	const msgDir = join(dec, "message");
	if (!existsSync(msgDir)) return 0;
	let total = 0;
	for (const file of readdirSync(msgDir)) {
		if (!file.endsWith(".db") || file.includes("_shm") || file.includes("_wal") || file.includes("tmp")) continue;
		try {
			const db = new DatabaseSync(join(msgDir, file), { readOnly: true });
			try {
				const hit = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name).find((t) => t.includes("_weflow_anti_revoke_deleted_cache"));
				if (hit) total += db.prepare(`SELECT COUNT(*) AS n FROM "${hit}"`).get().n;
			} finally {
				db.close();
			}
		} catch {}
	}
	return total;
}
/**
* Aggregate the overview stats.
* @param decryptedDir - decrypted data root.
* @returns the overview result.
*/
function queryOverview(decryptedDir) {
	const dec = decryptedDir;
	const sig = [
		fileSigOf(join(dec, "session", "session.db")),
		fileSigOf(join(dec, "contact", "contact.db")),
		fileSigOf(join(dec, "sns", "sns.db")),
		fileSigOf(join(dec, "sns", "db_sns", "sns.db")),
		fileSigOf(join(dec, "favorite", "favorite.db")),
		fileSigOf(join(dec, "emoticon", "emoticon.db")),
		fileSigOf(join(dec, "message", "message_resource.db")),
		shardCatalogSig(dec, ["message"])
	].join("|");
	return cachedBySig("overview:" + dec, sig, () => computeOverview(dec), 3e4);
}
function computeOverview(dec) {
	const cstats = queryContacts(dec).stats;
	const sessions = countRows$1(join(dec, "session", "session.db"), "SessionTable");
	const groups = cstats.group ?? 0;
	const contacts = cstats.friend ?? 0;
	const official = (cstats.official ?? 0) + (cstats.service ?? 0);
	const moments = countRows$1(join(dec, "sns", "sns.db"), "SnsTimeLine");
	const favorites = countRows$1(join(dec, "favorite", "favorite.db"), "fav_db_item");
	const emoticons = countRows$1(join(dec, "emoticon", "emoticon.db"), "kNonStoreEmoticonTable");
	const revoked = countRevokedAcrossShards(dec);
	let total_size = 0;
	let total_count = 0;
	const categories = [];
	const resourcePath = join(dec, "message", "message_resource.db");
	if (existsSync(resourcePath)) try {
		const db = new DatabaseSync(resourcePath, { readOnly: true });
		if (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='MessageResourceDetail'").get() !== void 0) {
			const agg = db.prepare("SELECT COALESCE(SUM(size), 0) AS s, COUNT(*) AS n FROM MessageResourceDetail").get();
			total_size = agg.s;
			total_count = agg.n;
			const rows = db.prepare("SELECT type, COUNT(*) AS c, SUM(size) AS s FROM MessageResourceDetail GROUP BY type").all();
			const catMap = /* @__PURE__ */ new Map();
			for (const r of rows) {
				const sample = db.prepare("SELECT packed_info FROM MessageResourceDetail WHERE type = ? LIMIT 1").get(r.type);
				const label = classifyPacked(r.type, sample?.packed_info);
				const cur = catMap.get(label) ?? {
					label,
					count: 0,
					size: 0
				};
				cur.count += r.c;
				cur.size += r.s;
				catMap.set(label, cur);
			}
			for (const c of catMap.values()) categories.push(c);
		}
		db.close();
	} catch {}
	const moments_authors = [];
	const snsPath = existsSync(join(dec, "sns", "db_sns", "sns.db")) ? join(dec, "sns", "db_sns", "sns.db") : join(dec, "sns", "sns.db");
	if (existsSync(snsPath)) try {
		const db = new DatabaseSync(snsPath, { readOnly: true });
		if (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='SnsTimeLine'").get() !== void 0) {
			const cols = new Set(db.prepare("PRAGMA table_info(SnsTimeLine)").all().map((r) => r.name));
			const uname = cols.has("user_name") ? "user_name" : "userName";
			const cname = cols.has("content") ? "content" : "Content";
			const rows = db.prepare(`SELECT ${uname} AS u, ${cname} AS c FROM SnsTimeLine`).all();
			const names = contactMeta(dec).names;
			const authorMap = /* @__PURE__ */ new Map();
			for (const r of rows) {
				const u = cellStr$13(r.u);
				if (!u) continue;
				const cur = authorMap.get(u);
				if (cur) cur.posts += 1;
				else authorMap.set(u, {
					name: names.get(u) || xmlNickname(cellStr$13(r.c)) || u,
					posts: 1
				});
			}
			const sorted = Array.from(authorMap.entries()).map(([username, v]) => ({
				username,
				name: v.name,
				posts: v.posts
			})).sort((a, b) => b.posts - a.posts).slice(0, 20);
			for (const a of sorted) moments_authors.push(a);
		}
		db.close();
	} catch {}
	return {
		sessions,
		groups,
		contacts,
		official,
		moments,
		favorites,
		emoticons,
		revoked,
		storage: {
			total_size,
			total_count,
			categories
		},
		moments_authors
	};
}
//#endregion
//#region lib/types/query/records.js
/**
* Records queries (撤回/转账/红包/视频号/小程序/好友验证) over general.db,
* rewritten from st_control general_records/lists.rs. The revoked cache lives
* in message shards (handlers/data/revoked.rs mirror).
*/
/** Stringify an SQLite cell (TEXT/NUMBER/BLOB) to a string. */
function cellString$5(v) {
	if (v === null || v === void 0) return "";
	if (typeof v === "string") return v;
	if (v instanceof Uint8Array) return new TextDecoder("utf-8", { fatal: false }).decode(v);
	if (typeof v === "number" || typeof v === "boolean" || typeof v === "bigint" || typeof v === "symbol") return String(v);
	return "";
}
function countIn(db, table) {
	try {
		return db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
	} catch {
		return 0;
	}
}
/** Count rows with an optional WHERE clause. */
function countWhere(db, table, whereSql) {
	try {
		if (!whereSql) return countIn(db, table);
		return db.prepare("SELECT COUNT(*) AS n FROM " + table + whereSql).get().n;
	} catch {
		return 0;
	}
}
/** Query one records table with limit/offset/keyword/direction, returning rows as objects. */
function queryTable(db, table, cols, orderCol, limit, offset, whereSql = "", direction = "desc") {
	try {
		const sel = cols.map((c) => c).join(", ");
		const dir = direction === "asc" ? "ASC" : "DESC";
		const sql = "SELECT " + sel + " FROM " + table + whereSql + " ORDER BY " + orderCol + " " + dir + " LIMIT ? OFFSET ?";
		return db.prepare(sql).all(limit, offset);
	} catch {
		return [];
	}
}
/** Build a numeric time-range WHERE fragment for a time column. */
function timeRangeSql(timeCol, from, to) {
	const parts = [];
	if (from > 0) parts.push(" " + timeCol + " >= " + String(Math.floor(from)));
	if (to > 0) parts.push(" " + timeCol + " <= " + String(Math.floor(to)));
	return parts.length > 0 ? parts.join(" AND") : "";
}
/** Locate the revoke cache table across message shards. */
function findRevokeTable(decryptedDir) {
	const msgDir = join(decryptedDir, "message");
	if (!existsSync(msgDir)) return {
		db: null,
		table: ""
	};
	for (const file of readdirSync(msgDir)) {
		if (!file.endsWith(".db") || file.includes("_shm") || file.includes("_wal")) continue;
		try {
			const db = new DatabaseSync(join(msgDir, file), { readOnly: true });
			const hit = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => String(r.name)).find((t) => t.includes("_weflow_anti_revoke_deleted_cache"));
			if (hit) return {
				db,
				table: hit
			};
			db.close();
		} catch {}
	}
	return {
		db: null,
		table: ""
	};
}
/** 为记录追加「人类可读」展示字段（显示名）。 */
function enrichRecords(items, kind, names) {
	const dn = (v) => {
		const s = cellString$5(v);
		return s ? names.get(s) ?? "" : "";
	};
	for (const it of items) {
		if (kind === "revokes") it["session_display"] = dn(it["session_name"]);
		if (kind === "transfers") {
			it["session_display"] = dn(it["session_name"]);
			it["receiver_display"] = dn(it["pay_receiver"]);
			it["payer_display"] = dn(it["pay_payer"]);
		}
		if (kind === "redpackets") {
			it["session_display"] = dn(it["session_name"]);
			it["sender_display"] = dn(it["sender_user_name"]);
		}
		if (kind === "finder") it["username_display"] = dn(it["finder_username"]);
		if (kind === "friendverifications") it["user_display"] = dn(it["user_name_"]);
	}
}
/** Record-type words that are data-source names, not record content (source stopwords). */
function isRecordTypeStopword(q) {
	return [
		"红包",
		"转账",
		"转帐",
		"收款",
		"付款",
		"收红包",
		"发红包",
		"红包记录",
		"转账记录",
		"redpacket",
		"red_packet",
		"transfer",
		"转账明细",
		"红包明细"
	].includes(q.trim().toLowerCase());
}
/**
* Query one records kind.
* @param decryptedDir - decrypted data root.
* @param kind - records kind key.
* @param limit - max rows.
* @param offset - page offset.
* @param q - optional session/user/id keyword (applied server-side per kind).
* @returns the records snapshot.
*/
function queryRecords(decryptedDir, kind, limit, offset, q, opts) {
	const gdb = join(decryptedDir, "general", "general.db");
	if (!existsSync(gdb)) return {
		items: [],
		total: 0
	};
	const db = new DatabaseSync(gdb, { readOnly: true });
	try {
		const cap = Math.min(limit ?? 50, 500);
		const off = offset ?? 0;
		const kw = (q ?? "").trim();
		const from = Math.max(0, opts?.from ?? 0);
		const to = Math.max(0, opts?.to ?? 0);
		const direction = opts?.direction === "asc" ? "asc" : "desc";
		const esc = (v) => v.replace(/'/g, "''");
		const names = contactMeta(decryptedDir).names;
		const s = {
			revokes: {
				table: "revokebatchmessage",
				cols: [
					"local_id",
					"batch_id",
					"msg_unique_id",
					"session_name",
					"msg_local_id",
					"msg_create_time"
				],
				order: "msg_create_time",
				timeCol: "msg_create_time",
				where: kw ? ` WHERE session_name LIKE '%${esc(kw)}%' OR msg_unique_id LIKE '%${esc(kw)}%'` : ""
			},
			transfers: {
				table: "transferTable",
				cols: [
					"transfer_id",
					"transcation_id",
					"CAST(message_server_id AS TEXT) AS message_server_id",
					"CAST(second_message_server_id AS TEXT) AS second_message_server_id",
					"session_name",
					"pay_sub_type",
					"pay_receiver",
					"pay_payer",
					"begin_transfer_time",
					"last_modified_time",
					"invalid_time",
					"last_update_time",
					"delay_confirm_flag"
				],
				order: "begin_transfer_time",
				timeCol: "begin_transfer_time",
				where: kw && !isRecordTypeStopword(kw) ? ` WHERE session_name LIKE '%${esc(kw)}%' OR transfer_id LIKE '%${esc(kw)}%'` : ""
			},
			redpackets: {
				table: "redEnvelopeTable",
				cols: [
					"CAST(message_server_id AS TEXT) AS message_server_id",
					"session_name",
					"sender_user_name",
					"native_url",
					"send_id",
					"scene_id",
					"hb_status",
					"hb_type",
					"receive_status"
				],
				order: "message_server_id",
				where: kw && !isRecordTypeStopword(kw) ? ` WHERE session_name LIKE '%${esc(kw)}%' OR sender_user_name LIKE '%${esc(kw)}%'` : ""
			},
			finder: {
				table: "wcfinderlivestatus",
				cols: [
					"finder_live_id",
					"finder_username",
					"finder_export_id",
					"live_status",
					"replay_status",
					"charge_flag"
				],
				order: "finder_live_id"
			},
			miniprograms: {
				table: "wacontact",
				cols: [
					"user_name",
					"type",
					"brand_icon_url",
					"external_info",
					"app_id"
				],
				order: "user_name",
				timeCol: "last_update_time"
			},
			friendverifications: {
				table: "FMessageTable",
				cols: [
					"user_name_",
					"type_",
					"timestamp_",
					"content_",
					"is_sender_",
					"scene_",
					"remark_"
				],
				order: "timestamp_",
				timeCol: "timestamp_",
				where: kw ? ` WHERE user_name_ LIKE '%${esc(kw)}%' OR remark_ LIKE '%${esc(kw)}%' OR content_ LIKE '%${esc(kw)}%'` : ""
			}
		}[kind];
		if (!s) return {
			items: [],
			total: 0
		};
		const combineWhere = (base, time) => {
			const b = base.trim();
			const t = time.trim();
			if (!b) return t ? " WHERE " + t : "";
			if (!t) return b;
			return " WHERE (" + b.replace(/^WHERE\s+/i, "") + ") AND " + t;
		};
		const timeSql = (timeCol) => timeRangeSql(timeCol, from, to);
		if (kind === "miniprograms") {
			const sel = s.cols.map((c) => "w." + c).join(", ") + ", COALESCE(a.last_update_time, 0) AS last_update_time";
			const whereSql = combineWhere(kw ? " WHERE w.user_name LIKE '" + esc(kw) + "%'" : "", s.timeCol ? timeSql("a." + s.timeCol) : "");
			const dir = direction === "asc" ? "ASC" : "DESC";
			const sql = "SELECT " + sel + " FROM wacontact w LEFT JOIN WeAppBizAttrSyncBufferTableV02 a ON a.user_name = w.user_name" + whereSql + " ORDER BY COALESCE(a.last_update_time, 0) " + dir + ", w.user_name ASC LIMIT ? OFFSET ?";
			let items = [];
			try {
				items = db.prepare(sql).all(cap, off);
			} catch {
				items = [];
			}
			for (const it of items) {
				const ext = String(it["external_info"] ?? "");
				let nickname = "";
				try {
					const v = JSON.parse(ext);
					nickname = cellString$5(v.RegisterSource?.NickName || v.NickName || "");
				} catch {}
				it["nickname"] = nickname;
			}
			enrichRecords(items, kind, names);
			let total = 0;
			try {
				total = db.prepare("SELECT COUNT(*) AS n FROM wacontact w LEFT JOIN WeAppBizAttrSyncBufferTableV02 a ON a.user_name = w.user_name" + whereSql).get().n;
			} catch {
				total = 0;
			}
			return {
				items,
				total
			};
		}
		const whereSql = combineWhere(s.where ?? "", s.timeCol ? timeSql(s.timeCol) : "");
		const items = queryTable(db, s.table, s.cols, s.order, cap, off, whereSql, direction);
		enrichRecords(items, kind, names);
		return {
			items,
			total: countWhere(db, s.table, whereSql)
		};
	} finally {
		db.close();
	}
}
/** WeChat message local_type → Chinese label (mirror handlers/data/revoked.rs). */
function revokeTypeLabel(t) {
	switch (t) {
		case 1: return "文本";
		case 3: return "图片";
		case 34: return "语音";
		case 42: return "名片";
		case 43: return "视频";
		case 47: return "表情";
		case 48: return "位置";
		case 49: return "文件/链接";
		case 1e4: return "系统消息";
		default: return "其他";
	}
}
/** Parse message_content `sender:\n内容` (mirror handlers/data/revoked.rs). */
function parseRevokeContent(raw, fallbackSender) {
	if (raw == null) return {
		sender: fallbackSender,
		content: "（无内容副本）"
	};
	const nl = raw.indexOf("\n");
	let sender = fallbackSender;
	let body = raw;
	if (nl >= 0) {
		const head = raw.slice(0, nl).replace(/:+$/, "").trim();
		if (head) sender = head;
		body = raw.slice(nl + 1);
	}
	const content = body.trim();
	return {
		sender,
		content: content || "（内容为编码/压缩格式，无法预览）"
	};
}
/**
* Query revoked messages from the anti-revoke cache (source shape:
* sender / type_label / content / create_time, time-descending).
* @param decryptedDir - decrypted data root.
* @param limit - max rows (default 200, capped 500).
* @returns the revoked snapshot.
*/
function queryRevoked(decryptedDir, limit, offset = 0) {
	const { db, table } = findRevokeTable(decryptedDir);
	if (db === null || !table) return {
		items: [],
		total: 0
	};
	try {
		const cap = Math.min(limit ?? 200, 500);
		const cols = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((r) => r.name));
		const sel = (cand, dft) => cols.has(cand) ? cand : dft;
		const items = db.prepare(`SELECT ${sel("local_type", "0")} AS lt, ${sel("real_sender_id", "0")} AS rid, ${sel("create_time", "0")} AS ct, ${sel("message_content", "''")} AS mc FROM ${table} ORDER BY create_time DESC LIMIT ? OFFSET ?`).all(cap, offset).map((r) => {
			const t = r.lt ?? 0;
			const realId = r.rid ?? 0;
			const fallback = realId > 0 ? `发送者#${realId}` : "未知发送者";
			const { sender, content } = parseRevokeContent(cellString$5(r.mc), fallback);
			return {
				sender,
				type_label: revokeTypeLabel(t),
				content,
				create_time: r.ct ?? 0
			};
		});
		return {
			items,
			total: db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n ?? items.length
		};
	} finally {
		db.close();
	}
}
//#endregion
//#region lib/types/query/emoticons.js
/**
* Emoticon queries over emoticon.db, mirroring the Rust modules/emoticons.rs:
* custom emoticons from kNonStoreEmoticonTable and store packages from
* kStoreEmoticonPackageTable (+ per-package file counts). Static bundled
* emoticons have no DSH counterpart (source ships them in public/wechat/).
*/
/** Coerce a DB cell to a string (null -> '', else String()). */
function cellStr$12(v) {
	if (typeof v === "string") return v;
	if (v === null || v === void 0) return "";
	if (typeof v === "number" || typeof v === "boolean" || typeof v === "bigint" || typeof v === "symbol") return String(v);
	return "";
}
function tableColumns$9(db, table) {
	try {
		const rows = db.prepare(`PRAGMA table_info(${table})`).all();
		return new Set(rows.map((r) => r.name));
	} catch {
		return /* @__PURE__ */ new Set();
	}
}
/** Pick the first present column among candidates; null when none exist. */
function col(cols, cands) {
	for (const c of cands) if (cols.has(c)) return c;
	return null;
}
/**
* Read custom emoticons + store packages.
* @param decryptedDir - decrypted data root.
* @param limit - max custom rows.
* @returns the emoticons snapshot.
*/
function queryEmoticons(decryptedDir, limit, offset = 0) {
	return cachedBySig("emoticons:" + decryptedDir + ":" + String(limit ?? "") + ":" + String(offset), fileSigOf(join(decryptedDir, "emoticon", "emoticon.db")), () => computeEmoticons(decryptedDir, limit, offset));
}
function computeEmoticons(decryptedDir, limit, offset = 0) {
	const path = join(decryptedDir, "emoticon", "emoticon.db");
	if (!existsSync(path)) return {
		custom: [],
		static: [],
		packages: [],
		total: 0,
		orderedBy: "builtin"
	};
	const db = new DatabaseSync(path, { readOnly: true });
	try {
		const custom = [];
		let customOrderedBy = "builtin";
		const cCols = tableColumns$9(db, "kNonStoreEmoticonTable");
		if (cCols.size > 0) {
			const md5Col = col(cCols, [
				"md5",
				"MD5",
				"md5_"
			]);
			const typeCol = col(cCols, [
				"type",
				"Type",
				"type_"
			]);
			const captionCol = col(cCols, [
				"caption",
				"Caption",
				"caption_"
			]);
			if (md5Col) {
				const cap = Math.min(limit ?? 500, 2e3);
				// 展示顺序来自 kFavEmoticonOrderTable（只有 md5 一列，行序即排列顺序），
				// 而不是 kNonStoreEmoticonTable 的内置行序。实测两者是同一组 30 个 md5，
				// 逐位比较仅 1/30 相同。排序放在 SQL 里，分页仍然正确；不在顺序表中的排最后。
				const sel = [
					`t.${md5Col} AS md5`,
					typeCol ? `t.${typeCol} AS item_type` : `0 AS item_type`,
					captionCol ? `t.${captionCol} AS caption` : `'' AS caption`
				].join(", ");
				const plain = `SELECT ${sel} FROM kNonStoreEmoticonTable t ORDER BY t.rowid LIMIT ? OFFSET ?`;
				const hasOrder = tableColumns$9(db, "kFavEmoticonOrderTable").has("md5");
				let rows;
				if (hasOrder) {
					const ordered = `SELECT ${sel} FROM kNonStoreEmoticonTable t
            LEFT JOIN (SELECT md5 AS omd5, MIN(rowid) AS ord FROM kFavEmoticonOrderTable GROUP BY md5) o
              ON o.omd5 = t.${md5Col}
            ORDER BY (o.ord IS NULL), o.ord, t.rowid LIMIT ? OFFSET ?`;
					try {
						rows = db.prepare(ordered).all(cap, offset);
						customOrderedBy = "wechat";
					} catch {
						rows = db.prepare(plain).all(cap, offset);
					}
				} else {
					rows = db.prepare(plain).all(cap, offset);
				}
				for (const r of rows) {
					const md5 = cellStr$12(r.md5 ?? "").trim();
					if (!md5) continue;
					const item = {
						md5,
						item_type: Number(r.item_type ?? 0)
					};
					const caption = cellStr$12(r.caption ?? "").trim();
					if (caption) item.caption = caption;
					custom.push(item);
				}
			}
		}
		const packages = [];
		const pCols = tableColumns$9(db, "kStoreEmoticonPackageTable");
		if (pCols.size > 0) {
			const idCol = col(pCols, [
				"package_id_",
				"package_id",
				"product_id_",
				"product_id",
				"id_"
			]);
			const nameCol = col(pCols, [
				"package_name_",
				"name_",
				"title_",
				"name",
				"title"
			]);
			if (idCol && nameCol) {
				// 表情包自带真实的 sort_order_ 列，按它排；无该列时退回 rowid。
				const sortCol = col(pCols, [
					"sort_order_",
					"sort_order",
					"order_",
					"sort"
				]);
				const orderBy = sortCol ? ` ORDER BY ${sortCol}, rowid` : " ORDER BY rowid";
				const rows = db.prepare(`SELECT ${idCol} AS pid, ${nameCol} AS name FROM kStoreEmoticonPackageTable${orderBy} LIMIT 500`).all();
				for (const r of rows) {
					const pid = cellStr$12(r.pid ?? "").trim();
					const name = cellStr$12(r.name ?? "").trim() || pid || "未命名表情包";
					let count = 0;
					if (pid) try {
						const fcols = tableColumns$9(db, "kStoreEmoticonFilesTable");
						if (fcols.size > 0) {
							const fpid = col(fcols, [
								"package_id_",
								"package_id",
								"product_id_",
								"product_id"
							]);
							if (fpid) count = db.prepare(`SELECT COUNT(*) AS n FROM kStoreEmoticonFilesTable WHERE ${fpid} = ?`).get(pid).n;
						}
					} catch {
						count = 0;
					}
					packages.push({
						name,
						count
					});
				}
			}
		}
		let total = custom.length;
		if (cCols.size > 0) try {
			total = db.prepare("SELECT COUNT(*) AS n FROM kNonStoreEmoticonTable").get().n;
		} catch {}
		return {
			custom,
			static: [],
			packages,
			total,
			orderedBy: customOrderedBy
		};
	} finally {
		db.close();
	}
}
//#endregion
//#region lib/types/query/storage.js
/**
* Storage stats over message_resource.db, mirroring handlers/data/storage.rs:
* total / categories (extension-priority + type-domain fallback) / chat &
* sender rankings via MessageResourceInfo + name2id rowid maps / large files
* with protobuf-parsed packed_info names.
*/
const ZSTD_MAGIC$7 = Buffer.from([
	40,
	181,
	47,
	253
]);
function decodeMsgText(v) {
	if (v === null || v === void 0) return "";
	if (typeof v === "string") return v;
	const raw = Buffer.from(v instanceof Uint8Array ? v : []);
	const bytes = raw.length >= 4 && raw.subarray(0, 4).equals(ZSTD_MAGIC$7) ? (() => {
		try {
			return Buffer.from(decompress(raw));
		} catch {
			return raw;
		}
	})() : raw;
	try {
		return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
	} catch {
		return new TextDecoder("gbk", { fatal: false }).decode(bytes);
	}
}
function xmlTitle(xml) {
	const m = xml.match(/<title>([^<]*)<\/title>/);
	return m ? (m[1] ?? "").trim() : "";
}
/** 找到包含指定会话消息表的 shard（db + table）。走共享分片目录缓存，不再逐库开句柄探测。 */
function findMsgShard(dec, username) {
	const table = "Msg_" + createHash("md5").update(username, "utf8").digest("hex");
	for (const sh of shardCatalogDirs(dec, ["message", "bizchat"])) if (sh.tables.has(table)) return {
		db: sh.file,
		table
	};
	return null;
}
/** 通过消息 server_id 反查 appmsg <title>（真实文件名来源之一）。 */
function resolveFileTitle(dec, username, svr) {
	if (!svr) return "";
	const sh = findMsgShard(dec, username);
	if (!sh) return "";
	try {
		const db = new DatabaseSync(sh.db, { readOnly: true });
		try {
			const cols = new Set(db.prepare("PRAGMA table_info(" + sh.table + ")").all().map((r) => r.name));
			if (!cols.has("server_id")) return "";
			const content = cols.has("message_content") ? "message_content" : "content";
			let numeric = null;
			if (/^\d+$/.test(svr)) try {
				numeric = BigInt(svr);
			} catch {}
			let row;
			if (numeric !== null) row = db.prepare("SELECT " + content + " AS c FROM " + sh.table + " WHERE server_id = ? LIMIT 1").get(numeric);
			if (!row) row = db.prepare("SELECT " + content + " AS c FROM " + sh.table + " WHERE CAST(server_id AS TEXT) = ? LIMIT 1").get(svr);
			return row ? xmlTitle(decodeMsgText(row.c)) : "";
		} finally {
			db.close();
		}
	} catch {
		return "";
	}
}
/** 扫描 msg/file 各月份子目录，建立 size -> 原文件名 映射（还原大文件真实文件名）。 */
function loadFileNamesBySize(wechatBaseDir) {
	if (!wechatBaseDir) return /* @__PURE__ */ new Map();
	const root = join(wechatBaseDir, "msg", "file");
	if (!existsSync(root)) return /* @__PURE__ */ new Map();
	return cachedBySig("storage-file-names:" + root, fileSigOf(root), () => {
		const map = /* @__PURE__ */ new Map();
		try {
			for (const e of readdirSync(root, { withFileTypes: true })) {
				if (!e.isDirectory()) continue;
				const sub = join(root, e.name);
				for (const f of readdirSync(sub, { withFileTypes: true })) {
					if (f.isDirectory()) continue;
					const p = join(sub, f.name);
					try {
						const st = statSync(p);
						if (st.isFile()) map.set(st.size, f.name);
					} catch {}
				}
			}
		} catch {}
		return map;
	}, 3e4);
}
/**
* Aggregate storage stats (source collect_stats).
* @param decryptedDir - decrypted data root.
* @param wechatBaseDir - raw WeChat install root (msg/file 原文件名还原).
* @returns the storage snapshot.
*/
function queryStorageStats(decryptedDir, wechatBaseDir) {
	const path = join(decryptedDir, "message", "message_resource.db");
	if (!existsSync(path)) return {
		total_size: 0,
		total_count: 0,
		categories: [],
		chats: [],
		senders: [],
		large_files: []
	};
	const db = new DatabaseSync(path, { readOnly: true });
	try {
		if (!(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='MessageResourceDetail'").get() !== void 0)) return {
			total_size: 0,
			total_count: 0,
			categories: [],
			chats: [],
			senders: [],
			large_files: []
		};
		const agg = db.prepare("SELECT COALESCE(SUM(size), 0) AS s, COUNT(*) AS n FROM MessageResourceDetail").get();
		const typeRows = db.prepare("SELECT type, COUNT(*) AS c, SUM(size) AS s FROM MessageResourceDetail GROUP BY type").all();
		const catMap = /* @__PURE__ */ new Map();
		for (const r of typeRows) {
			const sample = db.prepare("SELECT packed_info FROM MessageResourceDetail WHERE type = ? LIMIT 1").get(r.type);
			const label = classifyPacked(r.type, sample?.packed_info);
			const cur = catMap.get(label) ?? {
				count: 0,
				size: 0
			};
			cur.count += r.c;
			cur.size += r.s;
			catMap.set(label, cur);
		}
		const categories = Array.from(catMap.entries()).map(([label, v]) => ({
			label,
			count: v.count,
			size: v.size
		}));
		const names = contactMeta(decryptedDir).names;
		const chats = db.prepare(`
      SELECT COALESCE(c.user_name, '(未知会话)') AS u, COUNT(*) AS n, SUM(d.size) AS s
      FROM MessageResourceDetail d
      JOIN MessageResourceInfo i ON d.message_id = i.message_id
      LEFT JOIN ChatName2Id c ON c.rowid = i.chat_id
      GROUP BY i.chat_id ORDER BY SUM(d.size) DESC LIMIT 50`).all().map((r) => ({
			username: r.u,
			name: names.get(r.u) ?? "",
			count: r.n,
			size: r.s
		}));
		const senders = db.prepare(`
      SELECT COALESCE(s.user_name, '(未知发送者)') AS u, COUNT(*) AS n, SUM(d.size) AS s
      FROM MessageResourceDetail d
      JOIN MessageResourceInfo i ON d.message_id = i.message_id
      LEFT JOIN SenderName2Id s ON s.rowid = i.sender_id
      GROUP BY i.sender_id ORDER BY SUM(d.size) DESC LIMIT 50`).all().map((r) => ({
			username: r.u,
			name: names.get(r.u) ?? "",
			count: r.n,
			size: r.s
		}));
		const bigRows = db.prepare(`
      SELECT d.size AS s, d.type AS ty, d.data_index AS di, d.packed_info AS p, d.create_time AS ct, COALESCE(c.user_name, '') AS u,
             CAST(i.message_svr_id AS TEXT) AS svr
      FROM MessageResourceDetail d
      JOIN MessageResourceInfo i ON d.message_id = i.message_id
      LEFT JOIN ChatName2Id c ON c.rowid = i.chat_id
      ORDER BY d.size DESC LIMIT 100`).all();
		const sizeToName = loadFileNamesBySize(wechatBaseDir);
		const large_files = bigRows.map((r) => {
			const packedName = parsePackedName(r.p ?? null);
			const cat = classifyType(r.ty, packedName);
			let name = packedName || sizeToName.get(r.s) || resolveFileTitle(decryptedDir, r.u, r.svr) || "";
			if (!name) if (cat === "图片" || cat === "视频" || cat === "音频" || cat === "表情") name = "[" + cat + "]";
			else if (r.di && r.di !== "0") name = r.di + ".dat";
			else name = "(未知文件名)";
			return {
				name,
				username: r.u,
				sessionName: names.get(r.u) ?? "",
				create_time: r.ct,
				size: r.s
			};
		});
		return {
			total_size: agg.s,
			total_count: agg.n,
			categories,
			chats,
			senders,
			large_files
		};
	} finally {
		db.close();
	}
}
//#endregion
//#region lib/types/query/annual.js
/**
* Annual summary: available years derived from message timestamps across the
* message shards (a session's last_timestamp is recent even when a chat has
* older messages), so every year with messages shows up as a selectable report.
*/
/**
* List available years (descending) from actual message create_time values.
* @param decryptedDir - decrypted data root.
* @returns years with messages, and no count summary (a separate query owns it).
*/
function queryAnnual(decryptedDir) {
	return cachedBySig("annual:" + decryptedDir, shardCatalogSig(decryptedDir, ["message"]), () => computeAnnual(decryptedDir), 3e4);
}
function computeAnnual(decryptedDir) {
	const msgDir = join(decryptedDir, "message");
	if (!existsSync(msgDir)) return { years: [] };
	const years = /* @__PURE__ */ new Set();
	const files = readdirSync(msgDir).filter((f) => f.endsWith(".db") && !f.includes("_shm") && !f.includes("_wal") && !f.includes("monitor_cache") && !f.includes("fts"));
	for (const file of files) {
		let db = null;
		try {
			db = new DatabaseSync(join(msgDir, file), { readOnly: true });
		} catch {
			continue;
		}
		try {
			const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
			for (const t of tables) {
				if (!t.startsWith("Msg_")) continue;
				try {
					const rows = db.prepare(`SELECT DISTINCT CAST(strftime('%Y', datetime(create_time, 'unixepoch')) AS INTEGER) y FROM "${t}" WHERE create_time > 0`).all();
					for (const r of rows) {
						const y = r.y;
						if (Number.isFinite(y) && y > 2e3) years.add(y);
					}
				} catch {}
			}
		} catch {} finally {
			db.close();
		}
	}
	return { years: Array.from(years).sort((a, b) => b - a) };
}
//#endregion
//#region lib/types/query/settings.js
/**
* WeChat config (owned config.json under the DSH data root), read via the
* gateway's decrypted-dir location; returns the configuration summary.
*/
/**
* Locate the WeChat config.json for a data root: the DSH-owned root.
* @param decryptedDir - decrypted data root (the parent is the owned root).
* @returns the config file path, or null when it does not exist.
*/
function configPath$1(decryptedDir) {
	const owned = join(decryptedDir, "..", "config.json");
	return existsSync(owned) ? owned : null;
}
/**
* Read the WeChat configuration summary (without secrets).
* @param decryptedDir - decrypted data root.
* @returns the config summary.
*/
function queryWechatConfig(decryptedDir) {
	const path = configPath$1(decryptedDir);
	if (!path) return { db_dir: decryptedDir };
	try {
		const raw = JSON.parse(readFileSync(path, "utf8"));
		return {
			db_dir: raw.db_dir ?? "",
			wechat_process: raw.wechat_process ?? "",
			key_format: raw.key_format ?? "",
			api_enabled: raw.api_enabled ?? false,
			api_port: raw.api_port ?? 0
		};
	} catch {
		return { db_dir: decryptedDir };
	}
}
//#endregion
//#region lib/types/query/config.js
/**
* WeChat configuration management, rewritten as a local module. Reads/writes
* the owned config.json under the DSH data root, detects WeChat accounts, and
* verifies database keys (SQLCipher 4: PBKDF2-HMAC-SHA512 + AES-256).
*/
const PAGE_SZ$1 = 4096;
const SALT_SZ$1 = 16;
const HMAC_SZ = 64;
const RESERVE_SZ$1 = 80;
const PBKDF2_ITERS$2 = 256e3;
const SQLITE_HDR$2 = new TextEncoder().encode("SQLite format 3\0");
/** Read only the first database page (verification needs just the header page). */
function readFirstPage(file) {
	const fd = openSync(file, "r");
	try {
		const buf = Buffer.alloc(PAGE_SZ$1);
		const n = readSync(fd, buf, 0, PAGE_SZ$1, 0);
		return buf.subarray(0, n);
	} finally {
		closeSync(fd);
	}
}
/**
* Locate the WeChat config.json for a data root. The plugin owns its config
* under the DSH data root (`<root>/config.json`, i.e. the parent of
* `decrypted`).
* @param decryptedDir - decrypted data root (the parent is the owned root).
* @returns the owned config file path.
*/
function configPath(decryptedDir) {
	return join(decryptedDir, "..", "config.json");
}
/** Raw config file cache keyed by mtime+size (read-heavy callers: sync, media). */
const configCache = /* @__PURE__ */ new Map();
function configSig(p) {
	try {
		const st = statSync(p);
		return `${st.mtimeMs}:${st.size}`;
	} catch {
		return "";
	}
}
function readRawConfig(p) {
	const sig = configSig(p);
	const hit = configCache.get(p);
	if (hit && hit.sig === sig) return hit.raw;
	let raw = null;
	if (sig) try {
		raw = JSON.parse(readFileSync(p, "utf8"));
	} catch {}
	configCache.set(p, {
		sig,
		raw
	});
	return raw;
}
/** Defaults for a missing config. */
function defaultConfig() {
	return {
		db_dir: "",
		keys_file: null,
		decrypted_dir: null,
		decoded_image_dir: null,
		wechat_process: "Weixin.exe",
		image_aes_key: "",
		image_xor_key: 136,
		key_format: "wx_key_v4.1",
		db_enc_key: "",
		api_enabled: true,
		api_port: 5032,
		api_token: "",
		cdn_enabled: true,
		cdn_local_decrypt: true
	};
}
/**
* Read the full WeChat config (merged with defaults).
* @param decryptedDir - decrypted data root (used to locate config.json).
* @returns the merged config (defaults + file values + resolved paths).
*/
function getConfig(decryptedDir) {
	const p = configPath(decryptedDir);
	const cfg = defaultConfig();
	const raw = readRawConfig(p);
	if (raw) Object.assign(cfg, raw);
	const wechatRoot = join(decryptedDir, "..");
	const resolved = {
		decrypted_dir: decryptedDir,
		decoded_image_dir: join(wechatRoot, "decoded_images"),
		keys_file: join(wechatRoot, "all_keys.json")
	};
	cfg["resolved"] = resolved;
	cfg["decrypted_dir"] = resolved.decrypted_dir;
	cfg["decoded_image_dir"] = resolved.decoded_image_dir;
	cfg["keys_file"] = resolved.keys_file;
	return cfg;
}
/**
* Save the WeChat config (merge patch into config.json).
* @param decryptedDir - decrypted data root (used to locate config.json).
* @param patch - config fields to merge in.
* @returns ok, or an error description on failure.
*/
function saveConfig(decryptedDir, patch) {
	const p = configPath(decryptedDir);
	try {
		const current = getConfig(decryptedDir);
		for (const [k, v] of Object.entries(patch)) {
			if (k === "resolved") continue;
			if (v === void 0) continue;
			current[k] = v;
		}
		delete current["resolved"];
		const imgBefore = getConfig(decryptedDir);
		// 数据根目录可能尚未创建（首次保存配置），先确保父目录存在。
		mkdirSync(dirname(p), { recursive: true });
		writeFileSync(p, JSON.stringify(current, null, 2), "utf8");
		configCache.delete(p);
		const keyStr = (v) => typeof v === "string" ? v : typeof v === "number" ? String(v) : "";
		const aesChanged = keyStr(current["image_aes_key"]) !== keyStr(imgBefore["image_aes_key"]);
		const xorChanged = keyStr(current["image_xor_key"]) !== keyStr(imgBefore["image_xor_key"]);
		if (aesChanged || xorChanged) clearDecodedImages(join(decryptedDir, "..", "decoded_images"));
		return { ok: true };
	} catch (e) {
		return {
			ok: false,
			error: e.message
		};
	}
}
/** Clear the decoded-images cache (stale when the image key changed). */
function clearDecodedImages(dir) {
	try {
		if (!existsSync(dir)) return;
		for (const name of readdirSync(dir)) try {
			rmSync(join(dir, name), {
				recursive: true,
				force: true
			});
		} catch {}
	} catch {}
}
/** Common WeChat 4.x data bases (parents of `xwechat_files`) to scan. */
const DEFAULT_DATA_BASES = [
	"E:\\Tencent",
	"D:\\Tencent",
	"C:\\Tencent",
	process.env.USERPROFILE ? join(process.env.USERPROFILE, "Tencent") : "",
	process.env.USERPROFILE ? join(process.env.USERPROFILE, "Documents") : ""
].filter(Boolean);
/**
* WeChat 4.x data bases recorded per-user in
* `%APPDATA%/Tencent/xwechat/config/*.ini` — each line is the data root chosen
* at install/first login (e.g. `E:\Tencent\Weixin`, the parent of
* `xwechat_files`). The client rewrites these files on every login, so this is
* the authoritative source for a customized data location.
*/
function iniDataBases() {
	const configDir = process.env.APPDATA ? join(process.env.APPDATA, "Tencent", "xwechat", "config") : "";
	if (!configDir || !existsSync(configDir)) return [];
	const bases = [];
	for (const name of readdirSync(configDir)) {
		if (!name.endsWith(".ini")) continue;
		try {
			for (const line of readFileSync(join(configDir, name), "utf8").split(/\r?\n/)) {
				const base = line.trim();
				if (base) bases.push(base);
			}
		} catch {}
	}
	return bases;
}
/**
* WeChat 4.x install path from `HKCU\Software\Tencent\Weixin\InstallPath`
* (Windows only; '' elsewhere). The install dir is also a valid data base when
* the user kept the default data layout.
*/
function weixinInstallPath() {
	if (process.platform !== "win32") return "";
	try {
		const out = execFileSync("reg.exe", [
			"query",
			"HKCU\\Software\\Tencent\\Weixin",
			"/v",
			"InstallPath"
		], {
			encoding: "utf8",
			windowsHide: true
		});
		return (/\sInstallPath\s+REG_\w+\s+(.+)/i.exec(out)?.[1] ?? "").trim();
	} catch {}
	return "";
}
/** Version-folder pattern under the WeChat install dir (e.g. 4.1.12.26). */
const VERSION_DIR_RE = /^\d+\.\d+\.\d+(?:\.\d+)?$/;
/**
* WeChat version folder name inside the install dir.
* @param installDir - install path (defaults to the registry InstallPath).
* @returns the version, or '' when the install dir is unknown.
*/
function weixinVersion(installDir) {
	const dir = installDir ?? weixinInstallPath();
	if (!dir || !existsSync(dir)) return "";
	try {
		for (const entry of readdirSync(dir, { withFileTypes: true })) if (entry.isDirectory() && VERSION_DIR_RE.test(entry.name)) return entry.name;
	} catch {}
	return "";
}
/**
* Collect the `xwechat_files` roots to scan: default data bases, per-user
* config ini files, and the registry install path, deduped
* case-insensitively. A configured base may itself already be the
* `xwechat_files` dir, so both join forms are added; the account loop filters
* by `db_storage` presence.
* @returns absolute candidate roots (existence caller-checked).
*/
function collectScanRoots() {
	const seen = /* @__PURE__ */ new Set();
	const roots = [];
	const add = (base) => {
		if (!base) return;
		for (const root of [join(base, "xwechat_files"), base]) {
			const key = root.toLowerCase();
			if (seen.has(key)) continue;
			seen.add(key);
			roots.push(root);
		}
	};
	for (const base of [
		...DEFAULT_DATA_BASES,
		...iniDataBases(),
		weixinInstallPath()
	]) add(base);
	return roots;
}
/**
* Detect installed WeChat 4.x accounts by scanning `xwechat_files` roots.
* @param roots - explicit scan roots; defaults to {@link collectScanRoots}.
* @returns detected accounts with db_dir, last active and db file count.
*/
function detectWechatAccounts(roots) {
	const out = [];
	for (const root of roots ?? collectScanRoots()) {
		if (!existsSync(root)) continue;
		for (const entry of readdirSync(root, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			const dbStorage = join(join(root, entry.name), "db_storage");
			if (!existsSync(dbStorage)) continue;
			const wxid = normalizeWxidDir(entry.name) || "未知账号";
			let lastActive;
			try {
				const msgDir = join(dbStorage, "message");
				if (existsSync(msgDir)) {
					let newest = 0;
					for (const f of readdirSync(msgDir)) try {
						newest = Math.max(newest, statSync(join(msgDir, f)).mtimeMs);
					} catch {}
					lastActive = newest ? Math.floor(newest / 1e3) : void 0;
				}
			} catch {}
			const acct = {
				wxid,
				db_dir: dbStorage
			};
			if (lastActive) acct.last_active = lastActive;
			const dbs = scanDbFiles(dbStorage);
			if (dbs.length > 0) acct.db_files = dbs.length;
			out.push(acct);
		}
	}
	return out;
}
/** AES-256-CBC decrypt (no padding). */
function aes256CbcDecrypt(key, iv, data) {
	const d = createDecipheriv("aes-256-cbc", key, iv);
	d.setAutoPadding(false);
	return Buffer.concat([d.update(data), d.final()]);
}
/** AES-256-ECB decrypt one block. */
function aes256EcbDecryptBlock(key, block) {
	const d = createDecipheriv("aes-256-ecb", key, null);
	d.setAutoPadding(false);
	return d.update(block);
}
/**
* SQLCipher page-1 key verification (wx_key_v4.1 PBKDF2).
* @param page1 - first page (4096 bytes) of the encrypted database.
* @param wxKeyBin - 32-byte raw database key.
* @returns whether the HMAC and AES checks pass.
*/
function verifyDbKey(page1, wxKeyBin) {
	if (page1.length < PAGE_SZ$1) return {
		hmacOk: false,
		aesOk: false
	};
	page1 = page1.subarray(0, PAGE_SZ$1);
	const salt = page1.subarray(0, SALT_SZ$1);
	const derivedKey = pbkdf2Sync(wxKeyBin, salt, PBKDF2_ITERS$2, 32, "sha512");
	const macKey = pbkdf2Sync(derivedKey, Buffer.from(salt.map((b) => b ^ 58)), 2, 32, "sha512");
	const hmacData = page1.subarray(16, 4032);
	const storedHmac = page1.subarray(PAGE_SZ$1 - HMAC_SZ, PAGE_SZ$1);
	const mac = createHmac("sha512", macKey);
	mac.update(hmacData);
	const pgno = Buffer.alloc(4);
	pgno.writeUInt32LE(1, 0);
	mac.update(pgno);
	const hmacOk = mac.digest().equals(Buffer.from(storedHmac));
	const firstBlockDec = aes256EcbDecryptBlock(derivedKey, page1.subarray(16, 32));
	return {
		hmacOk,
		aesOk: aes256CbcDecrypt(derivedKey, Buffer.from(firstBlockDec.map((b, i) => b ^ (SQLITE_HDR$2[i] ?? 0))), page1.subarray(16, PAGE_SZ$1 - RESERVE_SZ$1)).subarray(0, 16).equals(Buffer.from(SQLITE_HDR$2))
	};
}
/**
* Verify one database file with a 64-hex key.
* @param dbPath - path to the encrypted database file.
* @param encKeyHex - 64-char hex (32-byte) database key.
* @returns validity plus per-check flags and any error.
*/
function verifyDatabaseKey(dbPath, encKeyHex) {
	if (!existsSync(dbPath)) return {
		valid: false,
		error: "数据库文件不存在"
	};
	const raw = (encKeyHex || "").trim();
	let key;
	try {
		key = Buffer.from(raw, "hex");
	} catch {
		key = Buffer.alloc(0);
	}
	if (key.length !== 32) return {
		valid: false,
		error: "密钥必须是 64 位 hex（32 字节）"
	};
	try {
		const page1 = readFirstPage(dbPath);
		if (page1.length < PAGE_SZ$1) return {
			valid: false,
			error: "文件太小，不是有效的数据库"
		};
		const { hmacOk, aesOk } = verifyDbKey(page1, key);
		return {
			valid: hmacOk && aesOk,
			aesOk,
			hmacOk
		};
	} catch (e) {
		return {
			valid: false,
			error: e.message
		};
	}
}
/** Recursively collect .db files under a dir (depth-limited). */
function scanDbFiles(dir, depth = 0) {
	if (depth > 4 || !existsSync(dir)) return [];
	const out = [];
	try {
		for (const e of readdirSync(dir, { withFileTypes: true })) {
			const p = join(dir, e.name);
			if (e.isDirectory()) out.push(...scanDbFiles(p, depth + 1));
			else if (e.name.endsWith(".db") && !e.name.includes("-wal") && !e.name.includes("-shm")) out.push(p);
		}
	} catch {}
	return out;
}
/**
* Verify all DBs in db_dir and write all_keys.json (per-db per-file keys).
* @param dbDir - directory containing the encrypted DBs to verify.
* @param keysFile - output all_keys.json path.
* @param encKeyHex - 64-char hex (32-byte) database key.
* @param keyFormat - key format recorded in the file (default wx_key_v4.1).
* @returns ok plus verified/total DB counts, or an error description.
*/
function generateKeysFile(dbDir, keysFile, encKeyHex, keyFormat) {
	const raw = (encKeyHex || "").trim();
	let key;
	try {
		key = Buffer.from(raw, "hex");
	} catch {
		key = Buffer.alloc(0);
	}
	if (key.length !== 32) return {
		ok: false,
		verified: 0,
		total: 0,
		error: "密钥必须是 64 位 hex（32 字节）"
	};
	const dbs = scanDbFiles(dbDir);
	if (dbs.length === 0) return {
		ok: false,
		verified: 0,
		total: 0,
		error: "未找到任何 .db 文件"
	};
	const entries = {};
	let verified = 0;
	for (const db of dbs) try {
		const rel = relative(dbDir, db).replace(/\\/g, "/");
		const { hmacOk, aesOk } = verifyDbKey(readFirstPage(db), key);
		const valid = hmacOk && aesOk;
		if (valid) verified += 1;
		entries[rel] = {
			key: raw,
			valid
		};
	} catch {}
	const payload = {
		...entries,
		_key_format: keyFormat ?? "wx_key_v4.1",
		_db_dir: dbDir
	};
	try {
		mkdirSync(dirname(keysFile), { recursive: true });
		writeFileSync(keysFile, JSON.stringify(payload, null, 2), "utf8");
		return {
			ok: true,
			verified,
			total: dbs.length
		};
	} catch (e) {
		return {
			ok: false,
			verified,
			total: dbs.length,
			error: e.message
		};
	}
}
/**
* Read all_keys.json info (format + count).
* @param decryptedDir - decrypted data root.
* @returns key format, key count and whether the file was loaded.
*/
function getKeysInfo(decryptedDir) {
	const p = join(decryptedDir, "..", "all_keys.json");
	if (!existsSync(p)) return {
		keyCount: 0,
		loaded: false
	};
	try {
		const raw = JSON.parse(readFileSync(p, "utf8"));
		const base = {
			keyCount: Object.keys(raw).filter((k) => !k.startsWith("_")).length,
			loaded: true
		};
		if (typeof raw["_key_format"] === "string") base.keyFormat = raw["_key_format"];
		return base;
	} catch {
		return {
			keyCount: 0,
			loaded: false
		};
	}
}
/**
* Normalize a WeChat account dir name to the real wxid (strip instance suffix).
* Account dirs look like `wxid_xxxxxx` or `wxid_xxxxxx_f312`; the wxid itself
* has no underscore, so everything after the second underscore is the instance
* id (mirrors st_control config/paths.rs normalize_wxid_dir).
* @param name - account directory name (e.g. wxid_a1z2r51mzqlf22_63e5).
* @returns the real wxid (input unchanged when it is not a wxid_ name).
*/
function normalizeWxidDir(name) {
	if (!name.startsWith("wxid_")) return name;
	const rest = name.slice(5);
	const pos = rest.indexOf("_");
	return pos >= 0 ? "wxid_" + rest.slice(0, pos) : name;
}
/** Self wxid from a db_dir path (the account dir is the parent of db_storage). */
function wxidFromDbDir(dbDir) {
	const d = (dbDir || "").trim().replace(/[\\/]+$/, "");
	if (!d) return "";
	const parts = d.split(/[\\/]/);
	const last = parts[parts.length - 1] ?? "";
	return normalizeWxidDir(last.startsWith("wxid_") ? last : parts[parts.length - 2] ?? "");
}
/**
* Resolve the logged-in account wxid (self). Mirrors st_control's cfg.wxid()
* which derives it from the account directory name. Resolution order:
* env DSH_WECHAT_SELF_WXID -> config.json db_dir -> all_keys.json _db_dir ->
* machine account scan. Unknown when every source is missing.
* @param decryptedDir - decrypted data root (configPath locates config.json).
* @returns the self wxid, or '' when it cannot be determined.
*/
function resolveSelfUsername(decryptedDir) {
	const envVal = process.env["DSH_WECHAT_SELF_WXID"];
	if (envVal && envVal.trim().length > 0) return envVal.trim();
	const cfg = getConfig(decryptedDir);
	const fromDbDir = wxidFromDbDir(typeof cfg["db_dir"] === "string" ? cfg["db_dir"] : "");
	if (fromDbDir) return fromDbDir;
	try {
		const keysPath = join(decryptedDir, "..", "all_keys.json");
		if (existsSync(keysPath)) {
			const raw = JSON.parse(readFileSync(keysPath, "utf8"));
			const fromKeys = wxidFromDbDir(typeof raw["_db_dir"] === "string" ? raw["_db_dir"] : "");
			if (fromKeys) return fromKeys;
		}
	} catch {}
	const accounts = detectWechatAccounts();
	for (const a of accounts) if (a.wxid && a.wxid.startsWith("wxid_")) return normalizeWxidDir(a.wxid);
	return "";
}
//#endregion
//#region lib/types/query/sync.js
/**
* Real-time sync from WeChat's raw encrypted DBs into the decrypted snapshot.
*
* Mirrors st_control's monitor/db_cache pipeline: the decrypted copy is a
* snapshot that only moves when something re-decrypts the raw SQLCipher
* database, so a chat panel polling the snapshot never sees new messages by
* itself. This module watches the raw message shards (mtime signature, like
* st_control's msg_dbs_sig), and on change re-decrypts the shard (full main
* DB + WAL frame patch) into the decrypted tree atomically.
*
* SQLCipher 4 layout (per 4096-byte page):
*   page 1: [16B salt][4000B encrypted][16B IV][64B HMAC]
*   other : [4016B encrypted][16B IV][64B HMAC]
* Key derivation (wx_key_v4.1): PBKDF2-HMAC-SHA512(rawKey, salt, 256000).
*/
const PAGE_SZ = 4096;
const SALT_SZ = 16;
const RESERVE_SZ = 80;
const PBKDF2_ITERS$1 = 256e3;
const SQLITE_HDR$1 = Buffer.from("SQLite format 3\0");
const WAL_HEADER_SZ = 32;
const WAL_FRAME_HEADER_SZ = 24;
const SYNC_INTERVAL_MS = 1e4;
const FULL_DECRYPT_COOLDOWN_MS = 6e3;
/** Cached raw-dir entries; refreshed when the directory signature changes. */
const dirEntryCache = /* @__PURE__ */ new Map();
function cachedDirEntries(dir) {
	try {
		const st = statSync(dir);
		const sig = `${st.mtimeMs}:${st.size}`;
		const hit = dirEntryCache.get(dir);
		if (hit && hit.sig === sig) return hit.files;
		const files = readdirSync(dir);
		dirEntryCache.set(dir, {
			sig,
			files
		});
		return files;
	} catch {
		return [];
	}
}
/** Read exactly the first n bytes of a file (readFileSync has no length option). */
function readPrefix$1(file, n) {
	const fd = openSync(file, "r");
	const buf = Buffer.alloc(n);
	let filled = 0;
	try {
		while (filled < n) {
			const r = readSync(fd, buf, filled, n - filled, null);
			if (r === 0) break;
			filled += r;
		}
	} finally {
		closeSync(fd);
	}
	return buf.subarray(0, filled);
}
/** Derive the per-database AES-256 key (wx_key_v4.1 PBKDF2, else raw). */
function deriveEncKey$1(rawKey, salt, keyFormat) {
	if (keyFormat === "wx_key_v4.1") return pbkdf2Sync(rawKey, salt, PBKDF2_ITERS$1, 32, "sha512");
	return rawKey;
}
/**
* Decrypt one SQLCipher page (pgno is 1-based) into a plain SQLite page.
* The per-page IV lives at the page tail; page 1 additionally prefixes the
* decrypted payload with the SQLite header (the salt occupied those 16 bytes
* on disk), matching st_control's decrypt_page output layout.
*/
function decryptPage(encKey, page, pgno) {
	const iv = page.subarray(PAGE_SZ - RESERVE_SZ, 4032);
	const encrypted = pgno === 1 ? page.subarray(SALT_SZ, PAGE_SZ - RESERVE_SZ) : page.subarray(0, PAGE_SZ - RESERVE_SZ);
	const decipher = createDecipheriv("aes-256-cbc", encKey, iv);
	decipher.setAutoPadding(false);
	const dec = Buffer.concat([decipher.update(encrypted), decipher.final()]);
	const out = Buffer.alloc(PAGE_SZ);
	if (pgno === 1) SQLITE_HDR$1.copy(out, 0);
	dec.copy(out, pgno === 1 ? SQLITE_HDR$1.length : 0);
	return out;
}
/**
* Stream-decrypt a whole SQLCipher database to a plain SQLite file.
*
* Async and chunked: the snapshot can be 200+ MB, and this runs inside the
* realtime sync tick on the host's single event loop. One chunk of pages is
* read, decrypted and written per scheduling step (64 pages ≈ 256 KiB), so
* other requests — the chat panel's own queries — interleave instead of
* freezing for the whole decrypt.
* @param dbPath - encrypted source database path.
* @param outPath - plain SQLite output path.
* @param encKey - derived 32-byte AES-256 key.
* @returns the number of pages decrypted.
*/
const DECRYPT_CHUNK_PAGES = 64;
async function fullDecryptFile(dbPath, outPath, encKey) {
	const input = await open(dbPath, "r");
	const output = await open(outPath, "w");
	const rawChunk = Buffer.alloc(PAGE_SZ * DECRYPT_CHUNK_PAGES);
	const decChunk = Buffer.alloc(PAGE_SZ * DECRYPT_CHUNK_PAGES);
	let pgno = 0;
	try {
		for (;;) {
			let filled = 0;
			while (filled < rawChunk.length) {
				const { bytesRead } = await input.read(rawChunk, filled, rawChunk.length - filled, null);
				if (bytesRead === 0) break;
				filled += bytesRead;
			}
			if (filled === 0) break;
			for (let offset = 0; offset < filled; offset += PAGE_SZ) {
				const page = rawChunk.subarray(offset, offset + PAGE_SZ);
				decryptPage(encKey, page.length < PAGE_SZ ? Buffer.concat([page, Buffer.alloc(PAGE_SZ - page.length)]) : page, pgno + 1).copy(decChunk, offset);
				pgno += 1;
			}
			await output.write(decChunk.subarray(0, filled));
			await new Promise((resolve) => {
				setImmediate(resolve);
			});
		}
	} finally {
		await input.close();
		await output.close();
	}
	return pgno;
}
/**
* Patch a decrypted DB file with valid frames from an encrypted WAL.
* @param walPath - encrypted WAL file path.
* @param outPath - decrypted DB file to patch in place.
* @param encKey - derived 32-byte AES-256 key.
* @returns the number of frames patched.
*/
async function decryptWalPatch(walPath, outPath, encKey) {
	if (!existsSync(walPath)) return 0;
	const wal = await readFile(walPath);
	if (wal.length <= WAL_HEADER_SZ) return 0;
	const frameSize = 4120;
	const walSalt1 = wal.readUInt32BE(16);
	const walSalt2 = wal.readUInt32BE(20);
	const fh = await open(outPath, "r+");
	let patched = 0;
	try {
		let offset = WAL_HEADER_SZ;
		while (offset + frameSize <= wal.length) {
			const pgno = wal.readUInt32BE(offset);
			const frameSalt1 = wal.readUInt32BE(offset + 8);
			const frameSalt2 = wal.readUInt32BE(offset + 12);
			if (pgno === 0 || pgno > 1e6 || frameSalt1 !== walSalt1 || frameSalt2 !== walSalt2) {
				offset += frameSize;
				continue;
			}
			const dec = decryptPage(encKey, wal.subarray(offset + WAL_FRAME_HEADER_SZ, offset + WAL_FRAME_HEADER_SZ + PAGE_SZ), pgno);
			await fh.write(dec, 0, PAGE_SZ, (pgno - 1) * PAGE_SZ);
			patched += 1;
			offset += frameSize;
		}
	} finally {
		await fh.close();
	}
	return patched;
}
/** True when at least one WAL frame's salt epoch matches the WAL header,
* i.e. the frames can be decrypted with the current snapshot key. WeChat
* rotates the salt on login/checkpoint; when it does, frames carry a different
* epoch and cannot be patched — the next main-DB rewrite (mtime change)
* triggers a clean full decrypt instead. */
async function walFramesPatchable(walPath) {
	if (!existsSync(walPath)) return false;
	const wal = await readFile(walPath);
	if (wal.length <= WAL_HEADER_SZ) return false;
	const frameSize = 4120;
	const walSalt1 = wal.readUInt32BE(16);
	const walSalt2 = wal.readUInt32BE(20);
	let offset = WAL_HEADER_SZ;
	while (offset + frameSize <= wal.length) {
		const frameSalt1 = wal.readUInt32BE(offset + 8);
		const frameSalt2 = wal.readUInt32BE(offset + 12);
		if (frameSalt1 === walSalt1 && frameSalt2 === walSalt2) return true;
		offset += frameSize;
	}
	return false;
}
/** True when the target exists and its data (not mtime) is usable. */
function looksDecrypted(dbPath) {
	try {
		const head = readPrefix$1(dbPath, 16);
		return head.length === 16 && head.subarray(0, 15).equals(SQLITE_HDR$1.subarray(0, 15));
	} catch {
		return false;
	}
}
/** Atomically replace target with a fully-decrypted temp file (async retries). */
async function atomicReplace(temp, target) {
	await mkdir(dirname(target), { recursive: true });
	let lastErr = null;
	for (let i = 0; i < 8; i += 1) try {
		try {
			await unlink(target);
		} catch {}
		await rename(temp, target);
		return;
	} catch (e) {
		lastErr = e;
		await new Promise((resolve) => {
			setTimeout(resolve, 120);
		});
	}
	throw lastErr instanceof Error ? lastErr : /* @__PURE__ */ new Error("atomicReplace failed");
}
/** all_keys.json read cache (mtime+size fingerprint; rewritten files re-read). */
const allKeysCache = /* @__PURE__ */ new Map();
/** Per-shard last full re-decrypt time, keyed by shard/label (bounded). */
const lastFullAt = /* @__PURE__ */ new Map();
/** True once when a full re-decrypt for `key` is allowed by the cooldown. */
function fullDecryptDue(key) {
	const last = lastFullAt.get(key) ?? 0;
	if (Date.now() - last < FULL_DECRYPT_COOLDOWN_MS) return false;
	lastFullAt.set(key, Date.now());
	return true;
}
function readAllKeysCached(decryptedDir) {
	const keysPath = join(decryptedDir, "..", "all_keys.json");
	let sig = "";
	try {
		const st = statSync(keysPath);
		sig = `${st.mtimeMs}:${st.size}`;
	} catch {
		return null;
	}
	const hit = allKeysCache.get(keysPath);
	if (hit && hit.sig === sig) return hit.raw;
	let raw = null;
	try {
		raw = JSON.parse(readFileSync(keysPath, "utf8"));
	} catch {}
	allKeysCache.set(keysPath, {
		sig,
		raw
	});
	return raw;
}
/**
* 64-hex raw key for a shard (all_keys.json per-file first, then config).
* @param decryptedDir - decrypted data root (all_keys.json sits beside it).
* @param relKey - per-file key entry (e.g. 'message/message_0.db').
* @param fallbackHex - config `db_enc_key` used when no per-file entry fits.
* @returns the 64-hex key string to use.
*/
function resolveShardKey(decryptedDir, relKey, fallbackHex) {
	const raw = readAllKeysCached(decryptedDir);
	if (raw !== null) {
		const entry = raw[relKey];
		const candidate = typeof entry?.key === "string" ? entry.key : typeof entry?.enc_key === "string" ? entry.enc_key : null;
		if (candidate && /^[0-9a-fA-F]{64}$/.test(candidate)) return candidate;
	}
	return fallbackHex;
}
/** Per-file derived AES key cache: PBKDF2 is ~70ms, so sync ticks re-derive
* only when the raw file's salt or the raw key actually changes. Bounded FIFO. */
const derivedKeyCache = /* @__PURE__ */ new Map();
/**
* Derive (and cache) the per-database AES-256 key.
* @param decryptedDir - decrypted data root (cache namespace part).
* @param relKey - per-file key entry (cache namespace part).
* @param rawDbFile - encrypted source file (its first 16 bytes are the salt).
* @param rawKeyHex - 64-hex raw key.
* @param keyFormat - SQLCipher key format (`wx_key_v4.1` PBKDF2, else raw).
* @returns the derived 32-byte key.
*/
function deriveEncKeyCached(decryptedDir, relKey, rawDbFile, rawKeyHex, keyFormat) {
	const salt = readPrefix$1(rawDbFile, SALT_SZ);
	const cacheKey = `${decryptedDir}|${relKey}|${salt.toString("hex")}|${rawKeyHex}|${keyFormat}`;
	const hit = derivedKeyCache.get(cacheKey);
	if (hit !== void 0) return hit;
	const encKey = deriveEncKey$1(Buffer.from(rawKeyHex, "hex"), salt, keyFormat);
	if (derivedKeyCache.size >= 128) {
		const first = derivedKeyCache.keys().next();
		if (!first.done) derivedKeyCache.delete(first.value);
	}
	derivedKeyCache.set(cacheKey, encKey);
	return encKey;
}
/** Resolve the raw key and derive the AES key for one database file. */
function shardEncKey(decryptedDir, relKey, rawDbFile, rawKeyHex, keyFormat) {
	return deriveEncKeyCached(decryptedDir, relKey, rawDbFile, resolveShardKey(decryptedDir, relKey, rawKeyHex), keyFormat);
}
/** Per-shard mtime signature (main db + its wal). */
function shardSig(msgDir, file) {
	const sig = {
		main: 0,
		wal: 0
	};
	for (const f of [file, file + "-wal"]) try {
		const ms = statSync(join(msgDir, f)).mtimeMs;
		if (f === file) sig.main = ms;
		else sig.wal = ms;
	} catch {}
	return sig;
}
/** Copy a raw WAL into staging when it has frames; otherwise drop stale staging. */
async function stageWal(rawWal, stagingWal) {
	if (existsSync(rawWal) && statSync(rawWal).size > WAL_HEADER_SZ) await copyFile(rawWal, stagingWal);
	else if (existsSync(stagingWal)) await unlink(stagingWal).catch(() => {});
}
/**
* Sync one message shard from the raw tree into the decrypted snapshot.
* - mode 'full': re-decrypt the main DB (first sync or the main file changed)
*   then WAL-patch the result; atomically replaces the snapshot.
* - mode 'wal': the main snapshot is current and only the WAL grew — patch the
*   changed frames into a staging copy of the snapshot (st_control's
*   write-only-page model) and atomically replace.
* @param rawMsgDir - raw message dir (encrypted).
* @param decMsgDir - decrypted message dir.
* @param file - shard file name (e.g. message_0.db).
* @param rawKeyHex - fallback 64-hex raw key.
* @param keyFormat - key format (wx_key_v4.1).
* @param mode - full or wal-incremental.
* @returns page counts for reporting.
*/
async function syncMessageShard(rawMsgDir, decMsgDir, file, rawKeyHex, keyFormat, mode = "full") {
	const relKey = "message/" + file;
	const rawDb = join(rawMsgDir, file);
	const rawWal = join(rawMsgDir, file + "-wal");
	const target = join(decMsgDir, file);
	await mkdir(decMsgDir, { recursive: true });
	const encKey = shardEncKey(decMsgDir, relKey, rawDb, rawKeyHex, keyFormat);
	const stagingDb = target + ".stage_src";
	const stagingWal = target + ".stage_wal";
	const temp = target + ".decrypt_tmp";
	if (mode === "wal") {
		if (!await walFramesPatchable(rawWal)) {
			console.warn("[wechat-sync]", file, "wal salt epoch mismatch, keeping snapshot");
			return {
				fullPages: 0,
				walPages: 0
			};
		}
		await copyFile(target, stagingDb);
		await stageWal(rawWal, stagingWal);
		try {
			const walPages = existsSync(stagingWal) ? await decryptWalPatch(stagingWal, stagingDb, encKey) : 0;
			if (!looksDecrypted(stagingDb)) throw new Error("wal patch invalid for " + file);
			await atomicReplace(stagingDb, target);
			return {
				fullPages: 0,
				walPages
			};
		} finally {
			for (const f of [stagingWal, temp]) try {
				await unlink(f);
			} catch {}
		}
	}
	await copyFile(rawDb, stagingDb);
	await stageWal(rawWal, stagingWal);
	try {
		const fullPages = await fullDecryptFile(stagingDb, temp, encKey);
		const walPages = existsSync(stagingWal) ? await decryptWalPatch(stagingWal, temp, encKey) : 0;
		if (!looksDecrypted(temp)) throw new Error("decrypt result invalid for " + file);
		await atomicReplace(temp, target);
		return {
			fullPages,
			walPages
		};
	} finally {
		for (const f of [
			stagingDb,
			stagingWal,
			temp
		]) try {
			await unlink(f);
		} catch {}
	}
}
/**
* Scan raw shards and sync every changed one. The main file changing forces a
* full re-decrypt; a WAL-only change applies an incremental frame patch.
* @param rawDbDir - raw db_storage root.
* @param decryptedDir - decrypted snapshot root.
* @param lastState - per-shard signature state (mutated).
* @returns descriptions of what was synced (file + mode + pages).
*/
async function syncChangedShards(rawDbDir, decryptedDir, lastState) {
	const msgDir = join(rawDbDir, "message");
	const decMsgDir = join(decryptedDir, "message");
	if (!existsSync(msgDir)) return [];
	const cfg = getConfig(decryptedDir);
	const keyFormat = typeof cfg["key_format"] === "string" ? cfg["key_format"] : "wx_key_v4.1";
	const fallbackKey = typeof cfg["db_enc_key"] === "string" ? cfg["db_enc_key"] : "";
	const synced = [];
	for (const f of cachedDirEntries(msgDir)) {
		if (!/^(biz_)?message_\d+\.db$/.test(f)) continue;
		const sig = shardSig(msgDir, f);
		const prev = lastState.get(f);
		const target = join(decMsgDir, f);
		if (prev !== void 0 && prev.main === sig.main && prev.wal === sig.wal && existsSync(target)) continue;
		lastState.set(f, sig);
		const mode = prev === void 0 || prev.main !== sig.main || !existsSync(target) ? "full" : "wal";
		if (mode === "full" && !fullDecryptDue(f)) {
			lastState.delete(f);
			continue;
		}
		try {
			const r = await syncMessageShard(msgDir, decMsgDir, f, fallbackKey, keyFormat, mode);
			if (mode === "full" || r.walPages > 0) synced.push(`${f}:${mode}(${r.fullPages}p/w${r.walPages})`);
		} catch (e) {
			lastState.delete(f);
			console.error("[wechat-sync]", f, e.message);
		}
	}
	return synced;
}
/** Session-db signature (main + wal). */
function sessionSig(sessionDir) {
	const sig = {
		main: 0,
		wal: 0
	};
	for (const f of ["session.db", "session.db-wal"]) try {
		const ms = statSync(join(sessionDir, f)).mtimeMs;
		if (f === "session.db") sig.main = ms;
		else sig.wal = ms;
	} catch {}
	return sig;
}
/**
* Sync session.db (the conversation list state) from the raw tree into the
* decrypted snapshot — full re-decrypt when the main file changed, WAL frame
* patch otherwise. The chat sidebar reads this table, so without it the
* session list never reflects new messages.
* @param rawDbDir - raw db_storage root.
* @param decryptedDir - decrypted snapshot root.
* @param lastState - shared per-target signature state.
* @param rawKeyHex - fallback 64-hex raw key.
* @param keyFormat - key format (wx_key_v4.1).
* @returns descriptions of what was synced (empty when nothing changed).
*/
async function syncSessionDb(rawDbDir, decryptedDir, lastState, rawKeyHex, keyFormat) {
	const rawSess = join(rawDbDir, "session");
	const decSess = join(decryptedDir, "session");
	const rawDb = join(rawSess, "session.db");
	if (!existsSync(rawDb)) return [];
	const sig = sessionSig(rawSess);
	const prev = lastState.get("session.db");
	const target = join(decSess, "session.db");
	if (prev !== void 0 && prev.main === sig.main && prev.wal === sig.wal && existsSync(target)) return [];
	lastState.set("session.db", sig);
	const mode = prev === void 0 || prev.main !== sig.main || !existsSync(target) ? "full" : "wal";
	if (mode === "full" && !fullDecryptDue("session.db")) {
		lastState.delete("session.db");
		return [];
	}
	try {
		const encKey = shardEncKey(decryptedDir, "session/session.db", rawDb, rawKeyHex, keyFormat);
		await mkdir(decSess, { recursive: true });
		const stagingDb = target + ".stage_src";
		const stagingWal = target + ".stage_wal";
		const temp = target + ".decrypt_tmp";
		if (mode === "wal") {
			if (!await walFramesPatchable(rawDb + "-wal")) {
				console.warn("[wechat-sync] session.db wal salt epoch mismatch, keeping snapshot");
				return [];
			}
			await copyFile(target, stagingDb);
			await stageWal(rawDb + "-wal", stagingWal);
			try {
				const walPages = existsSync(stagingWal) ? await decryptWalPatch(stagingWal, stagingDb, encKey) : 0;
				if (!looksDecrypted(stagingDb)) throw new Error("session wal patch invalid");
				await atomicReplace(stagingDb, target);
				if (walPages > 0) return [`session.db:wal(w${walPages})`];
				return [];
			} finally {
				for (const f of [stagingWal, temp]) try {
					await unlink(f);
				} catch {}
			}
		}
		await copyFile(rawDb, stagingDb);
		await stageWal(rawDb + "-wal", stagingWal);
		try {
			const fullPages = await fullDecryptFile(stagingDb, temp, encKey);
			const walPages = existsSync(stagingWal) ? await decryptWalPatch(stagingWal, temp, encKey) : 0;
			if (!looksDecrypted(temp)) throw new Error("session decrypt invalid");
			await atomicReplace(temp, target);
			return [`session.db:full(${fullPages}p/w${walPages})`];
		} finally {
			for (const f of [
				stagingDb,
				stagingWal,
				temp
			]) try {
				await unlink(f);
			} catch {}
		}
	} catch (e) {
		lastState.delete("session.db");
		console.error("[wechat-sync] session.db", e.message);
		return [];
	}
}
/** Contact-db signature (main + wal). */
function contactSig(contactDir) {
	const sig = {
		main: 0,
		wal: 0
	};
	for (const f of ["contact.db", "contact.db-wal"]) try {
		const ms = statSync(join(contactDir, f)).mtimeMs;
		if (f === "contact.db") sig.main = ms;
		else sig.wal = ms;
	} catch {}
	return sig;
}
/**
* Sync contact.db (contact/chatroom/friends names + members) from the raw
* tree into the decrypted snapshot — full re-decrypt when the main file
* changed, WAL frame patch otherwise. Without this, newly added contacts /
* official accounts (gh_*) keep showing their raw username in the sidebar.
* @param rawDbDir - raw db_storage root.
* @param decryptedDir - decrypted snapshot root.
* @param lastState - shared per-target signature state.
* @param rawKeyHex - fallback 64-hex raw key.
* @param keyFormat - key format (wx_key_v4.1).
* @returns descriptions of what was synced (empty when nothing changed).
*/
async function syncContactDb(rawDbDir, decryptedDir, lastState, rawKeyHex, keyFormat) {
	const rawContact = join(rawDbDir, "contact");
	const decContact = join(decryptedDir, "contact");
	const rawDb = join(rawContact, "contact.db");
	if (!existsSync(rawDb)) return [];
	const sig = contactSig(rawContact);
	const prev = lastState.get("contact.db");
	const target = join(decContact, "contact.db");
	if (prev !== void 0 && prev.main === sig.main && prev.wal === sig.wal && existsSync(target)) return [];
	lastState.set("contact.db", sig);
	const mode = prev === void 0 || prev.main !== sig.main || !existsSync(target) ? "full" : "wal";
	if (mode === "full" && !fullDecryptDue("contact.db")) {
		lastState.delete("contact.db");
		return [];
	}
	try {
		const encKey = shardEncKey(decryptedDir, "contact/contact.db", rawDb, rawKeyHex, keyFormat);
		await mkdir(decContact, { recursive: true });
		const stagingDb = target + ".stage_src";
		const stagingWal = target + ".stage_wal";
		const temp = target + ".decrypt_tmp";
		if (mode === "wal") {
			if (!await walFramesPatchable(rawDb + "-wal")) {
				console.warn("[wechat-sync] contact.db wal salt epoch mismatch, keeping snapshot");
				return [];
			}
			await copyFile(target, stagingDb);
			await stageWal(rawDb + "-wal", stagingWal);
			try {
				const walPages = existsSync(stagingWal) ? await decryptWalPatch(stagingWal, stagingDb, encKey) : 0;
				if (!looksDecrypted(stagingDb)) throw new Error("contact wal patch invalid");
				await atomicReplace(stagingDb, target);
				if (walPages > 0) return [`contact.db:wal(w${walPages})`];
				return [];
			} finally {
				for (const f of [stagingWal, temp]) try {
					await unlink(f);
				} catch {}
			}
		}
		await copyFile(rawDb, stagingDb);
		await stageWal(rawDb + "-wal", stagingWal);
		try {
			const fullPages = await fullDecryptFile(stagingDb, temp, encKey);
			const walPages = existsSync(stagingWal) ? await decryptWalPatch(stagingWal, temp, encKey) : 0;
			if (!looksDecrypted(temp)) throw new Error("contact decrypt invalid");
			await atomicReplace(temp, target);
			return [`contact.db:full(${fullPages}p/w${walPages})`];
		} finally {
			for (const f of [
				stagingDb,
				stagingWal,
				temp
			]) try {
				await unlink(f);
			} catch {}
		}
	} catch (e) {
		lastState.delete("contact.db");
		console.error("[wechat-sync] contact.db", e.message);
		return [];
	}
}
/** Signature of a plain db dir (main + wal by dbName). */
function plainDbSig(dir, dbName) {
	const sig = {
		main: 0,
		wal: 0
	};
	for (const f of [dbName, dbName + "-wal"]) try {
		const ms = statSync(join(dir, f)).mtimeMs;
		if (f === dbName) sig.main = ms;
		else sig.wal = ms;
	} catch {}
	return sig;
}
/**
* Sync any plain "dbName" under rawRoot/<sub> -> decryptedDir/<sub> with the
* shared full/WAL + 0-frame-upgrade policy (realtime coverage for general /
* sns / favorite / bizchat / chatbot).
* @returns descriptions of what was synced (empty when nothing changed).
*/
async function syncPlainDatabase(rawRoot, decryptedDir, sub, dbName, label, rawKeyHex, keyFormat, lastState) {
	const rawDir = join(rawRoot, sub);
	const decDir = join(decryptedDir, sub);
	const rawDb = join(rawDir, dbName);
	if (!existsSync(rawDb)) return [];
	const sig = plainDbSig(rawDir, dbName);
	const prev = lastState.get(label);
	const target = join(decDir, dbName);
	if (prev !== void 0 && prev.main === sig.main && prev.wal === sig.wal && existsSync(target)) return [];
	lastState.set(label, sig);
	const mode = prev === void 0 || prev.main !== sig.main || !existsSync(target) ? "full" : "wal";
	if (mode === "full" && !fullDecryptDue(label)) {
		lastState.delete(label);
		return [];
	}
	try {
		const encKey = shardEncKey(decryptedDir, sub + "/" + dbName, rawDb, rawKeyHex, keyFormat);
		await mkdir(decDir, { recursive: true });
		const stagingDb = target + ".stage_src";
		const stagingWal = target + ".stage_wal";
		const temp = target + ".decrypt_tmp";
		if (mode === "wal") {
			if (!await walFramesPatchable(rawDb + "-wal")) {
				console.warn("[wechat-sync] " + label + " wal salt epoch mismatch, keeping snapshot");
				return [];
			}
			await copyFile(target, stagingDb);
			await stageWal(rawDb + "-wal", stagingWal);
			try {
				const walPages = existsSync(stagingWal) ? await decryptWalPatch(stagingWal, stagingDb, encKey) : 0;
				if (!looksDecrypted(stagingDb)) throw new Error(label + " wal patch invalid");
				await atomicReplace(stagingDb, target);
				if (walPages > 0) return [label + ":wal(w" + String(walPages) + ")"];
				return [];
			} finally {
				for (const f of [stagingWal, temp]) try {
					await unlink(f);
				} catch {}
			}
		}
		await copyFile(rawDb, stagingDb);
		await stageWal(rawDb + "-wal", stagingWal);
		try {
			const fullPages = await fullDecryptFile(stagingDb, temp, encKey);
			const walPages = existsSync(stagingWal) ? await decryptWalPatch(stagingWal, temp, encKey) : 0;
			if (!looksDecrypted(temp)) throw new Error(label + " decrypt invalid");
			await atomicReplace(temp, target);
			return [label + ":full(" + String(fullPages) + "p/w" + String(walPages) + ")"];
		} finally {
			for (const f of [
				stagingDb,
				stagingWal,
				temp
			]) try {
				await unlink(f);
			} catch {}
		}
	} catch (e) {
		lastState.delete(label);
		console.error("[wechat-sync]", label, e.message);
		return [];
	}
}
/**
* Remove stale staging/temp files (`.stage_src`/`.stage_wal`/`.decrypt_tmp`)
* left by a previously interrupted sync. A killed process can leave a
* half-written snapshot behind, and a fresh run that reuses it can stall.
* Real decrypted DB files are never matched.
* @param root - decrypted snapshot root to sweep.
*/
async function cleanStaleStagingFiles(root) {
	const suffixes = [
		".stage_src",
		".stage_wal",
		".decrypt_tmp"
	];
	async function walk(dir) {
		try {
			const entries = await readdir(dir, { withFileTypes: true });
			for (const entry of entries) {
				const p = join(dir, entry.name);
				if (entry.isDirectory()) await walk(p);
				else if (suffixes.some((s) => entry.name.endsWith(s))) try {
					await unlink(p);
				} catch {}
			}
		} catch {
			return;
		}
	}
	await walk(root);
}
/**
* Real-time sync loop: first run immediately, then poll on an interval.
* @param rawDbDir - provider of the raw db_storage root (re-read per tick).
* @param decryptedDir - provider of the decrypted snapshot root.
* @param onSync - called with the shards that changed (empty when nothing new).
* @returns a disposer that stops the loop.
*/
function startRealtimeSync(rawDbDir, decryptedDir, onSync) {
	const lastState = /* @__PURE__ */ new Map();
	let timer = null;
	let running = false;
	let unavailableWarned = false;
	let failureLogged = false;
	let cleaned = false;
	const tick = async () => {
		if (running) return;
		running = true;
		try {
			if (!cleaned) {
				cleaned = true;
				await cleanStaleStagingFiles(decryptedDir());
			}
			const raw = rawDbDir();
			const dec = decryptedDir();
			if (!raw || !dec || !existsSync(raw)) {
				if (!unavailableWarned) {
					unavailableWarned = true;
					console.warn("[wechat-sync] realtime sync paused: raw db dir unavailable", `(raw=${JSON.stringify(raw || "")}, decrypted=${JSON.stringify(dec || "")})`, "— set db_dir in config.json, _db_dir in all_keys.json, or DSH_WECHAT_BASE_DIR");
				}
				return;
			}
			if (unavailableWarned) {
				unavailableWarned = false;
				console.log("[wechat-sync] raw db dir available again:", raw);
			}
			const cfg = getConfig(dec);
			const keyFormat = typeof cfg["key_format"] === "string" ? cfg["key_format"] : "wx_key_v4.1";
			const fallbackKey = typeof cfg["db_enc_key"] === "string" ? cfg["db_enc_key"] : "";
			const synced = await syncChangedShards(raw, dec, lastState);
			synced.push(...await syncSessionDb(raw, dec, lastState, fallbackKey, keyFormat));
			synced.push(...await syncContactDb(raw, dec, lastState, fallbackKey, keyFormat));
			for (const [sub, dbName, label] of [
				[
					"general",
					"general.db",
					"general.db"
				],
				[
					"sns",
					"sns.db",
					"sns.db"
				],
				[
					"favorite",
					"favorite.db",
					"favorite.db"
				],
				[
					"bizchat",
					"bizchat.db",
					"bizchat.db"
				],
				[
					"chatbot",
					"chatbot_message.db",
					"chatbot_message.db"
				]
			]) synced.push(...await syncPlainDatabase(raw, dec, sub, dbName, label, fallbackKey, keyFormat, lastState));
			if (synced.length > 0) onSync?.(synced);
			failureLogged = false;
		} catch (e) {
			if (!failureLogged) {
				failureLogged = true;
				console.error("[wechat-sync] tick failed:", e instanceof Error ? e.message : e);
			}
		} finally {
			running = false;
		}
	};
	tick();
	timer = setInterval(() => {
		tick();
	}, SYNC_INTERVAL_MS);
	return () => {
		if (timer !== null) {
			clearInterval(timer);
			timer = null;
		}
	};
}
//#endregion
//#region lib/types/query/privacy.js
/**
* Privacy scan: extract phone/ID/card/email/password/address patterns from
* decrypted text messages, aggregating per-category counts + samples and
* TOP contact/group rankings (mirror of wechat/privacy.rs).
*/
const CATEGORIES$1 = [
	{
		key: "phone",
		label: "手机号",
		icon: "📱",
		re: /1[3-9]\d{9}/g,
		insensitive: false
	},
	{
		key: "id_card",
		label: "身份证号",
		icon: "🪪",
		re: /[1-9]\d{5}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx]/g,
		insensitive: false
	},
	{
		key: "bank_card",
		label: "银行卡号",
		icon: "💳",
		re: /(?:62\d{14,17}|[45]\d{15,18})/g,
		insensitive: false
	},
	{
		key: "email",
		label: "邮箱",
		icon: "✉️",
		re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
		insensitive: true
	},
	{
		key: "password",
		label: "密码口令",
		icon: "🔑",
		re: /(?:密码|口令|pwd|password|passwd)\s*[=:：]\s*[A-Za-z0-9@#$%^&*!_.-]{4,32}/g,
		insensitive: true
	},
	{
		key: "address",
		label: "地址信息",
		icon: "📍",
		re: /(?:住在|地址|住址|小区|门牌号|大厦|宿舍)[^\n，。！？]{2,60}/g,
		insensitive: false
	}
];
/** Build a snippet centered on the first match (source make_snippet). */
function makeSnippet(text, matched) {
	const idx = text.indexOf(matched);
	if (idx < 0) return text.slice(0, 60);
	const start = Math.max(0, idx - 24);
	const end = Math.min(text.length, idx + matched.length + 36);
	const mid = text.slice(start, end);
	return start > 0 ? "…" + mid : mid;
}
/** Format a unix timestamp as YYYY-MM-DD HH:MM. */
function fmtFull$1(ts) {
	if (!ts) return "";
	const d = /* @__PURE__ */ new Date(ts * 1e3);
	const p = (n) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
/** Coerce a DB cell to a string (null -> '', else String()). */
function cellStr$11(v) {
	if (typeof v === "string") return v;
	if (v === null || v === void 0) return "";
	if (typeof v === "number" || typeof v === "boolean" || typeof v === "bigint" || typeof v === "symbol") return String(v);
	return "";
}
/** Message table names from the session db (source annual::load_session_usernames). */
function loadSessionUsernames$2(decryptedDir) {
	const out = [];
	try {
		const db = new DatabaseSync(join(decryptedDir, "session", "session.db"), { readOnly: true });
		if (!(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='SessionTable'").get() !== void 0)) {
			db.close();
			return out;
		}
		const cols = new Set(db.prepare("PRAGMA table_info(SessionTable)").all().map((r) => r.name));
		const userCol = cols.has("username") ? "username" : cols.has("UserName") ? "UserName" : "";
		if (!userCol) {
			db.close();
			return out;
		}
		const rows = db.prepare(`SELECT ${userCol} AS u FROM SessionTable`).all();
		for (const r of rows) {
			const u = cellStr$11(r.u ?? "");
			if (u) out.push(u);
		}
		db.close();
	} catch {}
	return out;
}
/** Contact display names (remark > nick). */
function loadDisplayNames$1(decryptedDir) {
	const map = /* @__PURE__ */ new Map();
	try {
		const db = new DatabaseSync(join(decryptedDir, "contact", "contact.db"), { readOnly: true });
		const cols = new Set(db.prepare("PRAGMA table_info(contact)").all().map((r) => r.name));
		if (!cols.has("username")) {
			db.close();
			return map;
		}
		const remark = cols.has("remark") ? "remark" : cols.has("Remark") ? "Remark" : "NULL";
		const nick = cols.has("nick_name") ? "nick_name" : cols.has("NickName") ? "NickName" : "nickName";
		const rows = db.prepare(`SELECT username, COALESCE(NULLIF(${remark}, ''), ${nick}) AS n FROM contact`).all();
		for (const r of rows) {
			const u = cellStr$11(r["username"] ?? "");
			const n = cellStr$11(r["n"] ?? "").trim();
			if (u && n) map.set(u, n);
		}
		db.close();
	} catch {}
	return map;
}
/** Decode a BLOB/TEXT cell to UTF-8 text. */
function decodeCell$7(v) {
	if (v == null) return "";
	if (typeof v === "string") return v;
	if (v instanceof Uint8Array) return new TextDecoder("utf-8", { fatal: false }).decode(v);
	if (typeof v === "number" || typeof v === "boolean" || typeof v === "bigint" || typeof v === "symbol") return String(v);
	return "";
}
/**
* Scan message shards for sensitive patterns.
* @param decryptedDir - decrypted data root.
* @param rowBudget - max scanned rows (default 600000, source budget).
* @returns categories with samples + rankings.
*/
function queryPrivacyScan(decryptedDir, rowBudget = 6e5) {
	const msgDir = join(decryptedDir, "message");
	const categories = CATEGORIES$1.map((c) => ({
		key: c.key,
		label: c.label,
		count: 0,
		icon: c.icon,
		samples: []
	}));
	const hitsByKey = /* @__PURE__ */ new Map();
	const perContact = /* @__PURE__ */ new Map();
	const usernames = loadSessionUsernames$2(decryptedDir);
	const names = loadDisplayNames$1(decryptedDir);
	let scanned = 0;
	let involved = 0;
	if (existsSync(msgDir)) {
		const shards = readdirSync(msgDir).filter((f) => f.endsWith(".db") && !f.includes("_shm") && !f.includes("_wal") && !f.includes("tmp"));
		const targetUsernames = usernames.slice(0, 800);
		const tableToUser = /* @__PURE__ */ new Map();
		for (const username of targetUsernames) tableToUser.set("Msg_" + createHash("md5").update(username, "utf8").digest("hex"), username);
		const fileInfos = [];
		for (const file of shards) {
			let probe = null;
			try {
				probe = new DatabaseSync(join(msgDir, file), { readOnly: true });
			} catch {
				continue;
			}
			try {
				const names = probe.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'Msg_%'").all().map((r) => r.name);
				const tables = [];
				for (const n of names) {
					const u = tableToUser.get(n);
					if (u) tables.push([n, u]);
				}
				if (tables.length > 0) fileInfos.push({
					path: join(msgDir, file),
					tables
				});
			} catch {} finally {
				probe.close();
			}
		}
		for (const fi of fileInfos) {
			if (scanned >= rowBudget) break;
			let db = null;
			try {
				db = new DatabaseSync(fi.path, { readOnly: true });
			} catch {
				continue;
			}
			try {
				for (const [tableName, username] of fi.tables) {
					if (scanned >= rowBudget) break;
					try {
						const cols = new Set(db.prepare(`PRAGMA table_info(${tableName})`).all().map((r) => r.name));
						if (!cols.has("local_id") || !cols.has("create_time") || !cols.has("message_content")) continue;
						const typeCol = cols.has("local_type") ? "local_type" : "type";
						const rows = db.prepare(`SELECT local_id, create_time, message_content FROM ${tableName} WHERE ${typeCol}=1`).all();
						for (const r of rows) {
							scanned += 1;
							if (scanned >= rowBudget) break;
							const text = decodeCell$7(r.message_content);
							if (!text || text.startsWith("<")) continue;
							const localId = r.local_id ?? 0;
							const ts = r.create_time ?? 0;
							let anyHit = false;
							for (let ci = 0; ci < categories.length; ci += 1) {
								const cat = categories[ci];
								if (cat === void 0) continue;
								const spec = CATEGORIES$1[ci];
								if (!spec) continue;
								const re = spec.insensitive ? new RegExp(spec.re.source, "gi") : spec.re;
								re.lastIndex = 0;
								const m = re.exec(text);
								if (!m) continue;
								cat.count += 1;
								const matched = m[0];
								const samples = hitsByKey.get(cat.key) ?? [];
								if (samples.length < 200) samples.push({
									username,
									name: names.get(username) ?? username,
									local_id: localId,
									ts,
									time: fmtFull$1(ts),
									snippet: makeSnippet(text, matched)
								});
								hitsByKey.set(cat.key, samples);
								anyHit = true;
							}
							if (anyHit) perContact.set(username, (perContact.get(username) ?? 0) + 1);
						}
						involved += 1;
					} catch {}
				}
			} finally {
				db.close();
			}
		}
	}
	for (const c of categories) c.samples = hitsByKey.get(c.key) ?? [];
	const totalHits = categories.reduce((a, c) => a + c.count, 0);
	const topContacts = Array.from(perContact.entries()).filter(([u]) => !u.endsWith("@chatroom") && !u.startsWith("gh_")).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 10).map(([username, count]) => ({
		username,
		name: names.get(username) ?? username,
		count
	}));
	const topGroups = Array.from(perContact.entries()).filter(([u]) => u.endsWith("@chatroom")).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 10).map(([username, count]) => ({
		username,
		name: names.get(username) ?? username,
		count
	}));
	return {
		categories,
		total_hits: totalHits,
		involved_sessions: involved,
		top_contacts: topContacts,
		top_groups: topGroups
	};
}
//#endregion
//#region lib/types/query/graph.js
/**
* Relationship graph: contact/group nodes with display names, message counts,
* shared-group codes (people mode) and shared-member metrics (groups mode),
* mirroring st_control insights/graph.rs. Edges are derived client-side from
* group_codes (people: contact↔contact by common groups; groups: group↔group
* by common members), like the source GraphModel.
*/
/** Stringify an SQLite cell (TEXT/NUMBER/BLOB) to a string. */
function cellString$4(v) {
	if (v === null || v === void 0) return "";
	if (typeof v === "string") return v;
	if (v instanceof Uint8Array) return new TextDecoder("utf-8", { fatal: false }).decode(v);
	if (typeof v === "number" || typeof v === "boolean" || typeof v === "bigint" || typeof v === "symbol") return String(v);
	return "";
}
function tableColumns$8(db, table) {
	const rows = db.prepare(`PRAGMA table_info(${table})`).all();
	return new Set(rows.map((r) => r.name));
}
/** Strip the WeChat instance suffix (wxid_xxx_f312 -> wxid_xxx). */
function cleanWxid$1(username) {
	const m = username.match(/^(wxid_[A-Za-z0-9]+)(?:_[A-Za-z0-9]+)?$/);
	return m ? m[1] ?? username : username;
}
/** Per-taker message counts (Msg_<md5> tables across shards, file-first). */
function loadMessageCounts(decryptedDir, usernames) {
	const counts = /* @__PURE__ */ new Map();
	const tableToUser = /* @__PURE__ */ new Map();
	for (const u of usernames) tableToUser.set("Msg_" + createHash("md5").update(u, "utf8").digest("hex"), u);
	for (const sh of shardCatalog(decryptedDir)) for (const t of sh.tables.keys()) {
		const u = tableToUser.get(t);
		if (!u || counts.has(u)) continue;
		let db = null;
		try {
			db = new DatabaseSync(sh.file, { readOnly: true });
		} catch {
			continue;
		}
		try {
			counts.set(u, db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n);
		} catch {} finally {
			db.close();
		}
	}
	return counts;
}
/** Friend flag + avatar per contact username. */
function loadContactMeta(decryptedDir) {
	const meta = /* @__PURE__ */ new Map();
	const p = join(decryptedDir, "contact", "contact.db");
	if (!existsSync(p)) return meta;
	try {
		const db = new DatabaseSync(p, { readOnly: true });
		const cols = tableColumns$8(db, "contact");
		if (!cols.has("username")) {
			db.close();
			return meta;
		}
		const sel = (c, dft) => cols.has(c) ? c : dft;
		const rows = db.prepare(`SELECT ${sel("username", "''")} AS u, ${sel("local_type", "0")} AS lt, ${sel("delete_flag", "0")} AS df, ${sel("small_head_url", "''")} AS s, ${sel("big_head_url", "''")} AS b FROM contact`).all();
		for (const r of rows) {
			const u = cellString$4(r.u);
			if (!u || u.endsWith("@chatroom")) continue;
			const avatar = cellString$4(r.b).trim() || cellString$4(r.s).trim();
			meta.set(u, {
				isFriend: r.lt === 1 && r.df === 0,
				avatar
			});
		}
		db.close();
	} catch {}
	return meta;
}
/** Build member↔group maps; ext_buffer snapshot fills chatroom_member gaps. */
function loadRoomData(decryptedDir) {
	const out = {
		memberGroups: /* @__PURE__ */ new Map(),
		roomMembers: /* @__PURE__ */ new Map(),
		roomCounts: /* @__PURE__ */ new Map()
	};
	const p = join(decryptedDir, "contact", "contact.db");
	if (!existsSync(p)) return out;
	try {
		const db = new DatabaseSync(p, { readOnly: true });
		const cid = tableColumns$8(db, "contact").has("id") ? "id" : "rowid";
		const idToUser = /* @__PURE__ */ new Map();
		try {
			const users = db.prepare(`SELECT ${cid} AS id, username FROM contact`).all();
			for (const r of users) idToUser.set(r.id, cellString$4(r.username));
		} catch {}
		let rooms = [];
		try {
			const crCols = tableColumns$8(db, "chat_room");
			if (crCols.has("ext_buffer")) rooms = db.prepare("SELECT id, username, ext_buffer AS ext FROM chat_room").all();
			else if (crCols.has("id") && crCols.has("username")) rooms = db.prepare("SELECT id, username FROM chat_room").all();
		} catch {}
		for (const room of rooms) {
			const u = cellString$4(room.username);
			if (!u) continue;
			if (!out.roomMembers.has(u)) out.roomMembers.set(u, /* @__PURE__ */ new Set());
		}
		try {
			const rows = db.prepare("SELECT room_id, member_id FROM chatroom_member").all();
			const roomByUsername = /* @__PURE__ */ new Map();
			for (const room of rooms) roomByUsername.set(room.id, cellString$4(room.username));
			for (const r of rows) {
				const room = roomByUsername.get(r.room_id);
				const user = idToUser.get(r.member_id);
				if (!room || !user) continue;
				out.roomMembers.get(room)?.add(user);
				let groups = out.memberGroups.get(user);
				if (!groups) {
					groups = /* @__PURE__ */ new Set();
					out.memberGroups.set(user, groups);
				}
				groups.add(room);
			}
		} catch {}
		for (const room of rooms) {
			const u = cellString$4(room.username);
			const raw = room.ext;
			const buf = raw instanceof Uint8Array ? Buffer.from(raw) : typeof raw === "string" && raw.length > 0 ? Buffer.from(raw, "utf8") : Buffer.alloc(0);
			if (!u || buf.length === 0) continue;
			let snap = [];
			try {
				snap = parseChatRoomExtBuffer(buf);
			} catch {
				snap = [];
			}
			for (const s of snap) {
				if (!s.username) continue;
				out.roomMembers.get(u)?.add(s.username);
				let groups = out.memberGroups.get(s.username);
				if (!groups) {
					groups = /* @__PURE__ */ new Set();
					out.memberGroups.set(s.username, groups);
				}
				groups.add(u);
			}
		}
		for (const [u, members] of out.roomMembers) out.roomCounts.set(u, members.size);
		db.close();
	} catch {}
	return out;
}
/**
* Build a graph snapshot: contact/group nodes enriched for both display modes.
* @param decryptedDir - decrypted data root.
* @param selfUsername - logged-in account wxid (excluded from persons).
* @returns nodes + summary (edges derived client-side from group_codes).
*/
function queryGraph(decryptedDir, selfUsername) {
	const nodes = [];
	const sessionPath = join(decryptedDir, "session", "session.db");
	const talkers = [];
	if (existsSync(sessionPath)) try {
		const db = new DatabaseSync(sessionPath, { readOnly: true });
		if (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='SessionTable'").get() !== void 0) {
			const rows = db.prepare("SELECT username FROM SessionTable").all();
			for (const r of rows) {
				const u = cellString$4(r.username);
				if (u && u !== "self") talkers.push(u);
			}
		}
		db.close();
	} catch {}
	const names = contactMeta(decryptedDir).names;
	const counts = loadMessageCounts(decryptedDir, talkers);
	const meta = loadContactMeta(decryptedDir);
	const roomData = loadRoomData(decryptedDir);
	const selfWxid = selfUsername ? cleanWxid$1(selfUsername) : "";
	const persons = [];
	const personIds = /* @__PURE__ */ new Set();
	for (const [u, info] of meta) {
		if (selfWxid && cleanWxid$1(u) === selfWxid) continue;
		const kind = u.startsWith("gh_") ? "official" : "contact";
		const groups = Array.from(roomData.memberGroups.get(u) ?? []).sort();
		const node = {
			id: u,
			label: names.get(u) || u,
			kind,
			msg_count: counts.get(u) ?? 0,
			group_count: groups.length,
			group_codes: groups,
			is_friend: info.isFriend
		};
		if (info.avatar) node.avatar_url = info.avatar;
		persons.push(node);
		personIds.add(u);
	}
	persons.sort((a, b) => (b.msg_count ?? 0) - (a.msg_count ?? 0) || (b.group_count ?? 0) - (a.group_count ?? 0) || a.id.localeCompare(b.id));
	const groups = [];
	for (const u of talkers) {
		if (!u.endsWith("@chatroom")) continue;
		const members = roomData.roomMembers.get(u) ?? /* @__PURE__ */ new Set();
		const shared = [];
		for (const m of members) {
			if (!personIds.has(m)) continue;
			shared.push({
				username: m,
				name: names.get(m) || m,
				is_friend: meta.get(m)?.isFriend ?? false,
				msg_count: counts.get(m) ?? 0
			});
		}
		shared.sort((a, b) => b.msg_count - a.msg_count || a.username.localeCompare(b.username));
		const node = {
			id: u,
			label: names.get(u) || u,
			kind: "group",
			msg_count: counts.get(u) ?? 0,
			member_count: roomData.roomCounts.get(u) ?? members.size,
			shared_count: shared.length,
			shared_members: shared.slice(0, 8),
			is_friend: false
		};
		groups.push(node);
	}
	groups.sort((a, b) => (b.shared_count ?? 0) - (a.shared_count ?? 0) || (b.msg_count ?? 0) - (a.msg_count ?? 0) || b.id.localeCompare(a.id));
	const totalMessages = Array.from(counts.values()).reduce((a, b) => a + b, 0);
	const friendCount = persons.filter((n) => n.is_friend).length;
	const groupNames = {};
	for (const g of groups) groupNames[g.id] = g.label;
	const topRelations = persons.slice(0, 8).map((n) => ({
		username: n.id,
		name: n.label,
		msg_count: n.msg_count ?? 0
	}));
	const selfMeta = selfWxid ? meta.get(selfWxid) : void 0;
	nodes.push({
		id: "self",
		label: "我",
		kind: "self",
		msg_count: 0,
		is_friend: true,
		...selfMeta?.avatar ? { avatar_url: selfMeta.avatar } : {}
	});
	nodes.push(...persons, ...groups);
	return {
		self: selfUsername ?? "",
		group_names: groupNames,
		nodes,
		edges: [],
		summary: {
			total_contacts: persons.filter((n) => n.kind === "contact").length,
			total_groups: groups.length,
			total_messages: totalMessages,
			contact_book_total: persons.length,
			contact_book_friends: friendCount,
			contact_book_members: persons.filter((n) => (n.group_count ?? 0) > 0).length,
			selected_contacts: persons.length,
			selected_groups: groups.length,
			top_relations: topRelations
		}
	};
}
//#endregion
//#region lib/types/query/calendar.js
/**
* Chat calendar: per-day message counts for one month, rewritten from
* st_control handlers/session/search.rs get_chat_daily_counts.
*/
/** Msg_<md5(username)> table name for a talker. */
function msgTableName$8(username) {
	return "Msg_" + createHash("md5").update(username, "utf8").digest("hex");
}
/**
* Daily message counts for one talker in a month (local time).
* @param decryptedDir - decrypted data root.
* @param username - conversation username.
* @param year - calendar year.
* @param month - calendar month (1-12).
* @returns day -> count plus the requested year/month.
*/
function getDailyCounts(decryptedDir, username, year, month) {
	if (month < 1 || month > 12) throw new Error("无效月份");
	const start = new Date(year, month - 1, 1, 0, 0, 0, 0);
	const end = new Date(year, month, 1, 0, 0, 0, 0);
	const startTs = Math.floor(start.getTime() / 1e3);
	const endTs = Math.floor(end.getTime() / 1e3);
	const counts = {};
	const msgDir = join(decryptedDir, "message");
	if (!existsSync(msgDir)) return {
		counts,
		year,
		month
	};
	const files = readdirSync(msgDir).filter((f) => f.endsWith(".db") && f.startsWith("message_") && !f.includes("fts") && !f.includes("resource") && !f.includes("media")).sort();
	const table = msgTableName$8(username);
	for (const f of files) {
		let db = null;
		try {
			db = new DatabaseSync(join(msgDir, f), { readOnly: true });
		} catch {
			continue;
		}
		if (!(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table) !== void 0)) {
			db.close();
			continue;
		}
		try {
			const sql = "SELECT strftime('%d', create_time, 'unixepoch', 'localtime') AS d, COUNT(*) AS c FROM \"" + table + "\" WHERE create_time >= ? AND create_time < ? GROUP BY d";
			const rows = db.prepare(sql).all(startTs, endTs);
			for (const r of rows) {
				const day = Number(r.d);
				if (Number.isFinite(day)) counts[String(day)] = (counts[String(day)] ?? 0) + r.c;
			}
		} catch {} finally {
			db.close();
		}
	}
	return {
		counts,
		year,
		month
	};
}
//#endregion
//#region lib/types/query/search.js
/**
* WeChat full-text message search index (FTS5), rewritten from st_control
* chat_search_index.rs. The index DB lives next to the decrypted dir
* (data/wechat/wechat_search.db); search prefers the index and falls back
* to a bounded full-table scan over the message shards.
*/
/** zstd magic bytes (WCDB compressed blobs). */
const ZSTD_MAGIC$6 = Buffer.from([
	40,
	181,
	47,
	253
]);
/** Decode raw column bytes: zstd-decompress when the magic matches. */
function tryDecompress$2(data) {
	if (data.length >= 4 && data.subarray(0, 4).equals(ZSTD_MAGIC$6)) try {
		return Buffer.from(decompress(data));
	} catch {
		return null;
	}
	return null;
}
/**
* Index DB path: sibling of the decrypted dir.
* @param decryptedDir - decrypted data root.
* @returns the absolute path of the search index DB.
*/
function searchIndexPath(decryptedDir) {
	return join(dirname(decryptedDir), "wechat_search.db");
}
/** Msg_<md5(username)> table name for a talker. */
function msgTableName$7(username) {
	return "Msg_" + createHash("md5").update(username, "utf8").digest("hex");
}
/** Decode a BLOB or TEXT cell to UTF-8 text (zstd + GBK aware). */
function decodeCell$6(v) {
	if (v === null || v === void 0) return "";
	if (typeof v === "string") return v;
	if (typeof v === "number" || typeof v === "boolean" || typeof v === "bigint" || typeof v === "symbol") return String(v);
	const raw = Buffer.from(v instanceof Uint8Array ? v : []);
	const bytes = tryDecompress$2(raw) ?? raw;
	try {
		return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
	} catch {
		return new TextDecoder("gbk", { fatal: false }).decode(bytes);
	}
}
/** Message shard DB files under <decrypted>/message (catalog-backed, sorted). */
function messageShardFiles$4(decryptedDir) {
	return shardCatalog(decryptedDir).map((s) => s.file);
}
/** Session usernames from session.db (SessionTable or Session). */
function loadSessionUsernames$1(decryptedDir) {
	const dbPath = join(decryptedDir, "session", "session.db");
	if (!existsSync(dbPath)) return [];
	const out = [];
	try {
		const db = new DatabaseSync(dbPath, { readOnly: true });
		const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
		const table = tables.includes("SessionTable") ? "SessionTable" : tables.includes("Session") ? "Session" : "";
		if (table) {
			const rows = db.prepare("SELECT username FROM \"" + table + "\"").all();
			for (const r of rows) {
				const u = decodeCell$6(r["username"]).trim();
				if (u) out.push(u);
			}
		}
		db.close();
	} catch {}
	return out;
}
/** Display names: contact remark/nick then session titles. */
function loadDisplayNames(decryptedDir) {
	const names = /* @__PURE__ */ new Map();
	for (const [u, n] of contactMeta(decryptedDir).names) names.set(u, n);
	const sessionDb = join(decryptedDir, "session", "session.db");
	if (existsSync(sessionDb)) try {
		const db = new DatabaseSync(sessionDb, { readOnly: true });
		if (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='SessionNoContactInfoTable'").get() !== void 0) {
			const rows = db.prepare("SELECT username, session_title FROM SessionNoContactInfoTable").all();
			for (const r of rows) {
				const u = decodeCell$6(r["username"]);
				const t = decodeCell$6(r["session_title"]).trim();
				if (u && t && !names.has(u)) names.set(u, t);
			}
		}
		db.close();
	} catch {}
	return names;
}
/**
* Search index status.
* @param decryptedDir - decrypted data root.
* @returns whether the index exists plus row count and built_at timestamp.
*/
function getSearchIndexStatus(decryptedDir) {
	const p = searchIndexPath(decryptedDir);
	if (!existsSync(p)) return {
		exists: false,
		rows: 0,
		built_at: null,
		ready: false
	};
	try {
		const db = new DatabaseSync(p, { readOnly: true });
		const rows = db.prepare("SELECT COUNT(*) AS c FROM message_meta").get().c;
		const built = db.prepare("SELECT value FROM meta WHERE key='built_at'").get();
		const ver = db.prepare("SELECT value FROM meta WHERE key='schema_version'").get();
		db.close();
		return {
			exists: true,
			rows,
			built_at: built?.value ?? null,
			ready: rows > 0 && ver?.value === INDEX_SCHEMA_VERSION
		};
	} catch {
		return {
			exists: true,
			rows: 0,
			built_at: null,
			ready: false
		};
	}
}
/** 索引 schema 版本：结构变化时自动重建（存在 meta 表里）。 */
const INDEX_SCHEMA_VERSION = "3";
/**
 * 把文本切成「unicode61 能正确检索」的形态 —— 中文 bigram 索引。
 * node:sqlite 只有 unicode61（把整串汉字当一个 token），写入时先拆成相邻 2 字窗口，
 * 检索时用同样规则拆查询词，FTS5 才能建出真正可用的中文 BM25 索引。
 */
function bigramTokens(text) {
	const out = [];
	for (const run of String(text || "").match(/[\u4e00-\u9fff]+|[A-Za-z0-9_]+/g) || []) {
		if (/^[A-Za-z0-9_]+$/.test(run)) {
			out.push(run.toLowerCase());
			continue;
		}
		if (run.length === 1) {
			out.push(run);
			continue;
		}
		for (let i = 0; i + 2 <= run.length; i += 1) out.push(run.slice(i, i + 2));
	}
	return out.join(" ");
}
/** 把一个检索词编成 FTS5 短语：bigram 之间要求连续出现（精度优先）。 */
function ftsPhrase(term) {
	const toks = bigramTokens(term).split(" ").filter(Boolean);
	if (toks.length === 0) return "";
	if (toks.length === 1) return "\"" + toks[0].replace(/"/g, "") + "\"";
	return "\"" + toks.join(" ") + "\"";
}
/** 索引是否可用（存在且版本匹配）。 */
function indexReady(decryptedDir) {
	const p = searchIndexPath(decryptedDir);
	if (!existsSync(p)) return false;
	try {
		const db = new DatabaseSync(p, { readOnly: true });
		const rows = db.prepare("SELECT COUNT(*) AS c FROM message_meta").get().c;
		const ver = db.prepare("SELECT value FROM meta WHERE key='schema_version'").get();
		db.close();
		return rows > 0 && ver?.value === INDEX_SCHEMA_VERSION;
	} catch {
		return false;
	}
}
/** 某个词在索引里的文档频率（df）；索引不可用返回 -1。
 *  用于过滤兜底 bigram 的跨词切分噪音（`次转`/`账给` 来自「最近一次转账」），
 *  它们在 BM25 里是合法 token，不过滤会把真正的「转账」通知挤出前列。 */
function countIndexMatches(decryptedDir, term) {
	if (!indexReady(decryptedDir)) return -1;
	const phrase = ftsPhrase(term);
	if (!phrase) return 0;
	try {
		const db = new DatabaseSync(searchIndexPath(decryptedDir), { readOnly: true });
		const row = db.prepare("SELECT COUNT(*) AS c FROM message_fts WHERE message_fts MATCH ?").get(phrase);
		db.close();
		return Number(row?.c ?? 0);
	} catch {
		return -1;
	}
}
/**
 * 一次 MATCH 检索全部词项（BM25 排序的全库召回）。
 * 相比「每词各查一次 LIKE、各取前 20 条、按行号倒序」：BM25 真的按相关度排序，
 * 命中数不再被 per-term cap 截断成任意样本（实测 `合同` 全库 4062 条，旧路径只看得到 20 条），
 * 且 bm25() 直接给出真实词 IDF；who 列让「问某人」能命中与他的会话。
 */
function searchIndexBatch(decryptedDir, terms, limit = 400, opts) {
	if (!indexReady(decryptedDir)) return {
		hits: [],
		ranked: false
	};
	const parts = terms.map(ftsPhrase).filter(Boolean);
	if (opts?.person) {
		const who = ftsPhrase(opts.person);
		if (who) parts.push("who:" + who);
	}
	if (parts.length === 0) return {
		hits: [],
		ranked: false
	};
	const match = parts.join(" OR ");
	try {
		const db = new DatabaseSync(searchIndexPath(decryptedDir), { readOnly: true });
		const sql = "SELECT m.text, m.username, m.create_time, m.local_id, bm25(message_fts) AS score FROM message_fts JOIN message_meta m ON m.rowid = message_fts.rowid WHERE message_fts MATCH ?" + (opts?.username ? " AND m.username = ?" : "") + " ORDER BY rank LIMIT ?";
		const args = opts?.username ? [match, opts.username, limit] : [match, limit];
		const rows = db.prepare(sql).all(...args);
		db.close();
		const names = loadDisplayNames(decryptedDir);
		const hits = rows.map((r) => {
			const text = decodeCell$6(r["text"]);
			const username = decodeCell$6(r["username"]);
			const createTime = Number(r["create_time"] ?? 0);
			const split = splitGroupPrefix(text, username);
			return {
				text,
				username,
				create_time: createTime,
				local_id: Number(r["local_id"] ?? 0),
				name: names.get(username) ?? username,
				time: formatFullTime(createTime),
				snippet: split.body.slice(0, 120),
				sender: senderLabel(split.sender, names),
				score: -Number(r["score"] ?? 0)
			};
		});
		return {
			hits,
			ranked: true
		};
	} catch {
		return {
			hits: [],
			ranked: false
		};
	}
}
/**
* Build (or rebuild) the FTS5 search index over text messages.
* @param decryptedDir - decrypted data root.
* @param force - drop and rebuild even when an index exists.
* @returns build result with status and row count.
*/
function buildSearchIndex(decryptedDir, force) {
	const db = new DatabaseSync(searchIndexPath(decryptedDir));
	const init = () => {
		db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
		// tokens 列存 bigram 切分后的文本、who 列存「会话名 + 群内发送者」，两列都进 BM25 索引；
		// 原文存在 message_meta 里（不重复索引），rowid 一一对应。
		db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS message_fts USING fts5(tokens, who, tokenize='unicode61')");
		db.exec("CREATE TABLE IF NOT EXISTS message_meta (rowid INTEGER PRIMARY KEY, text TEXT NOT NULL, username TEXT NOT NULL, create_time INTEGER NOT NULL DEFAULT 0, sort_seq INTEGER NOT NULL DEFAULT 0, local_id INTEGER NOT NULL DEFAULT 0)");
	};
	try {
		init();
		const existing = db.prepare("SELECT COUNT(*) AS c FROM message_meta").get().c;
		const ver = db.prepare("SELECT value FROM meta WHERE key='schema_version'").get();
		if (!force && existing > 0 && ver?.value === INDEX_SCHEMA_VERSION) return {
			status: "exists",
			rows: existing,
			message: "索引已存在，使用 force=true 可重建"
		};
		db.exec("DROP TABLE IF EXISTS message_fts");
		db.exec("DROP TABLE IF EXISTS message_meta");
		init();
		db.exec("DELETE FROM meta WHERE key='built_at'");
		const started = Date.now();
		const names = loadDisplayNames(decryptedDir);
		const usernames = loadSessionUsernames$1(decryptedDir);
		const shards = messageShardFiles$4(decryptedDir);
		db.exec("BEGIN");
		let total = 0;
		let batch = [];
		const flush = () => {
			if (batch.length === 0) return;
			const insMeta = db.prepare("INSERT INTO message_meta(text, username, create_time, sort_seq, local_id) VALUES(?, ?, ?, ?, ?)");
			const insFts = db.prepare("INSERT INTO message_fts(rowid, tokens, who) VALUES(?, ?, ?)");
			for (const [text, tokens, who, username, createTime, sortSeq, localId] of batch) {
				const r = insMeta.run(text, username, createTime, sortSeq, localId);
				insFts.run(Number(r.lastInsertRowid), tokens, who);
			}
			batch = [];
		};
		for (const username of usernames) {
			const table = msgTableName$7(username);
			// 会话名进 who 列：问「李四」时，与李四的会话本身就该命中，
			// 而不是只匹配到正文里恰好写了「李四」的消息。
			const sessionWho = bigramTokens(names.get(username) ?? username);
			for (const shard of shards) {
				let sdb = null;
				try {
					sdb = new DatabaseSync(shard, { readOnly: true });
				} catch {
					continue;
				}
				if (!(sdb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table) !== void 0)) {
					sdb.close();
					continue;
				}
				try {
					// 不再只取 local_type=1：转账/链接/文件/引用等 appmsg 与系统提示都带可读文本
					const sql = "SELECT local_id, create_time, sort_seq, message_content, compress_content FROM \"" + table + "\"";
					const rows = sdb.prepare(sql).all();
					for (const r of rows) {
						const localId = Number(r["local_id"] ?? 0);
						const createTime = Number(r["create_time"] ?? 0);
						const sortSeq = Number(r["sort_seq"] ?? localId);
						const raw = decodeCell$6(r["message_content"]) || decodeCell$6(r["compress_content"]);
						const split = splitGroupPrefix(raw, username);
						const text = readableMessageText(split.body);
						if (!text) continue;
						const who = split.sender ? sessionWho + " " + bigramTokens(names.get(split.sender) ?? split.sender) : sessionWho;
						batch.push([
							text,
							bigramTokens(text),
							who,
							username,
							createTime,
							sortSeq,
							localId
						]);
						if (batch.length >= 500) flush();
					}
				} catch {} finally {
					sdb.close();
				}
			}
			if (batch.length >= 500) flush();
		}
		flush();
		db.exec("COMMIT");
		total = db.prepare("SELECT COUNT(*) AS c FROM message_meta").get().c;
		const builtAt = (/* @__PURE__ */ new Date()).toISOString().slice(0, 19).replace("T", " ");
		db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES('built_at', ?)").run(builtAt);
		db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES('schema_version', ?)").run(INDEX_SCHEMA_VERSION);
		return {
			status: "ok",
			rows: total,
			built_at: builtAt,
			elapsed_ms: Date.now() - started
		};
	} catch (e) {
		try {
			db.exec("ROLLBACK");
		} catch {}
		throw new Error("构建搜索索引失败: " + e.message);
	} finally {
		db.close();
	}
}
/** Split the group-message sender prefix (`wxid_xxx:\n`) into sender id + body. */
function splitGroupPrefix(text, username) {
	if (!username.endsWith("@chatroom")) return { sender: "", body: text };
	const m = text.match(/^[A-Za-z0-9_@.\-]{3,64}:\n/);
	return m ? { sender: m[0].slice(0, -2), body: text.slice(m[0].length) } : { sender: "", body: text };
}
/** Strip the group-message sender prefix (wxid_xxx:\n) from display text. */
function stripGroupPrefix(text, username) {
	return splitGroupPrefix(text, username).body;
}
/** 群内发送者的显示名（联系人表里有就用名字，否则退回 wxid）。 */
function senderLabel(sender, names) {
	if (!sender) return "";
	return names.get(sender) ?? sender;
}
/**
 * 从 appmsg / 系统消息的 XML 里抽出可读文本。
 * 微信把「转账、链接、文件、引用、系统提示」存成 <msg><appmsg><title><![CDATA[微信转账]]></title><des>…</des>
 * —— 不是纯文本。旧索引只收 local_type=1，于是「微信转账收到转账1500元」这类消息
 * 完全不在索引里，而它恰恰是「最近一次转账给我的是谁」的唯一答案（实测）。
 */
function readableMessageText(raw) {
	const t = String(raw || "").trim();
	if (!t) return "";
	if (!t.startsWith("<")) return t;
	const parts = [];
	for (const tag of ["title", "des", "content", "nickname", "username"]) {
		let from = 0;
		while (parts.length < 8) {
			const si = t.indexOf("<" + tag, from);
			if (si < 0) break;
			const gt = t.indexOf(">", si);
			if (gt < 0) break;
			const ei = t.indexOf("</" + tag, gt);
			if (ei < 0) break;
			let v = t.slice(gt + 1, ei).trim();
			const cdata = v.match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/);
			if (cdata) v = cdata[1];
			v = v.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
			if (v) parts.push(v);
			from = ei + 1;
		}
		if (parts.length >= 8) break;
	}
	return parts.join("  ").trim();
}
/** (分片|表名) → 该表是否存在。窗口展开会按会话反复查同一张表，缓存掉这个探测。 */
const windowTableCache = /* @__PURE__ */ new Map();
/**
 * 取某个会话在 centerMs 前后 spanMs 内的连续消息（对话窗口）。
 *
 * 为什么便宜：Msg_* 表上带 `(local_type, sort_seq)` 复合索引，窗口查询走
 * `SEARCH ... USING INDEX _TYPE_SEQ`，实测 0ms。这是 chunk 级检索可行的前提 ——
 * 单条消息「我没答应」本身无法回答「谁答应过什么」，必须带上前后的对话。
 */
function loadMessageWindow(decryptedDir, username, centerMs, spanMs, limit = 14) {
	if (!username || !Number.isFinite(centerMs) || centerMs <= 0) return [];
	const table = msgTableName$7(username);
	const lo = Math.max(0, Math.floor(centerMs - spanMs));
	const hi = Math.floor(centerMs + spanMs);
	const out = [];
	for (const shard of messageShardFiles$4(decryptedDir)) {
		const key = shard + "|" + table;
		let has = windowTableCache.get(key);
		if (has === void 0) {
			let probe = null;
			try {
				probe = new DatabaseSync(shard, { readOnly: true });
				has = probe.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table) !== void 0;
			} catch {
				has = false;
			} finally {
				try { probe?.close(); } catch {}
			}
			windowTableCache.set(key, has);
		}
		if (!has) continue;
		let sdb = null;
		try {
			sdb = new DatabaseSync(shard, { readOnly: true });
			const rows = sdb.prepare("SELECT local_id, sort_seq, create_time, message_content FROM \"" + table + "\" WHERE local_type=1 AND sort_seq BETWEEN ? AND ? ORDER BY sort_seq LIMIT ?").all(lo, hi, limit);
			for (const r of rows) {
				const raw = decodeCell$6(r["message_content"]).trim();
				if (!raw || raw.startsWith("<")) continue;
				const split = splitGroupPrefix(raw, username);
				const text = split.body.replace(/\s+/g, " ").trim();
				if (!text) continue;
				out.push({
					local_id: Number(r["local_id"] ?? 0),
					sort_seq: Number(r["sort_seq"] ?? 0),
					create_time: Number(r["create_time"] ?? 0),
					text,
					sender: split.sender
				});
			}
			if (out.length > 0) break;
		} catch {} finally {
			try { sdb?.close(); } catch {}
		}
	}
	return out;
}
/** Format a unix timestamp as YYYY-MM-DD HH:MM. */
function formatFullTime(ts) {
	if (!ts) return "";
	const d = /* @__PURE__ */ new Date(ts * 1e3);
	const p = (n) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
/**
* Search WeChat's own message_fts.db (message_fts_v4_* + ImgFts*) which
* covers text AND image messages, mapping session_id back through name2id.
* @returns hits (empty when the built-in index is absent/empty).
*/
function searchWechatFts(decryptedDir, q, cap, names, scopeUsername) {
	const p = join(decryptedDir, "message", "message_fts.db");
	if (!existsSync(p)) return { hits: [] };
	try {
		const db = new DatabaseSync(p, { readOnly: true });
		const sessions = /* @__PURE__ */ new Map();
		try {
			const rows = db.prepare("SELECT rowid AS id, username AS u FROM name2id").all();
			for (const r of rows) sessions.set(r.id, decodeCell$6(r.u));
		} catch {}
		const out = [];
		const like = "%" + q.replace(/[%_]/g, " ") + "%";
		for (const [content, aux] of [
			["message_fts_v4_0_content", "message_fts_v4_aux_0"],
			["message_fts_v4_1_content", "message_fts_v4_aux_1"],
			["message_fts_v4_2_content", "message_fts_v4_aux_2"],
			["message_fts_v4_3_content", "message_fts_v4_aux_3"]
		]) {
			try {
				if (!(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(content) !== void 0)) continue;
				const sql = "SELECT c.c0 AS c, a.message_local_id AS lid, a.sort_seq AS ss, a.session_id AS sid FROM \"" + content + "\" c LEFT JOIN \"" + aux + "\" a ON a.rowid = c.id WHERE c.c0 LIKE ? ORDER BY c.id DESC LIMIT ?";
				const rows = db.prepare(sql).all(like, cap);
				for (const r of rows) {
					const username = sessions.get(Number(r["sid"])) ?? "";
					// 会话范围必须真的过滤（此前兜底路径忽略 scope，选了会话仍混入其他会话）
					if (scopeUsername && username !== scopeUsername) continue;
					const text = decodeCell$6(r["c"]);
					const { sender, body: display } = splitGroupPrefix(text, username);
					// sort_seq 是毫秒时间戳：恢复 create_time，时间筛选与显示才可用（此前恒为 0，时间范围会把命中全部滤掉）
					const ssMs = Number(r["ss"] ?? 0);
					const createTime = ssMs > 1e12 ? Math.floor(ssMs / 1e3) : ssMs > 1e9 ? Math.floor(ssMs) : 0;
					out.push({
						text,
						username,
						create_time: createTime,
						local_id: Number(r["lid"] ?? 0),
						name: names.get(username) ?? username,
						time: createTime ? formatFullTime(createTime) : "",
						snippet: display.slice(0, 120),
						sender: senderLabel(sender, names)
					});
					if (out.length >= cap) break;
				}
			} catch {}
			if (out.length >= cap) break;
		}
		db.close();
		return { hits: out };
	} catch {
		return { hits: [] };
	}
}
/**
* Search text messages: FTS5 index first, bounded full-table scan fallback.
* @param decryptedDir - decrypted data root.
* @param query - search term.
* @param limit - max hits.
* @param username - optional scope: only search one talker (chatroom).
* @returns hits plus whether the index was used.
*/
function searchIndexMessages(decryptedDir, query, limit, username) {
	const q = (query || "").trim();
	if (!q) return {
		hits: [],
		total: 0,
		indexed: false
	};
	const cap = Math.min(limit ?? 100, 300);
	const names = loadDisplayNames(decryptedDir);
	// ---- 自建 BM25 索引优先（bigram 切分 + 真实 IDF + 相关度排序）----
	const indexedBatch = searchIndexBatch(decryptedDir, [q], cap, username ? { username } : void 0);
	if (indexedBatch.ranked && indexedBatch.hits.length > 0) return {
		hits: indexedBatch.hits,
		total: indexedBatch.hits.length,
		indexed: true
	};
	const builtin = searchWechatFts(decryptedDir, q, cap, names, username);
	if (builtin.hits.length > 0) return {
		hits: builtin.hits,
		total: builtin.hits.length,
		indexed: false
	};
	const hits = [];
	const qLower = q.toLowerCase();
	let budget = 8e5;
	const shards = messageShardFiles$4(decryptedDir);
	const scopeUsernames = username ? [username] : loadSessionUsernames$1(decryptedDir).slice(0, 800);
	for (const username of scopeUsernames) {
		if (hits.length >= cap || budget <= 0) break;
		const table = msgTableName$7(username);
		for (const shard of shards) {
			if (hits.length >= cap || budget <= 0) break;
			let sdb = null;
			try {
				sdb = new DatabaseSync(shard, { readOnly: true });
			} catch {
				continue;
			}
			if (!(sdb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table) !== void 0)) {
				sdb.close();
				continue;
			}
			try {
				const sql = "SELECT local_id, create_time, message_content FROM \"" + table + "\" WHERE local_type=1";
				const rows = sdb.prepare(sql).all();
				for (const r of rows) {
					budget -= 1;
					if (hits.length >= cap || budget <= 0) break;
					const localId = Number(r["local_id"] ?? 0);
					const ts = Number(r["create_time"] ?? 0);
					const text = decodeCell$6(r["message_content"]).replace(/\n/g, " ").trim();
					if (!text || !text.toLowerCase().includes(qLower)) continue;
					const { sender, body: display } = splitGroupPrefix(text, username);
					const dIdx = display.toLowerCase().indexOf(qLower);
					const dStart = Math.max(0, dIdx < 0 ? 0 : dIdx - 20);
					const snippet = (dStart > 0 ? "…" : "") + display.slice(dStart, dStart + 100);
					hits.push({
						text,
						username,
						create_time: ts,
						local_id: localId,
						name: names.get(username) ?? username,
						time: formatFullTime(ts),
						snippet,
						sender: senderLabel(sender, names)
					});
				}
			} catch {} finally {
				sdb.close();
			}
		}
	}
	return {
		hits,
		total: hits.length,
		indexed: false
	};
}
//#endregion
//#region lib/types/query/members.js
/**
* Member / contact search (成员搜索). Uses the local contact_fts index in
* wechat_search.db when available (built lazily on first use) and falls back to
* a LIKE scan over contact.db; room-scoped searches join chatroom_member.
*/
const CONTACT_FTS_META = "contact_rows";
/** Stringify an SQLite cell (TEXT/NUMBER/BLOB) to a string. */
function cellText$1(v) {
	if (v === null || v === void 0) return "";
	if (typeof v === "string") return v;
	if (v instanceof Uint8Array) return new TextDecoder("utf-8", { fatal: false }).decode(v);
	if (typeof v === "number" || typeof v === "boolean" || typeof v === "bigint" || typeof v === "symbol") return String(v);
	return "";
}
/** Whether a table exists in this database. */
function tableExists$1(db, table) {
	try {
		return db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table) !== void 0;
	} catch {
		return false;
	}
}
/** Map raw contact rows to member-search hits. */
function hitsFromRows(rows, roomName) {
	const out = [];
	for (const r of rows) {
		const username = cellText$1(r["username"]).trim();
		if (!username) continue;
		const hit = {
			username,
			name: cellText$1(r["remark"]).trim() || cellText$1(r["nick_name"]).trim() || username
		};
		const head = cellText$1(r["small_head_url"]).trim() || cellText$1(r["big_head_url"]).trim();
		if (head) hit.head = head;
		const room = cellText$1(r["room"]).trim();
		if (room) hit.roomUsername = room;
		if (roomName) hit.roomName = roomName;
		const sig = cellText$1(r["signature"]).trim();
		if (sig) hit.signature = sig;
		const region = cellText$1(r["region"]).trim();
		if (region) hit.region = region;
		out.push(hit);
	}
	return out;
}
/** Build (once) the local contact_fts index from contact.db. */
function ensureContactFts(db, decryptedDir) {
	db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
	db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS contact_fts USING fts5(name, username UNINDEXED, remark UNINDEXED, alias UNINDEXED, quanpin UNINDEXED, local_type UNINDEXED, tokenize='unicode61')");
	const row = db.prepare("SELECT value FROM meta WHERE key=?").get(CONTACT_FTS_META);
	if (row && Number(row.value ?? 0) > 0) return;
	const contactPath = join(decryptedDir, "contact", "contact.db");
	if (!existsSync(contactPath)) return;
	let cdb = null;
	try {
		cdb = new DatabaseSync(contactPath, { readOnly: true });
		if (!tableExists$1(cdb, "contact")) return;
		const rows = cdb.prepare("SELECT username, remark, nick_name, alias, quan_pin FROM contact").all();
		db.exec("BEGIN");
		try {
			const ins = db.prepare("INSERT INTO contact_fts(name, username, remark, alias, quanpin, local_type) VALUES(?, ?, ?, ?, ?, 0)");
			for (const r of rows) {
				const username = cellText$1(r["username"]).trim();
				if (!username) continue;
				ins.run(cellText$1(r["remark"]).trim() || cellText$1(r["nick_name"]).trim() || username, username, cellText$1(r["remark"]).trim(), cellText$1(r["alias"]).trim(), cellText$1(r["quan_pin"]).trim());
			}
			db.exec("COMMIT");
			db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES(?, ?)").run(CONTACT_FTS_META, String(rows.length));
		} catch {
			try {
				db.exec("ROLLBACK");
			} catch {}
		}
	} catch {} finally {
		try {
			cdb?.close();
		} catch {}
	}
}
/** Global search: prefer contact_fts, otherwise LIKE over contact.db. */
function searchGlobalMembers(decryptedDir, term, cap) {
	const p = searchIndexPath(decryptedDir);
	if (existsSync(p)) try {
		const db = new DatabaseSync(p);
		try {
			ensureContactFts(db, decryptedDir);
			const escaped = "\"" + term.replace(/"/g, "\"\"") + "\"";
			const rows = db.prepare("SELECT name, username, remark, alias FROM contact_fts WHERE contact_fts MATCH ? ORDER BY rank LIMIT ?").all(escaped, cap * 4);
			if (rows.length > 0) {
				const items = [];
				const cdbPath = join(decryptedDir, "contact", "contact.db");
				let cdb = null;
				try {
					cdb = new DatabaseSync(cdbPath, { readOnly: true });
				} catch {
					cdb = null;
				}
				const headStmt = cdb && tableExists$1(cdb, "contact") ? cdb.prepare("SELECT small_head_url, big_head_url FROM contact WHERE username=?") : null;
				for (const r of rows) {
					const username = cellText$1(r["username"]).trim();
					if (!username) continue;
					const hit = {
						username,
						name: cellText$1(r["name"]).trim() || username
					};
					if (headStmt) try {
						const hr = headStmt.get(username);
						const head = cellText$1(hr?.small_head_url ?? "").trim() || cellText$1(hr?.big_head_url ?? "").trim();
						if (head) hit.head = head;
					} catch {}
					items.push(hit);
				}
				try {
					cdb?.close();
				} catch {}
				return {
					items: items.slice(0, cap),
					total: items.length,
					source: "fts"
				};
			}
		} finally {
			db.close();
		}
	} catch {}
	return searchGlobalLike(decryptedDir, term, cap);
}
/** LIKE fallback over contact.db (remark / nick / username / alias / quan_pin). */
function searchGlobalLike(decryptedDir, term, cap) {
	const p = join(decryptedDir, "contact", "contact.db");
	if (!existsSync(p)) return {
		items: [],
		total: 0,
		source: "like"
	};
	try {
		const db = new DatabaseSync(p, { readOnly: true });
		try {
			if (!tableExists$1(db, "contact")) return {
				items: [],
				total: 0,
				source: "like"
			};
			const like = "%" + term + "%";
			const rows = db.prepare("SELECT username, remark, nick_name, alias, small_head_url, big_head_url FROM contact WHERE remark LIKE ? OR nick_name LIKE ? OR username LIKE ? OR alias LIKE ? OR quan_pin LIKE ? ORDER BY remark, nick_name LIMIT ?").all(like, like, like, like, like, cap);
			return {
				items: hitsFromRows(rows),
				total: rows.length,
				source: "like"
			};
		} finally {
			db.close();
		}
	} catch {
		return {
			items: [],
			total: 0,
			source: "like"
		};
	}
}
/** Room-scoped search: chatroom_member join contact + chat room display name. */
function searchRoomMembers(decryptedDir, roomUsername, term, cap) {
	const p = join(decryptedDir, "contact", "contact.db");
	if (!existsSync(p)) return {
		items: [],
		total: 0,
		source: "like"
	};
	try {
		const db = new DatabaseSync(p, { readOnly: true });
		try {
			if (!tableExists$1(db, "chat_room") || !tableExists$1(db, "chatroom_member") || !tableExists$1(db, "contact")) return {
				items: [],
				total: 0,
				source: "like"
			};
			const room = db.prepare("SELECT id FROM chat_room WHERE username=?").get(roomUsername);
			if (room?.id === void 0) return {
				items: [],
				total: 0,
				source: "like"
			};
			const display = db.prepare("SELECT nick_name, remark FROM contact WHERE username=?").get(roomUsername);
			const roomName = (display ? cellText$1(display.remark).trim() || cellText$1(display.nick_name).trim() : "") || roomUsername;
			const like = "%" + term + "%";
			// 第 96 轮：补上别名与备注全拼（原缺 quan_pin/alias，群内按备注全拼搜不到人；见 src/query/members.ts）
			const rows = db.prepare("SELECT c.username, c.remark, c.nick_name, c.small_head_url, c.big_head_url, cr.username AS room FROM chatroom_member m JOIN contact c ON c.id=m.member_id JOIN chat_room cr ON cr.id=m.room_id WHERE m.room_id=? AND (c.remark LIKE ? OR c.nick_name LIKE ? OR c.username LIKE ? OR c.alias LIKE ? OR c.quan_pin LIKE ?) ORDER BY c.remark, c.nick_name LIMIT ?").all(room.id, like, like, like, like, like, cap);
			return {
				items: hitsFromRows(rows, roomName),
				total: rows.length,
				source: "like"
			};
		} finally {
			db.close();
		}
	} catch {
		return {
			items: [],
			total: 0,
			source: "like"
		};
	}
}
/**
* Search contacts / group members.
* @param decryptedDir - decrypted data root.
* @param q - search term (name/remark/username/alias/pinyin).
* @param opts - optional limit and room scope (roomUsername).
* @returns matching members + total + source.
*/
function searchMembers(decryptedDir, q, opts) {
	const term = q.trim();
	if (!term) return {
		items: [],
		total: 0,
		source: "like"
	};
	const cap = Math.min(opts?.limit ?? 50, 200);
	if (opts?.roomUsername) return searchRoomMembers(decryptedDir, opts.roomUsername, term, cap);
	return searchGlobalMembers(decryptedDir, term, cap);
}
//#endregion
//#region lib/types/query/media-image.js
/**
* WeChat image resolution and decoding, rewritten from st_control image.rs
* (image/{crypto,resolve}.rs). Chain: (username, local_id) -> image MD5 from
* the message shards (packed_info_data protobuf) or message_resource.db, then
* a pre-decoded image in decoded_images/<username>/<md5>.<ext>, then raw .dat
* XOR / V1 / V2 decoding. Returns a base64 data URL for the browser.
* wxgf/HEVC images are reported as hevc-unsupported (needs a system decoder).
*/
const V2_MAGIC$1 = [
	7,
	8,
	86,
	50
];
const V1_MAGIC_FULL = [
	7,
	8,
	86,
	49,
	8,
	7
];
const V2_MAGIC_FULL = [
	7,
	8,
	86,
	50,
	8,
	7
];
const V1_AES_KEY = new TextEncoder().encode("cfcd208495d565ef");
const IMAGE_MAGIC = [
	["png", [
		137,
		80,
		78,
		71
	]],
	["gif", [
		71,
		73,
		70,
		56
	]],
	["tif", [
		73,
		73,
		42,
		0
	]],
	["webp", [
		82,
		73,
		70,
		70
	]],
	["jpg", [
		255,
		216,
		255
	]]
];
/** Msg_<md5(username)> table name for a talker. */
function msgTableName$6(username) {
	return "Msg_" + createHash("md5").update(username, "utf8").digest("hex");
}
/** Convert a comma-separated decimal byte list (st_control BLOB text form) to bytes. */
function commaBytesToBytes(text) {
	const parts = text.split(",").map((n) => parseInt(n, 10));
	if (parts.length === 0 || parts.some((n) => Number.isNaN(n))) return null;
	return Uint8Array.from(parts);
}
/**
* Extract the 32-char hex image MD5 from a packed_info protobuf value.
* Accepts a raw BLOB, or the st_control comma-separated byte-list TEXT form.
* @param value - packed_info cell value (BLOB or comma-separated byte-list TEXT).
* @returns the 32-char hex image MD5, or null when none is found.
*/
function extractMd5FromPacked(value) {
	let bytes = null;
	if (value instanceof Uint8Array) bytes = value;
	else if (typeof value === "string" && value) if (value.includes(",")) bytes = commaBytesToBytes(value);
	else {
		const m = value.match(/[0-9a-f]{32}/);
		return m ? m[0] : null;
	}
	if (!bytes) return null;
	const buf = bytes;
	const marker = [
		18,
		34,
		10,
		32
	];
	for (let i = 0; i + marker.length + 32 <= buf.length; i += 1) if (marker.every((b, j) => buf[i + j] === b)) {
		const s = String.fromCharCode(...buf.slice(i + marker.length, i + marker.length + 32));
		if (/^[0-9a-f]{32}$/.test(s)) return s;
	}
	for (let i = 0; i + 34 <= buf.length; i += 1) if (buf[i] === 34 && buf[i + 1] === 32) {
		const s = String.fromCharCode(...buf.slice(i + 2, i + 34));
		if (/^[0-9a-f]{32}$/.test(s)) return s;
	}
	let s = "";
	for (let i = 0; i < buf.length; i += 1) {
		const c = String.fromCharCode(buf[i] ?? 0);
		if (/[0-9a-f]/i.test(c)) {
			s += c;
			if (s.length === 32) return s.toLowerCase();
		} else s = "";
	}
	return null;
}
/**
* Resolve image MD5 + MessageResourceDetail.data_index for (username, local_id):
* message shard packed_info_data first, then message_resource.db
* (ChatName2Id -> MessageResourceInfo -> MessageResourceDetail).
* @param decryptedDir - decrypted data root.
* @param username - conversation username.
* @param localId - message local id.
* @returns the 32-char hex image MD5 (or null) and the detail data_index hint.
*/
function resolveImageResourceHint(decryptedDir, username, localId) {
	const table = msgTableName$6(username);
	for (const shard of shardCatalogDirs(decryptedDir, ["message"])) {
		const tableMeta = shard.tables.get(table);
		if (!tableMeta) continue;
		let db = null;
		try {
			db = new DatabaseSync(shard.file, { readOnly: true });
		} catch {
			continue;
		}
		try {
			const packed = [...tableMeta.cols].find((c) => c.toLowerCase().includes("packed"));
			if (packed) try {
				const row = db.prepare("SELECT \"" + packed + "\" AS p FROM \"" + table + "\" WHERE local_id = ? AND (local_type = 3 OR local_type % 4294967296 = 3) LIMIT 1").get(localId);
				if (row) {
					const md5 = extractMd5FromPacked(row.p);
					if (md5) return {
						md5,
						dataIndex: ""
					};
				}
			} catch {}
		} finally {
			db.close();
		}
	}
	let dataIndex = "";
	const resDb = join(decryptedDir, "message", "message_resource.db");
	if (existsSync(resDb)) try {
		const db = new DatabaseSync(resDb, { readOnly: true });
		const chat = db.prepare("SELECT rowid FROM ChatName2Id WHERE user_name = ?").get(username);
		if (chat) {
			const info = db.prepare("SELECT message_id, packed_info AS p FROM MessageResourceInfo WHERE chat_id = ? AND message_local_id = ? AND (message_local_type = 3 OR message_local_type % 4294967296 = 3) ORDER BY message_create_time DESC LIMIT 1").get(chat.rowid, localId);
			if (info) {
				const md5 = extractMd5FromPacked(info.p);
				if (md5) {
					db.close();
					return {
						md5,
						dataIndex: ""
					};
				}
				if (info.message_id !== void 0) {
					const details = db.prepare("SELECT packed_info AS p, data_index AS di FROM MessageResourceDetail WHERE message_id = ? ORDER BY resource_id DESC LIMIT 20").all(info.message_id);
					for (const d of details) {
						const dm = extractMd5FromPacked(d.p);
						if (dm) {
							db.close();
							return {
								md5: dm,
								dataIndex: dataIndexOf(d.di)
							};
						}
						const di = dataIndexOf(d.di);
						if (di && !dataIndex) dataIndex = di;
					}
				}
			}
		}
		db.close();
	} catch {}
	return {
		md5: null,
		dataIndex
	};
}
/** Normalize a MessageResourceDetail.data_index cell to a non-empty string. */
function dataIndexOf(v) {
	if (v === null || v === void 0) return "";
	if (typeof v === "string") return v.trim();
	if (v instanceof Uint8Array) return new TextDecoder("utf-8", { fatal: false }).decode(v).trim();
	if (typeof v === "number" || typeof v === "boolean" || typeof v === "bigint") return String(v).trim();
	return "";
}
/**
* Detect an image format from a decrypted header.
* @param header - leading bytes of the (decrypted) image.
* @returns the format name ('png' / 'jpg' / 'gif' / ...), or 'bin' when unknown.
*/
function detectImageFormat$1(header) {
	for (const [fmt, magic] of IMAGE_MAGIC) if (header.length >= magic.length && magic.every((b, i) => header[i] === b)) return fmt;
	if (header.length >= 2 && header[0] === 66 && header[1] === 77) return "bmp";
	return "bin";
}
/**
* Detect a single-byte XOR key by matching image magic bytes.
* @param data - raw .dat bytes.
* @returns the XOR key byte, or null when no magic matches.
*/
function detectXorKey(data) {
	if (data.length < 4) return null;
	if ((data[0] ?? 0) === V2_MAGIC$1[0] && (data[1] ?? 0) === V2_MAGIC$1[1] && (data[2] ?? 0) === V2_MAGIC$1[2] && (data[3] ?? 0) === V2_MAGIC$1[3]) return null;
	for (const [, magic] of IMAGE_MAGIC) {
		const key = (data[0] ?? 0) ^ (magic[0] ?? 0);
		let ok = true;
		for (let i = 0; i < magic.length && i < data.length; i += 1) if (((data[i] ?? 0) ^ key) !== (magic[i] ?? 0)) {
			ok = false;
			break;
		}
		if (ok) return key;
	}
	return null;
}
/** AES-128-ECB decrypt (no padding). */
function aes128EcbDecrypt(key, data) {
	if (key.length < 16) throw new Error("AES key 长度不足 16 字节");
	const decipher = createDecipheriv("aes-128-ecb", Buffer.from(key), null);
	decipher.setAutoPadding(false);
	const out = Buffer.concat([decipher.update(Buffer.from(data)), decipher.final()]);
	return new Uint8Array(out);
}
/** Strip PKCS7 padding (defensive). */
function pkcs7Unpad(data) {
	if (data.length === 0) return data;
	const pad = data[data.length - 1] ?? 0;
	if (pad === 0 || pad > 16 || pad > data.length) return data;
	if (data.slice(data.length - pad).every((b) => b === pad)) return data.slice(0, data.length - pad);
	return data;
}
/** PKCS7 aligned block size. */
function alignedAesBlockSize(aesSize) {
	return aesSize % 16 === 0 ? aesSize + 16 : aesSize + (16 - aesSize % 16);
}
/**
* Decode raw .dat bytes (XOR / V1 / V2).
* @param data - raw .dat file bytes.
* @param aesKey - V2 AES key (raw bytes), optional.
* @param xorKey - XOR key byte for the XOR tail.
* @returns decrypted bytes + format, or an error description.
*/
function decodeDatBytes(data, aesKey, xorKey) {
	if (data.length < 6) return { error: "文件太小" };
	const sig = Array.from(data.slice(0, 6));
	const isV2 = sig.every((b, i) => b === V2_MAGIC_FULL[i]);
	const isV1 = sig.every((b, i) => b === V1_MAGIC_FULL[i]);
	let decrypted;
	if (isV2 || isV1) {
		const rawKey = typeof aesKey === "string" && aesKey.length > 0 ? Buffer.from(aesKey, "ascii") : aesKey;
		const key = isV1 ? V1_AES_KEY : rawKey instanceof Uint8Array ? rawKey : null;
		if (!key) return { error: "V2 格式需要 AES key" };
		if (key.length < 16) return { error: "AES key 长度不足 16 字节" };
		if (data.length < 15) return { error: "V2 文件头不完整" };
		const aesSize = (data[6] ?? 0) | (data[7] ?? 0) << 8 | (data[8] ?? 0) << 16 | (data[9] ?? 0) << 24;
		const xorSize = (data[10] ?? 0) | (data[11] ?? 0) << 8 | (data[12] ?? 0) << 16 | (data[13] ?? 0) << 24;
		const aligned = alignedAesBlockSize(aesSize);
		let offset = 15;
		if (offset + aligned > data.length) return { error: "数据不足 AES 块" };
		const decAes = pkcs7Unpad(aes128EcbDecrypt(key, data.slice(offset, offset + aligned)));
		offset += aligned;
		const rawEnd = data.length - xorSize;
		const raw = offset < rawEnd ? data.slice(offset, Math.max(offset, rawEnd)) : new Uint8Array(0);
		offset = Math.max(offset, rawEnd);
		const xorPart = data.slice(offset).map((b) => b ^ xorKey);
		const out = new Uint8Array(decAes.length + raw.length + xorPart.length);
		out.set(decAes, 0);
		out.set(raw, decAes.length);
		out.set(xorPart, decAes.length + raw.length);
		decrypted = out;
	} else {
		const key = detectXorKey(data);
		if (key === null) return { error: "无法检测 XOR key" };
		decrypted = data.map((b) => b ^ key);
	}
	if (decrypted.length >= 4 && decrypted[0] === 119 && decrypted[1] === 120 && decrypted[2] === 103 && decrypted[3] === 102) return {
		bytes: decrypted,
		format: "hevc"
	};
	const fmt = detectImageFormat$1(decrypted.length > 16 ? decrypted.slice(0, 16) : decrypted);
	if (fmt === "bin") return { error: "解密后无法识别图片格式 (可能是密钥错误)" };
	return {
		bytes: decrypted,
		format: fmt
	};
}
/** Decode bytes to a base64 data URL for a renderable format. */
function toDataUrl(format, bytes) {
	return "data:image/" + (format === "jpg" ? "jpeg" : format) + ";base64," + Buffer.from(bytes).toString("base64");
}
/** Renderable image extensions (decoded cache). */
const RENDERABLE_EXTS = [
	"jpg",
	"jpeg",
	"png",
	"gif",
	"webp",
	"bmp",
	"tif"
];
/**
* Resolve and decode a message image to a base64 data URL.
* @param decryptedDir - decrypted data root.
* @param decodedDir - decoded image cache root (data/wechat/decoded_images).
* @param username - conversation username.
* @param localId - message local id.
* @param wechatBaseDir - optional raw WeChat install dir for .dat fallback.
* @param aesKey - optional V2 AES key (16-char ASCII string or raw bytes).
* @param xorKey - XOR key byte, defaults to 0xFF.
* @returns data URL + format, or an error description.
*/
function decodeImageDataUrl(decryptedDir, decodedDir, username, localId, wechatBaseDir, aesKey, xorKey) {
	const hint = resolveImageResourceHint(decryptedDir, username, localId);
	const md5 = hint.md5;
	if (!md5 && !hint.dataIndex) return { error: "无法找到图片 MD5" };
	if (md5) for (const ext of RENDERABLE_EXTS) {
		const p = join(decodedDir, md5 + "." + ext);
		if (existsSync(p)) try {
			const bytes = readFileSync(p);
			return {
				url: toDataUrl(ext === "jpeg" ? "jpg" : ext, new Uint8Array(bytes)),
				format: ext === "jpeg" ? "jpg" : ext
			};
		} catch (e) {
			return { error: "读取已解码图片失败: " + e.message };
		}
	}
	if (md5) {
		const userDir = join(decodedDir, username);
		if (existsSync(userDir)) {
			for (const ext of RENDERABLE_EXTS) {
				const p = join(userDir, md5 + "." + ext);
				if (existsSync(p)) try {
					const bytes = readFileSync(p);
					return {
						url: toDataUrl(ext === "jpeg" ? "jpg" : ext, new Uint8Array(bytes)),
						format: ext === "jpeg" ? "jpg" : ext
					};
				} catch (e) {
					return { error: "读取已解码图片失败: " + e.message };
				}
			}
			if (existsSync(join(userDir, md5 + ".hevc"))) return { error: "hevc-unsupported" };
		}
	}
	if (wechatBaseDir && md5) {
		const dats = findDatFiles(join(wechatBaseDir, "msg", "attach", msgTableName$6(username).replace(/^Msg_/, "")), md5);
		if (dats.length > 0) {
			const aesBytes = typeof aesKey === "string" && aesKey.length > 0 ? Buffer.from(aesKey, "ascii") : aesKey ?? null;
			const ordered = [...dats].sort((a, b) => scoreDatPath$1(a) - scoreDatPath$1(b));
			for (const f of ordered) try {
				const bytes = readFileSync(f);
				const dec = decodeDatBytes(new Uint8Array(bytes), aesBytes, xorKey ?? 255);
				if ("error" in dec) continue;
				if (dec.format === "hevc") continue;
				try {
					writeDecodedCache(decodedDir, username, md5, dec.format, dec.bytes);
				} catch {}
				return {
					url: toDataUrl(dec.format, dec.bytes),
					format: dec.format
				};
			} catch {}
			return { error: "hevc-unsupported" };
		}
	}
	if (wechatBaseDir) {
		const hd = resolveImageFilePath(decryptedDir, wechatBaseDir, md5 ?? "", hint.dataIndex);
		if (hd) {
			const aesBytes = typeof aesKey === "string" && aesKey.length > 0 ? Buffer.from(aesKey, "ascii") : aesKey ?? null;
			try {
				const bytes = readFileSync(hd);
				const dec = decodeDatBytes(new Uint8Array(bytes), aesBytes, xorKey ?? 255);
				if (!("error" in dec) && dec.format !== "hevc") {
					try {
						writeDecodedCache(decodedDir, username, md5 || "data-" + hint.dataIndex, dec.format, dec.bytes);
					} catch {}
					return {
						url: toDataUrl(dec.format, dec.bytes),
						format: dec.format
					};
				}
			} catch {}
		}
	}
	return { error: md5 ? "找不到 .dat 文件 (MD5=" + md5 + ")" : "无法定位图片文件 (data_index=" + hint.dataIndex + ")" };
}
function decodeFileImageDataUrl(decryptedDir, decodedDir, wechatBaseDir, md5, aesKey, xorKey = 255) {
	const m = (md5 ?? "").trim().toLowerCase();
	if (!/^[0-9a-f]{32}$/.test(m)) return { error: "缺少图片 MD5" };
	for (const ext of ["jpg"]) {
		const p = join(decodedDir, m + "." + ext);
		if (existsSync(p)) {
			try {
				const bytes = readFileSync(p);
				return { url: toDataUrl(ext === "jpeg" ? "jpg" : ext, new Uint8Array(bytes)) };
			} catch (e) {
				return { error: "读取已解码图片失败: " + e.message };
			}
		}
	}
	return { error: "未找到已解密图片（decoded_images/" + m + ".jpg 不存在）" };
}

/**
 * Resolve a custom emoticon (sticker) md5 to a base64 data URL.
 * Prefer decoded_images cache, then scan msg/attach for <md5>.dat / _t.dat.
 */
function decodeEmoticonDataUrl(decryptedDir, decodedDir, wechatBaseDir, md5, aesKey, xorKey = 255) {
	const m = (md5 ?? "").trim().toLowerCase();
	if (!/^[0-9a-f]{32}$/.test(m)) return { error: "缺少表情 MD5" };
	for (const ext of RENDERABLE_EXTS) {
		const pth = join(decodedDir, m + "." + ext);
		if (existsSync(pth)) {
			try {
				const bytes = readFileSync(pth);
				return { url: toDataUrl(ext === "jpeg" ? "jpg" : ext, new Uint8Array(bytes)), format: ext === "jpeg" ? "jpg" : ext };
			} catch (e) {
				return { error: "读取已解码表情失败: " + e?.message };
			}
		}
	}
	if (!wechatBaseDir) return { error: "表情未缓存且缺少原始微信目录" };
	const attachRoot = join(wechatBaseDir, "msg", "attach");
	if (!existsSync(attachRoot)) return { error: "表情未缓存且找不到 msg/attach" };
	const dats = [];
	const walk = (dir, depth) => {
		if (depth > 4 || dats.length > 8) return;
		let entries = [];
		try {
			entries = readdirSync(dir, { withFileTypes: true }).map((e) => ({ name: e.name, isDir: e.isDirectory() }));
		} catch {
			return;
		}
		for (const e of entries) {
			if (dats.length > 8) return;
			const fp = join(dir, e.name);
			if (e.isDir) walk(fp, depth + 1);
			else if (e.name === m + "_t.dat" || e.name === m + ".dat") dats.push(fp);
		}
	};
	walk(attachRoot, 0);
	if (dats.length === 0) return { error: "未找到表情文件 (MD5=" + m + ")" };
	const aesBytes = typeof aesKey === "string" && aesKey.length > 0 ? Buffer.from(aesKey, "ascii") : aesKey ?? null;
	const ordered = [...dats].sort((a, b) => scoreDatPath$1(a) - scoreDatPath$1(b));
	for (const f of ordered) {
		try {
			const bytes = readFileSync(f);
			const dec = decodeDatBytes(new Uint8Array(bytes), aesBytes, xorKey);
			if ("error" in dec) continue;
			if (dec.format === "hevc") continue;
			try {
				writeFileSync(join(decodedDir, m + "." + dec.format), Buffer.from(dec.bytes));
			} catch {}
			return { url: toDataUrl(dec.format, dec.bytes), format: dec.format };
		} catch {}
	}
	return { error: "表情文件无法解码为浏览器可渲染格式" };
}

/** Prefer originals over thumbnails: 0 = .dat, 1 = _h.dat, 2 = _t.dat. */
function scoreDatPath$1(p) {
	if (p.endsWith("_t.dat")) return 2;
	if (p.endsWith("_h.dat")) return 1;
	return 0;
}
/** Write a decoded image into the cache so later lookups hit instantly. */
function writeDecodedCache(decodedDir, username, md5, format, bytes) {
	const dir = join(decodedDir, username);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, md5 + "." + format), Buffer.from(bytes));
}
/** Recursively find .dat files whose name starts with the image MD5. */
function findDatFiles(attachRoot, fileMd5) {
	const out = [];
	const walk = (dir) => {
		if (!existsSync(dir)) return;
		let entries = [];
		try {
			entries = readdirSync(dir, { withFileTypes: true }).map((e) => ({
				name: e.name,
				isDir: e.isDirectory()
			}));
		} catch {
			return;
		}
		for (const e of entries) {
			const p = join(dir, e.name);
			if (e.isDir) walk(p);
			else if (e.name.startsWith(fileMd5) && e.name.endsWith(".dat")) out.push(p);
		}
	};
	walk(attachRoot);
	return out;
}
/** Stringify an SQLite cell (TEXT/NUMBER/BLOB) to a string. */
function cellText(v) {
	if (v === null || v === void 0) return "";
	if (typeof v === "string") return v;
	if (v instanceof Uint8Array) return new TextDecoder("utf-8", { fatal: false }).decode(v);
	if (typeof v === "number" || typeof v === "boolean" || typeof v === "bigint" || typeof v === "symbol") return String(v);
	return "";
}
/** Read dir2id (rowid → directory name) from the decrypted hardlink.db. */
function readDir2id(db) {
	const map = /* @__PURE__ */ new Map();
	const rows = db.prepare("SELECT rowid, username FROM dir2id").all();
	for (const r of rows) map.set(r.rowid, cellText(r.username).trim());
	return map;
}
/** Candidate disk paths for a hardlink image file (mirrors ST candidate_paths). */
function imageCandidatePaths(baseDir, file, n1, n2) {
	const out = [];
	const push = (p) => {
		if (!out.includes(p)) out.push(p);
	};
	const pairs = [[n1, n2], [n2, n1]];
	for (const [a, b] of pairs) {
		push(join(baseDir, "msg", "attach", a, b, "Img", file));
		push(join(baseDir, "msg", "attach", a, b, file));
	}
	push(join(baseDir, "msg", "attach", n1, "Img", file));
	push(join(baseDir, "msg", "attach", n1, file));
	push(join(baseDir, "msg", "attach", n2, file));
	return out;
}
/**
* Resolve an image's on-disk .dat path via the decrypted hardlink.db:
* image_hardlink_info_v4 is queried by md5 (and by MessageResourceDetail
* data_index rowid when given), then dir1/dir2 are mapped through dir2id to
* the real msg/attach directory names. Returns the first existing path.
* @param decryptedDir - decrypted data root.
* @param wechatBaseDir - raw WeChat install dir (current account root).
* @param md5 - 32-char image md5 (optional when dataIndex is given).
* @param dataIndex - MessageResourceDetail.data_index (rowid hint, optional).
* @returns absolute .dat path, or null when not resolvable.
*/
function resolveImageFilePath(decryptedDir, wechatBaseDir, md5, dataIndex) {
	const dbPath = join(decryptedDir, "hardlink", "hardlink.db");
	if (!existsSync(dbPath)) return null;
	let db = null;
	try {
		db = new DatabaseSync(dbPath, { readOnly: true });
	} catch {
		return null;
	}
	try {
		const dirs = readDir2id(db);
		const rows = [];
		const md5l = (md5 ?? "").trim().toLowerCase();
		const di = (dataIndex ?? "").trim();
		if (md5l.length === 32) {
			const byMd5 = db.prepare("SELECT file_name, dir1, dir2 FROM image_hardlink_info_v4 WHERE lower(md5) = ? ORDER BY modify_time DESC LIMIT 8").all(md5l);
			rows.push(...byMd5);
		}
		if (di && /^\d+$/.test(di)) {
			const byRow = db.prepare("SELECT file_name, dir1, dir2 FROM image_hardlink_info_v4 WHERE _rowid_ = ? LIMIT 1").all(Number(di));
			rows.push(...byRow);
		}
		for (const r of rows) {
			const file = cellText(r.file_name).trim();
			if (!file || !file.endsWith(".dat")) continue;
			const n1 = dirs.get(r.dir1) ?? "";
			const n2 = dirs.get(r.dir2) ?? "";
			for (const p of imageCandidatePaths(wechatBaseDir, file, n1, n2)) if (existsSync(p)) return p;
		}
	} catch {} finally {
		try {
			db.close();
		} catch {}
	}
	return null;
}
//#endregion
//#region lib/types/query/sns-image.js
/**
* SNS (朋友圈) offline image resolution: scans WeChat's cache/<month>/Sns/Img
* directories for V2-encrypted image blobs, decrypts them with the image AES
* key and matches the plaintext MD5 against the media md5 from the moments XML.
*/
const md5UrlCache = /* @__PURE__ */ new Map();
/**
 * 按月增量的明文 md5 索引（第 40 轮改造）。
 * 旧实现整树重建：任一月份目录签名变化就解密全部 80 个月 / 15,220 个文件（~1.2 GB），
 * 实测单次 12–20 秒且发生在同步请求内。新实现按月份单独缓存、只重扫签名变化的月份，
 * 扫描顺序由新到旧并**命中即停**；全部月份按当前签名扫完仍未命中即「确实没有」。
 */
const snsImageIndex = /* @__PURE__ */ new Map();
/** 列出 cache/<月>/Sns/Img 根目录及其签名，按月份由新到旧。 */
function snsMonthRoots(wechatBaseDir) {
	const cacheRoot = join(wechatBaseDir, "cache");
	const out = [];
	if (!existsSync(cacheRoot)) return out;
	let months = [];
	try {
		months = readdirSync(cacheRoot);
	} catch {
		return out;
	}
	for (const month of months.sort().reverse()) {
		const root = join(cacheRoot, month, "Sns", "Img");
		if (!existsSync(root)) continue;
		try {
			const st = statSync(root);
			out.push({ month, root, mtimeMs: st.mtimeMs, size: st.size });
		} catch {}
	}
	return out;
}
/** 扫描一个月份目录，得到「明文 md5 → 文件路径」。 */
function scanSnsMonth(root, aesKey, xorKey) {
	const byMd5 = /* @__PURE__ */ new Map();
	const files = [];
	walkFiles$1(root, files, 0);
	for (const f of files) try {
		const dec = decodeDatBytes(new Uint8Array(readFileSync(f)), aesKey ?? null, xorKey);
		if ("error" in dec) continue;
		const key = md5Of(dec.bytes);
		if (!byMd5.has(key)) byMd5.set(key, f);
	} catch {}
	return byMd5;
}
/** 按月增量查找 wantMd5，命中即停。 */
function snsResolveByIndex(wechatBaseDir, aesKey, xorKey, wantMd5) {
	const roots = snsMonthRoots(wechatBaseDir);
	let idx = snsImageIndex.get(wechatBaseDir);
	if (!idx) {
		idx = { months: /* @__PURE__ */ new Map(), misses: /* @__PURE__ */ new Set() };
		snsImageIndex.set(wechatBaseDir, idx);
	}
	const live = new Set(roots.map((r) => r.month));
	for (const m of [...idx.months.keys()]) if (!live.has(m)) idx.months.delete(m);
	for (const { month, root, mtimeMs, size } of roots) {
		const cached = idx.months.get(month);
		if (cached && cached.mtimeMs === mtimeMs && cached.size === size) {
			const hit2 = cached.byMd5.get(wantMd5);
			if (hit2) return { file: hit2, complete: false };
			continue;
		}
		const byMd5 = scanSnsMonth(root, aesKey, xorKey);
		idx.months.set(month, { mtimeMs, size, byMd5 });
		idx.misses.clear();
		const hit = byMd5.get(wantMd5);
		if (hit) return { file: hit, complete: false };
	}
	return { complete: true };
}
function md5Of(bytes) {
	return createHash("md5").update(Buffer.from(bytes)).digest("hex");
}
function walkFiles$1(dir, out, depth) {
	if (depth > 5 || !existsSync(dir)) return;
	let entries = [];
	try {
		entries = readdirSync(dir, { withFileTypes: true }).map((e) => ({
			name: e.name,
			isDir: e.isDirectory()
		}));
	} catch {
		return;
	}
	for (const e of entries) {
		const p = join(dir, e.name);
		if (e.isDir) walkFiles$1(p, out, depth + 1);
		else if (!e.name.endsWith(".db") && !e.name.includes("_shm") && !e.name.includes("_wal")) out.push(p);
	}
}
/**
* Resolve one SNS media md5 to an offline base64 data URL.
* @param wechatBaseDir - raw WeChat install dir (current account root).
* @param aesKey - image AES key (16-char ASCII string), optional.
* @param xorKey - XOR key byte.
* @param md5 - 32-char media md5 from the moments XML.
* @returns data URL or an error description.
*/
function dataUrlOf$1(dec) {
	return "data:image/" + (dec.format === "jpg" ? "jpeg" : dec.format) + ";base64," + Buffer.from(dec.bytes).toString("base64");
}
/** Decode one cache file; returns data URL or null. */
function decodeCachedFile(f, aesKey, xorKey) {
	try {
		const bytes = readFileSync(f);
		const dec = decodeDatBytes(new Uint8Array(bytes), aesKey ?? null, xorKey);
		if ("error" in dec) return null;
		return dataUrlOf$1(dec);
	} catch {
		return null;
	}
}
/** Gather cache/<month>/Sns/Img roots. */
function snsImgRoots(wechatBaseDir) {
	const cacheRoot = join(wechatBaseDir, "cache");
	const out = [];
	if (!existsSync(cacheRoot)) return out;
	try {
		for (const e of readdirSync(cacheRoot, { withFileTypes: true })) {
			if (!e.isDirectory()) continue;
			const root = join(cacheRoot, e.name, "Sns", "Img");
			if (existsSync(root)) out.push(root);
		}
	} catch {}
	return out;
}
function resolveSnsImageDataUrl(wechatBaseDir, aesKey, xorKey, md5, timelineId, mediaId) {
	const key = (md5 || "").trim().toLowerCase();
	const cacheKey = timelineId && mediaId ? createHash("md5").update(timelineId + "_" + mediaId + "_2", "utf8").digest("hex") : key;
	if (!cacheKey) return { error: "缺少图片标识" };
	if (md5UrlCache.has(cacheKey)) {
		const cached = md5UrlCache.get(cacheKey) ?? "";
		if (cached) return { url: cached };
	}
	if (!wechatBaseDir) return { error: "未配置微信原始目录，无法离线解码" };
	if (timelineId && mediaId) for (const suffix of [
		"_2",
		"_1",
		"_0",
		""
	]) {
		const k = createHash("md5").update(timelineId + "_" + mediaId + suffix, "utf8").digest("hex");
		const sub = k.slice(0, 2);
		const rest = k.slice(2);
		for (const root of snsImgRoots(wechatBaseDir)) {
			const p = join(root, sub, rest);
			if (existsSync(p)) {
				const data = decodeCachedFile(p, aesKey, xorKey);
				if (data) {
					boundedSet(md5UrlCache, cacheKey, data);
					return { url: data };
				}
			}
		}
	}
	if (!key) return { error: "未找到匹配的本地 SNS 图片" };
	// 索引优先：按月增量、命中即停。旧实现在未命中后还会把同一批文件再全量扫一遍（双倍开销），已删除。
	const idxRes = snsResolveByIndex(wechatBaseDir, aesKey, xorKey, key);
	let indexDead = false;
	if (idxRes.file) {
		const data = decodeCachedFile(idxRes.file, aesKey, xorKey);
		if (data) {
			boundedSet(md5UrlCache, cacheKey, data);
			return { url: data };
		}
		indexDead = true;
	}
	if (indexDead || !idxRes.complete) {
	const files = [];
	for (const root of snsImgRoots(wechatBaseDir)) walkFiles$1(root, files, 0);
	for (const f of files) try {
		const bytes = readFileSync(f);
		const dec = decodeDatBytes(new Uint8Array(bytes), aesKey ?? null, xorKey);
		if ("error" in dec) continue;
		if (key && md5Of(dec.bytes) !== key) continue;
		const data = dataUrlOf$1(dec);
		boundedSet(md5UrlCache, cacheKey, data);
		return { url: data };
	} catch {}
	}
	const attachRoot = join(wechatBaseDir, "msg", "attach");
	if (existsSync(attachRoot)) {
		const attachFiles = [];
		walkFiles$1(attachRoot, attachFiles, 0);
		let hevcFallback = null;
		for (const f of attachFiles) try {
			const bytes = readFileSync(f);
			const dec = decodeDatBytes(new Uint8Array(bytes), aesKey ?? null, xorKey);
			if ("error" in dec) continue;
			const nameBase = (f.split(/[\\/]/).pop() ?? "").replace(/\.dat$/i, "").replace(/_(t|h|b|thumb.*)$/i, "");
			// 前缀匹配带长度门槛：msg/attach 里有 504 个名字短于 16 字符（实测有 `0_t`），
			// `key.startsWith("0")` 对任意以 0 开头的 md5 都成立 → 会在目标缺失时返回无关图片。
			const nameMatch = nameBase === key || (nameBase.length >= 16 && (nameBase.startsWith(key) || key.startsWith(nameBase)));
			if (md5Of(dec.bytes) !== key && !nameMatch) continue;
			const data = dataUrlOf$1(dec);
			const lower = f.toLowerCase();
			if (lower.includes("_t.") || lower.includes("_h.") || lower.includes("_b.") || lower.includes("_thumb")) {
				boundedSet(md5UrlCache, cacheKey, data);
				return { url: data };
			}
			if (!hevcFallback) hevcFallback = { data };
		} catch {}
		if (hevcFallback) {
			boundedSet(md5UrlCache, cacheKey, hevcFallback.data);
			return { url: hevcFallback.data };
		}
	}
	return { error: "未找到匹配的本地图片" };
}
//#endregion
//#region lib/types/query/article-cover.js
/**
* 公众号文章封面解析：抓取微信文章页，取 og:image（或首个 mmbiz 图片），
* 下载后转成 base64 data URL，并落盘到本地目录，下次直接读本地文件。
*/
const coverCache$1 = /* @__PURE__ */ new Map();
const FETCH_HEADERS = {
	"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
	"Referer": "https://mp.weixin.qq.com/"
};
function sniffImageFormat$1(data) {
	if (data.length >= 3 && data[0] === 255 && data[1] === 216 && data[2] === 255) return "jpeg";
	if (data.length >= 4 && data[0] === 137 && data[1] === 80 && data[2] === 78 && data[3] === 71) return "png";
	if (data.length >= 4 && data[0] === 71 && data[1] === 73 && data[2] === 70 && data[3] === 56) return "gif";
	if (data.length >= 12 && data[0] === 82 && data[1] === 73 && data[2] === 70 && data[3] === 70 && data[8] === 87 && data[9] === 69 && data[10] === 66 && data[11] === 80) return "webp";
	return "jpeg";
}
/** Fetch text with a timeout; throws on failure. */
async function fetchText(url, timeoutMs) {
	const res = await fetch(url, {
		headers: FETCH_HEADERS,
		signal: AbortSignal.timeout(timeoutMs)
	});
	if (!res.ok) throw new Error("HTTP " + String(res.status));
	return res.text();
}
/** Fetch image bytes with a timeout; throws on failure. */
async function fetchBytes(url, timeoutMs) {
	const res = await fetch(url, {
		headers: FETCH_HEADERS,
		signal: AbortSignal.timeout(timeoutMs)
	});
	if (!res.ok) throw new Error("HTTP " + String(res.status));
	return new Uint8Array(await res.arrayBuffer());
}
/** Extract the article cover image URL (og:image first, then first mmbiz image). */
function articleCoverUrl(html) {
	const og = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i) ?? html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
	if (og && og[1]) return og[1];
	const m = html.match(/mmbiz\.qpic\.cn\/[^"'\s>]+/);
	return m ? m[0] : null;
}
/** Local cache file for one article cover (md5(contentUrl)). */
function coverFile(cacheDir, key) {
	if (!cacheDir) return null;
	return join(cacheDir, "article-covers", createHash("md5").update(Buffer.from(key, "utf8")).digest("hex") + ".img");
}
/**
* Resolve a 公众号 article cover to a base64 data URL（本地缓存优先，再走网络并落盘）。
* @param contentUrl - mp.weixin.qq.com article URL from the moments XML.
* @param cacheDir - persistent cache directory (decoded_images), optional.
* @returns ImageDataUrlResult-like result.
*/
async function resolveArticleCoverDataUrl(contentUrl, cacheDir) {
	const key = (contentUrl || "").trim();
	if (!key) return { error: "缺少文章链接" };
	if (coverCache$1.has(key)) {
		const cached = coverCache$1.get(key) ?? "";
		return cached ? { url: cached } : { error: "文章封面暂不可用" };
	}
	const file = coverFile(cacheDir, key);
	if (file && existsSync(file)) try {
		const bytes = readFileSync(file);
		if (bytes.length >= 16) {
			const data = "data:image/" + sniffImageFormat$1(new Uint8Array(bytes)) + ";base64," + bytes.toString("base64");
			boundedSet(coverCache$1, key, data);
			return { url: data };
		}
	} catch {}
	try {
		const raw = articleCoverUrl(await fetchText(key, 2e4));
		if (!raw) {
			boundedSet(coverCache$1, key, "");
			return { error: "文章中未找到封面图片" };
		}
		const bytes = await fetchBytes(raw.startsWith("http://") ? "https://" + raw.slice(7) : raw, 2e4);
		if (bytes.length < 16) throw new Error("empty image");
		const data = "data:image/" + sniffImageFormat$1(bytes) + ";base64," + Buffer.from(bytes).toString("base64");
		if (file) try {
			mkdirSync(join(cacheDir ?? "", "article-covers"), { recursive: true });
			writeFileSync(file, Buffer.from(bytes));
		} catch {}
		boundedSet(coverCache$1, key, data);
		return { url: data };
	} catch {
		boundedSet(coverCache$1, key, "");
		return { error: "文章或封面获取失败" };
	}
}
//#endregion
//#region lib/types/query/media-file.js
/**
* 消息文件解析：从 msg/file/<月份>/<原文件名> 读取微信接收/下载的文件（明文），
* 转成 base64 data URL，供聊天界面「点击打开/下载」使用。
*/
const fileCache = /* @__PURE__ */ new Map();
const FILE_MIME = {
	pdf: "application/pdf",
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	bmp: "image/bmp",
	mp4: "video/mp4",
	mov: "video/quicktime",
	avi: "video/x-msvideo",
	mp3: "audio/mpeg",
	wav: "audio/wav",
	m4a: "audio/mp4",
	zip: "application/zip",
	rar: "application/vnd.rar",
	"7z": "application/x-7z-compressed",
	tar: "application/x-tar",
	gz: "application/gzip",
	doc: "application/msword",
	docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	xls: "application/vnd.ms-excel",
	xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	ppt: "application/vnd.ms-powerpoint",
	pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
	txt: "text/plain",
	md: "text/markdown",
	log: "text/plain",
	ini: "text/plain",
	cfg: "text/plain",
	json: "application/json",
	js: "text/javascript",
	ts: "text/plain",
	html: "text/html",
	css: "text/css",
	xml: "application/xml",
	yaml: "text/yaml",
	yml: "text/yaml",
	csv: "text/csv",
	sql: "text/plain",
	rtf: "application/rtf",
	bat: "text/plain",
	ps1: "text/plain",
	py: "text/plain"
};
function mimeOf(name) {
	return FILE_MIME[(name.split(".").pop() ?? "").toLowerCase()] || "application/octet-stream";
}
/** Sanitize a message file name for safe path lookup. */
function sanitize(name) {
	return name.replace(/[\\/:*?"<>|]/g, "_").trim() || "";
}
/**
* Resolve a received message file to a base64 data URL from msg/file.
* @param wechatBaseDir - raw WeChat install dir (current account root).
* @param fileName - original file name (e.g. 测试报告.pdf).
* @returns ImageDataUrlResult-like result.
*/
function resolveMessageFileDataUrl(wechatBaseDir, fileName) {
	if (!wechatBaseDir) return { error: "未配置微信原始目录，无法定位文件" };
	const name = sanitize(fileName);
	if (!name) return { error: "缺少文件名" };
	const cacheKey = name.toLowerCase();
	if (fileCache.has(cacheKey)) {
		const cached = fileCache.get(cacheKey) ?? "";
		return cached ? { url: cached } : { error: "本地未找到该文件" };
	}
	const fileRoot = join(wechatBaseDir, "msg", "file");
	if (!existsSync(fileRoot)) {
		boundedSet(fileCache, cacheKey, "");
		return { error: "msg/file 目录不存在，文件尚未下载" };
	}
	try {
		let found = "";
		let bestMtime = -1;
		for (const e of readdirSync(fileRoot, { withFileTypes: true })) {
			if (!e.isDirectory()) continue;
			const p = join(fileRoot, e.name, name);
			if (!existsSync(p)) continue;
			const st = statSync(p);
			if (st.mtimeMs > bestMtime) {
				bestMtime = st.mtimeMs;
				found = p;
			}
		}
		if (!found) {
			boundedSet(fileCache, cacheKey, "");
			return { error: "本地未找到该文件（需在微信中先打开/下载）" };
		}
		const bytes = readFileSync(found);
		const url = "data:" + mimeOf(name) + ";base64," + bytes.toString("base64");
		boundedSet(fileCache, cacheKey, url);
		return { url };
	} catch (e) {
		boundedSet(fileCache, cacheKey, "");
		return { error: e.message };
	}
}
//#endregion
//#region lib/types/query/overview-extras.js
/**
* Overview extras: trend deltas, a 90-day activity heatmap, and data
* freshness, computed over the same decrypted shards the overview reads.
* Cached by file signature so it stays cheap on the live dashboard.
*/
function cellStr$10(v) {
	if (typeof v === "string") return v;
	if (v === null || v === void 0) return "";
	if (typeof v === "number" || typeof v === "boolean" || typeof v === "bigint" || typeof v === "symbol") return String(v);
	if (v instanceof Uint8Array) return new TextDecoder("utf-8", { fatal: false }).decode(v);
	return "";
}
function dayKey(sec) {
	return (/* @__PURE__ */ new Date(sec * 1e3)).toISOString().slice(0, 10);
}
/** Recursively enumerate .db / -wal sizes under a directory. */
function walkDb(dir, depth, out) {
	if (depth > 4 || !existsSync(dir)) return;
	for (const e of readdirSync(dir, { withFileTypes: true })) {
		const p = join(dir, e.name);
		if (e.isDirectory()) walkDb(p, depth + 1, out);
		else if (e.name.endsWith(".db") && !e.name.includes("-wal") && !e.name.includes("-shm")) try {
			out.files += 1;
			out.bytes += statSync(p).size;
		} catch {}
		else if (e.name.endsWith("-wal") || e.name.endsWith(".db-wal")) out.wal = true;
	}
}
function queryOverviewExtras(decryptedDir) {
	const dec = decryptedDir;
	const sig = [shardCatalogSig(dec, ["message", "bizchat"]), fileSigOf(join(dec, "message", "message_resource.db"))].join("|");
	return cachedBySig("overview-extras:" + dec, sig, () => computeOverviewExtras(dec), 3e4);
}
function computeOverviewExtras(dec) {
	const now = Math.floor(Date.now() / 1e3);
	const day7 = now - 7 * 86400;
	const day30 = now - 30 * 86400;
	const day60 = now - 60 * 86400;
	const day14 = now - 14 * 86400;
	const day90 = now - 90 * 86400;
	const names = contactMeta(dec).names;
	const md5ToUser = /* @__PURE__ */ new Map();
	for (const u of names.keys()) md5ToUser.set(createHash("md5").update(u, "utf8").digest("hex"), u);
	try {
		const sp = join(dec, "session", "session.db");
		if (existsSync(sp)) {
			const db = new DatabaseSync(sp, { readOnly: true });
			if (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='SessionTable'").get() !== void 0) for (const r of db.prepare("SELECT username FROM SessionTable").all()) {
				const u = cellStr$10(r["username"]);
				if (u) md5ToUser.set(createHash("md5").update(u, "utf8").digest("hex"), u);
			}
			db.close();
		}
	} catch {}
	const dayCounts = /* @__PURE__ */ new Map();
	let m7 = 0;
	let m30 = 0;
	let m60 = 0;
	let prev7 = 0;
	let prev30 = 0;
	const contactActive7 = /* @__PURE__ */ new Set();
	const contactActive30 = /* @__PURE__ */ new Set();
	const groupActive7 = /* @__PURE__ */ new Set();
	const groupActive30 = /* @__PURE__ */ new Set();
	let lastSync = 0;
	for (const sh of shardCatalogDirs(dec, ["message", "bizchat"])) try {
		const db = new DatabaseSync(sh.file, { readOnly: true });
		try {
			for (const [table, meta] of sh.tables) {
				if (!meta.cols.has("create_time")) continue;
				const rows = db.prepare("SELECT create_time / 86400 AS d, COUNT(*) AS n FROM " + table + " WHERE create_time >= ? GROUP BY d").all(day90);
				if (rows.length === 0) continue;
				const talker = md5ToUser.get(table.slice(4)) ?? table.slice(4);
				const isGroup = talker.includes("@chatroom");
				for (const r of rows) {
					const day = r.d * 86400;
					const k = dayKey(day);
					dayCounts.set(k, (dayCounts.get(k) ?? 0) + r.n);
					if (day >= day7) {
						m7 += r.n;
						if (!isGroup) contactActive7.add(talker);
						else groupActive7.add(talker);
					}
					if (day >= day30) {
						m30 += r.n;
						if (!isGroup) contactActive30.add(talker);
						else groupActive30.add(talker);
					}
					if (day >= day60) m60 += r.n;
					if (day >= day14 && day < day7) prev7 += r.n;
					if (day >= day60 && day < day30) prev30 += r.n;
					if (day > lastSync) lastSync = day + 86399;
				}
			}
		} finally {
			db.close();
		}
	} catch {}
	const heatmap = [];
	for (let i = 89; i >= 0; i--) {
		const d = (/* @__PURE__ */ new Date((now - i * 86400) * 1e3)).toISOString().slice(0, 10);
		heatmap.push({
			d,
			count: dayCounts.get(d) ?? 0
		});
	}
	let storageBytes30 = 0;
	const rp = join(dec, "message", "message_resource.db");
	if (existsSync(rp)) try {
		const db = new DatabaseSync(rp, { readOnly: true });
		if (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='MessageResourceDetail'").get() !== void 0) {
			if (new Set(db.prepare("PRAGMA table_info(MessageResourceDetail)").all().map((r) => r.name)).has("create_time")) storageBytes30 = db.prepare("SELECT COALESCE(SUM(size), 0) AS s FROM MessageResourceDetail WHERE create_time >= ?").get(day30)?.s ?? 0;
		}
		db.close();
	} catch {}
	const dbState = {
		files: 0,
		bytes: 0,
		wal: false
	};
	walkDb(dec, 0, dbState);
	return {
		trends: {
			messages7: m7,
			messages30: m30,
			messages60: m60,
			messages7Delta: m7 - prev7,
			messages30Delta: m30 - prev30,
			activeContacts7: contactActive7.size,
			activeContacts30: contactActive30.size,
			activeGroups7: groupActive7.size,
			activeGroups30: groupActive30.size,
			storageBytes30
		},
		heatmap,
		freshness: {
			dbFiles: dbState.files,
			dbBytes: dbState.bytes,
			walPending: dbState.wal,
			ok: m60 > 0 || contactActive30.size > 0,
			lastSync: lastSync ? (/* @__PURE__ */ new Date(lastSync * 1e3)).toLocaleString("zh-CN") : ""
		}
	};
}
//#endregion
//#region lib/types/query/overview-insights.js
/**
* 微信数据总览「战术分析」：基于解密数据库做交互画像/作息浓度/关系浓度/
* 内容资产/数据健康五块统计，供总览页展示。
*/
function cellStr$9(v) {
	if (typeof v === "string") return v;
	if (v === null || v === void 0) return "";
	if (typeof v === "number" || typeof v === "boolean" || typeof v === "bigint" || typeof v === "symbol") return String(v);
	if (v instanceof Uint8Array) return new TextDecoder("utf-8", { fatal: false }).decode(v);
	return "";
}
/** 枚举 decrypted 目录下所有 *.db（不含 -wal/-shm）。 */
function walkDbFiles(dir, out, depth) {
	if (depth > 4 || !existsSync(dir)) return;
	for (const e of readdirSync(dir, { withFileTypes: true })) {
		const p = join(dir, e.name);
		if (e.isDirectory()) walkDbFiles(p, out, depth + 1);
		else if (e.name.endsWith(".db") && !e.name.includes("-wal") && !e.name.includes("-shm")) try {
			out.push({
				path: p,
				bytes: statSync(p).size
			});
		} catch {}
	}
}
/** 行内计数：按本地类型归一化后分类。 */
function typeBucket(t) {
	const m = t > 4294967296 ? t % 4294967296 : t;
	if (m === 1) return "text";
	if (m === 3) return "image";
	if (m === 34) return "voice";
	if (m === 43) return "video";
	if (m === 49) return "rich";
	if (m === 1e4) return "system";
	if (m === 10002) return "revoked";
	return "other";
}
function queryOverviewInsights(decryptedDir, selfUsername) {
	const dec = decryptedDir;
	const self = (selfUsername ?? "").trim();
	const sns = existsSync(join(dec, "sns", "db_sns", "sns.db")) ? join(dec, "sns", "db_sns", "sns.db") : join(dec, "sns", "sns.db");
	const sig = [
		shardCatalogSig(dec, ["message", "bizchat"]),
		fileSigOf(join(dec, "contact", "contact.db")),
		fileSigOf(join(dec, "session", "session.db")),
		fileSigOf(sns),
		fileSigOf(join(dec, "favorite", "favorite.db")),
		fileSigOf(join(dec, "emoticon", "emoticon.db")),
		fileSigOf(join(dec, "hardlink", "hardlink.db")),
		fileSigOf(join(dec, "message", "message_resource.db"))
	].join("|");
	return cachedBySig("overview-insights:" + dec + ":" + self, sig, () => computeOverviewInsights(decryptedDir, self));
}
function computeOverviewInsights(decryptedDir, self = "") {
	const dec = decryptedDir;
	const names = contactMeta(dec).names;
	const md5ToUser = /* @__PURE__ */ new Map();
	for (const u of names.keys()) md5ToUser.set(createHash("md5").update(u, "utf8").digest("hex"), u);
	try {
		const sp = join(dec, "session", "session.db");
		if (existsSync(sp)) {
			const db = new DatabaseSync(sp, { readOnly: true });
			if (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='SessionTable'").get() !== void 0) {
				const rows = db.prepare("SELECT username FROM SessionTable").all();
				for (const r of rows) {
					const u = cellStr$9(r["username"]);
					if (u) md5ToUser.set(createHash("md5").update(u, "utf8").digest("hex"), u);
				}
			}
			db.close();
		}
	} catch {}
	const total = {
		n: 0,
		sent: 0
	};
	const buckets = {
		text: 0,
		image: 0,
		voice: 0,
		video: 0,
		rich: 0,
		system: 0,
		revoked: 0,
		other: 0
	};
	const hourDist = new Array(24).fill(0);
	const dayCounts = /* @__PURE__ */ new Map();
	const talkerCount = /* @__PURE__ */ new Map();
	let minDay = -1;
	let maxDay = -1;
	let lastActive = 0;
	for (const sh of shardCatalogDirs(dec, ["message", "bizchat"])) try {
		const db = new DatabaseSync(sh.file, { readOnly: true });
		try {
			// 「自己发了多少条」必须用 real_sender_id 经**本分片**的 Name2Id 解析；
			// 旧实现读 `is_sender` 列 —— WeChat 4.x 的 Msg_ 表没有这一列（0/239 张有），
			// 于是 SUM('0') 恒为 0：导出报告里写的是「发出 0 / 收到 139,362」。
			let selfRowId;
			if (self) {
				const first = sh.tables.values().next().value;
				if (first) for (const [id, name] of first.name2id) if (name === self) {
					selfRowId = id;
					break;
				}
			}
			for (const [table, meta] of sh.tables) {
				if (!meta.cols.has("create_time") || !meta.cols.has("local_type")) continue;
				const sentExpr = meta.cols.has("real_sender_id") && selfRowId !== void 0 ? "SUM(CASE WHEN real_sender_id = " + selfRowId + " THEN 1 ELSE 0 END)" : "0";
				const grouped = db.prepare("SELECT (local_type & 4294967295) AS t, (create_time / 3600) % 24 AS h, create_time / 86400 AS d, COUNT(*) AS n, " + sentExpr + " AS s, MAX(create_time) AS m FROM " + table + " GROUP BY t, h, d").all();
				let tn = 0;
				for (const g of grouped) {
					const b = typeBucket(g.t);
					buckets[b] = (buckets[b] ?? 0) + g.n;
					total.sent += g.s;
					tn += g.n;
					hourDist[(g.h % 24 + 24) % 24] = (hourDist[(g.h % 24 + 24) % 24] ?? 0) + g.n;
					const d = g.d;
					dayCounts.set(d, (dayCounts.get(d) ?? 0) + g.n);
					if (minDay < 0 || d < minDay) minDay = d;
					if (d > maxDay) maxDay = d;
					if (g.m) lastActive = Math.max(lastActive, g.m);
				}
				total.n += tn;
				const talker = md5ToUser.get(table.slice(4)) ?? table.slice(4);
				talkerCount.set(talker, (talkerCount.get(talker) ?? 0) + tn);
			}
		} finally {
			db.close();
		}
	} catch {}
	let busyHour = 0;
	let busyCount = 0;
	let deepNight = 0;
	let weekend = 0;
	for (let i = 0; i < 24; i++) {
		const n = hourDist[i] ?? 0;
		if (n > busyCount) {
			busyCount = n;
			busyHour = i;
		}
		if (i >= 23 || i <= 5) deepNight += n;
	}
	for (const [d, n] of dayCounts) {
		const dow = (d + 4) % 7;
		if (dow === 0 || dow === 6) weekend += n;
	}
	const totalSafe = Math.max(1, total.n);
	const contactRows = [];
	const cp = join(dec, "contact", "contact.db");
	if (existsSync(cp)) try {
		const db = new DatabaseSync(cp, { readOnly: true });
		const cols = new Set(db.prepare("PRAGMA table_info(contact)").all().map((r) => r.name));
		if (cols.has("username")) {
			const lt = cols.has("local_type") ? "local_type" : "0";
			const df = cols.has("delete_flag") ? "delete_flag" : "0";
			const rows = db.prepare(`SELECT username, ${lt} AS lt, ${df} AS df FROM contact WHERE (${df} = 0 OR ${df} IS NULL)`).all();
			for (const r of rows) {
				const u = cellStr$9(r["username"]);
				if (!u) continue;
				if (u.startsWith("@")) continue;
				contactRows.push({
					username: u,
					isGroup: u.includes("@chatroom"),
					isGh: u.startsWith("gh_")
				});
			}
		}
		db.close();
	} catch {}
	const friendRows = contactRows.filter((r) => !r.isGroup && !r.isGh);
	const activeFriends = friendRows.filter((r) => talkerCount.has(r.username)).length;
	const silentFriends = friendRows.length - activeFriends;
	const groupsWithMsg = contactRows.filter((r) => r.isGroup && talkerCount.has(r.username)).length;
	const top = Array.from(talkerCount.entries()).filter(([u]) => !u.includes("@chatroom")).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([u, count]) => {
		let name = names.get(u) ?? "";
		if (!name) name = /^[0-9a-f]{16,}$/i.test(u) ? "未知联系人" : u;
		return {
			username: u,
			name,
			count
		};
	});
	const moments = {
		total: 0,
		images: 0,
		videos: 0,
		likes: 0,
		comments: 0
	};
	const sp2 = existsSync(join(dec, "sns", "db_sns", "sns.db")) ? join(dec, "sns", "db_sns", "sns.db") : join(dec, "sns", "sns.db");
	if (existsSync(sp2)) try {
		const db = new DatabaseSync(sp2, { readOnly: true });
		if (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='SnsTimeLine'").get() !== void 0) {
			const rows = db.prepare("SELECT content AS c FROM SnsTimeLine").all();
			for (const r of rows) {
				const xml = cellStr$9(r.c);
				moments.total += 1;
				moments.images += xml.split("<media>").length - 1 + xml.split("<media ").length - 1;
				if (xml.includes("<type>6</type>") || xml.includes("<type>4</type>") || xml.includes("<type>15</type>")) moments.videos += 1;
				const le = xml.indexOf("<LocalExtraInfo>");
				if (le >= 0) {
					const block = xml.slice(le, xml.indexOf("</LocalExtraInfo>", le) || xml.length);
					const parts = block.split("<user_comment>").length - 1;
					const likes = (block.match(/<type>1<\/type>/g) ?? []).length;
					moments.likes += likes;
					moments.comments += Math.max(0, parts - likes);
				}
			}
		}
		db.close();
	} catch {}
	const assets = {
		favorites: 0,
		emoticons: 0,
		files: 0,
		fileBytes: 0,
		mediaItems: 0,
		mediaBytes: 0
	};
	assets.favorites = countRows(join(dec, "favorite", "favorite.db"), "fav_db_item");
	assets.emoticons = countRows(join(dec, "emoticon", "emoticon.db"), "kNonStoreEmoticonTable");
	for (const table of [
		"image_hardlink_info_v4",
		"file_hardlink_info_v4",
		"video_hardlink_info_v4"
	]) {
		const hp = join(dec, "hardlink", "hardlink.db");
		if (!existsSync(hp)) break;
		try {
			const db = new DatabaseSync(hp, { readOnly: true });
			if (db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='${table}'`).get() !== void 0) {
				const c = db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(file_size), 0) AS s FROM ${table}`).get();
				assets.files += c.n;
				assets.fileBytes += c.s;
			}
			db.close();
		} catch {}
	}
	const rp = join(dec, "message", "message_resource.db");
	if (existsSync(rp)) try {
		const db = new DatabaseSync(rp, { readOnly: true });
		if (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='MessageResourceDetail'").get() !== void 0) {
			const c = db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS s FROM MessageResourceDetail").get();
			assets.mediaItems = c.n;
			assets.mediaBytes = c.s;
		}
		db.close();
	} catch {}
	const dbs = [];
	walkDbFiles(dec, dbs, 0);
	const dbBytes = dbs.reduce((a, r) => a + r.bytes, 0);
	return {
		messages: {
			total: total.n,
			sent: total.sent,
			received: Math.max(0, total.n - total.sent),
			text: buckets.text ?? 0,
			image: buckets.image ?? 0,
			voice: buckets.voice ?? 0,
			video: buckets.video ?? 0,
			rich: buckets.rich ?? 0,
			system: buckets.system ?? 0,
			revoked: buckets.revoked ?? 0
		},
		time: {
			activeDays: dayCounts.size,
			spanDays: maxDay >= 0 && minDay >= 0 ? maxDay - minDay + 1 : 0,
			busyHour,
			busyCount,
			hourDist,
			deepNightPct: Math.round(deepNight / totalSafe * 1e3) / 10,
			weekendPct: Math.round(weekend / totalSafe * 1e3) / 10,
			lastActive: lastActive ? (/* @__PURE__ */ new Date(lastActive * 1e3)).toLocaleString("zh-CN") : ""
		},
		relations: {
			total: friendRows.length,
			active: activeFriends,
			silent: silentFriends,
			groupsWithMsg,
			top
		},
		moments,
		assets,
		health: {
			dbFiles: dbs.length,
			dbBytes,
			ok: total.n > 0 || contactRows.length > 0
		},
		extras: queryOverviewExtras(decryptedDir)
	};
}
function countRows(path, table) {
	if (!existsSync(path)) return 0;
	try {
		const db = new DatabaseSync(path, { readOnly: true });
		if (!(db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='${table}'`).get() !== void 0)) {
			db.close();
			return 0;
		}
		const r = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get();
		db.close();
		return r.n;
	} catch {
		return 0;
	}
}
//#endregion
//#region lib/types/query/status.js
/**
* Decrypted DB status summary, rewritten from st_control
* handlers/data/media.rs get_wechat_db_status.
*/
const LABEL_MAP = [
	["session", "会话(session)"],
	["message", "消息(message)"],
	["contact", "通讯录(contact)"],
	["sns", "朋友圈(sns)"],
	["favorite", "收藏(favorite)"],
	["emoticon", "表情(emoticon)"],
	["hardlink", "文件(hardlink)"],
	["general", "通用(general)"],
	["bizchat", "公众号(bizchat)"],
	["head_image", "头像缓存(head_image)"],
	["solitaire", "接龙(solitaire)"],
	["backup", "备份(backup)"]
];
const EXCLUDED = ["monitor_cache", "exports"];
/** Recursively check whether a directory contains any .db file (max depth 5). */
function hasDbFile(dir, depth = 0) {
	if (depth > 5 || !existsSync(dir)) return false;
	let entries = [];
	try {
		entries = readdirSync(dir, { withFileTypes: true }).map((e) => ({
			name: e.name,
			isDir: e.isDirectory()
		}));
	} catch {
		return false;
	}
	for (const e of entries) {
		const p = join(dir, e.name);
		if (e.isDir) {
			if (hasDbFile(p, depth + 1)) return true;
		} else if (e.name.endsWith(".db")) return true;
	}
	return false;
}
/**
* Summarize the decrypted DB directories as status lines (cached ~5s).
* @param decryptedDir - decrypted data root.
* @returns status lines plus the resolved path.
*/
function getDbStatus(decryptedDir) {
	return cachedBySig("db-status:" + decryptedDir, "fs-status-v1", () => computeDbStatus(decryptedDir));
}
function computeDbStatus(decryptedDir) {
	const lines = [];
	if (!existsSync(decryptedDir)) {
		lines.push("⚠️ 解密目录不存在");
		return {
			lines,
			path: decryptedDir
		};
	}
	let dirs = [];
	try {
		dirs = readdirSync(decryptedDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => ({ name: e.name })).sort((a, b) => a.name.localeCompare(b.name));
	} catch (e) {
		lines.push("⚠️ 读取目录失败: " + e.message);
		return {
			lines,
			path: decryptedDir
		};
	}
	for (const d of dirs) {
		if (EXCLUDED.includes(d.name) || d.name.startsWith(".")) continue;
		const ok = hasDbFile(join(decryptedDir, d.name));
		const label = LABEL_MAP.find(([k]) => k === d.name)?.[1] ?? d.name;
		lines.push(ok ? label + ": ✅ 可用" : label + ": ⚠️ 空目录");
	}
	lines.push("路径: " + decryptedDir);
	return {
		lines,
		path: decryptedDir
	};
}
//#endregion
//#region lib/types/query/media-voice.js
/**
* WeChat voice message lookup, rewritten from st_control voice.rs.
* Locates silk voice data in media_0.db VoiceInfo (Name2Id direct, then
* svr_id fallback). Node cannot decode silk without ffmpeg/a WASM decoder,
* so decodable=false and the frontend shows a duration + degrade hint.
*/
/** Msg_<md5(username)> table name for a talker. */
function msgTableName$5(username) {
	return "Msg_" + createHash("md5").update(username, "utf8").digest("hex");
}
/** Message shard DB files under <decrypted>/message. */
function messageShardFiles$3(decryptedDir) {
	const dir = join(decryptedDir, "message");
	if (!existsSync(dir)) return [];
	return readdirSync(dir).filter((f) => f.endsWith(".db") && !f.includes("_shm") && !f.includes("_wal") && !f.includes("media") && !f.includes("fts") && !f.includes("resource")).sort().map((f) => join(dir, f));
}
/**
* server_id for (username, local_id) from the message shards.
* @returns the server id as text (bigints exceed the safe-integer range).
*/
function messageServerId(decryptedDir, username, localId) {
	const table = msgTableName$5(username);
	for (const shard of messageShardFiles$3(decryptedDir)) {
		let db = null;
		try {
			db = new DatabaseSync(shard, { readOnly: true });
		} catch {
			continue;
		}
		if (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table) !== void 0) try {
			const row = db.prepare("SELECT CAST(server_id AS TEXT) AS s FROM \"" + table + "\" WHERE local_id = ? LIMIT 1").get(localId);
			db.close();
			if (row && row.s) return row.s;
			continue;
		} catch {
			db.close();
			continue;
		}
		db.close();
	}
	return null;
}
/**
* Look up one voice message.
* @param decryptedDir - decrypted data root.
* @param username - conversation username.
* @param localId - message local id.
* @returns voice info; svrId as text (bigints exceed the safe-integer range);
* decodable=false when no Node silk decoder is available.
*/
function resolveVoiceInfo(decryptedDir, username, localId) {
	const mediaDb = join(decryptedDir, "message", "media_0.db");
	if (!existsSync(mediaDb)) return {
		available: false,
		decodable: false,
		error: "语音库不存在 (media_0.db)"
	};
	try {
		const db = new DatabaseSync(mediaDb, { readOnly: true });
		if (!(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='VoiceInfo'").get() !== void 0)) {
			db.close();
			return {
				available: false,
				decodable: false,
				error: "VoiceInfo 表不存在"
			};
		}
		let row;
		const chat = db.prepare("SELECT rowid FROM Name2Id WHERE user_name = ?").get(username);
		if (chat) row = db.prepare("SELECT CAST(svr_id AS TEXT) AS svr_id, length(voice_data) AS len FROM VoiceInfo WHERE chat_name_id = ? AND local_id = ? LIMIT 1").get(chat.rowid, localId);
		let svrId = row?.svr_id;
		if (!row) {
			const sid = messageServerId(decryptedDir, username, localId);
			if (sid !== null) {
				row = db.prepare("SELECT CAST(svr_id AS TEXT) AS svr_id, length(voice_data) AS len FROM VoiceInfo WHERE svr_id = ? ORDER BY create_time DESC LIMIT 1").get(sid);
				svrId = sid;
			}
		}
		db.close();
		if (!row) return {
			available: false,
			decodable: false,
			error: "未找到语音数据"
		};
		return {
			available: true,
			svrId: row.svr_id ?? svrId ?? "0",
			length: row.len ?? 0,
			decodable: false,
			error: "silk 解码需要 ffmpeg/WASM（当前不可用）"
		};
	} catch (e) {
		return {
			available: false,
			decodable: false,
			error: e.message
		};
	}
}
//#endregion
//#region lib/types/query/media-video.js
/**
* WeChat video message lookup, rewritten from st_control hevc/momentVideo
* surface. The raw video files live in the WeChat install dir (not the
* static decrypted snapshot), so this resolves the message MD5 and any
* decodable cover thumbnail from decoded_images; playback degrades to a
* placeholder when no cover/file is available.
*/
/** Msg_<md5(username)> table name for a talker. */
function msgTableName$4(username) {
	return "Msg_" + createHash("md5").update(username, "utf8").digest("hex");
}
/** Message shard DB files under <decrypted>/message. */
function messageShardFiles$2(decryptedDir) {
	const dir = join(decryptedDir, "message");
	if (!existsSync(dir)) return [];
	return readdirSync(dir).filter((f) => f.endsWith(".db") && !f.includes("_shm") && !f.includes("_wal") && !f.includes("monitor_cache")).sort().map((f) => join(dir, f));
}
/**
* Resolve one video message: MD5 from packed_info_data + a decodable cover
* thumbnail from the decoded image cache.
* @param decryptedDir - decrypted data root.
* @param decodedDir - decoded image cache root.
* @param username - conversation username.
* @param localId - message local id.
* @returns cover data URL (jpg) when available, else an error description.
*/
function resolveVideoInfo(decryptedDir, decodedDir, username, localId) {
	const table = msgTableName$4(username);
	let md5 = null;
	for (const shard of messageShardFiles$2(decryptedDir)) {
		let db = null;
		try {
			db = new DatabaseSync(shard, { readOnly: true });
		} catch {
			continue;
		}
		if (!(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table) !== void 0)) {
			db.close();
			continue;
		}
		const packed = db.prepare("PRAGMA table_info(\"" + table + "\")").all().map((r) => r.name).find((c) => c.toLowerCase().includes("packed"));
		if (packed) try {
			const row = db.prepare("SELECT \"" + packed + "\" AS p FROM \"" + table + "\" WHERE local_id = ? AND (local_type = 43 OR local_type % 4294967296 = 43) LIMIT 1").get(localId);
			if (row) md5 = extractMd5FromPacked(row.p);
		} catch {}
		db.close();
		if (md5) break;
	}
	if (!md5) return {
		available: false,
		error: "未找到视频 MD5"
	};
	const userDir = join(decodedDir, username);
	if (existsSync(userDir)) {
		for (const ext of [
			"jpg",
			"jpeg",
			"png",
			"webp"
		]) {
			const p = join(userDir, md5 + "." + ext);
			if (existsSync(p)) try {
				const bytes = readFileSync(p);
				return {
					available: true,
					md5,
					coverUrl: "data:image/" + (ext === "jpg" ? "jpeg" : ext) + ";base64," + Buffer.from(bytes).toString("base64")
				};
			} catch {}
		}
		if (existsSync(join(userDir, md5 + ".hevc"))) return {
			available: false,
			md5,
			error: "hevc-unsupported"
		};
	}
	return {
		available: false,
		md5,
		error: "视频文件不在本地快照（原始文件在微信安装目录）"
	};
}
//#endregion
//#region lib/types/query/avatar.js
/**
* WeChat user avatar resolution, rewritten from st_control modules/avatar.rs.
* Priority: head_image.db image_buffer (data URL) -> contact small/big_head_url.
*/
/** Sniff an image format from magic bytes. */
function sniffImageFormat(data) {
	if (data.length >= 3 && data[0] === 255 && data[1] === 216 && data[2] === 255) return "jpeg";
	if (data.length >= 4 && data[0] === 137 && data[1] === 80 && data[2] === 78 && data[3] === 71) return "png";
	if (data.length >= 4 && data[0] === 71 && data[1] === 73 && data[2] === 70 && data[3] === 56) return "gif";
	if (data.length >= 12 && data[0] === 82 && data[1] === 73 && data[2] === 70 && data[3] === 70 && data[8] === 87 && data[9] === 69 && data[10] === 66 && data[11] === 80) return "webp";
	return "jpeg";
}
/** Coerce a DB cell to a string (null -> '', else String()). */
function cellStr$8(v) {
	if (typeof v === "string") return v;
	if (v === null || v === void 0) return "";
	if (typeof v === "number" || typeof v === "boolean" || typeof v === "bigint" || typeof v === "symbol") return String(v);
	return "";
}
/** Avatar from head_image.db image_buffer. */
function avatarFromHeadImageDb(decryptedDir, username) {
	const dbPath = join(decryptedDir, "head_image", "head_image.db");
	if (!existsSync(dbPath)) return null;
	try {
		const db = new DatabaseSync(dbPath, { readOnly: true });
		if (!(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='head_image'").get() !== void 0)) {
			db.close();
			return null;
		}
		const row = db.prepare("SELECT image_buffer AS b FROM head_image WHERE username = ? ORDER BY update_time DESC LIMIT 1").get(username);
		db.close();
		if (!row) return null;
		const buf = row.b instanceof Uint8Array ? row.b : null;
		if (!buf || buf.length < 16) return null;
		return "data:image/" + sniffImageFormat(buf) + ";base64," + Buffer.from(buf).toString("base64");
	} catch {
		return null;
	}
}
/** Avatar URL from contact table (small then big). */
function avatarUrlFromContact(decryptedDir, username) {
	const dbPath = join(decryptedDir, "contact", "contact.db");
	if (!existsSync(dbPath)) return null;
	try {
		const db = new DatabaseSync(dbPath, { readOnly: true });
		if (!(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='contact'").get() !== void 0)) {
			db.close();
			return null;
		}
		const cols = db.prepare("PRAGMA table_info(contact)").all().map((r) => r.name);
		if (!cols.includes("username")) {
			db.close();
			return null;
		}
		const small = cols.includes("small_head_url") ? "small_head_url" : "NULL";
		const big = cols.includes("big_head_url") ? "big_head_url" : "NULL";
		const row = db.prepare("SELECT COALESCE(NULLIF(" + small + ", ''), " + big + ") AS u FROM contact WHERE username = ? LIMIT 1").get(username);
		db.close();
		const url = row?.u ? cellStr$8(row.u) : "";
		return url ? url : null;
	} catch {
		return null;
	}
}
/** Avatar from the raw temp/head_image cache (file name = md5(avatar URL), plain JPEG/PNG). */
function avatarFromTempHeadFile(wechatBaseDir, url) {
	if (!wechatBaseDir || !url) return null;
	const f = join(wechatBaseDir, "temp", "head_image", createHash("md5").update(Buffer.from(url, "utf8")).digest("hex"));
	if (!existsSync(f)) return null;
	try {
		const buf = readFileSync(f);
		if (buf.length < 16) return null;
		return "data:image/" + sniffImageFormat(new Uint8Array(buf)) + ";base64," + buf.toString("base64");
	} catch {
		return null;
	}
}
/** Contact row (username + avatar URL + head_img_md5) found by exact nick_name. */
function contactByNickname(decryptedDir, nickname) {
	if (!nickname) return null;
	const dbPath = join(decryptedDir, "contact", "contact.db");
	if (!existsSync(dbPath)) return null;
	try {
		const db = new DatabaseSync(dbPath, { readOnly: true });
		if (!(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='contact'").get() !== void 0)) {
			db.close();
			return null;
		}
		const cols = db.prepare("PRAGMA table_info(contact)").all().map((r) => r.name);
		if (!cols.includes("username") || !cols.includes("nick_name")) {
			db.close();
			return null;
		}
		const small = cols.includes("small_head_url") ? "small_head_url" : "NULL";
		const big = cols.includes("big_head_url") ? "big_head_url" : "NULL";
		const sql = `SELECT username, COALESCE(NULLIF(${small}, ''), ${big}) AS u, ${cols.includes("head_img_md5") ? "head_img_md5" : "NULL"} AS m FROM contact WHERE nick_name = ? AND COALESCE(NULLIF(${small}, ''), ${big}) != '' LIMIT 1`;
		const row = db.prepare(sql).get(nickname);
		db.close();
		if (!row) return null;
		const username = cellStr$8(row.username);
		const url = cellStr$8(row.u);
		return username && url ? {
			username,
			url,
			md5: cellStr$8(row.m)
		} : null;
	} catch {
		return null;
	}
}
/**
* Resolve a user avatar.
* Priority: head_image.db by username -> contact URL (temp cache data URL first) ->
* contact matched by nick_name (same URL/temp-cache path) -> none.
* @param decryptedDir - decrypted data root.
* @param username - contact or chatroom username.
* @param wechatBaseDir - raw WeChat install root (temp/head_image cache).
* @param nickname - optional display name for contact-by-nickname fallback.
* @returns kind + data URL / remote URL.
*/
function resolveAvatar(decryptedDir, username, wechatBaseDir, nickname) {
	const data = avatarFromHeadImageDb(decryptedDir, username);
	if (data) return {
		kind: "data",
		data
	};
	const url = avatarUrlFromContact(decryptedDir, username);
	if (url) {
		const temp = avatarFromTempHeadFile(wechatBaseDir, url);
		if (temp) return {
			kind: "data",
			data: temp
		};
		const remote = remoteAvatarUrl(url);
		if (remote) return {
			kind: "url",
			url: remote
		};
		return { kind: "none" };
	}
	if (nickname) {
		const c = contactByNickname(decryptedDir, nickname);
		if (c) {
			const temp = avatarFromTempHeadFile(wechatBaseDir, c.url);
			if (temp) return {
				kind: "data",
				data: temp
			};
			const head = avatarFromHeadImageDb(decryptedDir, c.username);
			if (head) return {
				kind: "data",
				data: head
			};
			const remote = remoteAvatarUrl(c.url);
			if (remote) return {
				kind: "url",
				url: remote
			};
			return { kind: "none" };
		}
	}
	return { kind: "none" };
}
/** 只放行 https 的远端头像 URL（http 会被本项目 CSP 的 img-src 拦截）。 */
function remoteAvatarUrl(url) {
	const u = (url ?? "").trim();
	return /^https:\/\//i.test(u) ? u : null;
}
/**
* 批量读取全部本地头像:单次打开 head_image.db,返回 username → data URL。
* 本地优先(头像绝不走网络);未命中者不出现在结果中。
*/
function resolveAvatarsLocal(decryptedDir, usernames) {
	const out = {};
	if (usernames.length === 0) return out;
	const dbPath = join(decryptedDir, "head_image", "head_image.db");
	if (!existsSync(dbPath)) return out;
	try {
		const db = new DatabaseSync(dbPath, { readOnly: true });
		if (!(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='head_image'").get() !== void 0)) {
			db.close();
			return out;
		}
		const stmt = db.prepare("SELECT image_buffer AS b FROM head_image WHERE username = ? ORDER BY update_time DESC LIMIT 1");
		for (const username of usernames) {
			const row = stmt.get(username);
			if (!row) continue;
			const buf = row.b instanceof Uint8Array ? row.b : null;
			if (!buf || buf.length < 16) continue;
			out[username] = "data:image/" + sniffImageFormat(buf) + ";base64," + Buffer.from(buf).toString("base64");
		}
		db.close();
	} catch {}
	return out;
}
//#endregion
//#region lib/types/keys/dll-key-scan.js
/**
* Static scan of Weixin.dll for the 32-byte internal DB key used by V4 key
* recovery, migrated from WeChatDataAnalysis `dll_key_scan.py`. The x64
* signature is the WeFlow/scan.py pattern: four consecutive
* `mov rdx, imm64` immediates followed by `test rax, rax`; the four
* immediates concatenated are the XOR-masked internal DB key.
*/
/** PE32+ optional-header SizeOfOptionalHeader is 0xF0; we read it from the file. */
/** mov rdx, imm64 opcode bytes. */
const MOV_RDX = Buffer.from([72, 186]);
/** test rax, rax opcode bytes. */
const TEST_RAX_RAX = Buffer.from([
	72,
	133,
	192
]);
/** PE code-section characteristic. */
const CODE_SECTION_CHARACTERISTIC = 536870912;
/** Chunk size for sequential scanning. */
const CHUNK_SIZE = 2 * 1024 * 1024;
/** Overlap retained across chunk boundaries. */
const OVERLAP_SIZE = 100;
/**
* Match the 4×mov rdx + test rax,rax signature at a chunk offset. Between
* consecutive `mov rdx, imm64` (10 bytes each) and before the tail there is
* a 3..8 byte gap of unrelated instructions.
* @param buf - chunk buffer.
* @param start - candidate offset of the first `48 BA`.
* @returns the concatenated 32-byte key, or null when the pattern fails.
*/
function matchKeyAt(buf, start) {
	let offset = start;
	const parts = [];
	for (let i = 0; i < 4; i += 1) {
		if (!MOV_RDX.equals(buf.subarray(offset, offset + 2))) return null;
		if (offset + 10 > buf.length) return null;
		parts.push(buf.subarray(offset + 2, offset + 10));
		offset += 10;
		if (i < 3) {
			const next = buf.indexOf(MOV_RDX, offset);
			if (next === -1) return null;
			const gap = next - offset;
			if (gap < 3 || gap > 8) return null;
			offset = next;
		}
	}
	const tail = buf.indexOf(TEST_RAX_RAX, offset);
	if (tail === -1) return null;
	const tailGap = tail - offset;
	if (tailGap < 3 || tailGap > 8) return null;
	return Buffer.concat(parts);
}
/**
* Scan one chunk for the internal-key signature.
* @param buf - chunk data (with overlap).
* @param chunkSize - real chunk length (without overlap).
* @returns candidate keys in scan order.
*/
function scanChunk(buf, chunkSize) {
	const out = [];
	let offset = 0;
	while (offset < chunkSize) {
		const idx = buf.indexOf(MOV_RDX, offset);
		if (idx === -1 || idx >= chunkSize) break;
		const key = matchKeyAt(buf, idx);
		if (key !== null && key.length === 32) out.push(key);
		offset = idx + 1;
	}
	return out;
}
/**
* Extract all internal-key candidates from a Weixin.dll file.
* @param dllPath - path to Weixin.dll.
* @returns candidates sorted by virtual address.
*/
function extractXorKeysFromDll(dllPath) {
	if (statSync(dllPath).size < 1024) return [];
	const file = readFileSync(dllPath);
	const peOffset = file.readUInt32LE(60);
	if (peOffset + 24 > file.length) return [];
	if (file.toString("latin1", peOffset, peOffset + 4) !== "PE\0\0") return [];
	const imageBase = Number(file.readBigUInt64LE(peOffset + 24 + 24));
	const numberOfSections = file.readUInt16LE(peOffset + 6);
	const sizeOfOptionalHeader = file.readUInt16LE(peOffset + 20);
	const sectionsStart = peOffset + 24 + sizeOfOptionalHeader;
	const candidates = [];
	for (let i = 0; i < numberOfSections; i += 1) {
		const entry = sectionsStart + i * 40;
		if (entry + 40 > file.length) break;
		if ((file.readUInt32LE(entry + 36) & CODE_SECTION_CHARACTERISTIC) === 0) continue;
		const virtualSize = file.readUInt32LE(entry + 8);
		const virtualAddress = file.readUInt32LE(entry + 12);
		const sizeOfRawData = file.readUInt32LE(entry + 16);
		const pointerToRawData = file.readUInt32LE(entry + 20);
		const rawSize = Math.min(sizeOfRawData, virtualSize > 0 ? virtualSize : sizeOfRawData);
		if (rawSize === 0) continue;
		for (let chunkOffset = 0; chunkOffset < rawSize; chunkOffset += CHUNK_SIZE) {
			const chunkSize = Math.min(CHUNK_SIZE, rawSize - chunkOffset);
			const chunk = file.subarray(pointerToRawData + chunkOffset, pointerToRawData + chunkOffset + chunkSize + OVERLAP_SIZE);
			for (const key of scanChunk(chunk, chunkSize)) {
				const va = imageBase + virtualAddress + chunkOffset;
				candidates.push({
					va: "0x" + va.toString(16).toUpperCase(),
					fileOffset: "0x" + (pointerToRawData + chunkOffset).toString(16).toUpperCase(),
					key: key.toString("hex").toUpperCase().replace(/(..)/g, "$1 ").trim(),
					keyHex: key.toString("hex")
				});
			}
		}
	}
	candidates.sort((a, b) => parseInt(a.va, 16) - parseInt(b.va, 16));
	return candidates;
}
/** Max user-space address (x64). */
const MAX_USER_ADDRESS = 0x7fffffffffff;
/**
* x64 MEMORY_BASIC_INFORMATION size: BaseAddress (ptr 8) + AllocationBase
* (ptr 8) + AllocationProtect (u32 4) + 4-byte padding + RegionSize (size_t 8)
* + State (u32 4) + Protect (u32 4) + Type (u32 4) = 48 bytes. The kernel
* rejects a shorter buffer (returns 0), so this must be the full struct size.
* WeChat 4.x is x64-only; the x86 layout (28 bytes) is not supported.
*/
const MBI_SIZE = 48;
let apiPromise;
async function win32Api() {
	if (apiPromise !== void 0) return apiPromise;
	apiPromise = (async () => {
		const kernel32 = (await import("koffi")).default.load("kernel32.dll");
		const openProcess = kernel32.func("__stdcall", "OpenProcess", "void *", [
			"uint32",
			"int32",
			"uint32"
		]);
		const virtualQueryEx = kernel32.func("__stdcall", "VirtualQueryEx", "size_t", [
			"void *",
			"void *",
			"void *",
			"size_t"
		]);
		const readProcessMemory = kernel32.func("__stdcall", "ReadProcessMemory", "int32", [
			"void *",
			"void *",
			"void *",
			"size_t",
			"size_t *"
		]);
		const closeHandle = kernel32.func("__stdcall", "CloseHandle", "int32", ["void *"]);
		return {
			openProcess(pid) {
				return openProcess(1040, 0, pid);
			},
			queryRegion(handle, address) {
				const info = Buffer.alloc(MBI_SIZE);
				const result = virtualQueryEx(handle, address, info, MBI_SIZE);
				if (Number(result) === 0) return null;
				return {
					baseAddress: Number(info.readBigUInt64LE(0)),
					size: Number(info.readBigUInt64LE(24)),
					state: info.readUInt32LE(32),
					protect: info.readUInt32LE(36)
				};
			},
			readMemory(handle, address, size) {
				if (size <= 0) return Buffer.alloc(0);
				const buffer = Buffer.alloc(size);
				const bytesRead = Buffer.alloc(8);
				const success = readProcessMemory(handle, address, buffer, size, bytesRead);
				if (Number(success) === 0) return Buffer.alloc(0);
				const read = Number(bytesRead.readBigUInt64LE(0));
				return read > 0 ? buffer.subarray(0, Math.min(read, size)) : Buffer.alloc(0);
			},
			closeHandle(handle) {
				try {
					closeHandle(handle);
				} catch {}
			}
		};
	})();
	return apiPromise;
}
/**
* True on a committed, writable, non-guarded region (image-key scan filter).
* @param region - queried memory region.
* @returns whether the scanner should read it.
*/
function isScannableRegion(region) {
	if (region.state !== 4096 || region.size <= 0 || region.size > 50 * 1024 * 1024) return false;
	if ((region.protect & 257) !== 0) return false;
	const prot = region.protect & 255;
	return prot === 4 || prot === 8 || prot === 64 || prot === 128;
}
/**
* Enumerate committed writable regions of a process.
* @param pid - target process id.
* @returns the API handle plus regions, or null when the process is inaccessible.
*/
async function enumerateScannableRegions(pid) {
	const api = await win32Api();
	const handle = api.openProcess(pid);
	if (!handle) return null;
	const regions = [];
	let address = 0;
	while (address < MAX_USER_ADDRESS) {
		const region = api.queryRegion(handle, address);
		if (region === null) break;
		const next = region.baseAddress + region.size;
		if (next <= address) break;
		if (isScannableRegion(region)) regions.push(region);
		address = next;
	}
	return {
		api,
		handle,
		regions
	};
}
/**
* Read bytes at a process address (opens its own handle).
* @param pid - target process id.
* @param address - virtual address to read.
* @param size - number of bytes to read.
* @returns the read bytes (empty when the read fails).
*/
async function readProcessMemory(pid, address, size) {
	const api = await win32Api();
	const handle = api.openProcess(pid);
	if (!handle) return Buffer.alloc(0);
	try {
		return api.readMemory(handle, address, size);
	} finally {
		api.closeHandle(handle);
	}
}
/** SQLCipher first-page size. */
const PAGE_SIZE = 4096;
/**
* GetKeyAddrStub rule (from key_v4.py): a 32-byte frame whose fixed runs are
* bytes 6-15 = 0x00, 16 = 0x20, 17-23 = 0x00, 24 = 0x2F, 25-31 = 0x00; the
* first 6 bytes are wildcards. The 8-byte little-endian value AT THE MATCH
* OFFSET is the candidate-key address.
*/
const STUB_FIXED = {
	/** index → required byte for every fixed position. */
	bytes: new Map([[16, 32], [24, 47]]),
	/** zero-run ranges (inclusive) inside the frame. */
	zeroRuns: [
		[6, 15],
		[17, 23],
		[25, 31]
	]
};
/** Read a little-endian u64 from a buffer. */
function readU64(data, offset) {
	return Number(data.readBigUInt64LE(offset));
}
/** Scan one memory chunk for the GetKeyAddrStub pattern (with 0x00 wildcards). */
/**
* Scan a chunk for GetKeyAddrStub frames; address = u64 at the match offset.
* @param chunk - memory chunk to scan.
* @returns candidate key addresses found in the chunk.
*/
function findKeyAddresses(chunk) {
	const out = [];
	for (let i = 0; i + 32 <= chunk.length; i += 1) {
		if (chunk[i + 16] !== 32 || chunk[i + 24] !== 47) continue;
		let ok = true;
		for (const [from, to] of STUB_FIXED.zeroRuns) {
			for (let j = from; j <= to; j += 1) if (chunk[i + j] !== 0) {
				ok = false;
				break;
			}
			if (!ok) break;
		}
		if (!ok) continue;
		const addr = readU64(chunk, i);
		if (addr > 0 && addr < 0x7fffffffffff) out.push(addr);
	}
	return out;
}
/**
* Entropy/printability prefilter for 32-byte key candidates.
* @param key - 32-byte candidate.
* @returns true when the candidate looks like random key material.
*/
function isPotentialKey(key) {
	if (key.length !== 32) return false;
	if (new Set(key).size < 15) return false;
	let printable = 0;
	for (const byte of key) if (byte >= 32 && byte <= 126) printable += 1;
	return printable <= 24;
}
/**
* Scan a process's committed private memory for candidate key addresses.
* @param pid - WeChat process id.
* @returns candidate 32-byte keys (deduplicated).
*/
async function scanProcessKeyCandidates(pid) {
	const scan = await enumerateScannableRegions(pid);
	if (scan === null) return [];
	const { api, handle, regions } = scan;
	try {
		const addresses = /* @__PURE__ */ new Set();
		for (const region of regions) {
			const CHUNK = 4 * 1024 * 1024;
			let offset = 0;
			let trailing = Buffer.alloc(0);
			while (offset < region.size) {
				const size = Math.min(CHUNK, region.size - offset);
				const chunk = api.readMemory(handle, region.baseAddress + offset, size);
				if (chunk.length > 0) {
					const data = Buffer.concat([trailing, chunk]);
					for (const addr of findKeyAddresses(data)) addresses.add(addr);
					trailing = data.subarray(-8);
				} else trailing = Buffer.alloc(0);
				offset += size;
			}
		}
		const keys = /* @__PURE__ */ new Map();
		for (const address of addresses) {
			const key = await readProcessMemory(pid, address, 32);
			if (key.length === 32) keys.set(key.toString("hex"), key);
		}
		return [...keys.values()];
	} finally {
		api.closeHandle(handle);
	}
}
/**
* Recover the V4 database key from a running WeChat process.
* @param pid - WeChat main-process pid.
* @param dbFilePath - path to one encrypted DB (first page used for verification).
* @param internalDbKey - optional 32-byte internal key from Weixin.dll scanning (XOR mask).
* @returns the recovered key as 64-hex, or an error.
*/
async function recoverDbKeyV4(pid, dbFilePath, internalDbKey) {
	let page1;
	try {
		page1 = readFileSync(dbFilePath);
	} catch (e) {
		return {
			ok: false,
			error: "数据库文件不可读: " + e.message
		};
	}
	if (page1.length < PAGE_SIZE) return {
		ok: false,
		error: "数据库文件太小，不是有效的 V4 加密库"
	};
	const rawCandidates = await scanProcessKeyCandidates(pid);
	if (rawCandidates.length === 0) return {
		ok: false,
		error: "进程内存中未找到密钥候选"
	};
	const filtered = rawCandidates.filter(isPotentialKey);
	for (const candidate of filtered) {
		const testKey = internalDbKey && internalDbKey.length === 32 ? Buffer.from(candidate.map((b, i) => b ^ (internalDbKey[i] ?? 0))) : candidate;
		const { hmacOk, aesOk } = verifyDbKey(page1, testKey);
		if (hmacOk && aesOk) return {
			ok: true,
			key: testKey.toString("hex"),
			source: "key_v4_memory"
		};
	}
	return {
		ok: false,
		error: "候选密钥均未通过 SQLCipher 校验"
	};
}
//#endregion
//#region lib/types/keys/image-key-resolver.js
/**
* Deterministic local image-key resolution compatible with WeFlow, migrated
* from WeChatDataAnalysis `image_key_resolver.py`. A V2 image is the source
* of truth: a kvcomm code and wxid are only returned after their derived AES
* key decrypts a real V2 block to a supported image signature.
*/
/** V2 image magic. */
const V2_MAGIC = Buffer.from([
	7,
	8,
	86,
	50,
	8,
	7
]);
/** Max kvcomm code value. */
const MAX_CODE = 4294967295;
/** Fallback traversal cap. */
const MAX_PREFERRED_DIRS = 2e3;
/** Fallback dirs skipped by name. */
const SKIPPED_FALLBACK_DIR_PARTS = ["thumb", "emoticon"];
/** Month dir regexp. */
const MONTH_DIR_RE = /^\d{4}-\d{2}$/;
/**
* Strip the data-directory suffix from a wxid (wxid_x_<suffix> → wxid_x).
* @param value - raw account id.
* @returns the cleaned wxid, or an empty string.
*/
function cleanWxid(value) {
	const candidate = (value == null ? "" : value).trim();
	if (candidate === "") return "";
	const match = /^(wxid_[^_]+)(?:_.+)$/i.exec(candidate);
	return match ? match[1] ?? "" : candidate;
}
/**
* Derive WeFlow's XOR byte and 16-byte ASCII AES key.
* @param code - kvcomm code (1..0xffffffff).
* @param wxid - account wxid (suffix stripped).
* @returns the derived key pair.
* @throws when code or wxid are invalid.
*/
function deriveImageKeys(code, wxid) {
	if (typeof code !== "number" || !Number.isInteger(code) || code <= 0 || code > MAX_CODE) throw new Error("code must be an integer in the range 1..0xffffffff");
	const cleanedWxid = cleanWxid(wxid);
	if (cleanedWxid === "") throw new Error("wxid must not be empty");
	const digest = createHash("md5").update(String(code) + cleanedWxid, "utf8").digest("hex");
	return {
		xorKey: code & 255,
		aesKey: digest.slice(0, 16)
	};
}
/** Decrypt one AES-ECB block. */
function decryptAesBlock(aesKey, ciphertext) {
	let keyBytes;
	try {
		keyBytes = typeof aesKey === "string" ? Buffer.from(aesKey, "ascii") : Buffer.from(aesKey);
	} catch {
		return null;
	}
	if (keyBytes.length < 16 || ciphertext.length !== 16) return null;
	try {
		const decipher = createDecipheriv("aes-128-ecb", keyBytes.subarray(0, 16), null);
		decipher.setAutoPadding(false);
		return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
	} catch {
		return null;
	}
}
/**
* Detect the image format of a decrypted V2 block.
* @param plaintext - decrypted first block.
* @returns the detected format (jpeg/png/webp/wxgf/gif), or null.
*/
function detectImageFormat(plaintext) {
	if (plaintext === null || plaintext.length === 0) return null;
	if (plaintext.subarray(0, 3).equals(Buffer.from([
		255,
		216,
		255
	]))) return "jpeg";
	if (plaintext.subarray(0, 8).equals(Buffer.from([
		137,
		80,
		78,
		71,
		13,
		10,
		26,
		10
	]))) return "png";
	if (plaintext.subarray(0, 4).toString("latin1") === "RIFF" && plaintext.subarray(8, 12).toString("latin1") === "WEBP") return "webp";
	if (plaintext.subarray(0, 4).toString("latin1").toLowerCase() === "wxgf") return "wxgf";
	if (plaintext.subarray(0, 5).toString("latin1").startsWith("GIF8")) return "gif";
	return null;
}
/**
* Verify one AES key against the encrypted first block of a V2 image.
* @param aesKey - 16-byte ASCII key (string or buffer).
* @param ciphertext - first encrypted AES block.
* @returns true when the block decrypts to a supported image signature.
*/
function verifyAesKey(aesKey, ciphertext) {
	return detectImageFormat(decryptAesBlock(aesKey, ciphertext)) !== null;
}
/**
* Infer XOR from the most common raw trailer pair, matching WeFlow.
* @param tails - raw 2-byte trailer pairs.
* @returns the inferred XOR byte, or null.
*/
function inferXorKeyFromV2Tails(tails) {
	const counts = /* @__PURE__ */ new Map();
	for (const tail of tails) {
		if (tail.length !== 2) continue;
		const key = tail.toString("hex");
		counts.set(key, (counts.get(key) ?? 0) + 1);
	}
	if (counts.size === 0) return null;
	let best = null;
	let bestCount = 0;
	for (const [key, count] of counts) if (count > bestCount) {
		best = key;
		bestCount = count;
	}
	if (best === null) return null;
	const pair = Buffer.from(best, "hex");
	const first = (pair[0] ?? 0) ^ 255;
	return first === ((pair[1] ?? 0) ^ 217) ? first : null;
}
/** Infer XOR with support count. */
function inferXorWithSupport(tails) {
	const counts = /* @__PURE__ */ new Map();
	for (const tail of tails) {
		if (tail.length !== 2) continue;
		const key = tail.toString("hex");
		counts.set(key, (counts.get(key) ?? 0) + 1);
	}
	if (counts.size === 0) return {
		xor: null,
		support: 0
	};
	let best = null;
	let bestCount = 0;
	for (const [key, count] of counts) if (count > bestCount) {
		best = key;
		bestCount = count;
	}
	if (best === null) return {
		xor: null,
		support: 0
	};
	const pair = Buffer.from(best, "hex");
	const first = (pair[0] ?? 0) ^ 255;
	return {
		xor: first === ((pair[1] ?? 0) ^ 217) ? first : null,
		support: bestCount
	};
}
/** List child directories of a path (best-effort). */
function listChildDirs(dir) {
	const out = [];
	try {
		for (const entry of readdirSync(dir, { withFileTypes: true })) if (entry.isDirectory()) out.push(join(dir, entry.name));
	} catch {
		return [];
	}
	return out;
}
/** Read a V2 template file's first block + trailer. */
function readV2Template(filePath) {
	try {
		const stat = statSync(filePath);
		const fd = readFileSync(filePath);
		const headerLen = 31;
		if (fd.length < headerLen || !fd.subarray(0, V2_MAGIC.length).equals(V2_MAGIC)) return null;
		const tailBytes = fd.subarray(fd.length - 2);
		return {
			path: filePath,
			ciphertext: Buffer.from(fd.subarray(15, headerLen)),
			mtimeNs: stat.mtimeMs * 1e6,
			tailXorKey: inferXorKeyFromV2Tails([tailBytes]),
			tailBytes: Buffer.from(tailBytes)
		};
	} catch {
		return null;
	}
}
/** Offer recent *_t.dat files into a max-heap (implemented as sorted list capped). */
function offerRecentTemplates(dir, capacity) {
	const out = [];
	try {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			if (!entry.name.toLowerCase().endsWith("_t.dat") || !entry.isFile()) continue;
			const tpl = readV2Template(join(dir, entry.name));
			if (tpl === null) continue;
			out.push(tpl);
		}
	} catch {
		return out;
	}
	out.sort((a, b) => b.mtimeNs - a.mtimeNs);
	return out.slice(0, capacity);
}
/**
* Scan for recent V2 thumbnail templates under an account dir.
* @param accountDir - WeChat account data dir (wxid_* folder).
* @param limit - max templates to return.
* @param maxFallbackDirs - cap for the fallback BFS.
* @returns the template scan result.
*/
function scanV2Templates(accountDir, limit = 32, maxFallbackDirs = 500) {
	if (limit <= 0) return {
		templates: [],
		inferredXorKey: null,
		usedFallback: false,
		filesScanned: 0,
		xorSupport: 0
	};
	const discoveryCapacity = Math.max(limit * 4, 64);
	const preferred = [];
	let visited = 0;
	const attachDirs = listChildDirs(join(accountDir, "msg", "attach"));
	attachDirs.sort((a, b) => (statSync(b).mtimeMs || 0) - (statSync(a).mtimeMs || 0) || a.localeCompare(b));
	for (const attachDir of attachDirs) {
		if (visited >= MAX_PREFERRED_DIRS) break;
		visited += 1;
		const monthDirs = listChildDirs(attachDir).filter((d) => MONTH_DIR_RE.test(d.split(/[\\/]/).pop() ?? ""));
		monthDirs.sort((a, b) => b.localeCompare(a));
		for (const monthDir of monthDirs) {
			if (visited >= MAX_PREFERRED_DIRS) break;
			visited += 1;
			for (const imgDir of listChildDirs(monthDir)) {
				if ((imgDir.split(/[\\/]/).pop() ?? "").toLowerCase() !== "img") continue;
				if (visited >= MAX_PREFERRED_DIRS) break;
				visited += 1;
				preferred.push(...offerRecentTemplates(imgDir, discoveryCapacity));
			}
		}
	}
	preferred.sort((a, b) => b.mtimeNs - a.mtimeNs);
	let templates = preferred.slice(0, limit);
	let filesScanned = preferred.length;
	let usedFallback = false;
	if (templates.length === 0 && maxFallbackDirs > 0) {
		usedFallback = true;
		const queue = [
			"msg",
			"cache",
			"resource"
		].map((name) => join(accountDir, name)).filter((d) => {
			try {
				return statSync(d).isDirectory();
			} catch {
				return false;
			}
		});
		const fallback = [];
		let queueIndex = 0;
		while (queueIndex < queue.length && queueIndex < maxFallbackDirs) {
			const directory = queue[queueIndex];
			if (directory === void 0) break;
			queueIndex += 1;
			fallback.push(...offerRecentTemplates(directory, discoveryCapacity));
			const children = listChildDirs(directory);
			children.sort((a, b) => a.localeCompare(b));
			for (const child of children) {
				const lower = (child.split(/[\\/]/).pop() ?? "").toLowerCase();
				if (SKIPPED_FALLBACK_DIR_PARTS.some((part) => lower.includes(part))) continue;
				if (queue.length >= maxFallbackDirs) break;
				queue.push(child);
			}
		}
		fallback.sort((a, b) => b.mtimeNs - a.mtimeNs);
		templates = fallback.slice(0, limit);
		filesScanned += fallback.length;
	}
	const { xor, support } = inferXorWithSupport(templates.map((t) => t.tailBytes));
	return {
		templates,
		inferredXorKey: xor,
		usedFallback,
		filesScanned,
		xorSupport: support
	};
}
/**
* Trusted XOR for a verified AES key across templates.
* @param aesKey - candidate AES key.
* @param templateData - V2 template scan or template list.
* @returns the trusted XOR byte, or null.
*/
function trustedXorForVerifiedAesKey(aesKey, templateData) {
	const templates = Array.isArray(templateData) ? templateData : templateData.templates;
	if (templates.length === 0) return null;
	const current = templates[0];
	if (current === void 0) return null;
	if (detectImageFormat(decryptAesBlock(aesKey, current.ciphertext)) === null) return null;
	const matching = [];
	for (const template of templates) if (detectImageFormat(decryptAesBlock(aesKey, template.ciphertext)) === "jpeg" && template.tailXorKey !== null) matching.push(template.tailXorKey);
	if (matching.length === 0) return null;
	const counts = /* @__PURE__ */ new Map();
	for (const x of matching) counts.set(x, (counts.get(x) ?? 0) + 1);
	let best = null;
	let bestCount = 0;
	for (const [x, count] of counts) if (count > bestCount) {
		best = x;
		bestCount = count;
	}
	return best;
}
/** kvcomm cache file pattern: `key_<code>_…_input.statistic` (4.x) or `<code>_…_input.statistic`. */
const KVCOMM_FILE_RE = /^(?:key_)?(\d+)_.+\.statistic$/i;
/**
* Enumerate kvcomm codes from `*_input.statistic` file names in the WeChat 4.x
* kvcomm cache dir (`%APPDATA%/Tencent/xwechat/net/kvcomm`).
* @param kvcommDir - kvcomm cache directory.
* @returns unique codes, empty when none.
*/
function kvcommCodesFromDir(kvcommDir) {
	const codes = [];
	try {
		for (const entry of readdirSync(kvcommDir, { withFileTypes: true })) {
			if (!entry.isFile()) continue;
			const match = KVCOMM_FILE_RE.exec(entry.name);
			if (!match) continue;
			const code = parseInt(match[1] ?? "", 10);
			if (code > 0 && code <= MAX_CODE && !codes.includes(code)) codes.push(code);
		}
	} catch {
		return [];
	}
	return codes;
}
/**
* Resolve the first code/wxid pair that passes real V2 AES validation.
* @param opts - kvcomm dir, account dir and optional hints.
* @returns the verified resolution, or null.
*/
function resolveLocalImageKey(opts) {
	const { kvcommDir, accountDir, targetWxid, account, localNativeWxids } = opts;
	const templateLimit = opts.templateLimit ?? 32;
	const maxFallbackDirs = opts.maxFallbackDirs ?? 500;
	const codes = kvcommCodesFromDir(kvcommDir);
	if (codes.length === 0) return null;
	const nativeValues = [];
	if (typeof localNativeWxids === "string") nativeValues.push(localNativeWxids);
	else if (localNativeWxids) nativeValues.push(...localNativeWxids);
	nativeValues.push(accountDir.split(/[\\/]/).pop() ?? "");
	const wxids = [];
	const seen = /* @__PURE__ */ new Set();
	for (const raw of [
		targetWxid,
		account,
		...nativeValues,
		"unknown"
	]) {
		const value = cleanWxid(raw);
		if (value === "" || seen.has(value)) continue;
		seen.add(value);
		wxids.push(value);
	}
	const templateData = scanV2Templates(accountDir, templateLimit, maxFallbackDirs);
	if (templateData.templates.length === 0) return null;
	const current = templateData.templates[0];
	if (current === void 0) return null;
	const currentXorKey = templateData.inferredXorKey !== null && templateData.xorSupport >= 2 ? templateData.inferredXorKey : current.tailXorKey;
	const orderedCodes = [...codes];
	if (currentXorKey !== null) orderedCodes.sort((a, b) => ((a & 255) !== currentXorKey ? 1 : 0) - ((b & 255) !== currentXorKey ? 1 : 0));
	for (const wxid of wxids) for (const code of orderedCodes) {
		const keys = deriveImageKeys(code, wxid);
		if (!verifyAesKey(keys.aesKey, current.ciphertext)) continue;
		return {
			code,
			wxid: cleanWxid(wxid),
			xorKey: keys.xorKey,
			aesKey: keys.aesKey,
			verified: true,
			templatePath: current.path,
			inferredXorKey: currentXorKey
		};
	}
	return null;
}
//#endregion
//#region lib/types/keys/image-key-memory-scan.js
/**
* Verified WeChat image-key recovery from Windows process memory, migrated
* from WeChatDataAnalysis `image_key_memory_scan.py`. A memory candidate is
* never returned until its first 16 ASCII bytes decrypt a real V2 image block
* and the XOR evidence agrees.
*/
/** Chunk size for memory reads. */
const MEMORY_CHUNK_SIZE = 4 * 1024 * 1024;
/**
* Yield first-16-byte AES keys from exact 32-character memory runs.
* @param data - memory chunk.
* @returns candidate keys with their encoding.
*/
function iterMemoryAesCandidates(data) {
	const seen = /* @__PURE__ */ new Set();
	const out = [];
	let i = 0;
	while (i < data.length) {
		const byte = data[i] ?? 0;
		if (byte >= 48 && byte <= 57 || byte >= 65 && byte <= 90 || byte >= 97 && byte <= 122) {
			let end = i + 1;
			while (end < data.length) {
				const b = data[end] ?? 0;
				if (b >= 48 && b <= 57 || b >= 65 && b <= 90 || b >= 97 && b <= 122) end += 1;
				else break;
			}
			if (end - i === 32) {
				const key = data.subarray(i, i + 16).toString("ascii");
				if (!seen.has(key)) {
					seen.add(key);
					out.push({
						key,
						encoding: "ascii"
					});
				}
			}
			i = end;
		} else i += 1;
	}
	i = 0;
	while (i + 1 < data.length) {
		const byte = data[i] ?? 0;
		if ((byte >= 48 && byte <= 57 || byte >= 65 && byte <= 90 || byte >= 97 && byte <= 122) && data[i + 1] === 0) {
			let end = i + 2;
			while (end + 1 < data.length) {
				const b = data[end] ?? 0;
				if ((b >= 48 && b <= 57 || b >= 65 && b <= 90 || b >= 97 && b <= 122) && data[end + 1] === 0) end += 2;
				else break;
			}
			if (end - i === 64) {
				const raw = Buffer.alloc(32);
				for (let j = 0; j < 32; j += 1) raw[j] = data[i + j * 2] ?? 0;
				const key = raw.subarray(0, 16).toString("ascii");
				if (!seen.has(key)) {
					seen.add(key);
					out.push({
						key,
						encoding: "utf-16le"
					});
				}
			}
			i = end;
		} else i += 1;
	}
	return out;
}
/**
* Find the first candidate verified by the newest V2 template + XOR evidence.
* @param data - memory chunk.
* @param templateScan - V2 template scan with XOR evidence.
* @returns the verified match, or null.
*/
function findVerifiedAesKeyInChunk(data, templateScan) {
	const template = templateScan.templates[0];
	if (template === void 0) return null;
	for (const { key, encoding } of iterMemoryAesCandidates(data)) if (trustedXorForVerifiedAesKey(key, templateScan) !== null) return {
		aesKey: key,
		templatePath: template.path,
		encoding
	};
	return null;
}
/**
* Scan one process's committed writable regions for a verified image AES key.
* @param pid - WeChat process id.
* @param templateScan - V2 template scan (must contain XOR evidence).
* @returns the verified key match, or null.
*/
async function scanProcessForImageKey(pid, templateScan) {
	if (templateScan.templates.length === 0) return null;
	if (!templateScan.templates.some((t) => t.tailXorKey !== null)) return null;
	const scan = await enumerateScannableRegions(pid);
	if (scan === null) return null;
	const { api, handle, regions } = scan;
	try {
		for (const region of regions) {
			let offset = 0;
			let trailing = Buffer.alloc(0);
			while (offset < region.size) {
				const requestSize = Math.min(MEMORY_CHUNK_SIZE, region.size - offset);
				const chunk = api.readMemory(handle, region.baseAddress + offset, requestSize);
				if (chunk.length === 0) {
					trailing = Buffer.alloc(0);
					offset += requestSize;
					continue;
				}
				const fullRead = chunk.length === requestSize;
				const data = Buffer.concat([trailing, chunk]);
				const match = findVerifiedAesKeyInChunk(data, templateScan);
				if (match !== null) return match;
				if (fullRead) trailing = data.subarray(-68);
				else trailing = Buffer.alloc(0);
				offset += requestSize;
			}
		}
		return null;
	} finally {
		api.closeHandle(handle);
	}
}
/**
* Poll one process's memory once for the image key (synchronous convenience
* wrapper around {@link scanProcessForImageKey}).
* @param pid - WeChat process id.
* @param templateScan - V2 template scan.
* @returns the verified match or null.
*/
async function scanImageKeyOnce(pid, templateScan) {
	return scanProcessForImageKey(pid, templateScan);
}
//#endregion
//#region lib/types/dirs.js
/**
* WeChat data root resolution + one-time bootstrap.
*
* The migrated plugin owns its data under the DeepSeek Harness home instead
* of reading st_control's working tree in place. The root is
* `$DSH_HOME/wechat-data` (default `~/.dsh/wechat-data`), overridable with
* `DSH_WECHAT_DATA_DIR`. Inside the root the layout mirrors st_control's
* `data/wechat` directory so the query modules keep working unchanged:
*
*   <root>/decrypted/          decrypted SQLite libraries (read)
*   <root>/decoded_images/     decoded image cache (read/write)
*   <root>/message_edits.db    edit store (write)
*   <root>/daily_summary.db    daily-summary store (write)
*   <root>/wechat_search.db    search index (write)
*   <root>/backups/            backup snapshots (write)
*   <root>/exports/            CSV/TXT exports (write)
*   <root>/config.json         WeChat config (read/write)
*   <root>/all_keys.json       generated keys info (write)
*
* On first use the root is bootstrapped from the source `data/wechat`
* directory (default `C:/Users/28361/Desktop/ST/st_control/data/wechat`,
* overridable with `DSH_WECHAT_SOURCE_DIR`): `decrypted`, `decoded_images`
* and existing write stores are copied once; later runs read/write only the
* DSH-owned root. Legacy env overrides `DSH_WECHAT_DECRYPTED_DIR` /
* `DSH_WECHAT_DECODED_DIR` bypass the root entirely (explicit user pinning).
*/
/** Legacy explicit override env var for the decrypted dir (bypasses the root). */
const DECRYPTED_DIR_ENV = "DSH_WECHAT_DECRYPTED_DIR";
/** Legacy explicit override env var for the decoded images dir. */
const DECODED_DIR_ENV = "DSH_WECHAT_DECODED_DIR";
/** Data-root override env var (highest precedence over the DSH home default). */
const DATA_DIR_ENV = "DSH_WECHAT_DATA_DIR";
/** Bootstrap source override env var. */
const SOURCE_DIR_ENV = "DSH_WECHAT_SOURCE_DIR";
/** Subdirectories/files copied from the source during bootstrap. */
const BOOTSTRAP_ITEMS = [
	"decrypted",
	"decoded_images",
	"message_edits.db",
	"daily_summary.db",
	"wechat_search.db",
	"wechat_tasks.db",
	"config.json",
	"all_keys.json"
];
/** Suffixes that must never be copied (SQLite runtime artifacts). */
const SKIP_SUFFIXES = ["-wal", "-shm"];
/** True when a name is a SQLite runtime artifact (e.g. session.db-wal). */
function isRuntimeArtifact(name) {
	return SKIP_SUFFIXES.some((suffix) => name.endsWith(suffix));
}
/**
* Resolve the plugin-owned WeChat data root.
* @param env - environment mapping (defaults to process.env).
* @returns the absolute data root path.
*/
function resolveWechatDataRoot(env = process.env) {
	const explicit = env[DATA_DIR_ENV];
	if (explicit !== void 0 && explicit.trim().length > 0) return resolve(explicit.trim());
	return resolve(join(resolveDshHome(void 0, env), "wechat-data"));
}
/**
* Resolve the decrypted-dir the queries read.
* @param env - environment mapping.
* @returns explicit override when pinned, otherwise `<root>/decrypted`.
*/
function resolveDecryptedDir(env = process.env) {
	const pinned = env[DECRYPTED_DIR_ENV];
	if (pinned !== void 0 && pinned.trim().length > 0) return resolve(pinned.trim());
	return join(resolveWechatDataRoot(env), "decrypted");
}
/**
* Resolve the decoded-images cache dir.
* @param env - environment mapping.
* @returns explicit override when pinned, otherwise `<root>/decoded_images`.
*/
function resolveDecodedDir(env = process.env) {
	const pinned = env[DECODED_DIR_ENV];
	if (pinned !== void 0 && pinned.trim().length > 0) return resolve(pinned.trim());
	return join(resolveWechatDataRoot(env), "decoded_images");
}
/**
* Resolve the bootstrap source directory.
* @param env - environment mapping.
* @returns the source dir, or null when unset/empty.
*/
function resolveSourceDir(env = process.env) {
	const explicit = env[SOURCE_DIR_ENV];
	if (explicit !== void 0 && explicit.trim().length > 0) return resolve(explicit.trim());
	return null;
}
/**
* Recursively copy a directory/file skipping SQLite -wal/-shm runtime files.
* @param src - source path.
* @param dest - destination path.
*/
function copyTree(src, dest) {
	if (!statSync(src).isDirectory()) {
		if (!isRuntimeArtifact(src.split(/[\\/]/).pop() ?? "")) cpSync(src, dest, { recursive: false });
		return;
	}
	mkdirSync(dest, { recursive: true });
	for (const entry of readdirSync(src, { withFileTypes: true })) {
		if (isRuntimeArtifact(entry.name)) continue;
		copyTree(join(src, entry.name), join(dest, entry.name));
	}
}
/**
* One-time bootstrap: copy `decrypted`/`decoded_images` and any existing
* write stores from the source into the DSH-owned data root. Idempotent —
* a root that already contains `decrypted` is left untouched. Explicit
* legacy overrides bypass the root, so nothing is copied in that mode.
* @param env - environment mapping.
* @returns what was copied (or skipped), for observability.
*/
function bootstrapWechatData(env = process.env) {
	const root = resolveWechatDataRoot(env);
	if (env["DSH_WECHAT_DECRYPTED_DIR"] !== void 0 && env["DSH_WECHAT_DECRYPTED_DIR"].trim().length > 0) return {
		root,
		copied: [],
		skipped: true
	};
	if (existsSync(join(root, "decrypted"))) return {
		root,
		copied: [],
		skipped: true
	};
	const source = resolveSourceDir(env);
	if (source === null || !existsSync(source)) return {
		root,
		copied: [],
		skipped: true
	};
	const copied = [];
	for (const item of BOOTSTRAP_ITEMS) {
		const src = join(source, item);
		const dest = join(root, item);
		if (!existsSync(src)) continue;
		copyTree(src, dest);
		copied.push(item);
	}
	return {
		root,
		copied,
		skipped: false
	};
}
//#endregion
//#region lib/types/keys/key-store.js
/**
* Key-store persistence for recovered WeChat account keys, migrated from
* WeChatDataAnalysis `key_store.py`. The store lives in the DSH-owned
* WeChat data root (see dirs.ts) as `keys.json`, written atomically.
*/
/** File name of the key store inside the data root. */
const KEY_STORE_FILE = "keys.json";
/**
* Resolve the key-store path for a data root.
* @param dataRoot - DSH wechat data root.
* @returns the absolute keys.json path.
*/
function keyStorePath(dataRoot = resolveWechatDataRoot()) {
	return join(dataRoot, KEY_STORE_FILE);
}
/**
* Read the whole key store (empty object when absent or corrupt).
* @param dataRoot - DSH wechat data root.
* @returns the parsed store.
*/
function loadAccountKeysStore(dataRoot = resolveWechatDataRoot()) {
	const p = keyStorePath(dataRoot);
	if (!existsSync(p)) return {};
	try {
		const raw = JSON.parse(readFileSync(p, "utf8"));
		return typeof raw === "object" && raw !== null ? raw : {};
	} catch {
		return {};
	}
}
/** Atomically replace the store file (write tmp then rename). */
function atomicWriteJson(file, payload) {
	mkdirSync(dirname(file), { recursive: true });
	const tmp = file + ".tmp";
	writeFileSync(tmp, JSON.stringify(payload, null, 2), "utf8");
	renameSync(tmp, file);
}
/**
* Upsert one account's keys into the store.
* @param account - canonical account id (wxid).
* @param patch - fields to set (undefined fields are left untouched).
* @param dataRoot - DSH wechat data root.
* @returns the updated primary record.
*/
function upsertAccountKeysInStore(account, patch, dataRoot = resolveWechatDataRoot()) {
	const name = account.trim();
	if (name === "") return {};
	const store = loadAccountKeysStore(dataRoot);
	const item = { ...store[name] ?? {} };
	for (const [k, v] of Object.entries(patch)) {
		if (v === void 0) continue;
		item[k] = v;
	}
	item.updated_at = (/* @__PURE__ */ new Date()).toISOString();
	store[name] = item;
	atomicWriteJson(keyStorePath(dataRoot), store);
	return { ...item };
}
//#endregion
//#region lib/types/keys/service.js
/**
* Key-service orchestration, migrated from WeChatDataAnalysis
* `key_service.py` (the parts that do not depend on the wx_key Python
* package). Finds the running WeChat process, scans Weixin.dll for the
* internal DB key, recovers the V4 database key from process memory, and
* recovers the image key from process memory — persisting results into the
* DSH-owned key store.
*/
/** WeChat main executable names. */
const WECHAT_EXECUTABLE_NAMES = ["weixin.exe", "wechat.exe"];
/** Default WeChat install paths to probe for Weixin.dll. */
function defaultWeixinDllCandidates() {
	const out = ["C:/Program Files/Tencent/Weixin/Weixin.dll", "C:/Program Files (x86)/Tencent/Weixin/Weixin.dll"];
	const userProfile = process.env.USERPROFILE;
	if (userProfile) out.push(join(userProfile, "AppData", "Roaming", "Tencent", "Weixin", "Weixin.dll"));
	return out;
}
/**
* Find the running WeChat main-process pid via tasklist.
* @returns the first matching pid, or null.
*/
function findWechatPid() {
	try {
		const out = execFileSync("tasklist", [
			"/FO",
			"CSV",
			"/NH"
		], {
			encoding: "utf8",
			windowsHide: true
		});
		for (const line of out.split(/\r?\n/)) {
			const match = /^"([^"]+)"\s*,\s*"(\d+)"/.exec(line.trim());
			if (!match) continue;
			const name = (match[1] ?? "").toLowerCase();
			if (WECHAT_EXECUTABLE_NAMES.includes(name)) return parseInt(match[2] ?? "", 10);
		}
		return null;
	} catch {
		return null;
	}
}
/**
* Scan Weixin.dll for the internal DB key used to unmask V4 candidates.
* @param wechatInstallDir - optional explicit install dir (may be the version
* folder or its parent; version subdirectories are probed too).
* @returns the first 32-byte internal key, or null.
*/
function scanDllInternalKey(wechatInstallDir) {
	const candidates = [];
	if (wechatInstallDir) {
		candidates.push(join(wechatInstallDir, "Weixin.dll"));
		try {
			for (const entry of readdirSync(wechatInstallDir, { withFileTypes: true })) if (entry.isDirectory() && /^\d+\.\d+\.\d+/.test(entry.name)) candidates.push(join(wechatInstallDir, entry.name, "Weixin.dll"));
		} catch {}
	}
	const base = process.env.DSH_WECHAT_BASE_DIR;
	if (base) candidates.push(join(base, "Weixin.dll"));
	candidates.push(...defaultWeixinDllCandidates());
	for (const p of candidates) {
		if (!existsSync(p)) continue;
		try {
			const first = extractXorKeysFromDll(p)[0];
			if (first?.keyHex) return Buffer.from(first.keyHex, "hex");
		} catch {}
	}
	return null;
}
/** Pick a V4 probe DB from the decrypted root (first candidate found). */
function pickProbeDb(decrypted, explicit) {
	if (explicit && existsSync(explicit)) return explicit;
	for (const name of [
		"msg0.db",
		"msg.db",
		"micromsg.db",
		"favorite.db",
		"mediamsg0.db",
		"msg0.db"
	]) {
		const p = join(decrypted, name);
		if (existsSync(p)) return p;
	}
	const msgDir = join(decrypted, "message");
	if (existsSync(msgDir)) {
		for (const f of readdirSync(msgDir)) if (f.endsWith(".db") && !f.includes("-wal") && !f.includes("-shm")) return join(msgDir, f);
	}
	return null;
}
/**
* Recover the V4 database key for the running WeChat process.
* @param opts - optional db probe path and install dir.
* @returns the recovered key result.
*/
async function fetchDbKey(opts = {}) {
	const pid = findWechatPid();
	if (pid === null) return {
		ok: false,
		error: "未检测到运行中的微信进程（Weixin.exe/WeChat.exe）"
	};
	const probe = pickProbeDb(resolveDecryptedDir(), opts.dbPath);
	if (probe === null) return {
		ok: false,
		error: "找不到可用于校验的 V4 加密数据库"
	};
	const result = await recoverDbKeyV4(pid, probe, scanDllInternalKey(opts.wechatInstallDir));
	if (result.ok && result.key) upsertAccountKeysInStore("default", {
		db_key: result.key,
		db_key_source_db_storage_path: dirname(probe)
	});
	return result;
}
/**
* Coerce the account dir to the wxid_* account root: a db_dir pointing at
* `db_storage` is lifted to its parent, because the V2 template cache lives
* under `<root>/msg/attach` (not under db_storage).
* @param accountDir - as passed by callers (db_dir or account root).
* @returns the account root, '' when nothing usable.
*/
function normalizeAccountDir(accountDir) {
	const dir = (accountDir || "").replace(/[\\/]+$/, "");
	if (!dir) return "";
	return (dir.split(/[\\/]/).pop() ?? "").toLowerCase() === "db_storage" ? dirname(dir) : dir;
}
/**
* WeChat 4.x kvcomm cache dir. The image key is derived from the kvcomm code
* (`md5(code + clean_wxid)[:16]`, XOR = `code & 0xFF`), and the codes are the
* decimal prefixes of `*_input.statistic` file names under this dir.
* @returns the kvcomm cache dir, '' when unavailable.
*/
function kvcommCacheDir() {
	const appData = process.env.APPDATA;
	return appData ? join(appData, "Tencent", "xwechat", "net", "kvcomm") : "";
}
/**
* Recover the image key: kvcomm-cache derivation first (WeChat 4.x on-disk
* cache, no injection), then the V2-verified process memory scan.
* @param opts - account dir (wxid folder) and optional pid.
* @returns the verified image key result.
*/
async function fetchImageKey(opts = {}) {
	const pid = opts.pid ?? findWechatPid();
	if (pid === null || pid <= 0) return {
		ok: false,
		error: "未检测到运行中的微信进程"
	};
	const accountDir = normalizeAccountDir(opts.accountDir ?? "");
	if (!accountDir || !existsSync(accountDir)) return {
		ok: false,
		error: "未提供有效账号数据目录（wxid_* 文件夹）"
	};
	const kvDir = kvcommCacheDir();
	if (existsSync(kvDir)) {
		const localWxids = detectWechatAccounts().map((a) => a.wxid);
		const resolution = resolveLocalImageKey({
			kvcommDir: kvDir,
			accountDir,
			account: basename(accountDir),
			localNativeWxids: localWxids
		});
		if (resolution !== null) {
			const result = {
				ok: true,
				aesKey: resolution.aesKey,
				xorKey: resolution.xorKey,
				verified: true,
				wxid: resolution.wxid,
				code: resolution.code,
				templatePath: resolution.templatePath
			};
			upsertAccountKeysInStore("default", {
				image_aes_key: resolution.aesKey,
				image_xor_key: String(resolution.xorKey),
				image_key_verified: true,
				image_key_source: "kvcomm",
				image_key_derived_wxid: resolution.wxid,
				image_key_code: resolution.code
			});
			return result;
		}
	}
	const templateScan = scanV2Templates(accountDir);
	if (templateScan.templates.length === 0) return {
		ok: false,
		error: "未找到 V2 图片模板（_t.dat），无法验证图片密钥"
	};
	const match = await scanImageKeyOnce(pid, templateScan);
	if (match === null) return {
		ok: false,
		error: "进程内存中未找到通过 V2 验证的图片 AES 密钥"
	};
	const xorKey = trustedXorForVerifiedAesKey(match.aesKey, templateScan) ?? 0;
	const result = {
		ok: true,
		aesKey: match.aesKey,
		xorKey,
		verified: true,
		templatePath: match.templatePath
	};
	upsertAccountKeysInStore("default", {
		image_aes_key: match.aesKey,
		image_xor_key: String(xorKey),
		image_key_verified: true,
		image_key_source: "memory_v2"
	});
	return result;
}
//#endregion
//#region lib/types/query/decrypt-all.js
/**
* Full SQLCipher decyption of the WeChat raw db_storage tree into the
* decrypted snapshot (one-call "立即解密"). Per database: page-1 salt →
* PBKDF2-HMAC-SHA512(256000) derive (wx_key_v4.1) → AES-256-CBC page stream
* decrypt → atomic publish at `<decrypted>/<rel>` with a SQLite-header check.
* Reuses the same layout as sync.ts so the realtime watchers keep working.
*/
const PBKDF2_ITERS = 256e3;
const SQLITE_HDR = Buffer.from("SQLite format 3\0");
/** Read exactly the first n bytes (readFileSync cannot bound a read). */
function readPrefix(file, n) {
	const fd = openSync(file, "r");
	const buf = Buffer.alloc(n);
	let filled = 0;
	try {
		while (filled < n) {
			const r = readSync(fd, buf, filled, n - filled, null);
			if (r === 0) break;
			filled += r;
		}
	} finally {
		closeSync(fd);
	}
	return buf.subarray(0, filled);
}
/** Raw key hex for one database: all_keys.json entry first, config fallback. */
function rawKeyHexFor(decryptedDir, rel, fallbackHex) {
	try {
		const keysPath = join(decryptedDir, "..", "all_keys.json");
		if (existsSync(keysPath)) {
			const entry = JSON.parse(readPrefix(keysPath, 1024 * 1024).toString("utf8"))[rel.replace(/\\/g, "/")];
			if (typeof entry?.["key"] === "string" && entry["key"].length === 64) return entry["key"];
		}
	} catch {}
	return fallbackHex;
}
/** Derive the per-database AES-256 key (wx_key_v4.1 PBKDF2, else raw). */
function deriveEncKey(rawKey, salt, keyFormat) {
	if (keyFormat === "wx_key_v4.1") return pbkdf2Sync(rawKey, salt, PBKDF2_ITERS, 32, "sha512");
	return rawKey;
}
/**
* Decrypt every .db under the raw db_storage tree into the decrypted root.
* Yields between databases so a progress-polling RPC stays served.
* @param rawDbDir - raw WeChat db_storage dir (from config db_dir).
* @param decryptedDir - decrypted snapshot root (target mirrors db_storage).
* @param onProgress - per-database progress callback (done/total/failed/message).
* @returns ok + success/failure counts (per-db failures never abort the run).
*/
async function decryptAllDbs(rawDbDir, decryptedDir, onProgress) {
	if (!rawDbDir || !existsSync(rawDbDir)) return {
		ok: false,
		total: 0,
		okCount: 0,
		failed: [],
		error: rawDbDir
			? `数据库目录不存在（${rawDbDir}）。请确认「数据配置」中的数据库目录指向真实的 db_storage，或使用「检测账号」自动选择。`
			: '数据库目录未配置。请先在「数据配置」中检测账号或填写数据库目录（…\\xwechat_files\\<wxid>\\db_storage）。'
	};
	const cfg = getConfig(decryptedDir);
	const rawKeyHex = typeof cfg["db_enc_key"] === "string" ? cfg["db_enc_key"].trim() : "";
	if (!rawKeyHex || rawKeyHex.length !== 64) return {
		ok: false,
		total: 0,
		okCount: 0,
		failed: [],
		error: "未配置 64 位数据库密钥（请先获取密钥）"
	};
	const keyFormat = typeof cfg["key_format"] === "string" ? cfg["key_format"] : "wx_key_v4.1";
	if (Buffer.from(rawKeyHex, "hex").length !== 32) return {
		ok: false,
		total: 0,
		okCount: 0,
		failed: [],
		error: "数据库密钥不是合法的 64 位 hex"
	};
	const dbs = scanDbFiles(rawDbDir);
	const failed = [];
	let okCount = 0;
	let done = 0;
	for (const db of dbs) {
		const rel = relative(rawDbDir, db).replace(/\\/g, "/");
		const target = join(decryptedDir, rel);
		const staged = target + ".decrypt_tmp";
		try {
			mkdirSync(dirname(target), { recursive: true });
			const salt = readPrefix(db, 16);
			if (salt.length < 16) throw new Error("文件过小");
			const keyHex = rawKeyHexFor(decryptedDir, rel, rawKeyHex);
			if (keyHex.length !== 64) throw new Error("db_enc_key 缺失");
			await fullDecryptFile(db, staged, deriveEncKey(Buffer.from(keyHex, "hex"), salt, keyFormat));
			if (!readPrefix(staged, 15).equals(SQLITE_HDR.subarray(0, 15))) throw new Error("解密结果校验失败（密钥不匹配？）");
			try {
				unlinkSync(target);
			} catch {}
			renameSync(staged, target);
			okCount += 1;
		} catch (e) {
			try {
				unlinkSync(staged);
			} catch {}
			failed.push({
				db: rel,
				error: e.message
			});
		}
		done += 1;
		onProgress?.(done, dbs.length, failed.length, rel);
		await new Promise((resolve) => {
			setImmediate(resolve);
		});
	}
	return {
		ok: failed.length === 0,
		total: dbs.length,
		okCount,
		failed
	};
}
//#endregion
//#region lib/types/query/decrypt-images.js
/**
* Batch decryption of WeChat .dat image files (V2/V1 encrypted, md5-prefixed
* file names under msg/attach) into the decoded_images cache:
* `<decoded_images>/<md5>.<ext>`, the same layout decodeImageDataUrl reads,
* so a batch pass makes per-message lookups hit the cache instantly.
*/
/** Image-dat file names start with the content md5: `<md5>[_t|_h].dat`. */
const MD5_PREFIX_RE = /^([0-9a-f]{32})/i;
/** Browser-renderable output extensions (hevc/wxgf skipped, counted). */
const WRITE_EXTS = new Set([
	"jpg",
	"png",
	"gif",
	"webp"
]);
/** Prefer full images over thumbnails for the same md5 (0 best). */
function scoreDatPath(p) {
	if (p.endsWith("_t.dat")) return 2;
	if (p.endsWith("_h.dat")) return 1;
	return 0;
}
/** Recursively collect md5-prefixed .dat files under msg/attach. */
function walkDataDats(dir, out, depth) {
	if (depth > 10 || !existsSync(dir)) return;
	let entries;
	try {
		entries = readdirSync(dir, { withFileTypes: true }).map((e) => ({
			name: e.name,
			isDir: e.isDirectory()
		}));
	} catch {
		return;
	}
	for (const e of entries) {
		const p = join(dir, e.name);
		if (e.isDir) walkDataDats(p, out, depth + 1);
		else if (e.name.toLowerCase().endsWith(".dat") && MD5_PREFIX_RE.test(e.name)) out.push(p);
	}
}
/**
* Decrypt every md5-prefixed .dat under `<rawRoot>/msg/attach` into the
* decoded-images cache with a bounded concurrent pool.
* @param rawRoot - raw WeChat account root (parent of db_storage).
* @param decodedDir - decoded-images cache root.
* @param aesKey - V2 AES key (16-char ASCII) or null.
* @param xorKey - XOR key byte.
* @param concurrency - worker count (clamped 1..32).
* @param onProgress - per-file progress callback (processed/total/failed/message).
* @returns total/ok/failed/skipped counts + per-file errors.
*/
async function decryptAllImageDats(rawRoot, decodedDir, aesKey, xorKey, concurrency = 8, onProgress) {
	const files = [];
	walkDataDats(join(rawRoot, "msg", "attach"), files, 0);
	files.sort((a, b) => scoreDatPath(a) - scoreDatPath(b));
	const aes = aesKey && aesKey.trim().length > 0 ? aesKey.trim() : null;
	let okCount = 0;
	let failed = 0;
	let skipped = 0;
	const errors = [];
	const skippedDetails = [];
	let cursor = 0;
	let processed = 0;
	const worker = async () => {
		for (;;) {
			const idx = cursor;
			cursor += 1;
			if (idx >= files.length) return;
			const file = files[idx];
			if (file === void 0) return;
			const name = file.split(/[\\/]/).pop() ?? "";
			const md5 = (MD5_PREFIX_RE.exec(name)?.[1] ?? "").toLowerCase();
			try {
				for (const ext of WRITE_EXTS) if (existsSync(join(decodedDir, md5 + "." + ext))) {
					skipped += 1;
					skippedDetails.push({
						file: name,
						reason: `已存在解码缓存（${md5}.${ext}），无需重复解码`
					});
					continue;
				}
				const bytes = await promises.readFile(file);
				const dec = decodeDatBytes(new Uint8Array(bytes), aes, xorKey);
				if ("error" in dec) {
					failed += 1;
					errors.push({
						file: name,
						error: dec.error
					});
					continue;
				}
				if (dec.format === "hevc") {
					skipped += 1;
					skippedDetails.push({
						file: name,
						reason: "HEVC 视频帧格式，当前环境暂不支持解码"
					});
					continue;
				}
				const ext = dec.format === "jpeg" ? "jpg" : dec.format;
				if (!WRITE_EXTS.has(ext)) {
					skipped += 1;
					skippedDetails.push({
						file: name,
						reason: `不支持的图片格式（${ext}），已跳过`
					});
					continue;
				}
				await promises.mkdir(decodedDir, { recursive: true });
				await promises.writeFile(join(decodedDir, md5 + "." + ext), Buffer.from(dec.bytes));
				okCount += 1;
			} catch (e) {
				failed += 1;
				errors.push({
					file: name,
					error: e.message
				});
			} finally {
				processed += 1;
				onProgress?.(processed, files.length, failed, name);
			}
		}
	};
	const pool = [];
	const workers = Math.max(1, Math.min(Math.floor(concurrency), 32));
	for (let i = 0; i < workers; i += 1) pool.push(worker());
	await Promise.all(pool);
	return {
		total: files.length,
		okCount,
		failed,
		skipped,
		errors,
		skippedDetails
	};
}
//#endregion
//#region lib/types/query/whisper.js
/**
* Whisper transcription configuration support: engine detection (whisper-cli
* binary or a user-pinned DSH_WECHAT_WHISPER_BIN), CUDA device presence, and
* model inventory scanned from the configured models dir. Inference runs
* locally in this package via whipser-cli (see voice-transcribe.ts); this
* module reports what is configured and available so the settings panel can
* offer a real model/device/threads configuration.
*/
/** Whisper model catalog (id/name/size labels). */
const WHISPER_MODELS = [
	{
		id: "tiny",
		name: "Tiny",
		sizeLabel: "约 75 MB · 最快"
	},
	{
		id: "base",
		name: "Base",
		sizeLabel: "约 145 MB · 很快"
	},
	{
		id: "small",
		name: "Small",
		sizeLabel: "约 466 MB · 较快"
	},
	{
		id: "medium",
		name: "Medium",
		sizeLabel: "约 1.5 GB · 中等"
	},
	{
		id: "large-v3",
		name: "Large v3",
		sizeLabel: "约 3.1 GB · 较慢"
	},
	{
		id: "turbo",
		name: "Turbo",
		sizeLabel: "约 1.6 GB · 快"
	}
];
/** ggml model file per model id (whisper.cpp official release artifacts). */
const WHISPER_DOWNLOAD_FILES = [
	["tiny", "ggml-tiny.bin"],
	["base", "ggml-base.bin"],
	["small", "ggml-small.bin"],
	["medium", "ggml-medium.bin"],
	["large-v3", "ggml-large-v3.bin"],
	["turbo", "ggml-large-v3-turbo.bin"]
];
/** Base order: env pin first, then the cached reachable one, then official/mirror. */
function whisperDownloadBases() {
	const pinned = process.env.DSH_WECHAT_WHISPER_MIRROR;
	const bases = [];
	if (pinned && pinned.trim().length > 0) bases.push(pinned.trim().replace(/\/$/, ""));
	if (reachableBase) bases.push(reachableBase);
	bases.push("https://huggingface.co", "https://hf-mirror.com");
	return [...new Set(bases)];
}
/** First base that answered a download; remembered for subsequent models. */
let reachableBase = null;
/** Header-arrival timeout before a base is declared unreachable. */
const DOWNLOAD_CONNECT_TIMEOUT_MS = 2e4;
/**
* Move one file/dir to a target (same-volume rename first, copy+remove
* fallback). An existing destination directory is merged child-by-child and
* then removed; existing destination files are kept untouched.
* @returns the number of items moved (merged dirs count their moved children).
*/
function moveItem(src, dest) {
	try {
		if (existsSync(dest)) {
			if (!statSync(src).isDirectory()) return 0;
			let moved = 0;
			for (const entry of readdirSync(src, { withFileTypes: true })) moved += moveItem(join(src, entry.name), join(dest, entry.name));
			try {
				rmSync(src, {
					recursive: true,
					force: true
				});
			} catch {}
			return moved;
		}
		mkdirSync(dirname(dest), { recursive: true });
		try {
			renameSync(src, dest);
			return 1;
		} catch {
			cpSync(src, dest, { recursive: true });
			rmSync(src, {
				recursive: true,
				force: true
			});
			return 1;
		}
	} catch {}
	return 0;
}
/**
* Move engine binary + sibling engine DLLs sitting at a models-dir root
* (manual extraction), keeping existing targets.
* @returns the number of items moved.
*/
function moveTopLevelEngineFiles(fromDir, toDir) {
	let moved = 0;
	try {
		for (const entry of readdirSync(fromDir, { withFileTypes: true })) {
			if (entry.isDirectory()) continue;
			if (/^whisper(?:-cli)?(?:\.exe)?$/i.test(entry.name) || /^(?:ggml-.+|llama)\.dll$/i.test(entry.name)) moved += moveItem(join(fromDir, entry.name), join(toDir, entry.name));
		}
	} catch {}
	return moved;
}
/**
* Migrate downloaded models (ggml-*.bin), the engine install (bin/), and any
* top-level engine files (whisper-cli.exe / whisper.exe + sibling engine DLLs)
* from one models dir to another (best-effort, keeps existing targets).
* @param fromDir - old models dir.
* @param toDir - new models dir (created when missing).
* @returns ok + moved count, or an error description.
*/
function migrateWhisperModels(fromDir, toDir) {
	if (!fromDir || !toDir) return {
		ok: false,
		moved: 0,
		error: "目录为空"
	};
	if (fromDir.toLowerCase() === toDir.toLowerCase()) return {
		ok: true,
		moved: 0
	};
	if (!existsSync(fromDir)) return {
		ok: true,
		moved: 0
	};
	try {
		mkdirSync(toDir, { recursive: true });
		let moved = 0;
		for (const entry of readdirSync(fromDir, { withFileTypes: true })) {
			const src = join(fromDir, entry.name);
			if (entry.isDirectory()) {
				if (entry.name === "bin") moved += moveItem(src, join(toDir, "bin"));
				continue;
			}
			if (/^ggml-.+\.bin$/i.test(entry.name)) moved += moveItem(src, join(toDir, entry.name));
			if (entry.name === "whisper-bin-x64.zip" || entry.name === "whisper-bin-x64.zip.part") try {
				unlinkSync(src);
			} catch {}
		}
		moved += moveTopLevelEngineFiles(fromDir, toDir);
		try {
			rmSync(join(fromDir, ".engine-staging"), {
				recursive: true,
				force: true
			});
		} catch {}
		return {
			ok: true,
			moved
		};
	} catch (e) {
		return {
			ok: false,
			moved: 0,
			error: e.message
		};
	}
}
/**
* Move the engine install directory (the folder holding `binPath`, when it
* sits under `fromDir`) to the mirrored location under `toDir` and return the
* relocated binary path; '' when binPath is outside fromDir (external engine:
* left untouched). The move is best-effort — the returned path is the correct
* destination either way.
*/
function migrateWhisperEngineDir(binPath, fromDir, toDir) {
	if (!binPath || !fromDir || !toDir) return "";
	const from = fromDir.replace(/[\\/]+$/, "");
	const norm = binPath.replace(/[\\/]+$/, "");
	const f = from.toLowerCase().replaceAll("\\", "/");
	if (!norm.toLowerCase().replaceAll("\\", "/").startsWith(f + "/")) return "";
	const rel = norm.slice(from.length).split(/[\\/]+/).filter(Boolean);
	const dirSegs = rel.slice(0, -1);
	if (dirSegs.length > 0) moveItem(dirname(norm), join(toDir, ...dirSegs));
	else moveTopLevelEngineFiles(fromDir, toDir);
	return join(toDir, ...rel);
}
/** ggml file-name prefixes per model id (turbo before large-v3 — it shares the prefix). */
const MODEL_FILE_PREFIX = [
	["turbo", "ggml-large-v3-turbo"],
	["large-v3", "ggml-large-v3"],
	["medium", "ggml-medium"],
	["small", "ggml-small"],
	["base", "ggml-base"],
	["tiny", "ggml-tiny"]
];
/**
* Resolve one engine candidate: a file path (validated) or a dir that
* contains whisper-cli.exe / whisper.exe. An existing bare directory is not a
* valid engine — an empty `bin/` leftover must not count as installed.
* @returns the binary path, or '' when not present.
*/
function resolveEngineCandidate(candidate) {
	const c = candidate.trim();
	if (!c) return "";
	for (const name of [
		"whisper-cli.exe",
		"whisper.exe",
		"whisper-cli",
		"whisper"
	]) {
		const p = join(c, name);
		if (existsSync(p)) return p;
	}
	try {
		if (existsSync(c) && statSync(c).isFile()) return c;
	} catch {}
	return "";
}
/**
* Detect a local whisper CLI binary. Order: persisted config path → env pin →
* models-dir install location (bin/ + a bounded search so engine releases
* extracted into a subdir by earlier layouts still resolve) → PATH.
* The probe (stat + bounded dir search + PATH lookup) is cached per file
* fingerprint for a few seconds: the settings panel polls it while a
* download progresses, and the search only needs to re-run once the dirs
* actually change.
* @param configBin - persisted engine path from config (file or dir).
* @param modelsDir - models cache dir (the engine installs under bin/).
* @returns the binary path, or '' when none.
*/
function whisperEnginePath(configBin, modelsDir) {
	const binSig = configBin && /[/\\]/.test(configBin) ? fileSigOf(configBin) : "";
	const dirSig = modelsDir ? fileSigOf(modelsDir) : "";
	return cachedBySig("whisper-engine:" + (modelsDir ?? "") + "|" + (configBin ?? ""), `${binSig}|${dirSig}`, () => resolveWhisperEngine(configBin, modelsDir));
}
/** Uncached engine probe (see {@link whisperEnginePath}). */
function resolveWhisperEngine(configBin, modelsDir) {
	const candidates = [];
	if (configBin && configBin.trim().length > 0) candidates.push(configBin);
	const pinned = process.env.DSH_WECHAT_WHISPER_BIN;
	if (pinned && pinned.trim().length > 0) candidates.push(pinned);
	if (modelsDir) candidates.push(join(modelsDir, "bin"), join(modelsDir, "whisper-cli.exe"));
	for (const candidate of candidates) {
		const resolved = resolveEngineCandidate(candidate);
		if (resolved) return resolved;
	}
	if (modelsDir) {
		const found = findFile(modelsDir, "whisper-cli.exe");
		if (found) return found;
	}
	for (const name of ["whisper-cli", "whisper"]) try {
		const found = resolveCommand(name);
		if (found && existsSync(found)) return found;
	} catch {}
	return "";
}
/** Resolve one command name/path against PATH (where/which). */
function resolveCommand(cmd) {
	if (/[/\\]/.test(cmd)) return cmd;
	return execFileSync(process.platform === "win32" ? "where.exe" : "which", [cmd], {
		encoding: "utf8",
		windowsHide: true
	}).split(/\r?\n/).map((s) => s.trim()).find((s) => s.length > 0) ?? "";
}
/**
* CUDA device presence (nvidia-smi replies with a device list). Process-level
* memo: driver presence cannot change while the host runs, so probe once and
* reuse for an hour (the nvidia-smi subprocess is otherwise spawned on every
* settings-panel status poll).
* @returns true when an NVIDIA CUDA device/driver is available.
*/
function whisperHasCuda() {
	return cachedBySig("whisper-cuda", "static", () => {
		try {
			execFileSync("nvidia-smi", ["-L"], {
				encoding: "utf8",
				windowsHide: true
			});
			return true;
		} catch {
			return false;
		}
	}, 36e5);
}
/**
* Scan a models dir for installed ggml binaries.
* @param modelsDir - directory searched for `ggml-<id>[.*].bin`.
* @returns per-model installed flags + the catalog.
*/
function whisperModelsStatus(modelsDir) {
	return cachedBySig("whisper-models:" + modelsDir, fileSigOf(modelsDir), () => {
		let names = [];
		try {
			names = readdirSync(modelsDir);
		} catch {}
		return WHISPER_MODELS.map((m) => ({
			...m,
			installed: MODEL_FILE_PREFIX.some(([id, prefix]) => id === m.id && names.some((n) => n.toLowerCase().startsWith(prefix) && n.toLowerCase().endsWith(".bin")))
		}));
	});
}
/** Default models dir under the project `wechat/` directory. */
function defaultWhisperModelsDir(_decryptedDir) {
	const here = fileURLToPath(new URL(".", import.meta.url));
	return resolve(here, "..", "..", "..", "..", "wechat", "whisper");
}
/**
* Download and install the whisper.cpp CLI engine into
* `<modelsDir>/bin/whisper-cli.exe` (official release zip, streamed).
* @param modelsDir - models cache dir.
* @param onProgress - progress callback (bytes, total).
* @returns ok + binary path, or an error description.
*/
async function installWhisperEngine(modelsDir, onProgress) {
	const binDir = join(modelsDir, "bin");
	const target = join(binDir, "whisper-cli.exe");
	if (existsSync(target)) return {
		ok: true,
		path: target
	};
	mkdirSync(binDir, { recursive: true });
	const urls = [
		process.env.DSH_WECHAT_WHISPER_ENGINE_URL?.trim().replace(/\/$/, ""),
		"https://github.com/ggml-org/whisper.cpp/releases/latest/download/whisper-bin-x64.zip",
		"https://github.com/ggerganov/whisper.cpp/releases/latest/download/whisper-bin-x64.zip"
	].filter((u) => Boolean(u));
	let lastError = "引擎下载失败";
	for (const url of urls) {
		const zipPath = join(modelsDir, "whisper-bin-x64.zip");
		const ctrl = new AbortController();
		const timer = setTimeout(() => {
			ctrl.abort();
		}, 3e4);
		try {
			const res = await fetch(url, {
				redirect: "follow",
				signal: ctrl.signal
			});
			clearTimeout(timer);
			if (!res.ok || res.body === null) throw new Error(`HTTP ${res.status}`);
			const total = Number(res.headers.get("content-length") ?? 0);
			const reader = res.body.getReader();
			const stream = createWriteStream(zipPath);
			let received = 0;
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				stream.write(value);
				received += value.byteLength;
				onProgress(received, total);
			}
			await new Promise((resolve, reject) => {
				stream.end(() => {
					resolve();
				});
				stream.on("error", reject);
			});
			const extractedBase = await extractZip(zipPath, modelsDir);
			const found = findFile(extractedBase, "whisper-cli.exe");
			if (!found) throw new Error("压缩包内未找到 whisper-cli.exe");
			const releaseDir = dirname(found);
			mkdirSync(binDir, { recursive: true });
			for (const name of readdirSync(releaseDir)) {
				const src = join(releaseDir, name);
				const dest = join(binDir, name);
				if (existsSync(dest)) continue;
				try {
					renameSync(src, dest);
				} catch {}
				if (!existsSync(dest)) try {
					copyFileSync(src, dest);
					unlinkSync(src);
				} catch {}
			}
			try {
				rmSync(extractedBase, {
					recursive: true,
					force: true
				});
			} catch {}
			try {
				unlinkSync(zipPath);
			} catch {}
			return existsSync(target) ? {
				ok: true,
				path: target
			} : {
				ok: false,
				error: "whisper-cli.exe 安装失败（拷贝/移动未完成）"
			};
		} catch (e) {
			lastError = `${url} ${e.message}`;
			try {
				unlinkSync(zipPath);
			} catch {}
		} finally {
			clearTimeout(timer);
		}
	}
	return {
		ok: false,
		error: lastError + "（可设置 DSH_WECHAT_WHISPER_ENGINE_URL 指向可达镜像，或 DSH_WECHAT_WHISPER_BIN 指向已安装的 whisper-cli.exe）"
	};
}
/** Extract a zip into a staging dir; top folder name is ignored. */
async function extractZip(zipPath, destDir) {
	const staging = join(destDir, ".engine-staging");
	try {
		rmSync(staging, {
			recursive: true,
			force: true
		});
	} catch {}
	mkdirSync(staging, { recursive: true });
	if (spawnSync("tar.exe", [
		"-xf",
		zipPath,
		"-C",
		staging
	], { windowsHide: true }).status === 0) return staging;
	if (spawnSync("powershell.exe", [
		"-NoProfile",
		"-Command",
		`Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${staging}' -Force`
	], { windowsHide: true }).status === 0) return staging;
	// 最终兜底：纯 JS unzipper（不依赖系统 tar/PowerShell）。
	try {
		const nodeRequire = createRequire(import.meta.url);
		const unzipper = nodeRequire("unzipper");
		const zip = await unzipper.Open.file(zipPath);
		await zip.extract({ path: staging });
		return staging;
	} catch {
		throw new Error("解压失败（tar/PowerShell/unzipper 均不可用）");
	}
}
/**
* Deep search one filename under a dir (depth ≤ 4; dot-entries skipped so
* staging leftovers never resolve as an engine source).
*/
function findFile(dir, name, depth = 0) {
	if (depth > 4 || !existsSync(dir)) return "";
	try {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			if (entry.name.startsWith(".")) continue;
			const p = join(dir, entry.name);
			if (entry.isDirectory()) {
				const found = findFile(p, name, depth + 1);
				if (found) return found;
			} else if (entry.name.toLowerCase() === name.toLowerCase()) return p;
		}
	} catch {}
	return "";
}
/**
* Stream one official ggml model file into the models dir (atomic .part →
* rename), reporting received/total bytes.
* @param modelId - model id from the catalog.
* @param modelsDir - target models dir (created when missing).
* @param onProgress - per-chunk progress callback (bytes, total bytes).
* @returns ok + file/bytes, or an error description.
*/
async function whisperDownloadModel(modelId, modelsDir, onProgress) {
	const entry = WHISPER_DOWNLOAD_FILES.find(([id]) => id === modelId);
	if (!entry) return {
		ok: false,
		error: "未知模型: " + modelId
	};
	const file = entry[1];
	mkdirSync(modelsDir, { recursive: true });
	const finalPath = join(modelsDir, file);
	if (existsSync(finalPath)) return {
		ok: true,
		file,
		bytes: 0
	};
	let lastError = "下载失败";
	for (const base of whisperDownloadBases()) {
		const url = `${base}/ggerganov/whisper.cpp/resolve/main/${file}`;
		const tmp = join(modelsDir, file + ".part");
		let bytes = 0;
		let total = 0;
		try {
			const ctrl = new AbortController();
			const timer = setTimeout(() => {
				ctrl.abort();
			}, DOWNLOAD_CONNECT_TIMEOUT_MS);
			let res;
			try {
				res = await fetch(url, {
					redirect: "follow",
					signal: ctrl.signal
				});
			} finally {
				clearTimeout(timer);
			}
			if (!res.ok || res.body === null) throw new Error(`HTTP ${res.status}`);
			total = Number(res.headers.get("content-length") ?? 0);
			const reader = res.body.getReader();
			const stream = createWriteStream(tmp);
			let settled = false;
			try {
				for (;;) {
					const { done, value } = await reader.read();
					if (done) break;
					stream.write(value);
					bytes += value.byteLength;
					onProgress(bytes, total);
				}
				await new Promise((resolve, reject) => {
					stream.end(() => {
						resolve();
					});
					stream.on("error", reject);
				});
				settled = true;
			} finally {
				if (!settled) {
					try {
						stream.destroy();
					} catch {}
					try {
						unlinkSync(tmp);
					} catch {}
				}
			}
			renameSync(tmp, finalPath);
			reachableBase = base;
			return {
				ok: true,
				file,
				bytes
			};
		} catch (e) {
			lastError = `${base} ${e.message}`;
			try {
				unlinkSync(tmp);
			} catch {}
		}
	}
	return {
		ok: false,
		error: lastError
	};
}
//#endregion
//#region lib/types/query/voice.js
/**
* WeChat voice-message source helpers: media_0.db VoiceInfo rows (silk v3
* voice_data), Name2Id username mapping, and the wx_silk decoder process
* (pure-Rust SILK v3 → WAV, bundled under resources/win32/x64).
*/
function mediaDbPath(decryptedDir) {
	return join(decryptedDir, "message", "media_0.db");
}
/** Map a chat_name_id (Name2Id rowid) to its user_name. */
function usernameByChatId(decryptedDir, chatId) {
	try {
		const db = new DatabaseSync(mediaDbPath(decryptedDir), { readOnly: true });
		const row = db.prepare("SELECT user_name FROM Name2Id WHERE rowid = CAST(? AS INTEGER) LIMIT 1").get(chatId);
		db.close();
		if (row && typeof row.user_name === "string") return row.user_name;
	} catch {}
	return "";
}
/** Most recent voice messages (newest first). */
function recentVoiceMessages(decryptedDir, limit) {
	const dbPath = mediaDbPath(decryptedDir);
	if (!existsSync(dbPath)) return [];
	const db = new DatabaseSync(dbPath, { readOnly: true });
	try {
		return db.prepare(`SELECT CAST(chat_name_id AS TEXT) AS c, CAST(local_id AS TEXT) AS l, CAST(svr_id AS TEXT) AS s
       FROM VoiceInfo ORDER BY create_time DESC LIMIT ?`).all(limit).map((r) => {
			const chatId = r.c ?? "";
			const svrId = r.s ?? "";
			return {
				chatId,
				localId: r.l ?? "",
				svrId,
				username: usernameByChatId(decryptedDir, chatId)
			};
		});
	} finally {
		db.close();
	}
}
/** The raw silk voice_data bytes for a svr_id. */
function voiceDataBySvr(decryptedDir, svrId) {
	const dbPath = mediaDbPath(decryptedDir);
	if (!existsSync(dbPath)) return null;
	const db = new DatabaseSync(dbPath, { readOnly: true });
	try {
		const row = db.prepare("SELECT voice_data FROM VoiceInfo WHERE svr_id = CAST(? AS INTEGER) LIMIT 1").get(svrId);
		db.close();
		if (row?.voice_data instanceof Uint8Array) return Buffer.from(row.voice_data);
		return null;
	} catch {
		db.close();
		return null;
	}
}
/** VoiceInfo svr_id for (username, local_id) — direct Name2Id mapping. */
function svrIdByChatLocal(decryptedDir, username, localId) {
	const dbPath = mediaDbPath(decryptedDir);
	if (!existsSync(dbPath)) return "";
	const db = new DatabaseSync(dbPath, { readOnly: true });
	try {
		const chat = db.prepare("SELECT rowid FROM Name2Id WHERE user_name = ? LIMIT 1").get(username);
		db.close();
		if (!chat || typeof chat.rowid !== "number") return "";
		const db2 = new DatabaseSync(dbPath, { readOnly: true });
		try {
			return db2.prepare("SELECT CAST(svr_id AS TEXT) AS s FROM VoiceInfo WHERE chat_name_id = ? AND local_id = ? LIMIT 1").get(chat.rowid, localId)?.s ?? "";
		} finally {
			db2.close();
		}
	} catch {
		return "";
	}
}
/** Resolve the wx_silk decoder binary: env pin, bundled resources, '' when none. */
function silkDecoderBin() {
	const pinned = process.env.DSH_WECHAT_SILK_BIN;
	if (pinned && pinned.trim().length > 0) return pinned.trim();
	try {
		let dir = fileURLToPath(new URL(".", import.meta.url));
		for (let i = 0; i < 5; i += 1) {
			const candidate = join(dir, "resources", "win32", "x64", "wx_silk.exe");
			if (existsSync(candidate)) return candidate;
			const parent = existingParent(dir);
			if (parent === dir) break;
			dir = parent;
		}
	} catch {}
	return "";
}
/** Parent dir that exists (dirname loop guard). */
function existingParent(dir) {
	const parent = dirname(dir);
	return parent === dir ? dir : parent;
}
/**
* Decode silk bytes to a WAV file via wx_silk (16 kHz mono, whisper-ready).
* @param silk - raw voice_data bytes (leading 0x02 tolerated).
* @param wavPath - output WAV path (parent dir created).
* @returns ok, or an error description.
*/
function silkToWav(silk, wavPath) {
	const bin = silkDecoderBin();
	if (!bin) return {
		ok: false,
		error: "未找到 wx_silk 解码器（DSH_WECHAT_SILK_BIN 或打包资源缺失）"
	};
	const tempDir = dirname(wavPath);
	const silkPath = join(tempDir, `.wx_silk_${process.pid}_${silk.length % 1e5}.silk`);
	try {
		mkdirSync(tempDir, { recursive: true });
		writeFileSync(silkPath, silk);
		const res = spawnSync(bin, [
			"16000",
			silkPath,
			wavPath
		], {
			encoding: "utf8",
			windowsHide: true
		});
		if (res.status === 0 && existsSync(wavPath)) return { ok: true };
		return {
			ok: false,
			error: (res.stderr || `解码器退出码 ${String(res.status)}`).trim().slice(0, 200)
		};
	} catch (e) {
		return {
			ok: false,
			error: e.message
		};
	}
}
//#endregion
//#region lib/types/query/voice-transcribe.js
/**
* Local voice batch transcription: silk → WAV (wx_silk) → whisper-cli with the
* selected ggml model → text cached as `<decoded>/voices/<svr_id>.txt`, WAVs
* cached alongside so later runs only re-infer.
*/
/** voice cache dir layout mirrors st_control: decoded_images/voices/. */
function voicesDir(decodedDir) {
	return join(decodedDir, "voices");
}
/** Cached transcript path for one voice message. */
function transcriptPath(decodedDir, svrId) {
	return join(voicesDir(decodedDir), svrId + ".txt");
}
/** Cached transcript text (empty when none). */
function cachedTranscript(decodedDir, svrId) {
	try {
		return readFileSync(transcriptPath(decodedDir, svrId), "utf8").trim();
	} catch {
		return "";
	}
}
/** Real parent dir → created ASCII junction path (per batch). */
const aliasLinks = /* @__PURE__ */ new Map();
function isAscii(s) {
	return !/[^\x00-\x7f]/.test(s);
}
/** Pick a creatable ASCII alias base under (or near) the decoded data root. */
function pickAliasBase(decodedDir) {
	const candidates = [join(decodedDir, "..", "whisper-aliases"), join(tmpdir(), "dsh-whisper-aliases")];
	for (const c of candidates) {
		if (!isAscii(c)) continue;
		try {
			mkdirSync(c, { recursive: true });
			return c;
		} catch {}
	}
	return tmpdir();
}
/** Ensure the ASCII junction for one real directory exists; returns its path. */
function ensureAsciiLink(realDir, aliasBase) {
	const cached = aliasLinks.get(realDir);
	if (cached) return cached;
	let link = join(aliasBase, "wpa-" + createHash("sha1").update(realDir.toLowerCase()).digest("hex").slice(0, 12));
	try {
		if (existsSync(link)) {
			if (readlinkSync(link).replace(/[\\/]+$/, "").toLowerCase() !== realDir.replace(/[\\/]+$/, "").toLowerCase()) {
				rmSync(link, {
					recursive: true,
					force: true
				});
				symlinkSync(realDir, link, "junction");
			}
		} else symlinkSync(realDir, link, "junction");
	} catch {
		link = realDir;
	}
	aliasLinks.set(realDir, link);
	return link;
}
/**
* Map a file path to an ASCII equivalent (junction alias for non-ASCII parent
* dirs) so whisper-cli can open it; ASCII paths pass through untouched.
* @param filePath - model/wav/output path to hand to whisper.
* @param aliasBase - ASCII dir that holds the junction links.
* @returns an ASCII-safe path to the same file.
*/
function asciiPathForWhisper(filePath, aliasBase) {
	if (isAscii(filePath)) return filePath;
	return join(ensureAsciiLink(dirname(filePath), aliasBase), basename(filePath));
}
/** Run whisper-cli on one WAV; returns the transcript text. */
function whisperOne(bin, modelPath, wavPath, outBase) {
	const done = spawnSync(bin, [
		"-m",
		modelPath,
		"-f",
		wavPath,
		"-l",
		"auto",
		"-np",
		"--no-timestamps",
		"-otxt",
		"-of",
		outBase
	], {
		encoding: "utf8",
		windowsHide: true,
		timeout: 6e5
	});
	if (done.status === 0 && existsSync(outBase + ".txt")) {
		const text = readFileSync(outBase + ".txt", "utf8").trim();
		if (text) return text;
	}
	if (done.error) throw new Error(`whisper-cli 启动失败: ${done.error.message}`);
	const stdout = done.stdout.trim();
	if (stdout) return stdout;
	throw new Error(done.stderr.trim() || `whisper-cli 退出码 ${String(done.status)}`);
}
/**
* Transcribe one voice message (or return its cached transcript): silk → WAV →
* whisper-cli → text cached as `<svr_id>.txt`.
* @returns { text } on success (possibly cached), { error } otherwise.
*/
function transcribeVoiceText(decryptedDir, decodedDir, modelPath, engineBin, svrId, aliasBase) {
	const vdir = voicesDir(decodedDir);
	mkdirSync(vdir, { recursive: true });
	const existing = cachedTranscript(decodedDir, svrId);
	if (existing) return { text: existing };
	try {
		const wavPath = join(vdir, svrId + ".wav");
		if (!existsSync(wavPath)) {
			const silk = voiceDataBySvr(decryptedDir, svrId);
			if (!silk) return { error: "VoiceInfo 无语音数据" };
			const dec = silkToWav(silk, wavPath);
			if (!dec.ok) return { error: "SILK 解码失败: " + (dec.error ?? "") };
		}
		const wavPathA = asciiPathForWhisper(wavPath, aliasBase);
		const outBaseA = asciiPathForWhisper(join(vdir, svrId), aliasBase);
		const text = whisperOne(engineBin, asciiPathForWhisper(modelPath, aliasBase), wavPathA, outBaseA);
		if (text) {
			writeFileSync(transcriptPath(decodedDir, svrId), text, "utf8");
			return { text };
		}
		return { error: "转写结果为空" };
	} catch (e) {
		return { error: e.message };
	}
}
/**
* Transcribe one voice message by (username, local_id) — used by the chat
* bubble's 语音转文字 button.
* @returns { ok:true, text } or { ok:false, error }.
*/
function transcribeOneVoice(decryptedDir, decodedDir, modelsDir, modelId, engineBin, username, localId) {
	const modelFile = WHISPER_DOWNLOAD_FILES.find(([id]) => id === modelId)?.[1];
	if (!modelFile) return {
		ok: false,
		error: "未知模型: " + modelId
	};
	const modelPath = join(modelsDir, modelFile);
	if (!existsSync(modelPath)) return {
		ok: false,
		error: `模型未安装: ${modelFile}`
	};
	if (!existsSync(engineBin)) return {
		ok: false,
		error: "未找到 whisper.cpp 引擎: " + engineBin
	};
	const svrId = svrIdByChatLocal(decryptedDir, username, localId);
	if (!svrId) return {
		ok: false,
		error: "未找到语音消息"
	};
	const r = transcribeVoiceText(decryptedDir, decodedDir, modelPath, engineBin, svrId, pickAliasBase(decodedDir));
	return r.text ? {
		ok: true,
		text: r.text
	} : {
		ok: false,
		error: r.error ?? "转写失败"
	};
}
/**
* Batch-transcribe the most recent voice messages.
* @param decryptedDir - decrypted data root (VoiceInfo source).
* @param decodedDir - decoded-images cache root (wav/txt caches).
* @param modelsDir - model cache dir.
* @param modelId - selected model id ('tiny' | ... | 'turbo').
* @param engineBin - whisper-cli binary path.
* @param limit - max voice messages to process (newest first).
* @param onProgress - per-message progress callback.
* @returns VoiceBatchResult with ok/done/failed/skipped counts.
*/
function transcribeVoiceBatch(decryptedDir, decodedDir, modelsDir, modelId, engineBin, limit, onProgress) {
	const modelFile = WHISPER_DOWNLOAD_FILES.find(([id]) => id === modelId)?.[1];
	if (!modelFile) return Promise.resolve({
		ok: false,
		total: 0,
		done: 0,
		failed: 0,
		skipped: 0,
		errors: [],
		engine: engineBin,
		error: "未知模型: " + modelId
	});
	const modelPath = join(modelsDir, modelFile);
	if (!existsSync(modelPath)) return Promise.resolve({
		ok: false,
		total: 0,
		done: 0,
		failed: 0,
		skipped: 0,
		errors: [],
		engine: engineBin,
		model: modelFile,
		error: `模型未安装: ${modelFile}（请先下载或放入模型目录）`
	});
	if (!existsSync(engineBin)) return Promise.resolve({
		ok: false,
		total: 0,
		done: 0,
		failed: 0,
		skipped: 0,
		errors: [],
		engine: engineBin,
		model: modelFile,
		error: "未找到 whisper.cpp 引擎: " + engineBin
	});
	const sources = recentVoiceMessages(decryptedDir, Math.max(1, limit));
	const aliasBase = pickAliasBase(decodedDir);
	const errors = [];
	let done = 0;
	let failed = 0;
	let skipped = 0;
	let idx = 0;
	for (const src of sources) {
		idx += 1;
		if (cachedTranscript(decodedDir, src.svrId)) {
			skipped += 1;
			onProgress(idx, sources.length, failed, src.svrId);
			continue;
		}
		const r = transcribeVoiceText(decryptedDir, decodedDir, modelPath, engineBin, src.svrId, aliasBase);
		if (r.text) done += 1;
		else if (r.error === "转写结果为空") skipped += 1;
		else {
			failed += 1;
			errors.push({
				svrId: src.svrId,
				username: src.username,
				error: r.error ?? "转写失败"
			});
		}
		onProgress(idx, sources.length, failed, src.svrId);
	}
	return Promise.resolve({
		ok: errors.length === 0,
		total: sources.length,
		done,
		failed,
		skipped,
		errors,
		engine: engineBin,
		model: modelFile
	});
}
//#endregion
//#region lib/types/query/zip.js
/**
* Minimal ZIP writer (no external deps): STORE method with deflate via
* node:zlib, used for .xlsx (OOXML) and export ZIP packaging.
*/
const CRC_TABLE = (() => {
	const table = new Array(256);
	for (let n = 0; n < 256; n += 1) {
		let c = n;
		for (let k = 0; k < 8; k += 1) c = (c & 1) !== 0 ? 3988292384 ^ c >>> 1 : c >>> 1;
		table[n] = c >>> 0;
	}
	return table;
})();
function crc32(buf) {
	let c = 4294967295;
	for (let i = 0; i < buf.length; i += 1) {
		const byte = buf[i] ?? 0;
		c = (CRC_TABLE[(c ^ byte) & 255] ?? 0) ^ c >>> 8;
	}
	return (c ^ 4294967295) >>> 0;
}
function u16(v) {
	const b = Buffer.alloc(2);
	b.writeUInt16LE(v);
	return b;
}
function u32(v) {
	const b = Buffer.alloc(4);
	b.writeUInt32LE(v >>> 0);
	return b;
}
/** Build a ZIP archive from named entries (string or bytes payloads). */
function zipFiles(entries) {
	const locals = [];
	const centrals = [];
	let offset = 0;
	const names = /* @__PURE__ */ new Set();
	for (const entry of entries) {
		const name = entry.name.replace(/\\/g, "/");
		if (names.has(name)) continue;
		names.add(name);
		const raw = typeof entry.data === "string" ? Buffer.from(entry.data, "utf8") : Buffer.from(entry.data);
		const deflated = deflateRawSync(raw);
		const data = deflated.length >= raw.length ? raw : deflated;
		const method = deflated.length >= raw.length ? 0 : 8;
		const crc = crc32(raw);
		const nameBuf = Buffer.from(name, "utf8");
		const local = Buffer.concat([
			u32(67324752),
			u16(20),
			u16(0),
			u16(method),
			u16(0),
			u16(0),
			u32(crc),
			u32(data.length),
			u32(data.length),
			u16(nameBuf.length),
			u16(0),
			nameBuf,
			data
		]);
		locals.push(local);
		centrals.push(Buffer.concat([
			u32(33639248),
			u16(20),
			u16(20),
			u16(0),
			u16(method),
			u16(0),
			u16(0),
			u32(crc),
			u32(data.length),
			u32(data.length),
			u16(nameBuf.length),
			u16(0),
			u16(0),
			u16(0),
			u16(0),
			u32(0),
			u32(offset),
			nameBuf
		]));
		offset += local.length;
	}
	const centralStart = offset;
	const central = Buffer.concat(centrals);
	const eocd = Buffer.concat([
		u32(101010256),
		u16(0),
		u16(0),
		u16(centrals.length),
		u16(centrals.length),
		u32(central.length),
		u32(centralStart),
		u16(0)
	]);
	return Buffer.concat([
		...locals,
		central,
		eocd
	]);
}
//#endregion
//#region lib/types/query/sns-video.js
/**
* SNS (朋友圈) video cover resolution: WeChat caches moments videos under
* cache/<month>/Sns/Video/<sha>/<hash>.mp4 with a sibling <hash>.jpg cover.
* The cover is a plain JPEG, unlike the image blobs, so no AES key is needed.
*/
const coverCache = /* @__PURE__ */ new Map();
const videoUrlCache = /* @__PURE__ */ new Map();
function walkFiles(dir, out, depth) {
	if (depth > 5 || !existsSync(dir)) return;
	let entries = [];
	try {
		entries = readdirSync(dir, { withFileTypes: true }).map((e) => ({
			name: e.name,
			isDir: e.isDirectory()
		}));
	} catch {
		return;
	}
	for (const e of entries) {
		const p = join(dir, e.name);
		if (e.isDir) walkFiles(p, out, depth + 1);
		else if (e.name.toLowerCase().endsWith(".jpg") || e.name.toLowerCase().endsWith(".jpeg") || e.name.toLowerCase().endsWith(".png")) out.push(p);
	}
}
/** Gather cache/<month>/Sns/Video roots. */
function snsVideoRoots(wechatBaseDir) {
	const cacheRoot = join(wechatBaseDir, "cache");
	const out = [];
	if (!existsSync(cacheRoot)) return out;
	try {
		for (const e of readdirSync(cacheRoot, { withFileTypes: true })) {
			if (!e.isDirectory()) continue;
			const root = join(cacheRoot, e.name, "Sns", "Video");
			if (existsSync(root)) out.push(root);
		}
	} catch {}
	return out;
}
function dataUrlOf(path) {
	try {
		const bytes = readFileSync(path);
		return "data:image/" + (path.toLowerCase().endsWith(".png") ? "png" : "jpeg") + ";base64," + Buffer.from(bytes).toString("base64");
	} catch {
		return null;
	}
}
function firstExisting(root, sub, rest) {
	for (const ext of [
		".jpg",
		".jpeg",
		".png"
	]) {
		const p = join(root, sub, rest + ext);
		if (existsSync(p)) return p;
	}
	return null;
}
/**
* Resolve one SNS video cover to an offline base64 data URL.
* @param wechatBaseDir - raw WeChat install dir (current account root).
* @param md5 - optional media md5 from the moments XML (fallback to msg/video).
* @param timelineId - optional timeline id (cache-key input).
* @param mediaId - optional media id (cache-key input).
* @returns data URL or an error description.
*/
function resolveSnsVideoCoverDataUrl(wechatBaseDir, md5, timelineId, mediaId) {
	const key = (timelineId && mediaId ? createHash("md5").update(timelineId + "_" + mediaId + "_2", "utf8").digest("hex") : "") || (md5 || "").trim().toLowerCase();
	if (!key) return { error: "缺少视频标识" };
	if (coverCache.has(key)) {
		const cached = coverCache.get(key) ?? "";
		if (cached) return { url: cached };
	}
	if (!wechatBaseDir) return { error: "未配置微信原始目录，无法离线解码" };
	if (timelineId && mediaId) for (const suffix of [
		"_2",
		"_1",
		"_0",
		""
	]) {
		const h = createHash("md5").update(timelineId + "_" + mediaId + suffix, "utf8").digest("hex");
		const sub = h.slice(0, 2);
		const rest = h.slice(2);
		for (const root of snsVideoRoots(wechatBaseDir)) {
			const p = firstExisting(root, sub, rest);
			if (p) {
				const data = dataUrlOf(p);
				if (data) {
					coverCache.set(key, data);
					return { url: data };
				}
			}
		}
	}
	if (md5) {
		const videoRoot = join(wechatBaseDir, "msg", "video");
		if (existsSync(videoRoot)) {
			const files = [];
			walkFiles(videoRoot, files, 0);
			for (const f of files) {
				const base = f.split(/[\\/]/).pop() ?? "";
				if (base.startsWith(md5) || base.startsWith(md5.toLowerCase()) || base.startsWith(md5.toUpperCase())) {
					const data = dataUrlOf(f);
					if (data) {
						coverCache.set(key, data);
						return { url: data };
					}
				}
			}
		}
	}
	return { error: "未找到匹配的本地 SNS 视频封面" };
}
function dataUrlOfVideo(path) {
	try {
		const bytes = readFileSync(path);
		return "data:video/" + (path.toLowerCase().endsWith(".mov") ? "quicktime" : "mp4") + ";base64," + Buffer.from(bytes).toString("base64");
	} catch {
		return null;
	}
}
function firstExistingVideo(root, sub, rest) {
	for (const ext of [".mp4", ".mov"]) {
		const p = join(root, sub, rest + ext);
		if (existsSync(p)) return p;
	}
	return null;
}
/**
* Resolve one SNS (朋友圈) video body to an offline base64 data URL so it can be
* played inline. The cached container sits beside its cover under
* cache/<month>/Sns/Video/<sha>/<hash>.mp4; fall back to msg/video/<md5>.mp4.
* @param wechatBaseDir - raw WeChat install dir (current account root).
* @param md5 - optional media md5 from the moments XML.
* @param timelineId - optional timeline id (cache-key input).
* @param mediaId - optional media id (cache-key input).
* @returns data URL or an error description.
*/
function resolveSnsVideoDataUrl(wechatBaseDir, md5, timelineId, mediaId) {
	const key = (timelineId && mediaId ? createHash("md5").update(timelineId + "_" + mediaId + "_2", "utf8").digest("hex") : "") || (md5 || "").trim().toLowerCase();
	if (!key) return { error: "缺少视频标识" };
	if (videoUrlCache.has(key)) {
		const cached = videoUrlCache.get(key) ?? "";
		if (cached) return { url: cached };
	}
	if (!wechatBaseDir) return { error: "未配置微信原始目录，无法离线解码" };
	if (timelineId && mediaId) for (const suffix of [
		"_2",
		"_1",
		"_0",
		""
	]) {
		const h = createHash("md5").update(timelineId + "_" + mediaId + suffix, "utf8").digest("hex");
		const sub = h.slice(0, 2);
		const rest = h.slice(2);
		for (const root of snsVideoRoots(wechatBaseDir)) {
			const p = firstExistingVideo(root, sub, rest);
			if (p) {
				const data = dataUrlOfVideo(p);
				if (data) {
					videoUrlCache.set(key, data);
					return { url: data };
				}
			}
		}
	}
	if (md5) {
		const videoRoot = join(wechatBaseDir, "msg", "video");
		if (existsSync(videoRoot)) {
			const files = [];
			walkFiles(videoRoot, files, 0);
			for (const f of files) {
				const base = f.split(/[\\/]/).pop() ?? "";
				const low = base.toLowerCase();
				if ((base.startsWith(md5) || base.startsWith(md5.toLowerCase()) || base.startsWith(md5.toUpperCase())) && (low.endsWith(".mp4") || low.endsWith(".mov"))) {
					const data = dataUrlOfVideo(f);
					if (data) {
						videoUrlCache.set(key, data);
						return { url: data };
					}
				}
			}
		}
	}
	return { error: "未找到匹配的本地 SNS 视频" };
}
//#endregion
//#region lib/types/query/annual-report.js
/**
* Annual report: local-only yearly WeChat chat story, rewritten from
* st_control AnnualSummary + utils/annual.ts. Scans all message shards for
* one year and computes hero stats, heatmap, monthly, types, phrases, emoji,
* top contacts/groups, and first/last sentences.
*/
/** Msg_<md5(username)> table name. */
function msgTableName$3(username) {
	return "Msg_" + createHash("md5").update(username, "utf8").digest("hex");
}
/** Coerce a DB cell to a string (null -> '', else String()). */
function cellStr$7(v) {
	if (typeof v === "string") return v;
	if (v === null || v === void 0) return "";
	if (typeof v === "number" || typeof v === "boolean" || typeof v === "bigint" || typeof v === "symbol") return String(v);
	return "";
}
/** zstd magic bytes (WCDB compressed blobs). */
const ZSTD_MAGIC$5 = Buffer.from([
	40,
	181,
	47,
	253
]);
/** Decode raw column bytes: zstd-decompress when the magic matches. */
function tryDecompress$1(data) {
	if (data.length >= 4 && data.subarray(0, 4).equals(ZSTD_MAGIC$5)) try {
		return Buffer.from(decompress(data));
	} catch {
		return null;
	}
	return null;
}
/** Decode bytes as UTF-8, falling back to GBK when UTF-8 leaves replacement chars. */
function decodeUtfOrGbk$1(bytes) {
	const utf8 = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
	if (!utf8.includes("�")) return utf8;
	try {
		const gbk = new TextDecoder("gbk", { fatal: false }).decode(bytes);
		const utf8Bad = (utf8.match(/\uFFFD/g) ?? []).length;
		return (gbk.match(/\uFFFD/g) ?? []).length < utf8Bad ? gbk : utf8;
	} catch {
		return utf8;
	}
}
/** Decode a message cell (TEXT or BLOB): zstd-decompress, then UTF-8/GBK. */
function decodeCell$5(v) {
	if (v === null || v === void 0) return "";
	if (typeof v === "string") return v;
	if (typeof v === "number" || typeof v === "boolean" || typeof v === "bigint" || typeof v === "symbol") return String(v);
	const raw = Buffer.from(v instanceof Uint8Array ? v : []);
	return decodeUtfOrGbk$1(tryDecompress$1(raw) ?? raw);
}
/** Strip XML tags for text. */
function stripXml$1(x) {
	return x.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}
/** Extract group sender from content prefix (wxid:\n). */
function senderFromContent(content) {
	const m = content.match(/([A-Za-z0-9_@.\-]{3,64}):\n/);
	return m ? m[1] ?? null : null;
}
/** Clean a message preview: strip binary header + group sender prefix + XML. */
function cleanMessage(text) {
	let t = text;
	const m = t.match(/(?:[A-Za-z0-9_@.\-]{3,64}:\s*)([\s\S]*)/);
	if (m && m[1] && !m[1].startsWith("<")) t = m[1];
	t = t.replace(/^[\x00-\x1f\x7f-\x9f]*/, "");
	t = t.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
	return t.slice(0, 120);
}
/** Compute persona tags from shares. */
function personaTags(s) {
	const tags = [];
	if (s.nightShare >= .2) tags.push("夜猫子");
	if (s.morningShare >= .15) tags.push("早起鸟");
	if (s.weekendShare >= .25) tags.push("周末达人");
	if (s.groupShare >= .6) tags.push("群聊之王");
	if (s.dailyAvg >= 50) tags.push("话痨");
	if (tags.length === 0) tags.push("稳健沟通者");
	return tags;
}
/**
* Compute the annual report for one year.
* @param decryptedDir - decrypted data root.
* @param year - calendar year.
* @returns the annual report.
*/
function queryAnnualReport(decryptedDir, year) {
	const msgDir = join(decryptedDir, "message");
	if (!existsSync(msgDir)) return {
		year,
		total: 0
	};
	const start = Math.floor(new Date(year, 0, 1, 0, 0, 0, 0).getTime() / 1e3);
	const end = Math.floor(new Date(year + 1, 0, 1, 0, 0, 0, 0).getTime() / 1e3);
	const usernames = loadUsernames(decryptedDir);
	const perSender = /* @__PURE__ */ new Map();
	const perChat = /* @__PURE__ */ new Map();
	const heat = new Array(168).fill(0);
	const monthly = new Array(12).fill(0);
	const kindCounts = /* @__PURE__ */ new Map();
	const emojiCount = /* @__PURE__ */ new Map();
	const phraseCount = /* @__PURE__ */ new Map();
	const activeDays = /* @__PURE__ */ new Set();
	let total = 0;
	let textCount = 0;
	let textChars = 0;
	let nightCount = 0;
	let morningCount = 0;
	let weekendCount = 0;
	let groupCount = 0;
	let firstMsg = null;
	let lastMsg = null;
	let firstTs = Number.POSITIVE_INFINITY;
	let lastTs = 0;
	const files = readdirSync(msgDir).filter((f) => f.endsWith(".db") && !f.includes("_shm") && !f.includes("_wal") && !f.includes("monitor_cache") && !f.includes("media") && !f.includes("resource") && !f.includes("fts"));
	const tableToUser = /* @__PURE__ */ new Map();
	for (const username of usernames) tableToUser.set(msgTableName$3(username), username);
	const fileInfos = [];
	for (const file of files) {
		let probe = null;
		try {
			probe = new DatabaseSync(join(msgDir, file), { readOnly: true });
		} catch {
			continue;
		}
		try {
			const names = probe.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'Msg_%'").all().map((r) => r.name);
			const tables = [];
			for (const n of names) {
				const u = tableToUser.get(n);
				if (u) tables.push([n, u]);
			}
			if (tables.length > 0) fileInfos.push({
				path: join(msgDir, file),
				tables
			});
		} catch {} finally {
			probe.close();
		}
	}
	for (const fi of fileInfos) {
		let db = null;
		try {
			db = new DatabaseSync(fi.path, { readOnly: true });
		} catch {
			continue;
		}
		try {
			for (const [table, username] of fi.tables) try {
				// 这里曾经投影 is_sender 但**从未使用**，而 WeChat 4.x 的 Msg_ 表没有这一列
				// （0/239 张有），属于恒为 '0' 的死列；年报没有「发出/收到」口径，直接去掉。
				const rows = db.prepare("SELECT create_time, local_type, message_content FROM \"" + table + "\" WHERE create_time >= ? AND create_time < ?").all(start, end);
				for (const r of rows) {
					const ts = Number(r["create_time"] ?? 0);
					const lt = Number(r["local_type"] ?? 0);
					const content = decodeCell$5(r["message_content"]);
					const text = stripXml$1(content);
					if (text && /^[0-9,]+$/.test(text.slice(0, 80))) continue;
					total += 1;
					if (username.endsWith("@chatroom")) {
						const sender = senderFromContent(content);
						if (sender && !sender.endsWith("@chatroom")) perSender.set(sender, (perSender.get(sender) ?? 0) + 1);
					} else perSender.set(username, (perSender.get(username) ?? 0) + 1);
					perChat.set(username, (perChat.get(username) ?? 0) + 1);
					if (username.endsWith("@chatroom")) groupCount += 1;
					const d = /* @__PURE__ */ new Date(ts * 1e3);
					const h = d.getHours();
					const dow = d.getDay();
					heat[dow * 24 + h] = (heat[dow * 24 + h] ?? 0) + 1;
					monthly[d.getMonth()] = (monthly[d.getMonth()] ?? 0) + 1;
					const dayKey = `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
					activeDays.add(dayKey);
					if (h >= 23 || h <= 4) nightCount += 1;
					if (h >= 5 && h <= 9) morningCount += 1;
					if (dow === 0 || dow === 6) weekendCount += 1;
					const normType = lt > 4294967296 ? lt % 4294967296 : lt;
					if (normType === 1 && text) {
						textCount += 1;
						textChars += text.length;
						for (let i = 0; i + 2 <= text.length; i += 1) {
							const bi = text.slice(i, i + 2);
							if (/[\u4e00-\u9fff]{2}/.test(bi)) phraseCount.set(bi, (phraseCount.get(bi) ?? 0) + 1);
						}
						const emo = text.match(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu) ?? [];
						for (const e of emo) emojiCount.set(e, (emojiCount.get(e) ?? 0) + 1);
					}
					kindCounts.set(typeLabel$1(normType), (kindCounts.get(typeLabel$1(normType)) ?? 0) + 1);
					if (ts > lastTs && text) {
						lastTs = ts;
						lastMsg = text.slice(0, 80);
					}
					if (ts < firstTs && text) {
						firstTs = ts;
						firstMsg = text.slice(0, 80);
					}
				}
			} catch {}
		} finally {
			db.close();
		}
	}
	const activeDaysCount = activeDays.size;
	const dailyAvg = activeDaysCount > 0 ? Math.round(total / activeDaysCount) : 0;
	const textShare = total > 0 ? textCount / total : 0;
	const nightShare = total > 0 ? nightCount / total : 0;
	const morningShare = total > 0 ? morningCount / total : 0;
	const weekendShare = total > 0 ? weekendCount / total : 0;
	const groupShare = total > 0 ? groupCount / total : 0;
	const nameMap = contactMeta(decryptedDir).names;
	const topContacts = Array.from(perSender.entries()).filter(([u]) => !u.endsWith("@chatroom") && !u.startsWith("gh_")).map(([username, count]) => ({
		username,
		name: nameMap.get(username) || username,
		count,
		share: total > 0 ? count / total : 0
	})).sort((a, b) => b.count - a.count).slice(0, 10);
	const topGroups = Array.from(perChat.entries()).filter(([u]) => u.endsWith("@chatroom")).map(([username, count]) => ({
		username,
		name: nameMap.get(username) || username,
		count,
		share: total > 0 ? count / total : 0
	})).sort((a, b) => b.count - a.count).slice(0, 10);
	const topEmoji = Array.from(emojiCount.entries()).map(([e, n]) => ({
		emoji: e,
		count: n
	})).sort((a, b) => b.count - a.count).slice(0, 8);
	const topPhrases = Array.from(phraseCount.entries()).map(([p, n]) => ({
		phrase: p,
		count: n
	})).sort((a, b) => b.count - a.count).slice(0, 20);
	const out = {
		year,
		total,
		active_days: activeDaysCount,
		text_chars: textChars,
		daily_avg: dailyAvg,
		text_share: Number(textShare.toFixed(4)),
		night_share: Number(nightShare.toFixed(4)),
		morning_share: Number(morningShare.toFixed(4)),
		weekend_share: Number(weekendShare.toFixed(4)),
		group_share: Number(groupShare.toFixed(4)),
		heat,
		monthly,
		kind_counts: Object.fromEntries(kindCounts),
		top_phrases: topPhrases,
		top_emoji: topEmoji,
		top_contacts: topContacts,
		top_groups: topGroups,
		persona_tags: personaTags({
			nightShare,
			morningShare,
			weekendShare,
			groupShare,
			dailyAvg
		})
	};
	if (firstMsg) out.first_message = cleanMessage(firstMsg);
	if (lastMsg) out.last_message = cleanMessage(lastMsg);
	return out;
}
/** Load session usernames. */
function loadUsernames(decryptedDir) {
	const p = join(decryptedDir, "session", "session.db");
	if (!existsSync(p)) return [];
	const out = [];
	try {
		const db = new DatabaseSync(p, { readOnly: true });
		const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
		const table = tables.includes("SessionTable") ? "SessionTable" : tables.includes("Session") ? "Session" : "";
		if (table) {
			const rows = db.prepare("SELECT username FROM \"" + table + "\"").all();
			for (const r of rows) {
				const u = cellStr$7(r["username"] ?? "").trim();
				if (u) out.push(u);
			}
		}
		db.close();
	} catch {}
	return out;
}
/** Human label for a message type. */
function typeLabel$1(t) {
	if (t === 1) return "文本";
	if (t === 3) return "图片";
	if (t === 34) return "语音";
	if (t === 42) return "名片";
	if (t === 43) return "视频";
	if (t === 47) return "表情";
	if (t === 48) return "位置";
	if (t === 49) return "链接";
	if (t === 1e4) return "系统消息";
	return "其他";
}
//#endregion
//#region lib/types/query/export.js
/**
* Session message export (txt/csv/excel/html), rewritten from st_control
* handlers/session/export.rs. Writes files under <decrypted>.parent()/exports
* and returns the path + count. Chronological order (oldest first).
*/
/** Decode a base64 data URL to bytes (returns null when not a base64 data URL). */
function dataUrlToBuffer(url) {
	const m = url.match(/^data:[^;,]+;base64,(.*)$/);
	if (!m || !m[1]) return null;
	try {
		return Buffer.from(m[1], "base64");
	} catch {
		return null;
	}
}
/** Media-resolution context (raw base dir + image AES/xor keys) from config. */
function exportMediaCtx(decrypted) {
	const cfg = getConfig(decrypted);
	const dbDir = typeof cfg["db_dir"] === "string" ? cfg["db_dir"] : "";
	let base = "";
	if (dbDir) {
		const parts = dbDir.replace(/[\\/]+$/, "").split(/[\\/]/);
		base = (parts[parts.length - 1] ?? "") === "db_storage" ? parts.slice(0, -1).join("/") : "";
	}
	const aesKey = typeof cfg["image_aes_key"] === "string" && cfg["image_aes_key"].length > 0 ? cfg["image_aes_key"] : void 0;
	const xorKey = Number(cfg["image_xor_key"] ?? 255);
	return {
		base: base || void 0,
		aesKey,
		xorKey
	};
}
/** Format a unix timestamp as YYYY-MM-DD HH:MM. */
function fmtFull(ts) {
	if (!ts) return "";
	const d = /* @__PURE__ */ new Date(ts * 1e3);
	const p = (n) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
/**
* Collect a conversation messages chronologically (oldest first).
* @param decryptedDir - decrypted data root.
* @param username - conversation username.
* @param count - 0 = all (max 50000), else up to count.
*/
function collectMessages(decryptedDir, username, count) {
	const target = count === 0 ? 5e4 : Math.max(1, Math.min(count, 5e4));
	const pages = [];
	let cursor;
	let cursorLocalId;
	let guard = 0;
	while (pages.length < target && guard < 600) {
		// 传复合游标，避免 sort_seq 重复处分页丢消息（导出必须一条不漏）。
		const env = queryMessages(decryptedDir, username, 100, cursor, void 0, cursorLocalId);
		if (env.messages.length === 0) break;
		pages.push(...env.messages);
		if (!env.hasMore) break;
		cursor = env.cursor;
		cursorLocalId = env.cursorLocalId;
		guard += 1;
	}
	return pages.slice(0, target).reverse();
}
/** Escape a CSV cell (wrap in quotes, double inner quotes). */
function csvCell(v) {
	return "\"" + v.replace(/"/g, "\"\"") + "\"";
}
/** HTML-escape a string. */
function htmlEscape(v) {
	return v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
/** Render one message row to export columns. */
function rowOf(m, username) {
	const sender = m.isSender === 1 ? "我" : m.sender || username;
	const typeLabel = m.type === 1 ? "文本" : m.typeLabel || String(m.type);
	return {
		time: fmtFull(m.createTime),
		sender,
		typeLabel,
		text: m.displayText || ""
	};
}
/** txt export body. */
function formatTxt(msgs, username) {
	const lines = [`消息导出 (${msgs.length})`];
	lines.push("=".repeat(48));
	lines.push("");
	for (const m of msgs) {
		const r = rowOf(m, username);
		lines.push(r.time + " " + r.sender);
		lines.push(r.typeLabel + ": " + r.text);
		lines.push("");
	}
	return lines.join("\n");
}
/** csv export body. */
function formatCsv(msgs, username) {
	const lines = ["时间,发送者,类型,内容"];
	for (const m of msgs) {
		const r = rowOf(m, username);
		lines.push(csvCell(r.time) + "," + csvCell(r.sender) + "," + csvCell(r.typeLabel) + "," + csvCell(r.text));
	}
	return lines.join("\n");
}
/** html chat-log export body (date dividers + bubbles). */
function formatHtml(msgs, username, now) {
	let body = "";
	let lastDay = "";
	for (const m of msgs) {
		const r = rowOf(m, username);
		const day = r.time.split(" ")[0] || "";
		if (day !== lastDay) {
			lastDay = day;
			body += "<div class=\"date-divider\"><span>" + htmlEscape(day) + "</span></div>";
		}
		const side = m.isSender === 1 ? "right" : "left";
		const content = m.type === 3 ? "<span class=\"muted\">[图片]</span>" : htmlEscape(r.text);
		body += "<div class=\"row " + side + "\"><div class=\"bubble\"><div class=\"sender\">" + htmlEscape(r.sender) + "</div><div class=\"content\">" + content + "</div><div class=\"time\">" + htmlEscape(r.time) + "</div></div></div>";
	}
	return "<!DOCTYPE html>\n<html lang=\"zh-CN\"><head><meta charset=\"utf-8\"><title>微信聊天记录导出</title><style>body{font-family:-apple-system,Segoe UI,Microsoft YaHei,sans-serif;background:#ededed;margin:0;padding:24px 12px;color:#1f1f1f}.wrap{max-width:760px;margin:0 auto}.hd{text-align:center;padding:16px 0 8px}.hd h1{font-size:18px;margin:0 0 4px}.hd p{font-size:12px;color:#888;margin:0}.date-divider{text-align:center;margin:18px 0 10px}.date-divider span{background:#c8c8c8;color:#fff;font-size:11px;padding:2px 12px;border-radius:999px}.row{display:flex;margin:10px 0}.row.right{justify-content:flex-end}.bubble{max-width:72%;padding:9px 12px;border-radius:8px;background:#fff;position:relative;box-shadow:0 1px 2px rgba(0,0,0,.08)}.row.right .bubble{background:#95ec69}.sender{font-size:11px;color:#576b95;margin-bottom:3px}.content{font-size:14px;line-height:1.5;word-break:break-word}.time{font-size:10px;color:#aaa;margin-top:4px;text-align:right}.muted{color:#999;font-size:12px}</style></head><body><div class=\"wrap\"><div class=\"hd\"><h1>微信聊天记录</h1><p>共 " + String(msgs.length) + " 条消息 · 导出时间 " + htmlEscape(now) + "</p></div>" + body + "</div></body></html>";
}
/** markdown chat-log export body (date dividers + bullets). */
function formatMarkdown(msgs, username) {
	const lines = [
		"# 微信聊天记录导出",
		"",
		"> 共 " + String(msgs.length) + " 条消息 · 导出时间 " + (/* @__PURE__ */ new Date()).toLocaleString(),
		""
	];
	let lastDay = "";
	for (const m of msgs) {
		const r = rowOf(m, username);
		const day = r.time.split(" ")[0] || "";
		if (day !== lastDay) {
			lastDay = day;
			lines.push("## " + day, "");
		}
		lines.push("**" + r.time + " " + r.sender + "**  ", r.typeLabel + "：" + r.text.replace(/\r?\n/g, "  "), "");
	}
	return lines.join("\n");
}
/** SQL export body (CREATE TABLE + INSERTs). */
function formatSql(msgs, username) {
	const q = (v) => "'" + v.replace(/'/g, "''") + "'";
	const lines = [
		"CREATE TABLE IF NOT EXISTS chat_messages (",
		"  id INTEGER PRIMARY KEY AUTOINCREMENT,",
		"  chatroom TEXT NOT NULL,",
		"  create_time TEXT,",
		"  sender TEXT,",
		"  type_label TEXT,",
		"  content TEXT,",
		"  local_id INTEGER",
		");",
		""
	];
	for (const m of msgs) {
		const r = rowOf(m, username);
		lines.push("INSERT INTO chat_messages (chatroom, create_time, sender, type_label, content, local_id) VALUES (" + q(username) + ", " + q(r.time) + ", " + q(r.sender) + ", " + q(r.typeLabel) + ", " + q(r.text) + ", " + String(m.localId) + ");");
	}
	return lines.join("\n");
}
/** JSON export body. */
function formatJson(msgs, username) {
	const items = msgs.map((m) => {
		const r = rowOf(m, username);
		const item = {
			localId: m.localId,
			sortSeq: m.sortSeq ?? 0,
			time: r.time,
			sender: r.sender,
			type: m.type,
			typeLabel: r.typeLabel,
			content: r.text
		};
		if (m.rich) item.rich = m.rich;
		return item;
	});
	return JSON.stringify(items, null, 2);
}
/** XML-escape a value for OOXML. */
function xmlEsc(v) {
	return v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
/** Minimal real .xlsx (OOXML single sheet, no deps). */
function formatXlsx(msgs, username) {
	const rows = [[
		"时间",
		"发送者",
		"类型",
		"内容",
		"localId"
	]];
	for (const m of msgs) {
		const r = rowOf(m, username);
		rows.push([
			r.time,
			r.sender,
			r.typeLabel,
			r.text,
			String(m.localId)
		]);
	}
	let cells = "";
	for (const row of rows) cells += "<row>" + row.map((c) => "<c t=\"inlineStr\"><is><t>" + xmlEsc(c) + "</t></is></c>").join("") + "</row>";
	return zipFiles([
		{
			name: "[Content_Types].xml",
			data: "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"><Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/><Default Extension=\"xml\" ContentType=\"application/xml\"/><Override PartName=\"/xl/workbook.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml\"/><Override PartName=\"/xl/worksheets/sheet1.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml\"/></Types>"
		},
		{
			name: "_rels/.rels",
			data: "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument\" Target=\"xl/workbook.xml\"/></Relationships>"
		},
		{
			name: "xl/workbook.xml",
			data: "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><workbook xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\" xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\"><sheets><sheet name=\"聊天记录\" sheetId=\"1\" r:id=\"rId1\"/></sheets></workbook>"
		},
		{
			name: "xl/_rels/workbook.xml.rels",
			data: "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet\" Target=\"worksheets/sheet1.xml\"/></Relationships>"
		},
		{
			name: "xl/worksheets/sheet1.xml",
			data: "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><worksheet xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\"><sheetData>" + cells + "</sheetData></worksheet>"
		}
	]);
}
/** Collect merged chat-log media metadata for the ZIP manifest. */
function collectChatlogMedia(msgs) {
	const out = [];
	for (const m of msgs) {
		const rich = m.rich;
		if (!rich || rich.type !== "chatlog" || !Array.isArray(rich.records)) continue;
		for (const rec of rich.records) {
			const item = {
				name: rec.name,
				time: rec.time,
				text: rec.text,
				renderType: rec.renderType ?? (rec.isImage ? "image" : "text")
			};
			if (rec.datatype) item.datatype = rec.datatype;
			if (rec.fullmd5) item.fullmd5 = rec.fullmd5;
			if (rec.thumbfullmd5) item.thumbfullmd5 = rec.thumbfullmd5;
			if (rec.md5) item.md5 = rec.md5;
			if (rec.cdnurlstring) item.cdnurlstring = rec.cdnurlstring;
			if (rec.encrypturlstring) item.encrypturlstring = rec.encrypturlstring;
			if (rec.link) item.link = rec.link;
			if (rec.fromnewmsgid) item.fromnewmsgid = rec.fromnewmsgid;
			out.push(item);
		}
	}
	return out;
}
/** Filter by message types and/or rich sub-types (empty lists = keep all). */
function filterMessages(msgs, types, richTypes) {
	const matchTypes = types !== void 0 && types.length > 0;
	const matchRich = richTypes !== void 0 && richTypes.length > 0;
	if (!matchTypes && !matchRich) return msgs;
	const tList = matchTypes ? types : [];
	const rList = matchRich ? richTypes : [];
	return msgs.filter((m) => {
		if (matchTypes && matchRich) return tList.includes(m.type) || (m.rich?.type ? rList.includes(m.rich.type) : false);
		if (matchTypes) return tList.includes(m.type);
		return m.rich?.type ? rList.includes(m.rich.type) : false;
	});
}
/**
* Export a conversation messages to a file under the exports dir (or dir).
* @param decryptedDir - decrypted data root.
* @param username - conversation username.
* @param format - txt | csv | excel | html | md | sql | json.
* @param count - 0 = all (max 50000), else up to count.
* @param dir - optional output directory (default <decrypted>.parent()/exports).
* @param types - optional message type numbers filter (empty = keep all).
* @param richTypes - optional rich sub-type filter (appmsg link/transfer/...).
* @returns the written file path, filename and message count.
*/
/** Sanitize a user-supplied file basename (no separators / invalid chars). */
function sanitizeBasename(name) {
	return name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").replace(/[. ]+$/g, "").trim().slice(0, 100);
}
function exportSessionMessages(decryptedDir, username, format, count, dir, types, richTypes, from, to, filename, zip) {
	const msgs = filterMessages(collectMessages(decryptedDir, username, count ?? 0), types, richTypes).filter((m) => {
		if (from && from > 0 && m.createTime < from) return false;
		if (to && to > 0 && m.createTime > to) return false;
		return true;
	});
	const now = (/* @__PURE__ */ new Date()).toISOString().slice(0, 19).replace("T", " ").replace(/[-:]/g, "");
	const isXlsx = format === "excel" || format === "xls" || format === "xlsx";
	const ext = isXlsx ? "xlsx" : format === "html" ? "html" : format === "csv" ? "csv" : format === "md" ? "md" : format === "sql" ? "sql" : format === "json" ? "json" : "txt";
	let content = "";
	if (format === "csv") content = formatCsv(msgs, username);
	else if (isXlsx) content = formatXlsx(msgs, username);
	else if (format === "html") content = formatHtml(msgs, username, now);
	else if (format === "md") content = formatMarkdown(msgs, username);
	else if (format === "sql") content = formatSql(msgs, username);
	else if (format === "json") content = formatJson(msgs, username);
	else content = formatTxt(msgs, username);
	const exportDir = dir && dir.trim() ? dir.trim() : join(dirname(decryptedDir), "exports");
	mkdirSync(exportDir, { recursive: true });
	const autoBase = username.replace(/@chatroom$/, "").replace(/[^\w\u4e00-\u9fa5-]/g, "_").slice(0, 24) + "_" + now + "_" + ((count ?? 0) === 0 ? "all" : String(count));
	const base = (filename && filename.trim() ? sanitizeBasename(filename.trim()) : "") || autoBase;
	const outExt = zip ? "zip" : ext;
	const innerName = base.toLowerCase().endsWith("." + ext) ? base : base + "." + ext;
	const filenameOut = base.toLowerCase().endsWith("." + outExt) ? base : base + "." + outExt;
	const filepath = join(exportDir, filenameOut);
	if (zip) writeFileSync(filepath, zipFiles([{
		name: innerName,
		data: content
	}, {
		name: "record_media.json",
		data: JSON.stringify({
			username,
			exportedAt: now,
			total: msgs.length,
			media: collectChatlogMedia(msgs)
		}, null, 2)
	}]));
	else writeFileSync(filepath, content);
	return {
		path: filepath,
		filename: filenameOut,
		count: msgs.length
	};
}
/**
* Export a data category to CSV under the exports dir.
* @param decryptedDir - decrypted data root.
* @param kind - contacts | favorites | records | moments.
* @param recordsKind - record category when kind=records.
* @returns the written file path, filename and row count.
*/
function exportCsv(decryptedDir, kind, recordsKind) {
	const now = (/* @__PURE__ */ new Date()).toISOString().slice(0, 19).replace("T", " ").replace(/[-:]/g, "");
	const exportDir = join(dirname(decryptedDir), "exports");
	mkdirSync(exportDir, { recursive: true });
	let rows = [];
	if (kind === "contacts") {
		rows = [[
			"用户名",
			"昵称",
			"备注",
			"类型"
		]];
		const env = queryContacts(decryptedDir);
		for (const c of env.contacts) rows.push([
			c.username,
			c.nickName,
			c.remark,
			c.category ?? ""
		]);
	} else if (kind === "favorites") {
		rows = [[
			"localId",
			"类型",
			"更新时间",
			"内容",
			"来源"
		]];
		const env = queryFavorites(decryptedDir, 5e3);
		for (const f of env.favorites) rows.push([
			String(f.localId),
			String(f.type),
			String(f.updateTime),
			f.content,
			f.fromUsr
		]);
	} else if (kind === "records") {
		rows = [["字段"]];
		const env = queryRecords(decryptedDir, recordsKind ?? "revokes", 5e3);
		for (const it of env.items) rows.push(Object.values(it).map((v) => String(v)));
	} else if (kind === "moments") {
		rows = [[
			"tid",
			"用户名",
			"作者",
			"时间",
			"内容",
			"媒体"
		]];
		const env = queryMoments(decryptedDir, 0, 5e3);
		for (const m of env.moments) rows.push([
			m.tid,
			m.username,
			m.author,
			m.time,
			m.text,
			m.media_desc
		]);
	} else if (kind === "privacy") {
		rows = [[
			"类别",
			"会话",
			"联系人",
			"时间",
			"片段"
		]];
		const env = queryPrivacyScan(decryptedDir);
		for (const c of env.categories) for (const s of c.samples) rows.push([
			c.label,
			s.username,
			s.name,
			s.time,
			s.snippet
		]);
	} else throw new Error("未知导出类型: " + kind);
	const lines = rows.map((r) => r.map((c) => csvCell(c)).join(","));
	const filename = kind + "_" + now + ".csv";
	const filepath = join(exportDir, filename);
	writeFileSync(filepath, lines.join("\n"), "utf8");
	return {
		path: filepath,
		filename,
		count: Math.max(0, rows.length - 1)
	};
}
/** 安全字符串化。 */
function strOf(v) {
	if (v === null || v === void 0) return "";
	if (typeof v === "string") return v;
	if (typeof v === "number" || typeof v === "boolean" || typeof v === "bigint") return String(v);
	return "";
}
/** 百分比字符串。 */
function pctOf(v) {
	const n = Number(v);
	return Number.isFinite(n) ? String(Math.round(n * 100)) + "%" : "";
}
/** 取榜单数组的前 N 项（转成简单对象）。 */
function topOf(arr, limit = 12) {
	if (!Array.isArray(arr)) return [];
	return arr.slice(0, limit).map((it) => {
		const o = it;
		const username = strOf(o["username"]);
		return {
			username,
			name: strOf(o["name"]) || username,
			count: Number(o["count"] ?? 0)
		};
	});
}
/**
* Export the annual report as markdown / html / json.
* @param decryptedDir - decrypted data root.
* @param year - report year.
* @param format - md | html | json.
* @param dir - optional target directory (default exports dir).
* @param filename - optional file name (without extension).
* @returns written file path + filename + message count.
*/
function exportAnnualReport(decryptedDir, year, format, dir, filename) {
	const report = queryAnnualReport(decryptedDir, year);
	const ext = format === "html" ? "html" : format === "json" ? "json" : "md";
	const base = dir && dir.trim() ? dir.trim() : join(dirname(decryptedDir), "exports");
	const safeName = filename && filename.trim() ? filename.trim().replace(/\.(md|html|json)$/i, "") + "." + ext : "wechat_annual_" + String(year) + "." + ext;
	mkdirSync(base, { recursive: true });
	let content = "";
	const total = Number(report["total"] ?? 0);
	const activeDays = Number(report["active_days"] ?? 0);
	const textChars = Number(report["text_chars"] ?? 0);
	const dailyAvg = Number(report["daily_avg"] ?? 0);
	const tags = Array.isArray(report["persona_tags"]) ? report["persona_tags"].map((t) => strOf(t)).join(" ") : "";
	const kinds = report["kind_counts"];
	const kindLine = kinds ? Object.entries(kinds).map(([k, v]) => k + " " + strOf(v)).join(" · ") : "";
	const phrases = Array.isArray(report["top_phrases"]) ? report["top_phrases"].slice(0, 12).map((p) => {
		const o = p;
		return strOf(o["phrase"]) + "(" + strOf(o["count"]) + ")";
	}).join(" · ") : "";
	const emoji = Array.isArray(report["top_emoji"]) ? report["top_emoji"].slice(0, 8).map((e) => {
		const o = e;
		return strOf(o["emoji"]) + "×" + strOf(o["count"]);
	}).join(" ") : "";
	const contacts = topOf(report["top_contacts"]);
	const groups = topOf(report["top_groups"]);
	const firstRaw = report["first_message"];
	const lastRaw = report["last_message"];
	const first = firstRaw == null ? "—" : strOf(firstRaw) || "—";
	const last = lastRaw == null ? "—" : strOf(lastRaw) || "—";
	if (ext === "html") {
		const items = [];
		items.push("<style>body{background:#0b0e13;color:#e6ebf2;font-family:sans-serif;max-width:760px;margin:40px auto;padding:0 18px}h1{color:#22d3ee}h2{border-left:4px solid #22d3ee;padding-left:8px;color:#fff}li{line-height:1.8}</style>");
		items.push("<h1>" + String(year) + " 年，你说了 " + String(total) + " 条消息</h1>");
		items.push("<p>活跃 " + String(activeDays) + " 天 · 文字 " + String(textChars) + " 字 · 日均 " + String(dailyAvg) + " 条 · 人物标签: " + (tags || "—") + "</p>");
		items.push("<p>类型占比: 文字 " + pctOf(report["text_share"]) + " · 深夜 " + pctOf(report["night_share"]) + " · 清晨 " + pctOf(report["morning_share"]) + " · 周末 " + pctOf(report["weekend_share"]) + " · 群聊 " + pctOf(report["group_share"]) + "</p>");
		if (kindLine) items.push("<h2>消息类型</h2><p>" + kindLine + "</p>");
		if (phrases) items.push("<h2>高频短语</h2><p>" + phrases + "</p>");
		if (emoji) items.push("<h2>表情宇宙</h2><p>" + emoji + "</p>");
		if (contacts.length > 0) items.push("<h2>聊得最多的人</h2><ul>" + contacts.map((c) => "<li>" + c.name + " — " + String(c.count) + " 条</li>").join("") + "</ul>");
		if (groups.length > 0) items.push("<h2>最活跃的群聊</h2><ul>" + groups.map((c) => "<li>" + c.name + " — " + String(c.count) + " 条</li>").join("") + "</ul>");
		items.push("<h2>首句与末句</h2><p><b>首句：</b>" + first + "</p><p><b>末句：</b>" + last + "</p>");
		content = "<!doctype html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\"><title>微信年度总结 " + String(year) + "</title>" + items.join("") + "</body></html>";
	} else if (ext === "json") content = JSON.stringify(report, null, 2);
	else {
		const md = [];
		md.push("# 微信年度总结 " + String(year));
		md.push("");
		md.push("总消息 " + String(total) + " 条 · 活跃 " + String(activeDays) + " 天 · 文字 " + String(textChars) + " 字 · 日均 " + String(dailyAvg) + " 条");
		if (tags) md.push("人物标签: " + tags);
		md.push("类型占比: 文字 " + pctOf(report["text_share"]) + " · 深夜 " + pctOf(report["night_share"]) + " · 清晨 " + pctOf(report["morning_share"]) + " · 周末 " + pctOf(report["weekend_share"]) + " · 群聊 " + pctOf(report["group_share"]));
		if (kindLine) md.push("消息类型: " + kindLine);
		if (phrases) md.push("高频短语: " + phrases);
		if (emoji) md.push("表情宇宙: " + emoji);
		if (contacts.length > 0) {
			md.push("聊得最多的人:");
			contacts.forEach((c, i) => md.push(String(i + 1) + ". " + c.name + " — " + String(c.count) + " 条"));
		}
		if (groups.length > 0) {
			md.push("最活跃的群聊:");
			groups.forEach((c, i) => md.push(String(i + 1) + ". " + c.name + " — " + String(c.count) + " 条"));
		}
		md.push("首句: " + first);
		md.push("末句: " + last);
		content = md.join("\n");
	}
	const path = join(base, safeName);
	writeFileSync(path, content, "utf8");
	return {
		path,
		filename: safeName,
		count: total
	};
}
/**
* Export moments (朋友圈) as txt / html / json / csv with optional
* author + time-range filters.
* @param decryptedDir - decrypted data root.
* @param opts - format/username/from/to/dir/filename.
* @returns written file path + filename + count.
*/
function exportMoments(decryptedDir, opts) {
	const format = opts?.format === "html" ? "html" : opts?.format === "json" ? "json" : opts?.format === "csv" ? "csv" : "txt";
	const NL = String.fromCharCode(10);
	const items = [];
	let offset = 0;
	for (;;) {
		const env = queryMoments(decryptedDir, offset, 500, opts?.username);
		items.push(...env.moments);
		offset += env.moments.length;
		if (env.moments.length < 500) break;
		if (items.length > 1e4) break;
	}
	const from = opts?.from ?? 0;
	const to = opts?.to ?? 0;
	const q = (opts?.q ?? "").trim().toLowerCase();
	const authorName = (opts?.authorName ?? "").trim();
	const media = opts?.media;
	const month = opts?.month;
	const mine = opts?.mine;
	const mediaCtx = opts?.images && format === "html" ? exportMediaCtx(decryptedDir) : void 0;
	const filtered = items.filter((m) => {
		if (authorName && m.author !== authorName) return false;
		if (media && media !== "all") {
			if (media === "image" && m.images.length === 0) return false;
			if (media === "video" && m.videos.length === 0) return false;
			if (media === "link" && !(m.link_title || m.contentType === 3 || m.contentType === 28)) return false;
			if (media === "location" && !m.location) return false;
			if (media === "text" && !(m.images.length === 0 && m.videos.length === 0 && !m.link_title)) return false;
		}
		if (mine === "mine" && !m.is_self) return false;
		if (mine === "others" && m.is_self) return false;
		if (month && m.ts) {
			const d = /* @__PURE__ */ new Date(m.ts * 1e3);
			if (String(d.getFullYear()) + "-" + String(d.getMonth() + 1).padStart(2, "0") !== month) return false;
		}
		if (from > 0 && m.ts < from) return false;
		if (to > 0 && m.ts > to) return false;
		if (!q) return true;
		return m.author.toLowerCase().includes(q) || m.text.toLowerCase().includes(q) || m.location.toLowerCase().includes(q) || m.link_title.toLowerCase().includes(q) || (m.link_url ?? "").toLowerCase().includes(q) || (m.sourceNickName ?? "").toLowerCase().includes(q) || (m.publicUserName ?? "").toLowerCase().includes(q) || m.likes.some((l) => (l.nickname || l.username).toLowerCase().includes(q)) || m.comments.some((c) => (c.nickname || c.username).toLowerCase().includes(q) || c.content.toLowerCase().includes(q));
	});
	const base = opts?.dir && opts.dir.trim() ? opts.dir.trim() : join(dirname(decryptedDir), "exports");
	mkdirSync(base, { recursive: true });
	if (opts?.zip) {
		const mediaCtx = exportMediaCtx(decryptedDir);
		const entries = [];
		entries.push({
			name: "moments.json",
			data: JSON.stringify(filtered, null, 2)
		});
		let idx = 0;
		for (const m of filtered) {
			for (const im of m.images) {
				const r = im.md5 ? resolveSnsImageDataUrl(mediaCtx.base, mediaCtx.aesKey, mediaCtx.xorKey, im.md5, im.timelineId, im.id) : { error: "" };
				if (r.url) {
					const buf = dataUrlToBuffer(r.url);
					if (buf) entries.push({
						name: "media/images/img_" + String(idx++) + ".jpg",
						data: buf
					});
				}
				if (entries.length > 5e3) break;
			}
			if (entries.length > 5e3) break;
			for (const v of m.videos) {
				const r = resolveSnsVideoDataUrl(mediaCtx.base, v.md5, v.timelineId, v.id);
				if (r.url) {
					const buf = dataUrlToBuffer(r.url);
					if (buf) entries.push({
						name: "media/videos/vid_" + String(idx++) + ".mp4",
						data: buf
					});
				}
				if (entries.length > 5e3) break;
			}
			if (entries.length > 5e3) break;
		}
		const rawName = (opts.filename ?? "").trim();
		const zipBase = rawName ? rawName.replace(/\.zip$/i, "") : "";
		const zipName = zipBase ? zipBase + ".zip" : "wechat_moments_" + String(Date.now()) + ".zip";
		const zipPath = join(base, zipName);
		writeFileSync(zipPath, zipFiles(entries));
		return {
			path: zipPath,
			filename: zipName,
			count: filtered.length
		};
	}
	const ext = format;
	const name = opts?.filename && opts.filename.trim() ? opts.filename.trim().replace(/\.(txt|html|json|csv)$/i, "") + "." + ext : "wechat_moments_" + String(Date.now()) + "." + ext;
	let content = "";
	if (ext === "json") content = JSON.stringify(filtered, null, 2);
	else if (ext === "csv") {
		const lines = ["时间,作者,内容,图片数,视频数,位置,链接标题,链接URL"];
		for (const m of filtered) lines.push(csvCell(m.time) + "," + csvCell(m.author) + "," + csvCell(m.text) + "," + String(m.images.length) + "," + String(m.videos.length) + "," + csvCell(m.location) + "," + csvCell(m.link_title) + "," + csvCell(m.link_url ?? ""));
		content = lines.join(NL);
	} else if (ext === "html") {
		const parts = [];
		parts.push("<!doctype html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\"><title>微信朋友圈导出</title>");
		parts.push("<style>body{background:#f2f2f2;font-family:sans-serif;margin:0;padding:24px 12px;color:#222}.wrap{max-width:680px;margin:0 auto}.hd{text-align:center;margin-bottom:18px}.card{background:#fff;border-radius:12px;padding:14px 16px;margin:12px 0;box-shadow:0 1px 3px rgba(0,0,0,.08)}.meta{color:#888;font-size:12px;margin-bottom:6px}.content{font-size:14px;line-height:1.6;white-space:pre-wrap}.tag{color:#576b95;font-size:12px;margin-top:6px}.divider{text-align:center;color:#bbb;font-size:12px;margin:14px 0}.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin-top:8px}.grid img{width:100%;aspect-ratio:1;object-fit:cover;border-radius:6px;display:block}.grid.single{grid-template-columns:1fr;max-width:240px}</style></head><body><div class=\"wrap\"><div class=\"hd\"><h1>微信朋友圈</h1><p>共 " + String(filtered.length) + " 条动态</p></div>");
		for (const m of filtered) {
			parts.push("<div class=\"card\"><div class=\"meta\">" + htmlEscape(m.author) + " · " + htmlEscape(m.time) + "</div>");
			if (m.text) parts.push("<div class=\"content\">" + htmlEscape(m.text) + "</div>");
			if (m.images.length > 0) {
				const single = m.images.length === 1 ? " single" : "";
				const imgs = m.images.map((im) => {
					let src = im.url || im.thumb || "";
					if (mediaCtx && im.md5) {
						const r = resolveSnsImageDataUrl(mediaCtx.base, mediaCtx.aesKey, mediaCtx.xorKey, im.md5, im.timelineId, im.id);
						if (r.url) src = r.url;
					}
					return "<img src=\"" + htmlEscape(src) + "\" loading=\"lazy\" />";
				}).join("");
				parts.push("<div class=\"grid" + single + "\">" + imgs + "</div>");
			}
			if (m.videos.length > 0) {
				const cover = m.videos[0] && (m.videos[0].thumb || "");
				parts.push("<div class=\"tag\">视频×" + String(m.videos.length) + (cover ? " <img src=\"" + htmlEscape(cover) + "\" style=\"width:36px;height:36px;object-fit:cover;border-radius:4px;vertical-align:middle;margin-left:4px\" />" : "") + "</div>");
			}
			if (m.location) parts.push("<div class=\"tag\">📍" + htmlEscape(m.location) + "</div>");
			if (m.link_title) {
				const link = m.link_url ? " href=\"" + htmlEscape(m.link_url) + "\" target=\"_blank\" rel=\"noopener\"" : "";
				parts.push("<div class=\"tag\"><a" + link + ">🔗" + htmlEscape(m.link_title) + "</a></div>");
			}
			if (m.likes.length > 0) parts.push("<div class=\"tag\">❤ " + htmlEscape(m.likes.map((l) => l.nickname || l.username || "").join("、")) + "</div>");
			if (m.comments.length > 0) {
				parts.push("<div class=\"tag\">💬 " + String(m.comments.length) + " 条评论</div>");
				for (const c of m.comments) parts.push("<div class=\"tag\" style=\"color:#555\">" + htmlEscape((c.nickname || c.username) + (c.content ? "：" + c.content : "")) + "</div>");
			}
			parts.push("</div>");
		}
		parts.push("</div></body></html>");
		content = parts.join("");
	} else {
		const lines = [];
		for (const m of filtered) {
			lines.push(m.time + " " + m.author);
			if (m.text) lines.push(m.text);
			const tags = [];
			if (m.images.length > 0) tags.push("图片×" + String(m.images.length));
			if (m.videos.length > 0) tags.push("视频×" + String(m.videos.length));
			if (m.location) tags.push("📍" + m.location);
			if (m.link_title) tags.push("🔗" + m.link_title + (m.link_url ? " " + m.link_url : ""));
			if (tags.length > 0) lines.push(tags.join("  "));
			lines.push("---");
		}
		content = lines.join(NL);
	}
	const path = join(base, name);
	writeFileSync(path, content, "utf8");
	return {
		path,
		filename: name,
		count: filtered.length
	};
}
/**
* Export ALL sessions as a single txt ZIP archive (账号归档).
* @param decryptedDir - decrypted data root.
* @param opts - optional dir/filename.
* @returns written zip path + filename + total messages.
*/
function exportAllSessions(decryptedDir, opts) {
	const sessions = querySessions(decryptedDir).sessions.slice(0, 1e3);
	const entries = [];
	const seen = /* @__PURE__ */ new Set();
	let total = 0;
	for (const s of sessions) {
		const msgs = collectMessages(decryptedDir, s.username, 0);
		const safeName = (s.displayName || s.username).replace(/[\\/:*?"<>|]/g, "_").replace(/\s+/g, "_").slice(0, 40);
		const uid = s.username.replace(/[^A-Za-z0-9@._-]/g, "_");
		let name = safeName + "_" + uid + ".txt";
		let n = 2;
		while (seen.has(name)) {
			name = safeName + "_" + uid + "_" + String(n) + ".txt";
			n += 1;
		}
		seen.add(name);
		if (msgs.length === 0) {
			entries.push({
				name,
				data: "（无消息）\n"
			});
			continue;
		}
		entries.push({
			name,
			data: formatTxt(msgs, s.username)
		});
		total += msgs.length;
	}
	const base = opts?.dir && opts.dir.trim() ? opts.dir.trim() : join(dirname(decryptedDir), "exports");
	mkdirSync(base, { recursive: true });
	const filename = opts?.filename && opts.filename.trim() ? opts.filename.trim().endsWith(".zip") ? opts.filename.trim() : opts.filename.trim() + ".zip" : "wechat_all_sessions_" + String(Date.now()) + ".zip";
	const path = join(base, filename);
	writeFileSync(path, zipFiles(entries));
	return {
		path,
		filename,
		count: total
	};
}
//#endregion
//#region lib/types/query/ask.js
/**
* AI Q&A over WeChat data: builds a retrieval context (message search hits)
* that the host gateway feeds to the DSH LLM service. The actual LLM call
* lives in the gateway (needs ctx.llm); this module only prepares the
* context + citations.
*/
/**
* Build the retrieval context for a question: search the message index,
* format the top hits as numbered context lines, and return citations.
* @param decryptedDir - decrypted data root.
* @param question - the user question.
* @param limit - max context hits (default 20).
*/
/**
 * 功能词字符集：一个 bigram 两边都落在这里 → 视为功能词组合，直接丢弃。
 * 中文没有分词器，bigram 是 FTS5 unicode61 下唯一可行的近似，但要剔除
 * 「的是什么 / 给我 / 我的」这类纯功能词组合，否则它们会吃满召回名额。
 */
const ASK_FUNCTION_CHARS = new Set("的了是我你他她它们在有和就都也很还要会能可这那么吗呢吧啊呀哦嗯给过下上个别不没与及或而但因所为以之其中对从到把被让使得着地谁哪几多少么什怎".split(""));
/** 常见功能词/疑问词 bigram：即使含内容字也是噪音。 */
const ASK_STOP_BIGRAMS = new Set([
	"什么", "怎么", "怎样", "如何", "为什", "哪些", "哪个", "是否", "能否",
	"我的", "你的", "他的", "她的", "我们", "你们", "他们", "她们", "咱们",
	"给我", "的是", "了吗", "了吧", "没有", "可以", "已经", "这个", "那个", "这些", "那些",
	"一下", "一起", "一定", "一样", "一直", "告诉", "帮忙", "请问", "麻烦", "知道", "觉得",
	"应该", "可能", "还是", "就是", "不是", "但是", "因为", "所以", "如果", "虽然", "然后",
	"时候", "地方", "东西", "事情", "问题", "多少", "几个", "以及", "并且", "或者", "而且",
	"不过", "只是", "有时", "大概", "也许", "有没有", "是不是", "能不能", "好不好"
]);
/** 「最近/最新/最后」这类**排序意图**词：不参与内容检索，只影响排序。 */
const ASK_RECENCY_WORDS = new Set(["最近", "最新", "最后", "一次", "上次", "上一", "近一", "这两", "这几", "刚刚", "之前", "前一"]);
const ASK_RECENCY_RE = /最近|最新|最后|上一次|上一回|前几天|这两天|这几天|刚刚|近期/;
/** 问题是否在问「最近/最后一次」。 */
function hasRecencyIntent(question) {
	return ASK_RECENCY_RE.test(question || "");
}
/** 把一段文字拆成检索词：拉丁/数字整段 + 中文内容 bigram（去重保序）。 */
function extractAskTerms(text) {
	const out = [];
	const seen = new Set();
	const push = (t) => {
		const v = String(t).trim();
		if (!v || seen.has(v)) return;
		seen.add(v);
		out.push(v);
	};
	// 中英数必须**分段**匹配：否则「丰田合同差额2000的那个客户是谁」会被当成
	// 一个「含数字」的整段直接入词，17 字整句变成唯一检索词 → 全库零命中（实测）。
	for (const run of String(text || "").match(/[\u4e00-\u9fff]+|[A-Za-z0-9]+/g) || []) {
		if (/^[A-Za-z0-9]+$/.test(run)) {
			push(run);
			continue;
		}
		if (run.length <= 3) {
			push(run);
			continue;
		}
		for (let i = 0; i + 2 <= run.length; i += 1) {
			const bg = run.slice(i, i + 2);
			if (ASK_STOP_BIGRAMS.has(bg)) continue;
			if (ASK_FUNCTION_CHARS.has(bg[0]) && ASK_FUNCTION_CHARS.has(bg[1])) continue;
			push(bg);
		}
	}
	return out;
}
/** 组内消息前缀 `wxid_xxx:` 的显示名解析（容忍 `:\n` 与 `: ` 两种分隔）。 */
function splitAskSender(raw) {
	const m = String(raw || "").match(/^([A-Za-z0-9_@.\-]{4,64}):\s/);
	return m ? { sender: m[1], body: String(raw).slice(m[0].length) } : { sender: "", body: String(raw || "") };
}
/** 以首个命中词为中心截取片段（旧实现恒从第 0 字开始，命中点常被截掉）。 */
function centerAskSnippet(text, terms, max = 90) {
	const body = String(text || "").replace(/\s+/g, " ").trim();
	if (body.length <= max) return body;
	let at = -1;
	let hit = "";
	for (const t of terms) {
		const i = body.indexOf(t);
		if (i >= 0 && (at < 0 || i < at)) { at = i; hit = t; }
	}
	if (at < 0) return body.slice(0, max) + "…";
	const start = Math.max(0, at - Math.floor((max - hit.length) / 2));
	const end = Math.min(body.length, start + max);
	return (start > 0 ? "…" : "") + body.slice(start, end) + (end < body.length ? "…" : "");
}
/** 每个词最多取多少条候选（per-term cap，词与词之间互不抢名额）。 */
const ASK_PER_TERM_CAP = 20;
/** 兜底 bigram 的最低支持度：只命中 1 条的多半是跨词切分噪音（次转/三我）。 */
const ASK_MIN_FALLBACK_SUPPORT = 2;
/** 相邻消息归入同一窗口的最大间隔（秒）：超过就是另一次对话了。 */
const ASK_CHUNK_GAP_S = 900;
/** 窗口展开的前后跨度（毫秒），以及窗口内最大条数。 */
const ASK_WINDOW_SPAN_MS = 15 * 60 * 1e3;
const ASK_WINDOW_MAX_MSGS = 14;
/** 最终送给模型的窗口数上限（每个窗口最多 6 行）。 */
const ASK_CHUNK_LIMIT = 10;
const ASK_CHUNK_LINES = 6;
/** 秒级时间戳 → HH:MM。 */
function askClock(ts) {
	if (!ts) return "";
	const d = /* @__PURE__ */ new Date(ts * 1e3);
	const p = (n) => String(n).padStart(2, "0");
	return `${p(d.getHours())}:${p(d.getMinutes())}`;
}
/** 按「同会话 + 时间相邻」把候选消息聚成对话窗口。 */
function clusterAskChunks(ranked) {
	const bySession = /* @__PURE__ */ new Map();
	for (const c of ranked) {
		const list = bySession.get(c.username);
		if (list) list.push(c);
		else bySession.set(c.username, [c]);
	}
	const clusters = [];
	for (const list of bySession.values()) {
		list.sort((a, b) => a.create_time - b.create_time);
		let cur = [];
		for (const c of list) {
			const prev = cur[cur.length - 1];
			if (prev && c.create_time - prev.create_time > ASK_CHUNK_GAP_S) {
				clusters.push(cur);
				cur = [];
			}
			cur.push(c);
		}
		if (cur.length > 0) clusters.push(cur);
	}
	return clusters;
}
/**
 * 把排序后的候选消息展开成对话窗口，并按「窗口内容与检索词的重合度」重排（RAG 的 rerank 段）。
 * 召回按消息做（精确），送给模型的单元是消息所在的连续对话 ——
 * 「谁答应过我下周交报告」的问与答往往分散在相邻两条里。
 */
function buildAskChunks(decryptedDir, ranked, termWeight, person, recency) {
	const clusters = clusterAskChunks(ranked);
	const chunks = [];
	let windowMessages = 0;
	for (const members of clusters) {
		const anchor = members.reduce((a, b) => (b.score > a.score ? b : a));
		const centerMs = Math.round((members[0].create_time + members[members.length - 1].create_time) / 2 * 1e3);
		const win = loadMessageWindow(decryptedDir, anchor.username, centerMs, ASK_WINDOW_SPAN_MS, ASK_WINDOW_MAX_MSGS);
		windowMessages += win.length;
		let lines = (win.length > 0 ? win.map((w) => ({
			time: askClock(w.create_time),
			sender: w.sender ? w.sender : "",
			text: w.text
		})) : [{
			time: askClock(anchor.create_time),
			sender: anchor.sender ?? "",
			text: anchor.snippet
		}]).slice(0, ASK_CHUNK_LINES);
		// 锚点（真正命中的那条）必须出现在窗口里：聚类跨度可能大于窗口跨度、
		// 窗口也可能被条数上限截掉锚点 —— 一旦如此，模型看到的是「一段不包含
		// 命中消息的对话」，窗口级打分也会跟着失真（实测会把最近的转账排到后面）。
		if (win.length > 0 && !win.some((w) => w.local_id === anchor.local_id)) {
			const anchorLine = {
				time: askClock(anchor.create_time),
				sender: anchor.sender ?? "",
				text: anchor.snippet
			};
			const at = lines.findIndex((l) => l.time > anchorLine.time);
			if (at < 0) lines.push(anchorLine);
			else lines.splice(at, 0, anchorLine);
			lines = lines.slice(0, ASK_CHUNK_LINES);
		}
		const blob = lines.map((l) => l.text).join(" ");
		let coverage = 0;
		for (const [t, w] of termWeight) if (blob.includes(t)) coverage += w;
		let score = anchor.score + 0.6 * coverage;
		if (person && (anchor.name.includes(person) || (anchor.sender ?? "").includes(person))) score += 0.5;
		const anchorCite = {
			name: anchor.name,
			time: anchor.time,
			snippet: anchor.snippet,
			username: anchor.username,
			local_id: anchor.local_id
		};
		if (anchor.sender) anchorCite.sender = anchor.sender;
		chunks.push({
			username: anchor.username,
			name: anchor.name,
			anchor: anchorCite,
			lines,
			score,
			pref: anchor.pref,
			createTime: anchor.create_time
		});
	}
	// 窗口级排序沿用消息级的同一套优先级：时间线索 → 窗口得分 → 时间新→旧
	chunks.sort(recency ? (a, b) => (b.pref - a.pref) || (b.createTime - a.createTime) : (a, b) => (b.pref - a.pref) || (b.score - a.score) || (b.createTime - a.createTime));
	return { chunks: chunks.slice(0, ASK_CHUNK_LIMIT), windowMessages };
}
/**
 * 按「规划器关键词 + 问题 bigram」召回候选并统一打分排序。
 * 旧实现是「原问题 → 逐个 bigram，谁先命中谁占名额，到 cap 就停」，
 * 实测 `最近`(20)/`周三`(20) 会把 cap 吃满，导致 `转账`/`李四` 这些真正有区分度的
 * 词根本没被检索。新实现：每词各自召回、用命中数做 IDF 近似加权、统一排序。
 */
function retrieveAskCitations(decryptedDir, question, hints, scope, limit) {
	const cap = Math.min(Math.max(limit ?? 24, 1), 60);
	const recency = hasRecencyIntent(question);
	const personHint = (hints?.person ?? "").trim();
	const planned = (hints?.subQueries ?? []).flatMap((q) => extractAskTerms(q));
	const fallback = extractAskTerms(question);
	const terms = [];
	const seenTerm = new Set();
	const addTerm = (t, base, isPlanned) => {
		if (recency && ASK_RECENCY_WORDS.has(t)) return;
		if (seenTerm.has(t)) return;
		seenTerm.add(t);
		terms.push({ t, base, planned: isPlanned });
	};
	for (const t of planned) addTerm(t, 1, true);
	for (const t of fallback) addTerm(t, 0.35, false);
	const active = terms.slice(0, 12);
	// 时间范围分两档，语义完全不同：
	//   · 用户在界面上选的「时间范围」= **硬过滤**（他明确要求只看这段）；
	//   · 规划器从「上周三」推断出来的日期 = **软偏好**（只是排序倾向）。
	// 后者绝不能当硬过滤：实测把它当过滤时，「上周三我和李四聊了什么」被收窄到
	// 2026-09-02 单日 → 候选 0 条，直接答不出来。推断错了不该让检索归零。
	const hardFromMs = scope?.from ? dayStartMs(scope.from) : NaN;
	const hardToMs = scope?.to ? dayEndMs(scope.to) : NaN;
	const softFromMs = hints?.from ? dayStartMs(hints.from) : NaN;
	const softToMs = hints?.to ? dayEndMs(hints.to) : NaN;
	const inHardRange = (ts) => {
		if (!Number.isFinite(hardFromMs) && !Number.isFinite(hardToMs)) return true;
		const ms = ts * 1e3;
		if (ms <= 0) return false;
		if (Number.isFinite(hardFromMs) && ms < hardFromMs) return false;
		if (Number.isFinite(hardToMs) && ms > hardToMs) return false;
		return true;
	};
	const inSoftRange = (ts) => {
		if (!Number.isFinite(softFromMs) && !Number.isFinite(softToMs)) return true;
		const ms = ts * 1e3;
		if (ms <= 0) return false;
		if (Number.isFinite(softFromMs) && ms < softFromMs) return false;
		if (Number.isFinite(softToMs) && ms > softToMs) return false;
		return true;
	};
	const byKey = new Map();
	let candidates = 0;
	let recallMode = "like";
	// 词 → 权重（IDF 近似），chunk 阶段算窗口覆盖率时复用
	const termWeight = new Map();
	// ── 首选：自建 bigram BM25 索引，一次 MATCH 召回全部词项 ──
	// 旧路径对每个词取「LIKE 命中按行号倒序的前 20 条」= 任意 20 条，
	// 实测 `合同` 全库 4062 条时召回率只有 0.49%；BM25 既按相关度排序又自带真实 IDF。
	// 先用真实 df 过滤词项：规划器词全留，兜底 bigram 至少要有 2 篇文档支持
	let bm25Terms = active.map((x) => x.t);
	if (countIndexMatches(decryptedDir, active[0]?.t ?? "") >= 0) {
		const kept = active.filter((x) => x.planned || countIndexMatches(decryptedDir, x.t) >= ASK_MIN_FALLBACK_SUPPORT);
		if (kept.length > 0) bm25Terms = kept.map((x) => x.t);
	}
	const batch = searchIndexBatch(decryptedDir, bm25Terms, 400, {
		...(scope?.username ? { username: scope.username } : {}),
		...(personHint ? { person: personHint } : {})
	});
	if (batch.ranked && batch.hits.length > 0) {
		recallMode = "bm25";
		const maxScore = batch.hits.reduce((m, h) => Math.max(m, h.score ?? 0), 0) || 1;
		for (const { t, base } of active) {
			let n = 0;
			for (const h of batch.hits) if (String(h.text).includes(t)) n += 1;
			if (n > 0) termWeight.set(t, base / (1 + Math.min(n, 400)));
		}
		const allTerms = active.map((x) => x.t);
		for (const h of batch.hits) {
			if (!inHardRange(h.create_time)) continue;
			const split = splitAskSender(h.text);
			const matched = allTerms.filter((t) => split.body.includes(t));
			// 问某个人时，三条线索都算命中：会话名、群内发送者、**正文里提到他**
			const personMatch = Boolean(personHint && (h.name.includes(personHint) || (h.sender ?? "").includes(personHint) || split.body.includes(personHint)));
			// who 列命中（问某人 → 命中与他的会话）时正文里可能一个词都没有，不能因此丢掉
			if (matched.length === 0 && !personMatch) continue;
			const key = h.username + ":" + h.local_id;
			if (byKey.has(key)) continue;
			let cov = 0;
			for (const t of matched) cov += termWeight.get(t) ?? 0;
			candidates += 1;
			const cand = {
				name: h.name,
				time: h.time,
				snippet: centerAskSnippet(split.body || String(h.snippet ?? ""), allTerms),
				username: h.username,
				local_id: h.local_id,
				create_time: h.create_time,
				score: (h.score ?? 0) / maxScore + 0.4 * cov,
				matched,
				pref: inSoftRange(h.create_time) ? 1 : 0,
				body: split.body
			};
			if (split.sender) cand.sender = split.sender;
			byKey.set(key, cand);
		}
	}
	// ── 兜底：索引未就绪时，每个词各自探测（互不抢名额）──
	let effective = [];
	if (recallMode === "like") {
		const probes = [];
		for (const { t, base, planned: isPlanned } of active) {
			const env = searchIndexMessages(decryptedDir, t, ASK_PER_TERM_CAP, scope?.username);
			probes.push({ t, base, planned: isPlanned, hits: env.hits || [] });
		}
		// 剔除低支持度的兜底 bigram；若所有词都没到阈值，则退回「有一个算一个」
		const usable = probes.filter((p) => p.planned || p.hits.length >= ASK_MIN_FALLBACK_SUPPORT);
		effective = usable.length > 0 ? usable : probes.filter((p) => p.hits.length > 0);
	}
	for (const { t, base, hits } of effective) {
		const w = base / (1 + Math.min(hits.length, ASK_PER_TERM_CAP));
		termWeight.set(t, w);
		for (const h of hits) {
			if (!inHardRange(h.create_time)) continue;
			const key = h.username + ":" + h.local_id;
			let c = byKey.get(key);
			if (!c) {
				const split = splitAskSender(h.text);
				candidates += 1;
				c = {
					name: h.name,
					time: h.time,
					snippet: centerAskSnippet(split.body || String(h.snippet ?? ""), effective.map((x) => x.t)),
					username: h.username,
					local_id: h.local_id,
					create_time: h.create_time,
					score: 0,
					matched: [],
					pref: inSoftRange(h.create_time) ? 1 : 0
				};
				if (split.sender) c.sender = split.sender;
				byKey.set(key, c);
			}
			c.score += w;
			if (!c.matched.includes(t)) c.matched.push(t);
		}
	}
	// 排名：时间线索优先 → 得分 → 命中词数 → 时间新→旧
	const ranked = [...byKey.values()].sort((a, b) => {
		if (a.pref !== b.pref) return b.pref - a.pref;
		if (Math.abs(a.score - b.score) > 1e-9) return b.score - a.score;
		if (a.matched.length !== b.matched.length) return b.matched.length - a.matched.length;
		return b.create_time - a.create_time;
	});
	const person = personHint;
	if (person) {
		// 人物线索权重要**压过**归一化 BM25 的微小差值（BM25 挤在 0~1，+0.5 不够）；
		// 正文里点名也算 —— 「合同表单里写着李四」正是问题在问的东西
		for (const c of ranked) if (c.name.includes(person) || (c.sender ?? "").includes(person) || (c.body ?? "").includes(person)) c.score += 1;
		ranked.sort((a, b) => (b.pref - a.pref) || (b.score - a.score) || (b.create_time - a.create_time));
	}
	// 「最近/最新/最后一次」：在**命中全部规划器内容词**的候选里按时间新→旧。
	// BM25 偏好「短文本 + 该词多次出现」的讨论型消息，实测会把群里讨论转账脚本的
	// 消息排在真正的转账通知之前；语义上「最近一次 X」就是「命中 X 的最新一条」。
	if (recency && ranked.length > 1) {
		const plannedTerms = active.filter((x) => x.planned).map((x) => x.t);
		const key = plannedTerms.length > 0 ? plannedTerms : active.map((x) => x.t);
		const isStrong = (c) => key.every((t) => c.matched.includes(t));
		const strong = ranked.filter(isStrong);
		const weak = ranked.filter((c) => !isStrong(c));
		strong.sort((a, b) => (b.pref - a.pref) || (b.create_time - a.create_time));
		ranked.length = 0;
		ranked.push(...strong, ...weak);
	}
	const keptRanked = ranked.slice(0, cap);
	// RAG 第三步：把「单条消息」升级成「对话窗口」并按窗口内容重排
	const chunked = buildAskChunks(decryptedDir, keptRanked, termWeight, person, recency);
	const chunks = chunked.chunks;
	const citations = chunks.map((c) => c.anchor);
	const usedTerms = active.filter((x) => termWeight.has(x.t)).map((x) => x.t);
	const scopeDesc = [
		scope?.username ? "会话限定" : "",
		scope?.from ? `起 ${scope.from}` : "",
		scope?.to ? `止 ${scope.to}` : ""
	].filter(Boolean).join(" ") || "全库";
	const timeHint = (hints?.from || hints?.to) ? `${hints?.from || "…"} ~ ${hints?.to || "…"}` : "";
	const hasSoftHint = Number.isFinite(softFromMs) || Number.isFinite(softToMs);
	return {
		citations,
		chunks,
		terms: usedTerms,
		stats: {
			terms: usedTerms.length,
			probed: active.length,
			candidates,
			kept: citations.length,
			scope: scopeDesc,
			recency,
			timeHint,
			hintHits: hasSoftHint ? keptRanked.filter((c) => c.pref === 1).length : 0,
			chunks: chunks.length,
			windowMessages: chunked.windowMessages,
			recall: recallMode
		}
	};
}
/** 把检索结果格式化成给 LLM 的上下文块（群聊带上发送者，回答「谁说过什么」才有依据）。 */
function formatAskContext(citations, meta, chunks) {
	if (citations.length === 0) return "（本机微信聊天记录中未检索到相关消息。请直接说明未检索到，并给出可以缩小或换种问法的建议，不要编造。）";
	const hintLine = meta?.timeHint ? (meta.hintHits && meta.hintHits > 0 ? `时间线索：${meta.timeHint}（优先展示，其中 ${meta.hintHits} 条落在该范围内）` : `时间线索：${meta.timeHint}（该范围内没有命中，以下为放宽时间后的结果，回答时不要声称限定在该日期）`) : "";
	const head = [
		meta?.intent ? `检索意图：${meta.intent}` : "",
		meta?.terms?.length ? `实际检索词：${meta.terms.join(" / ")}` : "",
		meta?.scope ? `检索范围：${meta.scope}` : "",
		hintLine,
		meta?.recency ? "排序：按时间新→旧（问题在问“最近/最后一次”）" : ""
	].filter(Boolean).join("；");
	const blocks = [];
	if (chunks && chunks.length > 0) {
		chunks.forEach((ch, i) => {
			const who = ch.anchor.sender ? `${ch.name} · ${ch.anchor.sender}` : ch.name;
			const day = (ch.anchor.time || "").slice(0, 10);
			const body = ch.lines.map((l) => `    ${l.time}${l.sender ? " " + l.sender : ""}：${l.text}`).join("\n");
			blocks.push(`[${i + 1}] ${who}（${day}，命中时间 ${(ch.anchor.time || "").slice(11)}）\n${body}`);
		});
	} else {
		citations.forEach((c, i) => {
			const who = c.sender ? `${c.name} · ${c.sender}` : c.name;
			blocks.push(`[${i + 1}] ${who} (${c.time}): ${c.snippet}`);
		});
	}
	return `${head ? head + "\n" : ""}以下是本机微信聊天记录中检索到的相关对话片段（每个 [n] 是一段连续对话，已按相关度排序），是回答的唯一事实依据：\n${blocks.join("\n\n")}`;
}
/** Start-of-day epoch ms for a YYYY-MM-DD string (NaN when invalid). */
function dayStartMs(s) {
	return (/* @__PURE__ */ new Date(s + "T00:00:00")).getTime();
}
/** End-of-day epoch ms for a YYYY-MM-DD string (NaN when invalid). */
function dayEndMs(s) {
	return (/* @__PURE__ */ new Date(s + "T23:59:59")).getTime();
}
/**
* Build the retrieval context for a question: search the message index with
* the raw question then CJK bigrams, union the top hits, and return citations.
* @param decryptedDir - decrypted data root.
* @param question - the user question.
* @param limit - max context hits (default 20).
* @param scope - optional talker and/or date-range filter.
* @returns the formatted context lines plus source citations.
*/
function buildAskContext(decryptedDir, question, limit, scope) {
	const { citations, chunks, terms, stats } = retrieveAskCitations(decryptedDir, question, void 0, scope, limit ?? 24);
	return {
		context: formatAskContext(citations, { terms, scope: stats.scope, recency: stats.recency }),
		citations
	};
}
/** 解析检索规划 LLM 的 JSON 输出（容忍 ```json 围栏与前后杂文；取不到时返回空规划）。 */
function parseAskPlan(text) {
	const out = { intent: "", subQueries: [], from: "", to: "", person: "" };
	if (!text) return out;
	let t = String(text).trim();
	const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
	if (fence) t = fence[1].trim();
	const start = t.indexOf("{");
	const end = t.lastIndexOf("}");
	if (start >= 0 && end > start) try {
		const obj = JSON.parse(t.slice(start, end + 1));
		if (typeof obj.intent === "string") out.intent = obj.intent.slice(0, 200);
		if (Array.isArray(obj.subQueries)) out.subQueries = obj.subQueries.filter((x) => typeof x === "string" && x.trim()).map((x) => x.trim().slice(0, 100)).slice(0, 4);
		// 日期必须严格是 YYYY-MM-DD 才采用：模型偶尔会回「上周三」这种相对描述，
		// 直接当 from/to 用会把检索范围悄悄收窄成空集。
		const day = (v) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v.trim()) ? v.trim() : "");
		out.from = day(obj.from);
		out.to = day(obj.to);
		if (typeof obj.person === "string") out.person = obj.person.trim().slice(0, 40);
	} catch {}
	return out;
}
/** 从回答正文里解析模型实际引用的来源序号（1 基），用于给「来源」列表做标记。 */
function parseCitedIndexes(answer, citationCount) {
	const out = new Set();
	for (const m of String(answer || "").matchAll(/\[(\d{1,3})\]/g)) {
		const n = Number(m[1]);
		if (n >= 1 && n <= citationCount) out.add(n);
	}
	return [...out].sort((a, b) => a - b);
}
/** 解析提问优化 LLM 的 JSON 输出（容忍围栏/杂文；解析失败时优化结果为空串由调用方兜底）。 */
function parseAskOptimize(text) {
	const out = { optimized: "", suggestions: [] };
	if (!text) return out;
	let t = String(text).trim();
	const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
	if (fence) t = fence[1].trim();
	const start = t.indexOf("{");
	const end = t.lastIndexOf("}");
	if (start >= 0 && end > start) try {
		const obj = JSON.parse(t.slice(start, end + 1));
		if (typeof obj.optimized === "string") out.optimized = obj.optimized.trim().slice(0, 500);
		if (Array.isArray(obj.suggestions)) out.suggestions = obj.suggestions.filter((x) => typeof x === "string" && x.trim()).map((x) => x.trim().slice(0, 200)).slice(0, 4);
	} catch {}
	return out;
}
//#endregion
//#region lib/types/query/backup.js
/**
* Backup manager: list / create / delete local snapshots of the decrypted
* WeChat DBs. Plain create makes a timestamped directory copy; encrypted
* create writes an AES-256-GCM `.wcb` bundle (scrypt key, HMAC-authenticated
* header, per-file IVs) that restoreBackup decrypts back to a directory.
*/
const MAGIC = Buffer.from("DSHWCB1\n", "utf8");
const SALT_LEN = 16;
const VERSION = 1;
/** Backup root dir: sibling of the decrypted dir. */
function backupDir(decryptedDir) {
	return join(dirname(decryptedDir), "backups");
}
function skipName(name) {
	return name.endsWith("-wal") || name.endsWith("-shm");
}
function collectFiles(root) {
	const out = [];
	const walk = (dir) => {
		if (!existsSync(dir)) return;
		for (const e of readdirSync(dir, { withFileTypes: true })) {
			if (skipName(e.name)) continue;
			const p = join(dir, e.name);
			if (e.isDirectory()) walk(p);
			else out.push({
				abs: p,
				rel: relative(root, p).split("\\").join("/"),
				size: statSync(p).size
			});
		}
	};
	walk(root);
	return out;
}
function dirSize(dir) {
	let size = 0;
	const walk = (d) => {
		for (const e of readdirSync(d, { withFileTypes: true })) {
			const p = join(d, e.name);
			if (e.isDirectory()) walk(p);
			else try {
				size += statSync(p).size;
			} catch {}
		}
	};
	walk(dir);
	return size;
}
/** Bounded content summary (items + .db count + capability composition); caps the walk. */
function dirSummary(dir) {
	let items = 0;
	let db = 0;
	const dbNames = /* @__PURE__ */ new Set();
	const walk = (d, depth) => {
		if (items > 2e4 || depth > 6) return;
		for (const e of readdirSync(d, { withFileTypes: true })) {
			if (skipName(e.name)) continue;
			items += 1;
			const p = join(d, e.name);
			if (e.isDirectory()) walk(p, depth + 1);
			else if (e.name.endsWith(".db")) {
				db += 1;
				dbNames.add(e.name.toLowerCase());
			}
		}
	};
	try {
		walk(dir, 0);
	} catch {}
	const has = (kw) => Array.from(dbNames).some((n) => n.includes(kw));
	const parts = [];
	if (has("sns")) parts.push("朋友圈");
	if (has("msg") || has("micro") || has("wxmsg")) parts.push("会话");
	if (has("contact") || has("address")) parts.push("通讯录");
	if (has("favorite") || has("fav")) parts.push("收藏");
	const comp = parts.length > 0 ? "（含 " + parts.join("/") + " 库）" : "";
	return (db > 0 ? `${items} 项 · ${db} 个库` : `${items} 项`) + comp;
}
/** Integrity check: dir backup looks like a DB snapshot; enc has the .wcb header. */
function backupOk(path, kind) {
	try {
		if (kind === "enc") {
			const fd = openSync(path, "r");
			try {
				const buf = Buffer.alloc(MAGIC.length);
				readSync(fd, buf, 0, MAGIC.length, 0);
				return buf.equals(MAGIC);
			} finally {
				closeSync(fd);
			}
		}
		let hasDb = false;
		for (const e of readdirSync(path, { withFileTypes: true })) {
			if (e.isDirectory()) {
				for (const sub of readdirSync(join(path, e.name))) if (sub.endsWith(".db")) {
					hasDb = true;
					break;
				}
			} else if (e.name.endsWith(".db")) {
				hasDb = true;
				break;
			}
			if (hasDb) break;
		}
		return hasDb;
	} catch {
		return false;
	}
}
/**
* Preview a backup's contents (bounded file/db list) before restore.
* @param decryptedDir - decrypted data root.
* @param name - backup name.
* @returns the preview snapshot (bounded items) or an empty result.
*/
function previewBackup(decryptedDir, name) {
	const p = join(backupDir(decryptedDir), name);
	if (!existsSync(p)) return {
		items: [],
		total: 0
	};
	const st = statSync(p);
	const items = [];
	const push = (rel, size, isDir) => {
		if (items.length >= 500) return;
		items.push({
			name: rel,
			size,
			isDir
		});
	};
	if (st.isDirectory()) {
		const walk = (d, prefix) => {
			if (items.length >= 500) return;
			let entries = [];
			try {
				entries = readdirSync(d, { withFileTypes: true }).map((e) => ({
					n: e.name,
					isDir: e.isDirectory()
				}));
			} catch {
				return;
			}
			for (const e of entries) {
				if (skipName(e.n)) continue;
				if (items.length >= 500) return;
				const abs = join(d, e.n);
				const rel = prefix ? prefix + "/" + e.n : e.n;
				if (e.isDir) {
					push(rel, 0, true);
					walk(abs, rel);
				} else {
					let size = 0;
					try {
						size = statSync(abs).size;
					} catch {}
					push(rel, size, false);
				}
			}
		};
		walk(p, "");
	} else push(name, st.size, false);
	return {
		items,
		total: items.length
	};
}
/**
* List existing backups (name, size, modified, kind).
* @param decryptedDir - decrypted data root.
* @returns backup items plus total count.
*/
function listBackups(decryptedDir) {
	const dir = backupDir(decryptedDir);
	if (!existsSync(dir)) return {
		items: [],
		total: 0
	};
	const items = [];
	for (const name of readdirSync(dir).sort().reverse()) {
		const p = join(dir, name);
		try {
			const st = statSync(p);
			if (st.isDirectory()) items.push({
				name,
				path: p,
				size: dirSize(p),
				modified: Math.floor(st.mtimeMs / 1e3),
				kind: "dir",
				summary: dirSummary(p),
				ok: backupOk(p, "dir")
			});
			else if (name.endsWith(".wcb")) items.push({
				name,
				path: p,
				size: st.size,
				modified: Math.floor(st.mtimeMs / 1e3),
				kind: "enc",
				summary: "AES-256 加密备份",
				ok: backupOk(p, "enc")
			});
		} catch {}
	}
	return {
		items,
		total: items.length
	};
}
/**
* Create a timestamped directory backup of the decrypted DBs.
* @param decryptedDir - decrypted data root.
* @returns the created backup entry.
*/
function createBackup(decryptedDir) {
	const name = "wechat_backup_" + (/* @__PURE__ */ new Date()).toISOString().replace(/[-:]/g, "").slice(0, 14);
	const dir = backupDir(decryptedDir);
	mkdirSync(dir, { recursive: true });
	const target = join(dir, name);
	if (existsSync(target)) rmSync(target, {
		recursive: true,
		force: true
	});
	mkdirSync(target, { recursive: true });
	if (existsSync(decryptedDir)) for (const sub of readdirSync(decryptedDir, { withFileTypes: true })) {
		if (!sub.isDirectory()) continue;
		if (sub.name.startsWith(".")) continue;
		try {
			cpSync(join(decryptedDir, sub.name), join(target, sub.name), { recursive: true });
		} catch {}
	}
	const st = statSync(target);
	return {
		name,
		path: target,
		size: dirSize(target),
		modified: Math.floor(st.mtimeMs / 1e3),
		kind: "dir"
	};
}
/**
* Create an encrypted `.wcb` backup bundle.
* @param decryptedDir - decrypted data root.
* @param password - encryption password.
* @returns the created backup entry.
*/
async function createEncryptedBackup(decryptedDir, password) {
	const name = "wechat_backup_" + (/* @__PURE__ */ new Date()).toISOString().replace(/[-:]/g, "").slice(0, 14) + ".wcb";
	const dir = backupDir(decryptedDir);
	mkdirSync(dir, { recursive: true });
	const target = join(dir, name);
	const salt = randomBytes(SALT_LEN);
	const key = scryptSync(password, salt, 32);
	const files = collectFiles(decryptedDir);
	const header = {
		version: VERSION,
		files: files.map((f) => ({
			name: f.rel,
			size: f.size,
			iv: randomBytes(12).toString("base64")
		}))
	};
	const headerBuf = Buffer.from(JSON.stringify(header), "utf8");
	const mac = createHmac("sha256", key).update(headerBuf).digest();
	const out = createWriteStream(target);
	out.write(MAGIC);
	out.write(salt);
	const lenBuf = Buffer.alloc(4);
	lenBuf.writeUInt32BE(headerBuf.length);
	out.write(lenBuf);
	out.write(headerBuf);
	out.write(mac);
	for (let i = 0; i < files.length; i += 1) {
		const f = header.files[i];
		const src = files[i];
		if (!f || !src) continue;
		const cipher = createCipheriv("aes-256-gcm", key, Buffer.from(f.iv, "base64"));
		for await (const chunk of createReadStream(src.abs)) out.write(cipher.update(chunk));
		out.write(cipher.final());
		out.write(cipher.getAuthTag());
	}
	await new Promise((resolve, reject) => {
		out.end(() => {
			resolve();
		});
		out.on("error", reject);
	});
	const st = statSync(target);
	return {
		name,
		path: target,
		size: st.size,
		modified: Math.floor(st.mtimeMs / 1e3),
		kind: "enc"
	};
}
/**
* Restore an encrypted `.wcb` backup into `<backups>/<name>.restored`.
* @param decryptedDir - decrypted data root.
* @param name - backup file name (must end .wcb).
* @param password - encryption password.
* @returns restore result with the extracted path.
*/
function restoreEncryptedBackup(decryptedDir, name, password) {
	const dir = backupDir(decryptedDir);
	const src = join(dir, name);
	if (!name.endsWith(".wcb") || !existsSync(src)) return {
		ok: false,
		error: "加密备份不存在"
	};
	const target = join(dir, name.replace(/\.wcb$/, "") + ".restored");
	if (existsSync(target)) rmSync(target, {
		recursive: true,
		force: true
	});
	let fd = null;
	try {
		fd = openSync(src, "r");
		if (!readExactFd(fd, MAGIC.length).equals(MAGIC)) return {
			ok: false,
			error: "不是有效的加密备份文件"
		};
		const salt = readExactFd(fd, SALT_LEN);
		const headerLen = readExactFd(fd, 4).readUInt32BE(0);
		const headerBuf = readExactFd(fd, headerLen);
		const mac = readExactFd(fd, 32);
		const key = scryptSync(password, salt, 32);
		const expect = createHmac("sha256", key).update(headerBuf).digest();
		if (!mac.equals(expect)) return {
			ok: false,
			error: "密码错误或文件被篡改"
		};
		const header = JSON.parse(headerBuf.toString("utf8"));
		for (const f of header.files) {
			const iv = Buffer.from(f.iv, "base64");
			const cipherText = readExactFd(fd, f.size);
			const tag = readExactFd(fd, 16);
			const decipher = createDecipheriv("aes-256-gcm", key, iv);
			decipher.setAuthTag(tag);
			const outPath = join(target, f.name.split("/").join(process.platform === "win32" ? "\\" : "/"));
			mkdirSync(dirname(outPath), { recursive: true });
			try {
				writeFileSync(outPath, Buffer.concat([decipher.update(cipherText), decipher.final()]));
			} catch {
				return {
					ok: false,
					error: "解密校验失败（数据损坏或密码错误）"
				};
			}
		}
		return {
			ok: true,
			path: target
		};
	} catch (e) {
		return {
			ok: false,
			error: e.message
		};
	} finally {
		if (fd !== null) closeSync(fd);
	}
}
function readExactFd(fd, size) {
	const buf = Buffer.alloc(size);
	let off = 0;
	while (off < size) {
		const n = readSync(fd, buf, off, size - off, null);
		if (n <= 0) throw new Error("备份文件读取被截断");
		off += n;
	}
	return buf;
}
/**
* Delete one backup by name.
* @param decryptedDir - decrypted data root.
* @param name - backup name to delete.
* @returns ok, or an error description when the backup cannot be removed.
*/
function deleteBackup(decryptedDir, name) {
	const dir = backupDir(decryptedDir);
	const target = join(dir, name);
	if (!target.startsWith(dir) || !existsSync(target)) return {
		ok: false,
		error: "备份不存在"
	};
	try {
		rmSync(target, {
			recursive: true,
			force: true
		});
		return { ok: true };
	} catch (e) {
		return {
			ok: false,
			error: e.message
		};
	}
}
//#endregion
//#region lib/types/query/daily-summary.js
/**
* Daily chat summary: collect one day of messages across all sessions,
* then the host gateway sends them to the DSH LLM for a Chinese summary.
* Collection is pure; the LLM call lives in the gateway (needs ctx.llm).
*/
/** Msg_<md5(username)> table name for a talker. */
function msgTableName$2(username) {
	return "Msg_" + createHash("md5").update(username, "utf8").digest("hex");
}
/** Message shard DB files under <decrypted>/message. */
function messageShardFiles$1(decryptedDir) {
	const dir = join(decryptedDir, "message");
	if (!existsSync(dir)) return [];
	return readdirSync(dir).filter((f) => f.endsWith(".db") && !f.includes("_shm") && !f.includes("_wal") && !f.includes("monitor_cache")).sort().map((f) => join(dir, f));
}
/** Session usernames from session.db (SessionTable or Session). */
function loadSessionUsernames(decryptedDir) {
	const dbPath = join(decryptedDir, "session", "session.db");
	if (!existsSync(dbPath)) return [];
	const out = [];
	try {
		const db = new DatabaseSync(dbPath, { readOnly: true });
		const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
		const table = tables.includes("SessionTable") ? "SessionTable" : tables.includes("Session") ? "Session" : "";
		if (table) {
			const rows = db.prepare("SELECT username FROM \"" + table + "\"").all();
			for (const r of rows) {
				const u = cellStr$6(r["username"] ?? "").trim();
				if (u) out.push(u);
			}
		}
		db.close();
	} catch {}
	return out;
}
/** Coerce a DB cell to a string (null -> '', else String()). */
function cellStr$6(v) {
	if (typeof v === "string") return v;
	if (v === null || v === void 0) return "";
	if (typeof v === "number" || typeof v === "boolean" || typeof v === "bigint" || typeof v === "symbol") return String(v);
	return "";
}
/** zstd magic bytes (WCDB compressed blobs). */
const ZSTD_MAGIC$4 = Buffer.from([
	40,
	181,
	47,
	253
]);
/** Decode raw column bytes: zstd-decompress when the magic matches. */
function tryDecompress(data) {
	if (data.length >= 4 && data.subarray(0, 4).equals(ZSTD_MAGIC$4)) try {
		return Buffer.from(decompress(data));
	} catch {
		return null;
	}
	return null;
}
/** Decode bytes as UTF-8, falling back to GBK when UTF-8 leaves replacement chars. */
function decodeUtfOrGbk(bytes) {
	const utf8 = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
	if (!utf8.includes("�")) return utf8;
	try {
		const gbk = new TextDecoder("gbk", { fatal: false }).decode(bytes);
		const utf8Bad = (utf8.match(/\uFFFD/g) ?? []).length;
		return (gbk.match(/\uFFFD/g) ?? []).length < utf8Bad ? gbk : utf8;
	} catch {
		return utf8;
	}
}
/** Decode a BLOB or TEXT cell to text (zstd-decompress, then UTF-8/GBK). */
function decodeCell$4(v) {
	if (v === null || v === void 0) return "";
	if (typeof v === "string") return v;
	if (typeof v === "number" || typeof v === "boolean" || typeof v === "bigint" || typeof v === "symbol") return String(v);
	const raw = Buffer.from(v instanceof Uint8Array ? v : []);
	return decodeUtfOrGbk(tryDecompress(raw) ?? raw);
}
/** Strip XML tags for a plain snippet. */
function stripXml(xml) {
	return xml.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);
}
/** Heuristic: true when a decoded line looks like human chat text (rejects numeric/base64/JSON/binary/system noise). */
function isHumanText(text) {
	const t = (text || "").trim();
	if (!t || t.length < 2) return false;
	if (t.includes("�")) return false;
	let printable = 0, space = 0, cjk = 0, base64 = 0;
	for (let i = 0; i < t.length; i += 1) {
		const cc = t.charCodeAt(i);
		const ch = t[i] ?? "";
		if (cc >= 32 && cc <= 126 || cc >= 128) printable += 1;
		if (ch === " " || ch === "　") space += 1;
		if (cc >= 19968 && cc <= 40959) cjk += 1;
		if (/[A-Za-z0-9+/=]/.test(ch)) base64 += 1;
	}
	if (printable / t.length < .6) return false;
	if (/^[\d\s.,，。;；:：!！?？+*#\-—/]+$/.test(t)) return false;
	const nonSpace = t.length - space;
	if (nonSpace >= 40 && base64 / nonSpace > .75 && cjk === 0) return false;
	if ((t.startsWith("{") || t.startsWith("[")) && t.includes(":")) return false;
	if (cjk === 0 && nonSpace - base64 < 8) return false;
	return true;
}
/** Human label for a normalized message type. */
function typeLabel(t) {
	if (t === 1) return "文本";
	if (t === 3) return "图片";
	if (t === 34) return "语音";
	if (t === 42) return "名片";
	if (t === 43) return "视频";
	if (t === 47) return "表情";
	if (t === 48) return "位置";
	if (t === 49) return "链接";
	if (t === 1e4) return "系统消息";
	return "其他";
}
const EMPTY_COLLECTED = {
	lines: [],
	count: 0,
	sessions: 0,
	total: 0,
	types: {},
	hourly: [],
	topSessions: []
};
function tableColumns$7(db, table) {
	const rows = db.prepare(`PRAGMA table_info("${table}")`).all();
	return new Set(rows.map((r) => r.name));
}
/** Shared range collection across sessions (chronological, capped per session). */
function collectRange(decryptedDir, start, end, cap, groupUsername, collectSources = false) {
	const lines = [];
	const sources = [];
	let sessions = 0;
	let total = 0;
	const hourly = new Array(24).fill(0);
	const types = /* @__PURE__ */ new Map();
	const perSession = /* @__PURE__ */ new Map();
	const sessionUsernames = loadSessionUsernames(decryptedDir);
	const tableToUser = /* @__PURE__ */ new Map();
	for (const username of sessionUsernames) tableToUser.set(msgTableName$2(username), username);
	const fileInfos = [];
	for (const shard of messageShardFiles$1(decryptedDir)) {
		let probe = null;
		try {
			probe = new DatabaseSync(shard, { readOnly: true });
		} catch {
			continue;
		}
		try {
			const names = probe.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'Msg_%'").all().map((r) => r.name);
			const tables = [];
			for (const n of names) {
				const u = tableToUser.get(n);
				if (u) tables.push([n, u]);
			}
			if (tables.length > 0) fileInfos.push({
				path: shard,
				tables
			});
		} catch {} finally {
			probe.close();
		}
	}
	for (const fi of fileInfos) {
		let db = null;
		try {
			db = new DatabaseSync(fi.path, { readOnly: true });
		} catch {
			continue;
		}
		try {
			for (const [table, username] of fi.tables) {
				if (groupUsername && username !== groupUsername) continue;
				const picked = [];
				try {
					const statRows = db.prepare("SELECT COUNT(*) c, CAST(strftime('%H', datetime(create_time, 'unixepoch')) AS INTEGER) h, local_type lt FROM \"" + table + "\" WHERE create_time >= ? AND create_time < ? GROUP BY h, lt").all(start, end);
					for (const sr of statRows) {
						const c = sr.c;
						total += c;
						const h = sr.h;
						if (h >= 0 && h < 24) hourly[h] = (hourly[h] ?? 0) + c;
						const lt = sr.lt;
						const label = typeLabel(lt > 4294967296 ? lt % 4294967296 : lt);
						types.set(label, (types.get(label) ?? 0) + c);
					}
					perSession.set(username, (perSession.get(username) ?? 0) + statRows.reduce((a, r) => a + r.c, 0));
					const hasLocal = tableColumns$7(db, table).has("local_id");
					const select = "SELECT create_time, message_content, local_type" + (hasLocal ? ", local_id" : "") + " FROM \"" + table + "\" WHERE create_time >= ? AND create_time < ? ORDER BY create_time ASC LIMIT ?";
					const rows = db.prepare(select).all(start, end, cap);
					for (const r of rows) {
						const t = Number(r["create_time"] ?? 0);
						const lt = Number(r["local_type"] ?? 0);
						const normLt = lt > 4294967296 ? lt % 4294967296 : lt;
						if (normLt === 1e4 || normLt === 10002) continue;
						const text = stripXml(decodeCell$4(r["message_content"]));
						if (isHumanText(text)) {
							picked.push({
								t,
								text
							});
							if (collectSources) sources.push({
								index: sources.length,
								username,
								localId: hasLocal ? Number(r["local_id"] ?? 0) : 0,
								time: t,
								text
							});
						}
					}
				} catch {}
				if (picked.length >= cap) break;
				if (picked.length > 0) {
					sessions += 1;
					lines.push("【" + username + "】");
					for (const p of picked) lines.push(p.text);
				}
			}
		} finally {
			db.close();
		}
	}
	const topSessions = Array.from(perSession.entries()).map(([username, count]) => ({
		username,
		count
	})).sort((a, b) => b.count - a.count).slice(0, 8);
	return {
		lines,
		count: lines.length,
		sessions,
		total,
		types: Object.fromEntries(types),
		hourly,
		topSessions,
		sources
	};
}
/** Local-date parser used by day/period collection. */
function toStartSeconds(date, plusDays = 0) {
	const parts = date.split("-").map((n) => parseInt(n, 10));
	if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) return NaN;
	return Math.floor(new Date(parts[0], parts[1] - 1, parts[2] + plusDays).getTime() / 1e3);
}
/**
* Collect one day of messages across sessions (chronological, capped).
* @param decryptedDir - decrypted data root.
* @param date - YYYY-MM-DD local date.
* @param maxPerSession - cap messages per session (default 30).
* @param groupUsername - optional session filter (only this talker).
* @returns per-session message lines.
*/
function collectDayMessages(decryptedDir, date, maxPerSession, groupUsername) {
	const cap = Math.min(maxPerSession ?? 30, 200);
	const start = toStartSeconds(date);
	const end = toStartSeconds(date, 1);
	if (!Number.isFinite(start) || !Number.isFinite(end)) return EMPTY_COLLECTED;
	return collectRange(decryptedDir, start, end, cap, groupUsername);
}
/**
* Collect messages across an inclusive local date range.
* @param decryptedDir - decrypted data root.
* @param from - first date (YYYY-MM-DD).
* @param to - last date (YYYY-MM-DD, inclusive).
* @param maxPerSession - cap messages per session (default 30).
* @param groupUsername - optional session filter (only this talker).
* @returns per-session message lines.
*/
function collectPeriodMessages(decryptedDir, from, to, maxPerSession, groupUsername) {
	const cap = Math.min(maxPerSession ?? 30, 200);
	const start = toStartSeconds(from);
	const end = toStartSeconds(to, 1);
	if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) return EMPTY_COLLECTED;
	return collectRange(decryptedDir, start, end, cap, groupUsername);
}
//#endregion
//#region lib/types/query/ledger.js
/**
* Funds ledger: aggregates transferTable / redEnvelopeTable rows, resolves
* amounts and timestamps from message shards by server_id, and derives
* per-contact totals plus fund anomaly warnings.
*/
const ZSTD_MAGIC$3 = Buffer.from([
	40,
	181,
	47,
	253
]);
/** Decode a BLOB/TEXT cell to UTF-8 text (zstd + GBK aware). */
function decodeCell$3(v) {
	if (v === null || v === void 0) return "";
	if (typeof v === "string") return v;
	if (typeof v === "number" || typeof v === "boolean" || typeof v === "bigint" || typeof v === "symbol") return String(v);
	const raw = Buffer.from(v instanceof Uint8Array ? v : []);
	const decompressed = raw.length >= 4 && raw.subarray(0, 4).equals(ZSTD_MAGIC$3) ? (() => {
		try {
			return Buffer.from(decompress(raw));
		} catch {
			return raw;
		}
	})() : raw;
	try {
		return new TextDecoder("utf-8", { fatal: false }).decode(decompressed);
	} catch {
		return new TextDecoder("gbk", { fatal: false }).decode(decompressed);
	}
}
/** Resolve server ids to raw message rows (amount via XML, create_time). */
function resolveMessagesByServerIds(decryptedDir, serverIds) {
	const out = /* @__PURE__ */ new Map();
	if (serverIds.length === 0) return out;
	const pending = [...new Set(serverIds)].filter(Boolean);
	const numeric = /* @__PURE__ */ new Map();
	for (const id of pending) if (/^\d+$/.test(id)) try {
		numeric.set(id, BigInt(id));
	} catch {}
	const shards = shardCatalogDirs(decryptedDir, ["message"]);
	const scan = (serverExpr, params) => {
		const placeholders = params.map(() => "?").join(",");
		for (const shard of shards) {
			let db;
			try {
				db = new DatabaseSync(shard.file, {
					readOnly: true,
					readBigInts: true
				});
			} catch {
				continue;
			}
			try {
				for (const [table, meta] of shard.tables) {
					if (!meta.cols.has("server_id") || !meta.cols.has("message_content")) continue;
					const sel = [
						meta.cols.has("local_id") ? "local_id" : "0",
						meta.cols.has("create_time") ? "create_time" : "0",
						"message_content",
						`${serverExpr} AS server_id`
					].join(", ");
					try {
						const rows = db.prepare(`SELECT ${sel} FROM "${table}" WHERE ${serverExpr} IN (${placeholders})`).all(...params);
						for (const r of rows) {
							const sid = decodeCell$3(r["server_id"]).trim();
							if (sid && !out.has(sid)) out.set(sid, {
								createTime: Number(r["create_time"] ?? 0),
								content: decodeCell$3(r["message_content"])
							});
						}
					} catch {}
				}
			} finally {
				db.close();
			}
		}
	};
	const numericIds = [...numeric.values()];
	if (numericIds.length > 0) for (let i = 0; i < numericIds.length; i += 400) scan("server_id", numericIds.slice(i, i + 400));
	const leftover = pending.filter((id) => !out.has(id));
	if (leftover.length > 0) for (let i = 0; i < leftover.length; i += 400) scan("CAST(server_id AS TEXT)", leftover.slice(i, i + 400));
	return out;
}
/** Extract a numeric amount from a payment card title (￥0.01 / 8.88). */
function parseAmount(s) {
	const m = (typeof s === "string" || typeof s === "number" ? String(s) : "").match(/[\d.]+/);
	return m ? Number(m[0]) : 0;
}
/** Parse a payment message content into amount + kind. */
function paymentFromContent(content) {
	if (!content) return {
		amount: 0,
		kind: null
	};
	const rich = parseMessageContent(49, content, false).rich;
	if (!rich) return {
		amount: 0,
		kind: null
	};
	if (rich.type === "transfer") return {
		amount: parseAmount(rich.title),
		kind: "transfer"
	};
	if (rich.type === "redpacket") return {
		amount: parseAmount(rich.amount),
		kind: "redpacket"
	};
	return {
		amount: 0,
		kind: null
	};
}
/** Month start/end epoch seconds for YYYY-MM (local midnight). */
function monthRange(month) {
	if (!month || !/^\d{4}-\d{2}$/.test(month)) return {
		from: 0,
		to: 0
	};
	const parts = month.split("-");
	const y = Number(parts[0]);
	const m = Number(parts[1]);
	return {
		from: Math.floor(new Date(y, m - 1, 1).getTime() / 1e3),
		to: Math.floor(new Date(y, m, 1).getTime() / 1e3) - 1
	};
}
/**
* Compute the funds ledger snapshot.
* @param decryptedDir - decrypted data root.
* @param month - optional YYYY-MM filter.
* @param selfUsername - logged-in account wxid (direction labels).
* @returns the ledger snapshot.
*/
function queryLedger(decryptedDir, month, selfUsername) {
	const names = contactMeta(decryptedDir).names;
	const self = (selfUsername ?? "").trim();
	const { from, to } = monthRange(month);
	const now = Math.floor(Date.now() / 1e3);
	const gdb = join(decryptedDir, "general", "general.db");
	const transfers = [];
	const redpackets = [];
	const serverIds = /* @__PURE__ */ new Set();
	if (existsSync(gdb)) {
		const db = new DatabaseSync(gdb, { readOnly: true });
		try {
			const tCols = new Set(db.prepare("PRAGMA table_info(transferTable)").all().map((r) => r.name));
			if (tCols.has("session_name") && tCols.has("message_server_id")) {
				const t = tCols.has("begin_transfer_time") ? "begin_transfer_time" : "0";
				const inv = tCols.has("invalid_time") ? "invalid_time" : "0";
				const where = from > 0 && t !== "0" ? ` WHERE ${t} >= ${from} AND ${t} <= ${to}` : "";
				try {
					const sql = `SELECT session_name, CAST(message_server_id AS TEXT) AS message_server_id, CAST(second_message_server_id AS TEXT) AS second_message_server_id, pay_receiver, pay_payer, ${t} AS begin_transfer_time, ${inv} AS invalid_time FROM transferTable${where}`;
					const rows = db.prepare(sql).all();
					for (const r of rows) {
						const sid = decodeCell$3(r["message_server_id"]).trim();
						const sid2 = decodeCell$3(r["second_message_server_id"]).trim();
						if (sid) serverIds.add(sid);
						if (sid2 && sid2 !== "0") serverIds.add(sid2);
						const payer = decodeCell$3(r["pay_payer"]).trim();
						const receiver = decodeCell$3(r["pay_receiver"]).trim();
						const session = decodeCell$3(r["session_name"]).trim();
						const direction = self && payer === self ? "out" : self && receiver === self ? "in" : "unknown";
						transfers.push({
							session,
							payer,
							receiver,
							direction,
							time: Number(r["begin_transfer_time"] ?? 0),
							invalidTime: Number(r["invalid_time"] ?? 0),
							serverIds: [sid, sid2].filter(Boolean)
						});
					}
				} catch {}
			}
			const rpCols = new Set(db.prepare("PRAGMA table_info(redEnvelopeTable)").all().map((r) => r.name));
			if (rpCols.has("session_name") && rpCols.has("message_server_id")) {
				const senderCol = rpCols.has("sender_user_name") ? "sender_user_name" : "'' AS sender_user_name";
				const hbStatus = rpCols.has("hb_status") ? "hb_status" : "0";
				try {
					const sql = `SELECT session_name, CAST(message_server_id AS TEXT) AS message_server_id, ${senderCol} AS sender_user_name, ${hbStatus} AS hb_status FROM redEnvelopeTable`;
					const rows = db.prepare(sql).all();
					for (const r of rows) {
						const sid = decodeCell$3(r["message_server_id"]).trim();
						if (sid) serverIds.add(sid);
						const sender = decodeCell$3(r["sender_user_name"]).trim();
						const session = decodeCell$3(r["session_name"]).trim();
						const direction = self && sender === self ? "out" : self ? "in" : "unknown";
						redpackets.push({
							session,
							sender,
							direction,
							returned: Number(r["hb_status"] ?? 0) === 2,
							serverId: sid
						});
					}
				} catch {}
			}
		} finally {
			db.close();
		}
	}
	const resolved = resolveMessagesByServerIds(decryptedDir, [...serverIds]);
	const byMsg = /* @__PURE__ */ new Map();
	for (const [sid, info] of resolved) {
		const pay = paymentFromContent(info.content);
		if (pay.kind) byMsg.set(sid, {
			amount: pay.amount,
			time: info.createTime
		});
	}
	const contactAgg = /* @__PURE__ */ new Map();
	const addContact = (username, amount, direction, count = 1) => {
		if (!username) return;
		const key = username + ":" + direction;
		const cur = contactAgg.get(key);
		if (cur) {
			cur.count += count;
			cur.amount += amount;
		} else contactAgg.set(key, {
			username,
			name: names.get(username) ?? username,
			count,
			amount,
			direction
		});
	};
	const warnings = [];
	let transferIn = 0;
	let transferOut = 0;
	let transferInAmount = 0;
	let transferOutAmount = 0;
	let transferCount = 0;
	for (const t of transfers) {
		transferCount += 1;
		const msg = t.serverIds.map((s) => byMsg.get(s)).find(Boolean);
		const amount = msg?.amount ?? 0;
		const time = msg?.time ?? t.time;
		if (t.direction === "in") {
			transferIn += 1;
			transferInAmount += amount;
			addContact(t.receiver === self ? t.session : t.payer || t.receiver || t.session, amount, "in");
		} else if (t.direction === "out") {
			transferOut += 1;
			transferOutAmount += amount;
			addContact(t.payer === self ? t.receiver || t.session : t.session, amount, "out");
		} else addContact(t.session || t.receiver || t.payer, amount, "unknown");
		if (t.invalidTime > 0 && t.invalidTime <= now) warnings.push({
			kind: "transfer-timeout",
			label: "转账超时/未确认",
			username: t.session,
			name: names.get(t.session) ?? t.session,
			time,
			amount
		});
	}
	let rpSent = 0;
	let rpReceived = 0;
	let rpSentAmount = 0;
	let rpReceivedAmount = 0;
	let rpKnownReceived = 0;
	for (const r of redpackets) {
		const msg = byMsg.get(r.serverId);
		const amount = msg?.amount ?? 0;
		const time = msg?.time ?? 0;
		if (from > 0 && (time <= 0 || time < from || time > to)) continue;
		const direction = r.direction;
		if (direction === "out") {
			rpSent += 1;
			rpSentAmount += amount;
			addContact(r.session, amount, "out");
		} else if (direction === "in") {
			rpReceived += 1;
			rpReceivedAmount += amount;
			rpKnownReceived += 1;
			addContact(r.sender || r.session, amount, "in");
		} else {
			rpReceived += 1;
			rpReceivedAmount += amount;
			addContact(r.sender || r.session, amount, "unknown");
		}
		if (r.returned) warnings.push({
			kind: "redpacket-returned",
			label: "红包已退回",
			username: r.sender || r.session,
			name: names.get(r.sender) ?? r.sender,
			time,
			amount
		});
	}
	const byContactRows = [...contactAgg.values()].sort((a, b) => b.amount - a.amount || b.count - a.count).slice(0, 20);
	const totalIn = transferInAmount + rpReceivedAmount;
	const totalOut = transferOutAmount + rpSentAmount;
	const receivedAmounts = redpackets.filter((r) => r.direction !== "out" && byMsg.get(r.serverId)?.amount).map((r) => byMsg.get(r.serverId)?.amount ?? 0);
	const redpacketBest = receivedAmounts.length > 0 ? Math.max(...receivedAmounts) : 0;
	const redpacketAvg = rpKnownReceived > 0 ? rpReceivedAmount / rpKnownReceived : 0;
	return {
		month: month ?? null,
		summary: {
			transfers: transferCount,
			transferIn,
			transferOut,
			transferAmountIn: transferInAmount,
			transferAmountOut: transferOutAmount,
			redpacketsSent: rpSent,
			redpacketsReceived: rpReceived,
			redpacketAmountSent: rpSentAmount,
			redpacketAmountReceived: rpReceivedAmount,
			totalAmountIn: totalIn,
			totalAmountOut: totalOut
		},
		byContact: byContactRows,
		redpacket: {
			sentCount: rpSent,
			receivedCount: rpReceived,
			sentAmount: rpSentAmount,
			receivedAmount: rpReceivedAmount,
			bestAmount: redpacketBest,
			avgAmount: redpacketAvg
		},
		warnings,
		updatedAt: now
	};
}
//#endregion
//#region lib/types/query/contact360.js
/**
* Contact 360° profile: cross-domain stats for one username — message count
* and first/last time, moments count, transfer/red-packet row counts, and
* shared groups. All reads are defensive against WeChat 4.x schema drift.
*/
/** Stringify a DB cell. */
function cellString$3(v) {
	if (v === null || v === void 0) return "";
	if (typeof v === "string") return v;
	if (v instanceof Uint8Array) return new TextDecoder("utf-8", { fatal: false }).decode(v);
	if (typeof v === "number" || typeof v === "boolean" || typeof v === "bigint" || typeof v === "symbol") return String(v);
	return "";
}
function tableColumns$6(db, table) {
	const rows = db.prepare(`PRAGMA table_info(${table})`).all();
	return new Set(rows.map((r) => r.name));
}
/** Msg_<md5(username)> table name for a talker. */
function msgTableName$1(username) {
	return "Msg_" + createHash("md5").update(username, "utf8").digest("hex");
}
/** Message count + first/last create_time across all shards for a talker. */
function messageStats(decryptedDir, username) {
	const table = msgTableName$1(username);
	let count = 0;
	let firstTime = null;
	let lastTime = null;
	for (const sh of shardCatalog(decryptedDir)) {
		const meta = sh.tables.get(table);
		if (!meta) continue;
		let db;
		try {
			db = new DatabaseSync(sh.file, { readOnly: true });
		} catch {
			continue;
		}
		try {
			const timeCol = meta.cols.has("create_time") ? "create_time" : meta.cols.has("CreateTime") ? "CreateTime" : "";
			const row = timeCol ? db.prepare(`SELECT COUNT(*) AS c, MIN(${timeCol}) AS mn, MAX(${timeCol}) AS mx FROM "${table}"`).get() : db.prepare(`SELECT COUNT(*) AS c FROM "${table}"`).get();
			count += row.c;
			if (row.mn != null) firstTime = firstTime == null ? row.mn : Math.min(firstTime, row.mn);
			if (row.mx != null) lastTime = lastTime == null ? row.mx : Math.max(lastTime, row.mx);
		} catch {} finally {
			db.close();
		}
	}
	return {
		count,
		firstTime,
		lastTime
	};
}
/** Count the author's moments from sns.db. */
function momentsCount(decryptedDir, username) {
	for (const p of [join(decryptedDir, "sns", "db_sns", "sns.db"), join(decryptedDir, "sns", "sns.db")]) {
		if (!existsSync(p)) continue;
		try {
			const db = new DatabaseSync(p, { readOnly: true });
			if (!(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='SnsTimeLine'").get() !== void 0)) {
				db.close();
				continue;
			}
			const cols = tableColumns$6(db, "SnsTimeLine");
			const uname = cols.has("user_name") ? "user_name" : cols.has("userName") ? "userName" : "";
			if (!uname) {
				db.close();
				continue;
			}
			const row = db.prepare(`SELECT COUNT(*) AS n FROM SnsTimeLine WHERE ${uname} = ?`).get(username);
			db.close();
			return row?.n ?? 0;
		} catch {}
	}
	return 0;
}
/** Transfer/red-packet row counts where the contact is the session. */
function fundsCount(decryptedDir, username) {
	const p = join(decryptedDir, "general", "general.db");
	if (!existsSync(p)) return {
		transfers: 0,
		redpackets: 0
	};
	try {
		const db = new DatabaseSync(p, { readOnly: true });
		let transfers = 0;
		let redpackets = 0;
		try {
			if (tableColumns$6(db, "transferTable").has("session_name")) transfers = db.prepare("SELECT COUNT(*) AS n FROM transferTable WHERE session_name = ?").get(username)?.n ?? 0;
		} catch {}
		try {
			if (tableColumns$6(db, "redEnvelopeTable").has("session_name")) redpackets = db.prepare("SELECT COUNT(*) AS n FROM redEnvelopeTable WHERE session_name = ?").get(username)?.n ?? 0;
		} catch {}
		db.close();
		return {
			transfers,
			redpackets
		};
	} catch {
		return {
			transfers: 0,
			redpackets: 0
		};
	}
}
/** Shared groups: chatroom_member -> chat_room, with member counts + names. */
function commonGroups(decryptedDir, username) {
	const p = join(decryptedDir, "contact", "contact.db");
	if (!existsSync(p)) return [];
	try {
		const db = new DatabaseSync(p, { readOnly: true });
		if (!(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='contact'").get() !== void 0)) {
			db.close();
			return [];
		}
		const cols = tableColumns$6(db, "contact");
		const userCol = cols.has("username") ? "username" : cols.has("UserName") ? "UserName" : "";
		if (!userCol) {
			db.close();
			return [];
		}
		const contactNames = contactMeta(decryptedDir).names;
		const me = db.prepare(`SELECT id FROM contact WHERE ${userCol} = ?`).get(username);
		if (!me) {
			db.close();
			return [];
		}
		const meId = me.id;
		if (meId === void 0) {
			db.close();
			return [];
		}
		const memberId = meId;
		const rooms = [];
		try {
			const cmCols = tableColumns$6(db, "chatroom_member");
			if (cmCols.has("room_id") && cmCols.has("member_id")) {
				const rows = db.prepare("SELECT room_id, COUNT(*) AS n FROM chatroom_member WHERE member_id = ? GROUP BY room_id").all(memberId);
				const crCols = tableColumns$6(db, "chat_room");
				const crUser = crCols.has("username") ? "username" : crCols.has("UserName") ? "UserName" : "";
				if (crUser) for (const r of rows) {
					const room = db.prepare(`SELECT ${crUser} AS u FROM chat_room WHERE id = ?`).get(r.room_id);
					if (!room) continue;
					const ru = cellString$3(room.u);
					if (!ru) continue;
					rooms.push({
						username: ru,
						name: contactNames.get(ru) ?? ru,
						memberCount: r.n
					});
					if (rooms.length >= 10) break;
				}
			}
		} catch {}
		db.close();
		return rooms;
	} catch {
		return [];
	}
}
/**
* Compute the contact 360° profile snapshot.
* @param decryptedDir - decrypted data root.
* @param username - contact/chatroom username.
* @returns the profile snapshot.
*/
function queryContact360(decryptedDir, username) {
	const msg = messageStats(decryptedDir, username);
	const funds = fundsCount(decryptedDir, username);
	return {
		username,
		displayName: contactMeta(decryptedDir).names.get(username) ?? username,
		messages: msg,
		moments: { count: momentsCount(decryptedDir, username) },
		funds,
		commonGroups: commonGroups(decryptedDir, username),
		updatedAt: Math.floor(Date.now() / 1e3)
	};
}
//#endregion
//#region lib/types/query/db-health.js
/**
* Data health view: walks the decrypted tree for SQLite files/WAL/SHM sizes,
* reads the search-index status, and reports plugin store files plus the
* decoded-image cache footprint.
*/
/** Recursively count .db/-wal/-shm sizes under a directory (depth 4). */
function walkSqlite(dir, depth) {
	let dbCount = 0;
	let dbBytes = 0;
	let walCount = 0;
	let shmCount = 0;
	if (depth > 4 || !existsSync(dir)) return {
		dbCount,
		dbBytes,
		walCount,
		shmCount
	};
	for (const e of readdirSync(dir, { withFileTypes: true })) {
		const p = join(dir, e.name);
		if (e.isDirectory()) {
			const sub = walkSqlite(p, depth + 1);
			dbCount += sub.dbCount;
			dbBytes += sub.dbBytes;
			walCount += sub.walCount;
			shmCount += sub.shmCount;
		} else try {
			const size = statSync(p).size;
			if (e.name.endsWith(".db")) {
				dbCount += 1;
				dbBytes += size;
			} else if (e.name.endsWith("-wal") || e.name.endsWith(".db-wal")) walCount += 1;
			else if (e.name.endsWith("-shm") || e.name.endsWith(".db-shm")) shmCount += 1;
		} catch {}
	}
	return {
		dbCount,
		dbBytes,
		walCount,
		shmCount
	};
}
/** Count/size of a directory (decoded image cache). */
function dirStats(dir) {
	let count = 0;
	let bytes = 0;
	if (!existsSync(dir)) return {
		count,
		bytes
	};
	try {
		for (const e of readdirSync(dir, { withFileTypes: true })) {
			const p = join(dir, e.name);
			try {
				if (e.isDirectory()) {
					const sub = dirStats(p);
					count += sub.count;
					bytes += sub.bytes;
				} else {
					count += 1;
					bytes += statSync(p).size;
				}
			} catch {}
		}
	} catch {}
	return {
		count,
		bytes
	};
}
/**
* Compute the data-health snapshot (cached ~5s so repeated open/close does
* not rescan the whole decrypted tree).
* @param decryptedDir - decrypted data root.
* @returns the health snapshot.
*/
function queryDbHealth(decryptedDir) {
	return cachedBySig("db-health:" + decryptedDir, "fs-snapshot-v1", () => computeDbHealth(decryptedDir));
}
function computeDbHealth(decryptedDir) {
	const sqlite = walkSqlite(decryptedDir, 0);
	const root = dirname(decryptedDir);
	const stores = [];
	for (const name of [
		"wechat_tasks.db",
		"daily_summary.db",
		"message_edits.db",
		"wechat_search.db",
		"config.json",
		"all_keys.json"
	]) {
		const p = join(root, name);
		try {
			if (existsSync(p)) stores.push({
				name,
				size: statSync(p).size
			});
		} catch {}
	}
	const images = dirStats(join(root, "decoded_images"));
	return {
		dbFiles: sqlite.dbCount,
		dbBytes: sqlite.dbBytes,
		walFiles: sqlite.walCount,
		shmFiles: sqlite.shmCount,
		searchIndex: getSearchIndexStatus(decryptedDir),
		stores,
		decodedImagesCount: images.count,
		decodedImagesBytes: images.bytes,
		updatedAt: Math.floor(Date.now() / 1e3)
	};
}
//#endregion
//#region lib/types/query/group-insights.js
/**
* Offline group insights for one chatroom: total/active-day stats, member
* activity ranks, and the group announcement. Sender identity is extracted
* from the message-content prefix (`wxid_xxx:\n`) which is reliable for
* 4.x chatroom rows; Name2Id resolution can be added later.
*/
const ZSTD_MAGIC$2 = Buffer.from([
	40,
	181,
	47,
	253
]);
function decodeCell$2(v) {
	if (v === null || v === void 0) return "";
	if (typeof v === "string") return v;
	if (typeof v === "number" || typeof v === "boolean" || typeof v === "bigint" || typeof v === "symbol") return String(v);
	const raw = Buffer.from(v instanceof Uint8Array ? v : []);
	const decompressed = raw.length >= 4 && raw.subarray(0, 4).equals(ZSTD_MAGIC$2) ? (() => {
		try {
			return Buffer.from(decompress(raw));
		} catch {
			return raw;
		}
	})() : raw;
	try {
		return new TextDecoder("utf-8", { fatal: false }).decode(decompressed);
	} catch {
		return new TextDecoder("gbk", { fatal: false }).decode(decompressed);
	}
}
function tableColumns$5(db, table) {
	const rows = db.prepare(`PRAGMA table_info(${table})`).all();
	return new Set(rows.map((r) => r.name));
}
function groupDisplayName(decryptedDir, username) {
	return contactMeta(decryptedDir).names.get(username) || username;
}
function memberCount(decryptedDir, username) {
	const p = join(decryptedDir, "contact", "contact.db");
	if (!existsSync(p)) return 0;
	try {
		const db = new DatabaseSync(p, { readOnly: true });
		if (!tableColumns$5(db, "contact").has("username")) {
			db.close();
			return 0;
		}
		const me = db.prepare("SELECT id FROM contact WHERE username = ?").get(username);
		if (!me || me.id === void 0) {
			db.close();
			return 0;
		}
		const cm = tableColumns$5(db, "chatroom_member");
		if (!cm.has("room_id") || !cm.has("member_id")) {
			db.close();
			return 0;
		}
		const row = db.prepare("SELECT COUNT(*) AS n FROM chatroom_member WHERE room_id = ?").get(me.id);
		db.close();
		return row?.n ?? 0;
	} catch {
		return 0;
	}
}
function announcement(decryptedDir, username) {
	const p = join(decryptedDir, "contact", "contact.db");
	if (!existsSync(p)) return {
		text: "",
		time: null
	};
	try {
		const db = new DatabaseSync(p, { readOnly: true });
		const cols = tableColumns$5(db, "contact");
		const userCol = cols.has("username") ? "username" : cols.has("UserName") ? "UserName" : "";
		if (!userCol) {
			db.close();
			return {
				text: "",
				time: null
			};
		}
		const me = db.prepare(`SELECT id FROM contact WHERE ${userCol} = ?`).get(username);
		const detail = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name).find((t) => t.includes("chat_room_info_detail"));
		const roomId = me?.id;
		if (roomId === void 0 || !detail) {
			db.close();
			return {
				text: "",
				time: null
			};
		}
		const dc = tableColumns$5(db, detail);
		const annCol = dc.has("announcement_") ? "announcement_" : dc.has("announcement") ? "announcement" : "";
		const timeCol = dc.has("announcement_publish_time_") ? "announcement_publish_time_" : dc.has("announcement_publish_time") ? "announcement_publish_time" : "";
		const whereCol = dc.has("room_id_") ? "room_id_" : dc.has("username_") ? "username_" : "";
		if (!annCol || !whereCol) {
			db.close();
			return {
				text: "",
				time: null
			};
		}
		const row = db.prepare(`SELECT ${annCol} AS a, ${timeCol || "0"} AS t FROM ${detail} WHERE ${whereCol} = ?`).get(roomId);
		db.close();
		if (!row) return {
			text: "",
			time: null
		};
		return {
			text: decodeCell$2(row.a).trim() || "",
			time: Number(row.t ?? 0) || null
		};
	} catch {
		return {
			text: "",
			time: null
		};
	}
}
/** Sender username from a chatroom message-content prefix (wxid_xxx:\n). */
function senderFromPrefix(text) {
	const m = text.match(/^([A-Za-z0-9_@.\-]{3,64}):\n/);
	return m ? m[1] ?? "" : "";
}
/**
* Compute offline group insights for one chatroom.
* @param decryptedDir - decrypted data root.
* @param username - chatroom username.
* @returns the insights snapshot.
*/
function queryGroupInsights(decryptedDir, username) {
	const names = contactMeta(decryptedDir).names;
	const table = "Msg_" + createHash("md5").update(username, "utf8").digest("hex");
	const dir = join(decryptedDir, "message");
	let total = 0;
	let minTime = null;
	let maxTime = null;
	const perMember = /* @__PURE__ */ new Map();
	let activeDays = 0;
	const daySet = /* @__PURE__ */ new Set();
	if (existsSync(dir)) for (const f of readdirSync(dir)) {
		if (!/^(biz_)?message_\d+\.db$/.test(f)) continue;
		let db;
		try {
			db = new DatabaseSync(join(dir, f), { readOnly: true });
		} catch {
			continue;
		}
		try {
			if (!(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table) !== void 0)) continue;
			const cols = tableColumns$5(db, table);
			if (!cols.has("message_content") || !cols.has("create_time")) continue;
			const rows = db.prepare(`SELECT create_time, message_content FROM "${table}"`).all();
			for (const r of rows) {
				total += 1;
				const t = Number(r["create_time"] ?? 0);
				if (t > 0) {
					if (minTime == null || t < minTime) minTime = t;
					if (maxTime == null || t > maxTime) maxTime = t;
					daySet.add(Math.floor(t / 86400));
				}
				const sender = senderFromPrefix(decodeCell$2(r["message_content"]));
				if (sender) perMember.set(sender, (perMember.get(sender) ?? 0) + 1);
			}
		} catch {} finally {
			db.close();
		}
	}
	activeDays = daySet.size;
	const topMembers = Array.from(perMember.entries()).map(([u, count]) => {
		let name = names.get(u) ?? "";
		if (!name) name = /^[0-9a-f]{16,}$/i.test(u) ? "未知联系人" : u;
		return {
			username: u,
			name,
			count
		};
	}).sort((a, b) => b.count - a.count).slice(0, 10);
	const ann = announcement(decryptedDir, username);
	const spanDays = minTime != null && maxTime != null ? Math.max(1, Math.ceil((maxTime - minTime) / 86400)) : 0;
	return {
		username,
		name: groupDisplayName(decryptedDir, username),
		memberCount: memberCount(decryptedDir, username),
		total,
		activeDays,
		from: minTime,
		to: maxTime,
		avgPerDay: spanDays > 0 ? total / spanDays : 0,
		announcement: ann.text,
		announcementTime: ann.time,
		topMembers
	};
}
//#endregion
//#region lib/types/query/asset-insights.js
/**
* Favorites + emoticon asset insights: favorite counts by type/year, custom
* and store emoticon counts, and top-used emoticon md5s from message shards.
*/
const ZSTD_MAGIC$1 = Buffer.from([
	40,
	181,
	47,
	253
]);
function decodeCell$1(v) {
	if (v === null || v === void 0) return "";
	if (typeof v === "string") return v;
	if (typeof v === "number" || typeof v === "boolean" || typeof v === "bigint" || typeof v === "symbol") return String(v);
	const raw = Buffer.from(v instanceof Uint8Array ? v : []);
	const decompressed = raw.length >= 4 && raw.subarray(0, 4).equals(ZSTD_MAGIC$1) ? (() => {
		try {
			return Buffer.from(decompress(raw));
		} catch {
			return raw;
		}
	})() : raw;
	try {
		return new TextDecoder("utf-8", { fatal: false }).decode(decompressed);
	} catch {
		return "";
	}
}
function tableExists(db, table) {
	return db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table) !== void 0;
}
function tableColumns$4(db, table) {
	const rows = db.prepare(`PRAGMA table_info(${table})`).all();
	return new Set(rows.map((r) => r.name));
}
function favoriteStats(decryptedDir) {
	const p = join(decryptedDir, "favorite", "favorite.db");
	if (!existsSync(p)) return {
		total: 0,
		byType: [],
		byYear: []
	};
	try {
		const db = new DatabaseSync(p, { readOnly: true });
		if (!tableExists(db, "fav_db_item")) {
			db.close();
			return {
				total: 0,
				byType: [],
				byYear: []
			};
		}
		const cols = tableColumns$4(db, "fav_db_item");
		const typeCol = cols.has("type") ? "type" : cols.has("Type") ? "Type" : "";
		const timeCol = cols.has("update_time") ? "update_time" : cols.has("UpdateTime") ? "UpdateTime" : "";
		const typeRows = typeCol ? db.prepare(`SELECT ${typeCol} AS t, COUNT(*) AS n FROM fav_db_item GROUP BY ${typeCol}`).all() : [];
		const yearRows = timeCol ? db.prepare(`SELECT CAST(strftime('%Y', datetime(${timeCol}, 'unixepoch')) AS INTEGER) AS y, COUNT(*) AS n FROM fav_db_item GROUP BY y ORDER BY y DESC`).all() : [];
		const totalRow = db.prepare("SELECT COUNT(*) AS n FROM fav_db_item").get();
		db.close();
		return {
			total: totalRow?.n ?? 0,
			byType: typeRows.map((r) => ({
				type: r.t,
				label: favTypeLabel(r.t),
				count: r.n
			})).sort((a, b) => b.count - a.count),
			byYear: yearRows.map((r) => ({
				year: r.y,
				count: r.n
			}))
		};
	} catch {
		return {
			total: 0,
			byType: [],
			byYear: []
		};
	}
}
function emoticonStats(decryptedDir, topUsages) {
	const p = join(decryptedDir, "emoticon", "emoticon.db");
	let customCount = 0;
	let storePackages = 0;
	let captions = 0;
	if (existsSync(p)) try {
		const db = new DatabaseSync(p, { readOnly: true });
		if (tableExists(db, "kNonStoreEmoticonTable")) customCount = db.prepare("SELECT COUNT(*) AS n FROM kNonStoreEmoticonTable").get().n;
		if (tableExists(db, "kStoreEmoticonPackageTable")) storePackages = db.prepare("SELECT COUNT(*) AS n FROM kStoreEmoticonPackageTable").get().n;
		if (tableExists(db, "kStoreEmoticonCaptionsTable")) captions = db.prepare("SELECT COUNT(*) AS n FROM kStoreEmoticonCaptionsTable").get().n;
		db.close();
	} catch {}
	return {
		customCount,
		storePackages,
		captions,
		topUsed: topUsages
	};
}
function topEmoticonUsage(decryptedDir, cap) {
	const counts = /* @__PURE__ */ new Map();
	const dir = join(decryptedDir, "message");
	if (!existsSync(dir)) return [];
	const re = /md5\s*=\s*["']([A-Fa-f0-9]{16,})["']/;
	for (const f of readdirSync(dir)) {
		if (!/^(biz_)?message_\d+\.db$/.test(f)) continue;
		let db;
		try {
			db = new DatabaseSync(join(dir, f), { readOnly: true });
		} catch {
			continue;
		}
		try {
			const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'Msg_%'").all().map((r) => r.name);
			for (const table of tables) {
				const cols = tableColumns$4(db, table);
				if (!cols.has("local_type") || !cols.has("message_content")) continue;
				try {
					const rows = db.prepare(`SELECT local_type, message_content FROM "${table}" WHERE (local_type & 4294967295) = 47`).all();
					for (const r of rows) {
						const m = re.exec(decodeCell$1(r["message_content"]));
						const md5 = m ? m[1] ?? "" : "";
						if (md5) counts.set(md5, (counts.get(md5) ?? 0) + 1);
					}
				} catch {}
			}
		} finally {
			db.close();
		}
	}
	return Array.from(counts.entries()).map(([md5, count]) => ({
		md5,
		count
	})).sort((a, b) => b.count - a.count).slice(0, cap);
}
/**
* Compute favorites + emoticon asset insights.
* @param decryptedDir - decrypted data root.
* @returns the asset insights snapshot.
*/
function queryAssetInsights(decryptedDir) {
	const sig = [
		fileSigOf(join(decryptedDir, "favorite", "favorite.db")),
		fileSigOf(join(decryptedDir, "emoticon", "emoticon.db")),
		shardCatalogSig(decryptedDir, ["message"])
	].join("|");
	return cachedBySig("asset-insights:" + decryptedDir, sig, () => computeAssetInsights(decryptedDir), 3e4);
}
function computeAssetInsights(decryptedDir) {
	return {
		favorites: favoriteStats(decryptedDir),
		emoticons: emoticonStats(decryptedDir, topEmoticonUsage(decryptedDir, 10)),
		updatedAt: Math.floor(Date.now() / 1e3)
	};
}
//#endregion
//#region lib/types/query/media-assets.js
/**
* Media assets inventory over hardlink.db: per-category file/size stats and
* duplicate md5 detection across image/file/video hardlink tables.
*/
const MEDIA_TABLES = [
	["image_hardlink_info_v4", "图片"],
	["file_hardlink_info_v4", "文件"],
	["video_hardlink_info_v4", "视频"]
];
function tableColumns$3(db, table) {
	const rows = db.prepare(`PRAGMA table_info(${table})`).all();
	return new Set(rows.map((r) => r.name));
}
/**
* Compute the media assets snapshot.
* @param decryptedDir - decrypted data root.
* @returns the media assets snapshot.
*/
function queryMediaAssets(decryptedDir) {
	return cachedBySig("media-assets:" + decryptedDir, fileSigOf(join(decryptedDir, "hardlink", "hardlink.db")), () => computeMediaAssets(decryptedDir), 3e4);
}
function computeMediaAssets(decryptedDir) {
	const p = join(decryptedDir, "hardlink", "hardlink.db");
	const categories = [];
	const duplicates = /* @__PURE__ */ new Map();
	let totalFiles = 0;
	let totalBytes = 0;
	if (existsSync(p)) try {
		const db = new DatabaseSync(p, { readOnly: true });
		for (const [table, label] of MEDIA_TABLES) {
			if (!(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table) !== void 0)) continue;
			const cols = tableColumns$3(db, table);
			const md5Col = cols.has("md5") ? "md5" : cols.has("MD5") ? "MD5" : "";
			const sizeCol = cols.has("file_size") ? "file_size" : "0";
			const stat = db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(${sizeCol}), 0) AS s FROM ${table}`).all()[0] ?? {
				n: 0,
				s: 0
			};
			const count = stat.n;
			const size = stat.s;
			categories.push({
				category: label,
				count,
				size
			});
			totalFiles += count;
			totalBytes += size;
			if (md5Col) try {
				const dupRows = db.prepare(`SELECT ${md5Col} AS m, COUNT(*) AS n, COALESCE(SUM(CAST(${sizeCol} AS INTEGER)), 0) AS s FROM ${table} WHERE ${md5Col} IS NOT NULL AND ${md5Col} != '' GROUP BY ${md5Col} HAVING COUNT(*) > 1`).all();
				for (const r of dupRows) {
					const md5 = typeof r.m === "string" ? r.m : "";
					if (md5) duplicates.set(md5, {
						count: r.n,
						size: r.s
					});
				}
			} catch {}
		}
		db.close();
	} catch {}
	let duplicateFiles = 0;
	let duplicateBytes = 0;
	let reclaimBytes = 0;
	const allDups = Array.from(duplicates.entries()).map(([md5, d]) => ({
		md5,
		count: d.count,
		size: d.size,
		reclaimBytes: d.count > 1 ? Math.round(d.size * (d.count - 1) / d.count) : 0
	})).sort((a, b) => b.count - a.count);
	// 合计必须遍历**全部**重复组；只有返回给界面展示的列表才截断。
	// 原先先 slice(0, 50) 再累加：实测本机 200 个重复组，导致「可回收」少报 3.2 倍。
	for (const d of allDups) {
		duplicateFiles += d.count;
		duplicateBytes += d.size;
		reclaimBytes += d.reclaimBytes;
	}
	return {
		categories,
		duplicates: allDups.slice(0, 50),
		totalFiles,
		totalBytes,
		duplicateFiles,
		duplicateBytes,
		reclaimBytes,
		updatedAt: Math.floor(Date.now() / 1e3)
	};
}
//#endregion
//#region lib/types/query/calls.js
/**
* Call (type 50) inventory across every message shard.
*
* `local_type = 50` rows hold a zstd blob (0x28B52FFD) with a
* `<voipmsg type="VoIPBubbleMsg">` XML. Measured locally (135/135):
*   <msg>       通话时长 00:21 / 对方已取消 / 已拒绝 / 未应答 / 已在其它设备接听 …
*   <duration>  **always 0** — the real length is inside <msg>
*   <room_type> 0×39 / 1×96, every call in a 1:1 chat → 语音/视频 stays unverified,
*               so the raw value is exposed and never labelled.
* Direction comes from `real_sender_id` via each shard's own Name2Id: the logged-in
* account means 呼出, anyone else 呼入 (locally 135/135 resolve).
*/
const ZSTD_MAGIC$9 = Buffer.from([
	40,
	181,
	47,
	253
]);
/** `已在其它设备接听`：接通了，但本机没有时长。 */
const CALL_ACK_ELSEWHERE = /已在其它设备接听/;
/**
* Decode a message cell: zstd-inflate when the magic matches, else UTF-8/GBK.
*/
function callsDecodeContent(v) {
	let raw;
	if (v instanceof Uint8Array) raw = Buffer.from(v);
	else if (typeof v === "string") raw = /^\d+(,\d+)*$/.test(v.trim()) ? Buffer.from(v.split(",").map(Number)) : Buffer.from(v, "utf8");
	else return "";
	if (raw.length === 0) return "";
	const bytes = raw.length >= 4 && raw.subarray(0, 4).equals(ZSTD_MAGIC$9) ? (() => {
		try {
			return Buffer.from(decompress(raw));
		} catch {
			return raw;
		}
	})() : raw;
	try {
		return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
	} catch {
		return new TextDecoder("gbk", { fatal: false }).decode(bytes);
	}
}
/** Inner text of the first `<tag>`; CDATA unwrapped. */
function callsTagText(xml, tag) {
	const open = "<" + tag;
	const si = xml.indexOf(open);
	if (si < 0) return "";
	const gt = xml.indexOf(">", si);
	if (gt < 0) return "";
	const ei = xml.indexOf("</" + tag, gt);
	if (ei < 0) return "";
	const body = xml.slice(gt + 1, ei).trim();
	const c = /^<!\[CDATA\[([\s\S]*?)\]\]>$/.exec(body);
	return c ? c[1] ?? "" : body;
}
/** The duration lives in the `<msg>` text (the XML `<duration>` is always 0). */
function callsParseDuration(text) {
	const m = /(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(text);
	if (!m) return void 0;
	const a = Number(m[1] ?? 0);
	const b = Number(m[2] ?? 0);
	return m[3] === void 0 ? a * 60 + b : a * 3600 + b * 60 + Number(m[3]);
}
/** md5(username) → username, for the `Msg_<md5>` table names. */
function callsMd5Index(decryptedDir) {
	const names = contactMeta(decryptedDir).names;
	const map = /* @__PURE__ */ new Map();
	for (const u of names.keys()) map.set(createHash("md5").update(u, "utf8").digest("hex"), u);
	return map;
}
/** Scan every message shard for type-50 rows and decode the voip XML. */
function scanCalls(decryptedDir, selfUsername) {
	const byMd5 = callsMd5Index(decryptedDir);
	const self = (selfUsername ?? "").trim();
	const out = [];
	for (const shard of shardCatalog(decryptedDir)) {
		const tables = [...shard.tables.keys()];
		if (tables.length === 0) continue;
		let db;
		try {
			db = new DatabaseSync(shard.file, { readOnly: true });
		} catch {
			continue;
		}
		try {
			for (const table of tables) {
				const tmeta = shard.tables.get(table);
				if (!tmeta || !tmeta.cols.has("message_content")) continue;
				let rows;
				try {
					rows = db.prepare(`SELECT local_id AS l, create_time AS t, real_sender_id AS s, message_content AS c FROM "${table}" WHERE (local_type & 4294967295) = 50`).all();
				} catch {
					continue;
				}
				if (rows.length === 0) continue;
				const talker = byMd5.get(table.slice(4)) ?? "";
				for (const r of rows) {
					const xml = callsDecodeContent(r.c);
					if (!xml) continue;
					const status = callsTagText(xml, "msg").trim();
					const durationSec = callsParseDuration(status);
					const connected = durationSec !== void 0 || CALL_ACK_ELSEWHERE.test(status);
					const sender = tmeta.name2id.get(Number(r.s ?? 0)) ?? "";
					const outgoing = self.length > 0 && sender === self;
					const username = outgoing ? talker : sender && sender !== self ? sender : talker;
					const roomType = Number(callsTagText(xml, "room_type"));
					out.push({
						username,
						localId: Number(r.l ?? 0),
						createTime: Number(r.t ?? 0),
						status,
						connected,
						...durationSec !== void 0 ? { durationSec } : {},
						outgoing,
						...Number.isFinite(roomType) ? { roomType } : {}
					});
				}
			}
		} finally {
			db.close();
		}
	}
	return out;
}
/** `YYYY-MM` in local time. */
function callsMonthOf(sec) {
	const d = new Date(sec * 1e3);
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}
function callsBuildSnapshot(raw, names, topPeers, recentLimit) {
	const byPeer = /* @__PURE__ */ new Map();
	const byMonth = /* @__PURE__ */ new Map();
	const byHour = new Array(24).fill(0);
	const unanswered = /* @__PURE__ */ new Map();
	let total = 0;
	let connectedCount = 0;
	let durationSec = 0;
	let outgoing = 0;
	let longestSec = 0;
	let longestPeer = "";
	let firstTime = null;
	let lastTime = null;
	const connectedDurations = [];
	for (const c of raw) {
		total += 1;
		if (c.connected) connectedCount += 1;
		if (c.outgoing) outgoing += 1;
		const d = c.durationSec ?? 0;
		durationSec += d;
		if (d > longestSec) {
			longestSec = d;
			longestPeer = c.username;
		}
		if (c.connected) connectedDurations.push(d);
		if (!c.connected && c.status) unanswered.set(c.status, (unanswered.get(c.status) ?? 0) + 1);
		const peer = byPeer.get(c.username) ?? {
			calls: 0,
			connected: 0,
			durationSec: 0,
			lastTime: 0
		};
		peer.calls += 1;
		if (c.connected) peer.connected += 1;
		peer.durationSec += d;
		if (c.createTime > peer.lastTime) peer.lastTime = c.createTime;
		byPeer.set(c.username, peer);
		if (c.createTime > 0) {
			const m = callsMonthOf(c.createTime);
			const row = byMonth.get(m) ?? {
				calls: 0,
				connected: 0,
				durationSec: 0
			};
			row.calls += 1;
			if (c.connected) row.connected += 1;
			row.durationSec += d;
			byMonth.set(m, row);
			byHour[new Date(c.createTime * 1e3).getHours()] += 1;
			if (firstTime == null || c.createTime < firstTime) firstTime = c.createTime;
			if (lastTime == null || c.createTime > lastTime) lastTime = c.createTime;
		}
	}
	const peers = [...byPeer.entries()].map(([username, p]) => ({
		username,
		name: names.get(username) ?? username,
		...p
	})).sort((a, b) => b.calls - a.calls || b.durationSec - a.durationSec);
	const months = [...byMonth.entries()].map(([month, m]) => ({
		month,
		...m
	})).sort((a, b) => a.month < b.month ? -1 : 1);
	const recent = [...raw].filter((c) => c.createTime > 0).sort((a, b) => b.createTime - a.createTime).slice(0, recentLimit).map((c) => ({
		username: c.username,
		name: names.get(c.username) ?? c.username,
		localId: c.localId,
		createTime: c.createTime,
		status: c.status,
		connected: c.connected,
		outgoing: c.outgoing,
		...c.durationSec !== void 0 ? { durationSec: c.durationSec } : {}
	}));
	return {
		total,
		connected: connectedCount,
		missed: total - connectedCount,
		durationSec,
		avgSec: connectedDurations.length > 0 ? Math.round(durationSec / connectedDurations.length) : 0,
		longestSec,
		longestPeer: longestPeer ? names.get(longestPeer) ?? longestPeer : "",
		outgoing,
		incoming: total - outgoing,
		ackElsewhere: raw.filter((c) => !c.durationSec && CALL_ACK_ELSEWHERE.test(c.status)).length,
		peers: peers.slice(0, topPeers),
		peerCount: peers.length,
		months,
		byHour,
		unanswered: [...unanswered.entries()].map(([status, count]) => ({
			status,
			count
		})).sort((a, b) => b.count - a.count),
		recent,
		from: firstTime,
		to: lastTime,
		updatedAt: Math.floor(Date.now() / 1e3)
	};
}
/**
* Compute the call inventory snapshot (cached on shard + contact fingerprints).
*/
function queryCalls(decryptedDir, selfUsername, topPeers = 20, recentLimit = 50) {
	const self = selfUsername ?? "";
	const sig = shardCatalogSig(decryptedDir, ["message"]) + "|" + self;
	const names = contactMeta(decryptedDir).names;
	return cachedBySig("calls:" + decryptedDir, sig, () => {
		const raw = scanCalls(decryptedDir, self);
		return callsBuildSnapshot(raw, names, topPeers, recentLimit);
	}, 6e4);
}
//#endregion
//#region lib/types/query/moments-insights.js
/**
* Moments insights for one author (usually self): post/like/comment totals,
* top likers and commenters, monthly distribution, and "on this day" items.
*/
function cellString$2(v) {
	if (typeof v === "string") return v;
	if (v === null || v === void 0) return "";
	if (typeof v === "number" || typeof v === "boolean" || typeof v === "bigint" || typeof v === "symbol") return String(v);
	return "";
}
function snsDb$1(decryptedDir) {
	for (const p of [join(decryptedDir, "sns", "db_sns", "sns.db"), join(decryptedDir, "sns", "sns.db")]) if (existsSync(p)) return p;
	return null;
}
function addInteractor(map, username, nickname) {
	const key = username || nickname || "?";
	const cur = map.get(key);
	if (cur) cur.count += 1;
	else map.set(key, {
		username,
		nickname,
		count: 1
	});
}
function sortedTop(map, cap) {
	return Array.from(map.values()).sort((a, b) => b.count - a.count).slice(0, cap);
}
/**
* 朋友圈「新动态提醒」表（`SnsTopItem_1`）的统计。
*
* 一行 = 一条被推入「朋友的新动态」的帖子；`is_read` 表示有没有看过。
* 实测（本机 116 行 / 33 人）：`<summary>` 恒为空；`last_read_time` 全量只有一个取值
* （一次批量已读），不能用来算「某个人的回访延迟」；28/116 条的 tid 已不在 SnsTimeLine。
* 所以只暴露三件能站得住的事 + 每人明细。
*/
function momentsComputeTopItems(db, tidCol, names) {
	const empty = {
		rows: 0,
		users: 0,
		unread: 0,
		vanished: 0,
		top: []
	};
	try {
		if (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='SnsTopItem_1'").get() === void 0) return empty;
		const rows = db.prepare(`SELECT CAST(tid AS TEXT) AS t, username AS u, create_time AS c, last_read_time AS r, is_read AS d FROM SnsTopItem_1`).all();
		if (rows.length === 0) return empty;
		const alive = /* @__PURE__ */ new Set();
		try {
			for (const r of db.prepare(`SELECT CAST(${tidCol} AS TEXT) AS t FROM SnsTimeLine`).all()) alive.add(cellString$2(r.t));
		} catch {}
		const byUser = /* @__PURE__ */ new Map();
		let unread = 0;
		let vanished = 0;
		for (const r of rows) {
			const username = cellString$2(r.u);
			if (!username) continue;
			const isUnread = Number(r.d ?? 1) === 0;
			const isGone = alive.size > 0 && !alive.has(cellString$2(r.t));
			if (isUnread) unread += 1;
			if (isGone) vanished += 1;
			const cur = byUser.get(username) ?? {
				count: 0,
				unread: 0,
				vanished: 0,
				lastRead: 0
			};
			cur.count += 1;
			if (isUnread) cur.unread += 1;
			if (isGone) cur.vanished += 1;
			cur.lastRead = Math.max(cur.lastRead, Number(r.r ?? 0));
			byUser.set(username, cur);
		}
		return {
			rows: rows.length,
			users: byUser.size,
			unread,
			vanished,
			top: Array.from(byUser.entries()).map(([username, v]) => ({
				username,
				name: names.get(username) ?? username,
				count: v.count,
				unread: v.unread,
				vanished: v.vanished,
				lastRead: v.lastRead
			})).sort((a, b) => b.count - a.count || a.username.localeCompare(b.username)).slice(0, 10)
		};
	} catch {
		return empty;
	}
}
/**
* 朋友圈「足迹」：城市/国家分布与打卡地点排行。
*
* ⚠️ `<location>` 的两个坐标属性**语义是反的**（南宁真实 22.87N/108.25E，
* 而 latitude 属性写的是 108.25；本机 490 条里 485 条 latitude > 90）。
* 这里输出的 lat/lng **已修正**，可直接画地图。
*/
function momentsComputeGeo(db) {
	const empty = {
		points: 0,
		cities: [],
		countries: [],
		places: [],
		pointList: []
	};
	try {
		const rows = db.prepare("SELECT user_name AS u, content AS c FROM SnsTimeLine").all();
		const cityCount = /* @__PURE__ */ new Map();
		const countryCount = /* @__PURE__ */ new Map();
		const placeCount = /* @__PURE__ */ new Map();
		let points = 0;
		// 逐条保留定位点：地图要画的是「每一次打卡」，不是聚合后的城市（同城多点会重叠成 1 个）
		const pointList = [];
		for (const r of rows) {
			const xml = cellString$2(r.c);
			const li = xml.indexOf("<location");
			if (li < 0) continue;
			const gt = xml.indexOf(">", li);
			const attrs = gt > 0 ? xml.slice(li + 9, gt) : "";
			const attr = (n) => {
				const m = new RegExp(n + "=\"([^\"]*)\"").exec(attrs);
				return m ? m[1] ?? "" : "";
			};
			const city = attr("city").trim();
			const country = attr("country").trim();
			const poi = attr("poiName").trim() || attr("poiname").trim();
			const lat = Number(attr("longitude")) || 0;
			const lng = Number(attr("latitude")) || 0;
			// 只有「修正后落在合法区间且非 0」才算真坐标。本机 2341 行**全部**带 <location>：
			// 1851 行 0/0（未定位）、5 行 -180/-180（微信定位失败的哨兵值，city 仍写南宁市）、485 行真实坐标。
			// 哨兵值不筛掉的话会在地图左下角堆出 5 个假点。
			const usable = (lat !== 0 || lng !== 0) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
			if (city) cityCount.set(city, (cityCount.get(city) ?? 0) + 1);
			if (country) countryCount.set(country, (countryCount.get(country) ?? 0) + 1);
			if (poi) {
				const cur = placeCount.get(poi) ?? {
					count: 0,
					city,
					lat: usable ? lat : 0,
					lng: usable ? lng : 0
				};
				cur.count += 1;
				placeCount.set(poi, cur);
			}
			if (usable) {
				points += 1;
				pointList.push({
					lat,
					lng,
					city,
					poi
				});
			}
		}
		return {
			points,
			cities: [...cityCount.entries()].map(([city, count]) => ({
				city,
				count
			})).sort((a, b) => b.count - a.count || a.city.localeCompare(b.city)),
			countries: [...countryCount.entries()].map(([country, count]) => ({
				country,
				count
			})).sort((a, b) => b.count - a.count || a.country.localeCompare(b.country)),
			places: [...placeCount.entries()].map(([name, v]) => ({
				name,
				city: v.city,
				count: v.count,
				lat: v.lat,
				lng: v.lng
			})).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)).slice(0, 10),
			pointList
		};
	} catch {
		return empty;
	}
}
/**
* Compute moments insights for an author.
* @param decryptedDir - decrypted data root.
* @param author - author username (default: all).
* @returns the insights snapshot.
*/
function queryMomentsInsights(decryptedDir, author) {
	const dbPath = snsDb$1(decryptedDir);
	const sig = dbPath === null ? "" : fileSigOf(dbPath);
	return cachedBySig("moments-insights:" + decryptedDir + ":" + (author ?? ""), sig, () => computeMomentsInsights(decryptedDir, author));
}
function computeMomentsInsights(decryptedDir, author) {
	const emptySnapshot = {
		author: author ?? "",
		posts: 0,
		likes: 0,
		comments: 0,
		likedBy: [],
		commenters: [],
		monthly: [],
		today: [],
		topItems: {
			rows: 0,
			users: 0,
			unread: 0,
			vanished: 0,
			top: []
		},
		geo: {
			points: 0,
			cities: [],
			countries: [],
			places: []
		},
		updatedAt: Math.floor(Date.now() / 1e3)
	};
	const dbPath = snsDb$1(decryptedDir);
	if (dbPath === null) return emptySnapshot;
	let posts = 0;
	let likes = 0;
	let comments = 0;
	const likers = /* @__PURE__ */ new Map();
	const commenters = /* @__PURE__ */ new Map();
	const monthly = /* @__PURE__ */ new Map();
	const now = /* @__PURE__ */ new Date();
	const today = [];
	let topItems = emptySnapshot.topItems;
	let geo = emptySnapshot.geo;
	try {
		const db = new DatabaseSync(dbPath, { readOnly: true });
		const cols = new Set(db.prepare("PRAGMA table_info(SnsTimeLine)").all().map((r) => r.name));
		const tidCol = cols.has("tid") ? "tid" : cols.has("Id") ? "Id" : "";
		// 提醒列表与「按作者过滤」无关：它永远是**我的**提醒清单，所以无条件计算。
		topItems = momentsComputeTopItems(db, tidCol, contactMeta(decryptedDir).names);
		geo = momentsComputeGeo(db);
		if (!(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='SnsTimeLine'").get() !== void 0)) {
			db.close();
			return {
				...emptySnapshot,
				topItems,
				geo
			};
		}
		const userCol = cols.has("user_name") ? "user_name" : cols.has("userName") ? "userName" : "";
		const contentCol = cols.has("content") ? "content" : cols.has("Content") ? "Content" : "";
		if (!tidCol || !userCol || !contentCol) {
			db.close();
			return {
				...emptySnapshot,
				topItems,
				geo
			};
		}
		const where = author ? ` WHERE ${userCol} = ?` : "";
		const rows = db.prepare(`SELECT CAST(${tidCol} AS TEXT) AS t, ${userCol} AS u, ${contentCol} AS c FROM SnsTimeLine${where}`).all(...author ? [author] : []);
		db.close();
		for (const r of rows) {
			posts += 1;
			const xml = cellString$2(r.c);
			const parsed = parseSnsXml(xml);
			const social = parseSnsLikesComments(xml);
			likes += social.likes.length;
			comments += social.comments.length;
			for (const like of social.likes) addInteractor(likers, like.username, like.nickname);
			for (const cm of social.comments) addInteractor(commenters, cm.username, cm.nickname);
			if (parsed.createTime > 0) {
				const d = /* @__PURE__ */ new Date(parsed.createTime * 1e3);
				const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
				monthly.set(key, (monthly.get(key) ?? 0) + 1);
				if (d.getMonth() === now.getMonth() && d.getDate() === now.getDate()) today.push({
					tid: cellString$2(r.t),
					text: parsed.text,
					ts: parsed.createTime,
					author: cellString$2(r.u)
				});
			}
		}
	} catch (e) {
		// 不再静默吞错：曾因此让「朋友圈洞察」长期显示全 0 而无人察觉
		// （SnsTimeLine.tid 100% 超出 JS 安全整数范围，未 CAST 时物化行会抛错）。
		console.warn("[moments-insights] 查询失败，返回空结果:", e?.message ?? e);
	}
	const monthlyArr = Array.from(monthly.entries()).map(([month, count]) => ({
		month,
		count
	})).sort((a, b) => a.month.localeCompare(b.month));
	return {
		author: author ?? "",
		posts,
		likes,
		comments,
		likedBy: sortedTop(likers, 10),
		commenters: sortedTop(commenters, 10),
		monthly: monthlyArr,
		today: today.slice(0, 20).sort((a, b) => b.ts - a.ts),
		topItems,
		geo,
		updatedAt: Math.floor(Date.now() / 1e3)
	};
}
//#endregion
//#region lib/types/query/moments-monthly.js
/**
* Full moments monthly distribution (all history, unfiltered by pagination).
* The "all months" histogram counts every timeline row by create-time month, so
* it reflects the whole feed rather than only the initially loaded page.
*/
/** Stringify an SQLite cell (TEXT/NUMBER/BLOB) to a string. */
function cellString$1(v) {
	if (v === null || v === void 0) return "";
	if (typeof v === "string") return v;
	if (v instanceof Uint8Array) return new TextDecoder("utf-8", { fatal: false }).decode(v);
	if (typeof v === "number" || typeof v === "boolean" || typeof v === "bigint" || typeof v === "symbol") return String(v);
	return "";
}
function snsDb(decryptedDir) {
	for (const p of [join(decryptedDir, "sns", "db_sns", "sns.db"), join(decryptedDir, "sns", "sns.db")]) if (existsSync(p)) return p;
	return null;
}
/**
* Compute the full monthly distribution of moments, optionally for one author.
* @param decryptedDir - decrypted data root.
* @param author - optional author username filter (all authors when omitted).
* @param authorName - optional author display-name filter, matching the author
*   chips (all authors when omitted). Takes precedence over `author` when set.
* @returns monthly rows sorted ascending by month.
*/
function queryMomentsMonthly(decryptedDir, author, authorName) {
	const dbPath = snsDb(decryptedDir);
	const sig = dbPath === null ? "" : fileSigOf(dbPath);
	return cachedBySig("moments-monthly:" + decryptedDir + ":" + (author ?? "") + ":" + (authorName ?? ""), sig, () => computeMomentsMonthly(decryptedDir, author, authorName));
}
function computeMomentsMonthly(decryptedDir, author, authorName) {
	const dbPath = snsDb(decryptedDir);
	if (dbPath === null) return [];
	try {
		const db = new DatabaseSync(dbPath, { readOnly: true });
		if (!(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='SnsTimeLine'").get() !== void 0)) {
			db.close();
			return [];
		}
		const cols = new Set(db.prepare("PRAGMA table_info(SnsTimeLine)").all().map((r) => r.name));
		const userCol = cols.has("user_name") ? "user_name" : cols.has("userName") ? "userName" : "";
		const contentCol = cols.has("content") ? "content" : cols.has("Content") ? "Content" : "";
		if (!userCol || !contentCol) {
			db.close();
			return [];
		}
		const where = author && !authorName ? ` WHERE ${userCol} = ?` : "";
		const rows = db.prepare(`SELECT ${userCol} AS u, ${contentCol} AS c FROM SnsTimeLine${where}`).all(...author && !authorName ? [author] : []);
		db.close();
		const names = authorName ? contactMeta(decryptedDir).names : null;
		const monthly = /* @__PURE__ */ new Map();
		for (const r of rows) {
			if (authorName) {
				const u = cellString$1(r.u);
				if ((names?.get(u) || u || "未知") !== authorName) continue;
			}
			const xml = cellString$1(r.c);
			if (!xml) continue;
			const createTime = parseSnsXml(xml).createTime;
			if (createTime <= 0) continue;
			const d = /* @__PURE__ */ new Date(createTime * 1e3);
			const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
			monthly.set(key, (monthly.get(key) ?? 0) + 1);
		}
		return Array.from(monthly.entries()).map(([month, count]) => ({
			month,
			count
		})).sort((a, b) => a.month.localeCompare(b.month));
	} catch {
		return [];
	}
}
//#endregion
//#region lib/types/query/official-assets.js
/**
* Official account content assets: for each public account (gh_*), count total
* messages, article-type (local_type 49) messages and the latest article time.
*/
const ZSTD_MAGIC = Buffer.from([
	40,
	181,
	47,
	253
]);
function decodeCell(v) {
	if (v === null || v === void 0) return "";
	if (typeof v === "string") return v;
	if (typeof v === "number" || typeof v === "boolean" || typeof v === "bigint" || typeof v === "symbol") return String(v);
	const raw = Buffer.from(v instanceof Uint8Array ? v : []);
	const decompressed = raw.length >= 4 && raw.subarray(0, 4).equals(ZSTD_MAGIC) ? (() => {
		try {
			return Buffer.from(decompress(raw));
		} catch {
			return raw;
		}
	})() : raw;
	try {
		return new TextDecoder("utf-8", { fatal: false }).decode(decompressed);
	} catch {
		return "";
	}
}
function tableColumns$2(db, table) {
	const rows = db.prepare(`PRAGMA table_info(${table})`).all();
	return new Set(rows.map((r) => r.name));
}
function loadOfficialUsernames(decryptedDir) {
	const p = join(decryptedDir, "session", "session.db");
	const out = [];
	if (!existsSync(p)) return out;
	try {
		const db = new DatabaseSync(p, { readOnly: true });
		const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
		const table = tables.includes("SessionTable") ? "SessionTable" : tables.includes("Session") ? "Session" : "";
		if (table) {
			const rows = db.prepare(`SELECT username FROM "${table}"`).all();
			for (const r of rows) {
				const u = decodeCell(r["username"]).trim();
				if (u.startsWith("gh_")) out.push(u);
			}
		}
		db.close();
	} catch {}
	return out;
}
function loadNames(decryptedDir) {
	const map = /* @__PURE__ */ new Map();
	const p = join(decryptedDir, "contact", "contact.db");
	if (!existsSync(p)) return map;
	try {
		const db = new DatabaseSync(p, { readOnly: true });
		if (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='contact'").get() !== void 0) {
			const cols = tableColumns$2(db, "contact");
			if (cols.has("username")) {
				const remark = cols.has("remark") ? "remark" : cols.has("Remark") ? "Remark" : "NULL";
				const nick = cols.has("nick_name") ? "nick_name" : cols.has("NickName") ? "NickName" : "NULL";
				const rows = db.prepare(`SELECT username, COALESCE(NULLIF(${remark}, ''), ${nick}) AS n FROM contact`).all();
				for (const r of rows) {
					const u = decodeCell(r["username"]).trim();
					const n = decodeCell(r["n"]).trim();
					if (u && n) map.set(u, n);
				}
			}
		}
		db.close();
	} catch {}
	return map;
}
/**
* Compute official account content assets.
* @param decryptedDir - decrypted data root.
* @returns the official-assets snapshot.
*/
function queryOfficialAssets(decryptedDir) {
	const sig = [
		fileSigOf(join(decryptedDir, "session", "session.db")),
		fileSigOf(join(decryptedDir, "contact", "contact.db")),
		shardCatalogSig(decryptedDir, ["message"])
	].join("|");
	return cachedBySig("official-assets:" + decryptedDir, sig, () => computeOfficialAssets(decryptedDir), 3e4);
}
function computeOfficialAssets(decryptedDir) {
	const usernames = loadOfficialUsernames(decryptedDir);
	const names = loadNames(decryptedDir);
	const per = /* @__PURE__ */ new Map();
	const dir = join(decryptedDir, "message");
	if (existsSync(dir)) for (const f of readdirSync(dir)) {
		if (!/^(biz_)?message_\d+\.db$/.test(f)) continue;
		let db;
		try {
			db = new DatabaseSync(join(dir, f), { readOnly: true });
		} catch {
			continue;
		}
		try {
			const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'Msg_%'").all().map((r) => r.name);
			for (const table of tables) {
				const username = usernames.find((u) => "Msg_" + createHash("md5").update(u, "utf8").digest("hex") === table);
				if (!username) continue;
				const cols = tableColumns$2(db, table);
				if (!cols.has("create_time") || !cols.has("local_type")) continue;
				try {
					const rows = db.prepare(`SELECT create_time, local_type FROM "${table}"`).all();
					let acc = per.get(username);
					if (!acc) {
						acc = {
							messages: 0,
							articles: 0,
							lastArticleTime: null
						};
						per.set(username, acc);
					}
					for (const r of rows) {
						acc.messages += 1;
						if ((Number(r["local_type"] ?? 0) & 4294967295) === 49) {
							acc.articles += 1;
							const t = Number(r["create_time"] ?? 0);
							if (t > 0 && (acc.lastArticleTime == null || t > acc.lastArticleTime)) acc.lastArticleTime = t;
						}
					}
				} catch {}
			}
		} finally {
			db.close();
		}
	}
	const rows = Array.from(per.entries()).map(([username, v]) => ({
		username,
		name: names.get(username) ?? username,
		...v
	})).filter((r) => r.messages > 0).sort((a, b) => b.messages - a.messages).slice(0, 100);
	return {
		rows,
		total: rows.length,
		updatedAt: Math.floor(Date.now() / 1e3)
	};
}
//#endregion
//#region lib/types/query/operation-log.js
/**
* Operation log for the WeChat data panel: append-only records of the work
* this app performs (settings, keys, sync, exports, deletes, backups, edits,
* tasks) plus the failures it observes. Entries carry metadata only — never
* message bodies, image or file contents — so an export is safe to share.
* Persisted in the same <data-root>/wechat_privacy.db as the privacy audit
* log.
*/
/** Categories accepted from the client; anything else is dropped by the filter. */
const CATEGORIES = [
	"settings",
	"keys",
	"sync",
	"export",
	"delete",
	"backup",
	"edit",
	"task",
	"error"
];
const ALLOWED_CATEGORIES = new Set(CATEGORIES);
/** Valid result statuses. */
const STATUSES = [
	"ok",
	"fail",
	"skip"
];
const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 5e3;
function dbPath$3(decryptedDir) {
	return join(dirname(decryptedDir), "wechat_privacy.db");
}
function openStore$3(decryptedDir) {
	const db = new DatabaseSync(dbPath$3(decryptedDir));
	db.exec("CREATE TABLE IF NOT EXISTS operation_log (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, category TEXT NOT NULL, action TEXT, target TEXT, status TEXT NOT NULL, detail TEXT)");
	db.exec("CREATE INDEX IF NOT EXISTS operation_log_ts ON operation_log(ts)");
	return db;
}
/**
* 把缺失/占位的文本收敛成空串。
*
* 为什么需要：`this.op('task', 'generate_annual_report', 'ok', String(options.year), …)`
* 在调用方没传 `year` 时会写入**字面量字符串 `undefined`**，界面上就会出现一行
* 「目标 = undefined」（第 48 轮在操作日志里实测到）。写入与读取两侧都收敛：
* 写入侧防新脏数据，读取侧把库里已有的 `undefined`/`null` 历史行显示成空。
*/
function cleanText(v) {
	if (typeof v !== "string") return "";
	const t = v.trim();
	return t === "undefined" || t === "null" ? "" : t;
}
/** Append one operation row. Best-effort: a logging failure never breaks the operation it records. */
function recordOperation(decryptedDir, entry) {
	try {
		const db = openStore$3(decryptedDir);
		db.prepare("INSERT INTO operation_log(ts, category, action, target, status, detail) VALUES (?, ?, ?, ?, ?, ?)").run(entry.ts ?? Date.now(), entry.category, cleanText(entry.action), cleanText(entry.target), entry.status, cleanText(entry.detail));
		db.close();
	} catch {}
}
/** Build the WHERE clause + bound params for one query, from its optional filters. */
function whereClause(query) {
	const clauses = [];
	const params = [];
	if (query.from !== void 0) {
		clauses.push("ts >= ?");
		params.push(query.from);
	}
	if (query.to !== void 0) {
		clauses.push("ts <= ?");
		params.push(query.to);
	}
	if (query.status !== void 0) {
		clauses.push("status = ?");
		params.push(query.status);
	}
	const categories = (query.categories ?? []).filter((c) => ALLOWED_CATEGORIES.has(c));
	if (categories.length > 0) {
		clauses.push("category IN (" + categories.map(() => "?").join(", ") + ")");
		params.push(...categories);
	}
	return {
		sql: clauses.length > 0 ? " WHERE " + clauses.join(" AND ") : "",
		params
	};
}
function asCategory(v) {
	return CATEGORIES.find((c) => c === v) ?? "error";
}
function asStatus(v) {
	return STATUSES.find((s) => s === v) ?? "fail";
}
function toEntry(r) {
	return {
		id: Number(r["id"] ?? 0),
		ts: Number(r["ts"] ?? 0),
		category: asCategory(r["category"]),
		action: cleanText(r["action"]),
		target: cleanText(r["target"]),
		status: asStatus(r["status"]),
		detail: cleanText(r["detail"])
	};
}
/**
* Read matching operation rows, newest first. `total` counts every match,
* ignoring `limit`.
* @param decryptedDir - decrypted WeChat data root.
* @param query - optional time-range / category / status / limit filters.
* @returns OperationLogSnapshot: matching items + full match count.
*/
function listOperations(decryptedDir, query = {}) {
	const { sql, params } = whereClause(query);
	const limit = Math.min(Math.max(Math.floor(query.limit ?? DEFAULT_LIMIT), 1), MAX_LIMIT);
	const offset = Math.max(Math.floor(query.offset ?? 0), 0);
	try {
		const db = openStore$3(decryptedDir);
		const countRow = db.prepare("SELECT COUNT(*) AS n FROM operation_log" + sql).get(...params);
		const rows = db.prepare("SELECT id, ts, category, action, target, status, detail FROM operation_log" + sql + " ORDER BY id DESC LIMIT ? OFFSET ?").all(...params, limit, offset);
		db.close();
		/* v8 ignore next -- COUNT(*) always returns exactly one row, so countRow and its n are defined. */
		return {
			items: rows.map(toEntry),
			total: countRow?.n ?? 0
		};
	} catch {
		return {
			items: [],
			total: 0
		};
	}
}
/**
* Delete all operation-log rows.
* @param decryptedDir - decrypted WeChat data root.
* @returns OperationLogClearResult: ok + removed row count.
*/
function clearOperationLog(decryptedDir) {
	try {
		const db = openStore$3(decryptedDir);
		const r = db.prepare("DELETE FROM operation_log").run();
		db.close();
		return {
			ok: true,
			removed: Number(r.changes)
		};
	} catch {
		return {
			ok: false,
			removed: 0
		};
	}
}
//#endregion
//#region lib/types/query/privacy-audit.js
/**
* Privacy state store for WeChat AI features: outbound block, sensitive-field
* redaction, and per-feature audit counts. Persisted in
* <data-root>/wechat_privacy.db; enforcement lives in the gateway's LLM paths.
*/
function dbPath$2(decryptedDir) {
	return join(dirname(decryptedDir), "wechat_privacy.db");
}
function openStore$2(decryptedDir) {
	const db = new DatabaseSync(dbPath$2(decryptedDir));
	db.exec("CREATE TABLE IF NOT EXISTS privacy_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
	db.exec("CREATE TABLE IF NOT EXISTS privacy_audit (id INTEGER PRIMARY KEY AUTOINCREMENT, feature TEXT NOT NULL, ts INTEGER NOT NULL, chars INTEGER NOT NULL DEFAULT 0, sessions INTEGER NOT NULL DEFAULT 0, messages INTEGER NOT NULL DEFAULT 0)");
	return db;
}
function getSetting(db, key, dft) {
	const row = db.prepare("SELECT value FROM privacy_settings WHERE key = ?").get(key);
	return row ? row.value === "1" : dft;
}
/** Read the current privacy settings. Defaults: redaction off, outbound allowed. */
function readPrivacySettings(decryptedDir) {
	try {
		const db = openStore$2(decryptedDir);
		const out = {
			redactSensitive: getSetting(db, "redactSensitive", false),
			blockOutbound: getSetting(db, "blockOutbound", false)
		};
		db.close();
		return out;
	} catch {
		return {
			redactSensitive: false,
			blockOutbound: false
		};
	}
}
/** Persist privacy settings (partial update). */
function writePrivacySettings(decryptedDir, patch) {
	const db = openStore$2(decryptedDir);
	try {
		const entries = [["redactSensitive", patch.redactSensitive], ["blockOutbound", patch.blockOutbound]];
		for (const [key, value] of entries) {
			if (value === void 0) continue;
			db.prepare("INSERT INTO privacy_settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value ? "1" : "0");
		}
		return {
			redactSensitive: getSetting(db, "redactSensitive", false),
			blockOutbound: getSetting(db, "blockOutbound", false)
		};
	} finally {
		db.close();
	}
}
/** Read the privacy state snapshot including audit aggregates. */
function getPrivacyStateSnapshot(decryptedDir) {
	const settings = readPrivacySettings(decryptedDir);
	try {
		const db = openStore$2(decryptedDir);
		const totalRow = db.prepare("SELECT COUNT(*) AS n FROM privacy_audit").get();
		const featureRows = db.prepare("SELECT feature, COUNT(*) AS n, SUM(chars) AS c FROM privacy_audit GROUP BY feature ORDER BY n DESC").all();
		const lastRow = db.prepare("SELECT MAX(ts) AS t FROM privacy_audit").get();
		db.close();
		return {
			redactSensitive: settings.redactSensitive,
			blockOutbound: settings.blockOutbound,
			audit: {
				total: totalRow?.n ?? 0,
				byFeature: featureRows.map((r) => ({
					feature: r.feature,
					count: r.n,
					chars: r.c
				})),
				last: lastRow?.t ?? null,
				updatedAt: Math.floor(Date.now() / 1e3)
			}
		};
	} catch {
		return {
			redactSensitive: settings.redactSensitive,
			blockOutbound: settings.blockOutbound,
			audit: {
				total: 0,
				byFeature: [],
				last: null,
				updatedAt: Math.floor(Date.now() / 1e3)
			}
		};
	}
}
/**
* Record one AI feature call in the audit log.
*
* 第 59 轮补回：这个函数与 redactSensitiveText 在 bundle 里**根本不存在** ——
* 因为没有任何模块引用它们，打包时被 tree-shake 掉了，于是 privacy_audit 表永远是 0 行。
*/
function recordPrivacyAudit(decryptedDir, feature, chars, sessions, messages) {
	try {
		const db = openStore$2(decryptedDir);
		db.prepare("INSERT INTO privacy_audit(feature, ts, chars, sessions, messages) VALUES (?, ?, ?, ?, ?)").run(feature, Date.now(), chars, sessions, messages);
		db.close();
	} catch {}
}
/** Redact common sensitive fields (phone/id/bank/email/password) from prompt text. */
function redactSensitiveText(text) {
	return text.replace(/1[3-9]\d{9}/g, "[手机号]").replace(/[1-9]\d{5}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx]/g, "[身份证]").replace(/(?:62\d{14,17}|[45]\d{15,18})/g, "[银行卡]").replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[邮箱]").replace(/(?:密码|口令|pwd|password|passwd)\s*[=:：]\s*[A-Za-z0-9@#$%^&*!_.-]{4,32}/g, "[口令]");
}
/** List recent raw privacy audit rows. */function listPrivacyAudit(decryptedDir, limit = 200) {
	try {
		const db = openStore$2(decryptedDir);
		const rows = db.prepare("SELECT id, feature, ts, chars, sessions, messages FROM privacy_audit ORDER BY id DESC LIMIT ?").all(limit);
		db.close();
		return rows.map((r) => ({
			id: Number(r["id"] ?? 0),
			feature: typeof r["feature"] === "string" ? r["feature"] : "",
			ts: Number(r["ts"] ?? 0),
			chars: Number(r["chars"] ?? 0),
			sessions: Number(r["sessions"] ?? 0),
			messages: Number(r["messages"] ?? 0)
		}));
	} catch {
		return [];
	}
}
/** Clear all privacy audit rows. */
function clearPrivacyAudit(decryptedDir) {
	try {
		const db = openStore$2(decryptedDir);
		const r = db.prepare("DELETE FROM privacy_audit").run();
		db.close();
		return {
			ok: true,
			removed: Number(r.changes)
		};
	} catch {
		return {
			ok: false,
			removed: 0
		};
	}
}
//#endregion
//#region lib/types/query/wechat-tasks.js
/**
* WeChat task store: persists extracted todo/reminder items in
* <data-root>/wechat_tasks.db.
*
* ⚠️ 提取是**纯本地**的：`extractTasks` 用正则
* （记得|待办|要做|提醒|别忘了|稍后|待处理|deadline）逐行匹配，全程不调用模型、不出网。
* 原注释「Extraction (LLM) lives in the gateway」与实现不符，已在第 59 轮改正。
*/
function dbPath$1(decryptedDir) {
	return join(dirname(decryptedDir), "wechat_tasks.db");
}
function openStore$1(decryptedDir) {
	const db = new DatabaseSync(dbPath$1(decryptedDir));
	db.exec("CREATE TABLE IF NOT EXISTS tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', due_at INTEGER, source_username TEXT NOT NULL DEFAULT '', source_local_id INTEGER, message_time INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)");
	return db;
}
function cellStr$5(v) {
	if (typeof v === "string") return v;
	if (v === null || v === void 0) return "";
	if (typeof v === "number" || typeof v === "boolean" || typeof v === "bigint" || typeof v === "symbol") return String(v);
	return "";
}
function rowToTask$1(r) {
	const status = cellStr$5(r["status"] ?? "open") === "done" ? "done" : "open";
	const task = {
		id: Number(r["id"] ?? 0),
		title: cellStr$5(r["title"] ?? ""),
		status,
		createdAt: Number(r["created_at"] ?? 0),
		updatedAt: Number(r["updated_at"] ?? 0)
	};
	if (r["due_at"] != null) task.dueAt = Number(r["due_at"]);
	if (r["source_username"]) task.sourceUsername = cellStr$5(r["source_username"]);
	if (r["source_local_id"] != null) task.sourceLocalId = Number(r["source_local_id"]);
	if (r["message_time"] != null) task.messageTime = Number(r["message_time"]);
	return task;
}
/** List tasks (newest first). */
function listTasks(decryptedDir) {
	try {
		const db = openStore$1(decryptedDir);
		const rows = db.prepare("SELECT * FROM tasks ORDER BY id DESC").all();
		db.close();
		const items = rows.map(rowToTask$1);
		return {
			items,
			total: items.length
		};
	} catch {
		return {
			items: [],
			total: 0
		};
	}
}
/** Insert one task (extracted or manual). Skips open duplicates by title. */
function insertTask(decryptedDir, task) {
	try {
		const db = openStore$1(decryptedDir);
		if (db.prepare("SELECT id FROM tasks WHERE title = ? AND status = 'open' LIMIT 1").get(task.title)) {
			db.close();
			return {
				ok: false,
				error: "已存在同名待办"
			};
		}
		const ts = Date.now();
		const r = db.prepare("INSERT INTO tasks(title, status, due_at, source_username, source_local_id, message_time, created_at, updated_at) VALUES (?, 'open', ?, ?, ?, ?, ?, ?)").run(task.title, task.dueAt ?? null, task.sourceUsername ?? "", task.sourceLocalId ?? null, task.messageTime ?? null, ts, ts);
		const id = Number(r.lastInsertRowid);
		db.close();
		return {
			ok: true,
			id
		};
	} catch (e) {
		return {
			ok: false,
			error: e.message
		};
	}
}
/** Set task status ('open' | 'done'). */
function setTaskStatus(decryptedDir, id, status) {
	try {
		const db = openStore$1(decryptedDir);
		const r = db.prepare("UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?").run(status, Date.now(), id);
		db.close();
		return {
			ok: r.changes > 0,
			id
		};
	} catch (e) {
		return {
			ok: false,
			error: e.message
		};
	}
}
/** Delete a task. */
function deleteTask(decryptedDir, id) {
	try {
		const db = openStore$1(decryptedDir);
		const r = db.prepare("DELETE FROM tasks WHERE id = ?").run(id);
		db.close();
		return {
			ok: r.changes > 0,
			id
		};
	} catch (e) {
		return {
			ok: false,
			error: e.message
		};
	}
}
//#endregion
//#region lib/types/query/handoff.js
/**
* Native WeChat reminders (handoff_remind_v0) access: defensive column probe
* plus import into the plugin task store with title dedupe.
*/
function tableColumns$1(db, table) {
	const rows = db.prepare(`PRAGMA table_info(${table})`).all();
	return new Set(rows.map((r) => r.name));
}
function cellStr$4(v) {
	if (typeof v === "string") return v;
	if (v === null || v === void 0) return "";
	if (typeof v === "number" || typeof v === "boolean" || typeof v === "bigint" || typeof v === "symbol") return String(v);
	return "";
}
/** Resolve column names for a DB. */
function resolveColumns(cols) {
	return {
		id: [
			"local_id",
			"id",
			"item_id",
			"record_id",
			"rowid"
		].find((c) => cols.has(c)) ?? "",
		title: [
			"content",
			"item_content",
			"text",
			"title",
			"msg_content",
			"des"
		].find((c) => cols.has(c)) ?? "",
		time: [
			"time",
			"create_time",
			"alert_time",
			"ts",
			"remind_time"
		].find((c) => cols.has(c)) ?? ""
	};
}
/**
* List native WeChat reminders.
* @param decryptedDir - decrypted data root.
* @returns the native reminder snapshot.
*/
function listHandoffReminds(decryptedDir) {
	const p = join(decryptedDir, "general", "general.db");
	if (!existsSync(p)) return {
		items: [],
		total: 0
	};
	try {
		const db = new DatabaseSync(p, { readOnly: true });
		if (!(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='handoff_remind_v0'").get() !== void 0)) {
			db.close();
			return {
				items: [],
				total: 0
			};
		}
		const { id, title, time } = resolveColumns(tableColumns$1(db, "handoff_remind_v0"));
		if (!id || !title) {
			db.close();
			return {
				items: [],
				total: 0
			};
		}
		const rows = db.prepare(`SELECT ${id} AS i, ${title} AS t, ${time || "0"} AS tm FROM handoff_remind_v0 LIMIT 500`).all();
		db.close();
		const items = rows.map((r) => ({
			id: Number(r.i ?? 0),
			title: cellStr$4(r.t).trim(),
			time: Number(r.tm ?? 0) || null
		})).filter((r) => r.title);
		return {
			items,
			total: items.length
		};
	} catch {
		return {
			items: [],
			total: 0
		};
	}
}
/**
* Import native reminders into the plugin task store (deduped by title).
* @param decryptedDir - decrypted data root.
* @returns mutation result with added count.
*/
function importHandoffTasks(decryptedDir) {
	const snap = listHandoffReminds(decryptedDir);
	let added = 0;
	for (const item of snap.items) if (insertTask(decryptedDir, {
		title: item.title,
		...item.time !== null ? { dueAt: item.time * 1e3 } : {},
		...item.time !== null ? { messageTime: item.time } : {}
	}).ok) added += 1;
	return {
		ok: true,
		added
	};
}
//#endregion
//#region lib/types/query/unified-search.js
/**
* Unified search across local WeChat data domains: messages (index), contacts,
* moments, favorites, files, and records. Every domain is best-effort and
* returns its own typed hit shape; one failed domain never blocks the others.
*/
/** Safe display wrapper: never throw; fall back to the raw username. */
function cellString(v) {
	if (v === null || v === void 0) return "";
	if (typeof v === "string") return v;
	if (typeof v === "number" || typeof v === "boolean" || typeof v === "bigint" || typeof v === "symbol") return String(v);
	if (v instanceof Uint8Array) return new TextDecoder("utf-8", { fatal: false }).decode(v);
	return "";
}
function tableColumns(db, table) {
	const rows = db.prepare(`PRAGMA table_info(${table})`).all();
	return new Set(rows.map((r) => r.name));
}
function like(q) {
	return "%" + q + "%";
}
/** Contact names: remark > nick > username, plus category label. */
function searchContacts(decryptedDir, q, cap) {
	const p = join(decryptedDir, "contact", "contact.db");
	if (!existsSync(p)) return [];
	try {
		const db = new DatabaseSync(p, { readOnly: true });
		if (!(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='contact'").get() !== void 0)) {
			db.close();
			return [];
		}
		const cols = tableColumns(db, "contact");
		const userCol = cols.has("username") ? "username" : cols.has("UserName") ? "UserName" : "";
		const remarkCol = cols.has("remark") ? "remark" : cols.has("Remark") ? "Remark" : "";
		const nickCol = cols.has("nick_name") ? "nick_name" : cols.has("NickName") ? "NickName" : "";
		const aliasCol = cols.has("alias") ? "alias" : "";
		const quanCol = cols.has("quan_pin") ? "quan_pin" : "";
		const remarkQuanCol = cols.has("remark_quan_pin") ? "remark_quan_pin" : "";
		if (!userCol) {
			db.close();
			return [];
		}
		const searchCols = [
			userCol,
			remarkCol,
			nickCol,
			aliasCol,
			quanCol,
			remarkQuanCol
		].filter(Boolean);
		const likeClauses = searchCols.map((c) => `${c} LIKE ?`).join(" OR ");
		if (!likeClauses) {
			db.close();
			return [];
		}
		const params = searchCols.map(() => like(q));
		const rows = db.prepare(`SELECT ${userCol} AS u, ${remarkCol || "NULL"} AS r, ${nickCol || "NULL"} AS n, ${aliasCol || "NULL"} AS a FROM contact WHERE ${likeClauses} LIMIT ?`).all(...params, cap);
		db.close();
		return rows.map((r) => ({
			username: cellString(r.u),
			name: cellString(r.r) || cellString(r.n) || cellString(r.a) || cellString(r.u),
			category: cellString(r.u).endsWith("@chatroom") ? "group" : cellString(r.u).startsWith("gh_") ? "official" : "contact"
		}));
	} catch {
		return [];
	}
}
/** Moments by author + content LIKE. */
function searchMoments(decryptedDir, q, cap) {
	const dbPathCandidates = [join(decryptedDir, "sns", "db_sns", "sns.db"), join(decryptedDir, "sns", "sns.db")];
	for (const p of dbPathCandidates) {
		if (!existsSync(p)) continue;
		try {
			const db = new DatabaseSync(p, { readOnly: true });
			if (!(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='SnsTimeLine'").get() !== void 0)) {
				db.close();
				continue;
			}
			const cols = tableColumns(db, "SnsTimeLine");
			const uname = cols.has("user_name") ? "user_name" : cols.has("userName") ? "userName" : "";
			const content = cols.has("content") ? "content" : cols.has("Content") ? "Content" : "";
			if (!uname || !content) {
				db.close();
				continue;
			}
			const rows = db.prepare(`SELECT ${uname} AS u, ${content} AS c FROM SnsTimeLine WHERE ${content} LIKE ? LIMIT ?`).all(like(q), cap);
			db.close();
			const names = contactMeta(decryptedDir).names;
			return rows.map((r) => {
				const username = cellString(r.u);
				return {
					username,
					name: names.get(username) ?? username,
					snippet: cellString(r.c).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 100)
				};
			});
		} catch {}
	}
	return [];
}
/** Favorites by content LIKE (fav_db_item in favorite.db). */
function searchFavorites(decryptedDir, q, cap) {
	const p = join(decryptedDir, "favorite", "favorite.db");
	if (!existsSync(p)) return [];
	try {
		const db = new DatabaseSync(p, { readOnly: true });
		if (!(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='fav_db_item'").get() !== void 0)) {
			db.close();
			return [];
		}
		const cols = tableColumns(db, "fav_db_item");
		const idCol = cols.has("local_id") ? "local_id" : cols.has("Id") ? "Id" : "0";
		const contentCol = cols.has("content") ? "content" : cols.has("Content") ? "Content" : "";
		if (!contentCol) {
			db.close();
			return [];
		}
		const rows = db.prepare(`SELECT ${idCol} AS id, ${contentCol} AS c FROM fav_db_item WHERE ${contentCol} LIKE ? LIMIT ?`).all(like(q), cap);
		db.close();
		return rows.map((r) => ({
			id: Number(r.id ?? 0),
			snippet: cellString(r.c).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 100)
		}));
	} catch {
		return [];
	}
}
/** Files by file_name LIKE across hardlink tables. */
function searchFiles(decryptedDir, q, cap) {
	const p = join(decryptedDir, "hardlink", "hardlink.db");
	if (!existsSync(p)) return [];
	try {
		const db = new DatabaseSync(p, { readOnly: true });
		const out = [];
		for (const table of [
			"image_hardlink_info_v4",
			"file_hardlink_info_v4",
			"video_hardlink_info_v4"
		]) {
			if (!(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table) !== void 0)) continue;
			const cols = tableColumns(db, table);
			const nameCol = cols.has("file_name") ? "file_name" : cols.has("fileName") ? "fileName" : "";
			const md5Col = cols.has("md5") ? "md5" : "";
			const sizeCol = cols.has("file_size") ? "file_size" : cols.has("fileSize") ? "fileSize" : "0";
			if (!nameCol) continue;
			const rows = db.prepare(`SELECT ${nameCol} AS n, ${md5Col || "'0'"} AS m, ${sizeCol} AS s FROM ${table} WHERE ${nameCol} LIKE ? LIMIT ?`).all(like(q), cap - out.length);
			for (const r of rows) {
				out.push({
					fileName: cellString(r.n),
					md5: cellString(r.m),
					size: Number(r.s ?? 0)
				});
				if (out.length >= cap) break;
			}
			if (out.length >= cap) break;
		}
		db.close();
		return out;
	} catch {
		return [];
	}
}
/** Transfers/red packets whose session matches the query. */
function searchRecords(decryptedDir, q, cap) {
	const p = join(decryptedDir, "general", "general.db");
	if (!existsSync(p)) return [];
	try {
		const db = new DatabaseSync(p, { readOnly: true });
		const out = [];
		for (const [table, kind] of [["transferTable", "transfers"], ["redEnvelopeTable", "redpackets"]]) {
			if (!(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table) !== void 0)) continue;
			const cols = tableColumns(db, table);
			const sessionCol = cols.has("session_name") ? "session_name" : cols.has("SessionName") ? "SessionName" : "";
			if (!sessionCol) continue;
			const rows = db.prepare(`SELECT ${sessionCol} AS s FROM ${table} WHERE ${sessionCol} LIKE ? LIMIT ?`).all(like(q), cap - out.length);
			for (const r of rows) {
				const session = cellString(r.s);
				if (!session) continue;
				out.push({
					kind,
					name: session,
					session
				});
				if (out.length >= cap) break;
			}
			if (out.length >= cap) break;
		}
		db.close();
		return out;
	} catch {
		return [];
	}
}
/**
* Run the unified local search.
* @param decryptedDir - decrypted data root.
* @param query - search term.
* @param limit - max hits per domain (default 6).
* @returns the unified snapshot.
*/
function searchUnified(decryptedDir, query, limit) {
	const q = (query || "").trim();
	const cap = Math.min(limit ?? 6, 12);
	return {
		query: q,
		messages: q ? searchIndexMessages(decryptedDir, q, cap).hits : [],
		contacts: q ? searchContacts(decryptedDir, q, cap) : [],
		moments: q ? searchMoments(decryptedDir, q, cap) : [],
		favorites: q ? searchFavorites(decryptedDir, q, cap) : [],
		files: q ? searchFiles(decryptedDir, q, cap) : [],
		records: q ? searchRecords(decryptedDir, q, cap) : []
	};
}
//#endregion
//#region lib/types/query/edit.js
/**
* Message edit store, rewritten from st_control edit_store.rs. Edits write to
* the decrypted message shard and record the original snapshot in
* <wechat>/message_edits.db so the original can be restored.
*/
/** Msg_<md5(username)> table name for a talker. */
function msgTableName(username) {
	return "Msg_" + createHash("md5").update(username, "utf8").digest("hex");
}
/** Message shard DB files under <decrypted>/message. */
function messageShardFiles(decryptedDir) {
	const dir = join(decryptedDir, "message");
	if (!existsSync(dir)) return [];
	return readdirSync(dir).filter((f) => f.endsWith(".db") && !f.includes("_shm") && !f.includes("_wal") && !f.includes("monitor_cache")).sort().map((f) => join(dir, f));
}
/** Edit store DB path: sibling of the decrypted dir. */
function editDbPath(decryptedDir) {
	return join(dirname(decryptedDir), "message_edits.db");
}
/** Open (create) the edit store with schema. */
function openEditStore(decryptedDir) {
	const db = new DatabaseSync(editDbPath(decryptedDir));
	db.exec("CREATE TABLE IF NOT EXISTS message_edits (account TEXT NOT NULL, session_id TEXT NOT NULL, db TEXT NOT NULL, table_name TEXT NOT NULL, local_id INTEGER NOT NULL, first_edited_at INTEGER NOT NULL, last_edited_at INTEGER NOT NULL, edit_count INTEGER NOT NULL, original_msg_json TEXT NOT NULL, edited_cols_json TEXT, PRIMARY KEY (account, session_id, db, table_name, local_id))");
	return db;
}
/** Coerce a DB cell to a string (null -> '', else String()). */
function cellStr$3(v) {
	if (typeof v === "string") return v;
	if (v === null || v === void 0) return "";
	if (typeof v === "number" || typeof v === "boolean" || typeof v === "bigint" || typeof v === "symbol") return String(v);
	return "";
}
/**
* List edited messages (optionally for one session).
* @param decryptedDir - decrypted data root.
* @param sessionId - optional session to filter by.
* @returns edited message records plus total count.
*/
function listEditedMessages(decryptedDir, sessionId) {
	const p = editDbPath(decryptedDir);
	if (!existsSync(p)) return {
		items: [],
		total: 0
	};
	try {
		const db = new DatabaseSync(p, { readOnly: true });
		let rows;
		if (sessionId) rows = db.prepare("SELECT session_id, db, table_name, local_id, last_edited_at, edit_count, original_msg_json FROM message_edits WHERE session_id = ? ORDER BY last_edited_at DESC").all(sessionId);
		else rows = db.prepare("SELECT session_id, db, table_name, local_id, last_edited_at, edit_count, original_msg_json FROM message_edits ORDER BY last_edited_at DESC LIMIT 500").all();
		db.close();
		const items = rows.map((r) => ({
			sessionId: cellStr$3(r["session_id"] ?? ""),
			db: cellStr$3(r["db"] ?? ""),
			tableName: cellStr$3(r["table_name"] ?? ""),
			localId: Number(r["local_id"] ?? 0),
			lastEditedAt: Number(r["last_edited_at"] ?? 0),
			editCount: Number(r["edit_count"] ?? 0),
			originalMsgJson: cellStr$3(r["original_msg_json"] ?? "")
		}));
		return {
			items,
			total: items.length
		};
	} catch {
		return {
			items: [],
			total: 0
		};
	}
}
/** Locate the shard containing a talker Msg table. */
function findShard(decryptedDir, table) {
	for (const f of messageShardFiles(decryptedDir)) try {
		const db = new DatabaseSync(f);
		if (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table) !== void 0) return db;
		db.close();
	} catch {}
	return null;
}
/**
* Edit one message content (writes to the decrypted shard + records the edit).
* @param decryptedDir - decrypted data root.
* @param username - conversation username.
* @param localId - message local id.
* @param newContent - new message content text.
* @returns result with ok + edited localId.
*/
function editChatMessage(decryptedDir, username, localId, newContent) {
	const table = msgTableName(username);
	const db = findShard(decryptedDir, table);
	if (!db) return {
		ok: false,
		error: "未找到消息分库"
	};
	try {
		const cols = db.prepare("PRAGMA table_info(\"" + table + "\")").all().map((r) => r.name);
		const contentCol = cols.includes("message_content") ? "message_content" : cols.includes("Content") ? "Content" : null;
		const strCol = cols.includes("str_content") ? "str_content" : null;
		if (!contentCol) {
			db.close();
			return {
				ok: false,
				error: "消息表缺少内容列"
			};
		}
		const row = db.prepare("SELECT \"" + contentCol + "\" AS c FROM \"" + table + "\" WHERE local_id = ? LIMIT 1").get(localId);
		if (!row) {
			db.close();
			return {
				ok: false,
				error: "消息不存在"
			};
		}
		const store = openEditStore(decryptedDir);
		const ts = Date.now();
		if (!store.prepare("SELECT 1 FROM message_edits WHERE session_id = ? AND local_id = ?").get(username, localId)) {
			const originalJson = JSON.stringify({ [contentCol]: cellStr$3(row.c ?? "") });
			store.prepare("INSERT INTO message_edits(account, session_id, db, table_name, local_id, first_edited_at, last_edited_at, edit_count, original_msg_json, edited_cols_json) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, '[\"" + contentCol + "\"]')").run(username, username, "message", table, localId, ts, ts, originalJson);
		} else store.prepare("UPDATE message_edits SET last_edited_at = ?, edit_count = edit_count + 1 WHERE session_id = ? AND local_id = ?").run(ts, username, localId);
		store.close();
		db.prepare("UPDATE \"" + table + "\" SET \"" + contentCol + "\" = ? WHERE local_id = ?").run(newContent, localId);
		if (strCol) db.prepare("UPDATE \"" + table + "\" SET \"" + strCol + "\" = ? WHERE local_id = ?").run(newContent, localId);
		return {
			ok: true,
			localId
		};
	} catch (e) {
		return {
			ok: false,
			error: e.message
		};
	} finally {
		db.close();
	}
}
/**
* Restore a message to its original content from the edit store.
* @param decryptedDir - decrypted data root.
* @param username - conversation username.
* @param localId - message local id to restore.
* @returns result with ok.
*/
function resetEditedMessage(decryptedDir, username, localId) {
	const p = editDbPath(decryptedDir);
	if (!existsSync(p)) return {
		ok: false,
		error: "编辑记录库不存在"
	};
	try {
		const store = new DatabaseSync(p);
		const rec = store.prepare("SELECT db, table_name, original_msg_json FROM message_edits WHERE session_id = ? AND local_id = ?").get(username, localId);
		if (!rec) {
			store.close();
			return {
				ok: false,
				error: "无编辑记录"
			};
		}
		let original = {};
		try {
			original = JSON.parse(rec.original_msg_json ?? "{}");
		} catch {}
		store.close();
		const table = rec.table_name ?? msgTableName(username);
		const db = findShard(decryptedDir, table);
		if (!db) return {
			ok: false,
			error: "未找到消息分库"
		};
		try {
			const cols = db.prepare("PRAGMA table_info(\"" + table + "\")").all().map((r) => r.name);
			for (const [col, val] of Object.entries(original)) {
				if (!cols.includes(col)) continue;
				db.prepare("UPDATE \"" + table + "\" SET \"" + col + "\" = ? WHERE local_id = ?").run(String(val), localId);
			}
			const store2 = new DatabaseSync(p);
			store2.prepare("DELETE FROM message_edits WHERE session_id = ? AND local_id = ?").run(username, localId);
			store2.close();
			return { ok: true };
		} finally {
			db.close();
		}
	} catch (e) {
		return {
			ok: false,
			error: e.message
		};
	}
}
//#endregion
//#region lib/types/query/drafts.js
/**
* Session draft clearing, rewritten from st_control handlers/session.rs
* clear_session_draft / clear_all_session_drafts. Writes to the decrypted
* session.db copy only (the WeChat source is untouched).
*/
/** Open the decrypted session.db read-write. */
function openSessionDb(decryptedDir) {
	const p = join(decryptedDir, "session", "session.db");
	if (!existsSync(p)) return null;
	try {
		return new DatabaseSync(p);
	} catch {
		return null;
	}
}
/** Coerce a DB cell to a string (null -> '', else String()). */
function cellStr$2(v) {
	if (typeof v === "string") return v;
	if (v === null || v === void 0) return "";
	if (typeof v === "number" || typeof v === "boolean" || typeof v === "bigint" || typeof v === "symbol") return String(v);
	return "";
}
/** Decode a draft cell (TEXT or BLOB). */
function draftText(v) {
	if (v === null || v === void 0) return "";
	if (typeof v === "string") return v;
	if (v instanceof Uint8Array) return new TextDecoder("utf-8", { fatal: false }).decode(v);
	if (typeof v === "number" || typeof v === "boolean" || typeof v === "bigint" || typeof v === "symbol") return String(v);
	return "";
}
/**
* Clear one session draft (decrypted copy only).
* @param decryptedDir - decrypted data root.
* @param username - session username whose draft is cleared.
* @returns ok + rows updated.
*/
function clearSessionDraft(decryptedDir, username) {
	const db = openSessionDb(decryptedDir);
	if (!db) return {
		ok: false,
		updated: 0,
		error: "解密 session.db 不存在"
	};
	try {
		if (!(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='SessionTable'").get() !== void 0)) {
			db.close();
			return {
				ok: false,
				updated: 0,
				error: "SessionTable 不存在"
			};
		}
		const r = db.prepare("UPDATE SessionTable SET draft = ? WHERE username = ?").run("", username);
		return {
			ok: true,
			updated: Number(r.changes)
		};
	} catch (e) {
		return {
			ok: false,
			updated: 0,
			error: e.message
		};
	} finally {
		db.close();
	}
}
/**
* Clear all session drafts, returning the cleared drafts list.
* @param decryptedDir - decrypted data root.
* @returns cleared drafts + count.
*/
function clearAllSessionDrafts(decryptedDir) {
	const db = openSessionDb(decryptedDir);
	if (!db) return {
		ok: false,
		cleared: [],
		count: 0,
		error: "解密 session.db 不存在"
	};
	try {
		if (!(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='SessionTable'").get() !== void 0)) {
			db.close();
			return {
				ok: false,
				cleared: [],
				count: 0,
				error: "SessionTable 不存在"
			};
		}
		const cleared = db.prepare("SELECT username, draft FROM SessionTable WHERE draft IS NOT NULL AND length(draft) > 0").all().map((r) => ({
			username: cellStr$2(r["username"] ?? ""),
			draft: draftText(r["draft"])
		}));
		db.prepare("UPDATE SessionTable SET draft = ? WHERE draft IS NOT NULL AND length(draft) > 0").run("");
		return {
			ok: true,
			cleared,
			count: cleared.length
		};
	} catch (e) {
		return {
			ok: false,
			cleared: [],
			count: 0,
			error: e.message
		};
	} finally {
		db.close();
	}
}
//#endregion
//#region lib/types/query/summary-tasks.js
/**
* Daily-summary task store, rewritten from st_control daily_summary/crud.rs.
* Persists scheduled summary tasks + generated records in <wechat>/daily_summary.db.
* The LLM generation itself lives in the gateway (needs ctx.llm).
*/
/** Daily-summary DB path: sibling of the decrypted dir. */
function dbPath(decryptedDir) {
	return join(dirname(decryptedDir), "daily_summary.db");
}
/** Open (create) the summary store with schema. */
function openStore(decryptedDir) {
	const db = new DatabaseSync(dbPath(decryptedDir));
	db.exec("CREATE TABLE IF NOT EXISTS summary_tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, group_username TEXT NOT NULL, group_name TEXT NOT NULL DEFAULT '', target_users TEXT NOT NULL DEFAULT '[]', provider_id TEXT NOT NULL DEFAULT '', model TEXT NOT NULL DEFAULT '', format TEXT NOT NULL DEFAULT 'brief', custom_prompt TEXT NOT NULL DEFAULT '', schedule_time TEXT NOT NULL DEFAULT '08:00', enabled INTEGER NOT NULL DEFAULT 1, last_run_at INTEGER, last_status TEXT NOT NULL DEFAULT '', last_error TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)");
	db.exec("CREATE TABLE IF NOT EXISTS summary_records (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER NOT NULL, group_username TEXT NOT NULL, group_name TEXT NOT NULL DEFAULT '', target_users TEXT NOT NULL DEFAULT '[]', summary_date TEXT NOT NULL, provider_id TEXT NOT NULL DEFAULT '', model TEXT NOT NULL DEFAULT '', format TEXT NOT NULL DEFAULT 'brief', summary TEXT NOT NULL DEFAULT '', char_count INTEGER NOT NULL DEFAULT 0, message_count INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'done', error TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL)");
	return db;
}
/** Coerce a DB cell to a string (null -> '', else String()). */
function cellStr$1(v) {
	if (typeof v === "string") return v;
	if (v === null || v === void 0) return "";
	if (typeof v === "number" || typeof v === "boolean" || typeof v === "bigint" || typeof v === "symbol") return String(v);
	return "";
}
/** Map a DB row to a task. */
function rowToTask(r) {
	let targetUsers = [];
	try {
		targetUsers = JSON.parse(cellStr$1(r["target_users"] ?? "[]"));
	} catch {}
	const base = {
		id: Number(r["id"] ?? 0),
		groupUsername: cellStr$1(r["group_username"] ?? ""),
		groupName: cellStr$1(r["group_name"] ?? ""),
		targetUsers,
		format: cellStr$1(r["format"] ?? "brief"),
		customPrompt: cellStr$1(r["custom_prompt"] ?? ""),
		scheduleTime: cellStr$1(r["schedule_time"] ?? "08:00"),
		enabled: Number(r["enabled"] ?? 1) !== 0,
		lastStatus: cellStr$1(r["last_status"] ?? ""),
		lastError: cellStr$1(r["last_error"] ?? ""),
		createdAt: Number(r["created_at"] ?? 0),
		updatedAt: Number(r["updated_at"] ?? 0)
	};
	if (r["last_run_at"]) base.lastRunAt = Number(r["last_run_at"]);
	return base;
}
/**
* List summary tasks.
* @param decryptedDir - decrypted data root.
* @returns summary task items plus total count.
*/
function listSummaryTasks(decryptedDir) {
	try {
		const db = openStore(decryptedDir);
		const rows = db.prepare("SELECT * FROM summary_tasks ORDER BY id DESC").all();
		db.close();
		const items = rows.map(rowToTask);
		return {
			items,
			total: items.length
		};
	} catch {
		return {
			items: [],
			total: 0
		};
	}
}
/**
* Save a task (insert when id=0, else update).
* @param decryptedDir - decrypted data root.
* @param task - task payload (id 0 inserts, otherwise updates).
* @returns ok plus the saved task id, or an error description.
*/
function saveSummaryTask(decryptedDir, task) {
	try {
		const db = openStore(decryptedDir);
		const ts = Date.now();
		const target = JSON.stringify(task.targetUsers);
		if (task.id && task.id > 0) {
			db.prepare("UPDATE summary_tasks SET group_username = ?, group_name = ?, target_users = ?, format = ?, custom_prompt = ?, schedule_time = ?, enabled = ?, updated_at = ? WHERE id = ?").run(task.groupUsername, task.groupName, target, task.format, task.customPrompt, task.scheduleTime, task.enabled ? 1 : 0, ts, task.id);
			db.close();
			return {
				ok: true,
				id: task.id
			};
		}
		const r = db.prepare("INSERT INTO summary_tasks(group_username, group_name, target_users, format, custom_prompt, schedule_time, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(task.groupUsername, task.groupName, target, task.format, task.customPrompt, task.scheduleTime, task.enabled ? 1 : 0, ts, ts);
		const id = Number(r.lastInsertRowid);
		db.close();
		return {
			ok: true,
			id
		};
	} catch (e) {
		return {
			ok: false,
			error: e.message
		};
	}
}
/**
* Delete a task by id.
* @param decryptedDir - decrypted data root.
* @param id - task id to delete.
* @returns ok, or an error description.
*/
/** Record a task's last run state (timestamp/status/error) so the scheduler does not re-run the same minute. */
function updateSummaryTaskRunState(decryptedDir, id, lastRunAt, lastStatus, lastError) {
	try {
		const db = openStore(decryptedDir);
		db.prepare("UPDATE summary_tasks SET last_run_at = ?, last_status = ?, last_error = ?, updated_at = ? WHERE id = ?").run(lastRunAt, lastStatus, lastError, Date.now(), id);
		db.close();
		return { ok: true };
	} catch (e) {
		return {
			ok: false,
			error: e.message
		};
	}
}
function deleteSummaryTask(decryptedDir, id) {
	try {
		const db = openStore(decryptedDir);
		db.prepare("DELETE FROM summary_tasks WHERE id = ?").run(id);
		db.close();
		return { ok: true };
	} catch (e) {
		return {
			ok: false,
			error: e.message
		};
	}
}
/**
* Toggle a task enabled state.
* @param decryptedDir - decrypted data root.
* @param id - task id to toggle.
* @param enabled - new enabled state.
* @returns ok, or an error description.
*/
function toggleSummaryTask(decryptedDir, id, enabled) {
	try {
		const db = openStore(decryptedDir);
		db.prepare("UPDATE summary_tasks SET enabled = ?, updated_at = ? WHERE id = ?").run(enabled ? 1 : 0, Date.now(), id);
		db.close();
		return { ok: true };
	} catch (e) {
		return {
			ok: false,
			error: e.message
		};
	}
}
/**
* Record a generated summary.
* @param decryptedDir - decrypted data root.
* @param rec - summary record payload (id/createdAt are generated).
* @returns ok plus the new record id, or an error description.
*/
function saveSummaryRecord(decryptedDir, rec) {
	try {
		const db = openStore(decryptedDir);
		const r = db.prepare("INSERT INTO summary_records(task_id, group_username, group_name, summary_date, summary, message_count, status, error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(rec.taskId, rec.groupUsername, rec.groupName ?? "", rec.summaryDate, rec.summary, rec.messageCount, rec.status, rec.error, Date.now());
		const id = Number(r.lastInsertRowid);
		db.close();
		return {
			ok: true,
			id
		};
	} catch (e) {
		return {
			ok: false,
			error: e.message
		};
	}
}
/**
* Delete a generated record by id.
* @param decryptedDir - decrypted data root.
* @param id - record id to delete.
* @returns ok, or an error description.
*/
function deleteSummaryRecord(decryptedDir, id) {
	try {
		const db = openStore(decryptedDir);
		db.prepare("DELETE FROM summary_records WHERE id = ?").run(id);
		db.close();
		return { ok: true };
	} catch (e) {
		return {
			ok: false,
			error: e.message
		};
	}
}
/**
* List generated records (optionally for one task).
* @param decryptedDir - decrypted data root.
* @param taskId - optional task id to filter by.
* @returns summary record items plus total count.
*/
function listSummaryRecords(decryptedDir, taskId) {
	try {
		const db = openStore(decryptedDir);
		let rows;
		if (taskId) rows = db.prepare("SELECT * FROM summary_records WHERE task_id = ? ORDER BY created_at DESC LIMIT 50").all(taskId);
		else rows = db.prepare("SELECT * FROM summary_records ORDER BY created_at DESC LIMIT 100").all();
		db.close();
		const items = rows.map((r) => ({
			id: Number(r["id"] ?? 0),
			taskId: Number(r["task_id"] ?? 0),
			groupUsername: cellStr$1(r["group_username"] ?? ""),
			summaryDate: cellStr$1(r["summary_date"] ?? ""),
			summary: cellStr$1(r["summary"] ?? ""),
			messageCount: Number(r["message_count"] ?? 0),
			status: cellStr$1(r["status"] ?? ""),
			error: cellStr$1(r["error"] ?? ""),
			createdAt: Number(r["created_at"] ?? 0)
		}));
		return {
			items,
			total: items.length
		};
	} catch {
		return {
			items: [],
			total: 0
		};
	}
}
//#endregion
//#region ../../util/values/src/index.ts
/**
* Mark an unreachable closed-union branch.
* @param value - impossible value; an unhandled typed variant fails at the call site.
* @param context - optional switch-site label included in the failure message.
* @returns never; a runtime value that escaped its type always throws.
*/
function assertNever(value, context) {
	const rendered = JSON.stringify(value) ?? String(value);
	throw new Error(`unreachable variant${context ? ` in ${context}` : ""}: ${rendered}`);
}
/**
* Deep-freeze an object graph in place while leaving live AbortSignal objects mutable.
* @param value - value to freeze.
* @returns the same value after every reachable enumerable child is frozen.
*/
function deepFreeze(value) {
	const seen = /* @__PURE__ */ new WeakSet();
	const pending = [{
		kind: "visit",
		node: value
	}];
	while (pending.length > 0) {
		const task = pending.pop();
		/* v8 ignore next -- the loop condition guarantees one pending task. */
		if (task === void 0) continue;
		if (task.kind === "property") {
			pending.push({
				kind: "visit",
				node: task.source[task.key]
			});
			continue;
		}
		const node = task.node;
		if (node === null || typeof node !== "object") continue;
		if (node instanceof AbortSignal) continue;
		if (seen.has(node)) continue;
		seen.add(node);
		Object.freeze(node);
		const keys = Object.keys(node);
		for (let index = keys.length - 1; index >= 0; index--) {
			const key = keys[index];
			/* v8 ignore next -- the loop is bounded by the captured key count. */
			if (key === void 0) continue;
			pending.push({
				kind: "property",
				source: node,
				key
			});
		}
	}
	return value;
}
//#endregion
//#region ../../util/crypto/src/index.ts
/**
* Random v4 UUID, minted from `crypto.getRandomValues`.
* @returns the UUID string.
*/
function randomUUID() {
	const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
	const hex = Array.from(bytes, (byte, index) => {
		return (index === 6 ? byte & 15 | 64 : index === 8 ? byte & 63 | 128 : byte).toString(16).padStart(2, "0");
	}).join("");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
//#endregion
//#region ../../util/brand/src/index.ts
/**
* Apply a compile-time string brand without changing the value.
* @param value - string admitted by the domain that owns the target brand.
* @returns the same string with the requested compile-time brand.
*/
function brandString(value) {
	return value;
}
//#endregion
//#region ../../llm/llm/src/message.ts
/** Message value types, identity, and immutable construction helpers. */
/**
* Detach and deep-freeze a message whose identity already exists.
* @param message - complete message, including its stable identity.
* @returns an immutable snapshot that preserves the identity.
*/
function freezeMessage(message) {
	return deepFreeze(structuredClone(message));
}
/**
* Create one identified message and freeze it before publication.
* @param input - complete role, content, and source for a new message.
* @returns an immutable message with a fresh stable identity.
*/
function createMessage(input) {
	return freezeMessage({
		...input,
		id: brandString(randomUUID())
	});
}
/**
* Create one identified user-role message and freeze it before publication.
* @param input - complete content and source for a new user message.
* @returns an immutable user message with a fresh stable identity.
*/
function createUserMessage(input) {
	return createMessage({
		...input,
		role: "user"
	});
}
//#endregion
//#region ../../../vendor/cosmokit/src/misc.ts
/** Return true when a value is `null` or `undefined`. */
function isNullable(value) {
	return value === null || value === void 0;
}
/** Return true for non-array object values. */
function isPlainObject(data) {
	return data && typeof data === "object" && !Array.isArray(data);
}
/** Filter object entries and return a new object. */
function filterKeys(object, filter) {
	return Object.fromEntries(Object.entries(object).filter(([key, value]) => filter(key, value)));
}
/** Map object values while preserving the original key set. */
function mapValues(object, transform) {
	return Object.fromEntries(Object.entries(object).map(([key, value]) => [key, transform(value, key)]));
}
/** Pick selected keys from an object, optionally including `undefined` values. */
function pick(source, keys, forced) {
	if (!keys) return { ...source };
	const result = {};
	for (const key of keys) if (forced || source[key] !== void 0) result[key] = source[key];
	return result;
}
//#endregion
//#region ../../../vendor/cosmokit/src/types.ts
/** Test values using `instanceof` with a `toStringTag` fallback. */
function is(type, value) {
	if (arguments.length === 1) return (value) => is(type, value);
	return type in globalThis && value instanceof globalThis[type] || Object.prototype.toString.call(value).slice(8, -1) === type;
}
function isArrayBufferLike(value) {
	return is("ArrayBuffer", value) || is("SharedArrayBuffer", value);
}
function isArrayBufferSource(value) {
	return isArrayBufferLike(value) || ArrayBuffer.isView(value);
}
let Binary;
(function(_Binary) {
	_Binary.is = isArrayBufferLike;
	_Binary.isSource = isArrayBufferSource;
	function fromSource(source) {
		if (ArrayBuffer.isView(source)) return source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength);
		else return source;
	}
	_Binary.fromSource = fromSource;
	function toBase64(source) {
		source = fromSource(source);
		if (typeof Buffer !== "undefined") return Buffer.from(source).toString("base64");
		let binary = "";
		const bytes = new Uint8Array(source);
		for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
		return btoa(binary);
	}
	_Binary.toBase64 = toBase64;
	function fromBase64(source) {
		if (typeof Buffer !== "undefined") return fromSource(Buffer.from(source, "base64"));
		return Uint8Array.from(atob(source), (c) => c.charCodeAt(0));
	}
	_Binary.fromBase64 = fromBase64;
	function toHex(source) {
		source = fromSource(source);
		if (typeof Buffer !== "undefined") return Buffer.from(source).toString("hex");
		return Array.from(new Uint8Array(source), (byte) => byte.toString(16).padStart(2, "0")).join("");
	}
	_Binary.toHex = toHex;
	function fromHex(source) {
		if (typeof Buffer !== "undefined") return fromSource(Buffer.from(source, "hex"));
		const hex = source.length % 2 === 0 ? source : source.slice(0, source.length - 1);
		const buffer = [];
		for (let i = 0; i < hex.length; i += 2) buffer.push(parseInt(`${hex[i]}${hex[i + 1]}`, 16));
		return Uint8Array.from(buffer).buffer;
	}
	_Binary.fromHex = fromHex;
})(Binary || (Binary = {}));
Binary.fromBase64;
Binary.toBase64;
Binary.fromHex;
Binary.toHex;
/** Deep-clone common JavaScript values while preserving prototypes and cycles. */
function clone(source, refs = /* @__PURE__ */ new Map()) {
	if (!source || typeof source !== "object") return source;
	if (is("Date", source)) return new Date(source.valueOf());
	if (is("RegExp", source)) return new RegExp(source.source, source.flags);
	if (isArrayBufferLike(source)) return source.slice(0);
	if (ArrayBuffer.isView(source)) return source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength);
	const cached = refs.get(source);
	if (cached) return cached;
	if (Array.isArray(source)) {
		const result = [];
		refs.set(source, result);
		source.forEach((value, index) => {
			result[index] = Reflect.apply(clone, null, [value, refs]);
		});
		return result;
	}
	const result = Object.create(Object.getPrototypeOf(source));
	refs.set(source, result);
	for (const key of Reflect.ownKeys(source)) {
		const descriptor = { ...Reflect.getOwnPropertyDescriptor(source, key) };
		if ("value" in descriptor) descriptor.value = Reflect.apply(clone, null, [descriptor.value, refs]);
		Reflect.defineProperty(result, key, descriptor);
	}
	return result;
}
/** Deeply compare arrays, dates, regexps, buffers, and plain object fields. */
function deepEqual(a, b, strict) {
	if (a === b) return true;
	if (!strict && isNullable(a) && isNullable(b)) return true;
	if (typeof a !== typeof b) return false;
	if (typeof a !== "object") return false;
	if (!a || !b) return false;
	function check(test, then) {
		return test(a) ? test(b) ? then(a, b) : false : test(b) ? false : void 0;
	}
	return check(Array.isArray, (a, b) => a.length === b.length && a.every((item, index) => deepEqual(item, b[index]))) ?? check(is("Date"), (a, b) => a.valueOf() === b.valueOf()) ?? check(is("RegExp"), (a, b) => a.source === b.source && a.flags === b.flags) ?? check(isArrayBufferLike, (a, b) => {
		if (a.byteLength !== b.byteLength) return false;
		const viewA = new Uint8Array(a);
		const viewB = new Uint8Array(b);
		for (let i = 0; i < viewA.length; i++) if (viewA[i] !== viewB[i]) return false;
		return true;
	}) ?? Object.keys({
		...a,
		...b
	}).every((key) => deepEqual(a[key], b[key], strict));
}
//#endregion
//#region ../../../vendor/cosmokit/src/time.ts
let Time;
(function(_Time) {
	_Time.millisecond = 1;
	const second = _Time.second = 1e3;
	const minute = _Time.minute = second * 60;
	const hour = _Time.hour = minute * 60;
	const day = _Time.day = hour * 24;
	const week = _Time.week = day * 7;
	let timezoneOffset = (/* @__PURE__ */ new Date()).getTimezoneOffset();
	function setTimezoneOffset(offset) {
		timezoneOffset = offset;
	}
	_Time.setTimezoneOffset = setTimezoneOffset;
	function getTimezoneOffset() {
		return timezoneOffset;
	}
	_Time.getTimezoneOffset = getTimezoneOffset;
	function getDateNumber(date = /* @__PURE__ */ new Date(), offset) {
		if (typeof date === "number") date = new Date(date);
		if (offset === void 0) offset = timezoneOffset;
		return Math.floor((date.valueOf() / minute - offset) / 1440);
	}
	_Time.getDateNumber = getDateNumber;
	function fromDateNumber(value, offset) {
		const date = new Date(value * day);
		if (offset === void 0) offset = timezoneOffset;
		return new Date(+date + offset * minute);
	}
	_Time.fromDateNumber = fromDateNumber;
	const numeric = /\d+(?:\.\d+)?/.source;
	const timeRegExp = new RegExp(`^${[
		"w(?:eek(?:s)?)?",
		"d(?:ay(?:s)?)?",
		"h(?:our(?:s)?)?",
		"m(?:in(?:ute)?(?:s)?)?",
		"s(?:ec(?:ond)?(?:s)?)?"
	].map((unit) => `(${numeric}${unit})?`).join("")}$`);
	function parseTime(source) {
		const capture = timeRegExp.exec(source);
		if (!capture) return 0;
		return (parseFloat(capture[1]) * week || 0) + (parseFloat(capture[2]) * day || 0) + (parseFloat(capture[3]) * hour || 0) + (parseFloat(capture[4]) * minute || 0) + (parseFloat(capture[5]) * second || 0);
	}
	_Time.parseTime = parseTime;
	function parseDate(date) {
		const parsed = parseTime(date);
		if (parsed) date = Date.now() + parsed;
		else if (/^\d{1,2}(:\d{1,2}){1,2}$/.test(date)) date = `${(/* @__PURE__ */ new Date()).toLocaleDateString()}-${date}`;
		else if (/^\d{1,2}-\d{1,2}-\d{1,2}(:\d{1,2}){1,2}$/.test(date)) date = `${(/* @__PURE__ */ new Date()).getFullYear()}-${date}`;
		return date ? new Date(date) : /* @__PURE__ */ new Date();
	}
	_Time.parseDate = parseDate;
	function format(ms) {
		const abs = Math.abs(ms);
		if (abs >= day - hour / 2) return Math.round(ms / day) + "d";
		else if (abs >= hour - minute / 2) return Math.round(ms / hour) + "h";
		else if (abs >= minute - second / 2) return Math.round(ms / minute) + "m";
		else if (abs >= second) return Math.round(ms / second) + "s";
		return ms + "ms";
	}
	_Time.format = format;
	function toDigits(source, length = 2) {
		return source.toString().padStart(length, "0");
	}
	_Time.toDigits = toDigits;
	function template(template, time = /* @__PURE__ */ new Date()) {
		return template.replace("yyyy", time.getFullYear().toString()).replace("yy", time.getFullYear().toString().slice(2)).replace("MM", toDigits(time.getMonth() + 1)).replace("dd", toDigits(time.getDate())).replace("hh", toDigits(time.getHours())).replace("mm", toDigits(time.getMinutes())).replace("ss", toDigits(time.getSeconds())).replace("SSS", toDigits(time.getMilliseconds(), 3));
	}
	_Time.template = template;
})(Time || (Time = {}));
//#endregion
//#region ../../../vendor/schemastery/src/index.ts
const kSchema = Symbol.for("schemastery");
const kValidationError = Symbol.for("ValidationError");
globalThis.__schemastery_index__ ??= 0;
globalThis.__schemastery_refs__ = void 0;
var ValidationError = class extends TypeError {
	options;
	name = "ValidationError";
	constructor(message, options) {
		let prefix = "$";
		for (const segment of options.path || []) if (typeof segment === "string") prefix += "." + segment;
		else if (typeof segment === "number") prefix += "[" + segment + "]";
		else if (typeof segment === "symbol") prefix += `[Symbol(${segment.toString()})]`;
		if (prefix.startsWith(".")) prefix = prefix.slice(1);
		super((prefix === "$" ? "" : `${prefix} `) + message);
		this.options = options;
	}
	static is(error) {
		return !!error?.[kValidationError];
	}
};
Object.defineProperty(ValidationError.prototype, kValidationError, { value: true });
const Schema = function(options) {
	const schema = function(data, options = {}) {
		return Schema.resolve(data, schema, options)[0];
	};
	if (options.refs) {
		const refs = mapValues(options.refs, (options) => new Schema(options));
		const getRef = (uid) => refs[uid];
		for (const key in refs) {
			const options = refs[key];
			options.sKey = getRef(options.sKey);
			options.inner = getRef(options.inner);
			options.list = options.list && options.list.map(getRef);
			options.dict = options.dict && mapValues(options.dict, getRef);
		}
		return refs[options.uid];
	}
	Object.assign(schema, options);
	if (typeof schema.callback === "string") try {
		schema.callback = new Function("return " + schema.callback)();
	} catch {}
	Object.defineProperty(schema, "uid", { value: globalThis.__schemastery_index__++ });
	Object.setPrototypeOf(schema, Schema.prototype);
	schema.meta ||= {};
	schema.toString = schema.toString.bind(schema);
	return schema;
};
Schema.prototype = Object.create(Function.prototype);
Schema.prototype[kSchema] = true;
Object.defineProperty(Schema.prototype, "~standard", { get() {
	return {
		version: 1,
		vendor: "schemastery",
		validate: (value) => {
			try {
				return { value: Schema.resolve(value, this, {})[0] };
			} catch (error) {
				if (ValidationError.is(error)) return { issues: [{
					message: error.message,
					path: error.options.path
				}] };
				throw error;
			}
		}
	};
} });
Schema.ValidationError = ValidationError;
Schema.prototype.toJSON = function toJSON() {
	if (globalThis.__schemastery_refs__) {
		globalThis.__schemastery_refs__[this.uid] ??= JSON.parse(JSON.stringify({ ...this }));
		return this.uid;
	}
	globalThis.__schemastery_refs__ = { [this.uid]: { ...this } };
	globalThis.__schemastery_refs__[this.uid] = JSON.parse(JSON.stringify({ ...this }));
	const result = {
		uid: this.uid,
		refs: globalThis.__schemastery_refs__
	};
	globalThis.__schemastery_refs__ = void 0;
	return result;
};
Schema.prototype.set = function set(key, value) {
	this.dict[key] = value;
	return this;
};
Schema.prototype.push = function push(value) {
	this.list.push(value);
	return this;
};
function mergeDesc(original, messages) {
	const result = typeof original === "string" ? { "": original } : { ...original };
	for (const locale in messages) {
		const value = messages[locale];
		if (value?.$description || value?.$desc) result[locale] = value.$description || value.$desc;
		else if (typeof value === "string") result[locale] = value;
	}
	return result;
}
function getInner(value) {
	return value?.$value ?? value?.$inner;
}
function extractKeys(data) {
	return filterKeys(data ?? {}, (key) => !key.startsWith("$"));
}
Schema.prototype.i18n = function i18n(messages) {
	const schema = Schema(this);
	const desc = mergeDesc(schema.meta.description, messages);
	if (Object.keys(desc).length) schema.meta.description = desc;
	if (schema.dict) schema.dict = mapValues(schema.dict, (inner, key) => {
		return inner.i18n(mapValues(messages, (data) => getInner(data)?.[key] ?? data?.[key]));
	});
	if (schema.list) schema.list = schema.list.map((inner, index) => {
		return inner.i18n(mapValues(messages, (data = {}) => {
			if (Array.isArray(getInner(data))) return getInner(data)[index];
			if (Array.isArray(data)) return data[index];
			return extractKeys(data);
		}));
	});
	if (schema.inner) schema.inner = schema.inner.i18n(mapValues(messages, (data) => {
		if (getInner(data)) return getInner(data);
		return extractKeys(data);
	}));
	if (schema.sKey) schema.sKey = schema.sKey.i18n(mapValues(messages, (data) => data?.$key));
	return schema;
};
Schema.prototype.extra = function extra(key, value) {
	const schema = Schema(this);
	schema.meta = {
		...schema.meta,
		[key]: value
	};
	return schema;
};
for (const key of [
	"required",
	"disabled",
	"collapse",
	"hidden",
	"loose"
]) Object.assign(Schema.prototype, { [key](value = true) {
	const schema = Schema(this);
	schema.meta = {
		...schema.meta,
		[key]: value
	};
	return schema;
} });
Schema.prototype.deprecated = function deprecated() {
	const schema = Schema(this);
	schema.meta.badges ||= [];
	schema.meta.badges.push({
		text: "deprecated",
		type: "danger"
	});
	return schema;
};
Schema.prototype.experimental = function experimental() {
	const schema = Schema(this);
	schema.meta.badges ||= [];
	schema.meta.badges.push({
		text: "experimental",
		type: "warning"
	});
	return schema;
};
Schema.prototype.pattern = function pattern(regexp) {
	const schema = Schema(this);
	const pattern = pick(regexp, ["source", "flags"]);
	schema.meta = {
		...schema.meta,
		pattern
	};
	return schema;
};
Schema.prototype.simplify = function simplify(value) {
	if (deepEqual(value, this.meta.default, this.type === "dict")) return null;
	if (isNullable(value)) return value;
	if (this.type === "object" || this.type === "dict") {
		const result = {};
		for (const key in value) {
			const item = (this.type === "object" ? this.dict[key] : this.inner)?.simplify(value[key]);
			if (this.type === "dict" || !isNullable(item)) result[key] = item;
		}
		if (deepEqual(result, this.meta.default, this.type === "dict")) return null;
		return result;
	} else if (this.type === "array" || this.type === "tuple") {
		const result = [];
		value.forEach((value, index) => {
			const schema = this.type === "array" ? this.inner : this.list[index];
			const item = schema ? schema.simplify(value) : value;
			result.push(item);
		});
		return result;
	} else if (this.type === "intersect") {
		const result = {};
		for (const item of this.list) Object.assign(result, item.simplify(value));
		return result;
	} else if (this.type === "union") for (const schema of this.list) try {
		Schema.resolve(value, schema, {});
		return schema.simplify(value);
	} catch {}
	return value;
};
Schema.prototype.toString = function toString(inline) {
	return formatters[this.type]?.(this, inline) ?? `Schema<${this.type}>`;
};
Schema.prototype.role = function role(role, extra) {
	const schema = Schema(this);
	schema.meta = {
		...schema.meta,
		role,
		extra
	};
	return schema;
};
for (const key of [
	"default",
	"link",
	"comment",
	"description",
	"max",
	"min",
	"step"
]) Object.assign(Schema.prototype, { [key](value) {
	const schema = Schema(this);
	schema.meta = {
		...schema.meta,
		[key]: value
	};
	return schema;
} });
const resolvers = {};
Schema.extend = function extend(type, resolve) {
	resolvers[type] = resolve;
};
Schema.resolve = function resolve(data, schema, options = {}, strict = false) {
	if (!schema) return [data];
	if (options.ignore?.(data, schema)) return [data];
	if (isNullable(data) && schema.type !== "lazy") {
		if (schema.meta.required) throw new ValidationError(`missing required value`, options);
		let current = schema;
		let fallback = schema.meta.default;
		while (current?.type === "intersect" && isNullable(fallback)) {
			current = current.list[0];
			fallback = current?.meta.default;
		}
		if (isNullable(fallback)) return [data];
		data = clone(fallback);
	}
	const callback = resolvers[schema.type];
	if (!callback) throw new ValidationError(`unsupported type "${schema.type}"`, options);
	try {
		return callback(data, schema, options, strict);
	} catch (error) {
		if (!schema.meta.loose) throw error;
		return [schema.meta.default];
	}
};
Schema.from = function from(source) {
	if (isNullable(source)) return Schema.any();
	else if ([
		"string",
		"number",
		"boolean"
	].includes(typeof source)) return Schema.const(source).required();
	else if (source[kSchema]) return source;
	else if (typeof source === "function") switch (source) {
		case String: return Schema.string().required();
		case Number: return Schema.number().required();
		case Boolean: return Schema.boolean().required();
		case Function: return Schema.function().required();
		default: return Schema.is(source).required();
	}
	else throw new TypeError(`cannot infer schema from ${source}`);
};
Schema.lazy = function lazy(builder) {
	const toJSON = () => {
		if (!schema.inner[kSchema]) {
			schema.inner = schema.builder();
			schema.inner.meta = {
				...schema.meta,
				...schema.inner.meta
			};
		}
		return schema.inner.toJSON();
	};
	const schema = new Schema({
		type: "lazy",
		builder,
		inner: { toJSON }
	});
	return schema;
};
Schema.natural = function natural() {
	return Schema.number().step(1).min(0);
};
Schema.percent = function percent() {
	return Schema.number().step(.01).min(0).max(1).role("slider");
};
Schema.date = function date() {
	return Schema.union([Schema.is(Date), Schema.transform(Schema.string().role("datetime"), (value, options) => {
		const date = new Date(value);
		if (isNaN(+date)) throw new ValidationError(`invalid date "${value}"`, options);
		return date;
	}, true)]);
};
Schema.regExp = function regExp(flag = "") {
	return Schema.union([Schema.is(RegExp), Schema.transform(Schema.string().role("regexp", { flag }), (value, options) => {
		try {
			return new RegExp(value, flag);
		} catch (e) {
			throw new ValidationError(e.message, options);
		}
	}, true)]);
};
Schema.arrayBuffer = function arrayBuffer(encoding) {
	return Schema.union([
		Schema.is(ArrayBuffer),
		Schema.is(SharedArrayBuffer),
		Schema.transform(Schema.any(), (value, options) => {
			if (Binary.isSource(value)) return Binary.fromSource(value);
			throw new ValidationError(`expected ArrayBufferSource but got ${value}`, options);
		}, true),
		...encoding ? [Schema.transform(Schema.string(), (value, options) => {
			try {
				return encoding === "base64" ? Binary.fromBase64(value) : Binary.fromHex(value);
			} catch (e) {
				throw new ValidationError(e.message, options);
			}
		}, true)] : []
	]);
};
Schema.extend("lazy", (data, schema, options, strict) => {
	if (!schema.inner[kSchema]) {
		schema.inner = schema.builder();
		schema.inner.meta = {
			...schema.meta,
			...schema.inner.meta
		};
	}
	return Schema.resolve(data, schema.inner, options, strict);
});
Schema.extend("any", (data) => {
	return [data];
});
Schema.extend("never", (data, _, options) => {
	throw new ValidationError(`expected nullable but got ${data}`, options);
});
Schema.extend("const", (data, { value }, options) => {
	if (deepEqual(data, value)) return [value];
	throw new ValidationError(`expected ${value} but got ${data}`, options);
});
function checkWithinRange(data, meta, description, options, skipMin = false) {
	const { max = Infinity, min = -Infinity } = meta;
	if (data > max) throw new ValidationError(`expected ${description} <= ${max} but got ${data}`, options);
	if (data < min && !skipMin) throw new ValidationError(`expected ${description} >= ${min} but got ${data}`, options);
}
Schema.extend("string", (data, { meta }, options) => {
	if (typeof data !== "string") throw new ValidationError(`expected string but got ${data}`, options);
	if (meta.pattern) {
		const regexp = new RegExp(meta.pattern.source, meta.pattern.flags);
		if (!regexp.test(data)) throw new ValidationError(`expect string to match regexp ${regexp}`, options);
	}
	checkWithinRange(data.length, meta, "string length", options);
	return [data];
});
function decimalShift(data, digits) {
	const str = data.toString();
	if (str.includes("e")) return data * Math.pow(10, digits);
	const index = str.indexOf(".");
	if (index === -1) return data * Math.pow(10, digits);
	const frac = str.slice(index + 1);
	const integer = str.slice(0, index);
	if (frac.length <= digits) return +(integer + frac.padEnd(digits, "0"));
	return +(integer + frac.slice(0, digits) + "." + frac.slice(digits));
}
function isMultipleOf(data, min, step) {
	step = Math.abs(step);
	if (!/^\d+\.\d+$/.test(step.toString())) return (data - min) % step === 0;
	const index = step.toString().indexOf(".");
	const digits = step.toString().slice(index + 1).length;
	return Math.abs(decimalShift(data, digits) - decimalShift(min, digits)) % decimalShift(step, digits) === 0;
}
Schema.extend("number", (data, { meta }, options) => {
	if (typeof data !== "number") throw new ValidationError(`expected number but got ${data}`, options);
	checkWithinRange(data, meta, "number", options);
	const { step } = meta;
	if (step && !isMultipleOf(data, meta.min ?? 0, step)) throw new ValidationError(`expected number multiple of ${step} but got ${data}`, options);
	return [data];
});
Schema.extend("boolean", (data, _, options) => {
	if (typeof data === "boolean") return [data];
	throw new ValidationError(`expected boolean but got ${data}`, options);
});
Schema.extend("bitset", (data, { bits, meta }, options) => {
	let value = 0, keys = [];
	if (typeof data === "number") {
		value = data;
		for (const key in bits) if (data & bits[key]) keys.push(key);
	} else if (Array.isArray(data)) {
		keys = data;
		for (const key of keys) {
			if (typeof key !== "string") throw new ValidationError(`expected string but got ${key}`, options);
			if (key in bits) value |= bits[key];
		}
	} else throw new ValidationError(`expected number or array but got ${data}`, options);
	if (value === meta.default) return [value];
	return [value, keys];
});
Schema.extend("function", (data, _, options) => {
	if (typeof data === "function") return [data];
	throw new ValidationError(`expected function but got ${data}`, options);
});
Schema.extend("is", (data, { constructor }, options) => {
	if (typeof constructor === "function") {
		if (data instanceof constructor) return [data];
		throw new ValidationError(`expected ${constructor.name} but got ${data}`, options);
	} else {
		if (isNullable(data)) throw new ValidationError(`expected ${constructor} but got ${data}`, options);
		let prototype = Object.getPrototypeOf(data);
		while (prototype) {
			if (prototype.constructor?.name === constructor) return [data];
			prototype = Object.getPrototypeOf(prototype);
		}
		throw new ValidationError(`expected ${constructor} but got ${data}`, options);
	}
});
function property(data, key, schema, options) {
	try {
		const [value, adapted] = Schema.resolve(data[key], schema, {
			...options,
			path: [...options.path || [], key]
		});
		if (adapted !== void 0) data[key] = adapted;
		return value;
	} catch (e) {
		if (!options?.autofix) throw e;
		delete data[key];
		return schema.meta.default;
	}
}
Schema.extend("array", (data, { inner, meta }, options) => {
	if (!Array.isArray(data)) throw new ValidationError(`expected array but got ${data}`, options);
	checkWithinRange(data.length, meta, "array length", options, !isNullable(inner.meta.default));
	return [data.map((_, index) => property(data, index, inner, options))];
});
Schema.extend("dict", (data, { inner, sKey }, options, strict) => {
	if (!isPlainObject(data)) throw new ValidationError(`expected object but got ${data}`, options);
	const result = {};
	for (const key in data) {
		let rKey;
		try {
			rKey = Schema.resolve(key, sKey, options)[0];
		} catch (error) {
			if (strict) continue;
			throw error;
		}
		result[rKey] = property(data, key, inner, options);
		data[rKey] = data[key];
		if (key !== rKey) delete data[key];
	}
	return [result];
});
Schema.extend("tuple", (data, { list }, options, strict) => {
	if (!Array.isArray(data)) throw new ValidationError(`expected array but got ${data}`, options);
	const result = list.map((inner, index) => property(data, index, inner, options));
	if (strict) return [result];
	result.push(...data.slice(list.length));
	return [result];
});
function merge(result, data) {
	for (const key in data) {
		if (key in result) continue;
		result[key] = data[key];
	}
}
Schema.extend("object", (data, { dict }, options, strict) => {
	if (!isPlainObject(data)) throw new ValidationError(`expected object but got ${data}`, options);
	const result = {};
	for (const key in dict) {
		const value = property(data, key, dict[key], options);
		if (!isNullable(value) || key in data) result[key] = value;
	}
	if (!strict) merge(result, data);
	return [result];
});
Schema.extend("union", (data, { list, toString }, options, strict) => {
	const messages = [];
	for (const inner of list) try {
		return Schema.resolve(data, inner, options, strict);
	} catch (error) {
		messages.push(error);
	}
	throw new ValidationError(`expected ${toString()} but got ${JSON.stringify(data)}`, options);
});
Schema.extend("intersect", (data, { list, toString }, options, strict) => {
	if (!list.length) return [data];
	let result;
	for (const inner of list) {
		const value = Schema.resolve(data, inner, options, true)[0];
		if (isNullable(value)) continue;
		if (isNullable(result)) result = value;
		else if (typeof result !== typeof value) throw new ValidationError(`expected ${toString()} but got ${JSON.stringify(data)}`, options);
		else if (typeof value === "object") merge(result ??= {}, value);
		else if (result !== value) throw new ValidationError(`expected ${toString()} but got ${JSON.stringify(data)}`, options);
	}
	if (!strict && isPlainObject(data)) merge(result, data);
	return [result];
});
Schema.extend("transform", (data, { inner, callback, preserve }, options) => {
	const [result, adapted = data] = Schema.resolve(data, inner, options, true);
	if (preserve) return [callback(result)];
	else return [callback(result), callback(adapted)];
});
const formatters = {};
function defineMethod(name, keys, format) {
	formatters[name] = format;
	Object.assign(Schema, { [name](...args) {
		const schema = new Schema({ type: name });
		keys.forEach((key, index) => {
			switch (key) {
				case "sKey":
					schema.sKey = args[index] ?? Schema.string();
					break;
				case "inner":
					schema.inner = Schema.from(args[index]);
					break;
				case "list":
					schema.list = args[index].map(Schema.from);
					break;
				case "dict":
					schema.dict = mapValues(args[index], Schema.from);
					break;
				case "bits":
					schema.bits = {};
					for (const key in args[index]) {
						if (typeof args[index][key] !== "number") continue;
						schema.bits[key] = args[index][key];
					}
					break;
				case "callback": {
					const callback = schema.callback = args[index];
					callback["toJSON"] ||= () => callback.toString();
					break;
				}
				case "constructor": {
					const constructor = schema.constructor = args[index];
					if (typeof constructor === "function") constructor["toJSON"] ||= () => constructor["name"];
					break;
				}
				default: schema[key] = args[index];
			}
		});
		if (name === "object" || name === "dict") schema.meta.default = {};
		else if (name === "array" || name === "tuple") schema.meta.default = [];
		else if (name === "bitset") schema.meta.default = 0;
		return schema;
	} });
}
defineMethod("is", ["constructor"], ({ constructor }) => {
	if (typeof constructor === "function") return constructor.name;
	else return constructor;
});
defineMethod("any", [], () => "any");
defineMethod("never", [], () => "never");
defineMethod("const", ["value"], ({ value }) => typeof value === "string" ? JSON.stringify(value) : value);
defineMethod("string", [], () => "string");
defineMethod("number", [], () => "number");
defineMethod("boolean", [], () => "boolean");
defineMethod("bitset", ["bits"], () => "bitset");
defineMethod("function", [], () => "function");
defineMethod("array", ["inner"], ({ inner }) => `${inner.toString(true)}[]`);
defineMethod("dict", ["inner", "sKey"], ({ inner, sKey }) => `{ [key: ${sKey.toString()}]: ${inner.toString()} }`);
defineMethod("tuple", ["list"], ({ list }) => `[${list.map((inner) => inner.toString()).join(", ")}]`);
defineMethod("object", ["dict"], ({ dict }) => {
	if (Object.keys(dict).length === 0) return "{}";
	return `{ ${Object.entries(dict).map(([key, inner]) => {
		return `${key}${inner.meta.required ? "" : "?"}: ${inner.toString()}`;
	}).join(", ")} }`;
});
defineMethod("union", ["list"], ({ list }, inline) => {
	const result = list.map(({ toString: format }) => format()).join(" | ");
	return inline ? `(${result})` : result;
});
defineMethod("intersect", ["list"], ({ list }) => {
	return `${list.map((inner) => inner.toString(true)).join(" & ")}`;
});
defineMethod("transform", [
	"inner",
	"callback",
	"preserve"
], ({ inner }, isInner) => inner.toString(isInner));
//#endregion
//#region ../../util/timeout/src/index.ts
/** Largest delay Node schedules without clamping it to one millisecond. */
const MAX_TIMER_DELAY_MS = 2147483647;
//#endregion
//#region ../../llm/llm/src/error.ts
/**
* Harness error base with a stable machine-routable code and chained cause.
* Package errors extend it so tool results and replay can retain failure class.
* @module @deepseek-ai/dsh-llm/error
*/
/**
* Base class for all harness errors. Carries a `code` (stable, programmatic —
* e.g. `NO_ADAPTER`, `INVALID_ARGS`, `INVARIANT`) distinct from the
* human-readable `message`, and supports `cause` chaining via the standard
* `ErrorOptions`. `name` defaults to the subclass constructor name.
*/
var HarnessError = class extends Error {
	/** Stable machine-routable failure class (e.g. `RATE_LIMIT`); route on this, never by parsing `message`. */
	code;
	constructor(message, code, options) {
		super(message, options);
		this.code = code;
		this.name = new.target.name;
	}
};
/**
* Canonical provider-neutral code for a response that completed normally but
* carried no content blocks at all. Providers occasionally emit a degenerate
* completion (a terminal stop with zero output); adapters classify it as this
* failure instead of yielding an empty assistant message, because an empty
* message silently ends the turn with nothing for the user or the loop to act
* on. The attempt produced nothing durable, so retry policy treats it as safe
* to repeat.
*/
const EMPTY_RESPONSE_CODE = "EMPTY_RESPONSE";
new RegExp(String.raw`(?:^|[^a-z0-9])context[\s_-](?:length|window)[\s_-]` + String.raw`(?:exceed(?:ed|s)?|overflow(?:ed)?|limit[\s_-]exceeded)(?:$|[^a-z0-9])`, "i");
new RegExp(String.raw`\b(?:request|prompt|input|messages?)\s+(?:is\s+|are\s+)?` + String.raw`too\s+(?:large|long)\s+for\s+(?:(?:this|the)\s+)?` + String.raw`(?:model(?:'s)?\s+)?context(?:\s+window)?\b`, "i");
new RegExp(String.raw`\b(?:input|prompt|request|messages?)\b.{0,40}` + String.raw`\b(?:exceed(?:s|ed)?|overflows?|is\s+larger\s+than)\b.{0,40}` + String.raw`\b(?:the\s+)?(?:model(?:'s)?\s+)?context(?:\s+(?:length|window))?\b`, "i");
//#endregion
//#region ../../llm/llm/src/retry-policy.ts
/**
* Provider-owned request-retry policy configuration and resolution.
*
* Adapters expose one resolved policy per registered provider route; the
* optional dsh-llm-retry plugin executes it on the agent's failed-step extension point.
*
* @module @deepseek-ai/dsh-llm/retry-policy
*/
const DEFAULT_MAX_RETRIES = 5;
const DEFAULT_INITIAL_DELAY_MS = 500;
const DEFAULT_MAX_DELAY_MS = 1e4;
const DEFAULT_JITTER_RATIO = .1;
const DEFAULT_RETRYABLE_CODES = Object.freeze([
	EMPTY_RESPONSE_CODE,
	"RATE_LIMIT",
	"SERVER",
	"TIMEOUT",
	"TRANSPORT"
]);
const backoffSchema = Schema.object({
	initialDelayMs: Schema.number().max(MAX_TIMER_DELAY_MS).default(DEFAULT_INITIAL_DELAY_MS),
	maxDelayMs: Schema.number().max(MAX_TIMER_DELAY_MS).default(DEFAULT_MAX_DELAY_MS),
	jitterRatio: Schema.number().min(0).max(1).default(DEFAULT_JITTER_RATIO)
});
const normalPolicySchema = Schema.object({
	mode: Schema.const("normal").required(),
	maxRetries: Schema.number().step(1).min(0).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_MAX_RETRIES),
	retryableCodes: Schema.array(Schema.string()).default([...DEFAULT_RETRYABLE_CODES]),
	backoff: backoffSchema
});
const alwaysPolicySchema = Schema.object({
	mode: Schema.const("always").required(),
	backoff: backoffSchema
});
Schema.union([normalPolicySchema, alwaysPolicySchema]);
const NORMAL_POLICY_KEYS = new Set([
	"mode",
	"maxRetries",
	"retryableCodes",
	"backoff"
]);
const ALWAYS_POLICY_KEYS = new Set([
	"mode",
	"maxRetries",
	"retryableCodes",
	"backoff"
]);
const BACKOFF_KEYS = new Set([
	"initialDelayMs",
	"maxDelayMs",
	"jitterRatio"
]);
function validateKeys(value, allowed, path) {
	for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`${path}: unknown key "${key}"`);
}
function resolveBackoff(config, path) {
	if (config !== void 0) validateKeys(config, BACKOFF_KEYS, path);
	const initialDelayMs = config?.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS;
	const maxDelayMs = config?.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
	const jitterRatio = config?.jitterRatio ?? DEFAULT_JITTER_RATIO;
	if (!Number.isFinite(initialDelayMs) || initialDelayMs <= 0 || initialDelayMs > 2147483647) throw new Error(`${path}.initialDelayMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`);
	if (!Number.isFinite(maxDelayMs) || maxDelayMs <= 0 || maxDelayMs > 2147483647) throw new Error(`${path}.maxDelayMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`);
	if (initialDelayMs > maxDelayMs) throw new Error(`${path}.initialDelayMs must be less than or equal to maxDelayMs`);
	if (!Number.isFinite(jitterRatio) || jitterRatio < 0 || jitterRatio > 1) throw new Error(`${path}.jitterRatio must be between 0 and 1`);
	return Object.freeze({
		initialDelayMs,
		maxDelayMs,
		jitterRatio
	});
}
/**
* Validate, default, and detach one provider-owned retry policy.
* @param config - optional provider configuration; omission selects normal defaults.
* @param path - diagnostic path naming the provider config that owns the value.
* @returns an immutable policy safe to capture in provider registration state.
*/
function resolveRetryPolicy(config, path) {
	if (config === void 0) return Object.freeze({
		mode: "normal",
		maxRetries: DEFAULT_MAX_RETRIES,
		retryableCodes: DEFAULT_RETRYABLE_CODES,
		...resolveBackoff(void 0, `${path}.backoff`)
	});
	switch (config.mode) {
		case "normal": {
			validateKeys(config, NORMAL_POLICY_KEYS, path);
			const maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES;
			const retryableCodes = config.retryableCodes ?? [...DEFAULT_RETRYABLE_CODES];
			if (!Number.isSafeInteger(maxRetries) || maxRetries < 0) throw new Error(`${path}.maxRetries must be a non-negative safe integer`);
			if (retryableCodes.length === 0) throw new Error(`${path}.retryableCodes must not be empty`);
			if (retryableCodes.some((code) => typeof code !== "string" || code.length === 0)) throw new Error(`${path}.retryableCodes must contain only non-empty strings`);
			if (new Set(retryableCodes).size !== retryableCodes.length) throw new Error(`${path}.retryableCodes must not contain duplicates`);
			return Object.freeze({
				mode: "normal",
				maxRetries,
				retryableCodes: Object.freeze([...retryableCodes]),
				...resolveBackoff(config.backoff, `${path}.backoff`)
			});
		}
		case "always":
			validateKeys(config, ALWAYS_POLICY_KEYS, path);
			return Object.freeze({
				mode: "always",
				...resolveBackoff(config.backoff, `${path}.backoff`)
			});
		default: throw new Error(`${path}.mode must be "normal" or "always"`);
	}
}
//#endregion
//#region ../../llm/llm/src/call-config.ts
/**
* Field-wise equality over {@link LlmCallConfig} — the comparison a caller
* runs to decide whether a proposed configuration is a real change (worth a
* logged header snapshot) or the held one restated.
* @param a - one configuration.
* @param b - the other.
* @returns whether every field (including the `stop` list, element-wise) matches.
*/
function callConfigEquals(a, b) {
	if (a.provider !== b.provider || a.model !== b.model || a.reasoningEffort !== b.reasoningEffort || a.temperature !== b.temperature || a.maxTokens !== b.maxTokens) return false;
	if (a.stop === void 0 || b.stop === void 0) return a.stop === b.stop;
	return a.stop.length === b.stop.length && a.stop.every((s, i) => s === b.stop?.[i]);
}
//#endregion
//#region ../../llm/llm/src/adapter-failure.ts
/**
* Normalization for values thrown by a final LLM adapter boundary.
*
* @module @deepseek-ai/dsh-llm/adapter-failure
*/
/**
* Detach serializable provider facts from a value thrown by an adapter.
* @param value - arbitrary value thrown during adapter dispatch or iteration.
* @returns immutable provider-neutral facts suitable for a terminal finish chunk.
* @internal
*/
function normalizeLlmFailure(value) {
	const error = value instanceof Error ? value : new HarnessError(thrownMessage(value), "UNKNOWN", { cause: value });
	const carried = ownFailureSnapshot(error);
	if (carried !== void 0 && carried.code === ownErrorCode(error)) return carried;
	return Object.freeze({
		message: errorMessage(error),
		code: harnessErrorCode(error)
	});
}
/** Render a non-Error throw without letting hostile coercion escape normalization. */
function thrownMessage(value) {
	try {
		const message = String(value);
		return message.length > 0 ? message : "LLM adapter failed";
	} catch (_hostileThrownValue) {
		return "LLM adapter failed";
	}
}
/** Read a foreign error's own data-backed `code` without invoking accessors. */
function ownErrorCode(error) {
	try {
		const descriptor = Object.getOwnPropertyDescriptor(error, "code");
		return descriptor !== void 0 && "value" in descriptor ? descriptor.value : void 0;
	} catch (_sdkPropertyTrap) {
		return;
	}
}
/** Snapshot an own data property without invoking an SDK-defined accessor. */
function ownFailureSnapshot(error) {
	try {
		const descriptor = Object.getOwnPropertyDescriptor(error, "failure");
		return descriptor !== void 0 && "value" in descriptor ? failureSnapshot(descriptor.value) : void 0;
	} catch (_sdkPropertyTrap) {
		return;
	}
}
/** Validate and detach an arbitrary serializable failure payload. */
function failureSnapshot(value) {
	if (typeof value !== "object" || value === null) return void 0;
	try {
		const candidate = value;
		const message = candidate.message;
		const code = candidate.code;
		const status = candidate.status;
		const providerRetryAfterMs = candidate.providerRetryAfterMs;
		const requestId = candidate.requestId;
		if (typeof message !== "string" || message.length === 0 || typeof code !== "string" || code.length === 0 || status !== void 0 && (!Number.isInteger(status) || status < 100 || status > 599) || providerRetryAfterMs !== void 0 && (!Number.isFinite(providerRetryAfterMs) || providerRetryAfterMs <= 0) || requestId !== void 0 && (typeof requestId !== "string" || requestId.length === 0)) return void 0;
		return Object.freeze({
			message,
			code,
			...status === void 0 ? {} : { status },
			...providerRetryAfterMs === void 0 ? {} : { providerRetryAfterMs },
			...requestId === void 0 ? {} : { requestId }
		});
	} catch (_sdkFailureGetter) {
		return;
	}
}
/** Read an SDK error message without letting an accessor replace the primary failure. */
function errorMessage(error) {
	try {
		const message = error.message;
		if (typeof message === "string" && message.length > 0) return message;
	} catch (_sdkMessageGetter) {}
	return "LLM adapter failed";
}
/** Trust only Harness-owned codes; third-party SDK codes are not our taxonomy. */
function harnessErrorCode(error) {
	return error instanceof HarnessError ? error.code : "UNKNOWN";
}
//#endregion
//#region ../../llm/llm/src/content.ts
function quoted(value) {
	return JSON.stringify(value);
}
/**
* Stable text shown to a model that cannot accept one durable image reference.
* @param ref - durable normalized attachment omitted from the request.
* @returns deterministic text-only placeholder.
*/
function textOnlyImageText(ref) {
	return `[image omitted because this model accepts text only; attachment sha256:${String(ref.attachmentId).slice(7, 15)}]`;
}
/**
* True when typed model content contains an image block, walking nested
* tool-result content. This is the one recursive image walk shared by every
* image policy (capability gating, text-only serialization, compaction
* survey), so a consumer cannot silently diverge on nesting depth.
* @param content - typed model content blocks.
* @returns whether any nested block is an image.
*/
function contentHasImage(content) {
	return content.some((block) => block.type === "image" || block.type === "tool-result" && contentHasImage(block.content));
}
/**
* True when typed model content contains a file block, walking nested
* tool-result content on the same recursion every file policy shares.
* @param content - typed model content blocks.
* @returns whether any nested block is a file.
*/
function contentHasFile(content) {
	return content.some((block) => block.type === "file" || block.type === "tool-result" && contentHasFile(block.content));
}
/**
* Stable model-facing handle for one durable file reference: the address of
* the verbatim stored copy and the instruction to read it on demand. This is
* the only representation a provider ever receives for a file.
* @param ref - durable verbatim file reference.
* @param readonlyPath - execution-world path of the stored copy, when resolvable.
* @returns deterministic handle text naming the file, its size, and its address.
*/
function fileHandleText(ref, readonlyPath) {
	const digest = String(ref.attachmentId).slice(7, 15);
	const identity = `File ${quoted(ref.name)} (${ref.bytes} bytes, sha256:${digest})`;
	if (readonlyPath === void 0) return `[${identity} was uploaded, but the current execution environment cannot access a readable path. Report that limitation if its contents are needed; do not claim to have read it.]`;
	return `[${identity}: verbatim read-only copy saved at ${quoted(readonlyPath)}. Read that path with your file tools when its contents are needed; copy it to a writable location before modifying it. When delegating file work, include this saved path in the delegation prompt; only subagents sharing this execution environment can read it.]`;
}
/** Replace every file occurrence, including nested tool results, with handle text. */
function replaceFilesWithHandles(blocks, resolvePath) {
	let next;
	for (const [index, block] of blocks.entries()) {
		if (block.type === "file") {
			next ??= blocks.slice(0, index);
			next.push({
				type: "text",
				text: fileHandleText(block.attachment, resolvePath(block.attachment))
			});
			continue;
		}
		if (block.type === "tool-result") {
			const content = replaceFilesWithHandles(block.content, resolvePath);
			if (content !== block.content) {
				next ??= blocks.slice(0, index);
				next.push({
					...block,
					content
				});
				continue;
			}
		}
		next?.push(block);
	}
	return next ?? blocks;
}
/**
* Project durable file history into deterministic handle text for every model
* route. Unlike images, no provider receives file blocks natively, so this
* projection is unconditional in request assembly.
* @param messages - complete request history.
* @param resolvePath - resolve one reference's current execution-world read path.
* @returns the original list without files, otherwise shallow message copies with handle text.
*/
function projectFilesToText(messages, resolvePath) {
	if (!messages.some((message) => contentHasFile(message.content))) return messages;
	return messages.map((message) => {
		const content = replaceFilesWithHandles(message.content, resolvePath);
		return content === message.content ? message : {
			...message,
			content
		};
	});
}
/** Replace every image occurrence, including nested tool results, for a text-only model. */
function replaceImagesForTextModel(blocks) {
	let next;
	for (const [index, block] of blocks.entries()) {
		if (block.type === "image") {
			next ??= blocks.slice(0, index);
			next.push({
				type: "text",
				text: textOnlyImageText(block.attachment)
			});
			continue;
		}
		if (block.type === "tool-result") {
			const content = replaceImagesForTextModel(block.content);
			if (content !== block.content) {
				next ??= blocks.slice(0, index);
				next.push({
					...block,
					content
				});
				continue;
			}
		}
		next?.push(block);
	}
	return next ?? blocks;
}
/**
* Project durable image history into deterministic text for an exact text-only model.
* @param messages - complete request history.
* @returns the original list without images, otherwise shallow message copies with stable placeholders.
*/
function projectImagesForTextModel(messages) {
	if (!messages.some((message) => contentHasImage(message.content))) return messages;
	return messages.map((message) => {
		const content = replaceImagesForTextModel(message.content);
		return content === message.content ? message : {
			...message,
			content
		};
	});
}
//#endregion
//#region ../../llm/llm/src/attribution.ts
/**
* Centralize the non-secret product identity every provider request sends as `User-Agent`, keeping
* adapters from drifting. See
* `.agents/notes/implemented/architecture/2026-06-21-mandatory-app-attribution-headers.md`.
*
* App-attribution vocabulary for provider requests.
* @module @deepseek-ai/dsh-llm/attribution
*/
const { version } = createRequire(import.meta.url)("../package.json");
//#endregion
//#region ../../llm/llm/src/assembler.ts
/**
* Incremental chunk-to-message assembler. This is the single canonical assembly
* algorithm used by the agent loop to build an assistant message from a chunk
* stream while logging the raw chunks for replay fidelity.
*
* @module @deepseek-ai/dsh-llm/assembler
*/
/**
* Incrementally assembles raw {@link StreamChunk}s into complete
* {@link ContentBlock}s and a final assistant {@link Message}.
*
* The agent loop feeds it while logging raw chunks for replay fidelity, then
* reads `blocks()` / `message()` / `usage` / `finish` once the stream ends,
* or `interruptedBlocks()` when cancellation cut the stream short.
*
* Tolerant of delta-only protocols (no block-start/end); deltas arriving for
* an index already closed by `block-end` are ignored (malformed stream) so a
* misbehaving adapter cannot grow memory or corrupt a completed block.
*/
var BlockAssembler = class {
	partials = /* @__PURE__ */ new Map();
	order = [];
	_usage;
	_finish;
	_replayState;
	/**
	* Feed one chunk into the assembly state.
	* @param chunk - the next raw chunk, in stream order.
	*/
	push(chunk) {
		switch (chunk.type) {
			case "block-start":
				if (!this.partials.has(chunk.index)) {
					this.order.push(chunk.index);
					this.partials.set(chunk.index, {
						blockType: chunk.blockType,
						text: "",
						toolCallArguments: ""
					});
				}
				return;
			case "text-delta":
			case "reasoning-delta": {
				const partial = this.ensure(chunk.index, chunk.type === "text-delta" ? "text" : "reasoning");
				if (partial.block) return;
				partial.text += chunk.text;
				return;
			}
			case "tool-call-delta": {
				const partial = this.ensure(chunk.index, "tool-call");
				if (partial.block) return;
				partial.toolCallId = chunk.id;
				if (chunk.name) partial.toolCallName = chunk.name;
				partial.toolCallArguments += chunk.argumentsDelta;
				return;
			}
			case "block-end": {
				const partial = this.ensure(chunk.index, chunk.block.type);
				if (partial.block) return;
				partial.block = chunk.block;
				return;
			}
			case "usage":
				this._usage = chunk.usage;
				return;
			case "finish":
				this._finish = chunk.reason;
				this._replayState = chunk.replayState;
				return;
			default: return assertNever(chunk, "BlockAssembler.push");
		}
	}
	ensure(index, blockType) {
		let partial = this.partials.get(index);
		if (!partial) {
			partial = {
				blockType,
				text: "",
				toolCallArguments: ""
			};
			this.partials.set(index, partial);
			this.order.push(index);
		}
		return partial;
	}
	assemble(partial, index) {
		if (partial.block) return partial.block;
		switch (partial.blockType) {
			case "text": return {
				type: "text",
				text: partial.text
			};
			case "reasoning": return {
				type: "reasoning",
				text: partial.text
			};
			case "tool-call": return {
				type: "tool-call",
				id: partial.toolCallId ?? brandString(`call-${index}`),
				name: partial.toolCallName ?? "",
				arguments: partial.toolCallArguments
			};
			default: throw new Error(`cannot assemble incomplete block of type "${partial.blockType}"`);
		}
	}
	/** Invariant accessor: every index in `order` has a partial. */
	mustGet(index) {
		const partial = this.partials.get(index);
		if (!partial) throw new Error(`BlockAssembler invariant violated: no partial for index ${index}`);
		return partial;
	}
	/**
	* The one shared keep/drop decision over all seen blocks: max-token
	* truncation drops tool calls that cannot be executed safely. Emitted blocks
	* and replay metadata both derive from this result, so they cannot disagree.
	*/
	assembled() {
		const all = this.order.map((index) => this.assemble(this.mustGet(index), index));
		const kept = this.finish.kind === "max-tokens" ? all.map((block) => block.type !== "tool-call") : void 0;
		const blocks = kept === void 0 ? all : all.filter((_, position) => kept[position]);
		const envelope = this._replayState;
		if (envelope?.blocks === void 0) return {
			blocks,
			replay: envelope
		};
		if (envelope.blocks.length !== all.length) return {
			blocks,
			replay: void 0
		};
		return {
			blocks,
			replay: kept === void 0 || blocks.length === all.length ? envelope : {
				response: envelope.response,
				blocks: envelope.blocks.filter((_, position) => kept[position])
			}
		};
	}
	/**
	* Assemble all blocks seen so far, in stream order.
	* @returns one block per seen index, except that max-token truncation drops
	*   tool calls that cannot be executed safely; an open block assembles from
	*   its accumulated deltas (an unknown block type never closed by `block-end` throws).
	*/
	blocks() {
		return this.assembled().blocks;
	}
	/**
	* Assemble the prefix an interrupted stream can safely finalize: closed and
	* open text/reasoning blocks with non-whitespace content, in stream order.
	* Tool calls are omitted because interruption precedes dispatch; retaining
	* one would require a fabricated result. Open unknown blocks are also omitted.
	* @returns the kept blocks; empty when nothing streamed before the interruption.
	*/
	interruptedBlocks() {
		return this.order.map((index) => {
			const partial = this.mustGet(index);
			const type = partial.block?.type ?? partial.blockType;
			if (type !== "text" && type !== "reasoning") return void 0;
			return this.assemble(partial, index);
		}).filter((block) => (block?.type === "text" || block?.type === "reasoning") && block.text.trim() !== "");
	}
	/** Usage from the `usage` chunk; undefined until one arrives. */
	get usage() {
		return this._usage;
	}
	/** Finish reason from the `finish` chunk; `{kind: 'stop'}` when the stream ended without one. */
	get finish() {
		return this._finish ?? { kind: "stop" };
	}
	/**
	* Replay metadata from the terminal finish chunk, if any, with per-block
	* entries pruned in step with {@link blocks}. Undefined when the envelope's
	* entries do not align with the emitted blocks.
	*/
	get replayState() {
		return this.assembled().replay;
	}
	/**
	* The assembled assistant message.
	* @param source - producer attribution for the assembled message.
	* @returns a frozen assistant-role message over `blocks()` (same open-block assembly rules).
	*/
	message(source = {
		kind: "plugin",
		plugin: "dsh-llm/assembler"
	}) {
		return createMessage({
			role: "assistant",
			content: this.blocks(),
			source
		});
	}
};
//#endregion
//#region ../../llm/llm/src/index.ts
/**
* LLM service: adapter registry with a waterfall-interceptable streaming call
* API. Exports the `LlmRuntime` default, the abstract `LlmAdapter` for
* provider backends, and `BlockAssembler` for chunk assembly.
*
* @module @deepseek-ai/dsh-llm
*/
var __runInitializers$1 = function(thisArg, initializers, value) {
	var useValue = arguments.length > 2;
	for (var i = 0; i < initializers.length; i++) value = useValue ? initializers[i].call(thisArg, value) : initializers[i].call(thisArg);
	return useValue ? value : void 0;
};
var __esDecorate$1 = function(ctor, descriptorIn, decorators, contextIn, initializers, extraInitializers) {
	function accept(f) {
		if (f !== void 0 && typeof f !== "function") throw new TypeError("Function expected");
		return f;
	}
	var kind = contextIn.kind, key = kind === "getter" ? "get" : kind === "setter" ? "set" : "value";
	var target = !descriptorIn && ctor ? contextIn["static"] ? ctor : ctor.prototype : null;
	var descriptor = descriptorIn || (target ? Object.getOwnPropertyDescriptor(target, contextIn.name) : {});
	var _, done = false;
	for (var i = decorators.length - 1; i >= 0; i--) {
		var context = {};
		for (var p in contextIn) context[p] = p === "access" ? {} : contextIn[p];
		for (var p in contextIn.access) context.access[p] = contextIn.access[p];
		context.addInitializer = function(f) {
			if (done) throw new TypeError("Cannot add initializers after decoration has completed");
			extraInitializers.push(accept(f || null));
		};
		var result = (0, decorators[i])(kind === "accessor" ? {
			get: descriptor.get,
			set: descriptor.set
		} : descriptor[key], context);
		if (kind === "accessor") {
			if (result === void 0) continue;
			if (result === null || typeof result !== "object") throw new TypeError("Object expected");
			if (_ = accept(result.get)) descriptor.get = _;
			if (_ = accept(result.set)) descriptor.set = _;
			if (_ = accept(result.init)) initializers.unshift(_);
		} else if (_ = accept(result)) if (kind === "field") initializers.unshift(_);
		else descriptor[key] = _;
	}
	if (target) Object.defineProperty(target, contextIn.name, descriptor);
	done = true;
};
/**
* Typed error for LLM-related failures. Extends {@link HarnessError}, so the
* `code` string (e.g. `AUTH`, `RATE_LIMIT`, `NO_ADAPTER`) is shared taxonomy.
*/
var LlmError = class extends HarnessError {
	/** Serializable facts retained beside this live Error. */
	failure;
	/**
	* @param message - non-empty human-readable failure summary.
	* @param code - non-empty stable provider-neutral machine code.
	* @param options - optional cause and validated serializable provider facts.
	*/
	constructor(message, code, options) {
		if (typeof message !== "string" || message.length === 0) throw new Error("LlmError message must be a non-empty string");
		if (typeof code !== "string" || code.length === 0) throw new Error("LlmError code must be a non-empty string");
		if (options?.status !== void 0 && (!Number.isInteger(options.status) || options.status < 100 || options.status > 599)) throw new Error("LlmError status must be an integer from 100 through 599");
		if (options?.providerRetryAfterMs !== void 0 && (!Number.isFinite(options.providerRetryAfterMs) || options.providerRetryAfterMs <= 0)) throw new Error("LlmError providerRetryAfterMs must be a positive finite number");
		if (options?.requestId !== void 0 && (typeof options.requestId !== "string" || options.requestId.length === 0)) throw new Error("LlmError requestId must be a non-empty string");
		super(message, code, options);
		this.name = "LlmError";
		this.failure = Object.freeze({
			message,
			code,
			...options?.status === void 0 ? {} : { status: options.status },
			...options?.providerRetryAfterMs === void 0 ? {} : { providerRetryAfterMs: options.providerRetryAfterMs },
			...options?.requestId === void 0 ? {} : { requestId: options.requestId }
		});
	}
};
(() => {
	let _classSuper = TypertRemoteService;
	let _instanceExtraInitializers = [];
	let _listProviders_decorators;
	let _listConfigurableProviders_decorators;
	let _remoteDiscoverModels_decorators;
	return class LlmRuntime extends _classSuper {
		static {
			const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
			_listProviders_decorators = [Remote];
			_listConfigurableProviders_decorators = [Remote];
			_remoteDiscoverModels_decorators = [Remote("discoverModels")];
			__esDecorate$1(this, null, _listProviders_decorators, {
				kind: "method",
				name: "listProviders",
				static: false,
				private: false,
				access: {
					has: (obj) => "listProviders" in obj,
					get: (obj) => obj.listProviders
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate$1(this, null, _listConfigurableProviders_decorators, {
				kind: "method",
				name: "listConfigurableProviders",
				static: false,
				private: false,
				access: {
					has: (obj) => "listConfigurableProviders" in obj,
					get: (obj) => obj.listConfigurableProviders
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate$1(this, null, _remoteDiscoverModels_decorators, {
				kind: "method",
				name: "remoteDiscoverModels",
				static: false,
				private: false,
				access: {
					has: (obj) => "remoteDiscoverModels" in obj,
					get: (obj) => obj.remoteDiscoverModels
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			if (_metadata) Object.defineProperty(this, Symbol.metadata, {
				enumerable: true,
				configurable: true,
				writable: true,
				value: _metadata
			});
		}
		adapters = (__runInitializers$1(this, _instanceExtraInitializers), /* @__PURE__ */ new Map());
		directory = /* @__PURE__ */ new Map();
		discoveries = /* @__PURE__ */ new Map();
		constructor(ctx) {
			super(ctx, "llm");
		}
		/** Notify topology observers without letting one broken listener veto the commit. */
		emitAdaptersUpdated() {
			let invariantFailure;
			for (const listener of this.ctx.events.dispatch("emit", ["llm/adapters-updated"])) try {
				const returned = listener();
				if (returned != null && typeof returned.then === "function") Promise.resolve(returned).then(void 0, (error) => {
					this.warnAdaptersListenerFailure(error);
				});
			} catch (error) {
				if (error?.code === "INVARIANT") {
					invariantFailure ??= error;
					continue;
				}
				this.warnAdaptersListenerFailure(error);
			}
			if (invariantFailure !== void 0) throw invariantFailure;
		}
		/** Contained-listener diagnostic shared by the sync and async failure paths. */
		warnAdaptersListenerFailure(error) {
			this.ctx.logger.warn("llm: an llm/adapters-updated listener failed");
			this.ctx.logger.warn(error);
		}
		/**
		* Register an adapter for the given provider routes. Throws `LlmError` with code
		* `DUPLICATE_ADAPTER` if any provider already has an adapter (all-or-nothing).
		* Disposed with the fiber.
		* @param providers - every provider route this adapter should serve.
		* @param adapter - the adapter that streams calls for those providers.
		* @returns the disposer, carrying {@link AdapterRegistrationHandle.replace}.
		*/
		registerAdapter(providers, adapter) {
			const owned = /* @__PURE__ */ new Set();
			let released = false;
			const dispose = this.ctx.effect(function* () {
				if (providers.length === 0) throw new LlmError("an adapter must register at least one provider", "INVALID_ADAPTER");
				this.commitRoutes(owned, this.prepareRoutes(providers, adapter, owned));
				yield () => {
					released = true;
					for (const provider of owned) this.adapters.delete(provider);
					owned.clear();
					this.emitAdaptersUpdated();
				};
			}.bind(this), "llm.registerAdapter()");
			const handle = (() => void dispose());
			handle.replace = (next) => {
				if (released) throw new LlmError("a disposed adapter registration cannot replace its routes", "REGISTRATION_DISPOSED");
				this.commitRoutes(owned, this.prepareRoutes(next, adapter, owned));
			};
			return handle;
		}
		/**
		* Validate one candidate route set for `adapter`, treating routes this
		* registration already holds as available. Nothing is mutated: a rejected
		* candidate leaves the registry exactly as it was.
		*/
		prepareRoutes(providers, adapter, owned) {
			const unique = /* @__PURE__ */ new Set();
			const registrations = [];
			for (const provider of providers) {
				if (provider.length === 0) throw new LlmError("adapter provider names must be non-empty", "INVALID_ADAPTER");
				if (unique.has(provider) || this.adapters.has(provider) && !owned.has(provider)) throw new LlmError(`an adapter for provider "${provider}" is already registered`, "DUPLICATE_ADAPTER");
				const info = adapter.providerInfo(provider);
				if (typeof info.id !== "string" || info.id !== provider || typeof info.name !== "string" || info.name.length === 0) throw new LlmError(`adapter metadata for provider "${provider}" must preserve its id and have a non-empty name`, "INVALID_ADAPTER");
				unique.add(provider);
				const retryPolicy = adapter.providerRetryPolicy(provider) ?? resolveRetryPolicy(void 0, `llm: provider "${provider}" retryPolicy`);
				registrations.push({
					adapter,
					provider: {
						id: info.id,
						name: info.name
					},
					retryPolicy
				});
			}
			return registrations;
		}
		/**
		* Swap this registration's routes for the prepared ones in one synchronous
		* section, so no observer can see the registry between the release and the
		* re-registration. The route set's one mutation point is also where
		* `llm/adapters-updated` is published, so a `replace` announces itself
		* exactly like a first registration.
		*/
		commitRoutes(owned, registrations) {
			for (const provider of owned) this.adapters.delete(provider);
			owned.clear();
			for (const registration of registrations) {
				this.adapters.set(registration.provider.id, registration);
				owned.add(registration.provider.id);
			}
			this.emitAdaptersUpdated();
		}
		/**
		* Describe provider routes with a registered adapter.
		* @returns detached provider metadata in registration order.
		*/
		listProviders() {
			return [...this.adapters.values()].map(({ provider }) => ({ ...provider }));
		}
		/**
		* Declare provider routes an adapter plugin can activate through
		* configuration. Registration is all-or-nothing: an empty list, invalid
		* entry, or a provider already declared by any registration throws
		* `LlmError` without registering the rest. Disposed with the fiber.
		* @param entries - every configurable provider this plugin owns.
		* @returns a handle that withdraws all of them, and can atomically replace them.
		*/
		registerConfigurableProviders(entries) {
			let held = [];
			let disposed = false;
			/**
			* Validate a candidate set in full against everything this registration
			* does not already hold, then publish it. Nothing is written until the
			* whole set passes, so a refused candidate leaves the current entries in
			* place — the property that makes `replace` a swap rather than a
			* delete-then-add that can strand the directory empty.
			*/
			const commit = (candidates) => {
				const detached = [];
				const own = new Set(held.map((entry) => entry.provider));
				for (const entry of candidates) {
					if (entry.provider.length === 0 || entry.displayName.length === 0 || entry.settingsNs.length === 0) throw new LlmError("configurable providers need a non-empty provider, displayName, and settingsNs", "INVALID_DIRECTORY");
					if (entry.settingsPath.some((segment) => segment.length === 0)) throw new LlmError(`configurable provider "${entry.provider}" has an empty settingsPath segment`, "INVALID_DIRECTORY");
					if (this.directory.has(entry.provider) && !own.has(entry.provider) || detached.some((seen) => seen.provider === entry.provider)) throw new LlmError(`configurable provider "${entry.provider}" is already declared`, "DUPLICATE_DIRECTORY");
					detached.push({
						...entry,
						settingsPath: [...entry.settingsPath]
					});
				}
				for (const entry of held) this.directory.delete(entry.provider);
				for (const entry of detached) this.directory.set(entry.provider, entry);
				held = detached;
				this.emitAdaptersUpdated();
			};
			const dispose = this.ctx.effect(function* () {
				if (entries.length === 0) throw new LlmError("a configurable-provider registration must declare at least one provider", "INVALID_DIRECTORY");
				commit(entries);
				yield () => {
					disposed = true;
					for (const entry of held) this.directory.delete(entry.provider);
					held = [];
					this.emitAdaptersUpdated();
				};
			}.bind(this), "llm.registerConfigurableProviders()");
			const handle = (() => void dispose());
			handle.replace = (next) => {
				if (disposed) throw new LlmError("this configurable-provider registration was disposed", "REGISTRATION_DISPOSED");
				commit(next);
			};
			return handle;
		}
		/**
		* List every declared configurable provider, registered or dormant.
		* @returns detached directory entries in declaration order.
		*/
		listConfigurableProviders() {
			return [...this.directory.values()].map((entry) => ({
				...entry,
				settingsPath: [...entry.settingsPath]
			}));
		}
		/**
		* Offer to interrogate provider endpoints on behalf of the settings
		* namespace this plugin owns. The namespace is the key because that is what
		* a configuration surface already holds from the configurable-provider
		* directory, and because a provider being *added* has no route to name yet.
		* Disposed with the fiber.
		* @param settingsNs - the namespace whose profiles this discovery serves.
		* @param discover - interrogates one endpoint and must honor the supplied signal.
		* @returns the disposer that withdraws the offer.
		*/
		registerModelDiscovery(settingsNs, discover) {
			const dispose = this.ctx.effect(function* () {
				if (settingsNs.length === 0) throw new LlmError("model discovery needs a non-empty settings namespace", "INVALID_DISCOVERY");
				if (this.discoveries.has(settingsNs)) throw new LlmError(`model discovery for "${settingsNs}" is already registered`, "DUPLICATE_DISCOVERY");
				this.discoveries.set(settingsNs, discover);
				yield () => {
					this.discoveries.delete(settingsNs);
				};
			}.bind(this), "llm.registerModelDiscovery()");
			return () => void dispose();
		}
		/**
		* Interrogate one provider endpoint for the models it advertises. The
		* request describes a draft, not a stored route, so nothing here reads or
		* writes settings or credentials — the caller owns both, and the reply is
		* candidate metadata a surface may offer for adoption.
		* @param settingsNs - namespace whose registered discovery serves this draft.
		* @param request - the endpoint, protocol, and one-shot credential to use.
		* @param signal - caller cancellation.
		* @returns the advertised models, deduplicated in endpoint order.
		*/
		async discoverModels(settingsNs, request, signal) {
			const discover = this.discoveries.get(settingsNs);
			if (discover === void 0) throw new LlmError(`no model discovery is registered for "${settingsNs}"`, "NO_DISCOVERY");
			if ((request.provider ?? "").length === 0 && (request.baseURL ?? "").length === 0) throw new LlmError("model discovery needs a provider route or a baseURL", "INVALID_DISCOVERY");
			const discovered = signal === void 0 ? await discover(request) : await discover(request, signal);
			const seen = /* @__PURE__ */ new Set();
			const models = [];
			for (const model of discovered) {
				if (typeof model.id !== "string" || model.id.length === 0 || seen.has(model.id)) continue;
				seen.add(model.id);
				models.push({
					id: model.id,
					...model.name === void 0 ? {} : { name: model.name },
					...model.contextWindow === void 0 ? {} : { contextWindow: model.contextWindow },
					...model.maxTokens === void 0 ? {} : { maxTokens: model.maxTokens }
				});
			}
			return models;
		}
		/**
		* Remote adapter for one draft provider interrogation.
		* @param settingsNs - namespace whose registered discovery serves this draft.
		* @param request - endpoint, protocol, and one-shot credential to use.
		* @param signal - caller cancellation supplied by the Remote carrier.
		* @returns advertised models in endpoint order.
		* @throws RemoteError with `llm/model-discovery-rejected` when discovery refuses or fails.
		*/
		async remoteDiscoverModels(settingsNs, request, signal) {
			try {
				return await this.discoverModels(settingsNs, request, signal);
			} catch (error) {
				throw new RemoteError("llm/model-discovery-rejected", error instanceof Error ? error.message : String(error), {
					settingsNs,
					...request.baseURL === void 0 ? {} : { baseURL: request.baseURL }
				}, { cause: error });
			}
		}
		/**
		* Resolve the retry policy captured when one provider route was registered.
		* @param provider - registered provider route to inspect.
		* @returns the provider-owned policy, with normal defaults already resolved.
		*/
		providerRetryPolicy(provider) {
			return this.registration(provider).retryPolicy;
		}
		/**
		* Resolve provider-side request-image pricing for one exact route, or
		* `undefined` when the provider is unregistered or declares none. Unknown
		* providers degrade to `undefined` rather than throwing because callers
		* price durable history whose route may no longer be mounted.
		* @param provider - provider route named by a request header.
		* @param model - exact model id named by the same header.
		* @returns the owning adapter's image pricing for the route, when declared.
		*/
		imageRequestPricing(provider, model) {
			return this.adapters.get(provider)?.adapter.imageRequestPricing(provider, model);
		}
		/**
		* Resolve the exact text one durable file occurrence contributes to every
		* provider request in the current execution environment.
		* @param ref - durable verbatim file reference from model history.
		* @returns the same deterministic handle text used at adapter dispatch.
		*/
		fileRequestText(ref) {
			return fileHandleText(ref, this.fileReadPath(ref));
		}
		/** Detach typed adapter-owned modality metadata. */
		detachedModalities(modalities) {
			return modalities === void 0 ? void 0 : [...modalities];
		}
		/**
		* Discover models advertised by one registered provider. Catalog membership
		* is advisory and never changes routing or request validation.
		* @param provider - registered provider route to inspect.
		* @returns detached model metadata in adapter-preferred order.
		*/
		async listModels(provider) {
			const models = await this.registration(provider).adapter.listModels(provider);
			const seen = /* @__PURE__ */ new Set();
			return models.map((model) => {
				if (typeof model.provider !== "string" || model.provider !== provider || typeof model.id !== "string" || model.id.length === 0 || typeof model.name !== "string" || model.name.length === 0 || model.description !== void 0 && typeof model.description !== "string" || seen.has(model.id)) throw new LlmError(`adapter returned invalid or duplicate model metadata for provider "${provider}"`, "INVALID_CATALOG");
				seen.add(model.id);
				const inputModalities = this.detachedModalities(model.inputModalities);
				return {
					provider: model.provider,
					id: model.id,
					name: model.name,
					...model.description === void 0 ? {} : { description: model.description },
					...inputModalities === void 0 ? {} : { inputModalities }
				};
			});
		}
		/**
		* Resolve and validate all metadata from the adapter that owns one exact
		* route. The result is detached from adapter-owned objects; catalog
		* membership remains advisory and does not control request routing.
		* @param provider - registered provider route to inspect.
		* @param model - exact model id passed to the adapter.
		* @param signal - optional cancellation for adapter-owned asynchronous lookup.
		* @returns exact model identity plus available context and reasoning metadata.
		*/
		async resolveModelInfo(provider, model, signal) {
			return this.resolveModelInfoFor(this.registration(provider), model, signal);
		}
		async resolveModelInfoFor(registration, model, signal) {
			const resolved = await registration.adapter.resolveModel(registration.provider.id, model, signal);
			return this.normalizeModelInfo(registration, model, resolved);
		}
		/** Validate and detach one adapter-returned exact model result. */
		normalizeModelInfo(registration, model, resolved) {
			const provider = registration.provider.id;
			if (typeof resolved.provider !== "string" || resolved.provider !== provider || typeof resolved.id !== "string" || resolved.id !== model || typeof resolved.name !== "string" || resolved.name.length === 0 || resolved.description !== void 0 && typeof resolved.description !== "string") throw new LlmError(`adapter returned invalid exact model metadata for provider "${provider}" model "${model}"`, "INVALID_MODEL_INFO");
			const context = resolved.context;
			if (context !== void 0 && (!Number.isInteger(context.contextWindow) || context.contextWindow <= 0)) throw new LlmError(`adapter returned invalid context metadata for provider "${provider}" model "${model}"`, "INVALID_MODEL_CONTEXT");
			const inputModalities = this.detachedModalities(resolved.inputModalities);
			const defaultMaxTokens = resolved.defaultMaxTokens;
			if (defaultMaxTokens !== void 0 && (!Number.isSafeInteger(defaultMaxTokens) || defaultMaxTokens <= 0)) throw new LlmError(`adapter returned invalid default maxTokens for provider "${provider}" model "${model}"`, "INVALID_MODEL_MAX_TOKENS");
			const info = {
				provider,
				id: model,
				name: resolved.name,
				...resolved.description === void 0 ? {} : { description: resolved.description },
				...inputModalities === void 0 ? {} : { inputModalities },
				...context === void 0 ? {} : { context: { contextWindow: context.contextWindow } },
				...defaultMaxTokens === void 0 ? {} : { defaultMaxTokens }
			};
			const reasoning = resolved.reasoning;
			if (reasoning === void 0) return info;
			if (reasoning.efforts.length === 0) throw new LlmError(`adapter returned invalid reasoning metadata for provider "${provider}" model "${model}"`, "INVALID_MODEL_REASONING");
			const seen = /* @__PURE__ */ new Set();
			const efforts = reasoning.efforts.map((effort) => {
				if (typeof effort.id !== "string" || effort.id.length === 0 || typeof effort.name !== "string" || effort.name.length === 0 || effort.description !== void 0 && typeof effort.description !== "string" || seen.has(effort.id)) throw new LlmError(`adapter returned invalid or duplicate reasoning effort metadata for provider "${provider}" model "${model}"`, "INVALID_MODEL_REASONING");
				seen.add(effort.id);
				return {
					id: effort.id,
					name: effort.name,
					...effort.description === void 0 ? {} : { description: effort.description }
				};
			});
			if (reasoning.defaultEffort !== void 0 && !seen.has(reasoning.defaultEffort)) throw new LlmError(`adapter returned an unknown default reasoning effort for provider "${provider}" model "${model}"`, "INVALID_MODEL_REASONING");
			return {
				...info,
				reasoning: {
					efforts,
					...reasoning.defaultEffort === void 0 ? {} : { defaultEffort: reasoning.defaultEffort }
				}
			};
		}
		/**
		* Validate a conversation call config against its exact model capability and
		* materialize adapter-configured defaults. Unsupported explicit efforts
		* reject before provider I/O; no clamping or aliasing is performed. This
		* standalone query does not bind a later dispatch; use {@link prepareCall}
		* when logging and streaming must share one adapter registration.
		* @param config - provider/model route and optional request controls.
		* @param signal - optional cancellation for adapter-owned capability lookup.
		* @returns a detached config only when a default must be materialized.
		*/
		async resolveCallConfig(config, signal) {
			return (await this.resolveCallFor(this.registration(config.provider), config, signal)).config;
		}
		async resolveCallFor(registration, config, signal) {
			const info = await this.resolveModelInfoFor(registration, config.model, signal);
			return this.resolveCallWithInfo(config, info);
		}
		/** Validate request controls against one already-bound exact model result. */
		resolveCallWithInfo(config, info) {
			const defaulted = config.maxTokens === void 0 && info.defaultMaxTokens !== void 0 ? {
				...config,
				maxTokens: info.defaultMaxTokens
			} : config;
			const reasoning = info.reasoning;
			const requested = defaulted.reasoningEffort;
			let resolvedConfig = defaulted;
			if (reasoning === void 0) {
				if (requested !== void 0) throw new LlmError(`provider "${config.provider}" model "${config.model}" does not support reasoning effort "${requested}"`, "UNSUPPORTED_REASONING_EFFORT");
			} else {
				const effective = requested ?? reasoning.defaultEffort;
				if (effective !== void 0) {
					if (!reasoning.efforts.some((effort) => effort.id === effective)) throw new LlmError(`provider "${config.provider}" model "${config.model}" does not support reasoning effort "${effective}"`, "UNSUPPORTED_REASONING_EFFORT");
					if (requested !== effective) resolvedConfig = {
						...defaulted,
						reasoningEffort: effective
					};
				}
			}
			return {
				config: resolvedConfig,
				...info.context === void 0 ? {} : { context: info.context },
				modelInfo: info
			};
		}
		/**
		* Resolve one call under its current adapter registration. The returned
		* one-shot handle keeps that registration across header logging and dispatch,
		* so HMR cannot combine one adapter's capability result with another adapter.
		* @param config - provider/model route and optional request controls.
		* @param signal - optional cancellation for adapter-owned capability lookup.
		* @returns a prepared config and its registration-bound stream entry point.
		*/
		async prepareCall(config, signal) {
			const registration = this.registration(config.provider);
			const adapterCall = await registration.adapter.prepareCall(config.provider, config.model, signal);
			const modelInfo = this.normalizeModelInfo(registration, config.model, adapterCall.model);
			const resolved = this.resolveCallWithInfo(config, modelInfo);
			const resolvedConfig = deepFreeze(structuredClone(resolved.config));
			const context = resolved.context === void 0 ? void 0 : deepFreeze(structuredClone(resolved.context));
			const adapterDefaults = deepFreeze({
				...config.reasoningEffort === void 0 && resolvedConfig.reasoningEffort !== void 0 ? { reasoningEffort: true } : {},
				...config.maxTokens === void 0 && resolvedConfig.maxTokens !== void 0 ? { maxTokens: true } : {}
			});
			let dispatched = false;
			return Object.freeze({
				config: resolvedConfig,
				retryPolicy: registration.retryPolicy,
				adapterDefaults,
				...context === void 0 ? {} : { context },
				...modelInfo.inputModalities === void 0 ? {} : { inputModalities: Object.freeze([...modelInfo.inputModalities]) },
				stream: (options) => {
					if (dispatched) throw new LlmError("a prepared LLM call can only be dispatched once", "INVALID_PREPARED_CALL");
					if (!callConfigEquals(options, resolvedConfig)) throw new LlmError("prepared LLM call config changed before adapter dispatch", "INVALID_PREPARED_CALL");
					dispatched = true;
					return this.streamWithRegistration(options, {
						registration,
						config: resolvedConfig,
						modelInfo,
						dispatch: (options) => adapterCall.stream(options)
					});
				}
			});
		}
		registration(provider) {
			const registration = this.adapters.get(provider);
			if (!registration) throw new LlmError(`no adapter registered for provider "${provider}"`, "NO_ADAPTER");
			return registration;
		}
		/** Remove replay state whose historical route is owned by another adapter. */
		forAdapter(options, adapter) {
			const messages = options.messages.map((message) => {
				const source = message.source;
				if (message.role !== "assistant" || source.kind !== "model" || source.replayState === void 0) return message;
				if (this.adapters.get(source.provider)?.adapter === adapter) return message;
				return freezeMessage({
					...message,
					source: {
						kind: "model",
						provider: source.provider,
						model: source.model
					}
				});
			});
			if (messages.every((message, index) => message === options.messages[index])) return options;
			const filtered = {
				...options,
				messages
			};
			return Object.isFrozen(options) ? deepFreeze(filtered) : filtered;
		}
		/**
		* Resolve the current execution-world read path of one durable file
		* reference through the mounted attachment and filesystem providers.
		*/
		fileReadPath(ref) {
			let hostPath;
			try {
				hostPath = this.ctx.get("attachments")?.fileHostPath(ref);
			} catch {
				return;
			}
			if (hostPath === void 0) return void 0;
			return this.ctx.get("fs")?.processPathFromHostPath(hostPath);
		}
		/**
		* Final adapter boundary. Adapter selection, dispatch, iterator construction,
		* and iteration failures become one terminal failure chunk. Middleware and
		* downstream consumer failures remain thrown plugin or consumer errors.
		*/
		async *adapterStream(options, prepared) {
			let iterator;
			try {
				const registration = prepared?.registration ?? this.registration(options.provider);
				const adapter = registration.adapter;
				let modelInfo;
				let resolvedConfig;
				let dispatch;
				if (prepared === void 0) {
					const adapterCall = await adapter.prepareCall(options.provider, options.model, options.signal);
					modelInfo = this.normalizeModelInfo(registration, options.model, adapterCall.model);
					resolvedConfig = this.resolveCallWithInfo(options, modelInfo).config;
					dispatch = (options) => adapterCall.stream(options);
				} else {
					modelInfo = prepared.modelInfo;
					resolvedConfig = prepared.config;
					dispatch = prepared.dispatch;
				}
				if (prepared !== void 0 && !callConfigEquals(options, resolvedConfig)) throw new LlmError("prepared LLM call config changed before adapter dispatch", "INVALID_PREPARED_CALL");
				const resolvedOptions = callConfigEquals(options, resolvedConfig) ? options : Object.isFrozen(options) ? deepFreeze({
					...options,
					...resolvedConfig
				}) : {
					...options,
					...resolvedConfig
				};
				let projectedMessages = resolvedOptions.messages;
				if (projectedMessages.some((message) => contentHasFile(message.content))) projectedMessages = projectFilesToText(projectedMessages, (ref) => this.fileReadPath(ref));
				if (modelInfo.inputModalities !== void 0 && !modelInfo.inputModalities.includes("image") && projectedMessages.some((message) => contentHasImage(message.content))) projectedMessages = projectImagesForTextModel(projectedMessages);
				const projectedOptions = projectedMessages === resolvedOptions.messages ? resolvedOptions : Object.isFrozen(resolvedOptions) ? deepFreeze({
					...resolvedOptions,
					messages: projectedMessages
				}) : {
					...resolvedOptions,
					messages: projectedMessages
				};
				iterator = dispatch(this.forAdapter(projectedOptions, adapter))[Symbol.asyncIterator]();
			} catch (error) {
				yield adapterFailureChunk(error, options.signal);
				return;
			}
			let completed = false;
			try {
				while (true) {
					let item;
					try {
						const next = await iterator.next();
						item = next.done ? { done: true } : {
							done: false,
							value: next.value
						};
					} catch (error) {
						completed = true;
						yield adapterFailureChunk(error, options.signal);
						return;
					}
					if (item.done) {
						completed = true;
						return;
					}
					yield item.value;
				}
			} finally {
				if (!completed) {
					const close = iterator.return?.bind(iterator);
					if (close) await close();
				}
			}
		}
		/**
		* Stream one model call as raw chunks (token-level deltas). Replay state is
		* retained only when the same adapter instance owns its historical provider
		* and the target provider. Final adapter selection remains fixed through
		* asynchronous exact-model resolution and dispatch. Adapter selection,
		* dispatch, and iteration failures become terminal `error` or `aborted`
		* finish chunks; middleware, nested-call, cleanup, and consumer failures
		* remain thrown.
		* @param options - the full request; `options.provider` selects the adapter.
		* @returns the chunk stream, possibly wrapped by `llm/stream` listeners.
		*/
		stream(options) {
			return this.streamWithRegistration(options);
		}
		streamWithRegistration(options, prepared) {
			return this.ctx.waterfall(this, "llm/stream", options, () => this.adapterStream(options, prepared));
		}
	};
})();
/** Convert one adapter throw into the stream protocol's terminal outcome. */
function adapterFailureChunk(error, signal) {
	const failure = normalizeLlmFailure(error);
	return {
		type: "finish",
		reason: signal?.aborted || failure.code === "ABORTED" ? {
			kind: "aborted",
			failure
		} : {
			kind: "error",
			failure
		}
	};
}
//#endregion
//#region lib/types/gateway.js
/**
* WeChatDataGateway — Host Remote service exposing st_control's decrypted
* WeChat SQLite through the DSH Typert RPC. The browser client calls
* ctx.remote.wechatData.* instead of an HTTP API.
*/
var __runInitializers = function(thisArg, initializers, value) {
	var useValue = arguments.length > 2;
	for (var i = 0; i < initializers.length; i++) value = useValue ? initializers[i].call(thisArg, value) : initializers[i].call(thisArg);
	return useValue ? value : void 0;
};
var __esDecorate = function(ctor, descriptorIn, decorators, contextIn, initializers, extraInitializers) {
	function accept(f) {
		if (f !== void 0 && typeof f !== "function") throw new TypeError("Function expected");
		return f;
	}
	var kind = contextIn.kind, key = kind === "getter" ? "get" : kind === "setter" ? "set" : "value";
	var target = !descriptorIn && ctor ? contextIn["static"] ? ctor : ctor.prototype : null;
	var descriptor = descriptorIn || (target ? Object.getOwnPropertyDescriptor(target, contextIn.name) : {});
	var _, done = false;
	for (var i = decorators.length - 1; i >= 0; i--) {
		var context = {};
		for (var p in contextIn) context[p] = p === "access" ? {} : contextIn[p];
		for (var p in contextIn.access) context.access[p] = contextIn.access[p];
		context.addInitializer = function(f) {
			if (done) throw new TypeError("Cannot add initializers after decoration has completed");
			extraInitializers.push(accept(f || null));
		};
		var result = (0, decorators[i])(kind === "accessor" ? {
			get: descriptor.get,
			set: descriptor.set
		} : descriptor[key], context);
		if (kind === "accessor") {
			if (result === void 0) continue;
			if (result === null || typeof result !== "object") throw new TypeError("Object expected");
			if (_ = accept(result.get)) descriptor.get = _;
			if (_ = accept(result.set)) descriptor.set = _;
			if (_ = accept(result.init)) initializers.unshift(_);
		} else if (_ = accept(result)) if (kind === "field") initializers.unshift(_);
		else descriptor[key] = _;
	}
	if (target) Object.defineProperty(target, contextIn.name, descriptor);
	done = true;
};
/** Compact, readable daily digest for the no-LLM fallback (short per-message previews). */
function compactDailyDigest(lines) {
	const parts = [];
	let lastSession = "";
	let shown = 0;
	for (const line of lines) {
		const m = line.match(/^【(.+?)】/);
		if (m && m[1]) {
			lastSession = m[1];
			parts.push("\n【" + lastSession + "】");
			continue;
		}
		if (shown >= 6) {
			parts.push("……");
			break;
		}
		const s = line.replace(/\s+/g, " ").slice(0, 48);
		parts.push("- " + s + (line.length > 48 ? "…" : ""));
		shown += 1;
	}
	return parts.join("\n");
}
/**
* Raw WeChat data base dir (the account root, parent of db_storage): env pin
* first, then the live config db_dir. Resolved per call — config.json may be
* bootstrapped or re-pointed after the gateway started, and a startup
* snapshot would stay empty and leave media resolution dead.
* @param decrypted - decrypted data root (locates config.json).
* @returns the account root, or '' when config has no usable db_dir.
*/
function rawWechatBase(decrypted) {
	const pinned = process.env.DSH_WECHAT_BASE_DIR;
	if (pinned && pinned.trim().length > 0) return pinned.trim();
	const cfg = getConfig(decrypted);
	const dbDir = typeof cfg["db_dir"] === "string" ? cfg["db_dir"] : "";
	if (!dbDir) return "";
	const parts = dbDir.replace(/[\\/]+$/, "").split(/[\\/]/);
	return (parts[parts.length - 1] ?? "") === "db_storage" ? parts.slice(0, -1).join("/") : "";
}
/** Resolve the data layout and run the one-time bootstrap. */
function resolveDirs() {
	bootstrapWechatData();
	return {
		decrypted: resolveDecryptedDir(),
		decoded: resolveDecodedDir()
	};
}
/** Coerce a config cell to a string (null -> '', else String()). */
function cellStr(v) {
	if (typeof v === "string") return v;
	if (v === null || v === void 0) return "";
	if (typeof v === "number" || typeof v === "boolean" || typeof v === "bigint" || typeof v === "symbol") return String(v);
	return "";
}
/** Remote-only service exposing WeChat data queries. */
let WechatDataGateway = (() => {
	let _classSuper = TypertRemoteService;
	let _instanceExtraInitializers = [];
	let _getSessions_decorators;
	let _getContacts_decorators;
	let _getOverviewInsights_decorators;
	let _getOverview_decorators;
	let _getRegionMap_decorators;
	let _getRecords_decorators;
	let _searchMembers_decorators;
	let _getRevoked_decorators;
	let _getEmoticons_decorators;
	let _getStorageStats_decorators;
	let _getAnnual_decorators;
	let _getWechatConfig_decorators;
	let _getPrivacyScan_decorators;
	let _getGraph_decorators;
	let _getMoments_decorators;
	let _getSelfUsername_decorators;
	let _getMomentsAuthors_decorators;
	let _getFavorites_decorators;
	let _getFiles_decorators;
	let _getMessages_decorators;
	let _getNewMessages_decorators;
	let _getSearchIndexStatus_decorators;
	let _buildSearchIndex_decorators;
	let _searchMessages_decorators;
	let _getGroupInfo_decorators;
	let _getPaymentStatus_decorators;
	let _resolveChatHistory_decorators;
	let _getDailyCounts_decorators;
	let _getVoiceInfo_decorators;
	let _getVideoInfo_decorators;
	let _exportSessionMessages_decorators;
	let _askWechat_decorators;
	let _optimizeAskQuestion_decorators;
	let _listBackups_decorators;
	let _previewBackup_decorators;
	let _createBackup_decorators;
	let _deleteBackup_decorators;
	let _generateDailySummary_decorators;
	let _listEditedMessages_decorators;
	let _editChatMessage_decorators;
	let _resetEditedMessage_decorators;
	let _listLlmProviders_decorators;
	let _listLlmModels_decorators;
	let _exportAnnualReport_decorators;
	let _exportAllSessions_decorators;
	let _exportMoments_decorators;
	let _exportCsv_decorators;
	let _clearSessionDraft_decorators;
	let _clearAllSessionDrafts_decorators;
	let _listSummaryTasks_decorators;
	let _saveSummaryTask_decorators;
	let _deleteSummaryTask_decorators;
	let _toggleSummaryTask_decorators;
	let _listSummaryRecords_decorators;
	let _deleteSummaryRecord_decorators;
	let _runSummaryTask_decorators;
	let _getAvatar_decorators;
	let _getAvatarsLocal_decorators;
	let _getWechatConfigFull_decorators;
	let _saveWechatConfig_decorators;
	let _getWhisperStatus_decorators;
	let _downloadWhisperModel_decorators;
	let _detectWechatAccounts_decorators;
	let _verifyDatabaseKey_decorators;
	let _generateKeysFile_decorators;
	let _getWechatKeysInfo_decorators;
	let _autoGetDbKey_decorators;
	let _autoGetImageKey_decorators;
	let _openPath_decorators;
	let _openConfig_decorators;
	let _verifyImageKey_decorators;
	let _decryptAllDatabases_decorators;
	let _decryptAllImages_decorators;
	let _getDecryptStatus_decorators;
	let _installWhisperEngine_decorators;
	let _transcribeVoiceBatch_decorators;
	let _getVoiceTranscript_decorators;
	let _transcribeVoiceMessage_decorators;
	let _setCdnImageEnabled_decorators;
	let _setCdnImageLocalDecrypt_decorators;
	let _deleteFavoriteItems_decorators;
	let _getAnnualReport_decorators;
	let _getDbStatus_decorators;
	let _getImageDataUrl_decorators;
	let _getSnsImageDataUrl_decorators;
	let _getFileImageDataUrl_decorators;
	let _getEmoticonDataUrl_decorators;
	let _getArticleCover_decorators;
	let _getMessageFile_decorators;
	let _addTask_decorators;
	let _clearOperationLog_decorators;
	let _clearPrivacyAudit_decorators;
	let _createEncryptedBackup_decorators;
	let _deleteTask_decorators;
	let _extractTasks_decorators;
	let _generatePeriodSummary_decorators;
	let _getAssetInsights_decorators;
	let _getCalls_decorators;
	let _getContact360_decorators;
	let _getDbHealth_decorators;
	let _getGroupInsights_decorators;
	let _getHandoffReminds_decorators;
	let _getLedger_decorators;
	let _getMediaAssets_decorators;
	let _getMomentsInsights_decorators;
	let _getMomentsMonthly_decorators;
	let _getOfficialAssets_decorators;
	let _getOperationLog_decorators;
	let _getPrivacyAuditRows_decorators;
	let _getPrivacyState_decorators;
	let _getSnsVideoCoverDataUrl_decorators;
	let _getSnsVideoDataUrl_decorators;
	let _listTasks_decorators;
	let _restoreBackup_decorators;
	let _searchUnified_decorators;
	let _setPrivacyState_decorators;
	let _setTaskStatus_decorators;
	let _syncHandoffTasks_decorators;
	return class WechatDataGateway extends _classSuper {
		static {
			const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
			_getSessions_decorators = [Remote("getSessions")];
			_getContacts_decorators = [Remote("getContacts")];
			_getOverviewInsights_decorators = [Remote("getOverviewInsights")];
			_getOverview_decorators = [Remote("getOverview")];
			_getRegionMap_decorators = [Remote("getRegionMap")];
			_getRecords_decorators = [Remote("getRecords")];
			_searchMembers_decorators = [Remote("searchMembers")];
			_getRevoked_decorators = [Remote("getRevoked")];
			_getEmoticons_decorators = [Remote("getEmoticons")];
			_getStorageStats_decorators = [Remote("getStorageStats")];
			_getAnnual_decorators = [Remote("getAnnual")];
			_getWechatConfig_decorators = [Remote("getWechatConfig")];
			_getPrivacyScan_decorators = [Remote("getPrivacyScan")];
			_getGraph_decorators = [Remote("getGraph")];
			_getMoments_decorators = [Remote("getMoments")];
			_getSelfUsername_decorators = [Remote("getSelfUsername")];
			_getMomentsAuthors_decorators = [Remote("getMomentsAuthors")];
			_getFavorites_decorators = [Remote("getFavorites")];
			_getFiles_decorators = [Remote("getFiles")];
			_getMessages_decorators = [Remote("getMessages")];
			_getNewMessages_decorators = [Remote("getNewMessages")];
			_getSearchIndexStatus_decorators = [Remote("getSearchIndexStatus")];
			_buildSearchIndex_decorators = [Remote("buildSearchIndex")];
			_searchMessages_decorators = [Remote("searchMessages")];
			_getGroupInfo_decorators = [Remote("getGroupInfo")];
			_getPaymentStatus_decorators = [Remote("getPaymentStatus")];
			_resolveChatHistory_decorators = [Remote("resolveChatHistory")];
			_getDailyCounts_decorators = [Remote("getDailyCounts")];
			_getVoiceInfo_decorators = [Remote("getVoiceInfo")];
			_getVideoInfo_decorators = [Remote("getVideoInfo")];
			_exportSessionMessages_decorators = [Remote("exportSessionMessages")];
			_askWechat_decorators = [Remote("askWechat")];
			_optimizeAskQuestion_decorators = [Remote("optimizeAskQuestion")];
			_listBackups_decorators = [Remote("listBackups")];
			_previewBackup_decorators = [Remote("previewBackup")];
			_createBackup_decorators = [Remote("createBackup")];
			_deleteBackup_decorators = [Remote("deleteBackup")];
			_generateDailySummary_decorators = [Remote("generateDailySummary")];
			_listEditedMessages_decorators = [Remote("listEditedMessages")];
			_editChatMessage_decorators = [Remote("editChatMessage")];
			_resetEditedMessage_decorators = [Remote("resetEditedMessage")];
			_listLlmProviders_decorators = [Remote("listLlmProviders")];
			_listLlmModels_decorators = [Remote("listLlmModels")];
			_exportAnnualReport_decorators = [Remote("exportAnnualReport")];
			_exportAllSessions_decorators = [Remote("exportAllSessions")];
			_exportMoments_decorators = [Remote("exportMoments")];
			_exportCsv_decorators = [Remote("exportCsv")];
			_clearSessionDraft_decorators = [Remote("clearSessionDraft")];
			_clearAllSessionDrafts_decorators = [Remote("clearAllSessionDrafts")];
			_listSummaryTasks_decorators = [Remote("listSummaryTasks")];
			_saveSummaryTask_decorators = [Remote("saveSummaryTask")];
			_deleteSummaryTask_decorators = [Remote("deleteSummaryTask")];
			_toggleSummaryTask_decorators = [Remote("toggleSummaryTask")];
			_listSummaryRecords_decorators = [Remote("listSummaryRecords")];
			_deleteSummaryRecord_decorators = [Remote("deleteSummaryRecord")];
			_runSummaryTask_decorators = [Remote("runSummaryTask")];
			_getAvatar_decorators = [Remote("getAvatar")];
			_getAvatarsLocal_decorators = [Remote("getAvatarsLocal")];
			_getWechatConfigFull_decorators = [Remote("getWechatConfigFull")];
			_saveWechatConfig_decorators = [Remote("saveWechatConfig")];
			_getWhisperStatus_decorators = [Remote("getWhisperStatus")];
			_downloadWhisperModel_decorators = [Remote("downloadWhisperModel")];
			_detectWechatAccounts_decorators = [Remote("detectWechatAccounts")];
			_verifyDatabaseKey_decorators = [Remote("verifyDatabaseKey")];
			_generateKeysFile_decorators = [Remote("generateKeysFile")];
			_getWechatKeysInfo_decorators = [Remote("getWechatKeysInfo")];
			_autoGetDbKey_decorators = [Remote("autoGetDbKey")];
			_autoGetImageKey_decorators = [Remote("autoGetImageKey")];
			_openPath_decorators = [Remote("openPath")];
			_openConfig_decorators = [Remote("openConfig")];
			_verifyImageKey_decorators = [Remote("verifyImageKey")];
			_decryptAllDatabases_decorators = [Remote("decryptAllDatabases")];
			_decryptAllImages_decorators = [Remote("decryptAllImages")];
			_getDecryptStatus_decorators = [Remote("getDecryptStatus")];
			_installWhisperEngine_decorators = [Remote("installWhisperEngine")];
			_transcribeVoiceBatch_decorators = [Remote("transcribeVoiceBatch")];
			_getVoiceTranscript_decorators = [Remote("getVoiceTranscript")];
			_transcribeVoiceMessage_decorators = [Remote("transcribeVoiceMessage")];
			_setCdnImageEnabled_decorators = [Remote("setCdnImageEnabled")];
			_setCdnImageLocalDecrypt_decorators = [Remote("setCdnImageLocalDecrypt")];
			_deleteFavoriteItems_decorators = [Remote("deleteFavoriteItems")];
			_getAnnualReport_decorators = [Remote("getAnnualReport")];
			_getDbStatus_decorators = [Remote("getDbStatus")];
			_getImageDataUrl_decorators = [Remote("getImageDataUrl")];
			_getSnsImageDataUrl_decorators = [Remote("getSnsImageDataUrl")];
			_getFileImageDataUrl_decorators = [Remote("getFileImageDataUrl")];
			_getEmoticonDataUrl_decorators = [Remote("getEmoticonDataUrl")];
			_getArticleCover_decorators = [Remote("getArticleCover")];
			_getMessageFile_decorators = [Remote("getMessageFile")];
			_addTask_decorators = [Remote("addTask")];
			_clearOperationLog_decorators = [Remote("clearOperationLog")];
			_clearPrivacyAudit_decorators = [Remote("clearPrivacyAudit")];
			_createEncryptedBackup_decorators = [Remote("createEncryptedBackup")];
			_deleteTask_decorators = [Remote("deleteTask")];
			_extractTasks_decorators = [Remote("extractTasks")];
			_generatePeriodSummary_decorators = [Remote("generatePeriodSummary")];
			_getAssetInsights_decorators = [Remote("getAssetInsights")];
			_getCalls_decorators = [Remote("getCalls")];
			_getContact360_decorators = [Remote("getContact360")];
			_getDbHealth_decorators = [Remote("getDbHealth")];
			_getGroupInsights_decorators = [Remote("getGroupInsights")];
			_getHandoffReminds_decorators = [Remote("getHandoffReminds")];
			_getLedger_decorators = [Remote("getLedger")];
			_getMediaAssets_decorators = [Remote("getMediaAssets")];
			_getMomentsInsights_decorators = [Remote("getMomentsInsights")];
			_getMomentsMonthly_decorators = [Remote("getMomentsMonthly")];
			_getOfficialAssets_decorators = [Remote("getOfficialAssets")];
			_getOperationLog_decorators = [Remote("getOperationLog")];
			_getPrivacyAuditRows_decorators = [Remote("getPrivacyAuditRows")];
			_getPrivacyState_decorators = [Remote("getPrivacyState")];
			_getSnsVideoCoverDataUrl_decorators = [Remote("getSnsVideoCoverDataUrl")];
			_getSnsVideoDataUrl_decorators = [Remote("getSnsVideoDataUrl")];
			_listTasks_decorators = [Remote("listTasks")];
			_restoreBackup_decorators = [Remote("restoreBackup")];
			_searchUnified_decorators = [Remote("searchUnified")];
			_setPrivacyState_decorators = [Remote("setPrivacyState")];
			_setTaskStatus_decorators = [Remote("setTaskStatus")];
			_syncHandoffTasks_decorators = [Remote("syncHandoffTasks")];
			__esDecorate(this, null, _getSessions_decorators, {
				kind: "method",
				name: "getSessions",
				static: false,
				private: false,
				access: {
					has: (obj) => "getSessions" in obj,
					get: (obj) => obj.getSessions
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _getContacts_decorators, {
				kind: "method",
				name: "getContacts",
				static: false,
				private: false,
				access: {
					has: (obj) => "getContacts" in obj,
					get: (obj) => obj.getContacts
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _getOverviewInsights_decorators, {
				kind: "method",
				name: "getOverviewInsights",
				static: false,
				private: false,
				access: {
					has: (obj) => "getOverviewInsights" in obj,
					get: (obj) => obj.getOverviewInsights
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _getOverview_decorators, {
				kind: "method",
				name: "getOverview",
				static: false,
				private: false,
				access: {
					has: (obj) => "getOverview" in obj,
					get: (obj) => obj.getOverview
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _getRegionMap_decorators, {
				kind: "method",
				name: "getRegionMap",
				static: false,
				private: false,
				access: {
					has: (obj) => "getRegionMap" in obj,
					get: (obj) => obj.getRegionMap
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _getRecords_decorators, {
				kind: "method",
				name: "getRecords",
				static: false,
				private: false,
				access: {
					has: (obj) => "getRecords" in obj,
					get: (obj) => obj.getRecords
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _searchMembers_decorators, {
				kind: "method",
				name: "searchMembers",
				static: false,
				private: false,
				access: {
					has: (obj) => "searchMembers" in obj,
					get: (obj) => obj.searchMembers
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _getRevoked_decorators, {
				kind: "method",
				name: "getRevoked",
				static: false,
				private: false,
				access: {
					has: (obj) => "getRevoked" in obj,
					get: (obj) => obj.getRevoked
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _getEmoticons_decorators, {
				kind: "method",
				name: "getEmoticons",
				static: false,
				private: false,
				access: {
					has: (obj) => "getEmoticons" in obj,
					get: (obj) => obj.getEmoticons
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _getStorageStats_decorators, {
				kind: "method",
				name: "getStorageStats",
				static: false,
				private: false,
				access: {
					has: (obj) => "getStorageStats" in obj,
					get: (obj) => obj.getStorageStats
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _getAnnual_decorators, {
				kind: "method",
				name: "getAnnual",
				static: false,
				private: false,
				access: {
					has: (obj) => "getAnnual" in obj,
					get: (obj) => obj.getAnnual
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _getWechatConfig_decorators, {
				kind: "method",
				name: "getWechatConfig",
				static: false,
				private: false,
				access: {
					has: (obj) => "getWechatConfig" in obj,
					get: (obj) => obj.getWechatConfig
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _getPrivacyScan_decorators, {
				kind: "method",
				name: "getPrivacyScan",
				static: false,
				private: false,
				access: {
					has: (obj) => "getPrivacyScan" in obj,
					get: (obj) => obj.getPrivacyScan
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _getGraph_decorators, {
				kind: "method",
				name: "getGraph",
				static: false,
				private: false,
				access: {
					has: (obj) => "getGraph" in obj,
					get: (obj) => obj.getGraph
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _getMoments_decorators, {
				kind: "method",
				name: "getMoments",
				static: false,
				private: false,
				access: {
					has: (obj) => "getMoments" in obj,
					get: (obj) => obj.getMoments
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _getSelfUsername_decorators, {
				kind: "method",
				name: "getSelfUsername",
				static: false,
				private: false,
				access: {
					has: (obj) => "getSelfUsername" in obj,
					get: (obj) => obj.getSelfUsername
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _getMomentsAuthors_decorators, {
				kind: "method",
				name: "getMomentsAuthors",
				static: false,
				private: false,
				access: {
					has: (obj) => "getMomentsAuthors" in obj,
					get: (obj) => obj.getMomentsAuthors
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _getFavorites_decorators, {
				kind: "method",
				name: "getFavorites",
				static: false,
				private: false,
				access: {
					has: (obj) => "getFavorites" in obj,
					get: (obj) => obj.getFavorites
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _getFiles_decorators, {
				kind: "method",
				name: "getFiles",
				static: false,
				private: false,
				access: {
					has: (obj) => "getFiles" in obj,
					get: (obj) => obj.getFiles
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _getMessages_decorators, {
				kind: "method",
				name: "getMessages",
				static: false,
				private: false,
				access: {
					has: (obj) => "getMessages" in obj,
					get: (obj) => obj.getMessages
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _getNewMessages_decorators, {
				kind: "method",
				name: "getNewMessages",
				static: false,
				private: false,
				access: {
					has: (obj) => "getNewMessages" in obj,
					get: (obj) => obj.getNewMessages
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _getSearchIndexStatus_decorators, {
				kind: "method",
				name: "getSearchIndexStatus",
				static: false,
				private: false,
				access: {
					has: (obj) => "getSearchIndexStatus" in obj,
					get: (obj) => obj.getSearchIndexStatus
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _buildSearchIndex_decorators, {
				kind: "method",
				name: "buildSearchIndex",
				static: false,
				private: false,
				access: {
					has: (obj) => "buildSearchIndex" in obj,
					get: (obj) => obj.buildSearchIndex
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _searchMessages_decorators, {
				kind: "method",
				name: "searchMessages",
				static: false,
				private: false,
				access: {
					has: (obj) => "searchMessages" in obj,
					get: (obj) => obj.searchMessages
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _getGroupInfo_decorators, {
				kind: "method",
				name: "getGroupInfo",
				static: false,
				private: false,
				access: {
					has: (obj) => "getGroupInfo" in obj,
					get: (obj) => obj.getGroupInfo
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _getPaymentStatus_decorators, {
				kind: "method",
				name: "getPaymentStatus",
				static: false,
				private: false,
				access: {
					has: (obj) => "getPaymentStatus" in obj,
					get: (obj) => obj.getPaymentStatus
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _resolveChatHistory_decorators, {
				kind: "method",
				name: "resolveChatHistory",
				static: false,
				private: false,
				access: {
					has: (obj) => "resolveChatHistory" in obj,
					get: (obj) => obj.resolveChatHistory
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _getDailyCounts_decorators, {
				kind: "method",
				name: "getDailyCounts",
				static: false,
				private: false,
				access: {
					has: (obj) => "getDailyCounts" in obj,
					get: (obj) => obj.getDailyCounts
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _getVoiceInfo_decorators, {
				kind: "method",
				name: "getVoiceInfo",
				static: false,
				private: false,
				access: {
					has: (obj) => "getVoiceInfo" in obj,
					get: (obj) => obj.getVoiceInfo
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _getVideoInfo_decorators, {
				kind: "method",
				name: "getVideoInfo",
				static: false,
				private: false,
				access: {
					has: (obj) => "getVideoInfo" in obj,
					get: (obj) => obj.getVideoInfo
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _exportSessionMessages_decorators, {
				kind: "method",
				name: "exportSessionMessages",
				static: false,
				private: false,
				access: {
					has: (obj) => "exportSessionMessages" in obj,
					get: (obj) => obj.exportSessionMessages
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _askWechat_decorators, {
				kind: "method",
				name: "askWechat",
				static: false,
				private: false,
				access: {
					has: (obj) => "askWechat" in obj,
					get: (obj) => obj.askWechat
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _optimizeAskQuestion_decorators, {
				kind: "method",
				name: "optimizeAskQuestion",
				static: false,
				private: false,
				access: {
					has: (obj) => "optimizeAskQuestion" in obj,
					get: (obj) => obj.optimizeAskQuestion
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _listBackups_decorators, {
				kind: "method",
				name: "listBackups",
				static: false,
				private: false,
				access: {
					has: (obj) => "listBackups" in obj,
					get: (obj) => obj.listBackups
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _previewBackup_decorators, {
				kind: "method",
				name: "previewBackup",
				static: false,
				private: false,
				access: {
					has: (obj) => "previewBackup" in obj,
					get: (obj) => obj.previewBackup
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _createBackup_decorators, {
				kind: "method",
				name: "createBackup",
				static: false,
				private: false,
				access: {
					has: (obj) => "createBackup" in obj,
					get: (obj) => obj.createBackup
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _deleteBackup_decorators, {
				kind: "method",
				name: "deleteBackup",
				static: false,
				private: false,
				access: {
					has: (obj) => "deleteBackup" in obj,
					get: (obj) => obj.deleteBackup
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _generateDailySummary_decorators, {
				kind: "method",
				name: "generateDailySummary",
				static: false,
				private: false,
				access: {
					has: (obj) => "generateDailySummary" in obj,
					get: (obj) => obj.generateDailySummary
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _listEditedMessages_decorators, {
				kind: "method",
				name: "listEditedMessages",
				static: false,
				private: false,
				access: {
					has: (obj) => "listEditedMessages" in obj,
					get: (obj) => obj.listEditedMessages
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _editChatMessage_decorators, {
				kind: "method",
				name: "editChatMessage",
				static: false,
				private: false,
				access: {
					has: (obj) => "editChatMessage" in obj,
					get: (obj) => obj.editChatMessage
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _resetEditedMessage_decorators, {
				kind: "method",
				name: "resetEditedMessage",
				static: false,
				private: false,
				access: {
					has: (obj) => "resetEditedMessage" in obj,
					get: (obj) => obj.resetEditedMessage
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _listLlmProviders_decorators, {
				kind: "method",
				name: "listLlmProviders",
				static: false,
				private: false,
				access: {
					has: (obj) => "listLlmProviders" in obj,
					get: (obj) => obj.listLlmProviders
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _listLlmModels_decorators, {
				kind: "method",
				name: "listLlmModels",
				static: false,
				private: false,
				access: {
					has: (obj) => "listLlmModels" in obj,
					get: (obj) => obj.listLlmModels
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _exportAnnualReport_decorators, {
				kind: "method",
				name: "exportAnnualReport",
				static: false,
				private: false,
				access: {
					has: (obj) => "exportAnnualReport" in obj,
					get: (obj) => obj.exportAnnualReport
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _exportAllSessions_decorators, {
				kind: "method",
				name: "exportAllSessions",
				static: false,
				private: false,
				access: {
					has: (obj) => "exportAllSessions" in obj,
					get: (obj) => obj.exportAllSessions
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _exportMoments_decorators, {
				kind: "method",
				name: "exportMoments",
				static: false,
				private: false,
				access: {
					has: (obj) => "exportMoments" in obj,
					get: (obj) => obj.exportMoments
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _exportCsv_decorators, {
				kind: "method",
				name: "exportCsv",
				static: false,
				private: false,
				access: {
					has: (obj) => "exportCsv" in obj,
					get: (obj) => obj.exportCsv
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _clearSessionDraft_decorators, {
				kind: "method",
				name: "clearSessionDraft",
				static: false,
				private: false,
				access: {
					has: (obj) => "clearSessionDraft" in obj,
					get: (obj) => obj.clearSessionDraft
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _clearAllSessionDrafts_decorators, {
				kind: "method",
				name: "clearAllSessionDrafts",
				static: false,
				private: false,
				access: {
					has: (obj) => "clearAllSessionDrafts" in obj,
					get: (obj) => obj.clearAllSessionDrafts
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _listSummaryTasks_decorators, {
				kind: "method",
				name: "listSummaryTasks",
				static: false,
				private: false,
				access: {
					has: (obj) => "listSummaryTasks" in obj,
					get: (obj) => obj.listSummaryTasks
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _saveSummaryTask_decorators, {
				kind: "method",
				name: "saveSummaryTask",
				static: false,
				private: false,
				access: {
					has: (obj) => "saveSummaryTask" in obj,
					get: (obj) => obj.saveSummaryTask
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _deleteSummaryTask_decorators, {
				kind: "method",
				name: "deleteSummaryTask",
				static: false,
				private: false,
				access: {
					has: (obj) => "deleteSummaryTask" in obj,
					get: (obj) => obj.deleteSummaryTask
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _toggleSummaryTask_decorators, {
				kind: "method",
				name: "toggleSummaryTask",
				static: false,
				private: false,
				access: {
					has: (obj) => "toggleSummaryTask" in obj,
					get: (obj) => obj.toggleSummaryTask
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _listSummaryRecords_decorators, {
				kind: "method",
				name: "listSummaryRecords",
				static: false,
				private: false,
				access: {
					has: (obj) => "listSummaryRecords" in obj,
					get: (obj) => obj.listSummaryRecords
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _deleteSummaryRecord_decorators, {
				kind: "method",
				name: "deleteSummaryRecord",
				static: false,
				private: false,
				access: {
					has: (obj) => "deleteSummaryRecord" in obj,
					get: (obj) => obj.deleteSummaryRecord
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _runSummaryTask_decorators, {
				kind: "method",
				name: "runSummaryTask",
				static: false,
				private: false,
				access: {
					has: (obj) => "runSummaryTask" in obj,
					get: (obj) => obj.runSummaryTask
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _getAvatar_decorators, {
				kind: "method",
				name: "getAvatar",
				static: false,
				private: false,
				access: {
					has: (obj) => "getAvatar" in obj,
					get: (obj) => obj.getAvatar
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _getAvatarsLocal_decorators, {
				kind: "method",
				name: "getAvatarsLocal",
				static: false,
				private: false,
				access: {
					has: (obj) => "getAvatarsLocal" in obj,
					get: (obj) => obj.getAvatarsLocal
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _getWechatConfigFull_decorators, {
				kind: "method",
				name: "getWechatConfigFull",
				static: false,
				private: false,
				access: {
					has: (obj) => "getWechatConfigFull" in obj,
					get: (obj) => obj.getWechatConfigFull
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _saveWechatConfig_decorators, {
				kind: "method",
				name: "saveWechatConfig",
				static: false,
				private: false,
				access: {
					has: (obj) => "saveWechatConfig" in obj,
					get: (obj) => obj.saveWechatConfig
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _getWhisperStatus_decorators, {
				kind: "method",
				name: "getWhisperStatus",
				static: false,
				private: false,
				access: {
					has: (obj) => "getWhisperStatus" in obj,
					get: (obj) => obj.getWhisperStatus
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _downloadWhisperModel_decorators, {
				kind: "method",
				name: "downloadWhisperModel",
				static: false,
				private: false,
				access: {
					has: (obj) => "downloadWhisperModel" in obj,
					get: (obj) => obj.downloadWhisperModel
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _detectWechatAccounts_decorators, {
				kind: "method",
				name: "detectWechatAccounts",
				static: false,
				private: false,
				access: {
					has: (obj) => "detectWechatAccounts" in obj,
					get: (obj) => obj.detectWechatAccounts
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _verifyDatabaseKey_decorators, {
				kind: "method",
				name: "verifyDatabaseKey",
				static: false,
				private: false,
				access: {
					has: (obj) => "verifyDatabaseKey" in obj,
					get: (obj) => obj.verifyDatabaseKey
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _generateKeysFile_decorators, {
				kind: "method",
				name: "generateKeysFile",
				static: false,
				private: false,
				access: {
					has: (obj) => "generateKeysFile" in obj,
					get: (obj) => obj.generateKeysFile
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _getWechatKeysInfo_decorators, {
				kind: "method",
				name: "getWechatKeysInfo",
				static: false,
				private: false,
				access: {
					has: (obj) => "getWechatKeysInfo" in obj,
					get: (obj) => obj.getWechatKeysInfo
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _autoGetDbKey_decorators, {
				kind: "method",
				name: "autoGetDbKey",
				static: false,
				private: false,
				access: {
					has: (obj) => "autoGetDbKey" in obj,
					get: (obj) => obj.autoGetDbKey
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _autoGetImageKey_decorators, {
				kind: "method",
				name: "autoGetImageKey",
				static: false,
				private: false,
				access: {
					has: (obj) => "autoGetImageKey" in obj,
					get: (obj) => obj.autoGetImageKey
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _openPath_decorators, {
				kind: "method",
				name: "openPath",
				static: false,
				private: false,
				access: {
					has: (obj) => "openPath" in obj,
					get: (obj) => obj.openPath
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _openConfig_decorators, {
				kind: "method",
				name: "openConfig",
				static: false,
				private: false,
				access: {
					has: (obj) => "openConfig" in obj,
					get: (obj) => obj.openConfig
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _verifyImageKey_decorators, {
				kind: "method",
				name: "verifyImageKey",
				static: false,
				private: false,
				access: {
					has: (obj) => "verifyImageKey" in obj,
					get: (obj) => obj.verifyImageKey
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _decryptAllDatabases_decorators, {
				kind: "method",
				name: "decryptAllDatabases",
				static: false,
				private: false,
				access: {
					has: (obj) => "decryptAllDatabases" in obj,
					get: (obj) => obj.decryptAllDatabases
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _decryptAllImages_decorators, {
				kind: "method",
				name: "decryptAllImages",
				static: false,
				private: false,
				access: {
					has: (obj) => "decryptAllImages" in obj,
					get: (obj) => obj.decryptAllImages
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _getDecryptStatus_decorators, {
				kind: "method",
				name: "getDecryptStatus",
				static: false,
				private: false,
				access: {
					has: (obj) => "getDecryptStatus" in obj,
					get: (obj) => obj.getDecryptStatus
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _installWhisperEngine_decorators, {
				kind: "method",
				name: "installWhisperEngine",
				static: false,
				private: false,
				access: {
					has: (obj) => "installWhisperEngine" in obj,
					get: (obj) => obj.installWhisperEngine
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _transcribeVoiceBatch_decorators, {
				kind: "method",
				name: "transcribeVoiceBatch",
				static: false,
				private: false,
				access: {
					has: (obj) => "transcribeVoiceBatch" in obj,
					get: (obj) => obj.transcribeVoiceBatch
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _getVoiceTranscript_decorators, {
				kind: "method",
				name: "getVoiceTranscript",
				static: false,
				private: false,
				access: {
					has: (obj) => "getVoiceTranscript" in obj,
					get: (obj) => obj.getVoiceTranscript
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _transcribeVoiceMessage_decorators, {
				kind: "method",
				name: "transcribeVoiceMessage",
				static: false,
				private: false,
				access: {
					has: (obj) => "transcribeVoiceMessage" in obj,
					get: (obj) => obj.transcribeVoiceMessage
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _setCdnImageEnabled_decorators, {
				kind: "method",
				name: "setCdnImageEnabled",
				static: false,
				private: false,
				access: {
					has: (obj) => "setCdnImageEnabled" in obj,
					get: (obj) => obj.setCdnImageEnabled
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _setCdnImageLocalDecrypt_decorators, {
				kind: "method",
				name: "setCdnImageLocalDecrypt",
				static: false,
				private: false,
				access: {
					has: (obj) => "setCdnImageLocalDecrypt" in obj,
					get: (obj) => obj.setCdnImageLocalDecrypt
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _deleteFavoriteItems_decorators, {
				kind: "method",
				name: "deleteFavoriteItems",
				static: false,
				private: false,
				access: {
					has: (obj) => "deleteFavoriteItems" in obj,
					get: (obj) => obj.deleteFavoriteItems
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _getAnnualReport_decorators, {
				kind: "method",
				name: "getAnnualReport",
				static: false,
				private: false,
				access: {
					has: (obj) => "getAnnualReport" in obj,
					get: (obj) => obj.getAnnualReport
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _getDbStatus_decorators, {
				kind: "method",
				name: "getDbStatus",
				static: false,
				private: false,
				access: {
					has: (obj) => "getDbStatus" in obj,
					get: (obj) => obj.getDbStatus
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _getImageDataUrl_decorators, {
				kind: "method",
				name: "getImageDataUrl",
				static: false,
				private: false,
				access: {
					has: (obj) => "getImageDataUrl" in obj,
					get: (obj) => obj.getImageDataUrl
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _getSnsImageDataUrl_decorators, {
				kind: "method",
				name: "getSnsImageDataUrl",
				static: false,
				private: false,
				access: {
					has: (obj) => "getSnsImageDataUrl" in obj,
					get: (obj) => obj.getSnsImageDataUrl
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _getFileImageDataUrl_decorators, {
				kind: "method",
				name: "getFileImageDataUrl",
				static: false,
				private: false,
				access: {
					has: (obj) => "getFileImageDataUrl" in obj,
					get: (obj) => obj.getFileImageDataUrl
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _getEmoticonDataUrl_decorators, {
				kind: "method",
				name: "getEmoticonDataUrl",
				static: false,
				private: false,
				access: {
					has: (obj) => "getEmoticonDataUrl" in obj,
					get: (obj) => obj.getEmoticonDataUrl
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _getArticleCover_decorators, {
				kind: "method",
				name: "getArticleCover",
				static: false,
				private: false,
				access: {
					has: (obj) => "getArticleCover" in obj,
					get: (obj) => obj.getArticleCover
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _getMessageFile_decorators, {
				kind: "method",
				name: "getMessageFile",
				static: false,
				private: false,
				access: {
					has: (obj) => "getMessageFile" in obj,
					get: (obj) => obj.getMessageFile
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _addTask_decorators, {
				kind: "method",
				name: "addTask",
				static: false,
				private: false,
				access: {
					has: (obj) => "addTask" in obj,
					get: (obj) => obj.addTask
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _clearOperationLog_decorators, {
				kind: "method",
				name: "clearOperationLog",
				static: false,
				private: false,
				access: {
					has: (obj) => "clearOperationLog" in obj,
					get: (obj) => obj.clearOperationLog
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _clearPrivacyAudit_decorators, {
				kind: "method",
				name: "clearPrivacyAudit",
				static: false,
				private: false,
				access: {
					has: (obj) => "clearPrivacyAudit" in obj,
					get: (obj) => obj.clearPrivacyAudit
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _createEncryptedBackup_decorators, {
				kind: "method",
				name: "createEncryptedBackup",
				static: false,
				private: false,
				access: {
					has: (obj) => "createEncryptedBackup" in obj,
					get: (obj) => obj.createEncryptedBackup
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _deleteTask_decorators, {
				kind: "method",
				name: "deleteTask",
				static: false,
				private: false,
				access: {
					has: (obj) => "deleteTask" in obj,
					get: (obj) => obj.deleteTask
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _extractTasks_decorators, {
				kind: "method",
				name: "extractTasks",
				static: false,
				private: false,
				access: {
					has: (obj) => "extractTasks" in obj,
					get: (obj) => obj.extractTasks
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _generatePeriodSummary_decorators, {
				kind: "method",
				name: "generatePeriodSummary",
				static: false,
				private: false,
				access: {
					has: (obj) => "generatePeriodSummary" in obj,
					get: (obj) => obj.generatePeriodSummary
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _getAssetInsights_decorators, {
				kind: "method",
				name: "getAssetInsights",
				static: false,
				private: false,
				access: {
					has: (obj) => "getAssetInsights" in obj,
					get: (obj) => obj.getAssetInsights
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _getCalls_decorators, {
				kind: "method",
				name: "getCalls",
				static: false,
				private: false,
				access: {
					has: (obj) => "getCalls" in obj,
					get: (obj) => obj.getCalls
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _getContact360_decorators, {
				kind: "method",
				name: "getContact360",
				static: false,
				private: false,
				access: {
					has: (obj) => "getContact360" in obj,
					get: (obj) => obj.getContact360
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _getDbHealth_decorators, {
				kind: "method",
				name: "getDbHealth",
				static: false,
				private: false,
				access: {
					has: (obj) => "getDbHealth" in obj,
					get: (obj) => obj.getDbHealth
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _getGroupInsights_decorators, {
				kind: "method",
				name: "getGroupInsights",
				static: false,
				private: false,
				access: {
					has: (obj) => "getGroupInsights" in obj,
					get: (obj) => obj.getGroupInsights
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _getHandoffReminds_decorators, {
				kind: "method",
				name: "getHandoffReminds",
				static: false,
				private: false,
				access: {
					has: (obj) => "getHandoffReminds" in obj,
					get: (obj) => obj.getHandoffReminds
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _getLedger_decorators, {
				kind: "method",
				name: "getLedger",
				static: false,
				private: false,
				access: {
					has: (obj) => "getLedger" in obj,
					get: (obj) => obj.getLedger
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _getMediaAssets_decorators, {
				kind: "method",
				name: "getMediaAssets",
				static: false,
				private: false,
				access: {
					has: (obj) => "getMediaAssets" in obj,
					get: (obj) => obj.getMediaAssets
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _getMomentsInsights_decorators, {
				kind: "method",
				name: "getMomentsInsights",
				static: false,
				private: false,
				access: {
					has: (obj) => "getMomentsInsights" in obj,
					get: (obj) => obj.getMomentsInsights
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _getMomentsMonthly_decorators, {
				kind: "method",
				name: "getMomentsMonthly",
				static: false,
				private: false,
				access: {
					has: (obj) => "getMomentsMonthly" in obj,
					get: (obj) => obj.getMomentsMonthly
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _getOfficialAssets_decorators, {
				kind: "method",
				name: "getOfficialAssets",
				static: false,
				private: false,
				access: {
					has: (obj) => "getOfficialAssets" in obj,
					get: (obj) => obj.getOfficialAssets
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _getOperationLog_decorators, {
				kind: "method",
				name: "getOperationLog",
				static: false,
				private: false,
				access: {
					has: (obj) => "getOperationLog" in obj,
					get: (obj) => obj.getOperationLog
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _getPrivacyAuditRows_decorators, {
				kind: "method",
				name: "getPrivacyAuditRows",
				static: false,
				private: false,
				access: {
					has: (obj) => "getPrivacyAuditRows" in obj,
					get: (obj) => obj.getPrivacyAuditRows
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _getPrivacyState_decorators, {
				kind: "method",
				name: "getPrivacyState",
				static: false,
				private: false,
				access: {
					has: (obj) => "getPrivacyState" in obj,
					get: (obj) => obj.getPrivacyState
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _getSnsVideoCoverDataUrl_decorators, {
				kind: "method",
				name: "getSnsVideoCoverDataUrl",
				static: false,
				private: false,
				access: {
					has: (obj) => "getSnsVideoCoverDataUrl" in obj,
					get: (obj) => obj.getSnsVideoCoverDataUrl
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _getSnsVideoDataUrl_decorators, {
				kind: "method",
				name: "getSnsVideoDataUrl",
				static: false,
				private: false,
				access: {
					has: (obj) => "getSnsVideoDataUrl" in obj,
					get: (obj) => obj.getSnsVideoDataUrl
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _listTasks_decorators, {
				kind: "method",
				name: "listTasks",
				static: false,
				private: false,
				access: {
					has: (obj) => "listTasks" in obj,
					get: (obj) => obj.listTasks
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _restoreBackup_decorators, {
				kind: "method",
				name: "restoreBackup",
				static: false,
				private: false,
				access: {
					has: (obj) => "restoreBackup" in obj,
					get: (obj) => obj.restoreBackup
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _searchUnified_decorators, {
				kind: "method",
				name: "searchUnified",
				static: false,
				private: false,
				access: {
					has: (obj) => "searchUnified" in obj,
					get: (obj) => obj.searchUnified
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _setPrivacyState_decorators, {
				kind: "method",
				name: "setPrivacyState",
				static: false,
				private: false,
				access: {
					has: (obj) => "setPrivacyState" in obj,
					get: (obj) => obj.setPrivacyState
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _setTaskStatus_decorators, {
				kind: "method",
				name: "setTaskStatus",
				static: false,
				private: false,
				access: {
					has: (obj) => "setTaskStatus" in obj,
					get: (obj) => obj.setTaskStatus
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _syncHandoffTasks_decorators, {
				kind: "method",
				name: "syncHandoffTasks",
				static: false,
				private: false,
				access: {
					has: (obj) => "syncHandoffTasks" in obj,
					get: (obj) => obj.syncHandoffTasks
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			if (_metadata) Object.defineProperty(this, Symbol.metadata, {
				enumerable: true,
				configurable: true,
				writable: true,
				value: _metadata
			});
		}
		/** Services this gateway depends on at runtime (LLM + default model). */
		static inject = ["llm", "agentDefaultModel"];
		_ctx = __runInitializers(this, _instanceExtraInitializers);
		_dirs;
		_selfUsername;
		_schedBusy = false;
		/** Live decrypt progress (polled by the settings panel). */
		decryptState = {
			op: null,
			active: false,
			done: 0,
			total: 0,
			failed: 0,
			skipped: 0,
			message: ""
		};
		/** Active whisper model download (polled by the settings panel). */
		whisperDownload = null;
		/** Active voice batch transcription (polled by the settings panel). */
		whisperTranscribing = {
			active: false,
			done: 0,
			total: 0,
			failed: 0,
			skipped: 0,
			current: ""
		};
		constructor(ctx) {
			super(ctx, "wechatData");
			this._ctx = ctx;
			this._dirs = resolveDirs();
			this._selfUsername = resolveSelfUsername(this._dirs.decrypted);
			const decrypted = this._dirs.decrypted;
			const rawDbDir = () => {
				const cfg = getConfig(decrypted);
				return typeof cfg["db_dir"] === "string" ? cfg["db_dir"] : "";
			};
			const stopSync = startRealtimeSync(rawDbDir, () => decrypted, (synced) => {
				console.log("[wechat-sync] updated:", synced.join(", "));
				invalidateWechatMeta();
				try {
					ctx.emit("wechat-data/updated", synced);
				} catch {}
			});
			ctx.effect(() => stopSync, "wechat-data: realtime sync");
			const schedTimer = setInterval(() => {
				this.maybeRunDueTasks();
			}, 3e4);
			ctx.effect(() => () => {
				clearInterval(schedTimer);
			}, "wechat-data: summary scheduler");
		}
		/**
		* Append one operation-log row. Metadata only — never message bodies or
		* image/file contents — so an export stays safe to share. Best-effort: a
		* logging failure never affects the operation it records.
		*/
		op(category, action, status, target = "", detail = "") {
			recordOperation(this._dirs.decrypted, {
				category,
				action,
				target,
				status,
				detail
			});
		}
		/**
		* 「出站拦截」是否已开启；开启时返回给用户看的说明，否则 null。
		*
		* 为什么要单独有这个提前检查：出站调用点前面还有「未配置默认模型」这类早退分支，
		* 不开拦截时它是对的；但用户先把「禁止 AI 出网」打开、再点每日总结时，早退分支会先返回
		* 「AI 不可用（未配置默认模型）」，把隐私拦截真实生效这件事盖掉（第 59 轮实测踩到）。
		* @param feature - 功能名，出现在提示文案里。
		* @returns 提示文案，或 null。
		*/
		privacyBlocked(feature) {
			try {
				return readPrivacySettings(this._dirs.decrypted).blockOutbound ? `隐私设置已开启「出站拦截」，已阻止「${feature}」把数据发送给模型` : null;
			} catch {
				return null;
			}
		}
		/**
		* 隐私闸门：**所有**出站 LLM 调用都必须先过这里（第 59 轮）。
		*
		* 背景：`readPrivacySettings` / `recordPrivacyAudit` 原本**谁都没调用** ——
		* 「出站拦截」「敏感字段脱敏」两个开关只写进 sqlite 就没人读，`privacy_audit`
		* 表实测 0 行（bundle 里连 INSERT 都没有）。收敛成一个方法，四处出站调用统一走它。
		* @param feature - 审计里的功能名。
		* @param stats - 本次出站涉及的数据量（会话数、消息数）。
		* @param texts - 即将发出去的文本；开启脱敏时返回脱敏后的副本。
		* @returns 允许出站 `{ok:true,texts}`；被拦截 `{ok:false,error}`。
		*/
		privacyGate(feature, stats, texts) {
			const blocked = this.privacyBlocked(feature);
			if (blocked !== null) return {
				ok: false,
				error: blocked
			};
			const settings = readPrivacySettings(this._dirs.decrypted);
			const out = settings.redactSensitive ? texts.map(redactSensitiveText) : texts;
			const chars = out.reduce((a, t) => a + t.length, 0);
			recordPrivacyAudit(this._dirs.decrypted, feature, chars, stats.sessions, stats.messages);
			return {
				ok: true,
				texts: out
			};
		}
		/**
		* Session list (search/filter/limit).
		* @param options - Filter options: keyword fuzzy search, limit max rows.
		* @returns SessionsSnapshot: sessions list (items + total).
		*/
		getSessions(options) {
			return querySessions(this._dirs.decrypted, options?.keyword, options?.limit, options?.offset);
		}
		/**
		* Contact book.
		* @param options - Optional page size + offset for incremental loading.
		* @returns ContactsSnapshot: contacts list (items + total) + per-category stats.
		*/
		getContacts(options) {
			return queryContacts(this._dirs.decrypted, options);
		}
		/**
		* One-screen data overview.
		* @returns OverviewSnapshot: aggregate counts for the overview screen.
		*/
		getOverviewInsights() {
			return queryOverviewInsights(this._dirs.decrypted, this._selfUsername);
		}
		getOverview() {
			return queryOverview(this._dirs.decrypted);
		}
		/**
		* Friend-region map (世界板块地图): world → country → province → city → friends.
		* @returns RegionMapSnapshot.
		*/
		getRegionMap() {
			return queryRegionMap(this._dirs.decrypted);
		}
		/**
		* Records (revokes/transfers/redpackets/finder/miniprograms/friendverifications).
		* @param options - Record kind to query plus pagination/filter options.
		* @returns RecordsSnapshot: record items (items + total).
		*/
		getRecords(options) {
			return queryRecords(this._dirs.decrypted, options.kind, options.limit, options.offset, options.q, options);
		}
		/**
		* Contact / group-member search.
		* @param options - search term, optional limit and room scope.
		* @returns MemberSearchSnapshot: matching members (items + total + source).
		*/
		searchMembers(options) {
			return searchMembers(this._dirs.decrypted, options.q, options);
		}
		/**
		* Revoked messages.
		* @param options - Optional limit for the number of rows returned.
		* @returns RevokedSnapshot: revoked message items.
		*/
		getRevoked(options) {
			return queryRevoked(this._dirs.decrypted, options?.limit, options?.offset);
		}
		/**
		* Custom emoticons.
		* @param options - Optional limit/offset for incremental loading.
		* @returns EmoticonsSnapshot: emoticon items.
		*/
		getEmoticons(options) {
			return queryEmoticons(this._dirs.decrypted, options?.limit, options?.offset);
		}
		/**
		* Storage stats.
		* @returns StorageSnapshot: per-category storage usage stats.
		*/
		getStorageStats() {
			return queryStorageStats(this._dirs.decrypted, rawWechatBase(this._dirs.decrypted) || void 0);
		}
		/**
		* Annual years.
		* @returns AnnualSnapshot: available yearly overview data.
		*/
		getAnnual() {
			return queryAnnual(this._dirs.decrypted);
		}
		/**
		* WeChat config summary.
		* @returns ConfigSnapshot: current WeChat config summary.
		*/
		getWechatConfig() {
			return queryWechatConfig(this._dirs.decrypted);
		}
		/**
		* Privacy scan.
		* @returns PrivacySnapshot: privacy scan result.
		*/
		getPrivacyScan() {
			return queryPrivacyScan(this._dirs.decrypted);
		}
		/**
		* Relationship graph.
		* @returns GraphSnapshot: chat relationship graph data.
		*/
		getGraph() {
			return queryGraph(this._dirs.decrypted, this._selfUsername);
		}
		/**
		* Moments page.
		* @param options - Pagination (offset/limit) and optional author filter.
		* @returns MomentsSnapshot: moments items (items + total).
		*/
		getMoments(options) {
			return queryMoments(this._dirs.decrypted, options?.offset, options?.limit, options?.author, this._selfUsername);
		}
		/**
		* Return the current account's own WeChat username (user_name).
		* @returns { username } - used by the panel to filter "我" authored comments.
		*/
		getSelfUsername() {
			return { username: this._selfUsername };
		}
		/**
		* Full-history author activity counts (ranked desc).
		* @returns Array of { name, count } for every moments author.
		*/
		getMomentsAuthors() {
			return queryMomentsAuthors(this._dirs.decrypted);
		}
		/**
		* Favorites list.
		* @param options - Optional limit for the number of rows returned.
		* @returns FavoritesSnapshot: favorite items (items + total).
		*/
		getFavorites(options) {
			return queryFavorites(this._dirs.decrypted, options?.limit, options?.offset);
		}
		/**
		* Resource files.
		* @param options - Optional limit/offset for incremental loading.
		* @returns FilesSnapshot: resource file items.
		*/
		getFiles(options) {
			return queryFiles(this._dirs.decrypted, options?.limit, options?.offset, options?.category);
		}
		/**
		* Messages of one talker.
		* @param options - Talker username, optional limit and pagination cursor.
		* @returns MessagesSnapshot: message items for the talker.
		*/
		getMessages(options) {
			return queryMessages(this._dirs.decrypted, options.talker, options.limit, options.cursor, this._selfUsername, options.cursorLocalId);
		}
		/**
		* Incremental messages newer than a sort_seq watermark (real-time polling).
		* @param options - talker, after watermark, optional limit.
		* @returns MessagesSnapshot with only the newer messages.
		*/
		getNewMessages(options) {
			return queryNewMessages(this._dirs.decrypted, options.talker, options.after, options.limit, this._selfUsername);
		}
		/**
		* Search index status.
		* @returns SearchIndexStatus: whether the FTS5 index exists and its row count.
		*/
		getSearchIndexStatus() {
			return getSearchIndexStatus(this._dirs.decrypted);
		}
		/**
		* Build (or rebuild) the FTS5 message search index.
		* @param options - force: rebuild even when the index already exists.
		* @returns SearchBuildResult: build outcome with row counts.
		*/
		buildSearchIndex(options) {
			try {
				const r = buildSearchIndex(this._dirs.decrypted, options?.force);
				this.op("sync", "build_search_index", r.status === "ok" ? "ok" : "skip", "", r.message ?? `rows=${r.rows ?? 0}`);
				return r;
			} catch (e) {
				this.op("sync", "build_search_index", "fail", "", e.message);
				throw e;
			}
		}
		/**
		* Full-text search over text messages (index first, scan fallback).
		* @param options - query string, optional result limit and optional talker scope.
		* @returns SearchSnapshot: matched message items.
		*/
		searchMessages(options) {
			return searchIndexMessages(this._dirs.decrypted, options.query, options.limit, options.username);
		}
		/**
		* Group chat info (群聊信息): name/remark, announcement, own alias, member
		* grid and local settings mirror.
		* @param options - chatroom username.
		* @returns GroupInfoSnapshot: the group (null when unknown).
		*/
		getGroupInfo(options) {
			return queryGroupInfo(this._dirs.decrypted, options.username, this._selfUsername);
		}
		/**
		* Resolve a nested merged chat-log pointer by server_id.
		* @param options - the record's fromnewmsgid (server_id) value.
		* @returns ChatHistoryResolveResult: found flag plus the parsed message.
		*/
		/**
		* Authoritative transfer/redpacket status by message server_id.
		* @param options - the message server_id (string, may exceed 2^53).
		* @returns PaymentStatus: found flag plus authoritative fields.
		*/
		getPaymentStatus(options) {
			return queryPaymentStatus(this._dirs.decrypted, options.serverId);
		}
		resolveChatHistory(options) {
			return queryMessageByServerId(this._dirs.decrypted, options.serverId);
		}
		/**
		* Per-day message counts for one month (chat calendar heatmap).
		* @param options - username, year and month to aggregate.
		* @returns CalendarSnapshot: per-day message counts.
		*/
		getDailyCounts(options) {
			return getDailyCounts(this._dirs.decrypted, options.username, options.year, options.month);
		}
		/**
		* Look up one voice message (silk decode degrades in Node).
		* @param options - username and localId of the voice message.
		* @returns VoiceInfoResult: voice metadata / decoded file info.
		*/
		getVoiceInfo(options) {
			return resolveVoiceInfo(this._dirs.decrypted, options.username, options.localId);
		}
		/**
		* Look up one video message (cover thumbnail + degradation).
		* @param options - username and localId of the video message.
		* @returns VideoInfoResult: video cover/thumbnail info.
		*/
		getVideoInfo(options) {
			return resolveVideoInfo(this._dirs.decrypted, this._dirs.decoded, options.username, options.localId);
		}
		/**
		* Export a conversation messages to txt/csv/excel/html.
		* @param options - username, export format and optional message count.
		* @returns ExportResult: exported file path/count info.
		*/
		exportSessionMessages(options) {
			try {
				const r = exportSessionMessages(this._dirs.decrypted, options.username, options.format, options.count, options.dir, options.types, options.richTypes, options.from, options.to, options.filename, options.zip);
				this.op("export", "export_session_messages", "ok", options.username, `共 ${r.count} 条`);
				return r;
			} catch (e) {
				this.op("export", "export_session_messages", "fail", options.username, e.message);
				throw e;
			}
		}
		/**
		* AI Q&A over WeChat data: retrieve context + DSH LLM answer with citations.
		* @param options - question to ask over the WeChat data.
		* @returns AskResult: LLM answer with citations.
		*/
async askWechat(options) {
	const ctx = this._ctx;
	// 先判「出站拦截」：它比「未配置模型」更该被用户看到（见 privacyBlocked 的注释）
	const blockedAsk = this.privacyBlocked("ask_wechat");
	if (blockedAsk !== null) {
		this.op("task", "ask_wechat", "skip", "", blockedAsk);
		throw new Error(blockedAsk);
	}
	const sel = ctx.agentDefaultModel?.currentSelection();
	if (!sel || !sel.provider || !sel.model) {
		this.op("task", "ask_wechat", "fail", "", "未配置默认模型（agentDefaultModel）");
		throw new Error("未配置默认模型（agentDefaultModel），无法调用 AI 问答");
	}
	// 检索范围：会话范围 / 时间范围必须真的参与检索。
	// 从前这里只传 question，用户选了「会话范围」也仍然全库检索（本次修复）。
	const scope = {
		username: typeof options.username === "string" && options.username ? options.username : void 0,
		from: typeof options.from === "string" && options.from ? options.from : void 0,
		to: typeof options.to === "string" && options.to ? options.to : void 0
	};
	// 多轮：最多携带最近 16 条（8 轮），单条截断 2000 字，防止 prompt 无限膨胀。
	// 多轮：最多携带最近 16 条（8 轮），并按**总字数预算**截断 ——
	// 单条截断不够：8 轮长回答各 2000 字会把 prompt 撑到 1.6 万字，把检索结果挤到末尾。
	const history = (Array.isArray(options.history) ? options.history : [])
		.filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
		.slice(-16);
	const HISTORY_BUDGET = 4000;
	let historyUsed = 0;
	const trimmedHistory = [];
	for (const m of [...history].reverse()) {
		const room = HISTORY_BUDGET - historyUsed;
		if (room <= 80) break;
		const text = m.content.trim().slice(0, Math.min(m.role === "assistant" ? 1200 : 400, room));
		trimmedHistory.unshift({ role: m.role, content: text });
		historyUsed += text.length;
	}
	const llm = ctx.llm;
	/**
	 * 跑一次对话。`onDelta` 存在时，把**已生成的全文**在生成过程中回传 ——
	 * 传全文而不是增量片段：渲染进程只需整体替换，丢一两个事件也不会串行错乱。
	 */
	const runChat = async (system, userText, maxTokens, onDelta) => {
		const assembler = new BlockAssembler();
		const opts = {
			provider: sel.provider,
			model: sel.model,
			messages: [createUserMessage({
				content: [{ type: "text", text: userText }],
				source: { kind: "plugin", plugin: "dsh-wechat-data" }
			})],
			system,
			maxTokens
		};
		let acc = "";
		let emitted = false;
		for await (const chunk of llm.stream(opts)) {
			assembler.push(chunk);
			if (onDelta && chunk.type === "text-delta" && typeof chunk.text === "string") {
				acc += chunk.text;
				emitted = true;
				onDelta(acc);
			}
		}
		// 厂商不支持 SSE 时 stream() 只 yield 一次完整 text-delta，上面已覆盖；
		// 若一个 delta 都没拿到（极端情况），最后补发一次完整文本，保证界面不会空着。
		if (onDelta && !emitted) {
			const finalText = assembler.blocks().map((b) => b.type === "text" ? b.text : "").join("").trim();
			if (finalText) onDelta(finalText);
		}
		return assembler.blocks().map((b) => b.type === "text" ? b.text : "").join("").trim();
	};
	/**
	 * 构造「回答增量」事件推送器（80ms 节流：每个增量都要跨 IPC → setState，
	 * 模型一秒吐几十个 delta，不节流会把开销压到生成本身上）。
	 */
	const makeDeltaEmitter = (streamId) => {
		const id = typeof streamId === "string" ? streamId.slice(0, 64) : "";
		if (!id) return void 0;
		let last = 0;
		return (text) => {
			const now = Date.now();
			if (now - last < 80) return;
			last = now;
			try {
				ctx.emit("wechat-ask/delta", { id, text });
			} catch {}
		};
	};
	// ── 第 1 步：意图分析与拆解（LLM → JSON 规划） ──
	// 规划器同时负责**把相对时间换算成绝对日期**（「上周三」→ 2026-09-02）与
	// **点名的人**（「李四」）—— 旧实现只取 subQueries，这两个线索全丢，
	// 于是「上周三我和李四聊了什么」只能靠通用词在全库瞎撞。
	const today = /* @__PURE__ */ new Date();
	const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
	const weekday = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][today.getDay()];
	const scopeDesc = "会话=" + (scope.username ?? "全部") + (scope.from ? "，起始=" + scope.from : "") + (scope.to ? "，截止=" + scope.to : "");
	const historyBrief = trimmedHistory.length > 0 ? "\n对话历史（最近）：\n" + trimmedHistory.map((m) => (m.role === "user" ? "用户：" : "助手：") + m.content.slice(0, 300)).join("\n") : "";
	const planPrompt = `今天是 ${todayStr}（${weekday}）。\n用户问题：${options.question}\n当前筛选范围：${scopeDesc}${historyBrief}\n\n请输出 JSON（不要输出其他内容）。`;
	const gatePlan = this.privacyGate("ask_wechat", { sessions: 0, messages: 0 }, [planPrompt]);
	if (!gatePlan.ok) {
		this.op("task", "ask_wechat", "skip", "", gatePlan.error);
		throw new Error(gatePlan.error);
	}
	let plan;
	try {
		const planText = await runChat("你是微信本地聊天记录的检索规划器。任务：分析用户问题，输出**检索关键词**与**隐含条件**。要求：① subQueries 给 1-4 个真正有区分度的中文关键词或短语（人名、事物、动作、专有名词），不要输出「什么/怎么/我的/给我/最近/一次」这类疑问词、停用词或泛化时间词；② 问题里出现相对时间（上周三/昨天/上个月）时，按给定的今天日期换算成绝对日期填 from/to（YYYY-MM-DD，单日则 from=to），识别不出就留空字符串；③ 问题点名了某个人就填 person，否则留空字符串。只输出一行 JSON：{\"intent\":\"一句话意图\",\"subQueries\":[\"关键词1\",\"关键词2\"],\"from\":\"YYYY-MM-DD\",\"to\":\"YYYY-MM-DD\",\"person\":\"人名\"}", gatePlan.texts[0] ?? planPrompt, 512);
		plan = parseAskPlan(planText);
		if (plan.subQueries.length === 0 && options.question.trim()) plan.subQueries = [options.question.trim()];
	} catch (e) {
		// 规划失败不阻断：退化为直接用原问题做 bigram 检索，保证问答始终可用。
		plan = { intent: "（规划失败，直接检索原问题）", subQueries: options.question.trim() ? [options.question.trim()] : [], from: "", to: "", person: "" };
		this.op("task", "ask_wechat", "fail", "intent_plan", e?.message || String(e));
	}
	// ── 第 2 步：多词召回 → 打分排序 → 展开成对话窗口（chunk 级 RAG 检索）──
	// 自建 BM25 索引是「相关度排序」的前提：没有它就得退回 LIKE 扫描，每个词只能看到
	// 按行号倒序的前 20 条（实测 `合同` 全库 4062 条 → 召回率 0.49%）。
	// 全量构建实测 5.4s / 13.5 万条，因此首次提问时自动建一次，之后直接复用。
	const indexStatus = getSearchIndexStatus(this._dirs.decrypted);
	if (!indexStatus.ready) try {
		const built = buildSearchIndex(this._dirs.decrypted, false);
		this.op("task", "ask_wechat", "ok", "build_index", `检索索引 ${built.status} · ${built.rows ?? 0} 条 · ${built.elapsed_ms ?? 0}ms`);
	} catch (e) {
		this.op("task", "ask_wechat", "fail", "build_index", e?.message || String(e));
	}
	const { citations, chunks, terms, stats } = retrieveAskCitations(this._dirs.decrypted, options.question, { subQueries: plan.subQueries, from: plan.from, to: plan.to, person: plan.person }, scope, 24);
	const contextBlock = formatAskContext(citations, { intent: plan.intent, terms, scope: stats.scope, recency: stats.recency, timeHint: stats.timeHint, hintHits: stats.hintHits }, chunks);
	// ── 第 3 步：综合对话历史与检索结果生成回答 ──
	const historyBlock = trimmedHistory.length > 0 ? "此前的对话（保持多轮连贯，但答案必须以本次检索结果为准）：\n" + trimmedHistory.map((m) => (m.role === "user" ? "用户：" : "助手：") + m.content).join("\n") + "\n\n" : "";
	const synthPrompt = `${historyBlock}用户本次问题：${options.question}

${contextBlock}

请按以下要求回答：
1. **结论先行**：第一句直接回答问题（是谁 / 什么时间 / 发生了什么），不要复述检索过程。
2. **逐条标注来源**：每一项事实性陈述后面立刻标注对应的 [n]；多个来源写 [1][3]。
3. **只用材料里的事实**：检索结果里没有的信息一律不要补充，尤其不要凭常识推测人名、金额、日期。
4. **群聊标明发言人**：材料里形如「群名 · 某人」的，回答时写清是谁说的。
5. **证据不足要说明**：只找到部分证据时，先说已确认的部分，再明确说明哪一点在本地记录里没找到；完全没找到时直接说明未检索到，并给出 1-2 条改问建议（换关键词、收窄时间或指定会话）。
6. **时间写绝对日期**（如 2026-09-05），不要写「上周」这类相对表述。
7. 语言用中文，简洁分点，不要罗列所有来源，只引用真正支持结论的。`;
	const gateAnswer = this.privacyGate("ask_wechat", { sessions: new Set(citations.map((c) => c.username)).size, messages: citations.length }, [synthPrompt]);
	if (!gateAnswer.ok) {
		this.op("task", "ask_wechat", "skip", "", gateAnswer.error);
		throw new Error(gateAnswer.error);
	}
	const answer = await runChat("你是本地微信数据助手，基于检索到的聊天记录与对话历史回答用户问题，语言用中文，引用来源用 [n] 标注。", gateAnswer.texts[0] ?? synthPrompt, 1600, makeDeltaEmitter(options.streamId));
	const citedIndexes = parseCitedIndexes(answer, citations.length);
	this.op("task", "ask_wechat", "ok", "", `意图「${plan.intent}」· 关键词 ${terms.length} 个 · 候选 ${stats.candidates} 条 → 窗口 ${stats.chunks} 段（${stats.windowMessages} 条消息）· 回答引用 ${citedIndexes.length} 段${stats.timeHint ? ` · 时间线索 ${stats.timeHint}（命中 ${stats.hintHits}）` : ""}`);
	return {
		answer: answer || "（模型未返回有效回答。可点「优化提问」改写问题，或收窄会话/时间范围后重试。）",
		citations,
		plan: { intent: plan.intent, subQueries: plan.subQueries, from: plan.from, to: plan.to, person: plan.person, terms },
		citedIndexes,
		retrieval: { candidates: stats.candidates, kept: stats.kept, scope: stats.scope, recency: stats.recency, timeHint: stats.timeHint, hintHits: stats.hintHits, chunks: stats.chunks, windowMessages: stats.windowMessages, recall: stats.recall }
	};
}

		/**
* 提问优化：把用户问题改写为更利于本机检索的形式，并给出改进建议。
* 供「微信问答」面板的「优化提问」按钮调用；出站前同样过隐私闸门。
* @param options - question（必填）+ 可选 scope/history 作上下文。
* @returns AskOptimizeResult: optimized（优化后的问题）+ suggestions（改进建议）。
*/
async optimizeAskQuestion(options) {
	const ctx = this._ctx;
	const blocked = this.privacyBlocked("ask_optimize");
	if (blocked !== null) {
		this.op("task", "ask_optimize", "skip", "", blocked);
		throw new Error(blocked);
	}
	const question = String(options?.question || "").trim();
	if (!question) throw new Error("请先输入问题，再进行优化");
	const sel = ctx.agentDefaultModel?.currentSelection();
	if (!sel || !sel.provider || !sel.model) {
		this.op("task", "ask_optimize", "fail", "", "未配置默认模型（agentDefaultModel）");
		throw new Error("未配置默认模型（agentDefaultModel），无法优化提问");
	}
	const scopeDesc = "会话=" + (options.username || "全部") + (options.from ? "，起始=" + options.from : "") + (options.to ? "，截止=" + options.to : "");
	const history = (Array.isArray(options.history) ? options.history : []).filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string").slice(-6);
	const historyBrief = history.length > 0 ? "\n最近对话背景：\n" + history.map((m) => (m.role === "user" ? "用户：" : "助手：") + m.content.slice(0, 200)).join("\n") : "";
	const prompt = "用户原始问题：" + question + "\n当前检索范围：" + scopeDesc + historyBrief + "\n\n请输出 JSON（不要输出其他内容）。";
	const gate = this.privacyGate("ask_optimize", { sessions: 0, messages: 0 }, [prompt]);
	if (!gate.ok) {
		this.op("task", "ask_optimize", "skip", "", gate.error);
		throw new Error(gate.error);
	}
	const assembler = new BlockAssembler();
	for await (const chunk of ctx.llm.stream({
		provider: sel.provider,
		model: sel.model,
		messages: [createUserMessage({
			content: [{ type: "text", text: gate.texts[0] ?? prompt }],
			source: { kind: "plugin", plugin: "dsh-wechat-data" }
		})],
		system: "你是微信聊天记录的提问优化器。把用户问题改写得更清晰、更利于全文检索（保留原意，补充隐含的时间/对象等限定，去掉口语口水词），并给出至多 3 条具体的改进建议。只输出一行 JSON：{\"optimized\":\"优化后的问题\",\"suggestions\":[\"建议1\",\"建议2\"]}",
		maxTokens: 512
	})) assembler.push(chunk);
	const text = assembler.blocks().map((b) => b.type === "text" ? b.text : "").join("").trim();
	const parsed = parseAskOptimize(text);
	const optimized = parsed.optimized || text.slice(0, 300);
	this.op("task", "ask_optimize", "ok", "", optimized.slice(0, 80));
	return { optimized, suggestions: parsed.suggestions };
}
				/**
		* List local WeChat backups.
		* @returns BackupSnapshot: backup entries (items + total).
		*/
		listBackups() {
			return listBackups(this._dirs.decrypted);
		}
		/**
		* Preview a backup's contents (bounded file list) before restore.
		* @param options - backup name.
		* @returns BackupPreviewSnapshot: items + total.
		*/
		previewBackup(options) {
			return previewBackup(this._dirs.decrypted, options.name);
		}
		/**
		* Create a local backup snapshot.
		* @returns BackupMutationResult: ok + backup name, or error.
		*/
		createBackup() {
			try {
				const e = createBackup(this._dirs.decrypted);
				this.op("backup", "create_backup", "ok", e.name);
				return {
					ok: true,
					name: e.name
				};
			} catch (err) {
				this.op("backup", "create_backup", "fail", "", err.message);
				return {
					ok: false,
					error: err.message
				};
			}
		}
		/**
		* Delete one backup by name.
		* @param options - name of the backup to delete.
		* @returns BackupMutationResult: ok, or error on failure.
		*/
		deleteBackup(options) {
			const r = deleteBackup(this._dirs.decrypted, options.name);
			this.op("delete", "delete_backup", r.ok ? "ok" : "fail", options.name, r.error ?? "");
			return r;
		}
		/**
		* Generate a daily chat summary for one date via DSH LLM.
		* @param options - date (YYYY-MM-DD) to summarize.
		* @returns DailySummaryResult: summary text with session/message counts.
		*/
		async generateDailySummary(options) {
			const { lines, count, sessions, total, types, hourly, topSessions } = collectDayMessages(this._dirs.decrypted, options.date);
			// 出站拦截要在这里判：再往下就是「未配置默认模型」的早退分支，它会盖掉拦截提示
			const blockedDay = this.privacyBlocked("daily_summary");
			if (blockedDay !== null) {
				this.op("task", "generate_daily_summary", "skip", options.date, blockedDay);
				return {
					summary: "⛔ " + blockedDay + "\n\n当日统计：共 " + String(total) + " 条消息 / " + String(sessions) + " 个活跃会话。" + (compactDailyDigest(lines) || "\n（当天无文本消息）"),
					date: options.date,
					sessions,
					messages: count,
					total,
					types,
					hourly,
					topSessions
				};
			}
			const ctx = this._ctx;
			const sel = ctx.agentDefaultModel?.currentSelection();
			const useProvider = options.provider && options.provider.trim() ? options.provider.trim() : sel?.provider ?? "";
			let useModel = options.model && options.model.trim() ? options.model.trim() : sel?.model ?? "";
			const llm = ctx.llm;
			if (!options.model && useModel && /vision|-exp/i.test(useModel)) try {
				const ms = await llm.listModels(useProvider);
				const chatModelRe = /chat|flash|pro|v4/i;
				const pick = ms.find((m) => chatModelRe.test(m.id) && !/vision|image|exp/i.test(m.id)) ?? ms.find((m) => !/vision|image|exp/i.test(m.id)) ?? ms[0];
				if (pick && pick.id) useModel = pick.id;
			} catch {}
			if (!useProvider || !useModel) {
				const fallback = "AI 不可用（未配置默认模型或 LLM 服务）。\n\n当日统计：共 " + String(total) + " 条消息 / " + String(sessions) + " 个活跃会话。" + (compactDailyDigest(lines) || "\n（当天无文本消息）");
				this.op("task", "generate_daily_summary", "fail", options.date, "未配置默认模型或 LLM 服务");
				return {
					summary: fallback,
					date: options.date,
					sessions,
					messages: count,
					total,
					types,
					hourly,
					topSessions
				};
			}
			const prompt = "请总结 " + options.date + " 当天的微信聊天内容，输出简洁的中文要点：\n\n" + lines.join("\n");
			const gate = this.privacyGate("daily_summary", {
				sessions,
				messages: count
			}, [prompt]);
			if (!gate.ok) {
				this.op("task", "generate_daily_summary", "skip", options.date, gate.error);
				return {
					summary: "⛔ " + gate.error + "\n\n当日统计：共 " + String(total) + " 条消息 / " + String(sessions) + " 个活跃会话。" + (compactDailyDigest(lines) || "\n（当天无文本消息）"),
					date: options.date,
					sessions,
					messages: count,
					total,
					types,
					hourly,
					topSessions
				};
			}
			const userMsg = createUserMessage({
				content: [{
					type: "text",
					text: gate.texts[0] ?? prompt
				}],
				source: {
					kind: "plugin",
					plugin: "dsh-wechat-data"
				}
			});
			const assembler = new BlockAssembler();
			const opts = {
				provider: useProvider,
				model: useModel,
				messages: [userMsg],
				system: "你是微信每日总结助手，用中文输出简洁的当日聊天要点总结。",
				maxTokens: 1024
			};
			let summary = "";
			try {
				for await (const chunk of llm.stream(opts)) assembler.push(chunk);
				summary = assembler.blocks().map((b) => b.type === "text" ? b.text : "").join("").trim();
			} catch (e) {
				summary = "LLM 调用失败: " + e.message;
			}
			const finalSummary = summary || (lines.length > 0 ? "模型未返回内容（请为默认模型配置 DEEPSEEK_API_KEY 或其它 LLM 密钥）。\n\n当日统计：共 " + String(total) + " 条消息 / " + String(sessions) + " 个活跃会话。" + (compactDailyDigest(lines) || "\n（当天无文本消息）") : "（当天没有可用的文本消息）");
			const ok = !finalSummary.startsWith("LLM 调用失败");
			this.op("task", "generate_daily_summary", ok ? "ok" : "fail", options.date, ok ? `共 ${count} 条消息` : finalSummary.slice(0, 120));
			return {
				summary: finalSummary,
				date: options.date,
				sessions,
				messages: count,
				total,
				types,
				hourly,
				topSessions
			};
		}
		/**
		* List edited messages (optionally for one session).
		* @param options - optional sessionId filter.
		* @returns EditedListSnapshot: edited message records (items + total).
		*/
		listEditedMessages(options) {
			return listEditedMessages(this._dirs.decrypted, options?.sessionId);
		}
		/**
		* Edit one message content (records the original in the edit store).
		* @param options - username, localId and new content.
		* @returns EditMutationResult: ok, or error on failure.
		*/
		editChatMessage(options) {
			const r = editChatMessage(this._dirs.decrypted, options.username, options.localId, options.content);
			this.op("edit", "edit_chat_message", r.ok ? "ok" : "fail", options.username, r.error ?? `localId=${options.localId}`);
			return r;
		}
		/**
		* Restore a message to its original content.
		* @param options - username and localId of the edited message.
		* @returns EditMutationResult: ok, or error on failure.
		*/
		resetEditedMessage(options) {
			const r = resetEditedMessage(this._dirs.decrypted, options.username, options.localId);
			this.op("edit", "reset_edited_message", r.ok ? "ok" : "fail", options.username, r.error ?? `localId=${options.localId}`);
			return r;
		}
		/**
		* Export a data category (contacts/favorites/records/moments) to CSV.
		* @param options - data category kind and optional records sub-kind.
		* @returns ExportResult: exported file path/count info.
		*/
		/**
		* Export the annual report as markdown / html / json.
		* @param options - year, format, optional dir/filename.
		* @returns ExportResult: written file path + filename + count.
		*/
		/**
		* List the daily-summary model provider(s): the default model's provider
		* (the one the user actually configured), clean and unambiguous.
		*/
		listLlmProviders() {
			const ctx = this._ctx;
			let provider = "";
			try {
				provider = (ctx.settings?.get("agent-default-model") ?? {}).provider ?? "";
			} catch {}
			if (!provider) try {
				const adm = this._ctx.agentDefaultModel;
				provider = (adm && adm.currentSelection ? adm.currentSelection() : void 0)?.provider ?? "";
			} catch {}
			if (!provider) return { providers: [] };
			const name = (() => {
				try {
					return (ctx.llm?.listConfigurableProviders().find((p) => p.provider === provider))?.displayName ?? provider;
				} catch {
					return provider;
				}
			})();
			return { providers: [{
				id: provider,
				name
			}] };
		}
		/** List the provider's configured models (from the "设置 → 模型" settings section), falling back to the provider catalog. */
		async listLlmModels(options) {
			const ctx = this._ctx;
			let ns = "";
			let settingsPath = [];
			try {
				const conf = (ctx.llm?.listConfigurableProviders() ?? []).find((p) => p.provider === options.provider);
				if (conf) {
					ns = conf.settingsNs;
					settingsPath = conf.settingsPath;
				}
			} catch {}
			if (ns) try {
				const doc = ctx.settings?.get(ns) ?? {};
				let profile = doc;
				if (settingsPath.length > 0) profile = settingsPath.reduce((acc, k) => {
					return acc[k] ?? {};
				}, doc);
				const ms = profile.models ?? [];
				if (Array.isArray(ms) && ms.length > 0) return { models: ms.map((m) => ({
					id: typeof m === "string" ? m : m.id ?? "",
					name: typeof m === "string" ? m : m.name ?? m.id ?? ""
				})).filter((m) => m.id) };
			} catch {}
			try {
				return { models: (await ctx.llm?.listModels(options.provider) ?? []).map((m) => ({
					id: m.id,
					name: m.name
				})).filter((m) => m.id) };
			} catch {
				return { models: [] };
			}
		}
		exportAnnualReport(options) {
			try {
				const r = exportAnnualReport(this._dirs.decrypted, options.year, options.format, options.dir, options.filename);
				this.op("export", "export_annual_report", "ok", String(options.year), `共 ${r.count} 条`);
				return r;
			} catch (e) {
				this.op("export", "export_annual_report", "fail", String(options.year), e.message);
				throw e;
			}
		}
		/**
		* Export ALL sessions as a single txt ZIP archive (账号归档).
		* @param options - optional dir/filename.
		* @returns ExportResult: written zip path + total messages.
		*/
		exportAllSessions(options) {
			try {
				const r = exportAllSessions(this._dirs.decrypted, options);
				this.op("export", "export_all_sessions", "ok", "", `共 ${r.count} 条`);
				return r;
			} catch (e) {
				this.op("export", "export_all_sessions", "fail", "", e.message);
				throw e;
			}
		}
		/**
		* Export moments (朋友圈) with author + keyword + time filters.
		* @param options - format/username/authorName/q/from/to/dir/filename.
		* @returns ExportResult: written file path + count.
		*/
		exportMoments(options) {
			try {
				const r = exportMoments(this._dirs.decrypted, options);
				this.op("export", "export_moments", "ok", options?.username ?? "", `共 ${r.count} 条`);
				return r;
			} catch (e) {
				this.op("export", "export_moments", "fail", options?.username ?? "", e.message);
				throw e;
			}
		}
		exportCsv(options) {
			try {
				const r = exportCsv(this._dirs.decrypted, options.kind, options.recordsKind);
				this.op("export", "export_csv", "ok", options.kind, `共 ${r.count} 行`);
				return r;
			} catch (e) {
				this.op("export", "export_csv", "fail", options.kind, e.message);
				throw e;
			}
		}
		/**
		* Clear one session draft (decrypted copy only).
		* @param options - username of the session to clear.
		* @returns DraftClearResult: ok, or error on failure.
		*/
		clearSessionDraft(options) {
			const r = clearSessionDraft(this._dirs.decrypted, options.username);
			this.op("delete", "clear_session_draft", r.ok ? "ok" : "fail", options.username, r.error ?? `已清除 ${r.updated} 条草稿`);
			return r;
		}
		/**
		* Clear all session drafts, returning the cleared list.
		* @returns DraftsClearResult: cleared session list (items + total).
		*/
		clearAllSessionDrafts() {
			const r = clearAllSessionDrafts(this._dirs.decrypted);
			this.op("delete", "clear_all_session_drafts", r.ok ? "ok" : "fail", "", r.error ?? `已清除 ${r.count} 个会话草稿`);
			return r;
		}
		/**
		* List daily-summary tasks.
		* @returns SummaryTaskSnapshot: summary tasks (items + total).
		*/
		listSummaryTasks() {
			return listSummaryTasks(this._dirs.decrypted);
		}
		/**
		* Save (insert/update) a daily-summary task.
		* @param options - task payload (id present = update, absent = insert).
		* @returns SummaryTaskMutationResult: ok + id, or error.
		*/
		saveSummaryTask(options) {
			const r = saveSummaryTask(this._dirs.decrypted, options.task);
			this.op("task", "save_summary_task", r.ok ? "ok" : "fail", options.task.groupUsername, r.error ?? `id=${r.id ?? ""}`);
			return r;
		}
		/**
		* Delete a daily-summary task.
		* @param options - id of the task to delete.
		* @returns SummaryTaskMutationResult: ok, or error on failure.
		*/
		deleteSummaryTask(options) {
			const r = deleteSummaryTask(this._dirs.decrypted, options.id);
			this.op("delete", "delete_summary_task", r.ok ? "ok" : "fail", `id=${options.id}`, r.error ?? "");
			return r;
		}
		/**
		* Toggle a daily-summary task enabled state.
		* @param options - task id and the new enabled flag.
		* @returns SummaryTaskMutationResult: ok, or error on failure.
		*/
		toggleSummaryTask(options) {
			const r = toggleSummaryTask(this._dirs.decrypted, options.id, options.enabled);
			this.op("task", "toggle_summary_task", r.ok ? "ok" : "fail", `id=${options.id}`, r.error ?? (options.enabled ? "启用" : "停用"));
			return r;
		}
		/**
		* List generated summary records.
		* @param options - optional taskId filter.
		* @returns SummaryRecordSnapshot: summary records (items + total).
		*/
		listSummaryRecords(options) {
			return listSummaryRecords(this._dirs.decrypted, options?.taskId);
		}
		/**
		* Delete one generated summary record.
		* @param options - id of the record to delete.
		* @returns SummaryTaskMutationResult: ok, or error on failure.
		*/
		deleteSummaryRecord(options) {
			const r = deleteSummaryRecord(this._dirs.decrypted, options.id);
			this.op("delete", "delete_summary_record", r.ok ? "ok" : "fail", `id=${options.id}`, r.error ?? "");
			return r;
		}
		/**
		* Run a summary task: collect the group previous-day messages + LLM summary + record.
		* @param options - id of the task to run.
		* @returns SummaryTaskRunResult: ok + summary + message count, or error.
		*/
		/** Run any enabled daily-summary task whose schedule time matches the current minute. */
		async maybeRunDueTasks() {
			if (this._schedBusy) return;
			this._schedBusy = true;
			try {
				const now = /* @__PURE__ */ new Date();
				const hhmm = String(now.getHours()).padStart(2, "0") + ":" + String(now.getMinutes()).padStart(2, "0");
				const tasks = listSummaryTasks(this._dirs.decrypted).items;
				for (const t of tasks) {
					if (!t.enabled) continue;
					if ((t.scheduleTime || "08:00").slice(0, 5) === hhmm && now.getTime() - Number(t.lastRunAt) > 6e4) await this.runSummaryTask({ id: t.id });
				}
			} catch (e) {
				this.op("error", "summary_scheduler_error", "fail", "", e.message);
			} finally {
				this._schedBusy = false;
			}
		}
		async runSummaryTask(options) {
			const task = listSummaryTasks(this._dirs.decrypted).items.find((t) => t.id === options.id);
			if (!task) return {
				ok: false,
				error: "任务不存在"
			};
			const prev = /* @__PURE__ */ new Date();
			prev.setDate(prev.getDate() - 1);
			const date = `${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, "0")}-${String(prev.getDate()).padStart(2, "0")}`;
			const { lines, count } = collectDayMessages(this._dirs.decrypted, date, 50, task.groupUsername);
			const ctx = this._ctx;
			const llm = ctx.llm;
			const sel = ctx.agentDefaultModel?.currentSelection();
			let summary = "";
			let status = "done";
			let errMsg = "";
			// 拦截优先于「模型不可用」：否则用户开了「禁止 AI 出网」却只看到「LLM/模型不可用」
			const blockedTask = this.privacyBlocked("summary_task");
			if (blockedTask !== null) {
				status = "error";
				errMsg = blockedTask;
			} else if (!sel || !sel.provider || !sel.model) {
				status = "error";
				errMsg = "LLM/模型不可用";
			} else {
				const targets = task.targetUsers.length > 0 ? task.targetUsers.join("、") : "全部成员";
				const formats = {
					brief: "请用简洁的中文概括当天聊天记录的重点，3-5 句话以内，不要分点。",
					detailed: "请对当天聊天记录做详细总结：按主题分点（Markdown 列表），包含关键事件、讨论的话题、达成的共识与结论；只依据记录内容，不编造。",
					bullets: "请用 Markdown 无序列表提炼当天聊天记录的核心要点，每条一句话，控制在 10 条以内。",
					story: "请以第三人称、叙事的方式回顾当天聊天记录：谁和谁聊了什么、发生了什么、有什么进展或插曲，读起来像一篇日记。",
					custom: (task.customPrompt || "").replace(/\{date\}/g, date).replace(/\{group\}/g, task.groupName || task.groupUsername).replace(/\{targets\}/g, targets)
				};
				const fmtPrompt = formats[task.format || "brief"] || formats["brief"] || "";
				const prompt = "群聊【" + task.groupName + "】(" + task.groupUsername + ") " + date + " 的聊天记录如下：\n\n" + lines.join("\n") + "\n\n" + fmtPrompt;
				const gate = this.privacyGate("summary_task", {
					sessions: 1,
					messages: count
				}, [prompt]);
				if (!gate.ok) {
					// 群总结任务不抛错：状态写进任务运行状态与记录里，界面能看到「被隐私设置拦下」
					status = "error";
					errMsg = gate.error;
				} else {
					const userMsg = createUserMessage({
						content: [{
							type: "text",
							text: gate.texts[0] ?? prompt
						}],
						source: {
							kind: "plugin",
							plugin: "dsh-wechat-data"
						}
					});
					const assembler = new BlockAssembler();
					const opts = {
						provider: sel.provider,
						model: sel.model,
						messages: [userMsg],
						system: "你是微信每日总结助手，按要求的格式输出总结。",
						maxTokens: 1024
					};
					try {
						for await (const chunk of llm.stream(opts)) assembler.push(chunk);
						summary = assembler.blocks().map((b) => b.type === "text" ? b.text : "").join("").trim();
					} catch (e) {
						status = "error";
						errMsg = e.message;
					}
				}
			}
			const rec = {
				id: 0,
				taskId: task.id,
				groupUsername: task.groupUsername,
				summaryDate: date,
				summary,
				messageCount: count,
				status,
				error: errMsg,
				createdAt: Date.now()
			};
			saveSummaryRecord(this._dirs.decrypted, rec);
			updateSummaryTaskRunState(this._dirs.decrypted, task.id, Date.now(), status, errMsg);
			const done = status === "done";
			this.op("task", "run_summary_task", done ? "ok" : "fail", task.groupUsername, errMsg || `共 ${count} 条消息`);
			return done ? {
				ok: true,
				summary,
				messageCount: count
			} : {
				ok: false,
				error: errMsg || "生成失败"
			};
		}
		/**
		* Resolve a user avatar (head_image.db data or contact URL).
		* @param options - username to resolve the avatar for.
		* @returns AvatarResult: avatar data URL or fallback info.
		*/
		getAvatar(options) {
			return resolveAvatar(this._dirs.decrypted, options.username, rawWechatBase(this._dirs.decrypted) || void 0, options.nickname);
		}
		/**
		* 批量读取本地头像(head_image.db 单次打开,全部返回 data URL;绝不回退网络)。
		* @param options - usernames 列表。
		* @returns username → data URL 映射(未命中的不在其中)。
		*/
		getAvatarsLocal(options) {
			return resolveAvatarsLocal(this._dirs.decrypted, options.usernames);
		}
		/**
		* Read the full WeChat config (incl. keys + resolved paths).
		* @returns WechatConfigFull: complete config with resolved paths.
		*/
		getWechatConfigFull() {
			const cfg = getConfig(this._dirs.decrypted);
			const resolved = cfg["resolved"] ?? {};
			return {
				db_dir: cellStr(cfg["db_dir"] ?? ""),
				wechat_process: cellStr(cfg["wechat_process"] ?? "Weixin.exe"),
				key_format: cellStr(cfg["key_format"] ?? "wx_key_v4.1"),
				db_enc_key: cellStr(cfg["db_enc_key"] ?? ""),
				image_aes_key: cellStr(cfg["image_aes_key"] ?? ""),
				image_xor_key: Number(cfg["image_xor_key"] ?? 136),
				api_enabled: Boolean(cfg["api_enabled"] ?? true),
				api_port: Number(cfg["api_port"] ?? 5032),
				api_token: cellStr(cfg["api_token"] ?? ""),
				cdn_enabled: Boolean(cfg["cdn_enabled"] ?? true),
				cdn_local_decrypt: Boolean(cfg["cdn_local_decrypt"] ?? true),
				whisper_device: cfg["whisper_device"] === "gpu" ? "gpu" : "cpu",
				whisper_model: cellStr(cfg["whisper_model"] ?? "medium"),
				whisper_threads: Number(cfg["whisper_threads"] ?? 0),
				whisper_models_dir: cellStr(cfg["whisper_models_dir"] ?? ""),
				whisper_bin: cellStr(cfg["whisper_bin"] ?? ""),
				resolved
			};
		}
		/**
		* Save the WeChat config (merge patch).
		* @param options - patch of config fields to merge.
		* @returns SimpleResult: ok, or error on failure.
		*/
		saveWechatConfig(options) {
			const before = getConfig(this._dirs.decrypted);
			const oldDirRaw = typeof before["whisper_models_dir"] === "string" && before["whisper_models_dir"].trim().length > 0 ? before["whisper_models_dir"] : defaultWhisperModelsDir(this._dirs.decrypted);
			const oldEngine = whisperEnginePath(typeof before["whisper_bin"] === "string" ? before["whisper_bin"] : "", oldDirRaw);
			const res = saveConfig(this._dirs.decrypted, options.patch);
			if (res.ok && typeof options.patch.whisper_models_dir === "string") {
				const newDir = (options.patch.whisper_models_dir ?? "").trim();
				if (newDir && newDir.toLowerCase() !== oldDirRaw.toLowerCase()) {
					migrateWhisperModels(oldDirRaw, newDir);
					const after = getConfig(this._dirs.decrypted);
					const bin = typeof after["whisper_bin"] === "string" ? after["whisper_bin"] : "";
					const relocated = migrateWhisperEngineDir(bin || oldEngine, oldDirRaw, newDir);
					if (relocated && relocated !== (bin || oldEngine)) saveConfig(this._dirs.decrypted, { whisper_bin: relocated });
				}
			}
			this.op("settings", "save_wechat_config", res.ok ? "ok" : "fail", "", res.error ?? "配置已保存");
			return res;
		}
		/**
		* Whisper transcription configuration status: engine detection, CUDA
		* presence, models dir + installed ggml binaries, active download progress
		* (inference itself stays bridge-side).
		* @returns WhisperStatus: engine/hasCuda/models inventory.
		*/
		getWhisperStatus() {
			const cfg = getConfig(this._dirs.decrypted);
			const configured = typeof cfg["whisper_models_dir"] === "string" && cfg["whisper_models_dir"].trim().length > 0 ? cfg["whisper_models_dir"] : defaultWhisperModelsDir(this._dirs.decrypted);
			const engine = whisperEnginePath(typeof cfg["whisper_bin"] === "string" ? cfg["whisper_bin"] : "", configured);
			const result = {
				engine,
				hasCuda: whisperHasCuda(),
				modelsDir: configured,
				models: whisperModelsStatus(configured),
				downloading: this.whisperDownload,
				transcribing: this.whisperTranscribing
			};
			if (engine) result.enginePath = engine;
			return result;
		}
		/**
		* Download one official whisper.cpp ggml model into the models dir
		* (streamed, atomic publish; huggingface.co with hf-mirror fallback).
		* @param options - model id to download.
		* @returns WhisperDownloadResult: ok + file/bytes, or an error.
		*/
		async downloadWhisperModel(options) {
			if (this.whisperDownload !== null) {
				this.op("settings", "download_whisper_model", "fail", options.model, "已有模型下载任务进行中");
				return {
					ok: false,
					error: "已有模型下载任务进行中"
				};
			}
			const cfg = getConfig(this._dirs.decrypted);
			const modelsDir = typeof cfg["whisper_models_dir"] === "string" && cfg["whisper_models_dir"].trim().length > 0 ? cfg["whisper_models_dir"] : defaultWhisperModelsDir(this._dirs.decrypted);
			this.whisperDownload = {
				model: options.model,
				file: "",
				received: 0,
				total: 0
			};
			try {
				const result = await whisperDownloadModel(options.model, modelsDir, (received, total) => {
					if (this.whisperDownload !== null) {
						this.whisperDownload.received = received;
						this.whisperDownload.total = total;
					}
				});
				this.whisperDownload.file = WHISPER_DOWNLOAD_FILES.find(([id]) => id === options.model)?.[1] ?? options.model;
				this.op("settings", "download_whisper_model", result.ok ? "ok" : "fail", options.model, result.error ?? `bytes=${result.bytes ?? 0}`);
				return result;
			} finally {
				this.whisperDownload = null;
			}
		}
		/**
		* Detect installed WeChat 4.x accounts.
		* @returns AccountsSnapshot: detected accounts (accounts + total).
		*/
		detectWechatAccounts() {
			const accounts = detectWechatAccounts();
			const snapshot = {
				accounts,
				total: accounts.length
			};
			const installDir = weixinInstallPath();
			if (installDir) {
				snapshot.install_dir = installDir;
				const version = weixinVersion(installDir);
				if (version) snapshot.version = version;
			}
			this.op("keys", "detect_accounts", "ok", "", `发现 ${snapshot.total} 个账号`);
			return snapshot;
		}
		/**
		* Verify a database key (SQLCipher PBKDF2 + AES + HMAC).
		* @param options - dbPath and encKeyHex of the key to verify.
		* @returns VerifyKeyResult: valid flag plus optional AES/HMAC checks.
		*/
		verifyDatabaseKey(options) {
			const r = verifyDatabaseKey(options.dbPath, options.encKeyHex);
			this.op("keys", "verify_db_key", r.valid ? "ok" : "fail", options.dbPath, r.error ?? (r.valid ? "有效" : "无效"));
			return r;
		}
		/**
		* Verify all DBs in db_dir and write all_keys.json.
		* @param options - dbDir, keysFile, encKeyHex and optional keyFormat.
		* @returns GenerateKeysResult: generation outcome.
		*/
		generateKeysFile(options) {
			const r = generateKeysFile(options.dbDir, options.keysFile, options.encKeyHex, options.keyFormat);
			this.op("keys", "generate_keys_file", r.ok ? "ok" : "fail", options.keysFile, r.error ?? `通过 ${r.verified}/${r.total}`);
			return r;
		}
		/**
		* Read all_keys.json info.
		* @returns KeysInfoResult: key format/count/loaded state.
		*/
		getWechatKeysInfo() {
			return getKeysInfo(this._dirs.decrypted);
		}
		/**
		* Auto-recover the V4 database key from the running WeChat process
		* (key_v4 memory scan + Weixin.dll internal-key unmask).
		* @param options - optional probe db path and install dir.
		* @returns AutoDbKeyResult: ok + 64-hex key, or an error.
		*/
		async autoGetDbKey(options) {
			const r = await fetchDbKey(options);
			this.op("keys", "auto_get_db_key", r.ok ? "ok" : "fail", options.dbPath ?? "", r.error ?? r.source ?? "");
			return r;
		}
		/**
		* Auto-recover the image key (V2-verified): a saved-and-valid config key
		* pair is returned first; otherwise the running WeChat process memory is
		* scanned.
		* @param options - account dir (wxid_* 文件夹或其 db_storage) and optional pid.
		* @returns AutoImageKeyResult: ok + xor/aes pair, or an error.
		*/
		async autoGetImageKey(options) {
			const accountDir = normalizeAccountDir(options.accountDir ?? "");
			if (accountDir && existsSync(accountDir)) {
				const cfg = getConfig(this._dirs.decrypted);
				const savedAes = typeof cfg["image_aes_key"] === "string" ? cfg["image_aes_key"].trim() : "";
				if (savedAes) {
					const scan = scanV2Templates(accountDir);
					if (scan.templates.length > 0) {
						const xor = trustedXorForVerifiedAesKey(savedAes, scan);
						if (xor !== null) {
							const result = {
								ok: true,
								aesKey: savedAes,
								xorKey: xor,
								verified: true
							};
							const template = scan.templates[0];
							if (template) result.templatePath = template.path;
							this.op("keys", "auto_get_image_key", "ok", accountDir, "使用已保存并验证的图片密钥");
							return result;
						}
					}
				}
			}
			const fetchOpts = { accountDir };
			if (options.pid !== void 0) fetchOpts.pid = options.pid;
			const r = await fetchImageKey(fetchOpts);
			this.op("keys", "auto_get_image_key", r.ok ? "ok" : "fail", accountDir, r.error ?? (r.verified ? "内存扫描成功" : ""));
			return r;
		}
		/**
		* Verify the saved image key pair against real V2 templates.
		* @returns VerifyImageKeyResult: verified flag + xor/template evidence.
		*/
		/** Open the owned WeChat config.json (e.g. for manual edit). @returns the opened path. */
		/** Open an owned path (config/output dir/file) with the system default. @returns the opened path. */
		async openPath(options, signal) {
			const p = options.path;
			try {
				await openNativePath(p, signal);
				return {
					ok: true,
					path: p
				};
			} catch {
				return {
					ok: false,
					path: p
				};
			}
		}
		async openConfig(signal) {
			const p = join(this._dirs.decrypted, "..", "config.json");
			try {
				await openNativePath(p, signal);
				return {
					ok: true,
					path: p
				};
			} catch {
				return {
					ok: false,
					path: p
				};
			}
		}
		verifyImageKey() {
			const cfg = getConfig(this._dirs.decrypted);
			const aesKey = typeof cfg["image_aes_key"] === "string" ? cfg["image_aes_key"].trim() : "";
			if (!aesKey) {
				this.op("keys", "verify_image_key", "fail", "", "尚未配置图片 AES 密钥");
				return {
					verified: false,
					error: "尚未配置图片 AES 密钥"
				};
			}
			const rawRoot = rawWechatBase(this._dirs.decrypted);
			if (!rawRoot) {
				this.op("keys", "verify_image_key", "fail", "", "未配置数据库目录，无法定位账号数据");
				return {
					verified: false,
					error: "未配置数据库目录，无法定位账号数据"
				};
			}
			const scan = scanV2Templates(rawRoot);
			if (scan.templates.length === 0) {
				this.op("keys", "verify_image_key", "fail", "", "未找到 V2 图片模板（_t.dat）");
				return {
					verified: false,
					error: "未找到 V2 图片模板（_t.dat）"
				};
			}
			const xor = trustedXorForVerifiedAesKey(aesKey, scan);
			const result = {
				verified: xor !== null,
				aesKey,
				xorKey: xor ?? Number(cfg["image_xor_key"] ?? 0)
			};
			const template = scan.templates[0];
			if (template) result.templatePath = template.path;
			this.op("keys", "verify_image_key", result.verified ? "ok" : "fail", "", result.error ?? (result.verified ? "已通过" : "验证失败"));
			return result;
		}
		/**
		* Full SQLCipher decryption: every .db under db_storage is re-decrypted
		* into the decrypted snapshot (逐库原子发布,单库失败不中断)。实时进度
		* 通过 getDecryptStatus 轮询读取。
		* @returns DecryptAllResult: total/ok/failed counts.
		*/
		async decryptAllDatabases() {
			if (this.decryptState.active) {
				this.op("sync", "decrypt_databases", "fail", "", "已有解密任务进行中");
				return {
					ok: false,
					total: 0,
					okCount: 0,
					failed: [],
					error: "已有解密任务进行中"
				};
			}
			const cfg = getConfig(this._dirs.decrypted);
			const rawDbDir = typeof cfg["db_dir"] === "string" ? cfg["db_dir"] : "";
			this.decryptState.op = "databases";
			this.decryptState.active = true;
			this.decryptState.done = 0;
			this.decryptState.total = 0;
			this.decryptState.failed = 0;
			this.decryptState.skipped = 0;
			this.decryptState.message = "";
			try {
				const r = await decryptAllDbs(rawDbDir, this._dirs.decrypted, (done, total, failed, message) => {
					this.decryptState.done = done;
					this.decryptState.total = total;
					this.decryptState.failed = failed;
					this.decryptState.message = message;
				});
				invalidateWechatMeta();
				this.op("sync", "decrypt_databases", r.ok ? "ok" : "fail", "", r.error ?? `成功 ${r.okCount}/${r.total}${r.failed.length > 0 ? `，失败 ${r.failed.length}` : ""}`);
				return r;
			} finally {
				this.decryptState.active = false;
				this.decryptState.message = "";
			}
		}
		/**
		* Batch-decode every md5-prefixed .dat image under msg/attach into the
		* decoded-images cache (并行池,已缓存/HEVC 跳过)。实时进度通过
		* getDecryptStatus 轮询读取。
		* @param options - optional worker concurrency (clamped 1..32).
		* @returns DecryptImagesResult: total/ok/failed/skipped counts.
		*/
		async decryptAllImages(options) {
			if (this.decryptState.active) {
				this.op("sync", "decrypt_images", "fail", "", "已有解密任务进行中");
				return {
					ok: false,
					total: 0,
					okCount: 0,
					failed: 0,
					skipped: 0,
					errors: [],
					error: "已有解密任务进行中"
				};
			}
			const cfg = getConfig(this._dirs.decrypted);
			const aesKey = typeof cfg["image_aes_key"] === "string" ? cfg["image_aes_key"] : void 0;
			const xorKey = Number(cfg["image_xor_key"] ?? 255);
			const rawRoot = rawWechatBase(this._dirs.decrypted);
			if (!rawRoot) {
				this.op("sync", "decrypt_images", "fail", "", "未配置数据库目录，无法定位图片数据");
				return {
					ok: false,
					total: 0,
					okCount: 0,
					failed: 0,
					skipped: 0,
					errors: [],
					error: "未配置数据库目录，无法定位图片数据"
				};
			}
			const concurrency = Math.floor(options.concurrency ?? 8) || 8;
			this.decryptState.op = "images";
			this.decryptState.active = true;
			this.decryptState.done = 0;
			this.decryptState.total = 0;
			this.decryptState.failed = 0;
			this.decryptState.skipped = 0;
			this.decryptState.message = "";
			try {
				const result = await decryptAllImageDats(rawRoot, this._dirs.decoded, aesKey, xorKey, concurrency, (processed, total, failed, message) => {
					this.decryptState.done = processed;
					this.decryptState.total = total;
					this.decryptState.failed = failed;
					this.decryptState.message = message;
				});
				this.decryptState.skipped = result.skipped;
				this.op("sync", "decrypt_images", result.failed === 0 ? "ok" : "fail", "", `成功 ${result.okCount}/${result.total}${result.failed > 0 ? `，失败 ${result.failed}` : ""}`);
				return {
					ok: true,
					...result
				};
			} finally {
				this.decryptState.active = false;
				this.decryptState.message = "";
			}
		}
		/**
		* Live decryption progress snapshot (polled by the settings panel).
		* @returns DecryptStatus: op/done/total/failed/skipped + current item.
		*/
		getDecryptStatus() {
			return {
				op: this.decryptState.op,
				active: this.decryptState.active,
				done: this.decryptState.done,
				total: this.decryptState.total,
				failed: this.decryptState.failed,
				skipped: this.decryptState.skipped,
				message: this.decryptState.message
			};
		}
		/**
		* Download + install the whisper.cpp CLI engine into the models dir
		* (`<modelsDir>/bin/whisper-cli.exe`), persisting the path as whisper_bin.
		* @returns WhisperDownloadResult: ok + path, or an error.
		*/
		async installWhisperEngine() {
			if (this.whisperDownload !== null) {
				this.op("settings", "install_whisper_engine", "fail", "", "已有下载任务进行中");
				return {
					ok: false,
					error: "已有下载任务进行中"
				};
			}
			const cfg = getConfig(this._dirs.decrypted);
			const modelsDir = typeof cfg["whisper_models_dir"] === "string" && cfg["whisper_models_dir"].trim().length > 0 ? cfg["whisper_models_dir"] : defaultWhisperModelsDir(this._dirs.decrypted);
			if (whisperEnginePath(typeof cfg["whisper_bin"] === "string" ? cfg["whisper_bin"] : "", modelsDir)) {
				this.op("settings", "install_whisper_engine", "skip", "", "引擎已存在");
				return {
					ok: true,
					file: "whisper-cli.exe",
					bytes: 0
				};
			}
			this.whisperDownload = {
				model: "engine",
				file: "whisper-bin-x64.zip",
				received: 0,
				total: 0
			};
			try {
				const result = await installWhisperEngine(modelsDir, (received, total) => {
					if (this.whisperDownload !== null) {
						this.whisperDownload.received = received;
						this.whisperDownload.total = total;
					}
				});
				if (result.ok && result.path) saveConfig(this._dirs.decrypted, { whisper_bin: result.path });
				const out = {
					ok: result.ok,
					file: "whisper-cli.exe"
				};
				if (result.error) out.error = result.error;
				this.op("settings", "install_whisper_engine", out.ok ? "ok" : "fail", "", out.error ?? "引擎已安装");
				return out;
			} finally {
				this.whisperDownload = null;
			}
		}
		/**
		* Batch-transcribe the most recent voice messages: silk → WAV (bundled
		* wx_silk) → whisper-cli with the selected model → text cached per message.
		* @param options - optional message count (default 50, clamped 1..200).
		* @returns VoiceTranscribeResult: done/failed/skipped counts.
		*/
		async transcribeVoiceBatch(options) {
			if (this.whisperTranscribing.active) {
				this.op("task", "transcribe_voice_batch", "fail", "", "已有转写任务进行中");
				return {
					ok: false,
					total: 0,
					done: 0,
					failed: 0,
					skipped: 0,
					errors: [],
					engine: "",
					error: "已有转写任务进行中"
				};
			}
			const cfg = getConfig(this._dirs.decrypted);
			const modelsDir = typeof cfg["whisper_models_dir"] === "string" && cfg["whisper_models_dir"].trim().length > 0 ? cfg["whisper_models_dir"] : defaultWhisperModelsDir(this._dirs.decrypted);
			const engine = whisperEnginePath(typeof cfg["whisper_bin"] === "string" ? cfg["whisper_bin"] : "", modelsDir);
			if (!engine) {
				this.op("task", "transcribe_voice_batch", "fail", "", "未检测到 whisper.cpp 引擎");
				return {
					ok: false,
					total: 0,
					done: 0,
					failed: 0,
					skipped: 0,
					errors: [],
					engine,
					error: "未检测到 whisper.cpp 引擎（可在第 5 步点击「下载引擎」，或设 DSH_WECHAT_WHISPER_BIN）"
				};
			}
			const modelId = typeof cfg["whisper_model"] === "string" && cfg["whisper_model"] ? cfg["whisper_model"] : "medium";
			const limit = Math.max(1, Math.min(Math.floor(options.limit ?? 50), 200));
			this.whisperTranscribing = {
				active: true,
				done: 0,
				total: 0,
				failed: 0,
				skipped: 0,
				current: ""
			};
			try {
				const result = await transcribeVoiceBatch(this._dirs.decrypted, this._dirs.decoded, modelsDir, modelId, engine, limit, (done, total, failed, current) => {
					this.whisperTranscribing.done = done;
					this.whisperTranscribing.total = total;
					this.whisperTranscribing.failed = failed;
					this.whisperTranscribing.current = current;
				});
				this.whisperTranscribing.skipped = result.skipped;
				this.op("task", "transcribe_voice_batch", result.ok ? "ok" : "fail", "", result.error ?? `成功 ${result.done}/${result.total}，失败 ${result.failed}`);
				return result;
			} finally {
				this.whisperTranscribing.active = false;
				this.whisperTranscribing.current = "";
			}
		}
		/**
		* Cached transcript for one voice message (if already transcribed).
		* @param options - message username + local_id.
		* @returns VoiceTranscriptResult: text or an error.
		*/
		getVoiceTranscript(options) {
			const svrId = svrIdByChatLocal(this._dirs.decrypted, options.username, options.localId);
			if (!svrId) return { error: "未找到语音消息" };
			const text = cachedTranscript(this._dirs.decoded, svrId);
			return text ? { text } : { error: "尚未转写" };
		}
		/**
		* Transcribe one voice message on demand (chat bubble 语音转文字).
		* @param options - message username + local_id.
		* @returns VoiceTranscribeOneResult: ok + text, or an error.
		*/
		transcribeVoiceMessage(options) {
			if (this.whisperTranscribing.active) {
				this.op("task", "transcribe_voice_message", "fail", options.username, "已有转写任务进行中");
				return {
					ok: false,
					error: "已有转写任务进行中"
				};
			}
			const cfg = getConfig(this._dirs.decrypted);
			const modelsDir = typeof cfg["whisper_models_dir"] === "string" && cfg["whisper_models_dir"].trim().length > 0 ? cfg["whisper_models_dir"] : defaultWhisperModelsDir(this._dirs.decrypted);
			const engine = whisperEnginePath(typeof cfg["whisper_bin"] === "string" ? cfg["whisper_bin"] : "", modelsDir);
			if (!engine) {
				this.op("task", "transcribe_voice_message", "fail", options.username, "未检测到 whisper.cpp 引擎");
				return {
					ok: false,
					error: "未检测到 whisper.cpp 引擎（可在第 5 步点击「下载引擎」）"
				};
			}
			const modelId = typeof cfg["whisper_model"] === "string" && cfg["whisper_model"] ? cfg["whisper_model"] : "medium";
			const r = transcribeOneVoice(this._dirs.decrypted, this._dirs.decoded, modelsDir, modelId, engine, options.username, options.localId);
			this.op("task", "transcribe_voice_message", r.ok ? "ok" : "fail", options.username, r.error ?? "转写成功");
			return r;
		}
		/**
		* Set CDN auto-fetch flag.
		* @param options - enabled: whether CDN auto-fetch is on.
		* @returns SimpleResult: ok, or error on failure.
		*/
		setCdnImageEnabled(options) {
			const r = saveConfig(this._dirs.decrypted, { cdn_enabled: options.enabled });
			this.op("settings", "set_cdn_image_enabled", r.ok ? "ok" : "fail", "", r.error ?? (options.enabled ? "开启" : "关闭"));
			return r;
		}
		/**
		* Set CDN local/service decrypt flag.
		* @param options - localDecrypt: whether decryption runs locally.
		* @returns SimpleResult: ok, or error on failure.
		*/
		setCdnImageLocalDecrypt(options) {
			const r = saveConfig(this._dirs.decrypted, { cdn_local_decrypt: options.localDecrypt });
			this.op("settings", "set_cdn_image_local_decrypt", r.ok ? "ok" : "fail", "", r.error ?? (options.localDecrypt ? "本地解密" : "服务端解密"));
			return r;
		}
		/**
		* Delete favorite items by local_id.
		* @param options - ids of the favorite items to delete.
		* @returns DeleteFavoriteResult: ok + deleted count, or error.
		*/
		deleteFavoriteItems(options) {
			const r = deleteFavoriteItems(this._dirs.decrypted, options.ids);
			this.op("delete", "delete_favorite_items", r.ok ? "ok" : "fail", "", r.error ?? `删除 ${r.deleted} 项`);
			return r;
		}
		/**
		* Compute the annual report for one year (local only).
		* @param options - year to compute the report for.
		* @returns AnnualReport: computed annual report data.
		*/
		getAnnualReport(options) {
			try {
				const r = queryAnnualReport(this._dirs.decrypted, options.year);
				this.op("task", "generate_annual_report", "ok", String(options.year), `共 ${r.total} 条`);
				return r;
			} catch (e) {
				this.op("task", "generate_annual_report", "fail", String(options.year), e.message);
				throw e;
			}
		}
		/**
		* Decrypted DB status summary.
		* @returns DbStatusSnapshot: per-database status summary.
		*/
		getDbStatus() {
			return getDbStatus(this._dirs.decrypted);
		}
		/**
		* Decode one message image to a base64 data URL.
		* @param options - username and localId of the message image.
		* @returns ImageDataUrlResult: base64 data URL or error.
		*/
		getImageDataUrl(options) {
			const base = rawWechatBase(this._dirs.decrypted) || void 0;
			const cfg = getConfig(this._dirs.decrypted);
			const aesKey = typeof cfg["image_aes_key"] === "string" && cfg["image_aes_key"].length > 0 ? cfg["image_aes_key"] : void 0;
			const xorKey = Number(cfg["image_xor_key"] ?? 255);
			return decodeImageDataUrl(this._dirs.decrypted, this._dirs.decoded, options.username, options.localId, base, aesKey, xorKey);
		}
		/**
		* Resolve one SNS (朋友圈) media md5 to an offline base64 data URL
		* from the WeChat cache/<month>/Sns/Img V2-encrypted blobs.
		* @param options - media md5 from the moments XML.
		* @returns ImageDataUrlResult: base64 data URL or error.
		*/
		getSnsImageDataUrl(options) {
			const base = rawWechatBase(this._dirs.decrypted) || void 0;
			const cfg = getConfig(this._dirs.decrypted);
			return resolveSnsImageDataUrl(base, typeof cfg["image_aes_key"] === "string" && cfg["image_aes_key"].length > 0 ? cfg["image_aes_key"] : void 0, Number(cfg["image_xor_key"] ?? 255), options.md5, options.timelineId, options.mediaId);
		}
		getFileImageDataUrl(options) {
			const base = rawWechatBase(this._dirs.decrypted) || void 0;
			const cfg = getConfig(this._dirs.decrypted);
			return decodeFileImageDataUrl(this._dirs.decrypted, this._dirs.decoded, base, options.md5, typeof cfg["image_aes_key"] === "string" && cfg["image_aes_key"].length > 0 ? cfg["image_aes_key"] : void 0, Number(cfg["image_xor_key"] ?? 255));
		}
		/**
		* Resolve a custom emoticon (sticker) md5 to an offline base64 data URL.
		* @param options - emoticon md5 from message XML.
		* @returns ImageDataUrlResult: base64 data URL or error.
		*/
		getEmoticonDataUrl(options) {
			const base = rawWechatBase(this._dirs.decrypted) || void 0;
			const cfg = getConfig(this._dirs.decrypted);
			return decodeEmoticonDataUrl(this._dirs.decrypted, this._dirs.decoded, base, options.md5, typeof cfg["image_aes_key"] === "string" && cfg["image_aes_key"].length > 0 ? cfg["image_aes_key"] : void 0, Number(cfg["image_xor_key"] ?? 255));
		}
		/**
		* Resolve a 公众号 article cover (og:image) to a base64 data URL.
		* @param options - mp.weixin.qq.com article URL.
		* @returns ImageDataUrlResult: base64 data URL or error.
		*/
		async getArticleCover(options) {
			return resolveArticleCoverDataUrl(options.contentUrl, this._dirs.decoded);
		}
		/**
		* Resolve a received message file (msg/file) to a base64 data URL.
		* @param options - original file name from the message card.
		* @returns ImageDataUrlResult: data URL or error.
		*/
		getMessageFile(options) {
			return resolveMessageFileDataUrl(rawWechatBase(this._dirs.decrypted) || void 0, options.fileName);
		}
		/**
		* Add a WeChat task.
		* @param options - title + optional dueAt.
		* @returns TaskMutationResult.
		*/
		addTask(options) {
			const r = insertTask(this._dirs.decrypted, options);
			this.op("task", "add_task", r.ok ? "ok" : "fail", options.title, r.error ?? "");
			return r;
		}
		clearOperationLog() {
			const r = clearOperationLog(this._dirs.decrypted);
			this.op("delete", "clear_operation_log", r.ok ? "ok" : "fail", "", r.ok ? `已清除 ${r.removed} 条` : "清除失败");
			return r;
		}
		clearPrivacyAudit() {
			const r = clearPrivacyAudit(this._dirs.decrypted);
			this.op("delete", "clear_privacy_audit", r.ok ? "ok" : "fail", "", r.ok ? `已清除 ${r.removed} 条` : "清除失败");
			return r;
		}
		async createEncryptedBackup(options) {
			try {
				const entry = await createEncryptedBackup(this._dirs.decrypted, options.password);
				this.op("backup", "create_encrypted_backup", "ok", entry.name);
				return {
					ok: true,
					name: entry.name
				};
			} catch (e) {
				this.op("backup", "create_encrypted_backup", "fail", "", e.message);
				return {
					ok: false,
					error: e.message
				};
			}
		}
		deleteTask(options) {
			const r = deleteTask(this._dirs.decrypted, options.id);
			this.op("delete", "delete_task", r.ok ? "ok" : "fail", `id=${options.id}`, r.error ?? "");
			return r;
		}
		extractTasks(options) {
			const days = options?.days ?? 7;
			const to = /* @__PURE__ */ new Date();
			const from = /* @__PURE__ */ new Date(to.getTime() - days * 864e5);
			const { lines } = collectPeriodMessages(this._dirs.decrypted, from.toISOString().slice(0, 10), to.toISOString().slice(0, 10), 50);
			const re = /(记得|待办|要做|提醒|别忘了|稍后|待处理|deadline)/i;
			let added = 0;
			for (const line of lines) if (re.test(line)) {
				const title = line.trim().slice(0, 60) || "待办";
				if (insertTask(this._dirs.decrypted, { title }).ok) added += 1;
			}
			this.op("task", "extract_tasks", "ok", "", `新增 ${added} 条待办`);
			return {
				ok: true,
				added
			};
		}
		async generatePeriodSummary(options) {
			const { lines, count, sessions, total, types, hourly, topSessions } = collectPeriodMessages(this._dirs.decrypted, options.from, options.to);
			// 同每日总结：拦截要在「未配置默认模型」早退之前判
			const blockedPeriod = this.privacyBlocked("period_summary");
			if (blockedPeriod !== null) {
				this.op("task", "generate_period_summary", "skip", `${options.from}~${options.to}`, blockedPeriod);
				return {
					summary: "⛔ " + blockedPeriod + "\n\n周期统计：共 " + String(total) + " 条消息 / " + String(sessions) + " 个活跃会话。" + (compactDailyDigest(lines) || ""),
					from: options.from,
					to: options.to,
					sessions,
					messages: count,
					total,
					types,
					hourly,
					topSessions
				};
			}
			const ctx = this._ctx;
			const sel = ctx.agentDefaultModel?.currentSelection();
			const useProvider = options.provider && options.provider.trim() ? options.provider.trim() : sel?.provider ?? "";
			let useModel = options.model && options.model.trim() ? options.model.trim() : sel?.model ?? "";
			const llm = ctx.llm;
			if (!options.model && useModel && /vision|-exp/i.test(useModel)) try {
				const ms = await llm.listModels(useProvider);
				const chatModelRe = /chat|flash|pro|v4/i;
				const pick = ms.find((m) => chatModelRe.test(m.id) && !/vision|image|exp/i.test(m.id)) ?? ms.find((m) => !/vision|image|exp/i.test(m.id)) ?? ms[0];
				if (pick && pick.id) useModel = pick.id;
			} catch {}
			if (!useProvider || !useModel) {
				const fallback = "AI 不可用（未配置默认模型或 LLM 服务）。\n\n周期统计：共 " + String(total) + " 条消息 / " + String(sessions) + " 个活跃会话。" + (compactDailyDigest(lines) || "");
				this.op("task", "generate_period_summary", "fail", `${options.from}~${options.to}`, "未配置默认模型或 LLM 服务");
				return {
					summary: fallback,
					from: options.from,
					to: options.to,
					sessions,
					messages: count,
					total,
					types,
					hourly,
					topSessions
				};
			}
			const prompt = "请总结 " + options.from + " 至 " + options.to + " 的微信聊天内容，输出简洁的中文要点：\n\n" + lines.join("\n");
			const gate = this.privacyGate("period_summary", {
				sessions,
				messages: count
			}, [prompt]);
			if (!gate.ok) {
				this.op("task", "generate_period_summary", "skip", `${options.from}~${options.to}`, gate.error);
				return {
					summary: "⛔ " + gate.error + "\n\n周期统计：共 " + String(total) + " 条消息 / " + String(sessions) + " 个活跃会话。" + (compactDailyDigest(lines) || ""),
					from: options.from,
					to: options.to,
					sessions,
					messages: count,
					total,
					types,
					hourly,
					topSessions
				};
			}
			const userMsg = createUserMessage({
				content: [{
					type: "text",
					text: gate.texts[0] ?? prompt
				}],
				source: {
					kind: "plugin",
					plugin: "dsh-wechat-data"
				}
			});
			const assembler = new BlockAssembler();
			const opts = {
				provider: useProvider,
				model: useModel,
				messages: [userMsg],
				system: "你是微信周期总结助手，用中文输出简洁的要点总结。",
				maxTokens: 1024
			};
			let summary = "";
			try {
				for await (const chunk of llm.stream(opts)) assembler.push(chunk);
				summary = assembler.blocks().map((b) => b.type === "text" ? b.text : "").join("").trim();
			} catch (e) {
				summary = "LLM 调用失败: " + e.message;
			}
			const finalSummary = summary || (lines.length > 0 ? "模型未返回内容。\n\n周期统计：共 " + String(total) + " 条消息 / " + String(sessions) + " 个活跃会话。" + (compactDailyDigest(lines) || "") : "（该周期没有可用的文本消息）");
			const ok = !finalSummary.startsWith("LLM 调用失败");
			this.op("task", "generate_period_summary", ok ? "ok" : "fail", `${options.from}~${options.to}`, ok ? `共 ${count} 条消息` : finalSummary.slice(0, 120));
			return {
				summary: finalSummary,
				from: options.from,
				to: options.to,
				sessions,
				messages: count,
				total,
				types,
				hourly,
				topSessions
			};
		}
		getAssetInsights() {
			return queryAssetInsights(this._dirs.decrypted);
		}
		getCalls(options) {
			return queryCalls(this._dirs.decrypted, this._selfUsername, options?.topPeers, options?.recentLimit);
		}
		getContact360(options) {
			return queryContact360(this._dirs.decrypted, options.username);
		}
		getDbHealth() {
			return queryDbHealth(this._dirs.decrypted);
		}
		getGroupInsights(options) {
			return queryGroupInsights(this._dirs.decrypted, options.username);
		}
		getHandoffReminds() {
			return listHandoffReminds(this._dirs.decrypted);
		}
		getLedger(options) {
			return queryLedger(this._dirs.decrypted, options?.month, this._selfUsername);
		}
		getMediaAssets() {
			return queryMediaAssets(this._dirs.decrypted);
		}
		getMomentsInsights(options) {
			return queryMomentsInsights(this._dirs.decrypted, options?.author);
		}
		getMomentsMonthly(options) {
			return queryMomentsMonthly(this._dirs.decrypted, options?.author, options?.authorName);
		}
		getOfficialAssets() {
			return queryOfficialAssets(this._dirs.decrypted);
		}
		getOperationLog(options) {
			return listOperations(this._dirs.decrypted, options);
		}
		getPrivacyAuditRows() {
			return listPrivacyAudit(this._dirs.decrypted);
		}
		getPrivacyState() {
			return getPrivacyStateSnapshot(this._dirs.decrypted);
		}
		getSnsVideoCoverDataUrl(options) {
			return resolveSnsVideoCoverDataUrl(rawWechatBase(this._dirs.decrypted) || void 0, options.md5, options.timelineId, options.mediaId);
		}
		/**
		* Resolve one SNS (朋友圈) video body to an offline base64 data URL so it can
		* be played inline. Returns an error when the cached container is missing.
		* @param options - media md5 from the moments XML (+ optional cache keys).
		* @returns ImageDataUrlResult: base64 data URL or error.
		*/
		getSnsVideoDataUrl(options) {
			return resolveSnsVideoDataUrl(rawWechatBase(this._dirs.decrypted) || void 0, options.md5, options.timelineId, options.mediaId);
		}
		listTasks() {
			return listTasks(this._dirs.decrypted);
		}
		restoreBackup(options) {
			const r = restoreEncryptedBackup(this._dirs.decrypted, options.name, options.password);
			this.op("backup", "restore_backup", r.ok ? "ok" : "fail", options.name, r.path ?? r.error ?? "");
			return r;
		}
		searchUnified(options) {
			return searchUnified(this._dirs.decrypted, options.query, options.limit);
		}
		setPrivacyState(options) {
			try {
				writePrivacySettings(this._dirs.decrypted, options);
				const snapshot = getPrivacyStateSnapshot(this._dirs.decrypted);
				this.op("settings", "set_privacy_state", "ok", "", `脱敏=${options.redactSensitive ?? "不变"}，出站拦截=${options.blockOutbound ?? "不变"}`);
				return snapshot;
			} catch (e) {
				this.op("settings", "set_privacy_state", "fail", "", e.message);
				throw e;
			}
		}
		setTaskStatus(options) {
			const r = setTaskStatus(this._dirs.decrypted, options.id, options.status);
			this.op("task", "set_task_status", r.ok ? "ok" : "fail", `id=${options.id}`, r.error ?? options.status);
			return r;
		}
		syncHandoffTasks() {
			const r = importHandoffTasks(this._dirs.decrypted);
			this.op("task", "sync_handoff_tasks", r.ok ? "ok" : "fail", "", r.error ?? `导入 ${r.added ?? 0} 条`);
			return r;
		}
	};
})();
//#endregion
//#region lib/types/index.js
/**
* Register the WeChat data gateway.
* @param ctx - Cordis context.
*/
function apply(ctx) {
	ctx.plugin(WechatDataGateway);
}
//#endregion
export { WechatDataGateway, apply };


