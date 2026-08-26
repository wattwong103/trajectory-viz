import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import os from 'node:os'
import path from 'node:path'

export default defineConfig({
  plugins: [react()],
  // node_modules sits on a Dropbox-synced drive; Dropbox file-locking breaks
  // the dep optimizer's temp-dir rename, leaving a corrupt cache (blank page).
  // Keep the optimizer cache on local disk instead.
  cacheDir: path.join(os.tmpdir(), 'trajectory-viz-vite-cache'),
  server: {
    port: 5173,
    proxy: {
      // Proxy API calls to FastAPI backend during development
      '/api': {
        target: 'http://127.0.0.1:9999',
        changeOrigin: true,
      },
      // traj-mining compat endpoint
      '/randomsample': {
        target: 'http://127.0.0.1:9999',
        changeOrigin: true,
      },
    },
  },
})
