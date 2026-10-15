import { describe, expect, test } from 'bun:test';

import { rejectionOf } from '@lostgradient/testing';
import { BoundedByteFeed, ByteBudget, OutputOverflowError } from './bounded-byte-feed.ts';

const bytes = (...values: number[]) => Uint8Array.from(values);

function open(maximumBufferedBytes = 8) {
  let cancelCalls = 0;
  const feed = new BoundedByteFeed(maximumBufferedBytes, () => {
    cancelCalls += 1;
  });
  return { feed, reader: feed.stream.getReader(), cancelCalls: () => cancelCalls };
}

describe('BoundedByteFeed', () => {
  test('delivers queued chunks in order, then end of file', async () => {
    const { feed, reader } = open();
    feed.push(bytes(1, 2));
    feed.push(bytes(3));
    feed.end();
    expect(await reader.read()).toEqual({ done: false, value: bytes(1, 2) });
    expect(await reader.read()).toEqual({ done: false, value: bytes(3) });
    expect(await reader.read()).toEqual({ done: true });
  });

  test('hands a chunk straight to a read that is already waiting, and ends a waiting read', async () => {
    const { feed, reader } = open();
    const first = reader.read();
    const second = reader.read();
    feed.push(bytes(9));
    feed.end();
    expect(await first).toEqual({ done: false, value: bytes(9) });
    expect(await second).toEqual({ done: true });
  });

  test('copies what it is given, so a producer that reuses its buffer changes nothing', async () => {
    const { feed, reader } = open();
    const scratch = bytes(1, 2, 3);
    feed.push(scratch);
    scratch.fill(0);
    expect(await reader.read()).toEqual({ done: false, value: bytes(1, 2, 3) });
    const waiting = reader.read();
    feed.push(scratch);
    scratch.fill(9);
    expect(await waiting).toEqual({ done: false, value: bytes(0, 0, 0) });
  });

  test('keeps empty chunks as data', async () => {
    const { feed, reader } = open();
    feed.push(new Uint8Array(0));
    expect(await reader.read()).toEqual({ done: false, value: new Uint8Array(0) });
  });

  test('fails visibly when unread output passes the bound, after delivering what fit', async () => {
    const { feed, reader } = open(4);
    feed.push(bytes(1, 2, 3, 4));
    feed.push(bytes(5));
    feed.push(bytes(6));
    feed.end();
    expect(await reader.read()).toEqual({ done: false, value: bytes(1, 2, 3, 4) });
    const failure = await rejectionOf(reader.read());
    expect(failure).toBeInstanceOf(OutputOverflowError);
    expect((failure as OutputOverflowError).maximumBufferedBytes).toBe(4);
    expect(await rejectionOf(reader.read())).toBe(failure);
  });

  test('a read that takes the queue back down makes room again', async () => {
    const { feed, reader } = open(4);
    feed.push(bytes(1, 2, 3, 4));
    await reader.read();
    feed.push(bytes(5, 6, 7, 8));
    feed.end();
    expect(await reader.read()).toEqual({ done: false, value: bytes(5, 6, 7, 8) });
  });

  test('rejects a waiting read when the producer fails', async () => {
    const { feed, reader } = open();
    const waiting = reader.read();
    const error = new Error('pipe broke');
    feed.fail(error);
    expect(await rejectionOf(waiting)).toBe(error);
  });

  test('ignores everything after the first of end, failure or cancel', async () => {
    const ended = open();
    ended.feed.end();
    ended.feed.push(bytes(1));
    ended.feed.fail(new Error('late'));
    expect(await ended.reader.read()).toEqual({ done: true });

    const failed = open();
    failed.feed.fail(new Error('first'));
    failed.feed.fail(new Error('second'));
    failed.feed.end();
    expect((await rejectionOf(failed.reader.read())) as Error).toHaveProperty('message', 'first');
  });

  test('cancel drops the queue, ends reads, runs the release once and refuses later bytes', async () => {
    const { feed, reader, cancelCalls } = open();
    feed.push(bytes(1, 2));
    await reader.cancel?.();
    await reader.cancel?.();
    expect(cancelCalls()).toBe(1);
    feed.push(bytes(3));
    expect(await reader.read()).toEqual({ done: true });
  });

  test('cancel ends a read that is waiting', async () => {
    const { reader } = open();
    const waiting = reader.read();
    await reader.cancel?.();
    expect(await waiting).toEqual({ done: true });
  });

  test('has one reader at a time, and a released lock can be taken again', () => {
    const { feed, reader } = open();
    expect(() => feed.stream.getReader()).toThrow(TypeError);
    reader.releaseLock();
    expect(() => feed.stream.getReader()).not.toThrow();
  });
});

describe('feeds that share one byte budget', () => {
  function shared(maximumBufferedBytes: number) {
    const budget = new ByteBudget(maximumBufferedBytes);
    const overflows: string[] = [];
    const first = new BoundedByteFeed(
      budget,
      () => undefined,
      () => overflows.push('first'),
    );
    const second = new BoundedByteFeed(
      budget,
      () => undefined,
      () => overflows.push('second'),
    );
    return { first, second, overflows };
  }

  test('each under the bound but together over it fails the feed that crossed it', async () => {
    const { first, second, overflows } = shared(4);
    first.push(bytes(1, 2, 3));
    second.push(bytes(4, 5, 6));
    expect(overflows).toEqual(['second']);
    const failure = await rejectionOf(second.stream.getReader().read());
    expect(failure).toBeInstanceOf(OutputOverflowError);
    expect((failure as OutputOverflowError).maximumBufferedBytes).toBe(4);
  });

  test('together at exactly the bound is not an overflow', async () => {
    const { first, second, overflows } = shared(4);
    first.push(bytes(1, 2));
    second.push(bytes(3, 4));
    first.end();
    second.end();
    expect(overflows).toEqual([]);
    const reader = second.stream.getReader();
    expect(await reader.read()).toEqual({ done: false, value: bytes(3, 4) });
    expect(await reader.read()).toEqual({ done: true });
  });

  test('a read on one feed makes room for the other, and a cancel returns what it held', () => {
    const { first, second, overflows } = shared(4);
    first.push(bytes(1, 2, 3));
    void first.stream.getReader().read();
    second.push(bytes(4, 5, 6));
    expect(overflows).toEqual([]);
    const third = new BoundedByteFeed(new ByteBudget(2), () => undefined);
    third.push(bytes(1, 2));
    void third.stream.getReader().cancel?.();
    third.push(bytes(3));
    expect(overflows).toEqual([]);
  });
});
