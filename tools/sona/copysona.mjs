// copysona — copy Sona's (@sonaabeyg) trades on paper.
//
// Every minute: fetch her newest posts (through the tg.i-c-a.su mirror — t.me
// is TLS-blocked on this network), OCR any screenshot, and hand the new posts
// plus the last 40 for context to headless Claude (`claude -p`, runs on the
// user's plan) with rules.md. Claude answers with actions (open / add entry /
// set SL / SL to entry / half book / close); the paper book executes them.
// When Claude can't tell what she means it asks the user on Telegram and the
// trade waits for the answer. Send the bot "status" for the book.
//
//   node tools/sona/copysona.mjs            run forever
//   node tools/sona/copysona.mjs --once     one poll, then exit (testing)
//   node tools/sona/copysona.mjs --replay <postId>   interpret one old post, print, don't trade
import { execFile, spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOME, sleep, logger, loadJSON, saveJSON, price, listed, tgSend, tgUpdates, esc } from './common.mjs';
import * as P from './paper.mjs';
import { makeTicker } from './live.mjs';
import { publish } from './publish.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CHANNEL = 'sonaabeyg';
const MIRROR = 'https://tg.i-c-a.su';
const POLL_MS = 60e3, TICK_MS = 20e3, CTX = 40, MAX_OPEN = 4;
const MODEL = process.env.SONA_MODEL || 'sonnet';
const log = logger('copysona');
const STATE_F = 'copysona.json';
const S = loadJSON(STATE_F, { lastId: 0, ctx: [], tgOffset: 0, pending: [], book: P.makeBook('copysona', 100) });
const save = () => saveJSON(STATE_F, S);

// ── mirror ────────────────────────────────────────────────────────────────
async function mirror(path, tries = 8) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(`${MIRROR}/${path}`, { headers: { 'user-agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(60000) });
      const ct = r.headers.get('content-type') || '';
      const buf = Buffer.from(await r.arrayBuffer());
      if (!ct.includes('json')) return { buf, ct };
      const j = JSON.parse(buf.toString());
      if (j.messages || j.success !== false) return { json: j };
      const fw = /FLOOD_WAIT_(\d+)/.exec(JSON.stringify(j));
      await sleep(((fw ? +fw[1] : 15) + 1) * 1000);
    } catch { await sleep(10000); }
  }
  return null;
}

// ── OCR ───────────────────────────────────────────────────────────────────
const OCR_BIN = join(HOME, 'ocr');
function ensureOcr() {
  if (existsSync(OCR_BIN)) return Promise.resolve();
  return new Promise((res, rej) => execFile('swiftc', ['-O', join(HERE, 'ocr.swift'), '-o', OCR_BIN], e => e ? rej(e) : res()));
}
function ocr(path) {
  return new Promise(res => execFile(OCR_BIN, [path], { timeout: 60000 }, (e, out) => res(e ? '' : (out.split('\t')[1] || '').trim())));
}

async function fetchNew() {
  const r = await mirror(`json/${CHANNEL}?limit=20`);
  if (!r?.json?.messages) return [];
  const fresh = r.json.messages.filter(m => m.id > S.lastId && m.post !== false).sort((a, b) => a.id - b.id);
  const out = [];
  for (const m of fresh) {
    const media = m.media?._ || null;
    const post = { id: m.id, date: m.date, text: (m.message || '').replace(/<br>/g, '\n').replace(/<[^>]+>/g, ''), media, reply: m.reply_to?.reply_to_msg_id || null };
    if (media === 'messageMediaPhoto') {
      const img = await mirror(`media/${CHANNEL}/${m.id}`);
      if (img?.buf && img.ct.startsWith('image')) {
        post.img = join(HOME, 'img', `${m.id}.jpg`);
        writeFileSync(post.img, img.buf);
        post.ocr = await ocr(post.img);
      }
    }
    out.push(post);
  }
  return out;
}

// ── interpretation ────────────────────────────────────────────────────────
const SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    actions: {
      type: 'array', items: {
        type: 'object', additionalProperties: false,
        properties: {
          type: { enum: ['open', 'add_entry', 'set_sl', 'set_tp', 'sl_to_entry', 'book_half', 'close', 'cancel_orders'] },
          coin: { type: 'string' }, side: { enum: ['LONG', 'SHORT', ''] },
          entry1: { type: ['number', 'null'] }, entry2: { type: ['number', 'null'] },
          sl: { type: ['number', 'null'] }, tps: { type: 'array', items: { type: 'number' } },
          margin_pct: { type: ['number', 'null'] }, leverage: { type: ['number', 'null'] },
          position_id: { type: 'string' }, from_post: { type: 'number' }
        },
        required: ['type', 'coin', 'side', 'entry1', 'entry2', 'sl', 'tps', 'margin_pct', 'leverage', 'position_id', 'from_post']
      }
    },
    question: { type: 'string' }, guess: { type: 'string' }, summary: { type: 'string' }
  },
  required: ['actions', 'question', 'guess', 'summary']
};

const pkt = s => new Date(s * 1000 + 5 * 3600e3).toISOString().slice(5, 16).replace('T', ' ');
function renderPost(p) {
  return `#${p.id} [${pkt(p.date)} PKT]${p.reply ? ` reply_to #${p.reply}` : ''}${p.media ? ` <${p.media.replace('messageMedia', '').toLowerCase()}>` : ''}${p.img ? ` image=${p.img}` : ''}\n` +
    (p.text ? p.text.trim() + '\n' : '') + (p.ocr ? `  [OCR of image: ${p.ocr}]\n` : '');
}

async function interpret(newPosts, userAnswer = null) {
  const b = S.book;
  const prices = {};
  for (const p of b.positions) prices[p.coin] ??= await price(p.coin).catch(() => null);
  const posList = b.positions.map(p => `${p.id}: ${p.coin} ${p.side === 'L' ? 'LONG' : 'SHORT'} ${p.status} entries ${p.legs.map(l => `${P.fmt(l.px)}${l.filled ? '✓' : ''}`).join(', ')} SL ${P.fmt(p.sl)}${p.slProvisional ? ' (temporary — she has not given it yet)' : ''} TPs ${p.tps.map(P.fmt).join(',') || 'none'} now ${P.fmt(prices[p.coin])}`).join('\n') || 'none';
  const recentClosed = b.history.slice(-6).map(p => `${p.coin} ${p.side === 'L' ? 'LONG' : 'SHORT'} entries ${p.legs.map(l => P.fmt(l.px)).join('/')} SL ${P.fmt(p.sl)} closed: ${p.exitWhy}`).join('\n') || 'none';
  const newIds = new Set(newPosts.map(p => p.id));
  const ctx = S.ctx.filter(p => !newIds.has(p.id)).slice(-CTX);
  const prompt = `${readFileSync(join(HERE, 'rules.md'), 'utf8')}

# Earlier messages (context only — already handled)
${ctx.map(renderPost).join('\n') || 'none'}

# Our open paper positions
${posList}

# Recently closed
${recentClosed}

# NEW messages to act on now
${newPosts.map(renderPost).join('\n')}
${userAnswer ? `\n# The user answered your earlier question about these messages\n"${userAnswer}"\nUse this answer. Only ask again if it truly doesn't resolve it.\n` : ''}
Decide the actions for the NEW messages only.`;
  const args = ['-p', '--model', MODEL, '--output-format', 'json', '--json-schema', JSON.stringify(SCHEMA),
    '--tools', 'Read', '--allowedTools', 'Read', '--add-dir', join(HOME, 'img'), '--no-session-persistence', '--setting-sources', ''];
  for (let attempt = 0; attempt < 2; attempt++) {
    const out = await new Promise(res => {
      const c = spawn('claude', args, { cwd: HOME, stdio: ['pipe', 'pipe', 'pipe'] });
      let s = ''; c.stdout.on('data', d => s += d);
      const kill = setTimeout(() => c.kill('SIGKILL'), 300e3);
      c.on('close', () => { clearTimeout(kill); res(s); });
      c.stdin.end(prompt);
    });
    try { const j = JSON.parse(out); if (j.structured_output) return j.structured_output; log('claude: no structured output', (j.result || '').slice(0, 200)); }
    catch { log('claude: bad output', out.slice(0, 200)); }
    await sleep(5000);
  }
  return null;
}

// ── executing actions ─────────────────────────────────────────────────────
const TEMP_SL = coin => /^(BTC|ETH)$/.test(coin) ? 0.015 : 0.03;   // her typical zone depth
function findPos(a) {
  const b = S.book;
  return b.positions.find(p => p.id === a.position_id) ||
    b.positions.filter(p => p.coin === a.coin.toUpperCase() && (!a.side || p.side === a.side[0])).at(-1);
}

async function execute(a, why = {}) {
  const b = S.book, coin = a.coin.toUpperCase().replace(/USDT$/, '');
  const side = a.side ? a.side[0] : null;
  const say = [];
  if (a.type === 'open') {
    if (!side) return [`skipped ${coin}: no direction`];
    if (!(await listed(coin).catch(() => false))) return [`skipped ${coin}: not on MEXC futures`];
    const dup = b.positions.find(p => p.coin === coin && p.side === side);
    if (dup) {   // she re-posted or re-entered a coin we still hold: treat it as an update
      if (a.entry1 && !dup.legs.some(l => Math.abs(l.px - a.entry1) / a.entry1 < 0.003)) { P.addLeg(b, dup, a.entry1, { marginPct: a.margin_pct ?? undefined }); say.push(`${coin} extra entry ${P.fmt(a.entry1)}`); }
      if (a.entry2 && !dup.legs.some(l => Math.abs(l.px - a.entry2) / a.entry2 < 0.003)) { P.addLeg(b, dup, a.entry2, { marginPct: a.margin_pct ?? undefined }); say.push(`${coin} entry 2 ${P.fmt(a.entry2)}`); }
      if (a.sl) { P.setStop(dup, a.sl); say.push(`${coin} SL ${P.fmt(a.sl)} (30m close)`); }
      return say.length ? say : [`${coin}: already holding, nothing new`];
    }
    if (b.positions.length >= MAX_OPEN) return [`skipped ${coin}: already ${MAX_OPEN} trades open`];
    const px = await price(coin);
    const ref = a.entry1 ?? px;
    // An entry that is already through the current price is a market entry.
    const e1 = a.entry1 == null || (side === 'L' ? px < a.entry1 : px > a.entry1) ? null : a.entry1;
    const temp = a.sl == null;
    const sl = a.sl ?? +(ref * (1 - (side === 'L' ? 1 : -1) * TEMP_SL(coin))).toPrecision(6);
    try {
      const p = P.open(b, { coin, side, e1, e2: a.entry2, sl, slProvisional: temp, tps: a.tps, src: `#${a.from_post}`, mkt: px, ttlH: 120, marginPct: a.margin_pct ?? P.MARGIN_PCT, lev: a.leverage ?? P.LEV, note: why.summary || '' });
      // for the website: her own words and which post it came from
      const post = (why.posts || []).find(x => x.id === a.from_post) || why.posts?.at(-1);
      p.postId = post?.id ?? a.from_post; p.quote = (post?.text || post?.ocr || '').trim().slice(0, 400);
      say.push(`${coin} ${side === 'L' ? 'LONG' : 'SHORT'} ${e1 == null ? `at market ~${P.fmt(px)}` : `limit ${P.fmt(e1)}`}${a.entry2 ? ` + entry 2 ${P.fmt(a.entry2)}` : ''} · SL ${P.fmt(sl)}${temp ? ' (temporary until she gives it)' : ' (30m close)'}${a.tps.length ? ` · TP ${a.tps.map(P.fmt).join('/')}` : ''} · ${p.marginPct}% × ${p.lev}x per entry`);
      // market legs fill on the spot
      say.push(...P.onBar(b, p, { h: px, l: px, c: px, closed: false }));
    } catch (e) { say.push(`skipped ${coin}: ${e.message}`); }
    return say;
  }
  const p = findPos({ ...a, coin });
  if (!p) return [`${a.type} ${coin}: no such trade open — ignored`];
  const px = await price(p.coin);
  switch (a.type) {
    case 'add_entry': {   // no price = she added at market ("add rest 0.5% at cmp")
      const at = a.entry1 ?? a.entry2 ?? null;
      const mktNow = at == null || (p.side === 'L' ? px < at : px > at);
      P.addLeg(b, p, mktNow ? null : at, { mkt: px, marginPct: a.margin_pct ?? undefined });
      say.push(`${p.coin} extra entry ${mktNow ? `at market ~${P.fmt(px)}` : P.fmt(at)}${a.margin_pct ? ` (${a.margin_pct}% margin)` : ''}`);
      say.push(...P.onBar(b, p, { h: px, l: px, c: px, closed: false }));
      break;
    }
    case 'set_sl': if (a.sl) { P.setStop(p, a.sl); say.push(`${p.coin} SL ${P.fmt(a.sl)} (30m close)`); } break;
    case 'set_tp': P.setTps(p, a.tps); say.push(`${p.coin} TP ${a.tps.map(P.fmt).join('/')}`); break;
    case 'sl_to_entry': if (P.filledQty(p) > 0) { P.stopToEntry(p); P.cancelPending(p); say.push(`${p.coin} SL → entry ${P.fmt(p.sl)}`); } break;
    case 'book_half': if (P.filledQty(p) > 0) { say.push(P.closePart(b, p, 0.5, px, 'she: half book')); p.bookedHalf = true; P.stopToEntry(p); P.cancelPending(p); say.push(`${p.coin} SL → entry ${P.fmt(p.sl)}`); } break;
    case 'close': say.push(P.filledQty(p) > 0 ? P.closePart(b, p, 1, px, 'she: book') : P.cancel(b, p, 'she closed it')); break;
    case 'cancel_orders': P.cancelPending(p); if (!P.filledQty(p)) say.push(P.cancel(b, p, 'she cancelled')); else say.push(`${p.coin} pending entries cancelled`); break;
  }
  return say.filter(Boolean);
}

async function handle(posts, userAnswer = null) {
  const r = await interpret(posts, userAnswer);
  const ids = posts.map(p => '#' + p.id).join(',');
  if (!r) { log('could not interpret', ids); await tgSend(`⚠️ <b>copysona</b>: couldn't read her post ${ids}. Check the channel.`); return; }
  log('read', ids, '→', r.summary, JSON.stringify(r.actions));
  const done = [];
  for (const a of r.actions) done.push(...await execute(a, { summary: r.summary, posts }).catch(e => [`error: ${e.message}`]));
  save();
  if (done.length) {
    log('did', done.join(' | '));
    await tgSend(`📋 <b>copysona</b> (paper)\n<i>${esc(r.summary)}</i>\n${done.map(esc).join('\n')}`);
  }
  if (r.question) {
    const quote = posts.map(p => (p.text || p.ocr || '[image]').slice(0, 300)).join('\n');
    const mid = await tgSend(`❓ <b>copysona needs you</b>\nShe said:\n<i>${esc(quote)}</i>\n\n${esc(r.question)}\nMy guess: ${esc(r.guess || '—')}\n\n<b>Reply to this message</b> with the answer (or "skip").`);
    S.pending.push({ tg: mid, posts, question: r.question, at: Date.now() });
    save();
    log('asked', r.question);
  }
}

async function checkReplies() {
  const { offset, msgs } = await tgUpdates(S.tgOffset);
  S.tgOffset = offset;
  for (const m of msgs) {
    const t = m.text.trim();
    if (/^\/?status$/i.test(t)) {
      // sonabot has no Telegram reader of its own — this bot answers for both.
      const books = [S.book, loadJSON('sonabot.json', null)?.book].filter(Boolean);
      const prices = {};
      for (const b of books) for (const p of b.positions) prices[p.coin] ??= await price(p.coin).catch(() => null);
      await tgSend(`<pre>${esc(books.map(b => P.summary(b, prices)).join('\n\n'))}</pre>`);
      continue;
    }
    const q = S.pending.find(x => x.tg === m.replyTo) || (S.pending.length === 1 ? S.pending[0] : null);
    if (!q) { await tgSend(S.pending.length ? 'Reply to the exact question message so I know which one you mean.' : 'No open questions. Send "status" for the paper book.'); continue; }
    S.pending = S.pending.filter(x => x !== q);
    save();
    if (/^skip$/i.test(t)) { log('user skipped', q.question); await tgSend('👍 skipped'); continue; }
    log('user answered', q.question, '→', t);
    await handle(q.posts, t);
  }
  save();
}

// ── market ticks ──────────────────────────────────────────────────────────
const ticker = makeTicker();
async function tick() {
  const ev = await ticker(S.book, log);
  if (ev.length) { save(); log('market', ev.join(' | ')); await tgSend(`📋 <b>copysona</b> (paper)\n${ev.map(esc).join('\n')}`); }
}

// ── main ──────────────────────────────────────────────────────────────────
async function poll() {
  const posts = await fetchNew();
  if (!posts.length) return;
  S.lastId = Math.max(S.lastId, ...posts.map(p => p.id));
  const worth = posts.filter(p => p.text.trim() || p.img);
  S.ctx.push(...posts.map(({ id, date, text, media, reply, img, ocr }) => ({ id, date, text, media, reply, img, ocr })));
  S.ctx = S.ctx.slice(-80);
  save();
  if (worth.length) await handle(worth);
}

async function seed() {
  // First start: take the last 40 posts as context only — never trade old posts.
  const r = await mirror(`json/${CHANNEL}?limit=40`);
  const ms = (r?.json?.messages || []).sort((a, b) => a.id - b.id);
  S.ctx = ms.map(m => ({ id: m.id, date: m.date, text: (m.message || '').replace(/<br>/g, '\n').replace(/<[^>]+>/g, ''), media: m.media?._ || null, reply: m.reply_to?.reply_to_msg_id || null }));
  S.lastId = ms.at(-1)?.id || 0;
  save();
  log('seeded; watching from post', S.lastId);
}

const argv = process.argv.slice(2);
await ensureOcr();
if (argv[0] === '--replay') {
  // Interpret one old post with the posts before it as context. Prints, trades nothing.
  const id = +argv[1];
  // History comes from ~/.sona/history.jsonl (the year pulled on 27 Sep 2026) — the mirror can't page by id.
  const hist = readFileSync(join(HOME, 'history.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).sort((a, b) => a.id - b.id);
  const ms = hist.filter(m => m.id <= id && m.id > id - 60).map(m => ({ id: m.id, date: m.date, message: m.text, media: m.media ? { _: m.media } : null, reply_to: m.reply ? { reply_to_msg_id: m.reply } : null }));
  S.ctx = ms.filter(m => m.id < id).map(m => ({ id: m.id, date: m.date, text: (m.message || '').replace(/<[^>]+>/g, ''), media: m.media?._ || null, reply: m.reply_to?.reply_to_msg_id || null }));
  const m = ms.find(x => x.id === id);
  if (!m) { console.log('post not on that page'); process.exit(1); }
  const post = { id, date: m.date, text: (m.message || '').replace(/<[^>]+>/g, ''), media: m.media?._ || null, reply: m.reply_to?.reply_to_msg_id || null };
  if (post.media === 'messageMediaPhoto') { const img = await mirror(`media/${CHANNEL}/${id}`); if (img?.buf) { post.img = join(HOME, 'img', `${id}.jpg`); writeFileSync(post.img, img.buf); post.ocr = await ocr(post.img); } }
  S.book = P.makeBook('replay', 100);
  console.log(JSON.stringify(await interpret([post]), null, 1));
  process.exit(0);
}
if (!S.lastId) await seed();
if (argv[0] === '--once') { await poll(); await checkReplies(); await tick(); process.exit(0); }

log(`copysona started (paper, ${P.SIZING}, model ${MODEL}); equity ${P.equity(S.book).toFixed(2)}`);
await tgSend(`🟢 <b>copysona</b> started — paper mode, copying Sona's trades. Send "status" anytime.`);
let nextPoll = 0;
for (;;) {
  try {
    if (Date.now() >= nextPoll) { nextPoll = Date.now() + POLL_MS; await poll(); }
    await checkReplies();
    await tick();
    await publish(S).catch(e => log('publish', e.message));
  } catch (e) { log('loop error', e.stack?.split('\n')[0] || e.message); }
  await sleep(TICK_MS);
}
