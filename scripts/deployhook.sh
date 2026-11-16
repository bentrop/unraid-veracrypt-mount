#!/bin/bash
# deployhook.sh: put the two array-stop hooks and the engine where Unraid looks
# for them, for development only. Or take them away again.
#
# Usage:    bash scripts/deployhook.sh install
#           bash scripts/deployhook.sh remove
# Preview:  DRY_RUN=1 bash scripts/deployhook.sh <install|remove>
#
# install, in one connection:
#   1. creates the folder /usr/local/emhttp/plugins/veracrypt.mount with the
#      sub-folders event and scripts (in RAM, gone after a reboot)
#   2. writes four files into it: event/stopping_docker,
#      event/unmounting_disks, scripts/vcmount and scripts/volumes.dev.json
#      (a copy of tests/volumes.test.json; while it is there, the hooks make
#      the engine read it instead of the configuration on the flash drive)
#   3. makes the first three executable
#   From then on Unraid runs the two hooks at every array stop.
#
# remove, in one connection:
#   deletes exactly those four files and then the three folders, which must
#   be empty by then. Nothing else is deleted.
#
# Nothing is installed as a plugin. The flash drive and /mnt are not touched.

set -eu
export MSYS_NO_PATHCONV=1

# The server address comes from .secrets/server (or BOB_HOST), see scripts/local.sh.
. "$(cd "$(dirname "$0")" && pwd)/local.sh"
SSH="${BOB_SSH:-/c/Windows/System32/OpenSSH/ssh.exe}"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
PLUGIN_DIR="/usr/local/emhttp/plugins/veracrypt.mount"
SOURCE_DIR="$REPO/src$PLUGIN_DIR"
HOOK="event/unmounting_disks"
HOOK2="event/stopping_docker"
ENGINE="scripts/vcmount"
FILES="$PLUGIN_DIR/$HOOK $PLUGIN_DIR/$HOOK2 $PLUGIN_DIR/$ENGINE"
TEST_DIR="$(stage_tests "$REPO/tests")" || exit 1   # with the test user filled in, see scripts/local.sh
TEST_CONFIG="volumes.test.json"
DEV_CONFIG="scripts/volumes.dev.json"

action="${1:-}"
case "$action" in
    install)
        remote="mkdir -p $PLUGIN_DIR && tar -xf - --no-same-owner -C $PLUGIN_DIR && chmod 755 $FILES && ls -l $FILES $PLUGIN_DIR/$DEV_CONFIG"
        ;;
    remove)
        remote="rm $FILES $PLUGIN_DIR/$DEV_CONFIG && rmdir $PLUGIN_DIR/event $PLUGIN_DIR/scripts $PLUGIN_DIR"
        ;;
    *)
        echo "Usage: bash scripts/deployhook.sh <install|remove>"
        exit 1
        ;;
esac
remote="$remote; echo \"[result code on Bob: \$?]\""

echo "Server:  $HOST"
if [ "$action" = install ]; then
    echo "Sends:   $SOURCE_DIR/$HOOK"
    echo "         $SOURCE_DIR/$HOOK2"
    echo "         $SOURCE_DIR/$ENGINE"
    echo "         $TEST_DIR/$TEST_CONFIG (as $DEV_CONFIG)"
fi
echo "Command: $remote"

if [ "${DRY_RUN:-0}" = 1 ]; then
    echo "(preview only, nothing was run)"
    exit 0
fi

if [ "$action" = install ]; then
    # The four files travel as one tar stream through the SSH connection. The
    # test configuration is renamed on the way.
    tar -cf - --transform "s|^$TEST_CONFIG\$|$DEV_CONFIG|" \
        -C "$SOURCE_DIR" "$HOOK" "$HOOK2" "$ENGINE" -C "$TEST_DIR" "$TEST_CONFIG" \
        | "$SSH" -o BatchMode=yes "$HOST" "$remote" || true
else
    "$SSH" -n -o BatchMode=yes "$HOST" "$remote" || true
fi
