# Application-Based Benchmarking: Redis vs MongoDB for GTFS Trip Planning

A runnable benchmark that loads the same GTFS transit feed into **Redis** and **MongoDB**,
verifies both return equivalent answers, then measures six real trip-planning queries at
three dataset sizes.

Every number in [`REPORT.md`](REPORT.md) was produced by the code in this repo. Nothing is
estimated — re-run it and you get your own numbers.

---

## What's here

| Path | Purpose |
|---|---|
| `src/gtfs/generate.js` | Seeded, GTFS-spec-compliant feed generator (3 size presets) |
| `src/gtfs/parse.js` | GTFS CSV reader + `HH:MM:SS` → seconds |
| `src/loaders/redis.js` | Redis data model + bulk load |
| `src/loaders/mongo.js` | MongoDB collections, indexes + bulk load |
| `src/queries/redis.js` | The six trip-planning queries, Redis |
| `src/queries/mongo.js` | The same six queries, MongoDB |
| `src/bench/harness.js` | Timing, percentiles, equivalence checking |
| `src/bench/run.js` | Main benchmark (one scale) |
| `src/bench/scale.js` | Scalability sweep (all scales) |
| `app/` | Working trip-planner API + UI, switchable between engines |
| `results/` | Committed benchmark output (JSON) |
| `REPORT.md` | **The written answers to all 8 checkpoint sections** |

---

## Requirements

- Node.js ≥ 18
- `redis-server` on your PATH
- A `mongod` binary — either installed, or set `MONGOD_BIN=/path/to/mongod`

The start script binds Redis to **6380** and MongoDB to **27018**, deliberately off the
default ports so it never touches an instance you already run.

## Run it

```bash
npm install
npm run servers:start     # redis on 6380, mongod on 27018
npm run bench             # generate feed + load + benchmark (medium scale)
npm run bench:scale       # sweep small -> medium -> large
npm run servers:stop
```

Tune the run with env vars:

```bash
ITERATIONS=2000 WARMUP=200 node src/bench/run.js large
```

## Try the trip planner

```bash
npm run bench             # loads data into both engines first
npm run app               # http://127.0.0.1:3000
```

The UI has an engine switch. Every response reports its own query time, so you can compare
Redis and MongoDB on the identical query, live:

```bash
curl "http://127.0.0.1:3000/api/plan?engine=redis&from=S00000&to=S00005&after=06:00:00"
curl "http://127.0.0.1:3000/api/plan?engine=mongo&from=S00000&to=S00005&after=06:00:00"
```

Both return the same trips — the benchmark asserts equivalence before timing anything.

---

## The six queries

| Query | What a planner uses it for | Redis structure | MongoDB access path |
|---|---|---|---|
| `stopLookup` | Show stop details | `HGETALL stop:{id}` | `_id` lookup |
| `stopsNearby` | "Stops near me" | `GEOSEARCH` | `2dsphere` + `$near` |
| `departuresAtStop` | Departure board | `ZRANGEBYSCORE` on departure secs | `{stop_id, departure_sec}` index |
| `tripSchedule` | Full route timetable | `ZRANGE trip:{id}:stops` | `{trip_id, stop_sequence}` index |
| `routesServingStop` | Which lines stop here | `SMEMBERS` | `distinct(route_id)` |
| `directTrips` | **Plan A → B after time T** | client-side join | server-side `$lookup` |

## On fairness

Redis is in-memory; MongoDB is disk-backed and durable. A raw latency comparison flatters
Redis, so the report states that plainly and compares **footprint and durability** alongside
speed. Both engines run on the same machine over loopback, with identical data, identical
query semantics, and the same warmup and iteration counts. Latency is measured per
round trip (sequential, not pipelined), and reported as percentiles because tail latency is
what a user actually feels.

## Licence

MIT
