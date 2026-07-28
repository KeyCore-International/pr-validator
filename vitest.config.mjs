import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.mjs'],
    environment: 'node',
    // Fixtures are read from disk; keep the cwd stable across workers.
    root: import.meta.dirname,
  },
});
