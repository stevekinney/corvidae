import { isAlive, waitUntilGone } from '../bun/bun-process.test-support.ts';
import { shellProfile } from '../bun/fixtures/bun-pipe-stdin.ts';
import { ENDLESS_OUTPUT, outputProfile, pidsIn } from '../bun/fixtures/terminal-output.ts';
import type { ServerMessage } from '../protocol/messages.ts';
import { DEFAULT_SESSION_BUDGETS } from '../session/session-types.ts';
import {
  SECOND_SESSION_IDENTIFIER,
  forgeInput,
  scriptedProcess,
} from '../websocket/websocket.test-support.ts';
import {
  channelFor,
  conclude,
  textOn,
  type CaseDefinition,
} from './conformance-cases.test-support.ts';
import { check } from './conformance.test-support.ts';

const SLEEPER = 'printf \'leader=%s \' "$$"; exec sleep 7919';
const CAT = "printf 'ready '; exec cat";
// Shorter than the liveness deadline, so the lifetime and not a missed heartbeat ends the attachment.
const LIFETIME_MILLISECONDS = 20_000;

/** A frame the server answered with a typed refusal, found among the raw frames the client was given. */
function refusalCodes(frames: readonly { readonly raw: string | Uint8Array }[]): string[] {
  return frames.flatMap((frame) => {
    if (typeof frame.raw !== 'string') return [];
    const parsed = JSON.parse(frame.raw) as { kind?: string; code?: string };
    return parsed.kind === 'operation-failure' && parsed.code !== undefined ? [parsed.code] : [];
  });
}

const authorityExpiry: CaseDefinition = {
  id: 'authority-expiry',
  modes: ['pipe', 'pty'],
  launch: () => ({
    profile: shellProfile(SLEEPER),
    rig: { lifetimeMilliseconds: LIFETIME_MILLISECONDS },
  }),
  async run({ rig }) {
    await rig.client.handshake();
    const { leader } = pidsIn(await rig.client.waitForOutput(/leader=\d+ /));
    await rig.expireAuthority();
    const { cleanup, closeCode } = await conclude(rig);
    const summary = await rig.session().closed;
    await waitUntilGone(leader as number);
    return [
      check('the revocation was the cause', summary.cause === 'authorization-revoked'),
      check('cleanup was complete', cleanup.outcome === 'complete'),
      check('the slot is not quarantined', !summary.quarantined),
      check('the process is gone', !isAlive(leader as number)),
      check('the transport closed normally', closeCode === 1000),
    ];
  },
};

const serverShutdown: CaseDefinition = {
  id: 'server-shutdown',
  modes: ['pipe', 'pty'],
  launch: () => ({ profile: shellProfile(SLEEPER) }),
  async run({ rig }) {
    await rig.client.handshake();
    const { leader } = pidsIn(await rig.client.waitForOutput(/leader=\d+ /));
    await rig.shutdown();
    const { cleanup, closeCode } = await conclude(rig);
    const summary = await rig.session().closed;
    await waitUntilGone(leader as number);
    return [
      check('the host disposed of the session', summary.cause !== 'process-exit'),
      check('cleanup was complete', cleanup.outcome === 'complete'),
      check('the process is gone', !isAlive(leader as number)),
      check('the transport closed', closeCode !== undefined),
    ];
  },
};

const staleGeneration: CaseDefinition = {
  id: 'stale-generation',
  modes: ['pipe', 'pty'],
  launch: () => ({ profile: shellProfile(CAT), acceptsInput: true }),
  async run({ rig, mode }) {
    const capabilities = await rig.client.handshake();
    await rig.client.waitForOutput('ready ');
    const generation = capabilities.attachmentGeneration;
    const before = rig.client.frames.length;
    rig.client.send(forgeInput(generation + 1, 1, 'stale'));
    rig.client.send(forgeInput(generation, 1, 'foreign', SECOND_SESSION_IDENTIFIER));
    await rig.client.waitForFrames(before + 2);
    const refusals = refusalCodes(rig.client.frames.slice(before));
    rig.client.sendResult(rig.client.endpoint.input('current\n'));
    await rig.client.waitForOutput('current');
    const text = textOn(rig.client.messages, channelFor(mode));
    rig.client.sendResult(rig.client.endpoint.terminate());
    const { cleanup } = await conclude(rig);
    return [
      check(
        'both stale messages were refused as stale-generation',
        refusals.length === 2 && refusals.every((code) => code === 'stale-generation'),
      ),
      check('neither reached the process', !text.includes('stale') && !text.includes('foreign')),
      check('the attachment stayed live for the current generation', text.includes('current')),
      check('cleanup was complete', cleanup.outcome === 'complete'),
    ];
  },
};

const readOnlyGrant: CaseDefinition = {
  id: 'read-only-grant',
  modes: ['pipe', 'pty'],
  launch: () => ({
    profile: shellProfile(CAT),
    acceptsInput: true,
    rig: { grant: 'read-only' },
  }),
  async run({ rig, mode }) {
    const capabilities = await rig.client.handshake();
    await rig.client.waitForOutput('ready ');
    const refused = rig.client.endpoint.input('typed');
    // A read-only peer that sends input anyway has broken the contract it was told: the host
    // ends its attachment instead of queueing or ignoring the bytes.
    rig.client.send(forgeInput(capabilities.attachmentGeneration, 1, 'forged'));
    const { cleanup, closeCode } = await conclude(rig);
    const summary = await rig.session().closed;
    const text = textOn(rig.client.messages, channelFor(mode));
    return [
      check(
        'the server derived a read-only attachment from the grant',
        capabilities.capabilities.readOnly && !capabilities.capabilities.input,
      ),
      check('the client cannot build input', !refused.ok),
      check(
        'a forged input frame ended the attachment as a violation',
        summary.cause === 'protocol-failure',
      ),
      check('the forged bytes never reached the process', !text.includes('forged')),
      check('cleanup was complete', cleanup.outcome === 'complete'),
      check('the transport was closed with a protocol code, not normally', closeCode === 1002),
    ];
  },
};

const BACKLOG_BYTES = 512 * 1024;

const stopUnderBacklog: CaseDefinition = {
  id: 'stop-under-held-burst',
  modes: ['pipe', 'pty'],
  launch: (mode) => ({
    profile: outputProfile(
      mode,
      `printf 'leader=%s ' "$$"; head -c ${BACKLOG_BYTES} /dev/zero | tr '\\0' a; exec sleep 7919`,
    ),
  }),
  async run({ rig }) {
    // The consumer holds half a budget of unparsed output, and then the user presses stop.
    rig.pauseConsuming();
    await rig.client.handshake();
    const { leader } = pidsIn(await rig.client.waitForOutput(/leader=\d+ /));
    while (rig.client.endpoint.outputBytes.received < BACKLOG_BYTES) {
      await rig.client.waitForFrames(rig.client.frames.length + 1);
    }
    const held = rig.client.endpoint.outputBytes;
    rig.client.sendResult(rig.client.endpoint.terminate());
    const { cleanup, closeCode } = await conclude(rig);
    const summary = await rig.session().closed;
    await waitUntilGone(leader as number);
    return [
      check(
        `the backlog was held unparsed, under the queue budget (${held.received} of ${DEFAULT_SESSION_BUDGETS.outputQueueBytes} bytes)`,
        held.received >= BACKLOG_BYTES &&
          held.consumed === 0 &&
          held.received <= DEFAULT_SESSION_BUDGETS.outputQueueBytes,
      ),
      check(
        'the stop was honored at once, not queued behind the output',
        summary.cause === 'attachment-stop',
      ),
      check('cleanup was complete', cleanup.outcome === 'complete'),
      check(
        'the bytes never parsed are reported as truncated, not lost silently',
        summary.drain.state === 'truncated' && summary.drain.unavailableBytes > 0,
      ),
      check('the producer is gone', !isAlive(leader as number)),
      check('the transport closed normally', closeCode === 1000),
    ];
  },
};

const outputOverflow: CaseDefinition = {
  id: 'output-overflow',
  modes: ['pipe', 'pty'],
  launch: () => ({ profile: shellProfile(ENDLESS_OUTPUT) }),
  async run({ rig }) {
    // A consumer that never reports a chunk parsed, as a hidden or hung page never does.
    rig.pauseConsuming();
    await rig.client.handshake();
    const { leader } = pidsIn(await rig.client.waitForOutput(/leader=\d+ /));
    const { cleanup, closeCode } = await conclude(rig);
    const summary = await rig.session().closed;
    await waitUntilGone(leader as number);
    const { received, consumed } = rig.client.endpoint.outputBytes;
    return [
      check(
        `output stopped at the queue budget (${received} of ${DEFAULT_SESSION_BUDGETS.outputQueueBytes} bytes unparsed)`,
        received <= DEFAULT_SESSION_BUDGETS.outputQueueBytes,
      ),
      check('the budget was actually reached, not stopped early', received > 0 && consumed === 0),
      check('the failure is visible as the cause', summary.cause === 'output-overflow'),
      check(
        'the bytes it could not deliver are counted',
        summary.drain.state === 'truncated' && summary.drain.unavailableBytes > 0,
      ),
      check('cleanup is reported as incomplete, never complete', cleanup.outcome === 'incomplete'),
      check('the slot is quarantined', summary.quarantined),
      check('the producer is gone', !isAlive(leader as number)),
      check('the transport closed', closeCode !== undefined),
    ];
  },
};

const BULK_BYTES = 200_000;

const pausedConsumer: CaseDefinition = {
  id: 'paused-consumer-resumes',
  modes: ['pipe', 'pty'],
  launch: (mode) => ({
    profile: outputProfile(
      mode,
      `head -c ${BULK_BYTES} /dev/zero | tr '\\0' a; printf END; exit 0`,
    ),
  }),
  async run({ rig, mode }) {
    // A hidden tab: bytes arrive and are held, nothing is reported parsed until the tab is shown again.
    rig.pauseConsuming();
    await rig.client.handshake();
    await rig.client.waitForOutput(/END$/);
    const heldBytes = rig.client.endpoint.outputBytes;
    const quiet = !rig.client.kinds().includes('cleanup-result');
    const openWhilePaused = !rig.session().snapshot.closed;
    rig.resumeConsuming();
    await rig.client.waitForKind('process-exit');
    const { cleanup, closeCode } = await conclude(rig);
    const text = textOn(rig.client.messages, channelFor(mode));
    return [
      check(
        `every byte was held while nothing was parsed (${heldBytes.received} received, ${heldBytes.consumed} parsed)`,
        heldBytes.received === BULK_BYTES + 3 && heldBytes.consumed === 0,
      ),
      check('the session waited for the consumer instead of closing', quiet && openWhilePaused),
      check('resuming released everything, in order', text === 'a'.repeat(BULK_BYTES) + 'END'),
      check('cleanup was complete', cleanup.outcome === 'complete'),
      check('the transport closed normally', closeCode === 1000),
    ];
  },
};

const IDLE_STEPS = 6;

const idleConsumer: CaseDefinition = {
  id: 'idle-consumer-liveness',
  modes: ['pipe', 'pty'],
  launch: () => ({ profile: shellProfile(SLEEPER) }),
  async run({ rig }) {
    // A viewer that sends nothing and parses nothing, answering only the transport's liveness probe.
    rig.pauseConsuming();
    await rig.client.handshake();
    const { leader } = pidsIn(await rig.client.waitForOutput(/leader=\d+ /));
    await rig.keepAlive(IDLE_STEPS);
    const survived = rig.session().snapshot.connection.kind === 'attached';
    // Silence: no probe is answered within the deadline, so the attachment expires.
    rig.clock.advance(DEFAULT_SESSION_BUDGETS.livenessDeadlineMilliseconds);
    const { cleanup } = await conclude(rig);
    const summary = await rig.session().closed;
    await waitUntilGone(leader as number);
    return [
      check(
        `the idle viewer outlived the liveness deadline (${IDLE_STEPS * 10} s of probes against ${DEFAULT_SESSION_BUDGETS.livenessDeadlineMilliseconds / 1000} s)`,
        IDLE_STEPS * 10_000 > DEFAULT_SESSION_BUDGETS.livenessDeadlineMilliseconds && survived,
      ),
      check('silence expired it', summary.cause === 'liveness-expired'),
      check('cleanup was complete', cleanup.outcome === 'complete'),
      check('the process is gone', !isAlive(leader as number)),
    ];
  },
};

const lostAcknowledgement: CaseDefinition = {
  id: 'lost-acknowledgement',
  modes: ['scripted'],
  launch: () => ({ profile: shellProfile('true'), scripted: scriptedProcess() }),
  async run({ rig, scripted }) {
    const process = scripted!;
    await rig.client.handshake();
    process.stallWrites();
    rig.client.sendResult(rig.client.endpoint.input('once'));
    await rig.client.waitForKind('operation-ack');
    await process.writes(1);
    // The backend never settles the write; the deadline passes on the fake clock and nothing else does.
    rig.clock.advance(DEFAULT_SESSION_BUDGETS.inputAcknowledgementDeadlineMilliseconds);
    const failure = await rig.client.waitForKind('operation-failure');
    const writesAtDeadline = process.written.length;
    rig.client.sendResult(rig.client.endpoint.terminate());
    const { cleanup } = await conclude(rig);
    process.releaseWrites();
    return [
      check(
        'the accepted write was reported as failed, not as success',
        failure.operationSequence > 0,
      ),
      check(
        'it was submitted exactly once, then never retried',
        writesAtDeadline === 1 && process.written.length === 1,
      ),
      check('the session ended with a reported cleanup', cleanup.outcome === 'complete'),
    ];
  },
};

const fifoReserve: CaseDefinition = {
  id: 'fifo-full-keeps-control-capacity',
  modes: ['scripted'],
  launch: () => ({
    profile: shellProfile('true'),
    scripted: scriptedProcess(),
    budgets: { operationQueueLimit: 4 },
  }),
  async run({ rig, scripted }) {
    const process = scripted!;
    await rig.client.handshake();
    process.stallWrites();
    // One write in flight and four queued fill the FIFO; the sixth finds no room.
    for (const text of ['a', 'b', 'c', 'd', 'e']) {
      const from = rig.client.messages.length;
      rig.client.sendResult(rig.client.endpoint.input(text));
      await rig.client.waitFor((message) => message.kind === 'operation-ack', from);
    }
    const from = rig.client.messages.length;
    rig.client.sendResult(rig.client.endpoint.input('f'));
    const refused = await rig.client.waitFor(
      (message) => message.kind === 'operation-failure',
      from,
    );
    // The control path still answers: stop is admitted on reserved capacity and cleans up.
    rig.client.sendResult(rig.client.endpoint.terminate());
    const { cleanup } = await conclude(rig);
    process.releaseWrites();
    return [
      check(
        'the full FIFO refused the next operation visibly',
        refused.kind === 'operation-failure' && refused.code === 'fifo-full',
      ),
      check('stop was still honored on reserved control capacity', cleanup.outcome === 'complete'),
      check(
        'the refused operation never reached the backend',
        !process.written.some((bytes) => new TextDecoder().decode(bytes) === 'f'),
      ),
    ];
  },
};

const defaultCapacity: CaseDefinition = {
  id: 'default-operation-capacity',
  modes: ['scripted'],
  launch: () => ({ profile: shellProfile('true'), scripted: scriptedProcess() }),
  async run({ rig, scripted }) {
    const process = scripted!;
    await rig.client.handshake();
    process.stallWrites();
    // With the backend stalled nothing drains: one operation is in flight and the FIFO holds the rest.
    let accepted = 0;
    let refusal: ServerMessage | undefined;
    while (refusal === undefined && accepted <= 2 * DEFAULT_SESSION_BUDGETS.operationQueueLimit) {
      const from = rig.client.messages.length;
      rig.client.sendResult(rig.client.endpoint.input('k'));
      const answer = await rig.client.waitFor(
        (message) => message.kind === 'operation-ack' || message.kind === 'operation-failure',
        from,
      );
      if (answer.kind === 'operation-ack') accepted += 1;
      else refusal = answer;
    }
    const writesInFlight = process.written.length;
    rig.client.sendResult(rig.client.endpoint.terminate());
    const { cleanup } = await conclude(rig);
    process.releaseWrites();
    return [
      check(
        `the FIFO took ${accepted} operations before refusing: ${DEFAULT_SESSION_BUDGETS.operationQueueLimit} queued and one in flight`,
        accepted === DEFAULT_SESSION_BUDGETS.operationQueueLimit + 1 && writesInFlight === 1,
      ),
      check(
        'the next was refused visibly as fifo-full',
        refusal?.kind === 'operation-failure' && refusal.code === 'fifo-full',
      ),
      check('stop was honored on reserved capacity', cleanup.outcome === 'complete'),
    ];
  },
};

const inputOverBudget: CaseDefinition = {
  id: 'input-over-budget',
  modes: ['scripted'],
  launch: () => ({
    profile: shellProfile('true'),
    scripted: scriptedProcess(),
    budgets: { inputQueueBytes: 1024 },
  }),
  async run({ rig, scripted }) {
    const process = scripted!;
    await rig.client.handshake();
    process.stallWrites();
    rig.client.sendResult(rig.client.endpoint.input('x'.repeat(700)));
    await rig.client.waitForKind('operation-ack');
    const from = rig.client.messages.length;
    rig.client.sendResult(rig.client.endpoint.input('y'.repeat(700)));
    const refused = await rig.client.waitFor(
      (message) => message.kind === 'operation-failure',
      from,
    );
    rig.client.sendResult(rig.client.endpoint.terminate());
    const { cleanup } = await conclude(rig);
    process.releaseWrites();
    return [
      check(
        'the over-budget input was refused visibly',
        refused.kind === 'operation-failure' && refused.code === 'fifo-full',
      ),
      check(
        'only the first input reached the backend',
        process.written.length <= 1 && process.written.every((bytes) => bytes.length === 700),
      ),
      check('cleanup was complete', cleanup.outcome === 'complete'),
    ];
  },
};

export const FAULT_CASES: readonly CaseDefinition[] = [
  authorityExpiry,
  serverShutdown,
  staleGeneration,
  readOnlyGrant,
  stopUnderBacklog,
  outputOverflow,
  pausedConsumer,
  idleConsumer,
  lostAcknowledgement,
  fifoReserve,
  defaultCapacity,
  inputOverBudget,
];
