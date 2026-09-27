// Live market ticks for a paper book: price every call, plus the real 30m
// candle once each candle closes (that's when "SL if candle close below"
// is judged). Used by copysona and sonabot.
import { price, candles } from './common.mjs';
import * as P from './paper.mjs';

export function makeTicker() {
  let lastBar = Math.floor(Date.now() / 1800e3) * 1800e3;   // don't judge a candle that closed before we started
  return async function tick(book, log) {
    if (!book.positions.length) return [];
    const ev = [];
    const bar = Math.floor(Date.now() / 1800e3) * 1800e3;       // start of the current 30m candle
    const newClose = bar > lastBar && Date.now() - bar > 15e3;  // one closed; give MEXC 15 s to publish it
    const prices = {};
    for (const p of [...book.positions]) {
      try {
        const px = prices[p.coin] ??= await price(p.coin);
        ev.push(...P.onBar(book, p, { h: px, l: px, c: px, closed: false }));
        if (newClose && book.positions.includes(p)) {
          const k = (await candles(p.coin, 'Min30', Math.floor(bar / 1000) - 3600)).find(x => x.t === bar - 1800e3);
          if (k) ev.push(...P.onBar(book, p, { ...k, closed: true, t: bar }));
        }
      } catch (e) { log('tick', p.coin, e.message); }
    }
    if (newClose) lastBar = bar;
    return ev;
  };
}
