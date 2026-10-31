/**
 * `/settings/plugins` (COR-1891): the plugins the host loaded, what each adds, the choices an owner
 * makes, and the restart that applies them. The host's plugin routes are a stand-in
 * (`plugins-host.test-support.ts`); the real ones are exercised by `src/host/host-plugins.test.ts`.
 */
import { HttpClient } from '@lostgradient/weft';
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { PLUGINS_COPY } from '../../../app/copy.ts';
import RouteOutletHarness from '../../../app/shell/route-outlet.test-harness.svelte';
import { AUTHORIZATION_SCOPES } from '../../../lib/scopes.svelte.ts';
import { landAt } from '../../chat/pages.test-support.ts';
import {
  contribution,
  installFakePluginHost,
  type FakePluginHost,
  type PluginFixture,
} from './plugins-host.test-support.ts';
import { restartProbing } from './restart-flow.svelte.ts';

const SECRET = 'tsk-live-0123456789-never-print-this';

function fixtures(): PluginFixture[] {
  return [
    {
      name: 'linear',
      version: '0.3.0',
      source: 'folder',
      location: '/home/.interborough/plugins/linear',
      configuration: { teamKey: 'COR' },
      contributions: [
        contribution('tool', 'linear:create-issue', { agents: 1 }),
        contribution('activity', 'linear:sync-issue', { waitingRuns: 1 }),
        contribution('trigger-kind', 'linear:issue-created', { schedules: 2 }),
      ],
    },
    {
      name: 'anthropic',
      contributions: [contribution('provider', 'anthropic')],
      secrets: [{ key: 'anthropic-api-key', set: true }],
    },
    {
      name: 'typesafe',
      status: 'needs-setup',
      contributions: [contribution('decision-router', 'typesafe:jev')],
      secrets: [{ key: 'typesafe-api-key', set: false }],
      problems: [
        { code: 'secret-missing', key: 'typesafe-api-key', contributions: ['typesafe:jev'] },
      ],
    },
    {
      name: 'bureau',
      source: 'built-in',
      location: '@lostgradient/bureau',
      required: true,
      contributions: [contribution('tool', 'bureau:discover-agents')],
    },
    { name: 'demo', enabled: false, contributions: [] },
  ];
}

let host: FakePluginHost | undefined;
const probing = { ...restartProbing };

beforeEach(() => {
  restartProbing.delayMs = 0;
});

afterEach(() => {
  cleanup();
  host?.restore();
  host = undefined;
  Object.assign(restartProbing, probing);
});

function open(
  plugin: string,
  options: Parameters<typeof installFakePluginHost>[1] = {},
  plugins: PluginFixture[] = fixtures(),
) {
  host = installFakePluginHost(plugins, options);
  landAt(`/settings/plugins?plugin=${plugin}`);
  return render(RouteOutletHarness, {
    props: {
      client: new HttpClient({ baseUrl: 'http://localhost/api' }),
      scopes: AUTHORIZATION_SCOPES,
    },
  } as never);
}

const writes = () => (host?.requests ?? []).filter((request) => request.method !== 'GET');
const rowOf = (container: HTMLElement, name: string) =>
  container.querySelector<HTMLElement>(`[data-plugin-row="${name}"]`);
const banner = (container: HTMLElement) =>
  container.querySelector<HTMLElement>('[data-testid="plugins-pending"]');
/** The banner's text, or `null` without one; cheap to print when an assertion on it fails. */
const bannerText = (container: HTMLElement) => banner(container)?.textContent ?? null;
const bodyOf = (container: HTMLElement) => within(container.ownerDocument.body);

/** The restart's progress and ending, which stays one element from the first step to the last. */
async function restartPanel(container: HTMLElement): Promise<HTMLElement> {
  return waitFor(() => {
    const panel = container.ownerDocument.body.querySelector<HTMLElement>(
      '[data-testid="plugins-restart"]',
    );
    expect(panel).not.toBeNull();
    return panel!;
  });
}

async function loaded(container: HTMLElement, plugin: string) {
  await waitFor(() => expect(rowOf(container, plugin)).not.toBeNull());
  await waitFor(() => expect(container.querySelector('[data-plugin-detail]')).not.toBeNull());
}

describe('the page', () => {
  test('lists every plugin with its status and source, and the open one beside it', async () => {
    const { container } = open('linear');
    await loaded(container, 'linear');

    expect(rowOf(container, 'linear')?.textContent).toContain(PLUGINS_COPY.status.running);
    expect(rowOf(container, 'linear')?.textContent).toContain(PLUGINS_COPY.source.folder);
    expect(rowOf(container, 'typesafe')?.textContent).toContain(PLUGINS_COPY.status.needsSetup);
    expect(rowOf(container, 'demo')?.textContent).toContain(PLUGINS_COPY.status.disabled);
    expect(rowOf(container, 'bureau')?.textContent).toContain(PLUGINS_COPY.source.builtIn);
    const detail = container.querySelector<HTMLElement>('[data-plugin-detail]')!;
    expect(detail.textContent).toContain('linear:create-issue');
    expect(detail.textContent).toContain(PLUGINS_COPY.contributionKinds['tool']!);
    expect(detail.textContent).toContain('1 agent, 2 schedules, 1 waiting run');
    const current = container.querySelector('nav a[aria-current="page"]');
    expect(current?.textContent?.trim()).toBe('Plugins');
  });

  test('says the host did not answer, and reads again on Try again', async () => {
    host = installFakePluginHost(fixtures());
    host.failReads = 1;
    landAt('/settings/plugins');
    const { container, findByRole } = render(RouteOutletHarness, {
      props: {
        client: new HttpClient({ baseUrl: 'http://localhost/api' }),
        scopes: AUTHORIZATION_SCOPES,
      },
    } as never);

    await findByRole('button', { name: 'Try again' });
    expect(container.textContent).toContain(PLUGINS_COPY.loadFailed.title);
    await fireEvent.click(await findByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(rowOf(container, 'linear')).not.toBeNull());
  });

  test('marks every control that calls a write, and none that only changes the page', async () => {
    const { container, getByRole } = open('typesafe');
    await loaded(container, 'typesafe');

    await fireEvent.click(
      getByRole('button', { name: PLUGINS_COPY.secrets.addLabel('typesafe-api-key') }),
    );
    const dialog = await bodyOf(container).findByRole('dialog');
    expect(
      within(dialog)
        .getByRole('button', { name: PLUGINS_COPY.secrets.dialog.save })
        .hasAttribute('data-changes'),
    ).toBe(true);
  });
});

describe('the controls that call a write', () => {
  test('are marked on Restart now and Disable and restart, and not on the switch or Discard', async () => {
    const { container, getByRole } = open('demo');
    await loaded(container, 'demo');
    await fireEvent.click(getByRole('switch', { name: PLUGINS_COPY.enabled }));
    await waitFor(() => expect(bannerText(container)).not.toBeNull());

    expect(
      getByRole('button', { name: PLUGINS_COPY.banner.restartNow }).hasAttribute('data-changes'),
    ).toBe(true);
    expect(
      getByRole('button', { name: PLUGINS_COPY.banner.discard }).hasAttribute('data-changes'),
    ).toBe(false);
    expect(getByRole('switch', { name: PLUGINS_COPY.enabled }).hasAttribute('data-changes')).toBe(
      false,
    );
  });

  test('includes the confirmation that disables a plugin and restarts', async () => {
    const { container, getByRole } = open('linear');
    await loaded(container, 'linear');
    await fireEvent.click(getByRole('switch', { name: PLUGINS_COPY.enabled }));

    const dialog = await bodyOf(container).findByRole('dialog');
    expect(
      within(dialog)
        .getByRole('button', { name: PLUGINS_COPY.disable.confirm })
        .hasAttribute('data-changes'),
    ).toBe(true);
  });
});

describe('a plugin that is always on', () => {
  test('shows Always on and no switch', async () => {
    const { container, queryByRole } = open('bureau');
    await loaded(container, 'bureau');

    const detail = container.querySelector<HTMLElement>('[data-plugin-detail]')!;
    expect(detail.textContent).toContain(PLUGINS_COPY.alwaysOn);
    expect(queryByRole('switch', { name: PLUGINS_COPY.enabled })).toBeNull();
  });

  test('shows the switch for a plugin that can be turned off', async () => {
    const { container, getByRole } = open('demo');
    await loaded(container, 'demo');

    expect(getByRole('switch', { name: PLUGINS_COPY.enabled }).getAttribute('aria-checked')).toBe(
      'false',
    );
    expect(container.textContent).not.toContain(PLUGINS_COPY.alwaysOn);
  });
});

describe('pending changes', () => {
  test('turning a plugin on shows the banner with the count, and Discard clears it', async () => {
    const { container, getByRole } = open('demo');
    await loaded(container, 'demo');
    expect(bannerText(container)).toBeNull();

    await fireEvent.click(getByRole('switch', { name: PLUGINS_COPY.enabled }));

    await waitFor(() => expect(bannerText(container)).not.toBeNull());
    expect(banner(container)?.textContent).toContain(PLUGINS_COPY.banner.changes(1));
    expect(rowOf(container, 'demo')?.textContent).toContain(
      PLUGINS_COPY.status.enabledAfterRestart,
    );
    expect(writes()).toEqual([]);

    await fireEvent.click(getByRole('button', { name: PLUGINS_COPY.banner.discard }));

    await waitFor(() => expect(bannerText(container)).toBeNull());
    expect(getByRole('switch', { name: PLUGINS_COPY.enabled }).getAttribute('aria-checked')).toBe(
      'false',
    );
    expect(rowOf(container, 'demo')?.textContent).toContain(PLUGINS_COPY.status.disabled);
    expect(writes()).toEqual([]);
  });

  test('turning a staged plugin back off drops the draft without asking', async () => {
    const { container, getByRole } = open('demo');
    await loaded(container, 'demo');
    await fireEvent.click(getByRole('switch', { name: PLUGINS_COPY.enabled }));
    await waitFor(() => expect(bannerText(container)).not.toBeNull());

    await fireEvent.click(getByRole('switch', { name: PLUGINS_COPY.enabled }));

    await waitFor(() => expect(bannerText(container)).toBeNull());
    expect(bodyOf(container).queryByRole('dialog')?.outerHTML ?? null).toBeNull();
    expect(getByRole('switch', { name: PLUGINS_COPY.enabled }).getAttribute('aria-checked')).toBe(
      'false',
    );
    expect(writes()).toEqual([]);
  });

  test('editing a configuration shows the banner, and putting the text back clears it', async () => {
    const { container, getByLabelText } = open('linear');
    await loaded(container, 'linear');
    const editor = getByLabelText(
      PLUGINS_COPY.configuration.label('linear'),
    ) as HTMLTextAreaElement;

    await fireEvent.input(editor, { target: { value: '{ "teamKey": "ENG" }' } });
    await waitFor(() => expect(bannerText(container)).not.toBeNull());
    expect(banner(container)?.textContent).toContain(PLUGINS_COPY.banner.changes(1));

    await fireEvent.input(editor, { target: { value: '{"teamKey":"COR"}' } });
    await waitFor(() => expect(bannerText(container)).toBeNull());
  });

  test('counts a switch and a configuration together, and Discard clears both', async () => {
    const { container, getByLabelText, getByRole } = open('linear');
    await loaded(container, 'linear');

    await fireEvent.input(getByLabelText(PLUGINS_COPY.configuration.label('linear')), {
      target: { value: '{ "teamKey": "ENG" }' },
    });
    await fireEvent.click(rowOf(container, 'demo')!);
    await waitFor(() =>
      expect(container.querySelector('[data-plugin-detail="demo"]')).not.toBeNull(),
    );
    await fireEvent.click(getByRole('switch', { name: PLUGINS_COPY.enabled }));

    await waitFor(() =>
      expect(banner(container)?.textContent).toContain(PLUGINS_COPY.banner.changes(2)),
    );
    await fireEvent.click(getByRole('button', { name: PLUGINS_COPY.banner.discard }));
    await waitFor(() => expect(bannerText(container)).toBeNull());
  });

  test('holds a configuration that is not an object, says so, and will not restart with it', async () => {
    const { container, getByLabelText, getByRole } = open('linear');
    await loaded(container, 'linear');

    await fireEvent.input(getByLabelText(PLUGINS_COPY.configuration.label('linear')), {
      target: { value: '{ "teamKey": ' },
    });

    await waitFor(() =>
      expect(container.textContent).toContain(PLUGINS_COPY.configuration.invalid),
    );
    expect(
      getByRole('button', { name: PLUGINS_COPY.banner.restartNow }).hasAttribute('disabled'),
    ).toBe(true);
  });

  test('counts a change the host already holds that the running host has not loaded', async () => {
    host = installFakePluginHost(fixtures());
    host.stored['demo'] = { enabled: true, configuration: {} };
    landAt('/settings/plugins?plugin=demo');
    const { container } = render(RouteOutletHarness, {
      props: {
        client: new HttpClient({ baseUrl: 'http://localhost/api' }),
        scopes: AUTHORIZATION_SCOPES,
      },
    } as never);

    await waitFor(() => expect(bannerText(container)).not.toBeNull());
    expect(banner(container)?.textContent).toContain(PLUGINS_COPY.banner.changes(1));
    expect(rowOf(container, 'demo')?.textContent).toContain(
      PLUGINS_COPY.status.enabledAfterRestart,
    );
  });
});

describe('disabling a plugin', () => {
  test('lists what the host reports depends on it, from every contribution', async () => {
    const { container, getByRole } = open('linear');
    await loaded(container, 'linear');

    await fireEvent.click(getByRole('switch', { name: PLUGINS_COPY.enabled }));

    const dialog = await bodyOf(container).findByRole('dialog');
    expect(dialog.textContent).toContain(PLUGINS_COPY.disable.title('linear'));
    const items = [...dialog.querySelectorAll('li')].map((item) => item.textContent ?? '');
    expect(items).toHaveLength(3);
    expect(items.join('\n')).toContain('1 agent');
    expect(items.join('\n')).toContain('linear:create-issue');
    expect(items.join('\n')).toContain('2 schedules');
    expect(items.join('\n')).toContain('linear:issue-created');
    expect(items.join('\n')).toContain('1 waiting run');
    expect(items.join('\n')).toContain('linear:sync-issue');
    // Nothing is written until it is confirmed, and the switch stays on.
    expect(writes()).toEqual([]);
    expect(bannerText(container)).toBeNull();
  });

  test('says so when nothing depends on it', async () => {
    const { container, getByRole } = open('anthropic');
    await loaded(container, 'anthropic');

    await fireEvent.click(getByRole('switch', { name: PLUGINS_COPY.enabled }));

    const dialog = await bodyOf(container).findByRole('dialog');
    expect(dialog.textContent).toContain(PLUGINS_COPY.disable.nothing);
    expect(dialog.querySelectorAll('li')).toHaveLength(0);
  });

  test('Cancel leaves the plugin on and writes nothing', async () => {
    const { container, getByRole } = open('linear');
    await loaded(container, 'linear');
    await fireEvent.click(getByRole('switch', { name: PLUGINS_COPY.enabled }));
    const dialog = await bodyOf(container).findByRole('dialog');

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
});

describe('restarting', () => {
  test('Restart now writes the changes, posts to the restart route, and shows the reconnecting state until the host answers again', async () => {
    const { container, getByRole } = open('demo');
    await loaded(container, 'demo');
    await fireEvent.click(getByRole('switch', { name: PLUGINS_COPY.enabled }));
    await waitFor(() => expect(bannerText(container)).not.toBeNull());

    await fireEvent.click(getByRole('button', { name: PLUGINS_COPY.banner.restartNow }));

    const status = await restartPanel(container);
    await waitFor(() => expect(status.getAttribute('data-phase')).toBe('back'));
    expect(writes()).toEqual([
      { method: 'PUT', path: '/host/plugins/demo', body: { enabled: true } },
      { method: 'POST', path: '/host/restart', body: undefined },
    ]);
    // The reads that failed while the host was down came between the request and the answer.
    expect(status.textContent).toContain(PLUGINS_COPY.restart.back.summary(4, 1, 0));

    await fireEvent.click(
      within(status).getByRole('button', { name: PLUGINS_COPY.restart.back.close }),
    );
    await waitFor(() =>
      expect(bodyOf(container).queryByRole('dialog')?.outerHTML ?? null).toBeNull(),
    );
    expect(bannerText(container)).toBeNull();
    expect(rowOf(container, 'demo')?.textContent).toContain(PLUGINS_COPY.status.running);
  });

  test('shows the starting step while the host does not answer, and not the end before it does', async () => {
    const { container, getByRole } = open('demo', { downFor: 50 });
    await loaded(container, 'demo');
    await fireEvent.click(getByRole('switch', { name: PLUGINS_COPY.enabled }));
    await fireEvent.click(getByRole('button', { name: PLUGINS_COPY.banner.restartNow }));

    const status = await restartPanel(container);
    await waitFor(() => expect(status.textContent).toContain(PLUGINS_COPY.restart.steps.starting));
    expect(status.getAttribute('data-phase')).toBe('starting');
    expect(
      within(status).queryByRole('button', { name: PLUGINS_COPY.restart.back.close }),
    ).toBeNull();
    // The page does not offer a second restart while one runs.
    expect(writes().filter((request) => request.path === '/host/restart')).toHaveLength(1);
  });

  test('knows the host is back when it answers with nothing pending, even if it was never seen down', async () => {
    const { container, getByRole } = open('demo', { downFor: 0 });
    await loaded(container, 'demo');
    await fireEvent.click(getByRole('switch', { name: PLUGINS_COPY.enabled }));

    await fireEvent.click(getByRole('button', { name: PLUGINS_COPY.banner.restartNow }));

    const status = await restartPanel(container);
    await waitFor(() => expect(status.getAttribute('data-phase')).toBe('back'));
  });

  test('Disable and restart disables the plugin and restarts the host', async () => {
    const { container, getByRole } = open('linear');
    await loaded(container, 'linear');
    await fireEvent.click(getByRole('switch', { name: PLUGINS_COPY.enabled }));
    const dialog = await bodyOf(container).findByRole('dialog');

    await fireEvent.click(
      within(dialog).getByRole('button', { name: PLUGINS_COPY.disable.confirm }),
    );

    const status = await restartPanel(container);
    await waitFor(() => expect(status.getAttribute('data-phase')).toBe('back'));
    expect(writes()).toEqual([
      { method: 'PUT', path: '/host/plugins/linear', body: { enabled: false } },
      { method: 'POST', path: '/host/restart', body: undefined },
    ]);
    expect(status.textContent).toContain(PLUGINS_COPY.restart.back.summary(2, 1, 2));
  });

  test('applies a staged switch together with the plugin it disables', async () => {
    const { container, getByRole } = open('demo');
    await loaded(container, 'demo');
    await fireEvent.click(getByRole('switch', { name: PLUGINS_COPY.enabled }));
    await fireEvent.click(rowOf(container, 'linear')!);
    await waitFor(() =>
      expect(container.querySelector('[data-plugin-detail="linear"]')).not.toBeNull(),
    );
    await fireEvent.click(getByRole('switch', { name: PLUGINS_COPY.enabled }));
    const dialog = await bodyOf(container).findByRole('dialog');

    await fireEvent.click(
      within(dialog).getByRole('button', { name: PLUGINS_COPY.disable.confirm }),
    );

    await restartPanel(container);
    await waitFor(() =>
      expect(writes().map((request) => `${request.method} ${request.path}`)).toEqual([
        'PUT /host/plugins/linear',
        'PUT /host/plugins/demo',
        'POST /host/restart',
      ]),
    );
  });

  test('does not restart when a change cannot be saved, and says so', async () => {
    const { container, getByRole } = open('demo');
    await loaded(container, 'demo');
    await fireEvent.click(getByRole('switch', { name: PLUGINS_COPY.enabled }));
    host!.refuseNext = Response.json({ error: 'failed', message: '' }, { status: 500 });

    await fireEvent.click(getByRole('button', { name: PLUGINS_COPY.banner.restartNow }));

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
    const { container, getByRole } = open('demo', { restartApplies: false });
    await loaded(container, 'demo');
    await fireEvent.click(getByRole('switch', { name: PLUGINS_COPY.enabled }));

    await fireEvent.click(getByRole('button', { name: PLUGINS_COPY.banner.restartNow }));

    const status = await restartPanel(container);
    await waitFor(() => expect(status.getAttribute('data-phase')).toBe('unconfirmed'));
    expect(status.textContent).toContain(PLUGINS_COPY.restart.unconfirmed.description);
    await fireEvent.click(
      within(status).getByRole('button', { name: PLUGINS_COPY.restart.unconfirmed.close }),
    );
    await waitFor(() =>
      expect(bodyOf(container).queryByRole('dialog')?.outerHTML ?? null).toBeNull(),
    );
    // The change is stored and still waits for a restart.
    expect(banner(container)?.textContent).toContain(PLUGINS_COPY.banner.changes(1));
  });

  test('says when the host refuses to restart', async () => {
    const { container, getByRole } = open('demo');
    await loaded(container, 'demo');
    await fireEvent.click(getByRole('switch', { name: PLUGINS_COPY.enabled }));
    host!.refuseRestart = Response.json({ error: 'failed', message: '' }, { status: 404 });

    await fireEvent.click(getByRole('button', { name: PLUGINS_COPY.banner.restartNow }));

    await waitFor(() =>
      expect(container.querySelector('[data-testid="plugins-restart-refused"]')).not.toBeNull(),
    );
    expect(container.textContent).toContain(PLUGINS_COPY.banner.refused);
  });
});

describe('two plugins that share a name', () => {
  test('lists both, and edits only the first, which owns the name', async () => {
    const { container, getByRole } = open('linear', {}, [
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

describe('a restart that cannot begin', () => {
  async function restartWith(setup: (host: FakePluginHost) => void) {
    const opened = open('demo');
    await loaded(opened.container, 'demo');
    await fireEvent.click(opened.getByRole('switch', { name: PLUGINS_COPY.enabled }));
    setup(host!);
    await fireEvent.click(opened.getByRole('button', { name: PLUGINS_COPY.banner.restartNow }));
    await waitFor(() =>
      expect(
        opened.container.querySelector('[data-testid="plugins-restart-refused"]'),
      ).not.toBeNull(),
    );
    return opened.container;
  }

  test('says the host keeps its choices when it refuses the write', async () => {
    const container = await restartWith((fake) => {
      fake.refuseNext = Response.json(
        { error: 'locked', reason: 'deployment', message: '' },
        { status: 403 },
      );
    });
    expect(container.textContent).toContain(PLUGINS_COPY.locked);
    expect(writes().filter((request) => request.path === '/host/restart')).toHaveLength(0);
  });

  test('says Interborough did not answer when the restart request gets no answer, and keeps the change', async () => {
    const container = await restartWith((fake) => {
      fake.failRestartRequest = true;
    });
    expect(container.textContent).toContain(PLUGINS_COPY.banner.unreachable);
    expect(banner(container)?.textContent).toContain(PLUGINS_COPY.banner.changes(1));
  });
});

describe('folders that did not load', () => {
  test('lists each by where it is, with what went wrong, apart from the plugins', async () => {
    host = installFakePluginHost(fixtures());
    host.unloaded = [
      {
        source: 'folder',
        location: '/home/.interborough/plugins/broken',
        status: 'skipped',
        problems: [{ code: 'load-failed', message: 'Cannot find package "left-pad".' }],
      },
    ];
    landAt('/settings/plugins');
    const { container } = render(RouteOutletHarness, {
      props: {
        client: new HttpClient({ baseUrl: 'http://localhost/api' }),
        scopes: AUTHORIZATION_SCOPES,
      },
    } as never);

    await waitFor(() =>
      expect(container.querySelector('[data-testid="plugins-unloaded"]')).not.toBeNull(),
    );
    const entry = container.querySelector<HTMLElement>(
      '[data-unloaded="/home/.interborough/plugins/broken"]',
    )!;
    expect(entry.textContent).toContain(PLUGINS_COPY.problems.failed.title);
    expect(entry.textContent).toContain('Cannot find package "left-pad".');
    expect(entry.textContent).toContain(PLUGINS_COPY.source.folder);
  });

  test('shows the empty state only when there are no plugins and no folders', async () => {
    const { container } = open('', {}, []);

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
        body: { value: SECRET },
      },
    ]);
    expect(bannerText(container)).toBeNull();
    expect(container.ownerDocument.body.innerHTML).not.toContain(SECRET);
    expect(container.ownerDocument.body.textContent).not.toContain(SECRET);
    expect(container.textContent).toContain(PLUGINS_COPY.secrets.set);
  });

  test('offers the missing secret from the problem, and a refused one is worded without the value', async () => {
    const { container, getByRole } = open('typesafe');
    await loaded(container, 'typesafe');
    expect(container.querySelector('[data-plugin-problem]')?.textContent).toContain(
      PLUGINS_COPY.problems.secretMissing.title,
    );
    host!.refuseNext = Response.json(
      { error: 'invalid', field: 'value', message: `${SECRET} is not accepted` },
      { status: 400 },
    );

    await fireEvent.click(
      getByRole('button', { name: PLUGINS_COPY.problems.secretMissing.action }),
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
    const { container, getByRole } = open('demo', { lockReason: 'deployment' });
    await loaded(container, 'demo');

    expect(container.textContent).toContain(PLUGINS_COPY.locked);
    expect(getByRole('switch', { name: PLUGINS_COPY.enabled }).hasAttribute('disabled')).toBe(true);
  });
});

describe('problems', () => {
  test('words each problem and keeps one for a code it does not know', async () => {
    const { container } = open('linear', {}, [
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
    expect(problems[0]).toContain('teamKey: Team key must be 2 to 5 capital letters.');
    expect(problems[1]).toContain(PLUGINS_COPY.problems.unknown('brand-new-code'));
  });
});
