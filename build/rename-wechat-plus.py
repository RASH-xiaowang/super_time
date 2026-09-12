from pathlib import Path

root = Path(r"D:\super-time-wechat")
old = "私人微信"
new = "微信+"

skip_parts = {"node_modules", "ui-dist", ".git", "build", "dist"}
skip_suffixes = {".map", ".png", ".ico", ".exe", ".dll", ".pak", ".bin", ".dat", ".log"}
skip_prefixes = [root / "src" / "client" / "ui-wechat" / "lib"]

changed = []
for p in root.rglob("*"):
    if not p.is_file():
        continue
    if any(part in skip_parts for part in p.parts):
        continue
    if p.suffix.lower() in skip_suffixes:
        continue
    if any(str(p).startswith(str(sp)) for sp in skip_prefixes):
        continue
    try:
        raw = p.read_bytes()
    except Exception:
        continue
    if b"\x00" in raw[:4096]:
        continue
    enc = "utf-8"
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        try:
            text = raw.decode("gbk")
            enc = "gbk"
        except Exception:
            continue
    if old not in text:
        continue
    count = text.count(old)
    out = text.replace(old, new)
    p.write_bytes(out.encode(enc))
    changed.append(f"{p.relative_to(root)} x{count} ({enc})")

print(f"files changed: {len(changed)}")
for c in changed:
    print(" ", c)
