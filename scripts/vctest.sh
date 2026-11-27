#!/bin/bash
# vctest.sh: run ONE test action against ONE throwaway volume on the server.
#
# Usage:    bash scripts/vctest.sh <action> <volume>
# Preview:  DRY_RUN=1 bash scripts/vctest.sh <action> <volume>
#           (prints the command for the server, runs nothing)
#
# Volumes:  ntfs | exfat | argon | xfs   (only these four; see the list below)
# Actions:  status   show whether the volume is open and mounted (read-only)
#           dump     read the volume header and print its details (read-only)
#           open     unlock the volume (creates /dev/mapper/vctest-<volume>)
#           mount    mount the unlocked volume at /mnt/addons/vctest-<volume>
#           write    write one small test file into the mounted volume
#           umount   dismount the volume (never forced)
#           close    lock the volume again (removes /dev/mapper/vctest-<volume>)
#
# The password is sent to cryptsetup through standard input only. It never
# appears in a command line.

set -eu

# Stop Git Bash on Windows from rewriting Unix paths in the command.
export MSYS_NO_PATHCONV=1

# The address this PC already trusts for the server (it is not known as "bob").
# The server address comes from .secrets/server (or BOB_HOST), see scripts/local.sh.
. "$(cd "$(dirname "$0")" && pwd)/local.sh"
# Windows' own SSH program. It gets the unlocked key from the Windows SSH agent;
# the SSH program that comes with Git cannot do that.
SSH="${BOB_SSH:-/c/Windows/System32/OpenSSH/ssh.exe}"
VOLUME_DIR="/mnt/user/data/veracrypt"
SECRET_FILE="$(dirname "$0")/../.secrets/throwaway-password"

usage() {
    echo "Usage: bash scripts/vctest.sh <action> <volume>"
    echo "  actions: status dump open mount write umount close"
    echo "  volumes: ntfs exfat argon xfs"
    exit 1
}

action="${1:-}"
volume="${2:-}"

# The only volumes this script will ever touch.
case "$volume" in
    ntfs)  file="throwaway-ntfs";  fstype="ntfs3" ;;
    exfat) file="throwaway-exfat"; fstype="exfat" ;;
    argon) file="throwaway-argon"; fstype="ntfs3" ;;
    xfs)   file="throwaway-400-xfs"; fstype="xfs" ;;
    *)     usage ;;
esac

path="$VOLUME_DIR/$file"
mapper="vctest-$volume"
mountpoint="/mnt/addons/vctest-$volume"

# Build the one command that runs on the server.
needs_password=no
case "$action" in
    status)
        # Both names: this script's own (vctest-...) and the engine's (vcm-...).
        remote="cryptsetup status $mapper; cryptsetup status vcm-$volume; grep -e $mapper -e vcm-$volume /proc/mounts || true"
        ;;
    dump)
        remote="cryptsetup tcryptDump --veracrypt $path"
        needs_password=yes
        ;;
    open)
        remote="cryptsetup tcryptOpen --veracrypt $path $mapper"
        needs_password=yes
        ;;
    mount)
        # XFS keeps owners itself and refuses uid= and gid=.
        opts="nosuid,nodev,uid=99,gid=100"; [ "$fstype" = xfs ] && opts="nosuid,nodev"
        remote="mkdir -p $mountpoint && mount -t $fstype -o $opts /dev/mapper/$mapper $mountpoint"
        ;;
    write)
        remote="echo 'written on the server' > $mountpoint/written-on-server.txt && ls -la $mountpoint"
        ;;
    umount)
        remote="umount $mountpoint && rmdir $mountpoint"
        ;;
    close)
        remote="cryptsetup close $mapper"
        ;;
    *)
        usage
        ;;
esac

# Windows' SSH program reports a wrong result code when run from Git Bash, so the
# server prints the real one itself as the last line of the output.
remote="$remote; echo \"[result code on the server: \$?]\""

echo "Server:  $HOST"
echo "Command: $remote"
if [ "$needs_password" = yes ]; then
    echo "Input:   the throwaway password, through standard input"
fi

if [ "${DRY_RUN:-0}" = 1 ]; then
    echo "(preview only, nothing was run)"
    exit 0
fi

# BatchMode: use the SSH key only, never stop to ask for a login password.
if [ "$needs_password" = yes ]; then
    "$SSH" -o BatchMode=yes "$HOST" "$remote" < "$SECRET_FILE" || true
else
    "$SSH" -n -o BatchMode=yes "$HOST" "$remote" || true
fi
