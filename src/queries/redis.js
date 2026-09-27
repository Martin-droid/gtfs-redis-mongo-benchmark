/**
 * The six trip-planning queries, implemented against the Redis data model.
 * Each one is a direct structure access - no scanning, no query planner.
 */
export const redisQueries = {
  /** 1. Point lookup: stop attributes by id. */
  async stopLookup(client, { stopId }) {
    return client.hGetAll(`stop:${stopId}`);
  },

  /** 2. Geospatial: stops within radiusM metres of a coordinate. */
  async stopsNearby(client, { lat, lon, radiusM = 1000 }) {
    return client.geoSearch(
      'stops:geo',
      { latitude: lat, longitude: lon },
      { radius: radiusM, unit: 'm' }
    );
  },

  /** 3. Next N departures at a stop at or after a time-of-day (seconds). */
  async departuresAtStop(client, { stopId, afterSec, limit = 10 }) {
    return client.zRangeByScore(`stop:${stopId}:departures`, afterSec, '+inf', {
      LIMIT: { offset: 0, count: limit },
    });
  },

  /** 4. Full ordered schedule for one trip. */
  async tripSchedule(client, { tripId }) {
    return client.zRange(`trip:${tripId}:stops`, 0, -1);
  },

  /** 5. Which routes serve a stop. */
  async routesServingStop(client, { stopId }) {
    return client.sMembers(`stop:${stopId}:routes`);
  },

  /**
   * 6. The real planning query: trips departing `from` after a time that also
   * call at `to` later in the same trip.
   *
   * Redis cannot join, so the join happens client-side: pull candidate
   * departures from the origin, then check each trip's schedule. The candidate
   * set is capped, which is what keeps this bounded.
   */
  async directTrips(client, { fromStop, toStop, afterSec, limit = 5, scan = 40 }) {
    const candidates = await client.zRangeByScore(
      `stop:${fromStop}:departures`, afterSec, '+inf',
      { LIMIT: { offset: 0, count: scan } }
    );

    const results = [];
    for (const entry of candidates) {
      const [tripId, seqStr] = entry.split('|');
      const fromSeq = Number(seqStr);
      // Only the portion of the trip after the origin can contain the target.
      const rest = await client.zRangeByScore(`trip:${tripId}:stops`, fromSeq + 1, '+inf');
      const hit = rest.find((m) => m.split('|')[0] === toStop);
      if (hit) {
        // member layout: stop_id|arrival_time|departure_time
        results.push({ tripId, boardAt: entry.split('|')[2], alightAt: hit.split('|')[1] });
        if (results.length >= limit) break;
      }
    }
    return results;
  },
};
