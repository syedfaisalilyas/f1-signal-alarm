// Trade-log filtering and stats, shared by the server route and the browser
// build so the two can't drift.

// Trades are identified by when they closed — a trade opened before the window
// but closed inside it is part of that period's result.
export function filterTrades(all, { side, from, to, minVol1h } = {}) {
  let rows = all;
  if (side === 'LONG' || side === 'SHORT') rows = rows.filter(t => t.side === side);
  if (from) rows = rows.filter(t => t.exitTime >= from);
  if (to) rows = rows.filter(t => t.exitTime <= to);
  if (minVol1h > 0) rows = rows.filter(t => t.vol1h !== null && t.vol1h >= minVol1h);
  return rows;
}

export function aggregate(list) {
  const n = list.length;
  const wins = list.filter(t => t.r > 0).length;
  const green = list.filter(t => t.r >= -0.02).length;
  const totalR = list.reduce((s, t) => s + t.r, 0);
  return {
    trades: n, wins,
    winRate: n ? wins / n * 100 : 0,
    greenRate: n ? green / n * 100 : 0,
    totalR, avgR: n ? totalR / n : 0,
    totalPct: list.reduce((s, t) => s + t.pnlPct, 0)
  };
}

// How far back the scanned candles actually reach. Without this, asking for a
// range older than the fetched window looks like "no trades" rather than
// "history doesn't go back that far".
export function coverage(all) {
  if (!all.length) return null;
  const times = all.map(t => t.exitTime);
  return { from: Math.min(...times), to: Math.max(...times) };
}
