import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import ts from 'typescript';

import { loadPackageMap } from './package-map.ts';
import { targetFor } from './target-definitions.ts';

/**
 * Every published package's declarations can name every type they mention (COR-1291).
 *
 * A published package whose inferred signature mentions a type that no module specifier a
 * consumer can write reaches — a type its dependency's public entry never exports — has
 * declarations the emitter cannot print. TypeScript reports that as TS2883 (and TS4023, TS4058,
 * TS4082, the other "cannot be named" diagnostics), and the target's bundler fails the build on
 * it. Corvidae never emits declarations, since its libraries ship source and carry no bundler, so
 * nothing here saw operative's four tool factories inferring armorer's unexported `NamedTool`
 * until the agent-bureau mirror's dependency-ordered build did.
 *
 * The emitter is the judge rather than a walk over types: it prints a type reference and stops,
 * so the set of names this refuses is exactly the set a consumer's declarations need, never the
 * closure of everything beneath them.
 *
 * Emission runs once, at module scope, as `committed-plans.ts` does and for the same reason: the
 * thirteen programs take tens of seconds (operative alone about eight), and bun's per-test
 * timeout covers a test body, not module evaluation. For the Svelte component packages the
 * program covers their TypeScript modules only; `.svelte` component types are outside `tsc`.
 */

const corvidaeRoot = join(import.meta.dir, '..', '..');
const cannotBeNamed = new Set([2883, 4023, 4058, 4082]);
const entryCandidates = ['src/index.ts', 'src/lib/index.ts'];

/**
 * TS5097: "An import path can only end with a '.ts' extension when 'allowImportingTsExtensions'
 * is enabled." COR-1196's cinder build failure.
 *
 * Corvidae's own `tsconfig.json` sets `allowImportingTsExtensions: true` everywhere (COR-1196's
 * markdown fixture), so a relative import written with an explicit `.ts` extension typechecks
 * locally and is invisible to `emitDeclarations` above, which reuses corvidae's own compiler
 * options. Every target that runs a real `tsc` build turns the flag off — `packages/markdown`,
 * `packages/components` and `packages/mcp` all set `allowImportingTsExtensions: false` in their
 * `tsconfig.build.json`, with `declaration: true`, `noEmit: false` and `include: ["src"]` — so the
 * published build fails on the same import a local `bun run typecheck` never sees.
 */
const disallowedTsExtension = new Set([5097]);

interface Emission {
  name: string;
  directory: string;
  diagnostics: string[];
}

function workspaceDirectories(): Map<string, string> {
  const directories = new Map<string, string>();
  for (const parent of ['packages', 'components']) {
    for (const child of readdirSync(join(corvidaeRoot, parent))) {
      const manifestPath = join(corvidaeRoot, parent, child, 'package.json');
      if (!existsSync(manifestPath)) continue;
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { name?: string };
      if (manifest.name) directories.set(manifest.name, join(parent, child));
    }
  }
  return directories;
}

function emitDeclarations(name: string, directory: string): Emission {
  const root = resolve(corvidaeRoot, directory);
  const entry = entryCandidates.map((candidate) => join(root, candidate)).find(existsSync);
  if (!entry) throw new Error(`${name} has no public entry among ${entryCandidates.join(', ')}`);
  const configPath = ts.findConfigFile(root, ts.sys.fileExists, 'tsconfig.json');
  if (!configPath) throw new Error(`${name} has no tsconfig.json`);
  const parsed = ts.parseJsonConfigFileContent(
    ts.readConfigFile(configPath, ts.sys.readFile).config,
    ts.sys,
    root,
  );
  const program = ts.createProgram([entry], {
    ...parsed.options,
    declaration: true,
    emitDeclarationOnly: true,
    noEmit: false,
    incremental: false,
    composite: false,
  });
  // The write callback discards every file: only the emitter's diagnostics are wanted.
  const result = program.emit(undefined, () => {}, undefined, true);
  const diagnostics = new Set<string>();
  for (const diagnostic of result.diagnostics) {
    if (!cannotBeNamed.has(diagnostic.code)) continue;
    diagnostics.add(
      `TS${String(diagnostic.code)}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')}`,
    );
  }
  return { name, directory, diagnostics: [...diagnostics].toSorted() };
}

/**
 * Compile a workspace's whole published `src/` tree with the option set a real `tsc` build
 * actually uses, per `disallowedTsExtension`'s doc comment.
 *
 * Unlike `emitDeclarations`, this walks every file `tsconfig.json` matches under `src/` rather
 * than only the public entry's import graph: `packages/markdown/src/rendering/async.ts` is a
 * `.ts`-extension offender COR-1196 found, and nothing in `src/index.ts` imports it, so an
 * entry-scoped program would never load the file and never see the diagnostic. A real
 * `tsconfig.build.json` compiles the same way — `include: ["src"]`, not one root file — because a
 * shipped-but-unreferenced module still has to build.
 */
function emitPortable(name: string, directory: string): Emission {
  const root = resolve(corvidaeRoot, directory);
  const configPath = ts.findConfigFile(root, ts.sys.fileExists, 'tsconfig.json');
  if (!configPath) throw new Error(`${name} has no tsconfig.json`);
  const parsed = ts.parseJsonConfigFileContent(
    ts.readConfigFile(configPath, ts.sys.readFile).config,
    ts.sys,
    root,
  );
  // Both confirmed `tsconfig.build.json`s (`packages/markdown`, `packages/components`) exclude
  // `**/*.test.ts` and `**/*.spec.ts` alongside `include: ["src"]`; corvidae's own `tsconfig.json`
  // has no such exclude, so a test file's own `.ts`-extension convention — common in this
  // repository's Bun test files — would otherwise be judged against a build that never compiles
  // it. `packages/components` additionally excludes `src/test` outright (test harnesses, not
  // published surface, some non-test-named); matched here too so a helper under it is not judged
  // against a build that never sees it either.
  const sourceFiles = parsed.fileNames.filter((file) => {
    const path = relative(root, file).split('\\').join('/');
    if (path !== 'src' && !path.startsWith('src/')) return false;
    if (path.startsWith('src/test/') || path === 'src/test') return false;
    return !path.endsWith('.test.ts') && !path.endsWith('.spec.ts');
  });
  if (sourceFiles.length === 0) throw new Error(`${name} has no files under src/ to compile`);
  const program = ts.createProgram(sourceFiles, {
    ...parsed.options,
    declaration: true,
    noEmit: false,
    allowImportingTsExtensions: false,
    incremental: false,
    composite: false,
  });
  // TS5097 is an ordinary semantic diagnostic, not one `Program.emit()`'s own `diagnostics`
  // array reports — that array covers the emit process itself (declaration-emit failures like
  // `cannotBeNamed`'s codes above), not type errors. `getPreEmitDiagnostics` is what a real `tsc`
  // invocation checks before it ever emits, so it is what has to be asked here too. The emit call
  // still runs, discarded, so a portability failure is judged the same way a real build hits it —
  // `tsc`'s own pipeline emits regardless of pre-emit diagnostics unless `noEmitOnError` is set.
  program.emit(undefined, () => {});
  const diagnostics = new Set<string>();
  for (const diagnostic of ts.getPreEmitDiagnostics(program)) {
    if (!disallowedTsExtension.has(diagnostic.code)) continue;
    const file = diagnostic.file ? `${relative(root, diagnostic.file.fileName)}: ` : '';
    diagnostics.add(
      `${file}TS${String(diagnostic.code)}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')}`,
    );
  }
  return { name, directory, diagnostics: [...diagnostics].toSorted() };
}

const packageMap = await loadPackageMap();
const published = Object.entries(packageMap.workspaces)
  .filter(([, entry]) => entry.disposition === 'publish-as')
  .map(([workspace]) => workspace)
  .toSorted();
const directories = workspaceDirectories();
const emissions: Emission[] = published.map((name) => {
  const directory = directories.get(name);
  if (!directory)
    throw new Error(`${name} is published but no workspace on disk carries that name`);
  return emitDeclarations(name, directory);
});
/**
 * The cinder-target workspaces a bare `tsc` build with `allowImportingTsExtensions: false` has
 * been confirmed to enforce this diagnostic for, read off the target clone rather than assumed
 * uniform across the target. Only `@lostgradient/markdown`, and for three separate reasons:
 *
 * Cross-target source inclusion. `armorer`, `@lostgradient/operative` and the rest of the
 * agent-bureau target's members ship from the same `workspace:*` graph, and corvidae's own
 * `moduleResolution: bundler` resolves a cross-package edge straight to the dependency's `src/`
 * rather than to a built `dist/`. A whole-project program for, say, `armorer` therefore pulls
 * `@lostgradient/operative`'s source into the same compilation and reports every `.ts`-extension
 * import in it too — a real finding about that pair, but not one this task's four defects cover,
 * and not evidence agent-bureau's own build ever compiles that way. `targetFor` narrows to
 * cinder-target workspaces first, so no exception below has to also name every foreign target.
 *
 * Not every real cinder build is `tsc`. `packages/editor` and `packages/chat` carry no
 * `tsconfig.build.json` at all — their `build.ts` calls `svelte-package`, a different pipeline
 * this scan says nothing about — and both use a `.ts`-extension relative import as their own
 * pervasive convention throughout `src/`, hundreds of times over.
 *
 * And `packages/components` (`@lostgradient/cinder`) does carry a `tsconfig.build.json` with
 * `allowImportingTsExtensions: false`, but its `build.ts` never runs plain `tsc` against it —
 * it calls `svelte2tsx`'s `emitDts({ tsconfig: … })`, a different declaration emitter this raw
 * `ts.createProgram` model does not reproduce. Modeled as a bare `tsc` run, corvidae's own
 * `src/index.ts` reports TS5097 on effectively every component export, because cinder's own
 * convention is `.ts`-extension imports throughout `src/`, just like editor and chat — yet
 * defect 1 of COR-1196's build failure names only markdown, never cinder's own declaration
 * build, so whatever `emitDts` does with these imports, it evidently is not what bare `tsc`
 * does. Asserting this check against cinder would report a wall of failures that describe a
 * convention that workspace's real emitter tolerates, not a defect this pass found.
 */
const tscBuildWorkspaces = published
  .filter((name) => targetFor(name) === 'cinder')
  .filter((name) => name === '@lostgradient/markdown');

const portableEmissions: Emission[] = tscBuildWorkspaces.map((name) => {
  const directory = directories.get(name);
  if (!directory)
    throw new Error(`${name} is published but no workspace on disk carries that name`);
  return emitPortable(name, directory);
});

describe('published declarations', () => {
  test('cover every publish-as workspace', () => {
    expect(emissions.map((emission) => emission.name)).toEqual(published);
    expect(emissions.length).toBeGreaterThan(0);
  });

  test.each(published)('%s declarations name only types a consumer can reach', (name) => {
    const emission = emissions.find((candidate) => candidate.name === name);
    expect(emission?.diagnostics ?? ['not emitted']).toEqual([]);
  });
});

/**
 * COR-1196: `allowImportingTsExtensions` is on everywhere in corvidae, so this is the one gate
 * that catches a `.ts`-extension relative import before it reaches the cinder target's real
 * build. It cannot catch every published-build failure — `@types/hast` resolving to a narrower
 * shape in the target's own lockfile than in corvidae's is invisible here, since both programs
 * run against corvidae's own `node_modules` — only the extension-portability class TS5097 names.
 */
describe('cinder’s real-tsc-build workspaces build with a real tsc build’s options', () => {
  test('cover every workspace with a confirmed bare-tsc build', () => {
    expect(portableEmissions.map((emission) => emission.name)).toEqual(tscBuildWorkspaces);
    expect(tscBuildWorkspaces).toEqual(['@lostgradient/markdown']);
  });

  test.each(tscBuildWorkspaces)('%s has no relative import a real build would refuse', (name) => {
    const emission = portableEmissions.find((candidate) => candidate.name === name);
    expect(emission?.diagnostics ?? ['not emitted']).toEqual([]);
  });
});
