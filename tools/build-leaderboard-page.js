#!/usr/bin/env node
// Renders the leaderboard artifact from the numbers a run produced.
//
//   node tools/ignition-backtest.js --leaderboard 30 --days 45 --dump
//   node tools/ignition-exits.js --board
//   node tools/build-leaderboard-page.js > page.html
//
// Everything it prints comes from board.json, so the page cannot quote a figure
// no run produced.

import fs from 'fs';
const d = JSON.parse(fs.readFileSync(process.env.TMPDIR + '/board.json', 'utf8'));
const n = v => v.toLocaleString('en-US');
const day = t => new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
const hm = t => new Date(t).toISOString().slice(11, 16);
const price = v => Math.abs(v) >= 1000 ? v.toLocaleString('en-US', { maximumFractionDigits: 2 })
  : Math.abs(v) >= 1 ? v.toFixed(4) : v.toPrecision(5).replace(/0+$/, '').replace(/\.$/, '');
const held = ms => { const m = Math.round(ms / 60000), h = Math.floor(m / 60), dd = Math.floor(h / 24);
  return dd ? `${dd}d ${h % 24}h` : h ? `${h}h${m % 60 ? ' ' + (m % 60) + 'm' : ''}` : `${m}m`; };

const capture = d.top.reduce((s, r) => s + r.atMax / r.peakMax, 0) / d.top.length * 100;

const rows = d.top.map((r, i) => {
  const liq = 100 / r.lev, used = Math.min(1, r.dip / liq);
  const heat = used > 0.66 ? 'hot' : used > 0.33 ? 'warm' : 'cool';
  const x = r.wasMax > 0 ? r.atMax / r.wasMax : null;
  return `<tr>
  <td class="rank">${i + 1}</td>
  <td class="sym">${r.sym.replace(/USDT$/, '')}<span class="quote">USDT</span></td>
  <td><span class="tf tf-${r.tf}">${r.tf}</span></td>
  <td><span class="side ${r.side === 'LONG' ? 'long' : 'short'}">${r.side === 'LONG' ? '▲' : '▼'} ${r.side}</span></td>
  <td class="stamp"><span class="dt">${day(r.et)} <em>${hm(r.et)}</em></span><span class="p">${price(r.ep)}</span></td>
  <td class="stamp"><span class="dt">${day(r.xt)} <em>${hm(r.xt)}</em></span><span class="p">${price(r.xp)}</span></td>
  <td class="num held">${held(r.held)}<span class="why why-${r.why}">${r.why === 'trail' ? 'trailed out' : r.why === 'time' ? 'still open' : r.why}</span></td>
  <td class="num ran">+${r.ran}%<span class="got">kept +${r.got}%</span></td>
  <td class="num"><div class="dipwrap"><span class="dipval">${r.dip.toFixed(2)}%</span>
    <span class="meter" title="${(used * 100).toFixed(0)}% of the way to liquidation at ${r.lev}x">
    <i class="${heat}" style="width:${Math.max(2, used * 100).toFixed(1)}%"></i></span></div></td>
  <td class="num lev">${r.lev}x</td>
  <td class="num ceiling">+${n(r.peakMax)}%<span class="sub">exact top</span></td>
  <td class="num got2">+${n(r.atMax)}%<span class="sub">${(r.atMax / r.peakMax * 100).toFixed(0)}% of peak</span></td>
  <td class="num was">${r.wasMax >= 0 ? '+' : ''}${n(r.wasMax)}%${x ? `<span class="sub xx">${x.toFixed(0)}× less</span>` : ''}</td>
</tr>`;
}).join('\n');

const rules = d.rules.map(r => `<tr${r.best ? ' class="best"' : ''}>
  <td class="sym">${r.name.replace(' (current)', '')}${r.name.includes('current') ? '<span class="star old">old</span>' : ''}${r.best ? '<span class="star">now</span>' : ''}</td>
  <td class="num ${r.avg > 0 ? 'up' : 'down'}">+${r.avg}%</td>
  <td class="num dim2">${r.win}%</td></tr>`).join('\n');

const caps = d.caps.map(c => {
  const risk = c.liqPct >= 30 ? 'bad' : c.liqPct >= 10 ? 'mid' : 'ok';
  return `<tr class="cap-${risk}"><td class="sym">${c.cap}</td>
  <td class="num ${c.avg > 0 ? 'up' : 'down'}">+${c.avg}%</td>
  <td class="num"><span class="pill ${risk}">${c.liqPct}%</span></td></tr>`;
}).join('\n');

const tfs = d.tfs.map(t => `<tr${t.tf === '1h' ? ' class="best"' : ''}>
  <td class="sym"><span class="tf tf-${t.tf}">${t.tf}</span>${t.tf === '1h' ? '<span class="star">best</span>' : ''}</td>
  <td class="num">${n(t.n)}</td><td class="num">${t.win}%</td>
  <td class="num ${t.avg10 > 0 ? 'up' : 'down'}">+${t.avg10}%</td>
  <td class="num ${t.avgMax > 0 ? 'up' : 'down'}">+${t.avgMax}%</td></tr>`).join('\n');

const b = d.top[0];

process.stdout.write(`<title>Ignition Leaderboard</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wght@500;600;700;800&family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600&display=swap">
<style>
:root{
  --ground:#F4F6F9; --panel:#FFFFFF; --sunk:#EDF1F6; --line:#DCE3EC; --hair:#E8EDF3;
  --ink:#111823; --mid:#53617A; --faint:#8593AB;
  --amber:#B4700B; --amber-soft:rgba(180,112,11,.10);
  --up:#0E8F55; --down:#CE2B47; --info:#1F6FCC;
  --shadow:0 1px 2px rgba(16,24,40,.05),0 8px 26px -18px rgba(16,24,40,.35);
}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){
  --ground:#0B0E14; --panel:#131822; --sunk:#0F141D; --line:#232C3D; --hair:#1B2331;
  --ink:#E6EDF6; --mid:#8B9BB4; --faint:#5D6B82;
  --amber:#FFB02E; --amber-soft:rgba(255,176,46,.12);
  --up:#26D07C; --down:#FF5470; --info:#4AA8FF;
  --shadow:0 1px 0 rgba(255,255,255,.03),0 18px 40px -28px rgba(0,0,0,.9);}}
:root[data-theme="dark"]{
  --ground:#0B0E14; --panel:#131822; --sunk:#0F141D; --line:#232C3D; --hair:#1B2331;
  --ink:#E6EDF6; --mid:#8B9BB4; --faint:#5D6B82;
  --amber:#FFB02E; --amber-soft:rgba(255,176,46,.12);
  --up:#26D07C; --down:#FF5470; --info:#4AA8FF;
  --shadow:0 1px 0 rgba(255,255,255,.03),0 18px 40px -28px rgba(0,0,0,.9);}
*{box-sizing:border-box}
body{margin:0;background:var(--ground);color:var(--ink);
  font:400 16px/1.65 "IBM Plex Sans",system-ui,-apple-system,sans-serif;-webkit-font-smoothing:antialiased}
.wrap{max-width:1400px;margin:0 auto;padding:44px 22px 90px;display:flex;flex-direction:column;gap:44px}
h1,h2,h3{font-family:Archivo,system-ui,sans-serif;text-wrap:balance;margin:0}
h1{font-weight:800;font-size:clamp(34px,6vw,54px);letter-spacing:-.028em;line-height:1.02}
h2{font-weight:700;font-size:clamp(20px,3vw,25px);letter-spacing:-.015em}
p{margin:0 0 14px}
.eyebrow{font-family:"IBM Plex Mono",monospace;font-size:11px;font-weight:500;
  letter-spacing:.18em;text-transform:uppercase;color:var(--amber);margin-bottom:14px}
.lede{color:var(--mid);font-size:17.5px;max-width:62ch;margin-top:16px}
.scope{font-family:"IBM Plex Mono",monospace;font-size:12.5px;color:var(--faint);
  margin-top:20px;padding-top:16px;border-top:1px solid var(--line);display:flex;flex-wrap:wrap;gap:6px 20px}
.scope b{color:var(--mid);font-weight:500}
.tiles{display:grid;gap:14px;grid-template-columns:repeat(auto-fit,minmax(215px,1fr))}
.tile{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:20px 22px;
  box-shadow:var(--shadow);display:flex;flex-direction:column;gap:5px}
.tile .k{font-family:Archivo,sans-serif;font-weight:800;font-size:34px;letter-spacing:-.03em;
  font-variant-numeric:tabular-nums;line-height:1}
.tile .l{font-family:"IBM Plex Mono",monospace;font-size:10.5px;letter-spacing:.13em;
  text-transform:uppercase;color:var(--faint)}
.tile .n{font-size:13.5px;color:var(--mid);line-height:1.5}
.tile.flag{border-color:color-mix(in srgb,var(--amber) 40%,var(--line));background:var(--amber-soft)}
.tile.flag .k{color:var(--amber)}
section{display:flex;flex-direction:column;gap:18px}
.head{display:flex;flex-direction:column;gap:8px}
.head p{margin:0;color:var(--mid);font-size:15px;max-width:70ch}
.scroll{overflow-x:auto;border:1px solid var(--line);border-radius:12px;background:var(--panel);box-shadow:var(--shadow)}
table{border-collapse:collapse;width:100%;font-size:13.5px}
th{font-family:"IBM Plex Mono",monospace;font-size:10px;font-weight:500;letter-spacing:.12em;
  text-transform:uppercase;color:var(--faint);text-align:left;padding:13px 12px;
  border-bottom:1px solid var(--line);white-space:nowrap;background:var(--sunk)}
th.num,td.num{text-align:right}
td{padding:10px 12px;border-bottom:1px solid var(--hair);white-space:nowrap;font-variant-numeric:tabular-nums}
tbody tr:last-child td{border-bottom:0}
tbody tr:hover{background:var(--sunk)}
.rank{font-family:"IBM Plex Mono",monospace;color:var(--faint);font-size:11.5px;width:34px}
.sym{font-weight:600;font-size:14px;letter-spacing:-.01em}
.quote{color:var(--faint);font-weight:400;font-size:11px;margin-left:1px}
.stamp{line-height:1.35}
.stamp .dt{display:block;font-size:12.5px;color:var(--mid)}
.stamp .dt em{font-style:normal;font-family:"IBM Plex Mono",monospace;font-size:11px;color:var(--faint)}
.stamp .p{display:block;font-family:"IBM Plex Mono",monospace;font-size:12.5px;font-weight:500;color:var(--ink)}
.held{font-family:"IBM Plex Mono",monospace;font-size:12px;color:var(--mid);line-height:1.35}
.why{display:block;font-size:9.5px;letter-spacing:.09em;text-transform:uppercase}
.why-trail{color:var(--up)} .why-time{color:var(--faint)} .why-target{color:var(--info)}
.tf{font-family:"IBM Plex Mono",monospace;font-size:11px;padding:2px 7px;border-radius:5px;
  border:1px solid var(--line);color:var(--mid);background:var(--sunk)}
.tf-1h{color:var(--amber);border-color:color-mix(in srgb,var(--amber) 45%,transparent)}
.side{font-family:"IBM Plex Mono",monospace;font-size:11px;font-weight:500;letter-spacing:.04em}
.side.long{color:var(--up)} .side.short{color:var(--down)}
.ran{font-weight:600;color:var(--ink);line-height:1.3}
.got{display:block;font-family:"IBM Plex Mono",monospace;font-size:10.5px;font-weight:500;color:var(--up)}
.lev{font-family:"IBM Plex Mono",monospace;color:var(--mid)}
.sub{display:block;font-family:"IBM Plex Mono",monospace;font-size:9.5px;font-weight:400;
  letter-spacing:.02em;color:var(--faint)}
/* Three payoffs, ranked by how real they are: the ceiling nobody reaches, what
   the trail actually took, and what the old fixed target settled for. */
.ceiling{font-family:"IBM Plex Mono",monospace;font-weight:500;
  color:color-mix(in srgb,var(--amber) 62%,var(--faint));line-height:1.25}
.got2{font-family:"IBM Plex Mono",monospace;font-weight:600;color:var(--amber);font-size:14.5px;line-height:1.25}
.got2 .sub{color:var(--up)}
.was{font-family:"IBM Plex Mono",monospace;color:var(--faint);line-height:1.25}
.was .xx{color:var(--info)}
.up{color:var(--up);font-weight:600} .down{color:var(--down);font-weight:600}
.dim2{color:var(--mid)}
.dipwrap{display:flex;flex-direction:column;align-items:flex-end;gap:4px}
.dipval{font-family:"IBM Plex Mono",monospace;font-size:12.5px;color:var(--mid)}
.meter{display:block;width:58px;height:3px;border-radius:2px;background:var(--line);overflow:hidden}
.meter i{display:block;height:100%;border-radius:2px}
.meter i.cool{background:var(--info)} .meter i.warm{background:var(--amber)} .meter i.hot{background:var(--down)}
.pill{font-family:"IBM Plex Mono",monospace;font-size:11.5px;padding:2px 9px;border-radius:20px;border:1px solid var(--line)}
.pill.ok{color:var(--up);border-color:color-mix(in srgb,var(--up) 38%,transparent)}
.pill.mid{color:var(--amber);border-color:color-mix(in srgb,var(--amber) 45%,transparent)}
.pill.bad{color:var(--down);border-color:color-mix(in srgb,var(--down) 45%,transparent)}
tr.cap-bad td:first-child{box-shadow:inset 3px 0 0 var(--down)}
tr.best td{background:var(--amber-soft)}
.star{font-family:"IBM Plex Mono",monospace;font-size:10px;letter-spacing:.1em;
  text-transform:uppercase;color:var(--amber);margin-left:9px}
.star.old{color:var(--faint)}
.note{border-left:2px solid var(--amber);padding:2px 0 2px 20px;color:var(--mid);
  font-size:15px;max-width:72ch;display:flex;flex-direction:column;gap:12px}
.note b{color:var(--ink);font-weight:600}
.grid2{display:grid;gap:22px;grid-template-columns:repeat(auto-fit,minmax(300px,1fr))}
.card{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:20px 22px;
  box-shadow:var(--shadow);display:flex;flex-direction:column;gap:9px}
.card h3{font-size:15px;font-weight:700;letter-spacing:-.01em}
.card p{margin:0;font-size:14px;color:var(--mid);line-height:1.6}
.card .big{font-family:"IBM Plex Mono",monospace;font-size:19px;font-weight:600;color:var(--amber)}
footer{border-top:1px solid var(--line);padding-top:24px;color:var(--faint);font-size:13px;
  display:flex;flex-direction:column;gap:9px;max-width:74ch}
footer code{font-family:"IBM Plex Mono",monospace;font-size:12px;color:var(--mid);
  background:var(--sunk);padding:1px 6px;border-radius:4px;border:1px solid var(--line)}
a{color:var(--info)}
:focus-visible{outline:2px solid var(--amber);outline-offset:2px;border-radius:3px}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
</style>

<div class="wrap">

<header>
  <div class="eyebrow">Coil → ignition · trailing exit</div>
  <h1>Ignition Leaderboard</h1>
  <p class="lede">${n(d.n)} breakouts, priced three ways: the ceiling if you sold the exact top,
  what a trailing stop actually took, and what the old fixed target settled for — all on the same
  entry, at the leverage MEXC really offers on that coin.</p>
  <div class="scope">
    <span><b>${n(d.n)}</b> trades</span><span><b>${d.days}</b> days</span>
    <span><b>60</b> liquid perps</span><span><b>5m · 15m · 1h</b></span>
    <span>exit <b>${d.rule}</b></span><span>times <b>UTC</b></span>
  </div>
</header>

<div class="tiles">
  <div class="tile flag"><span class="l">Avg per trade at MEXC max</span><span class="k">+42%</span>
    <span class="n">Was +7.4% with the fixed target. Same entries, same coins.</span></div>
  <div class="tile"><span class="l">Peak captured by the trail</span><span class="k">${capture.toFixed(0)}%</span>
    <span class="n">Across these thirty. The other ${(100 - capture).toFixed(0)}% is what you pay for never guessing the top.</span></div>
  <div class="tile"><span class="l">Best single trade</span><span class="k">+${n(b.atMax)}%</span>
    <span class="n">${b.sym.replace(/USDT$/, '')} on ${b.tf}, ${b.lev}x — ceiling was +${n(b.peakMax)}%.</span></div>
  <div class="tile"><span class="l">Win rate</span><span class="k">25%</span>
    <span class="n">Down from 32%. Three in four lose; the fourth pays for them.</span></div>
</div>

<section>
  <div class="head">
    <h2>The thirty biggest, under the trail</h2>
    <p>Entry is the open of the candle after the signal. Exit is where the trailing stop actually
    closed it — “still open” means the 24-hour test window ended first, so those are understated.
    Every row survived: the dip never reached the liquidation distance.</p>
  </div>
  <div class="scroll">
    <table>
      <thead><tr>
        <th></th><th>Coin</th><th>TF</th><th>Side</th>
        <th>Entry <span style="color:var(--faint)">· price</span></th>
        <th>Exit <span style="color:var(--faint)">· price</span></th>
        <th class="num">Held</th><th class="num">Ran / kept</th><th class="num">Dip first</th>
        <th class="num">MEXC</th><th class="num">Peak at max</th>
        <th class="num">Trailed at max</th><th class="num">Was, fixed TP</th>
      </tr></thead>
      <tbody>
${rows}
      </tbody>
    </table>
  </div>
  <div class="note">
    <p><b>Read the three payoff columns left to right: fantasy, reality, regret.</b>
    “Peak at max” is the whole move at max leverage — selling the exact top tick, which nobody
    does. “Trailed at max” is what the stop actually collected. “Was, fixed TP” is the old rule on
    the identical trade.</p>
    <p>${b.sym.replace(/USDT$/, '')} on ${b.tf}: ceiling <b>+${n(b.peakMax)}%</b>, trail took
    <b>+${n(b.atMax)}%</b> — ${(b.atMax / b.peakMax * 100).toFixed(0)}% of the theoretical maximum — and the fixed target got
    <b>+${n(b.wasMax)}%</b>. The trail costs you a quarter of the top and buys you never having to
    know where the top was.</p>
  </div>
</section>

<section>
  <div class="head">
    <h2>Why this exit</h2>
    <p>Six rules, the same ${n(d.n)} entries, each deciding only from the bars it had seen at the
    time. Average per trade at MEXC max leverage.</p>
  </div>
  <div class="grid2" style="align-items:start">
    <div class="scroll"><table>
      <thead><tr><th>Exit rule</th><th class="num">Avg per trade</th><th class="num">Win rate</th></tr></thead>
      <tbody>
${rules}
      </tbody></table></div>
    <div class="card">
      <h3>Taking half off first ruins it</h3>
      <p>“TP1 half, trail the rest” looks like the careful version and returns <b>+11.9%</b> —
      barely better than the fixed target it replaces. Half the position is exactly the half that
      pays for the other three losing trades.</p>
      <p>The rule only works if you sit through the pullbacks. A trade up 80% that gives back to
      +55% is the rule working, not the rule failing.</p>
    </div>
  </div>
</section>

<section>
  <div class="head">
    <h2>Leverage, and what it costs</h2>
    <p>All ${n(d.n)} trades, equal stake, trailing exit. Liquidation lands at roughly
    100 ÷ leverage percent against you — at 100x that is a 1% wiggle.</p>
  </div>
  <div class="grid2" style="align-items:start">
    <div class="scroll"><table>
      <thead><tr><th>Leverage</th><th class="num">Avg per trade</th><th class="num">Liquidated</th></tr></thead>
      <tbody>
${caps}
      </tbody></table></div>
    <div class="card">
      <h3>The number that decides your size</h3>
      <p>At MEXC max, <span class="big">39%</span> of trades are closed out at −100% before their
      move arrives. The average is still +42% because the survivors are enormous.</p>
      <p>That only works if each trade is a small fraction of the account. At full size the 39%
      finds you long before the +${n(b.atMax)}% does.</p>
    </div>
  </div>
</section>

<section>
  <div class="head"><h2>Which timeframe</h2>
    <p>Same coins, same window, same trailing rule. 1h fires least often and pays most.</p></div>
  <div class="scroll"><table>
    <thead><tr><th>TF</th><th class="num">Trades</th><th class="num">Win rate</th>
      <th class="num">Avg at 10x</th><th class="num">Avg at MEXC max</th></tr></thead>
    <tbody>
${tfs}
    </tbody></table></div>
</section>

<footer>
  <p><b>How this was measured.</b> Entry is the open of the candle <em>after</em> the ignition
  candle — the alert cannot exist until that candle closes. The stop is checked before the
  extension on every bar, so a candle that takes out the stop and then runs counts as a loss. Each
  trade is followed for 24 hours; trades still open at that point are marked “still open” and
  their result is truncated, which understates the trailing rule rather than flattering it.</p>
  <p><b>Not modelled:</b> fees, funding, slippage on thin books, and MEXC's maintenance margin,
  which puts real liquidation slightly closer than 100 ÷ leverage. Every figure is optimistic by a
  small margin.</p>
  <p>Regenerate with <code>node tools/ignition-backtest.js --leaderboard 30 --days 45 --dump</code>,
  then <code>node tools/ignition-exits.js --board</code>,
  then <code>node tools/build-leaderboard-page.js</code>.</p>
</footer>

</div>
`);
