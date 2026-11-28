/**
 * The "Or chat with" row of a new chat leaves out the agent the chat is with and an agent a plugin
 * hides from Chat (COR-2233).
 */
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { tick } from 'svelte';

import type { AgentSummary } from '../../lib/bureau-client.ts';
import NewChatChoices from './new-chat-choices.svelte';
import { AGENT } from './pages.test-support.ts';

afterEach(cleanup);

const agents = [
  { ...AGENT, name: 'tool-runner', displayName: 'Tool runner' },
  { ...AGENT, name: 'bookkeeper', displayName: 'Bookkeeper' },
  { ...AGENT, name: 'demo:internal', displayName: 'Internal', visibility: 'hidden' },
] as unknown as AgentSummary[];

describe('a list of agents that continues past the scroll box', () => {
  type Callback = (entries: Partial<IntersectionObserverEntry>[]) => void;
  const observers: { callback: Callback; observed: Element[]; disconnected: boolean }[] = [];
  const original = globalThis.IntersectionObserver;

  beforeEach(() => {
    observers.length = 0;
    globalThis.IntersectionObserver = class {
      readonly record: (typeof observers)[number];
      constructor(callback: Callback) {
        this.record = { callback, observed: [], disconnected: false };
        observers.push(this.record);
      }
      observe(element: Element) {
        this.record.observed.push(element);
      }
      unobserve() {}
      disconnect() {
        this.record.disconnected = true;
      }
      takeRecords() {
        return [];
      }
    } as unknown as typeof IntersectionObserver;
  });

  afterEach(() => {
    globalThis.IntersectionObserver = original;
  });

  const props = {
    agents,
    selected: 'tool-runner',
    blocked: false,
    onChoose: () => {},
    onExample: () => {},
  };

  test('says so with a visible control, and takes the last agent into view when it is pressed', async () => {
    const { getByTestId, queryByRole, getByRole } = render(NewChatChoices, { props } as never);
    const last = getByTestId('other-agents').querySelector('[data-agent]:last-of-type')!;
    const scrolled: Element[] = [];
    last.scrollIntoView = function (this: Element) {
      scrolled.push(this);
    };

    // The last agent is watched, and while it is whole in view nothing is said.
    const live = observers.filter((record) => !record.disconnected);
    expect(live.some((record) => record.observed.includes(last))).toBe(true);
    expect(queryByRole('button', { name: 'More agents' })).toBeNull();

    // Cut off by the end of the scroll box: the list says it continues, and the control is the way.
    for (const record of live) record.callback([{ isIntersecting: true, intersectionRatio: 0.4 }]);
    await tick();
    await fireEvent.click(getByRole('button', { name: 'More agents' }));
    expect(scrolled).toEqual([last]);

    // Whole in view again: the control goes.
    for (const record of live) record.callback([{ isIntersecting: true, intersectionRatio: 1 }]);
    await tick();
    expect(queryByRole('button', { name: 'More agents' })).toBeNull();
  });
});

describe('the other agents a new chat offers', () => {
  test('are not a hidden agent', () => {
    const { getByTestId } = render(NewChatChoices, {
      props: {
        agents,
        selected: 'tool-runner',
        blocked: false,
        onChoose: () => {},
        onExample: () => {},
      },
    } as never);

    const row = getByTestId('other-agents').textContent ?? '';
    expect(row).toContain('Bookkeeper');
    expect(row).not.toContain('Internal');
  });

  test('are every agent Chat offers when none is selected, still without a hidden one', () => {
    const { getByTestId } = render(NewChatChoices, {
      props: {
        agents,
        selected: undefined,
        blocked: false,
        onChoose: () => {},
        onExample: () => {},
      },
    } as never);

    const row = getByTestId('other-agents').textContent ?? '';
    expect(row).toContain('Tool runner');
    expect(row).toContain('Bookkeeper');
    expect(row).not.toContain('Internal');
  });
});
