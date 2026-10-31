/** The drafts Settings › Plugins holds: what counts as a change, what clears one, and what is written. */
import { describe, expect, test } from 'bun:test';

import type { PluginStanding, PluginsSnapshot } from '../../../lib/host-plugins.ts';
import { PluginDrafts, parseConfiguration } from './plugin-drafts.svelte.ts';
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

describe('the switch', () => {
  test('is a change only while it differs from what is stored', () => {
    const state = snapshot();
    const drafts = new PluginDrafts();
    const demo = plugin(state, 'demo');

    drafts.setEnabled(demo, true);
    expect(drafts.enabledOf(demo)).toBe(true);
    expect(drafts.changeCount(state)).toBe(1);

    drafts.setEnabled(demo, false);
    expect(drafts.enabledOf(demo)).toBe(false);
    expect(drafts.hasDrafts).toBe(false);
    expect(drafts.changeCount(state)).toBe(0);
  });
});

describe('the configuration', () => {
  test('means the same object whatever its key order or spacing', () => {
    const state = snapshot();
    const drafts = new PluginDrafts();
    const linear = plugin(state, 'linear');

    drafts.setConfiguration(linear, '{"labels":["a","b"],"teamKey":"COR"}');
    expect(drafts.hasDrafts).toBe(false);

    drafts.setConfiguration(linear, '{"labels":["b","a"],"teamKey":"COR"}');
    expect(drafts.changeCount(state)).toBe(1);
  });

  test('is held but never written when it is not an object, and says why', () => {
    const state = snapshot();
    const drafts = new PluginDrafts();
    const linear = plugin(state, 'linear');

    drafts.setConfiguration(linear, '{');
    expect(drafts.invalid(linear)).toBe('syntax');
    expect(drafts.hasInvalid(state)).toBe(true);
    drafts.setConfiguration(linear, '[1]');
    expect(drafts.invalid(linear)).toBe('shape');
    expect(drafts.writes(state)).toEqual([]);
    expect(parseConfiguration('null')).toEqual({ error: 'shape' });
    expect(parseConfiguration('{"a":1}')).toEqual({ value: { a: 1 } });
  });
});

describe('writes', () => {
  test('lists one write per changed plugin with only the fields that changed, in the host’s order', () => {
    const state = snapshot();
    const drafts = new PluginDrafts();
    drafts.setEnabled(plugin(state, 'demo'), true);
    drafts.setConfiguration(plugin(state, 'linear'), '{"teamKey":"ENG"}');
    drafts.setEnabled(plugin(state, 'linear'), false);

    expect(drafts.writes(state)).toEqual([
      { name: 'linear', enabled: false, configuration: { teamKey: 'ENG' } },
      { name: 'demo', enabled: true },
    ]);
    expect(drafts.changeCount(state)).toBe(3);
  });

  test('discard drops every draft', () => {
    const state = snapshot();
    const drafts = new PluginDrafts();
    drafts.setEnabled(plugin(state, 'demo'), true);
    drafts.discard();
    expect(drafts.hasDrafts).toBe(false);
    expect(drafts.writes(state)).toEqual([]);
  });
});

describe('reconcile', () => {
  test('drops a draft the host now holds as its stored choice', () => {
    const state = snapshot();
    const drafts = new PluginDrafts();
    drafts.setEnabled(plugin(state, 'demo'), true);
    drafts.setConfiguration(plugin(state, 'linear'), '{"teamKey":"ENG"}');

    const stored: PluginsSnapshot = {
      ...state,
      plugins: state.plugins.map((entry) =>
        entry.descriptor.name === 'demo' ? { ...entry, enabled: true } : entry,
      ),
    };
    drafts.reconcile(stored);

    expect(drafts.writes(stored)).toEqual([{ name: 'linear', configuration: { teamKey: 'ENG' } }]);
  });
});

describe('a change the host already holds', () => {
  test('counts once for a plugin the page has no draft for', () => {
    const state = snapshot();
    const demo = plugin(state, 'demo');
    const pending: PluginsSnapshot = {
      ...state,
      plugins: state.plugins.map((entry) =>
        entry === demo ? { ...entry, restartRequired: true } : entry,
      ),
    };
    const drafts = new PluginDrafts();
    expect(drafts.changeCount(pending)).toBe(1);
    drafts.setEnabled(plugin(pending, 'demo'), true);
    expect(drafts.changeCount(pending)).toBe(1);
  });
});
