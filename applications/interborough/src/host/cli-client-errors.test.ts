import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';

import {
  CLI_LOCAL_ERROR_CODES,
  CLI_SCHEMA_VERSION,
  executeCli,
  type CliClientDependencies,
  type CliExitCode,
} from './cli-client.ts';

const goldenDirectory = join(import.meta.dir, '__fixtures__', 'cli-error-golden');

async function golden(name: string): Promise<unknown> {
  return Bun.file(join(goldenDirectory, name)).json();
}

type FetchHandler = (request: Request) => Response | Promise<Response>;

async function dependencies(
  handler: FetchHandler,
  extra: Partial<CliClientDependencies> = {},
): Promise<CliClientDependencies> {
  const directory = await mkdtemp(join(tmpdir(), 'interborough-cli-errors-'));
  return {
    preferencesPath: join(directory, 'preferences.json'),
    fetch: async (input, init) => handler(new Request(input, init)),
    ...extra,
  };
}

/** Answers discovery, then fails the JSON-RPC call with `error`. */
function failingCall(error: Record<string, unknown>): FetchHandler {
  return (request) =>
    new URL(request.url).pathname === '/openrpc.json'
      ? Response.json({ methods: [{ name: 'weft.alerts.list' }] })
      : Response.json({ jsonrpc: '2.0', id: '1', error });
}

const callArguments = ['api', 'call', 'weft.alerts.list', '--yes', '--url', 'http://localhost'];

const conflictFault = {
  code: -32010,
  message: 'The workflow changed under you.',
  data: {
    weftCode: 'Conflict',
    httpStatus: 409,
    retryable: false,
    remediation: 'Re-read the workflow, then send the new revision.',
  },
};

function errorOf(stdout: string): Record<string, unknown> {
  return (JSON.parse(stdout) as { error: Record<string, unknown> }).error;
}

describe('Interborough command client failures', () => {
  // spawn-free: injected fetch stands in for the server.
  test('a server fault reports its FaultCode, retryable and remediation as JSON and JSONL', async () => {
    const injected = await dependencies(failingCall(conflictFault));
    const json = await executeCli([...callArguments, '--output', 'json'], injected);
    expect(json.exitCode).toBe(4);
    expect(JSON.parse(json.stdout)).toEqual(await golden('server-fault.json'));
    // `api call` takes no JSONL, so a stream command carries the same fault as one line.
    const jsonl = await executeCli(
      ['runs', 'list', '--url', 'http://localhost', '--output', 'jsonl'],
      injected,
    );
    expect(jsonl.exitCode).toBe(4);
    expect(jsonl.stdout.includes('\n')).toBe(false);
    expect(JSON.parse(jsonl.stdout)).toEqual(await golden('server-fault.json'));
  });

  // spawn-free: injected fetch stands in for the server.
  test('a server fault keeps the server retryable and omits an absent remediation', async () => {
    const injected = await dependencies(
      failingCall({
        code: -32015,
        message: 'Try again shortly.',
        data: { weftCode: 'Unavailable', httpStatus: 503, retryable: true },
      }),
    );
    const result = await executeCli([...callArguments, '--output', 'json'], injected);
    // `api call` is a mutation, so a fault with no exit status of its own leaves its outcome unknown.
    expect(result.exitCode).toBe(7);
    expect(errorOf(result.stdout)).toEqual({
      code: 'Unavailable',
      exitCode: 7,
      message: 'Try again shortly.',
      retryable: true,
    });
  });

  // spawn-free: injected fetch stands in for the server.
  test('text output prints the message, then a Try line only when a remediation came', async () => {
    const withAdvice = await executeCli(
      callArguments,
      await dependencies(failingCall(conflictFault)),
    );
    expect(withAdvice.stdout).toBe('');
    expect(withAdvice.stderr).toBe(
      'The workflow changed under you.\nTry: Re-read the workflow, then send the new revision.',
    );
    const withoutAdvice = await executeCli(
      callArguments,
      await dependencies(
        failingCall({
          code: -32010,
          message: 'Denied',
          data: { weftCode: 'Forbidden', httpStatus: 403, retryable: false },
        }),
      ),
    );
    expect(withoutAdvice.exitCode).toBe(3);
    expect(withoutAdvice.stderr).toBe('Denied');
  });

  // spawn-free: injected fetch stands in for the server.
  test('an error the CLI raises itself reports a named CLI_ code', async () => {
    const result = await executeCli(
      ['status', '--url', 'https://example.com', '--output', 'json'],
      await dependencies(() => Response.json({})),
    );
    expect(result.exitCode).toBe(3);
    expect(JSON.parse(result.stdout)).toEqual(await golden('local-error.json'));
  });

  // spawn-free: injected fetch stands in for the server.
  test('every local code is a named CLI_ code and each is reachable', async () => {
    expect(Object.values(CLI_LOCAL_ERROR_CODES).toSorted()).toEqual([
      'CLI_AUTHORIZATION',
      'CLI_CONFLICT',
      'CLI_CONNECTION_FAILED',
      'CLI_FAILED',
      'CLI_INPUT_REQUIRED',
      'CLI_INTERRUPTED',
      'CLI_OUTCOME_UNKNOWN',
      'CLI_USAGE',
    ]);
    const abort = () => {
      throw new DOMException('aborted', 'AbortError');
    };
    const conflict = (request: Request) =>
      new URL(request.url).pathname === '/openrpc.json'
        ? Response.json({ methods: [{ name: 'weft.alerts.list' }] })
        : Response.json({
            error: { code: -32001, message: 'Conflict', data: { httpStatus: 409 } },
          });
    const aborted = new AbortController();
    aborted.abort();
    const cases: Array<{
      readonly name: string;
      readonly arguments: string[];
      readonly handler: FetchHandler;
      readonly extra?: Partial<CliClientDependencies>;
      readonly exitCode: CliExitCode;
      readonly code: string;
      readonly retryable: boolean;
    }> = [
      {
        name: 'bad arguments',
        arguments: ['status', '--wat', '--output', 'json'],
        handler: () => Response.json({}),
        exitCode: 2,
        code: CLI_LOCAL_ERROR_CODES.usage,
        retryable: false,
      },
      {
        name: 'a refused endpoint',
        arguments: ['status', '--url', 'https://example.com', '--output', 'json'],
        handler: () => Response.json({}),
        exitCode: 3,
        code: CLI_LOCAL_ERROR_CODES.authorization,
        retryable: false,
      },
      {
        name: 'no connection',
        arguments: ['status', '--url', 'http://127.0.0.1:9', '--output', 'json'],
        handler: () => {
          throw new TypeError('fetch failed');
        },
        exitCode: 1,
        code: CLI_LOCAL_ERROR_CODES.connectionFailed,
        retryable: true,
      },
      {
        name: 'a timed-out request',
        arguments: ['status', '--url', 'http://127.0.0.1:9', '--output', 'json'],
        handler: abort,
        exitCode: 6,
        code: CLI_LOCAL_ERROR_CODES.connectionFailed,
        retryable: true,
      },
      {
        name: 'a server answer with no fault code',
        arguments: ['status', '--url', 'http://127.0.0.1:9', '--output', 'json'],
        handler: () => new Response('boom', { status: 500 }),
        exitCode: 1,
        code: CLI_LOCAL_ERROR_CODES.failed,
        retryable: false,
      },
      {
        name: 'a conflict with no fault code',
        arguments: [...callArguments, '--output', 'json'],
        handler: conflict,
        exitCode: 4,
        code: CLI_LOCAL_ERROR_CODES.conflict,
        retryable: false,
      },
      {
        name: 'a refused prompt',
        arguments: ['restart', '--no-input', '--output', 'json'],
        handler: () => Response.json({}),
        exitCode: 5,
        code: CLI_LOCAL_ERROR_CODES.inputRequired,
        retryable: false,
      },
      {
        name: 'an interrupted mutation outcome',
        arguments: [...callArguments, '--output', 'json'],
        handler: (request) => {
          if (new URL(request.url).pathname === '/openrpc.json')
            return Response.json({ methods: [{ name: 'weft.alerts.list' }] });
          return abort();
        },
        exitCode: 7,
        code: CLI_LOCAL_ERROR_CODES.outcomeUnknown,
        retryable: false,
      },
      {
        name: 'an interrupt',
        arguments: ['status', '--url', 'http://127.0.0.1:9', '--output', 'json'],
        handler: abort,
        extra: { signal: aborted.signal },
        exitCode: 130,
        code: CLI_LOCAL_ERROR_CODES.interrupted,
        retryable: false,
      },
    ];
    const seen = new Set<string>();
    for (const scenario of cases) {
      const result = await executeCli(
        scenario.arguments,
        await dependencies(scenario.handler, scenario.extra),
      );
      expect({ name: scenario.name, exitCode: result.exitCode }).toEqual({
        name: scenario.name,
        exitCode: scenario.exitCode,
      });
      const error = errorOf(result.stdout);
      expect({ name: scenario.name, code: error['code'], retryable: error['retryable'] }).toEqual({
        name: scenario.name,
        code: scenario.code,
        retryable: scenario.retryable,
      });
      expect(error['exitCode']).toBe(scenario.exitCode);
      expect(error['code']).toMatch(/^CLI_[A-Z_]+$/);
      seen.add(String(error['code']));
    }
    expect([...seen].toSorted()).toEqual(Object.values(CLI_LOCAL_ERROR_CODES).toSorted());
  });

  // spawn-free: the real fetch meets a loopback port nothing listens on.
  test('a refused connection from the real fetch reports CLI_CONNECTION_FAILED', async () => {
    const listener = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') });
    const { port } = listener;
    await listener.stop(true);
    const directory = await mkdtemp(join(tmpdir(), 'interborough-cli-errors-'));
    const result = await executeCli(
      ['status', '--url', `http://127.0.0.1:${port}`, '--output', 'json'],
      {
        preferencesPath: join(directory, 'preferences.json'),
      },
    );
    expect(result.exitCode).toBe(1);
    expect(errorOf(result.stdout)).toMatchObject({
      code: CLI_LOCAL_ERROR_CODES.connectionFailed,
      exitCode: 1,
      retryable: true,
    });
  });

  // spawn-free: no command runs.
  test('the envelope version is the one the golden files pin', async () => {
    expect(CLI_SCHEMA_VERSION).toBe(2);
    expect((await golden('server-fault.json')) as { schemaVersion: number }).toMatchObject({
      schemaVersion: CLI_SCHEMA_VERSION,
    });
    expect((await golden('local-error.json')) as { schemaVersion: number }).toMatchObject({
      schemaVersion: CLI_SCHEMA_VERSION,
    });
  });
});
