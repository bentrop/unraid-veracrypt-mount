#!/bin/bash
# enginetest-on-bob.sh: the part of the engine tests that runs on the server.
#
# It is copied to /tmp/vcmount-dev by scripts/deploy.sh and started by
# scripts/enginetest.sh. Do not start it by hand.
#
# Usage:  bash /tmp/vcmount-dev/enginetest-on-bob.sh <case>
# Cases:  wrong-password | busy | undo | unsaved | read-only | windows-names |
#         dismount-all | dependents | force | share | share-clash |
#         stop-prepare | stop-check | stop-cleanup
#
# It runs ONE case against the throwaway NTFS volume, prints every step with
# its result code, and ends with PASS or FAIL.
#
# The throwaway password arrives on standard input and is handed straight to
# the one "vcmount mount" of the case. This script never reads it. Every other
# command gets an empty standard input.
#
# Only the case "force" forces a dismount. The cases "dependents" and "force"
# create throwaway containers named vcm-test-... from the image alpine:3.21 and
# remove them again at the end. No other container is touched.
#
# If something is left mounted at the end, the script tries one normal dismount
# and reports what it finds.
#
# The three stop-... cases belong together and test the two array-stop hooks,
# which scripts/deployhook.sh must have installed:
#   stop-prepare  creates the two throwaway dependents, mounts deps-test and
#                 leaves a sleep sitting inside the volume. On success it does
#                 NOT clean up: the volume stays mounted for the array stop.
#   (then the array is stopped by hand with the Stop button)
#   stop-check    changes nothing. It reads the system log, the mount table
#                 and /proc and says whether the hooks did their work.
#   (then the array is started by hand)
#   stop-cleanup  removes the throwaway containers and the two small note
#                 files of stop-prepare. Needs Docker running.

set -u

DIR=/tmp/vcmount-dev
export VCMOUNT_CONFIG="$DIR/volumes.test.json"
NAME=throwaway-ntfs
FILE=/mnt/user/data/veracrypt/throwaway-ntfs
BLOCKER=/mnt/addons/vcm-test-blocker
ALL_NAMES="throwaway-ntfs undo-test unsaved-test deps-test"
IMAGE=alpine:3.21
TEST_CONTAINERS="vcm-test-good vcm-test-stubborn vcm-test-holder"
# For the stop-... cases.
PLUGIN_DIR=/usr/local/emhttp/plugins/veracrypt.mount
STOP_MOUNT=/mnt/addons/deps-test
PID_FILE="$DIR/stop-test.pid"            # process number of the sleep
LOG_START_FILE="$DIR/stop-test.logstart" # length of the system log before the stop
# For the share case.
SHARE_DIR=/etc/samba/veracrypt-shares
SMB_HOOK=/etc/samba/smb-unassigned.conf

fails=0
holder=""

vc() { php "$DIR/vcmount" "$@"; }

step() { echo; echo "--- $*"; }
good() { echo "ok:   $*"; }
bad() { echo "FAIL: $*"; fails=$((fails + 1)); }

# expect_code <wanted> <actual> <what>
expect_code() {
    if [ "$2" -eq "$1" ]; then good "$3 (code $2)"; else bad "$3: code $2, expected $1"; fi
}

# check <what> <command...>: the command must succeed.
check() {
    local what="$1"; shift
    if "$@" < /dev/null > /dev/null 2>&1; then good "$what"; else bad "$what"; fi
}

# check_not <what> <command...>: the command must fail.
check_not() {
    local what="$1"; shift
    if "$@" < /dev/null > /dev/null 2>&1; then bad "$what"; else good "$what"; fi
}

is_locked() { [ ! -e "/dev/mapper/vcm-$1" ]; }
is_mounted() { grep -q " /mnt/addons/$1 " /proc/mounts; }
# No loop device is left behind for the throwaway volume file.
no_loop() { ! grep -qs 'data/veracrypt/throwaway-ntfs$' /sys/block/loop*/loop/backing_file; }
log_lines() { grep -c 'veracrypt\.mount' /var/log/syslog; }
container_exists() { docker inspect --type container "$1" > /dev/null 2>&1; }
running() { [ "$(docker inspect --type container --format '{{.State.Running}}' "$1" 2> /dev/null)" = true ]; }
# has_text <text> <output> <what>: the output must contain the text.
has_text() {
    case "$2" in
        *"$1"*) good "$3" ;;
        *) bad "$3" ;;
    esac
}

# Leave things as we found them, then print the verdict.
finish() {
    step "Clean up"
    if [ -n "$holder" ] && kill -0 "$holder" 2> /dev/null; then
        kill "$holder"
        wait "$holder" 2> /dev/null
        echo "stopped the test's own sleep (process $holder)"
    fi
    for c in $TEST_CONTAINERS; do
        if container_exists "$c"; then
            docker rm -f "$c" > /dev/null
            echo "removed the throwaway container $c"
        fi
    done
    for n in $ALL_NAMES; do
        if ! is_locked "$n"; then
            echo "\"$n\" is not locked; trying one normal dismount"
            vc dismount "$n" < /dev/null
            if is_locked "$n"; then echo "now locked"; else bad "\"$n\" is STILL not locked"; fi
        fi
    done
    if [ -f "$BLOCKER" ] && [ ! -s "$BLOCKER" ]; then
        rm "$BLOCKER"
        echo "removed $BLOCKER"
    fi
    verdict
}

# Print PASS or FAIL and end.
verdict() {
    echo
    if [ "$fails" -eq 0 ]; then
        echo "PASS: $case"
        exit 0
    fi
    echo "FAIL: $case ($fails check(s) failed)"
    exit 1
}

case="${1:-}"
case "$case" in
    wrong-password|busy|undo|unsaved|read-only|windows-names|dismount-all|dependents|force|share|share-clash) ;;
    stop-prepare|stop-check|stop-cleanup) ;;
    *) echo "Unknown case. Cases: wrong-password busy undo unsaved read-only windows-names dismount-all dependents force share share-clash stop-prepare stop-check stop-cleanup"; exit 1 ;;
esac

# stop-check and stop-cleanup come after stop-prepare and start from what it
# left behind, so the "everything must be locked" rule is not for them.
case "$case" in stop-check|stop-cleanup) fresh_start=no ;; *) fresh_start=yes ;; esac

if [ "$fresh_start" = yes ]; then
step "Before: everything must be locked"
for n in $ALL_NAMES; do
    if ! is_locked "$n"; then
        echo "Stopped: \"$n\" is unlocked or mounted. Nothing was done."
        exit 1
    fi
done
if [ -e "$BLOCKER" ]; then
    echo "Stopped: $BLOCKER already exists. Nothing was done."
    exit 1
fi
for c in $TEST_CONTAINERS vcm-test-missing; do
    if container_exists "$c"; then
        echo "Stopped: a container named $c already exists. Nothing was done."
        exit 1
    fi
done
good "all test volumes are locked"
fi

case "$case" in

wrong-password)
    step "Mount $NAME with a wrong password"
    # Not a secret: a fixed text that is not the throwaway password.
    echo 'this-is-not-the-password' | vc mount "$NAME"
    expect_code 2 $? "mount with wrong password"
    sleep 1
    check "volume is locked" is_locked "$NAME"
    check "no loop device left" no_loop
    check "no mount folder left" test ! -e "/mnt/addons/$NAME"
    ;;

busy)
    step "Mount $NAME"
    vc mount "$NAME"
    code=$?
    expect_code 0 $code "mount"
    if [ $code -eq 0 ]; then
        step "Start a sleep that sits inside the volume, then dismount"
        ( cd "/mnt/addons/$NAME" && exec sleep 300 ) < /dev/null > /dev/null 2>&1 &
        holder=$!
        sleep 1
        out=$(vc dismount "$NAME" < /dev/null 2>&1)
        code=$?
        echo "$out"
        expect_code 5 $code "dismount while busy"
        case "$out" in
            *"held open by: sleep (process $holder)"*) good "the message names the sleep" ;;
            *) bad "the message does not name the sleep (process $holder)" ;;
        esac
        check "volume is still mounted" is_mounted "$NAME"

        step "Stop the sleep, dismount again"
        kill "$holder"
        wait "$holder" 2> /dev/null
        holder=""
        vc dismount "$NAME" < /dev/null
        expect_code 0 $? "dismount"
        check "volume is locked" is_locked "$NAME"
    fi
    ;;

undo)
    step "Put an empty file where the mount folder would have to be created"
    if [ ! -d /mnt/addons ]; then
        echo "Stopped: /mnt/addons does not exist. Nothing was done."
        exit 1
    fi
    : > "$BLOCKER"
    step "Mount undo-test (unlocks, then cannot create its mount folder)"
    vc mount undo-test
    expect_code 4 $? "mount that fails after unlocking"
    sleep 1
    check "volume is locked again" is_locked undo-test
    check "no loop device left" no_loop
    check "the blocker file is untouched" test -f "$BLOCKER" -a ! -s "$BLOCKER"
    ;;

unsaved)
    before=$(log_lines)
    step "Mount without saving, as unsaved-test"
    vc mount --file "$FILE" --name unsaved-test
    code=$?
    expect_code 0 $code "mount without saving"
    if [ $code -eq 0 ]; then
        out=$(vc list < /dev/null)
        echo "$out"
        case "$out" in
            *"unsaved-test (not saved)"*) good "list shows it as not saved" ;;
            *) bad "list does not show it as not saved" ;;
        esac
        check "it is mounted" is_mounted unsaved-test
        step "Dismount"
        vc dismount unsaved-test < /dev/null
        expect_code 0 $? "dismount"
        check "volume is locked" is_locked unsaved-test
    fi
    sleep 1
    after=$(log_lines)
    if [ "$before" = "$after" ]; then
        good "no new line in the system log ($after before and after)"
    else
        bad "the system log grew from $before to $after lines"
    fi
    ;;

read-only)
    step "Mount $NAME with --read-only"
    vc mount "$NAME" --read-only
    code=$?
    expect_code 0 $code "mount read-only"
    if [ $code -eq 0 ]; then
        out=$(vc status "$NAME" < /dev/null)
        echo "$out"
        case "$out" in
            *"Read-only:   yes"*) good "status says read-only" ;;
            *) bad "status does not say read-only" ;;
        esac
        check "the mount table says ro" grep -q " /mnt/addons/$NAME ntfs3 ro[, ]" /proc/mounts
        check_not "creating a file is refused" touch "/mnt/addons/$NAME/enginetest-ro.txt"
        step "Dismount"
        vc dismount "$NAME" < /dev/null
        expect_code 0 $? "dismount"
        check "volume is locked" is_locked "$NAME"
    fi
    ;;

windows-names)
    step "Mount $NAME"
    vc mount "$NAME"
    code=$?
    expect_code 0 $code "mount"
    if [ $code -eq 0 ]; then
        mp="/mnt/addons/$NAME"
        step "Try two file names Windows cannot handle, then a normal one"
        check_not "a name with a colon is refused" touch "$mp/enginetest-bad:name"
        check_not "a name ending in a dot is refused" touch "$mp/enginetest-trailing-dot."
        check "a normal name works" touch "$mp/enginetest-ok.txt"
        check "the normal file can be deleted" rm "$mp/enginetest-ok.txt"
        # If a bad name was accepted after all, do not leave it in the volume.
        rm -f "$mp/enginetest-bad:name" "$mp/enginetest-trailing-dot." "$mp/enginetest-ok.txt"
        step "Dismount"
        vc dismount "$NAME" < /dev/null
        expect_code 0 $? "dismount"
        check "volume is locked" is_locked "$NAME"
    fi
    ;;

dismount-all)
    step "Dismount all while nothing is mounted"
    vc dismount --all < /dev/null
    expect_code 0 $? "dismount --all with nothing mounted"

    step "Mount $NAME"
    vc mount "$NAME"
    code=$?
    expect_code 0 $code "mount"
    if [ $code -eq 0 ]; then
        step "Start a sleep that sits inside the volume, then dismount all"
        ( cd "/mnt/addons/$NAME" && exec sleep 300 ) < /dev/null > /dev/null 2>&1 &
        holder=$!
        sleep 1
        out=$(vc dismount --all < /dev/null 2>&1)
        code=$?
        echo "$out"
        expect_code 5 $code "dismount --all while busy"
        case "$out" in
            *"held open by: sleep (process $holder)"*) good "the message names the sleep" ;;
            *) bad "the message does not name the sleep (process $holder)" ;;
        esac
        check "volume is still mounted" is_mounted "$NAME"
        check "the system log names the sleep" grep -q "still in use by sleep (process $holder)" /var/log/syslog

        step "Stop the sleep, dismount all again"
        kill "$holder"
        wait "$holder" 2> /dev/null
        holder=""
        vc dismount --all < /dev/null
        expect_code 0 $? "dismount --all"
        check "volume is locked" is_locked "$NAME"
    fi
    ;;

dependents)
    step "Create two throwaway containers that only sleep"
    # With --init the container stops when asked. Without it, it ignores the
    # stop signal and has to be killed.
    check "created vcm-test-good" docker create --name vcm-test-good --init --network none "$IMAGE" sleep 3600
    check "created vcm-test-stubborn" docker create --name vcm-test-stubborn --network none "$IMAGE" sleep 3600

    step "Mount deps-test (one of its three dependents does not exist)"
    out=$(vc mount deps-test 2>&1)
    code=$?
    echo "$out"
    expect_code 7 $code "mount with a missing dependent"
    if [ $code -eq 7 ]; then
        has_text 'Dependent "vcm-test-missing" could not be started' "$out" "the message names the missing dependent"
        check "vcm-test-good is running" running vcm-test-good
        check "vcm-test-stubborn is running" running vcm-test-stubborn
        vc status deps-test < /dev/null

        step "Stop the dependents only"
        out=$(vc stop-dependents --all < /dev/null 2>&1)
        code=$?
        echo "$out"
        expect_code 0 $code "stop-dependents --all"
        has_text 'Stopped dependent "vcm-test-good"' "$out" "vcm-test-good stopped by itself"
        has_text '"vcm-test-stubborn" did not stop within 5 seconds and was killed' "$out" "vcm-test-stubborn was killed"
        check_not "vcm-test-good is not running" running vcm-test-good
        check_not "vcm-test-stubborn is not running" running vcm-test-stubborn
        check "volume is still mounted" is_mounted deps-test

        step "Start both again by hand, then dismount"
        check "started both" docker start vcm-test-good vcm-test-stubborn
        out=$(vc dismount deps-test < /dev/null 2>&1)
        code=$?
        echo "$out"
        expect_code 0 $code "dismount"
        has_text '"vcm-test-stubborn" did not stop within 5 seconds and was killed' "$out" "vcm-test-stubborn was killed"
        check_not "vcm-test-good is not running" running vcm-test-good
        check_not "vcm-test-stubborn is not running" running vcm-test-stubborn
        check "volume is locked" is_locked deps-test
        check "the system log names the kill" grep -q 'dependent "vcm-test-stubborn" of "deps-test" did not stop within 5 seconds and was killed' /var/log/syslog
    fi
    ;;

force)
    step "Mount $NAME"
    vc mount "$NAME"
    code=$?
    expect_code 0 $code "mount"
    if [ $code -eq 0 ]; then
        step "Start a sleep that sits inside the volume, then dismount without force"
        ( cd "/mnt/addons/$NAME" && exec sleep 300 ) < /dev/null > /dev/null 2>&1 &
        holder=$!
        sleep 1
        vc dismount "$NAME" < /dev/null
        expect_code 5 $? "dismount while busy, without force"
        check "volume is still mounted" is_mounted "$NAME"

        step "Start a container that is given the volume's folder and is not a dependent"
        check "started vcm-test-holder" docker run -d --name vcm-test-holder --init --network none \
            -v "/mnt/addons/$NAME:/data" "$IMAGE" sleep 3600

        step "Dismount with --force"
        out=$(vc dismount "$NAME" --force < /dev/null 2>&1)
        code=$?
        echo "$out"
        expect_code 0 $code "dismount --force"
        has_text "Forced: ended sleep (process $holder)" "$out" "the sleep was ended"
        has_text "Forced: stopped container vcm-test-holder" "$out" "the container was stopped"
        check_not "the sleep is gone" kill -0 "$holder"
        check_not "vcm-test-holder is not running" running vcm-test-holder
        check "volume is locked" is_locked "$NAME"
        check "no loop device left" no_loop
        wait "$holder" 2> /dev/null
        holder=""
    fi
    ;;

share|share-clash)
    # The share settings need a real Unraid user and, for the name clash, the
    # name of a real user share. Both are only read. The test configuration is
    # written to $DIR and uses the throwaway volume file only.
    step "Find an Unraid user and the name of an existing user share"
    user=$(awk -F: '$3 >= 1000 && $3 < 60000 { print $1; exit }' /etc/passwd)
    clash=""
    for d in /mnt/user/*/; do
        n=$(basename "$d")
        case "$n" in *[!A-Za-z0-9_-]*|-*|_*) continue ;; esac
        if [ ${#n} -le 32 ]; then clash="$n"; break; fi
    done
    if [ -z "$user" ] || [ -z "$clash" ]; then
        echo "Stopped: no Unraid user or no user share found. Nothing was done."
        exit 1
    fi
    if [ -e "/mnt/addons/$clash" ]; then
        echo "Stopped: /mnt/addons/$clash already exists. Nothing was done."
        exit 1
    fi
    echo "user: $user, existing share: $clash"
    ALL_NAMES="$ALL_NAMES share-test $clash"
    export VCMOUNT_CONFIG="$DIR/volumes.share-test.json"
    cat > "$VCMOUNT_CONFIG" << EOF
{
    "volumes": [
        { "name": "share-test", "file": "$FILE",
          "share": { "export": "hidden", "users": { "$user": "read-only" } } },
        { "name": "$clash", "file": "$FILE",
          "share": { "users": { "$user": "read-write" } } }
    ]
}
EOF
    others_before=$(grep -v 'veracrypt-shares' "$SMB_HOOK" 2> /dev/null)
    param() { testparm -s --section-name="$1" --parameter-name="$2" 2> /dev/null; }

    if [ "$case" = share ]; then
    step "Mount share-test (hidden, read-only share for $user)"
    vc mount share-test
    code=$?
    expect_code 0 $code "mount with a share"
    if [ $code -eq 0 ]; then
        check "the share file exists" test -f "$SHARE_DIR/share-test.conf"
        check "the include line is there" grep -qx "include = $SHARE_DIR/share-test.conf" "$SMB_HOOK"
        [ "$(param share-test path)" = /mnt/addons/share-test ] && good "Samba knows the share" || bad "Samba does not know the share"
        [ "$(param share-test browseable)" = No ] && good "hidden from browsing" || bad "not hidden from browsing"
        [ "$(param share-test 'read only')" = Yes ] && good "read-only" || bad "not read-only"
        [ "$(param share-test 'valid users')" = "$user" ] && good "only $user may connect" || bad "valid users is not $user"
        [ -z "$(param share-test 'write list')" ] && good "nobody may write" || bad "someone may write"
        out=$(vc status share-test < /dev/null)
        echo "$out"
        case "$out" in
            *"Share:"*"not active"*) bad "status says the share is not active" ;;
            *"Share:"*) good "status shows the share" ;;
            *) bad "status does not show the share" ;;
        esac

        step "Repair when nothing is wrong"
        out=$(vc repair-shares < /dev/null 2>&1)
        expect_code 0 $? "repair-shares"
        has_text "already in order" "$out" "nothing to repair"

        step "Take our include line out, as a lost write would, then repair"
        { grep -vx "include = $SHARE_DIR/share-test.conf" "$SMB_HOOK" || true; } > "$SMB_HOOK.test"
        cat "$SMB_HOOK.test" > "$SMB_HOOK"
        rm -f "$SMB_HOOK.test"
        check_not "the include line is gone" grep -qx "include = $SHARE_DIR/share-test.conf" "$SMB_HOOK"
        out=$(vc repair-shares < /dev/null 2>&1)
        expect_code 0 $? "repair-shares"
        echo "$out"
        check "the include line is back" grep -qx "include = $SHARE_DIR/share-test.conf" "$SMB_HOOK"

        step "Dismount: the share goes away"
        vc dismount share-test < /dev/null
        expect_code 0 $? "dismount"
        check "volume is locked" is_locked share-test
        check_not "the share file is gone" test -e "$SHARE_DIR/share-test.conf"
        check_not "the include line is gone" grep -q "veracrypt-shares/share-test.conf" "$SMB_HOOK"
        [ -z "$(param share-test path)" ] && good "Samba no longer knows the share" || bad "Samba still knows the share"
    fi
    else

    step "Mount a volume whose share name is already taken by the user share \"$clash\""
    out=$(vc mount "$clash" 2>&1)
    code=$?
    echo "$out"
    expect_code 8 $code "mount with a clashing share name"
    has_text "another share already has this name" "$out" "the message says why"
    check "it is mounted all the same" is_mounted "$clash"
    check_not "no share file was written" test -e "$SHARE_DIR/$clash.conf"
    vc dismount "$clash" < /dev/null
    expect_code 0 $? "dismount"
    check "volume is locked" is_locked "$clash"
    fi

    step "Lines of other plugins in $SMB_HOOK"
    if [ "$(grep -v 'veracrypt-shares' "$SMB_HOOK" 2> /dev/null)" = "$others_before" ]; then
        good "unchanged"
    else
        bad "they changed"
    fi
    rm -f "$VCMOUNT_CONFIG"
    ;;

stop-prepare)
    step "The two hooks, the engine and the test configuration must be installed"
    for f in event/stopping_docker event/unmounting_disks scripts/vcmount scripts/volumes.dev.json; do
        if [ ! -f "$PLUGIN_DIR/$f" ]; then
            echo "Stopped: $PLUGIN_DIR/$f is missing. Run scripts/deployhook.sh install first. Nothing was done."
            exit 1
        fi
    done
    good "all four files are there"

    step "Create two throwaway containers that only sleep"
    # With --init the container stops when asked. Without it, it ignores the
    # stop signal and has to be killed.
    check "created vcm-test-good" docker create --name vcm-test-good --init --network none "$IMAGE" sleep 3600
    check "created vcm-test-stubborn" docker create --name vcm-test-stubborn --network none "$IMAGE" sleep 3600

    step "Mount deps-test (one of its three dependents does not exist)"
    out=$(vc mount deps-test 2>&1)
    code=$?
    echo "$out"
    expect_code 7 $code "mount with a missing dependent"
    if [ $code -eq 7 ]; then
        check "vcm-test-good is running" running vcm-test-good
        check "vcm-test-stubborn is running" running vcm-test-stubborn

        step "Start a sleep that sits inside the volume and stays when this script ends"
        # setsid cuts the sleep loose from this script and the SSH connection.
        ( cd "$STOP_MOUNT" && exec setsid sleep 3600 ) < /dev/null > /dev/null 2>&1 &
        holder=$!
        sleep 1
        if [ "$(readlink "/proc/$holder/cwd" 2> /dev/null)" = "$STOP_MOUNT" ]; then
            good "the sleep (process $holder) sits in $STOP_MOUNT"
        else
            bad "the sleep (process $holder) does not sit in $STOP_MOUNT"
        fi
    fi

    if [ "$fails" -eq 0 ]; then
        # Remember the sleep and where the system log ends now, for stop-check.
        echo "$holder" > "$PID_FILE"
        wc -l < /var/log/syslog > "$LOG_START_FILE"
        echo
        echo "READY: deps-test is mounted, both dependents run, a sleep holds the volume."
        echo "Nothing was cleaned up. Now stop the array with the Stop button,"
        echo "then run the case stop-check."
        exit 0
    fi
    # Something went wrong: fall through to the clean-up below.
    ;;

stop-check)
    step "Read the two notes that stop-prepare left"
    if [ ! -f "$PID_FILE" ] || [ ! -f "$LOG_START_FILE" ]; then
        echo "Stopped: the notes of stop-prepare are missing. Run stop-prepare first."
        exit 1
    fi
    old_holder=$(cat "$PID_FILE")
    log_start=$(cat "$LOG_START_FILE")
    case "$old_holder$log_start" in
        ''|*[!0-9]*) echo "Stopped: the notes of stop-prepare are not numbers."; exit 1 ;;
    esac
    new_lines=$(tail -n "+$((log_start + 1))" /var/log/syslog)
    echo "the sleep was process $old_holder; the system log had $log_start lines"

    step "What the plugin wrote to the system log since stop-prepare"
    echo "$new_lines" | grep 'veracrypt\.mount'

    step "Lines since stop-prepare that say \"busy\""
    echo "$new_lines" | grep -i 'busy' || echo "(none)"

    step "Checks"
    has_text 'dependent "vcm-test-stubborn" of "deps-test" did not stop within 5 seconds and was killed' \
        "$new_lines" "stopping_docker: the stubborn dependent was killed after its grace period"
    has_text "dismount of \"deps-test\" forced: ended sleep (process $old_holder)" \
        "$new_lines" "unmounting_disks: the dismount was forced and ended the sleep"
    has_text 'dismounted "deps-test"' "$new_lines" "unmounting_disks: the volume was dismounted"
    case "$new_lines" in
        *"target is busy"*) bad "a disk was busy when Unraid unmounted it" ;;
        *) good "no \"target is busy\" in the system log" ;;
    esac
    check "volume is locked" is_locked deps-test
    check_not "volume is not mounted" is_mounted deps-test
    check "no loop device left" no_loop
    if [ "$(readlink "/proc/$old_holder/cwd" 2> /dev/null)" = "$STOP_MOUNT" ]; then
        bad "the sleep (process $old_holder) is still there"
    else
        good "the sleep is gone"
    fi
    echo
    echo "Not checked here: whether the containers stopped (Docker is off while the"
    echo "array is stopped) and the notifications in the web UI."
    # This case only reads. No clean-up.
    verdict
    ;;

stop-cleanup)
    step "Docker must be running"
    if ! docker info > /dev/null 2>&1; then
        echo "Stopped: Docker is not running. Start the array, then run this again. Nothing was done."
        exit 1
    fi
    good "Docker is running"
    # End the sleep only if that process number still is the test's own sleep.
    if [ -f "$PID_FILE" ]; then
        old_holder=$(cat "$PID_FILE")
        case "$old_holder" in
            ''|*[!0-9]*) ;;
            *) [ "$(readlink "/proc/$old_holder/cwd" 2> /dev/null)" = "$STOP_MOUNT" ] && holder=$old_holder ;;
        esac
    fi
    rm -f "$PID_FILE" "$LOG_START_FILE"
    echo "removed the two notes of stop-prepare"
    # The clean-up below removes the throwaway containers.
    ;;

esac

finish
