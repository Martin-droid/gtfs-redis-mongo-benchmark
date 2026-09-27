/**
 * MongoDB data model for trip planning.
 *
 * Unlike Redis, Mongo keeps one document shape per entity and relies on
 * secondary indexes + a query planner to serve different access paths. The
 * indexes below are the Mongo equivalents of the Redis structures:
 *
 *   stops.location        2dsphere        - $near / $geoWithin   (nearby stops)
 *   stop_times {stop_id, departure_sec}   - next departures      (range scan)
 *   stop_times {trip_id, stop_sequence}   - ordered schedule
 *   stop_times.stop_id -> distinct route  - routes serving a stop
 */
import { MongoClient } from 'mongodb';
import { MONGO_URL, MONGO_DB } from '../config.js';
import { toSeconds } from '../gtfs/parse.js';

export async function connectMongo() {
  const client = new MongoClient(MONGO_URL);
  await client.connect();
  return client;
}

export async function loadMongo(client, feed, { drop = true } = {}) {
  const db = client.db(MONGO_DB);
  if (drop) await db.dropDatabase();
  const t0 = performance.now();

  const stops = db.collection('stops');
  const routes = db.collection('routes');
  const trips = db.collection('trips');
  const stopTimes = db.collection('stop_times');

  await stops.insertMany(
    feed.stops.map((s) => ({
      _id: s.stop_id,
      stop_name: s.stop_name,
      stop_lat: Number(s.stop_lat),
      stop_lon: Number(s.stop_lon),
      location: { type: 'Point', coordinates: [Number(s.stop_lon), Number(s.stop_lat)] },
    })),
    { ordered: false }
  );

  await routes.insertMany(
    feed.routes.map((r) => ({
      _id: r.route_id,
      route_short_name: r.route_short_name,
      route_long_name: r.route_long_name,
      route_type: r.route_type,
    })),
    { ordered: false }
  );

  const tripRoute = new Map();
  await trips.insertMany(
    feed.trips.map((t) => {
      tripRoute.set(t.trip_id, t.route_id);
      return {
        _id: t.trip_id,
        route_id: t.route_id,
        service_id: t.service_id,
        trip_headsign: t.trip_headsign,
        direction_id: Number(t.direction_id),
      };
    }),
    { ordered: false }
  );

  // stop_times is the big one - insert in batches to bound memory.
  const BATCH = 10000;
  let batch = [];
  for (const st of feed.stopTimes) {
    batch.push({
      trip_id: st.trip_id,
      route_id: tripRoute.get(st.trip_id),
      stop_id: st.stop_id,
      stop_sequence: Number(st.stop_sequence),
      arrival_time: st.arrival_time,
      departure_time: st.departure_time,
      departure_sec: toSeconds(st.departure_time),
    });
    if (batch.length >= BATCH) { await stopTimes.insertMany(batch, { ordered: false }); batch = []; }
  }
  if (batch.length) await stopTimes.insertMany(batch, { ordered: false });

  // Indexes are created after the bulk load - building them once over a full
  // collection is substantially cheaper than maintaining them per insert.
  await stops.createIndex({ location: '2dsphere' });
  await stopTimes.createIndex({ stop_id: 1, departure_sec: 1 });
  await stopTimes.createIndex({ trip_id: 1, stop_sequence: 1 });
  await stopTimes.createIndex({ route_id: 1 });

  return { ms: performance.now() - t0, records: feed.stopTimes.length };
}
