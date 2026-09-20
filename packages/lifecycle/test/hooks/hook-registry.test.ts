import { describe, expect, it } from 'bun:test';

import { HookRegistry } from '../../src/hooks/hook-registry';

type TestHooks = {
  beforeRun: (context: { runId: string }) => void;
  afterRun: (context: { runId: string; result: string }) => void;
  transform: (value: string) => string;
};

describe('HookRegistry', () => {
  describe('on', () => {
    it('returns a dispose function that removes the handler', async () => {
      const registry = new HookRegistry<TestHooks>();
      const calls: string[] = [];

      const dispose = registry.on('beforeRun', (context) => {
        calls.push(context.runId);
      });

      await registry.run('beforeRun', { runId: 'run-1' });
      expect(calls).toEqual(['run-1']);

      dispose();

      await registry.run('beforeRun', { runId: 'run-2' });
      expect(calls).toEqual(['run-1']);
    });

    it('orders handlers by priority (higher priority runs first)', async () => {
      const registry = new HookRegistry<TestHooks>();
      const order: number[] = [];

      registry.on(
        'beforeRun',
        () => {
          order.push(1);
        },
        { priority: 1 },
      );
      registry.on(
        'beforeRun',
        () => {
          order.push(10);
        },
        { priority: 10 },
      );
      registry.on(
        'beforeRun',
        () => {
          order.push(5);
        },
        { priority: 5 },
      );

      await registry.run('beforeRun', { runId: 'run-1' });

      expect(order).toEqual([10, 5, 1]);
    });
  });

  describe('has', () => {
    it('returns true when handlers exist for a hook', () => {
      const registry = new HookRegistry<TestHooks>();
      registry.on('beforeRun', () => {});

      expect(registry.has('beforeRun')).toBe(true);
    });

    it('returns false when no handlers exist for a hook', () => {
      const registry = new HookRegistry<TestHooks>();

      expect(registry.has('beforeRun')).toBe(false);
    });

    it('returns false after the only handler is disposed', () => {
      const registry = new HookRegistry<TestHooks>();
      const dispose = registry.on('beforeRun', () => {});

      dispose();

      expect(registry.has('beforeRun')).toBe(false);
    });
  });

  describe('clear', () => {
    it('removes only the specified hook handlers when called with a hook name', async () => {
      const registry = new HookRegistry<TestHooks>();
      const calls: string[] = [];

      registry.on('beforeRun', () => {
        calls.push('beforeRun');
      });
      registry.on('afterRun', () => {
        calls.push('afterRun');
      });

      registry.clear('beforeRun');

      expect(registry.has('beforeRun')).toBe(false);
      expect(registry.has('afterRun')).toBe(true);

      await registry.run('beforeRun', { runId: 'run-1' });
      await registry.run('afterRun', { runId: 'run-1', result: 'done' });

      expect(calls).toEqual(['afterRun']);
    });

    it('removes all handlers when called without arguments', () => {
      const registry = new HookRegistry<TestHooks>();

      registry.on('beforeRun', () => {});
      registry.on('afterRun', () => {});
      registry.on('transform', (value) => value);

      registry.clear();

      expect(registry.has('beforeRun')).toBe(false);
      expect(registry.has('afterRun')).toBe(false);
      expect(registry.has('transform')).toBe(false);
    });
  });

  describe('run', () => {
    it('returns undefined when no handlers are registered', async () => {
      const registry = new HookRegistry<TestHooks>();

      const result = await registry.run('beforeRun', { runId: 'run-1' });

      expect(result).toBeUndefined();
    });
  });
});

// ---------------------------------------------------------------------------
// COR-567 — stable registration identity. Nothing could name one registration
// before this: `handlerIndex` is a position in a freshly sorted copy and
// shifts when an earlier handler is removed.
// ---------------------------------------------------------------------------
describe('registration identity (COR-567)', () => {
  it('assigns a generated id when the registrant supplies none', () => {
    const registry = new HookRegistry<TestHooks>();
    registry.on('beforeRun', () => {});
    registry.on('beforeRun', () => {});

    const ids = registry.getHandlers('beforeRun').map((entry) => entry.id);
    expect(ids).toEqual(['beforeRun#1', 'beforeRun#2']);
  });

  it('keeps a supplied id verbatim', () => {
    const registry = new HookRegistry<TestHooks>();
    registry.on('beforeRun', () => {}, { id: 'bureau:skill-catalog' });

    expect(registry.getHandlers('beforeRun')[0]?.id).toBe('bureau:skill-catalog');
  });

  it('never recycles a generated id after an unregistration', () => {
    const registry = new HookRegistry<TestHooks>();
    const removeFirst = registry.on('beforeRun', () => {});
    registry.on('beforeRun', () => {});

    removeFirst();
    registry.on('beforeRun', () => {});

    // The third registration must not reuse `#1`, or an observer correlating
    // by id would attribute the newcomer's invocations to the removed hook.
    const ids = registry.getHandlers('beforeRun').map((entry) => entry.id);
    expect(ids).toEqual(['beforeRun#2', 'beforeRun#3']);
  });

  it('keeps an id stable while handlerIndex shifts underneath it', async () => {
    const seen: Array<{ id: string; handlerIndex: number }> = [];
    const registry = new HookRegistry<TestHooks>({
      onError: (_error, context) => {
        seen.push({ id: context.id, handlerIndex: context.handlerIndex });
        return 'continue';
      },
    });

    const removeFirst = registry.on('beforeRun', () => {});
    registry.on('beforeRun', () => {
      throw new Error('boom');
    });

    await registry.run('beforeRun', { runId: 'run-1' });
    removeFirst();
    await registry.run('beforeRun', { runId: 'run-1' });

    // Same registration, same id, different position — which is exactly why
    // handlerIndex could never serve as a name.
    expect(seen.map((entry) => entry.id)).toEqual(['beforeRun#2', 'beforeRun#2']);
    expect(seen.map((entry) => entry.handlerIndex)).toEqual([1, 0]);
  });

  it('carries an id through mergeHookRegistries', async () => {
    const { mergeHookRegistries } = await import('../../src/hooks/merge-hook-registries');
    const base = new HookRegistry<TestHooks>();
    base.on('beforeRun', () => {}, { id: 'bureau:invariant' });
    const overlay = new HookRegistry<TestHooks>();
    overlay.on('beforeRun', () => {}, { id: 'agent:custom' });

    const merged = mergeHookRegistries(base, overlay);

    expect(merged.getHandlers('beforeRun').map((entry) => entry.id)).toEqual([
      'bureau:invariant',
      'agent:custom',
    ]);
  });
});
