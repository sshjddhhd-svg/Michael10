"use strict";
/**
 * Session Refresher — WHITE Engine
 * ===================================
 * يحفظ AppState المحدَّث دورياً لمنع انتهاء صلاحية الكوكيز
 * لا يُرسل أي طلبات HTTP إضافية لتجنب الكشف عن البوت
 */

const fs   = require("fs-extra");
const path = require("path");

function randInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function randMs(minMin, maxMin) { return randInt(minMin * 60000, maxMin * 60000); }

function log(level, msg) {
  const chalk = require("chalk");
  const ts = new Date().toLocaleTimeString("en", { hour12: false });
  if (level === "ok")   console.log(`${chalk.gray(ts)} ${chalk.green("✔")} ${chalk.green("[SESS_REF] " + msg)}`);
  if (level === "warn") console.log(`${chalk.gray(ts)} ${chalk.yellow("⚠")} ${chalk.yellow("[SESS_REF] " + msg)}`);
  if (level === "info") console.log(`${chalk.gray(ts)} ${chalk.cyan("•")} [SESS_REF] ${msg}`);
}

const ACCOUNT_PATH = require("../utils/paths").accountPath;

let _running = false;
let _api = null;
let _saveCount = 0;
let _lastSave = 0;
const _timers = [];

function addTimer(fn, ms) {
  const id = setTimeout(() => { const i = _timers.indexOf(id); if (i !== -1) _timers.splice(i, 1); fn(); }, ms);
  _timers.push(id); return id;
}
function clearAll() { _timers.forEach(id => clearTimeout(id)); _timers.length = 0; }

async function doSave() {
  if (!_running || !_api) return;

  try {
    const fresh = _api.getAppState();
    if (fresh?.length) {
      const { dedup } = require("../utils/cookieParser");
      const deduped = dedup(fresh);
      global._selfWrite = true;
      fs.writeFileSync(ACCOUNT_PATH, JSON.stringify(deduped, null, 2), "utf8");
      setTimeout(() => { global._selfWrite = false; }, 6000);
      _saveCount++;
      _lastSave = Date.now();
      log("ok", `AppState saved (${deduped.length} cookies) ×${_saveCount}`);
    }
  } catch (_) {}

  const cfg = global.config?.sessionRefresher || {};
  const minMin = cfg.minIntervalMinutes ?? 25;
  const maxMin = cfg.maxIntervalMinutes ?? 55;
  addTimer(doSave, randMs(minMin, maxMin));
}

function start(api) {
  const cfg = global.config?.sessionRefresher || {};
  if (cfg.enable === false) return;
  if (_running) return;
  _running = true;
  _api = api;
  log("info", "🚀 Session Refresher started (cookie-save mode — no HTTP)");
  // أول حفظ بعد 15-30 دقيقة من الانطلاق
  addTimer(doSave, randMs(15, 30));
}

function stop() { _running = false; clearAll(); log("warn", "🛑 Session Refresher stopped"); }

module.exports = {
  start, stop,
  getStatus: () => ({ running: _running, saveCount: _saveCount, lastSave: _lastSave }),
  isRunning: () => _running,
};
