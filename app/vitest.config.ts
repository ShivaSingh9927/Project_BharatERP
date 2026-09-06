import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Tests share one Postgres instance; run files serially to keep the
    // audit-chain tamper test from racing other writers.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
