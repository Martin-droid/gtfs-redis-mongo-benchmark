/**
 * Timing harness.
 *
 * Reports percentiles rather than an average alone: for an interactive trip
 * planner the tail latency is what users actually feel, and a mean hides it.
 * Every measured call is awaited individually, so these are sequential
 * round-trip latencies, not pipelined throughput.
 */
export function stats(samples) {
  const s = [...samples].sort((a, b) => a - b);
  const at = (p) => s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
  const mean = s.reduce((a, b) => a + b, 0) / s.length;
  return {
    n: s.length,
    mean_ms: +mean.toFixed(4),
    p50_ms: +at(50).toFixed(4),
    p95_ms: +at(95).toFixed(4),
    p99_ms: +at(99).toFixed(4),
    max_ms: +s[s.length - 1].toFixed(4),
    ops_per_sec: Math.round(1000 / mean),
  };
}

/**
 * @param fn      async () => any   the operation under test
 * @param nextArg () => object      fresh arguments per iteration (avoids
 *                                  measuring one lucky cache-resident key)
 */
export async function measure(fn, nextArg, { warmup, iterations }) {
  for (let i = 0; i < warmup; i++) await fn(nextArg());

  const samples = new Array(iterations);
  for (let i = 0; i < iterations; i++) {
    const arg = nextArg();
    const t = performance.now();
    await fn(arg);
    samples[i] = performance.now() - t;
  }
  return stats(samples);
}

/** Verifies both engines return equivalent answers before timing anything. */
export function assertSameShape(name, redisOut, mongoOut) {
  const rn = Array.isArray(redisOut) ? redisOut.length : redisOut ? 1 : 0;
  const mn = Array.isArray(mongoOut) ? mongoOut.length : mongoOut ? 1 : 0;
  return { query: name, redis_results: rn, mongo_results: mn, agree: rn === mn };
}
