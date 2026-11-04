"use strict";
// Each account gets a separate Node process: FCA, timers and command state are
// singleton-heavy, so process isolation prevents one account replacing another.
const { fork } = require("child_process");
const crypto = require("crypto");
const http = require("http");
const path = require("path");
const secret = crypto.randomBytes(32).toString("hex");
const children = new Map();
let dashboardIO;
let shuttingDown = false;

function start(io) {
  dashboardIO = io;
  for (const slot of [2, 3]) spawn(slot);
}
function spawn(slot) {
  const child = fork(path.join(__dirname, "../index.js"), [], {
    env: { ...process.env, BOT_ACCOUNT_SLOT: String(slot), BOT_INTERNAL_SECRET: secret, PORT: "0" },
    stdio: ["ignore", "inherit", "inherit", "ipc"],
  });
  const state = { child, port: null };
  children.set(slot, state);
  child.on("message", msg => {
    if (children.get(slot) !== state || !msg) return;
    if (msg.type === "ready") {
      state.port = msg.port;
      sendConfig(child);
    } else if (msg.type === "config-changed") {
      try {
        const cfg = require("fs").readFileSync(require("./paths").configPath, "utf8");
        global.config = JSON.parse(cfg);
        global.ownerID = global.config.ownerID || "";
        global.commandPrefix = global.config.prefix || "/";
        broadcastConfig();
      } catch (e) { console.error(`[ACCOUNT CONFIG] ${e.message}`); }
    } else if (msg.type === "event" && ["bot-status", "message", "command", "group-event", "cookies-updated"].includes(msg.event)) {
      dashboardIO?.emit(msg.event, { ...msg.data, accountId: slot });
    }
  });
  child.on("exit", () => {
    if (children.get(slot) !== state) return;
    children.delete(slot);
    dashboardIO?.emit("bot-status", { accountId: slot, status: "offline", message: "عملية الحساب متوقفة؛ جارٍ إعادة تشغيلها" });
    if (!shuttingDown) setTimeout(() => spawn(slot), 3000);
  });
  child.on("error", e => console.error(`[ACCOUNT ${slot}] ${e.message}`));
}
function sendConfig(child) {
  if (child.connected) child.send({ type: "config", config: global.config });
}
function broadcastConfig() { for (const { child } of children.values()) sendConfig(child); }
function reloadCopyMessages() { for (const { child } of children.values()) if (child.connected) child.send({ type: "reloadCopyMessages" }); }
function reloginAll() { for (const { child } of children.values()) if (child.connected) child.send({ type: "relogin" }); }
function reloadCommands() { for (const { child } of children.values()) if (child.connected) child.send({ type: "reloadCommands" }); }
function proxy(req, res, slot) {
  const state = children.get(slot);
  if (!state?.port) return res.status(503).json({ error: "الحساب قيد التشغيل، حاول مجدداً بعد لحظات" });
  const headers = { ...req.headers, host: `127.0.0.1:${state.port}`, "x-bot-internal-secret": secret };
  const upstream = http.request({ hostname: "127.0.0.1", port: state.port, method: req.method, path: req.originalUrl, headers }, response => {
    res.writeHead(response.statusCode, response.headers);
    response.pipe(res);
  });
  upstream.on("error", () => { if (!res.headersSent) res.status(503).json({ error: "تعذر الوصول إلى الحساب المحدد" }); else res.destroy(); });
  req.pipe(upstream);
}
function stop() { shuttingDown = true; for (const { child } of children.values()) child.kill(); }
module.exports = { start, proxy, broadcastConfig, reloadCommands, reloadCopyMessages, reloginAll, stop };
