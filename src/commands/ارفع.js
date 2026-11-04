"use strict";

const fs   = require("fs-extra");
const path = require("path");

const CONFIG_PATH = require("../utils/paths").configPath;

module.exports = {
  config: {
    name: "ارفع",
    aliases: [],
    description: "رفع مستخدم إلى مساعد أدمن (للأدمنز من لوحة التحكم فقط)",
    usage: "ارفع @شخص  أو  ارفع [userID]",
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
        "⚠️ حدد الشخص المراد رفعه:\n• ارفع @شخص\n• ارفع [userID]\n• أو رُد على رسالته",
        threadID
      );
    }

    targetID = String(targetID);

    // لا يمكن رفع شخص هو أدمن لوحة التحكم أصلاً
    if (global.isDashboardAdmin(targetID)) {
      return api.sendMessage(
        "✅ هذا الشخص هو أدمن لوحة التحكم أصلاً.",
        threadID
      );
    }

    // تحديث config.json
    const cfg = fs.existsSync(CONFIG_PATH) ? fs.readJsonSync(CONFIG_PATH) : {};
    if (!cfg.subAdminIDs) cfg.subAdminIDs = [];

    if (cfg.subAdminIDs.map(String).includes(targetID)) {
      return api.sendMessage("⚠️ هذا الشخص مساعد أدمن بالفعل.", threadID);
    }

    cfg.subAdminIDs.push(targetID);
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
      `✅ تم رفع ${name} إلى مساعد أدمن.\nيمكنه الآن استخدام جميع أوامر البوت.`,
      threadID
    );
  },
};
