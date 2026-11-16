import { defineConfig } from 'vite';

// A non-root `base` checks that relative page URLs keep the base path.
export default defineConfig({
  base: '/app/',
  logLevel: 'warn',
});
