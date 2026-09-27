// Shared plumbing for copysona and sonabot: where state lives, MEXC public
// prices, Telegram (send + read replies), and a one-line logger.
// Paper only — nothing in here can place an order.
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, appendFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const HOME = process.env.SONA_HOME || join(homedir(), '.sona');
mkdirSync(join(HOME, 'img'), { recursive: true });
export const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// Telegram credentials come from the app's .env (same bot the scanner alerts use).
for (const f of [join(REPO, '.env')]) {
  if (!existsSync(f)) continue;
  for (const line of readFileSync(f, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
  }
}

export const sleep = ms => new Promise(r => setTimeout(r, ms));
export const now = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

export function logger(name) {
  const f = join(HOME, `${name}.log`);
  return (...a) => {
    const line = `${now()} ${a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' ')}`;
    console.log(line);
    appendFileSync(f, line + '\n');
  };
}

export function loadJSON(name, dflt) {
  const f = join(HOME, name);
  if (!existsSync(f)) return structuredClone(dflt);
  return JSON.parse(readFileSync(f, 'utf8'));
}
export function saveJSON(name, obj) {
  const f = join(HOME, name);
  writeFileSync(f + '.tmp', JSON.stringify(obj, null, 1));
  renameSync(f + '.tmp', f);   // never leave a half-written state file
}

// ── MEXC public market data ───────────────────────────────────────────────
const MEXC = 'https://contract.mexc.com/api/v1/contract';
async function getJSON(url, tries = 4) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
      const j = await r.json();
      if (j.success === false) throw new Error(j.message || JSON.stringify(j).slice(0, 120));
      return j.data ?? j;
    } catch (e) { last = e; await sleep(1500 * (i + 1)); }
  }
  throw last;
}
export const sym = coin => `${coin.toUpperCase().replace(/USDT$|_USDT$/, '')}_USDT`;
export async function price(coin) {
  const d = await getJSON(`${MEXC}/ticker?symbol=${sym(coin)}`);
  return +d.lastPrice;
}
// Candles as [{t, o, h, l, c}] oldest first; t in ms. interval: Min30, Hour4, Day1…
export async function candles(coin, interval, sinceSec) {
  const d = await getJSON(`${MEXC}/kline/${sym(coin)}?interval=${interval}&start=${sinceSec}`);
  return d.time.map((t, i) => ({ t: t * 1000, o: +d.open[i], h: +d.high[i], l: +d.low[i], c: +d.close[i] }));
}
let contractSet;
export async function listed(coin) {
  contractSet ??= new Set((await getJSON(`${MEXC}/detail`)).map(c => c.symbol));
  return contractSet.has(sym(coin));
}

// ── Telegram ──────────────────────────────────────────────────────────────
const TG = () => `https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN}`;
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
export { esc };
export async function tgSend(html, replyTo, markup) {
  if (!process.env.TELEGRAM_TOKEN || !process.env.TELEGRAM_CHAT_ID) return null;
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(`${TG()}/sendMessage`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: process.env.TELEGRAM_CHAT_ID, text: html, parse_mode: 'HTML', disable_web_page_preview: true, ...(replyTo ? { reply_to_message_id: replyTo } : {}), ...(markup ? { reply_markup: markup } : {}) }),
        signal: AbortSignal.timeout(25000)
      });
      const j = await r.json();
      if (j.ok) return j.result.message_id;
      if (r.status < 500 && r.status !== 429) return null;
    } catch { }
    await sleep(2000 * (i + 1));
  }
  return null;
}
// Stop the spinner on a tapped button.
export async function tgAnswer(id) {
  try { await fetch(`${TG()}/answerCallbackQuery`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ callback_query_id: id }), signal: AbortSignal.timeout(15000) }); } catch { }
}
// Messages the user sent to the bot since `offset` (text and button taps). Only the configured chat counts.
export async function tgUpdates(offset) {
  if (!process.env.TELEGRAM_TOKEN) return { offset, msgs: [] };
  try {
    const r = await fetch(`${TG()}/getUpdates?timeout=0&offset=${offset}`, { signal: AbortSignal.timeout(20000) });
    const j = await r.json();
    if (!j.ok) return { offset, msgs: [] };
    const msgs = [];
    for (const u of j.result) {
      offset = Math.max(offset, u.update_id + 1);
      const m = u.message, cb = u.callback_query;
      if (m?.text && String(m.chat.id) === String(process.env.TELEGRAM_CHAT_ID))
        msgs.push({ id: m.message_id, text: m.text, replyTo: m.reply_to_message?.message_id ?? null });
      if (cb && String(cb.message?.chat?.id) === String(process.env.TELEGRAM_CHAT_ID))   // a tapped button
        msgs.push({ id: cb.message.message_id, callback: cb.data, cbId: cb.id, text: '' });
    }
    return { offset, msgs };
  } catch { return { offset, msgs: [] }; }
}
