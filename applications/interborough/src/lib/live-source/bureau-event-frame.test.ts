import { describe, expect, test } from 'bun:test';

import {
  isRecoveryKind,
  isReplayCompletePing,
  parseBureauEventFrame,
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

describe('isReplayCompletePing', () => {
  test('is true only for the replayComplete marker', () => {
    expect(isReplayCompletePing('{"replayComplete":true}')).toBe(true);
    expect(isReplayCompletePing('{"replayComplete":false}')).toBe(false);
    expect(isReplayCompletePing('garbage')).toBe(false);
  });
});

describe('isRecoveryKind', () => {
  test('names the gap and dropped-frames kinds', () => {
    expect(isRecoveryKind('feed.gap')).toBe(true);
    expect(isRecoveryKind('frames.dropped')).toBe(true);
    expect(isRecoveryKind('run.settled')).toBe(false);
  });
});
