import { describe, expect, test } from 'bun:test';

import type { ClientEndpoint } from '../client-endpoint.ts';
import {
  connect,
  expectOk,
  PIPE_CAPABILITIES,
  PTY_CAPABILITIES,
} from '../endpoint-pair.test-support.ts';
import type { HostEndpoint } from '../host-endpoint.ts';
import {
  CORPUS,
  REQUIRED_CORPUS_FIXTURE_IDS,
  SUPPLEMENTARY_CORPUS_FIXTURE_IDS,
  type CorpusFixture,
} from './fixtures.ts';
import {
  byteByByteChunks,
  PARTITION_SEED,
  SEEDED_PARTITION_COUNT,
  seededPartitions,
  twoChunkSplits,
} from './partitions.ts';

type Strategy = 'two-chunk-splits' | 'byte-by-byte' | 'seeded-partitions' | 'declared-chunks';

/** How many deliveries each strategy makes of a fixture; a missing or short cell fails the matrix. */
function expectedDeliveries(fixture: CorpusFixture, strategy: Strategy): number {
  switch (strategy) {
    case 'two-chunk-splits':
      return fixture.bytes.length + 1;
    case 'byte-by-byte':
      return 1;
    case 'seeded-partitions':
      return SEEDED_PARTITION_COUNT;
    case 'declared-chunks':
      return 1;
  }
}

function strategiesFor(fixture: CorpusFixture): Strategy[] {
  const strategies: Strategy[] = ['two-chunk-splits', 'byte-by-byte', 'seeded-partitions'];
  if (fixture.declaredChunks !== undefined) strategies.push('declared-chunks');
  return strategies;
}

const recorded = new Map<string, number>();

function record(fixture: CorpusFixture, strategy: Strategy): void {
  const cell = `${fixture.id}:${strategy}`;
  recorded.set(cell, (recorded.get(cell) ?? 0) + 1);
}

type ProtocolEvent = {
  readonly sequence: number;
  readonly channel: string;
  readonly payload: readonly number[];
};

/**
 * Hand `chunks` to a host as output, carry every frame to a client, and acknowledge as the client
 * parses. When the producer mutates its buffer it reuses one scratch buffer and overwrites it the
 * moment a chunk has been handed over. Returns what the client observed.
 */
function deliver(
  fixture: CorpusFixture,
  chunks: readonly Uint8Array[],
  host: HostEndpoint,
  client: ClientEndpoint,
): { joined: Uint8Array; events: ProtocolEvent[] } {
  const scratch = new Uint8Array(Math.max(1, ...chunks.map((chunk) => chunk.length)));
  const events: ProtocolEvent[] = [];
  const received: Uint8Array[] = [];
  for (const chunk of chunks) {
    let handed: Uint8Array = chunk.slice();
    if (fixture.mutatesProducerBuffer === true) {
      scratch.set(chunk);
      handed = scratch.subarray(0, chunk.length);
    }
    const sent = expectOk(host.output(fixture.channel, handed));
    if (fixture.mutatesProducerBuffer === true) scratch.fill(0xff);
    const message = expectOk(client.receive(sent.frame));
    if (message.kind !== 'output') throw new Error(`expected output, got ${message.kind}`);
    events.push({
      sequence: message.sequence,
      channel: message.channel,
      payload: [...message.payload],
    });
    received.push(message.payload);
    if (chunk.length > 0) {
      const acknowledgement = expectOk(client.consumeOutput(chunk.length));
      expectOk(host.receive(acknowledgement.frame));
    }
  }
  const joined = new Uint8Array(received.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of received) {
    joined.set(part, offset);
    offset += part.length;
  }
  return { joined, events };
}

function assertDelivery(fixture: CorpusFixture, chunks: readonly Uint8Array[]): void {
  const { host, client } = connect({
    capabilities: fixture.channel === 'pty' ? PTY_CAPABILITIES : PIPE_CAPABILITIES,
  });
  const { joined, events } = deliver(fixture, chunks, host, client);
  // The contiguous payload comes out byte for byte, however it was chunked.
  expect(joined).toEqual(fixture.bytes);
  // The protocol events are one output per chunk, numbered 1..n on the one channel, each with its chunk.
  expect(events.map((event) => event.sequence)).toEqual(chunks.map((_, index) => index + 1));
  expect(events.map((event) => event.payload)).toEqual(chunks.map((chunk) => [...chunk]));
  expect(new Set(events.map((event) => event.channel))).toEqual(new Set([fixture.channel]));
  // Every byte was counted once as produced, received and parsed.
  const total = fixture.bytes.length;
  expect(host.outputBytes).toEqual({ produced: total, consumed: total });
  expect(client.outputBytes).toEqual({ received: total, consumed: total });
}

describe('the corpus', () => {
  test('requires exactly the ten identifiers the contract freezes, in the contract order', () => {
    expect([...REQUIRED_CORPUS_FIXTURE_IDS]).toEqual([
      'utf8-split-alpha',
      'control-split-sgr',
      'combining-and-zwj',
      'cjk-width',
      'rtl-logical-order',
      'soft-wrap-retention',
      'alternate-screen',
      'cursor-and-attributes',
      'invalid-utf8',
      'query-reply',
    ]);
  });

  test('names the extra fixtures as supplementary, outside the required identifiers', () => {
    expect([...SUPPLEMENTARY_CORPUS_FIXTURE_IDS]).toEqual([
      'csi-osc-terminators',
      'nul-and-binary-mouse',
      'empty-chunks',
      'producer-mutation',
    ]);
    for (const id of SUPPLEMENTARY_CORPUS_FIXTURE_IDS) {
      expect(REQUIRED_CORPUS_FIXTURE_IDS as readonly string[]).not.toContain(id);
    }
  });

  test('runs every required and supplementary fixture, each with a distinct identifier and a description', () => {
    expect(CORPUS.map((fixture) => fixture.id)).toEqual([
      ...REQUIRED_CORPUS_FIXTURE_IDS,
      ...SUPPLEMENTARY_CORPUS_FIXTURE_IDS,
    ]);
    expect(new Set(CORPUS.map((fixture) => fixture.id)).size).toBe(CORPUS.length);
    for (const fixture of CORPUS) expect(fixture.description.length).toBeGreaterThan(10);
  });

  test('covers the bytes the protocol must never reinterpret', () => {
    const bytesOf = (id: string) => CORPUS.find((fixture) => fixture.id === id)!.bytes;
    expect(bytesOf('nul-and-binary-mouse')).toContain(0);
    expect(bytesOf('invalid-utf8')).toContain(0xff);
    expect(bytesOf('csi-osc-terminators')).toContain(0x07);
    expect(bytesOf('alternate-screen').length).toBeGreaterThan(0);
    expect(
      CORPUS.find((fixture) => fixture.id === 'empty-chunks')?.declaredChunks?.some(
        (chunk) => chunk.length === 0,
      ),
    ).toBe(true);
    expect(
      CORPUS.find((fixture) => fixture.id === 'producer-mutation')?.mutatesProducerBuffer,
    ).toBe(true);
  });

  test('declares chunks that add up to the fixture', () => {
    for (const fixture of CORPUS) {
      if (fixture.declaredChunks === undefined) continue;
      expect(Buffer.concat(fixture.declaredChunks)).toEqual(Buffer.from(fixture.bytes));
    }
  });
});

describe.each(CORPUS.map((fixture) => [fixture.id, fixture] as const))('%s', (_id, fixture) => {
  test('arrives intact for every two-chunk split', () => {
    for (const chunks of twoChunkSplits(fixture.bytes)) {
      assertDelivery(fixture, chunks);
      record(fixture, 'two-chunk-splits');
    }
  });

  test('arrives intact delivered one byte at a time', () => {
    assertDelivery(fixture, byteByByteChunks(fixture.bytes));
    record(fixture, 'byte-by-byte');
  });

  test(`arrives intact in ${SEEDED_PARTITION_COUNT} reproducible partitions from the checked-in seed`, () => {
    expect(PARTITION_SEED).toBe(1_869_636_978);
    for (const chunks of seededPartitions(fixture.bytes, PARTITION_SEED, SEEDED_PARTITION_COUNT)) {
      assertDelivery(fixture, chunks);
      record(fixture, 'seeded-partitions');
    }
  });
});

describe.each(
  CORPUS.filter((fixture) => fixture.declaredChunks !== undefined).map(
    (fixture) => [fixture.id, fixture] as const,
  ),
)('%s with declared chunks', (_id, fixture) => {
  test('arrives intact in the chunks it declares, empty ones included', () => {
    assertDelivery(fixture, fixture.declaredChunks!);
    record(fixture, 'declared-chunks');
  });
});

describe('two channels', () => {
  test('keep their own order and no total order across channels is claimed', () => {
    const { host, client } = connect({ capabilities: PIPE_CAPABILITIES });
    const writes: ReadonlyArray<readonly ['stdout' | 'stderr', string]> = [
      ['stdout', 'out-1 '],
      ['stderr', 'err-1 '],
      ['stderr', 'err-2 '],
      ['stdout', 'out-2 '],
      ['stdout', 'out-3 '],
      ['stderr', 'err-3 '],
    ];
    const byChannel: Record<string, string[]> = { stdout: [], stderr: [] };
    for (const [channel, text] of writes) {
      const message = expectOk(client.receive(expectOk(host.output(channel, text)).frame));
      if (message.kind !== 'output') throw new Error('expected output');
      byChannel[message.channel]!.push(new TextDecoder().decode(message.payload));
    }
    expect(byChannel['stdout']).toEqual(['out-1 ', 'out-2 ', 'out-3 ']);
    expect(byChannel['stderr']).toEqual(['err-1 ', 'err-2 ', 'err-3 ']);
  });
});

test('every required fixture and strategy cell ran its full set of deliveries', () => {
  // A cell that never ran, or ran fewer deliveries than the matrix requires, fails the suite.
  const missing: string[] = [];
  for (const id of [...REQUIRED_CORPUS_FIXTURE_IDS, ...SUPPLEMENTARY_CORPUS_FIXTURE_IDS]) {
    const fixture = CORPUS.find((candidate) => candidate.id === id);
    if (fixture === undefined) {
      missing.push(`${id}: fixture is missing`);
      continue;
    }
    for (const strategy of strategiesFor(fixture)) {
      const count = recorded.get(`${id}:${strategy}`) ?? 0;
      if (count !== expectedDeliveries(fixture, strategy)) {
        missing.push(`${id}:${strategy} ran ${count} of ${expectedDeliveries(fixture, strategy)}`);
      }
    }
  }
  expect(missing).toEqual([]);
});
