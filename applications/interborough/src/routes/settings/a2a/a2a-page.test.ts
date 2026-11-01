/**
 * `/settings/a2a` (COR-1862): the agents that opt in to A2A, each with the address of its Agent
 * Card as the host serves it, and the push-notification settings, which are read from the Bureau
 * and written through `bureau.settings.update` like the rest of Settings. The Bureau and the
 * host's cards are stubs.
 */
import { waitUntil } from '@lostgradient/testing/wait-until';
import { HttpClient } from '@lostgradient/weft';
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';

import { A2A_COPY, SETTINGS_COPY } from '../../../app/copy.ts';
import RouteOutletHarness from '../../../app/shell/route-outlet.test-harness.svelte';
import { agentCardPath } from '../../../lib/a2a-card.ts';
import type { BureauStub } from '../../../lib/bureau-stub.test-support.ts';
import { installFetchImplementation } from '../../../lib/live-source/fetch.test-support.ts';
import { router } from '../../../lib/router.svelte.ts';
import { AUTHORIZATION_SCOPES } from '../../../lib/scopes.svelte.ts';
import { AGENT, landAt } from '../../chat/pages.test-support.ts';
import { installSettingsBureau, servedSettings } from '../settings-fixtures.test-support.ts';

let stub: BureauStub | undefined;
let restoreCards: (() => void) | undefined;
afterEach(() => {
  cleanup();
  restoreCards?.();
  restoreCards = undefined;
  stub?.restore();
  stub = undefined;
});

const FILE_AGENT = {
  ...AGENT,
  name: 'researcher',
  displayName: 'Researcher',
  kind: 'file',
  a2a: true,
};
const CODE_AGENT = {
  ...AGENT,
  name: 'dispatcher',
  displayName: 'dispatcher',
  kind: 'code',
  a2a: true,
};
const CLOSED_AGENT = {
  ...AGENT,
  name: 'private',
  displayName: 'Private',
  kind: 'file',
  a2a: false,
};

/** A card as the host serves it: the interface address, and the security schemes when a key is set. */
const card = (url: string, secured = false) => ({
  supportedInterfaces: [{ url, protocolBinding: 'JSONRPC' }],
  ...(secured ? { securitySchemes: { apiKey: { type: 'apiKey' } } } : {}),
});

type Open = {
  agents: readonly object[] | 'fail';
  cards?: Record<string, () => Response>;
  values?: Record<string, unknown>;
};

function open({ agents, cards = {}, values }: Open) {
  const served = servedSettings(
    values === undefined ? {} : { values: { ...servedSettings().values, ...values } },
  );
  stub = installSettingsBureau(served, {
    'bureau.agents.list': () => {
      if (agents === 'fail') throw new Error('The Bureau is down.');
      return { agents };
    },
  });
  // The cards are the host's own route, not the Bureau's operation: layer them over the stub.
  const bureauFetch = globalThis.fetch;
  restoreCards = installFetchImplementation(async (input, init) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      'http://localhost',
    );
    const answer = cards[url.pathname];
    if (answer !== undefined) return answer();
    return bureauFetch(input, init);
  });
  landAt('/settings/a2a');
  return {
    served,
    view: render(RouteOutletHarness, {
      props: {
        client: new HttpClient({ baseUrl: 'http://localhost/api' }),
        scopes: AUTHORIZATION_SCOPES,
      },
    } as never),
  };
}

const cardOf = (agent: string, url: string, secured = false) => ({
  [agentCardPath(agent)]: () => Response.json(card(url, secured)),
});

describe('the agents reachable over A2A', () => {
  test('are the agents that opt in, each with the address of its card as the card names it', async () => {
    const { view } = open({
      agents: [FILE_AGENT, CLOSED_AGENT, CODE_AGENT],
      cards: {
        ...cardOf('researcher', 'https://agents.example.com/bureau/a2a/researcher'),
        ...cardOf('dispatcher', 'http://127.0.0.1:7234/bureau/a2a/dispatcher'),
      },
    });

    const list = await view.findByRole('list', { name: A2A_COPY.listLabel });
    await waitFor(() => expect(list.querySelectorAll('[data-testid="a2a-card"]')).toHaveLength(2));
    const rows = [...list.querySelectorAll<HTMLElement>('[data-agent]')];
    // The agent that did not opt in is not listed.
    expect(rows.map((row) => row.dataset['agent'])).toEqual(['researcher', 'dispatcher']);
    expect(rows[0]?.querySelector('[data-testid="a2a-card"] code')?.textContent).toBe(
      'https://agents.example.com/bureau/a2a/researcher/.well-known/agent-card.json',
    );
    expect(rows[1]?.querySelector('[data-testid="a2a-card"] code')?.textContent).toBe(
      'http://127.0.0.1:7234/bureau/a2a/dispatcher/.well-known/agent-card.json',
    );
    // Each address has a button that copies it.
    expect(within(rows[0]!).getByRole('button', { name: A2A_COPY.copyCard })).not.toBeNull();
  });

  test('link a file agent to its editor, where it opts in or out, and a code agent to none', async () => {
    const { view } = open({
      agents: [FILE_AGENT, CODE_AGENT],
      cards: {
        ...cardOf('researcher', 'http://localhost/bureau/a2a/researcher'),
        ...cardOf('dispatcher', 'http://localhost/bureau/a2a/dispatcher'),
      },
    });

    const list = await view.findByRole('list', { name: A2A_COPY.listLabel });
    const [file, code] = [...list.querySelectorAll<HTMLElement>('[data-agent]')];
    const edit = within(file!).getByRole('link', { name: A2A_COPY.editAgent('Researcher') });
    expect(edit.getAttribute('href')).toBe('/agents/researcher/edit');
    expect(code?.textContent).toContain(A2A_COPY.fromCode);
    expect(within(code!).queryByRole('link', { name: /^Edit/ })).toBeNull();
    await fireEvent.click(edit);
    expect(router.pathname).toBe('/agents/researcher/edit');
  });

  test('say when a caller needs the operator’s key', async () => {
    const { view } = open({
      agents: [FILE_AGENT],
      cards: cardOf('researcher', 'https://agents.example.com/bureau/a2a/researcher', true),
    });

    await view.findByRole('list', { name: A2A_COPY.listLabel });

    expect(await view.findByText(A2A_COPY.needsKey)).not.toBeNull();
  });

  test('keep an agent in the list when its card cannot be read, and read it again on request', async () => {
    let healthy = false;
    const { view } = open({
      agents: [FILE_AGENT],
      cards: {
        [agentCardPath('researcher')]: () =>
          healthy
            ? Response.json(card('http://localhost/bureau/a2a/researcher'))
            : new Response('no', { status: 503 }),
      },
    });

    const unavailable = await view.findByTestId('a2a-card-unavailable');
    expect(unavailable.textContent).toContain(A2A_COPY.cardUnavailable);
    healthy = true;
    await fireEvent.click(within(unavailable).getByRole('button', { name: A2A_COPY.cardRetry }));

    const loaded = await view.findByTestId('a2a-card');
    expect(loaded.textContent).toContain('/bureau/a2a/researcher');
  });

  test('are an empty state with a way to the agents when none opts in', async () => {
    const { view } = open({ agents: [CLOSED_AGENT] });

    const empty = await view.findByTestId('a2a-empty');

    expect(empty.textContent).toContain(A2A_COPY.empty.title);
    // The push settings are still there to read and write.
    expect(await view.findByRole('group', { name: SETTINGS_COPY.formLabel })).not.toBeNull();
    const link = within(empty).getByRole('link', { name: A2A_COPY.empty.action.label });
    expect(link.getAttribute('href')).toBe('/agents');
    await fireEvent.click(link);
    expect(router.pathname).toBe('/agents');
  });

  test('say so, with a way to try again, when the agents cannot be listed', async () => {
    const { view } = open({ agents: 'fail' });

    const failed = await view.findByTestId('a2a-agents-failed');

    expect(failed.textContent).toContain(A2A_COPY.loadFailed.title);
    expect(within(failed).getByRole('button', { name: 'Try again' })).not.toBeNull();
  });
});

describe('the push settings', () => {
  const row = (container: HTMLElement, key: string) =>
    container.querySelector<HTMLElement>(`[data-setting="${key}"]`);

  test('are the a2a settings and no others, with the values the Bureau holds', async () => {
    const { view } = open({ agents: [], values: { 'a2a.push.enabled': true } });

    const form = await view.findByRole('group', { name: SETTINGS_COPY.formLabel });

    expect(
      [...form.querySelectorAll<HTMLElement>('[data-setting]')].map(
        (entry) => entry.dataset['setting'],
      ),
    ).toEqual(['a2a.push.enabled', 'a2a.push.sweepIntervalMs']);
    expect(
      row(view.container, 'a2a.push.enabled')
        ?.querySelector('button[role="switch"]')
        ?.getAttribute('aria-checked'),
    ).toBe('true');
  });

  test('are not written until the person confirms, and cancelling keeps the edit', async () => {
    const { view } = open({ agents: [] });
    await view.findByRole('group', { name: SETTINGS_COPY.formLabel });
    const toggle = row(view.container, 'a2a.push.enabled')?.querySelector(
      'button[role="switch"]',
    ) as HTMLElement;

    await fireEvent.click(toggle);
    await fireEvent.click(view.getByRole('button', { name: SETTINGS_COPY.saveAction }));
    const dialog = await view.findByRole('dialog', { name: SETTINGS_COPY.confirmA2a.title });
    await fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    await waitUntil(() => view.queryByRole('dialog') === null);
    expect(stub?.callsTo('bureau.settings.update')).toEqual([]);
    // The edit is still in the form, ready to save.
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    const save = view.getByRole('button', { name: SETTINGS_COPY.saveAction });
    expect((save as HTMLButtonElement).disabled).toBe(false);
  });

  test('are written with one update against the revision read, and the restart they wait for is said', async () => {
    const { view, served } = open({ agents: [] });
    await view.findByRole('group', { name: SETTINGS_COPY.formLabel });

    await fireEvent.click(
      row(view.container, 'a2a.push.enabled')?.querySelector(
        'button[role="switch"]',
      ) as HTMLElement,
    );
    await fireEvent.click(view.getByRole('button', { name: SETTINGS_COPY.saveAction }));
    const dialog = await view.findByRole('dialog', { name: SETTINGS_COPY.confirmA2a.title });
    await fireEvent.click(
      within(dialog).getByRole('button', { name: SETTINGS_COPY.confirmA2a.confirm }),
    );

    await waitUntil(() => (stub?.callsTo('bureau.settings.update').length ?? 0) === 1);
    expect(stub?.callsTo('bureau.settings.update')[0]?.params).toEqual({
      patch: { 'a2a.push.enabled': true },
      expectedRevision: 3,
    });
    expect(served.values['a2a.push.enabled']).toBe(true);
    const summary = await view.findByTestId('settings-restart-summary');
    expect(summary.textContent).toContain('a2a.push.enabled');
  });
});
