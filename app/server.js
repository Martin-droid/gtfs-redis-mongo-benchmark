/**
 * A working trip-planning API over the loaded GTFS feed.
 *
 * Every endpoint accepts ?engine=redis|mongo and runs the identical query
 * against that database, so the two implementations can be compared live - and
 * each response reports how long its own query took.
 *
 *   npm run app   ->  http://127.0.0.1:3000
 */
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { connectRedis } from '../src/loaders/redis.js';
import { connectMongo } from '../src/loaders/mongo.js';
import { redisQueries } from '../src/queries/redis.js';
import { mongoQueries } from '../src/queries/mongo.js';
import { MONGO_DB } from '../src/config.js';
import { toSeconds } from '../src/gtfs/parse.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);

const redis = await connectRedis();
const mongoClient = await connectMongo();
const mongoDb = mongoClient.db(MONGO_DB);

/** Runs `name` on the chosen engine and times it. */
async function run(engine, name, args) {
  const t = performance.now();
  const data = engine === 'mongo'
    ? await mongoQueries[name](mongoDb, args)
    : await redisQueries[name](redis, args);
  return { engine, query: name, took_ms: +(performance.now() - t).toFixed(3), data };
}

const json = (res, code, body) => {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body, null, 2));
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const q = url.searchParams;
  const engine = q.get('engine') === 'mongo' ? 'mongo' : 'redis';
  const after = q.get('after') ? toSeconds(q.get('after')) : toSeconds('12:00:00');

  try {
    if (url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end(readFileSync(join(__dirname, 'index.html')));
    }

    if (url.pathname === '/api/nearby') {
      return json(res, 200, await run(engine, 'stopsNearby', {
        lat: Number(q.get('lat')), lon: Number(q.get('lon')),
        radiusM: Number(q.get('radius') || 1500),
      }));
    }

    if (url.pathname === '/api/departures') {
      return json(res, 200, await run(engine, 'departuresAtStop', {
        stopId: q.get('stop'), afterSec: after, limit: Number(q.get('limit') || 10),
      }));
    }

    if (url.pathname === '/api/plan') {
      return json(res, 200, await run(engine, 'directTrips', {
        fromStop: q.get('from'), toStop: q.get('to'), afterSec: after, limit: 5,
      }));
    }

    if (url.pathname === '/api/schedule') {
      return json(res, 200, await run(engine, 'tripSchedule', { tripId: q.get('trip') }));
    }

    json(res, 404, { error: 'not found', routes: ['/api/nearby', '/api/departures', '/api/plan', '/api/schedule'] });
  } catch (err) {
    json(res, 500, { error: String(err && err.message || err) });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Trip planner on http://127.0.0.1:${PORT}  (engine=redis|mongo)`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    await redis.quit(); await mongoClient.close(); process.exit(0);
  });
}
