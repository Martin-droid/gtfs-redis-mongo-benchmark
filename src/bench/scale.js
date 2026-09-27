/**
 * Scalability sweep: runs the whole benchmark at every scale preset and
 * summarises how ingestion, footprint and query latency move as the feed
 * grows. This is what the scalability question needs - a single dataset size
 * cannot show a trend.
 *
 *   node src/bench/scale.js
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { SCALES } from '../config.js';

const scales = Object.keys(SCALES);
const rows = [];

for (const s of scales) {
  console.log(`\n########## scale: ${s} ##########`);
  execFileSync(process.execPath, ['src/bench/run.js', s], { stdio: 'inherit' });
  rows.push(JSON.parse(readFileSync(`results/benchmark-${s}.json`, 'utf8')));
}

const summary = rows.map((r) => ({
  scale: r.scale,
  stop_times: r.feed.stop_times,
  redis_load_ms: r.ingestion.redis_ms,
  mongo_load_ms: r.ingestion.mongo_ms,
  redis_mem_mb: +(r.footprint.redis_used_memory_bytes / 1048576).toFixed(1),
  mongo_storage_mb: +((r.footprint.mongo_storage_size_bytes + r.footprint.mongo_index_size_bytes) / 1048576).toFixed(1),
  queries: Object.fromEntries(
    r.queries.map((q) => [q.query, { redis_p50: q.redis.p50_ms, mongo_p50: q.mongo.p50_ms }])
  ),
}));

writeFileSync('results/scale-summary.json', JSON.stringify(summary, null, 2));

console.log('\n\n=== SCALABILITY SUMMARY ===');
console.log('scale    stop_times   redis_load  mongo_load   redis_mem  mongo_disk');
for (const s of summary) {
  console.log(
    `${s.scale.padEnd(8)} ${String(s.stop_times).padEnd(12)} ${String(s.redis_load_ms + 'ms').padEnd(11)} ` +
    `${String(s.mongo_load_ms + 'ms').padEnd(12)} ${String(s.redis_mem_mb + 'MB').padEnd(10)} ${s.mongo_storage_mb}MB`
  );
}

console.log('\np50 latency by scale (ms)  [redis / mongo]');
const qnames = Object.keys(summary[0].queries);
console.log('query'.padEnd(19) + scales.map((s) => s.padEnd(18)).join(''));
for (const q of qnames) {
  const cells = summary.map((s) => {
    const { redis_p50, mongo_p50 } = s.queries[q];
    return `${redis_p50.toFixed(3)}/${mongo_p50.toFixed(3)}`.padEnd(18);
  });
  console.log(q.padEnd(19) + cells.join(''));
}
console.log('\nWrote results/scale-summary.json');
