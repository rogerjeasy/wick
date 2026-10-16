import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      '@wick/agent': fileURLToPath(new URL('./services/agent/src/index.ts', import.meta.url)),
      '@wick/contracts': fileURLToPath(new URL('./packages/contracts/src/index.ts', import.meta.url)),
      '@wick/policy': fileURLToPath(new URL('./services/policy/src/index.ts', import.meta.url)),
      '@wick/ring': fileURLToPath(new URL('./services/connectors/ring/src/index.ts', import.meta.url)),
      '@wick/strands-agentcore-session': fileURLToPath(new URL('./packages/strands-agentcore-session/src/index.ts', import.meta.url)),
      '@wick/vega-calm-ui': fileURLToPath(new URL('./packages/vega-calm-ui/src/index.ts', import.meta.url)),
    },
  },
  test: {
    include: ['**/*.{test,spec}.{ts,tsx}'],
    // .worktrees/ and .claude/worktrees/ hold other branches checked out side by side (.gitignore); their tests are theirs.
    exclude: ['**/node_modules/**', '**/dist/**', '**/.worktrees/**', '**/.claude/worktrees/**'],
  },
});
