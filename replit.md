# Michael Bot v3.1 — Michael Engine

## المشروع
بوت Facebook Messenger كامل مبني على @dongdev/fca-unofficial مع لوحة تحكم متكاملة.
- نظام كوكيز مثل WHITE-V3 (account.txt، جميع الصيغ، بدون m_sess)
- listener محسّن (MQTT أولاً → HTTP poll إذا لا m_sess)
- هاندلر WHITE-V3 مع حماية من الـ spam وتسجيل أسماء المجموعات
- hot-swap من لوحة التحكم
- نسخ احتياطي تلقائي كل ساعة

## التشغيل
```
PORT=5000 npm start
```
لوحة التحكم: http://localhost:5000  
كلمة المرور الافتراضية: `djamel2025*`

## البنية
```
src/
├── index.js              # نقطة الدخول — login lock، _selfWrite guard، MQTT/Poll
├── handler/
│   └── handlerEvents.js  # WHITE-V3 handler: spam، أسماء، dispatch، group events
├── commands/             # أوامر البوت (25+ أمر)
├── utils/
│   ├── autoBackup.js     # نسخ احتياطي تلقائي (كل ساعة)
│   ├── cookieParser.js   # محلل شامل (JSON/String/Token/Netscape)
│   └── checkLiveCookie.js
├── dashboard/
│   ├── server.js         # Express API + Socket.IO + Backup endpoints
│   └── public/
│       ├── index.html    # الواجهة الكاملة v3.1
│       └── uploads/      # ملفات الوسائط المرفوعة
├── protection/
│   ├── stealth.js        # محرك التخفي (UA rotation, browsing)
│   ├── outgoingThrottle.js # تقييد الرسائل
│   ├── humanTyping.js    # محاكاة الكتابة البشرية
│   ├── mqttHealthCheck.js # فحص صحة MQTT
│   ├── keepAlive.js      # نبضة حياة
│   └── rateLimit.js      # تقييد الأوامر
└── utils/
    ├── cookieParser.js     # محلل الكوكيز الشامل (جديد)
    ├── checkLiveCookie.js  # التحقق عبر mbasic.facebook.com
    ├── getFbstateFromToken.js # تحويل توكن EAAAA→كوكيز
    ├── database.js         # SQLite/Sequelize
    └── loader.js           # تحميل الأوامر

account.txt               # ملف الكوكيز (يستبدل appstate.json)
config.json               # إعدادات البوت
data/bot.db               # قاعدة البيانات SQLite
```

## نظام الكوكيز — WHITE-V3 Style
- **account.txt** يستبدل appstate.json بالكامل
- يدعم جميع الصيغ: Token EAAAA | Cookie String | JSON Array | Netscape
- **لا يحتاج m_sess** — يعمل بـ HTTP Long-Poll كاحتياطي تلقائي
- MQTT يُجرَّب أولاً (4 محاولات) ثم يتراجع لـ api.listen (alias لـ listenMqtt في v4)
- التحقق عبر mbasic.facebook.com (WHITE-V3 style)
- المكتبة: **@dongdev/fca-unofficial v4** — Classic callback: `const login = require("@dongdev/fca-unofficial")`

## Hot-Swap (تغيير الحساب بدون إعادة تشغيل)
- ارفع كوكيز جديدة من لوحة التحكم → يتم تغيير الحساب فوراً
- البوت يراقب account.txt تلقائياً → يعيد الدخول عند أي تغيير
- `global.reLoginBot()` متاح للاستخدام في أي مكان

## لوج المجموعات
- يعرض اسم المجموعة + اسم المرسل (محلول من getUserInfo/getThreadInfo)
- مؤشر لحظي في سجل الرسائل بالداشبورد
- Cache للأسماء في `global._nameCache`

## مكتبة الوسائط
- رفع صور/GIF/فيديو/صوت حتى 50 MB
- عرض مكتبة مرئية مع روابط قابلة للنسخ
- إدراج مباشر في كود الأوامر من محرر الأوامر

## الأوامر — محرر متقدم
- عرض/تعديل كود الأوامر مباشرة من الداشبورد
- قالب جاهز لأوامر جديدة
- دعم إدراج مرجع الوسائط في الأوامر

## أنظمة الحماية (Michael Engine)
- **Stealth** — تصفح صفحات، تدوير User-Agent، نوم ليلي (1-8 صباحاً)
- **Human Typing** — تأخير كتابة واقعي قبل كل رد
- **Outgoing Throttle** — حد رسائل لكل محادثة وعالمياً
- **MQTT Health Check** — إعادة اتصال تلقائي عند الانقطاع
- **Keep-Alive** — نبضة كل 8-18 دقيقة
- **Rate Limit** — 8 أوامر/10 ثوانٍ لكل مستخدم
- **Uprotection** (`src/protection/Uprotection.js`) — killswitch مخفي ومشفر، يفحص GitHub كل 10 دقائق، يوقف البوت فوراً عند الإشارة

## سجل النظام (لوحة التحكم)
- تبويب "📋 سجل النظام" في الداشبورد — يلتقط جميع console.log/warn/error/info
- بث فوري عبر Socket.IO + نقطة `/api/logs` (آخر 600 سجل)
- فلترة حسب المستوى + تمرير تلقائي

## قاعدة البيانات
SQLite — `data/bot.db`  
- Users, Threads, CommandLogs

## GitHub
https://github.com/castrolmocro/fb-messenger-bot  
⚠️ لا يُرفع للـ GitHub بدون إذن المستخدم
