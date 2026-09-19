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
      { name: 'chat-room', task: 'dev', variable: 'ANTHROPIC_API_KEY' },
      { name: 'chat-room', task: 'preview', variable: 'ANTHROPIC_BASE_URL' },
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
          name: `@corvidae/${name}`,
          private: true,
          scripts: { [task]: 'bun check.ts' },
        }),
      );
      await run(directory, [process.execPath, 'install']);
      const output = await run(
        directory,
        [join(root, 'node_modules/.bin/turbo'), 'run', task, `--filter=@corvidae/${name}`],
        { ...process.env, [variable]: 'configuration-test', CORVIDAE_UNRELATED_TEST: 'excluded' },
      );
      expect(output).toContain('configuration received');
    }
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
    delete fixtureEnvironment.TURBO_API;
    delete fixtureEnvironment.TURBO_TOKEN;
    delete fixtureEnvironment.TURBO_TEAM;
    delete fixtureEnvironment.TURBO_TEAMID;
    delete fixtureEnvironment.TURBO_CACHE;
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
  await Bun.write(join(directory, '.gitignore'), 'node_modules/\n');
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
      'node_modules/\n.svelte-kit/\n.playwright/\nbuild/\nexecutions.txt\n',
    );
    const cases = [
      {
        name: 'chat-room',
        tasks: ['lint', 'typecheck'],
        outputs: [
          '.svelte-kit/tsconfig.json',
          '.svelte-kit/ambient.d.ts',
          '.svelte-kit/env.d.ts',
          '.svelte-kit/non-ambient.d.ts',
          '.svelte-kit/types/src/routes/$types.d.ts',
          '.svelte-kit/generated/root.svelte',
        ],
      },
    ];
    for (const application of cases) {
      const applicationDirectory = join(directory, 'packages', application.name);
      await Bun.write(
        join(applicationDirectory, 'package.json'),
        JSON.stringify({
          name: `@corvidae/${application.name}`,
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
          `--filter=@corvidae/${application.name}`,
        ];
        const unrelatedBuildOutput = join(
          applicationDirectory,
          '.svelte-kit/output/server/index.js',
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
    await Bun.write(join(directory, '.gitignore'), 'node_modules/\n.playwright/\nexecutions.txt\n');
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
