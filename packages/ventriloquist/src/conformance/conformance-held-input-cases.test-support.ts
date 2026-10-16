import { closeSync, openSync } from 'node:fs';
import { join } from 'node:path';

import { SCENARIO_HANG_GUARD_MILLISECONDS } from '@lostgradient/testing';

import { shellProfile } from '../bun/fixtures/bun-pipe-stdin.ts';
import type { ServerMessage } from '../protocol/messages.ts';
import {
  channelFor,
  conclude,
  type CaseDefinition,
  type CaseLaunch,
} from './conformance-cases.test-support.ts';
import { check, type Check, type ProcessMode, type Rig } from './conformance.test-support.ts';

/** One paste: large enough to fill a terminal's input queue, and under the 65,536-byte paste limit. */
const PASTE_BYTES = 60_000;
/**
 * A pipe takes what its kernel buffer holds (64 KiB, less on macOS until a large write grows it)
 * before a write waits, so it needs one or two pastes before one is held; a terminal holds the
 * first. This bounds how many a cell sends, and what the host may have accepted by then: the
 * kernel's buffer and one write in flight, which the 64 KiB input budget bounds.
 */
const MAXIMUM_PASTES = 4;
const ACCEPTED_AT_MOST = 2 * 65_536;
const FINAL_MARKER = 'END';

let launches = 0;

/**
 * A child that is not reading its input until something is written to a named pipe, then copies it
 * to its output. It waits in `read`, which forks nothing: a polling loop forks a `sleep` every few
 * milliseconds, and a process created while cleanup sweeps the session is a descendant it cannot
 * prove gone, which reports cleanup `unknown` for a reason that has nothing to do with held input. A
 * terminal is put in raw mode first, so the line discipline neither echoes nor edits what arrives
 * and the output is exactly the input; in canonical mode the kernel discards what overflows instead
 * of holding the writer back.
 */
function nonReadingChild(mode: ProcessMode, scratch: string): CaseLaunch {
  const gate = join(scratch, `release-held-input-${launches++}`);
  const made = Bun.spawnSync(['mkfifo', gate], { timeout: SCENARIO_HANG_GUARD_MILLISECONDS });
  if (made.exitCode !== 0) throw new Error('mkfifo failed');
  const prepare = mode === 'pty' ? 'stty raw -echo; ' : '';
  return {
    profile: shellProfile(`${prepare}printf ready; read -r _ < "$1"; exec cat`, [gate]),
    acceptsInput: true,
    state: gate,
    rig: { lifetimeMilliseconds: 600_000 },
  };
}

const gateOf = (launched: CaseLaunch): string => launched.state as string;

/** A paste whose every byte differs from its neighbours, so a lost, repeated or reordered one shows. */
function pasteNumber(index: number): string {
  let text = '';
  for (let offset = 0; offset < PASTE_BYTES; offset += 1) {
    text += String.fromCharCode(97 + ((index * 7 + offset * 13 + (offset >> 5)) % 26));
  }
  return text;
}

type Answer = Extract<ServerMessage, { kind: 'operation-ack' | 'operation-failure' }>;

/** Offer `input` and wait for the host's answer to that one operation. */
async function offer(rig: Rig, input: Parameters<Rig['client']['endpoint']['input']>[0]) {
  const sent = rig.client.endpoint.input(input);
  rig.client.sendResult(sent);
  const sequence = (sent as { value: { sequence: number } }).value.sequence;
  const answer = await rig.client.waitFor<Answer>(
    (message) =>
      (message.kind === 'operation-ack' || message.kind === 'operation-failure') &&
      message.operationSequence === sequence,
  );
  return answer;
}

const refusedAsHeld = (answer: Answer): boolean =>
  answer.kind === 'operation-failure' &&
  answer.code === 'fifo-full' &&
  answer.message === 'input-held';

/**
 * Paste until the host says input is held, and return how many bytes it accepted. The empty input
 * is the capacity probe the client sends: accepted exactly when the host has room.
 */
async function pasteUntilHeld(
  rig: Rig,
): Promise<{ readonly accepted: number; readonly held: boolean }> {
  let pastes = 0;
  let held = false;
  while (!held && pastes < MAXIMUM_PASTES) {
    const pasted = await offer(rig, pasteNumber(pastes));
    const probe = await offer(rig, new Uint8Array(0));
    pastes += 1;
    held = pasted.kind === 'operation-ack' && refusedAsHeld(probe);
  }
  return { accepted: pastes * PASTE_BYTES, held };
}

function expectedOutput(pastes: number): string {
  let text = 'ready';
  for (let index = 0; index < pastes; index += 1) text += pasteNumber(index);
  return text;
}

async function outputReaches(rig: Rig, length: number): Promise<void> {
  while (rig.client.outputText().length < length) {
    await rig.client.waitForFrames(rig.client.frames.length + 1);
  }
}

/** Offer `input` until the host accepts it: the view is writable again. */
async function untilAccepted(rig: Rig, input: string): Promise<boolean> {
  let accepted = false;
  for (let attempt = 0; attempt < 500 && !accepted; attempt += 1) {
    const answer = await offer(rig, input);
    accepted = answer.kind === 'operation-ack';
    // Give the held write a turn to finish before asking again.
    await Bun.sleep(0);
  }
  return accepted;
}

/** Nothing in the conversation says the input failed: no attachment error, no submitted-operation failure. */
function noFailure(messages: readonly ServerMessage[]): boolean {
  return messages.every(
    (message) =>
      message.kind !== 'attachment-error' &&
      message.kind !== 'process-exit' &&
      (message.kind !== 'operation-failure' || message.code === 'fifo-full'),
  );
}

/** Bring a rig to the point where the host reports input held, without failing, long past the deadline. */
async function holdInput(rig: Rig): Promise<{ checks: Check[]; pastes: number }> {
  await rig.client.handshake();
  await rig.client.waitForOutput('ready');
  const { accepted, held } = await pasteUntilHeld(rig);
  // Far past the 2 s acknowledgement deadline, with the peer answering every ping.
  await rig.keepAlive(1);
  const stillOpen = !rig.session().snapshot.closed && noFailure(rig.client.messages);
  const probe = await offer(rig, 'x');
  const resize = await refusedResize(rig);
  return {
    pastes: accepted / PASTE_BYTES,
    checks: [
      check(`the host reported input held after ${accepted} accepted bytes`, held),
      check(
        `no more than the kernel buffer and one budget was accepted (${accepted} of ${ACCEPTED_AT_MOST} bytes)`,
        accepted <= ACCEPTED_AT_MOST,
      ),
      check('the session did not fail once the acknowledgement deadline had passed', stillOpen),
      check('new input was refused as held', refusedAsHeld(probe)),
      check('a resize was refused as held', resize),
    ],
  };
}

/** A terminal's resize while held; a pipe has no resize to refuse. */
async function refusedResize(rig: Rig): Promise<boolean> {
  if (rig.mode === 'pipe') return true;
  const sent = rig.client.endpoint.resize(100, 40);
  rig.client.sendResult(sent);
  const sequence = (sent as { value: { sequence: number } }).value.sequence;
  const answer = await rig.client.waitFor<Answer>(
    (message) =>
      (message.kind === 'operation-ack' || message.kind === 'operation-failure') &&
      message.operationSequence === sequence,
  );
  return refusedAsHeld(answer);
}

const heldInputBackpressure: CaseDefinition = {
  id: 'held-input-backpressure',
  comparable: false,
  scope:
    'the two paths are not compared: a pipe needs a second paste on a host whose pipe buffer takes the first whole, which varies by host',
  modes: ['pipe', 'pty'],
  launch: (mode, scratch) => nonReadingChild(mode, scratch),
  async run({ rig, launched, mode }) {
    const held = await holdInput(rig);
    const refusals = rig.client.messages.filter((message) => message.kind === 'operation-failure');
    // Opening the named pipe for writing waits for the child's read, then the child reads end of file.
    closeSync(openSync(gateOf(launched), 'w'));
    const expected = expectedOutput(held.pastes);
    await outputReaches(rig, expected.length);
    const writable = await untilAccepted(rig, FINAL_MARKER);
    await outputReaches(rig, expected.length + FINAL_MARKER.length);
    const text = rig.client.outputText();
    const channel = channelFor(mode);
    const onOneChannel = rig.client.messages
      .filter((message) => message.kind === 'output')
      .every((message) => message.channel === channel);
    rig.client.sendResult(rig.client.endpoint.terminate());
    const { cleanup, closeCode } = await conclude(rig);
    return [
      ...held.checks,
      check('input was refused, never queued behind the held write', refusals.length >= 2),
      check(
        `every accepted byte arrived exactly once and in order (${expected.length - 5} bytes)`,
        text === expected + FINAL_MARKER,
      ),
      check('the output came on the one channel the mode carries', onOneChannel),
      check('the host accepted input again without a new session', writable),
      check('cleanup was complete', cleanup.outcome === 'complete'),
      check('the transport closed normally', closeCode === 1000),
    ];
  },
};

/** The operations the host reported as unknown delivery. */
const unknownDelivery = (messages: readonly ServerMessage[]): ServerMessage[] =>
  messages.filter(
    (message) => message.kind === 'operation-failure' && message.code === 'transport-failed',
  );

const stopWhileHeld: CaseDefinition = {
  id: 'stop-while-input-held',
  comparable: false,
  scope: 'the two paths are not compared: see held-input-backpressure',
  modes: ['pipe', 'pty'],
  launch: (mode, scratch) => nonReadingChild(mode, scratch),
  async run({ rig }) {
    const held = await holdInput(rig);
    rig.client.sendResult(
      rig.client.endpoint.terminate() satisfies ReturnType<Rig['client']['endpoint']['terminate']>,
    );
    const { cleanup } = await conclude(rig);
    const summary = await rig.session().closed;
    return [
      ...held.checks,
      check('stop was honored while input was held', summary.cause === 'attachment-stop'),
      check(
        'the held write was reported as unknown delivery',
        unknownDelivery(rig.client.messages).length === 1,
      ),
      check('cleanup was complete', cleanup.outcome === 'complete'),
    ];
  },
};

const revokeWhileHeld: CaseDefinition = {
  id: 'revoke-while-input-held',
  comparable: false,
  scope: 'the two paths are not compared: see held-input-backpressure',
  modes: ['pipe', 'pty'],
  launch: (mode, scratch) => ({
    ...nonReadingChild(mode, scratch),
    rig: { lifetimeMilliseconds: 20_000 },
  }),
  async run({ rig }) {
    const held = await holdInput(rig);
    await rig.expireAuthority();
    const { cleanup } = await conclude(rig);
    const summary = await rig.session().closed;
    return [
      ...held.checks,
      check('the revocation was the cause', summary.cause === 'authorization-revoked'),
      check('input is frozen', rig.client.endpoint.authorityRevoked),
      check(
        'the held write was reported as unknown delivery',
        unknownDelivery(rig.client.messages).length === 1,
      ),
      check('cleanup was complete', cleanup.outcome === 'complete'),
    ];
  },
};

export const HELD_INPUT_CASES: readonly CaseDefinition[] = [
  heldInputBackpressure,
  stopWhileHeld,
  revokeWhileHeld,
];
