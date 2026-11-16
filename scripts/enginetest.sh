#!/bin/bash
# enginetest.sh: run ONE test case of the engine on the server.
#
# Usage:    bash scripts/enginetest.sh <case>
# Preview:  DRY_RUN=1 bash scripts/enginetest.sh <case>
#
# Cases:    wrong-password   wrong password gives code 2, volume left locked
#           busy             dismount with a program inside gives code 5
#           undo             a mount that fails after unlocking locks again
#           unsaved          mount without saving (--file and --name)
#           read-only        the --read-only option
#           windows-names    file names Windows cannot handle are refused
#           dismount-all     "dismount --all": nothing mounted, busy, then free
#           dependents       dependents start on mount, stop or are killed on dismount
#           force            "dismount --force" ends a program and stops a container
#           share            a hidden read-only SMB share is added on mount, repaired,
#                            removed on dismount
#           share-clash      a share name that is already taken is refused, the
#                            volume is mounted all the same
#
# The array-stop test, three cases around one press of the Stop button:
#           stop-prepare     before: mounts the volume with two throwaway
#                            dependents and leaves a program sitting inside it
#           stop-check       after the stop: only reads the system log and the
#                            mount table and says what the two hooks did
#           stop-cleanup     after the array is started again: removes the two
#                            throwaway containers
#           It needs scripts/deployhook.sh install first.
#
# The steps of each case are in tests/enginetest-on-bob.sh, which
# scripts/deploy.sh copies to the server. Run deploy.sh first.
#
# Only the throwaway NTFS volume is used. The throwaway password is sent
# through standard input only. It never appears in a command line.

set -eu
export MSYS_NO_PATHCONV=1

# The server address comes from .secrets/server (or BOB_HOST), see scripts/local.sh.
. "$(cd "$(dirname "$0")" && pwd)/local.sh"
SSH="${BOB_SSH:-/c/Windows/System32/OpenSSH/ssh.exe}"
REMOTE_DIR="/tmp/vcmount-dev"
SECRET_FILE="$(dirname "$0")/../.secrets/throwaway-password"

case="${1:-}"
needs_password=yes
case "$case" in
    wrong-password|stop-check|stop-cleanup) needs_password=no ;;
    busy|undo|unsaved|read-only|windows-names|dismount-all|dependents|force|share|share-clash|stop-prepare) ;;
    *)
        echo "Usage: bash scripts/enginetest.sh <case>"
        echo "  cases: wrong-password busy undo unsaved read-only windows-names dismount-all dependents force share share-clash"
        echo "         stop-prepare stop-check stop-cleanup"
        exit 1
        ;;
esac

remote="bash $REMOTE_DIR/enginetest-on-bob.sh $case"
remote="$remote; echo \"[result code on Bob: \$?]\""

echo "Server:  $HOST"
echo "Command: $remote"
if [ "$needs_password" = yes ]; then
    echo "Input:   the throwaway password, through standard input"
fi

if [ "${DRY_RUN:-0}" = 1 ]; then
    echo "(preview only, nothing was run)"
    exit 0
fi

if [ "$needs_password" = yes ]; then
    "$SSH" -o BatchMode=yes "$HOST" "$remote" < "$SECRET_FILE" || true
else
    "$SSH" -n -o BatchMode=yes "$HOST" "$remote" || true
fi
