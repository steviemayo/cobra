import { defineConfig } from 'vitest/config';

// The gateway tests start real servers, sockets and a SQLite file. The first test in a file pays
// for loading all of that, which can pass the 5 second default when the whole suite runs at once.
export default defineConfig({ test: { testTimeout: 20_000, hookTimeout: 20_000 } });
