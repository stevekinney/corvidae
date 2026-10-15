import { describe, expect, test } from 'bun:test';

import { OutputReleaseQueue } from './output-release.ts';

function queue() {
  const released: number[] = [];
  return { released, queue: new OutputReleaseQueue((bytes) => released.push(bytes)) };
}

describe('OutputReleaseQueue', () => {
  test('releases a chunk only when its parse is reported, not when it is registered', () => {
    const { queue: releases, released } = queue();
    const parsed = releases.register(10, 1);
    expect(released).toEqual([]);
    expect(releases.unreleasedChunks).toBe(1);
    parsed();
    expect(released).toEqual([10]);
    expect(releases.unreleasedChunks).toBe(0);
  });

  test('releases in order: a later chunk waits for every chunk ahead of it', () => {
    const { queue: releases, released } = queue();
    const first = releases.register(3, 1);
    const second = releases.register(5, 1);
    const third = releases.register(7, 1);
    second();
    third();
    expect(released).toEqual([]);
    first();
    expect(released).toEqual([15]);
  });

  test('a chunk with several listeners is released after the last of them reports', () => {
    const { queue: releases, released } = queue();
    const parsed = releases.register(4, 2);
    parsed();
    expect(released).toEqual([]);
    parsed();
    expect(released).toEqual([4]);
  });

  test('reporting a chunk more often than it has listeners does nothing', () => {
    const { queue: releases, released } = queue();
    const parsed = releases.register(4, 1);
    parsed();
    parsed();
    parsed();
    expect(released).toEqual([4]);
  });

  test('counts bytes, so a multi-byte chunk releases its own length', () => {
    const bytes = new TextEncoder().encode('世界');
    const { queue: releases, released } = queue();
    releases.register(bytes.length, 1)();
    expect(released).toEqual([6]);
  });
});
