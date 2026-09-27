// Publish copysona's trades to GitHub so the Calls page (🟣 Sona tab) can
// show her channel trades next to the strategy's. copysona runs on the Mac
// (it needs the user's Claude login), so it pushes; the page reads
// copysona.json from the `sona-live` branch. Uses the local `gh` login.
import { execFile } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { HOME } from './common.mjs';
import * as P from './paper.mjs';

const REPO = 'syedfaisalilyas/f1-signal-alarm', BRANCH = 'sona-live', FILE = 'copysona.json';

function gh(args, input) {
  return new Promise((res, rej) => {
    const c = execFile('gh', args, { timeout: 60000 }, (e, out, err) => e ? rej(new Error((err || e.message).slice(0, 200))) : res(out));
    if (input) c.stdin.end(input);
  });
}

async function ensureBranch() {
  try { await gh(['api', `repos/${REPO}/branches/${BRANCH}`]); return; } catch { }
  const sha = JSON.parse(await gh(['api', `repos/${REPO}/git/ref/heads/main`])).object.sha;
  await gh(['api', '-X', 'POST', `repos/${REPO}/git/refs`, '-f', `ref=refs/heads/${BRANCH}`, '-f', `sha=${sha}`]);
}

const side = p => p.side === 'L' ? 1 : -1;
function view(p, eq) {
  const a = P.avgPx(p);
  return {
    id: p.id, coin: p.coin, side: side(p), status: p.status,
    entries: p.legs.map(l => ({ px: l.px, filled: l.filled, market: !!l.market })), avg: a,
    sl: p.sl, slTemp: !!p.slProvisional, slHard: p.slMode === 'touch', tps: p.tps, bookedHalf: !!p.bookedHalf,
    marginPct: p.marginPct, lev: p.lev, post: p.postId || +(String(p.src).replace('#', '')) || null,
    quote: p.quote || '', note: p.note || '', createdAt: p.createdAt, closedAt: p.closedAt || null, exitWhy: p.exitWhy || null,
    pnl: +p.realized.toFixed(2), pnlPct: +(p.realized / eq * 100).toFixed(2), exits: p.exits
  };
}

let branchOk = false, lastSent = '';
// Returns 'sent', 'same' or throws.
export async function publish(S, extra = {}) {
  const b = S.book, eq = P.equity(b);
  const doc = {
    channel: 'sonaabeyg', sizing: P.SIZING, equity: +eq.toFixed(2), start: b.start,
    open: b.positions.map(p => view(p, eq)),
    closed: b.history.filter(p => p.exits.length && Date.now() - p.closedAt < 90 * 864e5).map(p => view(p, eq)).reverse(),
    asking: S.pending.length, lastPost: S.lastId, ...extra
  };
  const body = JSON.stringify(doc);
  // heartbeat: re-send unchanged content at most every 10 min so the page knows the bot is alive
  const key = body + Math.floor(Date.now() / 600e3);
  if (key === lastSent) return 'same';
  doc.updatedAt = Date.now();
  if (!branchOk) { await ensureBranch(); branchOk = true; }
  let sha;
  try { sha = JSON.parse(await gh(['api', `repos/${REPO}/contents/${FILE}?ref=${BRANCH}`])).sha; } catch { }
  const f = join(HOME, 'publish.json');
  writeFileSync(f, JSON.stringify({ message: 'copysona update', branch: BRANCH, content: Buffer.from(JSON.stringify(doc)).toString('base64'), ...(sha ? { sha } : {}) }));
  await gh(['api', '-X', 'PUT', `repos/${REPO}/contents/${FILE}`, '--input', f]);
  lastSent = key;
  return 'sent';
}
