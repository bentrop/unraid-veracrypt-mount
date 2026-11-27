#!/bin/bash
# vcrun.sh: run the development copy of the engine on the server, once.
#
# Usage:    bash scripts/vcrun.sh <vcmount arguments>
#           bash scripts/vcrun.sh list
#           bash scripts/vcrun.sh status throwaway-ntfs --json
# Preview:  DRY_RUN=1 bash scripts/vcrun.sh <vcmount arguments>
#
# It runs /tmp/vcmount-dev/vcmount (put there by scripts/deploy.sh) with the
# test configuration, which lists only the throwaway volume.
#
# For "mount", the throwaway password is sent through standard input only.
# It never appears in a command line.

set -eu
export MSYS_NO_PATHCONV=1

# The server address comes from .secrets/server (or BOB_HOST), see scripts/local.sh.
. "$(cd "$(dirname "$0")" && pwd)/local.sh"
SSH="${BOB_SSH:-/c/Windows/System32/OpenSSH/ssh.exe}"
REMOTE_DIR="/tmp/vcmount-dev"
SECRET_FILE="$(dirname "$0")/../.secrets/throwaway-password"

if [ $# -eq 0 ]; then
    echo "Usage: bash scripts/vcrun.sh <vcmount arguments>"
    exit 1
fi

# Only plain characters are passed on, so nothing can be misread by the
# server's shell.
for arg in "$@"; do
    case "$arg" in
        *[!A-Za-z0-9_./-]*|"")
            echo "Refused: argument contains characters other than letters, digits, _ . / -"
            exit 1
            ;;
    esac
done

remote="VCMOUNT_CONFIG=$REMOTE_DIR/volumes.test.json php $REMOTE_DIR/vcmount $*"
remote="$remote; echo \"[result code on the server: \$?]\""

needs_password=no
if [ "$1" = mount ]; then
    needs_password=yes
fi

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
