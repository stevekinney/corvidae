import { describe, expect, test } from 'bun:test';

import {
  isRecoveryKind,
  parseBureauEventFrame,
  readBureauEventFrame,
} from './bureau-event-frame.ts';

describe('parseBureauEventFrame', () => {
  test('reads a well-formed envelope', () => {
    const data = JSON.stringify({
      kind: 'k',
      cursor: 'a:1',
      sequence: 2,
      emittedAtMs: 3,
      payload: 4,
    });
    expect(parseBureauEventFrame(data)).toEqual({
      kind: 'k',
      cursor: 'a:1',
      sequence: 2,
      emittedAtMs: 3,
      payload: 4,
    });
  });

  test('keeps the envelope’s source, which is not a payload field', () => {
    const envelope = { kind: 'k', cursor: 'a:1', sequence: 2, emittedAtMs: 3 };
    expect(
      parseBureauEventFrame(
        JSON.stringify({ ...envelope, payload: { source: 'payload-key' }, source: 'inbox' }),
      ),
    ).toEqual({ ...envelope, payload: { source: 'payload-key' }, source: 'inbox' });
  });

  test('leaves source off an event from core, and ignores one that is not a plugin name', () => {
    const envelope = { kind: 'k', cursor: 'a:1', sequence: 2, emittedAtMs: 3, payload: {} };
    expect(parseBureauEventFrame(JSON.stringify(envelope))).not.toHaveProperty('source');
    expect(parseBureauEventFrame(JSON.stringify({ ...envelope, source: 7 }))).not.toHaveProperty(
      'source',
    );
    expect(parseBureauEventFrame(JSON.stringify({ ...envelope, source: '' }))).not.toHaveProperty(
      'source',
    );
  });

  test('rejects data that is not JSON, not an object, or missing a field', () => {
    expect(parseBureauEventFrame('{not json')).toBeNull();
    expect(parseBureauEventFrame('[1]')).toBeNull();
    expect(parseBureauEventFrame('null')).toBeNull();
    expect(
      parseBureauEventFrame(JSON.stringify({ kind: 1, cursor: 'c', sequence: 1, emittedAtMs: 1 })),
    ).toBeNull();
    expect(
      parseBureauEventFrame(JSON.stringify({ kind: 'k', cursor: 'c', emittedAtMs: 1 })),
    ).toBeNull();
    expect(
      parseBureauEventFrame(JSON.stringify({ kind: 'k', cursor: 'c', sequence: 1 })),
    ).toBeNull();
  });
});

describe('readBureauEventFrame', () => {
  test('reads data the transport already parsed, and is null for what is not an envelope', () => {
    const envelope = {
      kind: 'run.settled',
      cursor: 'a:1',
      sequence: 1,
      emittedAtMs: 2,
      payload: {},
    };
    expect(readBureauEventFrame(envelope)).toEqual(envelope);
    expect(readBureauEventFrame('text')).toBeNull();
    expect(readBureauEventFrame(null)).toBeNull();
    expect(readBureauEventFrame({ ...envelope, sequence: 'one' })).toBeNull();
  });
});

describe('isRecoveryKind', () => {
  test('names the gap and dropped-frames kinds', () => {
    expect(isRecoveryKind('feed.gap')).toBe(true);
    expect(isRecoveryKind('frames.dropped')).toBe(true);
    expect(isRecoveryKind('run.settled')).toBe(false);
  });
});
