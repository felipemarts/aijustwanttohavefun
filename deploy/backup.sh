#!/bin/sh
# Daily Postgres backup with retention (docs/DEPLOY.md, "Backups").
#
#   DATABASE_URL=postgres://user:pass@host:5432/ajwf BACKUP_DIR=/var/backups/ajwf BACKUP_KEEP_DAYS=14 ./deploy/backup.sh
#
# Writes a compressed custom-format dump (pg_dump -Fc), checks that it can be read back (pg_restore --list), and
# deletes dumps older than BACKUP_KEEP_DAYS. Needs pg_dump/pg_restore of the server's major version or newer.
# Restore (into an empty database, with the game server stopped):
#   pg_restore --clean --if-exists --no-owner -d "$DATABASE_URL" /var/backups/ajwf/ajwf-20260101-030000.dump
set -eu

: "${DATABASE_URL:?DATABASE_URL is required}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/ajwf}"
BACKUP_KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"

mkdir -p "$BACKUP_DIR"
stamp="$(date -u +%Y%m%d-%H%M%S)"
final="$BACKUP_DIR/ajwf-$stamp.dump"
partial="$final.partial"

# The snapshot is consistent: pg_dump reads one transaction. The game keeps running meanwhile.
pg_dump --format=custom --compress=6 --no-owner --dbname="$DATABASE_URL" --file="$partial"
pg_restore --list "$partial" > /dev/null
mv "$partial" "$final"
echo "backup: wrote $final ($(du -h "$final" | cut -f1))"

# Retention: keep the last BACKUP_KEEP_DAYS days, never the newest dump.
find "$BACKUP_DIR" -name 'ajwf-*.dump' -type f -mtime "+$BACKUP_KEEP_DAYS" ! -name "$(basename "$final")" -print -delete
find "$BACKUP_DIR" -name 'ajwf-*.dump.partial' -type f -mmin +60 -delete
