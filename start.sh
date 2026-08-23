#!/usr/bin/env bash
# Starts the scanner + a public HTTPS tunnel, and keeps the Mac awake.
cd "$(dirname "$0")"

pkill -f "node.*server.js" 2>/dev/null
pkill -f "cloudflared tunnel" 2>/dev/null
sleep 1

echo "starting scanner…"
caffeinate -is npm start > /tmp/f1srv.log 2>&1 &
sleep 4

echo "opening public tunnel…"
cloudflared tunnel --url http://localhost:8787 --protocol http2 --no-autoupdate > /tmp/tunnel.log 2>&1 &

for i in $(seq 1 45); do
  URL=$(grep -Eo 'https://[a-z0-9-]+\.trycloudflare\.com' /tmp/tunnel.log 2>/dev/null | head -1)
  [ -n "$URL" ] && break
  sleep 1
done

KEY=$(grep '^APP_PASSWORD=' .env | cut -d= -f2)

echo
echo "  ────────────────────────────────────────────────"
echo "   local :  http://localhost:8787"
echo "   public:  $URL/?key=$KEY"
echo "  ────────────────────────────────────────────────"
echo
echo "  The public link changes every restart (free quick tunnels)."
echo "  Stop everything with:  ./stop.sh"
