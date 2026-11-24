import { QueryClient } from '@tanstack/svelte-query';
import { describe, expect, it } from 'bun:test';
import { validateSeed } from '../tests/fixture/validate-seed.ts';
import { createCatalogHost, createCommand, createRead } from './index.ts';

describe('scoped catalog host', () => {
  it('keeps reads scoped and executes commands only when invoked', async () => {
    const calls: string[] = [];
    const cache = new QueryClient();
    const host = createCatalogHost({
      scope: 'actor-a',
      cache,
      transport: async (name, input) => {
        calls.push(name);
        return input;
      },
    });
    const read = createRead<{ id: string }, { id: string }>(host, 'probe.read', () => ({
      id: '1',
    }));
    const command = createCommand<{ id: string }, { id: string }>(host, 'probe.write', [
      'probe.read',
    ]);
    expect(calls).toEqual([]);
    expect(await read.refresh()).toEqual({ id: '1' });
    expect(await command.mutateAsync({ id: '2' })).toEqual({ id: '2' });
    expect(calls).toEqual(['probe.read', 'probe.write']);
    expect(cache.getQueryData(['backchannel', 'actor-a', 'probe.read', { id: '1' }])).toEqual({
      id: '1',
    });
    host.dispose();
    expect(cache.getQueryCache().getAll()).toHaveLength(0);
  });

  it('aborts and discards a late command when the scope is disposed', async () => {
    let finish!: (value: unknown) => void;
    let signal: AbortSignal | undefined;
    const host = createCatalogHost({
      scope: 'first',
      cache: new QueryClient(),
      transport: (_name, _input, options) => {
        signal = options?.signal;
        return new Promise((resolve) => {
          finish = resolve;
        });
      },
    });
    const pending = createCommand(host, 'probe.secret', []).mutateAsync({});
    host.dispose();
    expect(signal?.aborted).toBe(true);
    finish({ secret: 'unique-secret' });
    await expect(pending).rejects.toThrow();
    expect(host.cache.getMutationCache().getAll()).toHaveLength(0);
  });

  it('discards a command when its scope is disposed between transport completion and delivery', async () => {
    const host = createCatalogHost({
      scope: 'first',
      cache: new QueryClient(),
      transport: async () => ({ secret: 'late-secret' }),
    });
    const pending = createCommand(host, 'issue', []).mutateAsync({});
    queueMicrotask(() => host.dispose());
    await expect(pending).rejects.toThrow();
  });

  it('delivers concurrent responses to their own callers and forwards aborts', async () => {
    const responses = new Map<string, (value: unknown) => void>();
    const signals = new Map<string, AbortSignal | undefined>();
    const host = createCatalogHost({
      scope: 'first',
      cache: new QueryClient(),
      transport: (_name, input, options) => {
        const id = String(input);
        signals.set(id, options?.signal);
        return new Promise((resolve) => responses.set(id, resolve));
      },
    });
    const controller = new AbortController();
    const first = host.call('probe.read', 'first', controller.signal);
    const second = host.call('probe.read', 'second');
    responses.get('second')?.('second-result');
    responses.get('first')?.('first-result');
    expect(await second).toBe('second-result');
    expect(await first).toBe('first-result');
    const interrupted = host.call('probe.read', 'third', controller.signal);
    controller.abort();
    expect(signals.get('third')?.aborted).toBe(true);
    responses.get('third')?.('late');
    await expect(interrupted).rejects.toThrow();
  });

  it('snapshots caller input before asynchronous transport work', async () => {
    let resume!: () => void;
    const host = createCatalogHost({
      scope: 'a',
      cache: new QueryClient(),
      transport: async (_name, input) => {
        await new Promise<void>((resolve) => {
          resume = resolve;
        });
        return input;
      },
    });
    const input = { filter: 'original' };
    const request = host.call('read', input);
    input.filter = 'changed';
    resume();
    expect(await request).toEqual({ filter: 'original' });
  });

  it('validates SSR seeds synchronously and isolates them by scope and input', () => {
    const cache = new QueryClient();
    const host = createCatalogHost({ scope: 'a', cache, transport: async () => null });
    const validate = (value: unknown): value is string => typeof value === 'string';
    expect(() => host.seed('probe.read', { id: 1 }, 42, validate)).toThrow();
    host.seed('probe.read', { id: 1 }, 'seeded', validate);
    expect(cache.getQueryData(host.key('probe.read', { id: 1 }))).toBe('seeded');
    expect(cache.getQueryData(['backchannel', 'b', 'probe.read', { id: 1 }])).toBeUndefined();
    expect(() =>
      host.seed('probe.list', {}, { jobs: [{}], next: null, total: 1 }, validateSeed),
    ).toThrow();
  });

  it('requires reconciliation after an ambiguous command and never replays it', async () => {
    const calls: string[] = [];
    const host = createCatalogHost({
      scope: 'a',
      cache: new QueryClient(),
      transport: async (name) => {
        calls.push(name);
        if (name === 'write') throw new Error('response lost');
        return 'fresh';
      },
    });
    const command = createCommand(host, 'write', ['read']);
    await expect(command.mutateAsync({})).rejects.toThrow('outcome is unknown');
    await expect(command.mutateAsync({})).rejects.toThrow('Reconcile');
    expect(calls).toEqual(['write']);
    await command.reconcile('read', {});
    await expect(command.mutateAsync({})).rejects.toThrow('outcome is unknown');
    expect(calls).toEqual(['write', 'read', 'write']);
  });

  it('does not reconcile while an earlier concurrent command is still pending', async () => {
    let finish!: (value: unknown) => void;
    const calls: string[] = [];
    const host = createCatalogHost({
      scope: 'a',
      cache: new QueryClient(),
      transport: async (name, input) => {
        calls.push(name);
        if (name === 'read') return 'fresh';
        if (input === 'lost') throw new Error('response lost');
        return new Promise((resolve) => {
          finish = resolve;
        });
      },
    });
    const first = createCommand(host, 'write', ['read']);
    const second = createCommand(host, 'write', ['read']);
    const pending = second.mutateAsync('pending');
    await expect(first.mutateAsync('lost')).rejects.toThrow('outcome is unknown');
    await expect(first.reconcile('read', {})).rejects.toThrow('pending');
    expect(calls).toEqual(['write', 'write']);
    finish('settled');
    await pending;
    await first.reconcile('read', {});
    expect(calls).toEqual(['write', 'write', 'read']);
  });

  it('returns a one-time result to its caller without caching it', async () => {
    const secret = `synthetic-${crypto.randomUUID()}`;
    const cache = new QueryClient();
    const history: string[] = [];
    cache.getQueryCache().subscribe((event) => history.push(JSON.stringify(event)));
    cache.getMutationCache().subscribe((event) => history.push(JSON.stringify(event)));
    const host = createCatalogHost({ scope: 'a', cache, transport: async () => ({ secret }) });
    const command = createCommand<{}, { secret: string }>(host, 'issue', []);
    expect(await command.mutateAsync({})).toEqual({ secret });
    const retained = JSON.stringify({
      history,
      queries: cache.getQueryCache().getAll(),
      mutations: cache.getMutationCache().getAll(),
    });
    expect(retained).not.toContain(secret);
  });

  it('returns each concurrent one-time result only to the submitting caller', async () => {
    const callbacks = new Map<string, (result: unknown) => void>();
    const host = createCatalogHost({
      scope: 'a',
      cache: new QueryClient(),
      transport: async (_operation, input) =>
        new Promise((resolve) => callbacks.set(String(input), resolve)),
    });
    const first = createCommand<string, { secret: string }>(host, 'issue', []);
    const second = createCommand<string, { secret: string }>(host, 'issue', []);
    const firstResult = first.mutateAsync('first');
    const secondResult = second.mutateAsync('second');
    callbacks.get('second')!({ secret: 'second-secret' });
    callbacks.get('first')!({ secret: 'first-secret' });
    expect(await firstResult).toEqual({ secret: 'first-secret' });
    expect(await secondResult).toEqual({ secret: 'second-secret' });
    expect(host.cache.getQueryCache().getAll()).toEqual([]);
    expect(host.cache.getMutationCache().getAll()).toEqual([]);
  });

  it('reports pending commands without retaining their results', async () => {
    let finish!: (value: unknown) => void;
    const host = createCatalogHost({
      scope: 'a',
      cache: new QueryClient(),
      transport: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    });
    const command = createCommand(host, 'issue', []);
    const states: boolean[] = [];
    const release = command.pending.subscribe((pending) => states.push(pending));
    const request = command.mutateAsync({});
    finish({ secret: 'once' });
    await request;
    expect(states).toEqual([false, true, false]);
    release();
  });
});
