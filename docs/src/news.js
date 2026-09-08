// News for instruments that actually react to it.
//
// A crypto coin moves on its own flow. Gold and FX move on a calendar that is
// published days ahead, which makes "what is coming" a tradeable fact rather
// than commentary. Three things are worth knowing and all three are free:
//
//   calendar    ForexFactory's weekly JSON — event, currency, impact, forecast,
//               previous. No key. Covers the current week only, so past weeks
//               are accumulated on disk as they roll off.
//   headlines   Google News RSS. Titles and timestamps, nothing parsed from the
//               body — a headline's time is what matters for lining it up
//               against a candle.
//   impact      What past events DID, measured from price rather than claimed.
//               For every event already passed, the move over the 30 minutes
//               after its release, from real candles.
//
// The impact study is the part worth having. "CPI is high impact" is a label
// anyone can print; "the last four CPI releases moved gold 0.8%, 1.4%, 0.3%
// and 1.1% within half an hour, three of them up" is a number you can size a
// position against.

import { fetchCandles } from './providers.js';
import { reactionFor, directionFor, planFor, backtest } from './newsplan.js';

const CAL_URL = 'https://nfs.faireconomy.media/ff_calendar_thisweek.json';
const NEWS_URL = 'https://news.google.com/rss/search';
const UA = 'Mozilla/5.0 (compatible; f1-alarm/1.0)';

// This module runs in two places: the Node server, and the page on GitHub
// Pages via docs/engine.js. Only one of them has a filesystem, and importing
// `fs` at the top level would break the browser build outright — so the
// archive goes through a tiny adapter chosen at load time. In the page the
// archive is whatever the scheduled scanner published; localStorage keeps a
// copy so a failed fetch still renders something.
const isNode = typeof process !== 'undefined' && !!process.versions?.node;
let nodeFs = null, nodePath = null, ARCHIVE = null;
if (isNode) {
  nodeFs = (await import('fs')).default;
  nodePath = (await import('path')).default;
  ARCHIVE = nodePath.join(process.cwd(), 'data', 'calendar-archive.json');
}

const LS_KEY = 'f1calendararchive';

function readStore() {
  if (isNode) {
    try { return JSON.parse(nodeFs.readFileSync(ARCHIVE, 'utf8')); } catch { return []; }
  }
  try { return JSON.parse(localStorage.getItem(LS_KEY) || '[]'); } catch { return []; }
}

function writeStore(events) {
  if (isNode) {
    try {
      nodeFs.mkdirSync(nodePath.dirname(ARCHIVE), { recursive: true });
      nodeFs.writeFileSync(ARCHIVE, JSON.stringify(events));
    } catch { /* read-only fs — the live week still works */ }
    return;
  }
  try { localStorage.setItem(LS_KEY, JSON.stringify(events.slice(-4000))); } catch { /* private mode / quota */ }
}

const TTL = { cal: 15 * 60 * 1000, news: 10 * 60 * 1000, impact: 30 * 60 * 1000 };
const cache = new Map();

async function cached(key, ttl, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.val;
  const val = await fn();
  cache.set(key, { at: Date.now(), val });
  return val;
}

async function get(url, as = 'json') {
  const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`${res.status} ${url.split('?')[0]}`);
  return as === 'json' ? res.json() : res.text();
}

// ─────────────── which events matter to which instrument ───────────────
//
// Gold is priced in dollars and competes with dollar yields, so USD data moves
// it more than anything else — but a risk event anywhere can bid it as a haven.
// FX pairs care about their own two currencies. Everything else gets USD only.
const DRIVERS = {
  gold:   { currencies: ['USD'], extra: /fomc|fed|cpi|inflation|nonfarm|payroll|unemployment|ppi|gdp|powell|rate|treasury|jobless/i },
  silver: { currencies: ['USD'], extra: /fomc|fed|cpi|nonfarm|payroll|ppi|rate/i },
  oil:    { currencies: ['USD'], extra: /crude|oil|inventor|opec|gasoline/i }
};

function driversFor(instrument, symbol) {
  if (DRIVERS[instrument]) return DRIVERS[instrument];
  // EUR/USD -> both legs. USDJPY -> both legs.
  const legs = (symbol || '').toUpperCase().match(/[A-Z]{3}/g);
  if (legs && legs.length >= 2) return { currencies: [...new Set(legs)], extra: null };
  return { currencies: ['USD'], extra: null };
}

const IMPACT_RANK = { High: 3, Medium: 2, Low: 1, Holiday: 0 };

// ─────────────── calendar ───────────────

// The feed is one week wide and forgets. Every fetch merges into a file keyed
// by event id so past weeks survive, which is what makes "previous weeks" real
// instead of an empty section.
function archive(events) {
  const byId = new Map(readStore().map(e => [e.id, e]));
  for (const e of events) byId.set(e.id, { ...byId.get(e.id), ...e });
  // A year is plenty and keeps the file small enough to read in one go.
  const cutoff = Date.now() - 365 * 24 * 3600 * 1000;
  const out = [...byId.values()].filter(e => e.at > cutoff).sort((a, b) => a.at - b.at);
  writeStore(out);
  return out;
}

function readArchive() { return readStore(); }

// The page cannot fetch the calendar or Google News directly — neither sends
// CORS headers — so engine.js hands over whatever the scheduled scanner
// published and this module serves that instead of going to the network.
export function seed({ calendar: cal, headlines: heads } = {}) {
  if (Array.isArray(cal) && cal.length) {
    cache.set('cal', { at: Date.now(), val: archive(cal) });
  }
  if (heads && typeof heads === 'object') {
    for (const [instrument, list] of Object.entries(heads)) {
      if (!Array.isArray(list)) continue;
      const q = NEWS_QUERY[instrument] || `${instrument} price forecast`;
      // Seed both limits the callers ask for so neither re-fetches.
      cache.set(`news:${q}:12`, { at: Date.now(), val: list.slice(0, 12) });
      cache.set(`news:${q}:40`, { at: Date.now(), val: list });
    }
  }
}

export async function calendar() {
  return cached('cal', TTL.cal, async () => {
    const raw = await get(CAL_URL);
    const events = (Array.isArray(raw) ? raw : []).map(e => {
      const at = new Date(e.date).getTime();
      return {
        id: `${e.country}|${e.title}|${e.date}`,
        at,
        title: e.title,
        currency: e.country,
        impact: e.impact,
        rank: IMPACT_RANK[e.impact] ?? 0,
        forecast: e.forecast || null,
        previous: e.previous || null,
        actual: e.actual || null
      };
    }).filter(e => isFinite(e.at));
    return archive(events);
  });
}

// ─────────────── headlines ───────────────

// Minimal RSS pull. No XML parser dependency for four fields.
function parseRss(xml, limit) {
  const items = xml.split(/<item>/).slice(1, limit + 1);
  return items.map(chunk => {
    const pick = tag => {
      const m = chunk.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
      if (!m) return null;
      return m[1]
        .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
        .replace(/<[^>]+>/g, '')
        .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
        .trim();
    };
    const title = pick('title');
    const date = pick('pubDate');
    // Google appends " - Publisher" to every headline.
    const split = title ? title.lastIndexOf(' - ') : -1;
    return {
      title: split > 20 ? title.slice(0, split) : title,
      source: split > 20 ? title.slice(split + 3) : pick('source'),
      link: pick('link'),
      at: date ? new Date(date).getTime() : null
    };
  }).filter(n => n.title && n.at);
}

const NEWS_QUERY = {
  gold: 'gold price XAUUSD OR "gold futures"',
  silver: 'silver price XAGUSD',
  oil: 'crude oil price WTI',
  eurusd: 'EURUSD euro dollar forecast',
  gbpusd: 'GBPUSD pound dollar forecast',
  usdjpy: 'USDJPY yen dollar forecast'
};

export async function headlines(instrument, symbol, limit = 12) {
  const q = NEWS_QUERY[instrument] || `${symbol} price forecast`;
  return cached(`news:${q}:${limit}`, TTL.news, async () => {
    const xml = await get(`${NEWS_URL}?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`, 'text');
    return parseRss(xml, limit).sort((a, b) => b.at - a.at);
  });
}

// ─────────────── measured impact ───────────────

// What a release actually did, from 5m candles: the move from the last close
// before the event to the extremes over the next `windowMin` minutes.
//
// Deliberately reports both the directional move and the full range. A release
// that spikes 1% up then closes flat did not "move gold up 1%" — it moved it
// 1% in each direction and stopped anyone with a tight stop on either side.
function measure(bars, at, windowMin) {
  const before = bars.filter(b => b.closeTime <= at).at(-1);
  const after = bars.filter(b => b.t >= at && b.t < at + windowMin * 60000);
  if (!before || after.length < 2) return null;
  const from = before.c;
  const hi = Math.max(...after.map(b => b.h));
  const lo = Math.min(...after.map(b => b.l));
  const close = after.at(-1).c;
  const pct = v => from > 0 ? +((v - from) / from * 100).toFixed(2) : null;
  return {
    from,
    movePct: pct(close),
    upPct: pct(hi),
    downPct: pct(lo),
    rangePct: from > 0 ? +((hi - lo) / from * 100).toFixed(2) : null,
    direction: close > from ? 'up' : close < from ? 'down' : 'flat'
  };
}

// Past releases scored against real price. Only 5m candles are needed and one
// fetch covers every event in the window, so this costs a single request.
export async function impact({ market, symbol, instrument, days = 14, windowMin = 30, minRank = 3 }) {
  return cached(`impact:${market}:${symbol}:${days}:${windowMin}:${minRank}`, TTL.impact, async () => {
    const cal = await calendar().catch(() => readArchive());
    const drv = driversFor(instrument, symbol);
    const since = Date.now() - days * 24 * 3600 * 1000;

    const past = cal.filter(e =>
      e.at < Date.now() - windowMin * 60000 && e.at >= since &&
      e.rank >= minRank &&
      (drv.currencies.includes(e.currency) || (drv.extra && drv.extra.test(e.title)))
    );
    if (!past.length) return { events: [], summary: null, windowMin, days };

    // 5m bars, enough to cover the oldest event plus its window.
    const need = Math.ceil((Date.now() - Math.min(...past.map(e => e.at))) / 300000) + 20;
    const bars = await fetchCandles(market, symbol, '5m', Math.min(Math.max(need, 60), 1000));

    const events = past.map(e => {
      const m = measure(bars, e.at, windowMin);
      return m ? { ...e, ...m } : null;
    }).filter(Boolean).sort((a, b) => b.at - a.at);

    if (!events.length) return { events: [], summary: null, windowMin, days };

    const avgRange = +(events.reduce((s, e) => s + (e.rangePct || 0), 0) / events.length).toFixed(2);
    const ups = events.filter(e => e.direction === 'up').length;
    const biggest = events.reduce((a, b) => (b.rangePct || 0) > (a.rangePct || 0) ? b : a);
    return {
      windowMin, days,
      events,
      summary: {
        count: events.length,
        avgRangePct: avgRange,
        upCount: ups,
        downCount: events.length - ups,
        biggest: { title: biggest.title, at: biggest.at, rangePct: biggest.rangePct, direction: biggest.direction }
      }
    };
  });
}

// ─────────────── what actually moved it, whether or not a calendar knew ───────────────
//
// The calendar feed is one week wide, so on a fresh install there is no event
// history to study — and the user's question ("what did past weeks do") is
// still answerable, because price remembers even when the calendar does not.
//
// This finds the sharpest moves over the lookback directly from candles, then
// attaches whatever context exists for each: an archived calendar release
// within +/-15 minutes, and the headlines published around it. An unexplained
// shock is a real answer too — it says the move was flow, not news.
export async function shocks({ market, symbol, instrument, days = 21, windowMin = 30, top = 8 }) {
  return cached(`shocks:${market}:${symbol}:${days}:${top}`, TTL.impact, async () => {
    const bars = await fetchCandles(market, symbol, '15m', Math.min(days * 96 + 10, 1000));
    const closed = bars.filter(b => b.closed);
    if (closed.length < 10) return { moves: [], days, windowMin };

    const span = Math.max(1, Math.round(windowMin / 15));   // 15m bars per window
    const scored = [];
    for (let i = 0; i + span <= closed.length; i++) {
      const win = closed.slice(i, i + span);
      const from = closed[i - 1]?.c ?? win[0].o;
      if (!(from > 0)) continue;
      const hi = Math.max(...win.map(b => b.h));
      const lo = Math.min(...win.map(b => b.l));
      scored.push({
        at: win[0].t,
        from,
        movePct: +((win.at(-1).c - from) / from * 100).toFixed(2),
        rangePct: +((hi - lo) / from * 100).toFixed(2),
        direction: win.at(-1).c > from ? 'up' : win.at(-1).c < from ? 'down' : 'flat'
      });
    }
    // Biggest first, but never two overlapping windows — that would report one
    // event as several.
    scored.sort((a, b) => b.rangePct - a.rangePct);
    const picked = [];
    for (const m of scored) {
      if (picked.length >= top) break;
      if (picked.some(p => Math.abs(p.at - m.at) < windowMin * 60000 * 2)) continue;
      picked.push(m);
    }

    const cal = readArchive();
    const heads = await headlines(instrument, symbol, 40).catch(() => []);
    const moves = picked.map(m => {
      const event = cal.find(e => Math.abs(e.at - m.at) <= 15 * 60000 && e.rank >= 2) || null;
      const near = heads
        .filter(h => h.at >= m.at - 90 * 60000 && h.at <= m.at + 90 * 60000)
        .slice(0, 3);
      return {
        ...m,
        event: event ? { title: event.title, currency: event.currency, impact: event.impact } : null,
        headlines: near,
        explained: !!event || near.length > 0
      };
    }).sort((a, b) => b.at - a.at);

    const avg = +(picked.reduce((s, m) => s + m.rangePct, 0) / (picked.length || 1)).toFixed(2);
    return { days, windowMin, moves, avgShockRangePct: avg, unexplained: moves.filter(m => !m.explained).length };
  });
}

// ─────────────── one call for the report ───────────────

export async function newsFor({ market, symbol, instrument, days = 14 }) {
  const drv = driversFor(instrument, symbol);
  const [cal, heads, imp, shk, bars] = await Promise.all([
    calendar().catch(() => readArchive()),
    headlines(instrument, symbol).catch(() => []),
    impact({ market, symbol, instrument, days }).catch(() => ({ events: [], summary: null })),
    shocks({ market, symbol, instrument, days: Math.max(days, 21) }).catch(() => ({ moves: [] })),
    fetchCandles(market, symbol, '5m', 1500).catch(() => [])
  ]);

  const own = e => drv.currencies.includes(e.currency);
  const relevant = e => own(e) || (drv.extra && drv.extra.test(e.title));
  const now = Date.now();
  const upcoming = cal
    .filter(e => e.at > now && e.rank >= 2 && relevant(e))
    .map(e => ({ ...e, primary: own(e) }))
    .sort((a, b) => a.at - b.at)
    .slice(0, 12);

  // What is next, and how hard that release has historically hit. A foreign
  // central bank matching the keyword list still moves gold, but it is never
  // the headline event ahead of the instrument's own currency — sorting purely
  // by time made an ECB rate decision outrank US CPI for gold.
  const nextHigh =
    upcoming.find(e => e.primary && e.rank === 3) ||
    upcoming.find(e => e.primary) ||
    upcoming.find(e => e.rank === 3) ||
    upcoming[0] || null;

  // Attach the reaction rule to every upcoming event, so the list says which
  // way each one leans rather than only how loud it is.
  const price = bars.filter(b => b.closed).at(-1)?.c || null;
  for (const e of upcoming) {
    const r = reactionFor(instrument, symbol, e.title, e.currency);
    if (!r) continue;
    e.reaction = {
      onBeat: directionFor(r, e.currency),
      onMiss: directionFor(r, e.currency) === 'up' ? 'down' : 'up',
      why: r.why,
      confidence: r.weight >= 3 ? 'high' : r.weight === 2 ? 'medium' : 'low'
    };
  }

  // The plan for the next one, written before the number lands.
  let plan = null;
  if (nextHigh && price) {
    const r = reactionFor(instrument, symbol, nextHigh.title, nextHigh.currency);
    const priorRanges = (imp.events || [])
      .filter(e => e.title === nextHigh.title && e.rangePct)
      .slice(0, 6).map(e => e.rangePct);
    if (r) plan = planFor({ event: nextHigh, reaction: r, price, bars, priorRanges,
      name: instrument === 'gold' ? 'gold' : instrument === 'silver' ? 'silver' : symbol });
  }

  // How the same rule did on the releases that already happened this week.
  const weekAgo = Date.now() - 7 * 24 * 3600 * 1000;
  // Every release the rule has a view on, not just the loud ones. A week with
  // no high-impact prints — a holiday Monday, say — would otherwise show an
  // empty scorecard, when the quiet releases are exactly the ones worth knowing
  // do nothing. Their impact rating rides along so the results can say which
  // were which.
  const pastWeek = cal.filter(e => e.at < Date.now() && e.at >= weekAgo && e.rank >= 1 && relevant(e));
  const rule = bars.length
    ? backtest({ events: pastWeek, bars, instrument, symbol })
    : { trades: [], summary: null };
  const priorSame = nextHigh
    ? (imp.events || []).filter(e => e.title === nextHigh.title).slice(0, 4)
    : [];

  return {
    at: now,
    instrument: instrument || null,
    symbol, market,
    currencies: drv.currencies,
    upcoming,
    next: nextHigh ? {
      ...nextHigh,
      inMinutes: Math.round((nextHigh.at - now) / 60000),
      priorMoves: priorSame.map(e => ({ at: e.at, rangePct: e.rangePct, movePct: e.movePct, direction: e.direction })),
      typicalRangePct: priorSame.length
        ? +(priorSame.reduce((s, e) => s + (e.rangePct || 0), 0) / priorSame.length).toFixed(2)
        : null
    } : null,
    headlines: heads.slice(0, 10),
    impact: imp,
    shocks: shk,
    price,
    plan,
    rule,
    // The calendar feed only publishes the current week, so event-anchored
    // history starts empty and fills week by week. Say so rather than letting
    // an empty section read as "nothing ever moved this".
    archiveNote: (imp.events || []).length ? null
      : 'Event history builds from today — the free calendar feed only publishes the current week. The moves below come from price instead.'
  };
}
