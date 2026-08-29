#!/usr/bin/env node
// A once-a-day account summary to Telegram, so the bot reports itself instead
// of needing to be asked. Reads only — it never trades.

import './src/env.js';
import fs from 'fs';
import path from 'path';
import * as ex from './src/exchange/binance.js';

const STATE = path.join(process.cwd(), 'cloud', 'trades.json');
const st = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : {};
const LOG = path.join(process.env.HOME, 'trade.log');

await ex.syncTime();
const w = await ex.balance();
const pos = await ex.positions();

// What happened in the last 24h, straight from the log the runs write.
const since = Date.now() - 24 * 3600 * 1000;
let opened = 0, closed = 0, skipped = 0, errors = 0;
try {
  for (const line of fs.readFileSync(LOG, 'utf8').split('\n').slice(-4000)) {
    if (/→ BUY /.test(line)) opened++;
    else if (/✓ .* closed/.test(line)) closed++;
    else if (/too small|not enough free margin/.test(line)) skipped++;
    else if (/ ! /.test(line)) errors++;
  }
} catch { /* no log yet */ }

const money = v => '$' + v.toFixed(2);
const lines = [
  `<b>F1 Big Winners — daily</b>`,
  ``,
  `Wallet <b>${money(w.total)}</b>${st.locked ? `  (locked ${money(st.locked)}, staking from ${money(w.total - st.locked)})` : ''}`,
  st.hwm ? `Best ever ${money(st.hwm)}` : '',
  ``,
  `Open positions: <b>${pos.length}</b>`,
  ...pos.map(p => {
    const up = ((p.mark - p.entry) / p.entry * 100);
    const s = st.open?.[p.symbol];
    return `  ${p.symbol} ${p.lev}x · ${up >= 0 ? '+' : ''}${up.toFixed(1)}% ` +
      `(${(up * p.lev >= 0 ? '+' : '')}${(up * p.lev).toFixed(0)}% on margin) · pnl ${money(p.pnl)}` +
      (s?.stopPrice ? `\n     trail stop ${s.stopPrice.toPrecision(6)}` : '');
  }),
  ``,
  `Last 24h: ${opened} opened · ${closed} closed · ${skipped} too small${errors ? ` · ${errors} errors` : ''}`,
  ``,
  `<i>grade A only · 25x · 1% margin · trail 25%</i>`
].filter(Boolean).join('\n');

console.log(lines.replace(/<[^>]+>/g, ''));

const T = process.env.TELEGRAM_TOKEN, C = process.env.TELEGRAM_CHAT_ID;
if (T && C) {
  const r = await fetch(`https://api.telegram.org/bot${T}/sendMessage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: C, text: lines, parse_mode: 'HTML' })
  });
  console.log('telegram:', r.status);
} else {
  console.log('telegram: not configured');
}
