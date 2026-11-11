/**
 * The Agents list in the states that are not a list of rows (board PageAgents, "Loading", "Loading ·
 * slow", "First use · no agents", "Only unavailable agents" and "Filtered to nothing"): a read in
 * progress, a read the person gave up on, and a read that failed with nothing to show. The page
 * keeps its heading, its subtitle and its secondary "+" in every one of them, because creating an
 * agent does not need the list. The timings the placeholders keep run under fake timers, never a
 * sleep.
 */
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/svelte';
import { afterEach, describe, expect, jest, test } from 'bun:test';
import { flushSync } from 'svelte';

import { AGENTS_COPY, VIEW_COPY } from '../../app/copy.ts';
import { StubFault } from '../../lib/bureau-stub.test-support.ts';
import { installFetchImplementation } from '../../lib/live-source/fetch.test-support.ts';
import { AGENT, bureau, landAt } from '../chat/pages.test-support.ts';
import QueryPage from '../chat/query-page.test-harness.svelte';
import AgentList from './agent-list.svelte';

let restore: (() => void) | undefined;
afterEach(() => {
  jest.useRealTimers();
  cleanup();
  restore?.();
  restore = undefined;
});

const mount = () => render(QueryPage, { props: { page: AgentList } } as never);

function advance(milliseconds: number): void {
  jest.advanceTimersByTime(milliseconds);
  flushSync();
}

/** The header the page keeps in every state: the heading, the subtitle and the secondary "+". */
function expectHeader(container: HTMLElement): void {
  const view = within(container);
  expect(view.getByRole('heading', { level: 1, name: 'Agents' })).not.toBeNull();
  expect(container.textContent).toContain(AGENTS_COPY.subtitle);
  const create = container.querySelector('a[aria-label="New agent"]');
  expect(create).not.toBeNull();
  expect(create?.getAttribute('aria-disabled')).toBeNull();
}

describe('the Agents list while it loads', () => {
  function openHanging() {
    restore = installFetchImplementation(() => new Promise<Response>(() => {}));
    landAt('/agents');
    const rendered = mount();
    flushSync();
    return rendered;
  }

  test('draws the header at once and nothing for the read until 300 ms, then four placeholder rows', () => {
    jest.useFakeTimers();
    const { container } = openHanging();

    expectHeader(container);
    expect(container.querySelector('.cinder-skeleton-row')).toBeNull();

    advance(299);
    expect(container.querySelector('.cinder-skeleton-row')).toBeNull();

    advance(1);
    expect(container.querySelectorAll('.cinder-skeleton-row')).toHaveLength(4);
    expectHeader(container);
    // No segments, no cards and no empty state are drawn before the agents are known.
    expect(container.querySelector('[data-testid="agents-available"]')).toBeNull();
    expect(container.querySelector('[data-cinder-kind]')).toBeNull();
  });

  test('says it is taking longer than usual at 10 s, and not before', () => {
    jest.useFakeTimers();
    const { container } = openHanging();

    advance(9_999);
    expect(container.textContent).not.toContain(AGENTS_COPY.stillLoading);
    advance(1);
    expect(container.textContent).toContain(AGENTS_COPY.stillLoading);
  });

  test('stops the read on Cancel and shows the failed state with Try again, the header still live', async () => {
    jest.useFakeTimers();
    const { container } = openHanging();
    advance(10_000);

    await fireEvent.click(within(container).getByRole('button', { name: 'Cancel' }));
    flushSync();

    expectHeader(container);
    expect(
      within(container).getByRole('heading', { level: 2, name: VIEW_COPY.agents.error.title }),
    ).not.toBeNull();
    expect(container.textContent).toContain(VIEW_COPY.agents.error.description);
    expect(within(container).getByRole('button', { name: 'Try again' })).not.toBeNull();
    expect(container.querySelector('.cinder-skeleton-row')).toBeNull();
  });
});

describe('the Agents list when the read fails with nothing to show', () => {
  test('is the failed state with Try again, which reads the list again', async () => {
    let failing = true;
    restore = bureau({
      'bureau.agents.list': () => {
        if (failing) throw new StubFault('Unavailable', 503, 'The Bureau is down.');
        return { agents: [AGENT] };
      },
      'bureau.contexts.list': () => ({ contexts: [], nextOffset: null }),
    }).restore;
    landAt('/agents');
    const { container, findByRole } = mount();

    await findByRole('heading', { level: 2, name: VIEW_COPY.agents.error.title });
    expectHeader(container);

    failing = false;
    await fireEvent.click(await findByRole('button', { name: 'Try again' }));
    await findByRole('link', { name: /^Assistant/ });
    expect(container.querySelector('[data-agent="assistant"]')).not.toBeNull();
  });
});

describe('the Agents list, in the states of its board', () => {
  test('has no filter row when no agent exists, and New agent is the one primary button', async () => {
    restore = bureau({
      'bureau.agents.list': () => ({ agents: [] }),
      'bureau.contexts.list': () => ({ contexts: [], nextOffset: null }),
    }).restore;
    landAt('/agents');
    const { container, findByRole, queryByRole } = mount();

    await findByRole('heading', { level: 2, name: AGENTS_COPY.empty.title });
    expectHeader(container);
    expect(queryByRole('radio', { name: /^All/ })).toBeNull();
    const state = container.querySelector('[data-cinder-kind="first-use"]');
    expect(state?.querySelectorAll('a[href="/agents/new"]')).toHaveLength(1);
    await waitFor(() => expect(state?.textContent).toContain(AGENTS_COPY.empty.addPlugin));
  });
});
