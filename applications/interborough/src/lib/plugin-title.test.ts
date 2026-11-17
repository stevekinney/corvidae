import { describe, expect, test } from 'bun:test';

import { kindPlugin, pluginTitle } from './plugin-title.ts';

const snapshot = {
  plugins: [
    { descriptor: { name: 'github', title: 'GitHub' } },
    { descriptor: { name: 'linear', title: 'Linear' } },
  ],
} as never;

describe('pluginTitle', () => {
  test('is the title the host reports for the plugin', () => {
    expect(pluginTitle('github', snapshot)).toBe('GitHub');
    expect(pluginTitle('linear', snapshot)).toBe('Linear');
  });

  test('is undefined while the host’s plugins are not loaded, and for a plugin it does not list', () => {
    expect(pluginTitle('github', undefined)).toBeUndefined();
    expect(pluginTitle('slack', snapshot)).toBeUndefined();
  });
});

describe('kindPlugin', () => {
  test('is the plugin before the colon of a contributed kind', () => {
    expect(kindPlugin('github:webhook')).toBe('github');
  });

  test('is undefined for a kind with no plugin', () => {
    expect(kindPlugin('schedule')).toBeUndefined();
    expect(kindPlugin(':orphan')).toBeUndefined();
  });
});
