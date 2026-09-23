#!/usr/bin/env bash
# Tests receiver/export-receiver.ps1 against a real ntfy server.
# Needs PowerShell 7 (pwsh) and the ntfy server binary.  Usage: tests/test-receiver.sh /path/to/pwsh /path/to/ntfy
set -u
P=${1:?pwsh path}; NT=${2:?ntfy path}
R=$(cd "$(dirname "$0")/.." && pwd)/receiver/export-receiver.ps1
W=$(mktemp -d); cd "$W"
T=indesign-exports-rxtest7h3k9q2m8xwp4n
unset HTTPS_PROXY HTTP_PROXY https_proxy http_proxy ALL_PROXY all_proxy
startsrv() { ("$NT" serve --listen-http 127.0.0.1:2588 --base-url http://127.0.0.1:2588 --keepalive-interval 5s --cache-file "$W/cache.db" > ntfy.log 2>&1 &); sleep 2; }
srvpid() { pgrep -f "[n]tfy serve --listen-http 127.0.0.1:2588"; }
stopsrv() { srvpid | xargs -r kill; sleep 1; }
pub() { curl -s --noproxy '*' -H "Title: InDesign export finished" -d "$1" "http://127.0.0.1:2588/$T" >/dev/null; }
startrx() { ("$P" -NoProfile -File "$R" -Dir "$W/rdir" -TestMode -StaleSeconds 12 -WarnAfterMinutes 0.25 >> out.txt 2>&1 &); }
stoprx() { pgrep -f "[e]xport-receiver.ps1 -Dir $W" | xargs -r kill; sleep 1; }

mkdir -p rdir; printf "server=http://127.0.0.1:2588\ntopic=$T\n" > rdir/settings.txt; : > out.txt
startsrv
startrx; sleep 5; pub "Done (1): live_1.pdf"; pub "Done (1): live_2.pdf / קמפיין.pdf"; sleep 3      # live messages
"$P" -NoProfile -File "$R" -Dir "$W/rdir" -TestMode; echo "second copy exited: $?" >> out.txt      # accidental 2nd copy
pub "Done (1): FAIL-TOAST.pdf"; pub "Done (1): after_bad_toast.pdf"; sleep 3                         # Windows refuses one pop-up
stoprx; pub "Done (1): while_pc_off_1.pdf"; pub "Done (1): while_pc_off_2.pdf"; startrx; sleep 6    # PC off, then on
stopsrv; sleep 25; startsrv; pub "Done (1): after_outage.pdf"; sleep 70                              # ntfy down > warning time
kill -STOP "$(srvpid)"; sleep 18; kill -CONT "$(srvpid)"; pub "Done (1): after_freeze.pdf"; sleep 20 # silently dead connection
stoprx; stopsrv

expected="NOTIFY | Export notifications are on | You'll get a notification here when an InDesign export finishes.
NOTIFY | InDesign export finished | Done (1): live_1.pdf
NOTIFY | InDesign export finished | Done (1): live_2.pdf / קמפיין.pdf
second copy exited: 0
NOTIFY | InDesign export finished | Done (1): after_bad_toast.pdf
NOTIFY | InDesign export finished | Done (1): while_pc_off_1.pdf
NOTIFY | InDesign export finished | Done (1): while_pc_off_2.pdf
NOTIFY | Export notifications can't connect | Still trying. Check this computer's internet connection.
NOTIFY | Export notifications reconnected | Any exports you missed will appear now.
NOTIFY | InDesign export finished | Done (1): after_outage.pdf
NOTIFY | InDesign export finished | Done (1): after_freeze.pdf"
if [ "$(cat out.txt)" = "$expected" ] && grep -q "Could not show notification" rdir/receiver.log; then
    echo "receiver: all scenarios passed"; rm -rf "$W"; exit 0
fi
echo "receiver: FAILED. Got:"; cat out.txt; echo "--- log:"; cat rdir/receiver.log; exit 1
