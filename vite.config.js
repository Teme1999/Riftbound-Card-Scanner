import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, normalizePath } from 'vite';
import react from '@vitejs/plugin-react';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { viteStaticCopy } from 'vite-plugin-static-copy';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageJson = JSON.parse(fs.readFileSync(path.resolve(__dirname, 'package.json'), 'utf8'));

export default defineConfig({
  root: __dirname,
  define: {
    __BUILD_TIME__: JSON.stringify(Date.now()),
    __APP_VERSION__: JSON.stringify(packageJson.version),
    __APP_RELEASE_VERSION__: JSON.stringify(packageJson.releaseVersion || packageJson.version),
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
