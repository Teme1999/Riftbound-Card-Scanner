import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { transformWithEsbuild } from 'vite';

const root = fileURLToPath(new URL('../../', import.meta.url));
const compiled = new Map();
async function compileDirectory(directory) {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) await compileDirectory(filename);
    else if (/\.(js|jsx)$/.test(filename)) {
      const result = await transformWithEsbuild(await fs.readFile(filename, 'utf8'), filename, {
        format: 'cjs', jsx: 'transform',
        define: { __BUILD_TIME__: '0', __APP_VERSION__: '"test"', __APP_RELEASE_VERSION__: '"test"', 'import.meta.env.DEV': 'false' },
      });
      compiled.set(filename, result.code);
    }
  }
}
await compileDirectory(path.join(root, 'src'));

// Runs the real components and handlers with isolated state, timers and storage.
// It deliberately does not start cameras, network requests or app initialization.
export function createRuntime({ storage = {}, mocks = {}, globals = {} } = {}) {
  const values = new Map(Object.entries(storage).map(([key, value]) => [key, JSON.stringify(value)]));
  let currentHooks;
  const React = {
    createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
    useState(initial) {
      const hooks = currentHooks;
      const index = hooks.cursor++;
      if (!(index in hooks.states)) hooks.states[index] = typeof initial === 'function' ? initial() : initial;
      return [hooks.states[index], (next) => {
        hooks.states[index] = typeof next === 'function' ? next(hooks.states[index]) : next;
      }];
    },
    useRef(initial) {
      const hooks = currentHooks;
      const index = hooks.cursor++;
      if (!(index in hooks.states)) hooks.states[index] = { current: initial };
      return hooks.states[index];
    },
    useMemo: (fn) => fn(),
    useCallback: (fn) => fn,
    useEffect(fn) { currentHooks.effects.push(fn); },
    memo: (component) => component,
  };
  const context = vm.createContext({
    console, URL, Map, Set, Float32Array, Uint32Array, Uint8ClampedArray,
    Date, Math, crypto: globalThis.crypto,
    setTimeout: () => 1, clearTimeout: () => {}, setInterval: () => 1, clearInterval: () => {},
    requestAnimationFrame: (fn) => fn(),
    navigator: {}, window: { location: { origin: 'http://localhost' } },
    document: { addEventListener() {}, removeEventListener() {} },
    localStorage: { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) },
    ...globals,
  });
  const cache = new Map();
  function load(relative) {
    const filename = path.resolve(root, relative);
    if (Object.hasOwn(mocks, relative.replaceAll('\\', '/'))) return mocks[relative.replaceAll('\\', '/')];
    if (cache.has(filename)) return cache.get(filename).exports;
    const module = { exports: {} };
    cache.set(filename, module);
    const require = (specifier) => {
      if (Object.hasOwn(mocks, specifier)) return mocks[specifier];
      if (specifier.startsWith('.')) return load(path.relative(root, path.resolve(path.dirname(filename), specifier)));
      if (specifier === 'react') return React;
      if (specifier === 'lucide-react') return new Proxy({}, { get: (_, name) => () => name });
      if (specifier === 'onnxruntime-web/wasm') return { env: { wasm: {} } };
      if (specifier.startsWith('@tauri-apps/')) return { convertFileSrc: (value) => `asset:${value}` };
      throw new Error(`Unexpected test dependency: ${specifier}`);
    };
    const code = compiled.get(filename);
    if (!code) throw new Error(`Uncompiled test module: ${relative}`);
    const wrapper = vm.runInContext(`(function(require, module, exports) {\n${code}\n})`, context, { filename });
    wrapper(require, module, module.exports);
    return module.exports;
  }
  function mount(Component, initialStates = []) {
    const hooks = { states: [...initialStates], cursor: 0, effects: [] };
    return {
      render(props = {}) {
        hooks.cursor = 0;
        hooks.effects = [];
        currentHooks = hooks;
        return Component(props);
      },
      runEffects() { return hooks.effects.map((fn) => fn()); },
      states: hooks.states,
    };
  }
  return { load, mount, values };
}

export function nodes(tree, predicate) {
  if (!tree || typeof tree !== 'object') return [];
  if (Array.isArray(tree)) return tree.flatMap((node) => nodes(node, predicate));
  return [...(predicate(tree) ? [tree] : []), ...nodes(tree.props?.children, predicate)];
}

export function componentProps(tree, name) {
  const found = nodes(tree, (node) => node.type?.name === name)[0];
  if (!found) throw new Error(`Component missing: ${name}`);
  return found.props;
}

export function button(tree, label) {
  const text = (node) => typeof node === 'string' || typeof node === 'number' ? String(node) : Array.isArray(node)
    ? node.map(text).join('') : node?.props ? text(node.props.children) : '';
  const found = nodes(tree, (node) => node.type === 'button' && text(node).trim() === label)[0];
  if (!found) throw new Error(`Button missing: ${label}`);
  return found.props;
}
