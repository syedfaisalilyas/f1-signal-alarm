#!/usr/bin/env bash
pkill -f "node.*server.js" 2>/dev/null
pkill -f "cloudflared tunnel" 2>/dev/null
pkill -f "caffeinate -is npm" 2>/dev/null
echo "stopped."
