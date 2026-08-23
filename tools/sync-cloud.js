#!/usr/bin/env node
// Push the local watchlist to the cloud scanner.
//
// The app writes data/state.json; the scheduled runner reads
// cloud/watchlist.json. This copies the watches and settings across so adding a
// symbol on your Mac makes the cloud scan pick it up on the next run. Runtime
// state (what has already alerted) lives on the state branch and is untouched —
// a newly added symbol seeds silently rather than alerting on its history.

import fs from 'fs';
import path from 'path';

const local = path.join(process.cwd(), 'data', 'state.json');
const cloud = path.join(process.cwd(), 'cloud', 'watchlist.json');

if (!fs.existsSync(local)) {
  console.error('no data/state.json — run the app first, or add symbols in it');
  process.exit(1);
}

const s = JSON.parse(fs.readFileSync(local, 'utf8'));
const before = fs.existsSync(cloud) ? JSON.parse(fs.readFileSync(cloud, 'utf8')) : { watches: [] };

const next = { watches: s.watches || [], settings: s.settings || {} };
fs.writeFileSync(cloud, JSON.stringify(next, null, 2));

const ids = new Set(before.watches.map(w => w.id));
const added = next.watches.filter(w => !ids.has(w.id)).map(w => w.id);
const gone = before.watches.filter(w => !next.watches.some(n => n.id === w.id)).map(w => w.id);

console.log(`cloud watchlist: ${next.watches.length} watch(es)`);
if (added.length) console.log('  added:  ' + added.join(', '));
if (gone.length) console.log('  removed: ' + gone.join(', '));
if (!added.length && !gone.length) console.log('  unchanged');
console.log('\ncommit and push to apply:\n  git commit -am "sync watchlist" && git push');
