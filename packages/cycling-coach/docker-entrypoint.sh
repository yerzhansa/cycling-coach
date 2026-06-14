#!/bin/sh
set -e

# Platforms like Railway mount the persistent volume at $CYCLING_COACH_HOME owned
# by root, overlaying the build-time directory. The app runs as the non-root
# `node` user and locks the data dir to 0700, so it must own it. Start as root,
# hand the volume to `node`, then drop privileges for the actual process.
DATA_DIR="${CYCLING_COACH_HOME:-/data}"

if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA_DIR"
  chown -R node:node "$DATA_DIR"
  exec su-exec node "$@"
fi

exec "$@"
