import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, normalizePath } from 'vite';
import react from '@vitejs/plugin-react';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { viteStaticCopy } from 'vite-plugin-static-copy';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: __dirname,
  define: {
    __BUILD_TIME__: JSON.stringify(Date.now()),
  },
  plugins: [
    react(),
    basicSsl(),
    viteStaticCopy({
      targets: [
        {
          src: normalizePath(path.resolve(__dirname, 'node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded*.wasm')),
          dest: 'ort',
        },
        {
          src: normalizePath(path.resolve(__dirname, 'node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded*.mjs')),
          dest: 'ort',
        },
      ],
    }),
  ],
  resolve: {
    conditions: ['onnxruntime-web-use-extern-wasm'],
  },
  build: {
    outDir: 'dist',
    assetsInlineLimit: 0,
  },
  server: {
    host: true,
  },
});
