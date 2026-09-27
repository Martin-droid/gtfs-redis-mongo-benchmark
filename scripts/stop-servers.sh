#!/usr/bin/env bash
set -uo pipefail
redis-cli -p 6380 shutdown nosave 2>/dev/null && echo "redis stopped" || echo "redis not running"
mongosh --port 27018 --quiet --eval 'db.getSiblingDB("admin").shutdownServer()' 2>/dev/null || true
echo "mongod stop signalled"
