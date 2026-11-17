/**
 * Builds an MCP App's page into one self-contained HTML document (COR-910): the script and the
 * styles are inline, so the document needs no origin to load from and runs under the deny-all
 * content security policy a host gives a `ui://` resource. The digest names the exact bytes.
 *
 * The build compiles Svelte the way the application build does (`sveltePlugin` with `injectCss`,
 * the same compiler options), so a panel can be a Svelte component that renders Cinder through
 * `@lostgradient/cinder/panel` (COR-2216). `svelte` and `@lostgradient/cinder` always resolve from
 * the host's own install, never from the plugin's: a folder plugin gets Cinder without shipping it,
 * and the version of both always matches the application. Every stylesheet the bundler emits is
 * inlined into `<style>`.
 *
 * The compiler itself is read from the host's `svelte` when a build starts, not imported by this
 * module. `@lostgradient/testing`, which holds `sveltePlugin`, pulls in a browser test runner and
 * the TypeScript compiler, and this module is part of the host executable, which would carry them
 * into every release. A release stages `svelte` beside the plugin runtime for the same reason
 * (COR-2217).
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { z } from 'zod';

import { HOST_DEPENDENCIES } from './folder-plugins.ts';

/** A built page and the digest of its bytes. */
export type BuiltPanel = {
  /** The whole document: inline script and styles, no external reference. */
  readonly html: string;
  /** `sha256:<64 hex>`, the form `bureau.interactive-surface.v1` names. */
  readonly contentDigest: string;
};

/**
 * The packages a panel gets from the host, whatever the plugin installs: the Svelte runtime the
 * compiled components call, and the Cinder source the panel kit lives in.
 */
export const HOST_PANEL_PACKAGES: readonly string[] = ['svelte', '@lostgradient/cinder'];

/** The export conditions a panel build resolves, in the order a package's `exports` is read. */
const PANEL_CONDITIONS: readonly string[] = ['svelte', 'browser', 'import', 'module', 'default'];

/** Escape what would end the inline script early. */
function inlineScript(code: string): string {
  return code.replaceAll('</script', '<\\/script').replaceAll('<!--', '<\\!--');
}

/** Escape what would end the inline styles early. */
function inlineStyle(css: string): string {
  return css.replaceAll('</style', '<\\/style');
}

/** Escape text placed in an element, so a title cannot open a tag. */
function escapeText(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;');
}

/** Compute the contract's digest of `html`. */
export function digestOf(html: string): string {
  return `sha256:${new Bun.CryptoHasher('sha256').update(html).digest('hex')}`;
}

/** The target an `exports` entry names under `conditions`, or `undefined` when none applies. */
function exportTarget(entry: unknown, conditions: readonly string[]): string | undefined {
  if (typeof entry === 'string') return entry;
  if (Array.isArray(entry)) {
    for (const candidate of entry) {
      const target = exportTarget(candidate, conditions);
      if (target !== undefined) return target;
    }
    return undefined;
  }
  if (typeof entry !== 'object' || entry === null) return undefined;
  for (const [condition, candidate] of Object.entries(entry)) {
    if (condition !== 'default' && !conditions.includes(condition)) continue;
    const target = exportTarget(candidate, conditions);
    if (target !== undefined) return target;
  }
  return undefined;
}

/** The `exports` entry for `subpath` (`.` or `./name`), matching one `*` pattern when it must. */
function exportEntry(exportsField: unknown, subpath: string): unknown {
  if (typeof exportsField === 'string' || Array.isArray(exportsField)) {
    return subpath === '.' ? exportsField : undefined;
  }
  if (typeof exportsField !== 'object' || exportsField === null) return undefined;
  const entries: Array<[string, unknown]> = Object.entries(exportsField);
  // A map of conditions, not of subpaths: it describes the package root.
  if (!entries.some(([key]) => key.startsWith('.'))) {
    return subpath === '.' ? exportsField : undefined;
  }
  const exact = entries.find(([key]) => key === subpath);
  if (exact !== undefined) return exact[1];
  for (const [key, value] of entries) {
    const star = key.indexOf('*');
    if (star === -1) continue;
    const prefix = key.slice(0, star);
    const suffix = key.slice(star + 1);
    if (subpath.length >= key.length && subpath.startsWith(prefix) && subpath.endsWith(suffix)) {
      const matched = subpath.slice(prefix.length, subpath.length - suffix.length);
      const target = exportTarget(value, PANEL_CONDITIONS);
      return target === undefined ? undefined : target.replaceAll('*', matched);
    }
  }
  return undefined;
}

/** The fields of a package's `package.json` a panel build reads. */
const packageManifestSchema = z.object({
  exports: z.unknown().optional(),
  module: z.string().optional(),
  main: z.string().optional(),
  version: z.string().optional(),
});

/** The fields of the `package.json` at `path` that a panel build reads. */
function readPackageManifest(path: string): z.infer<typeof packageManifestSchema> {
  return packageManifestSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
}

/**
 * The file `specifier` names inside the package `host` holds under `dependencies`, or `undefined`
 * when `specifier` is not one of {@link HOST_PANEL_PACKAGES}. This reads the package's `exports`
 * itself, because a plugin's `onResolve` answer replaces the bundler's own resolution, which is the
 * one that knows the `browser` and `svelte` conditions.
 */
export function resolveHostPanelPackage(
  dependencies: string,
  specifier: string,
): string | undefined {
  const name = HOST_PANEL_PACKAGES.find(
    (candidate) => specifier === candidate || specifier.startsWith(`${candidate}/`),
  );
  if (name === undefined) return undefined;
  const directory = join(dependencies, name);
  const manifestPath = join(directory, 'package.json');
  if (!existsSync(manifestPath)) {
    throw new Error(`The host has no ${name} to build a panel with: ${manifestPath} is missing`);
  }
  const manifest = readPackageManifest(manifestPath);
  const subpath = specifier === name ? '.' : `.${specifier.slice(name.length)}`;
  const entry = exportEntry(manifest.exports, subpath);
  const target = typeof entry === 'string' ? entry : exportTarget(entry, PANEL_CONDITIONS);
  const relative =
    target ??
    (manifest.exports !== undefined
      ? undefined
      : subpath === '.'
        ? (manifest.module ?? manifest.main)
        : subpath.slice(2));
  if (relative === undefined) {
    throw new Error(`${name} does not export ${subpath} to a panel build`);
  }
  // The real path: a package's own dependencies sit beside it in the install, not beside the link.
  return realpathSync(join(directory, relative));
}

/** A bundler plugin that resolves {@link HOST_PANEL_PACKAGES} from `dependencies`. */
export function hostPanelPackages(dependencies: string): Bun.BunPlugin {
  return {
    name: 'host-panel-packages',
    setup(builder) {
      builder.onResolve({ filter: /^(?:svelte|@lostgradient\/cinder)(?:\/|$)/ }, ({ path }) => {
        const resolved = resolveHostPanelPackage(dependencies, path);
        return resolved === undefined ? undefined : { path: resolved };
      });
    },
  };
}

/** The two functions of `svelte/compiler` a panel build calls. */
export type SvelteCompiler = {
  /** Compile one component; `js.code` is the module Bun loads. */
  readonly compile: (
    source: string,
    options: Record<string, unknown>,
  ) => { readonly js: { readonly code: string } };
  /** Compile one rune module (`.svelte.js`); `js.code` is the module Bun loads. */
  readonly compileModule: (
    source: string,
    options: Record<string, unknown>,
  ) => { readonly js: { readonly code: string } };
};

const compilers = new Map<string, Promise<SvelteCompiler>>();

/** The compiler of the `svelte` the host holds under `dependencies`, loaded once per directory. */
function hostSvelteCompiler(dependencies: string): Promise<SvelteCompiler> {
  let compiler = compilers.get(dependencies);
  if (compiler === undefined) {
    const path = resolveHostPanelPackage(dependencies, 'svelte/compiler');
    if (path === undefined) throw new Error('svelte/compiler is not a host panel package');
    compiler = loadSvelteCompiler(path);
    compilers.set(dependencies, compiler);
    // A directory that held no compiler is not remembered, so staging it later works.
    compiler.catch(() => compilers.delete(dependencies));
  }
  return compiler;
}

/** Whether `value` is the module `svelte/compiler`: it compiles components and rune modules. */
function isSvelteCompiler(value: unknown): value is SvelteCompiler {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof Reflect.get(value, 'compile') === 'function' &&
    typeof Reflect.get(value, 'compileModule') === 'function'
  );
}

/** Import the Svelte compiler at `path`, and refuse a module that is not it. */
async function loadSvelteCompiler(path: string): Promise<SvelteCompiler> {
  const loaded: unknown = await import(pathToFileURL(path).href);
  if (!isSvelteCompiler(loaded)) throw new Error(`${path} is not the Svelte compiler`);
  return loaded;
}

const typeScript = new Bun.Transpiler({ loader: 'ts' });

/**
 * Compile one Svelte component as the application build does: client code, styles injected into the
 * script, production mode (`compileSvelteComponentForBun` of `@lostgradient/testing`, whose output
 * `panel-build.test.ts` holds this equal to).
 */
export function compileSveltePanelComponent(
  compiler: SvelteCompiler,
  source: string,
  path: string,
): string {
  return compiler.compile(source, {
    filename: path,
    generate: 'client',
    css: 'injected',
    dev: false,
  }).js.code;
}

/** Compile a Svelte rune module (`.svelte.ts` or `.svelte.js`) the same way. */
export function compileSveltePanelModule(
  compiler: SvelteCompiler,
  source: string,
  path: string,
): string {
  const moduleSource = path.endsWith('.ts') ? typeScript.transformSync(source) : source;
  return compiler.compileModule(moduleSource, { filename: path, generate: 'client', dev: false }).js
    .code;
}

/** The bundler plugin that compiles `.svelte` files and rune modules with the host's compiler. */
async function sveltePanelPlugin(dependencies: string): Promise<Bun.BunPlugin> {
  const compiler = await hostSvelteCompiler(dependencies);
  return {
    name: 'svelte-panel',
    setup(builder) {
      builder.onLoad({ filter: /\.svelte$/ }, async ({ path }) => ({
        contents: compileSveltePanelComponent(compiler, await Bun.file(path).text(), path),
        loader: 'js',
        resolveDir: dirname(path),
      }));
      builder.onLoad({ filter: /\.svelte\.[jt]s$/ }, async ({ path }) => ({
        contents: compileSveltePanelModule(compiler, await Bun.file(path).text(), path),
        loader: 'js',
        resolveDir: dirname(path),
      }));
    },
  };
}

/**
 * How long the host waits for one panel to build before it reports the panel as failed, in
 * milliseconds (COR-2219). A product timeout, not a test wait: a hung `Bun.build` would otherwise
 * hold the host's startup for as long as it hangs. Tests give {@link withPanelBuildDeadline} a
 * clock of their own, and none of them waits this long.
 */
export const PANEL_BUILD_DEADLINE_MILLISECONDS = 30_000;

/** The two functions of a timer {@link withPanelBuildDeadline} uses, so a test can fire it itself. */
export type PanelBuildClock = {
  /** Call `callback` once after `milliseconds`, and return what stops it. */
  readonly setTimeout: (callback: () => void, milliseconds: number) => unknown;
  /** Stop the timer `setTimeout` returned. */
  readonly clearTimeout: (handle: unknown) => void;
};

const platformTimers = new Map<object, ReturnType<typeof setTimeout>>();

/** The platform's timers. A timer is named by a token of its own, so the clock holds no platform handle type. */
export const REAL_PANEL_BUILD_CLOCK: PanelBuildClock = {
  setTimeout: (callback, milliseconds) => {
    const token = {};
    // poll-reason: timer
    const timer = globalThis.setTimeout(() => {
      platformTimers.delete(token);
      callback();
    }, milliseconds);
    platformTimers.set(token, timer);
    return token;
  },
  clearTimeout: (handle) => {
    if (typeof handle !== 'object' || handle === null) return;
    const timer = platformTimers.get(handle);
    if (timer === undefined) return;
    globalThis.clearTimeout(timer);
    platformTimers.delete(handle);
  },
};

/**
 * `work`, or a rejection once {@link PANEL_BUILD_DEADLINE_MILLISECONDS} have passed on `clock`,
 * whichever comes first. The timer is cleared as soon as `work` settles. `work` is not stopped when
 * the deadline passes, because `Bun.build` cannot be cancelled: what it makes late is not served by
 * this start, which has reported the panel failed, and the cache still stores a page that is
 * complete, so the next start serves it.
 */
export function withPanelBuildDeadline<T>(
  work: Promise<T>,
  title: string,
  clock: PanelBuildClock = REAL_PANEL_BUILD_CLOCK,
): Promise<T> {
  const { promise, resolve, reject } = Promise.withResolvers<T>();
  // poll-reason: timer
  const handle = clock.setTimeout(
    () =>
      reject(
        new Error(
          `The ${title} page did not finish building within ${PANEL_BUILD_DEADLINE_MILLISECONDS / 1000} seconds`,
        ),
      ),
    PANEL_BUILD_DEADLINE_MILLISECONDS,
  );
  // The timer is stopped in the same turn the caller is told of the result, so none outlives the build.
  void (async () => {
    try {
      resolve(await work);
    } catch (error) {
      reject(error);
    } finally {
      clock.clearTimeout(handle);
    }
  })();
  return promise;
}

/** The real path of `path`, or its absolute path when nothing is there to resolve. */
function realPathOrAbsolute(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolvePath(path);
  }
}

/**
 * What names the package `name` under `dependencies` to a build: the version it declares or, when
 * it declares none (Cinder, a private workspace package, has no `version`), `unversioned:` and a
 * digest of where the package really is and what its manifest says. The files the build reads are
 * hashed too; this is what tells two installs apart before any of them is read.
 */
function hostPackageIdentity(dependencies: string, name: string): string {
  const directory = join(dependencies, name);
  const manifestPath = join(directory, 'package.json');
  if (!existsSync(manifestPath)) return 'absent';
  const { version } = readPackageManifest(manifestPath);
  if (version !== undefined) return version;
  const digest = new Bun.CryptoHasher('sha256')
    .update(`${realPathOrAbsolute(directory)}\0${readFileSync(manifestPath, 'utf8')}`)
    .digest('hex');
  return `unversioned:${digest}`;
}

/**
 * What a panel's build depends on besides its files: Bun's version, the real path of the host's
 * `node_modules` that `svelte` and Cinder resolve from, and the identity of each. They key the
 * build cache, so a home that two installs share never serves one install's page to the other.
 */
export function panelBuildVersions(dependencies: string = HOST_DEPENDENCIES): {
  readonly bunVersion: string;
  readonly svelteVersion: string;
  readonly cinderVersion: string;
  readonly dependencies: string;
} {
  return {
    bunVersion: Bun.version,
    svelteVersion: hostPackageIdentity(dependencies, 'svelte'),
    cinderVersion: hostPackageIdentity(dependencies, '@lostgradient/cinder'),
    dependencies: realPathOrAbsolute(dependencies),
  };
}

/** What a panel build is given. */
export type PanelBuildRequest = {
  /** The panel's entry, as a `file:` URL. */
  readonly entry: string;
  /** The page's title. */
  readonly title: string;
  /** The plugin's own styles, placed after the kit's. */
  readonly styles: string;
  /** The host's `node_modules`, which `svelte` and `@lostgradient/cinder` resolve from. */
  readonly dependencies?: string;
};

/** A built page and, when the builder knows them, every file it read to make it. */
export type BuiltPanelWithInputs = BuiltPanel & {
  /** The absolute path of every file the build read, the entry and the whole import graph. */
  readonly inputs?: readonly string[];
};

/** What builds a panel's page: {@link buildPanelPage}, or a double that counts, stalls or fakes it. */
export type PanelPageBuilder = (request: PanelBuildRequest) => Promise<BuiltPanelWithInputs>;

/** Bundle `entry` and wrap it in a page with `title` and `styles`. */
export async function buildPanelPage(
  options: PanelBuildRequest,
): Promise<BuiltPanel & { readonly inputs: readonly string[] }> {
  const result = await Bun.build({
    entrypoints: [fileURLToPath(options.entry)],
    target: 'browser',
    format: 'esm',
    minify: true,
    metafile: true,
    conditions: ['browser', 'svelte'],
    define: { 'process.env.NODE_ENV': JSON.stringify('production') },
    plugins: [
      hostPanelPackages(options.dependencies ?? HOST_DEPENDENCIES),
      await sveltePanelPlugin(options.dependencies ?? HOST_DEPENDENCIES),
    ],
  });
  if (!result.success) {
    throw new AggregateError(result.logs, `The ${options.title} page did not build`);
  }
  const scripts = result.outputs.filter((output) => output.kind === 'entry-point');
  const stylesheets = result.outputs.filter((output) => output.path.endsWith('.css'));
  const others = result.outputs.filter(
    (output) => !scripts.includes(output) && !stylesheets.includes(output),
  );
  if (scripts.length !== 1 || others.length > 0) {
    // One document cannot carry a chunk, a file or an image beside its script.
    throw new AggregateError(
      result.logs,
      `The ${options.title} page did not build into one script: it produced ${result.outputs
        .map((output) => `${output.kind} ${output.path}`)
        .join(', ')}`,
    );
  }
  const script = await scripts[0]!.text();
  const builtStyles = await Promise.all(stylesheets.map((output) => output.text()));
  const styles = [...builtStyles, options.styles].filter((css) => css !== '').join('\n');
  const html = `<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeText(options.title)}</title><style>${inlineStyle(styles)}</style><div id="root"></div><script type="module">${inlineScript(script)}</script>`;
  // The metafile names inputs relative to the working directory the build ran in.
  const inputs = Object.keys(result.metafile?.inputs ?? {}).map((path) => resolvePath(path));
  return { html, contentDigest: digestOf(html), inputs };
}

/**
 * A digest of the host's own build code: the text of every function a build runs, and the
 * conditions it resolves under. The build cache keys a page by it, so a host whose build changed
 * never serves a page an older build made, with nobody having to remember to bump a constant. It
 * reads the functions' own text, not a file, because a release's executable carries no source
 * file to read; the text is what runs in either.
 */
export function panelBuildCodeDigest(): string {
  const hasher = new Bun.CryptoHasher('sha256');
  const parts: readonly unknown[] = [
    PANEL_CONDITIONS,
    HOST_PANEL_PACKAGES,
    inlineScript,
    inlineStyle,
    escapeText,
    digestOf,
    exportTarget,
    exportEntry,
    resolveHostPanelPackage,
    hostPanelPackages,
    compileSveltePanelComponent,
    compileSveltePanelModule,
    sveltePanelPlugin,
    buildPanelPage,
  ];
  for (const part of parts) {
    hasher.update(`${typeof part === 'function' ? part.toString() : JSON.stringify(part)}\0`);
  }
  return hasher.digest('hex');
}
