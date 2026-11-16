#!/bin/bash
# deployweb.sh: put the plugin's web pages and the engine where Unraid looks
# for them, for development only. Or take them away again.
#
# Usage:    bash scripts/deployweb.sh install
#           bash scripts/deployweb.sh install-reset
#           bash scripts/deployweb.sh remove
# Preview:  DRY_RUN=1 bash scripts/deployweb.sh <install|remove>
#
# install, in one connection:
#   1. creates /usr/local/emhttp/plugins/veracrypt.mount with the sub-folders
#      include, js, css and scripts (in RAM, gone after a reboot)
#   2. writes the files listed in WEB_FILES below, the engine
#      (scripts/vcmount) and scripts/volumes.dev.json (a copy of
#      tests/volumes.test.json; while it is there, action.php makes the engine
#      read it instead of the settings on the flash drive). An existing
#      volumes.dev.json is kept, so volumes added in the page survive a
#      reinstall. install-reset replaces it with the test copy.
#   3. makes the engine executable, lists what is there and lets PHP check the
#      three PHP files for syntax errors (they are not run)
#   From then on the page appears in Unraid under Settings > User Utilities.
#
# remove, in one connection:
#   deletes exactly the web files. The engine and volumes.dev.json are deleted
#   too, unless the array-stop hooks of scripts/deployhook.sh are installed and
#   still need them. Then the folders that are empty. Nothing else is deleted.
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
TEST_DIR="$(stage_tests "$REPO/tests")" || exit 1   # with the test user filled in, see scripts/local.sh

WEB_FILES="VeraCryptMount.page VeraCryptMountVolumes.page VeraCryptMountSettings.page VeraCryptMountDashboard.page VeraCryptMountMain.page include/action.php include/actions.php include/dialog.php js/vcmount.js js/vcsettings.js css/vcmount.css"
ENGINE="scripts/vcmount"
DEV_CONFIG="scripts/volumes.dev.json"

remote_files() {
    local out=""
    for f in "$@"; do out="$out $PLUGIN_DIR/$f"; done
    echo "$out"
}

action="${1:-}"
case "$action" in
    install|install-reset)
        if [ "$action" = install-reset ]; then
            keep="mv -f $PLUGIN_DIR/$DEV_CONFIG.new $PLUGIN_DIR/$DEV_CONFIG"
        else
            keep="if [ -e $PLUGIN_DIR/$DEV_CONFIG ]; then rm -f $PLUGIN_DIR/$DEV_CONFIG.new; echo 'Kept the existing $DEV_CONFIG'; else mv $PLUGIN_DIR/$DEV_CONFIG.new $PLUGIN_DIR/$DEV_CONFIG; fi"
        fi
        remote="mkdir -p $PLUGIN_DIR/include $PLUGIN_DIR/js $PLUGIN_DIR/css $PLUGIN_DIR/scripts"
        remote="$remote && tar -xf - --no-same-owner -C $PLUGIN_DIR && chmod 755 $PLUGIN_DIR/$ENGINE"
        remote="$remote && $keep"
        remote="$remote && ls -l$(remote_files $WEB_FILES $ENGINE $DEV_CONFIG)"
        remote="$remote && php -l $PLUGIN_DIR/$ENGINE && php -l $PLUGIN_DIR/include/actions.php && php -l $PLUGIN_DIR/include/action.php"
        ;;
    remove)
        remote="rm -f$(remote_files $WEB_FILES)"
        remote="$remote && if [ ! -e $PLUGIN_DIR/event/unmounting_disks ]; then rm -f$(remote_files $ENGINE $DEV_CONFIG); fi"
        remote="$remote && rmdir --ignore-fail-on-non-empty $PLUGIN_DIR/include $PLUGIN_DIR/js $PLUGIN_DIR/css $PLUGIN_DIR/scripts $PLUGIN_DIR"
        ;;
    *)
        echo "Usage: bash scripts/deployweb.sh <install|install-reset|remove>"
        exit 1
        ;;
esac
remote="$remote; echo \"[result code on Bob: \$?]\""

echo "Server:  $HOST"
if [ "$action" != remove ]; then
    for f in $WEB_FILES $ENGINE; do echo "Sends:   $SOURCE_DIR/$f"; done
    echo "Sends:   $TEST_DIR/volumes.test.json (as $DEV_CONFIG.new; used only if there is no $DEV_CONFIG or with install-reset)"
fi
echo "Command: $remote"

if [ "${DRY_RUN:-0}" = 1 ]; then
    echo "(preview only, nothing was run)"
    exit 0
fi

if [ "$action" != remove ]; then
    # One tar stream through the SSH connection. The test configuration is
    # renamed to scripts/volumes.dev.json.new on the way.
    tar -cf - -C "$SOURCE_DIR" $WEB_FILES $ENGINE \
        -C "$TEST_DIR" --transform "s|^volumes\.test\.json\$|$DEV_CONFIG.new|" volumes.test.json \
        | "$SSH" -o BatchMode=yes "$HOST" "$remote" || true
else
    "$SSH" -n -o BatchMode=yes "$HOST" "$remote" || true
fi
