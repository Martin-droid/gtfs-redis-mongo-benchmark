/**
 * Main benchmark: loads the same GTFS feed into both engines, verifies they
 * return equivalent answers, then times all six trip-planning queries.
 *
 *   node src/bench/run.js [scale]
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { loadFeed, toSeconds } from '../gtfs/parse.js';
import { connectRedis, loadRedis } from '../loaders/redis.js';
import { connectMongo, loadMongo } from '../loaders/mongo.js';
import { redisQueries } from '../queries/redis.js';
import { mongoQueries } from '../queries/mongo.js';
import { measure, assertSameShape } from './harness.js';
import { BENCH, MONGO_DB, DEFAULT_SCALE } from '../config.js';
import { generate } from '../gtfs/generate.js';

const scaleName = process.argv[2] || DEFAULT_SCALE;

function pickers(feed) {
  const stopIds = feed.stops.map((s) => s.stop_id);
  const tripIds = feed.trips.map((t) => t.trip_id);
  const coords = feed.stops.map((s) => ({ lat: Number(s.stop_lat), lon: Number(s.stop_lon) }));
  let i = 0;
  const next = () => i++;
  return {
    stop: () => stopIds[next() % stopIds.length],
    trip: () => tripIds[next() % tripIds.length],
    coord: () => coords[next() % coords.length],
    stopIds,
  };
}

async function main() {
  console.log(`\n=== GTFS benchmark | scale=${scaleName} ===`);
  const stats = generate(scaleName);
  console.log('Feed:', stats);

  const feed = loadFeed();
  const redis = await connectRedis();
  const mongoClient = await connectMongo();
  const db = mongoClient.db(MONGO_DB);

  // ---- ingestion -------------------------------------------------------
  console.log('\nLoading (this is the ingestion benchmark)...');
  const rLoad = await loadRedis(redis, feed);
  console.log(`  redis  ${rLoad.ms.toFixed(0)} ms  (${Math.round(rLoad.records / (rLoad.ms / 1000)).toLocaleString()} stop_times/s)`);
  const mLoad = await loadMongo(mongoClient, feed);
  console.log(`  mongo  ${mLoad.ms.toFixed(0)} ms  (${Math.round(mLoad.records / (mLoad.ms / 1000)).toLocaleString()} stop_times/s)`);

  // ---- memory / storage footprint --------------------------------------
  const rInfo = await redis.info('memory');
  const redisBytes = Number(/used_memory:(\d+)/.exec(rInfo)?.[1] || 0);
  const mStats = await db.command({ dbStats: 1 });
  const footprint = {
    redis_used_memory_bytes: redisBytes,
    mongo_data_size_bytes: mStats.dataSize,
    mongo_storage_size_bytes: mStats.storageSize,
    mongo_index_size_bytes: mStats.indexSize,
  };

  const pick = pickers(feed);
  const NOON = toSeconds('12:00:00');

  // ---- correctness check before timing ---------------------------------
  const sample = pick.stopIds[0];
  const checks = [];
  checks.push(assertSameShape('stopLookup',
    await redisQueries.stopLookup(redis, { stopId: sample }),
    await mongoQueries.stopLookup(db, { stopId: sample })));
  checks.push(assertSameShape('departuresAtStop',
    await redisQueries.departuresAtStop(redis, { stopId: sample, afterSec: NOON }),
    await mongoQueries.departuresAtStop(db, { stopId: sample, afterSec: NOON })));
  checks.push(assertSameShape('tripSchedule',
    await redisQueries.tripSchedule(redis, { tripId: feed.trips[0].trip_id }),
    await mongoQueries.tripSchedule(db, { tripId: feed.trips[0].trip_id })));
  console.log('\nEquivalence check:', checks.map(c => `${c.query}:${c.agree ? 'ok' : 'MISMATCH'}`).join('  '));

  // ---- query benchmarks -------------------------------------------------
  const cases = [
    ['stopLookup',
      () => ({ stopId: pick.stop() })],
    ['stopsNearby',
      () => ({ ...pick.coord(), radiusM: 1500 })],
    ['departuresAtStop',
      () => ({ stopId: pick.stop(), afterSec: NOON, limit: 10 })],
    ['tripSchedule',
      () => ({ tripId: pick.trip() })],
    ['routesServingStop',
      () => ({ stopId: pick.stop() })],
    ['directTrips',
      () => ({ fromStop: pick.stop(), toStop: pick.stop(), afterSec: NOON, limit: 5 })],
  ];

  // directTrips is ~25x heavier than a point read, so it gets fewer iterations
  // to keep the run bounded - but not too few: at 100 samples its winner is not
  // stable run to run, because its variance is far higher than the point reads.
  // A quarter of the budget, floor 300, is enough for a stable median.
  const iterFor = (name) => (name === 'directTrips'
    ? Math.max(300, Math.round(BENCH.iterations / 4))
    : BENCH.iterations);

  const results = [];
  console.log('\nQuery benchmarks:');
  for (const [name, nextArg] of cases) {
    const opts = { warmup: BENCH.warmup, iterations: iterFor(name) };
    const r = await measure((a) => redisQueries[name](redis, a), nextArg, opts);
    const m = await measure((a) => mongoQueries[name](db, a), nextArg, opts);
    results.push({ query: name, iterations: opts.iterations, redis: r, mongo: m });
    const faster = r.p50_ms <= m.p50_ms ? 'redis' : 'mongo';
    const ratio = (Math.max(r.p50_ms, m.p50_ms) / Math.min(r.p50_ms, m.p50_ms)).toFixed(1);
    console.log(
      `  ${name.padEnd(18)} redis p50=${r.p50_ms.toFixed(3)}ms p99=${r.p99_ms.toFixed(3)}  |  ` +
      `mongo p50=${m.p50_ms.toFixed(3)}ms p99=${m.p99_ms.toFixed(3)}  -> ${faster} ${ratio}x`
    );
  }

  const out = {
    generated_at: new Date().toISOString(),
    node: process.version,
    platform: `${process.platform}/${process.arch}`,
    scale: scaleName,
    feed: stats,
    bench: { warmup: BENCH.warmup, iterations: BENCH.iterations },
    ingestion: {
      redis_ms: +rLoad.ms.toFixed(1),
      mongo_ms: +mLoad.ms.toFixed(1),
      redis_rows_per_sec: Math.round(rLoad.records / (rLoad.ms / 1000)),
      mongo_rows_per_sec: Math.round(mLoad.records / (mLoad.ms / 1000)),
    },
    footprint,
    equivalence: checks,
    queries: results,
  };

  mkdirSync('results', { recursive: true });
  writeFileSync(`results/benchmark-${scaleName}.json`, JSON.stringify(out, null, 2));
  console.log(`\nWrote results/benchmark-${scaleName}.json`);

  await redis.quit();
  await mongoClient.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
