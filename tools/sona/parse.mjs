// Rule-based reader for Sona's posts (no AI). Turns one post into paper
// actions, or — when it can't be sure — a question for the user with tap
// options. Built from a year of her messages (Roman Urdu + English).
//
// Which trade a post is about (user rule, 27 Sep 2026): the coin named in
// the text → the MEXC card / chart in the same post → the post it replies to
// → the image or message just before it. Ask only if all of those fail.

// Coins she writes by name (from her year of posts). Anything written as
// "xxxusdt" or shown on a MEXC card counts too.
const NAMED = ['btc', 'bitcoin', 'eth', 'ethereum', 'sol', 'solana', 'xrp', 'tao', 'link', 'sui', 'brett', 'aster', 'ena', 'aave', 'spx', 'doge',
  'near', 'ltc', 'fet', 'avax', 'moodeng', 'dot', 'dia', 'zec', 'eigen', 'ada', 'fartcoin', 'uni', 'hype', 'wld', 'ondo', 'bnb', 'pepe', 'wif',
  'trx', 'op', 'arb', 'apt', 'inj', 'sei', 'tia', 'jup', 'pengu', 'bonk', 'trump', 'xlm', 'hbar', 'ton', 'kas', 'render', 'pol', 'atom', 'fil',
  'icp', 'etc', 'bch', 'xmr', 'crv', 'ldo', 'pendle', 'ena', 'jto', 'pyth', 'strk', 'zk', 'ordi', 'sats', 'virtual', 'ai16z', 'kaito', 'coai', 'sqd', 'xpl'];
const ALIAS = { bitcoin: 'BTC', ethereum: 'ETH', solana: 'SOL' };
const WORD = new Set(NAMED);

const NOISE = /(my personal trades|not (financial|investment) advice|financial advice|pretending to be me|must read|paid group|profit sharing|referral|shareCode|whatsapp\.com|join and unmute|unmute bell|campaign|giveaway|not responsible for your losses|dyor|18\+)/i;
const FUTURE = /(will (update|let (u|you) know|share|dca)|update (karungi|kerugi|kardugi)|bataou?gi|batau?ngi|will tell|baad mai|later)/i;

const INTENT = {
  // she entered herself
  took: /(trade (li|le li|lee|ki|kerli|kar ?li|kr ?li|liya|lia|taken)\b|i have taken|i took|personally took|took (this|the|a) trade|have (entered|taken)|my (next )?shot|my trade|\bentered\b|re-?entered|re-?entering|i am re-?enter|(i have |i )risked|risk (liya|lia|le liya)|re-?entry (li|ki|kerli|kar ?li|done|kerhi|karhi|kar rahi|ker rahi|le rahi|lerahi)|first entry (ki|kerli|kar ?li|li|done|hogai|ho gai|le li)|entry (li|le li|ki|kerli|done|hogai)|position (li|open)|here we go|going (long|short)|taking (long|short|risk|this trade|trade)|risking (long|short)?|longed|shorted|opened (a )?(long|short)|i am (long|short|longing|shorting)|have (placed|secured)|placed .{0,20}order)\b/i,
  // she tells followers to enter
  advice: /(re-?entry (valid|kersakhty|kar ?sakt|le ?sakht)|(re-?entry|entry)\b.{0,25}\b(is |hai )?valid|valid (entry|hai|reentry)|entry (le ?sakht|lesakht|ker ?sakht|kar ?sakt)|can (take|do) (first )?entry|can (long|short|buy|sell)|first entry (ker|kar|le) ?sakht|ap (bhi |b )?(entry|long|short)|buy(ing)? (zone|range|long)|long setup|short setup|trade idea|setup:)\b/i,
  add: /(cost ?av|\bdca\b|second entry|2nd entry|second buying|add(ed|ing)? (more|margin|rest)|averag)/i,
  slEntry: /(sl|stop ?loss|stoploss) ?(to )?(entry|breakeven|be\b)|sl entry|breakeven/i,
  half: /((50|half|aadha|adha) ?%? ?(book|booking))|(book (50|half)|half book|partial book)/i,
  close: /(book (kerlo|kar ?lo|kardo|kerdo|kerlena|karlena|kerli|kar ?li|kerlia|kiya|kia|kr ?lo|kerle|now|profit|kr ?li)|\bbooked\b|close (kerdo|kardo|kerlo|kar ?do|it|trade|position)|\bclosed\b|exit (kerlo|now|kardo)|no regrets book)/i,
  canBook: /book ker ?sakht|book kar ?sakt|book kersakhty/i,
  cancel: /(entry mat (lo|lena|lein)|dont (take|enter)|don't (take|enter)|invalid|cancel (kerdo|kardo|it|order)|not taking)/i
};

const num = s => {
  let t = s.replace(/,/g, '').trim().toLowerCase();
  const k = t.endsWith('k'); if (k) t = t.slice(0, -1);
  const v = parseFloat(t);
  return isNaN(v) ? null : k ? v * 1000 : v;
};
// numbers in a clause, skipping % and leverage ("0.5%", "200x") and times ("6:51")
function numbers(clause) {
  const out = [];
  const re = /(\d[\d,]*\.?\d*k?)(\s*%|\s*x\b|:\d)?/gi;
  let m;
  while ((m = re.exec(clause))) { if (m[2]) continue; const v = num(m[1]); if (v != null) out.push(v); }
  return out;
}

export function coinsIn(text) {
  const t = text.toLowerCase().replace(/<[^>]+>/g, ' ');
  const out = new Set();
  for (const m of t.matchAll(/\b([a-z0-9]{2,12})\s*[_/-]?usdt\b/g)) out.add(m[1].toUpperCase());
  for (const w of t.match(/[a-z0-9]+/g) || []) if (WORD.has(w)) out.add(ALIAS[w] || w.toUpperCase());
  return [...out];
}

// MEXC share card (OCR text): coin, side, leverage, entry, and whether it shows a close
export function readCard(ocr) {
  if (!ocr) return null;
  const m = /([A-Z0-9]{2,15})\s*USDT\s*(Perpetual|Perp)/i.exec(ocr);
  if (!m) return null;
  const side = /\bshort\b/i.test(ocr) ? 'S' : /\blong\b/i.test(ocr) ? 'L' : null;
  const lev = +(/(\d{1,3})\s*[xX]\b/.exec(ocr)?.[1] || 0) || null;
  // "Entry Price | Fair Price | $1.579 | $1.5781" or "Entry Price $1.579"
  const after = ocr.slice(ocr.search(/entry\s*price/i) >= 0 ? ocr.search(/entry\s*price/i) : 0);
  const entry = num((/\$\s*([\d,]+\.?\d*)/.exec(after) || [])[1] || '');
  const closed = /(close|closing|exit)\s*price/i.test(ocr);
  const roi = +((/([+-]\s*[\d.]+)\s*%/.exec(ocr) || [])[1]?.replace(/\s/g, '') ?? NaN);
  return { coin: m[1].toUpperCase(), side, lev, entry, closed, roi: isNaN(roi) ? null : roi };
}

// Split into clauses and pull out her levels.
function levels(text) {
  const L = { e1: [], e2: [], sl: [], tp: [], margin: null, cmp: /\bcmp\b|market price|abi (le|li)|yahin|ider se|here at/i.test(text) };
  const mg = /(\d+(\.\d+)?)\s*%\s*(se|sey|ki|margin|with|first|second)/i.exec(text) || /margin\s*(\d+(\.\d+)?)\s*%/i.exec(text);
  if (mg) L.margin = +mg[1];
  for (const raw of text.split(/\n|\. |;|\|/)) {
    const c = raw.toLowerCase();
    if (/liq|liquidation|margin|roi|%\s*(se|sey)|points?\b|pts\b/.test(c) && !/(entry|sl|stop|tp)/.test(c)) continue;
    const clean = c.replace(/liq(uidation)?[^.\n]*?(\d[\d,.k]*\s*(-\s*\d[\d,.k]*)?)/g, ' ');   // drop "liq below 30,000"
    const ns = numbers(clean);
    if (!ns.length) continue;
    if (/\b(sl|stop ?loss|stoploss|invalidation)\b/.test(clean) && !INTENT.slEntry.test(clean)) L.sl.push(...ns.slice(0, 2));
    else if (/\btps?\b|target/.test(clean)) L.tp.push(...ns);
    else if (/(second|2nd) (entry|buying)|\bdca\b|cost ?av/.test(clean)) L.e2.push(...ns.slice(0, 2));
    else if (/(first|1st) (entry|buying)|entry|buying (zone|range)|\bzone\b|buy|long|short|cmp/.test(clean)) L.e1.push(...ns.slice(0, 2));
  }
  return L;
}

// post: {id, text, ocr, reply, img} · ctx: earlier posts (oldest first) · open: our open positions
// px(coin) → current price or null (used to sanity-check numbers)
export function readPost(post, ctx, open, px = () => null, hints = {}) {
  const text = (post.text || '').replace(/<[^>]+>/g, ' ').replace(/&apos;/g, "'").trim();
  const card = readCard(post.ocr);
  const res = { actions: [], question: '', options: [], summary: '' };
  if (!text && !card) return res;
  if (NOISE.test(text) && !INTENT.took.test(text)) return res;

  // ── which coin ──
  let coin = hints.coin || null, how = hints.coin ? 'you told me' : '';
  const inText = coinsIn(text);
  if (!coin && inText.length === 1) { coin = inText[0]; how = 'named in her message'; }
  if (!coin && card) { coin = card.coin; how = 'from the MEXC card in the post'; }
  const byId = id => ctx.find(p => p.id === id);
  if (!coin && post.reply) {
    const r = byId(post.reply);
    const c = r && (coinsIn(r.text || '')[0] || readCard(r.ocr)?.coin);
    if (c) { coin = c; how = `from the post she replied to (#${post.reply})`; }
  }
  if (!coin) {
    for (const p of [...ctx].reverse().slice(0, 3)) {
      const c = readCard(p.ocr)?.coin || (coinsIn(p.text || '').length === 1 ? coinsIn(p.text || '')[0] : null);
      if (c) { coin = c; how = `from her post just before (#${p.id})`; break; }
    }
  }
  const multi = inText.length > 1 && !hints.coin;

  // ── what she means ──
  const lv = levels(text);
  const now_ = text.replace(/\b(li|ki|kerli|kari|lia|liya)\s+(thi|thay|the)\b/gi, ' ');
  const has = k => INTENT[k].test(now_);
  const tookIt = has('took'), advice = has('advice'), future = FUTURE.test(text);
  const chatty = text.length > 260 && !(lv.e1.length && lv.sl.length);     // long talk, not a trade post
  const pos = coin ? open.filter(p => p.coin === coin) : [];
  // levels decide first (stop under the entry = long), then her words — "short term" is not a short
  const words = text.replace(/short[\s-]*term|long[\s-]*term|shortly|long time/gi, ' ');
  let side = hints.side || null;
  if (!side && lv.e1.length && lv.sl.length) side = lv.sl[0] < Math.max(...lv.e1) ? 'L' : 'S';
  side ||= /\bshort|\bsell\b|shorting/i.test(words) ? 'S' : /\blong\b|\bbuy(ing)?\b|longing/i.test(words) ? 'L' : card?.side || pos[0]?.side || null;

  // sanity: keep only numbers within ±40% of the coin's price
  const p0 = coin ? px(coin) : null;
  const ok = v => !p0 || (v > p0 * 0.6 && v < p0 * 1.4);
  for (const k of ['e1', 'e2', 'sl', 'tp']) lv[k] = lv[k].filter(ok);
  const L = side === 'L';
  const e1 = lv.e1.length ? (L ? Math.max(...lv.e1) : Math.min(...lv.e1)) : card && !card.closed ? card.entry : null;
  let e2 = lv.e2.length ? (L ? Math.min(...lv.e2) : Math.max(...lv.e2)) : lv.e1.length > 1 ? (L ? Math.min(...lv.e1) : Math.max(...lv.e1)) : null;
  if (e2 != null && e1 != null && Math.abs(e2 - e1) / e1 < 0.001) e2 = null;
  const sl = lv.sl.length ? (L ? Math.min(...lv.sl) : Math.max(...lv.sl)) : null;
  const tps = [...new Set(lv.tp)].sort((a, b) => L ? a - b : b - a);
  const act = (type, extra = {}) => ({ type, coin, side: side === 'L' ? 'LONG' : side === 'S' ? 'SHORT' : '', entry1: null, entry2: null, sl: null, tps: [], margin_pct: lv.margin, leverage: card?.lev ?? null, position_id: pos[0]?.id || '', from_post: post.id, ...extra });

  // 1. managing a trade we hold
  if (pos.length && !(tookIt && !pos.some(p => p.side === side))) {
    if (has('half') || (has('canBook') && !has('close'))) { res.actions.push(act('book_half')); res.summary = `${coin}: she says half book → booking 50%, stop to entry`; return res; }
    if (has('close') || (card?.closed && card.coin === coin)) { res.actions.push(act('close')); res.summary = `${coin}: she booked it → closing`; return res; }
    if (has('slEntry')) { res.actions.push(act('sl_to_entry')); res.summary = `${coin}: SL to entry`; return res; }
    if (has('cancel')) { res.actions.push(act('cancel_orders')); res.summary = `${coin}: she cancelled the setup`; return res; }
    const out = [];
    if (sl != null && !future) out.push(act('set_sl', { sl }));
    if (has('add') && !future && (lv.e2.length || lv.e1.length || lv.cmp)) out.push(act('add_entry', { entry1: lv.cmp && !lv.e2.length ? null : (e2 ?? e1) }));
    else if (tookIt && !chatty) out.push(act('add_entry', { entry1: lv.cmp ? null : card?.entry ?? null }));
    if (tps.length) out.push(act('set_tp', { tps }));
    if (out.length) { res.actions = out; res.summary = `${coin}: update — ${out.map(a => a.type.replace('_', ' ')).join(', ')}`; return res; }
    if (card && card.coin === coin) return res;                  // a screenshot of the trade we hold
  }

  // 2. a new trade
  const plan = lv.e1.length && lv.sl.length;
  const wantsOpen = tookIt || advice || plan;
  if (!wantsOpen) {
    // a bare MEXC card of a coin we don't hold: could be a new trade or a brag — ask
    const manage = has('half') || has('close') || has('slEntry') || has('canBook');
    if (!manage && card && !card.closed && !open.some(p => p.coin === card.coin) && (!text || text.length < 60) && (card.roi == null || Math.abs(card.roi) < 30)) {
      res.question = `She posted a ${card.coin} ${card.side === 'S' ? 'SHORT' : 'LONG'} card${card.entry ? ` (entry ${card.entry})` : ''}${card.roi != null ? `, showing ${card.roi}%` : ''}${text ? ` with "${text.slice(0, 60)}"` : ' with no text'}. New trade to copy, or just a screenshot?`;
      res.options = [{ label: `Copy ${card.coin} ${card.side === 'S' ? 'SHORT' : 'LONG'}`, actions: [{ ...act('open', { coin: card.coin, side: card.side === 'S' ? 'SHORT' : 'LONG', entry1: null }) }] }];
    }
    return res;
  }
  if (multi && !plan) { res.question = `She mentioned ${inText.join(', ')} — which one did she trade?`; res.options = inText.map(c => ({ label: c, hint: { coin: c } })); return res; }
  if (multi && plan) {
    // several coins with levels in one post: a line naming a coin starts its block
    const blocks = [];
    for (const line of text.split('\n')) {
      const cs = coinsIn(line);
      if (cs.length === 1 && (line.trim().length <= 30 || /^\W*[a-z0-9]{2,12}\s*(usdt)?\s*[:\-]/i.test(line))) blocks.push({ coin: cs[0], text: line });
      else if (blocks.length) blocks.at(-1).text += '\n' + line;
    }
    const out = [];
    for (const b of blocks) {
      const r = readPost({ ...post, text: b.text, ocr: '', reply: null }, [], open, px, { ...hints, coin: b.coin });
      out.push(...r.actions.filter(a => a.type !== 'open' || (a.entry1 != null && a.sl != null)));   // a plan line needs its levels
    }
    if (out.length) { res.actions = out; res.summary = `plans for ${out.map(a => a.coin).join(', ')}`; return res; }
  }
  if (chatty && !card) {
    res.question = `Long message — is this a new trade${coin ? ` on ${coin}` : ''}?\n"${text.slice(0, 220)}…"`;
    res.options = coin && side ? [{ label: `Copy ${coin} ${side === 'L' ? 'LONG' : 'SHORT'} at market`, actions: [act('open', { entry1: null, sl })] }] : [];
    return res;
  }
  if (!coin) { res.question = `She posted a trade but I can't tell the coin:\n"${text.slice(0, 200)}"`; res.options = []; return res; }
  if (!side) { res.question = `${coin}: is her trade LONG or SHORT?`; res.options = [{ label: `${coin} LONG`, hint: { coin, side: 'L' } }, { label: `${coin} SHORT`, hint: { coin, side: 'S' } }]; return res; }
  if (open.some(p => p.coin === coin && p.side === side) && !lv.e1.length && !lv.e2.length && !card?.entry) return res;
  const entry1 = lv.cmp || (!lv.e1.length && tookIt && !card?.entry) ? null : e1;
  res.actions.push(act('open', { entry1, entry2: e2, sl, tps }));
  res.summary = `${coin} ${L ? 'LONG' : 'SHORT'} — ${tookIt ? 'she entered' : 'her setup'} (coin ${how})${entry1 != null ? `, entry ${entry1}` : ', at market'}${e2 != null ? `, DCA ${e2}` : ''}${sl != null ? `, SL ${sl}` : ', SL not given yet'}`;
  return res;
}

// What the user types back on Telegram:
//   "xrp" / "long" / "xrp short"          → fill in what was missing and re-read her post
//   "open xrp long 1.53 sl 1.49 dca 1.5"  → exactly that
//   "close xrp" · "half xrp" · "be xrp" · "sl xrp 1.45" · "skip" · "status"
export function readUser(t) {
  const s = t.trim().toLowerCase();
  if (/^(skip|ignore|no|nahi|chor)/.test(s)) return { skip: true };
  if (/^\/?status$/.test(s)) return { status: true };
  const coin = coinsIn(s)[0] || (/^([a-z0-9]{2,10})\b/.exec(s)?.[1] && !/^(open|close|half|be|sl|long|short|buy|sell)$/.test(/^([a-z0-9]{2,10})/.exec(s)[1]) ? /^([a-z0-9]{2,10})/.exec(s)[1].toUpperCase() : null);
  const side = /\b(short|sell)\b/.test(s) ? 'S' : /\b(long|buy)\b/.test(s) ? 'L' : null;
  const n = k => { const m = new RegExp(`${k}\\s*([\\d.,]+k?)`).exec(s); return m ? num(m[1]) : null; };
  const base = { coin, side: side === 'L' ? 'LONG' : side === 'S' ? 'SHORT' : '', entry1: null, entry2: null, sl: null, tps: [], margin_pct: null, leverage: null, position_id: '', from_post: 0 };
  if (/^open\b/.test(s) && coin && side) {
    const e = /(?:long|short|buy|sell)\s+([\d.,]+k?)/.exec(s);
    return { actions: [{ ...base, type: 'open', entry1: e ? num(e[1]) : null, entry2: n('dca'), sl: n('sl'), tps: n('tp') ? [n('tp')] : [] }] };
  }
  if (/^close\b/.test(s) && coin) return { actions: [{ ...base, type: 'close' }] };
  if (/^half\b/.test(s) && coin) return { actions: [{ ...base, type: 'book_half' }] };
  if (/^be\b/.test(s) && coin) return { actions: [{ ...base, type: 'sl_to_entry' }] };
  if (/^sl\b/.test(s) && coin && n(coin.toLowerCase())) return { actions: [{ ...base, type: 'set_sl', sl: n(coin.toLowerCase()) }] };
  if (coin || side) return { hint: { ...(coin ? { coin } : {}), ...(side ? { side } : {}) } };
  return {};
}
