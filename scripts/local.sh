# local.sh: the details of one person's own setup, kept out of the repository.
# The helper scripts read this file with ". scripts/local.sh"; it is not run
# on its own.
#
# It reads two one-line files from .secrets/ (excluded from Git):
#   .secrets/server      the server to test on, for example: root@tower.local
#   .secrets/test-user   an existing Unraid user for the share tests
# BOB_HOST, if set, overrides .secrets/server.

LOCAL_REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOCAL_DIR="$LOCAL_REPO/.secrets"

local_line() {
    [ -f "$LOCAL_DIR/$1" ] && head -n 1 "$LOCAL_DIR/$1" | tr -d '\r'
}

HOST="${BOB_HOST:-$(local_line server)}"
if [ -z "$HOST" ]; then
    echo "No server set. Put its address into .secrets/server (one line, for example root@tower.local), or set BOB_HOST." >&2
    exit 1
fi

# Copy the files of tests/ into build/tests/ with @TEST_USER@ replaced by the
# test user, and print that folder. The deploy scripts send this copy, so the
# repository itself holds no user name.
stage_tests() {
    local user dest f
    user="$(local_line test-user)"
    if ! [[ "$user" =~ ^[a-z_][a-z0-9_-]{0,31}$ ]]; then
        echo "No valid test user. Put an existing Unraid user name into .secrets/test-user." >&2
        exit 1
    fi
    dest="$LOCAL_REPO/build/tests"
    rm -rf "$dest"
    mkdir -p "$dest"
    for f in "$1"/*; do
        sed "s/@TEST_USER@/$user/g" "$f" > "$dest/$(basename "$f")"
    done
    echo "$dest"
}
