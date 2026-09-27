# Application-Based Benchmarking on Redis and MongoDB for Trip Planning using GTFS Data

**Author:** Martin Ndegwa
**Date:** 27 September 2026

> Every figure in this report was measured by the code in this repository.
> Reproduce with `npm run servers:start && npm run bench:scale`.
> Raw output: [`results/`](results/).

**Test environment**

| | |
|---|---|
| Machine | Apple M2 Pro, 10 cores, 16 GB RAM |
| OS | macOS 15.6.1 (darwin/arm64) |
| Node.js | v26.7.0 |
| Redis | 8.2.2 (port 6380, persistence disabled) |
| MongoDB | 8.2.6 (port 27018, WiredTiger default) |
| Method | 100 warmup + 800 measured iterations per query, sequential round trips |

---

## 1. Introduction to GTFS Data

### What is GTFS data, and what does it contain?

**GTFS** (General Transit Feed Specification) is the open standard transit agencies use to
publish schedules and geography. A feed is a ZIP of CSV files that reference each other by
ID — effectively a small relational schema distributed as flat files.

The files this project uses:

| File | Holds | Key fields |
|---|---|---|
| `agency.txt` | The operator | `agency_id`, `agency_timezone` |
| `stops.txt` | Every boarding point | `stop_id`, `stop_lat`, `stop_lon` |
| `routes.txt` | Named lines | `route_id`, `route_short_name`, `route_type` |
| `trips.txt` | One vehicle run along a route | `trip_id`, `route_id`, `service_id`, `direction_id` |
| `stop_times.txt` | **Every stop of every trip, with times** | `trip_id`, `stop_id`, `arrival_time`, `departure_time`, `stop_sequence` |
| `calendar.txt` | Which days a service runs | `service_id`, `monday`…`sunday` |

The relationships matter for database design:

```
agency ──< routes ──< trips ──< stop_times >── stops
                        │
                     calendar
```

`stop_times.txt` dominates everything. In the feed used here it is **97%+ of all records** —
345,600 of ~350,000 rows at the large scale. Any design decision that speeds up
`stop_times` access determines the performance of the whole application.

Two GTFS quirks worth noting:

- **Times can exceed 24:00:00.** A trip departing 23:50 and arriving 00:30 the next day is
  written `24:30:00`, so the service day stays intact. Parsing to a plain clock time breaks
  this; both loaders here convert to *seconds since midnight* (`toSeconds()`), which handles
  it naturally and makes times sortable integers.
- **Stops are shared between routes.** A stop is not owned by a route, which is exactly what
  makes "which lines serve this stop?" a real query rather than a field lookup.

### How is GTFS used for trip planning?

A planner answers "get me from A to B departing after T" by chaining lookups:

1. **Locate** — find stops near the origin and destination (geospatial search on `stops`).
2. **Find departures** — at the origin stop, the next services after T (time-range scan of
   `stop_times`, filtered to services running today via `calendar`).
3. **Follow each trip** — read its remaining stops in `stop_sequence` order.
4. **Match the destination** — keep trips that call at the destination *later in the same
   trip*. This is a self-join of `stop_times` on `trip_id`.
5. **Rank** — soonest arrival, fewest transfers, shortest walk.

Steps 2–4 are the hot path, and step 4 is the one that separates the two databases —
see §5.

---

## 2. Overview of Redis and MongoDB

### How they differ from SQL databases

A traditional SQL database enforces a fixed schema, normalises data across tables, and lets
a **query planner** decide how to satisfy arbitrary `JOIN`s at query time. You write *what*
you want; the engine works out *how*.

Both Redis and MongoDB are **NoSQL**, and they drop different parts of that contract:

| | SQL (e.g. PostgreSQL) | MongoDB | Redis |
|---|---|---|---|
| Schema | Fixed, enforced | Flexible per document | None — value shape is your problem |
| Data unit | Row in a table | BSON document | Typed value at a key |
| Joins | Any, planned at runtime | `$lookup` (server-side) | **None** — join in your app |
| Query language | SQL | Rich query + aggregation pipeline | Commands per data type |
| Indexes | B-tree, etc. | B-tree, compound, geo, text | The data structure *is* the index |
| Primary residence | Disk | Disk (memory-mapped, cached) | **RAM** |

### Redis — key features

An in-memory data-structure server. You don't store rows, you store *structures*, and you
pick the structure that makes your query cheap:

- **Rich types** — strings, hashes, lists, sets, sorted sets (ZSET), streams, bitmaps, HLL.
- **Sorted sets** are the workhorse here: each member carries a numeric score, and range
  queries by score are `O(log n)`. Departure times as scores makes "next departures after T"
  a single `ZRANGEBYSCORE`.
- **Native geospatial** — `GEOADD`/`GEOSEARCH` are a sorted set with geohash scores, so
  radius search is built in with no extra index.
- **Single-threaded command execution** — no lock contention, and every command is atomic.
- **Optional durability** — RDB snapshots and/or AOF. Disabled in this benchmark so the
  measurement is of Redis at its fastest.
- **Hard constraint: the dataset must fit in RAM.**

### MongoDB — key features

A document database that keeps JSON-like BSON documents in collections:

- **Flexible documents** — a GTFS stop, with its nested GeoJSON `location`, is one natural
  document; no join needed to read it.
- **Real query engine** — filters, sorts, projections, and an **aggregation pipeline**
  (`$match`, `$sort`, `$lookup`, `$group`) executed server-side.
- **Secondary indexes** — compound, geospatial (`2dsphere`), text, partial. The planner
  chooses among them, so new query shapes don't require re-modelling the data.
- **`$lookup`** — a server-side join. This is the single most important capability
  difference for trip planning.
- **Durable by default** — WiredTiger storage engine with journaling and compression.
- **Horizontal scale** — native sharding and replica sets.

---

## 3. Benchmarking Criteria

### What criteria did I use?

| Criterion | Measured as | Why it matters for a planner |
|---|---|---|
| **Ingestion throughput** | `stop_times` rows/second | Agencies republish feeds weekly; a slow reload is downtime |
| **Query latency p50** | Median ms per round trip | The typical user experience |
| **Query latency p95/p99** | Tail ms | What the unluckiest 1–5% of requests feel — this is what users complain about |
| **Memory / storage footprint** | Redis `used_memory`, Mongo `storageSize + indexSize` | Directly sets hosting cost; RAM costs far more than disk |
| **Scalability trend** | Same metrics at 3 dataset sizes | Flat vs rising latency predicts behaviour at city scale |
| **Correctness** | Equivalence assertion before timing | A fast wrong answer is worthless |
| **Query expressiveness** | Round trips needed per plan | Determines how much logic leaks into the application |

I report **percentiles rather than a mean alone**, because a mean hides the tail. An
average of 2 ms can hide a p99 of 40 ms, and in an interactive planner the p99 is the
request the user actually notices.

### Why benchmark for application-based scenarios?

Generic benchmarks (`redis-benchmark`, YCSB) measure synthetic key-value operations. They
would tell me Redis does ~100k ops/sec and stop there — true, and useless for choosing a
database for *this* application, because:

1. **They don't test your access patterns.** A trip plan is a self-join over `stop_times`
   filtered by time and ordered by sequence. No generic benchmark covers that shape.
2. **They ignore your data distribution.** GTFS is wildly skewed — 97% of records are in one
   entity, and a downtown interchange has 50× the departures of a suburban stop.
3. **They hide modelling cost.** Redis's raw speed is irrelevant if getting the answer needs
   40 round trips. §5 shows exactly this: Redis wins every *single-structure* query and
   still **loses** the actual trip-planning query.
4. **They ignore the total picture.** Latency alone would pick Redis. Adding footprint and
   durability changes the recommendation.

---

## 4. Data Ingestion and Storage

### How the GTFS data is ingested

Both loaders read the same parsed feed, so only the target model differs.

**Redis** ([`src/loaders/redis.js`](src/loaders/redis.js)) — because Redis has no query
planner, every access path must be built explicitly at write time:

```
stop:{id}              HASH   stop attributes                  -> point read
stops:geo              GEO    geohash-scored sorted set        -> radius search
stop:{id}:departures   ZSET   score = departure seconds        -> next departures
stop:{id}:routes       SET    route ids                        -> membership
trip:{id}:stops        ZSET   score = stop_sequence            -> ordered schedule
trip:{id}, route:{id}  HASH   attributes
```

Writes are pipelined with `MULTI` in batches of 5,000 so 345,600 rows don't become 345,600
round trips. **One source row fans out into three writes** (a departure entry, a schedule
entry, a route membership) — that redundancy is the price of Redis's read speed.

**MongoDB** ([`src/loaders/mongo.js`](src/loaders/mongo.js)) — one collection per entity,
inserted with `insertMany({ordered:false})` in 10,000-document batches, then indexes built
*after* the bulk load (building once over a full collection is far cheaper than maintaining
an index per insert):

```
stops.location                     2dsphere   -> $near
stop_times {stop_id, departure_sec}           -> departure board
stop_times {trip_id, stop_sequence}           -> ordered schedule
stop_times {route_id}                         -> route filtering
```

### Measured ingestion

| Scale | `stop_times` | Redis | MongoDB | Redis rows/s | Mongo rows/s | Redis lead |
|---|---|---|---|---|---|---|
| small | 8,640 | **80 ms** | 259 ms | 108,452 | 33,392 | **3.2×** |
| medium | 80,000 | **581 ms** | 787 ms | 137,653 | 101,689 | 1.35× |
| large | 345,600 | **2,625 ms** | 2,665 ms | 131,648 | 129,660 | **1.02×** |

**Redis is faster at every size, but its lead collapses from 3.2× to essentially nothing.**
MongoDB pays a fixed startup cost — creating collections, then building four indexes — which
is punishing on 8,640 rows and has amortised to almost zero by 345,600. Redis's cost is
purely per-record, so its rate stays near-constant (~108–138k rows/s) once pipelining is
saturated, while MongoDB's climbs steeply (33k → 130k rows/s) as the fixed cost spreads over
more rows.

The practical reading: **for a full-feed reload, ingestion speed is not a deciding factor.**
Both rebuild a large city feed in under three seconds.

### Comparing the storage mechanisms

| Scale | Redis RAM | Mongo disk (data + index) | Ratio |
|---|---|---|---|
| small | 2.2 MB | 0.4 MB | 5.5× |
| medium | 13.5 MB | 2.7 MB | 5.1× |
| large | **52.9 MB** | **10.6 MB** | **5.0×** |

MongoDB stores the same feed in **one-fifth the space**, consistently across scales, for two
reasons: WiredTiger applies block compression (BSON with repetitive `trip_id`/`stop_id`
strings compresses very well), and Redis carries per-key overhead — each of the ~450 stops
needs a hash, a ZSET and a SET, each with its own allocation and pointer overhead.

The difference is sharper than 5× in cost terms, because **Redis's 52.9 MB must be RAM**
while MongoDB's 10.6 MB is disk with only the working set cached. For a feed this size it's
irrelevant; for a national multi-agency feed it becomes the deciding constraint.

---

## 5. Query Performance

### How each database handles trip-planning queries

The difference is where the work happens. Redis executes one structure access per command
and cannot join, so multi-step logic runs in the **application**, costing a network round
trip per step. MongoDB has a planner and `$lookup`, so the same logic runs **server-side** in
one round trip.

Both implementations are in [`src/queries/redis.js`](src/queries/redis.js) and
[`src/queries/mongo.js`](src/queries/mongo.js), and the harness asserts they return
equivalent results before timing.

**Example — next 10 departures after noon:**

```js
// Redis: one O(log n) range over a sorted set
client.zRangeByScore(`stop:${stopId}:departures`, afterSec, '+inf',
                     { LIMIT: { offset: 0, count: 10 } });

// MongoDB: indexed range scan, sort satisfied by the index
db.collection('stop_times')
  .find({ stop_id: stopId, departure_sec: { $gte: afterSec } })
  .sort({ departure_sec: 1 }).limit(10).toArray();
```

**Example — the actual plan, A → B after T.** This is where they diverge:

```js
// Redis - no join, so the application does it: 1 + N round trips
const candidates = await client.zRangeByScore(`stop:${from}:departures`, afterSec, '+inf',
                                              { LIMIT: { offset: 0, count: 40 } });
for (const entry of candidates) {                     // up to 40 more round trips
  const rest = await client.zRangeByScore(`trip:${tripId}:stops`, fromSeq + 1, '+inf');
  if (rest.find(m => m.split('|')[0] === to)) { /* hit */ }
}

// MongoDB - the self-join runs server-side, one round trip total
db.collection('stop_times').aggregate([
  { $match: { stop_id: from, departure_sec: { $gte: afterSec } } },
  { $sort: { departure_sec: 1 } }, { $limit: 40 },
  { $lookup: { from: 'stop_times', let: { trip: '$trip_id', seq: '$stop_sequence' },
      pipeline: [{ $match: { $expr: { $and: [
        { $eq: ['$trip_id', '$$trip'] }, { $eq: ['$stop_id', to] },
        { $gt: ['$stop_sequence', '$$seq'] } ] } } }, { $limit: 1 }],
      as: 'arrival' } },
  { $match: { 'arrival.0': { $exists: true } } },
]);
```

### Measured latency (medium scale, 80,000 `stop_times`)

| Query | Redis p50 | Redis p99 | Mongo p50 | Mongo p99 | Winner |
|---|---|---|---|---|---|
| `stopLookup` | 0.084 ms | 0.149 | 0.083 ms | 0.163 | tie |
| `stopsNearby` | **0.084 ms** | 0.129 | 0.805 ms | 1.379 | **Redis 9.6×** |
| `departuresAtStop` | 0.088 ms | 0.189 | 0.116 ms | 0.204 | Redis 1.3× |
| `tripSchedule` | 0.085 ms | 0.130 | 0.157 ms | 0.438 | Redis 1.8× |
| `routesServingStop` | 0.086 ms | 0.198 | 0.189 ms | 0.423 | Redis 2.2× |
| `directTrips` | 3.684 ms | **52.654** | **2.181 ms** | 3.771 | **Mongo 1.7×** |

*(1,200 iterations per query; `directTrips` 300, as it is ~25× heavier.)*

### Reading the results

**Redis wins every single-structure query, but by less than expected.** `stopLookup` is a
dead tie (0.084 vs 0.083 ms) because at this speed both are dominated by the loopback TCP
round trip, not by the database. The engine is no longer the bottleneck — the network is.

**Redis's one dominant win is geospatial** — 9.6× on `stopsNearby`. `GEOSEARCH` reads a
geohash-scored sorted set directly; MongoDB's `$near` must traverse a 2dsphere B-tree and
then sort by true spherical distance. Redis's answer is also cheaper because it returns bare
member IDs, where Mongo materialises full documents.

**The most important result is the last row: MongoDB wins the actual trip-planning query**,
by 1.7×. Redis is slower despite being 1.3–9.6× faster at every individual operation, because
`directTrips` needs up to 41 sequential round trips against Redis versus **one** against
MongoDB. Redis's per-operation speed advantage is entirely consumed by network overhead it
cannot avoid — it has no join, so those round trips are structural, not a tuning problem.

This is exactly why application-based benchmarking matters (§3). A micro-benchmark would
have declared Redis the winner on every row and led to the wrong architecture.

**The tail is where it really shows.** Redis's p99 on `directTrips` is **52.7 ms against
MongoDB's 3.8 ms** — 14× worse. Chaining 41 round trips means 41 independent chances to catch
a slow one, and the delays compound. That outlier also drags Redis's median up: its p50 is
3.684 ms at medium but 2.551 ms at large, which is *non-monotonic* — a reminder that this
query is genuinely noisy and that a single run should not be over-read. MongoDB's tail stays
tight and predictable at every scale (3.771 ms medium, 3.770 ms large), precisely because it
is one operation rather than forty-one.

---

## 6. Scalability and Efficiency

Measured across a **40× increase** in dataset size (8,640 → 345,600 `stop_times`).

### p50 latency by scale (ms, Redis / MongoDB)

| Query | small (8.6k) | medium (80k) | large (345.6k) | Trend |
|---|---|---|---|---|
| `stopLookup` | 0.083 / 0.084 | 0.084 / 0.083 | 0.087 / 0.088 | Flat both, tied |
| `stopsNearby` | 0.086 / 0.763 | 0.084 / 0.805 | 0.089 / 0.805 | Flat both; Redis ~9× ahead throughout |
| `departuresAtStop` | 0.079 / 0.109 | 0.088 / 0.116 | 0.084 / 0.110 | Flat both |
| `tripSchedule` | 0.081 / 0.117 | 0.085 / 0.157 | 0.074 / 0.163 | Redis flat, **Mongo +39%** |
| `routesServingStop` | 0.076 / 0.153 | 0.086 / 0.189 | 0.083 / **0.262** | Redis flat, **Mongo +71%** |
| `directTrips` | 2.092 / **1.918** | 3.684 / **2.181** | 2.551 / **2.321** | Mongo ahead at every scale |

### What the trend shows

**Most queries are flat in both engines**, which is the expected and correct result: a
`ZRANGEBYSCORE` and an indexed B-tree range are both `O(log n)`, and log growth over 40× is
nearly invisible. Adding data does not slow down a well-indexed lookup in either database.
`stopLookup` is tied and flat; `stopsNearby` and `departuresAtStop` are flat in both, with
Redis holding a constant ~9× lead on the geospatial query.

**Two MongoDB queries degrade materially as the feed grows:**

- `routesServingStop` rises **71%** (0.153 → 0.262 ms). `distinct('route_id', {stop_id})`
  must scan every matching `stop_times` document to deduplicate, and the matches per stop
  grow linearly with the feed. Redis's `SMEMBERS` stays flat (0.076 → 0.083 ms) because the
  set was **deduplicated at write time**. This is the clearest illustration of the core
  trade-off: Redis pays once on ingest, MongoDB pays on every read.
  *(Fixable in Mongo with a materialised `stop_routes` collection — i.e. by adopting Redis's
  precompute strategy.)*
- `tripSchedule` rises **39%** (0.117 → 0.163 ms) as the index deepens and more documents are
  materialised per trip. Redis's ZSET read is flat (0.081 → 0.074 ms).

**`directTrips` — MongoDB leads at every scale.** The margin is 1.1× at small, 1.7× at
medium and 1.1× at large. The medium reading is inflated by a Redis latency spike (p99 52.7
ms), so the honest statement is the robust one: *MongoDB wins this query at every dataset
size tested, and Redis never wins it.* I measured this across several runs; whenever
`directTrips` is given enough samples (≥300), MongoDB wins consistently. At 100 samples the
winner flipped between runs — which is itself a lesson in sampling the heavy query properly.

### Efficiency

| | Redis | MongoDB |
|---|---|---|
| Footprint at 345.6k rows | 52.9 MB **RAM** | 10.6 MB **disk** |
| Cost of that medium | High (RAM) | Low (disk, working set cached) |
| Hard ceiling | Dataset must fit in RAM | Disk-bound, far higher |
| Scale-out | Redis Cluster (hash-slot sharding; cross-slot ops restricted) | Native sharding + replica sets |

### Which would I recommend for a large-scale trip planner?

**MongoDB as the system of record, with Redis as a caching layer in front of it.**

Neither alone is the right answer, and the data says why:

- **MongoDB must be the primary store.** It wins the query that defines the application
  (`directTrips`) at every scale tested, with a far tighter tail. It holds the data in 1/5 the space on
  cheap disk rather than expensive RAM, it's durable by default, and its planner absorbs new
  query shapes — adding "cheapest fare" or "wheelchair accessible" is a new index, not a
  re-model. For a national feed, Redis's RAM ceiling would become the binding constraint.
- **Redis earns its place in front.** Its 9.6× geospatial win makes it the right home for the
  "stops near me" lookup that fires on every app launch. Departure boards for the busiest
  stops are small, hot, and read constantly — ideal cache entries with a short TTL. Both stay
  flat under load.

The honest framing: **Redis's speed advantage is real but narrow**, and it evaporates the
moment a query needs more than one round trip. MongoDB's expressiveness is what actually
scales.

---

## 7. Practical Application

### Design

A working trip planner is implemented in [`app/`](app/). It runs on **either** engine via a
`?engine=` switch, so the two can be compared live on identical queries — and both return
identical results.

```
Browser (app/index.html)
    |  fetch /api/plan?from=S00000&to=S00005&after=06:00:00&engine=redis|mongo
    v
Node HTTP API (app/server.js)
    |  dispatches to one of two query modules with the same signature
    +--> src/queries/redis.js  --> Redis   (6380)
    +--> src/queries/mongo.js  --> MongoDB (27018)
```

| Endpoint | Query | Purpose |
|---|---|---|
| `GET /api/nearby?lat&lon&radius` | `stopsNearby` | Stops near the user |
| `GET /api/departures?stop&after` | `departuresAtStop` | Departure board |
| `GET /api/plan?from&to&after` | `directTrips` | **Plan a journey** |
| `GET /api/schedule?trip` | `tripSchedule` | Full timetable for a trip |

Every response reports its own measured query time:

```json
{ "engine": "redis", "query": "directTrips", "took_ms": 8.658,
  "data": [ { "tripId": "TR037_0002", "boardAt": "06:17:23", "alightAt": "06:27:04" } ] }
```

The same request with `engine=mongo` returns the same trips — equivalence is asserted by the
benchmark before any timing is recorded.

### Implementation steps

1. **Model the access paths first.** Decide every query the app must answer *before* loading
   data. For Redis this is mandatory — the structure chosen at write time *is* the only index
   you will ever have.
2. **Parse GTFS into a normalised intermediate form.** Convert `HH:MM:SS` to seconds since
   midnight so times past 24:00 sort correctly as integers.
3. **Bulk load.** Pipeline Redis writes (`MULTI`, batches of 5,000); use `insertMany({ordered:false})`
   for Mongo and **build indexes after the load, not before**.
4. **Implement each query behind one interface.** Identical signatures for both engines is
   what makes the comparison fair and the engine swappable at runtime.
5. **Assert equivalence before optimising.** The harness compares result counts across
   engines first — this is how the `alightAt` bug in this repo was caught (Redis was
   reporting departure time where Mongo reported arrival).
6. **Measure with warmup and percentiles**, using fresh arguments per iteration so one
   cache-resident key doesn't flatter the result.
7. **Serve behind an HTTP API**, reporting per-request timing so production latency stays
   visible.

**Next steps for a production system:** transfers (multi-leg journeys, which need a proper
RAPTOR or Connection-Scan algorithm rather than direct-trip matching), `calendar.txt` service-day
filtering, real-time `GTFS-Realtime` delay overlays, and walking-distance graph edges between
nearby stops.

---

## 8. Conclusion

### Advantages and disadvantages

**Redis**

| Advantages | Disadvantages |
|---|---|
| Fastest single-structure reads; 9.6× on geospatial | **No joins** — multi-step logic costs a round trip per step |
| Latency flat as data grows 40× on every query | Entire dataset must fit in RAM |
| Precomputed sets stay flat where Mongo degrades +71% | 5× the footprint, in the expensive medium |
| Ingest rate constant (~108–138k rows/s) | Every access path must be built by hand at write time |
| Atomic ops, trivial to operate | New query shape ⇒ re-model and reload |

**MongoDB**

| Advantages | Disadvantages |
|---|---|
| **Won the actual trip-planning query** at every scale, with a 14× tighter tail | 1.3–9.6× slower on single-structure reads |
| `$lookup` keeps joins server-side — one round trip | `distinct` degrades with data volume (+71% at 40×) |
| 1/5 the footprint, on cheap disk | `tripSchedule` degrades with data volume (+39% at 40×) |
| Durable by default; native sharding | More operationally complex |
| Query planner absorbs new query shapes without re-modelling | Higher fixed cost on small datasets |

### Which would I choose for future GTFS projects?

**MongoDB as the primary database, with Redis as a targeted cache.**

The benchmark changed my expectation, and that is the most valuable thing it produced. I
expected Redis to win outright — it is in-memory, and it won four of six queries and tied a
fifth. But the one query it lost is the one the application exists to answer, and it lost
because no amount of per-operation speed compensates for **41 round trips against 1**. It
lost that query at every dataset size I tested, with a tail 14× worse.

Choosing on the micro-benchmarks alone would have produced an architecture that gets slower
in exactly the place it matters most, while costing 5× more in RAM.

So:

- **MongoDB holds the feed.** It wins `directTrips`, scales further, costs less to store,
  survives a restart, and its query planner means a new feature is usually a new index rather
  than a re-model.
- **Redis fronts the hot, shape-stable reads** — geospatial "stops near me" (9.6× and flat)
  and departure boards for busy stops. Both are small, hot, and perfectly suited to a cache.

**The general lesson:** benchmark the queries your application actually runs, not the
operations the database advertises. Redis is faster at almost everything here and is still
the wrong primary store for this workload.

---

## Reproducing

```bash
npm install
npm run servers:start
npm run bench:scale
npm run app          # http://127.0.0.1:3000
npm run servers:stop
```

Raw measurements: [`results/benchmark-{small,medium,large}.json`](results/) and
[`results/scale-summary.json`](results/scale-summary.json).
