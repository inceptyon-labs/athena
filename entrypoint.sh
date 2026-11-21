#!/bin/sh
# Athena never runs as root. Started as root (Unraid, a plain `docker run`), it first gives the data folder to
# PUID:PGID, 99:100 by default (Unraid's nobody:users), then drops to that user.
set -e
if [ "$(id -u)" = 0 ]; then
	mkdir -p "$ATHENA_DATA"
	chown -R "${PUID:-99}:${PGID:-100}" "$ATHENA_DATA"
	chmod 700 "$ATHENA_DATA"
	exec setpriv --reuid="${PUID:-99}" --regid="${PGID:-100}" --clear-groups "$@"
fi
exec "$@"
