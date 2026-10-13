/**
 * Runs in a plain Bun process, never under `bun test`, so no test preload installs DOM globals.
 * Imports the entry named on the command line (only the modules that entry reaches) while
 * trapping the calls that would mean importing the package did real work, then prints a JSON
 * report for `check-boundaries.ts`. It reports reads of the globals listed in `DOM_GLOBALS` only,
 * the trapped calls and constructors named below, loads of the engine and Bun-only ventriloquist
 * entries, globals the import added, and an error thrown by the import.
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

function trapConstructor(owner: object, name: string, label: string): void {
  Object.defineProperty(owner, name, {
    configurable: true,
    writable: true,
    value: function trapped() {
      trappedCalls.push(`new ${label}`);
      throw new Error(`new ${label} must not run while importing the package`);
    },
  });
}

// Any read of a DOM global, even behind a `typeof` guard, means the import looked at the DOM. A
// name Bun already defines (`navigator`) keeps its value, behind a getter that records the read.
for (const name of DOM_GLOBALS) {
  const existing = Object.getOwnPropertyDescriptor(globalThis, name);
  const inherited = name in globalThis ? (globalThis as Record<string, unknown>)[name] : undefined;
  Object.defineProperty(globalThis, name, {
    configurable: true,
    get() {
      domGlobalReads.push(name);
      return existing?.get ? existing.get.call(globalThis) : (existing?.value ?? inherited);
    },
  });
}

// A timer armed on import would keep a real process alive, and the explicit exit below would hide
// it, so creating one is a finding. The originals come back before the report is written.
const timerNames = ['setTimeout', 'setInterval', 'setImmediate'] as const;
const originalTimers = timerNames.map((name) => [name, globalThis[name]] as const);
for (const name of timerNames) trapFunction(globalThis, name, name);

trapFunction(globalThis, 'fetch', 'fetch');
for (const name of ['compile', 'instantiate', 'compileStreaming', 'instantiateStreaming']) {
  trapFunction(WebAssembly, name, `WebAssembly.${name}`);
}
for (const name of ['Module', 'Instance']) {
  trapConstructor(WebAssembly, name, `WebAssembly.${name}`);
}
for (const name of ['Worker', 'SharedWorker', 'WebSocket', 'EventSource', 'XMLHttpRequest']) {
  trapConstructor(globalThis, name, name);
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

for (const [name, original] of originalTimers) {
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: original });
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
