import { describe, expect, test } from 'bun:test';

import type { OutputChannel } from '../protocol/messages.ts';
import type { SessionClosedSummary } from '../session/session-types.ts';
import {
  bytesOnChannel,
  channelOf,
  hostFor,
  isAlive,
  registerSessionCleanup,
  runHosted,
  textOf,
  waitUntilGone,
} from './bun-process.test-support.ts';
import { PIPE_STDIN_FIXTURES, shellProfile } from './fixtures/bun-pipe-stdin.ts';
import {
  ENDLESS_OUTPUT,
  ESCAPED_DESCENDANT,
  OUTPUT_CASES,
  outputProfile,
  pidsIn,
  type OutputMode,
} from './fixtures/terminal-output.ts';
import { ProcessStartFailure } from './process-start-failure.ts';

registerSessionCleanup();

const MODES: OutputMode[] = ['pipe', 'pty'];

describe.each(MODES)('a %s process that cannot start', (mode) => {
  test.each([
    ['an executable that does not exist', { executable: '/nonexistent/ventriloquist' }],
    ['a working directory that does not exist', { workingDirectory: '/nonexistent/ventriloquist' }],
    ['a file that is not executable', { executable: '/etc/hosts' }],
    ['a directory', { executable: '/tmp' }],
    ['a name that is not on the path', { executable: 'ventriloquist-no-such-command' }],
  ])(
    'reports spawn-failed for %s, apart from any exit or transport failure',
    async (_label, change) => {
      const hosted = hostFor(mode, { ...shellProfile('true'), ...change });
      const run = runHosted(hosted);
      await run.started;
      await run.exitReported;
      expect(hosted.startFailure).toBeInstanceOf(ProcessStartFailure);
      expect(hosted.startFailure?.code).toBe('spawn-failed');
      expect(run.session.snapshot.process).toEqual({ kind: 'failed', reason: 'start-rejected' });
      const summary = await run.session.closed;
      expect(summary).toMatchObject({
        cause: 'start-failed',
        cleanup: 'complete',
        quarantined: false,
      });
      expect(run.recorder.ofType('processExit')).toEqual([]);
      expect(run.recorder.ofType('output')).toEqual([]);
    },
  );
});

describe.each(MODES)('a %s process on a host outside the supported matrix', (mode) => {
  test('fails the session with unsupported-runtime, which a connected client is told by name', async () => {
    const hosted = hostFor(mode, shellProfile('true'), {
      host: { platform: 'win32', architecture: 'x64' },
    });
    const run = runHosted(hosted);
    await run.started;
    await run.exitReported;
    expect(hosted.startFailure?.code).toBe('unsupported-runtime');
    expect(run.session.startFailureCode).toBe('unsupported-runtime');
    expect(await run.session.closed).toMatchObject({ cause: 'start-failed', cleanup: 'complete' });
  });
});

describe.each(MODES)('a %s process that ends on its own', (mode) => {
  test('before its first output is a normal exit with nothing to drain', async () => {
    const run = runHosted(
      hostFor(mode, outputProfile(mode, OUTPUT_CASES.exitBeforeFirstOutput.body)),
    );
    const summary = await run.session.closed;
    await run.exitReported;
    expect(run.recorder.ofType('output')).toEqual([]);
    expect(run.recorder.ofType('processExit')).toEqual([
      { type: 'processExit', exitCode: 0, signal: null },
    ]);
    expect(summary).toMatchObject({
      cause: 'process-exit',
      cleanup: 'complete',
      quarantined: false,
    });
    expect(summary.drain).toEqual({ state: 'drained', unavailableBytes: 0 });
  });

  test('reports end of file and exit as separate events, with the final output captured first', async () => {
    const run = runHosted(hostFor(mode, outputProfile(mode, "printf 'last words'; exit 0")));
    const summary = await run.session.closed;
    expect(textOf(bytesOnChannel(run.recorder, channelOf(mode)))).toBe('last words');
    expect(run.recorder.ofType('processExit')).toEqual([
      { type: 'processExit', exitCode: 0, signal: null },
    ]);
    const channels: OutputChannel[] = mode === 'pipe' ? ['stderr', 'stdout'] : ['pty'];
    expect(
      run.recorder
        .ofType('sourceComplete')
        .map((event) => event.channel)
        .toSorted(),
    ).toEqual(channels);
    expect(summary).toMatchObject({ cause: 'process-exit', cleanup: 'complete' });
    expect(summary.drain).toEqual({ state: 'drained', unavailableBytes: 0 });
  });

  test('leaves no member of its group behind, even one that outlived its leader', async () => {
    const body = 'sleep 7919 >/dev/null 2>&1 & printf \'descendant=%s \' "$!"; exit 0';
    const run = runHosted(hostFor(mode, outputProfile(mode, body)));
    const summary = await run.session.closed;
    const { descendant } = pidsIn(textOf(bytesOnChannel(run.recorder, channelOf(mode))));
    expect(summary).toMatchObject({
      cause: 'process-exit',
      cleanup: 'complete',
      quarantined: false,
    });
    expect(isAlive(descendant as number)).toBe(false);
  });
});

describe.each(MODES)('a running %s process', (mode) => {
  const running = (hostOptions = {}) => {
    const run = runHosted(
      hostFor(mode, outputProfile(mode, 'printf \'leader=%s \' "$$"; sleep 7919'), hostOptions),
    );
    return run;
  };

  test.each([
    [
      'the client stops it',
      'attachment-stop',
      (run: ReturnType<typeof running>) => run.attachment.stop(),
    ],
    [
      'the client disconnects',
      'disconnect',
      (run: ReturnType<typeof running>) => run.attachment.detach(),
    ],
    ['the host stops it', 'host-stop', (run: ReturnType<typeof running>) => run.session.stop()],
    [
      'the host disposes of it',
      'host-dispose',
      (run: ReturnType<typeof running>) => run.session.dispose(),
    ],
    [
      'the host withdraws authorization',
      'authorization-revoked',
      (run: ReturnType<typeof running>) => run.session.revokeAuthorization(),
    ],
  ])('is ended when %s, with nothing left running', async (_label, cause, end) => {
    const run = running();
    await run.waitForOutput(channelOf(mode), /leader=\d+ /);
    const { leader } = pidsIn(textOf(bytesOnChannel(run.recorder, channelOf(mode))));
    expect(isAlive(leader as number)).toBe(true);
    end(run);
    const summary = await run.session.closed;
    expect(summary).toMatchObject({ cause, cleanup: 'complete', quarantined: false });
    expect(isAlive(leader as number)).toBe(false);
    // The kill may be reported as the exit while cleanup finishes; either way no code was invented.
    for (const exit of run.recorder.ofType('processExit')) expect(exit.exitCode).toBeNull();
  });

  test('that fills the output the consumer never parses fails the session visibly and is still ended', async () => {
    const run = runHosted(hostFor(mode, outputProfile(mode, ENDLESS_OUTPUT)), {
      parseOutput: false,
      budgets: { outputQueueBytes: 64 * 1024 },
    });
    const summary: SessionClosedSummary = await run.session.closed;
    expect(summary).toMatchObject({ cause: 'output-overflow', quarantined: true });
    expect(summary.drain.state).toBe('truncated');
    const { leader } = pidsIn(textOf(bytesOnChannel(run.recorder, channelOf(mode))));
    expect(isAlive(leader as number)).toBe(false);
  });

  test('that leaves its group is reported unknown, and the escaped descendant is not claimed', async () => {
    const run = runHosted(hostFor(mode, outputProfile(mode, ESCAPED_DESCENDANT)));
    await run.waitForOutput(channelOf(mode), /escaped=\d+ /);
    const { leader, escaped } = pidsIn(textOf(bytesOnChannel(run.recorder, channelOf(mode))));
    try {
      const summary = await run.session.dispose();
      // The owned group is gone, but a process that started a session of its own is beyond it.
      expect(summary).toMatchObject({ cleanup: 'unknown', quarantined: true });
      expect(isAlive(leader as number)).toBe(false);
      expect(isAlive(escaped as number)).toBe(true);
    } finally {
      process.kill(escaped as number, 'SIGKILL');
      await waitUntilGone(escaped as number);
    }
  });
});

describe('a pipe whose descendant writes after the process has exited', () => {
  test('keeps that output: the session waits for end of file, not for the exit', async () => {
    const run = runHosted(
      hostFor('pipe', shellProfile("(sleep 0.3; printf late) & printf 'early '; exit 0")),
    );
    const summary = await run.session.closed;
    expect(textOf(bytesOnChannel(run.recorder, 'stdout'))).toBe('early late');
    expect(summary).toMatchObject({ cause: 'process-exit', cleanup: 'complete' });
    expect(summary.drain).toEqual({ state: 'drained', unavailableBytes: 0 });
  });
});

describe('a pipe whose reader has gone', () => {
  test('is a backend failure: the broken pipe is reported, nothing is retried, and the process is ended', async () => {
    const fixture = PIPE_STDIN_FIXTURES.closesInput;
    const run = runHosted(hostFor('pipe', fixture.profile, { acceptsInput: true }));
    await run.waitForOutput('stdout', fixture.ready);
    const receipt = run.attachment.write(new TextEncoder().encode('lost'));
    expect(receipt.disposition).toBe('accepted');
    const summary = await run.session.closed;
    expect(run.recorder.ofType('operationResult')).toEqual([
      {
        type: 'operationResult',
        sequence: 1,
        kind: 'input',
        disposition: 'failed',
        reason: 'backend-failed',
      },
    ]);
    expect(summary).toMatchObject({
      cause: 'backend-failed',
      cleanup: 'complete',
      quarantined: false,
    });
  });
});

describe('a pipe without an input channel', () => {
  test('gives the process an empty input and advertises none', async () => {
    const run = runHosted(hostFor('pipe', shellProfile('cat; printf "|eof"')));
    expect(run.attachment.authority.capabilities).toMatchObject({ mode: 'pipe', input: false });
    expect(run.attachment.write(new TextEncoder().encode('x')).disposition).toBe('failed');
    await run.session.closed;
    expect(textOf(bytesOnChannel(run.recorder, 'stdout'))).toBe('|eof');
  });
});
