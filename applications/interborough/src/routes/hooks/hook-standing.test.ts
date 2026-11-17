/**
 * COR-2181 (rows R10-02 and R10-07): a hook has one status, chosen in a fixed order, in the list row
 * and the header alike: Off, then Unavailable (its plugin is disabled or no longer offers its
 * action), then Needs setup, then the latest delivery. The plugin and the action are named by their
 * titles, never by an identifier.
 */
import { describe, expect, test } from 'bun:test';

import type { ContributedHookActionKind } from '../../lib/bureau-plugin-kinds.ts';
import type { PluginsSnapshot } from '../../lib/host-plugins.ts';
import { actionTitleOf, hookStanding, pluginTitleOf, type StandingHook } from './hook-standing.ts';

type Plugins = PluginsSnapshot['plugins'];

function plugin(
  name: string,
  overrides: {
    title?: string;
    status?: string;
    secrets?: readonly { key: string; set: boolean }[];
  } = {},
): Plugins[number] {
  return {
    descriptor: { name, title: overrides.title ?? name },
    status: overrides.status ?? 'running',
    secrets: overrides.secrets ?? [],
  } as never;
}

function reaction(
  pluginName: string,
  kind: string,
  availability: 'available' | 'needs-setup' = 'available',
): ContributedHookActionKind {
  return {
    plugin: pluginName,
    kind,
    description: '',
    version: '1',
    dryRun: false,
    availability,
    configuration: null,
  };
}

const pluginHook = (over: Partial<StandingHook> = {}): StandingHook => ({
  enabled: true,
  action: { type: 'plugin', plugin: 'slack', kind: 'post-message' },
  lastDelivery: null,
  declaredBy: null,
  ...over,
});

const delivered = {
  id: 'd',
  kind: 'run.settled',
  test: false,
  status: 'delivered',
  lastAttempt: null,
  createdAt: 1,
  updatedAt: 1,
} as const;

const SLACK = plugin('slack', { title: 'Slack' });
const POST = reaction('slack', 'post-message');

describe('hookStanding', () => {
  test('is Off before anything else, and says nothing for an owner’s own hook', () => {
    const standing = hookStanding(pluginHook({ enabled: false }), {
      plugins: [plugin('slack', { title: 'Slack', status: 'disabled' })],
      reactions: [],
    });
    expect(standing).toMatchObject({ state: 'off', word: 'Off', sentence: undefined });
  });

  test('says an owner turned a default hook off, in the words of the design', () => {
    const standing = hookStanding(
      pluginHook({
        enabled: false,
        declaredBy: { plugin: 'slack', ownerDisabled: true, withdrawn: false },
      }),
      { plugins: [SLACK], reactions: [POST] },
    );
    expect(standing).toMatchObject({
      state: 'off',
      word: 'Off',
      sentence: 'You turned this hook off. It won’t run until you turn it on.',
    });
  });

  test('says nothing after Off for a default hook its plugin withdrew: the note says it once', () => {
    const standing = hookStanding(
      pluginHook({
        enabled: false,
        declaredBy: { plugin: 'slack', ownerDisabled: false, withdrawn: true },
      }),
      { plugins: [SLACK], reactions: [POST] },
    );
    expect(standing).toMatchObject({ state: 'withdrawn', word: 'Off', sentence: undefined });
  });

  test('is Unavailable when the plugin is disabled, with a link to open it in Settings', () => {
    const standing = hookStanding(pluginHook(), {
      plugins: [plugin('slack', { title: 'Slack', status: 'disabled' })],
      reactions: [],
    });
    expect(standing).toEqual({
      state: 'plugin-disabled',
      word: 'Unavailable',
      sentence: 'Slack is disabled, so this hook can’t run.',
      action: { kind: 'settings', plugin: 'slack', label: 'Open Slack in Settings' },
      plugin: 'slack',
    });
  });

  test('is Unavailable when the plugin is on and no longer offers the action, naming the action in words', () => {
    const standing = hookStanding(pluginHook(), { plugins: [SLACK], reactions: [] });
    expect(standing).toMatchObject({
      state: 'not-offered',
      word: 'Unavailable',
      sentence: 'Slack no longer offers Post message, so this hook can’t run.',
    });
    expect(standing.action).toBeUndefined();
  });

  test('is Unavailable on the Bureau’s own say-so when the listings are not read', () => {
    const standing = hookStanding(pluginHook({ problems: [{ code: 'reaction-unavailable' }] }), {
      plugins: undefined,
      reactions: undefined,
    });
    expect(standing).toMatchObject({
      state: 'not-offered',
      sentence: 'Slack no longer offers Post message, so this hook can’t run.',
    });
  });

  test('is Needs attention when the Bureau lists a configuration-invalid problem, after Off and Unavailable', () => {
    const invalid = {
      code: 'configuration-invalid' as const,
      issues: [{ path: ['channel'], code: 'invalid_type' }],
    };
    const standing = hookStanding(pluginHook({ problems: [invalid] }), {
      plugins: [SLACK],
      reactions: [reaction('slack', 'post-message', 'needs-setup')],
    });
    expect(standing).toEqual({
      state: 'configuration-invalid',
      word: 'Needs attention',
      sentence:
        'Slack changed what Post message takes, so this hook’s configuration no longer fits.',
      plugin: 'slack',
    });
    // Off and Unavailable still come first.
    expect(
      hookStanding(pluginHook({ enabled: false, problems: [invalid] }), {
        plugins: [SLACK],
        reactions: [],
      }).word,
    ).toBe('Off');
    expect(
      hookStanding(pluginHook({ problems: [invalid] }), { plugins: [SLACK], reactions: [] }).word,
    ).toBe('Unavailable');
  });

  test('says Off once for a withdrawn default hook the Bureau lists as reaction-unavailable', () => {
    const standing = hookStanding(
      pluginHook({
        enabled: false,
        declaredBy: { plugin: 'slack', ownerDisabled: false, withdrawn: true },
        problems: [{ code: 'reaction-unavailable' }],
      }),
      { plugins: [SLACK], reactions: [reaction('slack', 'post-message')] },
    );
    expect(standing).toEqual({ state: 'withdrawn', word: 'Off', sentence: undefined });
  });

  test('is Needs setup with Add the key when exactly one secret is missing', () => {
    const standing = hookStanding(pluginHook(), {
      plugins: [
        plugin('slack', {
          title: 'Slack',
          secrets: [
            { key: 'slack-bot-token', set: false },
            { key: 'slack-signing-key', set: true },
          ],
        }),
      ],
      reactions: [reaction('slack', 'post-message', 'needs-setup')],
    });
    expect(standing).toEqual({
      state: 'needs-setup',
      word: 'Needs setup',
      sentence: 'Slack needs setup before this hook can run.',
      action: { kind: 'secret', plugin: 'slack', key: 'slack-bot-token', label: 'Add the key' },
      plugin: 'slack',
    });
  });

  test('is Needs setup with Open <plugin> in Settings when more than one secret is missing, or none can be told', () => {
    const two = hookStanding(pluginHook(), {
      plugins: [
        plugin('slack', {
          title: 'Slack',
          secrets: [
            { key: 'a', set: false },
            { key: 'b', set: false },
          ],
        }),
      ],
      reactions: [reaction('slack', 'post-message', 'needs-setup')],
    });
    expect(two.action).toEqual({
      kind: 'settings',
      plugin: 'slack',
      label: 'Open Slack in Settings',
    });
    const unknown = hookStanding(pluginHook(), {
      plugins: [SLACK],
      reactions: [reaction('slack', 'post-message', 'needs-setup')],
    });
    expect(unknown.action).toMatchObject({ kind: 'settings' });
  });

  test('falls through to the latest delivery’s word, or nothing sent', () => {
    const context = { plugins: [SLACK], reactions: [POST] };
    expect(hookStanding(pluginHook({ lastDelivery: delivered }), context)).toMatchObject({
      state: 'delivery',
      word: 'Delivered',
    });
    expect(hookStanding(pluginHook(), context)).toMatchObject({
      state: 'delivery',
      word: undefined,
    });
    expect(
      hookStanding(
        { enabled: true, action: { type: 'notify', title: null }, lastDelivery: delivered },
        {
          plugins: undefined,
          reactions: undefined,
        },
      ).word,
    ).toBe('Delivered');
  });

  test('guesses nothing from what is not read yet', () => {
    expect(hookStanding(pluginHook(), { plugins: undefined, reactions: undefined })).toMatchObject({
      state: 'delivery',
    });
  });
});

describe('titles', () => {
  test('a plugin is its title, else its name in words; an action is its name in words', () => {
    expect(pluginTitleOf('slack', [SLACK])).toBe('Slack');
    expect(pluginTitleOf('web-search', [])).toBe('Web search');
    expect(pluginTitleOf('web-search', undefined)).toBe('Web search');
    expect(actionTitleOf('post-message')).toBe('Post message');
  });
});
