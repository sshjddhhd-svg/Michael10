"use strict";
const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "journal-dialogue-"));
process.env.BOT_DATA_DIR = dir;
process.env.BOT_ACCOUNT_SLOT = "1";
after(() => fs.rmSync(dir, { recursive: true, force: true }));

// Avoid network/database access, but exercise the real command dispatcher.
function mockModule(name, exports) { const filename = require.resolve(name); require.cache[filename] = { id: filename, filename, loaded: true, exports }; }
mockModule("../src/utils/database", { getOrCreateUser: async () => {}, getOrCreateThread: async () => {}, logCommand: async () => {} });
mockModule("../src/dashboard/server", { getIO: () => null });
mockModule("../src/protection/mqttHealthCheck", { onMqttActivity: () => {} });
const handler = require("../src/handler/handlerEvents");
const journal = require("../src/commands/جريدة");
const store = require("../src/utils/copyMessageStore");
const sent = [];
const api = {
  getCurrentUserID: () => "bot",
  getUserInfo: (id, cb) => cb(null, { [id]: { name: id } }),
  getThreadInfo: (id, cb) => cb(null, { threadName: id }),
  sendMessage: (message, threadID) => { sent.push({ message, threadID }); return Promise.resolve(); },
};
const noop = { config: { name: "ping" }, run: async () => { sent.push({ message: "ping" }); } };
const commands = new Map([["جريدة", journal], ["ping", noop]]);
global.commandPrefix = "/";
global.config = {};
global.isAdmin = id => ["admin", "admin2"].includes(id);
global.isOwner = () => false;
async function receive(body, senderID = "admin", threadID = "one", type = "message") {
  await handler(api, { type, body, senderID, threadID, isGroup: true, messageID: "x" }, commands);
}

test("one-word command waits for the same admin and group; text preserves formatting", async () => {
  global._pendingCopyMessages = new Map(); sent.length = 0;
  await receive("/جريدة");
  assert.match(sent.at(-1).message, /أرسل الآن/);
  await receive("من عضو", "member");
  await receive("من أدمن آخر", "admin2");
  await receive("مجموعة مختلفة", "admin", "two");
  assert.equal(store.get("one"), undefined);
  await receive("/ping");
  assert.equal(sent.at(-1).message, "ping");
  await receive("نص  أول\n\nنص ثانٍ 🕷️", "admin", "one", "message_reply");
  assert.equal(store.get("one"), "نص  أول\n\nنص ثانٍ 🕷️");
  assert.match(sent.at(-1).message, /تم حفظ/);
  await receive("رسالة عادية لاحقة");
  assert.equal(store.get("one"), "نص  أول\n\nنص ثانٍ 🕷️");
});

test("cancel, expiry, empty messages and slash-prefixed text are handled safely", async () => {
  global._pendingCopyMessages = new Map();
  await receive("/جريدة", "admin", "cancel");
  await receive("/الغاء", "admin", "cancel");
  await receive("لا تحفظ", "admin", "cancel");
  assert.equal(store.get("cancel"), undefined);
  await receive("/جريدة", "admin", "expiry");
  global._pendingCopyMessages.set(JSON.stringify(["expiry", "admin"]), Date.now() - 1);
  await receive("لا تحفظ", "admin", "expiry");
  assert.equal(store.get("expiry"), undefined);
  await receive("/جريدة", "admin", "empty");
  await receive("", "admin", "empty");
  assert.match(sent.at(-1).message, /أرسل نص/);
  await receive("/نص غير أمر\nالسطر الثاني", "admin", "empty");
  assert.equal(store.get("empty"), "/نص غير أمر\nالسطر الثاني");
});

test("inline command remains supported and cancels the pending prompt", async () => {
  global._pendingCopyMessages = new Map();
  await receive("/جريدة", "admin", "inline");
  await receive("/جريدة نص  مباشر\nثانٍ", "admin", "inline");
  await receive("رسالة لاحقة", "admin", "inline");
  assert.equal(store.get("inline"), "نص  مباشر\nثانٍ");
});
