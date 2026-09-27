// Central configuration. Ports are deliberately non-default so the benchmark
// never collides with a Redis/Mongo you already run locally.
export const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6380';
export const MONGO_URL = process.env.MONGO_URL || 'mongodb://127.0.0.1:27018';
export const MONGO_DB = process.env.MONGO_DB || 'gtfs_bench';

export const GTFS_DIR = process.env.GTFS_DIR || 'data/gtfs';

// Feed size presets. "scale" multiplies the network size so we can measure how
// each database behaves as the dataset grows (see: scalability section).
export const SCALES = {
  small:  { routes: 12,  stopsPerRoute: 18, tripsPerRoute: 40  },
  medium: { routes: 40,  stopsPerRoute: 25, tripsPerRoute: 80  },
  large:  { routes: 90,  stopsPerRoute: 32, tripsPerRoute: 120 },
};

export const DEFAULT_SCALE = process.env.SCALE || 'medium';

// Benchmark shape
export const BENCH = {
  warmup: Number(process.env.WARMUP || 200),
  iterations: Number(process.env.ITERATIONS || 2000),
};
