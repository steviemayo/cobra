// Compiles the gateway (and the workspace packages it uses) into one file, dist/main.mjs, so it starts
// without translating TypeScript first. tsx took 15 to 20 seconds to get going on a room PC, which
// is long enough for an installer or an updater waiting a fixed time to decide the gateway had failed.
// Packages with native parts or their own files stay outside the bundle and are loaded from node_modules.
import { build } from 'esbuild';

await build({
  entryPoints: ['src/main.ts'],
  outfile: 'dist/main.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: true,
  external: ['fastify', 'serialport', '@serialport/*', 'zod'],
  // A bundled CommonJS dependency may call require(); give it one.
  banner: {
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
  logLevel: 'info',
});
