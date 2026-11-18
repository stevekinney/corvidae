/**
 * COR-2180 — what the Bureau does with the hooks its plugins declare, over the real hooks and a
 * stand-in for the plugin registry: a running plugin's declarations are reconciled (COR-2179), a
 * refused one is left out and reported, a plugin that is not running is left alone, and a plugin the
 * host no longer gives is withdrawn, never deleted.
 */
import type { PluginHook } from '@lostgradient/interborough-plugin';
import { describe, expect, it } from 'bun:test';

import type { BureauDiagnostic } from '../bureau-types/options';
import type { HookInvalidPath } from '../plugins/plugin-types';
import { reconcilePluginHooks, type HookPluginSource } from './reconcile-plugin-hooks.ts';
import { harness } from './hooks-reactions.test-support.ts';

const settled: PluginHook = {
  name: 'Post settled runs',
  events: ['run.settled'],
  reaction: 'post-message',
  configuration: { channel: 'ops' },
};

/** A registry stand-in: the running plugins and what they declare, the plugins known, and what was reported. */
function registry(
  running: Record<string, readonly PluginHook[]>,
  known: readonly string[] = Object.keys(running),
) {
  const reported = new Map<string, { hook: string; path: HookInvalidPath }[]>();
  const source: HookPluginSource = {
    declaredHooks: () => Object.entries(running).map(([plugin, hooks]) => ({ plugin, hooks })),
    knownPlugins: () => new Set(known),
    reportHookProblems: (plugin, problems) => {
      reported.set(plugin, [...problems]);
    },
  };
  return { source, reported };
}

const diagnostics = () => {
  const seen: BureauDiagnostic[] = [];
  return { seen, diagnose: (diagnostic: BureauDiagnostic) => void seen.push(diagnostic) };
};

describe('reconcilePluginHooks (COR-2180)', () => {
  it('creates the hooks a running plugin declares, as default hooks of that plugin', async () => {
    const h = harness();
    const { source, reported } = registry({ slack: [settled] });
    const { diagnose, seen } = diagnostics();

    await reconcilePluginHooks({ hooks: h, plugins: source, diagnose });

    const listed = await h.hooks.list();
    expect(listed.map(({ name, enabled, declaredBy }) => [name, enabled, declaredBy])).toEqual([
      ['Post settled runs', true, { plugin: 'slack' }],
    ]);
    expect(reported.get('slack')).toEqual([]);
    expect(seen).toEqual([]);
  });

  it('leaves out a declaration reconcile refuses and reconciles the rest, naming the hook and field', async () => {
    const h = harness();
    const { source, reported } = registry({
      slack: [
        { ...settled, name: 'Bad configuration', configuration: { channel: 5 } },
        settled,
        { ...settled, name: 'Bad scope', scope: { kind: 'planet', id: 'earth' } as never },
      ],
    });
    const { diagnose, seen } = diagnostics();

    await reconcilePluginHooks({ hooks: h, plugins: source, diagnose });

    const listed = await h.hooks.list();
    expect(listed.map(({ name }) => name)).toEqual(['Post settled runs']);
    expect(reported.get('slack')).toEqual([
      { hook: 'Bad configuration', path: 'configuration' },
      { hook: 'Bad scope', path: 'scope' },
    ]);
    expect(seen).toEqual([]);
  });

  it('withdraws a hook the plugin no longer declares, and keeps it', async () => {
    const h = harness();
    await h.hooks.reconcileDeclared('slack', [settled]);
    const { source } = registry({ slack: [] });

    await reconcilePluginHooks({ hooks: h, plugins: source, diagnose: () => undefined });

    const [hook] = await h.hooks.list();
    expect(hook?.enabled).toBe(false);
    expect(hook?.declaredBy).toEqual({ plugin: 'slack', withdrawn: true });
  });

  it('leaves the hooks of a plugin that is known but not running as they are', async () => {
    const h = harness();
    await h.hooks.reconcileDeclared('slack', [settled]);
    const { source } = registry({}, ['slack']);

    await reconcilePluginHooks({ hooks: h, plugins: source, diagnose: () => undefined });

    const [hook] = await h.hooks.list();
    expect(hook?.enabled).toBe(true);
    expect(hook?.declaredBy).toEqual({ plugin: 'slack' });
  });

  it('withdraws the hooks of a plugin the host no longer gives, and an owner’s hook is not touched', async () => {
    const h = harness();
    await h.hooks.reconcileDeclared('slack', [settled]);
    const own = await h.hook();
    const { source } = registry({}, []);

    await reconcilePluginHooks({ hooks: h, plugins: source, diagnose: () => undefined });

    const listed = await h.hooks.list();
    const byName = new Map(listed.map((hook) => [hook.id, hook]));
    expect(byName.get(own.id)?.enabled).toBe(true);
    const withdrawn = [...byName.values()].filter((hook) => hook.declaredBy !== undefined);
    expect(withdrawn.map((hook) => [hook.enabled, hook.declaredBy])).toEqual([
      [false, { plugin: 'slack', withdrawn: true }],
    ]);
  });

  it('keeps an owner’s turn-off across a reconcile, as a restart does', async () => {
    const h = harness();
    const [created] = await h.hooks.reconcileDeclared('slack', [settled]);
    await h.hooks.update(created!.id, { enabled: false });
    const { source } = registry({ slack: [{ ...settled, configuration: { channel: 'alerts' } }] });

    await reconcilePluginHooks({ hooks: h, plugins: source, diagnose: () => undefined });

    const [hook] = await h.hooks.list();
    expect(hook?.enabled).toBe(false);
    expect(hook?.declaredBy).toEqual({ plugin: 'slack', ownerDisabled: true });
  });

  it('does nothing without hooks, and never rejects when the store fails', async () => {
    const { source } = registry({ slack: [settled] });
    const { diagnose, seen } = diagnostics();
    await reconcilePluginHooks({ hooks: undefined, plugins: source, diagnose });
    expect(seen).toEqual([]);

    const h = harness();
    const failing = {
      ...h.hooks,
      declaredPlugins: () => Promise.reject(new Error('the store is gone')),
    };
    await reconcilePluginHooks({ hooks: { hooks: failing }, plugins: source, diagnose });
    expect(seen.map(({ level, scope }) => [level, scope])).toEqual([['error', 'hooks']]);
  });
});
