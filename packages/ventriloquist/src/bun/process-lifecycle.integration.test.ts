import { describe, expect } from 'bun:test';

import type { OutputChannel } from '../protocol/messages.ts';
import type { SessionClosedSummary } from '../session/session-types.ts';
import {
  bytesOnChannel,
  channelOf,
  hostFor,
  isAlive,
  runHosted,
  scenario,
  scenarioResult,
  settleScenarios,
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

const MODES: OutputMode[] = ['pipe', 'pty'];

type Running = ReturnType<typeof runHosted>;

const SPAWN_REFUSALS = [
  ['an executable that does not exist', { executable: '/nonexistent/ventriloquist' }],
  ['a working directory that does not exist', { workingDirectory: '/nonexistent/ventriloquist' }],
  ['a file that is not executable', { executable: '/etc/hosts' }],
  ['a directory', { executable: '/tmp' }],
  ['a name that is not on the path', { executable: 'ventriloquist-no-such-command' }],
] as const;

for (const mode of MODES) {
  const refusals = SPAWN_REFUSALS.map(([label, change]) =>
    scenario(
      `reports spawn-failed for ${label}, apart from any exit or transport failure`,
      async () => {
        const hosted = hostFor(mode, { ...shellProfile('true'), ...change });
        const run = runHosted(hosted);
        await run.started;
        await run.exitReported;
        expect(hosted.startFailure).toBeInstanceOf(ProcessStartFailure);
        expect(hosted.startFailure?.code).toBe('spawn-failed');
        expect(run.session.snapshot.process).toEqual({
          kind: 'failed',
          reason: 'start-rejected',
        });
        const summary = await run.session.closed;
        expect(summary).toMatchObject({
          cause: 'start-failed',
          cleanup: 'complete',
          quarantined: false,
        });
        expect(run.recorder.ofType('processExit')).toEqual([]);
        expect(run.recorder.ofType('output')).toEqual([]);
      },
    ),
  );

  describe(`a ${mode} process that cannot start`, () => {
    for (const started of refusals) scenarioResult(started.name, started);
  });
}

for (const mode of MODES) {
  const scenario2 = scenario(
    'fails the session with unsupported-runtime, which a connected client is told by name',
    async () => {
      const hosted = hostFor(mode, shellProfile('true'), {
        host: { platform: 'win32', architecture: 'x64' },
      });
      const run = runHosted(hosted);
      await run.started;
      await run.exitReported;
      expect(hosted.startFailure?.code).toBe('unsupported-runtime');
      expect(run.session.startFailureCode).toBe('unsupported-runtime');
      expect(await run.session.closed).toMatchObject({
        cause: 'start-failed',
        cleanup: 'complete',
      });
    },
  );

  describe(`a ${mode} process on a host outside the supported matrix`, () => {
    scenarioResult(
      'fails the session with unsupported-runtime, which a connected client is told by name',
      scenario2,
    );
  });
}

for (const mode of MODES) {
  const scenario3 = scenario(
    'before its first output is a normal exit with nothing to drain',
    async () => {
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
    },
  );

  const scenario4 = scenario(
    'reports end of file and exit as separate events, with the final output captured first',
    async () => {
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
    },
  );

  const scenario5 = scenario(
    'leaves no member of its group behind, even one that outlived its leader',
    async () => {
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
    },
  );

  describe(`a ${mode} process that ends on its own`, () => {
    scenarioResult('before its first output is a normal exit with nothing to drain', scenario3);

    scenarioResult(
      'reports end of file and exit as separate events, with the final output captured first',
      scenario4,
    );

    scenarioResult(
      'leaves no member of its group behind, even one that outlived its leader',
      scenario5,
    );
  });
}

for (const mode of MODES) {
  const running = () =>
    runHosted(hostFor(mode, outputProfile(mode, 'printf \'leader=%s \' "$$"; sleep 7919')));

  const endings = (
    [
      ['the client stops it', 'attachment-stop', (run: Running) => run.attachment.stop()],
      ['the client disconnects', 'disconnect', (run: Running) => run.attachment.detach()],
      ['the host stops it', 'host-stop', (run: Running) => run.session.stop()],
      ['the host disposes of it', 'host-dispose', (run: Running) => run.session.dispose()],
      [
        'the host withdraws authorization',
        'authorization-revoked',
        (run: Running) => run.session.revokeAuthorization(),
      ],
    ] as const
  ).map(([label, cause, end]) =>
    scenario(`is ended when ${label}, with nothing left running`, async () => {
      const run = running();
      await run.waitForOutput(channelOf(mode), /leader=\d+ /);
      const { leader } = pidsIn(textOf(bytesOnChannel(run.recorder, channelOf(mode))));
      expect(isAlive(leader as number)).toBe(true);
      end(run);
      const summary = await run.session.closed;
      expect(summary).toMatchObject({ cause, cleanup: 'complete', quarantined: false });
      expect(isAlive(leader as number)).toBe(false);
      // The kill may be reported as the exit while cleanup finishes; either way no code was invented.
      for (const exit of run.recorder.ofType('processExit')) {
        expect(exit.exitCode).toBeNull();
      }
    }),
  );
  const scenario7 = scenario(
    'that fills the output the consumer never parses is paused, not failed, and is still ended on request',
    async () => {
      const run = runHosted(hostFor(mode, outputProfile(mode, ENDLESS_OUTPUT)), {
        parseOutput: false,
        budgets: { outputQueueBytes: 64 * 1024 },
      });
      await run.waitForOutput(channelOf(mode), /leader=\d+ /);
      const { leader } = pidsIn(textOf(bytesOnChannel(run.recorder, channelOf(mode))));
      // The budget fills and the session stops reading, so the producer blocks in the kernel.
      let delivered = bytesOnChannel(run.recorder, channelOf(mode)).length;
      for (let settled = 0; settled < 3;) {
        await Bun.sleep(100);
        const now = bytesOnChannel(run.recorder, channelOf(mode)).length;
        settled = now === delivered ? settled + 1 : 0;
        delivered = now;
      }
      expect(delivered).toBeLessThanOrEqual(64 * 1024);
      expect(delivered).toBeGreaterThan(32 * 1024);
      expect(run.recorder.ofType('attachmentRevoked')).toEqual([]);
      expect(isAlive(leader as number)).toBe(true);
      const summary: SessionClosedSummary = await run.session.dispose();
      expect(summary).toMatchObject({
        cause: 'host-dispose',
        cleanup: 'complete',
        quarantined: false,
      });
      expect(isAlive(leader as number)).toBe(false);
    },
  );

  const scenario8 = scenario(
    'that leaves its group is reported unknown, and the escaped descendant is not claimed',
    async () => {
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
    },
  );

  describe(`a running ${mode} process`, () => {
    for (const started of endings) scenarioResult(started.name, started);

    scenarioResult(
      'that fills the output the consumer never parses is paused, not failed, and is still ended on request',
      scenario7,
    );

    scenarioResult(
      'that leaves its group is reported unknown, and the escaped descendant is not claimed',
      scenario8,
    );
  });
}

const scenario9 = scenario(
  'keeps that output: the session waits for end of file, not for the exit',
  async () => {
    const run = runHosted(
      hostFor('pipe', shellProfile("(sleep 0.3; printf late) & printf 'early '; exit 0")),
    );
    const summary = await run.session.closed;
    expect(textOf(bytesOnChannel(run.recorder, 'stdout'))).toBe('early late');
    expect(summary).toMatchObject({ cause: 'process-exit', cleanup: 'complete' });
    expect(summary.drain).toEqual({ state: 'drained', unavailableBytes: 0 });
  },
);

describe('a pipe whose descendant writes after the process has exited', () => {
  scenarioResult(
    'keeps that output: the session waits for end of file, not for the exit',
    scenario9,
  );
});

const scenario10 = scenario(
  'is a backend failure: the broken pipe is reported, nothing is retried, and the process is ended',
  async () => {
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
  },
);

describe('a pipe whose reader has gone', () => {
  scenarioResult(
    'is a backend failure: the broken pipe is reported, nothing is retried, and the process is ended',
    scenario10,
  );
});

const scenario11 = scenario('gives the process an empty input and advertises none', async () => {
  const run = runHosted(hostFor('pipe', shellProfile('cat; printf "|eof"')));
  expect(run.attachment.authority.capabilities).toMatchObject({ mode: 'pipe', input: false });
  expect(run.attachment.write(new TextEncoder().encode('x')).disposition).toBe('failed');
  await run.session.closed;
  expect(textOf(bytesOnChannel(run.recorder, 'stdout'))).toBe('|eof');
});

describe('a pipe without an input channel', () => {
  scenarioResult('gives the process an empty input and advertises none', scenario11);
});

await settleScenarios();
