import { throwingRejectionOf } from '@lostgradient/testing/promise-outcome';
import { afterEach, describe, expect, it, spyOn } from 'bun:test';

import type { MemoryGovernanceNotification } from '../../src/governance/governed-memory-types';
import { createGovernedFixture, principalA } from './governed-memory-harness';

/** COR-1723 — `subscribe` hands a caller the notifications `onEvent` receives. */
const note = { collection: 'prefs', source: 'conversation' } as const;

const errorSpies: Array<{ mockRestore(): void }> = [];
afterEach(() => {
  for (const spy of errorSpies.splice(0)) spy.mockRestore();
});

function silenceConsoleError() {
  const spy = spyOn(console, 'error').mockImplementation(() => {});
  errorSpies.push(spy);
  return spy;
}

for (const backend of ['in-memory', 'weft'] as const) {
  describe(`GovernedMemory.subscribe (${backend})`, () => {
    it('delivers the notifications onEvent receives, after onEvent and in subscription order', async () => {
      const calls: string[] = [];
      const sunk: MemoryGovernanceNotification[] = [];
      const fixture = await createGovernedFixture(backend, {
        governed: {
          onEvent: (notification) => {
            sunk.push(notification);
            calls.push(`onEvent:${notification.type}`);
          },
        },
      });
      const received: MemoryGovernanceNotification[] = [];
      fixture.memory.subscribe((notification) => {
        calls.push(`first:${notification.type}`);
        received.push(notification);
      });
      fixture.memory.subscribe((notification) => void calls.push(`second:${notification.type}`));

      await fixture.memory.write(principalA, 'The user likes jazz.', note);

      expect(received.length).toBeGreaterThan(0);
      expect(received).toEqual(sunk);
      expect(calls).toEqual(
        received.flatMap(({ type }) => [`onEvent:${type}`, `first:${type}`, `second:${type}`]),
      );
    });

    it('delivers only what follows the subscription', async () => {
      const fixture = await createGovernedFixture(backend);
      await fixture.memory.write(principalA, 'Before.', note);
      const before = fixture.notifications.length;
      const received: MemoryGovernanceNotification[] = [];
      fixture.memory.subscribe((notification) => void received.push(notification));

      await fixture.memory.write(principalA, 'After.', { ...note });

      expect(received).toEqual(fixture.notifications.slice(before));
      expect(received.length).toBeGreaterThan(0);
    });

    it('stops delivering after unsubscribe, and unsubscribing twice changes nothing', async () => {
      const fixture = await createGovernedFixture(backend);
      const kept: string[] = [];
      const dropped: string[] = [];
      fixture.memory.subscribe((notification) => void kept.push(notification.type));
      const unsubscribe = fixture.memory.subscribe(
        (notification) => void dropped.push(notification.type),
      );
      await fixture.memory.write(principalA, 'One.', note);
      const delivered = dropped.length;
      expect(delivered).toBeGreaterThan(0);

      unsubscribe();
      unsubscribe();
      await fixture.memory.write(principalA, 'Two.', note);

      expect(dropped).toHaveLength(delivered);
      expect(kept.length).toBeGreaterThan(delivered);
    });

    it('treats one function subscribed twice as two subscriptions', async () => {
      const fixture = await createGovernedFixture(backend);
      const types: string[] = [];
      const listener = (notification: MemoryGovernanceNotification) =>
        void types.push(notification.type);
      const first = fixture.memory.subscribe(listener);
      fixture.memory.subscribe(listener);

      first();
      await fixture.memory.write(principalA, 'One.', note);

      expect(types).toEqual(fixture.notifications.map(({ type }) => type));
    });

    it('skips a listener removed by an earlier one during the same delivery', async () => {
      const fixture = await createGovernedFixture(backend);
      const heard: string[] = [];
      const removeFirst = fixture.memory.subscribe(() => {
        removeSecond();
      });
      const removeSecond = fixture.memory.subscribe(() => void heard.push('removed'));
      fixture.memory.subscribe(() => void heard.push('kept'));

      await fixture.memory.write(principalA, 'One.', note);

      expect(heard).not.toContain('removed');
      expect(heard).toContain('kept');
      removeFirst();
    });

    it('reports a throwing or rejecting listener with console.error and neither rejects the call nor skips a later listener', async () => {
      const errorSpy = silenceConsoleError();
      const fixture = await createGovernedFixture(backend);
      const heard: string[] = [];
      fixture.memory.subscribe(() => {
        throw new Error('listener failed');
      });
      fixture.memory.subscribe(async () => {
        throw new Error('async listener failed');
      });
      fixture.memory.subscribe((notification) => void heard.push(notification.type));

      const receipt = await fixture.memory.write(principalA, 'The user likes jazz.', note);

      expect(receipt.status).toBe('admitted');
      expect(heard).toEqual(fixture.notifications.map(({ type }) => type));
      // The rejection of the async listener is reported on a later turn.
      await Promise.resolve();
      const reported = errorSpy.mock.calls.map(([, error]) => (error as Error).message);
      expect(reported).toContain('listener failed');
      expect(reported).toContain('async listener failed');
    });

    it('rejects a listener that is not a function', async () => {
      const fixture = await createGovernedFixture(backend);
      const notAFunction = 'listener' as unknown as (n: MemoryGovernanceNotification) => void;
      expect(() => fixture.memory.subscribe(notAFunction)).toThrow(TypeError);
    });

    it('still notifies subscribers when onEvent throws, and the call rejects as before', async () => {
      const fixture = await createGovernedFixture(backend, {
        governed: {
          onEvent: async () => {
            throw new Error('audit sink down');
          },
        },
      });
      const heard: string[] = [];
      fixture.memory.subscribe((notification) => void heard.push(notification.type));

      expect(await throwingRejectionOf(fixture.memory.write(principalA, 'One.', note))).toThrow(
        'audit sink down',
      );

      expect(heard).toContain('memory.write.admitted');
    });
  });
}
