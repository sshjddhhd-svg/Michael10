"use strict";
/**
 * handlerEvents.js — WHITE-V3 Style Event Handler
 * يعالج جميع أنواع الأحداث: رسائل، أحداث مجموعات، تفاعلات، إلخ
 */

const chalk = require("chalk");
const moment = require("moment-timezone");
const { getOrCreateUser, getOrCreateThread, logCommand } = require("../utils/database");
const nameLock = require("../utils/nameLock");

// ─── Helper ───────────────────────────────────────────────────────────────────
const _sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function _randInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }

// ─── Anti-Spam / Flood Map ────────────────────────────────────────────────────
const _spamMap   = new Map(); // senderID → { count, resetAt }
const _warned    = new Set(); // senderIDs warned this window
const SPAM_LIMIT = 8;
const SPAM_WIN   = 10000; // 10s

function checkSpam(senderID) {
  const now = Date.now();
  let entry = _spamMap.get(senderID);
  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + SPAM_WIN };
    _warned.delete(senderID);
  }
  entry.count++;
  _spamMap.set(senderID, entry);
  return {
    exceeded: entry.count > SPAM_LIMIT,
    warned:   _warned.has(senderID),
    setWarn:  () => _warned.add(senderID),
  };
}

// ─── Name Cache ───────────────────────────────────────────────────────────────
const _nc = { u: {}, t: {} };
global._nameCache = _nc;

async function resolveUser(api, uid) {
  if (_nc.u[uid]) return _nc.u[uid];
  try {
    const info = await new Promise((res, rej) =>
      api.getUserInfo(uid, (e, d) => e ? rej(e) : res(d || {})));
    _nc.u[uid] = info[uid]?.name || String(uid);
  } catch { _nc.u[uid] = String(uid); }
  return _nc.u[uid];
}

async function resolveThread(api, tid) {
  if (_nc.t[tid]) return _nc.t[tid];
  try {
    const info = await new Promise((res, rej) =>
      api.getThreadInfo(tid, (e, d) => e ? rej(e) : res(d || {})));
    _nc.t[tid] = info?.threadName || String(tid);
  } catch { _nc.t[tid] = String(tid); }
  return _nc.t[tid];
}

// ─── Console Logger ───────────────────────────────────────────────────────────
const ts = () => moment().tz(global.config?.timezone || "Africa/Algiers").format("HH:mm:ss");
function logMsg(senderName, threadName, body, isGroup, isCmd) {
  const icon  = isGroup ? chalk.blue("👥") : chalk.green("💬");
  const who   = chalk.bold.cyan(senderName);
  const where = isGroup ? chalk.bold.blue(`[${threadName}]`) : chalk.bold.green("DM");
  const prefix = isCmd ? chalk.magenta("⚡CMD ") : "";
  console.log(
    `${chalk.gray(ts())} ${icon} ${where} ${chalk.gray("←")} ${who}: ${prefix}${chalk.white(String(body||"").slice(0,120))}`
  );
}
function logEvent(type, threadName) {
  console.log(`${chalk.gray(ts())} ${chalk.yellow("⚡")} ${chalk.yellow(type)} @ ${chalk.cyan(threadName)}`);
}

// ─── Main Handler ─────────────────────────────────────────────────────────────
module.exports = async function handlerEvents(api, event, commands) {
  if (!event) return;

  const io     = (() => { try { return require("../dashboard/server").getIO(); } catch { return null; } })();
  const prefix = global.commandPrefix || "/";
  const config = global.config || {};

  global._lastActivity = Date.now();
  try { require("../protection/mqttHealthCheck").onMqttActivity(); } catch (_) {}

  // ══ MESSAGE ══════════════════════════════════════════════════════════════════
  if (event.type === "message" || event.type === "message_reply") {
    const { body = "", threadID, senderID, isGroup, messageID } = event;

    // Ignore self
    if (senderID === api.getCurrentUserID()) return;

    // ── Permissions (computed early for lock check) ────────────────────────
    const isOwner = global.isOwner ? global.isOwner(senderID) : String(senderID) === String(global.ownerID);
    const isAdmin = global.isAdmin ? global.isAdmin(senderID) : isOwner || (config.adminIDs||[]).map(String).includes(String(senderID));

    // Resolve names (non-blocking)
    const [senderName, threadName] = await Promise.all([
      resolveUser(api, senderID),
      isGroup ? resolveThread(api, threadID) : Promise.resolve("DM"),
    ]);

    const isCmd = body.startsWith(prefix);
    logMsg(senderName, threadName, body, isGroup, isCmd);

    // Update DB (non-blocking)
    Promise.all([
      getOrCreateUser(senderID, senderName).catch(() => {}),
      isGroup ? getOrCreateThread(threadID, threadName).catch(() => {}) : Promise.resolve(),
    ]);

    const msgData = { senderID, senderName, threadID, threadName, body, isGroup, messageID, timestamp: Date.now() };

    // Buffer message for live dashboard page
    if (typeof global._bufferMsg === "function") global._bufferMsg(msgData);

    // Emit to dashboard
    if (io) io.emit("message", msgData);

    if (!isCmd) return;

    // ── Lock Check ────────────────────────────────────────────────────────────
    const _locked = global._lockedThreads || new Set();
    if ((global._globalLock || _locked.has(threadID)) && !isAdmin) return;

    // ── Command Dispatch ──────────────────────────────────────────────────────
    const args    = body.slice(prefix.length).trim().split(/\s+/);
    const cmdName = args.shift().toLowerCase();
    const cmd     = commands.get(cmdName);
    if (!cmd) return;

    // ── تجاهل تام لأي شخص ليس أدمناً — بدون أي رد ────────────────────────────
    if (!isAdmin) return;

    // Permission checks — commandRoles system
    // ownerOnly is always respected
    if (cmd.config.ownerOnly && !isOwner)
      return api.sendMessage("❌ هذا الأمر للمالك فقط.", threadID);

    // Anti-spam (skip for admins)
    if (!isAdmin) {
      const spam = checkSpam(senderID);
      if (spam.exceeded) {
        if (!spam.warned) {
          spam.setWarn();
          api.sendMessage("⚠️ أنت تستخدم الأوامر بسرعة كبيرة، انتظر قليلاً!", threadID);
        }
        return;
      }
    }

    // Log command
    console.log(`${chalk.gray(ts())} ${chalk.magenta("›")} /${chalk.bold.magenta(cmdName)} | ${chalk.cyan(senderName)} @ ${chalk.cyan(threadName)}`);
    if (io) io.emit("command", { cmdName, senderID, senderName, threadID, threadName, args, timestamp: Date.now() });
    logCommand(senderID, threadID, cmdName, args).catch(() => {});

    // Run command
    // ملاحظة: مؤشر الكتابة يعمل تلقائياً داخل api.sendMessage (humanTyping wrapper)
    // لا حاجة لمحاكاة يدوية هنا — النظام يعمل على مستوى API مباشرةً
    try {
      await cmd.run({
        api, event, args,
        body, threadID, senderID,
        isGroup, isOwner, isAdmin,
        senderName, threadName,
        prefix, config,
        commands,
      });
    } catch (e) {
      console.error(`${chalk.red("✘")} ${cmdName} error: ${e.message}`);
      try { api.sendMessage(`❌ خطأ في الأمر \`${cmdName}\`: ${e.message}`, threadID); } catch (_) {}
    }

  // ══ GROUP EVENT ══════════════════════════════════════════════════════════════
  } else if (event.type === "event") {
    const { threadID, logMessageType, logMessageData } = event;
    // Schedule the lock immediately, without waiting for thread lookup or logging.
    if (logMessageType === "log:thread-name") {
      nameLock.onNameChange(api, threadID, String(logMessageData?.name ?? ""));
    }
    const threadName = await resolveThread(api, threadID).catch(() => threadID);
    logEvent(logMessageType || "group_event", threadName);

    if (io) io.emit("group-event", {
      type: logMessageType,
      threadID, threadName,
      data: logMessageData,
      timestamp: Date.now(),
    });

    // Handle specific group events
    switch (logMessageType) {
      case "log:subscribe": {
        // Someone joined
        const names = (logMessageData?.addedParticipants || []).map(p => p.fullName || p.userFbId).join(", ");
        if (config.groupEvents?.welcomeMessage && names) {
          const msg = config.groupEvents.welcomeMessage.replace("{name}", names).replace("{thread}", threadName);
          setTimeout(() => api.sendMessage(msg, threadID, () => {}), 1500);
        }
        break;
      }
      case "log:unsubscribe": {
        // Someone left
        if (config.groupEvents?.leaveMessage) {
          const leftId = logMessageData?.leftParticipantFbId;
          if (leftId) {
            const leftName = await resolveUser(api, leftId).catch(() => leftId);
            const msg = config.groupEvents.leaveMessage.replace("{name}", leftName).replace("{thread}", threadName);
            setTimeout(() => api.sendMessage(msg, threadID, () => {}), 1500);
          }
        }
        break;
      }

      // ── قفل الكنيات ──────────────────────────────────────────────────────
      case "log:user-nickname": {
        const botUID      = String(api.getCurrentUserID());
        const changer     = String(event.author || logMessageData?.author || "");
        const targetUID   = String(logMessageData?.participant_id || "");
        const newNickname = String(logMessageData?.nickname || "");

        // تجاهل إذا كان البوت هو من غيّر الكنية
        if (changer === botUID) break;

        if (!global._nicknameJobs)  global._nicknameJobs  = new Map();
        if (!global._nickRestoring) global._nickRestoring = new Set();

        if (!global._nicknameJobs.has(threadID)) break;

        // الأدمنز يمكنهم تغيير كنياتهم بحرية — لا إعادة
        if (global.isAdmin && global.isAdmin(changer)) break;

        if (!targetUID) break;

        const restoreKey = `${threadID}:${targetUID}`;
        if (global._nickRestoring.has(restoreKey)) break;

        const lockedNick = global._nicknameJobs.get(threadID);
        if (newNickname === lockedNick) break; // الكنية صحيحة بالفعل

        // جدولة الإعادة بعد 3-8 ثوانٍ عشوائية
        global._nickRestoring.add(restoreKey);
        const delay = _randInt(3000, 8000);

        setTimeout(async () => {
          try {
            await _sleep(_randInt(500, 1500));

            if (!global._nicknameJobs?.has(threadID)) return;

            await new Promise((res, rej) =>
              api.changeNickname(lockedNick, threadID, targetUID, (e) => (e ? rej(e) : res()))
            );
          } catch (_) {}
          setTimeout(() => global._nickRestoring?.delete(restoreKey), 6000);
        }, delay);

        break;
      }
    }

  // ══ TYPING ═══════════════════════════════════════════════════════════════════
  } else if (event.type === "typ") {
    if (io && event.isTyping) io.emit("typing", { from: event.from, threadID: event.threadID });

  // ══ REACTION ═════════════════════════════════════════════════════════════════
  } else if (event.type === "message_reaction") {
    if (io) io.emit("reaction", {
      reaction: event.reaction,
      senderID: event.senderID,
      threadID: event.threadID,
      messageID: event.messageID,
    });
    global._lastActivity = Date.now();

  // ══ UNSEND ═══════════════════════════════════════════════════════════════════
  } else if (event.type === "message_unsend") {
    if (io) io.emit("unsend", {
      senderID: event.senderID,
      threadID: event.threadID,
      messageID: event.messageID,
    });

  // ══ READ RECEIPT ══════════════════════════════════════════════════════════════
  } else if (event.type === "read_receipt") {
    global._lastActivity = Date.now();
  }
};
