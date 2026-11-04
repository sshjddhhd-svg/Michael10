"use strict";

const nameLock = require("../utils/nameLock");

module.exports = {
  config: {
    name: "اسم",
    aliases: [],
    description: "قفل اسم المجموعة وإعادته تلقائياً عند تغييره",
    usage: "اسم [الاسم الجديد]  |  اسم ايقاف",
    adminOnly: true,
    ownerOnly: false,
    category: "group",
  },

  async run({ api, args, threadID, isGroup }) {
    if (isGroup === false) return api.sendMessage("⚠️ هذا الأمر للمجموعات فقط.", threadID);
    if (args.length === 1 && args[0] === "ايقاف") {
      return api.sendMessage(nameLock.unlock(threadID)
        ? "✅ تم إيقاف قفل اسم المجموعة."
        : "❌ لا يوجد قفل اسم نشط في هذه المجموعة.", threadID);
    }
    const newName = args.join(" ").trim();
    if (!newName) return api.sendMessage(
      "⚠️ حدد الاسم:\n• اسم [الاسم] — قفل الاسم\n• اسم ايقاف — إيقاف القفل", threadID);
    try {
      if (!await nameLock.lock(api, threadID, newName)) return;
      return api.sendMessage(
        `✅ تم تغيير اسم المجموعة إلى:\n"${newName}"\n\n🔒 الاسم مقفل — سيُعاد بعد 5-10 ثوانٍ عشوائية عند تغييره.\nلإيقاف القفل: اسم ايقاف`, threadID);
    } catch (e) {
      return api.sendMessage(`❌ فشل تغيير الاسم: ${e.message || e}`, threadID);
    }
  },
};
