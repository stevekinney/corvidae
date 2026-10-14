import { describe, expect, test } from 'bun:test';

import { ManualClock } from './fixtures/manual-clock.ts';
import { createScriptedBackend } from './fixtures/scripted-backend.ts';
import type { OutputSource, SessionOptions } from './session-types.ts';
import { SESSION_ID } from './session.test-support.ts';
import { Session } from './session.ts';

/** A stream source that counts how many times it was opened, so a test can prove nothing was acquired. */
function countingSource(channel: 'pty' | 'stdout' | 'stderr'): {
  readonly source: OutputSource;
  readonly opened: () => number;
} {
  let opened = 0;
  return {
    source: {
      kind: 'stream',
      channel,
      stream: {
        getReader: () => {
          opened += 1;
          return {
            read: () => new Promise(() => undefined),
            releaseLock: () => undefined,
            cancel: () => Promise.resolve(),
          };
        },
      },
    },
    opened: () => opened,
  };
}

function options(overrides: Partial<SessionOptions>): SessionOptions {
  return {
    sessionId: SESSION_ID,
    profile: { profileId: 'shell' },
    dimensions: { columns: 80, rows: 24 },
    clock: new ManualClock(),
    sources: [],
    ...overrides,
  };
}

describe('the session identity', () => {
  test.each([
    'not-a-uuid',
    '0B6F0C3E-8A1D-4C55-9A64-2F6E9B7D1C10',
    '0b6f0c3e8a1d4c559a642f6e9b7d1c10',
    ' 0b6f0c3e-8a1d-4c55-9a64-2f6e9b7d1c10',
    '',
  ])('rejects %p before acquiring a source or touching the backend', (sessionId) => {
    const counted = countingSource('pty');
    const backend = createScriptedBackend();
    expect(() => new Session(options({ sessionId, sources: [counted.source], backend }))).toThrow(
      TypeError,
    );
    expect(counted.opened()).toBe(0);
    expect(backend.calls).toEqual([]);
  });

  test('accepts the canonical lowercase form', () => {
    expect(() => new Session(options({ backend: createScriptedBackend() }))).not.toThrow();
  });
});

describe('source channels against the backend mode', () => {
  test.each([
    ['pty', 'stdout'],
    ['pty', 'stderr'],
    ['pipe', 'pty'],
  ] as const)('a %s backend refuses a source on %s before acquiring anything', (mode, channel) => {
    const earlier = countingSource(mode === 'pty' ? 'pty' : 'stdout');
    const offending = countingSource(channel);
    const backend = createScriptedBackend({ mode });
    expect(
      () => new Session(options({ sources: [earlier.source, offending.source], backend })),
    ).toThrow(TypeError);
    expect(earlier.opened()).toBe(0);
    expect(offending.opened()).toBe(0);
    expect(backend.calls).toEqual([]);
  });

  test.each(['pty', 'stderr'] as const)(
    'an output-only session refuses a source on %s',
    (channel) => {
      const offending = countingSource(channel);
      expect(() => new Session(options({ sources: [offending.source] }))).toThrow(TypeError);
      expect(offending.opened()).toBe(0);
    },
  );

  test('every combination the modes carry is accepted', () => {
    const accepted: [
      ReturnType<typeof createScriptedBackend> | undefined,
      ('pty' | 'stdout' | 'stderr')[],
    ][] = [
      [createScriptedBackend({ mode: 'pty' }), ['pty']],
      [createScriptedBackend({ mode: 'pipe' }), ['stdout', 'stderr']],
      [undefined, ['stdout']],
    ];
    for (const [backend, channels] of accepted) {
      const sources = channels.map((channel) => countingSource(channel).source);
      expect(
        () => new Session(options({ sources, ...(backend === undefined ? {} : { backend }) })),
      ).not.toThrow();
    }
  });
});
