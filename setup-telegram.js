#!/usr/bin/env node
// Interactive Telegram wiring: validate token -> discover chat id -> write .env -> test.
import fs from 'fs';
import path from 'path';
import readline from 'readline/promises';
import { stdin as input, stdout as output } from 'process';

const API = t => `https://api.telegram.org/bot${t}`;
const ENV = path.join(process.cwd(), '.env');
const c = { d: '\x1b[2m', g: '\x1b[32m', r: '\x1b[31m', y: '\x1b[33m', b: '\x1b[1m', x: '\x1b[0m' };
const ok = s => console.log(`  ${c.g}✓${c.x} ${s}`);
const bad = s => console.log(`  ${c.r}✗${c.x} ${s}`);
const dim = s => console.log(`  ${c.d}${s}${c.x}`);

async function tg(token, method, params) {
  const url = `${API(token)}/${method}` + (params ? '?' + new URLSearchParams(params) : '');
  const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
  const j = await res.json().catch(() => ({ ok: false, description: `HTTP ${res.status}` }));
  return j;
}

function writeEnv(updates) {
  let lines = fs.existsSync(ENV) ? fs.readFileSync(ENV, 'utf8').split(/\r?\n/) : [];
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
  for (const [k, v] of Object.entries(updates)) {
    const i = lines.findIndex(l => l.trim().startsWith(k + '='));
    if (i >= 0) lines[i] = `${k}=${v}`;
    else lines.push(`${k}=${v}`);
  }
  fs.writeFileSync(ENV, lines.join('\n') + '\n');
  fs.chmodSync(ENV, 0o600);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

console.log(`
  ${c.b}Telegram setup${c.x}
  ${c.d}──────────────${c.x}

  In Telegram, do this first (30 seconds):

    ${c.b}1.${c.x} Search for  ${c.b}@BotFather${c.x}  and open the chat
    ${c.b}2.${c.x} Send:  ${c.b}/newbot${c.x}
    ${c.b}3.${c.x} Give it any name, e.g.  ${c.b}F1 Alarm${c.x}
    ${c.b}4.${c.x} Give it a username ending in ${c.b}bot${c.x}, e.g.  ${c.b}faisal_f1_alarm_bot${c.x}
    ${c.b}5.${c.x} BotFather replies with a token like
       ${c.d}8123456789:AAF-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx${c.x}
`);

const rl = readline.createInterface({ input, output });
let closed = false;
rl.on('close', () => { closed = true; });

async function ask(q) {
  if (closed || !input.isTTY) return null;
  try { return (await rl.question(q)).trim(); } catch { return null; }
}
function giveUp(why) {
  console.log(`
  ${c.y}${why}${c.x}
  ${c.d}Run it again when you have the token:${c.x}  ${c.b}npm run telegram${c.x}
`);
}

let token = process.argv[2];
while (true) {
  if (!token) {
    token = await ask(`  ${c.b}Paste your bot token:${c.x} `);
    if (token === null) { giveUp('No token entered.'); break; }
  }
  if (!token) continue;
  if (!/^\d+:[\w-]{30,}$/.test(token)) {
    bad("That doesn't look like a bot token (expected digits, a colon, then a long string).");
    token = null;
    if (!input.isTTY) { giveUp('Stopping.'); break; }
    continue;
  }
  const me = await tg(token, 'getMe');
  if (!me.ok) {
    bad(`Telegram rejected it: ${me.description}`);
    token = null;
    if (!input.isTTY) { giveUp('Stopping.'); break; }
    continue;
  }
  ok(`Token valid — bot is ${c.b}@${me.result.username}${c.x}`);

  await tg(token, 'deleteWebhook');   // otherwise getUpdates returns nothing

  console.log(`
  ${c.y}Now open this link on your phone and press START:${c.x}
  ${c.b}https://t.me/${me.result.username}${c.x}
`);
  dim('waiting for your message…');

  let chat = null;
  for (let i = 0; i < 150 && !chat; i++) {
    const u = await tg(token, 'getUpdates', { timeout: 0, limit: 10, offset: -10 });
    if (u.ok && u.result.length) {
      const m = u.result.map(x => x.message || x.edited_message).filter(Boolean).pop();
      if (m) chat = m.chat;
    }
    if (!chat) await sleep(2000);
  }

  if (!chat) {
    bad('No message received after 5 minutes.');
    dim(`Open https://t.me/${me.result.username}, press START, then run this again.`);
    break;
  }

  const who = [chat.first_name, chat.last_name].filter(Boolean).join(' ') || chat.username || 'you';
  ok(`Found you: ${c.b}${who}${c.x} (chat id ${chat.id})`);

  writeEnv({ TELEGRAM_TOKEN: token, TELEGRAM_CHAT_ID: String(chat.id) });
  ok('Saved to .env');

  const test = await tg(token, 'sendMessage', {
    chat_id: chat.id,
    parse_mode: 'HTML',
    text: '<b>🔔 F1 Alarm connected</b>\nEntry, TP/SL and pre-alert signals will arrive here.'
  });
  if (test.ok) ok('Test message sent — check your phone');
  else bad(`Could not send test: ${test.description}`);

  console.log(`
  ${c.g}Done.${c.x} Restart the scanner to pick it up:

    ${c.b}./start.sh${c.x}
`);
  break;
}
rl.close();
