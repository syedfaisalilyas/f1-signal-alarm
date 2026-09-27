// copysona — copy Sona's (@sonaabeyg) trades on paper.
//
// Every minute: fetch her newest posts (through the tg.i-c-a.su mirror), OCR
// any screenshot (MEXC cards), and read each post with fixed rules (parse.mjs —
// no AI). Clear posts become paper actions (open / add entry / set SL / SL to
// entry / half book / close). When a post is unclear, the user gets a Telegram
// question with tap buttons; the answer (a button, or text like "xrp", "long",
// "open xrp long 1.53 sl 1.49", "close xrp", "skip") decides. Send "status" for
// the books. The user can also send those commands any time to steer it.
//
//   node tools/sona/copysona.mjs            run forever
//   node tools/sona/copysona.mjs --once     one poll, then exit (testing)
//   node tools/sona/copysona.mjs --replay <postId>   read one old post, print, don't trade
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOME, sleep, logger, loadJSON, saveJSON, price, listed, tgSend, tgUpdates, tgAnswer, esc } from './common.mjs';
import { readPost, readUser, coinsIn, readCard } from './parse.mjs';
import * as P from './paper.mjs';
import { makeTicker } from './live.mjs';
import { publish } from './publish.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CHANNEL = 'sonaabeyg';
const MIRROR = 'https://tg.i-c-a.su';
const POLL_MS = 60e3, TICK_MS = 20e3, CTX = 40, MAX_OPEN = 4;
const log = logger('copysona');
const STATE_F = 'copysona.json';
const S = loadJSON(STATE_F, { lastId: 0, ctx: [], tgOffset: 0, pending: [], qSeq: 0, book: P.makeBook('copysona', 100) });
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
// macOS: Vision (ocr.swift). Linux (the VPS): tesseract. Either way it's only a
// helper for reading her MEXC cards.
const MAC = process.platform === 'darwin';
const OCR_BIN = join(HOME, 'ocr');
function ensureOcr() {
  if (!MAC || existsSync(OCR_BIN)) return Promise.resolve();
  return new Promise((res, rej) => execFile('swiftc', ['-O', join(HERE, 'ocr.swift'), '-o', OCR_BIN], e => e ? rej(e) : res()));
}
function ocr(path) {
  if (!MAC) return new Promise(res => execFile('tesseract', [path, 'stdout'], { timeout: 60000 }, (e, out) =>
    res(e ? '' : out.split('\n').map(l => l.trim()).filter(Boolean).join(' | '))));
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

// ── reading her posts ─────────────────────────────────────────────────────
// Prices first (the reader drops numbers that are nowhere near the coin's
// price, like "liquidation below 30,000"), then the rules in parse.mjs.
async function readOne(post, hints = {}) {
  const ctx = S.ctx.filter(p => p.id < post.id).slice(-CTX);
  const coins = new Set([...coinsIn(post.text || ''), readCard(post.ocr)?.coin, hints.coin, ...S.book.positions.map(p => p.coin)].filter(Boolean));
  const px = {};
  for (const c of coins) px[c] = await price(c).catch(() => null);
  return readPost(post, ctx, S.book.positions, c => px[c] ?? null, hints);
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
  const p = findPos({ ...a, coin, position_id: a.position_id || '' });
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

const quoteOf = p => (p.text || '').trim() || (p.ocr ? `[screenshot] ${p.ocr.slice(0, 160)}` : '[image]');

async function run(actions, summary, posts) {
  const done = [];
  for (const a of actions) done.push(...await execute(a, { summary, posts }).catch(e => [`error: ${e.message}`]));
  save();
  if (done.length) {
    log('did', done.join(' | '));
    await tgSend(`📋 <b>copysona</b> (paper)\n<i>${esc(summary)}</i>\n${done.map(esc).join('\n')}`);
  }
}

async function ask(post, r, hints) {
  const id = ++S.qSeq;
  const opts = [...r.options.slice(0, 4), { label: '🚫 Ignore' }];
  const kb = { inline_keyboard: opts.map((o, i) => [{ text: o.label, callback_data: `q:${id}:${i}` }]) };
  const mid = await tgSend(`❓ <b>copysona needs you</b>\nShe posted (<a href="https://t.me/sonaabeyg/${post.id}">#${post.id}</a>):\n<i>${esc(quoteOf(post).slice(0, 400))}</i>\n\n${esc(r.question)}\n\nTap a button, or reply with the coin / "long" / "short", or e.g. <code>open xrp long 1.53 sl 1.49</code>, or <code>skip</code>.`, null, kb);
  S.pending.push({ id, tg: mid, post, hints, options: opts, question: r.question, at: Date.now() });
  save();
  log('asked', `#${post.id}`, r.question);
}

async function handle(posts, hints = {}) {
  for (const post of posts) {
    const r = await readOne(post, hints);
    if (r.actions.length) { log('read', `#${post.id}`, '→', r.summary); await run(r.actions, r.summary, [post]); }
    if (r.question) await ask(post, r, hints);
  }
}

async function status() {
  // sonabot has no Telegram reader of its own — this bot answers for both.
  const books = [S.book, loadJSON('sonabot.json', null)?.book].filter(Boolean);
  const prices = {};
  for (const b of books) for (const p of b.positions) prices[p.coin] ??= await price(p.coin).catch(() => null);
  await tgSend(`<pre>${esc(books.map(b => P.summary(b, prices)).join('\n\n'))}</pre>`);
}

// the user's answer to question q: a button index, or text
async function answer(q, pick, text) {
  S.pending = S.pending.filter(x => x !== q); save();
  const o = pick != null ? q.options[pick] : null;
  if (o && !o.actions && !o.hint) { log('user ignored', `#${q.post.id}`); await tgSend('👍 ignored'); return; }
  if (o?.actions) { log('user chose', o.label); await run(o.actions.map(a => ({ ...a, from_post: q.post.id })), `you chose: ${o.label}`, [q.post]); return; }
  const u = o?.hint ? { hint: o.hint } : readUser(text || '');
  if (u.skip) { await tgSend('👍 skipped'); return; }
  if (u.actions) { await run(u.actions.map(a => ({ ...a, from_post: q.post.id })), `you said: ${text}`, [q.post]); return; }
  if (u.hint) { log('user hint', JSON.stringify(u.hint)); await handle([q.post], { ...q.hints, ...u.hint }); return; }
  S.pending.push(q); save();
  await tgSend('I didn\'t get that — tap a button, or send e.g. <code>xrp</code>, <code>long</code>, <code>open xrp long 1.53 sl 1.49</code>, or <code>skip</code>.');
}

async function checkReplies() {
  const { offset, msgs } = await tgUpdates(S.tgOffset);
  S.tgOffset = offset;
  for (const m of msgs) {
    if (m.callback) {
      await tgAnswer(m.cbId);
      const [, qid, i] = m.callback.split(':');
      const q = S.pending.find(x => x.id === +qid);
      if (!q) { await tgSend('That question was already answered.'); continue; }
      await answer(q, +i, null);
      continue;
    }
    const t = m.text.trim(), u = readUser(t);
    if (u.status) { await status(); continue; }
    const q = S.pending.find(x => x.tg === m.replyTo) || (m.replyTo == null && S.pending.length === 1 ? S.pending[0] : null);
    if (q) { await answer(q, null, t); continue; }
    // not an answer: a direct command ("close xrp", "open sol long sl 80", "be tao")
    if (u.actions) { await run(u.actions, `you said: ${t}`, []); continue; }
    await tgSend(S.pending.length ? `${S.pending.length} questions are open — reply to the one you mean.` : 'Send <code>status</code>, or a command like <code>close xrp</code>, <code>half tao</code>, <code>be ltc</code>, <code>sl xrp 1.45</code>, <code>open sol long 84 sl 80</code>.');
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
  S.ctx = ms.filter(m => m.id < id).map(m => ({ id: m.id, date: m.date, text: (m.message || '').replace(/<br>/g, '\n').replace(/<[^>]+>/g, ''), media: m.media?._ || null, reply: m.reply_to?.reply_to_msg_id || null }));
  const m = ms.find(x => x.id === id);
  if (!m) { console.log('post not on that page'); process.exit(1); }
  const post = { id, date: m.date, text: (m.message || '').replace(/<br>/g, '\n').replace(/<[^>]+>/g, ''), media: m.media?._ || null, reply: m.reply_to?.reply_to_msg_id || null };
  if (post.media === 'messageMediaPhoto') { const img = await mirror(`media/${CHANNEL}/${id}`); if (img?.buf) { post.img = join(HOME, 'img', `${id}.jpg`); writeFileSync(post.img, img.buf); post.ocr = await ocr(post.img); } }
  S.book = P.makeBook('replay', 100);
  console.log(JSON.stringify(await readOne(post), null, 1));
  process.exit(0);
}
if (!S.lastId) await seed();
if (argv[0] === '--once') { await poll(); await checkReplies(); await tick(); process.exit(0); }

log(`copysona started (paper, ${P.SIZING}, rule reader); equity ${P.equity(S.book).toFixed(2)}`);
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
