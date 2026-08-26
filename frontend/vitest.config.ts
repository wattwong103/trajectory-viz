/**
 * Vitest config (Phase 3 Step 3.3).
 *
 * Kept separate from vite.config.ts so the test-only deps (jsdom, testing-library)
 * don't have to be installed for `npm run build` to work. Run `npm install` in
 * frontend/ once to install vitest + jsdom, then `npm test`.
 *
 * The CI workflow (.github/workflows/ci.yml) skips the test step when these
 * deps aren't installed, so this scaffold is additive.
 */
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test-setup.ts'],
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    // Suppress noisy DeckGL warnings during tests
    silent: false,
  },
});
