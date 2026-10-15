import { hostFor, isAlive, waitUntilGone } from '../bun/bun-process.test-support.ts';
import { PIPE_STDIN_FIXTURES, shellProfile } from '../bun/fixtures/bun-pipe-stdin.ts';
import { PTY_FIXTURES } from '../bun/fixtures/bun-pty.ts';
import {
  NONZERO_EXIT,
  OUTPUT_CASES,
  SIGNAL_EXIT,
  STUBBORN_DESCENDANT,
  outputProfile,
  pidsIn,
} from '../bun/fixtures/terminal-output.ts';
import type { HostedProcess, ProcessProfile } from '../bun/process-types.ts';
import type { OutputChannel, ServerMessage } from '../protocol/messages.ts';
import type { SessionBudgets } from '../session/session-types.ts';
import type { ScriptedProcess } from '../websocket/websocket.test-support.ts';
import {
  check,
  createRig,
  type Check,
  type ProcessMode,
  type Rig,
  type RigOptions,
  type TransportPath,
} from './conformance.test-support.ts';

/** What one cell observed, and the shape of the conversation, so the two paths can be compared. */
export type CellResult = {
  readonly checks: readonly Check[];
  /** The kinds the client saw, consecutive output frames collapsed, then the transport's close code. */
  readonly signature: readonly string[];
};

export type CaseContext = {
  readonly rig: Rig;
  readonly mode: ProcessMode;
  readonly path: TransportPath;
  /** A directory this run owns, for a fixture that waits on a file. */
  readonly scratch: string;
  /** What `launch` created for this run, handed back as it was returned. */
  readonly launched: CaseLaunch;
  /** The scripted process, for a cell whose ordering race needs a barrier rather than a real child. */
  readonly scripted: ScriptedProcess | undefined;
};

export type CaseLaunch = {
  readonly profile: ProcessProfile;
  readonly acceptsInput?: boolean;
  readonly rig?: Partial<RigOptions>;
  readonly budgets?: Partial<SessionBudgets>;
  /** Replace the real process with one the cell scripts. */
  readonly scripted?: ScriptedProcess;
  /** Host something other than a process: sources the cell built itself. */
  readonly hosted?: HostedProcess;
  /** Anything the cell's `run` needs from `launch`, such as a child it created. */
  readonly state?: unknown;
  /** Release what `launch` created outside the rig, such as a child the session does not own. */
  readonly dispose?: () => Promise<void>;
};

export type CaseDefinition = {
  readonly id: string;
  /** Whether the two paths must tell the same story. A client that vanishes is told nothing. */
  readonly comparable?: boolean;
  readonly modes: readonly ProcessMode[];
  readonly paths?: readonly TransportPath[];
  launch(mode: ProcessMode, scratch: string): CaseLaunch;
  run(context: CaseContext): Promise<readonly Check[]>;
};

const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

export const channelFor = (mode: ProcessMode): OutputChannel =>
  mode === 'pipe' ? 'stdout' : 'pty';

/** The text one channel carried, in arrival order. */
export function textOn(messages: readonly ServerMessage[], channel: OutputChannel): string {
  const chunks = messages.flatMap((message) =>
    message.kind === 'output' && message.channel === channel ? [message.payload] : [],
  );
  // Decode the joined bytes: a character can be split across frames, and each half alone is invalid.
  const joined = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.length;
  }
  return decode(joined);
}

export function signatureOf(messages: readonly ServerMessage[], closeCode: number | undefined) {
  const kinds: string[] = [];
  for (const message of messages) {
    if (message.kind === 'output' && kinds.at(-1) === 'output') continue;
    kinds.push(message.kind);
  }
  return [...kinds, `close:${closeCode ?? 'none'}`];
}

/** Run one definition on one path in one mode, always stopping the rig, and add the leak checks every cell owes. */
export async function runCell(
  definition: CaseDefinition,
  path: TransportPath,
  mode: ProcessMode,
  scratch: string,
): Promise<CellResult> {
  const launch = definition.launch(mode, scratch);
  const hosted =
    launch.hosted ??
    launch.scripted?.hosted ??
    hostFor(
      mode,
      launch.profile,
      launch.acceptsInput === undefined ? {} : { acceptsInput: launch.acceptsInput },
    );
  const rig = createRig(path, {
    profile: launch.profile,
    mode,
    hosted,
    ...(launch.acceptsInput === undefined ? {} : { acceptsInput: launch.acceptsInput }),
    ...(launch.budgets === undefined ? {} : { budgets: launch.budgets }),
    ...launch.rig,
  });
  let checks: readonly Check[] = [];
  let leaks;
  try {
    checks = await definition.run({
      rig,
      mode,
      path,
      scratch,
      launched: launch,
      scripted: launch.scripted,
    });
  } finally {
    leaks = await rig.stop();
    await launch.dispose?.();
  }
  const [closed] = await Promise.allSettled([rig.closeCode()]);
  const closeCode = closed.status === 'fulfilled' ? closed.value : undefined;
  return {
    checks: [
      ...checks,
      check('no timer is left running', leaks.timers === 0),
      check('no connection remains', leaks.connections === 0),
      check('no socket remains open', leaks.openSockets === 0),
    ],
    signature: signatureOf(rig.client.messages, closeCode),
  };
}

/** Wait for the host's last words: the cleanup result, then the close. */
export async function conclude(rig: Rig) {
  const cleanup = await rig.client.waitForKind('cleanup-result');
  const closeCode = await rig.closeCode();
  return { cleanup, closeCode };
}

export const exitsIn = (rig: Rig) =>
  rig.client.messages.filter((message) => message.kind === 'process-exit');

export function ordered(rig: Rig, first: string, second: string): boolean {
  const kinds = rig.client.kinds();
  return kinds.lastIndexOf(first) < kinds.indexOf(second);
}

const OUTPUT_BODY = [
  OUTPUT_CASES.progressRewrites.body,
  OUTPUT_CASES.alternateScreen.body,
  OUTPUT_CASES.unicodeOneByteAtATime.body,
].join('; ');
const OUTPUT_EXPECTED =
  OUTPUT_CASES.progressRewrites.output +
  OUTPUT_CASES.alternateScreen.output +
  OUTPUT_CASES.unicodeOneByteAtATime.output;

const outputBytes: CaseDefinition = {
  id: 'output-bytes',
  modes: ['pipe', 'pty'],
  launch: (mode) => ({ profile: outputProfile(mode, OUTPUT_BODY) }),
  async run({ rig, mode }) {
    await rig.client.handshake();
    await rig.client.waitForKind('process-exit');
    const { cleanup, closeCode } = await conclude(rig);
    const summary = await rig.session().closed;
    const outputs = rig.client.messages.filter((message) => message.kind === 'output');
    return [
      check(
        'every byte arrived exactly and in order',
        textOn(rig.client.messages, channelFor(mode)) === OUTPUT_EXPECTED,
      ),
      check(
        'on the one channel the mode carries',
        outputs.length > 0 && outputs.every((message) => message.channel === channelFor(mode)),
      ),
      check(
        'the exit was reported once, with status 0',
        exitsIn(rig).length === 1 &&
          exitsIn(rig).every((exit) => exit.exitCode === 0 && exit.signal === null),
      ),
      check('the exit followed the output', ordered(rig, 'output', 'process-exit')),
      check('cleanup was complete', cleanup.outcome === 'complete'),
      check('the transport closed normally', closeCode === 1000),
      check(
        'the close drained every byte',
        summary.cause === 'process-exit' && summary.drain.state === 'drained',
      ),
    ];
  },
};

const inputAndEcho: CaseDefinition = {
  id: 'input-and-echo',
  modes: ['pipe', 'pty'],
  launch: (mode) =>
    mode === 'pipe'
      ? { profile: PIPE_STDIN_FIXTURES.promptAndInput.profile, acceptsInput: true }
      : { profile: PTY_FIXTURES.promptAndInput.profile },
  async run({ rig, mode }) {
    const fixture =
      mode === 'pipe' ? PIPE_STDIN_FIXTURES.promptAndInput : PTY_FIXTURES.promptAndInput;
    const capabilities = await rig.client.handshake();
    await rig.client.waitForOutput(fixture.ready);
    const sent = rig.client.endpoint.input(fixture.input);
    rig.client.sendResult(sent);
    const acknowledged = await rig.client.waitForKind('operation-ack');
    await rig.client.waitForKind('process-exit');
    const { cleanup, closeCode } = await conclude(rig);
    const stdout = textOn(rig.client.messages, channelFor(mode));
    return [
      check('the host advertised input', capabilities.capabilities.input),
      check(
        'the input was accepted into the FIFO',
        sent.ok && acknowledged.operationSequence === sent.value.sequence,
      ),
      check(
        'the process saw exactly the bytes sent',
        mode === 'pipe'
          ? stdout === PIPE_STDIN_FIXTURES.promptAndInput.stdout &&
              textOn(rig.client.messages, 'stderr') === PIPE_STDIN_FIXTURES.promptAndInput.stderr
          : stdout === PTY_FIXTURES.promptAndInput.output,
      ),
      check('cleanup was complete', cleanup.outcome === 'complete'),
      check('the transport closed normally', closeCode === 1000),
    ];
  },
};

const resize: CaseDefinition = {
  id: 'resize',
  modes: ['pipe', 'pty'],
  launch: (mode) =>
    mode === 'pty'
      ? { profile: PTY_FIXTURES.resize.profile }
      : { profile: shellProfile('printf ready; exec sleep 7919'), acceptsInput: true },
  async run({ rig, mode }) {
    const capabilities = await rig.client.handshake();
    if (mode === 'pipe') {
      await rig.client.waitForOutput('ready');
      const refused = rig.client.endpoint.resize(100, 40);
      rig.client.sendResult(rig.client.endpoint.terminate());
      const { cleanup } = await conclude(rig);
      return [
        check('a pipe advertises no resize', !capabilities.capabilities.resize),
        check('the client refuses to build a resize', !refused.ok),
        check('cleanup was complete', cleanup.outcome === 'complete'),
      ];
    }
    await rig.client.waitForOutput(PTY_FIXTURES.resize.ready);
    rig.client.sendResult(rig.client.endpoint.resize(100, 40));
    rig.client.sendResult(rig.client.endpoint.input(PTY_FIXTURES.resize.input));
    await rig.client.waitForOutput('40 100');
    await rig.client.waitForKind('process-exit');
    const { cleanup } = await conclude(rig);
    const text = textOn(rig.client.messages, 'pty');
    return [
      check('a PTY advertises resize', capabilities.capabilities.resize),
      check('the launch size was reported first', text.startsWith('24 80\r\n')),
      check('the new size reached the terminal', text.includes('40 100')),
      check('cleanup was complete', cleanup.outcome === 'complete'),
    ];
  },
};

const exitCode: CaseDefinition = {
  id: 'exit-code',
  modes: ['pipe', 'pty'],
  launch: (mode) => ({ profile: outputProfile(mode, NONZERO_EXIT.body) }),
  async run({ rig, mode }) {
    await rig.client.handshake();
    const exit = await rig.client.waitForKind('process-exit');
    const { cleanup, closeCode } = await conclude(rig);
    return [
      check(
        'the output arrived',
        textOn(rig.client.messages, channelFor(mode)) === NONZERO_EXIT.output,
      ),
      check("the status is the process's own", exit.exitCode === NONZERO_EXIT.exitCode),
      check('no signal was invented', exit.signal === null),
      check('cleanup was complete', cleanup.outcome === 'complete'),
      check('the transport closed normally', closeCode === 1000),
    ];
  },
};

const exitSignal: CaseDefinition = {
  id: 'exit-signal',
  modes: ['pipe', 'pty'],
  launch: (mode) => ({ profile: outputProfile(mode, SIGNAL_EXIT.body) }),
  async run({ rig }) {
    await rig.client.handshake();
    const exit = await rig.client.waitForKind('process-exit');
    const { cleanup } = await conclude(rig);
    return [
      check('the signal is named', exit.signal === SIGNAL_EXIT.signal),
      check('no exit code is invented', exit.exitCode === null),
      check('cleanup was complete', cleanup.outcome === 'complete'),
    ];
  },
};

const channelSeparation: CaseDefinition = {
  id: 'channel-separation',
  modes: ['pipe'],
  launch: () => ({ profile: shellProfile("printf 'out'; printf 'err' >&2; exit 0") }),
  async run({ rig }) {
    await rig.client.handshake();
    await rig.client.waitForKind('process-exit');
    const { cleanup } = await conclude(rig);
    return [
      check(
        'standard output kept its own channel',
        textOn(rig.client.messages, 'stdout') === 'out',
      ),
      check('standard error kept its own channel', textOn(rig.client.messages, 'stderr') === 'err'),
      check('nothing was tagged as a terminal', textOn(rig.client.messages, 'pty') === ''),
      check('cleanup was complete', cleanup.outcome === 'complete'),
    ];
  },
};

const SLEEPER = 'printf \'leader=%s \' "$$"; exec sleep 7919';

const clientStop: CaseDefinition = {
  id: 'client-stop',
  modes: ['pipe', 'pty'],
  launch: () => ({ profile: shellProfile(SLEEPER) }),
  async run({ rig }) {
    await rig.client.handshake();
    const text = await rig.client.waitForOutput(/leader=\d+ /);
    const { leader } = pidsIn(text);
    const aliveBefore = isAlive(leader as number);
    rig.client.sendResult(rig.client.endpoint.terminate());
    const { cleanup, closeCode } = await conclude(rig);
    await waitUntilGone(leader as number);
    return [
      check('the process was running', aliveBefore),
      check('cleanup was complete', cleanup.outcome === 'complete'),
      check('the process is gone', !isAlive(leader as number)),
      check('the transport closed normally', closeCode === 1000),
    ];
  },
};

const stubbornDescendants: CaseDefinition = {
  id: 'stubborn-descendants',
  modes: ['pipe', 'pty'],
  launch: () => ({ profile: shellProfile(STUBBORN_DESCENDANT) }),
  async run({ rig }) {
    await rig.client.handshake();
    const text = await rig.client.waitForOutput(/leader=\d+ descendant=\d+ /);
    const pids = pidsIn(text);
    rig.client.sendResult(rig.client.endpoint.terminate());
    const { cleanup } = await conclude(rig);
    await waitUntilGone(pids['leader'] as number);
    await waitUntilGone(pids['descendant'] as number);
    return [
      check('both ignored TERM and were running', pids['leader'] !== pids['descendant']),
      check('cleanup was complete, so KILL ended the group', cleanup.outcome === 'complete'),
      check('the leader is gone', !isAlive(pids['leader'] as number)),
      check('the descendant is gone', !isAlive(pids['descendant'] as number)),
    ];
  },
};

const clientDisconnect: CaseDefinition = {
  id: 'client-disconnect',
  comparable: false,
  modes: ['pipe', 'pty'],
  launch: () => ({ profile: shellProfile(SLEEPER) }),
  async run({ rig }) {
    await rig.client.handshake();
    const text = await rig.client.waitForOutput(/leader=\d+ /);
    const { leader } = pidsIn(text);
    rig.drop();
    const summary = await rig.session().closed;
    await waitUntilGone(leader as number);
    return [
      check('the disconnect was the cause', summary.cause === 'disconnect'),
      check('cleanup was complete', summary.cleanup === 'complete'),
      check('the slot is not quarantined', !summary.quarantined),
      check('the process is gone', !isAlive(leader as number)),
    ];
  },
};

const spawnFailure: CaseDefinition = {
  id: 'spawn-failure',
  modes: ['pipe', 'pty'],
  launch: () => ({
    profile: { ...shellProfile('true'), executable: '/nonexistent/shell' },
  }),
  async run({ rig }) {
    await rig.client.handshake();
    const failure = await rig.client.waitForKind('attachment-error');
    const closeCode = await rig.closeCode();
    return [
      check('the failure is spawn-failed', failure.code === 'spawn-failed'),
      check('it is never reported as an exit', !rig.client.kinds().includes('process-exit')),
      check('no output was invented', textOn(rig.client.messages, channelFor(rig.mode)) === ''),
      check('the transport closed with the internal-error code', closeCode === 1011),
    ];
  },
};

const exitImmediately: CaseDefinition = {
  id: 'exit-immediately',
  modes: ['pipe', 'pty'],
  launch: (mode) => ({ profile: outputProfile(mode, OUTPUT_CASES.exitBeforeFirstOutput.body) }),
  async run({ rig }) {
    await rig.client.handshake();
    const exit = await rig.client.waitForKind('process-exit');
    const { cleanup, closeCode } = await conclude(rig);
    return [
      check('the exit was reported with status 0', exit.exitCode === 0 && exit.signal === null),
      check('no output was invented', !rig.client.kinds().includes('output')),
      check('cleanup was complete', cleanup.outcome === 'complete'),
      check('the transport closed normally', closeCode === 1000),
    ];
  },
};

const exitBeforeAttach: CaseDefinition = {
  id: 'exit-before-attach',
  modes: ['pipe', 'pty'],
  // A socket's process exists only after the hello, so the in-memory path is the one that can
  // have a process already gone when a client arrives.
  paths: ['direct'],
  launch: (mode) => ({
    profile: outputProfile(mode, OUTPUT_CASES.exitBeforeFirstOutput.body),
    rig: { startBeforeAttach: true },
  }),
  async run({ rig }) {
    const summary = await rig.session().closed;
    await rig.observed.exitRecorded;
    rig.client.sendResult(rig.client.endpoint.hello());
    const closeCode = await rig.closeCode();
    return [
      check('the session closed on the exit', summary.cause === 'process-exit'),
      check('cleanup was complete', summary.cleanup === 'complete'),
      check('a late client is refused', closeCode === 1008),
      check('no capabilities were issued', rig.client.messages.length === 0),
    ];
  },
};

const BARRIER_SCRIPT =
  'printf \'leader=%s \' "$$"; (until [ -e "$1" ]; do sleep 0.05; done; printf trailing) & exit 0';

const outputAfterExit: CaseDefinition = {
  id: 'output-after-exit-before-eof',
  // A PTY hangs up its session when the leader exits, so only a pipe can write after the exit.
  modes: ['pipe'],
  launch: (_mode, scratch) => ({
    profile: shellProfile(BARRIER_SCRIPT, [`${scratch}/release-trailing-output`]),
  }),
  async run({ rig, scratch }) {
    await rig.client.handshake();
    await rig.observed.exitRecorded;
    const snapshot = rig.session().snapshot;
    const heldExit = !rig.client.kinds().includes('process-exit');
    await Bun.write(`${scratch}/release-trailing-output`, '');
    await rig.client.waitForKind('process-exit');
    const { cleanup, closeCode } = await conclude(rig);
    const text = textOn(rig.client.messages, 'stdout');
    return [
      check('the session had recorded the exit', snapshot.process.kind === 'exited'),
      check('the stream had not ended, so the frame was held', heldExit && !snapshot.closed),
      check('the trailing output arrived', text.endsWith('trailing')),
      check('it arrived before the exit frame', ordered(rig, 'output', 'process-exit')),
      check('the exit was reported once', exitsIn(rig).length === 1),
      check('cleanup was complete', cleanup.outcome === 'complete'),
      check('the transport closed normally', closeCode === 1000),
    ];
  },
};

const eofWithoutExit: CaseDefinition = {
  id: 'eof-without-exit',
  // A terminal's EOF follows the leader's exit; only a pipe can close its streams and live on.
  modes: ['pipe'],
  launch: () => ({
    profile: shellProfile('printf \'leader=%s \' "$$"; exec 1>&- 2>&-; exec sleep 7919'),
  }),
  async run({ rig }) {
    await rig.client.handshake();
    const text = await rig.client.waitForOutput(/leader=\d+ /);
    const { leader } = pidsIn(text);
    await rig.observed.streamsEnded;
    const snapshot = rig.session().snapshot;
    const alive = isAlive(leader as number);
    const quiet = !rig.client.kinds().includes('process-exit');
    rig.client.sendResult(rig.client.endpoint.terminate());
    const { cleanup } = await conclude(rig);
    await waitUntilGone(leader as number);
    return [
      check('the process was still running', snapshot.process.kind === 'running' && alive),
      check('end of file was not reported as an exit', quiet),
      check('cleanup was complete', cleanup.outcome === 'complete'),
    ];
  },
};

export const BEHAVIOR_CASES: readonly CaseDefinition[] = [
  outputBytes,
  inputAndEcho,
  resize,
  exitCode,
  exitSignal,
  channelSeparation,
  clientStop,
  stubbornDescendants,
  clientDisconnect,
  spawnFailure,
  exitImmediately,
  exitBeforeAttach,
  outputAfterExit,
  eofWithoutExit,
];
