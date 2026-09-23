import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = join(import.meta.dir, '..');

test('temporary task fixtures never access an inherited remote cache', async () => {
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

test('application hosts and tests receive only their owned configuration', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'corvidae-host-environment-'));
  try {
    await createWorkspace(directory);
    const cases = [
      { name: 'desktop', task: 'dev', variable: 'ANTHROPIC_API_KEY' },
      { name: 'desktop', task: 'dev', variable: 'ANTHROPIC_BASE_URL' },
      { name: 'weft-ui', task: 'dev:browser', variable: 'WEFT_UI_PORT' },
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

test('an inherited TURBO_FORCE cannot make a fixture re-execute instead of restoring', async () => {
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
  const child = Bun.spawn(fixtureCommand, {
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

test('source task hashes follow transitive libraries, internal configuration and shared tooling', async () => {
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

test('test tasks preserve and hash the benchmark runner environment', async () => {
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

test('application check caches restore generated inputs without restoring build output', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'corvidae-generated-inputs-'));
  try {
    await createWorkspace(directory);
    await Bun.write(
      join(directory, '.gitignore'),
      'node_modules/\n.turbo/\n.hutch/\n.svelte-kit/\n.playwright/\nbuild/\nexecutions.txt\n',
    );
    // Electrobun projects its SDK into `.hutch/devkit` rather than generating
    // `.svelte-kit`, but the property under test is unchanged: a task that
    // declares generated inputs as outputs restores them from cache, while an
    // application's build output stays deleted.
    const cases = [
      {
        name: 'desktop',
        tasks: ['prepare:devkit'],
        outputs: ['.hutch/devkit/tsconfig.json', '.hutch/devkit/api/sdks/main/index.ts'],
      },
    ];
    for (const application of cases) {
      const applicationDirectory = join(directory, 'packages', application.name);
      await Bun.write(
        join(applicationDirectory, 'package.json'),
        JSON.stringify({
          name: `@lostgradient/${application.name}`,
          private: true,
          scripts: Object.fromEntries(application.tasks.map((task) => [task, 'bun generate.ts'])),
        }),
      );
      await Bun.write(
        join(applicationDirectory, 'generate.ts'),
        `const file = Bun.file('executions.txt');
await Bun.write(file, String((await file.exists() ? Number(await file.text()) : 0) + 1));
for (const output of ${JSON.stringify(application.outputs)}) await Bun.write(output, 'generated input');
`,
      );
    }
    await run(directory, [process.execPath, 'install']);
    for (const application of cases) {
      const applicationDirectory = join(directory, 'packages', application.name);
      const executions = Bun.file(join(applicationDirectory, 'executions.txt'));
      for (const [index, task] of application.tasks.entries()) {
        const command = [
          join(root, 'node_modules/.bin/turbo'),
          'run',
          task,
          `--filter=@lostgradient/${application.name}`,
        ];
        const unrelatedBuildOutput = join(
          applicationDirectory,
          'build/dev-macos-arm64/application.js',
        );
        await Bun.write(unrelatedBuildOutput, 'application build');
        await run(directory, command);
        expect(await executions.text()).toBe(String(index + 1));
        await rm(unrelatedBuildOutput);
        for (const output of application.outputs) await rm(join(applicationDirectory, output));
        await run(directory, command);
        expect(await executions.text()).toBe(String(index + 1));
        for (const output of application.outputs) {
          expect(await Bun.file(join(applicationDirectory, output)).text()).toBe('generated input');
        }
        expect(await Bun.file(unrelatedBuildOutput).exists()).toBe(false);
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('root browser test caches restore their generated catalogs and follow provider source', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'corvidae-browser-cache-'));
  try {
    await createWorkspace(directory);
    await Bun.write(
      join(directory, '.gitignore'),
      'node_modules/\n.turbo/\n.playwright/\nexecutions.txt\n',
    );
    const manifestPath = join(directory, 'package.json');
    const manifest = await Bun.file(manifestPath).json();
    await Bun.write(
      manifestPath,
      JSON.stringify({
        ...manifest,
        devDependencies: { '@fixture/library': 'workspace:*' },
        scripts: { 'test:browser-fixtures': 'bun scripts/generate.ts' },
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

test('the root package defines the preflight script the turbo task runs', async () => {
  // Turbo treats a task whose script is missing as a silent no-op, so deleting
  // or renaming this script would disable the gate above without failing.
  const manifest = await Bun.file(join(root, 'package.json')).json();
  expect(manifest.scripts?.preflight).toBe('bun install --frozen-lockfile');
});
