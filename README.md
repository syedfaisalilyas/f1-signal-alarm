# F1 Signal Alarm

Live scanner that runs your **F1 indicator** on any Binance crypto pair (spot or perps,
memecoins included) plus forex, and rings your phone the moment a signal fires —
with the exact position, TP1, TP2 and SL — *and* warns you a few minutes before it happens.

---

## Quick start

```bash
npm install
cp .env.example .env      # then fill in a notification channel (see below)
npm start
```

Open **http://localhost:8787**

To use it from your phone on the same Wi-Fi, find your Mac's LAN IP
(`ipconfig getifaddr en0`) and open `http://<that-ip>:8787` on the phone.

---

## Getting alerts on your phone

Pick **one**. Telegram is the easiest and the most reliable.

### 1. Telegram (recommended)
```bash
npm run telegram
```
Walks you through it. You only do the part that needs your Telegram account:

1. Message **@BotFather**, send `/newbot`, pick a name and a username ending in `bot`.
2. Paste the token it gives you into the script.

The script then validates the token, waits for you to press START in the bot chat,
auto-discovers your chat id, writes both values into `.env`, and sends a test message.
No hunting through `getUpdates` JSON.

### 2. ntfy (loudest — real alarm behaviour)
1. Install the **ntfy** app (iOS / Android).
2. Pick an unguessable topic name, e.g. `f1-alarm-8f2k9xq`, subscribe to it in the app.
3. Put it in `.env` as `NTFY_TOPIC`.
4. In the app, set that topic's priority handling to max so it breaks through silent mode.

### 3. Web push (PWA)
```bash
npm run keys      # prints VAPID_PUBLIC / VAPID_PRIVATE
```
Paste both into `.env`, restart, then tap **📱 Push** in the header.

> Web push needs HTTPS (localhost is exempt). Over a plain `http://192.168.x.x` LAN address
> your phone browser will refuse to subscribe. Telegram and ntfy have no such limitation
> because they're sent from the server. For HTTPS, put the app behind a
> Cloudflare Tunnel or ngrok.

---

## What you get

**Three alert types**

| Alert | When | Contains |
|---|---|---|
| `ENTRY` | F1 signal confirms on a closed candle | side, entry, TP1, TP2, SL, risk %, RSI/ATR/volume |
| `PREALERT` | setup is about to trigger | exact trigger price, % move needed, ETA in bars *and* minutes, which gates are open |
| `EXIT` | TP2, SL, breakeven stop, reversal TP, or time stop | exit price, reason, result in R and % |

**How the pre-alert knows**

The EMA cross is solvable in closed form. Given the previous bar's EMA values, the price
at which fast crosses slow on the *current* bar is:

```
x = ( slowPrev·(1−kS) − fastPrev·(1−kF) ) / (kF − kS)      k = 2/(len+1)
```

That's not a guess — it's the exact trigger price. The card shows how far price has to
travel to reach it, whether RSI/MACD/volume/trend currently permit the signal, and a
bars-to-cross estimate from the EMA spread's own slope. You get warned when price is
within `preAlertPct` (default 0.35%) or the cross is within `preAlertBars` (default 3).

**Managing symbols**
- Search by anything: `doge`, `pepe`, `wif`, `btc`, `EUR/USD`. Spot, perps and forex all searched at once.
- Pick a timeframe, click a result — it starts streaming instantly.
- Click **✕** on a card to remove it. Watchlist survives restarts (`data/state.json`).

---

## Config

Header **⚙** sets indicator params. Defaults match the corrected Pine script exactly:
filters OFF, original F1 entry logic, Swing stop, TP1 1R / TP2 2R, breakeven after TP1,
reversal TP on, 40-bar time stop.

Indicator changes apply to **newly added** symbols. To re-tune one you're already watching,
remove and re-add it.

Forex needs a free key from [twelvedata.com](https://twelvedata.com) → `TWELVEDATA_KEY`.
Crypto needs no key at all. Twelve Data's free tier has no 3m interval, so 3m forex candles
are built by aggregating 1m bars.

---

## Notes

- Signals evaluate on **closed candles**, matching the Pine script's no-repaint mode.
  Pre-alerts intentionally use the live forming candle — that's the whole point of them.
- The win rate and R totals on each card are computed from the last ~600 bars of history
  at theoretical fill prices. **No fees or slippage.** On 3m scalps with ~0.05% taker fees
  per side, a 1R win on a 0.3% stop is largely eaten by costs. Treat those numbers as a
  sanity check on the logic, not as a backtest.
- Binance market data is public and needs no API key. This app never places orders and
  holds no exchange credentials.

## Layout

```
server.js            express + websocket + alert routing
src/indicators.js    EMA / RSI / MACD / ATR (Pine-faithful, incl. Wilder RMA)
src/strategy.js      F1 port: entries, TP/SL state machine, pre-alert forecast
src/feed.js          Binance websocket streams, forex polling, signal detection
src/providers.js     symbol search, klines, 24h ticker
src/notify.js        Telegram / ntfy / web push
src/store.js         JSON persistence
public/              UI (vanilla, no build step)
```

---

## Deploying

### A) Public link right now (free, zero accounts)
```bash
./start.sh      # scanner + Cloudflare tunnel + keeps the Mac awake
./stop.sh
```
Prints a `https://….trycloudflare.com/?key=…` link. Real HTTPS, so **web push works**
on your phone through it. Caveat: it runs on your Mac — sleep the Mac and it stops.
The URL is new on every restart.

### B) Always-on (needs a free account, ~5 min)
The repo has a `Dockerfile`, so any container host works. **Koyeb** is the best free fit —
its free instance stays running (Render's free tier sleeps after 15 min of no traffic,
which would silence your alarms).

```bash
git init && git add -A && git commit -m "f1 signal alarm"
gh repo create f1-signal-alarm --private --source=. --push
```
Then on [koyeb.com](https://koyeb.com): **Create Service → GitHub → your repo →
Dockerfile**, and set env vars `APP_PASSWORD`, `TELEGRAM_TOKEN`, `TELEGRAM_CHAT_ID`.
You get a permanent `https://….koyeb.app` URL.

> Free container hosts have no persistent disk, so `data/state.json` resets on redeploy
> and you'd re-add your symbols. Everything else works identically.

### Access control
`APP_PASSWORD` in `.env` gates the API and the websocket. It's generated for you on
first run. Share the link as `https://host/?key=YOURKEY` — the key moves into
localStorage and is stripped from the address bar. Without it: `401`.
