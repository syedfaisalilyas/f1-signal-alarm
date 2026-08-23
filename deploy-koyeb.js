#!/usr/bin/env node
// Deploys this app to Koyeb's free instance via the REST API.
//   KOYEB_TOKEN=xxx node deploy-koyeb.js      (or: node deploy-koyeb.js <token>)
import crypto from 'crypto';

const API = 'https://app.koyeb.com/v1';
const c = { d:'\x1b[2m', g:'\x1b[32m', r:'\x1b[31m', y:'\x1b[33m', b:'\x1b[1m', x:'\x1b[0m' };
const ok  = s => console.log(`  ${c.g}✓${c.x} ${s}`);
const bad = s => console.log(`  ${c.r}✗${c.x} ${s}`);
const dim = s => console.log(`  ${c.d}${s}${c.x}`);

const TOKEN = process.argv[2] || process.env.KOYEB_TOKEN;
const IMAGE = process.env.IMAGE || 'ghcr.io/syedfaisalilyas/f1-signal-alarm:latest';
const APP   = process.env.APP_NAME || 'f1-alarm';
// Binance geo-blocks US IPs (HTTP 451) — keep this OUT of dal/rdu/mci/dsm.
const REGION = process.env.REGION || 'fra';

if (!TOKEN) {
  console.log(`
  ${c.b}Koyeb deploy${c.x}

  Need an API token. Get one at:
    ${c.b}https://app.koyeb.com/settings/api${c.x}   →  Create API token

  Then:  ${c.b}node deploy-koyeb.js <token>${c.x}
`);
  process.exit(1);
}

async function kb(method, path, body) {
  const res = await fetch(API + path, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(60000)
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: res.status, ok: res.ok, json };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// 1. validate token
const me = await kb('GET', '/account/profile');
if (!me.ok) { bad(`Token rejected (${me.status}): ${JSON.stringify(me.json).slice(0, 200)}`); process.exit(1); }
ok(`Authenticated as ${c.b}${me.json.profile?.email || me.json.profile?.id || 'account'}${c.x}`);

// 2. find or create the app
let appId;
const apps = await kb('GET', `/apps?limit=100`);
appId = apps.json.apps?.find(a => a.name === APP)?.id;
if (appId) ok(`Reusing app ${c.b}${APP}${c.x}`);
else {
  const created = await kb('POST', '/apps', { name: APP });
  if (!created.ok) { bad(`Create app failed (${created.status}): ${JSON.stringify(created.json).slice(0, 300)}`); process.exit(1); }
  appId = created.json.app.id;
  ok(`Created app ${c.b}${APP}${c.x}`);
}

// 3. env vars — generate a fresh password unless one is supplied
const APP_PASSWORD = process.env.APP_PASSWORD || crypto.randomBytes(9).toString('base64url');
const env = [{ key: 'APP_PASSWORD', value: APP_PASSWORD }, { key: 'PORT', value: '8787' }];
for (const k of ['TELEGRAM_TOKEN', 'TELEGRAM_CHAT_ID', 'NTFY_TOPIC', 'TWELVEDATA_KEY', 'VAPID_PUBLIC', 'VAPID_PRIVATE', 'VAPID_SUBJECT']) {
  if (process.env[k]) env.push({ key: k, value: process.env[k] });
}

const definition = {
  name: 'scanner',
  type: 'WEB',
  docker: { image: IMAGE },
  instance_types: [{ type: 'free' }],
  regions: [REGION],
  scalings: [{ min: 1, max: 1 }],
  env,
  ports: [{ port: 8787, protocol: 'http' }],
  routes: [{ port: 8787, path: '/' }],
  health_checks: [{ grace_period: 45, http: { port: 8787, path: '/' } }]
};

// 4. create or update the service
const svcs = await kb('GET', `/services?app_id=${appId}&limit=100`);
const existing = svcs.json.services?.find(s => s.name === 'scanner');
let svcId, r;
if (existing) {
  svcId = existing.id;
  r = await kb('PUT', `/services/${svcId}`, { definition });
  if (r.ok) ok('Updated existing service');
} else {
  r = await kb('POST', '/services', { app_id: appId, definition });
  if (r.ok) { svcId = r.json.service.id; ok('Created service'); }
}
if (!r.ok) {
  bad(`Service deploy failed (${r.status})`);
  console.log(JSON.stringify(r.json, null, 2).slice(0, 900));
  process.exit(1);
}

// 5. wait for it to come up
dim(`region=${REGION}  instance=free  image=${IMAGE}`);
dim('waiting for the deployment to become healthy…');
let state = '';
for (let i = 0; i < 100; i++) {
  await sleep(6000);
  const s = await kb('GET', `/services/${svcId}`);
  const st = s.json.service?.status;
  if (st && st !== state) { state = st; dim(`  status: ${state}`); }
  if (['HEALTHY', 'ERROR', 'DEGRADED'].includes(state)) break;
}

const app = await kb('GET', `/apps/${appId}`);
const domain = app.json.app?.domains?.find(d => d.type === 'AUTOASSIGNED')?.name
            || app.json.app?.domains?.[0]?.name;

if (state === 'HEALTHY' && domain) {
  console.log(`
  ${c.g}${c.b}Deployed.${c.x}

    ${c.b}https://${domain}/?key=${APP_PASSWORD}${c.x}

  ${c.d}Access key: ${APP_PASSWORD}${c.x}
  ${c.d}Set TELEGRAM_TOKEN / TELEGRAM_CHAT_ID at${c.x}
  ${c.d}https://app.koyeb.com → ${APP} → scanner → Settings → Environment variables${c.x}
`);
} else {
  bad(`Ended in state: ${state || 'unknown'}`);
  dim(`Logs: https://app.koyeb.com/services/${svcId}`);
  if (domain) dim(`Domain (once healthy): https://${domain}`);
  process.exit(1);
}
