/**
 * COR-2181: default hooks and plugin hooks on `/hooks` and `/hooks/:hook`, driven through the route
 * outlet against a stand-in Bureau and a stand-in host. A hook a plugin declared is marked Plugin,
 * says one status in a fixed order, and has a page the owner cannot change: its switch and Duplicate,
 * one note, and its configuration as pairs. A hook the owner made that runs a plugin's action shows
 * its configuration as fields, the secret as a Select of keys that holds `{ "$secret": key }` and
 * never a value, and saves it through update. A new hook chooses "Run an action from a plugin" and
 * then an action from a Select grouped by plugin.
 */
import { HttpClient } from '@lostgradient/weft';
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';

import RouteOutletHarness from '../../app/shell/route-outlet.test-harness.svelte';
import {
  installBureauStub,
  StubFault,
  type BureauStub,
} from '../../lib/bureau-stub.test-support.ts';
import { router } from '../../lib/router.svelte.ts';
import { AUTHORIZATION_SCOPES } from '../../lib/scopes.svelte.ts';
import { landAt } from '../chat/pages.test-support.ts';
import {
  installFakePluginHost,
  type FakePluginHost,
  type PluginFixture,
} from '../settings/plugins/plugins-host.test-support.ts';
import { HOOKS_COPY } from './hook-copy.ts';

let stub: BureauStub | undefined;
let host: FakePluginHost | undefined;
afterEach(() => {
  cleanup();
  host?.restore();
  stub?.restore();
  host = undefined;
  stub = undefined;
});

const SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: {
    channel: { type: 'string', title: 'Channel' },
    token: { type: 'string', title: 'Token', secret: true },
  },
  required: ['channel', 'token'],
};

function reaction(
  plugin: string,
  kind: string,
  over: { availability?: 'available' | 'needs-setup'; dryRun?: boolean } = {},
) {
  return {
    plugin,
    kind,
    description: `${kind} does it.`,
    version: '1',
    dryRun: over.dryRun ?? true,
    availability: over.availability ?? 'available',
    configuration: SCHEMA,
  };
}

function hook(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    owner: 'anonymous:local',
    name: id,
    action: {
      type: 'plugin',
      plugin: 'slack',
      kind: 'post-message',
      configuration: { channel: 'ops', token: { $secret: 'slack-bot-token' } },
    },
    events: ['review.requested'],
    scope: null,
    declaredBy: { plugin: 'slack', ownerDisabled: false, withdrawn: false },
    enabled: true,
    createdAt: 1_000,
    updatedAt: 1_000,
    revision: 1,
    ...over,
  };
}

const OWNED = hook('owned', { name: 'My Slack post', declaredBy: null });
const DEFAULT = hook('default-on', { name: 'Post settled runs' });
const OFF = hook('default-off', {
  name: 'Post started runs',
  enabled: false,
  declaredBy: { plugin: 'slack', ownerDisabled: true, withdrawn: false },
});
const WITHDRAWN = hook('default-withdrawn', {
  name: 'Post old runs',
  enabled: false,
  declaredBy: { plugin: 'slack', ownerDisabled: false, withdrawn: true },
});
const PAGER = hook('default-pager', {
  name: 'Page on failures',
  action: { type: 'plugin', plugin: 'pager', kind: 'page', configuration: {} },
  declaredBy: { plugin: 'pager', ownerDisabled: false, withdrawn: false },
});
const CALENDAR = hook('default-calendar', {
  name: 'Add to the calendar',
  action: { type: 'plugin', plugin: 'calendar', kind: 'add', configuration: {} },
  declaredBy: { plugin: 'calendar', ownerDisabled: false, withdrawn: false },
});

const PLUGINS: PluginFixture[] = [
  {
    name: 'slack',
    title: 'Slack',
    secrets: [
      { key: 'slack-bot-token', set: true },
      { key: 'slack-signing-key', set: false },
    ],
  },
  { name: 'pager', title: 'Pager', status: 'disabled', enabled: false },
  {
    name: 'calendar',
    title: 'Calendar',
    status: 'needs-setup',
    secrets: [{ key: 'calendar-token', set: false }],
  },
];

const CATALOG = ['review.requested', 'run.settled'].map((kind) => ({
  kind,
  origin: 'run',
  scopes: [],
  description: `Describes ${kind}`,
  payload: [],
}));

type Handlers = Parameters<typeof installBureauStub>[0];

function open(
  path: string,
  hooks: readonly ReturnType<typeof hook>[],
  handlers: Handlers = {},
  plugins: PluginFixture[] = PLUGINS,
) {
  stub = installBureauStub({
    'bureau.hooks.list': () => ({
      hooks: hooks.map((record) => ({ ...record, lastDelivery: null, problems: [] })),
    }),
    'bureau.hooks.get': (params) => hooks.find((record) => record.id === params['hookId']),
    'bureau.hooks.deliveries': () => ({ deliveries: [] }),
    'bureau.events.catalog': () => ({ events: CATALOG }),
    'bureau.plugins.contributions': () => ({
      providers: [],
      triggers: [],
      reactions: [
        reaction('slack', 'post-message'),
        reaction('calendar', 'add', { availability: 'needs-setup' }),
      ],
    }),
    ...handlers,
  });
  host = installFakePluginHost(plugins);
  landAt(path);
  return render(RouteOutletHarness, {
    props: {
      client: new HttpClient({ baseUrl: 'http://localhost/api' }),
      scopes: AUTHORIZATION_SCOPES,
    },
  } as never);
}

const copy = HOOKS_COPY.editor;

describe('the list (rows R10-01 to R10-03)', () => {
  test('marks what a plugin made with Plugin, never what the owner made', async () => {
    const view = open('/hooks', [DEFAULT, OWNED, OFF]);

    const rows = await waitFor(() => {
      const found = view.container.querySelectorAll<HTMLElement>('li[data-hook]');
      if (found.length !== 3) throw new Error('the rows are not drawn');
      return found;
    });
    const byId = (id: string) =>
      [...rows].find((row) => row.getAttribute('data-hook') === id) as HTMLElement;
    expect(within(byId('default-on')).getByTestId('hook-plugin-badge').textContent).toBe('Plugin');
    expect(within(byId('default-off')).getByTestId('hook-plugin-badge').textContent).toBe('Plugin');
    expect(within(byId('owned')).queryByTestId('hook-plugin-badge')).toBeNull();
  });

  test('shows one status per row in the order Off, Unavailable, Needs setup, then the delivery', async () => {
    const view = open('/hooks', [DEFAULT, OFF, PAGER, CALENDAR]);

    const rows = await waitFor(() => {
      const found = view.container.querySelectorAll<HTMLElement>('li[data-hook]');
      if (found.length !== 4) throw new Error('the rows are not drawn');
      return found;
    });
    const wordOf = (id: string) =>
      [...rows]
        .find((row) => row.getAttribute('data-hook') === id)
        ?.querySelectorAll('[data-status-word], .cinder-status-dot');
    await waitFor(() => {
      expect(
        [...(wordOf('default-pager') ?? [])].map((dot) => dot.getAttribute('data-status-word')),
      ).toEqual(['Unavailable']);
    });
    expect(
      [...(wordOf('default-off') ?? [])].map((dot) => dot.getAttribute('data-status-word')),
    ).toEqual(['Off']);
    expect(
      [...(wordOf('default-calendar') ?? [])].map((dot) => dot.getAttribute('data-status-word')),
    ).toEqual(['Needs setup']);
    // One dot per row: no second status word.
    for (const id of ['default-on', 'default-off', 'default-pager', 'default-calendar']) {
      const row = [...rows].find((candidate) => candidate.getAttribute('data-hook') === id);
      expect(row?.querySelectorAll('.cinder-status-dot').length, id).toBe(1);
    }
  });

  test('shows the problems the Bureau lists, as reaction-unavailable is shown: Needs attention for configuration-invalid (COR-2182)', async () => {
    const invalid = hook('owned-invalid', { name: 'My broken post', declaredBy: null });
    const unavailable = hook('owned-unavailable', { name: 'My lost post', declaredBy: null });
    const view = open('/hooks', [invalid, unavailable], {
      'bureau.hooks.list': () => ({
        hooks: [
          {
            ...invalid,
            lastDelivery: null,
            problems: [
              {
                code: 'configuration-invalid',
                issues: [{ path: ['channel'], code: 'invalid_type' }],
              },
            ],
          },
          { ...unavailable, lastDelivery: null, problems: [{ code: 'reaction-unavailable' }] },
        ],
      }),
    });

    const rows = await waitFor(() => {
      const found = view.container.querySelectorAll<HTMLElement>('li[data-hook]');
      if (found.length !== 2) throw new Error('the rows are not drawn');
      return found;
    });
    const wordOf = (id: string) =>
      [...rows]
        .find((row) => row.getAttribute('data-hook') === id)
        ?.querySelector('[data-status-word]')
        ?.getAttribute('data-status-word');
    await waitFor(() => expect(wordOf('owned-invalid')).toBe('Needs attention'));
    expect(wordOf('owned-unavailable')).toBe('Unavailable');
  });

  test('says Needs attention in the header of a hook the Bureau lists as configuration-invalid, as its row does (COR-2182)', async () => {
    const invalid = hook('owned-invalid', { name: 'My broken post', declaredBy: null });
    const view = open('/hooks/owned-invalid', [invalid], {
      'bureau.hooks.list': () => ({
        hooks: [
          {
            ...invalid,
            lastDelivery: null,
            problems: [
              {
                code: 'configuration-invalid',
                issues: [{ path: ['channel'], code: 'invalid_type' }],
              },
            ],
          },
        ],
      }),
    });

    const header = await view.findByTestId('hook-header');
    await waitFor(() => {
      expect(header.querySelector('[data-status-word]')?.getAttribute('data-status-word')).toBe(
        'Needs attention',
      );
    });
    expect(within(header).getByTestId('hook-standing-sentence').textContent).toBe(
      HOOKS_COPY.standing.configurationInvalid('Slack', 'Post message'),
    );
  });

  test('holds the switch of a hook its plugin withdrew, off, with the reason as a tooltip', async () => {
    const view = open('/hooks', [WITHDRAWN]);

    const row = await waitFor(() => {
      const found = view.container.querySelector<HTMLElement>('li[data-hook="default-withdrawn"]');
      if (found === null) throw new Error('no row');
      return found;
    });
    const toggle = within(row).getByRole('switch');
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    expect(toggle.hasAttribute('disabled') || toggle.getAttribute('aria-disabled') === 'true').toBe(
      true,
    );
    await waitFor(() => {
      const tooltip = row.querySelector('[role="tooltip"]');
      expect(tooltip?.textContent).toBe(HOOKS_COPY.standing.withdrawnSwitch('Slack'));
    });
  });

  test('turns a default hook off through update with enabled only, and says so when it cannot', async () => {
    const view = open('/hooks', [DEFAULT], {
      'bureau.hooks.update': () => {
        throw new StubFault('InvalidParams', 400, 'The Bureau refused it.');
      },
    });

    const row = await waitFor(() => {
      const found = view.container.querySelector<HTMLElement>('li[data-hook="default-on"]');
      if (found === null) throw new Error('no row');
      return found;
    });
    await fireEvent.click(within(row).getByRole('switch'));

    await waitFor(() => expect(stub?.callsTo('bureau.hooks.update')).toHaveLength(1));
    expect(stub?.callsTo('bureau.hooks.update')[0]?.params).toEqual({
      hookId: 'default-on',
      expectedRevision: 1,
      enabled: false,
    });
    await waitFor(() => expect(document.body.textContent).toContain(HOOKS_COPY.toggleFailed));
    // The switch follows the saved state.
    expect(within(row).getByRole('switch').getAttribute('aria-checked')).toBe('true');
  });
});

describe('a default hook’s page (rows R10-04 to R10-09 and R10-17)', () => {
  test('has the switch and Duplicate, no menu and no Delete, one note, and steps that are text', async () => {
    const view = open('/hooks/default-on', [DEFAULT]);

    const header = await view.findByTestId('hook-header');
    expect(within(header).getByRole('switch')).toBeTruthy();
    expect(
      within(header).getByRole('button', { name: HOOKS_COPY.defaultHook.duplicate }),
    ).toBeTruthy();
    expect(within(header).queryByRole('button', { name: copy.header.menuLabel })).toBeNull();
    expect(view.queryByText(copy.check.delete)).toBeNull();

    const note = await view.findByTestId('hook-provenance');
    expect(note.textContent).toContain(
      'Slack adds this hook, so you can turn it off but not change it. Duplicate it to make a copy you can change.',
    );
    expect(within(note).getByRole('link', { name: 'Slack' }).getAttribute('href')).toBe(
      '/settings/plugins?plugin=slack',
    );
    // A link in running text is underlined, so it is told apart without its color.
    expect(within(note).getByRole('link', { name: 'Slack' }).getAttribute('data-underline')).toBe(
      'always',
    );

    // No Edit button, no Name field, no Save hook; the configuration is pairs, never inputs.
    expect(view.queryByRole('button', { name: copy.steps.edit })).toBeNull();
    expect(view.queryByLabelText(copy.check.nameLabel)).toBeNull();
    expect(view.queryByRole('button', { name: copy.check.save })).toBeNull();
    const configuration = await view.findByTestId('contributed-action');
    expect(
      configuration.querySelectorAll('input, select, textarea, [role="combobox"]'),
    ).toHaveLength(0);
    expect([...configuration.querySelectorAll('dt')].map((term) => term.textContent)).toEqual([
      'Channel',
      'Token',
    ]);
    const key = configuration.querySelector('code[data-cinder-secret-key]');
    expect(key?.textContent).toBe('slack-bot-token');
    await waitFor(() => {
      expect(configuration.querySelector('.cinder-status-dot')?.textContent).toContain('Set');
    });
  });

  test('says why a hook turned off by its owner, and a withdrawn one says it once, in the note', async () => {
    const off = open('/hooks/default-off', [OFF]);
    const sentence = await off.findByTestId('hook-standing-sentence');
    expect(sentence.textContent).toBe(HOOKS_COPY.standing.ownerOff);
    cleanup();
    host?.restore();
    stub?.restore();

    const withdrawn = open('/hooks/default-withdrawn', [WITHDRAWN]);
    const note = await withdrawn.findByTestId('hook-provenance');
    expect(note.textContent).toContain(
      'Slack no longer offers this hook, so it stays off. Duplicate it to keep a copy you can change.',
    );
    expect(withdrawn.queryByTestId('hook-standing-sentence')).toBeNull();
    const header = await withdrawn.findByTestId('hook-header');
    const toggle = within(header).getByRole('switch');
    expect(toggle.hasAttribute('disabled') || toggle.getAttribute('aria-disabled') === 'true').toBe(
      true,
    );
    // The held switch gives its reason in a tooltip, the one its list row gives.
    await waitFor(() => {
      expect(header.querySelector('[role="tooltip"]')?.textContent).toBe(
        HOOKS_COPY.standing.withdrawnSwitch('Slack'),
      );
    });
  });

  test('shows the saved configuration of a hook whose action is not offered as pairs, read only', async () => {
    const withConfiguration = (record: ReturnType<typeof hook>) =>
      hook(record.id, {
        ...record,
        action: {
          ...record.action,
          configuration: { channel: 'ops', token: { $secret: 'slack-bot-token' }, limit: 3 },
        },
      });
    for (const [path, record] of [
      // The plugin is disabled.
      ['/hooks/default-pager', withConfiguration(PAGER)],
      // The plugin is on and dropped the action.
      [
        '/hooks/default-dropped',
        hook('default-dropped', {
          name: 'Post thing',
          action: {
            type: 'plugin',
            plugin: 'slack',
            kind: 'gone',
            configuration: { channel: 'ops', token: { $secret: 'slack-bot-token' }, limit: 3 },
          },
        }),
      ],
      // The plugin withdrew the hook and dropped its action.
      [
        '/hooks/default-gone',
        hook('default-gone', {
          name: 'Post gone runs',
          enabled: false,
          action: {
            type: 'plugin',
            plugin: 'slack',
            kind: 'gone',
            configuration: { channel: 'ops', token: { $secret: 'slack-bot-token' }, limit: 3 },
          },
          declaredBy: { plugin: 'slack', ownerDisabled: false, withdrawn: true },
        }),
      ],
    ] as const) {
      const view = open(path, [record]);
      const stored = await view.findByTestId('stored-configuration');
      expect(stored.textContent).toContain(copy.action.storedConfiguration);
      expect(stored.querySelectorAll('input, select, textarea, [role="combobox"]')).toHaveLength(0);
      expect(
        [...stored.querySelectorAll('dd')].map((value) => value.textContent?.trim()),
        path,
      ).toHaveLength(3);
      expect(stored.querySelector('code[data-cinder-secret-key]')?.textContent).toBe(
        'slack-bot-token',
      );
      // No schema says which string is writeOnly, so a saved string is Hidden, never shown in clear.
      expect(stored.textContent).not.toContain('ops');
      expect(stored.textContent).toContain('Hidden');
      expect(stored.textContent).toContain('3');
      expect(view.queryByTestId('contributed-action')).toBeNull();
      cleanup();
      host?.restore();
      stub?.restore();
      host = undefined;
      stub = undefined;
    }
  });

  test('is Unavailable when its plugin is disabled, with a link, and its test is off with the reason', async () => {
    const view = open('/hooks/default-pager', [PAGER]);

    const sentence = await view.findByTestId('hook-standing-sentence');
    expect(sentence.textContent).toBe('Pager is disabled, so this hook can’t run.');
    const header = view.getByTestId('hook-header');
    expect(header.querySelector('[data-status-word="Unavailable"]')).not.toBeNull();
    expect(
      within(header).getByRole('link', { name: 'Open Pager in Settings' }).getAttribute('href'),
    ).toBe('/settings/plugins?plugin=pager');
    const reason = await view.findByTestId('hook-test-reason');
    expect(reason.textContent?.trim()).toBe('Turn on Pager in Settings to test this action.');
    expect(
      within(reason).getByRole('link', { name: 'Settings' }).getAttribute('data-underline'),
    ).toBe('always');
    expect(
      within(header)
        .getByRole('link', { name: 'Open Pager in Settings' })
        .getAttribute('data-underline'),
    ).toBe('always');
    expect(view.getByRole('button', { name: copy.check.test }).getAttribute('aria-disabled')).toBe(
      'true',
    );
  });

  test('is Needs setup with Add the key when exactly one secret is missing, and its test is off before it is pressed', async () => {
    const view = open('/hooks/default-calendar', [CALENDAR]);

    const sentence = await view.findByTestId('hook-standing-sentence');
    expect(sentence.textContent).toBe('Calendar needs setup before this hook can run.');
    const header = view.getByTestId('hook-header');
    // It reads as the "Open <Plugin> in Settings" link of the next state does: Button's link variant.
    expect(
      within(header)
        .getByRole('button', { name: 'Add the key' })
        .getAttribute('data-cinder-variant'),
    ).toBe('link');
    await waitFor(() => {
      expect(view.getByTestId('hook-test-reason').textContent).toBe(
        copy.check.testPluginNeedsSetup('Calendar'),
      );
    });
    expect(view.getByRole('button', { name: copy.check.test }).getAttribute('aria-disabled')).toBe(
      'true',
    );
  });

  test('is Unavailable, and says the plugin dropped the action, when its plugin is on', async () => {
    const dropped = hook('default-dropped', {
      name: 'Post thing',
      action: { type: 'plugin', plugin: 'slack', kind: 'gone', configuration: {} },
    });
    const view = open('/hooks/default-dropped', [dropped]);

    const sentence = await view.findByTestId('hook-standing-sentence');
    expect(sentence.textContent).toBe('Slack no longer offers Gone, so this hook can’t run.');
    await waitFor(() => {
      expect(view.getByTestId('hook-test-reason').textContent?.trim()).toBe(
        copy.check.testNoLongerOffered('Slack'),
      );
    });
  });

  test('Duplicate makes an off copy named “<name> copy”, opens it, and says so', async () => {
    const copied = hook('copy-1', {
      name: 'Post settled runs copy',
      enabled: false,
      declaredBy: null,
    });
    const view = open('/hooks/default-on', [DEFAULT, copied], {
      'bureau.hooks.duplicate': () => ({ ...copied, signingSecret: null }),
    });

    const header = await view.findByTestId('hook-header');
    await fireEvent.click(
      within(header).getByRole('button', { name: HOOKS_COPY.defaultHook.duplicate }),
    );

    await waitFor(() => expect(router.pathname).toBe('/hooks/copy-1'));
    expect(stub?.callsTo('bureau.hooks.duplicate')[0]?.params).toEqual({
      hookId: 'default-on',
      name: 'Post settled runs copy',
    });
    await waitFor(() =>
      expect(document.body.textContent).toContain(HOOKS_COPY.defaultHook.duplicated),
    );
  });

  test('a Duplicate the Bureau refuses says so and stays on the default hook', async () => {
    const view = open('/hooks/default-on', [DEFAULT], {
      'bureau.hooks.duplicate': () => {
        throw new StubFault('InvalidParams', 400, 'No plugin offers it.');
      },
    });

    const header = await view.findByTestId('hook-header');
    await fireEvent.click(
      within(header).getByRole('button', { name: HOOKS_COPY.defaultHook.duplicate }),
    );

    await waitFor(() =>
      expect(document.body.textContent).toContain(HOOKS_COPY.defaultHook.duplicateFailed),
    );
    expect(router.pathname).toBe('/hooks/default-on');
  });

  test('a default hook’s switch saves through update with enabled only', async () => {
    const view = open('/hooks/default-on', [DEFAULT], {
      'bureau.hooks.update': (params) => ({ ...DEFAULT, enabled: params['enabled'], revision: 2 }),
    });

    const header = await view.findByTestId('hook-header');
    await fireEvent.click(within(header).getByRole('switch'));

    await waitFor(() => expect(stub?.callsTo('bureau.hooks.update')).toHaveLength(1));
    expect(stub?.callsTo('bureau.hooks.update')[0]?.params).toEqual({
      hookId: 'default-on',
      expectedRevision: 1,
      enabled: false,
    });
  });
});

describe('a hook the owner made that runs a plugin’s action (rows R10-10 to R10-16 and R10-22)', () => {
  const KEYS = [
    { name: 'slack', title: 'Slack', secrets: PLUGINS[0]?.secrets ?? [] },
  ] satisfies PluginFixture[];

  test('shows its configuration as fields, the secret as a Select of keys and never an input', async () => {
    const view = open('/hooks/owned', [OWNED], {}, KEYS);

    const action = await view.findByTestId('contributed-action');
    expect(await within(action).findByLabelText('Channel')).toBeTruthy();
    const token = await within(action).findByRole('combobox', { name: /^Token/ });
    expect(token.textContent).toContain('slack-bot-token');
    expect(action.querySelectorAll('input[type="password"]')).toHaveLength(0);
    expect(action.textContent).toContain(HOOKS_COPY.secrets.help);
    expect(view.getByTestId('hook-plugin-action').textContent?.trim()).toBe(
      'Post message from Slack',
    );

    await fireEvent.click(token);
    await waitFor(() => {
      const rows = [...document.body.querySelectorAll('[role="option"]')];
      expect(rows.length).toBeGreaterThan(0);
    });
    const rows = [...document.body.querySelectorAll('[role="option"]')];
    const note = (key: string) =>
      rows
        .find(
          (row) =>
            row.querySelector('.cinder-select__option-label .cinder-text')?.textContent === key,
        )
        ?.querySelector('.cinder-select__option-note')?.textContent;
    expect(note('slack-bot-token')).toBe('Set');
    expect(note('slack-signing-key')).toBe('Missing');
    // Row R10-13: every key row is an identifier, in monospace and cut only in its middle.
    for (const row of rows.filter((candidate) => candidate.textContent?.includes('slack-'))) {
      const key = row.querySelector('.cinder-select__option-label .cinder-text');
      expect(key?.getAttribute('data-cinder-variant')).toBe('code');
      expect(key?.getAttribute('data-cinder-truncate')).toBe('middle');
    }
    expect(
      [
        ...document.body.querySelectorAll('.cinder-select__group .cinder-_option-group__heading'),
      ].map((heading) => heading.textContent?.trim()),
    ).toEqual(['Slack']);
  });

  test('on a phone its configuration is still shown as fields, not folded into a summary', async () => {
    const original = Object.getOwnPropertyDescriptor(window, 'matchMedia');
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: (query: string) => ({
        media: query,
        matches: query.includes('640'),
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        addListener: () => undefined,
        removeListener: () => undefined,
      }),
    });
    try {
      const view = open('/hooks/owned', [OWNED], {}, KEYS);

      const action = await view.findByTestId('contributed-action');
      expect((within(action).getByLabelText('Channel') as HTMLInputElement).value).toBe('ops');
      expect(view.queryByTestId('hook-step-summary-then')).toBeNull();
    } finally {
      if (original === undefined) Reflect.deleteProperty(window, 'matchMedia');
      else Object.defineProperty(window, 'matchMedia', original);
    }
  });

  test('saves a changed configuration through update, the secret as its reference alone', async () => {
    const view = open(
      '/hooks/owned',
      [OWNED],
      { 'bureau.hooks.update': (params) => ({ ...OWNED, ...params, revision: 2 }) },
      KEYS,
    );

    const action = await view.findByTestId('contributed-action');
    const channel = await within(action).findByLabelText('Channel');
    await fireEvent.input(channel, { target: { value: 'alerts' } });
    await fireEvent.click(view.getByRole('button', { name: copy.check.save }));

    await waitFor(() => expect(stub?.callsTo('bureau.hooks.update')).toHaveLength(1));
    const sent = stub?.callsTo('bureau.hooks.update')[0]?.params;
    expect(sent?.['action']).toEqual({
      type: 'plugin',
      plugin: 'slack',
      kind: 'post-message',
      configuration: { channel: 'alerts', token: { $secret: 'slack-bot-token' } },
    });
    expect(JSON.stringify(sent)).not.toContain('"token":"');
  });

  test('warns under a chosen key that is Missing, and Add the key opens the dialog that saves it', async () => {
    const missing = hook('owned-missing', {
      name: 'My Slack post',
      declaredBy: null,
      action: {
        type: 'plugin',
        plugin: 'slack',
        kind: 'post-message',
        configuration: { channel: 'ops', token: { $secret: 'slack-signing-key' } },
      },
    });
    const view = open('/hooks/owned-missing', [missing], {}, KEYS);

    const action = await view.findByTestId('contributed-action');
    const warning = await waitFor(() => {
      const found = action.querySelector('.cinder-schema-form__secret-warning');
      if (found === null) throw new Error('no warning');
      return found;
    });
    expect(warning.textContent).toContain(HOOKS_COPY.secrets.missing('slack-signing-key'));
    expect(warning.querySelector('code')?.textContent).toBe('slack-signing-key');
    await fireEvent.click(
      within(warning as HTMLElement).getByRole('button', { name: 'Add the key' }),
    );

    expect(await view.findByRole('dialog', { name: 'Save slack-signing-key' })).toBeTruthy();
  });

  test('with no key to choose the Select is disabled and says where one is saved', async () => {
    // No key is saved and none is chosen: a chosen key would be a row of its own, shown as Missing.
    const unchosen = hook('owned-unchosen', {
      name: 'My Slack post',
      declaredBy: null,
      action: {
        type: 'plugin',
        plugin: 'slack',
        kind: 'post-message',
        configuration: { channel: 'ops' },
      },
    });
    const view = open('/hooks/owned-unchosen', [unchosen], {}, [{ name: 'slack', title: 'Slack' }]);

    const action = await view.findByTestId('contributed-action');
    await waitFor(() => {
      if (action.querySelector('.cinder-schema-form__secret-help') === null) {
        throw new Error('the help is not drawn');
      }
    });
    const token = within(action).getByRole('combobox', { name: /^Token/ });
    expect(token.hasAttribute('disabled') || token.getAttribute('aria-disabled') === 'true').toBe(
      true,
    );
    expect(token.textContent).toContain('No secrets to choose');
    const help = action.querySelector('.cinder-schema-form__secret-help');
    expect(help?.textContent?.replaceAll(/\s+/g, ' ').trim()).toBe(
      'Plugins name the secrets they use. Save one in Settings › Plugins.',
    );
    expect(
      within(help as HTMLElement)
        .getByRole('link')
        .getAttribute('href'),
    ).toBe('/settings/plugins?plugin=slack');
  });

  test('when the keys cannot be read says so with Try again and leaves the other fields usable', async () => {
    const failing = open('/hooks/owned', [OWNED], {}, KEYS);
    // The host answers no read: set before the page's first read is sent.
    host!.failReads = 10;

    const action = await failing.findByTestId('contributed-action');
    await waitFor(() => {
      expect(action.querySelector('.cinder-schema-form__secret-failed')?.textContent).toContain(
        HOOKS_COPY.secrets.failed,
      );
    });
    const channel = within(action).getByLabelText('Channel');
    await fireEvent.input(channel, { target: { value: 'alerts' } });
    expect((channel as HTMLInputElement).value).toBe('alerts');
  });

  test('a refused save keeps every value and shows the refusal on the field', async () => {
    const view = open(
      '/hooks/owned',
      [OWNED],
      {
        'bureau.hooks.update': () => {
          throw new StubFault('InvalidParams', 400, 'The configuration is refused.', {
            issues: [
              {
                path: ['action', 'configuration', 'channel'],
                message: 'That channel is not one this workspace has.',
                code: 'custom',
              },
            ],
          });
        },
      },
      KEYS,
    );

    const action = await view.findByTestId('contributed-action');
    const channel = await within(action).findByLabelText('Channel');
    await fireEvent.input(channel, { target: { value: 'nowhere' } });
    await fireEvent.click(view.getByRole('button', { name: copy.check.save }));

    const failure = await view.findByTestId('hook-failure');
    expect(failure.textContent).toContain(copy.saveFailed);
    expect(failure.textContent).toContain(copy.saveFailedKept);
    expect((within(action).getByLabelText('Channel') as HTMLInputElement).value).toBe('nowhere');
    await waitFor(() => {
      expect(action.textContent).toContain('That channel is not one this workspace has.');
    });
  });

  test('says no plugin, action or event kind as an identifier: each is its title or its name in words', async () => {
    const view = open('/hooks/owned', [OWNED], {}, KEYS);

    await view.findByTestId('hook-plugin-action');
    const text = view.container.textContent ?? '';
    expect(text).not.toContain('post-message');
    expect(text).not.toContain('slack ');
  });

  test('tests a hook while its plugin is on, and shows the button loading while it runs', async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const view = open(
      '/hooks/owned',
      [OWNED],
      {
        'bureau.hooks.test': async () => {
          await held;
          return {
            id: 't',
            hookId: 'owned',
            owner: 'anonymous:local',
            actionType: 'plugin',
            kind: 'hook.test',
            test: true,
            status: 'delivered',
            request: null,
            work: null,
            attempts: [],
            maxAttempts: 1,
            nextAttemptAt: null,
            createdAt: 1,
            updatedAt: 1,
          };
        },
      },
      KEYS,
    );

    const test = await waitFor(() => {
      const button = view.getByRole('button', { name: copy.check.test });
      if (button.getAttribute('aria-disabled') === 'true') throw new Error('still off');
      return button;
    });
    await fireEvent.click(test);
    await waitFor(() => expect(test.hasAttribute('data-cinder-loading')).toBe(true));
    release();
    await waitFor(() => expect(test.hasAttribute('data-cinder-loading')).toBe(false));
  });
});

describe('a new hook that runs a plugin’s action (rows R10-20 and R10-21)', () => {
  test('offers the four actions as one choice, and a plugin’s action from a Select grouped by plugin', async () => {
    const view = open('/hooks/new', []);

    const group = await view.findByRole('radiogroup', { name: copy.action.label });
    // The plugin choice appears once the Bureau has listed what plugins offer.
    await within(group).findByRole('radio', { name: copy.action.plugin });
    expect(
      [...group.querySelectorAll('[role="radio"]')].map((radio) => radio.textContent?.trim()),
    ).toEqual([
      copy.action.webhook,
      copy.action.startWorkflow,
      copy.action.notify,
      copy.action.plugin,
    ]);
    // The control falls back to a Select when the four do not fit.
    expect(group.closest('.cinder-segmented-control-container')).not.toBeNull();

    await fireEvent.click(within(group).getByRole('radio', { name: copy.action.plugin }));
    const select = await view.findByRole('combobox', { name: /^Action/ });
    await fireEvent.click(select);
    await waitFor(() => {
      expect(document.body.querySelectorAll('[role="option"]').length).toBe(2);
    });
    const headings = [
      ...document.body.querySelectorAll('.cinder-select__group .cinder-_option-group__heading'),
    ].map((heading) => heading.textContent?.trim());
    expect(headings).toEqual(['Slack', 'Calendar']);
    const options = [...document.body.querySelectorAll('[role="option"]')];
    const calendar = options.find((option) => option.textContent?.includes('Add'));
    expect(calendar?.querySelector('.cinder-select__option-note')?.textContent).toBe(
      copy.action.needsSetup,
    );
    // An action whose plugin needs setup can still be chosen.
    await fireEvent.click(calendar as HTMLElement);
    const configuration = await view.findByTestId('contributed-action');
    expect(within(configuration).getByLabelText('Channel')).toBeTruthy();
  });

  test('asks for an action before it saves', async () => {
    const view = open('/hooks/new', []);

    const group = await view.findByRole('radiogroup', { name: copy.action.label });
    await fireEvent.click(await within(group).findByRole('radio', { name: copy.action.plugin }));
    await view.findByRole('combobox', { name: /^Action/ });
    await fireEvent.click(view.getByRole('button', { name: copy.check.create }));

    await waitFor(() => expect(view.container.textContent).toContain(copy.action.pluginRequired));
  });
});
