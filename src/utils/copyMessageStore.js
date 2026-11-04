"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { dataDir, slot } = require("./paths");

// Each worker/account has its own file; keys are conversation IDs.
const file = path.join(dataDir, `copy-messages-${slot}.json`);
let messages;

function load() {
  if (messages) return messages;
  let data = {};
  try {
    data = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (!data || typeof data !== "object" || Array.isArray(data) || Object.values(data).some(value => typeof value !== "string")) {
    throw new Error("ملف رسائل النسخ غير صالح");
  }
  messages = new Map(Object.entries(data));
  return messages;
}

function get(threadID) { return load().get(String(threadID)); }
function set(threadID, text) {
  const updated = new Map(load());
  updated.set(String(threadID), text);
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(Object.fromEntries(updated), null, 2), { encoding: "utf8", mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, file);
    messages = updated;
  } finally {
    try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
}
function reload() { messages = undefined; }
module.exports = { get, set, reload };
