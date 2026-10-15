import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

import * as neutralEntry from './index.ts';

const packageRoot = join(import.meta.dir, '..');

describe('package entry points', () => {
  test('declare the neutral, Bun, and WebSocket entries as source files that exist', async () => {
    const manifest: { exports: Record<string, string> } = await Bun.file(
      join(packageRoot, 'package.json'),
    ).json();
    expect(manifest.exports).toEqual({
      '.': './src/index.ts',
      './bun': './src/bun/index.ts',
      './websocket': './src/websocket/index.ts',
    });
    for (const target of Object.values(manifest.exports)) {
      expect(await Bun.file(join(packageRoot, target)).exists(), target).toBe(true);
    }
  });

  test('every entry loads, and each exposes only its own surface', async () => {
    expect(Object.keys(await import('./bun/index.ts')).toSorted()).toEqual([
      'SUPPORTED_HOST_ARCHITECTURES',
      'SUPPORTED_HOST_PLATFORMS',
      'isSupportedHost',
    ]);
    expect(Object.keys(await import('./websocket/index.ts'))).toEqual(['isSendableCloseCode']);
    expect(Object.keys(neutralEntry).toSorted()).toEqual(
      [
        'ATTACHMENT_ERROR_CODES',
        'BINARY_FRAME_HEADER_BYTES',
        'CORPUS',
        'ClientEndpoint',
        'DEFAULT_SESSION_BUDGETS',
        'FAILURE_CLOSE_CODES',
        'FAILURE_TABLE',
        'FRAME_PAYLOAD_BYTES_RANGE',
        'HostEndpoint',
        'MAXIMUM_FRAME_PAYLOAD_BYTES',
        'MAXIMUM_QUEUED_OPERATIONS',
        'MAXIMUM_SEQUENCE',
        'MAXIMUM_TERMINAL_DIMENSION',
        'MESSAGE_KIND_DIRECTIONS',
        'MINIMUM_FRAME_PAYLOAD_BYTES',
        'MINIMUM_TERMINAL_DIMENSION',
        'ManualClock',
        'OPERATION_FAILURE_CODES',
        'PARTITION_SEED',
        'PROTOCOL_VERSION',
        'QUEUED_OPERATIONS_RANGE',
        'REQUIRED_CORPUS_FIXTURE_IDS',
        'SEEDED_PARTITION_COUNT',
        'SESSION_BUDGET_RANGES',
        'SUPPLEMENTARY_CORPUS_FIXTURE_IDS',
        'Session',
        'SessionConnection',
        'SessionSlot',
        'byteByByteChunks',
        'channelsForMode',
        'closeCodeForFailure',
        'createDeferred',
        'createFixtureTransport',
        'createRandom',
        'createScriptedBackend',
        'createScriptedIterable',
        'createScriptedStream',
        'createScriptedSubscription',
        'decodeFrame',
        'describeFailure',
        'encodeFrame',
        'encodeUtf8',
        'isValidSequence',
        'partitionAt',
        'resolveSessionBudgets',
        'seededPartitions',
        'systemClock',
        'twoChunkSplits',
        'utf8ByteLength',
        'validateCapabilities',
      ].toSorted(),
    );
  });
});
