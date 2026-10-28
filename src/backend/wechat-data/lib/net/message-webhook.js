// src/backend/wechat-data/src/net/message-webhook.ts
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
var MESSAGE_WEBHOOK_PATH_PREFIX = "/api/message-webhook/";
var MESSAGE_WEBHOOK_SERVICE = "message-list";
var MESSAGE_WEBHOOK_VERSION = "1.0";
var MESSAGE_WEBHOOK_API = 1;
function messageWebhookTokenKey(apiToken) {
  return createHash("sha256").update("supertime-message-webhook\0" + apiToken, "utf8").digest();
}
function deriveMessageWebhookToken(apiToken) {
  if (apiToken === "") return "";
  const key = messageWebhookTokenKey(apiToken);
  return createHmac("sha256", key).update("message-webhook-v1", "utf8").digest("base64url");
}
function verifyMessageWebhookToken(apiToken, token) {
  if (apiToken === "" || typeof token !== "string" || token === "") return false;
  const expected = Buffer.from(deriveMessageWebhookToken(apiToken), "utf8");
  const actual = Buffer.from(token, "utf8");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
function messageWebhookUrl(baseUrl, apiToken) {
  const token = deriveMessageWebhookToken(apiToken);
  if (token === "") return "";
  return baseUrl.replace(/\/+$/, "") + MESSAGE_WEBHOOK_PATH_PREFIX + token;
}
export {
  MESSAGE_WEBHOOK_API,
  MESSAGE_WEBHOOK_PATH_PREFIX,
  MESSAGE_WEBHOOK_SERVICE,
  MESSAGE_WEBHOOK_VERSION,
  deriveMessageWebhookToken,
  messageWebhookTokenKey,
  messageWebhookUrl,
  verifyMessageWebhookToken
};
