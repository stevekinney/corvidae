import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = join(import.meta.dir, '..');

async function run(
  directory: string,
  command: string[],
  environment = process.env,
): Promise<string> {
  const child = Bun.spawn(command, {
    cwd: directory,
    stdout: 'pipe',
    stderr: 'pipe',
    env: environment,
  });
  const [exitCode, output, errors] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(`${command.join(' ')} exited ${exitCode}: ${errors}`);
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
      workspaces: ['packages/*'],
    }),
  );
  await Bun.write(join(directory, '.gitignore'), 'node_modules/\n');
  await Bun.write(join(directory, 'turbo.json'), Bun.file(join(root, 'turbo.json')));
  for (const [name, dependency] of [
    ['base', undefined],
    ['library', 'base'],
    ['application', 'library'],
  ]) {
    if (!name) throw new Error('Fixture workspace name is required');
    await Bun.write(
      join(directory, 'packages', name, 'package.json'),
      JSON.stringify({
        name: `@fixture/${name}`,
        private: true,
        scripts: {
          typecheck: 'bun --eval "void 0"',
          test: `bun --eval "console.log('runner=' + (process.env.CODEX_CI ?? 'unset'))"`,
        },
        dependencies: dependency ? { [`@fixture/${dependency}`]: 'workspace:*' } : {},
      }),
    );
    await Bun.write(join(directory, 'packages', name, 'source.ts'), 'export const value = 1;\n');
  }
  await run(directory, ['git', 'init', '--quiet']);
  await run(directory, [process.execPath, 'install']);
}

test('source task hashes follow transitive library and shared tooling changes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'corvidae-task-cache-'));
  try {
    await createWorkspace(directory);
    const command = [join(root, 'node_modules/.bin/turbo'), 'run', 'typecheck', '--dry=json'];
    const before = applicationHash(await run(directory, command));
    await Bun.write(join(directory, 'packages/base/source.ts'), 'export const value = 2;\n');
    const afterDependency = applicationHash(await run(directory, command));
    expect(afterDependency).not.toBe(before);
    await Bun.write(join(directory, '.oxlintrc.json'), '{ "rules": { "no-labels": "error" } }');
    const afterTooling = applicationHash(await run(directory, command));
    expect(afterTooling).not.toBe(afterDependency);
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
      {
        name: 'cinder-browser-fixtures',
        tasks: ['test', 'build'],
        outputs: ['.playwright/manifest.json'],
      },
    ];
    for (const application of cases) {
      const applicationDirectory = join(directory, 'packages', application.name);
      await Bun.write(
        join(applicationDirectory, 'package.json'),
        JSON.stringify({
          name: `@repo/${application.name}`,
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
          `--filter=@repo/${application.name}`,
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
