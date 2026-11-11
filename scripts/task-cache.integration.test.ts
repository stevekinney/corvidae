import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';

import { spawnWithHangGuard } from '../testing/testing/src/hang-guard.ts';
import { outcomeOf, rethrow } from './module-scope-scenario.test-support.ts';

const root = join(import.meta.dir, '..');

// These scenarios build synthetic workspaces and run `git`, `bun install` and `turbo` in them,
// which takes seconds on a loaded host, so each runs at module scope off the per-test clock.
const scenario1 = await outcomeOf(async () => {
  const directory = await mkdtemp(join(tmpdir(), 'corvidae-cache-isolation-'));
  const remoteRequests: string[] = [];
  const remote = Bun.serve({
    port: 0,
    fetch(request) {
      remoteRequests.push(`${request.method} ${new URL(request.url).pathname}`);
      if (new URL(request.url).pathname.endsWith('/status')) {
        return Response.json({ status: 'enabled' });
      }
      return new Response(null, { status: request.method === 'PUT' ? 200 : 404 });
    },
  });
  try {
    await createWorkspace(directory);
    await run(
      directory,
      [join(root, 'node_modules/.bin/turbo'), 'run', 'test', '--filter=@fixture/base'],
      {
        ...process.env,
        TURBO_API: remote.url.origin,
        TURBO_TOKEN: 'fixture-cache-token',
        TURBO_TEAM: 'team_fixture',
        TURBO_CACHE: 'remote:rw',
      },
    );
    expect(remoteRequests).toEqual([]);
  } finally {
    await remote.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
});
test('temporary task fixtures never access an inherited remote cache', () => rethrow(scenario1));

const scenario2 = await outcomeOf(async () => {
  const directory = await mkdtemp(join(tmpdir(), 'corvidae-host-environment-'));
  try {
    await createWorkspace(directory);
    const cases = [
      { name: 'interborough', task: 'dev', variable: 'INTERBOROUGH_PORT' },
      { name: 'weft', task: 'test', variable: 'WEFT_EVENT_DISPATCH_ARCHITECTURE_BENCHMARK' },
      { name: 'cinder', task: 'test', variable: 'CINDER_SVG_DATA_URI_ROOTS' },
    ];
    for (const { name, task, variable } of cases) {
      const script = `if (process.env[${JSON.stringify(variable)}] !== 'configuration-test' || process.env.CORVIDAE_UNRELATED_TEST !== undefined) process.exit(1); console.log('configuration received');`;
      await Bun.write(join(directory, 'packages', name, 'check.ts'), script);
      await Bun.write(
        join(directory, 'packages', name, 'package.json'),
        JSON.stringify({
          name: `@lostgradient/${name}`,
          private: true,
          scripts: { [task]: 'bun check.ts' },
        }),
      );
      await run(directory, [process.execPath, 'install']);
      const output = await run(
        directory,
        [join(root, 'node_modules/.bin/turbo'), 'run', task, `--filter=@lostgradient/${name}`],
        { ...process.env, [variable]: 'configuration-test', CORVIDAE_UNRELATED_TEST: 'excluded' },
      );
      expect(output).toContain('configuration received');
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test('application hosts and tests receive only their owned configuration', () =>
  rethrow(scenario2));

const scenario3 = await outcomeOf(async () => {
  const directory = await mkdtemp(join(tmpdir(), 'corvidae-force-isolation-'));
  try {
    await createWorkspace(directory);
    // `executions.txt` is gitignored so it is not hashed as an input; a counted
    // execution must not be what invalidates the next lookup.
    await Bun.write(join(directory, '.gitignore'), 'node_modules/\n.turbo/\nexecutions.txt\n');
    const packageDirectory = join(directory, 'packages/base');
    await Bun.write(
      join(packageDirectory, 'package.json'),
      JSON.stringify({
        name: '@fixture/base',
        private: true,
        scripts: { test: 'bun generate.ts' },
        devDependencies: { '@fixture/typescript': 'workspace:*' },
      }),
    );
    await Bun.write(
      join(packageDirectory, 'generate.ts'),
      `const file = Bun.file('executions.txt');
await Bun.write(file, String((await file.exists() ? Number(await file.text()) : 0) + 1));
`,
    );
    await run(directory, [process.execPath, 'install']);
    const command = [
      join(root, 'node_modules/.bin/turbo'),
      'run',
      'test',
      '--filter=@fixture/base',
    ];
    const executions = Bun.file(join(packageDirectory, 'executions.txt'));
    // Injected the way the remote-cache isolation test at the top of this file
    // injects the variables it expects to be scrubbed, so this asserts the
    // scrub rather than whatever happens to be in the ambient shell.
    const forcedEnvironment = { ...process.env, TURBO_FORCE: 'true' };

    await run(directory, command, forcedEnvironment);
    expect(await executions.text()).toBe('1');
    await run(directory, command, forcedEnvironment);
    expect(await executions.text()).toBe('1');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test('an inherited TURBO_FORCE cannot make a fixture re-execute instead of restoring', () =>
  rethrow(scenario3));

async function run(
  directory: string,
  command: string[],
  environment = process.env,
): Promise<string> {
  // Synthetic workspaces must exercise their own cache, never inherited shared caches.
  const isTurbo = command[0] === join(root, 'node_modules/.bin/turbo');
  const fixtureCommand = isTurbo
    ? [...command, '--cache=local:rw', `--cache-dir=${join(directory, '.turbo/cache')}`]
    : command;
  const fixtureEnvironment = { ...environment };
  if (isTurbo) {
    // Every inherited `TURBO_*` variable goes, rather than a named few.
    //
    // This replaced a list of five cache-configuration variables — `TURBO_API`,
    // `TURBO_TOKEN`, `TURBO_TEAM`, `TURBO_TEAMID`, `TURBO_CACHE` — that missed
    // `TURBO_FORCE`, which defeats these fixtures more directly than any of
    // them: it makes turbo re-execute instead of restore, so the restoration
    // tests below count a second execution and fail against a repository that
    // is fine. Setting it to bypass a stale cache is an ordinary thing to do.
    //
    // A denylist has to stay right about every variable turbo will ever add,
    // and enumerating the ones that perturb execution-versus-restore is a
    // guess maintained by hand. Removing the whole prefix is right by
    // construction, and costs nothing here: a fixture needs no `TURBO_*`
    // variable of its own, because its cache mode and directory arrive as the
    // explicit CLI flags above.
    for (const key of Object.keys(fixtureEnvironment)) {
      if (key.startsWith('TURBO_')) delete fixtureEnvironment[key];
    }
  }
  const child = spawnWithHangGuard(fixtureCommand, {
    cwd: directory,
    stdout: 'pipe',
    stderr: 'pipe',
    env: fixtureEnvironment,
  });
  const [exitCode, output, errors] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(`${fixtureCommand.join(' ')} exited ${exitCode}: ${errors}`);
  return output;
}

function applicationHash(output: string, taskName = 'typecheck'): string {
  const summary: unknown = JSON.parse(output);
  if (summary === null || typeof summary !== 'object' || !('tasks' in summary)) {
    throw new Error('Turbo summary has no tasks');
  }
  if (!Array.isArray(summary.tasks)) throw new Error('Turbo tasks must be an array');
  for (const task of summary.tasks) {
    if (task.taskId === `@fixture/application#${taskName}` && typeof task.hash === 'string') {
      return task.hash;
    }
  }
  throw new Error('Turbo summary has no application typecheck hash');
}

async function createWorkspace(directory: string): Promise<void> {
  await Bun.write(
    join(directory, 'package.json'),
    JSON.stringify({
      name: 'task-cache-regression',
      private: true,
      packageManager: `bun@${Bun.version}`,
      workspaces: ['packages/*', 'components/*', 'applications/*', 'internal/*'],
    }),
  );
  // Turbo writes each task's log to `<package>/.turbo/turbo-<task>.log` after the
  // task runs. Unignored, that log is hashed as an input of the next run, so a
  // second invocation always misses and the restoration tests count a second
  // execution. The repository's own `.gitignore` excludes `.turbo/`; so must
  // every fixture's.
  await Bun.write(join(directory, '.gitignore'), 'node_modules/\n.turbo/\n');
  await Bun.write(join(directory, 'turbo.json'), Bun.file(join(root, 'turbo.json')));
  await Bun.write(
    join(directory, 'internal/typescript/package.json'),
    JSON.stringify({
      name: '@fixture/typescript',
      private: true,
      exports: { './library.json': './library.json' },
    }),
  );
  await Bun.write(
    join(directory, 'internal/typescript/library.json'),
    JSON.stringify({ compilerOptions: { strict: true } }),
  );
  for (const [name, dependency] of [
    ['base', undefined],
    ['library', 'base'],
    ['application', 'library'],
  ]) {
    if (!name) throw new Error('Fixture workspace name is required');
    const parent =
      name === 'application' ? 'applications' : name === 'library' ? 'components' : 'packages';
    await Bun.write(
      join(directory, parent, name, 'package.json'),
      JSON.stringify({
        name: `@fixture/${name}`,
        private: true,
        scripts: {
          typecheck: 'bun --eval "void 0"',
          test: `bun --eval "console.log('runner=' + (process.env.CODEX_CI ?? 'unset'))"`,
        },
        dependencies: dependency ? { [`@fixture/${dependency}`]: 'workspace:*' } : {},
        devDependencies: name === 'base' ? { '@fixture/typescript': 'workspace:*' } : {},
      }),
    );
    await Bun.write(join(directory, parent, name, 'source.ts'), 'export const value = 1;\n');
  }
  await run(directory, ['git', 'init', '--quiet']);
  await run(directory, [process.execPath, 'install']);
}

const scenario4 = await outcomeOf(async () => {
  const directory = await mkdtemp(join(tmpdir(), 'corvidae-task-cache-'));
  try {
    await createWorkspace(directory);
    const command = [join(root, 'node_modules/.bin/turbo'), 'run', 'typecheck', '--dry=json'];
    const before = applicationHash(await run(directory, command));
    await Bun.write(join(directory, 'packages/base/source.ts'), 'export const value = 2;\n');
    const afterDependency = applicationHash(await run(directory, command));
    expect(afterDependency).not.toBe(before);
    await Bun.write(join(directory, 'components/library/source.ts'), 'export const value = 3;\n');
    const afterComponent = applicationHash(await run(directory, command));
    expect(afterComponent).not.toBe(afterDependency);
    await Bun.write(
      join(directory, 'internal/typescript/library.json'),
      JSON.stringify({ compilerOptions: { strict: true, noImplicitReturns: true } }),
    );
    const afterConfiguration = applicationHash(await run(directory, command));
    expect(afterConfiguration).not.toBe(afterComponent);
    await Bun.write(join(directory, '.oxlintrc.json'), '{ "rules": { "no-labels": "error" } }');
    const afterTooling = applicationHash(await run(directory, command));
    expect(afterTooling).not.toBe(afterConfiguration);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test('source task hashes follow transitive libraries, internal configuration and shared tooling', () =>
  rethrow(scenario4));

const scenario5 = await outcomeOf(async () => {
  const directory = await mkdtemp(join(tmpdir(), 'corvidae-task-environment-'));
  try {
    await createWorkspace(directory);
    const command = [
      join(root, 'node_modules/.bin/turbo'),
      'run',
      'test',
      '--filter=@fixture/application',
    ];
    const constrained = { ...process.env, CODEX_CI: '1' };
    const unconstrained = { ...process.env, CODEX_CI: '0' };
    expect(await run(directory, command, constrained)).toContain('runner=1');
    const before = applicationHash(
      await run(directory, [...command, '--dry=json'], constrained),
      'test',
    );
    const after = applicationHash(
      await run(directory, [...command, '--dry=json'], unconstrained),
      'test',
    );
    expect(after).not.toBe(before);
    expect(await run(directory, command, unconstrained)).toContain('runner=0');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test('test tasks preserve and hash the benchmark runner environment', () => rethrow(scenario5));

const scenario6 = await outcomeOf(async () => {
  const directory = await mkdtemp(join(tmpdir(), 'corvidae-browser-cache-'));
  try {
    await createWorkspace(directory);
    await Bun.write(
      join(directory, '.gitignore'),
      'node_modules/\n.turbo/\n.playwright/\nexecutions.txt\n',
    );
    // The fixtures' own workspace owns their package dependencies, so the root does not: a
    // workspace the root depends on is folded into every task's global hash.
    const manifestPath = join(directory, 'package.json');
    const manifest = await Bun.file(manifestPath).json();
    await Bun.write(
      manifestPath,
      JSON.stringify({
        ...manifest,
        workspaces: [...manifest.workspaces, 'scripts/browser-fixtures'],
        scripts: { 'test:browser-fixtures': 'bun scripts/generate.ts' },
      }),
    );
    await Bun.write(
      join(directory, 'scripts/browser-fixtures/package.json'),
      JSON.stringify({
        name: '@lostgradient/browser-fixtures',
        private: true,
        devDependencies: { '@fixture/library': 'workspace:*' },
      }),
    );
    const outputs = ['manifest.json', 'fixture-modules.ts', 'manifest-inputs.sha256'].map((file) =>
      join('scripts/browser-fixtures/.playwright', file),
    );
    await Bun.write(
      join(directory, 'scripts/generate.ts'),
      `
const executions = Bun.file('executions.txt');
await Bun.write(executions, String((await executions.exists() ? Number(await executions.text()) : 0) + 1));
for (const output of ${JSON.stringify(outputs)}) await Bun.write(output, 'generated input');
`,
    );
    await run(directory, [process.execPath, 'install']);
    const command = [join(root, 'node_modules/.bin/turbo'), 'run', 'test:browser-fixtures'];
    await run(directory, command);
    expect(await Bun.file(join(directory, 'executions.txt')).text()).toBe('1');
    for (const output of outputs) await rm(join(directory, output));
    await run(directory, command);
    expect(await Bun.file(join(directory, 'executions.txt')).text()).toBe('1');
    for (const output of outputs) {
      expect(await Bun.file(join(directory, output)).text()).toBe('generated input');
    }
    await Bun.write(join(directory, 'packages/base/source.ts'), 'export const value = 2;\n');
    await run(directory, command);
    expect(await Bun.file(join(directory, 'executions.txt')).text()).toBe('2');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test('root browser test caches restore their generated catalogs and follow provider source', () =>
  rethrow(scenario6));

function taskHash(output: string, taskId: string): string {
  const summary = JSON.parse(output) as { tasks: Array<{ taskId: string; hash: string }> };
  const task = summary.tasks.find((candidate) => candidate.taskId === taskId);
  if (task === undefined) throw new Error(`Turbo summary has no ${taskId}`);
  return task.hash;
}

const scenario7 = await outcomeOf(async () => {
  // Every task's key once included the whole repository three ways: `//#preflight` hashed every
  // tracked file, `scripts/**` was a global dependency, and the root depended on workspaces,
  // whose files turbo folds into the global hash. Any commit then re-ran every package's suite.
  const directory = await mkdtemp(join(tmpdir(), 'corvidae-cache-isolation-keys-'));
  try {
    await createWorkspace(directory);
    await Bun.write(join(directory, 'scripts/tool.ts'), 'export const tool = 1;\n');
    await Bun.write(join(directory, 'README.md'), '# Fixture\n');
    const command = [join(root, 'node_modules/.bin/turbo'), 'run', 'typecheck', '--dry=json'];
    const baseKey = async () => taskHash(await run(directory, command), '@fixture/base#typecheck');
    const before = await baseKey();

    await Bun.write(
      join(directory, 'applications/application/source.ts'),
      'export const value = 2;\n',
    );
    expect(await baseKey()).toBe(before);
    await Bun.write(join(directory, 'scripts/tool.ts'), 'export const tool = 2;\n');
    expect(await baseKey()).toBe(before);
    await Bun.write(join(directory, 'README.md'), '# Fixture, edited\n');
    expect(await baseKey()).toBe(before);

    // The same key still moves for the package's own source and its lockfile-level inputs.
    await Bun.write(join(directory, 'packages/base/source.ts'), 'export const value = 3;\n');
    expect(await baseKey()).not.toBe(before);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test('a change leaves the cache keys of packages it cannot affect untouched', () =>
  rethrow(scenario7));

const scenario8 = await outcomeOf(async () => {
  // The root browser-fixtures task once hashed every tracked file of the repository (about 14,700
  // inputs), so an edit to AGENTS.md or to an application the fixtures never import re-ran it, and
  // each distinct TMPDIR (declared in `env`) was a different key. Its key is now what it reads:
  // the fixtures' own files, the root scripts it runs, and the providers `transit` folds in.
  const directory = await mkdtemp(join(tmpdir(), 'corvidae-browser-fixtures-keys-'));
  try {
    await createWorkspace(directory);
    await Bun.write(
      join(directory, '.gitignore'),
      'node_modules/\n.turbo/\n.playwright/\ntest-results/\n.DS_Store\n*.log\n',
    );
    const manifestPath = join(directory, 'package.json');
    const manifest = await Bun.file(manifestPath).json();
    await Bun.write(
      manifestPath,
      JSON.stringify({
        ...manifest,
        workspaces: [...manifest.workspaces, 'scripts/browser-fixtures'],
        scripts: { 'test:browser-fixtures': 'bun --eval "void 0"' },
      }),
    );
    await Bun.write(
      join(directory, 'scripts/browser-fixtures/package.json'),
      JSON.stringify({
        name: '@lostgradient/browser-fixtures',
        private: true,
        devDependencies: { '@fixture/cinder': 'workspace:*' },
      }),
    );
    await Bun.write(
      join(directory, 'components/cinder/package.json'),
      JSON.stringify({ name: '@fixture/cinder', private: true }),
    );
    for (const [path, text] of [
      ['components/cinder/src/index.ts', 'export const value = 1;\n'],
      ['scripts/browser-fixtures/scripts/fixture.test.ts', 'export const fixture = 1;\n'],
      ['scripts/bun-test-junit.ts', 'export const runner = 1;\n'],
      ['scripts/tool.ts', 'export const tool = 1;\n'],
      ['AGENTS.md', '# Agents\n'],
    ] as const) {
      await Bun.write(join(directory, path), text);
    }
    await run(directory, [process.execPath, 'install']);
    const command = [
      join(root, 'node_modules/.bin/turbo'),
      'run',
      'test:browser-fixtures',
      '--dry=json',
    ];
    const fixturesKey = async (environment: Record<string, string | undefined> = process.env) =>
      taskHash(await run(directory, command, environment), '//#test:browser-fixtures');
    const before = await fixturesKey();

    // Two TMPDIR values are one key: the task passes it through without hashing it.
    expect(await fixturesKey({ ...process.env, TMPDIR: join(directory, 'one') })).toBe(before);
    expect(await fixturesKey({ ...process.env, TMPDIR: join(directory, 'two') })).toBe(before);

    // Files the task cannot read leave its key alone.
    await Bun.write(join(directory, 'AGENTS.md'), '# Agents, edited\n');
    expect(await fixturesKey()).toBe(before);
    await Bun.write(
      join(directory, 'applications/application/source.ts'),
      'export const value = 2;\n',
    );
    expect(await fixturesKey()).toBe(before);
    await Bun.write(join(directory, 'scripts/tool.ts'), 'export const tool = 2;\n');
    expect(await fixturesKey()).toBe(before);
    // Generated output and machine-local files under the fixtures' own directory are ignored by
    // Git but not by an explicit glob, so each would key the task per machine and per run.
    for (const ignoredFile of [
      'scripts/browser-fixtures/test-results/report.txt',
      'scripts/browser-fixtures/.playwright/manifest.json',
      'scripts/browser-fixtures/snapshots/.DS_Store',
      'scripts/browser-fixtures/scripts/debug.log',
    ]) {
      await Bun.write(join(directory, ignoredFile), 'x\n');
      expect(await fixturesKey(), ignoredFile).toBe(before);
    }

    // Provider source, the fixtures' own files, and the root runner it executes each move it.
    const changes: Array<[string, string]> = [
      ['components/cinder/src/index.ts', 'export const value = 2;\n'],
      ['scripts/browser-fixtures/scripts/fixture.test.ts', 'export const fixture = 2;\n'],
      ['scripts/bun-test-junit.ts', 'export const runner = 2;\n'],
    ];
    let previous = before;
    for (const [path, text] of changes) {
      await Bun.write(join(directory, path), text);
      const after = await fixturesKey();
      expect(after, path).not.toBe(previous);
      previous = after;
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test('the browser-fixtures key follows the files it reads, never the host or the rest of the repository', () =>
  rethrow(scenario8));

test('the browser-fixtures task declares every root file its commands read, and no host variable', async () => {
  // Inputs that are not `$TURBO_DEFAULT$` must name each root script the lane runs or imports,
  // or a change to one replays a cached pass. The lane is the root `test:browser-fixtures`
  // script: it runs `scripts/bun-test-junit.ts` over `scripts/browser-fixtures/scripts`, so every
  // code file the fixtures workspace holds is an entrypoint, and so is every script the command
  // names. Data the runner and the tests read directly cannot be found by import, so they are
  // listed here.
  const { discoverWorkspaces, listTree } = await import('./affected-tests.ts');
  const { analyzeSource, resolveSpecifier, isCodeFile } = await import('./affected-tests-graph.ts');
  const configuration = await Bun.file(join(root, 'turbo.json')).json();
  const task: {
    env?: string[];
    passThroughEnv?: string[];
    inputs?: string[];
    outputs?: string[];
  } = configuration.tasks['//#test:browser-fixtures'];
  const manifest = await Bun.file(join(root, 'package.json')).json();
  const command: string = manifest.scripts['test:browser-fixtures'];
  const workspaces = discoverWorkspaces(root);
  const { paths } = listTree(root);
  const fixturesDirectory = 'scripts/browser-fixtures/';
  const isRootCode = (path: string) =>
    path.startsWith('scripts/') && !path.startsWith(fixturesDirectory);

  const seen = new Set<string>();
  const pending = [
    ...[...paths].filter(
      (path) =>
        path.startsWith(fixturesDirectory) && isCodeFile(path) && !path.endsWith('.playwright.ts'),
    ),
    ...command.split(/[\s&|;'"]+/).filter((token) => paths.has(token) && isCodeFile(token)),
  ];
  for (let current = pending.pop(); current !== undefined; current = pending.pop()) {
    if (seen.has(current)) continue;
    seen.add(current);
    const source = readFileSync(join(root, current), 'utf8');
    const analysis = analyzeSource(current, source);
    for (const specifier of analysis.specifiers) {
      const target = resolveSpecifier(current, specifier, paths, workspaces);
      if (target !== null && (target.startsWith(fixturesDirectory) || isRootCode(target))) {
        pending.push(target);
      }
    }
  }
  const reached = [...seen].filter(isRootCode);
  expect(reached).toContain('scripts/bun-test-junit.ts');

  const inputs = task.inputs ?? [];
  expect(inputs, 'the key must not fall back to every file in the repository').not.toContain(
    '$TURBO_DEFAULT$',
  );
  const covers = (path: string) =>
    inputs.some((input) => input === `$TURBO_ROOT$/${path}` || input === path);
  const required = [
    ...reached,
    // Read by `bun-test-junit.ts` through `check-test-durations.ts`.
    'scripts/test-duration-allowlist.json',
    // Bun's own configuration for a run from the repository root. `tsconfig.json` is a global
    // dependency, and the lockfile's Playwright pin that the provenance test reads moves the
    // root's resolved-dependency hash, so neither belongs here: either would only widen the key.
    'bunfig.toml',
  ];
  expect(
    required.filter((path) => !covers(path)).toSorted(),
    'root files the lane reads that its inputs omit',
  ).toEqual([]);
  expect(inputs).toContain('scripts/browser-fixtures/**');

  // Globs that include ignored directories hash generated output, so the key would drift.
  const exclusion = inputs.find((input) => input.startsWith('!scripts/browser-fixtures/'));
  expect(exclusion, 'generated and installed directories must be excluded').toBeDefined();
  const ignored = inputs.filter((input) => input.startsWith('!scripts/browser-fixtures/'));
  for (const generated of ['.playwright', 'node_modules', 'test-results', 'test-output']) {
    expect(ignored.join(' '), generated).toContain(generated);
  }
  // Editor, log and secret files a developer's machine adds under the glob.
  for (const local of ['.DS_Store', '*.log', '.env']) {
    expect(ignored.join(' '), local).toContain(local);
  }

  // The host's temporary directory differs per machine and per session and does not change what
  // the lane produces, so it must reach the process without keying the task.
  expect(task.env ?? []).not.toContain('TMPDIR');
  expect(task.passThroughEnv ?? []).toContain('TMPDIR');

  // `prepare-manifest.ts` skips regeneration when the hash it recorded still matches its inputs,
  // so a cache restore must bring the record back together with the files it vouches for.
  const generated = ['manifest.json', 'fixture-modules.ts', 'manifest-inputs.sha256'].map(
    (file) => `scripts/browser-fixtures/.playwright/${file}`,
  );
  expect(task.outputs ?? []).toEqual(expect.arrayContaining(generated));
});

test('the root package depends on no workspace but its compiler configuration', async () => {
  // Turbo hashes the files of every workspace the root package depends on, transitively, into
  // the global hash that every task key includes. A workspace the root depends on therefore
  // invalidates every cached task in the repository whenever it changes. Tooling that needs a
  // workspace belongs in a workspace of its own, as `scripts/browser-fixtures` is.
  const manifest = await Bun.file(join(root, 'package.json')).json();
  const workspaceDependencies = Object.entries({
    ...manifest.dependencies,
    ...manifest.devDependencies,
  })
    .filter(([, version]) => String(version).startsWith('workspace:'))
    .map(([name]) => name);
  expect(workspaceDependencies).toEqual(['@lostgradient/typescript']);
});

test('no install task sits in the graph, and global inputs name files, not the whole repository', async () => {
  const configuration = await Bun.file(join(root, 'turbo.json')).json();
  // The install check runs before turbo, in `scripts/run-exclusively.ts`, not as a task: a task
  // every other task depends on folds its own `package.json` into every key, so any root manifest
  // edit would re-run the whole repository.
  expect(configuration.tasks['//#preflight']).toBeUndefined();
  // A directory glob in `globalDependencies` invalidates every task when anything under it changes.
  for (const dependency of configuration.globalDependencies as string[]) {
    expect(dependency, dependency).not.toContain('*');
  }
});

test('the playground build uses the generic build definition', async () => {
  const configuration = await Bun.file(join(root, 'turbo.json')).json();
  // The generic `build` inputs cover the package directory, so a package-specific entry would
  // replace the generic definition and none may appear.
  expect(configuration.tasks['@lostgradient/playground#build']).toBeUndefined();
  expect(configuration.tasks.build.inputs).toBeUndefined();
  expect(configuration.tasks.build.dependsOn).toContain('transit');
  // The Svelte compiler picks development or production output from `NODE_ENV`, but the build
  // script pins `NODE_ENV=production` itself, so the caller's value never reaches the compiler.
  // Hashing it would only split the cache between shells that export different values.
  expect(configuration.tasks.build.env ?? []).not.toContain('NODE_ENV');
  const playgroundManifest = await Bun.file(
    join(root, 'applications/playground/package.json'),
  ).json();
  expect(playgroundManifest.scripts.build).toStartWith('NODE_ENV=production ');
});

test('the bureau tests hash the runtime contracts guide they compare a fixture with', async () => {
  const configuration = await Bun.file(join(root, 'turbo.json')).json();
  const task = configuration.tasks['@lostgradient/bureau#test'];
  // `signal-shutdown.integration.test.ts` fails when the reference handler in the guide drifts from the
  // tested fixture. The guide lives outside the package, so without this input an edit to it
  // alone would restore a cached pass. The entry replaces the generic `test` definition, so it
  // restates `transit` and the generic environment.
  expect(task?.inputs).toContain('$TURBO_DEFAULT$');
  expect(task?.inputs).toContain('$TURBO_ROOT$/documentation/runtime-contracts.md');
  expect(task?.dependsOn).toContain('transit');
  expect(task?.env).toEqual(configuration.tasks.test?.env);
  // Pin the read the input covers, so removing the read prompts removing the input.
  const source = await Bun.file(
    join(root, 'packages/bureau/src/signal-shutdown.integration.test.ts'),
  ).text();
  expect(source).toMatch(/'documentation',\s*'runtime-contracts\.md'/);
});

/**
 * A static model of turbo's `dependsOn` resolution: it strips a leading `^`
 * and falls back from `<package>#<task>` to the bare `<task>` definition. It
 * proves the wiring in `turbo.json`, not the runtime ordering.
 */
function reachesTransit(
  taskKey: string,
  tasks: Record<string, { dependsOn?: string[] }>,
  seen = new Set<string>(),
): boolean {
  if (seen.has(taskKey)) return false;
  seen.add(taskKey);
  const scope = taskKey.includes('#') ? taskKey.slice(0, taskKey.indexOf('#')) : '';
  for (const declared of tasks[taskKey]?.dependsOn ?? []) {
    const entry = declared.startsWith('^') ? declared.slice(1) : declared;
    if (entry === 'transit' || entry.endsWith('#transit')) return true;
    const candidates = entry.includes('#') ? [entry] : [`${scope}#${entry}`, entry];
    for (const candidate of candidates) {
      if (candidate in tasks && reachesTransit(candidate, tasks, seen)) return true;
    }
  }
  return false;
}

test('every cacheable package task reaches transit, so its key follows its dependencies', async () => {
  // `transit` is what folds each upstream workspace's hash into a task's key, so a change to a
  // library's source re-runs its dependents. A package-specific override replaces the generic task
  // definition rather than merging with it, so adding an `env` key to `<package>#test` silently
  // drops the inherited `dependsOn`, which is exactly how `@lostgradient/weft#test` once lost it.
  const configuration = await Bun.file(join(root, 'turbo.json')).json();
  const tasks: Record<string, { cache?: boolean; dependsOn?: string[] }> = configuration.tasks;
  const uncovered = Object.keys(tasks).filter(
    (key) =>
      key !== 'transit' &&
      !key.startsWith('//#') &&
      tasks[key]?.cache !== false &&
      !reachesTransit(key, tasks),
  );
  expect(uncovered).toEqual([]);
});

test('the validate gate runs every suite through the same `test` task the per-pull-request checks run', async () => {
  // `test:gate` and the per-package overrides that swapped a package's `test` for its coverage run
  // are gone (COR-2370): a suite `bun scripts/affected-tests.ts run` just ran is a cache hit in
  // `validate`, because both run the same `test` task on the same inputs.
  const configuration = await Bun.file(join(root, 'turbo.json')).json();
  const tasks: Record<string, { dependsOn?: string[] }> = configuration.tasks;
  expect(
    Object.keys(tasks).filter((name) => name.slice(name.lastIndexOf('#') + 1) === 'test:gate'),
  ).toEqual([]);

  // Coverage is a report: no task depends on a coverage run, and a coverage run never waits for
  // `test`, so the report can run alone.
  for (const [name, definition] of Object.entries(tasks)) {
    expect(definition.dependsOn ?? [], name).not.toContain('test:coverage');
    if (name.endsWith('#test:coverage')) {
      expect(definition.dependsOn ?? [], name).not.toContain('test');
    }
  }

  const { scripts = {} } = await Bun.file(join(root, 'package.json')).json();
  expect(scripts['validate']).toContain(
    'turbo run lint typecheck test:self test test:browser-fixtures',
  );
  expect(scripts['coverage']).toBe(
    "bun scripts/run-exclusively.ts --shared 'turbo run test:coverage'",
  );
  for (const [name, script] of Object.entries<string>(scripts)) {
    for (const invocation of script.match(/turbo run [^&']+/g) ?? []) {
      const names = invocation.split(/\s+/).slice(2);
      expect(names.includes('test') && names.includes('test:coverage'), name).toBe(false);
      expect(names, name).not.toContain('test:gate');
    }
  }
});

test('the check gate is the quick tier: no coverage run and no isolated lane', async () => {
  // Coverage is a report, run on demand by `bun run coverage`; `check` runs `test` alone, whole or
  // narrowed, and never names a coverage task. Coverage runs include each workspace's integration
  // tests (a process or an out-of-process service), which would make `check` depend on host load.
  const { scripts } = await Bun.file(join(root, 'package.json')).json();
  expect(scripts.check as string).toContain('bun scripts/affected-tests.ts run');
  for (const invocation of (scripts.check as string).match(/turbo run [^&']+/g) ?? []) {
    const names = invocation.split(/\s+/).slice(2);
    expect(names).not.toContain('test');
    expect(names).not.toContain('test:coverage');
  }

  const { discoverWorkspaces, planInvocations } = await import('./affected-tests.ts');
  const { selectTests } = await import('./affected-tests-selection.ts');
  const workspaces = discoverWorkspaces(root);
  const selection = selectTests({
    changed: ['turbo.json'],
    tree: { paths: new Set(['package.json', 'turbo.json']), read: () => undefined },
    workspaces,
  });
  expect(selection.repositoryRule).not.toBeNull();
  for (const step of planInvocations(selection)) {
    // The quick tier never runs a coverage report.
    expect(step.tasks).not.toContain('test:coverage');
    expect(step.tasks).not.toContain('test:slow');
  }
});

test('the tasks the selector narrows declare the selection variable, so no result is replayed across selections', async () => {
  // Strict environment mode passes a task only the variables it declares, and hashes them. A
  // narrowed lane without the variable would run everything, or replay a result cached for another
  // selection. Every task the selector runs narrowed, and each package-specific override of one,
  // names it; the whole-workspace coverage report (`test:coverage`) never reads it.
  const { SELECTION_VARIABLE } = await import('./affected-tests-manifest.ts');
  const configuration = await Bun.file(join(root, 'turbo.json')).json();
  const tasks: Record<string, { env?: string[] }> = configuration.tasks;
  for (const [name, definition] of Object.entries(tasks)) {
    const task = name.slice(name.lastIndexOf('#') + 1);
    const narrowed = ['test', 'test:slow', 'test:self', 'test:self:slow', 'test:browser-fixtures'];
    if (narrowed.includes(task)) {
      expect(definition.env ?? [], name).toContain(SELECTION_VARIABLE);
    }
    if (task === 'test:coverage') {
      expect(definition.env ?? [], name).not.toContain(SELECTION_VARIABLE);
    }
  }
});

test('a package task keys on every root script it runs and every root script those import', async () => {
  // A task that runs `bun ../../scripts/x.ts` replays a cached result unless x.ts, and what x.ts
  // imports, are among its inputs: the package's own files do not change when a root script does.
  // This covers the class for every script of every workspace, not one runner at a time.
  const { discoverWorkspaces, listTree } = await import('./affected-tests.ts');
  const { analyzeSource, owningWorkspace, resolveSpecifier } =
    await import('./affected-tests-graph.ts');
  const configuration = await Bun.file(join(root, 'turbo.json')).json();
  const tasks: Record<string, { inputs?: string[] }> = configuration.tasks;
  const workspaces = discoverWorkspaces(root);
  const { paths } = listTree(root);
  const isRootScript = (path: string) => /^scripts\/(?!browser-fixtures\/).+\.ts$/.test(path);
  const isScript = (path: string) =>
    /(?:^|\/)scripts\/.+\.ts$/.test(path) && !/\.test\./.test(path);

  // Every script file a script file imports, through `scripts/` directories only: library source
  // an entrypoint imports is hashed as the package's own files.
  const closure = (entrypoint: string): string[] => {
    const seen = new Set<string>();
    const pending = [entrypoint];
    for (let current = pending.pop(); current !== undefined; current = pending.pop()) {
      if (seen.has(current)) continue;
      seen.add(current);
      const source = readFileSync(join(root, current), 'utf8');
      const analysis = analyzeSource(current, source);
      for (const specifier of analysis.specifiers) {
        const target = resolveSpecifier(current, specifier, paths, workspaces);
        if (target !== null && isScript(target)) pending.push(target);
      }
      // Literal Bun subprocess command arrays name entrypoints outside the import graph.
      // Other path strings may only be comparisons, so they are not execution edges.
      for (const command of source.matchAll(/\[\s*['"]bun['"]\s*,\s*['"]([^'"]+\.ts)['"]/g)) {
        const literal = command[1]!;
        if (!analysis.pathLiterals.includes(literal)) continue;
        for (const directory of [
          posix.dirname(current),
          owningWorkspace(current, workspaces).directory,
        ]) {
          const target = posix.normalize(posix.join(directory, literal));
          if (paths.has(target) && isScript(target)) pending.push(target);
        }
      }
    }
    return [...seen].filter(isRootScript);
  };

  const missing: string[] = [];
  // Every root script each turbo task key can reach, across the workspaces it applies to.
  const reachable = new Map<string, Set<string>>();
  for (const workspace of workspaces) {
    if (workspace.directory === '') continue;
    const manifest = await Bun.file(join(root, workspace.directory, 'package.json')).json();
    for (const [script, command] of Object.entries<string>(manifest.scripts ?? {})) {
      const task = tasks[`${manifest.name}#${script}`] ?? tasks[script];
      if (task === undefined) continue;
      const taskKey =
        tasks[`${manifest.name}#${script}`] === undefined ? script : `${manifest.name}#${script}`;
      const reached = reachable.get(taskKey) ?? new Set<string>();
      reachable.set(taskKey, reached);
      for (const token of command.split(/[\s&|;'"]+/)) {
        const resolved = posix.normalize(posix.join(workspace.directory, token));
        if (!isScript(resolved) || !paths.has(resolved)) continue;
        for (const file of closure(resolved)) {
          reached.add(file);
          const covered = (task.inputs ?? []).some(
            (input) =>
              input === `$TURBO_ROOT$/${file}` || new Bun.Glob(input).match(`$TURBO_ROOT$/${file}`),
          );
          if (!covered)
            missing.push(`${manifest.name}#${script} runs ${resolved}: add $TURBO_ROOT$/${file}`);
        }
      }
    }
  }
  expect(missing.toSorted()).toEqual([]);

  // The other direction: a root script listed as an input that no workspace running the task can
  // reach widens the cache key, so a change to it re-runs work it cannot affect.
  // Scripts reached indirectly (a spawned tool, a dynamic import) are invisible to this scan, so
  // only a script some other task provably reaches counts as misplaced here.
  const reachedAnywhere = new Set([...reachable.values()].flatMap((files) => [...files]));
  const unreachable: string[] = [];
  for (const [taskKey, definition] of Object.entries(tasks)) {
    const reached = reachable.get(taskKey);
    if (reached === undefined) continue;
    for (const input of definition.inputs ?? []) {
      const match = /^\$TURBO_ROOT\$\/(scripts\/[^*]+\.ts)$/.exec(input);
      if (match !== null && reachedAnywhere.has(match[1]!) && !reached.has(match[1]!)) {
        unreachable.push(`${taskKey} declares ${match[1]!}, which no script it runs reaches`);
      }
    }
  }
  // Over-declarations that predate this guard; the list can only shrink, so a fixed entry must be
  // deleted here and a new one cannot be added without review.
  const knownOverDeclarations = [
    '@lostgradient/ventriloquist#typecheck declares scripts/typecheck-contracts.ts, which no script it runs reaches',
    'test:slow declares scripts/bun-test.ts, which no script it runs reaches',
  ];
  expect(unreachable.toSorted()).toEqual(knownOverDeclarations);
});

test('every test lane that bypasses the JUnit wrapper goes through a runner that honours the selection', async () => {
  // `test:slow` scripts used to call `bun test` directly, which would ignore the selection and run
  // every slow file in a workspace the selector narrowed.
  const { discoverWorkspaces } = await import('./affected-tests.ts');
  for (const workspace of discoverWorkspaces(root)) {
    const manifest = await Bun.file(join(root, workspace.directory, 'package.json')).json();
    for (const lane of ['test', 'test:slow', 'test:self', 'test:self:slow']) {
      const script: string | undefined = manifest.scripts?.[lane];
      if (script === undefined) continue;
      for (const command of script.split('&&')) {
        if (!/\bbun test\b/.test(command)) continue;
        expect(command, `${workspace.name} ${lane}`).toMatch(/bun-test-(?:junit|selected)\.ts/);
      }
    }
  }
});

test("Interborough's coverage gate measures both environments without a duplicate host run", async () => {
  const configuration = await Bun.file(join(root, 'turbo.json')).json();
  expect(configuration.tasks['@lostgradient/interborough#test:coverage'].dependsOn).toEqual([
    'transit',
  ]);
  expect(configuration.tasks['@lostgradient/interborough#test:coverage'].inputs).toContain(
    '$TURBO_ROOT$/scripts/test-deadlines.ts',
  );
  expect(configuration.tasks['@lostgradient/interborough#test:coverage'].inputs).toContain(
    '$TURBO_ROOT$/testing/testing/src/hang-guard.ts',
  );
  const runner = await Bun.file(
    join(root, 'applications/interborough/scripts/run-coverage.ts'),
  ).text();
  expect(runner).toContain('--config=./bunfig.toml test');
  expect(runner).toContain('src/host fixtures');
  expect(runner).toContain('--config=./bunfig.ui.toml test');
  expect(runner).toContain('combineEnvironmentCoverage(');
});

test('the root self-tests are keyed on the workspace files they validate', async () => {
  // `scripts/workspace-contract.integration.test.ts` reads every workspace manifest and TypeScript configuration,
  // but a root task hashes only root files by default, so without these inputs a manifest-only
  // change could replay a cached pass instead of re-running the contract.
  const configuration = await Bun.file(join(root, 'turbo.json')).json();
  const inputs: string[] = configuration.tasks['//#test:self']?.inputs ?? [];
  const manifest = await Bun.file(join(root, 'package.json')).json();
  for (const pattern of manifest.workspaces as string[]) {
    for await (const path of new Bun.Glob(`${pattern}/{package.json,tsconfig*.json}`).scan(root)) {
      expect(
        inputs.some((input) => new Bun.Glob(input).match(path)),
        path,
      ).toBe(true);
    }
  }
  expect(inputs).toContain('$TURBO_DEFAULT$');
});

test('the evaluation coverage report runs in the root coverage graph and caches its report', async () => {
  // Turbo has no generic `test:coverage` task, so a workspace's coverage script
  // runs under `bun run coverage` only when `turbo.json` names it. Dropping this
  // entry would silently remove `@lostgradient/evaluation` from the coverage report
  // without failing anything.
  const configuration = await Bun.file(join(root, 'turbo.json')).json();
  const manifest = await Bun.file(join(root, 'testing/evaluation/package.json')).json();
  expect(manifest.scripts?.['test:coverage']).toContain('--coverage');
  expect(configuration.tasks['@lostgradient/evaluation#test:coverage']).toMatchObject({
    dependsOn: ['transit'],
    outputs: expect.arrayContaining(['coverage/**']),
  });
});

test('every workspace that defines a coverage script has a task for it, and none of them fails on a floor', async () => {
  const configuration = await Bun.file(join(root, 'turbo.json')).json();
  const { discoverWorkspaces } = await import('./affected-tests.ts');
  for (const workspace of discoverWorkspaces(root)) {
    const manifest = await Bun.file(join(root, workspace.directory, 'package.json')).json();
    const script: string | undefined = manifest.scripts?.['test:coverage'];
    if (script === undefined) continue;
    expect(configuration.tasks[`${manifest.name}#test:coverage`], manifest.name).toBeDefined();
    // The floors (`coverageThreshold`, a recorded ratchet) are gone: the script is the test run
    // plus a report, and its exit status is the test run's.
    expect(script, manifest.name).not.toMatch(/ratchet|check-coverage\.ts/);
  }
  for await (const path of new Bun.Glob(
    '{applications,components,packages,testing}/*/bunfig*.toml',
  ).scan(root)) {
    expect(await Bun.file(join(root, path)).text(), path).not.toContain('coverageThreshold');
  }
});

test('the root package defines the preflight script the lock wrapper runs', async () => {
  // `scripts/run-exclusively.ts` runs the same command before every heavy stage; the script keeps
  // it available on its own as `bun run preflight`.
  const manifest = await Bun.file(join(root, 'package.json')).json();
  expect(manifest.scripts?.preflight).toBe('bun install --frozen-lockfile');
});
