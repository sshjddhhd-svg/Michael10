"use strict";
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const sqlite3 = require('sqlite3');
const root = path.resolve(__dirname, '..');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function eventually(fn, ms = 15000) {
  const end = Date.now() + ms; let last;
  while (Date.now() < end) { try { const v = await fn(); if (v) return v; } catch (e) { last = e; } await delay(150); }
  throw last || new Error('timed out');
}
function countCommands(file, user = "999") {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(file, sqlite3.OPEN_READONLY, err => {
      if (err) return reject(err);
      db.get('SELECT COUNT(*) AS n FROM CommandLogs WHERE userID = ?', [user], (e, row) => {
        db.close(); if (e) reject(e); else resolve(row.n);
      });
    });
  });
}

test('three isolated account processes share admin changes and route dashboard requests', { timeout: 60000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multi-bot-'));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ botName: 'jarfis', prefix: '/', ownerID: 'owner', adminIDs: [], dashboardPassword: 'test-password', cronJobs: [] }));
  const server = net.createServer(); await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port; await new Promise(r => server.close(r));
  let child = spawn(process.execPath, ['src/index.js'], { cwd: root, env: { ...process.env, PORT: String(port), BOT_DATA_DIR: dir, NODE_OPTIONS: `--require=${path.join(root, 'test/fixtures/mock-facebook.js')}` }, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = ''; child.stdout.on('data', d => logs += d); child.stderr.on('data', d => logs += d);
  t.after(async () => { child.kill('SIGTERM'); await Promise.race([new Promise(r => child.once('exit', r)), delay(3000)]); fs.rmSync(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${port}`;
  await eventually(async () => (await fetch(base + '/api/ping')).ok).catch(e => { throw new Error(e.message + '\n' + logs.slice(-6000)); });
  const unauth = await fetch(base + '/api/cookies', { headers: { 'X-Account-ID': '2' } }); assert.equal(unauth.status, 401);
  const login = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'test-password' }) });
  assert.equal(login.status, 200); const cookie = login.headers.get('set-cookie').split(';')[0];
  const call = (url, slot, method = 'GET', body) => fetch(base + url, { method, headers: { cookie, 'Content-Type': 'application/json', 'X-Account-ID': String(slot) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  await eventually(async () => (await call('/api/account-status', 2)).ok && (await call('/api/account-status', 3)).ok);
  assert.equal((await (await call('/api/config', 1)).json()).botName, 'Michael');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'config.json'))).botName, 'jarfis');
  assert.equal((await call('/api/cookies', 4)).status, 400);
  for (const id of [1, 2, 3]) {
    const r = await call('/api/cookies', id, 'POST', { cookies: `c_user=${id}00; xs=fake${id}` });
    assert.equal(r.status, 200, await r.text());
  }
  for (const id of [1, 2, 3]) {
    await eventually(async () => { const d = await (await call('/api/account-status', id)).json(); return d.status === 'online' && d.uid === `${id}00`; });
    const d = await (await call('/api/cookies', id)).json(); assert.equal(d.uid, `${id}00`);
  }
  const admin = await call('/api/admins', 1, 'POST', { uid: '999' }); assert.equal(admin.status, 200);
  for (const id of [1, 2, 3]) {
    const dbfile = path.join(dir, id === 1 ? 'bot.db' : `bot-${id}.db`);
    await eventually(async () => await countCommands(dbfile) > 0);
    const threads = await (await call('/api/threads', id)).json();
    assert.ok(threads.some(x => x.threadID === `thread-${id}00`));
    assert.ok(threads.every(x => x.threadID === `thread-${id}00`));
    const exec = await (await call('/api/execute', id, 'POST', { command: 'uid', threadID: `thread-${id}00` })).json();
    assert.equal(exec.ok, 1);
    const sent = await call('/api/send', id, 'POST', { threadID: `direct-${id}`, message: `hello-${id}` });
    assert.equal(sent.status, 200);
    assert.match(fs.readFileSync(path.join(dir, `sent-${id}00.jsonl`), 'utf8'), new RegExp(`hello-${id}`));
  }
  // The same conversation ID has separate journal text for each account.
  for (const id of [1, 2, 3]) {
    const text = `خبر ${id}  مسافتان\nالسطر الثاني`;
    const result = await (await call('/api/execute', id, 'POST', { command: 'جريدة', args: [text], threadID: 'shared' })).json();
    assert.equal(result.ok, 1);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, `copy-messages-${id}.json`))).shared, text);
  }
  // Restoring a backup reloads the account worker's cached journal as well as the file.
  const backup = await (await call('/api/backup/now', 1, 'POST', {})).json();
  assert.ok(backup.lastBackup?.ts);
  await call('/api/execute', 2, 'POST', { command: 'جريدة', args: ['محتوى مؤقت'], threadID: 'shared' });
  const restored = await call(`/api/backup/restore/${backup.lastBackup.ts}`, 1, 'POST', {});
  assert.equal(restored.status, 200);
  await eventually(async () => {
    const state = await (await call('/api/account-status', 2)).json();
    return state.status === 'online';
  });
  await call('/api/execute', 2, 'POST', { command: 'انسخ', args: ['وقت', '1s'], threadID: 'shared' });
  await call('/api/execute', 2, 'POST', { command: 'انسخ', threadID: 'shared' });
  await eventually(async () => {
    const lines = fs.readFileSync(path.join(dir, 'sent-200.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    return lines.some(item => item.tid === 'shared' && item.msg === 'خبر 2  مسافتان\nالسطر الثاني');
  }, 12000);
  await call('/api/execute', 2, 'POST', { command: 'توقف', threadID: 'shared' });
  // A helper admin promoted from account 2 is immediately shared with all accounts.
  const promote = await (await call('/api/execute', 2, 'POST', { command: 'ارفع', args: ['777'], threadID: 'thread-200' })).json();
  assert.equal(promote.ok, 1);
  for (const id of [1, 2, 3]) {
    const dbfile = path.join(dir, id === 1 ? 'bot.db' : `bot-${id}.db`);
    await eventually(async () => await countCommands(dbfile, '777') > 0);
  }
  const removed = await call('/api/cookies', 2, 'DELETE'); assert.equal(removed.status, 200);
  await eventually(async () => (await (await call('/api/account-status', 2)).json()).status === 'offline');
  assert.equal((await (await call('/api/account-status', 1)).json()).status, 'online');
  assert.equal((await (await call('/api/account-status', 3)).json()).status, 'online');
  // Volume-backed credentials/config survive a service restart.
  child.kill('SIGTERM'); await new Promise(r => child.once('exit', r));
  child = spawn(process.execPath, ['src/index.js'], { cwd: root, env: { ...process.env, PORT: String(port), BOT_DATA_DIR: dir, NODE_OPTIONS: `--require=${path.join(root, 'test/fixtures/mock-facebook.js')}` }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', d => logs += d); child.stderr.on('data', d => logs += d);
  await eventually(async () => (await fetch(base + '/api/ping')).ok);
  const again = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'test-password' }) });
  const cookieAgain = again.headers.get('set-cookie').split(';')[0];
  for (const id of [1, 3]) await eventually(async () => {
    const r = await fetch(base + '/api/account-status', { headers: { cookie: cookieAgain, 'X-Account-ID': String(id) } });
    if (!r.ok) return false; const state = await r.json(); return state.status === 'online' && state.uid === `${id}00`;
  });
  assert.ok(JSON.parse(fs.readFileSync(path.join(dir, 'config.json'))).adminIDs.includes('999'));
  for (const id of [1, 3]) {
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, `copy-messages-${id}.json`))).shared, `خبر ${id}  مسافتان\nالسطر الثاني`);
    const r = await fetch(base + '/api/execute', { method: 'POST', headers: { cookie: cookieAgain, 'Content-Type': 'application/json', 'X-Account-ID': String(id) }, body: JSON.stringify({ command: 'انسخ', threadID: 'shared' }) });
    assert.equal((await r.json()).ok, 1);
  }
});
