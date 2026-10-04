// Standby for close2sonastrat LIVE, run by .github/workflows/c2s-standby.yml
// (user, 4 Oct 2026). The live bot has no stop order on MEXC: its −10% stop
// and its trail are market orders sent by the VPS. If the VPS goes silent,
// this takes over those two exits — and only those — until it is back:
//
//   heartbeat fresh (≤ 10 min)  → idle: wait, then hand over to the next run
//   heartbeat stale             → standby: every 20 s walk each open trade on
//                                 MEXC 1-minute bars with the bot's own rules
//                                 (stop −10% from avg; trail on from +2.5%,
//                                 closes on a 1% give-back) and close at market
//
// It never opens, never adds. It only touches coins the bot's last published
// book held (C2S_BOOK), so a position opened by hand is left alone. When the
// VPS returns it finds a closed trade gone and drops it from its book as
// 'closed by hand'.
//
// A run cannot read the repo variables after it starts, so runs are short and
// chained: each one gets BEAT (C2S_HEARTBEAT) and BOOK (C2S_BOOK) fresh from
// the workflow. `best`/`armed` are rebuilt every run from the book snapshot
// plus the 1-minute bars since it, so nothing has to be carried between runs.
//
// env: BEAT, BOOK, WAS (idle|standby — what the previous run was), FORCE=1
// (treat the heartbeat as stale), DRY=1 (no orders), MEXC_ENV_FILE,
// TELEGRAM_TOKEN, TELEGRAM_CHAT_ID, NTFY_TOPIC, GITHUB_OUTPUT.
// The repo is public and so are its job logs: details go to Telegram only.
import { appendFileSync } from 'node:fs';
import { mexc, positions, submitOrder } from '../mexc/client.mjs';

const SL = 0.10, ACT = 0.025, TRAIL = 0.01;           // same as widfix.mjs
const STALE_MS = 10 * 60e3, IDLE_MS = +(process.env.IDLE_SEC ?? 240) * 1e3, RUN_MS = +(process.env.RUN_SEC ?? 270) * 1e3, TICK_MS = 20e3;
const DRY = process.env.DRY === '1' || process.env.DRY === 'true', FORCE = process.env.FORCE === '1' || process.env.FORCE === 'true';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const side = d => d > 0 ? 'LONG' : 'SHORT';
const fmt = x => x >= 100 ? x.toFixed(2) : x >= 1 ? x.toFixed(4) : x.toPrecision(4);
const out = mode => { if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `mode=${mode}\n`); };

async function notify(text, urgent) {
  const { TELEGRAM_TOKEN: tk, TELEGRAM_CHAT_ID: chat, NTFY_TOPIC: topic } = process.env;
  if (tk && chat) await fetch(`https://api.telegram.org/bot${tk}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: chat, text }), signal: AbortSignal.timeout(20000) }).catch(() => {});
  if (topic && urgent) await fetch(`https://ntfy.sh/${topic}`, { method: 'POST', headers: { Priority: 'urgent', Title: 'close2sonastrat standby' }, body: text, signal: AbortSignal.timeout(20000) }).catch(() => {});
}

// Closed 1-minute bars on MEXC from `fromMs` (bar start) up to now.
async function bars1m(symbol, fromMs) {
  const a = [], cut = Math.floor(Date.now() / 60e3) * 60;      // bars starting before this second are closed
  for (let start = Math.floor(fromMs / 60e3) * 60; start < cut;) {
    const k = await mexc('GET', `/api/v1/contract/kline/${symbol}`, { interval: 'Min1', start, end: Math.min(cut - 60, start + 1500 * 60) });
    const n = k.time?.length || 0;
    for (let i = 0; i < n; i++) if (k.time[i] >= start && k.time[i] < cut) a.push({ t: k.time[i] * 1000, h: +k.high[i], l: +k.low[i] });
    if (!n) break;
    start = Math.max(start + 1500 * 60, k.time[n - 1] + 60);
    await sleep(300);
  }
  return a;
}

// One bar for one trade, in the bot's order: trail, stop, then move the best.
export function step(st, d, av, b) {
  const lo = d * ((d > 0 ? b.l : b.h) / av - 1), hi = d * ((d > 0 ? b.h : b.l) / av - 1);
  if (st.armed && lo <= st.best - TRAIL + 1e-9) return { why: 'trail', at: st.best - TRAIL };
  if (lo <= -SL + 1e-9) return { why: 'stop −10%', at: -SL };
  st.best = Math.max(st.best, hi); st.armed ||= st.best >= ACT;
  return null;
}

async function main() {
  const beat = /^\d+$/.test(process.env.BEAT || '') ? +process.env.BEAT : NaN, was = process.env.WAS || 'idle';
  let book = {}; try { book = JSON.parse(process.env.BOOK || '{}'); } catch { }
  if (Number.isNaN(beat) && !FORCE) { console.log('heartbeat paused — idle'); await sleep(IDLE_MS); return out('idle'); }
  const age = Date.now() - beat;
  if (age <= STALE_MS && !FORCE) {
    console.log(`bot alive (heartbeat ${Math.round(age / 60e3)} min old) — idle`);
    if (was === 'standby') await notify('🟢 close2sonastrat is back — the standby has handed the trades back to the bot.');
    await sleep(IDLE_MS); return out('idle');
  }

  const mine = new Map((book.open || []).map(p => [`${p.coin}_USDT:${p.dir}`, p]));
  console.log(`STANDBY${DRY ? ' (dry)' : ''}: heartbeat ${Number.isNaN(beat) ? 'none' : Math.round(age / 60e3) + ' min old'} · book has ${mine.size} trade(s)`);
  if (was !== 'standby' && !DRY) await notify(`🟠 close2sonastrat STANDBY took over — the bot has been silent for ${Math.round(age / 60e3)} minutes. It is now watching the stop (−10%) and the trail on ${mine.size} open trade(s) from GitHub. It will not open or add.`, true);
  const state = new Map(), end = Date.now() + RUN_MS, since = book.t || beat || Date.now();
  do {
    try {
      const held = (await positions()).filter(p => p.holdVol > 0);
      let seen = 0, exits = 0;
      for (const pos of held) {
        const d = pos.positionType === 1 ? 1 : -1, key = `${pos.symbol}:${d}`, b0 = mine.get(key);
        if (!b0) continue;                                    // not the bot's trade
        seen++;
        const coin = pos.symbol.replace('_USDT', ''), av = +pos.holdAvgPrice;
        const st = state.get(key) ?? { best: b0.best ?? -1, armed: !!b0.armed, next: since };
        state.set(key, st);
        let exit = null;
        for (const b of await bars1m(pos.symbol, st.next)) { st.next = b.t + 60e3; if ((exit = step(st, d, av, b))) break; }
        if (DRY) console.log(`  dry: trade ${seen} avg ok · best ${(st.best * 100).toFixed(2)}% · ${st.armed ? 'trailing' : 'not trailing'} · ${exit ? 'WOULD CLOSE (' + exit.why + ')' : 'hold'}`);
        if (!exit) continue;
        exits++;
        if (!DRY) {
          await submitOrder({ symbol: pos.symbol, vol: pos.holdVol, leverage: pos.leverage, side: d > 0 ? 4 : 2, type: 5, openType: pos.openType, positionMode: 1, positionId: pos.positionId, externalOid: `c2sb${Date.now()}` });
          await notify(`${exit.why === 'trail' ? '✅' : '❌'} STANDBY closed ${coin} ${side(d)} (${exit.why}) at market — avg ${fmt(av)}, exit level ${fmt(av * (1 + d * exit.at))}. The bot was down, so GitHub closed it.`, true);
          await sleep(1500);
        }
      }
      console.log(`checked ${seen} trade(s), ${exits} exit(s)`);
    } catch (e) { console.log('standby error:', String(e.message).slice(0, 80)); }
    if (Date.now() + TICK_MS < end) await sleep(TICK_MS); else break;
  } while (true);
  out('standby');
}

if (process.argv[1]?.endsWith('standby.mjs')) await main();
