#!/bin/bash
# tctest.sh: try to unlock each of cryptsetup's TrueCrypt sample volumes with
# the plugin's own one-off mount, on the server.
#
# Usage:  bash scripts/tctest.sh <path to cryptsetup's tests/tcrypt-compat-test>
#
# The samples (cryptsetup's tests/tcrypt-images.tar.xz, only tc_*, tck_* and the
# two keyfiles) must already be in SAMPLES on the server. Their passwords are
# public and are read from cryptsetup's own test script, so none is stored
# here. They reach the engine through standard input only.
#
# Results: MOUNTED (unlocked and mounted; dismounted again at once), UNLOCKED
# (unlocked, but no usable file system), UNSUPPORTED (cryptsetup read the header
# but could not map the volume: TrueCrypt 4/5 CBC cascades and Blowfish, which
# the kernel cannot do), FAILED (wrong password or not recognised).

set -u
cd "$(dirname "$0")/.." || exit 1
. scripts/local.sh   # sets HOST
SSH="${BOB_SSH:-/c/Windows/System32/OpenSSH/ssh.exe}"

compat=${1:?Usage: bash scripts/tctest.sh <path to tcrypt-compat-test>}
SAMPLES=/mnt/user/data/veracrypt/tc-samples
ENGINE=/usr/local/emhttp/plugins/veracrypt.mount/scripts/vcmount

password_of() {   # the value of NAME="..." in cryptsetup's test script
    sed -n "s/^$1=\"\(.*\)\"$/\1/p" "$compat"
}
PASSWORD=$(password_of PASSWORD)
PASSWORD_HIDDEN=$(password_of PASSWORD_HIDDEN)
[ -n "$PASSWORD" ] && [ -n "$PASSWORD_HIDDEN" ] || { echo "No passwords found in $compat"; exit 1; }

export MSYS_NO_PATHCONV=1
files=$("$SSH" -n -o BatchMode=yes "$HOST" "cd $SAMPLES && ls tc_* tck_*" 2>/dev/null | tr -d '\r')

ok=0; old=0; bad=0
for f in $files; do
    args="mount --file $SAMPLES/$f --name tctest --json"
    pw=$PASSWORD
    case "$f" in *-hidden) args="$args --hidden"; pw=$PASSWORD_HIDDEN ;; esac
    case "$f" in tck_*) args="$args --keyfile $SAMPLES/keyfile1 --keyfile $SAMPLES/keyfile2" ;; esac
    start=$(date +%s)
    out=$(printf '%s\n' "$pw" | "$SSH" -o BatchMode=yes "$HOST" "$ENGINE $args" 2>/dev/null | tr -d '\r')
    secs=$(( $(date +%s) - start ))
    msg=$(printf '%s' "$out" | sed -n 's/.*"error":"\([^"]*\)".*/\1/p')
    if printf '%s' "$out" | grep -q '"ok":true'; then
        ( "$SSH" -n -o BatchMode=yes "$HOST" "$ENGINE dismount tctest" >/dev/null 2>&1 ) 2>/dev/null
        result="MOUNTED"; ok=$((ok + 1))
    elif printf '%s' "$msg" | grep -q 'its result code was 1)'; then
        result="UNSUPPORTED"; old=$((old + 1))
    elif printf '%s' "$msg" | grep -qi 'password\|could not unlock\|no volume'; then
        result="FAILED"; bad=$((bad + 1))
    else
        result="UNLOCKED"; ok=$((ok + 1))
    fi
    printf '%-48s %-9s %3ss  %s\n' "$f" "$result" "$secs" "$msg"
done
echo "Unlocked: $ok   Unsupported (old format): $old   Failed: $bad"
