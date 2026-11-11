/**
 * The agents list, for the agents a plugin ships (board PageAgents, "Agents, /agents" and its
 * captioned states). A plugin's agent that can run is an ordinary row, and a file among them has an
 * editor (the 2026-11-05 amendment makes plugin agents editable; Duplicate lives in the agent's
 * header, not in the row). An agent a disabled plugin holds back is read from the definitions list
 * and sits in its own card, whose one "Enable and restart" opens the question before the plugin is
 * turned on and the host restarts. The world is a stubbed Bureau under the fake plugin host the
 * Settings › Plugins tests use.
 */
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';

import { restartProbing } from '../../app/restart/host-restart-flow.svelte.ts';
import { taskFixture, toolApprovalFixture } from '../../lib/bureau-fixtures.test-support.ts';
import { router } from '../../lib/router.svelte.ts';
import { AGENT, bureau, landAt } from '../chat/pages.test-support.ts';
import QueryPage from '../chat/query-page.test-harness.svelte';
import { installFakePluginHost } from '../settings/plugins/plugins-host.test-support.ts';
import AgentList from './agent-list.svelte';

let restore: (() => void) | undefined;
let restoreViewport: (() => void) | undefined;
afterEach(() => {
  cleanup();
  restoreViewport?.();
  restoreViewport = undefined;
  restore?.();
  restore = undefined;
});

const PLUGIN_AGENT = {
  ...AGENT,
  name: 'linear:triager',
  displayName: 'Triager',
  kind: 'file',
  description: 'Triages issues.',
};
const OWN_AGENT = { ...AGENT, name: 'mine', displayName: 'Mine', kind: 'file' };

const held = (id: string, name: string, description: string) => ({
  id,
  source: 'code',
  state: 'unavailable',
  unavailable: { code: 'plugin-disabled', message: 'Plugin Demo is disabled' },
  name,
  description,
  a2a: false,
  hash: null,
  problem: null,
});
const RELEASE_HELPER = held(
  'demo:release-helper',
  'release-helper',
  'Drafts release notes from the pull requests merged since the last tag.',
);
const CHANGELOG_WRITER = held(
  'demo:changelog-writer',
  'changelog-writer',
  'Turns release notes into a short customer-facing changelog entry.',
);

/** The settings the restart flow reads once the host answers again; the page never shows them. */
const SETTINGS = {
  values: {},
  effective: {},
  running: {},
  revision: 0,
  persisted: true,
  keys: {},
};

type Answers = Parameters<typeof bureau>[0];

function serve(extra: Answers = {}) {
  const served = bureau({
    'bureau.agents.list': () => ({ agents: [AGENT, PLUGIN_AGENT, OWN_AGENT] }),
    'bureau.contexts.list': () => ({ contexts: [], nextOffset: null }),
    'bureau.agents.definitions.list': () => ({
      agents: [RELEASE_HELPER, CHANGELOG_WRITER],
      nextOffset: null,
    }),
    'bureau.reviews.list': () => ({ reviews: [], nextPageToken: null }),
    'bureau.tasks.list': () => ({ tasks: [], nextPageToken: null }),
    'bureau.settings.get': () => SETTINGS,
    ...extra,
  });
  restore = served.restore;
  return served;
}

const mount = () => render(QueryPage, { props: { page: AgentList } } as never);

/** Makes the viewport a phone, which is what `phoneViewport` reads. */
function phone(): void {
  const original = window.matchMedia;
  window.matchMedia = ((query: string) => ({
    matches: query === '(width < 640px)',
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
  })) as unknown as typeof window.matchMedia;
  restoreViewport = () => {
    window.matchMedia = original;
  };
}

const row = (container: HTMLElement, id: string) =>
  container.querySelector<HTMLElement>(`[data-agent="${id}"]`);

describe('the agents list, for a plugin’s agent that can run', () => {
  test('offers Edit on a plugin’s file agent as on the owner’s, and Duplicate nowhere in the row', async () => {
    landAt('/agents');
    serve({ 'bureau.agents.definitions.list': () => ({ agents: [], nextOffset: null }) });
    const { container, findByRole, queryByRole } = mount();

    await findByRole('link', { name: 'Edit Mine' });
    expect(
      row(container, 'linear:triager')?.querySelector('a[href="/agents/linear%3Atriager/edit"]'),
    ).not.toBeNull();
    expect(row(container, 'mine')?.querySelector('a[href="/agents/mine/edit"]')).not.toBeNull();
    expect(queryByRole('button', { name: 'Duplicate' })).toBeNull();
    expect(container.textContent).not.toContain('Duplicate');
  });
});

describe('the agents a disabled plugin holds back', () => {
  test('sit in a second card headed Unavailable 2, with one Enable and restart in the header and the reason where the buttons would be', async () => {
    landAt('/agents');
    serve();
    const { container, findByRole } = mount();

    await findByRole('heading', { level: 2, name: 'Unavailable 2' });
    await findByRole('heading', { level: 2, name: 'Available 3' });
    const card = container.querySelector('[data-testid="agents-unavailable"]');
    expect(card?.textContent).toContain(
      'Their plugin, Demo, is disabled. Chats with these agents are read-only until you enable it and restart.',
    );
    // The button is once in the group header and on no row.
    expect(container.querySelectorAll('[data-testid="agents-enable"]')).toHaveLength(1);
    expect(card?.querySelectorAll('[data-testid="agent-enable-row"]')).toHaveLength(0);

    for (const [id, title, description] of [
      ['demo:release-helper', 'Release helper', RELEASE_HELPER.description],
      ['demo:changelog-writer', 'Changelog writer', CHANGELOG_WRITER.description],
    ] as const) {
      const held = row(container, id);
      expect(held?.getAttribute('data-state')).toBe('unavailable');
      expect(held?.querySelector('.ib-agent-name')?.textContent).toBe(title);
      expect(held?.querySelector('[data-testid="agent-identifier"]')?.textContent).toBe(id);
      expect(held?.textContent).toContain('Unavailable');
      expect(held?.querySelector('[data-testid="agent-description"]')?.textContent).toBe(
        description,
      );
      // No icon buttons: the slot says why, in muted text, and Unavailable is neutral.
      expect(held?.querySelector('[data-testid="agent-held"]')?.textContent).toBe(
        'Plugin Demo is disabled',
      );
      expect(held?.querySelector('a[href$="/memories"]')).toBeNull();
      // Its address is not an agent the Bureau lists, so the row opens nothing.
      expect(held?.querySelector('a[href]')).toBeNull();
      expect(held?.querySelector('[data-testid="agent-new-chat"]')).toBeNull();
      expect(held?.querySelector('[data-cinder-status="neutral"]')).not.toBeNull();
    }
    // The agents that can run stay in the first card, and the held-back ones are not among them.
    const available = container.querySelector('[data-testid="agents-available"]');
    expect(available?.querySelector('[data-agent="demo:release-helper"]')).toBeNull();
    expect(available?.querySelector('[data-agent="assistant"]')).not.toBeNull();
  });

  test('count in All and are left out of Available, which hides their card', async () => {
    landAt('/agents');
    serve();
    const { container, findByRole } = mount();

    await findByRole('radio', { name: /^All\s*,\s*5$/ });
    await fireEvent.click(await findByRole('radio', { name: /^Available\s*,\s*3$/ }));
    await waitFor(() =>
      expect(container.querySelector('[data-testid="agents-unavailable"]')?.outerHTML ?? null).toBeNull(),
    );
    expect(container.querySelector('[data-testid="agents-available"]')).not.toBeNull();
  });

  test('are the whole page, with Enable and restart first and New agent beside it, when no agent can run', async () => {
    landAt('/agents');
    serve({ 'bureau.agents.list': () => ({ agents: [] }) });
    const { container, findByRole, queryByRole } = mount();

    await findByRole('heading', { level: 2, name: 'No agent can run yet' });
    const state = container.querySelector('[data-cinder-kind="disabled"]');
    expect(state?.textContent).toContain(
      'Release helper and Changelog writer are held back while Demo is disabled.',
    );
    const buttons = [...(state?.querySelectorAll('a, button') ?? [])].map((control) =>
      control.textContent?.trim(),
    );
    expect(buttons).toEqual(['Enable and restart', 'New agent']);
    // No filter row is drawn, and the header keeps its "+".
    expect(queryByRole('radio', { name: /^All/ })).toBeNull();
    expect(container.querySelector('a[aria-label="New agent"]')).not.toBeNull();
  });
});

describe('Enable and restart, from the list', () => {
  const confirmButton = (dialog: HTMLElement) =>
    [...dialog.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === 'Enable and restart',
    );

  test('asks Enable Demo and restart?, names what comes back, and says what a restart does to work in flight', async () => {
    landAt('/agents');
    serve({
      'bureau.reviews.list': () => ({
        reviews: [
          toolApprovalFixture(),
          toolApprovalFixture({ id: 'approval:run-2:call-1', runId: 'run-2' }),
        ],
        nextPageToken: null,
      }),
    });
    const { container, findByRole } = mount();

    await findByRole('heading', { level: 2, name: 'Unavailable 2' });
    await fireEvent.click(
      container.querySelector<HTMLElement>('[data-testid="agents-enable"]') as HTMLElement,
    );

    const dialog = await findByRole('dialog');
    expect(dialog.textContent).toContain('Enable Demo and restart?');
    expect(dialog.textContent).toContain(
      'Plugins load at startup, so Interborough restarts to load Demo. Release helper and Changelog writer become available afterwards.',
    );
    // Nothing is running in this world, so the note never says so; it says what the restart does.
    await waitFor(() =>
      expect(dialog.querySelector('[data-testid="agent-enable-work"]')?.textContent).toBe(
        'Running work picks up where it stopped; reviews stay waiting (2 are waiting on you). Interborough reconnects on its own when it is back.',
      ),
    );
    expect(dialog.textContent).not.toMatch(/nothing is running/i);
  });

  test('counts the runs going now ahead of the effect on reviews', async () => {
    landAt('/agents');
    serve({
      'bureau.tasks.list': (params) => ({
        tasks: params['status'] === 'working' ? [taskFixture()] : [],
        nextPageToken: null,
      }),
    });
    const { container, findByRole } = mount();

    await findByRole('heading', { level: 2, name: 'Unavailable 2' });
    await fireEvent.click(
      container.querySelector<HTMLElement>('[data-testid="agents-enable"]') as HTMLElement,
    );

    const dialog = await findByRole('dialog');
    await waitFor(() =>
      expect(dialog.querySelector('[data-testid="agent-enable-work"]')?.textContent).toBe(
        '1 run is running now. Running work picks up where it stopped; reviews stay waiting. Interborough reconnects on its own when it is back.',
      ),
    );
  });

  test('keeps the list on screen under the shared restart banner, which offers Retry now once the host stopped answering', async () => {
    const probing = { ...restartProbing };
    restartProbing.delayMs = 0;
    restartProbing.retryDelayMs = () => 60_000;
    landAt('/agents');
    serve();
    const host = installFakePluginHost(
      [{ name: 'demo', title: 'Demo', enabled: false, contributions: [] }],
      { downFor: 1 },
    );
    try {
      const { container, findByRole, findByTestId } = mount();
      await findByRole('heading', { level: 2, name: 'Unavailable 2' });
      await fireEvent.click(
        container.querySelector<HTMLElement>('[data-testid="agents-enable"]') as HTMLElement,
      );
      const dialog = await findByRole('dialog');
      await fireEvent.click(confirmButton(dialog) as HTMLElement);

      const banner = await findByTestId('agents-restart-banner');
      await waitFor(() => expect(banner.textContent).toContain('Retry now'));
      expect(container.querySelector('[data-agent="assistant"]')).not.toBeNull();
      // The plugin was switched on before the host was asked to restart.
      expect(host.requests.some((request) => request.method === 'PUT')).toBe(true);
      expect(host.requests.some((request) => request.path === '/host/restart')).toBe(true);
    } finally {
      host.restore();
      Object.assign(restartProbing, probing);
    }
  });

  test('says Demo is on once the host is back, with a link to Plugins, where the steps of the restart are drawn', async () => {
    const probing = { ...restartProbing };
    restartProbing.delayMs = 0;
    restartProbing.retryDelayMs = () => 0;
    landAt('/agents');
    serve();
    const host = installFakePluginHost(
      [{ name: 'demo', title: 'Demo', enabled: false, contributions: [] }],
      { downFor: 1 },
    );
    try {
      const { container, findByRole, findByTestId } = mount();
      await findByRole('heading', { level: 2, name: 'Unavailable 2' });
      await fireEvent.click(
        container.querySelector<HTMLElement>('[data-testid="agents-enable"]') as HTMLElement,
      );
      const dialog = await findByRole('dialog');
      await fireEvent.click(confirmButton(dialog) as HTMLElement);

      const back = await findByTestId('agents-restart-back');
      expect(back.textContent).toContain('Back up');
      expect(back.textContent).toContain(
        'Demo is on. Release helper and Changelog writer are available again.',
      );
      const link = [...back.querySelectorAll('a')].find(
        (anchor) => anchor.textContent?.trim() === 'Open Plugins',
      );
      expect(link?.getAttribute('href')).toBe('/settings/plugins');
      link?.click();
      expect(router.pathname).toBe('/settings/plugins');
    } finally {
      host.restore();
      Object.assign(restartProbing, probing);
    }
  });

  test('stays open with the reason when the plugin cannot be enabled, and nothing is restarted', async () => {
    landAt('/agents');
    serve();
    const host = installFakePluginHost([
      { name: 'demo', title: 'Demo', enabled: false, contributions: [] },
    ]);
    host.refuseNext = Response.json(
      {
        error: 'invalid',
        field: 'enabled',
        message: 'The plugin failed to load: its settings file is invalid.',
      },
      { status: 400 },
    );
    try {
      const { container, findByRole } = mount();
      await findByRole('heading', { level: 2, name: 'Unavailable 2' });
      await fireEvent.click(
        container.querySelector<HTMLElement>('[data-testid="agents-enable"]') as HTMLElement,
      );
      const dialog = await findByRole('dialog');
      await fireEvent.click(confirmButton(dialog) as HTMLElement);

      await waitFor(() => expect(dialog.textContent).toContain('Couldn’t enable Demo.'));
      expect(dialog.textContent).toContain(
        'The plugin failed to load: its settings file is invalid. Nothing was restarted and nothing changed.',
      );
      expect(
        [...dialog.querySelectorAll('a')].some(
          (anchor) => anchor.textContent?.trim() === 'Open Plugins',
        ),
      ).toBe(true);
      // The dialog is still the question, and the host was never asked to restart.
      expect(dialog.textContent).toContain('Enable Demo and restart?');
      expect(host.requests.some((request) => request.path === '/host/restart')).toBe(false);
      expect(container.querySelector('[data-testid="agents-restart-banner"]')).toBeNull();
    } finally {
      host.restore();
    }
  });
});

describe('the agents list, when the host will not restart after the switch was saved', () => {
  test('says the host refused, in a banner above the list, with a link to Plugins', async () => {
    landAt('/agents');
    serve();
    const host = installFakePluginHost([
      { name: 'demo', title: 'Demo', enabled: false, contributions: [] },
    ]);
    host.refuseRestart = Response.json({ error: 'failed', message: '' }, { status: 404 });
    try {
      const { container, findByRole, findByTestId } = mount();
      await findByRole('heading', { level: 2, name: 'Unavailable 2' });
      await fireEvent.click(
        container.querySelector<HTMLElement>('[data-testid="agents-enable"]') as HTMLElement,
      );
      const dialog = await findByRole('dialog');
      await fireEvent.click(confirmButton(dialog) as HTMLElement);

      const banner = await findByTestId('agents-restart-refused');
      expect(banner.textContent).toContain(
        'Demo is switched on, but Interborough has not restarted.',
      );
      expect(banner.textContent).toContain(
        'This host cannot restart itself. Restart it where it runs.',
      );
      expect(
        [...banner.querySelectorAll('a')].some(
          (anchor) => anchor.textContent?.trim() === 'Open Plugins',
        ),
      ).toBe(true);
      // The switch was saved before the restart was asked for, and the dialog is closed.
      expect(host.requests.some((request) => request.method === 'PUT')).toBe(true);
      expect(host.requests.some((request) => request.path === '/host/restart')).toBe(true);
      expect(container.querySelector('[data-testid="agents-restart-banner"]')).toBeNull();
      // The agents stay held back: nothing was restarted.
      expect(row(container, 'demo:release-helper')).not.toBeNull();
    } finally {
      host.restore();
    }
  });

  test('says the same when the restart request gets no answer', async () => {
    landAt('/agents');
    serve();
    const host = installFakePluginHost([
      { name: 'demo', title: 'Demo', enabled: false, contributions: [] },
    ]);
    host.failRestartRequest = true;
    try {
      const { container, findByRole, findByTestId } = mount();
      await findByRole('heading', { level: 2, name: 'Unavailable 2' });
      await fireEvent.click(
        container.querySelector<HTMLElement>('[data-testid="agents-enable"]') as HTMLElement,
      );
      const dialog = await findByRole('dialog');
      await fireEvent.click(confirmButton(dialog) as HTMLElement);

      const banner = await findByTestId('agents-restart-refused');
      expect(banner.textContent).toContain(
        'Interborough did not answer, so it was not asked to restart. Try again.',
      );
    } finally {
      host.restore();
    }
  });
});

describe('the agents list on a phone', () => {
  test('draws no icon buttons, puts the status and identifier on line two, and gives each held-back agent its own Enable and restart in place of the group header', async () => {
    phone();
    landAt('/agents');
    serve({
      'bureau.contexts.list': () => ({
        contexts: [
          {
            id: 'session-1',
            owner: 'anonymous:local',
            agentName: 'assistant',
            title: 'Plan the week',
            lastMessagePreview: 'Sounds good.',
            parentContextId: null,
            forkedFromMessageId: null,
            model: null,
            effort: null,
            permissionMode: 'on-changes',
            configVersion: 0,
            messageCount: 2,
            createdAt: '2026-10-19T08:00:00.000Z',
            updatedAt: '2026-10-19T09:00:00.000Z',
            activity: 'awaiting-input',
            origin: 'chat',
          },
        ],
        nextOffset: null,
      }),
    });
    const { container, findByRole } = mount();

    await findByRole('link', { name: /^Assistant/ });
    await waitFor(() =>
      expect(
        row(container, 'assistant')?.querySelector('[data-testid="agent-chat-count"]')?.textContent,
      ).toBe('1 chat'),
    );
    const assistant = row(container, 'assistant');
    // The row opens the agent's page; Memory, New chat and Edit are on that page.
    expect(assistant?.querySelector('[data-testid="agent-memory"]')).toBeNull();
    expect(assistant?.querySelector('[data-testid="agent-new-chat"]')).toBeNull();
    expect(assistant?.querySelector('[data-testid="agent-edit"]')).toBeNull();
    // Line one is the name only; the identifier follows the status and the count on line two.
    expect(assistant?.querySelectorAll('[data-testid="agent-identifier"]')).toHaveLength(1);
    expect(
      assistant?.querySelector('.ib-agent-row__title [data-testid="agent-identifier"]'),
    ).toBeNull();
    expect(assistant?.querySelector('[data-testid="agent-needs-you"]')?.textContent).toContain(
      'Waiting on you',
    );
    // The group header is gone; each held-back row carries the reason and its own link.
    expect(container.querySelector('[data-testid="agents-enable"]')).toBeNull();
    const helper = row(container, 'demo:release-helper');
    expect(helper?.querySelector('[data-testid="agent-held"]')?.textContent).toBe(
      'Plugin Demo is disabled',
    );
    expect(helper?.querySelector('[data-testid="agent-enable-row"]')?.textContent?.trim()).toBe(
      'Enable and restart',
    );
    expect(helper?.querySelector('[data-testid="agent-identifier"]')?.textContent).toBe(
      'demo:release-helper',
    );

    await fireEvent.click(
      helper?.querySelector<HTMLElement>('[data-testid="agent-enable-row"]') as HTMLElement,
    );
    expect((await findByRole('dialog')).textContent).toContain('Enable Demo and restart?');
  });
});
