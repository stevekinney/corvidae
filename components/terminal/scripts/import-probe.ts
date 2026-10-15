/**
 * Runs in a plain Bun process, never under `bun test`, so no test preload installs DOM globals.
 * Imports the entry named on the command line (only the modules that entry reaches) while
 * trapping the calls that would mean importing the package did real work, then prints a JSON
 * report for `check-boundaries.ts`. It reports reads of the globals listed in `DOM_GLOBALS` only,
 * the trapped calls and constructors named below, loads of the engine and Bun-only ventriloquist
 * entries, globals the import added, and an error thrown by the import.
 */
import { sveltePlugin } from '@lostgradient/testing';
import { plugin } from 'bun';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';

const entry = process.argv[2];
if (entry === undefined) throw new Error('usage: bun import-probe.ts <entry>');

/** Modules the entry's import graph must not load: the engine and the Bun-only host entries. */
const FORBIDDEN_MODULE =
  /(?:\/@xterm\/xterm\/|\/ventriloquist\/src\/(?:bun|websocket)\/).*\.(?:[cm]?[jt]s|[jt]sx)$/;
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

// The package's own source, by real path and as the working directory spells it. A DOM read counts
// against the package only when its call stack passes through here: a dependency that checks
// `typeof document` at import, as Cinder's components do, is covered by the server-render test.
Error.stackTraceLimit = 64;
const packageSources = [
  ...new Set([resolve(process.cwd(), 'src'), resolve(realpathSync(process.cwd()), 'src')]),
].map((directory) => `${directory}/`);

function readsFromPackageSource(): boolean {
  const stack = new Error().stack ?? '';
  return packageSources.some((directory) => stack.includes(directory));
}

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

// Any read of a DOM global from the package's source, even behind a `typeof` guard, means the
// import looked at the DOM. A name Bun already defines (`navigator`) keeps its value, behind a
// getter that records the read.
for (const name of DOM_GLOBALS) {
  const existing = Object.getOwnPropertyDescriptor(globalThis, name);
  const inherited = name in globalThis ? (globalThis as Record<string, unknown>)[name] : undefined;
  Object.defineProperty(globalThis, name, {
    configurable: true,
    get() {
      if (readsFromPackageSource()) domGlobalReads.push(name);
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

// Record every forbidden module the import graph loads. A forbidden module is replaced with an
// empty one, so the report names it without running it. Only forbidden paths reach the callback,
// so every other module, including a CommonJS dependency, keeps Bun's own loader and its interop.
// The engine's stylesheet is an asset, not engine code, and is not matched. Bun's runtime
// `onResolve` never sees bare specifiers, so loaded paths are the reliable signal. Built-in `bun:`
// and `node:` modules never reach `onLoad`; the static import scan in `check-boundaries.ts` owns
// those.
plugin({
  name: 'terminal-import-probe',
  setup(build) {
    build.onLoad({ filter: FORBIDDEN_MODULE }, ({ path }) => {
      forbiddenModules.push(path);
      return { contents: 'export {};', loader: 'js' };
    });
  },
});

// Svelte components compile for the server, as a server render would load them: with no DOM, and
// with the `browser` export condition unset, so a client-only guard such as `esm-env` reads false.
// Only this package's own components are compiled and evaluated. Without the plugin Bun resolves
// a `.svelte` import to a file path and the component's module graph, which is what has to be
// side-effect free, would never run. Another workspace's component stays a path: compiling all of
// Cinder's server graph costs seconds, and its import behavior is Cinder's own, covered by the
// server-render test. Rune modules (`.svelte.ts`) compile wherever they are, because their
// `$state` calls cannot run uncompiled.
const serverCompiler = sveltePlugin({ generate: 'server' });
await plugin({
  name: 'terminal-import-probe-svelte',
  async setup(build) {
    const scoped = new Proxy(build, {
      get(target, property) {
        if (property !== 'onLoad') {
          const value: unknown = Reflect.get(target, property);
          return typeof value === 'function' ? value.bind(target) : value;
        }
        return (
          constraints: { filter: RegExp },
          callback: (arguments_: { path: string }) => unknown,
        ) =>
          constraints.filter.test('component.svelte')
            ? target.onLoad(constraints, (arguments_) =>
                packageSources.some((directory) => arguments_.path.startsWith(directory))
                  ? (callback(arguments_) as never)
                  : {
                      contents: `export default ${JSON.stringify(arguments_.path)};`,
                      loader: 'js',
                    },
              )
            : target.onLoad(constraints, callback as never);
      },
    });
    await serverCompiler.setup(scoped);
  },
});

// Reflect.ownKeys includes symbol keys, which Object.getOwnPropertyNames omits.
const globalsBefore = new Set(Reflect.ownKeys(globalThis));
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
  addedGlobals: Reflect.ownKeys(globalThis)
    .filter((key) => !globalsBefore.has(key))
    .map((key) => String(key)),
  ...(error === undefined ? {} : { error }),
};
// Exit explicitly once the report is flushed: a module that started a timer or socket on import
// would otherwise keep this process alive, and that is a finding, not a reason to hang the check.
process.stdout.write(`${JSON.stringify(report)}\n`, () => process.exit(0));
