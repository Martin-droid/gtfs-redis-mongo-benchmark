/**
 * Minimal GTFS reader. GTFS files are plain CSV with a header row; this feed
 * contains no quoted/embedded commas, so a split parser is correct and fast.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GTFS_DIR } from '../config.js';

export function readTable(name, dir = GTFS_DIR) {
  const text = readFileSync(join(dir, name), 'utf8').trim();
  const [header, ...lines] = text.split('\n');
  const cols = header.split(',');
  return lines.map((line) => {
    const parts = line.split(',');
    const row = {};
    for (let i = 0; i < cols.length; i++) row[cols[i]] = parts[i];
    return row;
  });
}

/** "14:23:05" -> 51785. GTFS allows hours >= 24 for trips past midnight. */
export function toSeconds(hhmmss) {
  const [h, m, s] = hhmmss.split(':').map(Number);
  return h * 3600 + m * 60 + s;
}

export function loadFeed(dir = GTFS_DIR) {
  return {
    stops: readTable('stops.txt', dir),
    routes: readTable('routes.txt', dir),
    trips: readTable('trips.txt', dir),
    stopTimes: readTable('stop_times.txt', dir),
  };
}
