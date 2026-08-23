// Flat-file persistence. Small enough that JSON beats a database here.
import fs from 'fs';
import path from 'path';

const FILE = path.join(process.cwd(), 'data', 'state.json');
const EMPTY = { watches: [], settings: {}, pushSubs: [], log: [] };

let state = load();
let dirty = false;

function load() {
  try { return { ...EMPTY, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) }; }
  catch { return structuredClone(EMPTY); }
}

function flush() {
  if (!dirty) return;
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(state, null, 2));
  dirty = false;
}

// Every writer here is user-driven and infrequent (settings, watchlist, alert
// log), so write through immediately. Batching only created a window where a
// restart moments after a change silently lost it. The interval stays as a
// backstop for anything that mutates state directly.
setInterval(flush, 3000).unref();
process.on('exit', flush);
process.on('SIGINT', () => { flush(); process.exit(0); });

export const get = () => state;
export const save = () => { dirty = true; flush(); };

export function addWatch(w) {
  const id = `${w.market}:${w.symbol}:${w.interval}`;
  if (state.watches.some(x => x.id === id)) return null;
  const watch = { id, enabled: true, cfg: {}, addedAt: Date.now(), ...w };
  watch.id = id;
  state.watches.push(watch);
  save();
  return watch;
}

export function removeWatch(id) {
  const i = state.watches.findIndex(w => w.id === id);
  if (i < 0) return false;
  state.watches.splice(i, 1);
  save();
  return true;
}

export function updateWatch(id, patch) {
  const w = state.watches.find(x => x.id === id);
  if (!w) return null;
  Object.assign(w, patch);
  save();
  return w;
}

export function pushLog(entry) {
  state.log.unshift({ ...entry, at: Date.now() });
  if (state.log.length > 300) state.log.length = 300;
  save();
}

export function addSub(sub) {
  if (!state.pushSubs.some(s => s.endpoint === sub.endpoint)) {
    state.pushSubs.push(sub);
    save();
  }
}

export function removeSub(endpoint) {
  state.pushSubs = state.pushSubs.filter(s => s.endpoint !== endpoint);
  save();
}
