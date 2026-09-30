import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const uiPort = Number(process.env.UI_PORT || 5173);
if (!Number.isInteger(uiPort) || uiPort < 1024 || uiPort > 65535) throw new Error('Invalid UI_PORT');

export default defineConfig({
  plugins: [react()],
  build: {
    rolldownOptions: {
      output: {
        // Keep shared libraries cacheable without pulling route-only code into the entry.
        codeSplitting: {
          groups: [
            { name: 'react', test: /node_modules[\\/](?:react|react-dom|scheduler)[\\/]/ },
            { name: 'validation', test: /node_modules[\\/]zod[\\/]/ },
            { name: 'numbers', test: /node_modules[\\/]decimal\.js[\\/]/ },
            // Address parsing uses these on the landing page; keep them out of TronWeb's lazy chunks.
            { name: 'address-crypto', test: /node_modules[\\/](?:@noble|@scure)[\\/]/, priority: 1, entriesAware: true },
            { name: 'tronweb', test: /node_modules[\\/]tronweb[\\/]/, maxSize: 1024 * 1024 },
          ],
        },
      },
    },
  },
  server: {
    host: '127.0.0.1', port: uiPort, strictPort: true,
    // Native macOS watchers can raise EMFILE in restricted development hosts.
    watch: { usePolling: true, useFsEvents: false, interval: 800 },
    proxy: { '/api': { target: `http://127.0.0.1:${process.env.API_PORT || '8787'}` } },
  },
});
