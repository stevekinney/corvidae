import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { spawnWithHangGuard } from './hang-guard.ts';
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
      { name: 'weft', task: 'dev:ui-browser', variable: 'WEFT_UI_PORT' },
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
    const outputs = ['manifest.json', 'fixture-modules.ts'].map((file) =>
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

test('the preflight and global inputs name files, not the whole repository', async () => {
  const configuration = await Bun.file(join(root, 'turbo.json')).json();
  // Every task depends on `//#preflight`, so its inputs are part of every task key. It never caches,
  // so it re-verifies the install against the lockfile on every run whatever its inputs are; the
  // inputs only decide which edits re-key every task. The lockfile changes whenever any dependency
  // does. A manifest edit that leaves it alone (a script, a field) re-keys only that package and its
  // dependents, through `transit`, rather than the whole repository. No inputs at all would mean
  // Turborepo's default, every file in the repository.
  expect(configuration.tasks['//#preflight']?.inputs).toEqual(['bun.lock']);
  // A directory glob in `globalDependencies` invalidates every task when anything under it changes.
  for (const dependency of configuration.globalDependencies as string[]) {
    expect(dependency, dependency).not.toContain('*');
  }
});

test('the playground build is keyed on the published versions its documentation reads', async () => {
  const configuration = await Bun.file(join(root, 'turbo.json')).json();
  // The Playground reads each package's last published version from `published-versions.json`
  // in its own directory: the documentation displays it, and the bundles stamp Cinder's into the
  // token runtime. The generic `build` inputs cover the package directory, so a change to that file
  // already invalidates the cache and the build needs no entry of its own. A package-specific entry
  // would replace the generic definition, so none may reappear to hash a root file instead.
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
  expect(
    await Bun.file(join(root, 'applications/playground/published-versions.json')).exists(),
  ).toBe(true);
  // Pin the read the key covers, so moving the read out of the package prompts revisiting it. The
  // path is defined once in `playground-paths.ts`, shared by the version read and the file watcher,
  // so the pin has three parts: the definition names the file inside the playground,
  // `published-version.ts` imports that definition and reads the file through it, and both
  // consumers of the version — the documentation, and the stamp that writes Cinder's version into
  // the bundled token runtime (COR-231) — import that read.
  const paths = await Bun.file(
    join(root, 'applications/playground/src/playground-paths.ts'),
  ).text();
  expect(paths).toMatch(/export const PUBLISHED_VERSIONS_PATH\s*=\s*join\(PLAYGROUND_ROOT,/);
  expect(paths).toContain("'published-versions.json'");
  const read = await Bun.file(
    join(root, 'applications/playground/src/published-version.ts'),
  ).text();
  // The imported name must be `PUBLISHED_VERSIONS_PATH` itself: `{ SOMETHING_ELSE as
  // PUBLISHED_VERSIONS_PATH }` would satisfy a looser match while pointing the read elsewhere.
  expect(read).toMatch(
    /import\s*\{(?:[^}]*,)?\s*PUBLISHED_VERSIONS_PATH\s*(?:,[^}]*)?\}\s*from\s*'\.\/playground-paths\.ts'/,
  );
  expect(read).toContain('Bun.file(PUBLISHED_VERSIONS_PATH)');
  for (const consumer of ['component-documentation.ts', 'cinder-package-version-plugin.ts']) {
    const source = await Bun.file(join(root, 'applications/playground/src', consumer)).text();
    expect(source).toMatch(
      /import\s*\{(?:[^}]*,)?\s*readLastPublishedVersion\s*(?:,[^}]*)?\}\s*from\s*'\.\/published-version\.ts'/,
    );
  }
});

test('the bureau tests hash the runtime contracts guide they compare a fixture with', async () => {
  const configuration = await Bun.file(join(root, 'turbo.json')).json();
  const task = configuration.tasks['@lostgradient/bureau#test'];
  // `signal-shutdown.test.ts` fails when the reference handler in the guide drifts from the
  // tested fixture. The guide lives outside the package, so without this input an edit to it
  // alone would restore a cached pass. The entry replaces the generic `test` definition, so it
  // restates `transit` and the generic environment.
  expect(task?.inputs).toContain('$TURBO_DEFAULT$');
  expect(task?.inputs).toContain('$TURBO_ROOT$/documentation/runtime-contracts.md');
  expect(task?.dependsOn).toContain('transit');
  expect(task?.env).toEqual(configuration.tasks.test?.env);
  // Pin the read the input covers, so removing the read prompts removing the input.
  const source = await Bun.file(join(root, 'packages/bureau/src/signal-shutdown.test.ts')).text();
  expect(source).toMatch(/'documentation',\s*'runtime-contracts\.md'/);
});

/**
 * A static model of turbo's `dependsOn` resolution: it strips a leading `^`
 * and falls back from `<package>#<task>` to the bare `<task>` definition. It
 * proves the wiring in `turbo.json`, not the runtime ordering — a real
 * `turbo run` showing `//:preflight` ahead of the task is what confirms that.
 */
function reachesPreflight(
  taskKey: string,
  tasks: Record<string, { dependsOn?: string[] }>,
  seen = new Set<string>(),
): boolean {
  if (seen.has(taskKey)) return false;
  seen.add(taskKey);
  const scope = taskKey.includes('#') ? taskKey.slice(0, taskKey.indexOf('#')) : '';
  for (const declared of tasks[taskKey]?.dependsOn ?? []) {
    const entry = declared.startsWith('^') ? declared.slice(1) : declared;
    if (entry === '//#preflight') return true;
    const candidates = entry.includes('#') ? [entry] : [`${scope}#${entry}`, entry];
    for (const candidate of candidates) {
      if (candidate in tasks && reachesPreflight(candidate, tasks, seen)) return true;
    }
  }
  return false;
}

test('every cacheable turbo task reaches the install preflight', async () => {
  // A cached task that never routes through `//#preflight` can restore a result
  // computed against a `node_modules` that had drifted from `bun.lock`, because
  // turbo hashes the lockfile but never the installed tree. A package-specific
  // override replaces the generic task definition rather than merging with it,
  // so adding an `env` key to `<package>#test` silently drops the inherited
  // `dependsOn` — which is exactly how `@lostgradient/weft#test` lost it.
  const configuration = await Bun.file(join(root, 'turbo.json')).json();
  const tasks: Record<string, { cache?: boolean; dependsOn?: string[] }> = configuration.tasks;
  const uncovered = Object.keys(tasks).filter(
    (key) => key !== '//#preflight' && tasks[key]?.cache !== false && !reachesPreflight(key, tasks),
  );
  expect(uncovered).toEqual([]);
});

test('the evaluation coverage gate runs in the root coverage graph and caches its report', async () => {
  // Turbo has no generic `test:coverage` task, so a workspace's coverage script
  // runs under `bun run coverage` only when `turbo.json` names it. Dropping this
  // entry would silently remove `@lostgradient/evaluation`'s 100 percent line and
  // function threshold from `bun run validate` without failing anything.
  const configuration = await Bun.file(join(root, 'turbo.json')).json();
  const manifest = await Bun.file(join(root, 'testing/evaluation/package.json')).json();
  expect(manifest.scripts?.['test:coverage']).toContain('--coverage');
  expect(configuration.tasks['@lostgradient/evaluation#test:coverage']).toMatchObject({
    dependsOn: ['transit'],
    outputs: expect.arrayContaining(['coverage/**']),
  });
});

test('the root package defines the preflight script the turbo task runs', async () => {
  // Turbo treats a task whose script is missing as a silent no-op, so deleting
  // or renaming this script would disable the gate above without failing.
  const manifest = await Bun.file(join(root, 'package.json')).json();
  expect(manifest.scripts?.preflight).toBe('bun install --frozen-lockfile');
});
