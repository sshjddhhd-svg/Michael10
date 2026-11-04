"use strict";
const { test, after } = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "michael-copy-"));
process.env.BOT_DATA_DIR = testDataDir;
process.env.BOT_ACCOUNT_SLOT = "1";
after(() => fs.rmSync(testDataDir, { recursive: true, force: true }));
const assert = require("node:assert/strict");
const nameLock = require("../src/utils/nameLock");
const nameCommand = require("../src/commands/اسم");
const copy = require("../src/commands/انسخ");
const stop = require("../src/commands/توقف");
const journal = require("../src/commands/جريدة");
const store = require("../src/utils/copyMessageStore");

// Controllable timers let us exercise multi-second schedules instantly.
function fakeTimers(t) {
  const realSet = global.setTimeout, realClear = global.clearTimeout, random = Math.random;
  const timers = new Map(); let id = 0;
  global.setTimeout = (fn, ms) => { const key = ++id; timers.set(key, { fn, ms }); return key; };
  global.clearTimeout = (key) => timers.delete(key);
  t.after(() => { global.setTimeout = realSet; global.clearTimeout = realClear; Math.random = random; });
  return { timers, run(key) { const timer = timers.get(key); assert.ok(timer); timers.delete(key); return timer.fn(); } };
}
async function flush() { for (let i = 0; i < 12; i++) await Promise.resolve(); }
function apiMock() {
  const titles = [], messages = [];
  return { titles, messages, setTitle(name, tid, cb) { titles.push([name, tid]); cb(null); },
    sendMessage(message, tid, cb) { messages.push([message, tid]); if (cb) cb(null); return Promise.resolve(); },
    sendTypingIndicator() { return () => {}; } };
}

test("name lock schedules 5–10 seconds, coalesces changes and can be cancelled", async (t) => {
  const clock = fakeTimers(t); const api = apiMock(); const tid = "name-1";
  global._lockedNames = new Map(); Math.random = () => 0;
  await nameCommand.run({ api, args: ["الثابت"], threadID: tid, isGroup: true });
  nameLock.onNameChange(api, tid, "غيره");
  nameLock.onNameChange(api, tid, "آخر");
  assert.equal(clock.timers.size, 1);
  let [id, timer] = [...clock.timers][0]; assert.equal(timer.ms, 5000);
  clock.run(id); await flush(); assert.deepEqual(api.titles, [["الثابت", tid], ["الثابت", tid]]);
  Math.random = () => 0.999999;
  nameLock.onNameChange(api, tid, "جديد");
  [id, timer] = [...clock.timers][0]; assert.equal(timer.ms, 10000);
  nameLock.unlock(tid); assert.equal(clock.timers.size, 0);
  await flush(); assert.equal(api.titles.length, 2);
});

test("name lock uses latest name and handles a change while restoring", async (t) => {
  const clock = fakeTimers(t); const api = apiMock(); const tid = "name-2";
  global._lockedNames = new Map();
  await nameLock.lock(api, tid, "first");
  nameLock.onNameChange(api, tid, "other");
  await nameLock.lock(api, tid, "second");
  assert.equal(clock.timers.size, 0);
  nameLock.onNameChange(api, tid, "other");
  let finish;
  api.setTitle = (name, id, cb) => { api.titles.push([name, id]); finish = cb; };
  clock.run([...clock.timers.keys()][0]); await flush();
  nameLock.onNameChange(api, tid, "another");
  assert.equal(clock.timers.size, 1);
  finish(null); await flush();
  clock.run([...clock.timers.keys()][0]); await flush();
  assert.deepEqual(api.titles.slice(-2), [["second", tid], ["second", tid]]);
  finish(null); await flush(); nameLock.unlock(tid);
});

test("copy timing is per conversation, validated, and applied at the next schedule", async (t) => {
  const clock = fakeTimers(t); const api = apiMock();
  global._michaelAutoJobs = new Map(); global._copyDelays = new Map(); Math.random = () => 0;
  store.set("a", "النص التجريبي");
  await copy.run({ api, threadID: "a", args: [] });
  let [id, timer] = [...clock.timers][0]; assert.equal(timer.ms, 20000);
  await copy.run({ api, threadID: "a", args: ["وقت", "30"] });
  await copy.run({ api, threadID: "b", args: ["وقت", "0"] });
  assert.equal(global._copyDelays.get("a"), 30); assert.equal(global._copyDelays.has("b"), false);
  assert.equal(clock.timers.get(id).ms, 20000);
  clock.run(id); // timer starts the typing delay
  [id, timer] = [...clock.timers][0]; assert.equal(timer.ms, 2000);
  clock.run(id); await flush();
  [id, timer] = [...clock.timers][0]; assert.equal(timer.ms, 30000);
  await copy.run({ api, threadID: "a", args: ["وقت", "افتراضي"] });
  assert.equal(global._copyDelays.has("a"), false);
  await stop.run({ api, threadID: "a" }); assert.equal(clock.timers.size, 0);
});

test("stopping and restarting during typing cannot revive the old copy job", async (t) => {
  const clock = fakeTimers(t); const api = apiMock();
  global._michaelAutoJobs = new Map(); global._copyDelays = new Map(); Math.random = () => 0;
  store.set("a", "النص التجريبي");
  await copy.run({ api, threadID: "a", args: [] });
  clock.run([...clock.timers.keys()][0]);
  const oldTyping = [...clock.timers.keys()][0];
  await stop.run({ api, threadID: "a" });
  await copy.run({ api, threadID: "a", args: [] });
  const count = api.messages.length;
  clock.run(oldTyping); await flush();
  assert.equal(api.messages.length, count);
  assert.equal(clock.timers.size, 1);
  await stop.run({ api, threadID: "a" });
});

test("failed rename keeps the previous lock and does not falsely confirm success", async (t) => {
  fakeTimers(t); const api = apiMock(); const tid = "name-failure";
  global._lockedNames = new Map();
  await nameLock.lock(api, tid, "original");
  api.setTitle = (_name, _id, cb) => cb(new Error("denied"));
  await nameCommand.run({ api, threadID: tid, args: ["new"], isGroup: true });
  assert.equal(global._lockedNames.get(tid), "original");
  assert.match(api.messages.at(-1)[0], /فشل تغيير الاسم/);
  nameLock.unlock(tid);
});

test("copy delay accepts minute and second suffixes while preserving numeric seconds", async () => {
  const api = apiMock();
  global._copyDelays = new Map();
  for (const [input, expected] of [["5m", 300], ["40s", 40], ["12", 12], ["2M", 120], ["1440m", 86400]]) {
    await copy.run({ api, threadID: "units", args: ["وقت", input] });
    assert.equal(global._copyDelays.get("units"), expected, input);
  }
  for (const input of ["0m", "1441m", "86401s", "5h", "1.5m", "-2s", "3ms", "999999999999999999999m"]) {
    await copy.run({ api, threadID: "units", args: ["وقت", input] });
    assert.equal(global._copyDelays.get("units"), 86400, input);
    assert.match(api.messages.at(-1)[0], /⚠️/);
  }
});

test("configured minute and second delays produce the correct timer durations", async (t) => {
  const clock = fakeTimers(t); const api = apiMock();
  global._copyDelays = new Map(); global._michaelAutoJobs = new Map();
  store.set("minutes", "دقائق"); store.set("seconds", "ثواني");
  await copy.run({ api, threadID: "minutes", args: ["وقت", "5m"] });
  await copy.run({ api, threadID: "seconds", args: ["وقت", "40s"] });
  await copy.run({ api, threadID: "minutes", args: [] });
  await copy.run({ api, threadID: "seconds", args: [] });
  assert.deepEqual([...clock.timers.values()].map(timer => timer.ms), [300000, 40000]);
  await stop.run({ api, threadID: "minutes" });
  await stop.run({ api, threadID: "seconds" });
});

test("copy requires a journal message but timing commands still work", async (t) => {
  const clock = fakeTimers(t); const api = apiMock();
  global._michaelAutoJobs = new Map(); global._copyDelays = new Map();
  await copy.run({ api, threadID: "not-set", args: [] });
  assert.match(api.messages.at(-1)[0], /جريدة/);
  assert.equal(clock.timers.size, 0);
  await copy.run({ api, threadID: "not-set", args: ["وقت", "5m"] });
  assert.equal(global._copyDelays.get("not-set"), 300);
});

test("journal preserves multiline text and isolates conversations", async () => {
  const api = apiMock();
  const original = "السطر الأول  فيه مسافتان\n\nالسطر الثاني 🕷️";
  await journal.run({ api, threadID: "chat-1", body: `/جريدة ${original}`, prefix: "/" });
  await journal.run({ api, threadID: "chat-2", event: { body: "!جريدة رسالة أخرى" }, prefix: "!" });
  assert.equal(store.get("chat-1"), original);
  assert.equal(store.get("chat-2"), "رسالة أخرى");
  await journal.run({ api, threadID: "chat-1", body: "/جريدة \n \t", prefix: "/" });
  assert.equal(store.get("chat-1"), original);
  assert.match(api.messages.at(-1)[0], /اكتب الرسالة/);
  store.reload();
  assert.equal(store.get("chat-1"), original);
});

test("active copy uses the most recently saved message on the next send", async (t) => {
  const clock = fakeTimers(t); const api = apiMock(); Math.random = () => 0;
  global._michaelAutoJobs = new Map(); global._copyDelays = new Map();
  await journal.run({ api, threadID: "live", body: "/جريدة أول نص", prefix: "/" });
  await copy.run({ api, threadID: "live", args: [] });
  await journal.run({ api, threadID: "live", body: "/جريدة نص جديد\nسطر آخر", prefix: "/" });
  clock.run([...clock.timers.keys()][0]);
  clock.run([...clock.timers.keys()][0]); await flush();
  assert.equal(api.messages.at(-1)[0], "نص جديد\nسطر آخر");
  await stop.run({ api, threadID: "live" });
});

test("saved messages survive process reload and are isolated by account", () => {
  const { spawnSync } = require("node:child_process");
  const env = { ...process.env, BOT_DATA_DIR: testDataDir };
  const program = `const s=require('./src/utils/copyMessageStore'); process.stdout.write(JSON.stringify(s.get('chat-1') || null))`;
  const run = slot => spawnSync(process.execPath, ["-e", program], { cwd: path.join(__dirname, ".."), env: { ...env, BOT_ACCOUNT_SLOT: String(slot) }, encoding: "utf8" });
  assert.equal(run(1).stdout, JSON.stringify("السطر الأول  فيه مسافتان\n\nالسطر الثاني 🕷️"));
  assert.equal(run(2).stdout, "null");
});

test("branding maps the old default without changing custom names", () => {
  const { botName } = require("../src/utils/branding");
  assert.equal(botName("jarfis"), "Michael");
  assert.equal(botName(undefined), "Michael");
  assert.equal(botName("اسم خاص"), "اسم خاص");
});

test("invalid saved data is not silently overwritten", async () => {
  const api = apiMock();
  const file = path.join(testDataDir, "copy-messages-1.json");
  const previous = fs.readFileSync(file, "utf8");
  fs.writeFileSync(file, "{bad-json"); store.reload();
  try {
    await journal.run({ api, threadID: "broken", body: "/جريدة رسالة", prefix: "/" });
    assert.match(api.messages.at(-1)[0], /تعذّر حفظ/);
    assert.equal(fs.readFileSync(file, "utf8"), "{bad-json");
  } finally {
    fs.writeFileSync(file, previous); store.reload();
  }
});
