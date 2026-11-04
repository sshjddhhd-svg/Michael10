// Loaded only by the integration test through NODE_OPTIONS, never in production.
const Module = require('module');
const fs = require('fs');
const path = require('path');
const original = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === '@dongdev/fca-unofficial') return (options, cb) => {
    const uid = options.appState.find(c => c.key === 'c_user').value;
    const api = {
      getCurrentUserID: () => uid,
      getAppState: () => options.appState,
      setOptions: () => {},
      stopListening: cb => cb?.(),
      getUserInfo: (id, cb) => cb(null, { [id]: { name: 'Admin' } }),
      getThreadInfo: (id, cb) => cb(null, { threadName: `group-${uid}` }),
      sendMessage: (msg, tid, cb) => {
        fs.appendFileSync(path.join(process.env.BOT_DATA_DIR, `sent-${uid}.jsonl`), JSON.stringify({ tid, msg }) + '\n');
        cb?.(null, { messageID: 'mock-message' });
        return Promise.resolve();
      },
      editMessage: () => {},
      sendTypingIndicator: () => () => {},
      listen: callback => {
        let tick = 0;
        const interval = setInterval(() => { const senderID = ++tick % 2 ? '999' : '777'; callback(null, { type: 'message', body: '/ping', senderID,
          threadID: `thread-${uid}`, messageID: `${senderID}-${Date.now()}`, isGroup: true }); }, 500);
        return () => clearInterval(interval);
      },
    };
    setImmediate(() => cb(null, api));
  };
  if (request.endsWith('/checkLiveCookie') || request === './checkLiveCookie') return async () => true;
  if (request.includes('/protection/')) return new Proxy({}, { get: () => () => {} });
  return original.apply(this, arguments);
};
