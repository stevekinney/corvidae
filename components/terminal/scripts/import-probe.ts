/**
 * Runs in a plain Bun process, never under `bun test`, so no test preload installs DOM globals.
 * Imports the entry named on the command line while trapping the calls that would mean importing
 * the package did real work, then prints a JSON report for `check-boundaries.ts`.
 */
import { plugin } from 'bun';
import { resolve } from 'node:path';

const entry = process.argv[2];
if (entry === undefined) throw new Error('usage: bun import-probe.ts <entry>');

/** Modules the entry's import graph must not load: the engine and the Bun-only host entries. */
const FORBIDDEN_MODULE = /\/@xterm\/xterm\/|\/ventriloquist\/src\/(?:bun|websocket)\//;
const DOM_GLOBALS = [
  'window',
  'document',
  'navigator',
  'HTMLElement',
  'customElements',
  'requestAnimationFrame',
  'ResizeObserver',
  'MutationObserver',
];

const trappedCalls: string[] = [];
const forbiddenModules: string[] = [];
const domGlobalReads: string[] = [];

function trapFunction(owner: object, name: string, label: string): void {
  Object.defineProperty(owner, name, {
    configurable: true,
    writable: true,
    value: () => {
      trappedCalls.push(label);
      throw new Error(`${label} must not run while importing the package`);
    },
  });
}

function trapConstructor(name: string): void {
  Object.defineProperty(globalThis, name, {
    configurable: true,
    writable: true,
    value: function trapped() {
      trappedCalls.push(`new ${name}`);
      throw new Error(`new ${name} must not run while importing the package`);
    },
  });
}

// Bun already defines some of these names (`navigator`), so only the absent ones can be trapped; a
// read of an absent one, even behind a `typeof` guard, means the import looked at the DOM.
for (const name of DOM_GLOBALS) {
  if (name in globalThis) continue;
  Object.defineProperty(globalThis, name, {
    configurable: true,
    get() {
      domGlobalReads.push(name);
      return undefined;
    },
  });
}

trapFunction(globalThis, 'fetch', 'fetch');
for (const name of ['compile', 'instantiate', 'compileStreaming', 'instantiateStreaming']) {
  trapFunction(WebAssembly, name, `WebAssembly.${name}`);
}
for (const name of ['Worker', 'SharedWorker', 'WebSocket', 'EventSource', 'XMLHttpRequest']) {
  trapConstructor(name);
}

// Record every source module the import graph loads. A forbidden module is replaced with an empty
// one, so the report names it without running it; everything else loads unchanged. Bun's runtime
// `onResolve` never sees bare specifiers, so loaded paths are the reliable signal. Built-in `bun:`
// and `node:` modules never reach `onLoad`; the static import scan in `check-boundaries.ts` owns
// those.
const LOADERS = {
  ts: 'ts',
  mts: 'ts',
  cts: 'ts',
  tsx: 'tsx',
  js: 'js',
  mjs: 'js',
  cjs: 'js',
  jsx: 'jsx',
} as const;
plugin({
  name: 'terminal-import-probe',
  setup(build) {
    build.onLoad({ filter: /\.(?:[cm]?[jt]s|[jt]sx)$/ }, async ({ path }) => {
      if (FORBIDDEN_MODULE.test(path)) {
        forbiddenModules.push(path);
        return { contents: 'export {};', loader: 'js' };
      }
      const extension = path.slice(path.lastIndexOf('.') + 1) as keyof typeof LOADERS;
      return { contents: await Bun.file(path).text(), loader: LOADERS[extension] };
    });
  },
});

const globalsBefore = new Set(Object.getOwnPropertyNames(globalThis));
let error: string | undefined;
try {
  await import(resolve(entry));
} catch (caught) {
  error = caught instanceof Error ? caught.message : String(caught);
}

const report = {
  forbiddenModules,
  trappedCalls,
  domGlobals: domGlobalReads,
  addedGlobals: Object.getOwnPropertyNames(globalThis).filter((name) => !globalsBefore.has(name)),
  ...(error === undefined ? {} : { error }),
};
// Exit explicitly once the report is flushed: a module that started a timer or socket on import
// would otherwise keep this process alive, and that is a finding, not a reason to hang the check.
process.stdout.write(`${JSON.stringify(report)}\n`, () => process.exit(0));
