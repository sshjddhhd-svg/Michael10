"use strict";
const fs = require("fs");
const path = require("path");
const root = path.resolve(__dirname, "../..");
const slot = Number(process.env.BOT_ACCOUNT_SLOT || 1);
if (![1, 2, 3].includes(slot)) throw new Error("Invalid BOT_ACCOUNT_SLOT");
const dataDir = path.resolve(process.env.BOT_DATA_DIR || path.join(root, "data"));
fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
const configPath = process.env.BOT_DATA_DIR ? path.join(dataDir, "config.json") : path.join(root, "config.json");
const accountPath = !process.env.BOT_DATA_DIR && slot === 1
  ? path.join(root, "account.txt") : path.join(dataDir, `account-${slot}.txt`);
module.exports = { root, slot, dataDir, configPath, accountPath, databasePath: path.join(dataDir, slot === 1 ? "bot.db" : `bot-${slot}.db`) };
