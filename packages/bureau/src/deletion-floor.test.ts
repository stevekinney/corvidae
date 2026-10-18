import { describe, expect, it } from 'bun:test';

import { createDeletionFloor } from './deletion-floor';

describe('the deletion floor of a session subscription (COR-718)', () => {
  it('reads the floor once per live incarnation, and again when the incarnation changes', async () => {
    const markers = [-1, 7, 12];
    let lookups = 0;
    const floor = createDeletionFloor(async () => markers[lookups++] ?? 99);

    expect(await floor.floorFor('first')).toBe(-1);
    expect(await floor.floorFor('first')).toBe(-1);
    // Another owner's incarnation came and went, and the id is Bob's again.
    expect(await floor.floorFor('third')).toBe(7);
    expect(await floor.floorFor('third')).toBe(7);
    expect(lookups).toBe(2);
  });

  it('is raised by a marker the stream delivers, but only for the incarnation it is read for', async () => {
    let lookups = 0;
    const floor = createDeletionFloor(async () => (lookups++ === 0 ? 3 : 20));

    await floor.floorFor('first');
    floor.raise(9);
    expect(await floor.floorFor('first')).toBe(9);
    floor.raise(2);
    expect(await floor.floorFor('first')).toBe(9);
    expect(await floor.floorFor('second')).toBe(20);
  });

  it('caches nothing when the lookup fails, so the next event reads it afresh', async () => {
    let lookups = 0;
    const floor = createDeletionFloor(async () => {
      lookups += 1;
      if (lookups === 1) throw new Error('injected: marker read failed');
      return 4;
    });

    let failure: unknown;
    try {
      await floor.floorFor('first');
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    expect(await floor.floorFor('first')).toBe(4);
    expect(lookups).toBe(2);
  });
});
