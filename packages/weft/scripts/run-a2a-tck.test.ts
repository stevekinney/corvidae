import { afterEach, describe, expect, test } from 'bun:test';

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { throwingRejectionOf } from '../src/testing/promise-outcome.test-support.ts';
import {
  A2A_TCK_COMMIT,
  A2A_TCK_EXCLUSIONS,
  type CommandRunner,
  listeningUrl,
  parseArguments,
  runA2ATck,
  summarizeJUnit,
  tckCommand,
} from './run-a2a-tck.ts';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

/** A stand-in system under test that serves an Agent Card and counts requests for it. */
function stubSystemUnderTest(): { url: string; cardRequests: () => number } {
  let cardRequests = 0;
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      if (new URL(request.url).pathname === '/.well-known/agent-card.json') {
        cardRequests += 1;
        return Response.json({ name: 'Stub' });
      }
      return new Response('Not Found', { status: 404 });
    },
  });
  cleanups.push(() => server.stop(true));
  return { url: `http://127.0.0.1:${server.port}`, cardRequests: () => cardRequests };
}

async function temporaryCheckout(): Promise<string> {
  const checkout = await mkdtemp(join(tmpdir(), 'weft-a2a-tck-'));
  cleanups.push(() => rm(checkout, { recursive: true, force: true }));
  return checkout;
}

function junit(counts: { tests: number; failures?: number; errors?: number; skipped?: number }) {
  const cases: string[] = [];
  for (let index = 0; index < counts.tests; index += 1) {
    const outcome =
      index < (counts.failures ?? 0)
        ? '<failure message="x"/>'
        : index < (counts.failures ?? 0) + (counts.errors ?? 0)
          ? '<error message="x"/>'
          : index < (counts.failures ?? 0) + (counts.errors ?? 0) + (counts.skipped ?? 0)
            ? '<skipped type="pytest.xfail" message="x"/>'
            : '';
    cases.push(`<testcase classname="c" name="t${index}">${outcome}</testcase>`);
  }
  return `<?xml version="1.0"?><testsuites><testsuite name="pytest">${cases.join('')}</testsuite></testsuites>`;
}

/**
 * A command runner that records each command, writes the report `reports` names, and
 * exits with `exitCodes`' code for the level (by default 0 with a report, 4 without).
 */
function fakeTck(
  reports: (level: string) => string | undefined,
  exitCodes: (level: string) => number | undefined = () => undefined,
) {
  const commands: string[][] = [];
  const runCommand: CommandRunner = async (command, cwd) => {
    commands.push([...command]);
    const level = command[command.indexOf('--level') + 1] as string;
    const report = reports(level);
    if (report !== undefined) await writeFile(join(cwd, 'reports', 'junitreport.xml'), report);
    return exitCodes(level) ?? (report === undefined ? 4 : 0);
  };
  return { commands, runCommand };
}

describe('run-a2a-tck', () => {
  test('passes --sut-host through to every level and starts no example', async () => {
    const stub = stubSystemUnderTest();
    const checkout = await temporaryCheckout();
    const tck = fakeTck(() => junit({ tests: 3, skipped: 1 }));
    let started = 0;
    const lines: string[] = [];

    const exitCode = await runA2ATck(['--sut-host', stub.url], {
      runCommand: tck.runCommand,
      ensureCheckout: async () => undefined,
      startExample: async () => {
        started += 1;
        throw new Error('the example must not start');
      },
      checkout,
      log: (line) => lines.push(line),
    });

    expect(exitCode).toBe(0);
    expect(started).toBe(0);
    expect(stub.cardRequests()).toBe(1);
    expect(tck.commands).toEqual([
      tckCommand(stub.url, 'must'),
      tckCommand(stub.url, 'should'),
      tckCommand(stub.url, 'may'),
    ]);
    expect(tck.commands[0]).toEqual([
      'uv',
      'run',
      './run_tck.py',
      '--sut-host',
      stub.url,
      '--transport',
      'jsonrpc',
      '--level',
      'must',
      '--',
      '--deselect',
      'tests/compatibility/core_operations/test_requirements.py::test_must_requirement[CORE-SEND-003-jsonrpc]',
    ]);
    expect(lines[0]).toContain(A2A_TCK_COMMIT);
    expect(await readFile(join(checkout, 'reports', 'junit-may.xml'), 'utf8')).toContain(
      '<testsuite',
    );
  });

  test('starts the example without --sut-host, tests it, and stops it', async () => {
    const stub = stubSystemUnderTest();
    const checkout = await temporaryCheckout();
    const tck = fakeTck(() => junit({ tests: 1 }));
    let stopped = false;

    const exitCode = await runA2ATck([], {
      runCommand: tck.runCommand,
      ensureCheckout: async () => undefined,
      startExample: async () => ({
        url: stub.url,
        stop: async () => {
          stopped = true;
        },
      }),
      checkout,
      log: () => undefined,
    });

    expect(exitCode).toBe(0);
    expect(stopped).toBe(true);
    expect(tck.commands.map((command) => command[4])).toEqual([stub.url, stub.url, stub.url]);
  });

  test('fails when any level reports a failure or an error, or writes no report', async () => {
    const stub = stubSystemUnderTest();
    for (const reports of [
      (level: string) => junit({ tests: 2, failures: level === 'should' ? 1 : 0 }),
      (level: string) => junit({ tests: 2, errors: level === 'may' ? 1 : 0 }),
      (level: string) => (level === 'must' ? undefined : junit({ tests: 1 })),
    ]) {
      const checkout = await temporaryCheckout();
      const tck = fakeTck(reports);

      const exitCode = await runA2ATck(['--sut-host', stub.url], {
        runCommand: tck.runCommand,
        ensureCheckout: async () => undefined,
        startExample: async () => {
          throw new Error('unused');
        },
        checkout,
        log: () => undefined,
      });

      expect(exitCode).toBe(1);
      expect(tck.commands).toHaveLength(3);
    }
  });

  test('fails when a level exits nonzero, even with a clean report', async () => {
    const stub = stubSystemUnderTest();
    const checkout = await temporaryCheckout();
    // pytest's NO_TESTS_COLLECTED (5) can still leave a report with no failure or error.
    const tck = fakeTck(
      () => junit({ tests: 1 }),
      (level) => (level === 'should' ? 5 : 0),
    );
    const lines: string[] = [];

    const exitCode = await runA2ATck(['--sut-host', stub.url], {
      runCommand: tck.runCommand,
      ensureCheckout: async () => undefined,
      startExample: async () => {
        throw new Error('unused');
      },
      checkout,
      log: (line) => lines.push(line),
    });

    expect(exitCode).toBe(1);
    expect(tck.commands).toHaveLength(3);
    expect(lines).toContain('  should: run_tck.py exited 5');
  });

  test('refuses a system under test that serves no Agent Card', async () => {
    const stub = stubSystemUnderTest();
    const checkout = await temporaryCheckout();
    const tck = fakeTck(() => junit({ tests: 1 }));

    expect(
      await throwingRejectionOf(
        runA2ATck([`--sut-host=${stub.url}/missing/`], {
          runCommand: tck.runCommand,
          ensureCheckout: async () => undefined,
          startExample: async () => {
            throw new Error('unused');
          },
          checkout,
          log: () => undefined,
        }),
      ),
    ).toThrow('served no Agent Card (404)');
    expect(tck.commands).toEqual([]);
  });
});

describe('run-a2a-tck helpers', () => {
  test('parses --sut-host in both spellings and rejects anything else', () => {
    expect(parseArguments([])).toEqual({});
    expect(parseArguments(['--sut-host', 'http://h'])).toEqual({ sutHost: 'http://h' });
    expect(parseArguments(['--sut-host=http://h'])).toEqual({ sutHost: 'http://h' });
    expect(() => parseArguments(['--sut-host'])).toThrow('--sut-host needs a URL.');
    expect(() => parseArguments(['--verbose'])).toThrow('Unknown argument: --verbose');
  });

  test('collects each --deselect and passes it after the recorded exclusions', () => {
    expect(
      parseArguments(['--sut-host', 'http://h', '--deselect', 'a::b', '--deselect', 'c::d']),
    ).toEqual({
      sutHost: 'http://h',
      deselect: ['a::b', 'c::d'],
    });
    expect(() => parseArguments(['--deselect'])).toThrow('--deselect needs a test.');
    const command = tckCommand('http://h', 'must', ['a::b']);
    expect(command.slice(-2)).toEqual(['--deselect', 'a::b']);
    expect(command.filter((argument) => argument === '--deselect')).toHaveLength(
      A2A_TCK_EXCLUSIONS.length + 1,
    );
  });

  test('counts a JUnit report’s cases and outcomes, xfails among the skipped', () => {
    expect(summarizeJUnit(junit({ tests: 5, failures: 1, errors: 1, skipped: 2 }))).toEqual({
      tests: 5,
      failures: 1,
      errors: 1,
      skipped: 2,
    });
  });

  test('reads the URL the example prints once it listens', () => {
    expect(listeningUrl('noise\nA2A agent listening at http://127.0.0.1:5000\n')).toBe(
      'http://127.0.0.1:5000',
    );
    expect(listeningUrl('starting')).toBeUndefined();
  });
});
