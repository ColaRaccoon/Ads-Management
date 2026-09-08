#!/bin/sh
set -eu
umask 077
cp /run/secrets/input.pgpass /tmp/pgpass
chmod 0600 /tmp/pgpass
export PGPASSFILE=/tmp/pgpass
set +e
psql "$@" >/tmp/psql.stdout 2>/tmp/psql.stderr
status=$?
set -e
stdout_bytes=$(wc -c </tmp/psql.stdout)
stderr_bytes=$(wc -c </tmp/psql.stderr)
if [ "$stdout_bytes" -gt 65536 ] || [ "$stderr_bytes" -gt 65536 ]; then
  echo R2A_PSQL_OUTPUT_LIMIT_EXCEEDED >&2
  exit 125
fi
cat /tmp/psql.stdout
cat /tmp/psql.stderr >&2
exit "$status"
