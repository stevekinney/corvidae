import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import ts from 'typescript';

import { loadPackageMap } from './package-map.ts';

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
