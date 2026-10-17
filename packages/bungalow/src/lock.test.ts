import { spawnWithHangGuard } from '@lostgradient/testing/hang-guard';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, test } from 'bun:test';

import { openBungalow } from './bungalow.ts';
import { BungalowLockedError } from './errors.ts';
import { homeEnvironment, TEST_NAME, useTemporaryDirectories } from './fixtures.test-support.ts';

const temporaryDirectory = useTemporaryDirectories();

function openIn(root: string) {
  return openBungalow({ name: TEST_NAME, environment: homeEnvironment(root) });
}

/** A process identifier no operating system hands out, so its holder is certainly dead. */
const ABSENT_PROCESS = 2_147_483_646;

/**
 * The child-process scenario runs once at module scope, where no per-test clock applies and the
 * hang guard bounds it, rather than inside test bodies (AGENTS.md, COR-1507). A child opens the
 * root and holds its lock; this process then tries the same root, kills the child without letting
 * it close, and reopens the root to prove that a dead holder's lock is reclaimed.
 */
type ChildScenario = {
  readonly childProcessIdentifier: number;
  readonly childDeploymentId: string;
  readonly whileHeld: unknown;
  readonly lockFileWhileHeld: string;
  readonly afterKill:
    { readonly deploymentId: string; readonly lockFile: string } | { error: unknown };
};

const scenarioRoot = mkdtempSync(join(tmpdir(), 'bungalow-lock-'));
afterAll(() => {
  rmSync(scenarioRoot, { recursive: true, force: true });
});

async function readReadyLine(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (value !== undefined) text += decoder.decode(value, { stream: true });
    const newline = text.indexOf('\n');
    if (newline !== -1) {
      reader.releaseLock();
      return text.slice(0, newline);
    }
    if (done)
      throw new Error(`The lock holder exited before it was ready: ${JSON.stringify(text)}`);
  }
}

async function runChildScenario(): Promise<ChildScenario> {
  const child = spawnWithHangGuard(
    [process.execPath, join(import.meta.dir, 'lock-holder.test-support.ts'), scenarioRoot],
    { stdout: 'pipe', stderr: 'inherit' },
  );
  try {
    const ready = await readReadyLine(child.stdout);
    const [marker, childDeploymentId] = ready.split(' ');
    if (marker !== 'READY' || childDeploymentId === undefined) {
      throw new Error(`Unexpected lock holder output: ${ready}`);
    }

    let whileHeld: unknown;
    try {
      openIn(scenarioRoot).close();
    } catch (error) {
      whileHeld = error;
    }
    const lockFileWhileHeld = readFileSync(join(scenarioRoot, 'lock'), 'utf8');

    child.kill('SIGKILL');
    await child.exited;

    let afterKill: ChildScenario['afterKill'];
    try {
      const reclaimed = openIn(scenarioRoot);
      afterKill = {
        deploymentId: reclaimed.deploymentId,
        lockFile: readFileSync(join(scenarioRoot, 'lock'), 'utf8'),
      };
      reclaimed.close();
    } catch (error) {
      afterKill = { error };
    }
    return {
      childProcessIdentifier: child.pid,
      childDeploymentId,
      whileHeld,
      lockFileWhileHeld,
      afterKill,
    };
  } finally {
    child.kill('SIGKILL');
    await child.exited;
  }
}

const scenario = await runChildScenario();

describe('a lock held by another process', () => {
  test('makes a second open throw BungalowLockedError naming the holder', () => {
    expect(scenario.whileHeld).toBeInstanceOf(BungalowLockedError);
    const error = scenario.whileHeld as BungalowLockedError;
    expect(error.holderProcessIdentifier).toBe(scenario.childProcessIdentifier);
    expect(error.message).toContain(String(scenario.childProcessIdentifier));
    expect(scenario.lockFileWhileHeld).toBe(`${scenario.childProcessIdentifier}\n`);
  });

  test('is reclaimed once the holder is dead, keeping the persisted identity', () => {
    if ('error' in scenario.afterKill) throw scenario.afterKill.error;
    expect(scenario.afterKill.lockFile).toBe(`${process.pid}\n`);
    expect(scenario.afterKill.deploymentId).toBe(scenario.childDeploymentId);
    expect(existsSync(join(scenarioRoot, 'lock'))).toBe(false);
  });
});

describe('a lock held by this process', () => {
  test('makes a second open of the same root throw BungalowLockedError naming this process', () => {
    const root = temporaryDirectory();
    using held = openIn(root);
    const error = (() => {
      try {
        openIn(root);
      } catch (thrown) {
        return thrown;
      }
      return undefined;
    })();
    expect(error).toBeInstanceOf(BungalowLockedError);
    expect((error as BungalowLockedError).holderProcessIdentifier).toBe(process.pid);
    // The failed attempt neither released the holder's lock nor left files behind.
    expect(readFileSync(join(root, 'lock'), 'utf8')).toBe(`${process.pid}\n`);
    expect(held.root).toBe(root);
    expect(new Set(requireEntries(root))).toEqual(
      new Set(['deployment-id', 'lock', 'logs', 'secrets']),
    );
  });

  test('is released by close, so the root opens again', () => {
    const root = temporaryDirectory();
    openIn(root).close();
    openIn(root).close();
  });
});

describe('stale locks', () => {
  test('a lock naming a dead process is reclaimed', () => {
    const root = temporaryDirectory();
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'lock'), `${ABSENT_PROCESS}\n`);
    using handle = openIn(root);
    expect(handle.root).toBe(root);
    expect(readFileSync(join(root, 'lock'), 'utf8')).toBe(`${process.pid}\n`);
    expect(new Set(requireEntries(root))).toEqual(
      new Set(['deployment-id', 'lock', 'logs', 'secrets']),
    );
  });

  test.each(['', 'garbage', '-5\n', '0\n', '12abc\n', '99999999999999999999\n'])(
    'a lock that does not hold a process identifier (%p) is reclaimed',
    (text) => {
      const root = temporaryDirectory();
      writeFileSync(join(root, 'lock'), text);
      using handle = openIn(root);
      expect(handle.root).toBe(root);
    },
  );

  test('a lock naming a live process is respected', () => {
    const root = temporaryDirectory();
    writeFileSync(join(root, 'lock'), `${process.ppid}\n`);
    expect(() => openIn(root)).toThrow(BungalowLockedError);
    expect(readFileSync(join(root, 'lock'), 'utf8')).toBe(`${process.ppid}\n`);
  });
});

function requireEntries(root: string): string[] {
  const entries = new Bun.Glob('*').scanSync({ cwd: root, onlyFiles: false, dot: true });
  return [...entries];
}
