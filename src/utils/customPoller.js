"use strict";
/**
 * customPoller.js — HTTP fallback poller when MQTT/listen fails
 * Uses api.getThreadList + api.getThreadHistory
 * Compatible with @dongdev/fca-unofficial v4
 */

const chalk  = require("chalk");
const moment = require("moment-timezone");
const nameLock = require("./nameLock");

const ts = () => moment().tz(global.config?.timezone || "Africa/Algiers").format("HH:mm:ss");
const log = {
  info:  (m) => console.log(`${chalk.gray(ts())} ${chalk.cyan("•")} ${m}`),
  ok:    (m) => console.log(`${chalk.gray(ts())} ${chalk.green("✔")} ${m}`),
  warn:  (m) => console.log(`${chalk.gray(ts())} ${chalk.yellow("⚠")} ${chalk.yellow(m)}`),
  error: (m) => console.log(`${chalk.gray(ts())} ${chalk.red("✘")} ${chalk.red(m)}`),
};

// ─── State ────────────────────────────────────────────────────────────────────
let _timer        = null;
let _running      = false;
let _lastSeen     = new Map();  // threadID → lastTimestamp
let _seenMsgIDs   = new Set();  // dedup
let _startTs      = 0;
let _pollInterval = 6000;
let _failCount    = 0;
const MAX_FAILS   = 15;

function stopPoller() {
  if (_timer) { clearTimeout(_timer); _timer = null; }
  _running = false;
}

// ─── getThreadList via standard API ──────────────────────────────────────────
function getThreadList(api) {
  return new Promise((res, rej) => {
    // Try standard getThreadList(limit, timestamp, tags, cb)
    if (typeof api.getThreadList === "function") {
      api.getThreadList(20, null, ["INBOX"], (err, threads) => {
        if (err) return rej(err);
        res(threads || []);
      });
    } else {
      rej(new Error("getThreadList not available on api"));
    }
  });
}

// ─── Thread History ───────────────────────────────────────────────────────────
function getHistory(api, threadID, amount) {
  return new Promise((res, rej) => {
    if (typeof api.getThreadHistory === "function") {
      api.getThreadHistory(threadID, amount, undefined, (err, msgs) => {
        if (err) return rej(err);
        res(msgs || []);
      });
    } else {
      rej(new Error("getThreadHistory not available on api"));
    }
  });
}

// ─── Build fake event from message ───────────────────────────────────────────
function buildEvent(msg, isGroup) {
  return {
    type:        "message",
    senderID:    String(msg.senderID || msg.authorID || ""),
    body:        msg.body || "",
    threadID:    String(msg.threadID),
    messageID:   msg.messageID,
    timestamp:   msg.timestamp,
    attachments: msg.attachments || [],
    isGroup:     !!isGroup,
    mentions:    msg.mentions || {},
    _poll:       true,
  };
}

// ─── Poll once ────────────────────────────────────────────────────────────────
async function pollOnce(api, eventHandler) {
  let threads;
  try {
    threads = await getThreadList(api);
    if (_failCount > 0) {
      log.ok(`Custom Poller استُعيدَ ✔ — ${threads.length} محادثة`);
    }
    _failCount = 0;
  } catch (e) {
    _failCount++;
    const msg = String(e.error || e.message || e);

    // Only log every 5th failure to avoid spam
    if (_failCount % 5 === 1) {
      log.warn(`poller (${_failCount}/${MAX_FAILS}): ${msg.slice(0, 80)}`);
    }

    if (_failCount >= MAX_FAILS) {
      log.error("Poller: فشل متكرر — توقف مؤقت 2 دقيقة ثم إعادة المحاولة");
      stopPoller();
      setTimeout(() => {
        if (!_running) {
          _running = true;
          _failCount = 0;
          log.info("Poller: إعادة تشغيل بعد توقف…");
          scheduleNext(api, eventHandler);
        }
      }, 120000);
    }
    return;
  }

  for (const thread of threads) {
    const tid     = String(thread.threadID);
    // The fallback receives no group events; inspect known names on each poll.
    if (typeof thread.threadName === "string") {
      nameLock.onNameChange(api, tid, thread.threadName);
    }
    const lastT   = _lastSeen.get(tid) || _startTs;
    const threadTs = thread.timestamp ? parseInt(thread.timestamp) : 0;
    if (threadTs <= lastT) continue;

    const isGroup = !!(thread.isGroup || (thread.threadName && thread.threadName !== ""));

    let msgs;
    try { msgs = await getHistory(api, tid, 5); }
    catch { continue; }

    let maxTs = lastT;
    for (const msg of msgs) {
      const msgTs   = parseInt(msg.timestamp) || 0;
      const senderS = String(msg.senderID || msg.authorID || "");

      if (msgTs <= _startTs) continue;
      if (msgTs <= lastT) continue;
      if (_seenMsgIDs.has(msg.messageID)) continue;
      if (senderS === api.getCurrentUserID()) continue;

      _seenMsgIDs.add(msg.messageID);
      if (maxTs < msgTs) maxTs = msgTs;

      const fakeEvent = buildEvent(msg, isGroup);
      try { await eventHandler(api, fakeEvent, global.commands); }
      catch (e) { log.error(`poller handler: ${e.message}`); }
    }

    if (maxTs > lastT) _lastSeen.set(tid, maxTs);
  }

  // Prune seenMsgIDs
  if (_seenMsgIDs.size > 4000) {
    const arr = [..._seenMsgIDs];
    _seenMsgIDs = new Set(arr.slice(-2000));
  }
}

// ─── Schedule next poll ───────────────────────────────────────────────────────
function scheduleNext(api, eventHandler) {
  if (!_running) return;
  _timer = setTimeout(async () => {
    if (!_running) return;
    try { await pollOnce(api, eventHandler); }
    catch (e) { log.error(`poller loop: ${e.message}`); }
    scheduleNext(api, eventHandler);
  }, _pollInterval);
}

// ─── Start Poller ─────────────────────────────────────────────────────────────
function startPoller(api, eventHandler, intervalMs = 6000) {
  stopPoller();

  _running      = true;
  _pollInterval = Math.max(4000, intervalMs);
  _startTs      = Date.now();
  _failCount    = 0;
  _lastSeen.clear();
  _seenMsgIDs.clear();

  log.ok(`Custom Poller نشط ✔ — يفحص كل ${_pollInterval / 1000}s`);

  try {
    const { getIO } = require("../dashboard/server");
    const io = getIO();
    if (io) io.emit("bot-status", {
      status:  "online",
      message: `متصل ✔ Custom Poller (${api.getCurrentUserID()})`,
    });
  } catch (_) {}

  _timer = setTimeout(async () => {
    try { await pollOnce(api, eventHandler); }
    catch (_) {}
    scheduleNext(api, eventHandler);
  }, 2000);
}

module.exports = { startPoller, stopPoller };
