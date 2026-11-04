"use strict";

// A timer per thread coalesces repeated events without suppressing changes
// that arrive while a previous setTitle request is in flight.
const pending = new Map();
const versions = new Map();
const queues = new Map();

function locks() {
  return global._lockedNames || (global._lockedNames = new Map());
}
function cancel(threadID) {
  const timer = pending.get(threadID);
  if (timer) clearTimeout(timer);
  pending.delete(threadID);
}
function bump(threadID) {
  const version = (versions.get(threadID) || 0) + 1;
  versions.set(threadID, version);
  cancel(threadID);
  return version;
}
function enqueue(threadID, task) {
  const previous = queues.get(threadID) || Promise.resolve();
  const next = previous.catch(() => {}).then(task);
  queues.set(threadID, next);
  next.finally(() => { if (queues.get(threadID) === next) queues.delete(threadID); }).catch(() => {});
  return next;
}
function setTitle(api, name, threadID) {
  return new Promise((resolve, reject) => {
    api.setTitle(name, threadID, (err) => err ? reject(err) : resolve());
  });
}

async function lock(api, threadID, name) {
  const version = bump(threadID);
  return enqueue(threadID, async () => {
    if (versions.get(threadID) !== version) return false;
    await setTitle(api, name, threadID);
    if (versions.get(threadID) !== version) return false;
    locks().set(threadID, name);
    return true;
  });
}
function unlock(threadID) {
  bump(threadID);
  return locks().delete(threadID);
}
function onNameChange(api, threadID, newName) {
  const locked = locks().get(threadID);
  if (locked === undefined) return;
  if (newName === locked) { cancel(threadID); return; }
  if (pending.has(threadID)) return;
  const version = versions.get(threadID) || 0;
  const delay = 5000 + Math.floor(Math.random() * 5001);
  const timer = setTimeout(() => {
    if (pending.get(threadID) !== timer) return;
    pending.delete(threadID);
    enqueue(threadID, async () => {
      if ((versions.get(threadID) || 0) !== version || !locks().has(threadID)) return;
      await setTitle(api, locks().get(threadID), threadID);
    }).catch((error) => console.error(`[NAME LOCK] ${threadID}: ${error.message || error}`));
  }, delay);
  pending.set(threadID, timer);
}
function clearAll() {
  for (const id of pending.keys()) cancel(id);
  for (const id of locks().keys()) bump(id);
  locks().clear();
}
module.exports = { lock, unlock, onNameChange, clearAll };
