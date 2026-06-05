import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

export default defineConfig({
  plugins: [svelte()],
  server: {
    fs: {
      allow: ['.']
    }
  },
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      if (req.url?.startsWith('/api/current-balances')) {
        eval("import('./server/db.js')")
          .then((mod) => {
            const payload = mod.getCurrentAccountBalances();
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify(payload));
          })
          .catch((err) => {
            next();
          });
      } else {
        next();
      }
    });
  }
});
