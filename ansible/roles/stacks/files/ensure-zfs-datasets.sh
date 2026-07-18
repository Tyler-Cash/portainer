#!/bin/sh
# Ensures ZFS datasets exist for a stack's bind-mount sources under /ssd or /hdd.
#
# Runs on the deploy target (via Ansible's `script` module), given the path
# to a stack's deployed docker-compose.yml. For every bind-mount source path
# under /ssd or /hdd that doesn't exist yet:
#   - walk up to the nearest existing ancestor directory
#   - if that ancestor is itself a ZFS dataset's mountpoint (not just some
#     plain subdirectory inside a bigger dataset), create the next path
#     component below it as a new child dataset — e.g. for a brand new
#     stack "foo" with bind mounts under /ssd/services/foo/*, this creates
#     /ssd/services/foo as its own dataset (assuming /ssd/services is a
#     dataset boundary), individually snapshottable like the other per-app
#     datasets the backup job discovers
#   - any path components deeper than that new dataset are plain mkdir -p,
#     matching how stacks already keep plain subdirectories inside a single
#     app-level dataset (e.g. zipline/public, zipline/themes)
#   - if the nearest existing ancestor isn't a dataset boundary (or zfs
#     isn't available), just mkdir -p the whole path
#
# Never touches a path that already exists (file or directory) — this only
# fills in what's missing, it doesn't rearrange or migrate existing data.

set -eu

compose_file="${1:?usage: ensure-zfs-datasets.sh <path-to-docker-compose.yml>}"

[ -f "$compose_file" ] || { echo "SKIP: $compose_file not found"; exit 0; }

have_zfs=1
command -v zfs >/dev/null 2>&1 || have_zfs=0
[ "$have_zfs" -eq 0 ] && echo "WARN: zfs command not found, falling back to plain mkdir -p for all paths"

# Short syntax: "- /ssd/foo/bar:/container/path[:ro]"
# Long syntax:  "source: /ssd/foo/bar"
paths=$(
    {
        grep -oE '^\s*-\s*(/ssd|/hdd)/[^:[:space:]]+' "$compose_file" | sed -E 's#^\s*-\s*##'
        grep -oE 'source:\s*(/ssd|/hdd)/[^[:space:]]+' "$compose_file" | sed -E 's#source:\s*##'
    } | sort -u
)

[ -z "$paths" ] && { echo "No /ssd or /hdd bind mounts found in $compose_file"; exit 0; }

# Is $1 the mountpoint of its own distinct ZFS dataset (not just a plain
# subdirectory living inside some ancestor dataset)?
is_dataset_root() {
    dir="$1"
    [ "$have_zfs" -eq 1 ] || return 1
    mp=$(zfs list -H -o mountpoint "$dir" 2>/dev/null) || return 1
    [ "$mp" = "$dir" ]
}

echo "$paths" | while IFS= read -r path; do
    [ -z "$path" ] && continue
    [ -e "$path" ] && continue  # already exists (file or dir) — never touch it

    ancestor="$path"
    while [ ! -e "$ancestor" ] && [ "$ancestor" != "/" ]; do
        ancestor="$(dirname "$ancestor")"
    done

    if is_dataset_root "$ancestor"; then
        rel="${path#"$ancestor"/}"
        first_component="${rel%%/*}"
        new_ds_path="$ancestor/$first_component"
        new_ds_name="$(zfs list -H -o name "$ancestor")/$first_component"

        if zfs list -H "$new_ds_name" >/dev/null 2>&1; then
            # Dataset already registered but not mounted where expected —
            # don't fight it, just make sure the directory tree exists.
            mkdir -p "$path"
            echo "SKIPPED (dataset exists, not mounted at $new_ds_path): $new_ds_name"
        elif zfs create -o mountpoint="$new_ds_path" "$new_ds_name" 2>/tmp/zfs-create-err.$$; then
            echo "CREATED dataset: $new_ds_name at $new_ds_path"
            mkdir -p "$path"
        else
            echo "WARN: zfs create $new_ds_name failed ($(cat /tmp/zfs-create-err.$$)), falling back to mkdir -p"
            rm -f /tmp/zfs-create-err.$$
            mkdir -p "$path"
            echo "CREATED plain dir: $path"
        fi
    else
        mkdir -p "$path"
        echo "CREATED plain dir: $path"
    fi
done
