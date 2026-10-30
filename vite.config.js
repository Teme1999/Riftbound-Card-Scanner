import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, normalizePath } from 'vite';
import react from '@vitejs/plugin-react';
import { viteStaticCopy } from 'vite-plugin-static-copy';
import { opencvCspPlugin, opencvCspOptimizer } from './scripts/opencv-csp.mjs';

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
    opencvCspPlugin(),
    react(),
    viteStaticCopy({
      targets: [
        { src: normalizePath(path.resolve(__dirname, 'node_modules/tesseract.js/dist/worker.min.js')), dest: 'ocr' },
        { src: normalizePath(path.resolve(__dirname, 'node_modules/tesseract.js/dist/worker.min.js.LICENSE.txt')), dest: 'ocr' },
        { src: normalizePath(path.resolve(__dirname, 'node_modules/tesseract.js/LICENSE.md')), dest: 'ocr/licenses/tesseract-js' },
        { src: normalizePath(path.resolve(__dirname, 'node_modules/@techstark/opencv-js/LICENSE')), dest: 'visual/licenses/opencv-js' },
        { src: normalizePath(path.resolve(__dirname, 'node_modules/tesseract.js-core/LICENSE')), dest: 'ocr/licenses/tesseract-core' },
        { src: normalizePath(path.resolve(__dirname, 'node_modules/tesseract.js-core/*lstm.wasm*')), dest: 'ocr/core' },
        { src: normalizePath(path.resolve(__dirname, 'node_modules/@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz')), dest: 'ocr/lang' },
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
  // The workspace also contains generated Tauri/test/browser HTML under target.
  // Dependency discovery must start from the application, not those artifacts.
  optimizeDeps: { entries: ['index.html'], esbuildOptions: { plugins: [opencvCspOptimizer()] } },
  worker: { plugins: () => [opencvCspPlugin()] },
  build: {
    outDir: 'dist',
    assetsInlineLimit: 0,
  },
  server: {
    host: true,
    watch: { ignored: ['**/src-tauri/target/**', '**/.venv/**'] },
  },
});
