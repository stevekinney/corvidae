#!/usr/bin/env bun
/**
 * COR-510 (DR-9, local release readiness): the tarball validator the contract specifies.
 *
 * A Bun CLI that proves the diff-review public surface actually works from installed,
 * registry-shaped tarballs — never workspace source — by building an isolated temporary consumer
 * per fixture, installing only the supplied tarballs plus pinned peers with Bun, and running the
 * import/style, SSR, browser-hydration, and aggregate-export matrix against it. It writes
 * `manifest.json` under `--evidence-directory` with installed versions, tarball hashes, resolved
 * module paths, exit codes, and per-case results.
 *
 * This is the published-artifact gate DR-9 names, separate from the existing staged-package
 * consumer scripts (`validate:consumer` and friends), which prove the mirror's own transform is
 * internally consistent but never install from a real tarball the way this does.
 *
 * @module
 */
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ============================================================================
// Argument parsing (pure)
// ============================================================================

export interface ValidatorArguments {
  cinderTarball: string;
  editorTarball: string;
  evidenceDirectory: string;
  /** Optional: a locally built Markdown tarball. Defaults to the registry's `^0.5.0`. */
  markdownTarball: string | undefined;
}

export interface ArgumentError {
  code: 'missing-argument' | 'not-absolute';
  option: string;
  message: string;
}

export type ArgumentResult =
  { ok: true; value: ValidatorArguments } | { ok: false; error: ArgumentError };

const REQUIRED_OPTIONS = ['cinder-tarball', 'editor-tarball', 'evidence-directory'] as const;
const OPTIONAL_ABSOLUTE_OPTIONS = ['markdown-tarball'] as const;

function readOption(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(`--${name}`);
  if (index === -1) return undefined;
  return argv[index + 1];
}

function requireAbsolute(option: string, value: string): ArgumentError | undefined {
  if (!value.startsWith('/')) {
    return {
      code: 'not-absolute',
      option,
      message: `--${option} must be an absolute path, got ${JSON.stringify(value)}`,
    };
  }
  return undefined;
}

/**
 * Parses and validates argv for the three required, always-absolute options plus the optional
 * `--markdown-tarball`. Pure: no filesystem access, so every failure path is unit-testable without
 * a real tarball on disk.
 */
export function parseArguments(argv: readonly string[]): ArgumentResult {
  for (const option of REQUIRED_OPTIONS) {
    const value = readOption(argv, option);
    if (value === undefined) {
      return {
        ok: false,
        error: { code: 'missing-argument', option, message: `Missing required option --${option}` },
      };
    }
    const error = requireAbsolute(option, value);
    if (error) return { ok: false, error };
  }
  for (const option of OPTIONAL_ABSOLUTE_OPTIONS) {
    const value = readOption(argv, option);
    if (value === undefined) continue;
    const error = requireAbsolute(option, value);
    if (error) return { ok: false, error };
  }
  return {
    ok: true,
    value: {
      cinderTarball: readOption(argv, 'cinder-tarball')!,
      editorTarball: readOption(argv, 'editor-tarball')!,
      evidenceDirectory: readOption(argv, 'evidence-directory')!,
      markdownTarball: readOption(argv, 'markdown-tarball'),
    },
  };
}

// ============================================================================
// Manifest (pure)
// ============================================================================

export type CaseStatus = 'pass' | 'fail';

export interface CaseResult {
  /** `<fixture>/<case>`, e.g. `annotated/import`. */
  id: string;
  fixture: 'plain-cinder' | 'annotated' | 'aggregate';
  status: CaseStatus;
  detail?: string | undefined;
  resolvedPaths?: Record<string, string> | undefined;
}

export interface TarballRecord {
  path: string;
  sha256: string;
}

export interface RegistryManifest {
  schemaVersion: 1;
  generatedAt: string;
  cinderTarball: TarballRecord;
  editorTarball: TarballRecord;
  markdownTarball: TarballRecord | { registryRange: string };
  installedVersions: Record<string, string>;
  cases: CaseResult[];
  exitCode: number;
}

export interface BuildManifestInput {
  now?: () => string;
  cinderTarball: TarballRecord;
  editorTarball: TarballRecord;
  markdownTarball: TarballRecord | { registryRange: string };
  installedVersions: Record<string, string>;
  cases: CaseResult[];
}

/**
 * Builds the manifest and computes its exit code from the case list: any failed case, or an empty
 * case list (a matrix that ran nothing proved nothing — DR-9 requires it to "fail on any missing
 * case"), makes the run non-zero.
 */
export function buildManifest(input: BuildManifestInput): RegistryManifest {
  const now = input.now ?? (() => new Date().toISOString());
  const cases =
    input.cases.length > 0
      ? input.cases
      : [
          {
            id: 'matrix/no-cases',
            fixture: 'plain-cinder' as const,
            status: 'fail' as const,
            detail: 'No matrix cases ran; a validator that runs nothing proves nothing.',
          },
        ];
  const exitCode = cases.some((c) => c.status === 'fail') ? 1 : 0;
  return {
    schemaVersion: 1,
    generatedAt: now(),
    cinderTarball: input.cinderTarball,
    editorTarball: input.editorTarball,
    markdownTarball: input.markdownTarball,
    installedVersions: input.installedVersions,
    cases,
    exitCode,
  };
}

// ============================================================================
// Hashing and process helpers
// ============================================================================

export async function sha256File(path: string): Promise<string> {
  const buffer = await Bun.file(path).arrayBuffer();
  const hasher = new Bun.CryptoHasher('sha256');
  hasher.update(new Uint8Array(buffer));
  return hasher.digest('hex');
}

export interface SpawnResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type Spawner = (command: readonly string[], cwd: string) => Promise<SpawnResult>;

export const defaultSpawner: Spawner = async (command, cwd) => {
  const proc = Bun.spawn([...command], { cwd, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
};

// ============================================================================
// Fixture consumers
// ============================================================================

interface FixtureDefinition {
  name: 'plain-cinder' | 'annotated' | 'aggregate';
  dependencies: Record<string, string>;
  resolutions: Record<string, string>;
}

const PEER_VERSIONS = {
  svelte: '^5.56.7',
  milkdownCtx: '^7.17.3',
  milkdownKit: '^7.17.3',
  milkdownProse: '^7.17.3',
  prosemirrorInputrules: '^1.5.1',
  prosemirrorModel: '^1.25.4',
  prosemirrorState: '^1.4.4',
  prosemirrorView: '^1.41.3',
};

function fixturesFor(args: ValidatorArguments): FixtureDefinition[] {
  const markdownSpecifier = args.markdownTarball ? `file:${args.markdownTarball}` : '^0.5.0';
  const cinderSpecifier = `file:${args.cinderTarball}`;
  const editorAndFriends: Record<string, string> = {
    '@lostgradient/editor': `file:${args.editorTarball}`,
    '@lostgradient/markdown': markdownSpecifier,
    svelte: PEER_VERSIONS.svelte,
    '@milkdown/ctx': PEER_VERSIONS.milkdownCtx,
    '@milkdown/kit': PEER_VERSIONS.milkdownKit,
    '@milkdown/prose': PEER_VERSIONS.milkdownProse,
    'prosemirror-inputrules': PEER_VERSIONS.prosemirrorInputrules,
    'prosemirror-model': PEER_VERSIONS.prosemirrorModel,
    'prosemirror-state': PEER_VERSIONS.prosemirrorState,
    'prosemirror-view': PEER_VERSIONS.prosemirrorView,
  };
  // `resolutions` forces every transitive `@lostgradient/cinder`/`@lostgradient/markdown` edge
  // (Editor's own `peerDependencies/dependencies` name them as semver ranges) onto the exact
  // supplied tarballs rather than the real registry — this is what makes "resolves from the
  // supplied tarballs, never the registry" actually true; without it Bun's resolver treats a
  // nested `^x.y.z` edge as needing independent registry satisfaction even when a `file:` copy of
  // the same package is already installed at the workspace root.
  const resolutions: Record<string, string> = { '@lostgradient/cinder': cinderSpecifier };
  if (args.markdownTarball) resolutions['@lostgradient/markdown'] = `file:${args.markdownTarball}`;

  return [
    {
      name: 'plain-cinder',
      dependencies: { '@lostgradient/cinder': cinderSpecifier, svelte: PEER_VERSIONS.svelte },
      resolutions: {},
    },
    {
      name: 'annotated',
      dependencies: { '@lostgradient/cinder': cinderSpecifier, ...editorAndFriends },
      resolutions,
    },
    {
      name: 'aggregate',
      dependencies: { '@lostgradient/cinder': cinderSpecifier, ...editorAndFriends },
      resolutions,
    },
  ];
}

async function writeConsumer(directory: string, fixture: FixtureDefinition): Promise<void> {
  const manifest: Record<string, unknown> = {
    name: `diff-review-registry-validator-${fixture.name}`,
    private: true,
    type: 'module',
    dependencies: fixture.dependencies,
  };
  if (Object.keys(fixture.resolutions).length > 0) manifest['resolutions'] = fixture.resolutions;
  await mkdir(directory, { recursive: true });
  await Bun.write(join(directory, 'package.json'), `${JSON.stringify(manifest, undefined, 2)}\n`);
}

async function installConsumer(directory: string, spawn: Spawner): Promise<SpawnResult> {
  return spawn(['bun', 'install'], directory);
}

async function installedVersionOf(
  directory: string,
  packageName: string,
): Promise<string | undefined> {
  const manifestPath = join(directory, 'node_modules', packageName, 'package.json');
  const file = Bun.file(manifestPath);
  if (!(await file.exists())) return undefined;
  const manifest = (await file.json()) as { version?: string };
  return manifest.version;
}

// ============================================================================
// Probes (each writes a small script into the fixture and runs it under `bun run`)
// ============================================================================

/** A probe script's own emitted result line, one JSON object per `console.log`. */
interface ProbeCase {
  id: string;
  status: CaseStatus;
  detail?: string | undefined;
  resolvedPaths?: Record<string, string> | undefined;
}

function parseProbeOutput(stdout: string): ProbeCase[] {
  const cases: ProbeCase[] = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('PROBE ')) continue;
    try {
      cases.push(JSON.parse(trimmed.slice('PROBE '.length)) as ProbeCase);
    } catch {
      // A malformed line is not a case result; the probe's own crash is reported separately by
      // the caller from the process's exit code and stderr.
    }
  }
  return cases;
}

const IMPORT_STYLE_PROBE_SOURCE = `
async function run(specifiers) {
  for (const specifier of specifiers) {
    try {
      const resolved = import.meta.resolve(specifier);
      const inTarball = resolved.includes('/node_modules/@lostgradient/');
      const isWorkspaceSource = resolved.includes('/components/cinder/src/') || resolved.includes('/components/editor/src/');
      const mod = await import(specifier);
      const ok = inTarball && !isWorkspaceSource && typeof mod === 'object' && mod !== null;
      console.log('PROBE ' + JSON.stringify({ id: specifier, status: ok ? 'pass' : 'fail', resolvedPaths: { [specifier]: resolved } }));
    } catch (error) {
      console.log('PROBE ' + JSON.stringify({ id: specifier, status: 'fail', detail: String(error && error.message || error) }));
    }
  }
}
await run(__SPECIFIERS__);
`;

async function runImportStyleProbe(
  directory: string,
  fixtureName: FixtureDefinition['name'],
  specifiers: string[],
  spawn: Spawner,
): Promise<CaseResult[]> {
  const source = IMPORT_STYLE_PROBE_SOURCE.replace('__SPECIFIERS__', JSON.stringify(specifiers));
  const probePath = join(directory, '.import-style-probe.mjs');
  await Bun.write(probePath, source);
  const result = await spawn(['bun', 'run', probePath], directory);
  const cases = parseProbeOutput(result.stdout);
  if (cases.length === 0) {
    return [
      {
        id: `${fixtureName}/import-style`,
        fixture: fixtureName,
        status: 'fail',
        detail: `Probe produced no case output (exit ${result.exitCode}): ${result.stderr || result.stdout}`,
      },
    ];
  }
  return cases.map((c) => ({
    id: `${fixtureName}/${c.id.startsWith('@') ? c.id : `import-style:${c.id}`}`,
    fixture: fixtureName,
    status: c.status,
    detail: c.detail,
    resolvedPaths: c.resolvedPaths,
  }));
}

const NO_EDITOR_PROBE_SOURCE = `
try {
  await import('@lostgradient/editor');
  console.log('PROBE ' + JSON.stringify({ id: 'no-editor', status: 'fail', detail: 'Editor unexpectedly resolved in the plain Cinder fixture' }));
} catch {
  console.log('PROBE ' + JSON.stringify({ id: 'no-editor', status: 'pass' }));
}
`;

async function runNoEditorProbe(directory: string, spawn: Spawner): Promise<CaseResult> {
  const probePath = join(directory, '.no-editor-probe.mjs');
  await Bun.write(probePath, NO_EDITOR_PROBE_SOURCE);
  const result = await spawn(['bun', 'run', probePath], directory);
  const [probeCase] = parseProbeOutput(result.stdout);
  return {
    id: 'plain-cinder/no-editor',
    fixture: 'plain-cinder',
    status: probeCase?.status ?? 'fail',
    detail:
      probeCase?.detail ?? (probeCase ? undefined : `Probe produced no output: ${result.stderr}`),
  };
}

const AGGREGATE_EXPORT_PROBE_SOURCE = `
import {
  createDiffReviewState,
  reduceDiffReviewState,
  validSourceTargetFixture,
  validMarkdownTargetFixture,
} from '@lostgradient/editor/diff-review-state';
import { exportDiffReviewMarkdown, exportDiffReviewJson } from '@lostgradient/editor/export';

function count(haystack, needle) {
  return haystack.split(needle).length - 1;
}

function report(id, ok, detail) {
  console.log('PROBE ' + JSON.stringify({ id, status: ok ? 'pass' : 'fail', detail }));
}

const created = createDiffReviewState([validSourceTargetFixture, validMarkdownTargetFixture]);
if (!created.ok) { report('aggregate-export', false, 'createDiffReviewState: ' + JSON.stringify(created.error)); }
else {
  const withSource = reduceDiffReviewState(created.value, {
    type: 'create-comment',
    targetId: validSourceTargetFixture.targetId,
    anchor: { kind: 'file', fileOccurrence: 0 },
    body: 'AGGREGATE-PROBE-SOURCE-COMMENT',
  });
  const withMarkdown = withSource.ok
    ? reduceDiffReviewState(withSource.value, {
        type: 'create-comment',
        targetId: validMarkdownTargetFixture.targetId,
        anchor: { kind: 'file', fileOccurrence: 0 },
        body: 'AGGREGATE-PROBE-MARKDOWN-COMMENT',
      })
    : withSource;
  if (!withSource.ok || !withMarkdown.ok) {
    report('aggregate-export', false, 'reduceDiffReviewState failed: ' + JSON.stringify((!withSource.ok ? withSource : withMarkdown).error));
  } else {
    const markdown = exportDiffReviewMarkdown(withMarkdown.value);
    const json = exportDiffReviewJson(withMarkdown.value);
    if (!markdown.ok || !json.ok) {
      report('aggregate-export', false, 'export failed');
    } else {
      const ok =
        count(markdown.value, 'AGGREGATE-PROBE-SOURCE-COMMENT') === 1 &&
        count(markdown.value, 'AGGREGATE-PROBE-MARKDOWN-COMMENT') === 1 &&
        count(json.value, 'AGGREGATE-PROBE-SOURCE-COMMENT') === 1 &&
        count(json.value, 'AGGREGATE-PROBE-MARKDOWN-COMMENT') === 1;
      report(
        'aggregate-export',
        ok,
        ok ? undefined : 'a saved comment did not appear exactly once across both export surfaces',
      );
    }
  }
}
`;

async function runAggregateExportProbe(directory: string, spawn: Spawner): Promise<CaseResult> {
  const probePath = join(directory, '.aggregate-export-probe.mjs');
  await Bun.write(probePath, AGGREGATE_EXPORT_PROBE_SOURCE);
  const result = await spawn(['bun', 'run', probePath], directory);
  const [probeCase] = parseProbeOutput(result.stdout);
  return {
    id: 'aggregate/export',
    fixture: 'aggregate',
    status: probeCase?.status ?? 'fail',
    detail:
      probeCase?.detail ??
      (probeCase
        ? undefined
        : `Probe produced no output (exit ${result.exitCode}): ${result.stderr || result.stdout}`),
  };
}

/** SSR: default `bun run` resolution activates the `node` condition, which the manifests point at each component's server-compiled dist. A crash-free import plus a callable/renderable default export is the smoke proof. */
const SSR_PROBE_SOURCE = `
async function run(specifiers) {
  for (const specifier of specifiers) {
    try {
      const mod = await import(specifier);
      const ok = typeof mod === 'object' && mod !== null && 'default' in mod;
      console.log('PROBE ' + JSON.stringify({ id: specifier, status: ok ? 'pass' : 'fail', detail: ok ? undefined : 'module has no default export' }));
    } catch (error) {
      console.log('PROBE ' + JSON.stringify({ id: specifier, status: 'fail', detail: String(error && error.message || error) }));
    }
  }
}
await run(__SPECIFIERS__);
`;

async function runSsrProbe(
  directory: string,
  fixtureName: FixtureDefinition['name'],
  specifiers: string[],
  spawn: Spawner,
): Promise<CaseResult[]> {
  const source = SSR_PROBE_SOURCE.replace('__SPECIFIERS__', JSON.stringify(specifiers));
  const probePath = join(directory, '.ssr-probe.mjs');
  await Bun.write(probePath, source);
  const result = await spawn(['bun', 'run', probePath], directory);
  const cases = parseProbeOutput(result.stdout);
  if (cases.length === 0) {
    return [
      {
        id: `${fixtureName}/ssr`,
        fixture: fixtureName,
        status: 'fail',
        detail: `SSR probe produced no case output (exit ${result.exitCode}): ${result.stderr || result.stdout}`,
      },
    ];
  }
  return cases.map((c) => ({
    id: `${fixtureName}/ssr:${c.id}`,
    fixture: fixtureName,
    status: c.status,
    detail: c.detail,
  }));
}

// ============================================================================
// Browser hydration
// ============================================================================

async function buildHydrationBundle(directory: string, entrySource: string): Promise<string> {
  const entryPath = join(directory, '.hydration-entry.mjs');
  await Bun.write(entryPath, entrySource);
  const result = await Bun.build({ entrypoints: [entryPath], target: 'browser', format: 'esm' });
  if (!result.success) {
    throw new Error(result.logs.map((log) => log.message).join('\n'));
  }
  return result.outputs[0] ? await result.outputs[0].text() : '';
}

/** The path the hydration test page's `<script>` fetches its bundle from. Exported for its own test. */
export const HYDRATION_BUNDLE_PATH = '/hydration-bundle.js';

/**
 * The hydration case's test page, referencing its bundle by URL rather than inlining it.
 *
 * A built bundle can legitimately contain HTML-tokenizer-significant byte sequences inside
 * otherwise inert JS/data content -- confirmed, in the `annotated` fixture, to include the literal
 * text `</script>` (from a bundled Shiki HTML-language TextMate grammar's own
 * `"end":"(?=</(?i:script))"` pattern) and, elsewhere in the same ~13.7 MB bundle, `<!--` (33
 * occurrences; unconfirmed which line). The old code interpolated the built bundle directly into
 * `<script type="module">${bundle}</script>`. The BROWSER'S HTML PARSER recognizes `</script` as a
 * real closing tag regardless of JS-string context, so it closed the real `<script>` element early
 * at that embedded occurrence. Everything after that point in the bundle -- several megabytes of
 * otherwise-valid, never-reached JS source -- then landed in the page as literal body markup
 * instead of executing, and the HTML tokenizer's ordinary attribute-parsing rules turned bare JS
 * identifiers sitting inside that leftover text into real DOM attributes: reproducing the exact
 * failure and inspecting the resulting DOM found an `<svg>` element (from the bundled `qrcode`
 * package's own SVG-string-building source, itself reachable only because
 * `@lostgradient/cinder`'s root barrel includes `QrCode`) whose outerHTML was
 * `<svg xmlns="..." '="" +="" width="" viewBox="" shape-rendering="crispEdges">` -- the JS source
 * `'<svg xmlns="..." ' + width + viewBox + ' shape-rendering="crispEdges">'`, tokenized as markup,
 * turns the bare identifiers `width` and `viewBox` into valueless attributes, which Blink's
 * SVG-attribute-value parser then rejected as an empty `<length>` and an empty `viewBox`,
 * respectively -- exactly the two observed console errors, and unrelated to any Editor/Cinder
 * component's actual rendering. (A naive fix of escaping every `</script` occurrence before
 * inlining is not sufficient: this bundle also contains `<!--`, which puts the HTML tokenizer into
 * the script-data-escaped states where `<script`/`</script` sequences change meaning again,
 * confirmed by that approach still producing a page-load `SyntaxError` when tried.) Confirmed by
 * reproducing the identical bundle and switching only this page-construction detail (inline text
 * vs. this external-script form): the errors disappear and the component mounts correctly, with no
 * other change. Serving the bundle from its own URL removes the hazard by construction, for any
 * bundle content: the HTML text never contains the bundle at all, so the HTML parser never
 * tokenizes any of it.
 */
export function hydrationPageHtml(): string {
  return `<!doctype html><html><body><div id="app"></div><script type="module" src="${HYDRATION_BUNDLE_PATH}"></script></body></html>`;
}

/** Serves the fixed test page at `/` and the bundle, verbatim, at {@link HYDRATION_BUNDLE_PATH}. */
export function hydrationFetchHandler(bundle: string): (request: Request) => Response {
  const html = hydrationPageHtml();
  return (request) => {
    const { pathname } = new URL(request.url);
    if (pathname === HYDRATION_BUNDLE_PATH) {
      return new Response(bundle, { headers: { 'content-type': 'text/javascript' } });
    }
    return new Response(html, { headers: { 'content-type': 'text/html' } });
  };
}

async function runHydrationCase(
  directory: string,
  fixtureName: FixtureDefinition['name'],
  entrySource: string,
  markerText: string,
): Promise<CaseResult> {
  const id = `${fixtureName}/hydration`;
  let bundle: string;
  try {
    bundle = await buildHydrationBundle(directory, entrySource);
  } catch (error) {
    return {
      id,
      fixture: fixtureName,
      status: 'fail',
      detail: `bundling failed: ${String(error)}`,
    };
  }

  const server = Bun.serve({ port: 0, fetch: hydrationFetchHandler(bundle) });
  try {
    const { chromium } = await import('@playwright/test');
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      const consoleErrors: string[] = [];
      page.on('console', (message) => {
        if (message.type() === 'error') consoleErrors.push(message.text());
      });
      await page.goto(`http://localhost:${server.port}/`);
      // `state: 'attached'`, not the default `'visible'`: this proves the component actually
      // hydrated and rendered its real markup into the DOM, which is what this case exists to
      // prove. Whether it is also painted visible depends on stylesheet delivery this build does
      // not attempt to replicate (a real published tarball's CSS pipeline is a separate,
      // already-covered concern — the `/styles` subpath resolution case above).
      await page.waitForSelector(`text=${markerText}`, { timeout: 5000, state: 'attached' });
      const bodyText = await page.textContent('body');
      const mounted = Boolean(bodyText && bodyText.includes(markerText));
      return {
        id,
        fixture: fixtureName,
        status: mounted && consoleErrors.length === 0 ? 'pass' : 'fail',
        detail: mounted
          ? consoleErrors.length > 0
            ? `console errors during hydration: ${consoleErrors.join('; ')}`
            : undefined
          : 'expected marker text did not appear after hydration',
      };
    } finally {
      await browser.close();
    }
  } catch (error) {
    return { id, fixture: fixtureName, status: 'fail', detail: String(error) };
  } finally {
    await server.stop(true);
  }
}

// ============================================================================
// Orchestration
// ============================================================================

const PLAIN_CINDER_IMPORT_SPECIFIERS = [
  '@lostgradient/cinder/source-diff-viewer',
  '@lostgradient/cinder/source-diff-viewer/styles',
];

const ANNOTATED_IMPORT_SPECIFIERS = [
  '@lostgradient/editor/diff-review',
  '@lostgradient/editor/diff-review/styles',
  '@lostgradient/editor/diff-review-comments',
  '@lostgradient/editor/diff-review-comments/styles',
  '@lostgradient/editor/diff-review-state',
  '@lostgradient/editor/export',
  '@lostgradient/editor/diff-viewer',
  '@lostgradient/editor/review-editor',
];

const SSR_SPECIFIERS = [
  '@lostgradient/editor/diff-review',
  '@lostgradient/editor/diff-review-comments',
  '@lostgradient/editor/diff-viewer',
  '@lostgradient/editor/review-editor',
];

const CINDER_HYDRATION_ENTRY = `
import { mount } from 'svelte';
import SourceDiffViewer from '@lostgradient/cinder/source-diff-viewer';
mount(SourceDiffViewer, {
  target: document.getElementById('app'),
  props: { patch: 'diff --git a/x b/x\\n--- a/x\\n+++ b/x\\n@@ -1,1 +1,1 @@\\n-old\\n+new\\n' },
});
`;

const DIFF_REVIEW_COMMENTS_HYDRATION_ENTRY = `
import { mount } from 'svelte';
import DiffReviewComments from '@lostgradient/editor/diff-review-comments';
import { createDiffReviewState, validSourceTargetFixture } from '@lostgradient/editor/diff-review-state';
const created = createDiffReviewState([validSourceTargetFixture]);
if (!created.ok) throw new Error('createDiffReviewState failed');
mount(DiffReviewComments, {
  target: document.getElementById('app'),
  props: { state: created.value, onStateChange: () => {} },
});
`;

export interface RunOptions {
  spawn?: Spawner;
  tempRoot?: string;
}

export async function runValidator(
  args: ValidatorArguments,
  options: RunOptions = {},
): Promise<RegistryManifest> {
  const spawn = options.spawn ?? defaultSpawner;
  const cases: CaseResult[] = [];
  const workRoot = await mkdtemp(join(options.tempRoot ?? tmpdir(), 'diff-review-registry-'));

  try {
    const fixtures = fixturesFor(args);
    const installedVersions: Record<string, string> = {};

    for (const fixture of fixtures) {
      const directory = join(workRoot, fixture.name);
      await writeConsumer(directory, fixture);
      const install = await installConsumer(directory, spawn);
      if (install.exitCode !== 0) {
        cases.push({
          id: `${fixture.name}/install`,
          fixture: fixture.name,
          status: 'fail',
          detail: `bun install exited ${install.exitCode}: ${install.stderr || install.stdout}`,
        });
        continue;
      }

      for (const packageName of [
        '@lostgradient/cinder',
        '@lostgradient/editor',
        '@lostgradient/markdown',
      ]) {
        const version = await installedVersionOf(directory, packageName);
        if (version) installedVersions[`${fixture.name}:${packageName}`] = version;
      }

      if (fixture.name === 'plain-cinder') {
        cases.push(
          ...(await runImportStyleProbe(
            directory,
            'plain-cinder',
            PLAIN_CINDER_IMPORT_SPECIFIERS,
            spawn,
          )),
        );
        cases.push(await runNoEditorProbe(directory, spawn));
        cases.push(
          ...(await runSsrProbe(
            directory,
            'plain-cinder',
            ['@lostgradient/cinder/source-diff-viewer'],
            spawn,
          )),
        );
        cases.push(
          await runHydrationCase(directory, 'plain-cinder', CINDER_HYDRATION_ENTRY, 'new'),
        );
      } else if (fixture.name === 'annotated') {
        cases.push(
          ...(await runImportStyleProbe(
            directory,
            'annotated',
            ANNOTATED_IMPORT_SPECIFIERS,
            spawn,
          )),
        );
        cases.push(...(await runSsrProbe(directory, 'annotated', SSR_SPECIFIERS, spawn)));
        cases.push(
          await runHydrationCase(
            directory,
            'annotated',
            DIFF_REVIEW_COMMENTS_HYDRATION_ENTRY,
            'All comments',
          ),
        );
      } else {
        cases.push(await runAggregateExportProbe(directory, spawn));
      }
    }

    const [cinderHash, editorHash, markdownRecord] = await Promise.all([
      sha256File(args.cinderTarball),
      sha256File(args.editorTarball),
      args.markdownTarball
        ? sha256File(args.markdownTarball).then((sha256) => ({
            path: args.markdownTarball!,
            sha256,
          }))
        : Promise.resolve({ registryRange: '^0.5.0' }),
    ]);

    const manifest = buildManifest({
      cinderTarball: { path: args.cinderTarball, sha256: cinderHash },
      editorTarball: { path: args.editorTarball, sha256: editorHash },
      markdownTarball: markdownRecord,
      installedVersions,
      cases,
    });

    await mkdir(args.evidenceDirectory, { recursive: true });
    await Bun.write(
      join(args.evidenceDirectory, 'manifest.json'),
      `${JSON.stringify(manifest, undefined, 2)}\n`,
    );
    return manifest;
  } finally {
    await rm(workRoot, { recursive: true, force: true });
  }
}

// ============================================================================
// CLI entry
// ============================================================================

export async function runValidatorCommand(argv: readonly string[]): Promise<number> {
  const parsed = parseArguments(argv);
  if (!parsed.ok) {
    process.stderr.write(`${parsed.error.message}\n`);
    return 1;
  }
  try {
    const manifest = await runValidator(parsed.value);
    for (const result of manifest.cases) {
      process.stdout.write(
        `${result.status === 'pass' ? 'PASS' : 'FAIL'} ${result.id}${result.detail ? `: ${result.detail}` : ''}\n`,
      );
    }
    process.stdout.write(
      `\nEvidence written to ${join(parsed.value.evidenceDirectory, 'manifest.json')}\n`,
    );
    return manifest.exitCode;
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    return 1;
  }
}

if (import.meta.main) process.exit(await runValidatorCommand(Bun.argv.slice(2)));
