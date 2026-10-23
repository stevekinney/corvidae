/**
 * The Memory page (`/agents/:id/memory`) against a stand-in for the Bureau's memory operations:
 * the list and the search, one memory's lineage, what forgetting answers in each of the deletion's
 * states, and what correcting answers, including the Bureau's two refusals. The Agents view's
 * frame owns the page's loading, empty, failing, locked and not-found states
 * (`app/view-frame.test.ts`). The real Bureau is exercised in the Playwright suite.
 */
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';

import { MEMORY_COPY, RETRY_LABEL } from '../../app/copy.ts';
import {
  installBureauStub,
  StubFault,
  type BureauHandler,
  type BureauStub,
} from '../../lib/bureau-stub.test-support.ts';
import { router } from '../../lib/router.svelte.ts';
import { AGENT, landAt } from '../chat/pages.test-support.ts';
import QueryPage from '../chat/query-page.test-harness.svelte';
import AgentDetail from './agent-detail.svelte';
import FramedMemory from './agent-memory-frame.test-harness.svelte';
import AgentMemory from './agent-memory.svelte';

let stub: BureauStub | undefined;
afterEach(() => {
  cleanup();
  stub?.restore();
  stub = undefined;
});

const mount = (page: unknown) => render(QueryPage, { props: { page } } as never);

const AISLE = {
  id: 'memory-aisle',
  content: 'The user prefers aisle seats.',
  memoryClass: 'episodic',
  source: 'conversation',
  trust: 'untrusted',
  createdAt: '2026-10-19T08:00:00.000Z',
  sessionId: 'session-1',
};
const WINDOW = {
  ...AISLE,
  id: 'memory-window',
  content: 'The user prefers window seats.',
  source: 'operator',
  trust: 'verified',
  sessionId: null,
};
/** The time a row's actions are named with. */
const whenOf = (memory: { readonly createdAt: string }): string =>
  new Date(memory.createdAt).toLocaleString();
const NO_LINEAGE = { runId: null, corrects: null, correctedBy: null };

const RECEIPT = {
  deletionId: 'deletion-1',
  awaitingHoldRelease: false,
  open: true,
  targets: [
    { target: 'source-evidence', lane: 'synchronous', status: 'completed' },
    { target: 'durable-snapshots', lane: 'bounded-async', status: 'pending' },
  ],
};

type Answers = Record<string, BureauHandler>;

/** An element's text with its whitespace collapsed, as a reader sees it. */
const textOf = (element: Element | null | undefined): string =>
  (element?.textContent ?? '').replace(/\s+/g, ' ').trim();

/** The Bureau for one test: an agent with memories, and whatever a test overrides. */
function bureau(answers: Answers = {}): BureauStub {
  stub = installBureauStub({
    'bureau.agents.list': () => ({ agents: [AGENT] }),
    'bureau.memory.list': () => ({ memories: [AISLE, WINDOW], nextOffset: null }),
    'bureau.memory.search': () => ({ hits: [] }),
    'bureau.memory.get': (params) => ({
      memory: params['id'] === WINDOW.id ? WINDOW : AISLE,
      lineage: NO_LINEAGE,
    }),
    ...answers,
  });
  return stub;
}

function open(path = '/agents/assistant/memory') {
  landAt(path);
  return mount(AgentMemory);
}

/** Opens the details of the memory whose text is `content`, by clicking its row. */
async function openDetails(view: ReturnType<typeof open>, content: string) {
  const text = await view.findByText(content);
  const opener = text.closest('button');
  if (opener === null) throw new Error(`No row holds "${content}".`);
  await fireEvent.click(opener);
  return view.findByRole('region', { name: MEMORY_COPY.detail.heading });
}

describe('the list and the search', () => {
  test('lists what the agent remembers, newest first, with the memory’s class and time', async () => {
    const served = bureau();
    const { findByText, container } = open();

    await findByText(AISLE.content);
    await findByText(WINDOW.content);
    expect(served.callsTo('bureau.memory.list')[0]?.params).toEqual({
      agentId: 'assistant',
      limit: 20,
      offset: 0,
    });
    const rows = container.querySelectorAll('[data-memory]');
    expect([...rows].map((row) => row.getAttribute('data-memory'))).toEqual([
      'memory-aisle',
      'memory-window',
    ]);
    expect(rows[0]?.textContent).toContain(MEMORY_COPY.kind.episodic.label);
    expect(rows[0]?.querySelector('time')?.getAttribute('datetime')).toBe(AISLE.createdAt);
    expect(rows[0]?.querySelector('time')?.getAttribute('title')).toBe(
      new Date(AISLE.createdAt).toLocaleString(),
    );
  });

  test('says how many memories the agent has, and that there are more when a page is left', async () => {
    bureau({ 'bureau.memory.list': () => ({ memories: [AISLE, WINDOW], nextOffset: 2 }) });
    const { findByTestId } = open();

    expect(textOf(await findByTestId('memory-count'))).toBe(MEMORY_COPY.count(2, true));
    expect(MEMORY_COPY.count(1, false)).toBe('1 memory');
    expect(MEMORY_COPY.count(2, false)).toBe('2 memories');
  });

  test('has no Details button: a row opens its memory, and shows Forget and Correct', async () => {
    const served = bureau();
    const view = open();
    const text = await view.findByText(AISLE.content);

    expect(view.queryByRole('button', { name: /^Details/ })).toBeNull();
    const row = text.closest('li') as HTMLElement;
    expect(
      within(row).getByRole('button', {
        name: MEMORY_COPY.rowAction.forget(AISLE.content, whenOf(AISLE)),
      }),
    ).not.toBeNull();
    expect(
      within(row).getByRole('button', {
        name: MEMORY_COPY.rowAction.correct(AISLE.content, whenOf(AISLE)),
      }),
    ).not.toBeNull();
    expect(served.callsTo('bureau.memory.get')).toEqual([]);

    await fireEvent.click(text.closest('button') as HTMLElement);

    expect(await view.findByRole('region', { name: MEMORY_COPY.detail.heading })).not.toBeNull();
    expect(served.callsTo('bureau.memory.get')[0]?.params['id']).toBe(AISLE.id);
    expect(row.getAttribute('data-selected')).toBe('true');
  });

  test('describes the kind chip in plain words, and calls a person’s own memory an operator one', async () => {
    bureau();
    const view = open();
    await view.findByText(AISLE.content);

    const row = view.container.querySelector('[data-memory="memory-aisle"]') as HTMLElement;
    // The kind is part of the opener, so a screen reader hears it with the text, and the opener
    // is what a keyboard user focuses to see the tooltip.
    const opener = row.querySelector('.cinder-selectable-row__primary') as HTMLElement;
    expect(opener.textContent).toContain(MEMORY_COPY.kind.episodic.label);
    expect(
      row.querySelector('.cinder-selectable-row__trailing-actions')?.textContent,
    ).not.toContain(MEMORY_COPY.kind.episodic.label);
    const describedBy = opener.getAttribute('aria-describedby');
    expect(describedBy).not.toBeNull();
    expect(document.getElementById(describedBy as string)?.textContent).toBe(
      MEMORY_COPY.kind.episodic.description,
    );
    expect(
      within(
        view.container.querySelector('[data-memory="memory-window"]') as HTMLElement,
      ).getByText(MEMORY_COPY.kind.operator.label),
    ).not.toBeNull();
  });

  test('searches by the typed text, ranks every hit with its relevance, and lists again when cleared', async () => {
    const served = bureau({
      'bureau.memory.search': () => ({ hits: [{ memory: WINDOW, score: 0.8 }] }),
    });
    const { container, findByText, getByRole, getByLabelText, getByTestId, queryByText } = open();
    await findByText(AISLE.content);

    await fireEvent.input(getByLabelText(MEMORY_COPY.searchLabel), {
      target: { value: ' window ' },
    });
    await fireEvent.click(getByRole('button', { name: MEMORY_COPY.searchAction }));

    await findByText(`${MEMORY_COPY.relevance}: 0.80`);
    expect(queryByText(AISLE.content)).toBeNull();
    // The count says what the Bureau ranked, and the word searched for is marked in the text.
    expect(textOf(getByTestId('memory-match-count'))).toBe(MEMORY_COPY.matchCount(1, 2, false));
    expect(container.querySelector('mark')?.textContent).toBe('window');
    expect(served.callsTo('bureau.memory.search')[0]?.params).toEqual({
      agentId: 'assistant',
      query: 'window',
      limit: 100,
    });

    await fireEvent.click(getByRole('button', { name: /clear/i }));
    await findByText(AISLE.content);
    expect(queryByText(new RegExp(MEMORY_COPY.relevance))).toBeNull();
  });

  test('counts the memories that hold a word of the query, whatever the Bureau scored them', async () => {
    // The Bureau ranks every memory and has no floor. Here the memory that holds "window" is
    // scored below zero, and one that holds nothing of the query is scored above it.
    bureau({
      'bureau.memory.search': () => ({
        hits: [
          { memory: AISLE, score: 0.21 },
          { memory: WINDOW, score: -0.09 },
        ],
      }),
    });
    const { findByText, getByRole, getByLabelText, getByTestId, queryByText } = open();
    await findByText(AISLE.content);

    await fireEvent.input(getByLabelText(MEMORY_COPY.searchLabel), { target: { value: 'window' } });
    await fireEvent.click(getByRole('button', { name: MEMORY_COPY.searchAction }));

    await findByText(`${MEMORY_COPY.relevance}: -0.09`);
    expect(queryByText(AISLE.content)).toBeNull();
    expect(textOf(getByTestId('memory-match-count'))).toBe('1 of 2 memories match');
  });

  test('says no memory matches a query that holds no word of any memory, though the Bureau scored one above zero', async () => {
    const dark = { ...AISLE, id: 'memory-dark', content: 'The user prefers dark mode' };
    const fridays = { ...AISLE, id: 'memory-fridays', content: 'Deploys go out on Fridays' };
    const orca = { ...AISLE, id: 'memory-orca', content: 'The staging database is called orca' };
    bureau({
      'bureau.memory.list': () => ({ memories: [dark, fridays, orca], nextOffset: null }),
      'bureau.memory.search': () => ({
        hits: [
          { memory: orca, score: 0.2111 },
          { memory: dark, score: 0.0412 },
          { memory: fridays, score: -0.0153 },
        ],
      }),
    });
    const { findByText, getByRole, getByLabelText, getByTestId, queryByTestId } = open();
    await findByText(dark.content);

    await fireEvent.input(getByLabelText(MEMORY_COPY.searchLabel), { target: { value: 'india' } });
    await fireEvent.click(getByRole('button', { name: MEMORY_COPY.searchAction }));

    await waitFor(() =>
      expect(textOf(getByTestId('memory-match-count'))).toBe(MEMORY_COPY.noMatch('india')),
    );
    expect(queryByTestId('memory-nothing-left')).toBeNull();
    expect(getByRole('button', { name: MEMORY_COPY.clearMatch })).not.toBeNull();
  });

  test('keeps a memory that holds a word of the query though the Bureau scored it below zero, in the Bureau’s order', async () => {
    const support = {
      ...AISLE,
      id: 'memory-support',
      content: 'echo is support priority database on mode',
    };
    const ticket = {
      ...AISLE,
      id: 'memory-ticket',
      content: 'echo ticket prefers orca fridays notes called priority notes',
    };
    const release = { ...AISLE, id: 'memory-release', content: 'echo database called release' };
    bureau({
      'bureau.memory.list': () => ({ memories: [support, ticket, release], nextOffset: null }),
      'bureau.memory.search': () => ({
        hits: [
          { memory: release, score: 0.3011 },
          { memory: ticket, score: 0.1274 },
          { memory: support, score: -0.0871 },
        ],
      }),
    });
    const { container, findByText, getByRole, getByLabelText, getByTestId } = open();
    await findByText(support.content);

    await fireEvent.input(getByLabelText(MEMORY_COPY.searchLabel), {
      target: { value: 'echo build' },
    });
    await fireEvent.click(getByRole('button', { name: MEMORY_COPY.searchAction }));

    await waitFor(() =>
      expect(textOf(getByTestId('memory-match-count'))).toBe(MEMORY_COPY.matchCount(3, 3, false)),
    );
    expect(
      [...container.querySelectorAll('[data-memory]')].map((row) =>
        row.getAttribute('data-memory'),
      ),
    ).toEqual(['memory-release', 'memory-ticket', 'memory-support']);
    expect(container.querySelectorAll('mark')).toHaveLength(3);
  });

  test('says how many match without a total while the agent’s list has pages left, and that more may', async () => {
    bureau({
      'bureau.memory.list': () => ({ memories: [AISLE, WINDOW], nextOffset: 2 }),
      'bureau.memory.search': () => ({
        hits: Array.from({ length: 100 }, (_, index) => ({
          memory: { ...AISLE, id: `memory-${index}`, content: `Match ${index}` },
          score: 0.5 - index / 1000,
        })),
      }),
    });
    const { findByText, getByRole, getByLabelText, getByTestId } = open();
    await findByText(AISLE.content);

    await fireEvent.input(getByLabelText(MEMORY_COPY.searchLabel), { target: { value: 'match' } });
    await fireEvent.click(getByRole('button', { name: MEMORY_COPY.searchAction }));

    await waitFor(() =>
      expect(textOf(getByTestId('memory-match-count'))).toBe('100+ memories match'),
    );
  });

  test('says no memory matches when no memory holds a word of the query, and lists everything again from its action', async () => {
    bureau({
      'bureau.memory.search': () => ({
        hits: [
          { memory: AISLE, score: 0.04 },
          { memory: WINDOW, score: -0.02 },
        ],
      }),
    });
    const { findByText, getByRole, getByLabelText, getByTestId, queryByTestId } = open();
    await findByText(AISLE.content);

    await fireEvent.input(getByLabelText(MEMORY_COPY.searchLabel), { target: { value: 'zebra' } });
    await fireEvent.click(getByRole('button', { name: MEMORY_COPY.searchAction }));

    await waitFor(() =>
      expect(textOf(getByTestId('memory-match-count'))).toBe(MEMORY_COPY.noMatch('zebra')),
    );
    await fireEvent.click(getByRole('button', { name: MEMORY_COPY.clearMatch }));

    expect(await findByText(AISLE.content)).not.toBeNull();
    expect(queryByTestId('memory-match-count')).toBeNull();
  });

  test('lists on a blank search rather than asking the Bureau to search for nothing', async () => {
    const served = bureau();
    const { findByText, getByRole, getByLabelText } = open();
    await findByText(AISLE.content);

    await fireEvent.input(getByLabelText(MEMORY_COPY.searchLabel), { target: { value: '   ' } });
    await fireEvent.click(getByRole('button', { name: MEMORY_COPY.searchAction }));

    expect(served.callsTo('bureau.memory.search')).toEqual([]);
    expect(await findByText(AISLE.content)).not.toBeNull();
  });

  test('loads the next page of a long list', async () => {
    const served = bureau({
      'bureau.memory.list': (params) =>
        params['offset'] === 0
          ? { memories: [AISLE], nextOffset: 1 }
          : { memories: [WINDOW], nextOffset: null },
    });
    const { findByText, getByRole, queryByRole } = open();
    await findByText(AISLE.content);

    await fireEvent.click(getByRole('button', { name: MEMORY_COPY.loadMore }));

    await findByText(WINDOW.content);
    expect(served.callsTo('bureau.memory.list').map((call) => call.params['offset'])).toEqual([
      0, 1,
    ]);
    expect(queryByRole('button', { name: MEMORY_COPY.loadMore })).toBeNull();
  });

  test('does not repeat a memory the next page gives again, and stays', async () => {
    // A memory was recorded after the first page was read, so offset 1 starts with its last row.
    bureau({
      'bureau.memory.list': (params) =>
        params['offset'] === 0
          ? { memories: [AISLE], nextOffset: 1 }
          : { memories: [AISLE, WINDOW], nextOffset: null },
    });
    const { container, findByText, getByRole } = open();
    await findByText(AISLE.content);

    await fireEvent.click(getByRole('button', { name: MEMORY_COPY.loadMore }));

    await findByText(WINDOW.content);
    expect(container.textContent).not.toContain('Something went wrong');
    expect(
      [...container.querySelectorAll('[data-memory]')].map((row) =>
        row.getAttribute('data-memory'),
      ),
    ).toEqual(['memory-aisle', 'memory-window']);
  });

  test('says the list could not be loaded, and tries again on request', async () => {
    let failing = true;
    bureau({
      'bureau.memory.list': () => {
        if (failing) throw new StubFault('EngineFailure', 500, 'The Bureau broke.');
        return { memories: [AISLE], nextOffset: null };
      },
    });
    const { findByText, getByRole } = open();

    await findByText(MEMORY_COPY.listFailed);
    failing = false;
    await fireEvent.click(getByRole('button', { name: RETRY_LABEL }));

    expect(await findByText(AISLE.content)).not.toBeNull();
  });
});

describe('leaving the page', () => {
  test('goes back to the agent’s page, and leaves a modified click to the browser', async () => {
    bureau();
    const { findByRole } = open();

    const back = await findByRole('link', { name: MEMORY_COPY.backToAgent('assistant') });
    back.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, metaKey: true }));
    expect(router.pathname).toBe('/agents/assistant/memory');
    back.click();

    expect(router.pathname).toBe('/agents/assistant');
  });
});

describe('one memory’s lineage', () => {
  test('shows its source, trust, class, creation time and chat from the memory, and its run, correction and corrector from the ledger', async () => {
    bureau({
      'bureau.memory.get': () => ({
        memory: AISLE,
        lineage: { runId: 'run-7', corrects: 'memory-old', correctedBy: 'memory-new' },
      }),
    });
    const view = open();

    const detail = await openDetails(view, AISLE.content);

    const field = (name: string) => {
      const term = within(detail).getByText(name, { selector: 'dt' });
      return term.nextElementSibling?.textContent?.trim();
    };
    expect(field(MEMORY_COPY.detail.fields.source)).toBe(MEMORY_COPY.source.conversation);
    expect(field(MEMORY_COPY.detail.fields.trust)).toBe(MEMORY_COPY.trust.untrusted);
    expect(field(MEMORY_COPY.detail.fields.memoryClass)).toBe(MEMORY_COPY.memoryClass.episodic);
    expect(field(MEMORY_COPY.detail.fields.created)).toBe(
      new Date(AISLE.createdAt).toLocaleString(),
    );
    expect(field(MEMORY_COPY.detail.fields.session)).toBe(MEMORY_COPY.detail.openChat);
    expect(
      within(detail).getByRole('link', { name: MEMORY_COPY.detail.openChat }).getAttribute('href'),
    ).toBe('/chat/session-1');
    expect(field(MEMORY_COPY.detail.fields.run)).toBe('run-7');
    expect(field(MEMORY_COPY.detail.fields.corrects)).toBe(MEMORY_COPY.detail.openMemory);
    expect(field(MEMORY_COPY.detail.fields.correctedBy)).toBe(MEMORY_COPY.detail.openMemory);
    expect(field(MEMORY_COPY.detail.fields.legalHold)).toBe(MEMORY_COPY.detail.legalHold.unknown);
    expect(within(detail).getByText(AISLE.content, { selector: 'blockquote' })).not.toBeNull();
  });

  test('says a field was not recorded when the Bureau has nothing for it', async () => {
    bureau({ 'bureau.memory.get': () => ({ memory: WINDOW, lineage: NO_LINEAGE }) });
    const view = open();

    const detail = await openDetails(view, WINDOW.content);

    for (const name of [
      MEMORY_COPY.detail.fields.session,
      MEMORY_COPY.detail.fields.run,
      MEMORY_COPY.detail.fields.corrects,
      MEMORY_COPY.detail.fields.correctedBy,
    ]) {
      expect(textOf(within(detail).getByText(name, { selector: 'dt' }).nextElementSibling)).toBe(
        MEMORY_COPY.detail.notRecorded,
      );
    }
    expect(
      textOf(
        within(detail).getByText(MEMORY_COPY.detail.fields.source, { selector: 'dt' })
          .nextElementSibling,
      ),
    ).toBe(MEMORY_COPY.source.operator);
  });

  test('opens the memory a correction replaced from its “corrects” link', async () => {
    const served = bureau({
      'bureau.memory.get': (params) =>
        params['id'] === 'memory-aisle'
          ? { memory: AISLE, lineage: NO_LINEAGE }
          : {
              memory: WINDOW,
              lineage: { runId: null, corrects: 'memory-aisle', correctedBy: null },
            },
    });
    const view = open();
    const detail = await openDetails(view, WINDOW.content);

    await fireEvent.click(
      within(
        within(detail).getByText(MEMORY_COPY.detail.fields.corrects, { selector: 'dt' })
          .nextElementSibling as HTMLElement,
      ).getByRole('button', { name: MEMORY_COPY.detail.openMemory }),
    );

    await waitFor(() => {
      expect(served.callsTo('bureau.memory.get').map((call) => call.params['id'])).toEqual([
        'memory-window',
        'memory-aisle',
      ]);
    });
    expect(
      await within(
        await view.findByRole('region', { name: MEMORY_COPY.detail.heading }),
      ).findByText(AISLE.content, { selector: 'blockquote' }),
    ).not.toBeNull();
  });

  test('shows a loading state while a memory is read', async () => {
    bureau({ 'bureau.memory.get': () => new Promise(() => {}) });
    const view = open();
    await view.findByText(AISLE.content);

    await openDetails(view, AISLE.content);

    const loading = await view.findByRole('status', { name: MEMORY_COPY.detail.loading });
    expect(loading.getAttribute('aria-busy')).toBe('true');
  });

  test('opens the memory that corrected this one from its “corrected by” link', async () => {
    const served = bureau({
      'bureau.memory.get': (params) =>
        params['id'] === 'memory-aisle'
          ? {
              memory: AISLE,
              lineage: { runId: null, corrects: null, correctedBy: 'memory-window' },
            }
          : {
              memory: WINDOW,
              lineage: { runId: null, corrects: 'memory-aisle', correctedBy: null },
            },
    });
    const view = open();
    const detail = await openDetails(view, AISLE.content);

    await fireEvent.click(
      within(
        within(detail).getByText(MEMORY_COPY.detail.fields.correctedBy, { selector: 'dt' })
          .nextElementSibling as HTMLElement,
      ).getByRole('button', { name: MEMORY_COPY.detail.openMemory }),
    );

    await waitFor(() => {
      expect(served.callsTo('bureau.memory.get').map((call) => call.params['id'])).toEqual([
        'memory-aisle',
        'memory-window',
      ]);
    });
    const opened = await view.findByRole('region', { name: MEMORY_COPY.detail.heading });
    expect(
      await within(opened).findByText(WINDOW.content, { selector: 'blockquote' }),
    ).not.toBeNull();
  });

  test('follows the chat link inside the app, and leaves a modified click to the browser', async () => {
    bureau();
    const view = open();
    const detail = await openDetails(view, AISLE.content);
    const link = within(detail).getByRole('link', { name: MEMORY_COPY.detail.openChat });

    link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, metaKey: true }));
    expect(router.pathname).toBe('/agents/assistant/memory');
    link.click();

    expect(router.pathname).toBe('/chat/session-1');
  });

  test('tries a memory that could not be loaded again on request', async () => {
    let failing = true;
    const served = bureau({
      'bureau.memory.get': () => {
        if (failing) throw new StubFault('EngineFailure', 500, 'The Bureau broke.');
        return { memory: AISLE, lineage: NO_LINEAGE };
      },
    });
    const view = open();
    await view.findByText(AISLE.content);
    await openDetails(view, AISLE.content);
    const failed = await view.findByText(MEMORY_COPY.detail.failed);
    const region = failed.closest('section') as HTMLElement;
    failing = false;

    await fireEvent.click(within(region).getByRole('button', { name: RETRY_LABEL }));

    expect(
      await within(region).findByText(AISLE.content, { selector: 'blockquote' }),
    ).not.toBeNull();
    expect(served.callsTo('bureau.memory.get')).toHaveLength(2);
  });

  test('says a memory was not found when it is gone, and when it cannot be loaded', async () => {
    bureau({
      'bureau.memory.get': () => {
        throw new StubFault('NotFound', 404, 'No memory.', { resource: 'memory' });
      },
    });
    const view = open();
    await view.findByText(AISLE.content);
    await openDetails(view, AISLE.content);
    expect(await view.findByText(MEMORY_COPY.detail.notFound.title)).not.toBeNull();
    cleanup();
    stub?.restore();

    bureau({
      'bureau.memory.get': () => {
        throw new StubFault('EngineFailure', 500, 'The Bureau broke.');
      },
    });
    const failing = open();
    await failing.findByText(AISLE.content);
    await openDetails(failing, AISLE.content);
    expect(await failing.findByText(MEMORY_COPY.detail.failed)).not.toBeNull();
  });

  test('closes the details', async () => {
    bureau();
    const view = open();
    await openDetails(view, AISLE.content);

    await fireEvent.click(view.getByRole('button', { name: MEMORY_COPY.detail.close }));

    expect(view.queryByRole('region', { name: MEMORY_COPY.detail.heading })).toBeNull();
  });
});

describe('forgetting a memory', () => {
  async function forgetWith(deletion: string, extra: Answers = {}) {
    // As the Bureau does: a memory that was forgotten is not found when it is read again.
    let gone = false;
    const served = bureau({
      'bureau.memory.get': () => {
        if (gone) throw new StubFault('NotFound', 404, 'No memory.', { resource: 'memory' });
        return { memory: AISLE, lineage: NO_LINEAGE };
      },
      'bureau.memory.forget': () => {
        gone = deletion === 'completed';
        return {
          id: AISLE.id,
          deletion,
          receipt: {
            ...RECEIPT,
            awaitingHoldRelease: deletion === 'exempt',
            targets: [{ target: 'source-evidence', lane: 'synchronous', status: deletion }],
          },
        };
      },
      ...extra,
    });
    const view = open();
    const detail = await openDetails(view, AISLE.content);
    await fireEvent.click(within(detail).getByRole('button', { name: MEMORY_COPY.forget.action }));
    const dialog = await view.findByRole('dialog', { name: MEMORY_COPY.forget.dialog.title });
    expect(dialog.textContent).toContain(MEMORY_COPY.forget.dialog.description);
    await fireEvent.click(
      within(dialog).getByRole('button', { name: MEMORY_COPY.forget.dialog.confirm }),
    );
    return { served, view, detail };
  }

  /** Forgets the first memory straight from its row, confirming the question. */
  async function forgetFromRow(view: ReturnType<typeof open>, content: string) {
    const text = await view.findByText(content);
    const row = text.closest('li') as HTMLElement;
    await fireEvent.click(
      within(row).getByRole('button', {
        name: MEMORY_COPY.rowAction.forget(content, whenOf(AISLE)),
      }),
    );
    const dialog = await view.findByRole('dialog', { name: MEMORY_COPY.forget.dialog.title });
    await fireEvent.click(
      within(dialog).getByRole('button', { name: MEMORY_COPY.forget.dialog.confirm }),
    );
  }

  test('asks first, and forgets nothing when the question is declined', async () => {
    const served = bureau();
    const view = open();
    const detail = await openDetails(view, AISLE.content);
    await fireEvent.click(within(detail).getByRole('button', { name: MEMORY_COPY.forget.action }));
    const dialog = await view.findByRole('dialog', { name: MEMORY_COPY.forget.dialog.title });

    await fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    expect(served.callsTo('bureau.memory.forget')).toEqual([]);
  });

  for (const state of ['completed', 'exempt', 'pending', 'failed', 'unknown'] as const) {
    test(`words a deletion that came to ${state}`, async () => {
      const { served, view } = await forgetWith(state);
      const words = MEMORY_COPY.forget.outcome[state];

      const title = await view.findByText(words.title);

      expect(title.getAttribute('data-forget-outcome')).toBe(state);
      expect(view.container.textContent).toContain(words.description);
      expect(served.callsTo('bureau.memory.forget')[0]?.params).toEqual({
        agentId: 'assistant',
        id: AISLE.id,
      });
      // The receipt's rows are shown in the receipt's own states.
      expect(textOf(view.container)).toContain(
        `${MEMORY_COPY.forget.targets['source-evidence']}: ${MEMORY_COPY.forget.targetStatus[state]}`,
      );
    });
  }

  test('learns of a legal hold from the exempt answer, and leaves the memory listed', async () => {
    const { served, view, detail } = await forgetWith('exempt');

    await view.findByText(MEMORY_COPY.forget.outcome.exempt.title);

    expect(
      textOf(
        within(detail).getByText(MEMORY_COPY.detail.fields.legalHold, { selector: 'dt' })
          .nextElementSibling,
      ),
    ).toBe(MEMORY_COPY.detail.legalHold.held);
    // The memory is still there to forget again or correct.
    expect(within(detail).getByRole('button', { name: MEMORY_COPY.forget.action })).not.toBeNull();
    expect(view.container.querySelector('[data-memory="memory-aisle"]')).not.toBeNull();
    await waitFor(() => expect(served.callsTo('bureau.memory.list').length).toBeGreaterThan(1));
  });

  test('closes the details of a memory that is gone, and reads the list again', async () => {
    const { served, view } = await forgetWith('completed');

    await view.findByText(MEMORY_COPY.forget.outcome.completed.title);

    // The memory is gone, so there is nothing left to show about it or to do to it.
    expect(view.queryByRole('region', { name: MEMORY_COPY.detail.heading })).toBeNull();
    await waitFor(() => expect(served.callsTo('bureau.memory.list').length).toBeGreaterThan(1));
    // Its details are not asked for again, and the page does not answer it with "not found".
    expect(served.callsTo('bureau.memory.get')).toHaveLength(1);
    expect(view.queryByText(MEMORY_COPY.detail.notFound.title)).toBeNull();
  });

  test('forgets from the row without opening the details', async () => {
    const served = bureau({
      'bureau.memory.forget': () => ({ id: AISLE.id, deletion: 'completed', receipt: RECEIPT }),
    });
    const view = open();

    await forgetFromRow(view, AISLE.content);

    expect(await view.findByText(MEMORY_COPY.forget.outcome.completed.title)).not.toBeNull();
    expect(served.callsTo('bureau.memory.forget')[0]?.params).toEqual({
      agentId: 'assistant',
      id: AISLE.id,
    });
    expect(served.callsTo('bureau.memory.get')).toEqual([]);
    expect(view.queryByRole('region', { name: MEMORY_COPY.detail.heading })).toBeNull();
  });

  test('keeps the receipt on screen when the last memory is forgotten, inside the Agents view', async () => {
    let gone = false;
    bureau({
      'bureau.memory.list': () => ({ memories: gone ? [] : [AISLE], nextOffset: null }),
      'bureau.memory.get': () => ({ memory: AISLE, lineage: NO_LINEAGE }),
      'bureau.memory.forget': () => {
        gone = true;
        return { id: AISLE.id, deletion: 'completed', receipt: RECEIPT };
      },
    });
    landAt('/agents/assistant/memory');
    const view = render(FramedMemory, { props: { agentId: 'assistant' } } as never);
    await view.findByText(AISLE.content);
    const detail = await openDetails(view as never, AISLE.content);
    await fireEvent.click(within(detail).getByRole('button', { name: MEMORY_COPY.forget.action }));
    const dialog = await view.findByRole('dialog', { name: MEMORY_COPY.forget.dialog.title });
    await fireEvent.click(
      within(dialog).getByRole('button', { name: MEMORY_COPY.forget.dialog.confirm }),
    );

    // The receipt is readable, the page says nothing is left, and the frame has not swapped the
    // page for its empty state under it.
    expect(await view.findByText(MEMORY_COPY.forget.outcome.completed.title)).not.toBeNull();
    expect(await view.findByText(MEMORY_COPY.nothingLeft)).not.toBeNull();
    expect(view.container.querySelector('.weft-view')?.getAttribute('data-state')).toBe('ready');
    expect(textOf(view.container)).toContain(MEMORY_COPY.forget.targets['source-evidence']);
  });

  test('says so when the Bureau refuses the forget', async () => {
    const { view } = await forgetWith('completed', {
      'bureau.memory.forget': () => {
        throw new StubFault('Forbidden', 403, 'No.', {
          reason: 'missing scope bureau.memory:write',
        });
      },
    });

    await view.findByText(MEMORY_COPY.forget.failed);

    expect(view.container.textContent).toContain(MEMORY_COPY.correct.refusal.forbidden.description);
  });
});

describe('a forget the Bureau cannot answer', () => {
  test('shows the Bureau’s own words, and lets the person dismiss them and try again', async () => {
    const served = bureau({
      'bureau.memory.forget': () => {
        throw new StubFault('EngineFailure', 500, 'The Bureau broke.');
      },
    });
    const view = open();
    const detail = await openDetails(view, AISLE.content);
    await fireEvent.click(within(detail).getByRole('button', { name: MEMORY_COPY.forget.action }));
    const dialog = await view.findByRole('dialog', { name: MEMORY_COPY.forget.dialog.title });
    await fireEvent.click(
      within(dialog).getByRole('button', { name: MEMORY_COPY.forget.dialog.confirm }),
    );

    await view.findByText(MEMORY_COPY.forget.failed);
    expect(view.container.textContent).toContain('The Bureau broke.');
    await fireEvent.click(view.getByRole('button', { name: /dismiss/i }));

    expect(view.queryByText(MEMORY_COPY.forget.failed)).toBeNull();
    expect(served.callsTo('bureau.memory.forget')).toHaveLength(1);
  });
});

describe('correcting a memory', () => {
  async function correctWith(answer: BureauHandler, content = 'The user prefers the exit row.') {
    const served = bureau({ 'bureau.memory.correct': answer });
    const view = open();
    const detail = await openDetails(view, AISLE.content);
    await fireEvent.click(within(detail).getByRole('button', { name: MEMORY_COPY.correct.action }));
    const dialog = await view.findByRole('dialog', { name: MEMORY_COPY.correct.dialog.title });
    const field = within(dialog).getByLabelText(MEMORY_COPY.correct.dialog.label);
    // The field starts from the memory's own text.
    expect((field as HTMLTextAreaElement).value).toBe(AISLE.content);
    await fireEvent.input(field, { target: { value: content } });
    await fireEvent.click(
      within(dialog).getByRole('button', { name: MEMORY_COPY.correct.dialog.submit }),
    );
    return { served, view, dialog };
  }

  test('sends the corrected words, opens the correction, and says the old memory was replaced', async () => {
    const corrected = { ...WINDOW, content: 'The user prefers the exit row.' };
    const { served, view } = await correctWith(() => ({ id: AISLE.id, memory: corrected }));

    expect(await view.findByText(MEMORY_COPY.correct.saved.title)).not.toBeNull();

    expect(served.callsTo('bureau.memory.correct')[0]?.params).toEqual({
      agentId: 'assistant',
      id: AISLE.id,
      content: 'The user prefers the exit row.',
    });
    // The list is read again, and the page now shows the correction's details.
    await waitFor(() => expect(served.callsTo('bureau.memory.list').length).toBeGreaterThan(1));
    await waitFor(() =>
      expect(served.callsTo('bureau.memory.get').map((call) => call.params['id'])).toContain(
        WINDOW.id,
      ),
    );
    expect(view.queryByRole('dialog', { name: MEMORY_COPY.correct.dialog.title })).toBeNull();
  });

  test('corrects from the row, starting from the memory’s own words', async () => {
    const corrected = { ...WINDOW, content: 'The user prefers the exit row.' };
    const served = bureau({ 'bureau.memory.correct': () => ({ id: AISLE.id, memory: corrected }) });
    const view = open();
    const text = await view.findByText(AISLE.content);
    const row = text.closest('li') as HTMLElement;

    await fireEvent.click(
      within(row).getByRole('button', {
        name: MEMORY_COPY.rowAction.correct(AISLE.content, whenOf(AISLE)),
      }),
    );
    const dialog = await view.findByRole('dialog', { name: MEMORY_COPY.correct.dialog.title });
    const field = within(dialog).getByLabelText(MEMORY_COPY.correct.dialog.label);
    expect((field as HTMLTextAreaElement).value).toBe(AISLE.content);
    await fireEvent.input(field, { target: { value: corrected.content } });
    await fireEvent.click(
      within(dialog).getByRole('button', { name: MEMORY_COPY.correct.dialog.submit }),
    );

    expect(await view.findByText(MEMORY_COPY.correct.saved.title)).not.toBeNull();
    expect(served.callsTo('bureau.memory.correct')[0]?.params).toEqual({
      agentId: 'assistant',
      id: AISLE.id,
      content: corrected.content,
    });
  });

  test('words the Bureau’s refusal of a memory that was already corrected', async () => {
    const { dialog } = await correctWith(() => {
      throw new StubFault('Conflict', 409, 'Already corrected.', { reason: 'memory-superseded' });
    });

    const title = await within(dialog).findByText(MEMORY_COPY.correct.refusal.superseded.title);

    expect(title.getAttribute('data-correction-refusal')).toBe('superseded');
    expect(dialog.textContent).toContain(MEMORY_COPY.correct.refusal.superseded.description);
  });

  test('words the Bureau’s refusal of a correction it does not admit, and keeps what was typed', async () => {
    const { dialog } = await correctWith(() => {
      throw new StubFault('Unprocessable', 422, 'Not admitted.', {
        reason: 'memory-successor-not-admitted',
      });
    });

    const title = await within(dialog).findByText(
      MEMORY_COPY.correct.refusal['successor-not-admitted'].title,
    );

    expect(title.getAttribute('data-correction-refusal')).toBe('successor-not-admitted');
    expect(dialog.textContent).toContain(
      MEMORY_COPY.correct.refusal['successor-not-admitted'].description,
    );
    expect(
      (within(dialog).getByLabelText(MEMORY_COPY.correct.dialog.label) as HTMLTextAreaElement)
        .value,
    ).toBe('The user prefers the exit row.');
  });

  test('words a missing scope, a missing memory, and any other failure', async () => {
    const cases = [
      [new StubFault('Forbidden', 403, 'No.'), MEMORY_COPY.correct.refusal.forbidden.title],
      [
        new StubFault('NotFound', 404, 'No memory.'),
        MEMORY_COPY.correct.refusal['not-found'].title,
      ],
      [
        new StubFault('EngineFailure', 500, 'The Bureau broke.'),
        MEMORY_COPY.correct.refusal.other.title,
      ],
    ] as const;
    for (const [fault, title] of cases) {
      const { dialog } = await correctWith(() => {
        throw fault;
      });
      expect(await within(dialog).findByText(title)).not.toBeNull();
      cleanup();
      stub?.restore();
    }
  });

  test('closes without sending anything when it is cancelled', async () => {
    const served = bureau();
    const view = open();
    const detail = await openDetails(view, AISLE.content);
    await fireEvent.click(within(detail).getByRole('button', { name: MEMORY_COPY.correct.action }));
    const dialog = await view.findByRole('dialog', { name: MEMORY_COPY.correct.dialog.title });

    await fireEvent.click(
      within(dialog).getByRole('button', { name: MEMORY_COPY.correct.dialog.cancel }),
    );

    await waitFor(() =>
      expect(view.queryByRole('dialog', { name: MEMORY_COPY.correct.dialog.title }) === null).toBe(
        true,
      ),
    );
    expect(served.callsTo('bureau.memory.correct')).toEqual([]);
  });

  test('closes with the dialog’s own close control, and keeps the memory as it was', async () => {
    const served = bureau();
    const view = open();
    const detail = await openDetails(view, AISLE.content);
    await fireEvent.click(within(detail).getByRole('button', { name: MEMORY_COPY.correct.action }));
    const dialog = await view.findByRole('dialog', { name: MEMORY_COPY.correct.dialog.title });

    await fireEvent.click(within(dialog).getByRole('button', { name: 'Close dialog' }));

    await waitFor(() =>
      expect(view.queryByRole('dialog', { name: MEMORY_COPY.correct.dialog.title }) === null).toBe(
        true,
      ),
    );
    expect(served.callsTo('bureau.memory.correct')).toEqual([]);
    // It opens again, from the memory’s own text.
    await fireEvent.click(within(detail).getByRole('button', { name: MEMORY_COPY.correct.action }));
    const again = await view.findByRole('dialog', { name: MEMORY_COPY.correct.dialog.title });
    expect(
      (within(again).getByLabelText(MEMORY_COPY.correct.dialog.label) as HTMLTextAreaElement).value,
    ).toBe(AISLE.content);
  });

  test('does not send a blank correction', async () => {
    const served = bureau();
    const view = open();
    const detail = await openDetails(view, AISLE.content);
    await fireEvent.click(within(detail).getByRole('button', { name: MEMORY_COPY.correct.action }));
    const dialog = await view.findByRole('dialog', { name: MEMORY_COPY.correct.dialog.title });

    await fireEvent.input(within(dialog).getByLabelText(MEMORY_COPY.correct.dialog.label), {
      target: { value: '   ' },
    });

    expect(
      within(dialog)
        .getByRole('button', { name: MEMORY_COPY.correct.dialog.submit })
        .hasAttribute('disabled'),
    ).toBe(true);
    expect(served.callsTo('bureau.memory.correct')).toEqual([]);
  });
});

describe('what a review round found', () => {
  test('says a match total that is capped as at least, even when the agent’s total is known', () => {
    expect(MEMORY_COPY.matchCount(20, 25, true)).toBe('20+ of 25 memories match');
    // Every memory matching is exact, however full the page was.
    expect(MEMORY_COPY.matchCount(20, 20, true)).toBe('20 of 20 memories match');
    expect(MEMORY_COPY.matchCount(3, 12, false)).toBe('3 of 12 memories match');
    expect(MEMORY_COPY.matchCount(1, 1, false)).toBe('1 of 1 memory matches');
  });

  test('keeps the counts current when a memory is forgotten from the search results', async () => {
    let gone = false;
    bureau({
      'bureau.memory.list': () => ({
        memories: gone ? [WINDOW] : [AISLE, WINDOW],
        nextOffset: null,
      }),
      'bureau.memory.search': () => ({
        hits: (gone ? [WINDOW] : [AISLE, WINDOW]).map((memory) => ({ memory, score: 0.12 })),
      }),
      'bureau.memory.forget': () => {
        gone = true;
        return { id: AISLE.id, deletion: 'completed', receipt: RECEIPT };
      },
    });
    const view = open();
    await view.findByText(AISLE.content);
    await fireEvent.input(view.getByLabelText(MEMORY_COPY.searchLabel), {
      target: { value: 'seats' },
    });
    await fireEvent.click(view.getByRole('button', { name: MEMORY_COPY.searchAction }));
    await waitFor(() =>
      expect(textOf(view.getByTestId('memory-match-count'))).toBe(
        MEMORY_COPY.matchCount(2, 2, false),
      ),
    );

    // The words searched for are marked, so the row is found by its identity and not its text.
    const row = view.container.querySelector('[data-memory="memory-aisle"]') as HTMLElement;
    await fireEvent.click(
      within(row).getByRole('button', {
        name: MEMORY_COPY.rowAction.forget(AISLE.content, whenOf(AISLE)),
      }),
    );
    const dialog = await view.findByRole('dialog', { name: MEMORY_COPY.forget.dialog.title });
    await fireEvent.click(
      within(dialog).getByRole('button', { name: MEMORY_COPY.forget.dialog.confirm }),
    );

    await waitFor(() =>
      expect(textOf(view.getByTestId('memory-match-count'))).toBe(
        MEMORY_COPY.matchCount(1, 1, false),
      ),
    );
    expect(textOf(view.getByTestId('memory-count'))).toBe(MEMORY_COPY.count(1, false));
  });

  test('keeps a legal hold known after the receipt that reported it is dismissed', async () => {
    bureau({
      'bureau.memory.forget': () => ({
        id: AISLE.id,
        deletion: 'exempt',
        receipt: { ...RECEIPT, awaitingHoldRelease: true },
      }),
    });
    const view = open();
    const detail = await openDetails(view, AISLE.content);
    await fireEvent.click(within(detail).getByRole('button', { name: MEMORY_COPY.forget.action }));
    const dialog = await view.findByRole('dialog', { name: MEMORY_COPY.forget.dialog.title });
    await fireEvent.click(
      within(dialog).getByRole('button', { name: MEMORY_COPY.forget.dialog.confirm }),
    );
    await view.findByText(MEMORY_COPY.forget.outcome.exempt.title);

    await fireEvent.click(view.getByRole('button', { name: /dismiss/i }));

    expect(view.queryByText(MEMORY_COPY.forget.outcome.exempt.title)).toBeNull();
    expect(
      textOf(
        within(detail).getByText(MEMORY_COPY.detail.fields.legalHold, { selector: 'dt' })
          .nextElementSibling,
      ),
    ).toBe(MEMORY_COPY.detail.legalHold.held);
  });

  test('does not close a newer correction form, or leave for its memory, when an older correction lands', async () => {
    let release: (answer: unknown) => void = () => {};
    const served = bureau({
      'bureau.memory.correct': () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    });
    const view = open();
    const aisleText = await view.findByText(AISLE.content);
    const aisleRow = aisleText.closest('li') as HTMLElement;
    await fireEvent.click(
      within(aisleRow).getByRole('button', {
        name: MEMORY_COPY.rowAction.correct(AISLE.content, whenOf(AISLE)),
      }),
    );
    const first = await view.findByRole('dialog', { name: MEMORY_COPY.correct.dialog.title });
    await fireEvent.input(within(first).getByLabelText(MEMORY_COPY.correct.dialog.label), {
      target: { value: 'The user prefers the exit row.' },
    });
    await fireEvent.click(
      within(first).getByRole('button', { name: MEMORY_COPY.correct.dialog.submit }),
    );
    await waitFor(() => expect(served.callsTo('bureau.memory.correct')).toHaveLength(1));
    await fireEvent.click(
      within(first).getByRole('button', { name: MEMORY_COPY.correct.dialog.cancel }),
    );
    // The person moves on to another memory while the first correction is still being saved.
    const windowText = await view.findByText(WINDOW.content);
    const windowRow = windowText.closest('li') as HTMLElement;
    await fireEvent.click(
      within(windowRow).getByRole('button', {
        name: MEMORY_COPY.rowAction.correct(WINDOW.content, whenOf(WINDOW)),
      }),
    );
    const second = await view.findByRole('dialog', { name: MEMORY_COPY.correct.dialog.title });
    const field = within(second).getByLabelText(MEMORY_COPY.correct.dialog.label);
    expect((field as HTMLTextAreaElement).value).toBe(WINDOW.content);

    release({ id: AISLE.id, memory: { ...AISLE, id: 'memory-corrected', source: 'operator' } });

    expect(await view.findByText(MEMORY_COPY.correct.saved.title)).not.toBeNull();
    const stillOpen = view.getByRole('dialog', { name: MEMORY_COPY.correct.dialog.title });
    expect(
      (within(stillOpen).getByLabelText(MEMORY_COPY.correct.dialog.label) as HTMLTextAreaElement)
        .value,
    ).toBe(WINDOW.content);
    expect(served.callsTo('bureau.memory.get')).toEqual([]);
  });

  test('tells two memories that share their first words apart in their actions', async () => {
    const prefix = 'The traveller prefers a window seat on long flights and always wants';
    const first = { ...AISLE, id: 'memory-first', content: `${prefix} the vegetarian meal.` };
    const second = {
      ...AISLE,
      id: 'memory-second',
      content: `${prefix} the fish meal.`,
      createdAt: '2026-10-20T09:30:00.000Z',
    };
    bureau({ 'bureau.memory.list': () => ({ memories: [first, second], nextOffset: null }) });
    const view = open();
    await view.findByText(first.content);

    const buttons = view.getAllByRole('button', { name: /^Forget:/ });
    const names = buttons.map((button) => button.getAttribute('aria-label'));

    expect(new Set(names).size).toBe(2);
    // Each action is described by its row's whole text.
    for (const button of buttons) {
      const described = document.getElementById(button.getAttribute('aria-describedby') ?? '');
      expect([first.content, second.content]).toContain(textOf(described));
    }
  });

  test('holds every Forget while one is being saved, and asks the Bureau once', async () => {
    let settle: (answer: unknown) => void = () => {};
    const served = bureau({
      'bureau.memory.forget': () =>
        new Promise((resolve) => {
          settle = resolve;
        }),
    });
    const view = open();
    const detail = await openDetails(view, AISLE.content);
    // The details also hold the text, so the rows are found by identity.
    const aisleRow = view.container.querySelector('[data-memory="memory-aisle"]') as HTMLElement;
    const windowRow = view.container.querySelector('[data-memory="memory-window"]') as HTMLElement;
    await fireEvent.click(
      within(aisleRow).getByRole('button', {
        name: MEMORY_COPY.rowAction.forget(AISLE.content, whenOf(AISLE)),
      }),
    );
    const dialog = await view.findByRole('dialog', { name: MEMORY_COPY.forget.dialog.title });
    await fireEvent.click(
      within(dialog).getByRole('button', { name: MEMORY_COPY.forget.dialog.confirm }),
    );
    await waitFor(() => expect(served.callsTo('bureau.memory.forget')).toHaveLength(1));

    // Every Forget waits: the row's, another row's, and the details'.
    const forgets = [
      within(aisleRow).getByRole('button', { name: /^Forget:/ }),
      within(windowRow).getByRole('button', { name: /^Forget:/ }),
      within(detail).getByRole('button', { name: MEMORY_COPY.forget.action }),
    ];
    await waitFor(() =>
      expect(forgets.map((button) => button.hasAttribute('disabled'))).toEqual([true, true, true]),
    );
    await fireEvent.click(forgets[1]!);
    expect(view.queryByRole('dialog', { name: MEMORY_COPY.forget.dialog.title })).toBeNull();
    expect(served.callsTo('bureau.memory.forget')).toHaveLength(1);

    settle({ id: AISLE.id, deletion: 'completed', receipt: RECEIPT });
    await view.findByText(MEMORY_COPY.forget.outcome.completed.title);
    await waitFor(() =>
      expect(
        within(windowRow)
          .getByRole('button', { name: /^Forget:/ })
          .hasAttribute('disabled'),
      ).toBe(false),
    );
  });

  describe('scrolling the details into view', () => {
    const original = {
      scroll: HTMLElement.prototype.scrollIntoView,
      media: window.matchMedia,
    };
    afterEach(() => {
      HTMLElement.prototype.scrollIntoView = original.scroll;
      window.matchMedia = original.media;
    });

    async function scrollsWhenOpened(wide: boolean): Promise<number> {
      let scrolls = 0;
      HTMLElement.prototype.scrollIntoView = () => {
        scrolls += 1;
      };
      window.matchMedia = ((query: string) => ({
        matches: wide && query.includes('64rem'),
      })) as unknown as typeof window.matchMedia;
      bureau();
      const view = open();
      await openDetails(view, AISLE.content);
      await view.findByText(MEMORY_COPY.detail.lineage);
      return scrolls;
    }

    test('scrolls to the details when they are stacked under the list', async () => {
      expect(await scrollsWhenOpened(false)).toBe(1);
    });

    test('leaves the page where it is when the details sit beside the list', async () => {
      expect(await scrollsWhenOpened(true)).toBe(0);
    });
  });
});

describe('the agent’s page', () => {
  test('links to its memory, which keeps the Agents view', async () => {
    bureau({ 'bureau.agents.list': () => ({ agents: [AGENT] }) });
    stub?.on('bureau.contexts.list', () => ({ contexts: [], nextOffset: null }));
    landAt('/agents/assistant');
    const { findByRole } = mount(AgentDetail);

    const link = await findByRole('link', { name: MEMORY_COPY.link });
    expect(link.getAttribute('href')).toBe('/agents/assistant/memory');
    link.click();

    expect(router.pathname).toBe('/agents/assistant/memory');
    expect(router.current.route?.view).toBe('agents');
    expect(router.current.params['id']).toBe('assistant');
  });
});
