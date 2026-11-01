/**
 * The first-run checklist (`first-run-checklist.svelte`) against a host that answers as a fresh
 * installation, as one part-way through, and as one that has finished: each step completes from the
 * host's own answer, an undone step links to the page that does it, and a dismissal is kept in this
 * browser and ends it.
 */
import { waitUntil } from '@lostgradient/testing/wait-until';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { router } from '../lib/router.svelte.ts';
import { AGENT, bureau, CONTEXT, landAt } from '../routes/chat/pages.test-support.ts';
import QueryPage from '../routes/chat/query-page.test-harness.svelte';
import { FIRST_RUN_COPY } from './copy.ts';
import Checklist from './first-run-checklist.svelte';
import { FIRST_RUN_DISMISSED_KEY } from './first-run.ts';

let restore: (() => void) | undefined;

beforeEach(() => {
  window.localStorage.removeItem(FIRST_RUN_DISMISSED_KEY);
  landAt('/chats');
});

afterEach(() => {
  cleanup();
  restore?.();
  restore = undefined;
  window.localStorage.removeItem(FIRST_RUN_DISMISSED_KEY);
});

const PROVIDERS = (hasKey: boolean) => ({
  providers: [{ name: 'anthropic', configured: hasKey, hasKey }],
  catalog: [],
  models: [],
});
const FILE_AGENT = { ...AGENT, name: 'researcher', displayName: 'Researcher', kind: 'file' };

/** A host with the given signals, answering the three reads the checklist makes. */
function host(signals: { key: boolean; agents: readonly object[]; chats: number }) {
  const urls: string[] = [];
  const served = bureau(
    {
      'bureau.agents.list': () => ({ agents: signals.agents }),
      'bureau.contexts.list': () => ({
        contexts: Array.from({ length: signals.chats }, () => CONTEXT),
        nextOffset: null,
      }),
    },
    (url) => {
      urls.push(url);
      return url === '/host/providers' ? Response.json(PROVIDERS(signals.key)) : undefined;
    },
  );
  restore = served.restore;
  /** Resolves once the host has been asked all three questions. */
  const asked = () => waitUntil(() => urls.includes('/host/providers') && served.calls.length >= 2);
  return { asked };
}

const mount = () => render(QueryPage, { props: { page: Checklist } } as never);

describe('a fresh installation', () => {
  test('shows the three steps, none done, each with the page that does it', async () => {
    host({ key: false, agents: [{ ...AGENT }], chats: 0 });
    const { findByTestId, container } = mount();

    const checklist = await findByTestId('first-run');
    const steps = [...container.querySelectorAll('[data-step]')] as HTMLElement[];
    expect(steps.map((step) => step.dataset['step'])).toEqual(['provider', 'agent', 'chat']);
    expect(steps.map((step) => step.dataset['done'])).toEqual(['false', 'false', 'false']);
    expect(steps.map((step) => step.querySelector('a')?.getAttribute('href'))).toEqual([
      '/settings/models',
      '/agents/new',
      '/chats/new',
    ]);
    expect(checklist.textContent).toContain(FIRST_RUN_COPY.steps.provider.title);
    expect(checklist.textContent).toContain(FIRST_RUN_COPY.steps.agent.title);
    expect(checklist.textContent).toContain(FIRST_RUN_COPY.steps.chat.title);
    // The code agent the host ships does not make the agent step done.
    expect((container.querySelector('[data-step="agent"]') as HTMLElement).dataset['done']).toBe(
      'false',
    );
  });

  test('sends a person to the page for a step when its action is pressed', async () => {
    host({ key: false, agents: [], chats: 0 });
    const { findByRole } = mount();

    await fireEvent.click(
      await findByRole('link', { name: FIRST_RUN_COPY.steps.provider.action.label }),
    );

    expect(router.pathname).toBe('/settings/models');
  });
});

describe('each step', () => {
  test('completes from its own signal and offers nothing more to do', async () => {
    host({ key: true, agents: [FILE_AGENT], chats: 0 });
    const { findByTestId, container } = mount();

    await findByTestId('first-run');
    const done = (step: string) =>
      (container.querySelector(`[data-step="${step}"]`) as HTMLElement).dataset['done'];
    expect([done('provider'), done('agent'), done('chat')]).toEqual(['true', 'true', 'false']);
    // A finished step has no action, and says so to a screen reader.
    expect(container.querySelector('[data-step="provider"] a')).toBeNull();
    expect(container.querySelector('[data-step="provider"]')?.textContent).toContain(
      FIRST_RUN_COPY.completed,
    );
    expect(container.querySelector('[data-step="chat"] a')?.getAttribute('href')).toBe(
      '/chats/new',
    );
  });

  test('the key a provider holds is never shown, only that it holds one', async () => {
    host({ key: true, agents: [], chats: 0 });
    const { findByTestId } = mount();

    const checklist = await findByTestId('first-run');

    expect(checklist.textContent).not.toContain('anthropic');
  });
});

describe('a finished installation', () => {
  test('shows nothing once all three steps are done', async () => {
    const { asked } = host({ key: true, agents: [FILE_AGENT], chats: 1 });
    const { queryByTestId } = mount();

    await asked();
    // load-proof: all three answers are in once asked() resolves; one turn lets the page take them in, and load can only delay the absence being asserted
    await new Promise((resolve) => setImmediate(resolve));
    expect(queryByTestId('first-run')).toBeNull();
  });

  test('shows nothing while the host cannot say whether a step is done', async () => {
    const urls: string[] = [];
    const served = bureau(
      {
        'bureau.agents.list': () => ({ agents: [] }),
        'bureau.contexts.list': () => ({ contexts: [], nextOffset: null }),
      },
      (url) => {
        urls.push(url);
        return url === '/host/providers' ? new Response('no', { status: 500 }) : undefined;
      },
    );
    restore = served.restore;
    const { queryByTestId } = mount();

    await waitUntil(() => urls.includes('/host/providers') && served.calls.length >= 2);
    // load-proof: every read has been answered once the wait ends; one turn lets the page take the failure in, and load can only delay the absence being asserted
    await new Promise((resolve) => setImmediate(resolve));
    expect(queryByTestId('first-run')).toBeNull();
  });
});

describe('dismissing', () => {
  test('keeps the choice in this browser and ends the checklist', async () => {
    host({ key: false, agents: [], chats: 0 });
    const { findByRole, queryByTestId } = mount();

    await fireEvent.click(await findByRole('button', { name: FIRST_RUN_COPY.dismissLabel }));

    expect(queryByTestId('first-run')).toBeNull();
    expect(window.localStorage.getItem(FIRST_RUN_DISMISSED_KEY)).toBe('true');
  });

  test('a dismissed checklist stays away on the next visit and asks the host nothing', async () => {
    window.localStorage.setItem(FIRST_RUN_DISMISSED_KEY, 'true');
    const served = bureau({}, (url) =>
      url === '/host/providers' ? Response.json(PROVIDERS(false)) : undefined,
    );
    restore = served.restore;
    const { queryByTestId } = mount();

    // load-proof: a dismissed checklist enables no query, so nothing is in flight to wait for
    await new Promise((resolve) => setImmediate(resolve));
    expect(queryByTestId('first-run')).toBeNull();
    expect(served.calls).toEqual([]);
  });
});
