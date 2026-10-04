// Minimal MEXC futures (contract) REST client. Keys come from ~/.mexc.env,
// never from the repo. Signature per MEXC contract docs:
//   HMAC_SHA256(secret, accessKey + requestTime + paramString)
// where paramString is the sorted query string for GET/DELETE and the raw
// JSON body for POST.
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import https from 'node:https';
import dns from 'node:dns';

// The Mac's resolver intermittently answers "could not resolve host" for
// contract.mexc.com (an Akamai CNAME chain) while public DNS resolves it
// fine — seen live on 20 Sep 2026 with a position open. So every request
// resolves through 1.1.1.1/8.8.8.8 first and falls back to the system.
const resolver = new dns.Resolver(); resolver.setServers(['1.1.1.1', '8.8.8.8']);
const dnsCache = new Map();
function lookup(host, opts, cb) {
  // net.connect asks with { all: true } (happy eyeballs) and wants an array then.
  const done = (err, ip) => err ? cb(err) : opts?.all ? cb(null, [{ address: ip, family: 4 }]) : cb(null, ip, 4);
  const hit = dnsCache.get(host);
  if (hit && Date.now() - hit.at < 60000) return done(null, hit.ip);
  resolver.resolve4(host, (err, addrs) => {
    if (!err && addrs?.length) { dnsCache.set(host, { ip: addrs[0], at: Date.now() }); return done(null, addrs[0]); }
    dns.lookup(host, { family: 4 }, (e2, ip) => { if (!e2) dnsCache.set(host, { ip, at: Date.now() }); done(e2, ip); });
  });
}
const agent = new https.Agent({ keepAlive: true, lookup });
const guarded = new WeakSet();
function request(method, url, headers, body, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({ method, hostname: u.hostname, path: u.pathname + u.search, headers, agent, timeout: timeoutMs }, res => {
      let data = ''; res.setEncoding('utf8');
      res.on('data', c => data += c);
      res.on('end', () => resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, text: data }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    // A keep-alive socket can error after its request is gone (ENETUNREACH on a
    // Wi-Fi drop, 22 Sep) — with no listener that throws and kills the executor.
    req.on('socket', s => { if (!guarded.has(s)) { guarded.add(s); s.on('error', () => {}); } });
    if (body) req.write(body);
    req.end();
  });
}

const BASE = 'https://contract.mexc.com';

function loadEnv() {
  const out = {};
  // MEXC_ENV_FILE picks another account's keys (close2sonastrat LIVE uses its own, 2 Oct 2026)
  for (const line of readFileSync(process.env.MEXC_ENV_FILE || `${homedir()}/.mexc.env`, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.+?)\s*$/);
    if (m) out[m[1]] = m[2];
  }
  if (!out.MEXC_KEY || !out.MEXC_SECRET) throw new Error(`${process.env.MEXC_ENV_FILE || '~/.mexc.env'} needs MEXC_KEY and MEXC_SECRET`);
  return out;
}
const env = loadEnv();

// MEXC answers 510 "Requests are too frequent" now and then (a refusal — nothing
// was executed), so wait and ask again; only a 4th refusal in a row is thrown.
export async function mexc(method, path, params = {}) {
  for (let i = 0; ; i++) {
    try { return await mexcOnce(method, path, params); }
    catch (e) { if (e.code !== 510 || i >= 3) throw e; await new Promise(r => setTimeout(r, 2000 * (i + 1))); }
  }
}

async function mexcOnce(method, path, params = {}) {
  const t = String(Date.now());
  let url = BASE + path, body;
  let paramStr = '';
  if (method === 'GET' || method === 'DELETE') {
    const qs = Object.keys(params).sort().map(k => `${k}=${params[k]}`).join('&');
    if (qs) { url += '?' + qs; paramStr = qs; }
  } else {
    body = JSON.stringify(params);
    paramStr = body;
  }
  const sig = createHmac('sha256', env.MEXC_SECRET).update(env.MEXC_KEY + t + paramStr).digest('hex');
  const res = await request(method, url, { 'ApiKey': env.MEXC_KEY, 'Request-Time': t, 'Signature': sig, 'Content-Type': 'application/json', ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}) }, body);
  const text = res.text;
  // Order ids are 18-digit integers, past what a JS number holds exactly, so
  // quote any bare integer that long before parsing.
  const safe = text.replace(/([:\[,]\s*)(\d{16,})(?=\s*[,\]}])/g, '$1"$2"');
  let j; try { j = JSON.parse(safe); } catch { j = { raw: text }; }
  if (!res.ok || j.success === false) throw Object.assign(new Error(`${method} ${path} → ${res.status} ${j.code ?? ''} ${j.message ?? text.slice(0, 200)}`), { code: j.code });
  return j.data ?? j;
}

// Public
export const ticker = (symbol) => mexc('GET', '/api/v1/contract/ticker', { symbol });
export const contractDetail = (symbol) => mexc('GET', '/api/v1/contract/detail', { symbol });
// Private
export const positions = (symbol) => mexc('GET', '/api/v1/private/position/open_positions', symbol ? { symbol } : {});
export const openOrders = (symbol) => mexc('GET', `/api/v1/private/order/list/open_orders/${symbol}`, { page_num: 1, page_size: 50 });
export const stopOrders = (symbol) => mexc('GET', '/api/v1/private/stoporder/list/orders', { symbol, is_finished: 0, page_num: 1, page_size: 50 });
export const planOrders = (symbol) => mexc('GET', '/api/v1/private/planorder/list/orders', { symbol, states: '1', page_num: 1, page_size: 50 });
export const assets = () => mexc('GET', '/api/v1/private/account/assets');
// Modify the TP/SL attached to a position. Takes the stop order's `id` (the
// plan id). change_price with the orderId answers "success" and changes
// nothing — verified live on 20 Sep 2026 — so it is not used.
export const changeStopPrice = (stopPlanOrderId, stopLossPrice, takeProfitPrice) =>
  mexc('POST', '/api/v1/private/stoporder/change_plan_price', { stopPlanOrderId, stopLossPrice, takeProfitPrice });
// Set / replace TP-SL on an open position directly (positionId based).
export const placePositionTpSl = (params) => mexc('POST', '/api/v1/private/stoporder/place', params);
export const submitOrder = (params) => mexc('POST', '/api/v1/private/order/submit', params);
export const cancelOrders = (ids) => mexc('POST', '/api/v1/private/order/cancel', ids.map(String));
export const cancelByExternal = (symbol, externalOid) => mexc('POST', '/api/v1/private/order/cancel_with_external', { symbol, externalOid });
