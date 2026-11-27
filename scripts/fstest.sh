#!/bin/bash
# fstest.sh: test one file system end to end on the test server (FS-1):
# write a file, dismount, mount read-only, check the file is there and cannot
# be changed, dismount, mount normally again, remove the file.
#
# Usage:  bash scripts/fstest.sh <volume name> [<volume file>]
#   A saved volume:              bash scripts/fstest.sh throwaway-ext4
#   A file not saved ("once"):   bash scripts/fstest.sh tw-xfs /mnt/user/data/veracrypt/throwaway-400-xfs
#
# Only for throwaway volumes. The password goes to vcmount on standard input
# from .secrets/throwaway-password, once per mount; it is never on a command line.
# A saved volume is left mounted afterwards, a "once" volume dismounted.

set -u
export MSYS_NO_PATHCONV=1
. "$(cd "$(dirname "$0")" && pwd)/local.sh"
SSH="${BOB_SSH:-/c/Windows/System32/OpenSSH/ssh.exe}"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
PASSWORD="$REPO/.secrets/throwaway-password"

NAME="${1:-}"
FILE="${2:-}"
[[ "$NAME" =~ ^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$ ]] || { echo "Usage: bash scripts/fstest.sh <name> [<file>]" >&2; exit 1; }
POINT="/mnt/addons/$NAME"
TEST="$POINT/vcm-fstest.txt"

# Quote a value for the server's shell (spaces, quotes), never as raw text.
q() { printf '%q' "$1"; }
on_bob() { "$SSH" -n -o BatchMode=yes "$HOST" "$1" 2>&1 | grep -v 'IO is still pending'; }
mount_it() {   # $1: extra options ("" or "--read-only")
    if [ -n "$FILE" ]; then
        "$SSH" -o BatchMode=yes "$HOST" "vcmount mount --file $(q "$FILE") --name $(q "$NAME") $1" < "$PASSWORD" 2>&1 | grep -v 'IO is still pending'
    else
        "$SSH" -o BatchMode=yes "$HOST" "vcmount mount $(q "$NAME") $1" < "$PASSWORD" 2>&1 | grep -v 'IO is still pending'
    fi
}

echo "== $NAME"
on_bob "vcmount status '$NAME' | grep -E '^State' || true"
# The answer comes back as text: an exit code would be lost in the ssh pipe.
if [ "$(on_bob "grep -q ' $POINT ' /proc/mounts && echo yes || echo no")" != yes ]; then
    echo "not mounted, mounting"
    mount_it ""
fi
echo "-- write a file and show its owner"
on_bob "echo 'written by fstest' > '$TEST' && stat -c '%U:%G %n' '$TEST' && grep ' $POINT ' /proc/mounts | cut -d' ' -f3,4"
echo "-- dismount, mount read-only"
on_bob "vcmount dismount '$NAME'"
mount_it "--read-only"
on_bob "grep ' $POINT ' /proc/mounts | cut -d' ' -f3,4"
echo "-- the file is still there:"
on_bob "cat '$TEST'"
echo "-- writing must fail:"
on_bob "echo x >> '$TEST' && echo 'WROTE - not read-only!' || echo 'refused, as it should be'"
echo "-- dismount, mount normally, remove the test file"
on_bob "vcmount dismount '$NAME'"
mount_it ""
on_bob "rm -f '$TEST' && echo 'test file removed'"
if [ -n "$FILE" ]; then
    on_bob "vcmount dismount '$NAME'"
fi
on_bob "vcmount status '$NAME' 2>/dev/null | grep -E '^State' || echo 'State:       not listed (dismounted once volume)'"
