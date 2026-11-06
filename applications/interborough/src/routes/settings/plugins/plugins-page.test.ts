/**
 * `/settings/plugins` (COR-1891, COR-2019): the plugins the host loaded as a list with the open one
 * beside it, what each adds, its configuration as a form, and the restart that applies the
 * changes. The Bureau is a stub (`../settings-fixtures.test-support.ts`) and the host's plugin
 * routes a stand-in (`plugins-host.test-support.ts`); the real routes are exercised by
 * `src/host/host-plugins.test.ts`.
 */
import { HttpClient } from '@lostgradient/weft';
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { PLUGINS_COPY, RESTART_COPY, SETTINGS_COPY } from '../../../app/copy.ts';
import { restartProbing } from '../../../app/restart/host-restart-flow.svelte.ts';
import RouteOutletHarness from '../../../app/shell/route-outlet.test-harness.svelte';
import type { BureauStub } from '../../../lib/bureau-stub.test-support.ts';
import { AUTHORIZATION_SCOPES } from '../../../lib/scopes.svelte.ts';
import { landAt } from '../../chat/pages.test-support.ts';
import { installSettingsBureau, servedSettings } from '../settings-fixtures.test-support.ts';
import {
  contribution,
  installFakePluginHost,
  type FakePluginHost,
  type PluginFixture,
} from './plugins-host.test-support.ts';

const SECRET = 'tsk-live-0123456789-never-print-this';
const BANNER = SETTINGS_COPY.general.restartBanner;

/** A configuration schema as a plugin's own Zod schema writes it: one field of each control. */
const LINEAR_SCHEMA = {
  type: 'object',
  properties: {
    teamKey: { type: 'string', title: 'Team key', description: 'The team the issues go to.' },
    region: { type: 'string', enum: ['us', 'eu'], description: 'Where the work runs.' },
    labels: { type: 'array', items: { type: 'string' }, description: 'Added to every issue.' },
    snippets: { type: 'boolean', description: 'Show an excerpt.' },
    cacheMs: { type: 'number', description: 'How long a result is kept.' },
  },
  required: ['teamKey'],
};

function fixtures(): PluginFixture[] {
  return [
    {
      name: 'linear',
      title: 'Linear',
      version: '0.3.0',
      description: 'Linear issues, as tools agents can use.',
      source: 'folder',
      location: '/home/.interborough/plugins/linear',
      configuration: { teamKey: 'COR' },
      configurationSchema: LINEAR_SCHEMA,
      contributions: [
        contribution('tool', 'linear:create-issue@1.0.0', { agents: 1 }, 'Create an issue'),
        contribution('activity', 'linear:sync-issue', { waitingRuns: 1 }),
        contribution('trigger-kind', 'linear:issue-created', { schedules: 2 }),
      ],
    },
    {
      name: 'anthropic',
      title: 'Anthropic',
      description: 'Claude models for your agents.',
      contributions: [contribution('provider', 'anthropic:anthropic')],
      secrets: [{ key: 'anthropic-api-key', set: true }],
    },
    {
      name: 'typesafe',
      title: 'TypeSafe',
      status: 'needs-setup',
      contributions: [contribution('decision-router', 'typesafe:jev')],
      secrets: [{ key: 'typesafe-api-key', set: false }],
      problems: [
        { code: 'secret-missing', key: 'typesafe-api-key', contributions: ['typesafe:jev'] },
      ],
    },
    {
      name: 'openai',
      title: 'OpenAI',
      status: 'needs-setup',
      contributions: [contribution('provider', 'openai:openai')],
      secrets: [{ key: 'openai-api-key', set: false }],
      problems: [{ code: 'secret-missing', key: 'openai-api-key', contributions: [] }],
    },
    {
      name: 'bureau',
      source: 'built-in',
      location: '@lostgradient/bureau',
      required: true,
      contributions: [contribution('tool', 'bureau:discover-agents')],
    },
    { name: 'demo', title: 'Demo', description: 'Sample tools and agents.', enabled: false },
  ];
}

type AgentListing = { id: string; name: string; state: 'ready' | 'unavailable' };

let host: FakePluginHost | undefined;
let stub: BureauStub | undefined;
const probing = { ...restartProbing };

beforeEach(() => {
  restartProbing.delayMs = 0;
  restartProbing.retryDelayMs = () => 0;
});

afterEach(() => {
  cleanup();
  // Newest first: each stand-in restores the fetch it found.
  host?.restore();
  host = undefined;
  stub?.restore();
  stub = undefined;
  Object.assign(restartProbing, probing);
});

function mount(
  at: string,
  plugins: PluginFixture[] = fixtures(),
  options: Parameters<typeof installFakePluginHost>[1] & {
    agents?: AgentListing[];
    skills?: { name: string; plugin: string }[];
    pendingSettings?: string[];
  } = {},
) {
  const { agents = [], skills = [], pendingSettings = [], ...hostOptions } = options;
  stub = installSettingsBureau(servedSettings({ pendingRestart: new Set(pendingSettings) }), {
    'bureau.agents.definitions.list': () => ({
      agents: agents.map((agent) => ({
        ...agent,
        source: 'code',
        unavailable:
          agent.state === 'unavailable'
            ? { code: 'plugin-disabled', message: 'Plugin is disabled' }
            : null,
        description: null,
        a2a: false,
        hash: null,
        problem: null,
      })),
      nextOffset: null,
    }),
    'bureau.skills.list': () => ({
      skills: skills.map((skill) => ({
        name: skill.name,
        description: '',
        source: { id: skill.plugin, kind: 'plugin', location: '', plugin: skill.plugin },
        trust: 'trusted',
        trustReason: '',
        available: true,
        unavailableReason: null,
        allowedTools: [],
      })),
      sources: [],
    }),
  });
  host = installFakePluginHost(plugins, hostOptions);
  landAt(at);
  return render(RouteOutletHarness, {
    props: {
      client: new HttpClient({ baseUrl: 'http://localhost/api' }),
      scopes: AUTHORIZATION_SCOPES,
    },
  } as never);
}

const open = (plugin: string, plugins?: PluginFixture[], options?: Parameters<typeof mount>[2]) =>
  mount(`/settings/plugins?plugin=${plugin}`, plugins, options);

const writes = () => (host?.requests ?? []).filter((request) => request.method !== 'GET');
const rowOf = (container: HTMLElement, name: string) =>
  container.querySelector<HTMLElement>(`[data-plugin-row="${name}"]`);
const banner = (container: HTMLElement) =>
  container.querySelector<HTMLElement>('[data-testid="settings-restart-summary"]');
/** The banner's text, or `null` without one; cheap to print when an assertion on it fails. */
const bannerText = (container: HTMLElement) => banner(container)?.textContent ?? null;
const bodyOf = (container: HTMLElement) => within(container.ownerDocument.body);
const detailOf = (container: HTMLElement) =>
  container.querySelector<HTMLElement>('[data-plugin-detail]')!;

/** Restart now asks first (`RESTART_COPY.confirm`): this presses it and confirms. */
async function restartNow(container: HTMLElement): Promise<void> {
  await fireEvent.click(
    within(banner(container)!).getByRole('button', { name: RESTART_COPY.confirm.confirm }),
  );
  const question = await bodyOf(container).findByRole('dialog', {
    name: RESTART_COPY.confirm.title,
  });
  await fireEvent.click(
    within(question).getByRole('button', { name: RESTART_COPY.confirm.confirm }),
  );
}

/** The enable question, once the switch of a disabled plugin has been pressed. */
const enableQuestion = (container: HTMLElement, plugin: string) =>
  bodyOf(container).findByRole('dialog', { name: PLUGINS_COPY.enable.title(plugin) });

/** Confirms the enable question: it writes the choice and restarts, with no second question. */
async function confirmEnable(container: HTMLElement, plugin = 'Demo'): Promise<void> {
  const question = await enableQuestion(container, plugin);
  await fireEvent.click(
    within(question).getByRole('button', { name: PLUGINS_COPY.enable.confirm }),
  );
}

/** The restart dialog's card, which carries the phase it shows. */
async function restartCard(container: HTMLElement): Promise<HTMLElement> {
  return waitFor(() => {
    const card = container.ownerDocument.body.querySelector<HTMLElement>(
      '.cinder-restart-state__card',
    );
    expect(card).not.toBeNull();
    return card!;
  });
}

/** The banner that says what applied once the host is back. */
async function backBanner(container: HTMLElement): Promise<HTMLElement> {
  return waitFor(() => {
    const back = container.querySelector<HTMLElement>('[data-testid="restart-back"]');
    expect(back).not.toBeNull();
    return back!;
  });
}

async function loaded(container: HTMLElement, plugin: string) {
  await waitFor(() => expect(rowOf(container, plugin)).not.toBeNull());
  await waitFor(() => expect(container.querySelector('[data-plugin-detail]')).not.toBeNull());
}

/** A field of the open plugin's configuration form. */
const fieldOf = (container: HTMLElement, key: string) =>
  container.querySelector<HTMLElement>(`[data-configuration-field="${key}"]`)!;
const saveButton = (container: HTMLElement) =>
  within(container).getByRole('button', { name: PLUGINS_COPY.configuration.save });

describe('the list', () => {
  test('shows each plugin by its name with its version, status and kind, and the open one beside it', async () => {
    const { container } = open('linear');
    await loaded(container, 'linear');

    const linear = rowOf(container, 'linear')!;
    expect(linear.textContent).toContain('Linear');
    expect(linear.textContent).toContain('0.3.0');
    expect(linear.textContent).toContain(PLUGINS_COPY.status.running);
    expect(linear.textContent).toContain(PLUGINS_COPY.source.folder);
    expect(rowOf(container, 'typesafe')?.textContent).toContain(PLUGINS_COPY.status.needsSetup);
    expect(rowOf(container, 'demo')?.textContent).toContain(PLUGINS_COPY.status.disabled);
    expect(rowOf(container, 'bureau')?.textContent).toContain(PLUGINS_COPY.source.builtIn);
    expect(container.querySelector('nav a[aria-current="page"]')?.textContent?.trim()).toBe(
      'Plugins',
    );
  });

  test('needs setup is neutral, and the list header counts the plugins beside a link to how to add one', async () => {
    const { container, getByRole } = open('linear');
    await loaded(container, 'linear');

    const dot = rowOf(container, 'typesafe')!.querySelector('[data-cinder-status]');
    expect(dot?.getAttribute('data-cinder-status')).toBe('neutral');
    expect(container.querySelector('[data-testid="plugins-count"]')?.textContent?.trim()).toBe(
      `${PLUGINS_COPY.listHeader.heading} 6`,
    );
    const link = getByRole('link', { name: PLUGINS_COPY.listHeader.howToAdd });
    expect(link.getAttribute('href')).toBe(PLUGINS_COPY.listHeader.howToAddHref);
  });

  test('says the server answered with an error, offers Try again and Open Health, and reads again on Try again', async () => {
    const opened = mount('/settings/plugins');
    host!.failReads = 1;
    const retry = await opened.findByRole('button', { name: 'Try again' });
    expect(opened.container.textContent).toContain('Couldn’t load plugins.');
    expect(opened.container.textContent).toContain(
      'The server answered with an error (500). Nothing you did caused it.',
    );
    expect(opened.getByRole('link', { name: 'Open Health' }).getAttribute('href')).toBe('/health');

    await fireEvent.click(retry);

    await waitFor(() => expect(rowOf(opened.container, 'linear')).not.toBeNull());
  });
});

describe('a plugin', () => {
  test('shows its name, version and description, its switch, where it came from, and what it adds under human names', async () => {
    const { container, getByRole } = open('linear');
    await loaded(container, 'linear');

    const detail = detailOf(container);
    expect(detail.querySelector('h3')?.textContent).toBe('Linear');
    expect(detail.textContent).toContain('0.3.0');
    expect(detail.textContent).toContain('Linear issues, as tools agents can use.');
    expect(getByRole('switch', { name: PLUGINS_COPY.enabled }).getAttribute('aria-checked')).toBe(
      'true',
    );
    expect(detail.textContent).toContain('/home/.interborough/plugins/linear');
    expect(detail.textContent).toContain(PLUGINS_COPY.sourceKind.folder);
    const adds = detail.querySelector('[data-testid="plugin-adds"]')!;
    expect(adds.textContent).toContain(PLUGINS_COPY.contributionKinds['tool']!);
    // The title the plugin gave, with the identifier (and no version) small beside it.
    expect(adds.querySelector('[data-contribution="linear:create-issue"]')?.textContent).toContain(
      'Create an issue',
    );
    expect(adds.querySelector('[data-contribution="linear:create-issue"]')?.textContent).toContain(
      'linear:create-issue',
    );
    // A name with no title is the identifier as words.
    expect(adds.querySelector('[data-contribution="linear:sync-issue"]')?.textContent).toContain(
      'Sync issue',
    );
    // Tools come before activities, then the other kinds.
    expect([...adds.querySelectorAll('dt')].map((term) => term.textContent)).toEqual([
      'Tools',
      'Activities',
      'Triggers',
    ]);
  });

  test('says what uses a running plugin, or that nothing does yet', async () => {
    const { container } = open('linear');
    await loaded(container, 'linear');
    expect(
      detailOf(container).querySelector('[data-testid="plugin-in-use"]')?.textContent,
    ).toContain('In use. 1 agent, 2 schedules and 1 waiting run use Linear.');

    await fireEvent.click(rowOf(container, 'anthropic')!);
    await waitFor(() =>
      expect(container.querySelector('[data-plugin-detail="anthropic"]')).not.toBeNull(),
    );
    expect(
      container
        .querySelector('[data-plugin-detail="anthropic"] [data-testid="plugin-in-use"]')
        ?.textContent?.replaceAll(/\s+/g, ' ')
        .trim(),
    ).toBe('In use. Nothing uses Anthropic yet.');
  });

  test('lists the skills it ships under Skills', async () => {
    const { container } = open('linear', fixtures(), {
      skills: [
        { name: 'tips', plugin: 'linear' },
        { name: 'other', plugin: 'demo' },
      ],
    });
    await loaded(container, 'linear');

    const skill = await waitFor(() => {
      const found = container.querySelector<HTMLElement>('[data-contribution="linear:tips"]');
      expect(found).not.toBeNull();
      return found!;
    });
    expect(skill.textContent).toContain('Tips');
    expect(container.querySelector('[data-contribution="linear:other"]')).toBeNull();
    const terms = [...detailOf(container).querySelectorAll('dt')].map((term) => term.textContent);
    expect(terms).toContain(PLUGINS_COPY.contributionKinds['skill']!);
  });

  test('a disabled plugin reads Disabled, says what it holds back, and explains that enabling it restarts', async () => {
    const { container, getByRole } = open('demo', fixtures(), {
      agents: [
        { id: 'demo:release-helper', name: 'Release helper', state: 'unavailable' },
        { id: 'demo:changelog-writer', name: 'Changelog writer', state: 'unavailable' },
        // The sample world's own Assistant is available, so Demo's copy is not what it holds back.
        { id: 'demo:assistant', name: 'Assistant', state: 'unavailable' },
        { id: 'assistant', name: 'Assistant', state: 'ready' },
      ],
    });
    await loaded(container, 'demo');

    expect(getByRole('switch', { name: PLUGINS_COPY.disabled }).getAttribute('aria-checked')).toBe(
      'false',
    );
    const holding = await waitFor(() => {
      const found = container.querySelector<HTMLElement>('[data-testid="plugin-holding-back"]');
      expect(found).not.toBeNull();
      return found!;
    });
    expect(holding.textContent?.replaceAll(/\s+/g, ' ').trim()).toBe(
      'Holding back. Release helper and Changelog writer are unavailable until Demo is enabled.',
    );
    expect(detailOf(container).textContent).toContain(PLUGINS_COPY.enableNote);
    // A plugin that is off is not in use.
    expect(container.querySelector('[data-testid="plugin-in-use"]')).toBeNull();
  });

  test('does not ask for a secret the host creates itself when the plugin is first enabled', async () => {
    const { container } = open('demo', [
      {
        name: 'demo',
        title: 'Demo',
        enabled: false,
        secrets: [{ key: 'demo-approval-secret', set: false, generated: true }],
      },
    ]);
    await loaded(container, 'demo');

    expect(container.querySelector('[data-testid="plugin-secrets"]')).toBeNull();
    expect(container.textContent).not.toContain('demo-approval-secret');
  });

  test('says nothing is held back when a disabled plugin has no agent of its own', async () => {
    const { container } = open('demo');
    await loaded(container, 'demo');
    await waitFor(() => expect(detailOf(container).textContent).toContain(PLUGINS_COPY.enableNote));
    expect(container.querySelector('[data-testid="plugin-holding-back"]')).toBeNull();
  });

  test('a plugin that needs setup says so, lists its missing key with the one action and where it is saved', async () => {
    const { container, getByRole } = open('typesafe');
    await loaded(container, 'typesafe');

    const detail = detailOf(container);
    expect(detail.textContent).toContain(PLUGINS_COPY.status.needsSetup);
    const secret = detail.querySelector<HTMLElement>('[data-secret="typesafe-api-key"]')!;
    expect(secret.textContent).toContain('typesafe-api-key');
    expect(secret.textContent).toContain(PLUGINS_COPY.secrets.missing);
    // One way to add it: the secret's own action, not a second card for the same thing.
    expect(container.querySelector('[data-plugin-problem]')).toBeNull();
    expect(
      getByRole('button', { name: PLUGINS_COPY.secrets.addLabel('typesafe-api-key') }),
    ).not.toBeNull();
    expect(secret.textContent).toContain(PLUGINS_COPY.secrets.add);
    expect(detail.querySelector('[data-testid="plugin-secret-note"]')?.textContent?.trim()).toBe(
      PLUGINS_COPY.secrets.note('/home/.bungalow/secrets', 'TypeSafe', false),
    );
    // Nothing to put in use while it cannot run.
    expect(container.querySelector('[data-testid="plugin-in-use"]')).toBeNull();
  });

  test('a provider plugin adds its key through the connect flow, which tests the key, and says so', async () => {
    const { container, getByRole } = open('openai');
    await loaded(container, 'openai');
    expect(
      detailOf(container).querySelector('[data-testid="plugin-secret-note"]')?.textContent,
    ).toContain('The models appear as soon as the key passes a test.');

    await fireEvent.click(
      getByRole('button', { name: PLUGINS_COPY.secrets.addLabel('openai-api-key') }),
    );

    const dialog = await bodyOf(container).findByRole('dialog');
    expect(dialog.textContent).toContain('Connect');
    expect(writes()).toEqual([]);
  });

  test('a plugin the host requires shows Always on and no switch', async () => {
    const { container, queryByRole } = open('bureau');
    await loaded(container, 'bureau');

    expect(detailOf(container).textContent).toContain(PLUGINS_COPY.alwaysOn);
    expect(queryByRole('switch')).toBeNull();
  });
});

describe('a plugin’s configuration', () => {
  test('is a form built from the schema, never raw JSON: a row per field with its key and hint, and one explicit Save', async () => {
    const { container, getByRole } = open('linear');
    await loaded(container, 'linear');

    const form = container.querySelector<HTMLElement>('[data-testid="plugin-configuration"]')!;
    expect(form.textContent).toContain(PLUGINS_COPY.sections.configuration);
    expect(form.textContent).toContain(PLUGINS_COPY.configuration.description);
    expect(container.querySelector('textarea')).toBeNull();
    expect(
      [...form.querySelectorAll('[data-configuration-field]')].map((row) =>
        row.getAttribute('data-configuration-field'),
      ),
    ).toEqual(['teamKey', 'region', 'labels', 'snippets', 'cacheMs']);
    const team = fieldOf(container, 'teamKey');
    expect(team.textContent).toContain('Team key');
    expect(team.textContent).toContain('teamKey');
    expect(team.textContent).toContain('The team the issues go to.');
    expect((team.querySelector('input') as HTMLInputElement).value).toBe('COR');
    expect(fieldOf(container, 'region').querySelector('select')).not.toBeNull();
    expect(fieldOf(container, 'snippets').querySelector('[role="switch"]')).not.toBeNull();
    expect(getByRole('button', { name: PLUGINS_COPY.configuration.save })).not.toBeNull();
    expect(form.textContent).toContain(PLUGINS_COPY.configuration.note);
    // Typing changes nothing until Save: no write, and no count in the banner.
    await fireEvent.input(team.querySelector('input')!, { target: { value: 'ENG' } });
    expect(writes()).toEqual([]);
    expect(bannerText(container)).toBeNull();
  });

  test('Save stores what was typed, restarts nothing, and the plugin then waits for a restart', async () => {
    const { container } = open('linear');
    await loaded(container, 'linear');
    await fireEvent.input(fieldOf(container, 'teamKey').querySelector('input')!, {
      target: { value: 'ENG' },
    });

    await fireEvent.click(saveButton(container));

    await waitFor(() => expect(bannerText(container)).not.toBeNull());
    expect(writes()).toEqual([
      { method: 'PUT', path: '/host/plugins/linear', body: { configuration: { teamKey: 'ENG' } } },
    ]);
    expect(banner(container)?.textContent).toContain(BANNER.title(1));
    expect(banner(container)?.textContent).toContain('Linear');
    expect(rowOf(container, 'linear')?.textContent).toContain(
      PLUGINS_COPY.status.changesAfterRestart,
    );
  });

  test('a failed save keeps the typed value, says why under the button, leaves Save as the retry and the count unchanged', async () => {
    const { container } = open('linear');
    await loaded(container, 'linear');
    const input = fieldOf(container, 'teamKey').querySelector('input')!;
    await fireEvent.input(input, { target: { value: 'ENG' } });
    host!.refuseNext = Response.json({ error: 'failed', message: '' }, { status: 500 });

    await fireEvent.click(saveButton(container));

    const failure = await waitFor(() => {
      const found = container.querySelector<HTMLElement>(
        '[data-testid="plugin-configuration-failed"]',
      );
      expect(found).not.toBeNull();
      return found!;
    });
    expect(failure.textContent?.replaceAll(/\s+/g, ' ').trim()).toBe(
      `${PLUGINS_COPY.configuration.failureLead} ${PLUGINS_COPY.configuration.failed}`,
    );
    expect((fieldOf(container, 'teamKey').querySelector('input') as HTMLInputElement).value).toBe(
      'ENG',
    );
    expect(bannerText(container)).toBeNull();
    // Save is still there, and pressing it again goes through.
    await fireEvent.click(saveButton(container));
    await waitFor(() => expect(bannerText(container)).not.toBeNull());
    expect(banner(container)?.textContent).toContain(BANNER.title(1));
  });

  test('a value the host refuses is named at its field, and nothing else is claimed', async () => {
    const { container } = open('linear');
    await loaded(container, 'linear');
    host!.refuseNext = Response.json(
      {
        error: 'invalid',
        field: 'configuration.teamKey',
        message: 'Team key must be capital letters.',
      },
      { status: 400 },
    );

    await fireEvent.click(saveButton(container));

    await waitFor(() =>
      expect(fieldOf(container, 'teamKey').textContent).toContain(
        'Team key must be capital letters.',
      ),
    );
    expect(container.querySelector('[data-testid="plugin-configuration-failed"]')).toBeNull();
    expect(bannerText(container)).toBeNull();
  });

  test('Revert on the notice puts a saved configuration back, so nothing waits for a restart', async () => {
    const { container } = open('linear');
    await loaded(container, 'linear');
    await fireEvent.input(fieldOf(container, 'teamKey').querySelector('input')!, {
      target: { value: 'ENG' },
    });
    await fireEvent.click(saveButton(container));
    await waitFor(() => expect(bannerText(container)).not.toBeNull());

    await fireEvent.click(
      within(banner(container)!).getByRole('button', { name: BANNER.revert(1) }),
    );

    await waitFor(() => expect(bannerText(container)).toBeNull());
    expect(host!.stored['linear']).toEqual({ enabled: true, configuration: { teamKey: 'COR' } });
    await waitFor(() =>
      expect((fieldOf(container, 'teamKey').querySelector('input') as HTMLInputElement).value).toBe(
        'COR',
      ),
    );
  });
});

describe('the restart notice', () => {
  test('counts a setting that waits with the plugins that wait, and names them all', async () => {
    const { container } = open('linear', fixtures(), {
      pendingSettings: ['engine.workflowClaimRenewInterval'],
    });
    await loaded(container, 'linear');
    host!.stored['demo'] = { enabled: true, configuration: {} };
    await fireEvent.click(rowOf(container, 'anthropic')!);

    await waitFor(() => expect(banner(container)?.textContent).toContain(BANNER.title(1)));
    await fireEvent.click(rowOf(container, 'demo')!);
    expect(banner(container)?.textContent).toContain('Workflow claim renew interval');
  });

  test('counts a change the host already holds that the running host has not loaded', async () => {
    const { container } = open('demo');
    host!.stored['demo'] = { enabled: true, configuration: {} };
    await loaded(container, 'demo');

    await waitFor(() => expect(bannerText(container)).not.toBeNull());
    expect(banner(container)?.textContent).toContain(BANNER.title(1));
    expect(rowOf(container, 'demo')?.textContent).toContain(
      PLUGINS_COPY.status.enabledAfterRestart,
    );
  });
});

describe('disabling a plugin while a setting waits', () => {
  test('still says what became of the plugin, though the restart also applies the setting', async () => {
    const { container, getByRole } = open('linear', fixtures(), {
      pendingSettings: ['engine.workflowClaimRenewInterval'],
    });
    await loaded(container, 'linear');
    await waitFor(() => expect(bannerText(container)).not.toBeNull());
    await fireEvent.click(getByRole('switch', { name: PLUGINS_COPY.enabled }));
    const dialog = await bodyOf(container).findByRole('dialog');

    await fireEvent.click(
      within(dialog).getByRole('button', { name: PLUGINS_COPY.disable.confirm }),
    );

    const back = await backBanner(container);
    expect(back.textContent).toContain(RESTART_COPY.back.disabled('Linear'));
  });
});

describe('disabling a plugin', () => {
  test('lists what the host reports depends on it, from every contribution', async () => {
    const { container, getByRole } = open('linear');
    await loaded(container, 'linear');

    await fireEvent.click(getByRole('switch', { name: PLUGINS_COPY.enabled }));

    const dialog = await bodyOf(container).findByRole('dialog');
    const items = [...dialog.querySelectorAll('li')].map((item) => item.textContent ?? '');
    expect(items).toHaveLength(3);
    expect(items.join('\n')).toContain('1 agent');
    expect(items.join('\n')).toContain('linear:create-issue');
    expect(items.join('\n')).toContain('2 schedules');
    expect(items.join('\n')).toContain('1 waiting run');
    // Nothing is written until it is confirmed, and the switch stays on.
    expect(writes()).toEqual([]);
    expect(bannerText(container)).toBeNull();
  });

  test('says so when nothing depends on it, and Cancel leaves the plugin on and writes nothing', async () => {
    const { container, getByRole } = open('anthropic');
    await loaded(container, 'anthropic');
    await fireEvent.click(getByRole('switch', { name: PLUGINS_COPY.enabled }));
    const dialog = await bodyOf(container).findByRole('dialog');
    expect(dialog.textContent).toContain(PLUGINS_COPY.disable.intro);
    expect(dialog.textContent).toContain(
      `${PLUGINS_COPY.disable.nothingLead}${PLUGINS_COPY.disable.nothing('Anthropic')}`,
    );
    expect(dialog.textContent).toContain(PLUGINS_COPY.disable.reassurance);
    expect(dialog.querySelectorAll('li')).toHaveLength(0);

    await fireEvent.click(
      within(dialog).getByRole('button', { name: PLUGINS_COPY.disable.cancel }),
    );

    await waitFor(() =>
      expect(bodyOf(container).queryByRole('dialog')?.outerHTML ?? null).toBeNull(),
    );
    expect(getByRole('switch', { name: PLUGINS_COPY.enabled }).getAttribute('aria-checked')).toBe(
      'true',
    );
    expect(writes()).toEqual([]);
  });

  test('Disable and restart disables the plugin, restarts the host, and says what became of it', async () => {
    const { container, getByRole } = open('linear');
    await loaded(container, 'linear');
    await fireEvent.click(getByRole('switch', { name: PLUGINS_COPY.enabled }));
    const dialog = await bodyOf(container).findByRole('dialog');

    await fireEvent.click(
      within(dialog).getByRole('button', { name: PLUGINS_COPY.disable.confirm }),
    );

    const back = await backBanner(container);
    expect(writes()).toEqual([
      {
        method: 'PUT',
        path: '/host/plugins/linear',
        body: { enabled: false, operationId: expect.any(String), expectedRevision: '{}' },
      },
      { method: 'POST', path: '/host/restart', body: undefined },
    ]);
    expect(back.textContent).toContain(RESTART_COPY.back.disabled('Linear'));
    expect(back.textContent).toContain(RESTART_COPY.back.enableAgain);
  });
});

describe('enabling a plugin', () => {
  const demoAgents: AgentListing[] = [
    { id: 'demo:release-helper', name: 'release-helper', state: 'unavailable' },
    { id: 'demo:changelog-writer', name: 'changelog-writer', state: 'unavailable' },
  ];

  test('asks first, in a confirm dialog that says what comes back and that Interborough restarts, and writes nothing yet', async () => {
    const { container, getByRole } = open('demo', fixtures(), { agents: demoAgents });
    await loaded(container, 'demo');

    await fireEvent.click(getByRole('switch', { name: PLUGINS_COPY.disabled }));

    const question = await enableQuestion(container, 'Demo');
    await waitFor(() => expect(question.textContent).toContain('Release helper'));
    expect(question.textContent).toContain(
      'Interborough restarts to load it. Release helper and Changelog writer become available again. Running work picks up where it stopped; reviews stay waiting.',
    );
    expect(question.className).toContain('cinder-confirm-dialog');
    expect(
      within(question).getByRole('button', { name: PLUGINS_COPY.enable.cancel }),
    ).not.toBeNull();
    expect(
      within(question).getByRole('button', { name: PLUGINS_COPY.enable.confirm }),
    ).not.toBeNull();
    expect(writes()).toEqual([]);
    expect(bannerText(container)).toBeNull();
  });

  test('says only that it restarts when the plugin holds nothing back', async () => {
    const { container, getByRole } = open('demo');
    await loaded(container, 'demo');
    await fireEvent.click(getByRole('switch', { name: PLUGINS_COPY.disabled }));

    const question = await enableQuestion(container, 'Demo');
    expect(question.textContent).toContain(
      'Interborough restarts to load it. Running work picks up where it stopped; reviews stay waiting.',
    );
    expect(question.textContent).not.toContain('available again');
  });

  test('Cancel leaves the plugin off and writes nothing', async () => {
    const { container, getByRole } = open('demo');
    await loaded(container, 'demo');
    await fireEvent.click(getByRole('switch', { name: PLUGINS_COPY.disabled }));
    const question = await enableQuestion(container, 'Demo');

    await fireEvent.click(
      within(question).getByRole('button', { name: PLUGINS_COPY.enable.cancel }),
    );

    await waitFor(() =>
      expect(bodyOf(container).queryByRole('dialog')?.outerHTML ?? null).toBeNull(),
    );
    expect(getByRole('switch', { name: PLUGINS_COPY.disabled }).getAttribute('aria-checked')).toBe(
      'false',
    );
    expect(writes()).toEqual([]);
    expect(bannerText(container)).toBeNull();
  });

  test('turning a plugin on again after a restart that did not finish only drops the held choice', async () => {
    const { container, getByRole } = open('demo');
    await loaded(container, 'demo');
    await fireEvent.click(getByRole('switch', { name: PLUGINS_COPY.disabled }));
    host!.refuseNext = Response.json({ error: 'failed', message: '' }, { status: 500 });
    await confirmEnable(container);
    await waitFor(() => expect(bannerText(container)).not.toBeNull());

    // The choice is still held and counted; putting the switch back asks nothing and writes nothing.
    await fireEvent.click(getByRole('switch', { name: PLUGINS_COPY.enabled }));

    await waitFor(() => expect(bannerText(container)).toBeNull());
    expect(bodyOf(container).queryByRole('dialog')).toBeNull();
  });
});

describe('restarting', () => {
  test('Restart now asks first, and nothing is written or restarted until it is confirmed', async () => {
    const { container } = open('linear');
    await loaded(container, 'linear');
    await fireEvent.input(fieldOf(container, 'teamKey').querySelector('input')!, {
      target: { value: 'ENG' },
    });
    await fireEvent.click(saveButton(container));
    await waitFor(() => expect(bannerText(container)).not.toBeNull());
    const before = writes().length;
    await fireEvent.click(
      within(banner(container)!).getByRole('button', { name: RESTART_COPY.confirm.confirm }),
    );

    const question = await bodyOf(container).findByRole('dialog', {
      name: RESTART_COPY.confirm.title,
    });
    // It names the effect on running work, and never says nothing is running.
    expect(question.textContent).toContain(RESTART_COPY.confirm.description(1));
    expect(question.textContent).toContain('Running work picks up where it stopped');
    await fireEvent.click(
      within(question).getByRole('button', { name: RESTART_COPY.confirm.cancel }),
    );
    await waitFor(() =>
      expect(bodyOf(container).queryByRole('dialog')?.outerHTML ?? null).toBeNull(),
    );
    expect(writes()).toHaveLength(before);
    expect(writes().filter((request) => request.path === '/host/restart')).toHaveLength(0);
  });

  test('Enable and restart writes the switch, posts to the restart route, and says what applied once the host answers again', async () => {
    const { container, getByRole } = open('demo');
    await loaded(container, 'demo');
    await fireEvent.click(getByRole('switch', { name: PLUGINS_COPY.disabled }));

    await confirmEnable(container);

    const back = await backBanner(container);
    expect(writes()).toEqual([
      { method: 'PUT', path: '/host/plugins/demo', body: { enabled: true } },
      { method: 'POST', path: '/host/restart', body: undefined },
    ]);
    // The dialog is gone; the banner says what applied and how the plugins stand now.
    expect(bodyOf(container).queryByRole('dialog')).toBeNull();
    expect(back.textContent).toContain(RESTART_COPY.back.title);
    expect(back.textContent).toContain(RESTART_COPY.back.applied(['Demo']));
    expect(bannerText(container)).toBeNull();
    expect(rowOf(container, 'demo')?.textContent).toContain(PLUGINS_COPY.status.running);

    await fireEvent.click(within(back).getByRole('button', { name: RESTART_COPY.back.dismiss }));
    await waitFor(() =>
      expect(container.querySelector('[data-testid="restart-back"]')?.outerHTML ?? null).toBeNull(),
    );
  });

  test('restarts for the plugin whose configuration was saved, and names it', async () => {
    const { container } = open('linear');
    await loaded(container, 'linear');
    await fireEvent.input(fieldOf(container, 'teamKey').querySelector('input')!, {
      target: { value: 'ENG' },
    });
    await fireEvent.click(saveButton(container));
    await waitFor(() => expect(bannerText(container)).not.toBeNull());

    await restartNow(container);

    const back = await backBanner(container);
    expect(back.textContent).toContain(RESTART_COPY.back.applied(['Linear']));
    expect(writes().map((request) => `${request.method} ${request.path}`)).toEqual([
      'PUT /host/plugins/linear',
      'POST /host/restart',
    ]);
  });

  test('counts the reconnect attempts while the host does not answer, and not the end before it does', async () => {
    restartProbing.retryDelayMs = () => 60_000;
    const { container, getByRole } = open('demo', fixtures(), { downFor: 1 });
    await loaded(container, 'demo');
    await fireEvent.click(getByRole('switch', { name: PLUGINS_COPY.disabled }));
    await confirmEnable(container);

    const card = await restartCard(container);
    await waitFor(() => expect(card.getAttribute('data-cinder-phase')).toBe('reconnecting'));
    expect(card.textContent).toContain('Attempt 1 of 8.');
    expect(container.querySelector('[data-testid="restart-back"]')).toBeNull();
    // Retry now probes at once, without waiting out the minute the countdown has left.
    await fireEvent.click(within(card).getByRole('button', { name: 'Retry now' }));
    await backBanner(container);
  });

  test('says the host did not come back after 8 tries, with what to check, the launch command and Keep waiting', async () => {
    const { container, getByRole } = open('demo', fixtures(), { downFor: 1_000 });
    await loaded(container, 'demo');
    await fireEvent.click(getByRole('switch', { name: PLUGINS_COPY.disabled }));
    await confirmEnable(container);

    const card = await restartCard(container);
    await waitFor(() => expect(card.getAttribute('data-cinder-phase')).toBe('failed'));
    expect(card.querySelector('h2')?.textContent).toContain('Interborough didn’t come back');
    expect(card.textContent).toContain(RESTART_COPY.failed.check);
    expect(card.querySelector('code.cinder-restart-state__command-text')?.textContent).toBe(
      'bun run start',
    );
    // There is no restart-again action: the route that restarts lives on the host that is not answering.
    expect(within(card).getByRole('button', { name: 'Keep waiting' })).not.toBeNull();
    expect(within(card).queryByRole('button', { name: /restart/i })).toBeNull();
    expect(container.querySelector('[data-testid="restart-back"]')).toBeNull();
  });

  test('does not restart when a change cannot be saved, and says so', async () => {
    const { container, getByRole } = open('demo');
    await loaded(container, 'demo');
    await fireEvent.click(getByRole('switch', { name: PLUGINS_COPY.disabled }));
    host!.refuseNext = Response.json({ error: 'failed', message: '' }, { status: 500 });

    await confirmEnable(container);

    await waitFor(() =>
      expect(container.querySelector('[data-testid="plugins-restart-refused"]')).not.toBeNull(),
    );
    expect(container.textContent).toContain(PLUGINS_COPY.banner.failed);
    expect(writes().filter((request) => request.path === '/host/restart')).toHaveLength(0);
    // What the person chose is still there to try again.
    expect(bannerText(container)).not.toBeNull();
  });

  test('says the host did not restart when it keeps answering with the change still pending', async () => {
    restartProbing.unchangedLimit = 3;
    const { container, getByRole } = open('demo', fixtures(), { restartApplies: false });
    await loaded(container, 'demo');
    await fireEvent.click(getByRole('switch', { name: PLUGINS_COPY.disabled }));

    await confirmEnable(container);

    const notice = await waitFor(() => {
      const found = container.querySelector<HTMLElement>(
        '[data-testid="settings-restart-unconfirmed"]',
      );
      expect(found).not.toBeNull();
      return found!;
    });
    expect(notice.textContent).toContain(RESTART_COPY.unconfirmed.description);
    expect(bodyOf(container).queryByRole('dialog')?.outerHTML ?? null).toBeNull();
  });

  test('says when the host refuses to restart, or keeps its choices in its deployment', async () => {
    const { container, getByRole } = open('demo');
    await loaded(container, 'demo');
    await fireEvent.click(getByRole('switch', { name: PLUGINS_COPY.disabled }));
    host!.refuseRestart = Response.json({ error: 'failed', message: '' }, { status: 404 });

    await confirmEnable(container);

    await waitFor(() =>
      expect(container.querySelector('[data-testid="settings-restart-refused"]')).not.toBeNull(),
    );
    expect(container.textContent).toContain(RESTART_COPY.refusal.refused);
  });
});

describe('two plugins that share a name', () => {
  test('lists both, and edits only the first, which owns the name', async () => {
    const { container, getByRole } = open('linear', [
      { name: 'linear', location: '@lostgradient/plugin-linear' },
      {
        name: 'linear',
        source: 'folder',
        location: '/home/plugins/linear',
        status: 'skipped',
        problems: [
          {
            code: 'name-clash',
            name: 'linear',
            first: { source: 'package', location: '@lostgradient/plugin-linear' },
            second: { source: 'folder', location: '/home/plugins/linear' },
          },
        ],
      },
    ]);
    await loaded(container, 'linear');
    await waitFor(() =>
      expect(container.querySelectorAll('[data-plugin-row="linear"]')).toHaveLength(2),
    );
    expect(getByRole('switch', { name: PLUGINS_COPY.enabled }).hasAttribute('disabled')).toBe(
      false,
    );

    await fireEvent.click(container.querySelectorAll('[data-plugin-row="linear"]')[1]!);

    await waitFor(() =>
      expect(container.querySelector('[data-plugin-problem="name-clash"]')).not.toBeNull(),
    );
    expect(getByRole('switch', { name: PLUGINS_COPY.enabled }).hasAttribute('disabled')).toBe(true);
  });
});

describe('folders that did not load', () => {
  test('lists each by where it is, with what went wrong, apart from the plugins', async () => {
    const { container } = mount('/settings/plugins');
    host!.unloaded = [
      {
        source: 'folder',
        location: '/home/.interborough/plugins/broken',
        status: 'skipped',
        problems: [{ code: 'load-failed', message: 'Cannot find package "left-pad".' }],
      },
    ];

    await waitFor(() =>
      expect(container.querySelector('[data-testid="plugins-unloaded"]')).not.toBeNull(),
    );
    const entry = container.querySelector<HTMLElement>(
      '[data-unloaded="/home/.interborough/plugins/broken"]',
    )!;
    expect(entry.textContent).toContain('The plugin’s code didn’t load');
    expect(entry.textContent).toContain('Cannot find package "left-pad".');
    expect(entry.textContent).toContain(PLUGINS_COPY.source.folder);
  });

  test('shows the empty state only when there are no plugins and no folders', async () => {
    const { container } = mount('/settings/plugins', []);

    await waitFor(() => expect(container.textContent).toContain(PLUGINS_COPY.empty.title));
    expect(container.querySelector('[data-testid="plugins-unloaded"]')).toBeNull();
  });
});

describe('secrets', () => {
  test('saves a secret the plugin waits for, with no restart, and never echoes it', async () => {
    const { container, getByRole } = open('typesafe');
    await loaded(container, 'typesafe');
    expect(container.textContent).toContain(PLUGINS_COPY.secrets.missing);

    await fireEvent.click(
      getByRole('button', { name: PLUGINS_COPY.secrets.addLabel('typesafe-api-key') }),
    );
    const dialog = await bodyOf(container).findByRole('dialog');
    const field = dialog.querySelector<HTMLInputElement>('input[type="password"]')!;
    await fireEvent.input(field, { target: { value: SECRET } });
    await fireEvent.click(
      within(dialog).getByRole('button', { name: PLUGINS_COPY.secrets.dialog.save }),
    );

    await waitFor(() =>
      expect(rowOf(container, 'typesafe')?.textContent).toContain(PLUGINS_COPY.status.running),
    );
    expect(writes()).toEqual([
      {
        method: 'PUT',
        path: '/host/plugins/typesafe/secrets/typesafe-api-key',
        body: { value: SECRET, operationId: expect.any(String), expectedRevision: '{}' },
      },
    ]);
    expect(bannerText(container)).toBeNull();
    expect(container.ownerDocument.body.innerHTML).not.toContain(SECRET);
    expect(container.ownerDocument.body.textContent).not.toContain(SECRET);
    expect(container.textContent).toContain(PLUGINS_COPY.secrets.set);
    // A key that is set is replaced, not added.
    expect(
      within(detailOf(container)).getByRole('button', {
        name: PLUGINS_COPY.secrets.replaceLabel('typesafe-api-key'),
      }).textContent,
    ).toContain(PLUGINS_COPY.secrets.replace);
  });

  test('a refused secret is worded without the value', async () => {
    const { container, getByRole } = open('typesafe');
    await loaded(container, 'typesafe');
    host!.refuseNext = Response.json(
      { error: 'invalid', field: 'value', message: `${SECRET} is not accepted` },
      { status: 400 },
    );

    await fireEvent.click(
      getByRole('button', { name: PLUGINS_COPY.secrets.addLabel('typesafe-api-key') }),
    );
    const dialog = await bodyOf(container).findByRole('dialog');
    const field = dialog.querySelector<HTMLInputElement>('input[type="password"]')!;
    await fireEvent.input(field, { target: { value: SECRET } });
    await fireEvent.click(
      within(dialog).getByRole('button', { name: PLUGINS_COPY.secrets.dialog.save }),
    );

    await waitFor(() =>
      expect(dialog.querySelector('[data-testid="plugin-secret-failure"]')).not.toBeNull(),
    );
    expect(container.ownerDocument.body.innerHTML).not.toContain(SECRET);
    expect(field.value).toBe('');
  });

  test('asks for a value before it sends anything', async () => {
    const { container, getByRole } = open('typesafe');
    await loaded(container, 'typesafe');
    await fireEvent.click(
      getByRole('button', { name: PLUGINS_COPY.secrets.addLabel('typesafe-api-key') }),
    );
    const dialog = await bodyOf(container).findByRole('dialog');

    await fireEvent.click(
      within(dialog).getByRole('button', { name: PLUGINS_COPY.secrets.dialog.save }),
    );

    await waitFor(() =>
      expect(dialog.textContent).toContain(PLUGINS_COPY.secrets.dialog.valueRequired),
    );
    expect(writes()).toEqual([]);
  });
});

describe('a host that keeps its choices in its deployment', () => {
  test('says so and holds every control that writes', async () => {
    const { container, getByRole } = open('demo', fixtures(), { lockReason: 'deployment' });
    await loaded(container, 'demo');

    expect(container.textContent).toContain(PLUGINS_COPY.locked);
    expect(getByRole('switch', { name: PLUGINS_COPY.disabled }).hasAttribute('disabled')).toBe(
      true,
    );
  });

  test('holds Save and every field of the configuration', async () => {
    const { container } = open('linear', fixtures(), { lockReason: 'deployment' });
    await loaded(container, 'linear');

    expect(saveButton(container).hasAttribute('disabled')).toBe(true);
    expect(
      (fieldOf(container, 'teamKey').querySelector('input') as HTMLInputElement).disabled,
    ).toBe(true);
  });
});

describe('problems', () => {
  test('words each problem and keeps one for a code it does not know', async () => {
    const { container } = open('linear', [
      {
        name: 'linear',
        problems: [
          {
            code: 'configuration-invalid',
            field: 'teamKey',
            message: 'Team key must be 2 to 5 capital letters.',
          },
          { code: 'brand-new-code' },
        ],
      },
    ]);
    await loaded(container, 'linear');

    const problems = [...container.querySelectorAll('[data-plugin-problem]')].map(
      (problem) => problem.textContent ?? '',
    );
    expect(problems).toHaveLength(2);
    expect(problems[0]).toContain('Team key must be 2 to 5 capital letters.');
    expect(problems[1]).toContain('Reported as brand-new-code.');
  });

  test('Fix the setting moves to the configuration form', async () => {
    const { container, getByRole } = open('linear', [
      {
        name: 'linear',
        status: 'skipped',
        configurationSchema: LINEAR_SCHEMA,
        configuration: { teamKey: 'x' },
        problems: [
          { code: 'configuration-invalid', field: 'teamKey', message: 'Must be capital letters.' },
        ],
      },
    ]);
    await loaded(container, 'linear');

    await fireEvent.click(getByRole('button', { name: 'Fix the setting' }));

    expect(container.ownerDocument.activeElement).toBe(
      fieldOf(container, 'teamKey').querySelector('input'),
    );
  });

  test('Show both opens the plugin that kept the name, and is not drawn when the other side is not listed', async () => {
    const clash = (counterpart: string | undefined): PluginFixture[] => [
      { name: 'linear', location: '@lostgradient/plugin-linear' },
      {
        name: 'linear',
        source: 'folder',
        location: '/home/plugins/linear',
        status: 'skipped',
        problems: [
          {
            code: 'name-clash',
            name: 'linear',
            first: { source: 'package', location: counterpart ?? 'host' },
            second: { source: 'folder', location: '/home/plugins/linear' },
          },
        ],
      },
    ];
    const { container, getByRole } = open('linear', clash('@lostgradient/plugin-linear'));
    await loaded(container, 'linear');
    await fireEvent.click(container.querySelectorAll('[data-plugin-row="linear"]')[1]!);
    await waitFor(() =>
      expect(
        container.querySelector('[data-testid="plugins-attention"] [data-plugin-problem]'),
      ).not.toBeNull(),
    );
    expect(container.querySelector('[data-plugin-detail]')?.textContent).toContain(
      '/home/plugins/linear',
    );

    await fireEvent.click(getByRole('button', { name: 'Show both' }));

    await waitFor(() =>
      expect(container.querySelector('[data-plugin-detail]')?.textContent).toContain(
        '@lostgradient/plugin-linear',
      ),
    );
  });
});

describe('after a startup with problems', () => {
  const startup = (): PluginFixture[] => [
    {
      name: 'gemini',
      title: 'Gemini',
      status: 'needs-setup',
      contributions: [
        contribution('provider', 'gemini:gemini'),
        contribution('embedder', 'gemini:embedder'),
      ],
      secrets: [{ key: 'gemini-api-key', set: false }],
      problems: [
        {
          code: 'secret-missing',
          key: 'gemini-api-key',
          contributions: ['gemini:gemini', 'gemini:embedder'],
        },
      ],
    },
    {
      name: 'web-search',
      title: 'Web search',
      status: 'skipped',
      configurationSchema: LINEAR_SCHEMA,
      configuration: { teamKey: 'x' },
      secrets: [{ key: 'web-search-key', set: false }],
      problems: [
        {
          code: 'configuration-invalid',
          field: '',
          message: 'Search address must start with https://. You entered “search.example.com”.',
        },
        { code: 'secret-missing', key: 'web-search-key', contributions: [] },
      ],
    },
  ];
  const attention = (container: HTMLElement) =>
    container.querySelector<HTMLElement>('[data-testid="plugins-attention"]');

  test('lists each plugin’s problems under its name, with the neutral and the red status and one button each', async () => {
    const { container } = open('web-search', startup());
    await loaded(container, 'web-search');

    const cards = [...attention(container)!.querySelectorAll<HTMLElement>('[data-plugin-problem]')];
    expect(cards).toHaveLength(3);
    const gemini = cards[0]!;
    expect(gemini.textContent).toContain('Gemini');
    expect(gemini.textContent).toContain('Needs setup');
    expect(gemini.textContent).toContain('A secret isn’t saved yet');
    expect(gemini.textContent).toContain(
      'gemini-api-key isn’t saved, so Gemini models and embeddings are unavailable. Save it and they work at once, with no restart.',
    );
    expect(gemini.querySelector('[data-cinder-status]')?.getAttribute('data-cinder-status')).toBe(
      'neutral',
    );
    expect(within(gemini).getByRole('button', { name: 'Add the key' })).not.toBeNull();
    const search = cards[1]!;
    expect(search.textContent).toContain('Web search');
    expect(search.textContent).toContain('Not loaded');
    expect(search.textContent).toContain('A setting is invalid');
    expect(search.textContent).toContain(
      'Search address must start with https://. You entered “search.example.com”.',
    );
    expect(search.querySelector('[data-cinder-status]')?.getAttribute('data-cinder-status')).toBe(
      'danger',
    );
    expect(within(search).getByRole('button', { name: 'Fix the setting' })).not.toBeNull();
    // The plugin's own page does not draw them a second time.
    expect(detailOf(container).querySelector('[data-plugin-problem]')).toBeNull();
  });

  test('Add the key opens the dialog that saves the secret, and Fix the setting opens the plugin’s form', async () => {
    const { container } = open('gemini', startup());
    await loaded(container, 'gemini');
    const cards = [...attention(container)!.querySelectorAll<HTMLElement>('[data-plugin-problem]')];

    await fireEvent.click(within(cards[2]!).getByRole('button', { name: 'Add the key' }));
    const dialog = await bodyOf(container).findByRole('dialog');
    expect(dialog.textContent).toContain(PLUGINS_COPY.secrets.dialog.title('web-search-key'));
    await fireEvent.click(
      within(dialog).getByRole('button', { name: PLUGINS_COPY.secrets.dialog.cancel }),
    );

    await fireEvent.click(within(cards[1]!).getByRole('button', { name: 'Fix the setting' }));
    await waitFor(() =>
      expect(container.querySelector('[data-plugin-detail="web-search"]')).not.toBeNull(),
    );
    await waitFor(() =>
      expect(
        container.ownerDocument.activeElement ===
          fieldOf(container, 'teamKey').querySelector('input'),
      ).toBe(true),
    );
  });

  test('Add the key for a provider opens the Connect dialog for that provider, the one Models › Connect opens', async () => {
    const { container } = open('web-search', startup());
    await loaded(container, 'web-search');
    const cards = [...attention(container)!.querySelectorAll<HTMLElement>('[data-plugin-problem]')];

    await fireEvent.click(within(cards[0]!).getByRole('button', { name: 'Add the key' }));

    const dialog = await bodyOf(container).findByRole('dialog');
    // The provider is Gemini here, as it is when Connect is pressed on the Models page.
    expect(dialog.textContent).toContain('Connect Gemini');
    expect(dialog.querySelector('[data-testid="provider-connect-form"]')).not.toBeNull();
  });

  test('draws no list while every plugin loaded, whatever else is wrong with them', async () => {
    const { container } = open('gemini', [startup()[0]!]);
    await loaded(container, 'gemini');

    expect(attention(container)).toBeNull();
  });
});
