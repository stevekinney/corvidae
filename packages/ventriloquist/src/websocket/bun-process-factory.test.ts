import { describe, expect, test } from 'bun:test';

import { ProcessStartFailure } from '../bun/process-start-failure.ts';
import { createBunProcessFactory } from './bun-process-factory.ts';
import { LAUNCH } from './websocket.test-support.ts';

// Neither helper spawns anything until its session starts the backend, and every test below that
// does start one points it at an unsupported host first, so no process is ever created.
const unsupported = { host: { platform: 'win32', architecture: 'x64' } } as const;

describe('createBunProcessFactory', () => {
  // spawn-free: the factory only builds the helper, which starts nothing until its backend starts
  test('makes a PTY process, with one combined channel, from a pty launch', () => {
    const hosted = createBunProcessFactory()(LAUNCH);
    expect(hosted.mode).toBe('pty');
    expect(hosted.sources.map((source) => source.channel)).toEqual(['pty']);
    expect(hosted.backend.mode).toBe('pty');
  });

  // spawn-free: the factory only builds the helper, which starts nothing until its backend starts
  test('makes a pipe process, with separate channels, from a pipe launch', () => {
    const hosted = createBunProcessFactory()({ ...LAUNCH, mode: 'pipe' });
    expect(hosted.mode).toBe('pipe');
    expect(hosted.sources.map((source) => source.channel)).toEqual(['stdout', 'stderr']);
    expect(hosted.backend.acceptsInput).toBe(false);
  });

  // spawn-free: the factory only builds the helper, which starts nothing until its backend starts
  test('a pipe has an input channel only when the launch asks for one', () => {
    const hosted = createBunProcessFactory()({ ...LAUNCH, mode: 'pipe', acceptsInput: true });
    expect(hosted.backend.acceptsInput).toBe(true);
  });

  // spawn-free: the host is unsupported, so the backend refuses to start before any spawn
  test('passes the host options to the helper, so an unsupported host fails the start', async () => {
    const hosted = createBunProcessFactory(unsupported)(LAUNCH);
    const failure = await hosted.backend.start().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ProcessStartFailure);
    expect((failure as ProcessStartFailure).code).toBe('unsupported-runtime');
  });

  // spawn-free: validation throws before the helper could start anything
  test('refuses a malformed launch at construction', () => {
    expect(() =>
      createBunProcessFactory()({ ...LAUNCH, dimensions: { columns: 0, rows: 24 } }),
    ).toThrow(RangeError);
  });
});
