import { describe, expect, it } from 'bun:test';
import { recoveryFailureLog, withRecoveryLock } from './server-owned-recovery-test-helpers';

describe('withRecoveryLock', () => {
  it('waits for the first recovery before starting the second', async () => {
    let releaseFirst!: () => void;
    const firstReady = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const events: string[] = [];

    const first = withRecoveryLock('conversation-1', async () => {
      events.push('first-start');
      await firstReady;
      events.push('first-finished');
      return 'first';
    });
    await Promise.resolve();
    const second = withRecoveryLock('conversation-1', async () => {
      events.push('second-start');
      return 'second';
    });

    await Promise.resolve();
    expect(events).toEqual(['first-start']);
    releaseFirst();
    expect(await Promise.all([first, second])).toEqual(['first', 'second']);
    expect(events).toEqual(['first-start', 'first-finished', 'second-start']);
  });

  it('does not serialize different conversations', async () => {
    let releaseFirst!: () => void;
    const firstReady = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = withRecoveryLock('conversation-a', async () => {
      await firstReady;
      return 'a';
    });
    const second = withRecoveryLock('conversation-b', async () => 'b');

    expect(await second).toBe('b');
    releaseFirst();
    expect(await first).toBe('a');
  });

  it('makes the loser observe the winner history after classification', async () => {
    let releaseWinner!: () => void;
    const winnerReady = new Promise<void>((resolve) => {
      releaseWinner = resolve;
    });
    const history: string[] = [];

    const winner = withRecoveryLock('conversation-race', async () => {
      await winnerReady;
      history.push('orphaned:run-winner');
      return 'orphaned';
    });
    const loser = withRecoveryLock('conversation-race', async () =>
      history.length > 0 ? 'nothing-to-resume' : 'orphaned',
    );

    releaseWinner();
    expect(await winner).toBe('orphaned');
    expect(await loser).toBe('nothing-to-resume');
    expect(history).toEqual(['orphaned:run-winner']);
  });

  it('serializes the same conversation across module evaluations and cleans up the lock', async () => {
    const reloaded = await import(`./server-owned-recovery.ts?reload=${crypto.randomUUID()}`);
    expect(reloaded.withRecoveryLock).not.toBe(withRecoveryLock);
    let releaseWinner!: () => void;
    const winnerReady = new Promise<void>((resolve) => {
      releaseWinner = resolve;
    });
    const events: string[] = [];

    const winner = withRecoveryLock('conversation-hmr', async () => {
      events.push('winner-start');
      await winnerReady;
      events.push('winner-finished');
      return 'winner';
    });
    await Promise.resolve();
    const loser = reloaded.withRecoveryLock('conversation-hmr', async () => {
      events.push('loser-start');
      return 'loser';
    });

    await Promise.resolve();
    expect(events).toEqual(['winner-start']);
    releaseWinner();
    expect(await Promise.all([winner, loser])).toEqual(['winner', 'loser']);
    expect(events).toEqual(['winner-start', 'winner-finished', 'loser-start']);
    const locks = Reflect.get(
      globalThis,
      Symbol.for('cinder.chat-room.server-owned.recovery-locks'),
    );
    if (!(locks instanceof Map)) throw new Error('Expected recovery locks to be a Map.');
    expect(locks.has('conversation-hmr')).toBe(false);

    // A completed chain removes its key rather than retaining a promise for
    // every conversation forever. The next request can acquire it immediately.
    await reloaded.withRecoveryLock('conversation-hmr', async () => 'fresh');
  });
});

describe('recoveryFailureLog', () => {
  it('identifies the rejected run without exposing a provider reason', () => {
    const log = recoveryFailureLog('conversation-1', 'run-1');
    expect(log).toContain('run-1');
    expect(log).toContain('details withheld');
    expect(log).not.toContain('reason');
  });
});
