"use strict";

const fs   = require("fs-extra");
const path = require("path");

const CONFIG_PATH = require("../utils/paths").configPath;

module.exports = {
  config: {
    name: "انزل",
    aliases: [],
    description: "إزالة مستخدم من مساعدي الأدمن (للأدمنز من لوحة التحكم فقط)",
    usage: "انزل @شخص  أو  انزل [userID]",
    adminOnly: true,
    ownerOnly: false,
    category: "admin",
  },

  async run({ api, event, args, threadID, senderID }) {
    // فقط أدمنز لوحة التحكم يملكون هذه الصلاحية
    if (!event._dashboard && (!global.isDashboardAdmin || !global.isDashboardAdmin(senderID))) {
      return api.sendMessage(
        "❌ هذا الأمر لأدمنز لوحة التحكم فقط.",
        threadID
      );
    }

    // احصل على معرّف الشخص المستهدف
    let targetID = null;
    const mentions = Object.keys(event.mentions || {});
    if (mentions.length > 0) {
      targetID = mentions[0];
    } else if (args[0] && /^\d+$/.test(args[0].trim())) {
      targetID = args[0].trim();
    } else if (event.messageReply?.senderID) {
      targetID = event.messageReply.senderID;
    }

    if (!targetID) {
      return api.sendMessage(
        "⚠️ حدد الشخص المراد إنزاله:\n• انزل @شخص\n• انزل [userID]\n• أو رُد على رسالته",
        threadID
      );
    }

    targetID = String(targetID);

    // حماية أدمنز لوحة التحكم — لا يمكن إنزالهم أبداً
    if (global.isDashboardAdmin(targetID)) {
      return api.sendMessage(
        "🔒 لا يمكن إنزال أدمن لوحة التحكم.\nأدمنز الواجهة لا يمكن التحكم بهم من هنا.",
        threadID
      );
    }

    // تحديث config.json
    const cfg = fs.existsSync(CONFIG_PATH) ? fs.readJsonSync(CONFIG_PATH) : {};
    if (!cfg.subAdminIDs) cfg.subAdminIDs = [];

    const before = cfg.subAdminIDs.map(String);
    if (!before.includes(targetID)) {
      return api.sendMessage("⚠️ هذا الشخص ليس مساعد أدمن أصلاً.", threadID);
    }

    cfg.subAdminIDs = cfg.subAdminIDs.filter(id => String(id) !== targetID);
    fs.writeJsonSync(CONFIG_PATH, cfg, { spaces: 2 });
    if (global.config) global.config.subAdminIDs = cfg.subAdminIDs;
    global.syncSharedConfig?.();

    // احصل على اسم الشخص
    let name = targetID;
    try {
      const info = await new Promise((res, rej) =>
        api.getUserInfo(targetID, (e, d) => e ? rej(e) : res(d || {}))
      );
      name = info[targetID]?.name || targetID;
    } catch (_) {}

    api.sendMessage(
      `✅ تم إنزال ${name} من مساعدي الأدمن.\nلم يعد بإمكانه استخدام أوامر البوت.`,
      threadID
    );
  },
};
