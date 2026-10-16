import { isAlive, waitUntilGone } from '../bun/bun-process.test-support.ts';
import { shellProfile } from '../bun/fixtures/bun-pipe-stdin.ts';
import { ESCAPED_DESCENDANT, outputProfile, pidsIn } from '../bun/fixtures/terminal-output.ts';
import { conclude, type CaseDefinition } from './conformance-cases.test-support.ts';
import { check } from './conformance.test-support.ts';

/**
 * Ending a PTY ends its session, not only the shell's process group. A shell on a terminal puts
 * every background job in a group of its own, so these cells run a real interactive shell and its
 * real jobs. A process that leaves the session with `setsid` is out of reach and stays `unknown`.
 */

/** An interactive shell: it takes the terminal as its own and does job control, as a user's shell does. */
const INTERACTIVE_SHELL = {
  ...shellProfile('', [], { TERM: 'xterm', PS1: '$ ' }),
  argumentList: ['-i'],
};

const backgroundAndStoppedJobs: CaseDefinition = {
  id: 'pty-background-and-stopped-jobs',
  modes: ['pty'],
  launch: () => ({ profile: INTERACTIVE_SHELL }),
  async run({ rig }) {
    await rig.client.handshake();
    // The typed line is echoed with `$!` and `$$` unexpanded, so only the shell's own output matches.
    rig.client.sendResult(rig.client.endpoint.input('sleep 7919 & echo bg=$! shell=$$\n'));
    await rig.client.waitForOutput(/bg=\d+ shell=\d+/);
    rig.client.sendResult(rig.client.endpoint.input("sh -c 'echo stopped=$$; exec sleep 7919'\n"));
    await rig.client.waitForOutput(/stopped=\d+/);
    // Control-Z reaches the foreground job through the terminal, and the shell reports it stopped.
    rig.client.sendResult(rig.client.endpoint.input('\u001a'));
    const text = await rig.client.waitForOutput(/Stopped/);
    const { bg, shell, stopped } = pidsIn(text);
    const aliveBefore = [bg, shell, stopped].map((pid) => isAlive(pid as number));
    rig.client.sendResult(rig.client.endpoint.terminate());
    const { cleanup } = await conclude(rig);
    const summary = await rig.session().closed;
    await Promise.all([bg, shell, stopped].map((pid) => waitUntilGone(pid as number)));
    return [
      check(
        'the shell, its background job and its stopped job were all running',
        aliveBefore.every(Boolean),
      ),
      check('cleanup was complete', cleanup.outcome === 'complete'),
      check('the slot is not quarantined', !summary.quarantined),
      check('the shell is gone', !isAlive(shell as number)),
      check('the background job is gone', !isAlive(bg as number)),
      check('the stopped job is gone', !isAlive(stopped as number)),
    ];
  },
};

/** A background job that ignores the hang-up the shell passes on; only the TERM sweep reaches it. */
const HANGUP_IGNORING_JOB =
  'set -m; sh -c \'trap "" HUP; printf "ignorer=%s " $$; exec sleep 7919\' & printf \'leader=%s \' "$$"; wait';

const hangUpIgnoredJob: CaseDefinition = {
  id: 'pty-sighup-ignored-job',
  modes: ['pty'],
  launch: (mode) => ({ profile: outputProfile(mode, HANGUP_IGNORING_JOB) }),
  async run({ rig }) {
    await rig.client.handshake();
    const text = await rig.client.waitForOutput(/(ignorer=\d+ leader=\d+|leader=\d+ ignorer=\d+) /);
    const { leader, ignorer } = pidsIn(text);
    const aliveBefore = isAlive(ignorer as number);
    rig.client.sendResult(rig.client.endpoint.terminate());
    const { cleanup } = await conclude(rig);
    const summary = await rig.session().closed;
    await waitUntilGone(leader as number);
    await waitUntilGone(ignorer as number);
    return [
      check('the job was running with the hang-up ignored', aliveBefore),
      check('cleanup was complete', cleanup.outcome === 'complete'),
      check('the slot is not quarantined', !summary.quarantined),
      check('the shell is gone', !isAlive(leader as number)),
      check('the job that ignored the hang-up is gone', !isAlive(ignorer as number)),
    ];
  },
};

/** One job in the session, and one that starts a session of its own and so leaves it. */
const SETSID_ESCAPE = `set -m; sleep 7919 & printf 'job=%s ' "$!"; set +m; ${ESCAPED_DESCENDANT}`;

const setsidEscapeIsUnknown: CaseDefinition = {
  id: 'pty-setsid-escape-unknown',
  modes: ['pty'],
  launch: (mode) => ({ profile: outputProfile(mode, SETSID_ESCAPE) }),
  async run({ rig }) {
    await rig.client.handshake();
    const text = await rig.client.waitForOutput(/escaped=\d+ /);
    const { leader, job, escaped } = pidsIn(text);
    try {
      rig.client.sendResult(rig.client.endpoint.terminate());
      const { cleanup } = await conclude(rig);
      const summary = await rig.session().closed;
      await waitUntilGone(leader as number);
      return [
        check(
          'cleanup is unknown, since a process left the session',
          cleanup.outcome === 'unknown',
        ),
        check('the slot is quarantined', summary.quarantined),
        check('the shell is gone', !isAlive(leader as number)),
        check('the job that stayed in the session is gone', !isAlive(job as number)),
        check('the process that left the session is not claimed', isAlive(escaped as number)),
      ];
    } finally {
      // The escapee is beyond cleanup by design, so the cell ends it by the pid it printed.
      if (isAlive(escaped as number)) process.kill(escaped as number, 'SIGKILL');
      await waitUntilGone(escaped as number);
    }
  },
};

export const SESSION_CASES: readonly CaseDefinition[] = [
  backgroundAndStoppedJobs,
  hangUpIgnoredJob,
  setsidEscapeIsUnknown,
];
