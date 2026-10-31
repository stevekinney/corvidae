/**
 * COR-1883 — the plugin identity guard. The scenarios that need a real checkout (a baseline commit,
 * a plugin to load, the CLI's exit code) run at module scope, as the process-spawn guard requires,
 * in one fixture repository whose commits are the baselines; the tests assert on what they recorded.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, test } from 'bun:test';

import { runWithHangGuard } from '../testing/testing/src/hang-guard.ts';
import {
  baselineVariable,
  compareIdentities,
  type IdentitySnapshot,
  parseSnapshot,
} from './check-plugin-identities.ts';

const script = join(import.meta.dir, 'check-plugin-identities.ts');
const zodPath = Bun.resolveSync('zod', join(import.meta.dir, '../packages/interborough-plugin'));

function snapshot(version: string, schema: string | null): IdentitySnapshot {
  return {
    plugin: 'example',
    version,
    entries: [{ kind: 'tool', id: 'example:lookup', version, schema }],
  };
}

describe('compareIdentities', () => {
  test('fails a digest that changed at the same version', () => {
    expect(compareIdentities(snapshot('1.0.0', 'sha256:a'), snapshot('1.0.0', 'sha256:b'))).toEqual(
      [expect.stringContaining('The tool "example:lookup" changed its schema at version 1.0.0')],
    );
  });

  test('passes a changed digest under a bumped version, an unchanged digest, and new or removed entries', () => {
    expect(compareIdentities(snapshot('1.0.0', 'sha256:a'), snapshot('1.1.0', 'sha256:b'))).toEqual(
      [],
    );
    expect(compareIdentities(snapshot('1.0.0', 'sha256:a'), snapshot('1.0.0', 'sha256:a'))).toEqual(
      [],
    );
    expect(
      compareIdentities(snapshot('1.0.0', 'sha256:a'), {
        ...snapshot('1.0.0', 'sha256:a'),
        entries: [],
      }),
    ).toEqual([]);
    expect(
      compareIdentities(
        { ...snapshot('1.0.0', 'sha256:a'), entries: [] },
        snapshot('1.0.0', 'sha256:a'),
      ),
    ).toEqual([]);
  });
});

describe('parseSnapshot', () => {
  test('reads a snapshot and names why anything else is refused', () => {
    expect(parseSnapshot(JSON.stringify(snapshot('1.0.0', null)))).toEqual(snapshot('1.0.0', null));
    expect(parseSnapshot('{')).toContain('not valid JSON');
    expect(parseSnapshot('{"plugin":"x"}')).toContain('must hold');
  });
});

const roots: string[] = [];
afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

const root = await mkdtemp(join(tmpdir(), 'plugin-identities-'));
roots.push(root);

async function run(command: string[], environment: Record<string, string> = {}) {
  const completed = await runWithHangGuard(command, {
    env: { ...process.env, ...environment },
  });
  return {
    exitCode: completed.exitCode,
    output: `${completed.stdout.toString()}${completed.stderr.toString()}`,
  };
}

const git = (...args: string[]) =>
  run(['git', '-c', 'user.name=Test', '-c', 'user.email=test@example.test', '-C', root, ...args]);

async function writePlugin(name: string, version: string, field: string) {
  const directory = join(root, 'plugins', name);
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, 'package.json'),
    JSON.stringify({ name: `@fixture/${name}`, private: true, exports: { '.': './plugin.js' } }),
  );
  await writeFile(
    join(directory, 'plugin.js'),
    `import { z } from ${JSON.stringify(zodPath)};
export default {
  name: ${JSON.stringify(name)},
  version: ${JSON.stringify(version)},
  description: 'A fixture plugin.',
  configuration: z.object({ ${field}: z.string().default('x') }),
};
`,
  );
}

const check = (environment: Record<string, string> = {}) =>
  run([process.execPath, script, '--root', root], environment);
const write = (name: string) =>
  run([process.execPath, script, '--root', root, '--write', `plugins/${name}`]);

await git('init', '--quiet');
await writePlugin('example', '1.0.0', 'first');
const written = await write('example');
await git('add', '-A');
await git('commit', '--quiet', '-m', 'baseline');
const head = await git('rev-parse', 'HEAD');
const baseline = head.output.trim();

const unchanged = await check({ [baselineVariable]: baseline });

await writePlugin('example', '1.0.0', 'second');
const stale = await check({ [baselineVariable]: baseline });
await write('example');
const sameVersion = await check({ [baselineVariable]: baseline });

await writePlugin('example', '1.1.0', 'second');
await write('example');
await writePlugin('fresh', '0.1.0', 'only');
await write('fresh');
const bumpedAndNew = await check({ [baselineVariable]: baseline });

await writePlugin('bare', '1.0.0', 'only');
const missingFile = await check({ [baselineVariable]: baseline });
const missingRef = await check({ [baselineVariable]: 'refs/heads/does-not-exist' });

const committed = JSON.parse(
  await Bun.file(join(root, 'plugins/example/plugin-identities.json')).text(),
);

describe('the guard over a fixture repository', () => {
  test('--write writes the workspace file from its plugin', () => {
    expect(written.exitCode).toBe(0);
    expect(committed.plugin).toBe('example');
    expect(committed.version).toBe('1.1.0');
    expect(committed.entries).toEqual([
      expect.objectContaining({ kind: 'configuration', id: 'example', version: '1.1.0' }),
    ]);
  });

  test('passes a plugin that has not changed since the baseline', () => {
    expect(unchanged).toEqual({ exitCode: 0, output: '' });
  });

  test('fails a file that no longer matches its plugin', () => {
    expect(stale.exitCode).toBe(1);
    expect(stale.output).toContain('plugins/example/plugin-identities.json is out of date');
    expect(stale.output).toContain('--write plugins/example');
  });

  test('fails a schema digest that changed while the version did not', () => {
    expect(sameVersion.exitCode).toBe(1);
    expect(sameVersion.output).toContain(
      'The configuration "example" changed its schema at version 1.0.0',
    );
  });

  test('passes after a version bump, and passes a plugin absent at the baseline', () => {
    expect(bumpedAndNew).toEqual({ exitCode: 0, output: '' });
  });

  test('fails a plugin workspace that has no file', () => {
    expect(missingFile.exitCode).toBe(1);
    expect(missingFile.output).toContain('plugins/bare has no plugin-identities.json');
  });

  test('fails a baseline ref that does not exist and names the variable', () => {
    expect(missingRef.exitCode).toBe(1);
    expect(missingRef.output).toContain(baselineVariable);
    expect(missingRef.output).toContain('refs/heads/does-not-exist');
  });
});
