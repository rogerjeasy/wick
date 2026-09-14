import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      '@wick/contracts': fileURLToPath(new URL('./packages/contracts/src/index.ts', import.meta.url)),
      '@wick/policy': fileURLToPath(new URL('./services/policy/src/index.ts', import.meta.url)),
      '@wick/vega-calm-ui': fileURLToPath(new URL('./packages/vega-calm-ui/src/index.ts', import.meta.url)),
    },
  },
  test: {
    include: ['**/*.{test,spec}.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
  },
});
