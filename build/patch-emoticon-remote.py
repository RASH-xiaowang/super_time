from pathlib import Path

p = Path(r"D:\super-time-wechat\src\backend\wechat-data\lib\index.js")
text = p.read_text(encoding="utf-8")

# 1) Insert decodeEmoticonDataUrl after decodeFileImageDataUrl function
anchor = "function decodeFileImageDataUrl(decryptedDir, decodedDir, wechatBaseDir, md5, aesKey, xorKey = 255) {"
idx = text.find(anchor)
if idx < 0:
    raise SystemExit("decodeFileImageDataUrl not found")
# find end of that function: next top-level "function " or "\n// " after a closing brace at col 0
# simpler: find the unique return error string after the function
end_marker = 'return { error: "未找到已解密图片（decoded_images/" + m + ".jpg 不存在）" };\n}'
end = text.find(end_marker, idx)
if end < 0:
    raise SystemExit("end of decodeFileImageDataUrl not found")
end += len(end_marker)

decode_fn = r'''

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
'''

if "function decodeEmoticonDataUrl" not in text:
    text = text[:end] + decode_fn + text[end:]

# 2) decorator let
old = "	let _getFileImageDataUrl_decorators;"
new = "	let _getFileImageDataUrl_decorators;\n	let _getEmoticonDataUrl_decorators;"
if "let _getEmoticonDataUrl_decorators" not in text:
    if old not in text:
        raise SystemExit("decorator let not found")
    text = text.replace(old, new, 1)

# 3) decorator assignment
old = '			_getFileImageDataUrl_decorators = [Remote("getFileImageDataUrl")];'
new = '			_getFileImageDataUrl_decorators = [Remote("getFileImageDataUrl")];\n			_getEmoticonDataUrl_decorators = [Remote("getEmoticonDataUrl")];'
if '_getEmoticonDataUrl_decorators = [Remote' not in text:
    if old not in text:
        raise SystemExit("decorator assign not found")
    text = text.replace(old, new, 1)

# 4) __esDecorate block after getFileImageDataUrl
old = '''			__esDecorate(this, null, _getFileImageDataUrl_decorators, {
				kind: "method",
				name: "getFileImageDataUrl",
				static: false,
				private: false,
				access: {
					has: (obj) => "getFileImageDataUrl" in obj,
					get: (obj) => obj.getFileImageDataUrl
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);'''
new = old + '''
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
			}, null, _instanceExtraInitializers);'''
if "name: \"getEmoticonDataUrl\"" not in text:
    if old not in text:
        raise SystemExit("esDecorate block not found")
    text = text.replace(old, new, 1)

# 5) method impl after getFileImageDataUrl
old = '''		getFileImageDataUrl(options) {
			const base = rawWechatBase(this._dirs.decrypted) || void 0;
			const cfg = getConfig(this._dirs.decrypted);
			return decodeFileImageDataUrl(this._dirs.decrypted, this._dirs.decoded, base, options.md5, typeof cfg["image_aes_key"] === "string" && cfg["image_aes_key"].length > 0 ? cfg["image_aes_key"] : void 0, Number(cfg["image_xor_key"] ?? 255));
		}'''
new = old + '''
		/**
		* Resolve a custom emoticon (sticker) md5 to an offline base64 data URL.
		* @param options - emoticon md5 from message XML.
		* @returns ImageDataUrlResult: base64 data URL or error.
		*/
		getEmoticonDataUrl(options) {
			const base = rawWechatBase(this._dirs.decrypted) || void 0;
			const cfg = getConfig(this._dirs.decrypted);
			return decodeEmoticonDataUrl(this._dirs.decrypted, this._dirs.decoded, base, options.md5, typeof cfg["image_aes_key"] === "string" && cfg["image_aes_key"].length > 0 ? cfg["image_aes_key"] : void 0, Number(cfg["image_xor_key"] ?? 255));
		}'''
if "getEmoticonDataUrl(options)" not in text:
    if old not in text:
        raise SystemExit("method impl not found")
    text = text.replace(old, new, 1)

p.write_text(text, encoding="utf-8")
print("patched lib/index.js")
# sanity
for s in ["function decodeEmoticonDataUrl", 'Remote("getEmoticonDataUrl")', "getEmoticonDataUrl(options)"]:
    print(s, "OK" if s in text else "MISSING")
