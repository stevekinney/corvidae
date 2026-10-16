import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SCENARIO_HANG_GUARD_MILLISECONDS } from '../module-scope-scenario.test-support.ts';
import { shellWord } from './mirror-verify-workflow.ts';
import { applyVersionConstants, versionConstants } from './source.ts';
import type { PublishedPackage } from './surface.ts';
import { buildVerifySteps, versionConstantScript, type VerifyEnvironment } from './verify-steps.ts';

/**
 * The release gate for exported version constants. `@lostgradient/cinder@0.28.0` shipped a
 * `package.json` at 0.28.0 beside `export const VERSION = '0.27.1';`: the sync had rewritten the
 * constant to the target's version, and the target's Changesets flow bumped the manifest after it.
 * `mirror-verify.yaml`, which the target's release job needs, now runs `versionConstantScript`.
 */

const cinderVersionFile = versionConstants['@lostgradient/cinder']!;

const generatedHeader = ['/**', ' * GENERATED FILE. Do not edit by hand.', ' */', ''].join('\n');

function versionFile(version: string): string {
  return `${generatedHeader}export const VERSION = '${version}';\n`;
}

interface Outcome {
  exitCode: number;
  stdout: string;
  stderr: string;
}

const scratch = await mkdtemp(join(tmpdir(), 'version-constant-gate-'));

/**
 * One package directory with the given manifest version and version file, checked by the gate as
 * the rendered workflow runs it: one shell line from the step's argv. The child is the behavior,
 * so it runs here at module scope, off the per-test clock.
 */
async function runGate(
  name: string,
  manifestVersion: string,
  contents: string | undefined,
): Promise<Outcome> {
  const directory = join(scratch, name);
  await mkdir(join(directory, 'src/tokens/runtime'), { recursive: true });
  await Bun.write(
    join(directory, 'package.json'),
    JSON.stringify({ name: '@lostgradient/cinder', version: manifestVersion }),
  );
  if (contents !== undefined) await Bun.write(join(directory, cinderVersionFile), contents);
  const line = ['bun', '-e', versionConstantScript, cinderVersionFile].map(shellWord).join(' ');
  const child = Bun.spawn(['sh', '-c', line], {
    cwd: directory,
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: SCENARIO_HANG_GUARD_MILLISECONDS,
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, stdout, stderr };
}

/** The file `applyVersionConstants` emits for a composed version, as the sync writes it. */
function emittedBySync(version: string): string {
  const path = `packages/components/${cinderVersionFile}`;
  const files: Record<string, string> = { [path]: versionFile('workspace') };
  applyVersionConstants(files, [
    { workspace: '@lostgradient/cinder', directory: 'packages/components', version },
  ]);
  return files[path]!;
}

const stale = await runGate('stale', '0.28.0', versionFile('0.27.1'));
const matching = await runGate('matching', '0.28.0', versionFile('0.28.0'));
const syncEmitted = await runGate('sync-emitted', '1.0.0-beta.2', emittedBySync('1.0.0-beta.2'));
const missing = await runGate('missing', '0.28.0', undefined);
const misshapen = await runGate(
  'misshapen',
  '0.28.0',
  "export const VERSION = '0.28.0';\nexport const OTHER = 1;\n",
);
const sentinel = await runGate('sentinel', '0.28.0', versionFile('workspace'));
await rm(scratch, { recursive: true, force: true });

describe('versionConstantScript', () => {
  test('refuses the 0.28.0 release: manifest 0.28.0, exported VERSION 0.27.1', () => {
    expect(stale.exitCode).toBe(1);
    expect(stale.stderr).toContain('exports VERSION 0.27.1');
    expect(stale.stderr).toContain('package.json is version 0.28.0');
    expect(stale.stderr).toContain('Run the mirror sync for this target');
  });

  test('passes when the exported VERSION is the manifest version', () => {
    expect(matching.exitCode).toBe(0);
    expect(matching.stdout).toContain('@lostgradient/cinder exports VERSION 0.28.0');
  });

  test('passes the file the sync emits, so a sync pull request is never refused by its own gate', () => {
    expect(syncEmitted.exitCode).toBe(0);
  });

  test('refuses a declared version file that is missing', () => {
    expect(missing.exitCode).toBe(1);
    expect(missing.stderr).toContain('does not exist');
  });

  test('refuses a version file with anything after the export', () => {
    expect(misshapen.exitCode).toBe(1);
    expect(misshapen.stderr).toContain('is not shaped as export const VERSION');
  });

  test("refuses corvidae's unsubstituted sentinel", () => {
    expect(sentinel.exitCode).toBe(1);
    expect(sentinel.stderr).toContain('exports VERSION workspace');
  });

  test('renders as one shell word without quoting', () => {
    expect(shellWord(versionConstantScript)).toBe(`'${versionConstantScript}'`);
    expect(versionConstantScript).not.toContain("'");
    expect(versionConstantScript).not.toContain('\\');
  });
});

describe('the version-constant verify step', () => {
  const environment: VerifyEnvironment = {
    resolveDirectory: (relative) => relative,
    scratchDirectory: '/scratch',
    toolCommand: (tool) => [tool],
  };

  function publishedPackage(workspace: string, directory: string): PublishedPackage {
    return {
      workspace,
      directory,
      publicName: workspace,
      entry: {} as PublishedPackage['entry'],
      exports: { '.': { types: './dist/index.d.ts', default: './dist/index.js' } },
      files: ['dist'],
      version: '1.0.0',
      dependsOn: [],
    };
  }

  const steps = buildVerifySteps(
    {
      installCommand: ['bun', 'install', '--frozen-lockfile'],
      published: [
        publishedPackage('@lostgradient/markdown', 'packages/markdown'),
        publishedPackage('@lostgradient/cinder', 'packages/components'),
      ],
      privateWorkspaces: [],
    },
    environment,
  );

  test('runs once per package that declares a version constant, in its package directory', () => {
    const gates = steps.filter((step) => step.kind === 'version-constant');
    expect(gates.map((step) => [step.publicName, step.cwd, step.command])).toEqual([
      [
        '@lostgradient/cinder',
        'packages/components',
        ['bun', '-e', versionConstantScript, cinderVersionFile],
      ],
    ]);
  });

  test('runs after the install and before any build', () => {
    const kinds = steps.map((step) => step.kind);
    expect(kinds[0]).toBe('install');
    expect(kinds.indexOf('version-constant')).toBe(1);
    expect(kinds.indexOf('version-constant')).toBeLessThan(kinds.indexOf('build'));
  });
});
