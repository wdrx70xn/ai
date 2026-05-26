import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: ['src/index.ts', 'src/opa/index.ts'],
    format: ['esm'],
    dts: true,
    sourcemap: true,
  },
]);
