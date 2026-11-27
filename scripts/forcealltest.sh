#!/bin/bash
# forcealltest.sh: test the forced "dismount all" of the array stop with
# several volumes in use at once (audit 2026-11-27c S1.4), on the server.
#
# Usage:  bash scripts/forcealltest.sh
#
# Mounts three throwaway volumes (their saved settings; the throwaway password
# from .secrets/throwaway-password on standard input only), puts into each a
# "sleep" that ignores the stop signal, so it must be killed after the wait,
# then runs "vcmount dismount --all --force --within 22", the time the
# unmounting_disks hook has with Unraid's default shutdown time-out. Expected:
# all three locked, in about one forced wait rather than three.
# At the end it kills its own sleeps, if any are left. Nothing else is touched.

set -u
cd "$(dirname "$0")/.." || exit 1
. scripts/local.sh   # sets HOST
SSH="${BOB_SSH:-/c/Windows/System32/OpenSSH/ssh.exe}"
SECRET=.secrets/throwaway-password
E="${ENGINE:-/usr/local/emhttp/plugins/veracrypt.mount/scripts/vcmount}"   # ENGINE=... to compare another engine
VOLUMES="throwaway-ntfs throwaway-exfat throwaway-ext4"
export MSYS_NO_PATHCONV=1

on_bob() { "$SSH" -n -o BatchMode=yes "$HOST" "$1" 2>&1 | grep -v "IO is still"; }

for v in $VOLUMES; do
    "$SSH" -o BatchMode=yes "$HOST" "$E mount $v" < "$SECRET" 2>&1 | grep -v "IO is still"
done

echo "--- A sleep that ignores the stop signal in each volume"
for v in $VOLUMES; do
    on_bob "cd /mnt/addons/$v && (setsid -f sh -c 'trap \"\" TERM; exec sleep 300' > /dev/null 2>&1 < /dev/null); sleep 0.3; echo started in $v"
done

echo "--- Dependents first, as the stopping_docker hook does before"
on_bob "$E stop-dependents --all"

echo "--- Forced dismount of all, within 22 seconds"
on_bob "start=\$(date +%s); VCMOUNT_TRACE=1 $E dismount --all --force --within 22; echo \"code \$? after \$((\$(date +%s) - start)) seconds\""

echo "--- Afterwards"
on_bob "for v in $VOLUMES; do if [ -e /dev/mapper/vcm-\$v ]; then echo \"\$v: STILL UNLOCKED\"; else echo \"\$v: locked\"; fi; done; pgrep -f 'sleep 300' > /dev/null && { pkill -KILL -f '^sleep 300$'; echo 'killed leftover sleeps'; } || true"
