
"use strict";

module.exports = {
  config: {
    name: "توقف",
    aliases: [],
    description: "إيقاف الإرسال التلقائي في هذه المحادثة",
    usage: "توقف",
    adminOnly: false,
    ownerOnly: false,
    category: "auto",
  },

  async run({ api, threadID }) {
    if (!global._michaelAutoJobs || !global._michaelAutoJobs.has(threadID)) {
      return api.sendMessage(
        "❌ لا يوجد إرسال تلقائي نشط في هذه المحادثة.",
        threadID
      );
    }

    const job = global._michaelAutoJobs.get(threadID);
    clearTimeout(job.timer);
    global._michaelAutoJobs.delete(threadID);

    await api.sendMessage("⛔ تم إيقاف الإرسال التلقائي في هذه المحادثة.", threadID);
  },
};
