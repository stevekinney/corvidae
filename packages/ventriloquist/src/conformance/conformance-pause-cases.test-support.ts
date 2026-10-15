import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { isAlive, waitUntilGone } from '../bun/bun-process.test-support.ts';
import { ENDLESS_OUTPUT, outputProfile, pidsIn } from '../bun/fixtures/terminal-output.ts';
import { DEFAULT_SESSION_BUDGETS } from '../session/session-types.ts';
import {
  bytesOn,
  channelFor,
  conclude,
  type CaseDefinition,
  type CaseLaunch,
} from './conformance-cases.test-support.ts';
import { check, type Check, type Rig } from './conformance.test-support.ts';

const BUDGET = DEFAULT_SESSION_BUDGETS.outputQueueBytes;
/** A file several times the budget, so that finishing it proves the host kept reading as the client parsed. */
const FLOOD_FILE_BYTES = 6 * 1024 * 1024;
/** How far the host's memory may grow while output many times the budget goes through it. */
const MEMORY_GROWTH_LIMIT_BYTES = 160 * 1024 * 1024;
/** The pump reads again only when this much room is free, so a full budget settles a little under the limit. */
const HELD_AT_LEAST_BYTES = BUDGET - 128 * 1024;

const floodFile = (scratch: string): string => join(scratch, 'flood.bin');

/** Bytes that make a lost, repeated or reordered stretch visible, written once per run. */
function writeFloodFile(scratch: string): string {
  const path = floodFile(scratch);
  const bytes = new Uint8Array(FLOOD_FILE_BYTES);
  for (let index = 0; index < bytes.length; index += 1)
    bytes[index] = (index * 31 + (index >> 8)) & 0xff;
  writeFileSync(path, bytes);
  return path;
}

/** Wait until the client has been sent `count` bytes of output, parsed or not. */
async function untilReceived(rig: Rig, count: number): Promise<void> {
  while (rig.client.endpoint.outputBytes.received < count) {
    await rig.client.waitForFrames(rig.client.frames.length + 1);
  }
}

/** Wait until no output has arrived for a few intervals in a row, and say how much had. */
async function untilQuiet(rig: Rig): Promise<number> {
  let last = -1;
  for (let quiet = 0; quiet < 4;) {
    await Bun.sleep(100);
    const now = rig.client.endpoint.outputBytes.received;
    quiet = now === last ? quiet + 1 : 0;
    last = now;
  }
  return last;
}

/** Start a consumer that has parsed nothing and let the budget fill; returns the producer's pid and what is held. */
async function fillBudget(rig: Rig): Promise<{ leader: number; held: number }> {
  rig.pauseConsuming();
  await rig.client.handshake();
  const { leader } = pidsIn(await rig.client.waitForOutput(/leader=\d+ /));
  await untilReceived(rig, HELD_AT_LEAST_BYTES);
  return { leader: leader as number, held: await untilQuiet(rig) };
}

const holdsTheBudget = (rig: Rig, held: number): Check =>
  check(
    `the budget filled and the host stopped reading (${held} of ${BUDGET} bytes held, none parsed)`,
    held >= HELD_AT_LEAST_BYTES &&
      held <= BUDGET &&
      rig.client.endpoint.outputBytes.consumed === 0 &&
      !rig.session().snapshot.closed,
  );

const floodYes: CaseDefinition = {
  id: 'flood-yes',
  modes: ['pipe', 'pty'],
  launch: (mode) => ({ profile: outputProfile(mode, ENDLESS_OUTPUT) }),
  async run({ rig, mode }) {
    const memoryBefore = process.memoryUsage().rss;
    await rig.client.handshake();
    const { leader } = pidsIn(await rig.client.waitForOutput(/leader=\d+ /));
    // Three budgets of output, with a consumer that parses each chunk as it arrives.
    await untilReceived(rig, 3 * BUDGET);
    const memoryGrowth = process.memoryUsage().rss - memoryBefore;
    const { received, consumed } = rig.client.endpoint.outputBytes;
    const stillOpen = !rig.session().snapshot.closed;
    const revoked = rig.client.endpoint.authorityRevoked;
    const text = new TextDecoder().decode(bytesOn(rig.client.messages, channelFor(mode)));
    const body = text.slice(text.indexOf(' ') + 1);
    rig.client.sendResult(rig.client.endpoint.terminate());
    const { cleanup, closeCode } = await conclude(rig);
    await waitUntilGone(leader as number);
    return [
      check(
        `${received} bytes went through without overflowing the budget`,
        received >= 3 * BUDGET && stillOpen && !revoked,
      ),
      check(
        `no more than the budget was ever unparsed at the end (${received - consumed} bytes)`,
        received - consumed <= BUDGET,
      ),
      check(
        `host memory stayed bounded (${Math.round(memoryGrowth / 1048576)} MiB growth)`,
        memoryGrowth < MEMORY_GROWTH_LIMIT_BYTES,
      ),
      check('only what the producer wrote arrived', /^[y\n]*$/.test(body)),
      check('cleanup was complete', cleanup.outcome === 'complete'),
      check('the producer is gone', !isAlive(leader as number)),
      check('the transport closed normally', closeCode === 1000),
    ];
  },
};

const floodCat: CaseDefinition = {
  id: 'flood-cat',
  modes: ['pipe', 'pty'],
  launch: (mode, scratch) => ({
    profile: outputProfile(mode, `cat '${writeFloodFile(scratch)}'`),
  }),
  async run({ rig, mode, scratch }) {
    const memoryBefore = process.memoryUsage().rss;
    await rig.client.handshake();
    await rig.client.waitForKind('process-exit');
    const { cleanup, closeCode } = await conclude(rig);
    const summary = await rig.session().closed;
    const memoryGrowth = process.memoryUsage().rss - memoryBefore;
    const received = bytesOn(rig.client.messages, channelFor(mode));
    const expected = readFileSync(floodFile(scratch));
    return [
      check(
        `every byte of ${expected.length} arrived, once and in order (${received.length} received)`,
        received.length === expected.length && Buffer.compare(received, expected) === 0,
      ),
      check(
        'the producer ended on its own, with nothing lost',
        summary.cause === 'process-exit' && summary.drain.state === 'drained',
      ),
      check(
        `host memory stayed bounded (${Math.round(memoryGrowth / 1048576)} MiB growth)`,
        memoryGrowth < MEMORY_GROWTH_LIMIT_BYTES,
      ),
      check('cleanup was complete', cleanup.outcome === 'complete'),
      check('the transport closed normally', closeCode === 1000),
    ];
  },
};

const BOTH_CHANNELS = 'printf \'leader=%s \' "$$"; yes out & yes err >&2 & wait';

const floodBothChannels: CaseDefinition = {
  id: 'flood-both-channels',
  modes: ['pipe'],
  scope:
    'pipe only: a terminal has one channel, so there is no second source to share the queue with',
  launch: (mode) => ({ profile: outputProfile(mode, BOTH_CHANNELS) }),
  async run({ rig }) {
    // A consumer that parses a little at a time, so releases free room in pieces and wake both sources together.
    rig.pauseConsuming();
    await rig.client.handshake();
    const { leader } = pidsIn(await rig.client.waitForOutput(/leader=\d+ /));
    let unharmed = true;
    for (let step = 0; step < 60; step += 1) {
      await Bun.sleep(20);
      const { received, consumed } = rig.client.endpoint.outputBytes;
      const owed = Math.min(received - consumed, 100_000);
      if (owed > 0) rig.client.sendResult(rig.client.endpoint.consumeOutput(owed));
      unharmed &&= !rig.client.endpoint.authorityRevoked && !rig.session().snapshot.closed;
    }
    const { received, consumed } = rig.client.endpoint.outputBytes;
    const text = (channel: 'stdout' | 'stderr') => bytesOn(rig.client.messages, channel);
    const stdout = text('stdout');
    const stderr = text('stderr');
    rig.client.sendResult(rig.client.endpoint.terminate());
    const { cleanup, closeCode } = await conclude(rig);
    await waitUntilGone(leader as number);
    return [
      check('neither channel overflowed the one queue they share', unharmed),
      check(
        `both channels kept moving (${stdout.length} bytes of stdout, ${stderr.length} of stderr)`,
        stdout.length > 100_000 && stderr.length > 100_000,
      ),
      check(
        `no more than the budget was unparsed (${received - consumed} bytes)`,
        received - consumed <= BUDGET,
      ),
      check('cleanup was complete', cleanup.outcome === 'complete'),
      check('the producers are gone', !isAlive(leader as number)),
      check('the transport closed normally', closeCode === 1000),
    ];
  },
};

const stalledConsumerPauses: CaseDefinition = {
  id: 'stalled-consumer-pauses',
  modes: ['pipe', 'pty'],
  launch: (mode) => ({ profile: outputProfile(mode, ENDLESS_OUTPUT) }),
  async run({ rig }) {
    const { leader, held } = await fillBudget(rig);
    const holds = holdsTheBudget(rig, held);
    const bytesWhenFull = rig.client.endpoint.outputBytes.received;
    await Bun.sleep(400);
    const stayedPut = rig.client.endpoint.outputBytes.received === bytesWhenFull;
    const producerAlive = isAlive(leader) && !rig.client.endpoint.authorityRevoked;
    // The consumer comes back: parsing what it holds is what lets the producer write again.
    rig.resumeConsuming();
    await untilReceived(rig, held + BUDGET);
    const flowed = rig.client.endpoint.outputBytes.received >= held + BUDGET;
    rig.client.sendResult(rig.client.endpoint.terminate());
    const { cleanup } = await conclude(rig);
    const summary = await rig.session().closed;
    await waitUntilGone(leader);
    return [
      holds,
      check('nothing more arrived while the consumer was stalled', stayedPut),
      check('the producer was paused, not ended or failed', producerAlive),
      check('it flowed again once the consumer parsed', flowed),
      check('the session ended only when asked', summary.cause === 'attachment-stop'),
      check('cleanup was complete', cleanup.outcome === 'complete'),
      check('the producer is gone', !isAlive(leader)),
    ];
  },
};

const stalledConsumerCompletes: CaseDefinition = {
  id: 'stalled-consumer-completes',
  modes: ['pipe', 'pty'],
  launch: (mode, scratch) => ({
    profile: outputProfile(mode, `cat '${writeFloodFile(scratch)}'`),
  }),
  async run({ rig, mode, scratch }) {
    rig.pauseConsuming();
    await rig.client.handshake();
    const held = await untilQuiet(rig);
    const heldWithoutExit = !rig.client.kinds().includes('process-exit');
    const pausedAt = { ...rig.client.endpoint.outputBytes };
    rig.resumeConsuming();
    await rig.client.waitForKind('process-exit');
    const { cleanup, closeCode } = await conclude(rig);
    const summary = await rig.session().closed;
    const received = bytesOn(rig.client.messages, channelFor(mode));
    const expected = readFileSync(floodFile(scratch));
    return [
      check(
        `the producer was held back by the stalled consumer (${held} of ${expected.length} bytes, none parsed)`,
        held > 0 &&
          held <= BUDGET &&
          held < expected.length &&
          pausedAt.consumed === 0 &&
          heldWithoutExit,
      ),
      check(
        `resuming completed the output byte for byte (${received.length} of ${expected.length})`,
        received.length === expected.length && Buffer.compare(received, expected) === 0,
      ),
      check(
        'nothing was lost to the pause',
        summary.cause === 'process-exit' && summary.drain.state === 'drained',
      ),
      check('cleanup was complete', cleanup.outcome === 'complete'),
      check('the transport closed normally', closeCode === 1000),
    ];
  },
};

const stopWhilePaused: CaseDefinition = {
  id: 'stop-while-paused',
  modes: ['pipe', 'pty'],
  launch: (mode) => ({ profile: outputProfile(mode, ENDLESS_OUTPUT) }),
  async run({ rig }) {
    const { leader, held } = await fillBudget(rig);
    const holds = holdsTheBudget(rig, held);
    const asked = performance.now();
    rig.client.sendResult(rig.client.endpoint.terminate());
    const { cleanup, closeCode } = await conclude(rig);
    const elapsed = performance.now() - asked;
    const summary = await rig.session().closed;
    await waitUntilGone(leader);
    return [
      holds,
      check(
        `stop was honored while paused (${Math.round(elapsed)} ms)`,
        summary.cause === 'attachment-stop' && elapsed < 4000,
      ),
      check('cleanup was complete', cleanup.outcome === 'complete'),
      check('the paused producer is gone', !isAlive(leader)),
      check('the transport closed normally', closeCode === 1000),
    ];
  },
};

const revokeWhilePaused: CaseDefinition = {
  id: 'revoke-while-paused',
  modes: ['pipe', 'pty'],
  launch: (mode) => ({
    profile: outputProfile(mode, ENDLESS_OUTPUT),
    rig: { lifetimeMilliseconds: 20_000 },
  }),
  async run({ rig }) {
    const { leader, held } = await fillBudget(rig);
    const holds = holdsTheBudget(rig, held);
    await rig.expireAuthority();
    const { cleanup, closeCode } = await conclude(rig);
    const summary = await rig.session().closed;
    await waitUntilGone(leader);
    return [
      holds,
      check('the revocation was the cause', summary.cause === 'authorization-revoked'),
      check('cleanup was complete', cleanup.outcome === 'complete'),
      check('the paused producer is gone', !isAlive(leader)),
      check('the transport closed normally', closeCode === 1000),
    ];
  },
};

const inputWhilePaused: CaseDefinition = {
  id: 'input-while-paused',
  modes: ['pipe', 'pty'],
  launch: (mode): CaseLaunch => ({
    profile: outputProfile(mode, ENDLESS_OUTPUT),
    acceptsInput: true,
  }),
  async run({ rig, mode }) {
    const { leader, held } = await fillBudget(rig);
    const holds = holdsTheBudget(rig, held);
    // A resize on a terminal, input on a pipe: control that must not queue behind output.
    const first =
      mode === 'pty' ? rig.client.endpoint.resize(100, 40) : rig.client.endpoint.input('x');
    rig.client.sendResult(first);
    const ack = await rig.client.waitForKind('operation-ack');
    rig.client.sendResult(rig.client.endpoint.input('y'));
    const second = await rig.client.waitFor(
      (message) => message.kind === 'operation-ack' && message.operationSequence === 2,
    );
    const stillHeld = rig.client.endpoint.outputBytes.received <= BUDGET;
    rig.client.sendResult(rig.client.endpoint.terminate());
    const { cleanup } = await conclude(rig);
    await waitUntilGone(leader);
    return [
      holds,
      check(
        'the first control operation was acknowledged while paused',
        ack.operationSequence === 1,
      ),
      check('the second was acknowledged too, in order', second.kind === 'operation-ack'),
      check('the budget stayed full throughout', stillHeld),
      check('cleanup was complete', cleanup.outcome === 'complete'),
    ];
  },
};

const cleanupKillsPaused: CaseDefinition = {
  id: 'cleanup-kills-paused-producer',
  modes: ['pipe', 'pty'],
  launch: (mode) => ({ profile: outputProfile(mode, ENDLESS_OUTPUT) }),
  async run({ rig }) {
    const { leader, held } = await fillBudget(rig);
    const holds = holdsTheBudget(rig, held);
    await rig.shutdown();
    const { cleanup, closeCode } = await conclude(rig);
    const summary = await rig.session().closed;
    await waitUntilGone(leader);
    return [
      holds,
      check('the host disposed of the paused session', summary.cause !== 'process-exit'),
      check('cleanup was complete', cleanup.outcome === 'complete'),
      check('the paused producer is gone', !isAlive(leader)),
      check('the slot is not quarantined', !summary.quarantined),
      check('the transport closed', closeCode !== undefined),
    ];
  },
};

export const PAUSE_CASES: readonly CaseDefinition[] = [
  floodYes,
  floodCat,
  floodBothChannels,
  stalledConsumerPauses,
  stalledConsumerCompletes,
  stopWhilePaused,
  revokeWhilePaused,
  inputWhilePaused,
  cleanupKillsPaused,
];
