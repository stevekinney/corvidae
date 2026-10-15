import { closeSync, openSync } from 'node:fs';

import { isAlive, waitUntilGone } from '../bun/bun-process.test-support.ts';
import { shellProfile } from '../bun/fixtures/bun-pipe-stdin.ts';
import { OUTPUT_CASES, outputProfile, pidsIn } from '../bun/fixtures/terminal-output.ts';
import { MAXIMUM_FRAME_PAYLOAD_BYTES } from '../protocol/protocol-constants.ts';
import { ManualClock } from '../session/fixtures/manual-clock.ts';
import { DEFAULT_SESSION_BUDGETS } from '../session/session-types.ts';
import { forgeInput, scriptedProcess } from '../websocket/websocket.test-support.ts';
import {
  channelFor,
  conclude,
  textOn,
  type CaseDefinition,
} from './conformance-cases.test-support.ts';
import { settledDescriptorCount } from './conformance-leak-cases.test-support.ts';
import { check, openDescriptorCount } from './conformance.test-support.ts';

const CAT_WITH_PID = 'printf \'leader=%s \' "$$"; exec cat';
const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

/**
 * The controls. Each one makes a failure the suite is supposed to detect actually happen, so a
 * green result elsewhere cannot be a harness that detects nothing. They run in the same matrix,
 * on both paths, and the report records them before any other cell is read.
 */
const corruptedFrame: CaseDefinition = {
  id: 'control-corrupted-frame',
  modes: ['pipe', 'pty'],
  launch: () => ({ profile: shellProfile(CAT_WITH_PID), acceptsInput: true }),
  async run({ rig }) {
    const capabilities = await rig.client.handshake();
    const { leader } = pidsIn(await rig.client.waitForOutput(/leader=\d+ /));
    const good = forgeInput(capabilities.attachmentGeneration, 1, 'x');
    const corrupted = new Uint8Array(good);
    // The first header byte is the protocol version; no valid frame carries this one.
    corrupted[0] = 0xff;
    rig.client.send(corrupted);
    const { cleanup, closeCode } = await conclude(rig);
    const summary = await rig.session().closed;
    await waitUntilGone(leader as number);
    return [
      check(
        'corrupted bytes ended the attachment as a protocol failure',
        summary.cause === 'protocol-failure',
      ),
      check('the transport was closed with the protocol code', closeCode === 1002),
      check('cleanup was complete', cleanup.outcome === 'complete'),
      check('the process is gone', !isAlive(leader as number)),
    ];
  },
};

/** A binary input frame whose header names `length` payload bytes, which the encoder itself refuses to build. */
function oversizedInput(generation: number, length: number): Uint8Array {
  const header = forgeInput(generation, 1, 'x').slice(0, 40);
  const frame = new Uint8Array(40 + length);
  frame.set(header);
  new DataView(frame.buffer).setUint32(36, length);
  return frame;
}

const oversizedFrame: CaseDefinition = {
  id: 'control-over-budget-frame',
  modes: ['pipe', 'pty'],
  // A socket refuses the frame before the session sees it, so the cleanup result cannot follow it.
  comparable: false,
  launch: () => ({ profile: shellProfile(CAT_WITH_PID), acceptsInput: true }),
  async run({ rig, path }) {
    const capabilities = await rig.client.handshake();
    const { leader } = pidsIn(await rig.client.waitForOutput(/leader=\d+ /));
    rig.client.send(
      oversizedInput(capabilities.attachmentGeneration, MAXIMUM_FRAME_PAYLOAD_BYTES + 1),
    );
    const closeCode = await rig.closeCode();
    const summary = await rig.session().closed;
    await waitUntilGone(leader as number);
    return [
      // Past the socket's own ceiling Bun drops the connection, which a client observes as 1006.
      check(
        'a frame over the budget closed the transport as too large',
        closeCode === 1009 || (path === 'websocket' && closeCode === 1006),
      ),
      check('the attachment was ended and cleanup was complete', summary.cleanup === 'complete'),
      check('the process is gone', !isAlive(leader as number)),
    ];
  },
};

const byteComparison: CaseDefinition = {
  id: 'control-byte-comparison',
  modes: ['pipe', 'pty'],
  launch: (mode) => ({ profile: outputProfile(mode, OUTPUT_CASES.noNewlineOutput.body) }),
  async run({ rig, mode }) {
    await rig.client.handshake();
    await rig.client.waitForKind('process-exit');
    await conclude(rig);
    const received = textOn(rig.client.messages, channelFor(mode));
    const expected = OUTPUT_CASES.noNewlineOutput.output;
    // The comparison every byte-delivery cell relies on, shown to fail when one byte differs.
    const corrupted = `${expected.slice(0, -1)}${String.fromCharCode(expected.charCodeAt(expected.length - 1) ^ 1)}`;
    return [
      check('the real output equals the expected bytes', received === expected),
      check('a copy with one byte altered is not equal', received !== corrupted),
      check(
        'and has the same length, so only the content differs',
        corrupted.length === expected.length,
      ),
    ];
  },
};

function quarantineCase(outcome: 'unknown' | 'incomplete'): CaseDefinition {
  return {
    id: `control-${outcome}-cleanup`,
    modes: ['scripted'],
    launch: () => ({
      profile: shellProfile('true'),
      scripted: scriptedProcess({ cleanup: outcome }),
    }),
    async run({ rig }) {
      await rig.client.handshake();
      rig.client.sendResult(rig.client.endpoint.terminate());
      const { cleanup } = await conclude(rig);
      const summary = await rig.session().closed;
      return [
        check(`the host reported ${outcome}, never complete`, cleanup.outcome === outcome),
        check('the slot is quarantined', summary.quarantined),
      ];
    },
  };
}

const missingParseCompletion: CaseDefinition = {
  id: 'control-missing-parse-completion',
  modes: ['scripted'],
  launch: () => ({ profile: shellProfile('true'), scripted: scriptedProcess() }),
  async run({ rig, scripted }) {
    const process = scripted!;
    // A consumer that receives output and never reports it parsed.
    rig.pauseConsuming();
    await rig.client.handshake();
    process.stream.push(new TextEncoder().encode('hello'));
    await rig.client.waitForOutput('hello');
    process.stream.end();
    process.exit(0);
    await rig.observed.exitRecorded;
    // The natural close waits for the parse report; only the fake clock's deadline ends the wait.
    const waiting = !rig.session().snapshot.closed;
    rig.clock.advance(DEFAULT_SESSION_BUDGETS.cleanupDeadlineMilliseconds);
    const { cleanup } = await conclude(rig);
    const summary = await rig.session().closed;
    return [
      check('the session waited rather than closing over unparsed output', waiting),
      check('the deadline ended the wait', summary.cause === 'process-exit'),
      check(
        'the unparsed bytes are reported as truncated',
        summary.drain.state === 'truncated' && summary.drain.unavailableBytes === 5,
      ),
      check('cleanup was complete', cleanup.outcome === 'complete'),
    ];
  },
};

const lateCallback: CaseDefinition = {
  id: 'control-late-callback-after-close',
  modes: ['scripted'],
  launch: () => ({ profile: shellProfile('true'), scripted: scriptedProcess() }),
  async run({ rig, scripted }) {
    const process = scripted!;
    await rig.client.handshake();
    rig.client.sendResult(rig.client.endpoint.terminate());
    await conclude(rig);
    await rig.session().closed;
    const settled = rig.client.messages.length;
    const bytes = rig.client.endpoint.outputBytes.received;
    // The producer is not told the session ended, and writes anyway.
    process.stream.push(new TextEncoder().encode('too late'));
    process.exit(0);
    await rig.observed.exitRecorded;
    await Bun.sleep(0);
    return [
      check(
        'nothing was delivered after the session closed',
        rig.client.messages.length === settled,
      ),
      check('no late byte was counted', rig.client.endpoint.outputBytes.received === bytes),
      check(
        'the late text never reached the client',
        !rig.client.outputText().includes('too late'),
      ),
    ];
  },
};

const revokedDuringPaste: CaseDefinition = {
  id: 'control-revoked-input-during-paste',
  modes: ['scripted'],
  launch: () => ({
    profile: shellProfile('true'),
    scripted: scriptedProcess(),
    // Shorter than the liveness deadline, so the lifetime ending is what revokes on a socket too.
    rig: { lifetimeMilliseconds: 20_000 },
  }),
  async run({ rig, scripted }) {
    const process = scripted!;
    await rig.client.handshake();
    process.stallWrites();
    // A paste in three 16 KiB parts: the first is mid-write when the authority is withdrawn.
    for (const part of ['a', 'b', 'c']) {
      const from = rig.client.messages.length;
      rig.client.sendResult(rig.client.endpoint.input(part.repeat(16 * 1024)));
      await rig.client.waitFor((message) => message.kind === 'operation-ack', from);
    }
    await process.writes(1);
    await rig.expireAuthority();
    const { cleanup } = await conclude(rig);
    const summary = await rig.session().closed;
    const writesAtRevocation = process.written.length;
    process.releaseWrites();
    await Bun.sleep(0);
    const failed = rig.client.messages.filter((message) => message.kind === 'operation-failure');
    return [
      check(
        'the withdrawn authority, not a missed heartbeat, ended it',
        summary.cause === 'authorization-revoked',
      ),
      check(
        'only the part already mid-write reached the backend',
        writesAtRevocation === 1 && decode(process.written[0] as Uint8Array)[0] === 'a',
      ),
      check('the rest of the paste was canceled, visibly', failed.length >= 2),
      check(
        'nothing was written after the revocation, even once the backend resumed',
        process.written.length === 1,
      ),
      check('cleanup was complete', cleanup.outcome === 'complete'),
    ];
  },
};

const leakDetectors: CaseDefinition = {
  id: 'control-leak-detectors',
  modes: ['scripted'],
  launch: () => ({ profile: shellProfile('true'), scripted: scriptedProcess() }),
  async run({ rig }) {
    await rig.client.handshake();
    // Each detector the other cells rely on, shown to see a leak when one is made and to go quiet when it is released.
    const timers = new ManualClock();
    let fired = 0;
    const fire = (weight: number) => () => {
      fired += weight;
    };
    timers.schedule(fire(1), 1);
    const cancel = timers.schedule(fire(10), 1);
    const pending = timers.pendingTimers;
    cancel();
    timers.advance(1);
    const descriptorsBefore = openDescriptorCount();
    const descriptor = openSync('/dev/null', 'r');
    const descriptorsHeld = openDescriptorCount();
    // Waiting for a release must not hide a descriptor that is never released.
    const stillHeld = await settledDescriptorCount(descriptorsBefore, 3);
    closeSync(descriptor);
    const released = await settledDescriptorCount(descriptorsBefore, 3);
    const descriptorsAfter = openDescriptorCount();
    rig.client.sendResult(rig.client.endpoint.terminate());
    await conclude(rig);
    return [
      check(
        'pending timers are counted, a canceled one never fires, and none is left once due',
        pending === 2 && fired === 1 && timers.pendingTimers === 0,
      ),
      check('a held descriptor is counted', descriptorsHeld === descriptorsBefore + 1),
      check('a closed descriptor is no longer counted', descriptorsAfter === descriptorsBefore),
      check(
        'the wait for a release gives up on a descriptor that stays held',
        stillHeld.count === descriptorsHeld && stillHeld.turns === 3,
      ),
      check(
        'and ends on the first turn once it is released',
        released.count === descriptorsBefore && released.turns === 1,
      ),
      check('a running process is seen as alive', isAlive(globalThis.process.pid)),
      check('a process that does not exist is seen as gone', !isAlive(0x7ffffffe)),
    ];
  },
};

export const CONTROL_CASES: readonly CaseDefinition[] = [
  corruptedFrame,
  oversizedFrame,
  byteComparison,
  quarantineCase('unknown'),
  quarantineCase('incomplete'),
  missingParseCompletion,
  lateCallback,
  revokedDuringPaste,
  leakDetectors,
];
