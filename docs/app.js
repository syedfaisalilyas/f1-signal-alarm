// ─────────── state ───────────
let ws, state = { watches: [], settings: {}, defaults: {}, channels: {}, vapidPublic: null, forexEnabled: false };
let audioCtx = null, soundOn = false, alarmTimer = null;
const $ = s => document.querySelector(s);
const el = (t, c, h) => { const n = document.createElement(t); if (c) n.className = c; if (h !== undefined) n.innerHTML = h; return n; };

// ─────────── formatting ───────────
const fmtPx = v => v == null ? '—'
  : Math.abs(v) >= 1000 ? v.toLocaleString('en-US', { maximumFractionDigits: 2 })
  : Math.abs(v) >= 1 ? v.toFixed(4)
  : Math.abs(v) >= 0.01 ? v.toFixed(5)
  : v.toPrecision(4);
const pct = v => (v >= 0 ? '+' : '') + v.toFixed(2) + '%';
const ago = t => {
  const s = Math.floor((Date.now() - t) / 1000);
  return s < 60 ? s + 's' : s < 3600 ? Math.floor(s / 60) + 'm' : Math.floor(s / 3600) + 'h';
};
const ivMin = iv => { const n = parseInt(iv); return iv.endsWith('h') ? n * 60 : n; };

// ─────────── access key ───────────
let appKey = localStorage.getItem('f1key') || '';
{
  const fromUrl = new URLSearchParams(location.search).get('key');
  if (fromUrl) {
    appKey = fromUrl;
    localStorage.setItem('f1key', fromUrl);
    history.replaceState({}, '', location.pathname);   // keep it out of the address bar
  }
}
function askKey(msg) {
  const k = prompt(msg || 'Access key for this dashboard:');
  if (k) { localStorage.setItem('f1key', k.trim()); location.reload(); }
}
async function api(path, opts = {}) {
  const r = await fetch(path, { ...opts, headers: { ...(opts.headers || {}), 'x-app-key': appKey } });
  if (r.status === 401) { askKey('Wrong or missing key. Try again:'); throw new Error('unauthorized'); }
  return r;
}

// The tunnel returns an HTML error page on a hiccup, and r.json() then throws
// "The string did not match the expected pattern" — useless on screen. Read the
// body once and say what actually happened.
async function apiJson(path, opts) {
  const r = await api(path, opts);
  const text = await r.text();
  try { return JSON.parse(text); }
  catch {
    const snippet = text.trim().slice(0, 60).replace(/\s+/g, ' ');
    throw new Error(r.ok ? `bad response (${snippet}…)` : `HTTP ${r.status} — connection dropped, retrying`);
  }
}

// ─────────── websocket ───────────
function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws?key=${encodeURIComponent(appKey)}`);
  ws.onopen = () => setConn(true);
  ws.onclose = e => {
    setConn(false);
    if (e.code === 4001) return askKey('This dashboard needs an access key:');
    setTimeout(connect, 2000);
  };
  ws.onmessage = e => {
    const { type, payload } = JSON.parse(e.data);
    if (type === 'init') {
      state = { ...state, ...payload };
      applySettingsToForm();
      renderChannels();
      render();
      renderLog(payload.log);
      updateMuteBtn();
      initVol();
    }
    if (type === 'watches') { state.watches = payload; render(); loadVol(); }
    if (type === 'tick') {
      const w = state.watches.find(x => x.id === payload.id);
      if (w) { w.analysis = payload.analysis; w.loading = false; w.error = null; patchCard(w); }
    }
    if (type === 'werror') {
      const w = state.watches.find(x => x.id === payload.id);
      if (w) { w.error = payload.error; patchCard(w); }
    }
    if (type === 'alert') onAlert(payload);
    if (type === 'settings') { state.settings = payload; updateMuteBtn(); }
  };
}
function setConn(on) {
  $('#conn').innerHTML = `<i class="dot ${on ? 'on' : 'off'}"></i> ${on ? 'live' : 'reconnecting…'}`;
}

// ─────────── search ───────────
let searchTimer, resultsData = [], selIdx = -1;
$('#q').addEventListener('input', e => {
  clearTimeout(searchTimer);
  const q = e.target.value.trim();
  searchTimer = setTimeout(() => doSearch(q), 180);
});
$('#q').addEventListener('keydown', e => {
  if (!resultsData.length) return;
  if (e.key === 'ArrowDown') { selIdx = Math.min(selIdx + 1, resultsData.length - 1); paintResults(); e.preventDefault(); }
  if (e.key === 'ArrowUp') { selIdx = Math.max(selIdx - 1, 0); paintResults(); e.preventDefault(); }
  if (e.key === 'Enter' && selIdx >= 0) { addWatch(resultsData[selIdx]); e.preventDefault(); }
  if (e.key === 'Escape') hideResults();
});
document.addEventListener('click', e => { if (!e.target.closest('.searchwrap')) hideResults(); });

async function doSearch(q) {
  if (!q) return hideResults();
  const r = await api('/api/search?q=' + encodeURIComponent(q));
  resultsData = await r.json();
  selIdx = resultsData.length ? 0 : -1;
  paintResults();
}
function paintResults() {
  const box = $('#results');
  if (!resultsData.length) return hideResults();
  box.innerHTML = '';
  resultsData.forEach((s, i) => {
    const tag = s.market === 'futures' ? '<span class="tag fut">perp</span>'
      : s.market === 'forex' ? '<span class="tag fx">forex</span>' : '<span class="tag">spot</span>';
    const n = el('div', 'res' + (i === selIdx ? ' sel' : ''),
      `<b>${s.symbol}</b><span class="dim" style="font-size:12px">${s.label}</span>${tag}`);
    n.onclick = () => addWatch(s);
    box.appendChild(n);
  });
  box.classList.remove('hidden');
}
function hideResults() { $('#results').classList.add('hidden'); resultsData = []; selIdx = -1; }

async function addWatch(s) {
  hideResults();
  $('#q').value = '';
  const interval = $('#tf').value;
  const r = await api('/api/watches', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ market: s.market, symbol: s.symbol, interval })
  });
  if (!r.ok) {
    const e = await r.json();
    alert(e.error || 'could not add');
  }
}
async function removeWatch(id) {
  await api('/api/watches/' + encodeURIComponent(id), { method: 'DELETE' });
}

// ─────────── rendering ───────────
function render() {
  const grid = $('#grid');
  grid.innerHTML = '';
  $('#empty').classList.toggle('hidden', state.watches.length > 0);
  state.watches.forEach(w => grid.appendChild(buildCard(w)));
}
const TREND_ARROW = { UP: '▲', DOWN: '▼', FLAT: '–' };

// The 15m/1h/4h read for the coin, so a scalp signal is seen in context.
function trendRow(t) {
  const cells = Object.entries(t.tfs).map(([tf, d]) => {
    if (!d) return `<span class="tr none"><b>${tf}</b>—</span>`;
    const cls = d.dir === 'UP' ? 'up' : d.dir === 'DOWN' ? 'down' : 'flat';
    const move = `${d.changePct >= 0 ? '+' : ''}${d.changePct}%`;
    return `<span class="tr ${cls}" title="${tf}: ${d.dir.toLowerCase()} · ADX ${d.adx ?? '—'} · EMA21/55 gap ${d.sep}% · ${move} over 55 bars">`
      + `<b>${tf}</b>${TREND_ARROW[d.dir]}</span>`;
  }).join('');
  const bias = t.bias === 'MIXED'
    ? '<span class="tr bias mixed" title="The timeframes disagree">mixed</span>'
    : `<span class="tr bias ${t.bias.toLowerCase()}" title="All timeframes agree">${t.bias === 'UP' ? 'uptrend' : 'downtrend'}</span>`;
  return el('div', 'trend', cells + bias);
}

function patchCard(w) {
  const old = document.getElementById('c_' + cssId(w.id));
  if (!old) return render();
  const fresh = buildCard(w);
  old.replaceWith(fresh);
}
const cssId = id => id.replace(/[^a-zA-Z0-9]/g, '_');

function buildCard(w) {
  const a = w.analysis;
  const card = el('div', 'card');
  card.id = 'c_' + cssId(w.id);

  const p = a?.position, f = a?.forecast;
  if (p) card.classList.add(p.side === 'LONG' ? 'long' : 'short');
  else if (f?.imminent) card.classList.add('forming');

  const mtag = (w.market === 'futures' ? '<span class="tag fut">perp</span>'
    : w.market === 'forex' ? '<span class="tag fx">fx</span>' : '')
    + (w.maxLev ? `<span class="tag lev">${w.maxLev}x max</span>` : '');

  const head = el('div', 'chead', `
    <div class="sym"><b>${w.symbol}</b><span class="iv">${w.interval}</span>${mtag}</div>`);
  const x = el('button', 'x', '✕');
  x.onclick = e => { e.stopPropagation(); removeWatch(w.id); };
  head.appendChild(x);
  card.appendChild(head);

  card.onclick = () => openHistory(w.id);
  card.style.cursor = 'pointer';

  if (w.loading) { card.appendChild(el('div', 'dim', 'loading history…')); return card; }
  if (w.error) { card.appendChild(el('div', 'err', w.error)); return card; }
  if (!a) { card.appendChild(el('div', 'dim', 'waiting for data…')); return card; }

  // price + status badge
  const badge = p
    ? `<span class="badge b-${p.side.toLowerCase()}">${p.side === 'LONG' ? '▲' : '▼'} in ${p.side.toLowerCase()}</span>`
    : f?.imminent ? `<span class="badge b-form">⏳ ${f.side} forming</span>`
    : `<span class="badge b-flat">flat</span>`;
  card.appendChild(el('div', 'px', `<span class="v">${fmtPx(a.price)}</span>${badge}`));

  if (w.trend) {
    card.appendChild(trendRow(w.trend));
    // Worth saying out loud: the setup and the higher timeframes disagree.
    const side = p?.side || (f?.imminent ? f.side : null);
    if (side && w.trend.bias !== 'MIXED' && side !== (w.trend.bias === 'UP' ? 'LONG' : 'SHORT')) {
      card.appendChild(el('div', 'counter',
        `⚠ ${side.toLowerCase()} against a higher-timeframe ${w.trend.bias === 'UP' ? 'uptrend' : 'downtrend'}`));
    }
  }

  if (p) {
    // ── open position: levels + progress between SL and TP2 ──
    const lo = Math.min(p.sl, p.tp2), hi = Math.max(p.sl, p.tp2);
    const prog = Math.max(0, Math.min(100, ((a.price - lo) / (hi - lo)) * 100));
    const lev = w.maxLev;
    const mv = v => Math.abs(v - p.entryPrice) / p.entryPrice * 100;
    const lx = (pct, sign) => lev
      ? `<em>${sign}${pct.toFixed(2)}%</em><b>${sign}${(pct * lev).toFixed(0)}%</b>`
      : `<em>${sign}${pct.toFixed(2)}%</em>`;
    const lvls = el('div', 'levels', `
      <div class="lv tp"><span>TP2</span><span class="lvv">${lx(mv(p.tp2), '+')}${fmtPx(p.tp2)}</span></div>
      <div class="lv tp" style="opacity:.8"><span>TP1${p.tp1Done ? ' ✓ hit' : ''}</span><span class="lvv">${lx(mv(p.tp1), '+')}${fmtPx(p.tp1)}</span></div>
      <div class="lv en"><span>Entry</span><span class="lvv">${fmtPx(p.entryPrice)}</span></div>
      <div class="lv sl"><span>SL${p.tp1Done ? ' → BE' : ''}</span><span class="lvv">${lx(p.riskPct, '-')}${fmtPx(p.sl)}</span></div>`);
    if (p.tpSource) card.appendChild(el('div', 'tpsrc', `target from <b>${p.tpSource}</b>`));
    card.appendChild(lvls);
    const meter = el('div', 'meter');
    const bar = el('i');
    bar.style.width = prog + '%';
    bar.style.background = p.livePnlPct >= 0 ? 'var(--up)' : 'var(--down)';
    meter.appendChild(bar);
    card.appendChild(meter);
    const pnlCls = p.livePnlPct >= 0 ? 'up' : 'down';
    const levPnl = lev ? ` · <b>${pct(p.livePnlPct * lev)}</b> @${lev}x` : '';
    card.appendChild(el('div', 'trigger', `
      <div class="t1"><span class="dim">Live P&L</span>
        <span class="${pnlCls}">${pct(p.livePnlPct)} · ${p.liveR >= 0 ? '+' : ''}${p.liveR.toFixed(2)}R${levPnl}</span></div>
      <div class="t2"><span>held ${p.barsHeld} bars${p.tp1Done ? ` · TP1 banked ${Math.round(p.tp1Portion * 100)}%` : ''}</span>
        <span>risk ${p.riskPct.toFixed(2)}%</span></div>`));
    if (lev && p.riskPct * lev >= 50)
      card.appendChild(el('div', 'liqwarn',
        `⚠ at ${lev}x the stop costs ${(p.riskPct * lev).toFixed(0)}% of margin · liquidation ≈ ${(100 / lev).toFixed(1)}% move`));
  } else if (f) {
    // ── flat: how far to the trigger ──
    const dir = f.distancePct > 0 ? 'up' : 'down';
    const eta = f.barsToCross != null
      ? `~${f.barsToCross.toFixed(1)} bars · ${(f.barsToCross * ivMin(w.interval)).toFixed(0)}m`
      : `bar closes in ${Math.ceil(f.msToBarClose / 60000)}m`;
    card.appendChild(el('div', 'trigger', `
      <div class="t1"><span class="dim">${f.side} triggers at</span><b>${fmtPx(f.triggerPrice)}</b></div>
      <div class="t2"><span>needs ${Math.abs(f.distancePct).toFixed(2)}% ${dir}</span><span>${eta}</span></div>`));
    const meter = el('div', 'meter');
    const bar = el('i');
    bar.style.width = f.readiness + '%';
    bar.style.background = f.readiness > 75 ? 'var(--warn)' : f.readiness > 45 ? 'var(--info)' : 'var(--faint)';
    meter.appendChild(bar);
    card.appendChild(meter);
    if (a.regime && a.regime.adx != null) {
      const strong = a.regime.adx >= (state.settings.cfg?.minAdx ?? 20);
      card.appendChild(el('div', 'chips',
        `<span class="chip ${strong ? 'ok' : 'no'}">ADX ${a.regime.adx.toFixed(0)}${strong ? ' trending' : ' chop'}</span>` +
        `<span class="chip">EMA gap ${a.regime.emaSep?.toFixed(2) ?? '—'}%</span>` +
        `<span class="chip">${a.regime.recentSignals} signals/30b</span>`));
    }
    card.appendChild(el('div', 'chips', Object.entries(f.conditions)
      .map(([k, v]) => `<span class="chip ${v ? 'ok' : 'no'}">${k}${v ? ' ✓' : ' ✗'}</span>`).join('')
      + `<span class="chip">ready ${f.readiness}%</span>`));
  }

  if (a.calibration) {
    const k = a.calibration, lev = w.maxLev;
    const over = lev && lev > k.liqLev;
    card.appendChild(el('div', 'calib', `
      <div class="c1"><span>Stop ${k.stopPct.toFixed(2)}%</span>
        <span class="dim">covers ${(state.settings.cfg?.autoCoverage ?? 0.85) * 100}% of winner pullbacks</span></div>
      <div class="c2"><span>typical winner <b class="up">+${k.medianWinPct.toFixed(1)}%</b></span>
        <span>big winner <b class="up">+${k.bigWinPct.toFixed(0)}%</b></span></div>
      <div class="c3 ${over ? 'bad' : ''}">max survivable ${k.liqLev}x · comfortable ${k.safeLev}x${over ? ` — ${lev}x liquidates before the stop` : ''}</div>`));
  }
  if (a.profile) card.appendChild(vaStrip(a.profile, a.price, p));

  card.appendChild(el('div', 'cfoot', `
    <span>RSI ${a.rsi?.toFixed(1) ?? '—'} · ATR ${a.atrPct?.toFixed(2) ?? '—'}% · Vol ${a.volRatio?.toFixed(2) ?? '—'}x</span>
    <span>${a.stats.trades}t · ${a.stats.winRate.toFixed(0)}% win · ${a.stats.totalR >= 0 ? '+' : ''}${a.stats.totalR.toFixed(1)}R</span>`));

  return card;
}

// Value-area strip: where price sits inside the volume profile, with the
// shelves that TP levels are drawn from marked on it.
function vaStrip(prof, price, pos) {
  const lo = Math.min(prof.lo, price), hi = Math.max(prof.hi, price);
  const span = hi - lo || 1;
  const at = v => Math.max(0, Math.min(100, ((v - lo) / span) * 100));
  const wrap = el('div', 'vp');
  const bar = el('div', 'vpbar');

  const va = el('i', 'vpva');
  va.style.left = at(prof.val) + '%';
  va.style.width = Math.max(1, at(prof.vah) - at(prof.val)) + '%';
  bar.appendChild(va);

  for (const n of prof.nodes) {
    const t = el('i', 'vpnode');
    t.style.left = at(n) + '%';
    bar.appendChild(t);
  }
  const pocEl = el('i', 'vppoc');
  pocEl.style.left = at(prof.poc) + '%';
  bar.appendChild(pocEl);

  if (pos) {
    for (const [lvl, cls] of [[pos.tp1, 'vptp'], [pos.tp2, 'vptp'], [pos.sl, 'vpsl']]) {
      const m = el('i', cls);
      m.style.left = at(lvl) + '%';
      bar.appendChild(m);
    }
  }
  const now = el('i', 'vpnow');
  now.style.left = at(price) + '%';
  bar.appendChild(now);

  wrap.appendChild(bar);
  wrap.appendChild(el('div', 'vplbl',
    `<span>VAL ${fmtPx(prof.val)}</span><span class="poc">POC ${fmtPx(prof.poc)}</span><span>VAH ${fmtPx(prof.vah)}</span>`));
  return wrap;
}

// ─────────── best suitable ───────────
$('#bestBtn').onclick = () => { $('#bestModal').classList.remove('hidden'); loadBest(); };
$('#bestClose').onclick = () => $('#bestModal').classList.add('hidden');
$('#bestModal').onclick = e => { if (e.target.id === 'bestModal') $('#bestModal').classList.add('hidden'); };
$('#bestCoins').onchange = loadBest;
$('#bestMode').onchange = () => renderBest(lastBest);
$('#bestSort').onchange = () => renderBest(lastBest);
$('#bestRefresh').onclick = loadBest;
// Period and explicit dates are two ways to say the same thing, so picking one
// clears the other rather than leaving a contradictory pair on screen.
$('#bestDays').onchange = () => { $('#bestFrom').value = ''; $('#bestTo').value = ''; loadBest(); };
$('#bestFrom').onchange = () => { $('#bestDays').value = ''; loadBest(); };
$('#bestTo').onchange = () => { $('#bestDays').value = ''; loadBest(); };
$('#bestClear').onclick = () => {
  $('#bestDays').value = '';
  $('#bestFrom').value = '';
  $('#bestTo').value = '';
  loadBest();
};

// The window to score trades in: a rolling period, an explicit range, or
// neither — in which case the whole backtest counts, as it always did.
function bestWindow() {
  const days = Number($('#bestDays').value) || 0;
  if (days) {
    return { from: Date.now() - days * 86400000, to: '',
             label: days === 1 ? 'last 24 hours' : `last ${days} days` };
  }
  // Date inputs are local days; the API works in epoch ms, so send whole days.
  const from = $('#bestFrom').value ? new Date($('#bestFrom').value + 'T00:00:00').getTime() : '';
  const to = $('#bestTo').value ? new Date($('#bestTo').value + 'T23:59:59.999').getTime() : '';
  const label = from || to ? `${$('#bestFrom').value || 'start'} → ${$('#bestTo').value || 'now'}` : '';
  return { from, to, label };
}

let lastBest = null;
async function loadBest() {
  const w = bestWindow();
  $('#bestMeta').textContent = w.label
    ? `backtesting ${w.label}… a longer period means deeper candle fetches`
    : 'backtesting… this takes a few seconds';
  $('#bestRows').innerHTML = '';
  try {
    lastBest = await apiJson(`/api/screener?coins=${$('#bestCoins').value}`
      + `&from=${w.from}&to=${w.to}`);
    if (lastBest.error) throw new Error(lastBest.error);
    renderBest(lastBest);
  } catch (e) {
    $('#bestMeta').textContent = 'scan failed: ' + e.message;
  }
}

const SORT_KEYS = {
  raw: [r => r.totalPct, 'percent of price captured'],
  rec: [r => r.pctAtUsable, 'return at the recommended leverage'],
  max: [r => r.totalPct * (r.maxLev || 1), 'return at MEXC max leverage']
};

function renderBest(d) {
  if (!d) return;
  const [keyFn, label] = SORT_KEYS[$('#bestSort').value] || SORT_KEYS.rec;
  // Re-pick the best timeframe per coin using the chosen metric, not the
  // server's default ranking — otherwise sorting reorders the wrong shortlist.
  let rows = [...d.rows].sort((a, b) => keyFn(b) - keyFn(a));
  if ($('#bestMode').value === 'best') {
    const seen = new Set();
    rows = rows.filter(r => (seen.has(r.symbol) ? false : seen.add(r.symbol)));
  }
  const w = bestWindow();
  const day = ts => new Date(ts).toLocaleDateString([], { month: 'short', day: 'numeric' });
  $('#bestMeta').innerHTML =
    `tested ${d.scanned} coin/timeframe combos · <b>${d.profitable}</b> profitable · ` +
    (w.label ? `scored over <b>${w.label}</b> · ` : '') +
    `sorted by ${label}`;
  // Deep history costs API calls, so the scan is capped — say when the window
  // asked for more than the candles actually reach, rather than showing a
  // short period as if it were the whole story.
  if (w.from && d.reach?.shallowest > w.from + 3600000) {
    $('#bestMeta').innerHTML +=
      `<br><span class="warn">Some timeframes only reach back to ${day(d.reach.shallowest)} at this scan depth` +
      (d.reach.deepest < d.reach.shallowest ? ` (the deepest goes to ${day(d.reach.deepest)})` : '') +
      ` — 1m candles run out first.</span>`;
  }
  const box = $('#bestRows');
  box.innerHTML = '';
  if (!rows.length) {
    box.innerHTML = `<div class="hempty">${w.label
      ? 'Nothing profitable in that period.' : 'Nothing profitable in this scan.'}</div>`;
    return;
  }

  for (const r of rows) {
    const n = el('div', 'brow' + (r.watched ? ' watched' : ''), `
      <div class="b1">
        <span class="bsym">${r.symbol}</span>
        <span class="iv">${r.interval}</span>
        ${r.watched ? '<span class="tag">watching</span>' : ''}
        <span class="bpct up">+${r.totalPct.toFixed(1)}%</span>
      </div>
      <div class="b2">
        <span>${r.trades} trades${r.allTrades > r.trades ? ` of ${r.allTrades}` : ''}</span>
        <span class="${r.winRate >= 70 ? 'up' : ''}">${r.winRate.toFixed(0)}% win</span>
        <span>ADX ${r.adx?.toFixed(0) ?? '—'}</span>
        <span>stop ${r.stopPct?.toFixed(1) ?? '—'}%</span>
      </div>
      <div class="b3"><span>1D ${r.vol1d?.toFixed(0)}% · 1H ${r.vol1h?.toFixed(1)}%</span></div>
      <div class="blevs">
        <div class="lvbox max">
          <span>MEXC max ${r.maxLev ?? '—'}x</span>
          <b>+${(r.totalPct * (r.maxLev || 1)).toFixed(0)}%</b>
          <em>${r.maxLev > r.usableLev ? `needs ≤${r.usableLev}x to survive the stop` : 'stop survives ✓'}</em>
        </div>
        <div class="lvbox rec">
          <span>Recommended ${r.usableLev}x</span>
          <b>+${r.pctAtUsable.toFixed(0)}%</b>
          <em>stop costs ${(r.stopPct * r.usableLev).toFixed(0)}% of margin</em>
        </div>
      </div>`);
    n.onclick = () => {
      if (r.watched) return;
      addWatch({ market: r.market, symbol: r.symbol });
      $('#tf').value = r.interval;
      setTimeout(() => addWatch({ market: r.market, symbol: r.symbol }), 50);
    };
    box.appendChild(n);
  }
}

// ─────────── coil → ignition ───────────
// Which build is on screen. Pages caches for ten minutes and a phone can hold
// it longer, so "is the fix live yet" was being answered by guesswork on both
// sides of the conversation. Now the page says.
$('#buildStamp').textContent = window.__BUILD ? `· build ${window.__BUILD}` : '· dev';

$('#coilBtn').onclick = () => { $('#coilModal').classList.remove('hidden'); loadCoil(); };
$('#coilClose').onclick = () => $('#coilModal').classList.add('hidden');
$('#coilModal').onclick = e => { if (e.target.id === 'coilModal') $('#coilModal').classList.add('hidden'); };
$('#coilTf').onchange = loadCoil;
$('#coilVol').onchange = loadCoil;
$('#coilFresh').onchange = () => renderCoil(lastCoil);
$('#coilRefresh').onclick = loadCoil;

let lastCoil = null;
async function loadCoil() {
  $('#coilFired').innerHTML = '';
  $('#coilReady').innerHTML = '';
  // One pass is a few hundred requests and on a phone that is not quick. A
  // static label looks identical to a dead button, so count the seconds.
  let secs = 0;
  const label = () => $('#coilMeta').textContent =
    `sweeping every liquid perp… ${secs}s (a few hundred requests)`;
  label();
  const tick = setInterval(() => { secs++; label(); }, 1000);
  try {
    // Ask for the widest freshness the picker offers and narrow it here, so
    // changing "fresh within" re-filters instantly instead of re-sweeping.
    lastCoil = await apiJson(`/api/ignition?interval=${$('#coilTf').value}`
      + `&minVol=${$('#coilVol').value}&fresh=12`);
    if (lastCoil.error) throw new Error(lastCoil.error);
    renderCoil(lastCoil);
  } catch (e) {
    $('#coilMeta').innerHTML = `<span class="warn">sweep failed after ${secs}s — ${e.message}</span>`;
  } finally {
    clearInterval(tick);
  }
}

const px = v => v === null || v === undefined ? '—'
  : Math.abs(v) >= 1000 ? v.toFixed(2) : Math.abs(v) >= 1 ? v.toFixed(4) : v.toPrecision(5);

function renderCoil(d) {
  if (!d) return;
  const fresh = Number($('#coilFresh').value) || 3;
  const all = [...(d.igniting || []), ...(d.stale || [])];
  const fired = all.filter(r => r.fired.barsAgo <= fresh)
    .sort((a, b) => a.fired.barsAgo - b.fired.barsAgo || b.fired.volX - a.fired.volX);

  $('#coilMeta').innerHTML =
    `swept ${d.scanned} liquid ${d.market} symbols on ${d.interval} · ` +
    `<b>${fired.length}</b> igniting within ${fresh} candle${fresh > 1 ? 's' : ''} · ` +
    `<b>${d.coiling.length}</b> coiled`;

  const fbox = $('#coilFired');
  fbox.innerHTML = '';
  if (!fired.length) {
    fbox.innerHTML = '<div class="hempty">Nothing igniting right now — watch the coiled list.</div>';
  }
  for (const r of fired) {
    const f = r.fired;
    const up = f.side === 'LONG';
    // barsAgo is the whole point: the first candle is the trade, and six
    // candles later it is someone else's trade.
    const age = f.barsAgo === 0 ? 'this candle' : `${f.barsAgo} candle${f.barsAgo > 1 ? 's' : ''} ago`;
    const n = el('div', 'brow coilrow' + (up ? ' long' : ' short') + (r.watched ? ' watched' : ''), `
      <div class="b1">
        <span class="bsym">${r.symbol}</span>
        <span class="iv">${d.interval}</span>
        <span class="side ${up ? 'up' : 'down'}">${up ? '🚀 LONG' : '🔻 SHORT'}</span>
        ${r.watched ? '<span class="tag">watching</span>' : ''}
        <span class="grade g${f.grade || 'B'}">${f.grade === 'A' ? 'A · take it' : 'B'}</span>
        <span class="age ${f.barsAgo <= 1 ? 'hot' : ''}">${age}</span>
      </div>
      <div class="b2">
        <span>range <b>${f.rangeX.toFixed(1)}×</b> ATR</span>
        <span>vol <b>${f.volX.toFixed(1)}×</b></span>
        <span>body ${(f.bodyRatio * 100).toFixed(0)}%</span>
        <span>out of a ${f.boxWidthPct.toFixed(1)}% coil</span>
      </div>
      <div class="plan">
        <span>entry <b>${px(f.entry)}</b></span>
        <span>stop <b class="down">${px(f.stop)}</b> <em>${f.riskPct.toFixed(2)}%</em></span>
        <span class="trail">then trail <b>${((f.trailGive ?? 0.25) * 100).toFixed(0)}%</b> below the high</span>
        <span class="rr">${f.rr1.toFixed(1)}R</span>
      </div>
      <div class="plan refs">
        <span>ref TP1 ${px(f.tp1)}</span>
        <span>ref TP2 ${px(f.tp2)}</span>
        <em>don't sell there — that is what caps these at +285% instead of +12,000%</em>
      </div>
      <div class="b3">
        <span>$${(r.quoteVol / 1e6).toFixed(1)}M 24h · ${r.changePct.toFixed(1)}% today</span>
        <span class="why ${f.grade === 'A' ? 'ok' : ''}">${f.gradeWhy || ''}</span>
      </div>`);
    n.onclick = () => watchFromCoil(r, d.interval);
    fbox.appendChild(n);
  }

  renderCoilPast(d);

  const rbox = $('#coilReady');
  rbox.innerHTML = '';
  if (!d.coiling.length) {
    rbox.innerHTML = '<div class="hempty">Nothing coiled — the whole board is moving.</div>';
    return;
  }
  for (const r of d.coiling) {
    const c = r.coil;
    const n = el('div', 'brow coilrow coiled' + (r.watched ? ' watched' : ''), `
      <div class="b1">
        <span class="dial" style="--v:${r.readiness}%"><i>${r.readiness}</i></span>
        <span class="bsym">${r.symbol}</span>
        <span class="iv">${d.interval}</span>
        ${r.watched ? '<span class="tag">watching</span>' : ''}
        <span class="dim">${px(r.price)}</span>
      </div>
      <div class="b2">
        <span>box <b>${c.widthPct.toFixed(2)}%</b> wide</span>
        <span>tightest <b>${c.tightRank.toFixed(0)}%</b> of its own day</span>
        <span>vol <b>${(c.dryRatio * 100).toFixed(0)}%</b> of normal</span>
      </div>
      <div class="plan trig">
        <span>break up <b class="up">${px(r.trigger.up)}</b></span>
        <span>break down <b class="down">${px(r.trigger.down)}</b></span>
        <em>pre-place these and the move takes you with it</em>
      </div>`);
    n.onclick = () => watchFromCoil(r, d.interval);
    rbox.appendChild(n);
  }
}

// The track record: what this same setup already caught, scored by the trailing
// exit rather than the fixed target it used to use.
//
// Two sources. The scan window costs nothing — those candles arrived with the
// sweep. Anything longer is a separate deeper pass over fewer coins, so asking
// for a year never slows down "what is igniting now".
let pastRows = [], pastFrom = 'the scan window', pastDays = 0;

// One button applies all three. Sort and search could redraw on every keystroke
// and originally did, but a filter row where two controls act instantly and the
// third waits is a row you cannot trust — you change something, nothing moves,
// and you cannot tell whether it ignored you or is still working. So nothing
// applies until Apply, and the button says when there is something to apply.
$('#pastSort').onchange = markPastPending;
$('#pastQ').oninput = markPastPending;
$('#pastRange').onchange = markPastPending;
$('#pastApply').onclick = applyPast;
$('#pastQ').onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); applyPast(); } };

const RANGE_LABEL = { 0: 'the scan window', 30: 'last 30 days', 90: 'last 3 months',
                      180: 'last 6 months', 365: 'last year' };
// What is actually on screen, as opposed to what the controls are set to.
let applied = { days: 0, sort: 'pnl', q: '' };

const controls = () => ({
  days: Number($('#pastRange').value) || 0,
  sort: $('#pastSort').value,
  q: $('#pastQ').value.trim().toUpperCase()
});

function markPastPending() {
  const c = controls(), btn = $('#pastApply');
  const dirty = c.days !== applied.days || c.sort !== applied.sort || c.q !== applied.q;
  // Never disabled. A greyed-out Apply is indistinguishable from a broken one
  // on a phone — you tap it, nothing happens, and the control has lied to you.
  // Re-applying an unchanged filter is harmless, so let it always work.
  btn.classList.toggle('pending', dirty);
  btn.textContent = c.days !== applied.days ? `Apply — read ${RANGE_LABEL[c.days]}` : 'Apply filters';
}

async function applyPast() {
  const c = controls();
  // Only a changed range costs a fetch; the rest is a redraw.
  if (c.days !== applied.days) { await loadPast(); }
  applied = c;
  drawPast();
  markPastPending();
  // Say so out loud. A sort that reorders rows below the fold looks identical
  // to a button that did nothing, which is how this ends up reported as broken.
  const btn = $('#pastApply');
  btn.classList.add('done');
  setTimeout(() => btn.classList.remove('done'), 900);
  $('#coilPast').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function renderCoilPast(d) {
  if (Number($('#pastRange').value)) return;   // a deeper range is on screen
  pastRows = d.history || [];
  pastFrom = 'the scan window'; pastDays = 0;
  drawPast();
  markPastPending();
}

async function loadPast() {
  const days = Number($('#pastRange').value) || 0;
  if (!days) {
    pastRows = lastCoil?.history || [];
    pastFrom = 'the scan window'; pastDays = 0;
    drawPast(); return;
  }

  const btn = $('#pastApply');
  btn.textContent = 'Reading…';
  let secs = 0;
  const label = () => $('#pastMeta').textContent =
    `reading ${days} days of history… ${secs}s (deeper candles, top coins by volume)`;
  label();
  const tick = setInterval(() => { secs++; label(); }, 1000);
  $('#coilPast').innerHTML = '';
  try {
    const d = await apiJson(`/api/ignition/history?interval=${$('#coilTf').value}`
      + `&days=${days}&minVol=${$('#coilVol').value}`);
    if (d.error) throw new Error(d.error);
    pastRows = d.rows;
    pastFrom = `${d.days} days · top ${d.coins} coins by volume`;
    pastDays = d.days;
  } catch (e) {
    $('#pastMeta').innerHTML = `<span class="warn">could not read history after ${secs}s — ${e.message}</span>`;
  } finally {
    clearInterval(tick);
  }
}

const PAST_SORT = {
  pnl:  (a, b) => b.atMaxLev - a.atMaxLev,
  new:  (a, b) => b.entryTime - a.entryTime,
  old:  (a, b) => a.entryTime - b.entryTime,
  move: (a, b) => b.peakPct - a.peakPct,
  coil: (a, b) => (a.coilPct ?? 99) - (b.coilPct ?? 99)
};

function drawPast() {
  const box = $('#coilPast');
  box.innerHTML = '';
  const q = applied.q;
  const past = pastRows
    .filter(h => h.atMaxLev > 0)
    .filter(h => !q || h.symbol.includes(q))
    .sort(PAST_SORT[applied.sort] || PAST_SORT.pnl);

  $('#pastMeta').innerHTML = pastRows.length
    ? `<b>${past.length}</b> profitable ignition${past.length === 1 ? '' : 's'} from ${pastFrom}` +
      (q ? ` · matching “${q}”` : '') +
      ` · biggest +${Math.round(Math.max(0, ...past.map(h => h.atMaxLev))).toLocaleString()}% at MEXC max`
    : '';

  if (!past.length) {
    box.innerHTML = `<div class="hempty">${q ? `No ignitions for “${q}” in this range.`
      : 'No completed ignitions in this window yet.'}</div>`;
    return;
  }
  const when = t => new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  for (const h of past) {
    const up = h.side === 'LONG';
    const n = el('div', 'brow coilrow past' + (up ? ' long' : ' short'), `
      <div class="b1">
        <span class="bsym">${h.symbol}</span>
        <span class="iv">${h.interval}</span>
        <span class="side ${up ? 'up' : 'down'}">${up ? '🚀' : '🔻'} ${h.side}</span>
        ${h.open ? '<span class="age hot">still running</span>' : '<span class="age">trailed out</span>'}
        <span class="pnl">+${Math.round(h.atMaxLev).toLocaleString()}%<em>of a +${Math.round(
          h.peakAtMaxLev ?? h.peakPct * h.maxLev).toLocaleString()}% peak · kept ${(
          h.pnlPct / h.peakPct * 100).toFixed(0)}%</em></span>
      </div>
      <div class="b2">
        <span>moved <b>+${h.peakPct.toFixed(1)}%</b></span>
        <span>trail kept <b>+${h.pnlPct.toFixed(1)}%</b></span>
        <span>at ${h.maxLev}x MEXC max</span>
        <span>dipped ${h.dipPct.toFixed(2)}% first</span>
      </div>
      <div class="plan">
        <span>in <b>${when(h.entryTime)}</b> @ ${px(h.entry)}</span>
        ${h.peakTime ? `<span class="peaked">peak <b>${when(h.peakTime)}</b> @ ${px(h.peakPrice)}</span>` : ''}
        <span>out <b>${when(h.exitTime)}</b> @ ${px(h.exit)}</span>
        <span class="rr">out of a ${h.coilPct?.toFixed(1) ?? '—'}% coil</span>
      </div>`);
    n.onclick = () => watchFromCoil({ market: h.market, symbol: h.symbol }, h.interval);
    box.appendChild(n);
  }
}

// The list is market-wide, so a row is only useful if you can put it on the
// watchlist in one tap.
function watchFromCoil(r, interval) {
  if (r.watched) return;
  $('#tf').value = interval;
  addWatch({ market: r.market, symbol: r.symbol });
}

// ─────────── trade history ───────────
let histId = null;

async function openHistory(id) {
  const w = state.watches.find(x => x.id === id);
  if (!w) return;
  histId = id;
  $('#histTitle').textContent = `${w.symbol} ${w.interval}`;
  $('#histSub').innerHTML = w.maxLev ? `<span class="tag lev">${w.maxLev}x max</span>` : '';
  $('#histModal').classList.remove('hidden');
  loadHistory();
}

async function loadHistory() {
  if (!histId) return;
  const w = state.watches.find(x => x.id === histId);
  const limit = $('#histLimit').value, minVol = $('#histVol').value;
  const side = $('#histSide').value;
  // Date inputs are local days; the API works in epoch ms, so send the whole day.
  const from = $('#histFrom').value ? new Date($('#histFrom').value + 'T00:00:00').getTime() : '';
  const to = $('#histTo').value ? new Date($('#histTo').value + 'T23:59:59.999').getTime() : '';
  $('#histMeta').textContent = 'scanning history…';
  $('#histRows').innerHTML = '';
  $('#histStats').innerHTML = '';
  try {
    const d = await apiJson(`/api/history/${encodeURIComponent(histId)}`
      + `?limit=${limit}&minVol1h=${minVol}&side=${side}&from=${from}&to=${to}`);
    if (d.error) throw new Error(d.error);
    renderHistory(d, w?.maxLev);
  } catch (e) {
    $('#histMeta').textContent = 'could not load history: ' + e.message;
  }
}
$('#histLimit').onchange = loadHistory;
$('#histVol').onchange = loadHistory;
$('#histSide').onchange = loadHistory;
$('#histFrom').onchange = loadHistory;
$('#histTo').onchange = loadHistory;
$('#histClear').onclick = () => {
  $('#histFrom').value = '';
  $('#histTo').value = '';
  loadHistory();
};

function renderHistory(d, lev) {
  const s2 = d.stats, trades = d.rows;
  const sgn = v => (Number(v) >= 0 ? '+' : '') + v;
  $('#histStats').innerHTML = [
    ['Trades', String(s2.trades)],
    ['Win rate', s2.winRate.toFixed(0) + '%'],
    ['Total R', sgn(s2.totalR.toFixed(2)) + 'R'],
    ['Avg R', sgn(s2.avgR.toFixed(2)) + 'R'],
    ['Sum move', sgn(s2.totalPct.toFixed(1)) + '%'],
    ...(lev ? [[`At ${lev}x`, sgn((s2.totalPct * lev).toFixed(0)) + '%']] : [])
  ].map(([k, v]) => `<div class="hstat"><span>${k}</span><b class="${v.startsWith('-') ? 'down' : 'up'}">${v}</b></div>`).join('');

  const filt = $('#histVol').value;
  const side = $('#histSide').value;
  const day = ts => new Date(ts).toLocaleDateString([], { month: 'short', day: 'numeric' });
  const bits = [];
  if (filt > 0) bits.push(`1H range ≥ ${filt}%`);
  if (side) bits.push(side.toLowerCase() + ' only');
  if ($('#histFrom').value || $('#histTo').value) {
    bits.push(`${$('#histFrom').value || 'start'} → ${$('#histTo').value || 'now'}`);
  }
  $('#histMeta').innerHTML =
    `scanned ${d.barsScanned.toLocaleString()} candles · ${d.totalTrades} trades found` +
    (d.covers ? ` · covers ${day(d.covers.from)} – ${day(d.covers.to)}` : '') +
    (bits.length ? ` · <b>${d.matched}</b> match ${bits.join(' + ')}` : '') +
    ` · showing ${trades.length}`;

  // The window is limited by how many candles were fetched, so an empty result
  // for an older range is a scan-depth problem, not an absence of trades.
  const wantFrom = $('#histFrom').value ? new Date($('#histFrom').value + 'T00:00:00').getTime() : 0;
  if (d.covers && wantFrom && wantFrom < d.covers.from) {
    $('#histMeta').innerHTML +=
      `<br><span class="warn">History only reaches back to ${day(d.covers.from)} at this scan depth — raise “Show” for a deeper scan.</span>`;
  }

  // Keep the pickers inside what actually exists.
  if (d.covers) {
    const iso = ts => new Date(ts).toISOString().slice(0, 10);
    for (const el2 of [$('#histFrom'), $('#histTo')]) { el2.min = iso(d.covers.from); el2.max = iso(d.covers.to); }
  }

  const body = $('#histRows');
  body.innerHTML = '';
  if (!trades.length) {
    body.innerHTML = '<div class="hempty">No trades match that filter.</div>';
    return;
  }
  for (const t of trades) {
    const good = t.r >= 0;
    const when = new Date(t.exitTime).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    const levPnl = lev ? `<span class="hlev ${good ? 'up' : 'down'}">${t.pnlPct >= 0 ? '+' : ''}${(t.pnlPct * lev).toFixed(1)}% @${lev}x</span>` : '';
    const hit = `<span class="tgt ${t.tp1Hit ? 'on' : ''}">TP1</span><span class="tgt ${t.tp2Hit ? 'on' : ''}">TP2</span>` +
                `<span class="tgt ${t.r < 0 ? 'bad' : ''}">SL</span>` +
                (t.vol1h != null ? `<span class="volchip ${t.vol1h >= 3 ? 'hot' : ''}">1H ${t.vol1h.toFixed(1)}%</span>` : '');
    const peak = t.peakR > t.r + 0.05
      ? `<span class="hpeak">peaked +${t.peakR.toFixed(2)}R · gave back ${t.gaveBack.toFixed(2)}R</span>` : '';
    body.appendChild(el('div', 'hrow ' + (good ? 'win' : 'loss'), `
      <div class="hr1">
        <span class="hside ${t.side === 'LONG' ? 'up' : 'down'}">${t.side === 'LONG' ? '▲' : '▼'} ${t.side}</span>
        <span class="hreason">${t.reason}</span>
        <span class="hr ${good ? 'up' : 'down'}">${good ? '+' : ''}${t.r.toFixed(2)}R</span>
      </div>
      <div class="htgts">${hit}${peak}</div>
      <div class="hr2">
        <span>${fmtPx(t.entryPrice)} → ${fmtPx(t.exitPrice)}</span>
        <span class="${good ? 'up' : 'down'}">${t.pnlPct >= 0 ? '+' : ''}${t.pnlPct.toFixed(2)}%</span>
        ${levPnl}
      </div>
      <div class="hr3">
        <span>${when}</span>
        <span>${t.tpSource || ''}${t.tp1Filled ? ` · TP1 banked ${Math.round(t.tp1Portion * 100)}%` : ''}</span>
      </div>`));
  }
}
$('#histClose').onclick = () => { $('#histModal').classList.add('hidden'); histId = null; };
$('#histModal').onclick = e => { if (e.target.id === 'histModal') { $('#histModal').classList.add('hidden'); histId = null; } };

// ─────────── alerts in-page ───────────
function onAlert(entry) {
  prependLog(entry);
  const card = document.getElementById('c_' + cssId(entry.id));
  if (card) { card.classList.remove('pulse'); void card.offsetWidth; card.classList.add('pulse'); }
  if (entry.kind === 'ENTRY' || (entry.kind === 'EXIT' && entry.priority === 5)) playAlarm();
  else beep();
  if (Notification.permission === 'granted') {
    new Notification(entry.title, { body: entry.body, tag: entry.id + entry.kind, renotify: true });
  }
}
function renderLog(items = []) { $('#log').innerHTML = ''; items.forEach(i => $('#log').appendChild(logRow(i))); }
function prependLog(i) {
  const l = $('#log');
  l.prepend(logRow(i));
  while (l.children.length > 60) l.lastChild.remove();
}
function logRow(i) {
  return el('div', 'li ' + i.kind, `
    <span class="when">${ago(i.at)}</span>
    <span class="txt"><b>${i.title}</b><pre>${i.body}</pre></span>`);
}

// ─────────── volatility board ───────────
let volData = [], volSort = 'vol1d', volLookupRow = null, volTimer = null;

function volClass(v, tf) {
  // thresholds scaled per window — 1% on 5m is a lot, on 1D it's nothing
  const hot = { vol5m: 1.0, vol1h: 3.0, vol1d: 15 }[tf];
  const mid = { vol5m: 0.4, vol1h: 1.2, vol1d: 6 }[tf];
  if (v === null || v === undefined) return 'vlow';
  return v >= hot ? 'vhot' : v >= mid ? 'vmid' : 'vlow';
}
const vpct = v => v === null || v === undefined ? '—' : v.toFixed(2) + '%';

async function loadVol() {
  const market = $('#volMarket').value, limit = $('#volLimit').value;
  $('#volFoot').textContent = 'scanning…';
  try {
    const d = await apiJson(`/api/volatility?market=${market}&limit=${limit}`);
    if (d.error) throw new Error(d.error);
    volData = d.rows;
    renderVol();
  } catch (e) {
    $('#volFoot').textContent = 'scan failed: ' + e.message;
  }
}

function renderVol() {
  const box = $('#volRows');
  box.innerHTML = '';
  const rows = [...volData].sort((a, b) => (b[volSort] ?? -1) - (a[volSort] ?? -1));
  if (volLookupRow && !rows.some(r => r.symbol === volLookupRow.symbol)) box.appendChild(volRow(volLookupRow, true));
  for (const r of rows) box.appendChild(volRow(r, volLookupRow?.symbol === r.symbol));
  document.querySelectorAll('.volhdr .vnum').forEach(n => n.classList.toggle('active', n.dataset.k === volSort));
  const flat = volData.filter(r => r.pinned && r.vol1h !== null && r.vol1h < Number($('#lowVol1h')?.value || 1)).map(r => r.symbol);
  $('#volFoot').innerHTML =
    `<span>${rows.length} coins · updated ${new Date().toLocaleTimeString()}</span>` +
    `<span>${flat.length ? '😴 flat: ' + flat.join(', ') : 'click a row to watch it'}</span>`;
}

function volRow(r, isLookup) {
  const n = el('div', 'volrow body' + (r.pinned ? ' pin' : '') + (isLookup ? ' pinlookup' : ''),
    `<span class="vsym">${r.symbol}${r.pinned ? '<span class="star">⭐</span>' : ''}</span>
     <span class="vnum ${volClass(r.vol5m, 'vol5m')}">${vpct(r.vol5m)}</span>
     <span class="vnum ${volClass(r.vol1h, 'vol1h')}">${vpct(r.vol1h)}</span>
     <span class="vnum ${volClass(r.vol1d, 'vol1d')}">${vpct(r.vol1d)}</span>`);
  n.title = `24h volume $${(r.quoteVol / 1e6).toFixed(1)}M · change ${r.changePct?.toFixed(2)}%` +
            (r.avg5m != null ? ` · avg 5m move ${r.avg5m.toFixed(2)}%` : '');
  n.querySelector('.vsym').onclick = () => addWatch({ market: r.market, symbol: r.symbol });
  return n;
}

$('#volToggle').onclick = () => {
  const open = !$('#volBody').classList.toggle('hidden');
  $('#volToggle').classList.toggle('closed', !open);
  localStorage.setItem('volOpen', open ? '1' : '0');
  if (open) loadVol();
};
$('#volMarket').onchange = () => { volLookupRow = null; loadVol(); };
$('#volLimit').onchange = loadVol;
$('#volRefresh').onclick = loadVol;

let volSearchTimer;
$('#volSearch').addEventListener('input', e => {
  clearTimeout(volSearchTimer);
  const q = e.target.value.trim().toUpperCase();
  if (!q) { volLookupRow = null; renderVol(); return; }
  volSearchTimer = setTimeout(async () => {
    try {
      // Send the raw query — the server resolves partials, case and near-misses.
      const d = await apiJson(`/api/volatility/lookup?market=${$('#volMarket').value}&symbol=${encodeURIComponent(q)}`);
      if (d.error) { volLookupRow = null; $('#volFoot').textContent = d.error; renderVol(); return; }
      volLookupRow = { ...d, pinned: state.watches.some(w => w.symbol === d.symbol) };
      renderVol();
    } catch { /* keep last good board */ }
  }, 450);
});

document.querySelectorAll('.volhdr .vnum').forEach(n => {
  n.onclick = () => { volSort = n.dataset.k; renderVol(); };
});

function initVol() {
  const open = localStorage.getItem('volOpen') !== '0';
  $('#volBody').classList.toggle('hidden', !open);
  $('#volToggle').classList.toggle('closed', !open);
  if (open) loadVol();
  clearInterval(volTimer);
  volTimer = setInterval(() => { if (!$('#volBody').classList.contains('hidden')) loadVol(); }, 90000);
}

// ─────────── sound ───────────
function ensureAudio() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}
function tone(freq, dur, when = 0, gain = 0.22) {
  const c = ensureAudio();
  const o = c.createOscillator(), g = c.createGain();
  o.type = 'sine'; o.frequency.value = freq;
  g.gain.setValueAtTime(0, c.currentTime + when);
  g.gain.linearRampToValueAtTime(gain, c.currentTime + when + 0.015);
  g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + when + dur);
  o.connect(g).connect(c.destination);
  o.start(c.currentTime + when); o.stop(c.currentTime + when + dur + 0.05);
}
function beep() { if (soundOn) { tone(880, 0.12); tone(1180, 0.12, 0.14); } }
function playAlarm() {
  if (!soundOn) return;
  let n = 0;
  clearInterval(alarmTimer);
  const ring = () => { tone(1046, 0.18); tone(1318, 0.18, 0.2); tone(1568, 0.26, 0.4); };
  ring();
  alarmTimer = setInterval(() => { ring(); if (++n >= 5) clearInterval(alarmTimer); }, 800);
}
$('#soundBtn').onclick = () => {
  soundOn = !soundOn;
  if (soundOn) { ensureAudio(); tone(1046, 0.12); tone(1318, 0.14, 0.13); }
  else clearInterval(alarmTimer);
  $('#soundBtn').textContent = soundOn ? '🔊 Sound' : '🔇 Sound';
  $('#soundBtn').classList.toggle('on', soundOn);
  if (soundOn && Notification.permission === 'default') Notification.requestPermission();
};

// ─────────── web push ───────────
$('#pushBtn').onclick = async () => {
  if (!state.vapidPublic) return alert('Web push is not configured.\n\nRun `npm run keys`, paste VAPID_PUBLIC / VAPID_PRIVATE into .env, and restart.\n\nTelegram or ntfy work without this.');
  if (!('serviceWorker' in navigator)) return alert('This browser has no service worker support.');
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') return alert('Notification permission denied.');
  const reg = await navigator.serviceWorker.register('sw.js');
  await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlB64ToUint8(state.vapidPublic)
  });
  await api('/api/push/subscribe', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(sub)
  });
  $('#pushBtn').classList.add('on');
  $('#pushBtn').textContent = '📱 Push ✓';
};
function urlB64ToUint8(b64) {
  const pad = '='.repeat((4 - b64.length % 4) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
}

// ─────────── mute + test ───────────
$('#muteBtn').onclick = async () => {
  const muted = !state.settings.muted;
  await saveSettings({ muted });
};
function updateMuteBtn() {
  const m = state.settings.muted;
  $('#muteBtn').textContent = m ? '🔕 Muted' : '🔔 Live';
  $('#muteBtn').classList.toggle('danger', !!m);
}
$('#testBtn').onclick = async () => {
  const r = await api('/api/test-alert', { method: 'POST' });
  const d = await r.json();
  playAlarm();
  const on = Object.entries(d.channels).filter(([, v]) => v).map(([k]) => k);
  alert(on.length
    ? `Test sent via: ${on.join(', ')}\n\n${JSON.stringify(d.result, null, 1)}`
    : 'No phone channels configured yet.\n\nEasiest: create a Telegram bot with @BotFather, put TELEGRAM_TOKEN and TELEGRAM_CHAT_ID in .env, restart.');
};

// ─────────── settings ───────────
$('#cfgBtn').onclick = () => $('#modal').classList.remove('hidden');
$('#closeCfg').onclick = () => $('#modal').classList.add('hidden');
$('#modal').onclick = e => { if (e.target.id === 'modal') $('#modal').classList.add('hidden'); };

function collectIndicatorCfg() {
  const num = id => Number($('#c_' + id).value);
  const bool = id => $('#c_' + id).checked;
  return {
    emaFast: num('emaFast'), emaSlow: num('emaSlow'),
    rsiLen: num('rsiLen'), rsiOB: num('rsiOB'), rsiOS: num('rsiOS'),
    atrLen: num('atrLen'), rr1: num('rr1'), rr2: num('rr2'),
    slMode: $('#c_slMode').value, slLookback: num('slLookback'), slBuf: num('slBuf'),
    beAtR: num('beAtR'), trailAfterR: num('trailAfterR'), trailAtr: num('trailAtr'),
    useTrail: bool('useTrail'), tp1Portion: num('tp1Portion') / 100,
    runner: bool('runner'), noStop: bool('noStop'), autoCoverage: num('autoCoverage'),
    minVol1h: num('minVol1h'), minVol1d: num('minVol1d'), tp1AtR: num('tp1AtR'),
    minAdx: num('minAdx'), minEmaSep: num('minEmaSep'), maxRecentSignals: num('maxRecentSignals'),
    rsiPeakExit: bool('rsiPeakExit'), rsiPeakLong: num('rsiPeakLong'),
    rsiPeakShort: 100 - num('rsiPeakLong'), rsiPeakDrop: 5,
    tpMode: $('#c_tpMode').value, vpLen: num('vpLen'), vpRows: num('vpRows'),
    vaPct: num('vaPct'), hvnThr: num('hvnThr'), minTpAtr: num('minTpAtr'), fallbackRR: num('fallbackRR'),
    maxBars: num('maxBars'), requireVol: bool('requireVol'), useTrend: bool('useTrend'),
    useRevExit: bool('useRevExit'), beAfterTp1: bool('beAfterTp1'),
    preAlertPct: Number($('#preAlertPct').value), preAlertBars: Number($('#preAlertBars').value)
  };
}
function applySettingsToForm() {
  const s = { ...state.defaults, ...(state.settings.cfg || {}) };
  const set = (id, v) => { const n = $('#c_' + id); if (n) { if (n.type === 'checkbox') n.checked = !!v; else n.value = v; } };
  ['emaFast', 'emaSlow', 'rsiLen', 'rsiOB', 'rsiOS', 'atrLen', 'rr1', 'rr2', 'slLookback', 'slBuf', 'maxBars',
    'requireVol', 'useTrend', 'useRevExit', 'beAfterTp1', 'vpLen', 'vpRows', 'vaPct', 'hvnThr',
    'minTpAtr', 'fallbackRR', 'beAtR', 'trailAfterR', 'trailAtr', 'useTrail', 'runner', 'autoCoverage',
    'minVol1h', 'minVol1d', 'tp1AtR', 'noStop', 'minAdx', 'minEmaSep', 'maxRecentSignals',
    'rsiPeakExit', 'rsiPeakLong'].forEach(k => set(k, s[k]));
  set('tp1Portion', Math.round((s.tp1Portion ?? 0.5) * 100));
  $('#levOverride').value = Object.entries(state.settings.levOverride || {})
    .map(([k, v]) => `${k}=${v}`).join(', ');
  $('#c_tpMode').value = s.tpMode;
  $('#c_slMode').value = s.slMode;
  $('#preAlertPct').value = s.preAlertPct;
  $('#preAlertBars').value = s.preAlertBars;
  $('#preAlerts').checked = state.settings.preAlerts !== false;
  $('#exitAlerts').checked = state.settings.exitAlerts !== false;
  $('#lowVolAlerts').checked = state.settings.lowVolAlerts !== false;
  $('#lowVol1h').value = state.settings.lowVol1h ?? 1.0;
}
const PRESETS = {
  all:      { minAdx: 0,  minEmaSep: 0,    maxRecentSignals: 0 },
  balanced: { minAdx: 20, minEmaSep: 0,    maxRecentSignals: 0 },
  strict:   { minAdx: 20, minEmaSep: 0.20, maxRecentSignals: 0 },
  sniper:   { minAdx: 0,  minEmaSep: 0.25, maxRecentSignals: 0 }
};
$('#c_preset').onchange = e => {
  const p = PRESETS[e.target.value];
  if (!p) return;
  $('#c_minAdx').value = p.minAdx;
  $('#c_minEmaSep').value = p.minEmaSep;
  $('#c_maxRecentSignals').value = p.maxRecentSignals;
};

$('#saveCfg').onclick = async () => {
  await saveSettings({
    cfg: collectIndicatorCfg(),
    preAlerts: $('#preAlerts').checked,
    exitAlerts: $('#exitAlerts').checked,
    lowVolAlerts: $('#lowVolAlerts').checked,
    lowVol1h: Number($('#lowVol1h').value),
    levOverride: Object.fromEntries(($('#levOverride').value || '').split(',')
      .map(p => p.trim()).filter(Boolean)
      .map(p => p.split('=').map(x => x.trim()))
      .filter(([k, v]) => k && Number(v) > 0)
      .map(([k, v]) => [k.toUpperCase(), Number(v)]))
  });
  $('#modal').classList.add('hidden');
};
async function saveSettings(patch) {
  const r = await api('/api/settings', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch)
  });
  state.settings = await r.json();
  updateMuteBtn();
}
function renderChannels() {
  const c = state.channels;
  const rows = [
    ['Telegram', c.telegram, 'TELEGRAM_TOKEN + TELEGRAM_CHAT_ID in .env'],
    ['ntfy', c.ntfy, 'NTFY_TOPIC in .env + ntfy app on your phone'],
    ['Web push', c.webpush, 'npm run keys → VAPID_* in .env, then tap 📱 Push'],
    ['Forex data', state.forexEnabled, 'TWELVEDATA_KEY in .env']
  ];
  $('#channels').innerHTML = rows.map(([n, on, hint]) =>
    `<div class="ch"><span>${n}<br><span class="dim" style="font-size:11px">${on ? 'ready' : hint}</span></span>
     <span class="st ${on ? 'up' : 'dim'}">${on ? '● on' : '○ off'}</span></div>`).join('');
}

// refresh relative timestamps
setInterval(() => renderLogTimes(), 20000);
function renderLogTimes() {
  api('/api/log').then(r => r.json()).then(renderLog).catch(() => {});
}

connect();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
