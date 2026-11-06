/**
 * `/settings/plugins` (COR-1891): the plugins the host loaded, what each adds, the choices an owner
 * makes, and the restart that applies them. The host's plugin routes are a stand-in
 * (`plugins-host.test-support.ts`); the real ones are exercised by `src/host/host-plugins.test.ts`.
 */
import { HttpClient } from '@lostgradient/weft';
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { PLUGINS_COPY, RESTART_COPY } from '../../../app/copy.ts';
import { restartProbing } from '../../../app/restart/host-restart-flow.svelte.ts';
import RouteOutletHarness from '../../../app/shell/route-outlet.test-harness.svelte';
import { AUTHORIZATION_SCOPES } from '../../../lib/scopes.svelte.ts';
import { landAt } from '../../chat/pages.test-support.ts';
import {
  contribution,
  installFakePluginHost,
  type FakePluginHost,
  type PluginFixture,
} from './plugins-host.test-support.ts';

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
  restartProbing.retryDelayMs = () => 0;
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

/** Restart now asks first (`RESTART_COPY.confirm`): this presses it and confirms. */
async function restartNow(container: HTMLElement): Promise<void> {
  await fireEvent.click(
    within(container).getByRole('button', { name: PLUGINS_COPY.banner.restartNow }),
  );
  const question = await bodyOf(container).findByRole('dialog', {
    name: RESTART_COPY.confirm.title,
  });
  await fireEvent.click(
    within(question).getByRole('button', { name: RESTART_COPY.confirm.confirm }),
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

/** The textarea behind a plugin's configuration editor, which holds its text once the editor mounts. */
function configurationField(container: HTMLElement, plugin: string): HTMLTextAreaElement {
  const field = container.querySelector<HTMLTextAreaElement>(
    `[data-plugin-detail="${plugin}"] textarea.cinder-json-editor__textarea`,
  );
  expect(field).not.toBeNull();
  return field!;
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
  test('Restart now asks first, and nothing is written or restarted until it is confirmed', async () => {
    const { container, getByRole } = open('demo');
    await loaded(container, 'demo');
    await fireEvent.click(getByRole('switch', { name: PLUGINS_COPY.enabled }));
    await fireEvent.click(getByRole('button', { name: PLUGINS_COPY.banner.restartNow }));

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
    expect(writes()).toEqual([]);
  });

  test('Restart now writes the changes, posts to the restart route, and says what applied once the host answers again', async () => {
    const { container, getByRole } = open('demo');
    await loaded(container, 'demo');
    await fireEvent.click(getByRole('switch', { name: PLUGINS_COPY.enabled }));
    await waitFor(() => expect(bannerText(container)).not.toBeNull());

    await restartNow(container);

    const back = await backBanner(container);
    expect(writes()).toEqual([
      {
        method: 'PUT',
        path: '/host/plugins/demo',
        body: { enabled: true, operationId: expect.any(String), expectedRevision: '{}' },
      },
      { method: 'POST', path: '/host/restart', body: undefined },
    ]);
    // The dialog is gone; the banner says what applied and how the plugins stand now.
    expect(bodyOf(container).queryByRole('dialog')).toBeNull();
    expect(back.textContent).toContain(RESTART_COPY.back.title);
    expect(back.textContent).toContain(RESTART_COPY.back.applied(['demo']));
    expect(back.textContent).toContain(
      '4 plugins running (linear, anthropic, bureau and demo); typesafe needs setup.',
    );
    expect(bannerText(container)).toBeNull();
    expect(rowOf(container, 'demo')?.textContent).toContain(PLUGINS_COPY.status.running);

    await fireEvent.click(within(back).getByRole('button', { name: RESTART_COPY.back.dismiss }));
    await waitFor(() =>
      expect(container.querySelector('[data-testid="restart-back"]')?.outerHTML ?? null).toBeNull(),
    );
  });

  test('counts the reconnect attempts while the host does not answer, and not the end before it does', async () => {
    restartProbing.retryDelayMs = () => 60_000;
    const { container, getByRole } = open('demo', { downFor: 1 });
    await loaded(container, 'demo');
    await fireEvent.click(getByRole('switch', { name: PLUGINS_COPY.enabled }));
    await restartNow(container);

    const card = await restartCard(container);
    await waitFor(() => expect(card.getAttribute('data-cinder-phase')).toBe('reconnecting'));
    expect(card.textContent).toContain('Attempt 1 of 8.');
    expect(within(card).getByRole('button', { name: 'Retry now' })).not.toBeNull();
    expect(container.querySelector('[data-testid="restart-back"]')).toBeNull();
    // The page does not offer a second restart while one runs.
    expect(writes().filter((request) => request.path === '/host/restart')).toHaveLength(1);

    // Retry now probes at once, without waiting out the minute the countdown has left.
    await fireEvent.click(within(card).getByRole('button', { name: 'Retry now' }));
    await backBanner(container);
  });

  test('knows the host is back when it answers with nothing pending, even if it was never seen down', async () => {
    const { container, getByRole } = open('demo', { downFor: 0 });
    await loaded(container, 'demo');
    await fireEvent.click(getByRole('switch', { name: PLUGINS_COPY.enabled }));

    await restartNow(container);

    await backBanner(container);
  });

  test('says the host did not come back after 8 tries, with what to check, the launch command and Keep waiting', async () => {
    const { container, getByRole } = open('demo', { downFor: 1_000 });
    await loaded(container, 'demo');
    await fireEvent.click(getByRole('switch', { name: PLUGINS_COPY.enabled }));
    await restartNow(container);

    const card = await restartCard(container);
    await waitFor(() => expect(card.getAttribute('data-cinder-phase')).toBe('failed'));
    expect(card.querySelector('h2')?.textContent).toContain('Interborough didn’t come back');
    expect(card.textContent).toContain(RESTART_COPY.failed.description(1, undefined));
    expect(card.textContent).toContain(RESTART_COPY.failed.check);
    expect(card.textContent).toContain('Show the error details');
    // The command is the one the host reported before it stopped.
    expect(card.querySelector('code.cinder-restart-state__command-text')?.textContent).toBe(
      'bun run start',
    );
    expect(within(card).getByRole('button', { name: 'Copy' })).not.toBeNull();
    // There is no restart-again action: the route that restarts lives on the host that is not answering.
    expect(within(card).getByRole('button', { name: 'Keep waiting' })).not.toBeNull();
    expect(within(card).queryByRole('button', { name: /restart/i })).toBeNull();
    // The dialog cannot be dismissed, and no banner claims the host is back.
    expect(container.querySelector('[data-testid="restart-back"]')).toBeNull();
  });

  test('Keep waiting watches again, and the host coming back ends the failed state', async () => {
    const { container, getByRole } = open('demo', { downFor: 12 });
    await loaded(container, 'demo');
    await fireEvent.click(getByRole('switch', { name: PLUGINS_COPY.enabled }));
    await restartNow(container);

    const card = await restartCard(container);
    await waitFor(() => expect(card.getAttribute('data-cinder-phase')).toBe('failed'));
    await fireEvent.click(within(card).getByRole('button', { name: 'Keep waiting' }));

    await backBanner(container);
    expect(bodyOf(container).queryByRole('dialog')).toBeNull();
  });

  test('leaves the command out of the failed state when the host cannot say how it was launched', async () => {
    const { container, getByRole } = open('demo', { downFor: 1_000 });
    host!.launch = null;
    await loaded(container, 'demo');
    await fireEvent.click(getByRole('switch', { name: PLUGINS_COPY.enabled }));
    await restartNow(container);

    const card = await restartCard(container);
    await waitFor(() => expect(card.getAttribute('data-cinder-phase')).toBe('failed'));
    expect(card.querySelector('.cinder-restart-state__command')).toBeNull();
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
    expect(back.textContent).toContain(RESTART_COPY.back.disabled('linear'));
    expect(back.textContent).toContain(
      '2 plugins running (anthropic and bureau); typesafe needs setup; linear and demo are disabled.',
    );
    // The references it counted before the restart say what stopped working.
    expect(back.textContent).toContain('1 agent, 2 schedules and 1 waiting run used linear');
    expect(back.textContent).toContain(RESTART_COPY.back.enableAgain);
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

    await backBanner(container);
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

    await restartNow(container);

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

    await restartNow(container);

    const notice = await waitFor(() => {
      const found = container.querySelector<HTMLElement>(
        '[data-testid="plugins-restart-unconfirmed"]',
      );
      expect(found).not.toBeNull();
      return found!;
    });
    expect(notice.textContent).toContain(RESTART_COPY.unconfirmed.description);
    expect(bodyOf(container).queryByRole('dialog')?.outerHTML ?? null).toBeNull();
    await fireEvent.click(within(notice).getByRole('button', { name: /dismiss/i }));
    await waitFor(() =>
      expect(
        container.querySelector('[data-testid="plugins-restart-unconfirmed"]')?.outerHTML ?? null,
      ).toBeNull(),
    );
    // The change is stored and still waits for a restart.
    expect(banner(container)?.textContent).toContain(PLUGINS_COPY.banner.changes(1));
  });

  test('says when the host refuses to restart', async () => {
    const { container, getByRole } = open('demo');
    await loaded(container, 'demo');
    await fireEvent.click(getByRole('switch', { name: PLUGINS_COPY.enabled }));
    host!.refuseRestart = Response.json({ error: 'failed', message: '' }, { status: 404 });

    await restartNow(container);

    await waitFor(() =>
      expect(container.querySelector('[data-testid="plugins-restart-refused"]')).not.toBeNull(),
    );
    expect(container.textContent).toContain(PLUGINS_COPY.banner.refused);
  });
});

describe('a change the host applies at once', () => {
  test('is saved without a restart, and is not left pending', async () => {
    const { container } = open('anthropic', {}, [
      {
        name: 'anthropic',
        liveConfiguration: true,
        configuration: { allowlist: ['a'] },
        contributions: [contribution('provider', 'anthropic')],
      },
      { name: 'demo', enabled: false },
    ]);
    await loaded(container, 'anthropic');
    await fireEvent.input(configurationField(container, 'anthropic'), {
      target: { value: '{ "allowlist": ["a", "b"] }' },
    });
    await waitFor(() => expect(bannerText(container)).not.toBeNull());

    await restartNow(container);

    await waitFor(() => expect(bannerText(container)).toBeNull());
    expect(writes()).toEqual([
      {
        method: 'PUT',
        path: '/host/plugins/anthropic',
        body: {
          configuration: { allowlist: ['a', 'b'] },
          operationId: expect.any(String),
          expectedRevision: '{}',
        },
      },
    ]);
    expect(container.ownerDocument.body.querySelector('.cinder-restart-state__card')).toBeNull();
    expect(bodyOf(container).queryByRole('dialog')?.outerHTML ?? null).toBeNull();
    expect(configurationField(container, 'anthropic').value).toContain('"b"');
    expect(container.ownerDocument.body.textContent).toContain(PLUGINS_COPY.banner.saved);
  });

  test('still restarts when another plugin in the same write needs it', async () => {
    const { container, getByRole } = open('anthropic', {}, [
      { name: 'anthropic', liveConfiguration: true, configuration: {} },
      { name: 'demo', enabled: false },
    ]);
    await loaded(container, 'anthropic');
    await fireEvent.input(configurationField(container, 'anthropic'), {
      target: { value: '{ "allowlist": [] }' },
    });
    await fireEvent.click(rowOf(container, 'demo')!);
    await waitFor(() =>
      expect(container.querySelector('[data-plugin-detail="demo"]')).not.toBeNull(),
    );
    await fireEvent.click(getByRole('switch', { name: PLUGINS_COPY.enabled }));

    await restartNow(container);

    await backBanner(container);
    expect(writes().filter((request) => request.path === '/host/restart')).toHaveLength(1);
  });
});

describe('a write the host rejects', () => {
  test('names the plugin, the field and the host message beside that plugin editor', async () => {
    const { container } = open('linear');
    await loaded(container, 'linear');
    await fireEvent.input(configurationField(container, 'linear'), {
      target: { value: '{ "teamKey": 7 }' },
    });
    host!.refuseNext = Response.json(
      { error: 'invalid', field: 'configuration.teamKey', message: 'expected a string.' },
      { status: 400 },
    );

    await restartNow(container);

    const rejection = await waitFor(() => {
      const found = container.querySelector<HTMLElement>('[data-testid="plugin-write-rejected"]');
      expect(found).not.toBeNull();
      return found!;
    });
    expect(rejection.textContent).toContain('configuration.teamKey');
    expect(rejection.textContent).toContain('expected a string.');
    expect(container.querySelector('[data-plugin-detail="linear"]')?.contains(rejection)).toBe(
      true,
    );
    expect(container.textContent).toContain(PLUGINS_COPY.banner.rejected('linear'));
    expect(writes().filter((request) => request.path === '/host/restart')).toHaveLength(0);
    // The text is still there to correct.
    expect(bannerText(container)).not.toBeNull();
  });
});

describe('disabling with other changes waiting', () => {
  async function stageDemoSwitch() {
    const opened = open('demo');
    await loaded(opened.container, 'demo');
    await fireEvent.click(opened.getByRole('switch', { name: PLUGINS_COPY.enabled }));
    await fireEvent.click(rowOf(opened.container, 'linear')!);
    await waitFor(() =>
      expect(opened.container.querySelector('[data-plugin-detail="linear"]')).not.toBeNull(),
    );
    return opened;
  }

  test('does not write or restart while another plugin holds text that is not valid, and keeps the text', async () => {
    const { container, getByRole } = open('linear');
    await loaded(container, 'linear');
    await fireEvent.input(configurationField(container, 'linear'), {
      target: { value: '{ "teamKey": ' },
    });
    await fireEvent.click(rowOf(container, 'anthropic')!);
    await waitFor(() =>
      expect(container.querySelector('[data-plugin-detail="anthropic"]')).not.toBeNull(),
    );
    await fireEvent.click(getByRole('switch', { name: PLUGINS_COPY.enabled }));
    const dialog = await bodyOf(container).findByRole('dialog');

    expect(dialog.textContent).toContain(PLUGINS_COPY.banner.invalid);
    const confirm = within(dialog).getByRole('button', { name: PLUGINS_COPY.disable.confirm });
    expect(confirm.hasAttribute('disabled')).toBe(true);
    await fireEvent.click(confirm);

    expect(writes()).toEqual([]);
    await fireEvent.click(
      within(dialog).getByRole('button', { name: PLUGINS_COPY.disable.cancel }),
    );
    await waitFor(() =>
      expect(bodyOf(container).queryByRole('dialog')?.outerHTML ?? null).toBeNull(),
    );
    await fireEvent.click(rowOf(container, 'linear')!);
    await waitFor(() =>
      expect(configurationField(container, 'linear').value).toBe('{ "teamKey": '),
    );
  });

  test('lists every other change it will write, then writes them', async () => {
    const { container, getByRole } = await stageDemoSwitch();
    await fireEvent.input(configurationField(container, 'linear'), {
      target: { value: '{ "teamKey": "OPS" }' },
    });
    await fireEvent.click(rowOf(container, 'anthropic')!);
    await waitFor(() =>
      expect(container.querySelector('[data-plugin-detail="anthropic"]')).not.toBeNull(),
    );
    await fireEvent.click(getByRole('switch', { name: PLUGINS_COPY.enabled }));
    const dialog = await bodyOf(container).findByRole('dialog');

    const pending = [...dialog.querySelectorAll<HTMLElement>('[data-pending-change]')].map(
      (item) => item.textContent ?? '',
    );
    expect(pending).toHaveLength(2);
    expect(pending.join('\n')).toContain('demo');
    expect(pending.join('\n')).toContain('linear');
    await fireEvent.click(
      within(dialog).getByRole('button', { name: PLUGINS_COPY.disable.confirm }),
    );

    await backBanner(container);
    await waitFor(() =>
      expect(writes().map((request) => `${request.method} ${request.path}`)).toEqual([
        'PUT /host/plugins/linear',
        'PUT /host/plugins/anthropic',
        'PUT /host/plugins/demo',
        'POST /host/restart',
      ]),
    );
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
    await restartNow(opened.container);
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
    expect(entry.textContent).toContain('The plugin’s code didn’t load');
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
        body: { value: SECRET, operationId: expect.any(String), expectedRevision: '{}' },
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
      'A secret isn’t saved yet',
    );
    host!.refuseNext = Response.json(
      { error: 'invalid', field: 'value', message: `${SECRET} is not accepted` },
      { status: 400 },
    );

    await fireEvent.click(getByRole('button', { name: 'Add the key' }));
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
    expect(problems[1]).toContain('Reported as brand-new-code.');
  });
});

describe('a problem’s button', () => {
  test('Fix the setting moves to the configuration editor', async () => {
    const { container, getByRole } = open('linear', {}, [
      {
        name: 'linear',
        status: 'skipped',
        problems: [
          { code: 'configuration-invalid', field: 'teamKey', message: 'Must be capital letters.' },
        ],
      },
    ]);
    await loaded(container, 'linear');

    await fireEvent.click(getByRole('button', { name: 'Fix the setting' }));

    expect(container.ownerDocument.activeElement?.id).toBe('plugin-configuration-linear');
  });

  test('Show both opens the plugin that kept the name', async () => {
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
    await fireEvent.click(container.querySelectorAll('[data-plugin-row="linear"]')[1]!);
    await waitFor(() =>
      expect(container.querySelector('[data-plugin-detail] [data-plugin-problem]')).not.toBeNull(),
    );

    await fireEvent.click(getByRole('button', { name: 'Show both' }));

    await waitFor(() =>
      expect(container.querySelectorAll('[data-plugin-detail] [data-plugin-problem]')).toHaveLength(
        0,
      ),
    );
    expect(container.querySelector('[data-plugin-detail] dd')?.textContent).toContain(
      '@lostgradient/plugin-linear',
    );
  });

  test('Show both is not drawn when the other side is not a listed plugin', async () => {
    const { container, queryByRole } = open('linear', {}, [
      {
        name: 'linear',
        status: 'skipped',
        problems: [
          {
            code: 'name-clash',
            name: 'linear:create-issue',
            first: { source: 'built-in', location: 'host' },
            second: { source: 'package', location: '@lostgradient/plugin-package' },
          },
        ],
      },
    ]);
    await loaded(container, 'linear');
    await waitFor(() =>
      expect(container.querySelector('[data-plugin-problem="name-clash"]')).not.toBeNull(),
    );

    expect(queryByRole('button', { name: 'Show both' })).toBeNull();
  });
});
