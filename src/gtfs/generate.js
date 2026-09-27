/**
 * Generates a GTFS-spec-compliant feed.
 *
 * Why synthetic rather than a downloaded feed: the benchmark needs to run at
 * several dataset sizes to say anything useful about scalability, and it needs
 * to be byte-for-byte reproducible on any machine. A seeded generator gives
 * both. The field names, types and relationships follow the GTFS reference, so
 * the loaders and queries are the same ones a real feed would need.
 *
 * Files produced: agency.txt, stops.txt, routes.txt, trips.txt, calendar.txt,
 * stop_times.txt
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { GTFS_DIR, SCALES, DEFAULT_SCALE } from '../config.js';

// Deterministic PRNG (mulberry32) so every run produces an identical feed.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const csv = (rows) => rows.map((r) => r.join(',')).join('\n') + '\n';
const pad = (n, w = 2) => String(n).padStart(w, '0');
const hhmmss = (sec) => `${pad(Math.floor(sec / 3600))}:${pad(Math.floor((sec % 3600) / 60))}:${pad(sec % 60)}`;

// Nairobi-ish bounding box, so coordinates are plausible for geo queries.
const CENTER = { lat: -1.286389, lon: 36.817223 };

export function generate(scaleName = DEFAULT_SCALE, outDir = GTFS_DIR) {
  const scale = SCALES[scaleName];
  if (!scale) throw new Error(`Unknown scale "${scaleName}". Use: ${Object.keys(SCALES).join(', ')}`);

  const rand = rng(42);
  mkdirSync(outDir, { recursive: true });

  // ---- agency.txt -------------------------------------------------------
  const agency = [
    ['agency_id', 'agency_name', 'agency_url', 'agency_timezone'],
    ['IVY', 'Ivy Metro Transit', 'https://example.org', 'Africa/Nairobi'],
  ];

  // ---- stops.txt --------------------------------------------------------
  // Stops are laid out as a shared pool; routes then walk through a subset, so
  // stops are genuinely shared between routes (as in a real network).
  const stopCount = Math.round(scale.routes * scale.stopsPerRoute * 0.45);
  const stops = [['stop_id', 'stop_name', 'stop_lat', 'stop_lon']];
  const stopIds = [];
  for (let i = 0; i < stopCount; i++) {
    const id = `S${pad(i, 5)}`;
    stopIds.push(id);
    // spread ~0.25 deg (~27km) around the centre
    const lat = (CENTER.lat + (rand() - 0.5) * 0.25).toFixed(6);
    const lon = (CENTER.lon + (rand() - 0.5) * 0.25).toFixed(6);
    stops.push([id, `Stop ${i}`, lat, lon]);
  }

  // ---- routes.txt -------------------------------------------------------
  const routes = [['route_id', 'agency_id', 'route_short_name', 'route_long_name', 'route_type']];
  for (let r = 0; r < scale.routes; r++) {
    routes.push([`R${pad(r, 3)}`, 'IVY', `${r + 1}`, `Route ${r + 1}`, '3']);
  }

  // ---- calendar.txt -----------------------------------------------------
  const calendar = [
    ['service_id', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday', 'start_date', 'end_date'],
    ['WEEKDAY', '1', '1', '1', '1', '1', '0', '0', '20260101', '20261231'],
    ['WEEKEND', '0', '0', '0', '0', '0', '1', '1', '20260101', '20261231'],
  ];

  // ---- trips.txt + stop_times.txt --------------------------------------
  const trips = [['route_id', 'service_id', 'trip_id', 'trip_headsign', 'direction_id']];
  const stopTimes = [['trip_id', 'arrival_time', 'departure_time', 'stop_id', 'stop_sequence']];

  for (let r = 0; r < scale.routes; r++) {
    const routeId = `R${pad(r, 3)}`;
    // Pick this route's ordered stop pattern out of the shared pool.
    const pattern = [];
    let cursor = Math.floor(rand() * stopIds.length);
    for (let s = 0; s < scale.stopsPerRoute; s++) {
      pattern.push(stopIds[cursor % stopIds.length]);
      cursor += 1 + Math.floor(rand() * 3);
    }

    for (let t = 0; t < scale.tripsPerRoute; t++) {
      const serviceId = t % 5 === 0 ? 'WEEKEND' : 'WEEKDAY';
      const tripId = `T${routeId}_${pad(t, 4)}`;
      const dir = t % 2;
      trips.push([routeId, serviceId, tripId, `Route ${r + 1} ${dir ? 'Inbound' : 'Outbound'}`, String(dir)]);

      // First departure spread across a 05:00 -> 22:00 service day.
      let sec = 5 * 3600 + Math.floor((t / scale.tripsPerRoute) * 17 * 3600);
      const order = dir ? [...pattern].reverse() : pattern;
      order.forEach((stopId, seq) => {
        // 90s-240s hop between consecutive stops, plus a short dwell
        sec += 90 + Math.floor(rand() * 150);
        const arr = sec;
        const dep = sec + 20;
        sec = dep;
        stopTimes.push([tripId, hhmmss(arr), hhmmss(dep), stopId, String(seq + 1)]);
      });
    }
  }

  const files = {
    'agency.txt': csv(agency),
    'stops.txt': csv(stops),
    'routes.txt': csv(routes),
    'calendar.txt': csv(calendar),
    'trips.txt': csv(trips),
    'stop_times.txt': csv(stopTimes),
  };
  for (const [name, body] of Object.entries(files)) writeFileSync(join(outDir, name), body);

  const stats = {
    scale: scaleName,
    agencies: 1,
    stops: stops.length - 1,
    routes: routes.length - 1,
    trips: trips.length - 1,
    stop_times: stopTimes.length - 1,
  };
  return stats;
}

// CLI entry
if (import.meta.url === `file://${process.argv[1]}`) {
  const scaleName = process.argv[2] || DEFAULT_SCALE;
  const stats = generate(scaleName);
  console.log('Generated GTFS feed:', stats);
}
