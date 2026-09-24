#!/bin/sh
# Snapshot every company to a place the container cannot reach.
#
#   docker/backup.sh [destination]
#
# Run from the HOST, never from inside the factory. The point is that agents
# have a shell and write access to /data — so a copy they can also reach is
# not a backup, it is a second thing to lose. The destination is deliberately
# not mounted into any container.
#
# Nothing here needs Docker: the data directory is a bind mount, so it is
# ordinary files on your disk whether the container is running or not.
set -eu
# Everything this writes holds keys, or vaults they open: owner-only from the
# first byte, not after a chmod.
umask 077

here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# RIFF_DATA and RIFF_KEYS as compose would read them: the environment, else
# $RIFF_ENV, else docker/.env. Without Docker, so read the files here.
from_env_files() {
  for f in "${RIFF_ENV:-}" "$here/.env"; do
    [ -n "$f" ] && [ -f "$f" ] || continue
    v=$(sed -n "s/^[[:space:]]*\(export[[:space:]]*\)\{0,1\}$1=[\"']\{0,1\}\([^\"']*\)[\"']\{0,1\}[[:space:]]*$/\2/p" "$f" | tail -1)
    if [ -n "$v" ]; then printf '%s' "$v"; return 0; fi
  done
  # Found nowhere is an answer, not a failure: under set -e, a non-zero status
  # here ended the script in silence, before anything was made or backed up.
  return 0
}
RIFF_DATA=${RIFF_DATA:-$(from_env_files RIFF_DATA)}
RIFF_KEYS=${RIFF_KEYS:-$(from_env_files RIFF_KEYS)}
DATA="${RIFF_DATA:-$HOME/.riff}"
DATA=${DATA%/}
DEST="${1:-$HOME/riff-backups}"
STAMP=$(date +%Y-%m-%dT%H-%M-%S)

[ -d "$DATA" ] || { echo "No data directory at $DATA" >&2; exit 1; }

mkdir -p "$DEST"
OUT="$DEST/riff-$STAMP.tar.gz"

# Each world is a git repository, so the history is inside the tarball too —
# a backup you can `git log` is worth more than a pile of current files.
tar -czf "$OUT" -C "$(dirname "$DATA")" "$(basename "$DATA")"

# The vault's private key lives beside the data, never in it (the factory mounts
# the data). Without it the vaults in the tarball above cannot be opened, so it
# is backed up too — to its own archive, as sensitive as the old master.key was.
KEYS="${RIFF_KEYS:-$DATA-keys}"
KEYS=${KEYS%/}
if [ -f "$KEYS/vault.key" ]; then
  tar -czf "$DEST/riff-keys-$STAMP.tar.gz" -C "$(dirname "$KEYS")" "$(basename "$KEYS")"
  echo "  vault key → $DEST/riff-keys-$STAMP.tar.gz"
elif ls "$DATA"/secrets/*.vault.json >/dev/null 2>&1 && [ ! -f "$DATA/master.key" ]; then
  # Sealed vaults with no key beside them: this backup cannot restore a secret.
  echo "  NO VAULT KEY at $KEYS/vault.key — the vaults in this backup cannot be opened." >&2
  echo "  Set RIFF_KEYS to where the keyproxy's /keys is mounted from." >&2
  exit 1
fi

SIZE=$(du -h "$OUT" | cut -f1)
COUNT=$(find "$DATA/companies" -maxdepth 1 -mindepth 1 -type d 2>/dev/null | wc -l | tr -d ' ')
echo "  $COUNT compan$([ "$COUNT" = 1 ] && echo y || echo ies) → $OUT ($SIZE)"

# Keep the last 30. Old enough to cover a bad week, few enough to stay small.
ls -1t "$DEST"/riff-2*.tar.gz 2>/dev/null | tail -n +31 | while read -r old; do
  rm -f "$old" "$DEST/riff-keys-${old##*/riff-}"
  echo "  pruned $(basename "$old")"
done
ls -1t "$DEST"/riff-keys-*.tar.gz 2>/dev/null | tail -n +31 | while read -r old; do
  rm -f "$old"
  echo "  pruned $(basename "$old")"
done
