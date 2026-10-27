import { rejectionOf } from '@lostgradient/testing';
import { describe, expect, test } from 'bun:test';

import { quietFor } from '@lostgradient/testing/wait-until';
import type { PtyDevice } from './pty-device.ts';
import { MASTER_FLAGS, MASTER_FLAG_COUNT, type MasterMessage } from './pty-master-loop.ts';
import { createPtyMaster, type MasterWorker, type MasterWrite } from './pty-master.ts';

/** A reader thread the test drives: it never touches a descriptor, and says what the test makes it say. */
function fakeWorker() {
  const posted: unknown[] = [];
  let terminated = 0;
  let flags: Int32Array | undefined;
  const listeners = new Map<string, (event: MessageEvent<MasterMessage>) => void>();
  const worker: MasterWorker & { say(message: MasterMessage): void } = {
    addEventListener: (type, handler) => {
      listeners.set(type, handler);
    },
    postMessage: (message) => {
      posted.push(message);
      flags = new Int32Array(
        (message as { shared: SharedArrayBuffer }).shared,
        0,
        MASTER_FLAG_COUNT,
      );
    },
    terminate: () => {
      terminated += 1;
    },
    say: (message) => listeners.get('message')?.({ data: message } as MessageEvent<MasterMessage>),
  };
  return {
    worker,
    fail: (type: 'error' | 'messageerror') =>
      listeners.get(type)?.({} as MessageEvent<MasterMessage>),
    say: (message: MasterMessage) => worker.say(message),
    posted,
    get terminated() {
      return terminated;
    },
    flag: (index: number) => Atomics.load(flags as Int32Array, index),
    setFlag: (index: number, value: number) => Atomics.store(flags as Int32Array, index, value),
  };
}

function fakeDevice() {
  const closed: number[] = [];
  const device: PtyDevice = {
    open: () => ({ masterFd: 5, slavePath: 'x' }),
    openSlave: () => 6,
    setWindowSize: () => undefined,
    close: (descriptor) => {
      closed.push(descriptor);
    },
  };
  return { device, closed };
}

function master(
  options: { endsWithIo?: boolean; write?: MasterWrite; stopTimeoutMilliseconds?: number } = {},
) {
  const thread = fakeWorker();
  const { device, closed } = fakeDevice();
  const created = createPtyMaster({
    descriptor: 5,
    device,
    endsWithIo: options.endsWithIo ?? true,
    createWorker: () => thread.worker,
    ...(options.write === undefined ? {} : { write: options.write }),
    ...(options.stopTimeoutMilliseconds === undefined
      ? {}
      : { stopTimeoutMilliseconds: options.stopTimeoutMilliseconds }),
  });
  return { created, thread, closed };
}

const bytes = (...values: number[]): ArrayBuffer => Uint8Array.from(values).buffer;
const textOf = (result: { done: boolean; value?: Uint8Array | undefined }): string =>
  result.done ? '<done>' : new TextDecoder().decode(result.value);

describe('reading a master', () => {
  test('hands the worker its descriptor and the shared flags', () => {
    const { thread } = master();
    expect(thread.posted).toHaveLength(1);
    expect(thread.posted[0]).toMatchObject({ fd: 5 });
  });

  test('a read waits for a chunk and takes it, returning credit to the worker', async () => {
    const { created, thread } = master();
    const reader = created.stream.getReader();
    const waiting = reader.read();
    Atomics.add(
      new Int32Array((thread.posted[0] as { shared: SharedArrayBuffer }).shared),
      MASTER_FLAGS.inflight,
      2,
    );
    thread.say({ type: 'data', chunk: new TextEncoder().encode('hi').buffer });
    expect(textOf(await waiting)).toBe('hi');
    expect(thread.flag(MASTER_FLAGS.inflight)).toBe(0);
  });

  test('chunks that arrive with no read waiting are kept in order and credited only as they are taken', async () => {
    const { created, thread } = master();
    thread.setFlag(MASTER_FLAGS.inflight, 3);
    thread.say({ type: 'data', chunk: new TextEncoder().encode('a').buffer });
    thread.say({ type: 'data', chunk: new TextEncoder().encode('bc').buffer });
    expect(thread.flag(MASTER_FLAGS.inflight)).toBe(3);
    const reader = created.stream.getReader();
    expect(textOf(await reader.read())).toBe('a');
    expect(thread.flag(MASTER_FLAGS.inflight)).toBe(2);
    expect(textOf(await reader.read())).toBe('bc');
    expect(thread.flag(MASTER_FLAGS.inflight)).toBe(0);
  });

  test('refuses a second reader until the first is released', () => {
    const { created } = master();
    const reader = created.stream.getReader();
    expect(() => created.stream.getReader()).toThrow(TypeError);
    reader.releaseLock();
    expect(() => created.stream.getReader()).not.toThrow();
  });

  test.each([
    ['end of file', { type: 'end', how: 'eof' }, true, 'done'],
    [
      'EIO where the kernel ends a terminal with it',
      { type: 'end', how: 'eio', code: 'EIO' },
      true,
      'done',
    ],
    ['EIO anywhere else', { type: 'end', how: 'eio', code: 'EIO' }, false, 'fail'],
    ['a stop', { type: 'end', how: 'stopped' }, true, 'done'],
    ['a read error', { type: 'end', how: 'error', code: 'EBADF' }, true, 'fail'],
    ['a read error without a code', { type: 'end', how: 'error' }, true, 'fail'],
  ] as const)('%s ends a waiting read', async (_name, message, endsWithIo, outcome) => {
    const { created, thread } = master({ endsWithIo });
    const waiting = created.stream.getReader().read();
    thread.say(message);
    if (outcome === 'done') {
      const ended = await waiting;
      expect(ended.done).toBe(true);
    } else expect(((await rejectionOf(waiting)) as Error).message).toContain('could not be read');
  });

  test('bytes read before the end are delivered before it, and the end is remembered', async () => {
    const { created, thread } = master();
    thread.say({ type: 'data', chunk: new TextEncoder().encode('last').buffer });
    thread.say({ type: 'end', how: 'eof' });
    const reader = created.stream.getReader();
    expect(textOf(await reader.read())).toBe('last');
    const awaited8 = await reader.read();
    expect(awaited8.done).toBe(true);
    const awaited9 = await reader.read();
    expect(awaited9.done).toBe(true);
  });

  test('a failure after the last chunk is raised on the read that follows it', async () => {
    const { created, thread } = master();
    thread.say({ type: 'end', how: 'error', code: 'EBADF' });
    expect(((await rejectionOf(created.stream.getReader().read())) as Error).message).toContain(
      'EBADF',
    );
  });

  test('canceling drops what is held, ends reads, and switches the worker to discarding', async () => {
    const { created, thread } = master();
    thread.setFlag(MASTER_FLAGS.inflight, 4);
    thread.say({ type: 'data', chunk: bytes(1, 2, 3, 4) });
    const reader = created.stream.getReader();
    await reader.cancel?.();
    expect(thread.flag(MASTER_FLAGS.discard)).toBe(1);
    expect(thread.flag(MASTER_FLAGS.inflight)).toBe(0);
    const awaited10 = await reader.read();
    expect(awaited10.done).toBe(true);
    // The worker may still post what it read before it saw the flag; that is credited back and dropped.
    thread.setFlag(MASTER_FLAGS.inflight, 2);
    thread.say({ type: 'data', chunk: bytes(9, 9) });
    expect(thread.flag(MASTER_FLAGS.inflight)).toBe(0);
    const awaited11 = await reader.read();
    expect(awaited11.done).toBe(true);
  });

  test('canceling resolves a read that is waiting', async () => {
    const { created } = master();
    const reader = created.stream.getReader();
    const waiting = reader.read();
    await reader.cancel?.();
    const awaited12 = await waiting;
    expect(awaited12.done).toBe(true);
  });
});

describe('a reader thread that dies', () => {
  test.each(['error', 'messageerror'] as const)(
    'a %s event ends the output as a failure a waiting read can see',
    async (type) => {
      const { created, thread } = master();
      const waiting = created.stream.getReader().read();
      thread.fail(type);
      expect(((await rejectionOf(waiting)) as Error).message).toContain('WORKER');
    },
  );

  test('later reads fail the same way, and what was already queued is still delivered first', async () => {
    const { created, thread } = master();
    thread.say({ type: 'data', chunk: new TextEncoder().encode('kept').buffer });
    thread.fail('error');
    const reader = created.stream.getReader();
    expect(textOf(await reader.read())).toBe('kept');
    expect(((await rejectionOf(reader.read())) as Error).message).toContain('WORKER');
  });

  test('stop does not wait for a thread that is already gone', async () => {
    const { created, thread } = master({ stopTimeoutMilliseconds: 5_000 });
    thread.fail('error');
    // A stop that waited out its five seconds would report the thread as unconfirmed.
    expect(await created.stop()).toBe(true);
  });

  test('a thread whose module cannot be loaded ends the output instead of leaving it waiting', async () => {
    const { device } = fakeDevice();
    const created = createPtyMaster({
      descriptor: 2_000_000,
      device,
      endsWithIo: true,
      createWorker: () => new Worker(new URL('./no-such-worker-module.ts', import.meta.url).href),
    });
    expect(await rejectionOf(created.stream.getReader().read()).then(() => 'failed')).toBe(
      'failed',
    );
    expect(typeof (await created.stop())).toBe('boolean');
  });
});

describe('writing a master', () => {
  function recordingWrite(script: (call: number) => number | string) {
    const taken: string[] = [];
    let calls = 0;
    const write: MasterWrite = (_descriptor, data, offset) => {
      calls += 1;
      const answer = script(calls);
      if (typeof answer === 'string') throw Object.assign(new Error(answer), { code: answer });
      taken.push(new TextDecoder().decode(data.subarray(offset, offset + answer)));
      return answer;
    };
    return { write, taken, calls: () => calls };
  }

  test('a write the kernel takes whole settles at once', async () => {
    const run = recordingWrite((): number => 3);
    const { created } = master({ write: run.write });
    await created.write(new TextEncoder().encode('abc'));
    expect(run.taken).toEqual(['abc']);
  });

  test('a zero-length write settles without a call', async () => {
    const run = recordingWrite((): number => 0);
    const { created } = master({ write: run.write });
    await created.write(new Uint8Array(0));
    expect(run.calls()).toBe(0);
  });

  test('keeps the bytes as they were when written, whatever the caller does to its buffer', async () => {
    const run = recordingWrite((call) => (call === 1 ? 'EAGAIN' : 3));
    const { created } = master({ write: run.write });
    const input = new TextEncoder().encode('abc');
    const settled = created.write(input);
    input.fill(0x7a);
    await settled;
    expect(run.taken).toEqual(['abc']);
  });

  test('retries after EAGAIN, backing off, and keeps writes in order behind the one waiting', async () => {
    const run = recordingWrite((call) => (call <= 6 ? 'EAGAIN' : 100));
    const { created } = master({ write: run.write });
    const first = created.write(new TextEncoder().encode('one'));
    const second = created.write(new TextEncoder().encode('two'));
    await Promise.all([first, second]);
    expect(run.taken).toEqual(['one', 'two']);
    expect(run.calls()).toBe(8);
  });

  test('a partial write continues from where the kernel stopped', async () => {
    const run = recordingWrite((call) => (call === 1 ? 2 : 100));
    const { created } = master({ write: run.write });
    await created.write(new TextEncoder().encode('abcdef'));
    expect(run.taken).toEqual(['ab', 'cdef']);
  });

  test.each(['EIO', 'EPIPE', 'ENXIO'])(
    '%s means the other end is gone: the write never settles',
    async (code) => {
      const run = recordingWrite(() => code);
      const { created } = master({ write: run.write });
      let settled = false;
      void created.write(new TextEncoder().encode('lost')).then(() => {
        settled = true;
      });
      // The write never settles; load can only delay a settlement, never bring it forward.
      await quietFor(30);
      expect(settled).toBe(false);
      expect(run.calls()).toBe(1);
    },
  );

  test('any other error fails that write only, and the next one is still written', async () => {
    const run = recordingWrite((call) => (call === 1 ? 'EBADF' : 5));
    const { created } = master({ write: run.write });
    const failed = created.write(new TextEncoder().encode('bad'));
    const next = created.write(new TextEncoder().encode('good!'));
    expect(((await rejectionOf(failed)) as Error).message).toContain('EBADF');
    await next;
    expect(run.taken).toEqual(['good!']);
  });

  function reports() {
    const log: string[] = [];
    return { log, hold: { held: () => log.push('held'), resumed: () => log.push('resumed') } };
  }

  test('reports one hold while the kernel refuses with EAGAIN, and none when it takes the write', async () => {
    const quiet = reports();
    const takes = recordingWrite((): number => 3);
    await master({ write: takes.write }).created.write(new TextEncoder().encode('abc'), quiet.hold);
    expect(quiet.log).toEqual([]);
    const held = reports();
    const run = recordingWrite((call) => (call <= 4 ? 'EAGAIN' : 100));
    await master({ write: run.write }).created.write(new TextEncoder().encode('abc'), held.hold);
    expect(held.log).toEqual(['held']);
  });

  test('reports the hold over when the kernel takes some of the write, and again if it refuses more', async () => {
    const run = recordingWrite((call) =>
      call === 1 ? 'EAGAIN' : call === 2 ? 2 : call === 3 ? 'EAGAIN' : 100,
    );
    const { log, hold } = reports();
    await master({ write: run.write }).created.write(new TextEncoder().encode('abcdef'), hold);
    expect(log).toEqual(['held', 'resumed', 'held']);
    expect(run.taken).toEqual(['ab', 'cdef']);
  });

  test('a terminal that hangs up while the write is held makes it a lost write, not a held one', async () => {
    const run = recordingWrite((call) => (call === 1 ? 'EAGAIN' : 'EIO'));
    const { log, hold } = reports();
    let settled = false;
    void master({ write: run.write })
      .created.write(new TextEncoder().encode('lost'), hold)
      .then(() => {
        settled = true;
      });
    // The write never settles; load can only delay a settlement, never bring it forward.
    await quietFor(60);
    expect(settled).toBe(false);
    expect(log).toEqual(['held', 'resumed']);
  });

  test('a terminal that hangs up without a prior hold reports nothing', async () => {
    const run = recordingWrite(() => 'EIO');
    const { log, hold } = reports();
    void master({ write: run.write }).created.write(new TextEncoder().encode('lost'), hold);
    await quietFor(30);
    expect(log).toEqual([]);
  });

  test('closing abandons a write that is waiting to be retried', async () => {
    const run = recordingWrite((): string => 'EAGAIN');
    const { created } = master({ write: run.write });
    void created.write(new TextEncoder().encode('stuck'));
    const calls = run.calls();
    created.close();
    await quietFor(40);
    expect(run.calls()).toBe(calls);
  });
});

describe('ending a master', () => {
  test('discard tells the worker to read and drop', () => {
    const { created, thread } = master();
    created.discard();
    expect(thread.flag(MASTER_FLAGS.discard)).toBe(1);
  });

  test('stop sets the flag, waits for the worker to say it ended, and terminates it', async () => {
    const { created, thread } = master();
    const stopping = created.stop();
    expect(thread.flag(MASTER_FLAGS.stop)).toBe(1);
    thread.say({ type: 'end', how: 'stopped' });
    expect(await stopping).toBe(true);
    expect(thread.terminated).toBe(1);
  });

  test('stop after the worker already ended does not wait', async () => {
    const { created, thread } = master();
    thread.say({ type: 'end', how: 'eio', code: 'EIO' });
    expect(await created.stop()).toBe(true);
  });

  test('a worker that does not answer in time is terminated and reported as not stopped', async () => {
    const { created, thread } = master({ stopTimeoutMilliseconds: 20 });
    expect(await created.stop()).toBe(false);
    expect(thread.terminated).toBe(1);
  });

  test('abandon drops queued input and leaves the descriptor open, even if close follows', () => {
    const { created, closed } = master();
    created.abandon();
    created.close();
    expect(closed).toEqual([]);
  });

  test('close closes the descriptor once', () => {
    const { created, closed } = master();
    created.close();
    created.close();
    expect(closed).toEqual([5]);
  });
});

describe('the default worker', () => {
  test('is a real thread that can be created, stopped and closed', async () => {
    const { device } = fakeDevice();
    const created = createPtyMaster({ descriptor: 2_000_000, device, endsWithIo: true });
    // The descriptor does not exist, so the thread reports an error end; stopping it still completes.
    expect(typeof (await created.stop())).toBe('boolean');
    created.close();
  });
});
