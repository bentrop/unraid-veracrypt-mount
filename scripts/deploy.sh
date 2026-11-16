#!/bin/bash
# deploy.sh: copy the engine, actions.php and the tests to the server, for
# development only.
#
# Usage:    bash scripts/deploy.sh
# Preview:  DRY_RUN=1 bash scripts/deploy.sh   (prints what would happen, runs nothing)
#
# What it does on the server, in one connection:
#   1. creates the folder /tmp/vcmount-dev (in RAM, gone after a reboot)
#   2. writes five files into it: vcmount, actions.php, volumes.test.json,
#      enginetest-on-bob.sh and actiontest-on-bob.php
#   3. lets PHP check vcmount and actions.php for syntax errors (they are not run)
#
# Nothing is installed. The flash drive and /mnt are not touched.

set -eu
export MSYS_NO_PATHCONV=1

# The server address comes from .secrets/server (or BOB_HOST), see scripts/local.sh.
. "$(cd "$(dirname "$0")" && pwd)/local.sh"
SSH="${BOB_SSH:-/c/Windows/System32/OpenSSH/ssh.exe}"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
ENGINE_DIR="$REPO/src/usr/local/emhttp/plugins/veracrypt.mount/scripts"
INCLUDE_DIR="$REPO/src/usr/local/emhttp/plugins/veracrypt.mount/include"
TEST_DIR="$(stage_tests "$REPO/tests")" || exit 1   # with the test user filled in, see scripts/local.sh
REMOTE_DIR="/tmp/vcmount-dev"

remote="mkdir -p $REMOTE_DIR && tar -xf - --no-same-owner -C $REMOTE_DIR && chmod 755 $REMOTE_DIR/vcmount"
remote="$remote && php -l $REMOTE_DIR/vcmount && php -l $REMOTE_DIR/actions.php"
remote="$remote; echo \"[result code on Bob: \$?]\""

echo "Server:  $HOST"
echo "Sends:   $ENGINE_DIR/vcmount"
echo "         $INCLUDE_DIR/actions.php"
echo "         $TEST_DIR/volumes.test.json"
echo "         $TEST_DIR/enginetest-on-bob.sh"
echo "         $TEST_DIR/actiontest-on-bob.php"
echo "Command: $remote"

if [ "${DRY_RUN:-0}" = 1 ]; then
    echo "(preview only, nothing was run)"
    exit 0
fi

# The five files travel as one tar stream through the SSH connection.
tar -cf - -C "$ENGINE_DIR" vcmount -C "$INCLUDE_DIR" actions.php \
    -C "$TEST_DIR" volumes.test.json enginetest-on-bob.sh actiontest-on-bob.php \
    | "$SSH" -o BatchMode=yes "$HOST" "$remote" || true
