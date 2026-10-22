/**
 * COR-1559 — the steering log reads a `model` override that names its provider and the refusal
 * reasons this change adds, and still reads every record written before it.
 */
import { MemoryStorage, textValueStore } from '@lostgradient/weft';
import { describe, expect, it } from 'bun:test';

import {
  appendSteeringLogEvent,
  isReadableSteeringLogEvent,
  readSteeringLogEntries,
  readSteeringLogHead,
  type SteeringLogEvent,
} from './steering-log';

const SESSION = 'session-1';
const INCARNATION = 'incarnation-1';
const NOW = '2026-10-22T00:00:00.000Z';

function command(requestedValue: Record<string, unknown>, id = 'c1') {
  return {
    id,
    idOrigin: 'caller',
    sessionId: SESSION,
    principal: 'alice',
    requestedValue,
    requestedAt: NOW,
  };
}

/** An admission, as the JSON a log would hold. */
function admitted(requestedValue: Record<string, unknown>): SteeringLogEvent {
  return JSON.parse(
    JSON.stringify({ type: 'admit', command: command(requestedValue), liveRunIds: [], now: NOW }),
  ) as SteeringLogEvent;
}

function refused(failure: Record<string, unknown>, requestedValue: Record<string, unknown>) {
  return JSON.parse(
    JSON.stringify({
      type: 'refused',
      command: command(requestedValue),
      outcome: { outcome: 'rejected', failure },
      now: NOW,
    }),
  ) as SteeringLogEvent;
}

describe('a log written before the provider field existed', () => {
  it('still reads a model override that is a bare string, as provider-unspecified', async () => {
    const kv = textValueStore(new MemoryStorage());
    const legacy = admitted({ target: 'model', override: 'claude-sonnet-5' });
    const head = await readSteeringLogHead(kv, SESSION, INCARNATION);
    const appended = await appendSteeringLogEvent(kv, SESSION, INCARNATION, head, legacy);
    expect(appended.status).toBe('appended');

    const [event] = await readSteeringLogEntries(kv, SESSION, INCARNATION, 0, 1);

    expect(event?.type === 'admit' && event.command.requestedValue).toEqual({
      target: 'model',
      override: 'claude-sonnet-5',
    });
  });
});

describe('a model override that names its provider', () => {
  it('is readable and keeps its provider through the log', async () => {
    const kv = textValueStore(new MemoryStorage());
    const event = admitted({ target: 'model', override: 'claude-opus-5-5', provider: 'openai' });
    const head = await readSteeringLogHead(kv, SESSION, INCARNATION);
    await appendSteeringLogEvent(kv, SESSION, INCARNATION, head, event);

    const [read] = await readSteeringLogEntries(kv, SESSION, INCARNATION, 0, 1);

    expect(read?.type === 'admit' && read.command.requestedValue).toEqual({
      target: 'model',
      override: 'claude-opus-5-5',
      provider: 'openai',
    });
  });

  it('is corrupt when the provider is not text', () => {
    expect(
      isReadableSteeringLogEvent(
        admitted({ target: 'model', override: 'claude-opus-5-5', provider: 7 }),
        SESSION,
      ),
    ).toBe(false);
  });

  it('is corrupt on any other target', () => {
    for (const target of ['provider', 'route', 'effort', 'agent-identity']) {
      expect(
        isReadableSteeringLogEvent(
          admitted({
            target,
            override: target === 'effort' ? 'high' : 'x',
            provider: 'openai',
          }),
          SESSION,
        ),
      ).toBe(false);
    }
  });
});

describe('the refusal reasons', () => {
  const value = { target: 'model', override: 'gpt-4.1' };

  it('reads a model-not-allowed refusal Bureau decided before the gate', () => {
    expect(
      isReadableSteeringLogEvent(refused({ failedAt: NOW, reason: 'model-not-allowed' }, value), SESSION),
    ).toBe(true);
  });

  it('still reads policy-denied, and still refuses a reason no process logs as a refusal', () => {
    expect(
      isReadableSteeringLogEvent(refused({ failedAt: NOW, reason: 'policy-denied' }, value), SESSION),
    ).toBe(true);
    for (const reason of ['deadline-passed', 'run-terminal', 'session-terminal', 'bogus']) {
      expect(isReadableSteeringLogEvent(refused({ failedAt: NOW, reason }, value), SESSION)).toBe(
        false,
      );
    }
  });
});
