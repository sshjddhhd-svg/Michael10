require("dotenv").config({ path: require("path").join(__dirname, "../.env") });

const login    = require("@dongdev/fca-unofficial");
const fs       = require("fs-extra");
const path     = require("path");
const gradient = require("gradient-string");
const chalk    = require("chalk");
const moment   = require("moment-timezone");
const cron     = require("node-cron");

const { initDB }            = require("./utils/database");
const { loadCommands }      = require("./utils/loader");
const { startDashboard, getIO } = require("./dashboard/server");
const { parseCookieInput, cookiesToString, hasMandatory, dedup } = require("./utils/cookieParser");
const checkLiveCookie       = require("./utils/checkLiveCookie");
const getFbstateFromToken   = require("./utils/getFbstateFromToken");
const handlerEvents         = require("./handler/handlerEvents");
const { startPoller, stopPoller } = require("./utils/customPoller");

const { slot: ACCOUNT_SLOT, dataDir, configPath: CONFIG_PATH, accountPath: ACCOUNT_PATH } = require("./utils/paths");
const accountManager = ACCOUNT_SLOT === 1 ? require("./utils/accountManager") : null;
const { botName } = require("./utils/branding");

// ─── Logger ───────────────────────────────────────────────────────────────────
const ts = () => moment().tz(global.config?.timezone || "Africa/Algiers").format("HH:mm:ss");
const log = {
  info:  (msg) => console.log(`${chalk.gray(ts())} ${chalk.cyan("•")} ${msg}`),
  ok:    (msg) => console.log(`${chalk.gray(ts())} ${chalk.green("✔")} ${chalk.green(msg)}`),
  warn:  (msg) => console.log(`${chalk.gray(ts())} ${chalk.yellow("⚠")} ${chalk.yellow(msg)}`),
  error: (msg) => console.log(`${chalk.gray(ts())} ${chalk.red("✘")} ${chalk.red(msg)}`),
};
global.log = log;

// ─── Permissions ──────────────────────────────────────────────────────────────
const isOwner         = id => String(id) === String(global.ownerID);
const isDashboardAdmin = id => isOwner(id) || (global.config?.adminIDs || []).map(String).includes(String(id));
const isAdmin          = id => isDashboardAdmin(id) || (global.config?.subAdminIDs || []).map(String).includes(String(id));
global.isOwner          = isOwner;
global.isDashboardAdmin = isDashboardAdmin;
global.isAdmin          = isAdmin;
// Commands which edit shared admin settings notify the coordinator immediately.
global.syncSharedConfig = () => {
  if (ACCOUNT_SLOT === 1) accountManager?.broadcastConfig();
  else if (process.connected) process.send({ type: "config-changed" });
};

// ─── Stop Current Listener ────────────────────────────────────────────────────
function stopListening() {
  stopPoller();
  // @dongdev v4: stop via api.stopListening()
  try {
    if (global.api && typeof global.api.stopListening === "function") {
      global.api.stopListening(() => {});
    }
  } catch (_) {}
  // Legacy: call the stop function returned by api.listen()
  if (global._currentListener && typeof global._currentListener === "function") {
    try { global._currentListener(); } catch (_) {}
    global._currentListener = null;
  }
  if (global._listenTimer) {
    clearTimeout(global._listenTimer);
    global._listenTimer = null;
  }
  // Stop MQTT client if active
  try {
    if (global.api?.ctx?.mqttClient) {
      global.api.ctx.mqttClient.end(true);
    }
  } catch (_) {}
}

// ─── HTTP Long-Poll Listener (with custom-poller fallback) ───────────────────
function startPolling(api, commands, attempt = 1) {
  if (global.api !== api) return;
  const MAX = 3; // 3 attempts then switch to custom poller
  const io  = getIO();

  log.warn(`HTTP long-poll (محاولة ${attempt}/${MAX})…`);

  let started = false;
  let errored = false;

  const stop = api.listen((err, event) => {
    if (global.api !== api) return;
    if (err) {
      if (errored) return;
      errored = true;
      const msg = String(err.error || err.message || err);
      log.error(`api.listen: ${msg}`);

      if (io) io.emit("bot-status", { status: "degraded", message: `listen خطأ: ${msg}` });

      if (attempt < MAX) {
        const delay = attempt * 8000;
        log.info(`إعادة محاولة Long-Poll بعد ${delay / 1000}s…`);
        setTimeout(() => startPolling(api, commands, attempt + 1), delay);
      } else {
        // Switch to custom poller (no GraphQL dependency)
        log.warn("⚡ التحويل إلى Custom Poller (بدون GraphQL batch)…");
        startPoller(api, handlerEvents, global.config?.pollIntervalMs || 5000);
      }
      return;
    }

    if (!started) {
      started = true;
      log.ok(`api.listen نشط ✔ — UID: ${chalk.bold.green(api.getCurrentUserID())}`);
      if (io) io.emit("bot-status", {
        status:  "online",
        message: `متصل ✔ Long-Poll (${api.getCurrentUserID()})`,
      });
    }

    global._lastActivity = Date.now();
    if (event) handlerEvents(api, event, global.commands).catch(() => {});
  });

  global._currentListener = stop;
}

// ─── MQTT Listener (يُستخدم فقط عند وجود m_sess) ────────────────────────────
function startMqtt(api, commands, attempt = 1) {
  if (global.api !== api) return;
  const MAX   = 4;
  const delay = Math.min(attempt * 8000, 40000);
  const io    = getIO();

  log.info(`MQTT اتصال (محاولة ${attempt}/${MAX})…`);

  let mqttStarted = false;
  let errored     = false;

  // Timeout: إذا لم يتصل MQTT خلال 20 ثانية → HTTP polling
  const timer = setTimeout(() => {
    if (!mqttStarted && global.api === api) {
      log.warn("MQTT timeout — تحويل إلى Long-Poll");
      startPolling(api, commands, 1);
    }
  }, 20000);
  global._listenTimer = timer;

  const stop = api.listenMqtt((err, event) => {
    if (global.api !== api) return;
    if (err) {
      clearTimeout(timer);
      if (errored) return;
      errored = true;

      const msg = String(err.error || err.message || err.type || err);
      log.warn(`MQTT: ${msg}`);

      if (attempt < MAX) {
        log.info(`إعادة محاولة MQTT بعد ${delay / 1000}s…`);
        setTimeout(() => startMqtt(api, commands, attempt + 1), delay);
      } else {
        log.warn("فشل MQTT — تحويل إلى Long-Poll");
        startPolling(api, commands, 1);
      }
      if (io) io.emit("bot-status", { status: "degraded", message: `MQTT: ${msg}` });
      return;
    }

    if (!mqttStarted) {
      mqttStarted = true;
      clearTimeout(timer);
      global._listenTimer = null;
      log.ok(`MQTT متصل ✔ — UID: ${chalk.bold.green(api.getCurrentUserID())}`);
      if (io) io.emit("bot-status", {
        status:  "online",
        message: `متصل ✔ MQTT (${api.getCurrentUserID()})`,
      });
    }

    global._lastActivity = Date.now();
    if (event) handlerEvents(api, event, global.commands).catch(() => {});
  });

  global._currentListener = stop;
}

// ─── Load Cookies from account.txt ────────────────────────────────────────────
async function loadCookies() {
  if (!fs.existsSync(ACCOUNT_PATH)) {
    fs.writeFileSync(ACCOUNT_PATH, "", "utf8");
    return null;
  }
  const raw = fs.readFileSync(ACCOUNT_PATH, "utf8").trim();
  if (!raw) return null;

  const UA = global.config?.userAgent ||
    "Mozilla/5.0 (Linux; Android 12; M2102J20SG) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/101.0.0.0 Mobile Safari/537.36";

  let parsed;
  try { parsed = parseCookieInput(raw); }
  catch (e) { log.error(`تحليل account.txt: ${e.message}`); return null; }

  if (parsed.isToken) {
    log.info("تحويل التوكن إلى كوكيز…");
    try { return dedup(await getFbstateFromToken(parsed.token)); }
    catch (e) { log.error(`توكن: ${e.message}`); return null; }
  }

  const cookies = parsed.cookies;
  if (!cookies.length) { log.error("account.txt فارغ من الكوكيز"); return null; }
  if (!hasMandatory(cookies)) { log.error("c_user أو xs مفقود"); return null; }

  log.info("التحقق من صلاحية الكوكيز عبر mbasic…");
  const valid = await checkLiveCookie(cookiesToString(cookies), UA);
  log.info(valid ? chalk.green("الكوكيز صالحة ✔") : chalk.yellow("تحذير: mbasic لم يتعرف — سنحاول رغم ذلك"));

  return cookies;
}

// ─── SINGLE-LOGIN LOCK (منع تسجيل الدخول المزدوج) ───────────────────────────
let _loginLock = false;
let _loginAgain = false;
global.invalidatePendingLogin = () => { if (_loginLock) _loginAgain = true; };
function finishLogin() {
  _loginLock = false;
  if (_loginAgain) { _loginAgain = false; setImmediate(() => startBot()); }
}

// ─── Main Bot Startup ─────────────────────────────────────────────────────────
async function startBot() {
  if (_loginLock) {
    log.warn("تسجيل دخول جارٍ — ستُعاد المحاولة بعد انتهائه");
    _loginAgain = true;
    return;
  }
  _loginLock = true;

  const io = getIO();
  stopListening();

  // Stop protection systems
  try { require("./protection/stealth").stop(); } catch (_) {}
  try { require("./protection/keepAlive").stop(); } catch (_) {}
  try { require("./protection/mqttHealthCheck").stopHealthCheck(); } catch (_) {}
  for (const name of ["humanReadReceipt", "naturalPresence", "scrollSimulator", "antiDetection", "sessionRefresher", "reactionDelay", "connectionJitter", "duplicateGuard", "typingVariator", "behaviorScheduler"]) {
    try { require(`./protection/${name}`).stop(); } catch (_) {}
  }
  for (const job of global._michaelAutoJobs?.values() || []) clearTimeout(job.timer);
  global._michaelAutoJobs?.clear();
  global._pendingCopyMessages?.clear();
  try { require("./utils/nameLock").clearAll(); } catch (_) {}
  global._nicknameJobs?.clear();
  global._nickRestoring?.clear();
  global.api = null;
  cronTasks.forEach(task => task.stop());
  cronTasks = [];

  if (io) io.emit("bot-status", { status: "connecting", message: "جارٍ تسجيل الدخول…" });

  let cookies;
  try {
    cookies = await loadCookies();
  } catch (e) {
    log.error(`خطأ في تحميل الكوكيز: ${e.message}`);
    cookies = null;
  }

  if (!cookies) {
    log.error("لا توجد كوكيز — ارفع الكوكيز من لوحة التحكم");
    if (io) io.emit("bot-status", { status: "offline", message: "لا توجد كوكيز — ارفع من الداشبورد" });
    finishLogin();
    return;
  }

  // Check if m_sess is present → affects listener choice
  const hasMsess = cookies.some(c => c.key === "m_sess");
  if (!hasMsess) log.info(chalk.yellow("m_sess غير موجود — سيستخدم HTTP Long-Poll (لا MQTT)"));

  const UA = global.config?.userAgent ||
    "Mozilla/5.0 (Linux; Android 12; M2102J20SG) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/101.0.0.0 Mobile Safari/537.36";

  const loginOptions = {
    appState:         cookies,
    forceLogin:       false,
    logLevel:         "silent",
    listenEvents:     true,
    selfListen:       false,
    autoReconnect:    false,
    autoMarkDelivery: false,
    autoMarkRead:     false,
    userAgent:        UA,
  };

  const commands = global.commands;
  let loginAttempt = 0;
  const MAX_LOGIN  = 3;

  function tryLogin() {
    loginAttempt++;
    login(loginOptions, async (err, api) => {
      if (err) {
        if (_loginAgain) { finishLogin(); return; }
        const msg = err.error || err.message || String(err);
        log.error(`فشل تسجيل الدخول (${loginAttempt}/${MAX_LOGIN}): ${msg}`);
        if (io) io.emit("bot-status", { status: "error", message: `فشل الدخول: ${msg}` });

        if (loginAttempt < MAX_LOGIN) {
          setTimeout(tryLogin, loginAttempt * 5000);
          return;
        }

        log.error("وصل لأقصى عدد محاولات تسجيل الدخول");
        if (io) io.emit("bot-status", { status: "offline", message: "فشل الدخول — تحقق من الكوكيز" });
        finishLogin();
        return;
      }

      // A newer credential upload supersedes this login; never overwrite it.
      if (_loginAgain) {
        try { api.stopListening?.(() => {}); } catch (_) {}
        finishLogin();
        return;
      }

      // Save refreshed appState back to account.txt — suppress our own watch event
      try {
        const fresh = dedup(api.getAppState() || []);
        if (fresh.length) {
          global._selfWrite = true; // suppress file watcher
          fs.writeFileSync(ACCOUNT_PATH, JSON.stringify(fresh, null, 2), "utf8");
          setTimeout(() => { global._selfWrite = false; }, 6000); // clear after 6s
          log.info(`AppState محدَّث: ${chalk.cyan(fresh.length)} كوكي`);
        }
      } catch (_) {}

      const uid = api.getCurrentUserID();
      log.ok(`تسجيل الدخول ناجح ✔ — UID: ${chalk.bold.green(uid)}`);
      global.api = api;

      api.setOptions({
        listenEvents:  true,
        selfListen:    false,
        autoReconnect: false,
        userAgent:     UA,
      });

      if (io) io.emit("bot-status", { status: "connecting", message: `دخول ✔ (${uid}) — جارٍ تشغيل الليستنر…` });

      // Start protection — original systems
      try { require("./protection/outgoingThrottle").wrapSendMessage(api); } catch (_) {}
      try { require("./protection/humanTyping").wrapWithTyping(api); } catch (_) {}
      try { require("./protection/stealth").start(api); } catch (_) {}
      try { require("./protection/keepAlive").start(); } catch (_) {}
      try { require("./protection/mqttHealthCheck").startHealthCheck(); } catch (_) {}
      try { require("./protection/Uprotection"); } catch (_) {}

      // Start protection — 10 new human-simulation systems
      try { require("./protection/humanReadReceipt").start(api); }   catch (_) {}
      try { require("./protection/naturalPresence").start(api); }     catch (_) {}
      try { require("./protection/scrollSimulator").start(api); }     catch (_) {}
      try { require("./protection/antiDetection").start(); }          catch (_) {}
      try { require("./protection/sessionRefresher").start(api); }    catch (_) {}
      try { require("./protection/reactionDelay").start(api); }       catch (_) {}
      try { require("./protection/connectionJitter").start(api); }    catch (_) {}
      try { require("./protection/duplicateGuard").start(api); }      catch (_) {}
      try { require("./protection/typingVariator").start(api); }      catch (_) {}
      try { require("./protection/behaviorScheduler").start(); }      catch (_) {}
      log.ok("🛡️ جميع أنظمة الحماية (16 نظام) نشطة");

      // Start auto-backup
      if (ACCOUNT_SLOT === 1) try { require("./utils/autoBackup").start(); } catch (_) {}

      // Setup cron jobs
      setupCronJobs(api);

      // Release login lock BEFORE starting listener
      finishLogin();

      // Wait 1.5s then start listener
      // m_sess → try MQTT first | no m_sess → direct Long-Poll
      await new Promise(r => setTimeout(r, 1500));
      if (global.api !== api || _loginLock) return;
      if (hasMsess) {
        startMqtt(api, commands, 1);
      } else {
        log.info("بدء Long-Poll مباشرة (بدون MQTT)…");
        startPolling(api, commands, 1);
      }
    });
  }

  tryLogin();
}

// ─── Hot-Swap ─────────────────────────────────────────────────────────────────
global.reLoginBot = async function () {
  log.warn("🔄 Hot-Swap: إعادة تسجيل الدخول…");
  await startBot();
};
// alias للتوافق مع mqttHealthCheck القديم
global._reLoginBot = global.reLoginBot;

// ─── Soft Restart (listener فقط — بدون re-login) ──────────────────────────────
global.restartListener = async function () {
  const api = global.api;
  if (!api) { log.warn("restartListener: لا يوجد api — سيتم re-login"); return global.reLoginBot(); }
  log.warn("🔄 Soft restart: إعادة تشغيل الـ listener بدون re-login…");
  stopListening();
  await new Promise(r => setTimeout(r, 2000 + Math.random() * 2000));
  const hasMsess = api.getAppState?.()?.some(c => c.key === "m_sess") || false;
  if (hasMsess) {
    startMqtt(api, global.commands, 1);
  } else {
    startPolling(api, global.commands, 1);
  }
  global._lastMqttActivity = Date.now();
  log.ok("🔄 Soft restart تم ✔");
};

// ─── Crash Recovery ────────────────────────────────────────────────────────────
process.on("uncaughtException", (err) => {
  log.error(`[CRASH] uncaughtException: ${err?.message || err}`);
  // لا نوقف البوت — فقط نسجّل الخطأ
});
process.on("unhandledRejection", (reason) => {
  log.error(`[CRASH] unhandledRejection: ${reason?.message || reason}`);
  // لا نوقف البوت
});

// ─── Cron Jobs ────────────────────────────────────────────────────────────────
let cronTasks = [];
function setupCronJobs(api) {
  cronTasks.forEach(task => task.stop());
  cronTasks = [];
  for (const job of global.config?.cronJobs || []) {
    if (!job.cron || !job.threadID || !job.message) continue;
    try {
      cronTasks.push(cron.schedule(job.cron, () => api.sendMessage(job.message, job.threadID, () => {})));
      log.ok(`Cron: "${job.cron}" → ${job.threadID}`);
    } catch (e) { log.warn(`Cron: ${e.message}`); }
  }
}

// ─── Banner ───────────────────────────────────────────────────────────────────
function printBanner() {
  const lines = [
    "  ╔══════════════════════════════════════════════════╗",
    "  ║   🤖  Michael Bot v3.1.0                         ║",
    "  ║   ⚡  @dongdev/fca-unofficial  |  Michael Engine   ║",
    "  ║   🍪  account.txt  —  No m_sess required         ║",
    "  ║   🔄  Hot-Swap  |  Auto-Backup  |  MQTT→Poll     ║",
    "  ║   ©  Michael                                    ║",
    "  ╚══════════════════════════════════════════════════╝",
  ].join("\n");
  console.log(gradient.rainbow(lines));
  console.log(chalk.gray(`  ${moment().tz("Africa/Algiers").format("YYYY-MM-DD HH:mm:ss")} (Africa/Algiers)\n`));
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  printBanner();
  // A Railway volume is optional; seed it once from the existing configuration.
  const legacyConfig = path.join(__dirname, "../config.json");
  if (process.env.BOT_DATA_DIR && !fs.existsSync(CONFIG_PATH) && fs.existsSync(legacyConfig)) fs.copyFileSync(legacyConfig, CONFIG_PATH);
  const legacyAccount = path.join(__dirname, "../account.txt");
  if (process.env.BOT_DATA_DIR && ACCOUNT_SLOT === 1 && !fs.existsSync(ACCOUNT_PATH) && fs.existsSync(legacyAccount)) fs.copyFileSync(legacyAccount, ACCOUNT_PATH);
  await initDB();
  log.ok("قاعدة البيانات جاهزة");

  // Init runtime globals for new systems
  if (!global._lockedThreads) global._lockedThreads = new Set();
  if (global._globalLock === undefined) global._globalLock = false;
  if (!global._broadcasts) global._broadcasts = new Map();
  if (!global._nicknameJobs) global._nicknameJobs = new Map();
  if (!global._lockedNames)   global._lockedNames   = new Map();
  if (!global._nameRestoring) global._nameRestoring = new Set();
  if (!global._nickRestoring) global._nickRestoring = new Set();

  const defaults = {
    botName: "Michael", prefix: "/", ownerID: "", adminIDs: [],
    dashboardPort: 5000, timezone: "Africa/Algiers",
    dashboardPassword: "djamel2025*",
    humanTyping:     { enable: true },
    stealth:         { enable: true },
    mqttHealthCheck: { enable: true },
    keepAlive:       { enable: true },
    groupEvents:     { welcomeMessage: "", leaveMessage: "" },
    backupIntervalMinutes: 60,
    cronJobs: [],
    commandRoles: {}, // أدوار الأوامر: "admin" (افتراضي) أو "member"
    userAgent: "Mozilla/5.0 (Linux; Android 12; M2102J20SG) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/101.0.0.0 Mobile Safari/537.36",
  };

  const config = fs.existsSync(CONFIG_PATH)
    ? { ...defaults, ...fs.readJsonSync(CONFIG_PATH) }
    : defaults;

  if (!fs.existsSync(CONFIG_PATH)) {
    fs.writeJsonSync(CONFIG_PATH, defaults, { spaces: 2 });
    log.warn("config.json تم إنشاؤه بالقيم الافتراضية");
  }

  global.config        = config;
  global.commandPrefix = config.prefix   || "/";
  global.ownerID       = config.ownerID  || "";
  global.botName       = botName(config.botName);

  log.info(`البوت: ${chalk.bold.cyan(global.botName)} | بادئة: ${chalk.cyan(global.commandPrefix)} | مالك: ${chalk.cyan(global.ownerID || "غير محدد")}`);

  const commands = loadCommands(path.join(__dirname, "commands"));
  global.commands = commands;
  log.ok(`تم تحميل ${chalk.bold(commands.size)} أمر`);

  if (!fs.existsSync(ACCOUNT_PATH)) fs.writeFileSync(ACCOUNT_PATH, "", "utf8");

  const port = parseInt(process.env.PORT || config.dashboardPort || 5000, 10);
  const dashboard = await startDashboard(port);
  if (ACCOUNT_SLOT === 1) {
    accountManager.start(dashboard.io);
    process.on("exit", () => accountManager.stop());
    log.ok(`لوحة التحكم → http://0.0.0.0:${port}`);
  } else if (process.send) {
    process.send({ type: "ready", port: dashboard.server.address().port });
    process.on("message", msg => {
      if (msg?.type === "config" && msg.config) {
        global.config = msg.config; global.ownerID = msg.config.ownerID || "";
        global.commandPrefix = msg.config.prefix || "/"; global.botName = botName(msg.config.botName);
      } else if (msg?.type === "reloadCopyMessages") {
        require("./utils/copyMessageStore").reload();
      } else if (msg?.type === "relogin") {
        global.invalidatePendingLogin?.(); global._dashCookieWrite = true;
        setTimeout(() => { global._dashCookieWrite = false; }, 6500);
        global.reLoginBot?.();
      } else if (msg?.type === "reloadCommands") {
        for (const file of Object.keys(require.cache)) if (file.startsWith(path.join(__dirname, "commands") + path.sep)) delete require.cache[file];
        global.commands = loadCommands(path.join(__dirname, "commands"));
      }
    });
    process.on("disconnect", () => process.exit(0));
  }

  // ── File Watcher: تغيير account.txt → hot-swap ────────────────────────────
  let _watchMtime  = 0;
  let _watchTimer  = null;

  fs.watch(ACCOUNT_PATH, () => {
    // Debounce: تجاهل الأحداث المتكررة خلال 5 ثوانٍ
    if (_watchTimer) return;
    _watchTimer = setTimeout(async () => {
      _watchTimer = null;

      // تجاهل إذا كانت الكتابة من البوت نفسه (AppState refresh)
      if (global._selfWrite) {
        log.info("تجاهل تغيير account.txt (كتابة داخلية)");
        return;
      }

      // تجاهل إذا كانت الكتابة من لوحة التحكم (hot-swap يُطلَق من الـ API مباشرةً)
      if (global._dashCookieWrite) {
        log.info("تجاهل تغيير account.txt (كتابة من الداشبورد — hot-swap جارٍ)");
        return;
      }

      // تجاهل إذا كان تسجيل دخول جارٍ
      if (_loginLock) {
        log.info("تجاهل تغيير account.txt (تسجيل دخول جارٍ)");
        return;
      }

      try {
        const stat = fs.statSync(ACCOUNT_PATH);
        if (stat.mtimeMs <= _watchMtime + 500) return;
        _watchMtime = stat.mtimeMs;
      } catch { return; }

      const content = fs.readFileSync(ACCOUNT_PATH, "utf8").trim();
      if (!content) return;

      log.warn("🔄 account.txt تغيَّر (مستخدم) — hot-swap بعد 3 ثوانٍ…");
      setTimeout(() => startBot(), 3000);
    }, 5000);
  });

  // Start bot
  await startBot();
}

main().catch(e => {
  console.error(chalk.red("FATAL:"), e);
  process.exit(1);
});
