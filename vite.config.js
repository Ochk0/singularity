import { defineConfig } from 'vite';

export default defineConfig({
  server: { port: 5173, host: '127.0.0.1' },
  assetsInclude: ['**/*.glsl', '**/*.vert', '**/*.frag'],
  // top-level await (used to init the WASM module) needs ES2022+.
  build: { target: 'es2022' },
  esbuild: { target: 'es2022' },
  optimizeDeps: { esbuildOptions: { target: 'es2022' } },
});
