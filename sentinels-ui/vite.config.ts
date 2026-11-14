import { defineConfig } from 'vite';
// The swarm page ships inside the Python runner (sentinels/styx_sentinels/ui), which serves it and
// its /api on 127.0.0.1. Fonts and logo are shared with every Styx page (../site/public).
// `npm run dev` proxies /api to a runner started with `styx-sentinels rehearse` or `run`.
export default defineConfig({
  base: './',
  publicDir: '../site/public',
  build: { outDir: '../sentinels/styx_sentinels/ui', emptyOutDir: true },
  server: { proxy: { '/api': 'http://127.0.0.1:8790' } },
});
