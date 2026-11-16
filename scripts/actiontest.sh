#!/bin/bash
# actiontest.sh: run ONE test case of actions.php (the logic behind the web
# pages) on the server.
#
# Usage:    bash scripts/actiontest.sh <case>
# Preview:  DRY_RUN=1 bash scripts/actiontest.sh <case>
#
# Cases:    config   options, list, save-config valid and invalid, refused
#                    requests. No password, nothing is mounted.
#           mount    "require HTTPS" refuses a mount over HTTP; then a mount and
#                    dismount of the throwaway NTFS volume through actions.php.
#
# The steps are in tests/actiontest-on-bob.php, which scripts/deploy.sh copies
# to the server. Run deploy.sh first. The settings file used is in
# /tmp/vcmount-dev, never the one on the flash drive.
#
# The throwaway password is sent through standard input only. It never appears
# in a command line.

set -eu
export MSYS_NO_PATHCONV=1

# The server address comes from .secrets/server (or BOB_HOST), see scripts/local.sh.
. "$(cd "$(dirname "$0")" && pwd)/local.sh"
SSH="${BOB_SSH:-/c/Windows/System32/OpenSSH/ssh.exe}"
REMOTE_DIR="/tmp/vcmount-dev"
SECRET_FILE="$(dirname "$0")/../.secrets/throwaway-password"

case="${1:-}"
case "$case" in
    config) needs_password=no ;;
    mount) needs_password=yes ;;
    *)
        echo "Usage: bash scripts/actiontest.sh config|mount"
        exit 1
        ;;
esac

remote="php $REMOTE_DIR/actiontest-on-bob.php $case"
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
