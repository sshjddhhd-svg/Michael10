"use strict";

const messages = require("../utils/copyMessageStore");
const WAIT_MS = 10 * 60 * 1000;
const pending = () => global._pendingCopyMessages || (global._pendingCopyMessages = new Map());
const keyFor = (threadID, senderID) => JSON.stringify([String(threadID), String(senderID)]);

async function save(api, threadID, text, prefix, key) {
  try {
    messages.set(threadID, text);
  } catch (error) {
    console.error(`[COPY MESSAGE] ${error.message}`);
    await api.sendMessage("❌ تعذّر حفظ الرسالة. تحقق من مساحة التخزين وحاول مجدداً.", threadID);
    return false;
  }
  if (key) pending().delete(key);
  await api.sendMessage(`✅ تم حفظ رسالة النسخ لهذه المحادثة. استخدم ${prefix}انسخ لتفعيل الإرسال.`, threadID);
  return true;
}

module.exports = {
  config: {
    name: "جريدة",
    aliases: [],
    description: "تحديد الرسالة التي يرسلها أمر النسخ في هذه المحادثة",
    usage: "جريدة",
    adminOnly: true,
    ownerOnly: false,
    category: "auto",
  },

  async run({ api, event, body, args = [], threadID, senderID, prefix = global.commandPrefix || "/" }) {
    // Keep the original text when the message is supplied after the command.
    const raw = typeof body === "string" ? body : event?.body;
    let text;
    if (typeof raw === "string") {
      const commandText = raw.startsWith(prefix) ? raw.slice(prefix.length) : raw;
      const match = commandText.match(/^\s*جريدة(?=\s|$)/u);
      text = match ? commandText.slice(match[0].length).replace(/^\s+/u, "").trimEnd() : args.join(" ").trim();
    } else {
      text = args.join(" ").trim();
    }
    const sender = senderID || event?.senderID;
    const key = sender ? keyFor(threadID, sender) : null;
    if (text) return save(api, threadID, text, prefix, key);
    // The dashboard has a text box; it cannot reliably collect the next Messenger message.
    if (event?._dashboard || !key) return api.sendMessage(`⚠️ اكتب الرسالة بعد الأمر، مثال: ${prefix}جريدة رسالتي`, threadID);
    const now = Date.now();
    for (const [entry, expires] of pending()) if (expires <= now) pending().delete(entry);
    pending().set(key, now + WAIT_MS);
    return api.sendMessage(`📝 أرسل الآن رسالة النسخ في رسالة تالية خلال 10 دقائق. للإلغاء: ${prefix}الغاء`, threadID);
  },

  // Called by the event handler only for an authorized sender.
  async handlePending({ api, event, prefix, commands }) {
    const { threadID, senderID } = event;
    const key = keyFor(threadID, senderID);
    const expires = pending().get(key);
    if (expires === undefined) return false;
    if (Date.now() >= expires) {
      pending().delete(key);
      return false;
    }
    const body = typeof event.body === "string" ? event.body : "";
    if (body.startsWith(prefix)) {
      if (body.slice(prefix.length).trim() === "الغاء") {
        pending().delete(key);
        await api.sendMessage("✅ تم إلغاء تعديل رسالة النسخ.", threadID);
        return true;
      }
      // Known commands retain their normal behavior; arbitrary slash-prefixed
      // text can still be saved as the requested message.
      const name = body.slice(prefix.length).trim().split(/\s+/u)[0].toLowerCase();
      if (commands?.has(name)) return false;
    }
    if (!body.trim()) {
      await api.sendMessage(`⚠️ أرسل نص الرسالة، أو ${prefix}الغاء لإلغاء التعديل.`, threadID);
      return true;
    }
    await save(api, threadID, body, prefix, key);
    return true;
  },
};
