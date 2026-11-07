/** The drafts Settings › Plugins holds: what counts as a change, what clears one, and what is written. */
import { describe, expect, test } from 'bun:test';

import type { PluginStanding, PluginsSnapshot } from '../../../lib/host-plugins.ts';
import { PluginDrafts } from './plugin-drafts.svelte.ts';
import { installFakePluginHost, snapshotOf } from './plugins-host.test-support.ts';

function snapshot(): PluginsSnapshot {
  const host = installFakePluginHost([
    { name: 'linear', configuration: { teamKey: 'COR', labels: ['a', 'b'] } },
    { name: 'demo', enabled: false },
    { name: 'bureau', required: true },
  ]);
  const result = snapshotOf(host);
  host.restore();
  return result;
}

const plugin = (state: PluginsSnapshot, name: string): PluginStanding =>
  state.plugins.find((entry) => entry.descriptor.name === name)!;

const waiting = (state: PluginsSnapshot, name: string): PluginsSnapshot => ({
  ...state,
  plugins: state.plugins.map((entry) =>
    entry.descriptor.name === name ? { ...entry, restartRequired: true } : entry,
  ),
});

describe('the switch', () => {
  test('is a change only while it differs from what is stored', () => {
    const state = snapshot();
    const drafts = new PluginDrafts();
    const demo = plugin(state, 'demo');

    drafts.setEnabled(demo, true);
    expect(drafts.enabledOf(demo)).toBe(true);
    expect(drafts.changed(state).map((entry) => entry.descriptor.name)).toEqual(['demo']);

    drafts.setEnabled(demo, false);
    expect(drafts.enabledOf(demo)).toBe(false);
    expect(drafts.hasDrafts).toBe(false);
    expect(drafts.changed(state)).toEqual([]);
  });
});

describe('writes', () => {
  test('lists one write per switched plugin, in the host’s order', () => {
    const state = snapshot();
    const drafts = new PluginDrafts();
    drafts.setEnabled(plugin(state, 'demo'), true);
    drafts.setEnabled(plugin(state, 'linear'), false);

    expect(drafts.pendingWrites(state)).toEqual([
      { name: 'linear', enabled: false },
      { name: 'demo', enabled: true },
    ]);
  });

  test('discard drops every draft', () => {
    const state = snapshot();
    const drafts = new PluginDrafts();
    drafts.setEnabled(plugin(state, 'demo'), true);
    drafts.discard();
    expect(drafts.hasDrafts).toBe(false);
    expect(drafts.pendingWrites(state)).toEqual([]);
  });
});

describe('reconcile', () => {
  test('drops a draft the host now holds as its stored choice', () => {
    const state = snapshot();
    const drafts = new PluginDrafts();
    drafts.setEnabled(plugin(state, 'demo'), true);
    drafts.setEnabled(plugin(state, 'linear'), false);

    const stored: PluginsSnapshot = {
      ...state,
      plugins: state.plugins.map((entry) =>
        entry.descriptor.name === 'demo' ? { ...entry, enabled: true } : entry,
      ),
    };
    drafts.reconcile(stored);

    expect(drafts.pendingWrites(stored)).toEqual([{ name: 'linear', enabled: false }]);
  });
});

describe('a change the host already holds', () => {
  test('lists a plugin once when it also has a draft', () => {
    const pending = waiting(snapshot(), 'demo');
    const drafts = new PluginDrafts();
    expect(drafts.changed(pending).map((entry) => entry.descriptor.name)).toEqual(['demo']);
    drafts.setEnabled(plugin(pending, 'demo'), true);
    expect(drafts.changed(pending).map((entry) => entry.descriptor.name)).toEqual(['demo']);
  });

  test('lists a plugin a saved configuration waits for, with no draft at all', () => {
    const drafts = new PluginDrafts();
    expect(
      drafts.changed(waiting(snapshot(), 'linear')).map((entry) => entry.descriptor.name),
    ).toEqual(['linear']);
    expect(drafts.hasDrafts).toBe(false);
  });
});
