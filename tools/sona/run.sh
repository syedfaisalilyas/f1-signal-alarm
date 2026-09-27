#!/bin/zsh
# Start / stop / check copysona and sonabot (paper). Each runs in a restart loop;
# logs and state live in ~/.sona (copysona.log, sonabot.log, *.json).
#   tools/sona/run.sh start | stop | status
DIR=${0:A:h}; H=~/.sona; mkdir -p $H
loop() { # name script
  while [ ! -f $H/$1.stop ]; do caffeinate -i node $DIR/$2 >> $H/$1.out 2>&1; sleep 20; done
}
case $1 in
  start)
    # Since 27 Sep 2026 both bots run on the Oracle server (systemd: sona-copysona, sona-sonabot).
    # Two copysonas would both trade and both read your Telegram replies.
    [ "$2" = "--here" ] || { echo "The bots run on the server now (ssh ubuntu@140.245.246.123; systemctl status sona-copysona sona-sonabot)."; echo "Only run them here after stopping the server ones:  $0 start --here"; exit 1; }
    for b in copysona sonabot; do
      rm -f $H/$b.stop
      pgrep -f "tools/sona/$b.mjs" >/dev/null && { echo "$b already running"; continue; }
      loop $b $b.mjs &! ; echo $! > $H/$b.pid; echo "$b started"
    done ;;
  stop)
    for b in copysona sonabot; do
      touch $H/$b.stop                                   # the loop exits instead of restarting
      [ -f $H/$b.pid ] && kill $(cat $H/$b.pid) 2>/dev/null; rm -f $H/$b.pid
      pkill -f "tools/sona/$b.mjs"
    done; echo stopped ;;
  status)
    for b in copysona sonabot; do
      pgrep -f "tools/sona/$b.mjs" >/dev/null && echo "$b: running" || echo "$b: stopped"
      tail -3 $H/$b.log 2>/dev/null | sed 's/^/   /'
    done ;;
  *) echo "usage: $0 start|stop|status" ;;
esac
