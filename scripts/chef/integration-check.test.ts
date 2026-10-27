import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  expandFastCheck,
  failingFilesFromOutput,
  integrationWorkspaces,
  parseRemovedNames,
  removedNameHits,
} from './integration-check.ts';
import type { WorkspaceGraph } from './merge-overlap.ts';
import { UsageError } from './process-runner.ts';

const graph = (
  edges: Record<string, string[]>,
  everything: string[] = ['bun.lock', 'package.json', 'turbo.json'],
): WorkspaceGraph => ({
  directories: Object.keys(edges),
  dependencies: new Map(Object.entries(edges).map(([directory, to]) => [directory, new Set(to)])),
  everythingPatterns: everything,
});

describe('integrationWorkspaces', () => {
  const workspaces = graph({
    'packages/core': [],
    'packages/client': ['packages/core'],
    'packages/unrelated': [],
    'components/ui': ['packages/client'],
  });

  test('is the workspaces both sides touched', () => {
    expect(
      integrationWorkspaces(
        ['packages/core/a.ts', 'packages/unrelated/x.ts'],
        ['packages/core/b.ts'],
        workspaces,
      ),
    ).toEqual(['packages/core']);
  });

  test('counts a branch change in a consumer of a library that main changed', () => {
    // main changed packages/core's API; the branch only touched code that imports it.
    expect(
      integrationWorkspaces(['packages/client/use.ts'], ['packages/core/api.ts'], workspaces),
    ).toEqual(['packages/client']);
  });

  test('counts a workspace main changed that consumes a library the branch changed', () => {
    expect(
      integrationWorkspaces(['packages/core/api.ts'], ['packages/client/use.ts'], workspaces),
    ).toEqual(['packages/client']);
  });

  test('is empty when the two sides share nothing', () => {
    expect(
      integrationWorkspaces(['packages/unrelated/x.ts'], ['packages/core/b.ts'], workspaces),
    ).toEqual([]);
    expect(integrationWorkspaces(['README.md'], ['packages/core/b.ts'], workspaces)).toEqual([]);
  });

  test('a lockfile change on main puts every workspace the branch touched in play', () => {
    expect(
      integrationWorkspaces(
        ['packages/unrelated/x.ts', 'components/ui/a.svelte'],
        ['bun.lock'],
        workspaces,
      ),
    ).toEqual(['components/ui', 'packages/unrelated']);
  });

  test('never names the root package, and ignores a workspace the merged tree no longer has', () => {
    expect(integrationWorkspaces(['scripts/x.ts'], ['scripts/y.ts'], workspaces)).toEqual([]);
    expect(
      integrationWorkspaces(['packages/gone/x.ts'], ['packages/gone/y.ts'], workspaces),
    ).toEqual([]);
  });
});

describe('expandFastCheck', () => {
  test('replaces {filters} with one --filter per workspace directory', () => {
    expect(
      expandFastCheck('turbo run typecheck lint {filters}', ['packages/a', 'components/b']),
    ).toBe('turbo run typecheck lint --filter=./packages/a --filter=./components/b');
  });

  test('refuses a directory that is not a plain path, so nothing reaches the shell', () => {
    expect(() => expandFastCheck('turbo {filters}', ['packages/a; rm -rf /'])).toThrow(UsageError);
    expect(() => expandFastCheck('turbo {filters}', ['$(x)'])).toThrow(UsageError);
  });
});

describe('failingFilesFromOutput', () => {
  const directories = new Map([
    ['@lostgradient/memory', 'packages/memory'],
    ['@lostgradient/cinder', 'components/cinder'],
  ]);

  test('reads TypeScript, oxlint and svelte-check locations, prefixed by their workspace', () => {
    const output = [
      '@lostgradient/memory:typecheck: src/store.ts(12,5): error TS2322: Type string is not assignable.',
      "@lostgradient/memory:typecheck: src/store.ts(40,1): error TS2304: Cannot find name 'x'.",
      '@lostgradient/cinder:lint:   x no-unused-vars',
      '@lostgradient/cinder:lint:    ,-[src/button.svelte:3:7]',
      'scripts/chef/deliver.ts:88:3 Error: nope',
      '/abs/path/outside.ts:1:1 Error',
    ].join('\n');
    expect(failingFilesFromOutput(output, directories)).toEqual([
      'packages/memory/src/store.ts',
      'components/cinder/src/button.svelte',
      'scripts/chef/deliver.ts',
      '/abs/path/outside.ts',
    ]);
  });

  test('reads tsc --pretty output, whose location is coloured and split by codes', () => {
    const esc = String.fromCharCode(27);
    const pretty = `@lostgradient/memory:typecheck: ${esc}[96msrc/zz.ts${esc}[0m:${esc}[93m1${esc}[0m:${esc}[93m14${esc}[0m - ${esc}[91merror${esc}[0m TS2322: bad`;
    expect(failingFilesFromOutput(pretty, directories)).toEqual(['packages/memory/src/zz.ts']);
  });

  test('ignores colour codes and keeps at most 20 files', () => {
    const esc = String.fromCharCode(27);
    const colored = `${esc}[31mscripts/a.ts(1,1): error TS1${esc}[0m`;
    expect(failingFilesFromOutput(colored, directories)).toEqual(['scripts/a.ts']);
    const many = Array.from({ length: 30 }, (_, index) => `scripts/f${index}.ts(1,1): error`).join(
      '\n',
    );
    expect(failingFilesFromOutput(many, directories)).toHaveLength(20);
  });
});

describe('parseRemovedNames', () => {
  test('reads one identifier per line, skipping blanks and # comments', () => {
    expect(
      parseRemovedNames('legacyMode\n\n# gone in this change\n  $internal \nfoo_bar\n'),
    ).toEqual(['legacyMode', '$internal', 'foo_bar']);
  });

  test('refuses a line that is not an identifier', () => {
    expect(() => parseRemovedNames('a.b\n')).toThrow(UsageError);
    expect(() => parseRemovedNames('a|b\n')).toThrow(UsageError);
    expect(() => parseRemovedNames('(x)\n')).toThrow(UsageError);
  });
});

describe('removedNameHits', () => {
  let sandbox: string;
  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), 'integration-check-'));
    mkdirSync(join(sandbox, 'src'), { recursive: true });
  });
  afterEach(() => rmSync(sandbox, { recursive: true, force: true }));

  const write = (path: string, text: string) => writeFileSync(join(sandbox, path), text);

  test('finds member accesses, quoted keys and object keys that tsc cannot see', () => {
    write(
      'src/fixture.ts',
      [
        'const engine = Object.create(null) as never;',
        'engine.legacyMode = true;',
        'const read = engine?.legacyMode;',
        "const bag = { ['legacyMode']: 1 };",
        'const shaped = { ...base, legacyMode: false } as never;',
        'const fine = engine.legacyModeEnabled;',
        'const alsoFine = notlegacyMode;',
        '',
      ].join('\n'),
    );
    const hits = removedNameHits(sandbox, ['src/fixture.ts'], ['legacyMode']);
    expect(hits.map((hit) => `${hit.path}:${hit.line}`)).toEqual([
      'src/fixture.ts:2',
      'src/fixture.ts:3',
      'src/fixture.ts:4',
      'src/fixture.ts:5',
    ]);
    expect(hits[0]).toMatchObject({ name: 'legacyMode' });
  });

  test('looks only at the files it is given, and skips ones that no longer exist or are not source', () => {
    write('src/a.ts', 'x.legacyMode;\n');
    write('src/b.ts', 'x.legacyMode;\n');
    write('src/notes.md', 'x.legacyMode;\n');
    expect(
      removedNameHits(sandbox, ['src/a.ts', 'src/gone.ts', 'src/notes.md'], ['legacyMode']),
    ).toHaveLength(1);
  });

  test('matches names that contain $ and does not treat names as patterns', () => {
    write('src/a.ts', 'x.$state; y.astate;\n');
    expect(removedNameHits(sandbox, ['src/a.ts'], ['$state'])).toHaveLength(1);
  });

  test('returns nothing with no names', () => {
    write('src/a.ts', 'x.legacyMode;\n');
    expect(removedNameHits(sandbox, ['src/a.ts'], [])).toEqual([]);
  });
});
