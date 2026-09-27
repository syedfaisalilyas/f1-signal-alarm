// The 🟣 Sona tab on the Calls page: her zone setups on her 13 coins, why
// each one is there, and every one tracked to TP or SL. Called by calls.js on
// each 5-min scan; the result is doc.sona in calls.json.
//
// Tracking follows her rules (same as the paper book in paper.mjs), in R:
//   entry 1 at the zone edge, entry 2 deeper — each half the position;
//   stop = a 30m CLOSE beyond the SL (plus a hard disaster stop 2R out);
//   TP1 → book half, stop to entry; TP2 → close the rest;
//   an order that doesn't fill in 48 h expires; a new zone replaces an unfilled one.
import { setup, btcRegime, COINS, CFG } from './zones.mjs';

const TTL = 48 * 3600;              // seconds an unfilled setup waits
const KEEP = 90 * 86400e3;          // closed history kept
// sonabot.mjs --backtest, 27 Sep 2026 (Binance 30m, fees in) and the check of her own posted calls
export const SONA_BT = {
  period: '27 Sep 2025 – 27 Sep 2026', coins: COINS.length, trades: 290, tp1: 57, avgR: -0.09,
  her: { n: 44, avgR: 0.3, full: 41 }
};

const dir = c => c.side;
const sig = x => +(+x).toPrecision(6);

// 4H → closed UTC days (6 bars each)
function days(b4) {
  const out = [];
  for (const b of b4) {
    const d = b.t - b.t % 86400, last = out.at(-1);
    if (last && last.t === d) { last.h = Math.max(last.h, b.h); last.l = Math.min(last.l, b.l); last.c = b.c; last.n++; }
    else out.push({ t: d, h: b.h, l: b.l, c: b.c, n: 1 });
  }
  return out.filter(d => d.n === 6);
}

function why(coin, s, px, regime, btcRange) {
  const L = s.side === 'L', z = s.zone;
  const pts = [...z.pts].sort((a, b) => a.t - b.t);
  return {
    zoneLine: `${L ? 'Demand' : 'Supply'} zone ${sig(z.lo)} – ${sig(z.hi)} on the 4H chart: price ${L ? 'bounced up' : 'dropped'} from here ${z.touch} times in the last 60 days, and no 4H candle has closed ${L ? 'below' : 'above'} it since.`,
    reactions: pts.map(p => ({ t: p.t, px: sig(p.v), move: +(p.react * 100).toFixed(1) })),
    btc: `BTC leads (her rule): BTC's daily close is in the ${regime > 0 ? 'top' : 'bottom'} half of its 20-day range (${sig(btcRange[0])} – ${sig(btcRange[1])}), so ${regime > 0 ? 'only longs' : 'only shorts'} are taken.`,
    plan: [
      `Entry 1 at the ${L ? 'top' : 'bottom'} of the zone, half size (her "0.5% first entry").`,
      `Entry 2 (DCA) at the ${L ? 'bottom' : 'top'} of the zone, the other half.`,
      `SL only if a 30-min candle CLOSES ${L ? 'below' : 'above'} ${sig(s.sl)} — wicks don't count. Hard safety stop 2R out for crash candles.`,
      `TP1 = +1R from entry 1: book 50% and move the stop to entry.`,
      s.next && sig(s.tps[1]) === sig(L ? s.next.lo : s.next.hi)
        ? `TP2 = the next ${L ? 'supply' : 'demand'} zone at ${sig(s.tps[1])} — where price turned before.`
        : `TP2 = ${sig(s.tps[1])} (${s.next ? `the next ${L ? 'supply' : 'demand'} zone at ${sig(L ? s.next.lo : s.next.hi)} is too close, so` : `no ${L ? 'supply' : 'demand'} zone nearby, so`} at least ${CFG.MIN_RR}R).`
    ],
    away: +((L ? px - s.e1 : s.e1 - px) / px * 100).toFixed(2)
  };
}

// Walk 5m bars since the call's last update. Returns true when something changed.
function track(c, m5) {
  const L = c.side > 0;
  for (const b of m5) {
    if (b.t <= c.lastT) continue;
    c.lastT = b.t;
    if (c.status === 'waiting') {
      if (b.t > c.createdAt / 1000 + TTL) { close(c, 'expired', 0, b.t); return; }
      if (L ? b.l <= c.e1 : b.h >= c.e1) {
        c.legs = [c.e1]; c.status = 'open'; c.filledAt = b.t * 1000;
        if (L ? b.l <= c.e2 : b.h >= c.e2) c.legs.push(c.e2);
      }
      continue;                                  // the fill bar can't be trusted for targets
    }
    if (c.status === 'open' && c.legs.length === 1 && (L ? b.l <= c.e2 : b.h >= c.e2)) c.legs.push(c.e2);
    const avg = c.legs.reduce((s, x) => s + x, 0) / c.legs.length, R = Math.abs(avg - c.sl);
    const rAt = p => (p - avg) * dir(c) / R;
    const hard = c.sl - dir(c) * R;
    if (c.status === 'open' && (L ? b.l <= hard : b.h >= hard)) { close(c, 'sl', c.booked + (1 - c.part) * rAt(hard), b.t); return; }
    if (c.status === 'half' && (L ? b.l <= c.beAt : b.h >= c.beAt)) { close(c, 'be', c.booked, b.t); return; }
    if (c.status === 'open' && (L ? b.h >= c.tp1 : b.l <= c.tp1)) {
      c.booked += 0.5 * rAt(c.tp1); c.part = 0.5; c.status = 'half'; c.beAt = avg; c.avg = avg;
    }
    if (c.status === 'half' && (L ? b.h >= c.tp2 : b.l <= c.tp2)) { close(c, 'tp', c.booked + 0.5 * rAt(c.tp2), b.t); return; }
    const barEnd = b.t + 300;
    if (c.status === 'open' && barEnd % 1800 === 0 && (L ? b.c < c.sl : b.c > c.sl)) { close(c, 'sl', rAt(b.c), b.t); return; }
    c.avg = avg;
  }
}
function close(c, status, r, t) {
  c.status = status; c.r = +r.toFixed(2); c.closedAt = t * 1000;
}

// prev: last doc.sona · markets: [{id, name, tv, dp}] · b4: id → 4H bars · m5: id → 5m bars · price: id → last
export function sonaPass({ prev, markets, b4, m5, price, btc4 }) {
  const calls = (prev?.calls || []).filter(c => ['waiting', 'open', 'half'].includes(c.status) || Date.now() - (c.closedAt || c.createdAt) < KEEP);
  const d = btc4 ? days(btc4) : [];
  const regime = btcRegime(d);
  const last20 = d.slice(-20), btcRange = last20.length ? [Math.min(...last20.map(x => x.l)), Math.max(...last20.map(x => x.h))] : [0, 0];
  for (const c of calls) if (['waiting', 'open', 'half'].includes(c.status) && m5[c.market]) track(c, m5[c.market]);
  for (const m of markets) {
    const px = price[m.id], k4 = b4[m.id];
    if (!k4 || k4.length < 100 || !(px > 0)) continue;
    const s = setup(k4.slice(-400), px, regime);
    const live = calls.find(c => c.market === m.id && ['waiting', 'open', 'half'].includes(c.status));
    if (live) { live.price = px; if (live.status !== 'waiting' || !s) continue; }
    if (!s) continue;
    // an unfilled setup whose zone changed is replaced by the new one
    if (live) {
      if (Math.abs(live.zone.lo - s.zone.lo) / s.zone.lo < 0.001 && live.side === (s.side === 'L' ? 1 : -1)) { Object.assign(live, { why: why(m.id, s, px, regime, btcRange) }); continue; }
      live.status = 'replaced'; live.closedAt = Date.now();
    }
    const nowT = Math.floor(Date.now() / 1000);
    calls.push({
      id: `${m.id}-sona-${s.side}-${sig(s.zone.lo)}-${nowT}`, market: m.id, coin: m.id.replace(/USDT$/, ''), name: m.name || m.id, tv: m.tv, dp: m.dp,
      side: s.side === 'L' ? 1 : -1, e1: sig(s.e1), e2: sig(s.e2), sl: sig(s.sl), tp1: sig(s.tps[0]), tp2: sig(s.tps[1]),
      zone: { lo: sig(s.zone.lo), hi: sig(s.zone.hi), touch: s.zone.touch },
      why: why(m.id, s, px, regime, btcRange), price: px, status: 'waiting', createdAt: Date.now(),
      lastT: m5[m.id]?.at(-1)?.t ?? nowT, legs: [], booked: 0, part: 0
    });
  }
  const shown = calls.filter(c => c.status !== 'replaced');
  return {
    updatedAt: Date.now(), regime, btcRange: btcRange.map(sig), coins: COINS, bt: SONA_BT,
    calls: shown.filter(c => c.status !== 'expired' || Date.now() - c.closedAt < 7 * 86400e3)
  };
}
