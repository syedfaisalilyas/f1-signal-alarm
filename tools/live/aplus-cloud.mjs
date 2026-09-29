// A+ gold + silver scanner for the cloud (GitHub Actions), so phone alerts keep
// coming when the laptop is off. Same rules as the local MT5 scanner:
//   trade only with the 15m + 1h trend, zones from recent 5m swing points,
//   yesterday's high/low and broken levels; FORMING when price nears a zone,
//   CONFIRMED on a strong 5m rejection close. Skips: news +-20 min (FF high/medium,
//   USD/AUD/EUR/GBP/JPY/CAD/CNY), swing points in the path (stop-hunt risk), < 1.8R.
// Prices come from Dukascopy (close to MT5, can differ by ~$0.5 on gold).
// Runs for RUN_MIN minutes, checking every 20 s. Pushes to ntfy (ASCII titles only).

const TOPIC = process.env.NTFY_TOPIC || 'faisalgold24';
const RUN_MIN = +(process.env.RUN_MIN || 330);
const RISK = 30;
const UA = 'Mozilla/5.0';
const SYMS = [
  { inst: 'XAU/USD', name: 'GOLD', val: 1, d: 1 },    // $ per 1.0 move per 0.01 lot
  { inst: 'XAG/USD', name: 'SILVER', val: 50, d: 3 },
];
const TF = { '5m': ['5MIN', 300], '15m': ['15MIN', 900], '1h': ['1HOUR', 3600] };

async function get(url, headers = {}) {
  for (let t = 0; t < 3; t++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(20000), headers: { 'User-Agent': UA, ...headers } });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.text();
    } catch (e) {
      if (t === 2) throw e;
      await new Promise(z => setTimeout(z, 1500 * (t + 1)));
    }
  }
}

async function bars(inst, tf, limit) {
  const url = 'https://freeserv.dukascopy.com/2.0/index.php?path=chart%2Fjson3&instrument=' + encodeURIComponent(inst) +
    `&offer_side=B&interval=${TF[tf][0]}&splits=true&stocks=true&limit=${limit}&time_direction=P&timestamp=${Date.now()}&jsonp=_cb`;
  const body = await get(url, { Referer: 'https://freeserv.dukascopy.com/2.0/?path=chart/index' });
  const rows = JSON.parse(body.slice(body.indexOf('(') + 1, body.lastIndexOf(')'))).filter(Boolean);
  return rows.map(r => ({ t: r[0] / 1000, o: r[1], h: r[2], l: r[3], c: r[4] })).sort((a, b) => a.t - b.t);
}

async function push(title, msg, pri = 'high', tag = 'hourglass') {
  console.log(new Date().toISOString().slice(11, 19), title, '|', msg);
  try {
    await fetch('https://ntfy.sh/' + TOPIC, { method: 'POST', headers: { Title: title, Priority: pri, Tags: tag }, body: msg });
  } catch (e) { console.log('ntfy failed', e.message); }
}

const ema = (a, n) => { const k = 2 / (n + 1); let e = a[0].c; for (const b of a) e = b.c * k + e * (1 - k); return e; };
const atr = (a, n = 14) => { let s = 0; for (let i = a.length - n; i < a.length; i++) s += Math.max(a[i].h - a[i].l, Math.abs(a[i].h - a[i - 1].c), Math.abs(a[i].l - a[i - 1].c)); return s / n; };
const rsi = (a, n = 14) => {
  let g = 0, l = 0;
  for (let i = 1; i <= n; i++) { const d = a[i].c - a[i - 1].c; d > 0 ? g += d : l -= d; }
  g /= n; l /= n;
  for (let i = n + 1; i < a.length; i++) { const d = a[i].c - a[i - 1].c; g = (g * (n - 1) + Math.max(d, 0)) / n; l = (l * (n - 1) + Math.max(-d, 0)) / n; }
  return 100 - 100 / (1 + g / (l || 1e-9));
};
function pivots(a, n = 3) {
  const H = [], L = [];
  for (let i = n; i < a.length - n; i++) {
    let h = 1, l = 1;
    for (let j = i - n; j <= i + n; j++) { if (j === i) continue; if (a[j].h >= a[i].h) h = 0; if (a[j].l <= a[i].l) l = 0; }
    if (h) H.push({ p: a[i].h, i }); if (l) L.push({ p: a[i].l, i });
  }
  return { H, L };
}

let NEWS = [];
async function loadNews() {
  try {
    const j = JSON.parse(await get('https://nfs.faireconomy.media/ff_calendar_thisweek.json'));
    NEWS = j.filter(e => (e.impact === 'High' || e.impact === 'Medium') && ['USD', 'AUD', 'EUR', 'GBP', 'JPY', 'CAD', 'CNY'].includes(e.country))
      .map(e => ({ t: Date.parse(e.date), n: e.country + ' ' + e.title }));
    console.log('news events loaded:', NEWS.length);
  } catch (e) { console.log('news load failed', e.message); }
}

const st = {};
async function scan(S) {
  const [m5all, m15all, h1all] = await Promise.all([bars(S.inst, '5m', 300), bars(S.inst, '15m', 200), bars(S.inst, '1h', 200)]);
  const now = Date.now() / 1000;
  const done = m5all.filter(b => b.t + 300 <= now + 3), q15 = m15all.filter(b => b.t + 900 <= now + 3), q1 = h1all.filter(b => b.t + 3600 <= now + 3);
  const px = m5all.at(-1).c, c = done.at(-1), p = done.at(-2);
  const k = st[S.name] || (st[S.name] = { last: 0, lf: null, lc: null });
  const newBar = c.t !== k.last, first = !k.last; k.last = c.t;
  const f = x => x.toFixed(S.d), a5 = atr(done), a15 = atr(q15);
  const down = ema(q15, 20) < ema(q15, 50) && q1.at(-1).c < ema(q1, 50);
  const up = ema(q15, 20) > ema(q15, 50) && q1.at(-1).c > ema(q1, 50);
  if (!down && !up) return;
  const r1 = rsi(q1);
  const recent = done.slice(-48), { H, L } = pivots(recent);
  const lvls = [];
  if (down) { for (const x of H) lvls.push(x.p); for (const x of L) if (recent.slice(x.i + 1).some(b => b.c < x.p - 0.2 * a5)) lvls.push(x.p); }
  else { for (const x of L) lvls.push(x.p); for (const x of H) if (recent.slice(x.i + 1).some(b => b.c > x.p + 0.2 * a5)) lvls.push(x.p); }
  // yesterday's high / low (UTC day) as extra levels
  const dayStart = Math.floor(now / 86400) * 86400, yd = q1.filter(b => b.t >= dayStart - 86400 && b.t < dayStart);
  if (yd.length) { lvls.push(Math.max(...yd.map(b => b.h)), Math.min(...yd.map(b => b.l))); }
  const w = 0.35 * a15;
  const Z = [];
  for (const v of lvls.filter(v => down ? v > px : v < px).sort((x, y) => down ? x - y : y - x)) {
    const z = Z.at(-1);
    if (z && Math.abs(v - z.ref) < w) { z.lo = Math.min(z.lo, v - w / 2); z.hi = Math.max(z.hi, v + w / 2); z.n++; }
    else Z.push({ ref: v, lo: v - w / 2, hi: v + w / 2, n: 1 });
  }
  const near = Z.slice(0, 2);
  const tgt = down ? L.map(x => x.p).filter(v => v < px).sort((x, y) => y - x) : H.map(x => x.p).filter(v => v > px).sort((x, y) => x - y);
  if (first) return;
  for (const z of near) {
    const dist = down ? z.lo - px : px - z.hi;
    const lf = k.lf;
    if (dist <= 0.6 * a5 && !(lf && Math.abs(lf.ref - z.ref) < a15 && Date.now() - lf.t < 45 * 60e3)) {
      k.lf = { ref: z.ref, t: Date.now() };
      await push(`${S.name} ${down ? 'SELL' : 'BUY'} setup forming`, `Price ${f(px)} near zone ${f(z.lo)}-${f(z.hi)} (${z.n} touch${z.n > 1 ? 'es' : ''}). Wait for the ${down ? 'red' : 'green'} 5m close. Don't enter yet. (cloud)`, 'default', 'hourglass');
    }
    if (!newBar) continue;
    const rng = c.h - c.l || 1e-9, body = Math.abs(c.c - c.o);
    const touched = down ? c.h >= z.lo : c.l <= z.hi, strong = body >= 0.5 * rng && body >= 0.4 * a5;
    const rej = down ? (c.c < c.o && c.c < z.lo && c.c < p.l + 0.1 * a5) : (c.c > c.o && c.c > z.hi && c.c > p.h - 0.1 * a5);
    const lc = k.lc;
    if (!(touched && strong && rej) || (lc && Math.abs(lc.ref - z.ref) < a15 && Date.now() - lc.t < 60 * 60e3)) continue;
    k.lc = { ref: z.ref, t: Date.now() };
    const sl = down ? Math.max(c.h, z.hi) + 0.3 * a5 : Math.min(c.l, z.lo) - 0.3 * a5, rk = Math.abs(sl - c.c);
    const t1 = tgt.find(v => Math.abs(v - c.c) >= 1.5 * rk) ?? (down ? c.c - 2 * rk : c.c + 2 * rk), t2 = down ? c.c - 3 * rk : c.c + 3 * rk;
    const rr = Math.abs(t1 - c.c) / rk;
    const lot = Math.max(0.01, Math.floor(RISK / (rk * S.val)) / 100);
    const why = [];
    const nw = NEWS.find(e => Math.abs(Date.now() - e.t) <= 20 * 60e3); if (nw) why.push('news: ' + nw.n);
    const pools = (down ? L : H).map(x => x.p).filter(v => down ? (v < c.c && v > c.c - 1.2 * rk) : (v > c.c && v < c.c + 1.2 * rk));
    if (pools.length) why.push(`swing ${down ? 'lows' : 'highs'} ${pools.map(f).join('/')} in the path`);
    if (rr < 1.8) why.push(`only ${rr.toFixed(1)}R`);
    if (why.length) { console.log(`skipped ${S.name} @ ${f(c.c)}: ${why.join('; ')}`); continue; }
    const grade = (down ? r1 < 25 : r1 > 75) ? 'A (H1 RSI stretched - smaller size)' : 'A+';
    await push(`${S.name} ${down ? 'SELL' : 'BUY'} ${grade} @ ${f(c.c)}`,
      `Zone ${f(z.lo)}-${f(z.hi)} rejected. SL ${f(sl)}, TP1 ${f(t1)} (${rr.toFixed(1)}R), TP2 ${f(t2)} (3R). Lot ${lot.toFixed(2)} ~ $${(lot * 100 * rk * S.val).toFixed(0)} risk. Dukascopy price - check MT5. (cloud)`,
      'urgent', 'white_check_mark');
  }
}

await loadNews();
const end = Date.now() + RUN_MIN * 60e3;
let lastNews = Date.now();
while (Date.now() < end) {
  for (const S of SYMS) { try { await scan(S); } catch (e) { console.log(S.name, 'error', e.message); } }
  if (Date.now() - lastNews > 6 * 3600e3) { await loadNews(); lastNews = Date.now(); }
  await new Promise(z => setTimeout(z, 20000));
}
