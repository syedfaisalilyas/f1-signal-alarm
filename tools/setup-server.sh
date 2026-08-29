#!/usr/bin/env bash
# Everything the trading box needs, in one command.
#
#   ssh -i ~/.ssh/f1bot ubuntu@YOUR_IP 'bash -s' < tools/setup-server.sh
#
# Safe to run twice — it installs what is missing and leaves the rest alone.
# It deliberately does NOT start live trading: it ends in paper mode, because a
# bot should be watched for a few days before it is trusted with money.
set -euo pipefail

REPO=https://github.com/syedfaisalilyas/f1-signal-alarm.git
DIR="$HOME/f1-signal-alarm"

echo "── checking this machine can reach Binance ──"
code=$(curl -s -o /dev/null -w '%{http_code}' -m 20 https://fapi.binance.com/fapi/v1/ping || echo 000)
if [ "$code" != "200" ]; then
  echo "Binance futures returned $code from this server."
  [ "$code" = "451" ] && echo "451 means this region is blocked — rebuild the VM in Mumbai, Singapore or Frankfurt."
  echo "Stopping: the bot cannot trade from here."
  exit 1
fi
echo "Binance reachable ✓"

echo "── installing node ──"
if ! command -v node >/dev/null 2>&1 || [ "$(node -v | cut -c2-3)" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
sudo apt-get install -y git >/dev/null
node -v

echo "── fetching the bot ──"
if [ -d "$DIR/.git" ]; then git -C "$DIR" pull --ff-only; else git clone "$REPO" "$DIR"; fi
cd "$DIR" && npm ci --omit=dev

echo "── keys ──"
if [ ! -f "$DIR/.env" ]; then
  cat > "$DIR/.env" <<'KEYS'
# Binance futures API key. Futures permission ONLY — no spot, no margin, no
# withdrawals — and restricted to this server's IP address.
BINANCE_KEY=
BINANCE_SECRET=
KEYS
  chmod 600 "$DIR/.env"
  echo "created $DIR/.env — put your key and secret in it (nano .env)"
else
  echo ".env already exists, leaving it alone"
fi

echo "── a paper run, to prove it works ──"
cd "$DIR" && PAPER=1 PAPER_BALANCE=50 node trade.js || true

cat <<'NEXT'

────────────────────────────────────────────────────────
Set up. What is left, in order:

  1. nano ~/f1-signal-alarm/.env      put your Binance key and secret in
  2. node trade.js                    should now print your REAL balance
  3. watch it in paper for a few days — read what it says it would do
  4. when you trust it:
       crontab -e
       */5 * * * * cd ~/f1-signal-alarm && LIVE=1 /usr/bin/node trade.js >> ~/trade.log 2>&1

  tail -f ~/trade.log     to watch it work
────────────────────────────────────────────────────────
NEXT
