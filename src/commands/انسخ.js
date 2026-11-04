
"use strict";

const messages = require("../utils/copyMessageStore");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function randInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function delays() { return global._copyDelays || (global._copyDelays = new Map()); }

module.exports = {
  config: {
    name: "انسخ",
    aliases: ["نسخ"],
    description: "تشغيل إرسال الرسالة المحددة بأمر جريدة وضبط وقت الانتظار",
    usage: "انسخ | انسخ وقت [5m أو 40s أو ثوانٍ] | انسخ وقت افتراضي",
    adminOnly: false,
    ownerOnly: false,
    category: "auto",
  },

  async run({ api, threadID, args = [] }) {
    if (args[0] === "وقت") {
      if (args.length === 1) {
        const value = delays().get(threadID);
        return api.sendMessage(value === undefined
          ? "⏱️ وقت النسخ الافتراضي: عشوائي بين 20 و35 ثانية."
          : `⏱️ وقت النسخ الحالي: ${value} ثانية.`, threadID);
      }
      if (args.length === 2 && args[1] === "افتراضي") {
        delays().delete(threadID);
        return api.sendMessage("✅ عاد وقت النسخ الافتراضي: عشوائي بين 20 و35 ثانية، بدءاً من الجدولة التالية.", threadID);
      }
      const match = args.length === 2 && /^(\d+)([sm])?$/i.exec(args[1]);
      const seconds = match ? Number(match[1]) * (match[2]?.toLowerCase() === "m" ? 60 : 1) : NaN;
      if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > 86400) {
        return api.sendMessage("⚠️ استخدم: انسخ وقت 5m للدقائق أو انسخ وقت 40s للثواني. الأرقام دون لاحقة تعني ثوانٍ، والحد من ثانية إلى 86400 ثانية. لإعادة الوقت: انسخ وقت افتراضي.", threadID);
      }
      delays().set(threadID, seconds);
      return api.sendMessage(`✅ تم ضبط وقت انتظار النسخ على ${seconds} ثانية لهذه المحادثة، بدءاً من الجدولة التالية.`, threadID);
    }
    try {
      if (!messages.get(threadID)) return api.sendMessage(
        `⚠️ لم تُحدد رسالة لهذه المحادثة. استخدم ${global.commandPrefix || "/"}جريدة متبوعاً بالرسالة أولاً.`, threadID);
    } catch (error) {
      console.error(`[COPY MESSAGE] ${error.message}`);
      return api.sendMessage("❌ تعذّر قراءة رسالة النسخ. تحقق من مساحة التخزين وحاول مجدداً.", threadID);
    }
    if (!global._michaelAutoJobs) global._michaelAutoJobs = new Map();
    if (global._michaelAutoJobs.has(threadID)) {
      return api.sendMessage(`⚠️ الإرسال التلقائي يعمل بالفعل في هذه المحادثة.\nاستخدم «${global.commandPrefix || "/"}توقف» لإيقافه.`, threadID);
    }

    const job = { timer: null };
    global._michaelAutoJobs.set(threadID, job);
    const active = () => global._michaelAutoJobs?.get(threadID) === job;
    const configured = delays().get(threadID);
    try {
      await api.sendMessage(configured === undefined
        ? "✅ تم تفعيل الإرسال التلقائي — يرسل كل 20-35 ثانية."
        : `✅ تم تفعيل الإرسال التلقائي — وقت الانتظار ${configured} ثانية.`, threadID);
    } catch (error) {
      if (active()) global._michaelAutoJobs.delete(threadID);
      throw error;
    }
    if (!active()) return;

    function scheduleNext() {
      const delaySec = delays().get(threadID) ?? randInt(20, 35);
      job.timer = setTimeout(async () => {
        if (!active()) return;
        try {
          const stopTyping = api.sendTypingIndicator(threadID);
          await sleep(randInt(2000, 5000));
          if (typeof stopTyping === "function") {
            try { stopTyping(); } catch (_) {}
          }
          if (!active()) return;
          let message;
          try { message = messages.get(threadID); }
          catch (error) {
            console.error(`[COPY MESSAGE] ${error.message}`);
            global._michaelAutoJobs.delete(threadID);
            await api.sendMessage("⛔ توقف النسخ لتعذّر قراءة الرسالة المحفوظة.", threadID);
            return;
          }
          if (!message) {
            global._michaelAutoJobs.delete(threadID);
            await api.sendMessage(`⛔ توقف النسخ: لم تعد هناك رسالة محفوظة. استخدم ${global.commandPrefix || "/"}جريدة لتحديد رسالة جديدة.`, threadID);
            return;
          }
          await new Promise((resolve) => {
            api.sendMessage(message, threadID, (err) => resolve(err));
          });
        } catch (_) {}
        if (active()) scheduleNext();
      }, delaySec * 1000);
    }
    scheduleNext();
  },
};
