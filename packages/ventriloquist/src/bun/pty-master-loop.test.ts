import { describe, expect, test } from 'bun:test';

import {
  MASTER_CHUNK_BYTES,
  MASTER_FLAGS,
  MASTER_FLAG_COUNT,
  MASTER_POLL_MILLISECONDS,
  MASTER_WINDOW_BYTES,
  runMasterLoop,
  type MasterMessage,
  type MasterPrimitives,
} from './pty-master-loop.ts';

type Step = number | { readonly code?: string };

/**
 * A scripted master: each poll answers from `polls` and each read from `reads` (a count of bytes,
 * or an error with an errno code). When a script runs out the loop is stopped, so a test can never spin.
 */
function scripted(options: {
  readonly polls?: readonly boolean[];
  readonly reads: readonly Step[];
  readonly onWait?: (flags: Int32Array) => void;
}) {
  const flags = new Int32Array(MASTER_FLAG_COUNT);
  const posts: MasterMessage[] = [];
  const waits: { index: number; expected: number; timeout: number }[] = [];
  const polls = [...(options.polls ?? [])];
  const reads = [...options.reads];
  let pollCount = 0;
  const io: MasterPrimitives = {
    poll: (timeout) => {
      pollCount += 1;
      expect(timeout).toBe(MASTER_POLL_MILLISECONDS);
      const answer = polls.shift() ?? true;
      if (polls.length === 0 && reads.length === 0) Atomics.store(flags, MASTER_FLAGS.stop, 1);
      return answer;
    },
    read: (buffer, offset, length) => {
      const step = reads.shift();
      if (step === undefined) {
        Atomics.store(flags, MASTER_FLAGS.stop, 1);
        throw Object.assign(new Error('again'), { code: 'EAGAIN' });
      }
      if (typeof step !== 'number') {
        throw Object.assign(
          new Error('read failed'),
          step.code === undefined ? {} : { code: step.code },
        );
      }
      const count = Math.min(step, length);
      buffer.fill(7, offset, offset + count);
      return count;
    },
    wait: (waitFlags, index, expected, timeout) => {
      waits.push({ index, expected, timeout });
      options.onWait?.(waitFlags);
    },
    post: (message) => {
      posts.push(message);
    },
  };
  return { flags, io, posts, waits, pollCount: () => pollCount };
}

const bytesOf = (message: MasterMessage | undefined): number =>
  message?.type === 'data' ? message.chunk.byteLength : -1;

describe('the master read loop', () => {
  test('posts what one drain pass read as a single message and credits it as in flight', () => {
    const run = scripted({ reads: [1024, 1024, 512, { code: 'EAGAIN' }] });
    runMasterLoop(run.flags, run.io);
    expect(bytesOf(run.posts[0])).toBe(2560);
    expect(run.posts.at(-1)).toEqual({ type: 'end', how: 'stopped' });
    expect(Atomics.load(run.flags, MASTER_FLAGS.inflight)).toBe(2560);
  });

  test('cuts a message at the chunk size and keeps reading', () => {
    const run = scripted({ reads: [MASTER_CHUNK_BYTES, 100, { code: 'EAGAIN' }] });
    runMasterLoop(run.flags, run.io);
    expect(run.posts.slice(0, 2).map(bytesOf)).toEqual([MASTER_CHUNK_BYTES, 100]);
  });

  test('a poll that times out reads nothing and looks at the flags again', () => {
    const run = scripted({ polls: [false, false, true], reads: [10, { code: 'EAGAIN' }] });
    runMasterLoop(run.flags, run.io);
    expect(run.posts.map(bytesOf)[0]).toBe(10);
  });

  test('end of file ends the loop after the bytes read before it', () => {
    const run = scripted({ reads: [5, 0] });
    runMasterLoop(run.flags, run.io);
    expect(run.posts.map((message) => message.type)).toEqual(['data', 'end']);
    expect(run.posts[1]).toEqual({ type: 'end', how: 'eof' });
  });

  test('EIO is the Linux end of output and carries its code', () => {
    const run = scripted({ reads: [{ code: 'EIO' }] });
    runMasterLoop(run.flags, run.io);
    expect(run.posts).toEqual([{ type: 'end', how: 'eio', code: 'EIO' }]);
  });

  test('any other read error ends the loop as an error with its code, or UNKNOWN without one', () => {
    const coded = scripted({ reads: [{ code: 'EBADF' }] });
    runMasterLoop(coded.flags, coded.io);
    expect(coded.posts).toEqual([{ type: 'end', how: 'error', code: 'EBADF' }]);
    const bare = scripted({ reads: [{}] });
    runMasterLoop(bare.flags, bare.io);
    expect(bare.posts).toEqual([{ type: 'end', how: 'error', code: 'UNKNOWN' }]);
  });

  test('does not read while the window of unread bytes is full, and reads again when it is taken', () => {
    const run = scripted({
      reads: [10, { code: 'EAGAIN' }],
      onWait: (flags) => Atomics.store(flags, MASTER_FLAGS.inflight, 0),
    });
    Atomics.store(run.flags, MASTER_FLAGS.inflight, MASTER_WINDOW_BYTES);
    runMasterLoop(run.flags, run.io);
    expect(run.waits).toEqual([
      {
        index: MASTER_FLAGS.inflight,
        expected: MASTER_WINDOW_BYTES,
        timeout: MASTER_POLL_MILLISECONDS,
      },
    ]);
    expect(run.pollCount()).toBeGreaterThan(0);
    expect(run.posts.map(bytesOf)[0]).toBe(10);
  });

  test('a stop set while the window is full ends the loop without a read', () => {
    const run = scripted({
      reads: [10],
      onWait: (flags) => Atomics.store(flags, MASTER_FLAGS.stop, 1),
    });
    Atomics.store(run.flags, MASTER_FLAGS.inflight, MASTER_WINDOW_BYTES);
    runMasterLoop(run.flags, run.io);
    expect(run.posts).toEqual([{ type: 'end', how: 'stopped' }]);
  });

  test('in discard mode output is read and dropped, whatever the window holds', () => {
    const run = scripted({ reads: [100, 100, { code: 'EAGAIN' }] });
    Atomics.store(run.flags, MASTER_FLAGS.discard, 1);
    Atomics.store(run.flags, MASTER_FLAGS.inflight, MASTER_WINDOW_BYTES);
    runMasterLoop(run.flags, run.io);
    expect(run.posts).toEqual([{ type: 'end', how: 'stopped' }]);
    expect(run.waits).toEqual([]);
    expect(Atomics.load(run.flags, MASTER_FLAGS.inflight)).toBe(MASTER_WINDOW_BYTES);
  });
});
