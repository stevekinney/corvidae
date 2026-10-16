import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { spawnWithHangGuard } from './hang-guard.ts';
import { outcomeOf, rethrow } from './module-scope-scenario.test-support.ts';
import { directoryGlob, workspaceParentDirectories } from './workspace-directories.ts';

const root = join(import.meta.dir, '..');

/**
 * Every nested oxlint configuration under `directory`, relative to it and sorted.
 *
 * A nested `.oxlintrc.json` replaces the root policy for every file beneath it rather than merging
 * with it, so a synthetic file under `packages/weft/` is governed by `packages/weft/.oxlintrc.json`
 * and nothing in the root file reaches it. `lintImport` recreates that layout in its temporary tree
 * by linking each of these at the same relative location, then lets oxlint discover them. Read from
 * the tree rather than listed by hand, so a workspace that adopts its own configuration is exercised
 * here without anyone remembering to add it.
 *
 * Every depth counts, because oxlint's discovery has no depth limit: a configuration directly
 * under `scripts/` or three directories into a workspace governs its subtree exactly as a
 * workspace-root one does. Installed packages and dot-directories are not policy.
 */
function nestedConfigurationsUnder(directory: string): string[] {
  const glob = new Bun.Glob(
    `${directoryGlob([...workspaceParentDirectories, 'scripts'])}/**/.oxlintrc.json`,
  );
  return [...glob.scanSync({ cwd: directory, dot: true, onlyFiles: true })]
    .filter((path) =>
      path
        .split('/')
        .slice(0, -1)
        .every((segment) => segment !== 'node_modules' && !segment.startsWith('.')),
    )
    .toSorted();
}

const nestedConfigurations = nestedConfigurationsUnder(root);

test('nested configurations are found at every depth, outside installed packages and dot-directories', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'corvidae-lint-policy-'));
  try {
    for (const path of [
      '.oxlintrc.json',
      'scripts/.oxlintrc.json',
      'packages/example/.oxlintrc.json',
      'packages/example/src/deep/.oxlintrc.json',
      'packages/example/node_modules/dependency/.oxlintrc.json',
      'components/.cache/.oxlintrc.json',
      '.github/policy/.oxlintrc.json',
    ]) {
      await Bun.write(join(directory, path), '{}\n');
    }
    expect(nestedConfigurationsUnder(directory)).toEqual([
      'packages/example/.oxlintrc.json',
      'packages/example/src/deep/.oxlintrc.json',
      'scripts/.oxlintrc.json',
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

/**
 * Lint one synthetic file with whichever configuration governs its path in the real tree.
 *
 * No `--config` is passed: an explicit configuration disables oxlint's nested discovery, which
 * would make every path answer to the root policy whether or not the root policy governs it. The
 * temporary directory sits under the root, so oxlint finds the root `.oxlintrc.json` from its
 * working directory, and `nestedConfigurations` are linked (not copied) into the same relative
 * locations, so a weft-pathed file is judged by the live `packages/weft/.oxlintrc.json`.
 */
async function lintImport(
  source: string,
  relativePath = 'consumer.ts',
  typeAware = false,
): Promise<{ exitCode: number; output: string }> {
  const directory = await mkdtemp(join(root, '.lint-policy-'));
  try {
    for (const configuration of nestedConfigurations) {
      const link = join(directory, configuration);
      await mkdir(dirname(link), { recursive: true });
      await symlink(join(root, configuration), link);
    }
    const path = join(directory, relativePath);
    await Bun.write(path, source);
    await Bun.write(join(directory, 'accepted.ts'), 'export const accepted = true;\n');
    const configurationPath = join(directory, 'tsconfig.json');
    if (typeAware) {
      await Bun.write(
        configurationPath,
        JSON.stringify({
          compilerOptions: {
            strict: true,
            noEmit: true,
            target: 'ESNext',
            module: 'ESNext',
            moduleResolution: 'Bundler',
            skipLibCheck: true,
          },
          include: ['**/*.ts'],
        }),
      );
    }
    const process = spawnWithHangGuard(
      [
        join(root, 'node_modules/.bin/oxlint'),
        '--deny-warnings',
        ...(typeAware ? ['--type-aware', '--tsconfig', configurationPath] : []),
        directory,
      ],
      { cwd: root, stdout: 'pipe', stderr: 'pipe' },
    );
    const [exitCode, stdout, stderr] = await Promise.all([
      process.exited,
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
    ]);
    return { exitCode, output: stdout + stderr };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

// These scenarios run the real `oxlint` and `tsc` binaries against synthetic files, which takes
// seconds on a loaded host, so each runs at module scope off the per-test clock.
for (const [path, maximum] of [
  ['packages/example/src/consumer.ts', 100],
  ['components/example/src/consumer.svelte', 100],
  ['applications/example/src/consumer.ts', 100],
  ['packages/example/src/consumer.test.ts', 100],
  ['scripts/consumer.ts', 300],
  ['components/example/scripts/consumer.mjs', 300],
  ['packages/example/scripts/nested/consumer.ts', 300],
  ['applications/example/scripts/consumer.ts', 300],
] as const) {
  const outcome = await outcomeOf(async () => {
    function source(complexity: number): string {
      const branches = Array.from(
        { length: complexity - 1 },
        (_, index) => `if (value === ${index}) return ${index};`,
      ).join('\n');
      const implementation = `export function classify(value) { ${branches}\nreturn -1; }`;
      return path.endsWith('.svelte')
        ? `<script lang="ts">${implementation}</script>`
        : implementation;
    }
    const accepted = await lintImport(source(maximum), path);
    expect(accepted.exitCode, accepted.output).toBe(0);
    const rejected = await lintImport(source(maximum + 1), path);
    expect(rejected.exitCode, rejected.output).toBe(1);
    expect(rejected.output).toContain('complexity');
    expect(rejected.output).toContain(`complexity of ${maximum + 1}`);
  });
  test(`${path} accepts complexity ${maximum} and rejects ${maximum + 1}`, () => rethrow(outcome));
}

const scenario1 = await outcomeOf(async () => {
  expect(nestedConfigurations).toContain('packages/weft/.oxlintrc.json');
  // Weft caps complexity at 10 where the root allows 100, so the same function is accepted
  // under a root-governed path and rejected under a weft one only if discovery reached the
  // nested file.
  const branches = Array.from(
    { length: 10 },
    (_, index) => `if (value === ${index}) return ${index};`,
  ).join('\n');
  const source = `export function classify(value) { ${branches}\nreturn -1; }`;
  const rootGoverned = await lintImport(source, 'packages/example/src/consumer.ts');
  expect(rootGoverned.exitCode, rootGoverned.output).toBe(0);
  const weftGoverned = await lintImport(source, 'packages/weft/src/consumer.ts');
  expect(weftGoverned.exitCode, weftGoverned.output).toBe(1);
  expect(weftGoverned.output).toContain('complexity of 11');
});
test('weft-pathed files answer to the nested weft configuration, not the root policy', () =>
  rethrow(scenario1));

const scenario2 = await outcomeOf(async () => {
  const result = await lintImport("import './component.css';\n");
  expect(result.output).not.toContain('no-unassigned-import');
  expect(result.exitCode).toBe(0);
});
test('the root import rule accepts stylesheet side effects', () => rethrow(scenario2));

const scenario3 = await outcomeOf(async () => {
  const result = await lintImport("import './component.ts';\n");
  expect(result.output).toContain('no-unassigned-import');
  expect(result.exitCode).toBe(1);
});
test('the root import rule still rejects unassigned JavaScript module imports', () =>
  rethrow(scenario3));

const scenario4 = await outcomeOf(async () => {
  const result = await lintImport(
    "import '@lostgradient/cinder';\n",
    'components/chat/src/index.ts',
  );
  expect(result.output).not.toContain('no-unassigned-import');
  expect(result.exitCode).toBe(0);
});
test('Chat can load its stylesheet-owning Cinder dependency from the public root', () =>
  rethrow(scenario4));

const scenario5 = await outcomeOf(async () => {
  const otherProvider = await lintImport(
    "import '@lostgradient/lifecycle';\n",
    'components/chat/src/index.ts',
  );
  const otherConsumer = await lintImport("import '@lostgradient/cinder';\n");
  expect(otherProvider.output).toContain('no-unassigned-import');
  expect(otherProvider.exitCode).toBe(1);
  expect(otherConsumer.output).toContain('no-unassigned-import');
  expect(otherConsumer.exitCode).toBe(1);
});
test('the Chat stylesheet exception does not allow other modules or consumers', () =>
  rethrow(scenario5));

const scenario6 = await outcomeOf(async () => {
  for (const output of ['build', '.svelte-kit', '.playwright', 'coverage', '.turbo']) {
    const result = await lintImport(
      "import './generated-module.ts';\n",
      `applications/fixture/${output}/generated.ts`,
    );
    expect(result.output, output).not.toContain('no-unassigned-import');
    expect(result.exitCode, output).toBe(0);
  }
});
test('application output is excluded at every workspace depth', () => rethrow(scenario6));

const scenario7 = await outcomeOf(async () => {
  const generated = await lintImport('export {};\n', 'workflows.generated.d.ts');
  expect(generated.exitCode).toBe(0);
  expect(generated.output).not.toContain('require-module-specifiers');

  const authored = await lintImport('export {};\n', 'authored.d.ts');
  expect(authored.exitCode).toBe(1);
  expect(authored.output).toContain('require-module-specifiers');
});
test('generated declaration contracts are separate from authored declaration lint', () =>
  rethrow(scenario7));

const scenario8 = await outcomeOf(async () => {
  const source = 'export function read(value: unknown) { return value as { name: string }; }\n';
  const production = await lintImport(source, 'components/cinder/src/consumer.ts', true);
  expect(production.exitCode).toBe(1);
  expect(production.output).toContain('no-unsafe-type-assertion');

  const fixture = await lintImport(source, 'components/cinder/src/consumer.test.ts', true);
  expect(fixture.output).not.toContain('no-unsafe-type-assertion');
  expect(fixture.exitCode).toBe(0);
});
test('UI production retains strict assertion checks while test fixtures keep their source contract', () =>
  rethrow(scenario8));

const scenario9 = await outcomeOf(async () => {
  const source = 'export function* workflow() { return 42; }\n';
  const fixture = await lintImport(source, 'packages/weft/src/consumer.test-support.ts');
  expect(fixture.exitCode).toBe(0);
  expect(fixture.output).not.toContain('require-yield');

  const production = await lintImport(source, 'packages/weft/src/consumer.ts');
  expect(production.exitCode).toBe(1);
  expect(production.output).toContain('require-yield');
});
test('zero-yield workflow fixtures do not disable generator checks for production', () =>
  rethrow(scenario9));

const scenario10 = await outcomeOf(async () => {
  const worker = await lintImport(
    "const worker = new Worker('./worker.ts'); worker.postMessage('start');\n",
    'packages/weft/src/workers/consumer.ts',
  );
  expect(worker.exitCode).toBe(0);

  const window = await lintImport(
    "window.postMessage('start');\n",
    'applications/fixture/src/client.ts',
  );
  expect(window.exitCode).toBe(1);
  expect(window.output).toContain('require-post-message-target-origin');
});
test('worker messaging preserves its API while window messaging requires an origin', () =>
  rethrow(scenario10));

const scenario11 = await outcomeOf(async () => {
  const diagnostic = await lintImport(
    "console.warn('Invalid component usage');\n",
    'components/cinder/src/consumer.ts',
  );
  expect(diagnostic.exitCode).toBe(0);

  const debug = await lintImport("console.log('debug');\n", 'components/cinder/src/consumer.ts');
  expect(debug.exitCode).toBe(1);
  expect(debug.output).toContain('no-console');
});
test('diagnostic output is retained without permitting stray UI debug logging', () =>
  rethrow(scenario11));

const scenario12 = await outcomeOf(async () => {
  const diagnostic = await lintImport(
    "export function printDocument() { console.log('Document structure:'); }\n",
    'components/editor/src/editor/test-utilities.ts',
  );
  expect(diagnostic.exitCode).toBe(0);
  const application = await lintImport(
    "console.log('debug');\n",
    'applications/fixture/src/consumer.ts',
  );
  expect(application.exitCode).toBe(1);
  expect(application.output).toContain('no-console');
});
test('explicit document-debug utilities can print while ordinary UI source cannot', () =>
  rethrow(scenario12));

const scenario13 = await outcomeOf(async () => {
  const source = "import 'fake-indexeddb/auto';\n";
  const fixture = await lintImport(source, 'packages/weft/tests/test-preload.ts');
  expect(fixture.exitCode).toBe(0);

  const production = await lintImport(source, 'packages/weft/src/consumer.ts');
  expect(production.exitCode).toBe(1);
  expect(production.output).toContain('no-unassigned-import');
});
test('IndexedDB test setup remains a side effect confined to test code', () => rethrow(scenario13));

const scenario14 = await outcomeOf(async () => {
  const source = 'export function assertType<T>(value: T): void { void value; }\n';
  for (const path of ['packages/weft/src/consumer.test-d.ts', 'packages/armorer/src/consumer.ts']) {
    const contract = await lintImport(source, path, true);
    expect(contract.exitCode).toBe(0);
  }
});
test('caller-selected generic contracts remain valid in source and type assertions', () =>
  rethrow(scenario14));

const scenario15 = await outcomeOf(async () => {
  for (const source of [
    'export const value = { then() { return 42; } };\n',
    'export async function wait(done: boolean) { while (!done) await Promise.resolve(); }\n',
  ]) {
    const fixture = await lintImport(source, 'packages/armorer/test/fixture.test.ts');
    expect(fixture.exitCode).toBe(0);
    const production = await lintImport(source, 'packages/armorer/src/consumer.ts');
    expect(production.exitCode).toBe(1);
  }
});
test('deliberate thenables and asynchronously changed loop signals are allowed only in tests', () =>
  rethrow(scenario15));

const scenario16 = await outcomeOf(async () => {
  const accepted = await lintImport(
    'export function read(value) { return value._meta ?? value._didMount ?? value._willUpdate; }\n',
  );
  expect(accepted.exitCode).toBe(0);
  const rejected = await lintImport('export function read(value) { return value._private; }\n');
  expect(rejected.exitCode).toBe(1);
  expect(rejected.output).toContain('no-underscore-dangle');
});
test('external protocol and framework names do not permit arbitrary underscored properties', () =>
  rethrow(scenario16));

const scenario17 = await outcomeOf(async () => {
  const handled = await lintImport("fetch('/resource').then(() => undefined, () => undefined);\n");
  expect(handled.exitCode).toBe(0);

  const unhandled = await lintImport("fetch('/resource').then(() => undefined);\n");
  expect(unhandled.exitCode).toBe(1);
  expect(unhandled.output).toContain('catch-or-return');
});
test('two-handler promise observation preserves rejection timing without an empty catch', () =>
  rethrow(scenario17));

const scenario18 = await outcomeOf(async () => {
  const source =
    '<script>import Recursive from "./_json-viewer-node.svelte";</script><Recursive />\n';
  const recursive = await lintImport(
    source,
    'components/cinder/src/components/json-viewer/_json-viewer-node.svelte',
  );
  expect(recursive.exitCode).toBe(0);

  const accidental = await lintImport(
    source,
    'components/cinder/src/components/fixture/_json-viewer-node.svelte',
  );
  expect(accidental.exitCode).toBe(1);
  expect(accidental.output).toContain('no-self-import');
});
test('recursive Svelte components retain self imports without allowing arbitrary module cycles', () =>
  rethrow(scenario18));

async function compileContract(
  source: string,
  configurationName = 'base.json',
): Promise<{ exitCode: number; output: string }> {
  const directory = await mkdtemp(join(root, '.lint-policy-'));
  try {
    await Bun.write(join(directory, 'contract.ts'), source);
    const configuration = join(directory, 'tsconfig.json');
    await Bun.write(
      configuration,
      JSON.stringify({
        extends: join(root, 'internal/typescript', configurationName),
        include: ['./contract.ts'],
        // `base.json` leaves `types` unset, which every real consumer in
        // this workspace resolves by explicitly opting into `["bun"]` (see
        // the root and per-package tsconfigs). TypeScript 6 no longer
        // auto-discovers `@types/bun` for an unset `types` array the way
        // 5.9 did, so this isolated contract needs the same explicit
        // opt-in — `browser.json` already sets `types: []` on purpose, to
        // assert Bun/Node globals are absent, and must keep doing so.
        ...(configurationName === 'base.json' ? { compilerOptions: { types: ['bun'] } } : {}),
      }),
    );
    const process = spawnWithHangGuard(
      [join(root, 'node_modules/.bin/tsc'), '--project', configuration],
      {
        cwd: root,
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );
    const [exitCode, stdout, stderr] = await Promise.all([
      process.exited,
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
    ]);
    return { exitCode, output: stdout + stderr };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const scenario19 = await outcomeOf(async () => {
  for (const extension of ['ts', 'svelte']) {
    const wrap = (source: string) =>
      extension === 'svelte' ? `<script lang="ts">${source}</script>` : source;
    const path = `components/example/src/consumer.${extension}`;
    const browser = await lintImport(
      wrap("document.title = 'Corvidae'; window.localStorage.clear();"),
      path,
    );
    expect(browser.exitCode, browser.output).toBe(0);
    for (const source of [
      'Bun.file("data.json");',
      'process.cwd();',
      'globalThis.process.cwd();',
      'Buffer.from("data");',
      'require("fs");',
    ]) {
      const server = await lintImport(wrap(source), path);
      expect(server.exitCode, server.output).toBe(1);
      expect(server.output).toContain('no-restricted-globals');
    }
  }
});
test('component source accepts browser APIs and rejects server globals in TypeScript and Svelte', () =>
  rethrow(scenario19));

const scenario20 = await outcomeOf(async () => {
  for (const source of [
    "export { readFile } from 'node:fs/promises';",
    "export { readFile } from 'fs/promises';",
    "export { file } from 'bun';",
    "export { Database } from 'bun:sqlite';",
    "export const load = () => import('node:fs');",
    "import type { Stats } from 'node:fs'; export type File = Stats;",
  ]) {
    const result = await lintImport(source, 'components/example/src/consumer.ts');
    expect(result.exitCode, `${source}\n${result.output}`).toBe(1);
    expect(result.output).toContain('no-restricted-imports');
  }
});
test('component imports reject Node and Bun modules including bare names and dynamic imports', () =>
  rethrow(scenario20));

const scenario21 = await outcomeOf(async () => {
  for (const path of [
    'src/consumer.test.ts',
    'src/consumer-test-helpers.ts',
    'scripts/prepare.ts',
  ]) {
    const result = await lintImport(
      "export const file = Bun.file('fixture.json');",
      `components/example/${path}`,
    );
    expect(result.exitCode, result.output).toBe(0);
  }
});
test('component tests and scripts retain Bun APIs without exempting adjacent production files', () =>
  rethrow(scenario21));

const scenario22 = await outcomeOf(async () => {
  const browser = await compileContract(
    'export const element: HTMLElement = document.body; export const timer: number = setTimeout(() => {}, 0);',
    'browser.json',
  );
  expect(browser.exitCode, browser.output).toBe(0);
  const server = await compileContract(
    'Bun.file("data.json"); process.cwd(); Buffer.from("data");',
    'browser.json',
  );
  expect(server.exitCode, server.output).toBe(2);
  for (const name of ['Bun', 'process', 'Buffer'])
    expect(server.output).toContain(`Cannot find name '${name}'`);
});
test('browser compiler policy provides DOM types without ambient Bun or Node globals', () =>
  rethrow(scenario22));

const scenario23 = await outcomeOf(async () => {
  const result = await compileContract(
    "import { sha256Hex } from '../packages/cryptography/src/hash.ts'; export const hash = sha256Hex('browser');",
    'browser.json',
  );
  expect(result.exitCode, result.output).toBe(0);
});
test('portable hashing compiles for browser consumers without ambient Bun types', () =>
  rethrow(scenario23));

const scenario24 = await outcomeOf(async () => {
  const complete = await compileContract(
    "export function select(value: 'a' | 'b'): number { switch(value) { case 'a': return 1; case 'b': return 2; } }",
  );
  expect(complete.exitCode, complete.output).toBe(0);
  const incomplete = await compileContract(
    "export function select(value: 'a' | 'b'): number { if(value === 'a') return 1; }",
  );
  expect(incomplete.exitCode).toBe(2);
  expect(incomplete.output).toContain('lacks ending return statement');
});
test('TypeScript enforces return completeness while accepting exhaustive unions', () =>
  rethrow(scenario24));

const scenario25 = await outcomeOf(async () => {
  const source = `import { expect } from 'bun:test';
    const actual: { name: string } = { name: 'value' };
    const expected: unknown = actual;
    expect<unknown>(actual).toEqual(expected);`;
  const contract = await compileContract(source);
  expect(contract.exitCode, contract.output).toBe(0);
  const lint = await lintImport(source, 'packages/armorer/test/fixture.test.ts', true);
  expect(lint.exitCode, lint.output).toBe(0);
});
test('an explicit default generic can intentionally prevent narrower argument inference', () =>
  rethrow(scenario25));
