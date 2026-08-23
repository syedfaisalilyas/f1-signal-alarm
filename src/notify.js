// Phone delivery: Telegram, ntfy, Web Push. All optional, all fire in parallel.
import webpush from 'web-push';

let pushReady = false;
export function initPush() {
  const { VAPID_PUBLIC, VAPID_PRIVATE, VAPID_SUBJECT } = process.env;
  if (VAPID_PUBLIC && VAPID_PRIVATE) {
    webpush.setVapidDetails(VAPID_SUBJECT || 'mailto:alarm@localhost', VAPID_PUBLIC, VAPID_PRIVATE);
    pushReady = true;
  }
  return pushReady;
}

export function channelStatus() {
  return {
    telegram: !!(process.env.TELEGRAM_TOKEN && process.env.TELEGRAM_CHAT_ID),
    ntfy: !!process.env.NTFY_TOPIC,
    webpush: pushReady
  };
}

async function sendTelegram(text) {
  const t = process.env.TELEGRAM_TOKEN, chat = process.env.TELEGRAM_CHAT_ID;
  if (!t || !chat) return 'not configured';
  const res = await fetch(`https://api.telegram.org/bot${t}/sendMessage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chat, text, parse_mode: 'HTML', disable_web_page_preview: true })
  });
  if (!res.ok) throw new Error('telegram ' + res.status + ' ' + (await res.text()).slice(0, 200));
  return 'sent';
}

async function sendNtfy(title, body, priority, tags) {
  const topic = process.env.NTFY_TOPIC;
  if (!topic) return 'not configured';
  const server = process.env.NTFY_SERVER || 'https://ntfy.sh';
  const res = await fetch(`${server}/${topic}`, {
    method: 'POST',
    headers: {
      Title: title,
      Priority: String(priority),           // 5 = max → bypasses silent mode on Android
      Tags: tags.join(','),
      'Content-Type': 'text/plain; charset=utf-8'
    },
    body
  });
  if (!res.ok) throw new Error('ntfy ' + res.status);
  return 'sent';
}

async function sendWebPush(subs, payload, onDead) {
  if (!pushReady) return 'not configured';
  if (!subs.length) return 'no devices subscribed';
  let sent = 0, dead = 0;
  await Promise.all(subs.map(async (s) => {
    try { await webpush.sendNotification(s, JSON.stringify(payload)); sent++; }
    catch (e) {
      if (e.statusCode === 410 || e.statusCode === 404) { dead++; onDead?.(s.endpoint); }
      else throw e;
    }
  }));
  return `sent to ${sent} device(s)` + (dead ? `, dropped ${dead} stale` : '');
}

const fmt = (v, d = 6) => v === null || v === undefined ? '—' :
  (Math.abs(v) >= 1000 ? v.toFixed(2) : Math.abs(v) >= 1 ? v.toFixed(4) : v.toPrecision(d));

export function buildMessage(kind, w, a) {
  const sym = `${w.symbol} ${w.interval}`;
  const mk = w.market === 'futures' ? ' ⓕ' : '';

  if (kind === 'ENTRY') {
    const p = a.position;
    const arrow = p.side === 'LONG' ? '🚀' : '🔻';
    const title = `${arrow} ${p.side} ${w.symbol} ${w.interval}`;
    const body =
      `Entry  ${fmt(p.entryPrice)}\n` +
      `TP1    ${fmt(p.tp1)}  (+${(Math.abs(p.tp1 - p.entryPrice) / p.entryPrice * 100).toFixed(2)}%)\n` +
      `TP2    ${fmt(p.tp2)}  (+${(Math.abs(p.tp2 - p.entryPrice) / p.entryPrice * 100).toFixed(2)}%)\n` +
      `SL     ${fmt(p.sl)}  (-${p.riskPct.toFixed(2)}%)\n` +
      (p.tpSource ? `target ${p.tpSource}\n` : '') +
      (a.profile ? `POC ${fmt(a.profile.poc)} · VA ${fmt(a.profile.val)}-${fmt(a.profile.vah)}\n` : '') +
      `RSI ${a.rsi.toFixed(1)} · ATR ${a.atrPct.toFixed(2)}% · Vol ${a.volRatio.toFixed(2)}x` +
      (p.volConfirmed ? ' ✅' : '');
    return {
      title, body,
      telegram: `<b>${arrow} ${p.side} ${sym}${mk}</b>\n<pre>${body}</pre>`,
      priority: 5, tags: p.side === 'LONG' ? ['rocket', 'chart_with_upwards_trend'] : ['small_red_triangle_down', 'chart_with_downwards_trend']
    };
  }

  if (kind === 'PREALERT') {
    const f = a.forecast;
    const mins = f.msToBarClose / 60000;
    const eta = f.barsToCross !== null
      ? `~${f.barsToCross.toFixed(1)} bars (${(f.barsToCross * intervalMin(w.interval)).toFixed(0)} min)`
      : `this bar (${mins.toFixed(1)} min left)`;
    const title = `⏳ ${f.side} forming — ${w.symbol} ${w.interval}`;
    const body =
      `Triggers at ${fmt(f.triggerPrice)}\n` +
      `Price ${fmt(a.price)} → needs ${Math.abs(f.distancePct).toFixed(2)}% ${f.distancePct > 0 ? 'up' : 'down'}\n` +
      `ETA ${eta} · readiness ${f.readiness}%\n` +
      `RSI ${a.rsi.toFixed(1)} ${f.conditions.rsi ? '✓' : '✗'}  MACD ${f.conditions.macd ? '✓' : '✗'}  Vol ${f.conditions.volume ? '✓' : '✗'}`;
    return {
      title, body,
      telegram: `<b>⏳ ${f.side} forming — ${sym}${mk}</b>\n<pre>${body}</pre>`,
      priority: 4, tags: ['hourglass_flowing_sand']
    };
  }

  if (kind === 'EXIT') {
    const t = a.justClosed;
    const good = t.r >= 0;
    const title = `${good ? '✅' : '🛑'} ${t.reason} — ${w.symbol} ${w.interval}`;
    const body =
      `Closed ${t.side} @ ${fmt(t.exitPrice)}\n` +
      `From   ${fmt(t.entryPrice)}\n` +
      `Result ${t.r >= 0 ? '+' : ''}${t.r.toFixed(2)}R  (${t.pnlPct >= 0 ? '+' : ''}${t.pnlPct.toFixed(2)}%)`;
    return {
      title, body,
      telegram: `<b>${good ? '✅' : '🛑'} ${t.reason} — ${sym}${mk}</b>\n<pre>${body}</pre>`,
      priority: good ? 4 : 5, tags: good ? ['white_check_mark'] : ['octagonal_sign']
    };
  }
}

export function intervalMin(iv) {
  const n = parseInt(iv);
  return iv.endsWith('h') ? n * 60 : iv.endsWith('d') ? n * 1440 : n;
}

export async function dispatch(msg, subs, onDead) {
  const results = {};
  const run = (name, p) => p.then(r => results[name] = r || 'sent').catch(e => results[name] = 'FAILED: ' + e.message);
  await Promise.allSettled([
    run('telegram', sendTelegram(msg.telegram)),
    run('ntfy', sendNtfy(msg.title, msg.body, msg.priority, msg.tags)),
    run('webpush', sendWebPush(subs, { title: msg.title, body: msg.body, priority: msg.priority }, onDead))
  ]);
  results.delivered = Object.entries(results).some(([k, v]) => k !== 'delivered' && String(v).startsWith('sent'));
  return results;
}
