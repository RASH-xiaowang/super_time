// src/backend/wechat-data/src/net/rpa-media.ts
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
var RPA_MEDIA_PATH_PREFIX = "/api/rpa-media/";
var RPA_MEDIA_TOKEN_VERSION = "v1";
var RPA_MEDIA_DEFAULT_TTL_MS = 60 * 60 * 1e3;
var RPA_MEDIA_MAX_TTL_MS = 24 * 60 * 60 * 1e3;
var RPA_MEDIA_IMAGE_EXTS = [
  ".jpg",
  ".jpeg",
  ".png",
  ".gif",
  ".webp",
  ".bmp",
  ".avif"
];
var REL_MAX = 300;
function rpaMediaTokenKey(apiToken) {
  return createHash("sha256").update("supertime-rpa-media\0" + apiToken, "utf8").digest();
}
function isSafeRpaMediaRel(rel) {
  if (typeof rel !== "string") return false;
  if (rel === "" || rel.length > REL_MAX) return false;
  if (rel.includes("\\") || rel.includes("\0") || rel.includes(":")) return false;
  if (rel.startsWith("/")) return false;
  for (const seg of rel.split("/")) {
    if (seg === "" || seg === "." || seg === "..") return false;
  }
  const lower = rel.toLowerCase();
  return RPA_MEDIA_IMAGE_EXTS.some((ext) => lower.endsWith(ext));
}
function encodePayload(payload) {
  return Buffer.from(
    JSON.stringify([payload.recordId, payload.expiresAt, payload.rel]),
    "utf8"
  ).toString("base64url");
}
function signingInput(encoded) {
  return RPA_MEDIA_TOKEN_VERSION + "." + encoded;
}
function signRpaMediaToken(key, payload) {
  const encoded = encodePayload(payload);
  const mac = createHmac("sha256", key).update(signingInput(encoded), "utf8").digest().toString("base64url");
  return RPA_MEDIA_TOKEN_VERSION + "." + encoded + "." + mac;
}
function verifyRpaMediaToken(key, token, nowMs) {
  if (typeof token !== "string" || token.length === 0 || token.length > 1024) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [version, encoded, mac] = parts;
  if (version !== RPA_MEDIA_TOKEN_VERSION || encoded === void 0 || mac === void 0) return null;
  if (encoded === "" || mac === "") return null;
  let expected;
  let actual;
  try {
    expected = createHmac("sha256", key).update(signingInput(encoded), "utf8").digest();
    actual = Buffer.from(mac, "base64url");
  } catch {
    return null;
  }
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  if (actual.toString("base64url") !== mac) return null;
  let decoded;
  try {
    decoded = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!Array.isArray(decoded) || decoded.length !== 3) return null;
  const [recordId, expiresAt, rel] = decoded;
  if (typeof recordId !== "number" || !Number.isInteger(recordId) || recordId <= 0) return null;
  if (typeof expiresAt !== "number" || !Number.isInteger(expiresAt)) return null;
  if (!isSafeRpaMediaRel(rel)) return null;
  if (expiresAt <= nowMs) return null;
  if (expiresAt > nowMs + RPA_MEDIA_MAX_TTL_MS) return null;
  return { recordId, expiresAt, rel };
}
function rpaMediaUrl(baseUrl, token) {
  return baseUrl.replace(/\/+$/, "") + RPA_MEDIA_PATH_PREFIX + token;
}
export {
  RPA_MEDIA_DEFAULT_TTL_MS,
  RPA_MEDIA_IMAGE_EXTS,
  RPA_MEDIA_MAX_TTL_MS,
  RPA_MEDIA_PATH_PREFIX,
  RPA_MEDIA_TOKEN_VERSION,
  isSafeRpaMediaRel,
  rpaMediaTokenKey,
  rpaMediaUrl,
  signRpaMediaToken,
  verifyRpaMediaToken
};
