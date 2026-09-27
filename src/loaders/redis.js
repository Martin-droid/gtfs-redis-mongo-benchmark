/**
 * Redis data model for trip planning.
 *
 * Redis has no query planner, so the access paths have to be designed up front.
 * Each structure below exists to serve one specific query shape in O(log n) or
 * better:
 *
 *   stop:{id}              HASH  - stop attributes                 (point read)
 *   stops:geo              GEO   - GEOSEARCH by radius             (nearby stops)
 *   stop:{id}:departures   ZSET  - score = departure seconds       (next departures)
 *   stop:{id}:routes       SET   - routes serving a stop           (membership)
 *   trip:{id}:stops        ZSET  - score = stop_sequence           (ordered schedule)
 *   trip:{id}              HASH  - trip attributes
 *   route:{id}             HASH  - route attributes
 */
import { createClient } from 'redis';
import { REDIS_URL } from '../config.js';
import { toSeconds } from '../gtfs/parse.js';

export async function connectRedis() {
  const client = createClient({ url: REDIS_URL });
  client.on('error', (e) => { throw e; });
  await client.connect();
  return client;
}

export async function loadRedis(client, feed, { flush = true } = {}) {
  if (flush) await client.flushDb();
  const t0 = performance.now();

  // Stops + geo index
  let pipe = client.multi();
  for (const s of feed.stops) {
    pipe.hSet(`stop:${s.stop_id}`, {
      stop_id: s.stop_id, stop_name: s.stop_name, stop_lat: s.stop_lat, stop_lon: s.stop_lon,
    });
    pipe.geoAdd('stops:geo', {
      longitude: Number(s.stop_lon), latitude: Number(s.stop_lat), member: s.stop_id,
    });
  }
  await pipe.exec();

  // Routes
  pipe = client.multi();
  for (const r of feed.routes) {
    pipe.hSet(`route:${r.route_id}`, {
      route_id: r.route_id, route_short_name: r.route_short_name,
      route_long_name: r.route_long_name, route_type: r.route_type,
    });
  }
  await pipe.exec();

  // Trips (keep a trip -> route map in memory for the stop->route index)
  const tripRoute = new Map();
  pipe = client.multi();
  for (const t of feed.trips) {
    tripRoute.set(t.trip_id, t.route_id);
    pipe.hSet(`trip:${t.trip_id}`, {
      trip_id: t.trip_id, route_id: t.route_id, service_id: t.service_id,
      trip_headsign: t.trip_headsign, direction_id: t.direction_id,
    });
  }
  await pipe.exec();

  // stop_times -> the two hot indexes. Batched so we never build one giant MULTI.
  const BATCH = 5000;
  pipe = client.multi();
  let n = 0;
  for (const st of feed.stopTimes) {
    const dep = toSeconds(st.departure_time);
    const routeId = tripRoute.get(st.trip_id);

    // next departures at a stop, ordered by time
    pipe.zAdd(`stop:${st.stop_id}:departures`, {
      score: dep, value: `${st.trip_id}|${st.stop_sequence}|${st.departure_time}`,
    });
    // ordered schedule for a trip
    // arrival AND departure: you board on departure but alight on arrival,
    // so both are needed for a correct plan.
    pipe.zAdd(`trip:${st.trip_id}:stops`, {
      score: Number(st.stop_sequence),
      value: `${st.stop_id}|${st.arrival_time}|${st.departure_time}`,
    });
    // which routes serve this stop
    if (routeId) pipe.sAdd(`stop:${st.stop_id}:routes`, routeId);

    if (++n % BATCH === 0) { await pipe.exec(); pipe = client.multi(); }
  }
  await pipe.exec();

  return { ms: performance.now() - t0, records: feed.stopTimes.length };
}
