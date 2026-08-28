// Signed Binance USDⓈ-M futures client — only the calls the bot actually makes.
//
// Nothing here is clever. It exists so trade.js reads as trading logic rather
// than as HMAC plumbing, and so every write goes through one place that can be
// switched off.

import crypto from 'crypto';

const BASE = process.env.BINANCE_BASE || 'https://fapi.binance.com';
const KEY = () => process.env.BINANCE_KEY || '';
const SECRET = () => process.env.BINANCE_SECRET || '';

// Binance rejects a request whose timestamp drifts from server time, and a
// laptop or a cheap VM drifts. Learn the offset once and carry it.
let drift = 0;
export async function syncTime() {
  const r = await fetch(`${BASE}/fapi/v1/time`, { signal: AbortSignal.timeout(15000) });
  const { serverTime } = await r.json();
  drift = serverTime - Date.now();
  return drift;
}

async function call(method, path, params = {}, signed = true) {
  const q = new URLSearchParams(
    Object.entries(params).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => [k, String(v)])
  );
  if (signed) {
    q.set('timestamp', String(Date.now() + drift));
    q.set('recvWindow', '10000');
    q.set('signature', crypto.createHmac('sha256', SECRET()).update(q.toString()).digest('hex'));
  }
  const url = `${BASE}${path}${method === 'GET' || method === 'DELETE' ? `?${q}` : ''}`;
  const res = await fetch(url, {
    method,
    headers: { 'X-MBX-APIKEY': KEY(), ...(method === 'POST' ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
    body: method === 'POST' ? q.toString() : undefined,
    signal: AbortSignal.timeout(20000)
  });
  const text = await res.text();
  let body; try { body = JSON.parse(text); } catch { body = text; }
  if (!res.ok) {
    // 451 here means the host itself is geo-blocked — worth saying plainly,
    // because no amount of retrying or re-keying fixes it.
    const hint = res.status === 451 ? ' — this IP is geo-blocked by Binance; run the bot outside the US' : '';
    throw new Error(`${res.status} ${path}: ${body?.msg || text.slice(0, 120)}${hint}`);
  }
  return body;
}

export const ping = () => call('GET', '/fapi/v1/ping', {}, false);

// Quantity and price both have to land on the symbol's tick, or the order is
// rejected with a message that does not say which one was wrong.
let filters = null;
export async function rules() {
  if (filters) return filters;
  const info = await call('GET', '/fapi/v1/exchangeInfo', {}, false);
  filters = new Map();
  for (const s of info.symbols) {
    if (s.status !== 'TRADING' || s.quoteAsset !== 'USDT') continue;
    const f = Object.fromEntries(s.filters.map(x => [x.filterType, x]));
    filters.set(s.symbol, {
      qtyStep: +f.LOT_SIZE?.stepSize || 0.001,
      minQty: +f.LOT_SIZE?.minQty || 0,
      tick: +f.PRICE_FILTER?.tickSize || 0.0001,
      minNotional: +f.MIN_NOTIONAL?.notional || 5
    });
  }
  return filters;
}

const floorTo = (v, step) => {
  if (!(step > 0)) return v;
  const dp = Math.max(0, (String(step).split('.')[1] || '').replace(/0+$/, '').length);
  return +(Math.floor(v / step) * step).toFixed(dp);
};
export const roundQty = (r, q) => floorTo(q, r.qtyStep);
export const roundPrice = (r, p) => floorTo(p, r.tick);

export const balance = async () => {
  const rows = await call('GET', '/fapi/v2/balance');
  const u = rows.find(r => r.asset === 'USDT');
  return { total: +u.balance, available: +u.availableBalance };
};

export const positions = async () => (await call('GET', '/fapi/v2/positionRisk'))
  .filter(p => Math.abs(+p.positionAmt) > 0)
  .map(p => ({
    symbol: p.symbol, qty: +p.positionAmt, entry: +p.entryPrice,
    mark: +p.markPrice, liq: +p.liquidationPrice, lev: +p.leverage,
    side: +p.positionAmt > 0 ? 'LONG' : 'SHORT', pnl: +p.unRealizedProfit
  }));

export const openOrders = (symbol) => call('GET', '/fapi/v1/openOrders', { symbol });
export const cancelOrder = (symbol, orderId) => call('DELETE', '/fapi/v1/order', { symbol, orderId });

// Isolated margin so one liquidation cannot reach into the rest of the wallet.
export const setIsolated = (symbol) =>
  call('POST', '/fapi/v1/marginType', { symbol, marginType: 'ISOLATED' })
    .catch(e => { if (!/No need to change|-4046/.test(e.message)) throw e; });

export const setLeverage = (symbol, leverage) => call('POST', '/fapi/v1/leverage', { symbol, leverage });

export const marketBuy = (symbol, quantity) =>
  call('POST', '/fapi/v1/order', { symbol, side: 'BUY', type: 'MARKET', quantity });

export const closeLong = (symbol, quantity) =>
  call('POST', '/fapi/v1/order', { symbol, side: 'SELL', type: 'MARKET', quantity, reduceOnly: 'true' });

// closePosition means the exchange holds the whole position's stop, so the bot
// crashing does not leave the trade unprotected.
export const stopLong = (symbol, stopPrice) =>
  call('POST', '/fapi/v1/order', {
    symbol, side: 'SELL', type: 'STOP_MARKET', stopPrice, closePosition: 'true', workingType: 'MARK_PRICE'
  });

export const maxLeverage = async (symbol) => {
  const brackets = await call('GET', '/fapi/v1/leverageBracket', { symbol });
  return brackets?.[0]?.brackets?.[0]?.initialLeverage || 20;
};
