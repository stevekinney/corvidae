import { describe, expect } from 'bun:test';

import { SCENARIO_HANG_GUARD_MILLISECONDS } from '@lostgradient/testing';

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
import { shellProfile } from './fixtures/bun-pipe-stdin.ts';
import {
  ESCAPED_DESCENDANT,
  outputProfile,
  pidsIn,
  type OutputMode,
} from './fixtures/terminal-output.ts';

/**
 * The shell puts each background job in a group of its own (`set -m`), as an interactive shell
 * does, so ending the shell's group never reaches it. Only the session does.
 */
const BACKGROUND_JOB = 'set -m; sleep 7919 & printf \'leader=%s job=%s \' "$$" "$!"; wait';

/**
 * A pipe has no terminal and so no job control: a job in a group of its own is one that put itself
 * there, which is what this does.
 */
const OWN_GROUP_JOB =
  'perl -e \'setpgrp(0, 0); $|=1; print "job=$$ "; exec "sleep", "7919"\' & printf \'leader=%s \' "$$"; wait';

/** A job that ignores both the hang-up and TERM, so only KILL ends it. */
const STUBBORN_JOB =
  'set -m; sh -c \'trap "" HUP TERM; printf "stubborn=%s " $$; while :; do sleep 1; done\' & printf \'leader=%s \' "$$"; wait';

/**
 * A stopped job. The shell announces it only once `ps` shows it stopped, so a test that has read
 * the announcement never mistakes a job that has not stopped yet for one.
 */
const STOPPED_JOB =
  'set -m; sleep 7919 & kill -STOP $!; until ps -o stat= -p $! | grep -q T; do sleep 0.02; done; printf \'leader=%s job=%s \' "$$" "$!"; exec sleep 7919';

type Observed = { readonly leader: number; readonly pids: Record<string, number> };

async function launch(
  mode: OutputMode,
  body: string,
  ready: RegExp,
): Promise<{ run: ReturnType<typeof runHosted>; observed: Observed }> {
  const run = runHosted(hostFor(mode, outputProfile(mode, body)));
  await run.waitForOutput(channelOf(mode), ready);
  const pids = pidsIn(textOf(bytesOnChannel(run.recorder, channelOf(mode))));
  return { run, observed: { leader: pids['leader'] as number, pids } };
}

/** Start a process in a session of its own, as an unrelated program on the host would. */
function startUnrelated(): { readonly pid: number; end(): void } {
  const child = Bun.spawn(['sleep', '7919'], {
    detached: true,
    stdio: ['ignore', 'ignore', 'ignore'],
    timeout: SCENARIO_HANG_GUARD_MILLISECONDS,
  });
  return { pid: child.pid, end: () => child.kill('SIGKILL') };
}

const scenario1 = scenario(
  'a background job in a group of its own is ended, and cleanup is complete',
  async () => {
    const { run, observed } = await launch('pty', BACKGROUND_JOB, /job=\d+ /);
    const job = observed.pids['job'] as number;
    expect(isAlive(job)).toBe(true);
    const summary = await run.session.dispose();
    expect(summary).toMatchObject({ cleanup: 'complete', quarantined: false });
    expect(isAlive(observed.leader)).toBe(false);
    expect(isAlive(job)).toBe(false);
  },
);

const scenario2 = scenario('a stopped job is ended', async () => {
  const { run, observed } = await launch('pty', STOPPED_JOB, /job=\d+ /);
  const job = observed.pids['job'] as number;
  const summary = await run.session.dispose();
  expect(summary).toMatchObject({ cleanup: 'complete', quarantined: false });
  expect(isAlive(job)).toBe(false);
  expect(isAlive(observed.leader)).toBe(false);
});

const scenario3 = scenario(
  'a job that ignores the hang-up and TERM is killed by the sweep',
  async () => {
    const { run, observed } = await launch(
      'pty',
      STUBBORN_JOB,
      /stubborn=\d+ leader=\d+ |leader=\d+ stubborn=\d+ /,
    );
    const stubborn = observed.pids['stubborn'] as number;
    expect(isAlive(stubborn)).toBe(true);
    const summary = await run.session.dispose();
    expect(summary).toMatchObject({ cleanup: 'complete', quarantined: false });
    expect(isAlive(stubborn)).toBe(false);
  },
);

const scenario4 = scenario('a job that outlived its shell is still ended', async () => {
  const { run, observed } = await launch(
    'pty',
    'set -m; sleep 7919 & printf \'leader=%s job=%s \' "$$" "$!"; exit 0',
    /job=\d+ /,
  );
  const job = observed.pids['job'] as number;
  await run.exitReported;
  // On Linux the terminal reports the end of its output only when every holder of it has closed
  // it, and the job still holds it, so the session is ended the way a host ends it.
  const summary = await run.session.dispose();
  expect(summary).toMatchObject({ cleanup: 'complete', quarantined: false });
  expect(isAlive(job)).toBe(false);
});

const scenario5 = scenario(
  'a process in another session survives, and is never signaled',
  async () => {
    const unrelated = startUnrelated();
    try {
      const { run, observed } = await launch('pty', BACKGROUND_JOB, /job=\d+ /);
      const summary = await run.session.dispose();
      expect(summary).toMatchObject({ cleanup: 'complete', quarantined: false });
      expect(isAlive(observed.pids['job'] as number)).toBe(false);
      expect(isAlive(unrelated.pid)).toBe(true);
    } finally {
      unrelated.end();
      await waitUntilGone(unrelated.pid);
    }
  },
);

const scenario6 = scenario(
  'a descendant that left the session is unknown, though the jobs that stayed end',
  async () => {
    const { run, observed } = await launch(
      'pty',
      `set -m; sleep 7919 & printf 'job=%s ' "$!"; set +m; ${ESCAPED_DESCENDANT}`,
      /escaped=\d+ /,
    );
    const { job, escaped } = observed.pids;
    try {
      const summary = await run.session.dispose();
      expect(summary).toMatchObject({ cleanup: 'unknown', quarantined: true });
      expect(isAlive(job as number)).toBe(false);
      expect(isAlive(escaped as number)).toBe(true);
    } finally {
      process.kill(escaped as number, 'SIGKILL');
      await waitUntilGone(escaped as number);
    }
  },
);

describe('ending a PTY ends the jobs its shell started', () => {
  scenarioResult(
    'a background job in a group of its own is ended, and cleanup is complete',
    scenario1,
  );

  scenarioResult('a stopped job is ended', scenario2);

  scenarioResult('a job that ignores the hang-up and TERM is killed by the sweep', scenario3);

  scenarioResult('a job that outlived its shell is still ended', scenario4);

  scenarioResult('a process in another session survives, and is never signaled', scenario5);

  scenarioResult(
    'a descendant that left the session is unknown, though the jobs that stayed end',
    scenario6,
  );
});

const scenario7 = scenario(
  'a background job in a group of its own is not claimed, and is reported unknown',
  async () => {
    const run = runHosted(hostFor('pipe', shellProfile(OWN_GROUP_JOB)));
    await run.waitForOutput('stdout', /job=\d+ /);
    const { leader, job } = pidsIn(textOf(bytesOnChannel(run.recorder, 'stdout')));
    try {
      const summary = await run.session.dispose();
      expect(summary).toMatchObject({ cleanup: 'unknown', quarantined: true });
      expect(isAlive(leader as number)).toBe(false);
      expect(isAlive(job as number)).toBe(true);
    } finally {
      process.kill(job as number, 'SIGKILL');
      await waitUntilGone(job as number);
    }
  },
);

describe('a pipe is unchanged: its guarantee is the process group', () => {
  scenarioResult(
    'a background job in a group of its own is not claimed, and is reported unknown',
    scenario7,
  );
});

await settleScenarios();
