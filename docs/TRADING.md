# Running the bot

The scanner runs on GitHub Actions and always will. **The bot cannot.** GitHub's
runners sit in US datacentres and Binance answers `451` to every one of them —
checked directly, `fapi.binance.com/fapi/v1/ping` returns 451 from a runner in
Des Moines. MEXC is worse in a subtler way: it lets the runner read an account
and blocks order submission with a `403`, so the bot would see your balance and
never place a trade.

Market data survives this because it falls back to MEXC. Trading has no
fallback. So the bot needs a machine outside the US.

## A free machine that stays on

**Oracle Cloud Always Free** — genuinely free with no expiry, and you choose the
region. Pick anywhere except the US: Mumbai, Singapore, Frankfurt.

1. Sign up at `cloud.oracle.com` (a card is needed for identity; the Always Free
   shapes are not billed).
2. Create a **VM instance** → shape **VM.Standard.A1.Flex** (ARM), 1 CPU / 6 GB.
   Image: Ubuntu 24.04. Save the SSH key it offers.
3. SSH in and set it up:

```bash
sudo apt update && sudo apt install -y nodejs npm git
git clone https://github.com/syedfaisalilyas/f1-signal-alarm.git
cd f1-signal-alarm && npm ci --omit=dev
```

Any always-on box works the same way — a Raspberry Pi, an old laptop, a cheap
VPS. The only requirement is that Binance is reachable from it.

## Your keys

Create them at Binance → API Management:

- Enable **Futures** only. Leave spot, margin and withdrawals **off**.
- Restrict to your server's IP address.
- **Never paste them into a chat, a commit, or a GitHub secret for this repo.**

On the server, put them in a file only you can read:

```bash
cat > ~/f1-signal-alarm/.env <<'KEYS'
BINANCE_KEY=your_key
BINANCE_SECRET=your_secret
KEYS
chmod 600 ~/f1-signal-alarm/.env
```

## Watch it first

```bash
node trade.js                    # paper: real data, real decisions, nothing placed
PAPER_BALANCE=50 node trade.js   # paper with a pretend balance
```

Run that for a few days and read what it says it would have done. When the
decisions look right:

```bash
LIVE=1 node trade.js             # places real orders
```

## On a timer

```bash
crontab -e
# every 5 minutes, logging to the home directory
*/5 * * * * cd ~/f1-signal-alarm && LIVE=1 /usr/bin/node trade.js >> ~/trade.log 2>&1
```

Every pass raises the trailing stops on open positions *before* it looks for
anything new, so a slow sweep never delays protecting a running trade.

## What it does

| | |
|---|---|
| takes | fresh long ignitions, ≤2 candles old, on 1h |
| skips | shorts — 391 of them produced no move above +50% |
| size | 1% of the wallet as margin (`MARGIN_PCT`) |
| leverage | the symbol's exchange maximum (`MAX_LEV` to cap it) |
| margin mode | isolated, so one liquidation cannot reach the rest |
| stop | on the exchange as `closePosition` — a crashed bot still has a protected trade |
| exit | no target; the stop trails 25% below the best price seen |
| cap | 8 positions at once (`MAX_OPEN`) |

## Things that will happen

**Small wallets hit exchange floors.** Binance sets a minimum notional per
symbol — $50 for BTCUSDT. At 1% of a $50 wallet that is $0.50 of margin, so
only symbols whose minimum your leverage can clear are tradeable. The bot says
which ones it skipped and why.

**Most trades lose.** The strategy wins roughly one in five and pays through the
occasional coin that runs hundreds of percent. A run of fifteen losses is
normal and is not a reason to change anything.

**The stop lives on the exchange, the trail lives in the bot.** If the server
dies, your position keeps its last stop and simply stops trailing upward. That
is the failure you want — it exits somewhere sensible rather than not at all.
