#!/bin/bash
# speedtest.sh: compare a volume opened through the share path (/mnt/user/...)
# with the same file opened through its real disk path (/mnt/diskN/...) (VOL-8).
#
# Usage:  bash scripts/speedtest.sh <share path> <disk path> [<MB>] [<rounds>]
#   bash scripts/speedtest.sh /mnt/user/data/veracrypt/throwaway-400-xfs \
#                             /mnt/disk5/data/veracrypt/throwaway-400-xfs 250 3
#
# Only for throwaway volumes. Each path is mounted "once" (not saved, not
# logged by name) as tw-speed, a test file of <MB> is written (with fsync) and,
# after the server's read cache is emptied, read back; the file is removed and
# the volume dismounted. The password goes to vcmount on standard input from
# .secrets/throwaway-password; it is never on a command line.

set -u
export MSYS_NO_PATHCONV=1
. "$(cd "$(dirname "$0")" && pwd)/local.sh"
SSH="${BOB_SSH:-/c/Windows/System32/OpenSSH/ssh.exe}"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
PASSWORD="$REPO/.secrets/throwaway-password"

SHARE_PATH="${1:-}"
DISK_PATH="${2:-}"
MB="${3:-250}"
ROUNDS="${4:-3}"
[ -n "$SHARE_PATH" ] && [ -n "$DISK_PATH" ] || { echo "Usage: bash scripts/speedtest.sh <share path> <disk path> [<MB>] [<rounds>]" >&2; exit 1; }
[[ "$MB" =~ ^[0-9]+$ && "$ROUNDS" =~ ^[0-9]+$ ]] || { echo "MB and rounds must be numbers" >&2; exit 1; }
NAME=tw-speed
POINT="/mnt/addons/$NAME"
TEST="$POINT/vcm-speedtest.bin"

# Quote a value for the server's shell (spaces, quotes), never as raw text.
q() { printf '%q' "$1"; }
on_bob() { "$SSH" -n -o BatchMode=yes "$HOST" "$1" 2>&1 | grep -v 'IO is still pending'; }

for path in "$SHARE_PATH" "$DISK_PATH"; do
    echo "== $path"
    "$SSH" -o BatchMode=yes "$HOST" "vcmount mount --file $(q "$path") --name $(q "$NAME")" < "$PASSWORD" 2>&1 | grep -v 'IO is still pending'
    # The answer comes back as text: an exit code would be lost in the ssh pipe.
    if [ "$(on_bob "grep -q ' $POINT ' /proc/mounts && echo yes || echo no")" != yes ]; then
        echo "not mounted, test stopped" >&2
        exit 1
    fi
    for r in $(seq 1 "$ROUNDS"); do
        # dd's last line holds the speed; fsync makes the write reach the disk.
        w=$(on_bob "dd if=/dev/zero of='$TEST' bs=1M count=$MB conv=fsync 2>&1 | tail -1")
        on_bob "sync && echo 3 > /proc/sys/vm/drop_caches"
        rd=$(on_bob "dd if='$TEST' of=/dev/null bs=1M 2>&1 | tail -1")
        on_bob "rm -f '$TEST'"
        echo "round $r  write: ${w##*, }   read: ${rd##*, }"
    done
    on_bob "vcmount dismount '$NAME'"
done
on_bob "grep -q ' $POINT ' /proc/mounts && echo 'STILL MOUNTED' || echo 'dismounted, test file removed'"
