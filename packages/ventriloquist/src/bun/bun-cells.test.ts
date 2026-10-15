import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CORPUS } from '../protocol/corpus/fixtures.ts';
import {
  bytesOnChannel,
  channelOf,
  hostFor,
  isAlive,
  runHosted,
  scenarioTest,
  settleScenarios,
  textOf,
  type HostedRun,
} from './bun-process.test-support.ts';
import { PIPE_STDIN_FIXTURES, shellProfile } from './fixtures/bun-pipe-stdin.ts';
import { PTY_FIXTURES } from './fixtures/bun-pty.ts';
import {
  NONZERO_EXIT,
  OUTPUT_CASES,
  outputProfile,
  pidsIn,
  SIGNAL_EXIT,
  STUBBORN_DESCENDANT,
  type OutputMode,
} from './fixtures/terminal-output.ts';
import { createPipeProcess } from './pipe-process.ts';
import { createPtyProcess } from './pty-process.ts';

/**
 * The real-process matrix: every cell runs a real child on this host, through a real session, in
 * both modes. A cell that is missing, or that never ran, fails the last test, so selecting a
 * subset of this file cannot pass.
 */
const CELLS = [
  'prompt-and-input',
  'no-newline-output',
  'progress-rewrites',
  'alternate-screen',
  'resize',
  'unicode-chunks',
  'nonzero-exit',
  'signals',
  'stubborn-descendants',
  'corpus-passthrough',
] as const;
const MODES: OutputMode[] = ['pipe', 'pty'];
const REQUIRED_CELL_IDS = MODES.flatMap((mode) => CELLS.map((cell) => `${mode}:${cell}`));
const completed = new Set<string>();
const passedCorpusFixtures = new Map<OutputMode, Set<string>>(
  MODES.map((mode) => [mode, new Set()]),
);
let corpusScratch: string | undefined;

/** Where the corpus bytes are written for the child to `cat`. Created on first use, removed after the file. */
function corpusDirectory(): string {
  corpusScratch ??= mkdtempSync(join(tmpdir(), 'ventriloquist-corpus-'));
  return corpusScratch;
}

function cell(mode: OutputMode, name: (typeof CELLS)[number], body: () => Promise<void>): void {
  scenarioTest(`${mode}:${name}`, async () => {
    await body();
    completed.add(`${mode}:${name}`);
  });
}

async function finish(run: HostedRun) {
  const summary = await run.session.closed;
  await run.exitReported;
  return summary;
}

function expectCleanExit(run: HostedRun, exit: { exitCode: number | null; signal: string | null }) {
  expect(run.recorder.ofType('processExit')).toEqual([{ type: 'processExit', ...exit }]);
}

/** Run one shared output case and require its bytes to arrive exactly, with a clean exit. */
async function expectOutputCase(
  mode: OutputMode,
  output: string,
  body: string,
  exit: { exitCode: number | null; signal: string | null } = { exitCode: 0, signal: null },
): Promise<HostedRun> {
  const run = runHosted(hostFor(mode, outputProfile(mode, body)));
  const summary = await finish(run);
  expect(textOf(bytesOnChannel(run.recorder, channelOf(mode)))).toBe(output);
  expect(summary).toMatchObject({ cause: 'process-exit', cleanup: 'complete', quarantined: false });
  expect(summary.drain).toEqual({ state: 'drained', unavailableBytes: 0 });
  expectCleanExit(run, exit);
  return run;
}

describe('the real-process matrix', () => {
  cell('pipe', 'prompt-and-input', async () => {
    const fixture = PIPE_STDIN_FIXTURES.promptAndInput;
    const run = runHosted(createPipeProcess({ profile: fixture.profile, acceptsInput: true }));
    await run.waitForOutput('stdout', fixture.ready);
    expect(run.attachment.write(new TextEncoder().encode(fixture.input)).disposition).toBe(
      'accepted',
    );
    const summary = await finish(run);
    expect(textOf(bytesOnChannel(run.recorder, 'stdout'))).toBe(fixture.stdout);
    expect(textOf(bytesOnChannel(run.recorder, 'stderr'))).toBe(fixture.stderr);
    expect(textOf(bytesOnChannel(run.recorder, 'pty'))).toBe('');
    expect(summary.cleanup).toBe('complete');
    expectCleanExit(run, { exitCode: 0, signal: null });

    // A sequence cut on stdout with stderr written in the cut stays whole on its own channel.
    const split = PIPE_STDIN_FIXTURES.splitSequenceAcrossChannels;
    const cut = runHosted(createPipeProcess({ profile: split.profile, acceptsInput: true }));
    await cut.waitForOutput('stdout', split.firstHalf);
    await cut.waitForOutput('stderr', split.firstDiagnostic);
    expect(textOf(bytesOnChannel(cut.recorder, 'stdout'))).toBe(split.firstHalf);
    expect(cut.attachment.write(new TextEncoder().encode(split.input)).disposition).toBe(
      'accepted',
    );
    await finish(cut);
    expect(textOf(bytesOnChannel(cut.recorder, 'stdout'))).toBe(split.stdout);
    expect(textOf(bytesOnChannel(cut.recorder, 'stderr'))).toBe(split.stderr);
    expect(textOf(bytesOnChannel(cut.recorder, 'pty'))).toBe('');
    expectCleanExit(cut, { exitCode: 0, signal: null });
  });

  cell('pty', 'prompt-and-input', async () => {
    const fixture = PTY_FIXTURES.promptAndInput;
    const run = runHosted(
      createPtyProcess({ profile: fixture.profile, dimensions: { columns: 80, rows: 24 } }),
    );
    await run.waitForOutput('pty', fixture.ready);
    run.attachment.write(new TextEncoder().encode(fixture.input));
    await finish(run);
    // The terminal's line discipline echoed the input; the host added nothing.
    expect(textOf(bytesOnChannel(run.recorder, 'pty'))).toBe(fixture.output);
    expectCleanExit(run, { exitCode: 0, signal: null });

    const silent = PTY_FIXTURES.silentInput;
    const quiet = runHosted(
      createPtyProcess({ profile: silent.profile, dimensions: { columns: 80, rows: 24 } }),
    );
    await quiet.waitForOutput('pty', silent.ready);
    quiet.attachment.write(new TextEncoder().encode(silent.input));
    await finish(quiet);
    expect(textOf(bytesOnChannel(quiet.recorder, 'pty'))).toBe(silent.output);
  });

  for (const mode of MODES) {
    cell(mode, 'no-newline-output', async () => {
      const { body, output } = OUTPUT_CASES.noNewlineOutput;
      await expectOutputCase(mode, output, body);
    });
    cell(mode, 'progress-rewrites', async () => {
      const { body, output } = OUTPUT_CASES.progressRewrites;
      await expectOutputCase(mode, output, body);
    });
    cell(mode, 'alternate-screen', async () => {
      const { body, output } = OUTPUT_CASES.alternateScreen;
      await expectOutputCase(mode, output, body);
    });
    cell(mode, 'unicode-chunks', async () => {
      const { body, output } = OUTPUT_CASES.unicodeOneByteAtATime;
      const run = await expectOutputCase(mode, output, body);
      expect(textOf(bytesOnChannel(run.recorder, channelOf(mode)))).not.toContain('�');
    });
    cell(mode, 'nonzero-exit', async () => {
      await expectOutputCase(mode, NONZERO_EXIT.output, NONZERO_EXIT.body, {
        exitCode: NONZERO_EXIT.exitCode,
        signal: null,
      });
    });
  }

  cell('pipe', 'resize', async () => {
    const hosted = hostFor('pipe', shellProfile('printf ready; sleep 7919'));
    const run = runHosted(hosted);
    await run.waitForOutput('stdout', 'ready');
    expect(run.attachment.authority.capabilities.resize).toBe(false);
    expect(hosted.backend.resize).toBeUndefined();
    expect(run.attachment.resize(100, 30)).toEqual({
      disposition: 'failed',
      sequence: 1,
      reason: 'unsupported',
    });
  });

  cell('pty', 'resize', async () => {
    const fixture = PTY_FIXTURES.resize;
    const run = runHosted(
      createPtyProcess({ profile: fixture.profile, dimensions: { columns: 40, rows: 10 } }),
      {
        columns: 40,
        rows: 10,
      },
    );
    await run.waitForOutput('pty', fixture.ready);
    expect(run.attachment.resize(100, 30).disposition).toBe('accepted');
    run.attachment.write(new TextEncoder().encode(fixture.input));
    await finish(run);
    expect(textOf(bytesOnChannel(run.recorder, 'pty'))).toBe('10 40\r\nready\r\n\r\n30 100\r\n');
  });

  cell('pipe', 'signals', async () => {
    await expectSignals('pipe');
  });
  cell('pty', 'signals', async () => {
    await expectSignals('pty');
  });

  cell('pipe', 'stubborn-descendants', async () => {
    await expectStubbornDescendantsEnded('pipe');
  });
  cell('pty', 'stubborn-descendants', async () => {
    await expectStubbornDescendantsEnded('pty');
  });

  for (const mode of MODES) {
    for (const fixture of CORPUS) {
      scenarioTest(`${mode}:corpus-passthrough:${fixture.id}`, async () => {
        const file = join(corpusDirectory(), `${mode}-${fixture.id}.bin`);
        writeFileSync(file, fixture.bytes);
        const profile = shellProfile(`${mode === 'pty' ? 'stty -opost; ' : ''}cat "$1"`, [file]);
        const run = runHosted(hostFor(mode, profile));
        await finish(run);
        expect(bytesOnChannel(run.recorder, channelOf(mode))).toEqual(fixture.bytes);
        passedCorpusFixtures.get(mode)?.add(fixture.id);
      });
    }
  }

  test('every cell in both modes ran, and none outside the matrix did', () => {
    // Each corpus fixture is its own test, so the cell is complete only when all of them passed.
    for (const mode of MODES) {
      if (passedCorpusFixtures.get(mode)?.size === CORPUS.length) {
        completed.add(`${mode}:corpus-passthrough`);
      }
    }
    expect([...completed].toSorted()).toEqual(REQUIRED_CELL_IDS.toSorted());
  });
});

/** A signal ends a process with no exit code, and the host can end one on request. */
async function expectSignals(mode: OutputMode): Promise<void> {
  await expectOutputCase(mode, SIGNAL_EXIT.output, SIGNAL_EXIT.body, {
    exitCode: null,
    signal: SIGNAL_EXIT.signal,
  });

  const run = runHosted(
    hostFor(mode, outputProfile(mode, 'printf \'leader=%s \' "$$"; sleep 7919')),
  );
  await run.waitForOutput(channelOf(mode), /leader=\d+ /);
  const { leader } = pidsIn(textOf(bytesOnChannel(run.recorder, channelOf(mode))));
  expect(run.attachment.stop().accepted).toBe(true);
  const summary = await run.session.closed;
  expect(summary).toMatchObject({
    cause: 'attachment-stop',
    cleanup: 'complete',
    quarantined: false,
  });
  expect(isAlive(leader as number)).toBe(false);
}

async function expectStubbornDescendantsEnded(mode: OutputMode): Promise<void> {
  const run = runHosted(hostFor(mode, outputProfile(mode, STUBBORN_DESCENDANT)));
  await run.waitForOutput(channelOf(mode), /descendant=\d+ /);
  const { leader, descendant } = pidsIn(textOf(bytesOnChannel(run.recorder, channelOf(mode))));
  expect(isAlive(descendant as number)).toBe(true);
  const summary = await run.session.dispose();
  // TERM is ignored by both, so only the escalation to KILL can end the group.
  expect(summary).toMatchObject({ cleanup: 'complete', quarantined: false });
  expect(isAlive(leader as number)).toBe(false);
  expect(isAlive(descendant as number)).toBe(false);
}

await settleScenarios();

afterAll(() => {
  completed.clear();
  if (corpusScratch !== undefined) rmSync(corpusScratch, { recursive: true, force: true });
});
