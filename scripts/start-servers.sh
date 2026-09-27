#!/usr/bin/env bash
# Boots a Redis and a MongoDB instance dedicated to this benchmark.
# Non-default ports (6380 / 27018) so nothing you already run is touched.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RT="$ROOT/.runtime"
mkdir -p "$RT/redis" "$RT/mongo"

MONGOD="${MONGOD_BIN:-$(find "$HOME/.cache/mongodb-binaries" -name 'mongod*' -type f 2>/dev/null | head -1)}"
if [ -z "${MONGOD:-}" ] || [ ! -x "$MONGOD" ]; then
  echo "mongod not found. Set MONGOD_BIN=/path/to/mongod, or install MongoDB." >&2
  exit 1
fi

if ! lsof -iTCP:6380 -sTCP:LISTEN >/dev/null 2>&1; then
  redis-server --port 6380 --daemonize yes --save '' --appendonly no \
    --dir "$RT/redis" --logfile "$RT/redis/redis.log"
  echo "redis-server up on 6380"
else
  echo "redis already listening on 6380"
fi

if ! lsof -iTCP:27018 -sTCP:LISTEN >/dev/null 2>&1; then
  # macOS builds reject --fork, so background it and wait for the port.
  nohup "$MONGOD" --port 27018 --dbpath "$RT/mongo" \
    --logpath "$RT/mongo/mongod.log" --bind_ip 127.0.0.1 >/dev/null 2>&1 &
  echo $! > "$RT/mongo/mongod.pid"
  for _ in $(seq 1 60); do
    lsof -iTCP:27018 -sTCP:LISTEN >/dev/null 2>&1 && break
    perl -e 'select(undef,undef,undef,0.5)'
  done
  if lsof -iTCP:27018 -sTCP:LISTEN >/dev/null 2>&1; then
    echo "mongod up on 27018"
  else
    echo "mongod failed to start; see $RT/mongo/mongod.log" >&2; exit 1
  fi
else
  echo "mongod already listening on 27018"
fi
