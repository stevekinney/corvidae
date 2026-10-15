import { describe, expect, test } from 'bun:test';

import { ClientEndpoint } from './client-endpoint.ts';
import {
  OTHER_SESSION_IDENTIFIER,
  OUTPUT_ONLY_CAPABILITIES,
  PTY_CAPABILITIES,
  SESSION_IDENTIFIER,
  TOKEN,
} from './endpoint-pair.test-support.ts';
import type { SentFrame } from './endpoint-support.ts';
import { encodeFrame } from './frame-codec.ts';
import { HostEndpoint, type HostEndpointOptions } from './host-endpoint.ts';
import type { Capabilities, ProtocolMessage } from './messages.ts';
import {
  FRAME_PAYLOAD_BYTES_RANGE,
  MAXIMUM_SEQUENCE,
  MINIMUM_FRAME_PAYLOAD_BYTES,
} from './protocol-constants.ts';
import type { ProtocolResult } from './protocol-failure.ts';
import { SequenceCursor } from './sequence-cursor.ts';

const maximum = MAXIMUM_SEQUENCE;
const cursor = (framesLeft: number) => new SequenceCursor(maximum - framesLeft);

const helloFrame = (requestedMode: 'read-only' | 'interactive') =>
  JSON.stringify({
    version: 1,
    kind: 'hello',
    direction: 'client-to-server',
    sessionId: SESSION_IDENTIFIER,
    requestedMode,
    token: TOKEN,
  });

/** A host attached at the largest generation with `inbound` and `outbound` sequence numbers left. */
function attachedHost(
  inbound: number,
  outbound: number,
  capabilities: Capabilities = PTY_CAPABILITIES,
  options: HostEndpointOptions = {},
): HostEndpoint {
  const host = new HostEndpoint(options, { inbound: cursor(inbound), outbound: cursor(outbound) });
  host.receive(helloFrame(capabilities.readOnly ? 'read-only' : 'interactive'));
  expect(host.issueCapabilities({ generation: maximum, capabilities }).ok).toBe(true);
  return host;
}

function inputFrame(
  overrides: { generation?: number; sessionId?: string; sequence?: number } = {},
): Uint8Array {
  const encoded = encodeFrame({
    kind: 'input',
    sessionId: overrides.sessionId ?? SESSION_IDENTIFIER,
    attachmentGeneration: overrides.generation ?? maximum,
    sequence: overrides.sequence ?? maximum,
    payload: Uint8Array.of(1),
  });
  if (!encoded.ok) throw new Error('could not encode');
  return encoded.value as Uint8Array;
}

function lengthOf(result: ProtocolResult<SentFrame> | ProtocolResult<ProtocolMessage>): number {
  const frame = result.ok ? (result.value as SentFrame).frame : result.failure.reply;
  if (typeof frame !== 'string')
    throw new Error(`expected a text frame: ${JSON.stringify(result)}`);
  return frame.length;
}

/** Every text frame an endpoint builds for itself, at maximal numbers and with its own reason text. */
function generatedFrames(): Record<string, number> {
  const lengths: Record<string, number> = {};
  lengths['refusal: operation not permitted'] = lengthOf(
    attachedHost(1, 1, OUTPUT_ONLY_CAPABILITIES).receive(inputFrame()),
  );
  const full = attachedHost(2, 1, PTY_CAPABILITIES, { maxQueuedOperations: 1 });
  full.receive(inputFrame({ sequence: maximum - 1 }));
  lengths['refusal: operation window full'] = lengthOf(full.receive(inputFrame()));
  const exited = attachedHost(1, 3);
  exited.processExit(0, null);
  lengths['refusal: authority revoked'] = lengthOf(exited.receive(inputFrame()));
  lengths['refusal: stale generation'] = lengthOf(
    attachedHost(1, 1).receive(inputFrame({ generation: maximum - 1 })),
  );
  lengths['refusal: stale session'] = lengthOf(
    attachedHost(1, 1).receive(inputFrame({ sessionId: OTHER_SESSION_IDENTIFIER })),
  );
  const accepting = attachedHost(1, 1);
  accepting.receive(inputFrame());
  lengths['operation-ack'] = lengthOf(accepting.acknowledgeOperation(maximum));
  lengths['process-exit'] = lengthOf(attachedHost(1, 1).processExit(Number.MIN_SAFE_INTEGER, null));
  for (const code of ['spawn-failed', 'backend-failed', 'transport-failed'] as const) {
    lengths[`attachment-error: ${code}`] = lengthOf(attachedHost(1, 1).attachmentError(code, ''));
  }
  lengths['cleanup-result'] = lengthOf(attachedHost(1, 1).cleanupResult('incomplete'));

  const client = new ClientEndpoint(
    { sessionId: SESSION_IDENTIFIER, requestedMode: 'interactive', token: TOKEN },
    { inbound: cursor(1), outbound: cursor(3) },
  );
  client.hello();
  client.receive(
    (
      encodeFrame({
        kind: 'capabilities',
        version: 1,
        sessionId: SESSION_IDENTIFIER,
        attachmentGeneration: maximum,
        capabilities: PTY_CAPABILITIES,
        maxFrameBytes: 65_536,
        maxQueuedOperations: 256,
      }) as { value: string }
    ).value,
  );
  const output = encodeFrame({
    kind: 'output',
    sessionId: SESSION_IDENTIFIER,
    attachmentGeneration: maximum,
    sequence: maximum,
    channel: 'pty',
    payload: Uint8Array.of(1),
  });
  client.receive((output as { value: Uint8Array }).value);
  lengths['output-consumed'] = lengthOf(client.consumeOutput(1));
  lengths['resize'] = lengthOf(client.resize(65_535, 65_535));
  lengths['terminate'] = lengthOf(client.terminate());
  return lengths;
}

describe('the minimum frame budget', () => {
  test('is the largest frame either endpoint generates for itself', () => {
    const lengths = generatedFrames();
    expect(Object.keys(lengths)).toHaveLength(14);
    const largest = Math.max(...Object.values(lengths));
    expect(MINIMUM_FRAME_PAYLOAD_BYTES).toBe(largest);
    expect(FRAME_PAYLOAD_BYTES_RANGE.minimum as number).toBe(largest);
  });

  test('lets a host at the minimum build every reason it generates', () => {
    const tight: HostEndpointOptions = { maxFrameBytes: MINIMUM_FRAME_PAYLOAD_BYTES };
    const host = attachedHost(1, 1, OUTPUT_ONLY_CAPABILITIES, tight);
    expect(host.receive(inputFrame()).ok).toBe(false);
    const stale = attachedHost(1, 1, PTY_CAPABILITIES, tight);
    expect(
      lengthOf(stale.receive(inputFrame({ generation: maximum - 1 })) as never),
    ).toBeLessThanOrEqual(MINIMUM_FRAME_PAYLOAD_BYTES);
  });
});
