#!/bin/bash
# logcheck.sh: search the server's logs and temporary files for the throwaway
# password, to show that it was not written anywhere (SEC-1).
#
# Usage:    bash scripts/logcheck.sh
# Preview:  DRY_RUN=1 bash scripts/logcheck.sh
#
# The password goes to grep through standard input (grep -f -), so it never
# appears in a command line. Only file names are printed, never what matched.
# It reads everything below /var/log and /tmp and changes nothing.
#
# Result code of grep: 1 means "found nowhere" (the good result), 0 means it
# was found in the files listed.

set -eu
export MSYS_NO_PATHCONV=1

# The server address comes from .secrets/server (or BOB_HOST), see scripts/local.sh.
. "$(cd "$(dirname "$0")" && pwd)/local.sh"
SSH="${BOB_SSH:-/c/Windows/System32/OpenSSH/ssh.exe}"
SECRET_FILE="$(dirname "$0")/../.secrets/throwaway-password"

# Empty lines are dropped first: an empty search pattern would match every file.
remote="sed '/^\$/d' | grep -rlsF -f - /var/log /tmp"
remote="$remote; echo \"[grep result code on Bob: \$? (1 = found nowhere)]\""

echo "Server:  $HOST"
echo "Command: $remote"
echo "Input:   the throwaway password, through standard input"

if [ "${DRY_RUN:-0}" = 1 ]; then
    echo "(preview only, nothing was run)"
    exit 0
fi

"$SSH" -o BatchMode=yes "$HOST" "$remote" < "$SECRET_FILE" || true
