// Paper trading book, shared by copysona, sonabot and the sonabot backtest so
// all three fill, stop and book by the same rules.
//
// Her way of trading, as the book models it:
//   · two entries — entry 1 at the top of the zone, entry 2 (DCA) deeper —
//     each half of the position ("0.5% first entry, 0.5% second entry")
//   · stop is a 30m candle CLOSE beyond the level, wicks don't count
//     ("sl if candle close below X"); after "SL to entry" it becomes a hard
//     touch stop at the average price
//   · "SL to entry 50% book": at the first target, bank half, stop to entry
// Sizing is hers (user, 27 Sep: "no risk as sona do it"): each entry puts
// MARGIN_PCT of the balance up as margin at LEV leverage, cross margin
// ("liq zero" — the whole balance backs it). 0.5% × 200x = one full balance
// of notional per entry, so a 1% move is ~1% of the account per filled leg.
// The whole book is liquidated if a loss ever eats the balance.
export const MARGIN_PCT = +(process.env.SONA_MARGIN_PCT || 0.5);
export const LEV = +(process.env.SONA_LEV || 200);
export const SIZING = `her sizing: ${MARGIN_PCT}% margin × ${LEV}x per entry`;
export const FEE = 0.0002;       // MEXC futures taker, per side
export const SLIP = 0.0005;      // market fills pay this much extra
export const DISASTER_R = 1;     // hard stop this many R beyond the candle-close stop (= 2R from entry)

let seq = 0;
const newId = (bot) => `${bot}-${Date.now().toString(36)}${(seq++).toString(36)}`;

export function makeBook(bot, start = 100) {
  return { bot, start, realized: 0, positions: [], history: [] };
}

export function equity(book) { return book.start + book.realized; }

const dir = p => p.side === 'L' ? 1 : -1;
export function filledQty(p) { return p.legs.filter(l => l.filled).reduce((s, l) => s + l.qty, 0) - p.closedQty; }
export function avgPx(p) {
  const f = p.legs.filter(l => l.filled);
  const q = f.reduce((s, l) => s + l.qty, 0);
  return q ? f.reduce((s, l) => s + l.px * l.qty, 0) / q : null;
}
export function unrealized(p, px) { const a = avgPx(p); return a == null ? 0 : (px - a) * dir(p) * filledQty(p); }

// One entry = marginPct of the balance × lev, in coins at that entry's price.
const legQty = (book, px, marginPct, lev) => equity(book) * marginPct / 100 * lev / px;

// e1/e2: limit prices, or null for "at market". sl required (provisional is fine).
export function open(book, { coin, side, e1, e2 = null, sl, slProvisional = false, tps = [], src = '', note = '', ttlH = 72, autoBE = true, mkt = null, marginPct = MARGIN_PCT, lev = LEV }) {
  const ref = e1 ?? mkt;
  if (ref == null || sl == null) throw new Error('open needs an entry (or market price) and a stop');
  if ((side === 'L' && sl >= ref) || (side === 'S' && sl <= ref)) throw new Error(`stop ${sl} is on the wrong side of entry ${ref}`);
  const p = {
    id: newId(book.bot), coin: coin.toUpperCase(), side, status: 'pending', marginPct, lev,
    legs: [{ px: e1, qty: legQty(book, ref, marginPct, lev), filled: false, market: e1 == null }],
    sl, slMode: 'close', slProvisional, tps: [...tps], tpHit: 0, autoBE, bookedHalf: false,
    closedQty: 0, realized: 0, createdAt: Date.now(), expiresAt: Date.now() + ttlH * 3600e3, src, note, exits: []
  };
  if (e2 != null) p.legs.push({ px: e2, qty: legQty(book, e2, marginPct, lev), filled: false });
  book.positions.push(p);
  return p;
}

// px null = at market; mkt is then the current price (for sizing).
export function addLeg(book, p, px, { mkt = null, marginPct = p.marginPct ?? MARGIN_PCT } = {}) {
  p.legs.push({ px, qty: legQty(book, px ?? mkt, marginPct, p.lev ?? LEV), filled: false, market: px == null });
}
export function setStop(p, sl, mode = 'close') { p.sl = sl; p.slMode = mode; p.slProvisional = false; }
export function setTps(p, tps) { p.tps = [...tps]; p.tpHit = 0; }
export function stopToEntry(p) { const a = avgPx(p); if (a != null) { p.sl = a; p.slMode = 'touch'; p.slProvisional = false; cancelPending(p); } }
export function cancelPending(p) { p.legs = p.legs.filter(l => l.filled); }

// Close `frac` of what is filled, at px. Returns the event text.
export function closePart(book, p, frac, px, why, ts = Date.now()) {
  const q = filledQty(p) * frac;
  if (!(q > 0)) return null;
  const a = avgPx(p);
  const pnl = (px - a) * dir(p) * q - FEE * px * q;
  p.closedQty += q; p.realized += pnl; book.realized += pnl;
  p.exits.push({ px, q, pnl: +pnl.toFixed(4), why, ts });
  if (filledQty(p) <= 1e-12) finish(book, p, why, ts);
  return `${p.coin} ${p.side === 'L' ? 'LONG' : 'SHORT'} ${frac >= 0.999 ? 'closed' : `booked ${Math.round(frac * 100)}%`} @ ${fmt(px)} (${why}) ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)} USDT`;
}
function finish(book, p, why, ts) {
  p.status = 'closed'; p.closedAt = ts; p.exitWhy = why;
  cancelPending(p);
  book.positions = book.positions.filter(x => x !== p);
  book.history.push(p);
}
export function cancel(book, p, why) {
  if (filledQty(p) > 0) return null;
  finish(book, p, why, Date.now());
  return `${p.coin} order cancelled (${why})`;
}

export const fmt = x => x == null ? '—' : (Math.abs(x) >= 100 ? x.toFixed(1) : Math.abs(x) >= 1 ? x.toFixed(3) : x.toPrecision(4));

// Feed one bar (live: a tick as h=l=c=px, closed=false; at each 30m close the
// real candle with closed=true). Returns event strings.
export function onBar(book, p, { h, l, c, closed, t = Date.now() }) {
  const ev = [];
  const L = p.side === 'L';
  let filledNow = false;
  // 1. fills
  for (const leg of p.legs) {
    if (leg.filled) continue;
    if (leg.market) { leg.px = c * (1 + dir(p) * SLIP); leg.filled = true; leg.at = t; }
    else if (L ? l <= leg.px : h >= leg.px) { leg.filled = true; leg.at = t; }
    else continue;
    filledNow = true;
    const fee = FEE * leg.px * leg.qty; p.realized -= fee; book.realized -= fee;
    ev.push(`${p.coin} ${L ? 'LONG' : 'SHORT'} filled @ ${fmt(leg.px)}${p.legs.length > 1 ? ` (entry ${p.legs.indexOf(leg) + 1})` : ''}`);
    if (p.status === 'pending') p.status = 'open';
  }
  if (p.status === 'pending') {
    if (t > p.expiresAt) { const e = cancel(book, p, 'zone never reached'); if (e) ev.push(e); }
    return ev;
  }
  const a = avgPx(p);
  // Disaster stop: the candle-close stop can't protect a crash candle (10 Oct
  // 2025: SUI closed so far under the zone that a 2 USDT risk lost 50). A hard
  // stop DISASTER_R beyond the close-stop caps it.
  if (p.slMode === 'close') {
    const R = Math.abs(a - p.sl), hard = p.sl - dir(p) * DISASTER_R * R;
    if (L ? l <= hard : h >= hard) { ev.push(closePart(book, p, 1, hard, `disaster stop ${fmt(hard)}`, t)); return ev.filter(Boolean); }
  }
  // Cross margin: the balance is the only buffer. A loss that eats it all
  // liquidates (checked after the disaster stop — price passes that first).
  const worst = L ? l : h, eq = equity(book);
  if (a != null && (a - worst) * dir(p) * filledQty(p) >= eq) {
    const liqPx = a - dir(p) * eq / filledQty(p);
    ev.push(closePart(book, p, 1, liqPx, 'LIQUIDATED — balance gone', t));
    return ev.filter(Boolean);
  }
  // A bar that filled us can't also be trusted to have hit a target after the
  // fill (we don't know the order inside the bar) — only the stop is judged.
  if (filledNow) {
    if (closed && p.slMode === 'close' && (L ? c < p.sl : c > p.sl)) ev.push(closePart(book, p, 1, c, `30m close beyond SL ${fmt(p.sl)}`, t));
    return ev.filter(Boolean);
  }
  // 2. hard stop (after "SL to entry") — checked before targets, the conservative order
  if (p.slMode === 'touch' && (L ? l <= p.sl : h >= p.sl)) { ev.push(closePart(book, p, 1, p.sl, 'stop at entry', t)); return ev; }
  // 3. targets
  while (p.status !== 'closed' && p.tpHit < p.tps.length && (L ? h >= p.tps[p.tpHit] : l <= p.tps[p.tpHit])) {
    const px = p.tps[p.tpHit], last = p.tpHit === p.tps.length - 1;
    p.tpHit++;
    if (last) ev.push(closePart(book, p, 1, px, `TP${p.tpHit}`, t));
    else if (!p.bookedHalf) { ev.push(closePart(book, p, 0.5, px, `TP${p.tpHit}`, t)); p.bookedHalf = true; stopToEntry(p); ev.push(`${p.coin} SL → entry ${fmt(p.sl)}`); }
    else ev.push(closePart(book, p, 1 / (p.tps.length - p.tpHit + 1), px, `TP${p.tpHit}`, t));
  }
  if (p.status === 'closed') return ev;
  // 4. her standing rule when no targets were given: at +1R bank half, stop to entry
  if (p.autoBE && !p.bookedHalf && !p.tps.length && !p.slProvisional) {
    const R = Math.abs(a - p.sl), best = L ? h : l;
    if (R > 0 && (best - a) * dir(p) >= R) {
      const px = a + dir(p) * R;
      ev.push(closePart(book, p, 0.5, px, '+1R: SL to entry, 50% book', t)); p.bookedHalf = true; stopToEntry(p);
      ev.push(`${p.coin} SL → entry ${fmt(p.sl)}`);
    }
  }
  // 5. candle-close stop
  if (closed && p.slMode === 'close' && (L ? c < p.sl : c > p.sl)) ev.push(closePart(book, p, 1, c, `30m close beyond SL ${fmt(p.sl)}`, t));
  return ev.filter(Boolean);
}

export function summary(book, prices = {}) {
  const lines = [];
  const unr = book.positions.reduce((s, p) => s + (prices[p.coin] ? unrealized(p, prices[p.coin]) : 0), 0);
  const closed = book.history.filter(p => p.exits.length);
  const wins = closed.filter(p => p.realized > 0).length;
  lines.push(`${book.bot}: equity ${(equity(book) + unr).toFixed(2)} USDT (start ${book.start}) · closed ${closed.length} · wins ${wins}`);
  for (const p of book.positions) {
    const a = avgPx(p), px = prices[p.coin];
    lines.push(`• ${p.coin} ${p.side === 'L' ? 'LONG' : 'SHORT'} ${p.status} ${a ? '@ ' + fmt(a) : 'orders ' + p.legs.map(l => fmt(l.px)).join('/')} SL ${fmt(p.sl)}${p.slProvisional ? ' (temp)' : ''}${p.slMode === 'touch' ? ' (hard)' : ''}${px && a ? ` · now ${fmt(px)} · ${unrealized(p, px) >= 0 ? '+' : ''}${unrealized(p, px).toFixed(2)}` : ''}`);
  }
  return lines.join('\n');
}
