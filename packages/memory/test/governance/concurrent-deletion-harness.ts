/**
 * Interleaving controls for two-actor deletion tests: each actor is a governed memory built over
 * the same durable state, and these park one of them at a real await so the other can act while
 * it waits. Nothing here mocks the race itself; the parked actor resumes against whatever the
 * store holds by then.
 */
import type { MemoryRecordStorage } from '../../src/memory-record-storage';

/** A point one actor parks at: `reached` settles when it arrives, and it waits for `release()`. */
export interface Park {
  readonly reached: Promise<void>;
  wait(): Promise<void>;
  release(): void;
}

export function park(): Park {
  let arrive!: () => void;
  let release!: () => void;
  const reached = new Promise<void>((resolve) => (arrive = resolve));
  const released = new Promise<void>((resolve) => (release = resolve));
  return {
    reached,
    release,
    async wait() {
      arrive();
      await released;
    },
  };
}

/** `target` with `overrides` in place of some of its methods; the rest stay bound to it. */
export function intercept<T extends object>(target: T, overrides: Partial<T>): T {
  return new Proxy(target, {
    get(object, property) {
      if (property in overrides) return overrides[property as keyof T];
      const value: unknown = Reflect.get(object, property, object);
      return typeof value === 'function' ? value.bind(object) : value;
    },
  });
}

export type LaneBehavior = 'succeed' | 'fail' | 'park' | 'hang';

/**
 * An actor's record storage whose `deleteMany` succeeds, fails, or parks once and then does
 * whatever `behavior` says by the time it is released (`hang` never settles, as a process that
 * stalled for good).
 */
export function controlledLane(storage: MemoryRecordStorage) {
  const parked = park();
  const lane = {
    behavior: 'succeed' as LaneBehavior,
    parked,
    storage: intercept(storage, {
      async deleteMany(...parameters: Parameters<NonNullable<MemoryRecordStorage['deleteMany']>>) {
        if (lane.behavior === 'park') {
          lane.behavior = 'hang';
          await parked.wait();
        }
        if (lane.behavior === 'hang') await new Promise<never>(() => {});
        if (lane.behavior === 'fail') throw new Error('storage unavailable');
        return storage.deleteMany!(...parameters);
      },
    }),
  };
  return lane;
}
