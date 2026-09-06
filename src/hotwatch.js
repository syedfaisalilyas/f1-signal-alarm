// The alarm for the thing you asked about: a coin whose hours wake up.
//
// The measurement behind it (tools/hourly-lead.js) says a hot-hours day is a
// filter, not a signal — 11.8% of them are followed by a big day against a
// 6.3% base rate, but the signal fires on 41% of all coin-days. Alarming on
// that would be alarming four times a day for nothing. So this narrows it in
// three ways before it wakes you up:
//
//   the transition, not the state — the hour has to go wide after six CALM
//   hours. A coin that has been hot since yesterday is not news, and the same
//   coin cannot re-fire every hour while it runs.
//
//   the coin has to be worth it — its median day already ranges enough to pay
//   for a trade, and it has to be liquid enough to get out of.
//
//   then it is finalised — the survivors go through the full coin report and
//   the alarm carries a side, a stop and targets, or says plainly that there
//   is no trade yet and gives the two prices that would make one.
//
// The thresholds are not guesses. `tools/hourly-lead.js --trigger --grid` walks
// 116 coins over 30 days and scores every combination by what the next 24 hours
// paid from the trigger hour's close. Loose settings are worthless — a 2× hour
// on a 6%-a-day coin fires 70 times a day for a 1.2× edge. These are what came
// back:
//
//     5× hour · 2× volume · calm before · median day 15%+
//     54 fires in 30 days across the board — under two a day
//     85% saw a 10% move in the next 24h, 61% saw 20%
//     against a base rate of 5.7% of hours — a 10.7× edge
//
// Two honest caveats on that 61%. It counts the biggest move in EITHER
// direction, so it is the odds of something happening, not of profit — you
// still have to be on the right side, which is what stage two is for. And 54
// fires is a small sample; treat it as the right order of magnitude, not a
// promise.
//
// What it still cannot do is tell you direction from the volatility alone.
// COLLECT's 90% day was down. That is why stage two exists.

import { universe } from './ignition.js';
import { coinReport } from './coinreport.js';

export const HOT_DEFAULTS = {
  market: 'futures',
  minQuoteVol: 5e6,     // liquid enough to leave
  minDailyPct: 15,      // …and its median DAY ranges at least this much
  ratio: 5,             // the hour is this × the coin's own median hour
  volX: 2,              // …on this × its median hour volume
  calm: 1.3,            // the six hours before were under this × median
  calmBars: 6,
  maxRunPct: 40,        // moved this much in 24h already = you are late, not early
  lookback: 4,          // how many closed hours back a wake-up still counts
  bars: 400,            // ~16 days of hourly candles, one request per coin
  concurrency: 8,
  confirm: 6            // how many candidates get the expensive second stage
};

const median = a => { const s = [...a].filter(v => v > 0).sort((x, y) => x - y); return s.length ? s[s.length >> 1] : 0; };
const rangePct = b => b.l > 0 ? (b.h - b.l) / b.l * 100 : 0;
const r2 = v => v === null || v === undefined || !isFinite(v) ? null : +v.toFixed(2);

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      try { out[idx] = await fn(items[idx]); } catch { out[idx] = null; }
    }
  }));
  return out;
}

// One hour, judged. Everything it needs ends at bar `i`, so the same function
// serves the live read and a walk back through history.
function judgeHour(row, closed, i, barsAgo, cfg) {
  const bar = closed[i];

  // Baseline stops before the trigger hour — an hour cannot be measured
  // against a normal it is itself part of.
  const hist = closed.slice(Math.max(0, i - 336), i);
  if (hist.length < 100) return null;
  const medR = median(hist.map(rangePct));
  const medV = median(hist.map(b => b.v));
  if (!(medR > 0) || !(medV > 0)) return null;

  const ratio = rangePct(bar) / medR;
  const volX = bar.v / medV;
  const before = closed.slice(Math.max(0, i - cfg.calmBars), i);
  const calmRatio = median(before.map(rangePct)) / medR;

  // Is this coin a mover at all? A 5× hour on something that ranges 1.5% a day
  // is 5× of nothing, and there is no trade in it whatever the ratio says.
  const dayRanges = [];
  for (let d = 1; d <= 14; d++) {
    const w = closed.slice(Math.max(0, i + 1 - d * 24), i + 1 - (d - 1) * 24);
    if (w.length < 20) continue;
    const hi = Math.max(...w.map(b => b.h)), lo = Math.min(...w.map(b => b.l));
    if (lo > 0) dayRanges.push((hi - lo) / lo * 100);
  }
  const dailyMed = median(dayRanges);

  if (!(ratio >= cfg.ratio && volX >= cfg.volX && calmRatio < cfg.calm && dailyMed >= cfg.minDailyPct)) return null;

  return {
    market: cfg.market, symbol: row.symbol,
    price: closed.at(-1).c, quoteVol: row.quoteVol, changePct: row.changePct,
    hourAt: bar.t, barsAgo,
    hourRangePct: r2(rangePct(bar)), medianHourPct: r2(medR),
    ratio: r2(ratio), volX: r2(volX), calmRatio: r2(calmRatio),
    hourChgPct: r2(bar.o > 0 ? (bar.c - bar.o) / bar.o * 100 : 0),
    dailyMedianPct: r2(dailyMed),
    // Woken up, or already gone? The alarm is for the first case.
    late: Math.abs(row.changePct) >= cfg.maxRunPct,
    strength: r2(ratio * Math.min(volX, 6))
  };
}

// Stage one, and the only part that runs on every coin. Pure, so the same
// judgement can be replayed over history without a network.
//
// It checks the last few closed hours, not only the newest, because the thing
// that runs it is not reliable. GitHub takes a `*/5 * * * *` cron and actually
// wakes the scanner up every two to three hours, so a watch that only ever
// read the hour just gone would sleep through most of what it is for. Walking
// back a few hours turns a late runner into a late alert instead of no alert —
// the same trade scan.js already makes for entries. The newest wake-up wins,
// and the calm-hours rule means a coin that has been running since cannot
// re-fire on the hours after its own start.
export function hotStart(row, bars, cfg = HOT_DEFAULTS) {
  const closed = bars.filter(b => b.closed);
  if (closed.length < 200) return null;
  const look = Math.max(1, cfg.lookback ?? 1);
  for (let back = 0; back < look; back++) {
    const hit = judgeHour(row, closed, closed.length - 1 - back, back, cfg);
    if (hit) return hit;
  }
  return null;
}

// Stage two: the report decides whether there is a trade, and the grade says
// how loudly to say so.
function grade(hit, rep) {
  const p = rep.plan, liq = rep.liquidity.verdict;
  if (liq === 'thin') return { grade: 'C', why: 'too thin to trade — ' + rep.liquidity.note };
  if (hit.late) return { grade: 'C', why: `already ${hit.changePct}% on the day — this is the middle of the move, not the start` };
  if (p.side !== 'WAIT' && (p.rr === null || p.rr >= 1.5)) return { grade: 'A', why: p.headline };
  if (p.side !== 'WAIT') return { grade: 'B', why: `${p.headline} — but only ${p.rr}:1 to the first target` };
  return { grade: 'B', why: p.headline };
}

// One sweep. Cheap on every coin, expensive on the few that survive.
export async function hotSweep(opts = {}) {
  const cfg = { ...HOT_DEFAULTS, ...opts };
  const list = await universe(cfg.market, cfg.minQuoteVol);
  const { fetchCandles } = await import('./providers.js');

  const hits = (await mapLimit(list, cfg.concurrency, async row => {
    const bars = await fetchCandles(cfg.market, row.symbol, '1h', cfg.bars);
    return hotStart(row, bars, cfg);
  })).filter(Boolean).sort((a, b) => b.strength - a.strength);

  const confirmed = [];
  for (const hit of hits.slice(0, cfg.confirm)) {
    try {
      const rep = await coinReport(cfg.market, hit.symbol, { ttl: 0 });
      confirmed.push({ ...hit, ...grade(hit, rep), report: rep });
    } catch (e) {
      confirmed.push({ ...hit, grade: 'C', why: 'could not build the report — ' + e.message, report: null });
    }
  }

  return { at: Date.now(), market: cfg.market, scanned: list.length, hits, confirmed };
}

// The alarm text. Same shape notify.js expects from buildMessage.
export function hotMessage(c) {
  const p = c.report?.plan, v = c.report?.volatility;
  const n = x => x === null || x === undefined ? '—'
    : Math.abs(x) >= 1000 ? x.toFixed(2) : Math.abs(x) >= 1 ? x.toFixed(4) : x.toPrecision(6);
  const icon = c.grade === 'A' ? '🔥' : '👀';
  const title = `${icon} HOT HOURS ${c.symbol}${p && p.side !== 'WAIT' ? ' — ' + p.side : ''}`;

  const when = !c.barsAgo ? 'just woke up'
    : `woke up ${c.barsAgo}h ago (${new Date(c.hourAt).toISOString().slice(11, 16)} UTC)`;
  const lines = [
    `Its hours ${when}: ${c.hourRangePct}% in one hour, ${c.ratio}× its normal ${c.medianHourPct}%, on ${c.volX}× volume.`,
    `The six hours before were quiet (${c.calmRatio}× normal) — this is the turn, not the middle.`,
    `Typical day for this coin ranges ${c.dailyMedianPct}% · 24h volume $${(c.quoteVol / 1e6).toFixed(1)}M · ${c.changePct >= 0 ? '+' : ''}${c.changePct?.toFixed(1)}% today`,
    ''
  ];

  if (p && p.side !== 'WAIT') {
    lines.push(p.headline,
      `Entry ${n(p.entry)}`,
      `Stop  ${n(p.stop)}   (${p.riskPct}%)`,
      ...p.targets.map((t, i) => `TP${i + 1}   ${n(t)}`),
      p.rr ? `Reward:risk ${p.rr}:1 · size at ${p.lev || '?'}×` : '');
  } else {
    lines.push(p?.headline || 'No trade yet — the report found nothing to take.',
      ...(p?.triggers || []).map(t => `${t.side}: ${t.text}`));
  }

  if (v) lines.push('', `Volatility is ${v.state} — ${v.note}`);
  lines.push('', 'A wide hour says a move is coming, not which way. Direction above comes from trend, levels and flow — check the chart before you take it.');

  const body = lines.filter(x => x !== undefined).join('\n');
  return {
    title, body,
    telegram: `<b>${title}</b>\n<pre>${body}</pre>`,
    priority: c.grade === 'A' ? 5 : 4,
    tags: c.grade === 'A' ? ['fire'] : ['eyes']
  };
}
