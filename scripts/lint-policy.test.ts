import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';

const root = join(import.meta.dir, '..');

async function lintImport(
  source: string,
  relativePath = 'consumer.ts',
  typeAware = false,
): Promise<{ exitCode: number; output: string }> {
  const directory = await mkdtemp(join(root, '.lint-policy-'));
  try {
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
    const process = Bun.spawn(
      [
        join(root, 'node_modules/.bin/oxlint'),
        '--config',
        join(root, '.oxlintrc.json'),
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
  test(`${path} accepts complexity ${maximum} and rejects ${maximum + 1}`, async () => {
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
}

test('the root import rule accepts stylesheet side effects', async () => {
  const result = await lintImport("import './component.css';\n");
  expect(result.output).not.toContain('no-unassigned-import');
  expect(result.exitCode).toBe(0);
});

test('the root import rule still rejects unassigned JavaScript module imports', async () => {
  const result = await lintImport("import './component.ts';\n");
  expect(result.output).toContain('no-unassigned-import');
  expect(result.exitCode).toBe(1);
});

test('Chat can load its stylesheet-owning Cinder dependency from the public root', async () => {
  const result = await lintImport("import '@lostgradient/cinder';\n", 'components/chat/src/index.ts');
  expect(result.output).not.toContain('no-unassigned-import');
  expect(result.exitCode).toBe(0);
});

test('the Chat stylesheet exception does not allow other modules or consumers', async () => {
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

test('application output is excluded at every workspace depth', async () => {
  for (const output of ['build', '.svelte-kit', '.playwright', 'coverage', '.turbo']) {
    const result = await lintImport(
      "import './generated-module.ts';\n",
      `applications/fixture/${output}/generated.ts`,
    );
    expect(result.output, output).not.toContain('no-unassigned-import');
    expect(result.exitCode, output).toBe(0);
  }
});

test('generated declaration contracts are separate from authored declaration lint', async () => {
  const generated = await lintImport('export {};\n', 'workflows.generated.d.ts');
  expect(generated.exitCode).toBe(0);
  expect(generated.output).not.toContain('require-module-specifiers');

  const authored = await lintImport('export {};\n', 'authored.d.ts');
  expect(authored.exitCode).toBe(1);
  expect(authored.output).toContain('require-module-specifiers');
});

test('UI production retains strict assertion checks while test fixtures keep their source contract', async () => {
  const source = 'export function read(value: unknown) { return value as { name: string }; }\n';
  const production = await lintImport(source, 'components/cinder/src/consumer.ts', true);
  expect(production.exitCode).toBe(1);
  expect(production.output).toContain('no-unsafe-type-assertion');

  const fixture = await lintImport(source, 'components/cinder/src/consumer.test.ts', true);
  expect(fixture.output).not.toContain('no-unsafe-type-assertion');
  expect(fixture.exitCode).toBe(0);
});

test('zero-yield workflow fixtures do not disable generator checks for production', async () => {
  const source = 'export function* workflow() { return 42; }\n';
  const fixture = await lintImport(source, 'packages/weft/src/consumer.test-support.ts');
  expect(fixture.exitCode).toBe(0);
  expect(fixture.output).not.toContain('require-yield');

  const production = await lintImport(source, 'packages/weft/src/consumer.ts');
  expect(production.exitCode).toBe(1);
  expect(production.output).toContain('require-yield');
});

test('worker messaging preserves its API while window messaging requires an origin', async () => {
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

test('diagnostic output is retained without permitting stray UI debug logging', async () => {
  const diagnostic = await lintImport(
    "console.warn('Invalid component usage');\n",
    'components/cinder/src/consumer.ts',
  );
  expect(diagnostic.exitCode).toBe(0);

  const debug = await lintImport("console.log('debug');\n", 'components/cinder/src/consumer.ts');
  expect(debug.exitCode).toBe(1);
  expect(debug.output).toContain('no-console');
});

test('explicit document-debug utilities can print while ordinary UI source cannot', async () => {
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

test('IndexedDB test setup remains a side effect confined to test code', async () => {
  const source = "import 'fake-indexeddb/auto';\n";
  const fixture = await lintImport(source, 'packages/weft/tests/test-preload.ts');
  expect(fixture.exitCode).toBe(0);

  const production = await lintImport(source, 'packages/weft/src/consumer.ts');
  expect(production.exitCode).toBe(1);
  expect(production.output).toContain('no-unassigned-import');
});

test('caller-selected generic contracts remain valid in source and type assertions', async () => {
  const source = 'export function assertType<T>(value: T): void { void value; }\n';
  for (const path of ['packages/weft/src/consumer.test-d.ts', 'packages/armorer/src/consumer.ts']) {
    const contract = await lintImport(source, path, true);
    expect(contract.exitCode).toBe(0);
  }
});

test('deliberate thenables and asynchronously changed loop signals are allowed only in tests', async () => {
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

test('external protocol and framework names do not permit arbitrary underscored properties', async () => {
  const accepted = await lintImport(
    'export function read(value) { return value._meta ?? value._didMount ?? value._willUpdate; }\n',
  );
  expect(accepted.exitCode).toBe(0);
  const rejected = await lintImport('export function read(value) { return value._private; }\n');
  expect(rejected.exitCode).toBe(1);
  expect(rejected.output).toContain('no-underscore-dangle');
});

test('two-handler promise observation preserves rejection timing without an empty catch', async () => {
  const handled = await lintImport("fetch('/resource').then(() => undefined, () => undefined);\n");
  expect(handled.exitCode).toBe(0);

  const unhandled = await lintImport("fetch('/resource').then(() => undefined);\n");
  expect(unhandled.exitCode).toBe(1);
  expect(unhandled.output).toContain('catch-or-return');
});

test('recursive Svelte components retain self imports without allowing arbitrary module cycles', async () => {
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
    const process = Bun.spawn([join(root, 'node_modules/.bin/tsc'), '--project', configuration], {
      cwd: root,
      stdout: 'pipe',
      stderr: 'pipe',
    });
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

test('component source accepts browser APIs and rejects server globals in TypeScript and Svelte', async () => {
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

test('component imports reject Node and Bun modules including bare names and dynamic imports', async () => {
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

test('component tests and scripts retain Bun APIs without exempting adjacent production files', async () => {
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

test('browser compiler policy provides DOM types without ambient Bun or Node globals', async () => {
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

test('portable hashing compiles for browser consumers without ambient Bun types', async () => {
  const result = await compileContract(
    "import { sha256Hex } from '../packages/cryptography/src/hash.ts'; export const hash = sha256Hex('browser');",
    'browser.json',
  );
  expect(result.exitCode, result.output).toBe(0);
});

test('TypeScript enforces return completeness while accepting exhaustive unions', async () => {
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

test('an explicit default generic can intentionally prevent narrower argument inference', async () => {
  const source = `import { expect } from 'bun:test';
    const actual: { name: string } = { name: 'value' };
    const expected: unknown = actual;
    expect<unknown>(actual).toEqual(expected);`;
  const contract = await compileContract(source);
  expect(contract.exitCode, contract.output).toBe(0);
  const lint = await lintImport(source, 'packages/armorer/test/fixture.test.ts', true);
  expect(lint.exitCode, lint.output).toBe(0);
});
