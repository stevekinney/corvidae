/**
 * The Memory page (`/agents/:agent/memories`) against a stand-in for the server's memory operations:
 * the list with the open memory beside it, the search that runs as you type, the kind filter, one
 * memory's facts, what forgetting answers in each of the deletion's states, correcting in place
 * (the original is kept in the history), and the governance actions (share, hold, quarantine,
 * export). The Agents view's frame owns the page's loading, empty, failing, locked and not-found
 * states (`app/view-frame.test.ts`). The real server is exercised in the Playwright suite.
 */
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/svelte';
import { afterEach, describe, expect, mock, test } from 'bun:test';

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
const RECIPE = {
  ...AISLE,
  id: 'memory-recipe',
  content: 'To book a flight, ask for the date first.',
  memoryClass: 'procedural',
};
const FACT = {
  ...AISLE,
  id: 'memory-fact',
  content: 'The user lives in Lisbon.',
  memoryClass: 'semantic',
};
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

/** The server for one test: an agent with memories, and whatever a test overrides. */
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

function open(path = '/agents/assistant/memories') {
  landAt(path);
  return mount(AgentMemory);
}

/** The list's row for a memory, found by its identifier. */
const rowOf = (view: ReturnType<typeof open>, id: string): HTMLElement => {
  const row = view.container.querySelector<HTMLElement>(`[data-memory="${id}"]`);
  if (row === null) throw new Error(`No row for ${id}.`);
  return row;
};

/** Opens the memory whose text is `content`, by clicking its row, and returns the details. */
async function openDetails(
  view: Pick<ReturnType<typeof open>, 'findByText' | 'findByRole'>,
  content: string,
) {
  const text = await view.findByText(content);
  const opener = text.closest('button');
  if (opener === null) throw new Error(`No row holds "${content}".`);
  await fireEvent.click(opener);
  const region = await view.findByRole('region', { name: MEMORY_COPY.detail.heading });
  // The details read the memory again: wait for its text to be the details' own.
  await waitFor(() => expect(region.querySelector('[data-memory-detail]')).not.toBeNull());
  await waitFor(() => expect(within(region).queryByRole('status')?.outerHTML ?? null).toBeNull());
  return region;
}

/** The value of a fact in the details, found by its term. */
const factOf = (detail: HTMLElement, term: string): HTMLElement | null =>
  (within(detail).queryByText(term, { selector: 'dt' })?.nextElementSibling as
    HTMLElement | undefined) ?? null;

describe('the list', () => {
  test('lists what the agent remembers, newest first, with a plain kind and the time', async () => {
    const served = bureau();
    const view = open();

    await view.findByText(AISLE.content);
    await view.findByText(WINDOW.content);
    expect(served.callsTo('bureau.memory.list')[0]?.params).toEqual({
      agentId: 'assistant',
      limit: 20,
      offset: 0,
    });
    const rows = view.container.querySelectorAll('[data-memory]');
    expect([...rows].map((row) => row.getAttribute('data-memory'))).toEqual([
      'memory-aisle',
      'memory-window',
    ]);
    // The engine's own term is for the details: a row says where the memory came from.
    expect(rows[0]?.textContent).toContain(MEMORY_COPY.plainKind.chats);
    expect(rows[0]?.textContent).not.toContain(MEMORY_COPY.kind.episodic.label);
    expect(rows[1]?.textContent).toContain(MEMORY_COPY.plainKind.you);
    expect(rows[0]?.querySelector('time')?.getAttribute('datetime')).toBe(AISLE.createdAt);
    expect(rows[0]?.querySelector('time')?.getAttribute('title')).toBe(
      new Date(AISLE.createdAt).toLocaleString(),
    );
  });

  test('is a list with the open memory beside it: the title, Export and the filters sit in its own header', async () => {
    bureau();
    const view = open();
    await view.findByText(AISLE.content);

    const list = view.getByRole('region', { name: MEMORY_COPY.listLabel });
    expect(within(list).getByRole('heading', { level: 1 }).textContent).toBe(MEMORY_COPY.heading);
    expect(
      within(list).getByRole('button', { name: MEMORY_COPY.govern.export.action }),
    ).not.toBeNull();
    expect(within(list).getByRole('searchbox', { name: MEMORY_COPY.searchLabel })).not.toBeNull();
    expect(within(list).getByLabelText(MEMORY_COPY.filter.label)).not.toBeNull();
    // Nothing is open, and a row has no actions of its own.
    expect(view.getByText(MEMORY_COPY.nothingOpen.title)).not.toBeNull();
    expect(within(rowOf(view, AISLE.id).closest('li')!).queryAllByRole('button')).toHaveLength(1);
    expect(view.queryByRole('button', { name: /^Back to/ })).toBeNull();
  });

  test('says how many memories the agent has, and that there are more when a page is left', async () => {
    bureau({ 'bureau.memory.list': () => ({ memories: [AISLE, WINDOW], nextOffset: 2 }) });
    const { findByTestId } = open();

    expect(textOf(await findByTestId('memory-count'))).toBe(MEMORY_COPY.count(2, true));
    expect(MEMORY_COPY.count(1, false)).toBe('1 memory');
    expect(MEMORY_COPY.count(2, false)).toBe('2 memories');
  });

  test('loads the next page of a long list from its last row', async () => {
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
        if (failing) throw new StubFault('EngineFailure', 500, 'The server broke.');
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

describe('the search', () => {
  test('searches as you type, ranks every hit with its relevance, and lists again when cleared', async () => {
    const served = bureau({
      'bureau.memory.search': () => ({ hits: [{ memory: WINDOW, score: 0.8 }] }),
    });
    const { container, findByText, getByLabelText, getByTestId, queryByText, getByRole } = open();
    await findByText(AISLE.content);

    // No Search button: typing is the search, and spaces around the words are not part of it.
    await fireEvent.input(getByLabelText(MEMORY_COPY.searchLabel), {
      target: { value: ' window ' },
    });

    await findByText(`${MEMORY_COPY.relevance}: 0.80`);
    expect(queryByText(AISLE.content)).toBeNull();
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

  test('counts the memories that hold a word of the query, whatever the server scored them', async () => {
    // The server ranks every memory and has no floor. Here the memory that holds "window" is
    // scored below zero, and one that holds nothing of the query is scored above it.
    bureau({
      'bureau.memory.search': () => ({
        hits: [
          { memory: AISLE, score: 0.4 },
          { memory: WINDOW, score: -0.3 },
        ],
      }),
    });
    const { container, findByTestId, getByLabelText } = open();
    await findByTestId('memory-count');

    await fireEvent.input(getByLabelText(MEMORY_COPY.searchLabel), { target: { value: 'window' } });

    expect(textOf(await findByTestId('memory-match-count'))).toBe(
      MEMORY_COPY.matchCount(1, 2, false),
    );
    expect(
      [...container.querySelectorAll('[data-memory]')].map((row) =>
        row.getAttribute('data-memory'),
      ),
    ).toEqual(['memory-window']);
  });

  test('says no memory matches as an empty state with a way back, and lists everything from it', async () => {
    bureau({ 'bureau.memory.search': () => ({ hits: [{ memory: AISLE, score: 0.2 }] }) });
    const { findByText, findByRole, getByLabelText, container } = open();
    await findByText(AISLE.content);

    await fireEvent.input(getByLabelText(MEMORY_COPY.searchLabel), { target: { value: 'zebra' } });

    expect(await findByText(MEMORY_COPY.noMatch.title('zebra'), { selector: 'h2' })).not.toBeNull();
    // The empty state says it once: no status line repeats it.
    expect(container.textContent?.split(MEMORY_COPY.noMatch.title('zebra'))).toHaveLength(2);
    expect(container.querySelector('[data-memory]')).toBeNull();
    await fireEvent.click(await findByRole('button', { name: MEMORY_COPY.clearMatch }));
    await findByText(AISLE.content);
    expect((getByLabelText(MEMORY_COPY.searchLabel) as HTMLInputElement).value).toBe('');
  });

  test('says how many match without a total while the list has pages left, and that more may', async () => {
    bureau({
      'bureau.memory.list': () => ({ memories: [AISLE, WINDOW], nextOffset: 2 }),
      'bureau.memory.search': () => ({ hits: [{ memory: WINDOW, score: 0.8 }] }),
    });
    const { findByTestId, getByLabelText } = open();
    await findByTestId('memory-count');

    await fireEvent.input(getByLabelText(MEMORY_COPY.searchLabel), { target: { value: 'window' } });

    expect(textOf(await findByTestId('memory-match-count'))).toBe(
      MEMORY_COPY.matchCount(1, undefined, false),
    );
  });

  test('lists on a blank search rather than asking the server to search for nothing', async () => {
    const served = bureau();
    const { findByText, getByLabelText } = open();
    await findByText(AISLE.content);

    await fireEvent.input(getByLabelText(MEMORY_COPY.searchLabel), { target: { value: '   ' } });

    await findByText(WINDOW.content);
    expect(served.callsTo('bureau.memory.search')).toEqual([]);
  });

  test('says a match total that is capped as at least, even when the agent’s total is known', () => {
    expect(MEMORY_COPY.matchCount(100, 150, true)).toBe('100+ of 150 memories match');
    expect(MEMORY_COPY.matchCount(2, 2, true)).toBe('2 of 2 memories match');
  });
});

describe('the kind filter', () => {
  const MIXED = [AISLE, WINDOW, RECIPE, FACT];

  async function mixed() {
    const served = bureau({ 'bureau.memory.list': () => ({ memories: MIXED, nextOffset: null }) });
    const view = open();
    await view.findByText(FACT.content);
    return { served, view };
  }

  const choose = (view: ReturnType<typeof open>, value: string) =>
    fireEvent.change(view.getByLabelText(MEMORY_COPY.filter.label), { target: { value } });

  const shownIds = (view: ReturnType<typeof open>) =>
    [...view.container.querySelectorAll('[data-memory]')].map((row) =>
      row.getAttribute('data-memory'),
    );

  test('names the kinds in plain words and keeps the engine’s terms for the details', async () => {
    const { view } = await mixed();
    const select = view.getByLabelText(MEMORY_COPY.filter.label);

    expect([...select.querySelectorAll('option')].map((option) => option.textContent)).toEqual([
      MEMORY_COPY.filter.all,
      MEMORY_COPY.filter.facts,
      MEMORY_COPY.filter.chats,
      MEMORY_COPY.filter.howTo,
      MEMORY_COPY.filter.you,
    ]);
    const list = view.getByRole('region', { name: MEMORY_COPY.listLabel });
    for (const engine of ['Semantic', 'Episodic', 'Procedural', 'Operator']) {
      expect(list.textContent).not.toContain(engine);
    }
  });

  for (const [value, expected] of [
    ['facts', ['memory-fact']],
    ['chats', ['memory-aisle']],
    ['howTo', ['memory-recipe']],
    ['you', ['memory-window']],
    ['all', ['memory-aisle', 'memory-window', 'memory-recipe', 'memory-fact']],
  ] as const) {
    test(`narrows the list to ${value}`, async () => {
      const { view } = await mixed();

      await choose(view, value);

      await waitFor(() => expect(shownIds(view)).toEqual([...expected]));
    });
  }

  test('says it works over the memories loaded so far while pages are left', async () => {
    bureau({ 'bureau.memory.list': () => ({ memories: MIXED, nextOffset: 4 }) });
    const view = open();
    await view.findByText(FACT.content);

    await choose(view, 'facts');

    expect(textOf(await view.findByTestId('memory-kind-note'))).toBe(
      MEMORY_COPY.filter.note(1, 4, true),
    );
    expect(MEMORY_COPY.filter.note(1, 4, true)).toContain('loaded so far');
  });

  test('says no loaded memory is of the kind chosen, with a way back to every kind', async () => {
    bureau({ 'bureau.memory.list': () => ({ memories: [AISLE], nextOffset: null }) });
    const view = open();
    await view.findByText(AISLE.content);

    await choose(view, 'howTo');

    await view.findByText(MEMORY_COPY.noKind.title, { selector: 'h2' });
    await fireEvent.click(view.getByRole('button', { name: MEMORY_COPY.clearMatch }));
    await view.findByText(AISLE.content);
    expect((view.getByLabelText(MEMORY_COPY.filter.label) as HTMLSelectElement).value).toBe('all');
  });

  test('works together with a search', async () => {
    bureau({
      'bureau.memory.list': () => ({ memories: MIXED, nextOffset: null }),
      'bureau.memory.search': () => ({
        hits: [
          { memory: AISLE, score: 0.5 },
          { memory: WINDOW, score: 0.4 },
        ],
      }),
    });
    const view = open();
    await view.findByText(FACT.content);

    await fireEvent.input(view.getByLabelText(MEMORY_COPY.searchLabel), {
      target: { value: 'seats' },
    });
    await choose(view, 'you');

    await waitFor(() => expect(shownIds(view)).toEqual(['memory-window']));
  });
});

describe('one memory', () => {
  test('leads with its text, then its kind, time and the two icon buttons, and the facts in three columns', async () => {
    bureau({
      'bureau.memory.get': () => ({
        memory: AISLE,
        lineage: { runId: 'run-7', corrects: null, correctedBy: null },
      }),
    });
    const view = open();
    const detail = await openDetails(view, AISLE.content);

    expect(detail.querySelector('blockquote')?.textContent?.trim()).toBe(AISLE.content);
    expect(
      within(detail).getByRole('button', { name: MEMORY_COPY.correct.iconLabel }),
    ).not.toBeNull();
    expect(
      within(detail).getByRole('button', { name: MEMORY_COPY.forget.iconLabel }),
    ).not.toBeNull();
    // The engine's term for the kind appears here, and nowhere in the list.
    expect(textOf(factOf(detail, MEMORY_COPY.detail.fields.kind))).toBe(
      MEMORY_COPY.kind.episodic.label,
    );
    expect(textOf(factOf(detail, MEMORY_COPY.detail.fields.source))).toBe(
      MEMORY_COPY.source.conversation,
    );
    expect(textOf(factOf(detail, MEMORY_COPY.detail.fields.trust))).toBe(
      MEMORY_COPY.trust.untrusted,
    );
    expect(textOf(factOf(detail, MEMORY_COPY.detail.fields.created))).toBe(
      new Date(AISLE.createdAt).toLocaleString(),
    );
    expect(textOf(factOf(detail, MEMORY_COPY.detail.fields.run))).toBe('run-7');
    const groups = [...detail.querySelectorAll('.ib-memory-detail__group')].map((group) =>
      textOf(group.querySelector('h3')),
    );
    expect(groups).toEqual([
      MEMORY_COPY.detail.groups.origin,
      MEMORY_COPY.detail.groups.standing,
      MEMORY_COPY.detail.groups.history,
    ]);
    // The chat is a link inside the app.
    const chat = within(factOf(detail, MEMORY_COPY.detail.fields.session)!).getByRole('link');
    expect(chat.getAttribute('href')).toBe('/chats/session-1');
  });

  test('says a field was not recorded when the server has nothing for it, and shows no legal hold yet', async () => {
    bureau();
    const view = open();
    const detail = await openDetails(view, WINDOW.content);

    expect(textOf(factOf(detail, MEMORY_COPY.detail.fields.session))).toBe(
      MEMORY_COPY.detail.notRecorded,
    );
    expect(textOf(factOf(detail, MEMORY_COPY.detail.fields.run))).toBe(
      MEMORY_COPY.detail.notRecorded,
    );
    expect(textOf(factOf(detail, MEMORY_COPY.detail.fields.corrects))).toBe(
      MEMORY_COPY.detail.noHistory,
    );
    // Nothing has said whether it is held, so the page does not guess.
    expect(factOf(detail, MEMORY_COPY.detail.fields.legalHold)).toBeNull();
  });

  test('keeps the open memory in the address, and opens the one the address names', async () => {
    bureau();
    const view = open('/agents/assistant/memories?memory=memory-window');

    const detail = await view.findByRole('region', { name: MEMORY_COPY.detail.heading });
    await waitFor(() =>
      expect(detail.querySelector('blockquote')?.textContent).toContain(WINDOW.content),
    );
    await fireEvent.click(rowOf(view, AISLE.id));
    await waitFor(() => expect(router.search.get('memory')).toBe(AISLE.id));
  });

  test('opens the memory a correction replaced from its “corrects” link, though no list holds it', async () => {
    const ORIGINAL = {
      ...AISLE,
      id: 'memory-original',
      content: 'The user prefers the middle seat.',
    };
    const served = bureau({
      'bureau.memory.list': () => ({ memories: [WINDOW], nextOffset: null }),
      'bureau.memory.get': (params) =>
        params['id'] === ORIGINAL.id
          ? { memory: ORIGINAL, lineage: { runId: null, corrects: null, correctedBy: WINDOW.id } }
          : { memory: WINDOW, lineage: { runId: null, corrects: ORIGINAL.id, correctedBy: null } },
    });
    const view = open();
    const detail = await openDetails(view, WINDOW.content);

    await fireEvent.click(
      within(factOf(detail, MEMORY_COPY.detail.fields.corrects)!).getByRole('button', {
        name: MEMORY_COPY.detail.openMemory,
      }),
    );

    await waitFor(() =>
      expect(detail.querySelector('blockquote')?.textContent).toContain(ORIGINAL.content),
    );
    expect(served.callsTo('bureau.memory.get').map((call) => call.params['id'])).toContain(
      ORIGINAL.id,
    );
    // It leads the list while it is open, and the link back reaches the correction.
    expect(rowOf(view, ORIGINAL.id).textContent).toContain(ORIGINAL.content);
    await fireEvent.click(
      within(factOf(detail, MEMORY_COPY.detail.fields.correctedBy)!).getByRole('button', {
        name: MEMORY_COPY.detail.openMemory,
      }),
    );
    await waitFor(() =>
      expect(detail.querySelector('blockquote')?.textContent).toContain(WINDOW.content),
    );
  });

  test('follows the chat link inside the app, and leaves a modified click to the browser', async () => {
    bureau();
    const view = open();
    const detail = await openDetails(view, AISLE.content);
    const link = within(detail).getByRole('link', { name: MEMORY_COPY.detail.openChat });

    link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, metaKey: true }));
    expect(router.pathname).toBe('/agents/assistant/memories');
    link.click();

    expect(router.pathname).toBe('/chats/session-1');
  });

  test('keeps a row for a memory the list does not hold while it is read, and says when it cannot be', async () => {
    bureau({ 'bureau.memory.get': () => new Promise(() => {}) });
    const view = open('/agents/assistant/memories?memory=memory-elsewhere');

    // While it is read the row is a placeholder, not a blank.
    await waitFor(() =>
      expect(rowOf(view, 'memory-elsewhere').querySelector('.cinder-skeleton')).not.toBeNull(),
    );
    cleanup();
    stub?.restore();

    bureau({
      'bureau.memory.get': () => {
        throw new StubFault('EngineFailure', 500, 'The server broke.');
      },
    });
    const failed = open('/agents/assistant/memories?memory=memory-elsewhere');
    await waitFor(() =>
      expect(textOf(rowOf(failed, 'memory-elsewhere'))).toContain(MEMORY_COPY.detail.failed),
    );
  });

  test('shows a loading state while a memory is read', async () => {
    bureau({ 'bureau.memory.get': () => new Promise(() => {}) });
    const view = open();
    const text = await view.findByText(AISLE.content);

    await fireEvent.click(text.closest('button')!);

    expect(await view.findByRole('status', { name: MEMORY_COPY.detail.loading })).not.toBeNull();
  });

  test('says a memory was not found when it is gone, and tries one that could not be loaded again on request', async () => {
    let failing: 'missing' | 'broken' | undefined = 'broken';
    const served = bureau({
      'bureau.memory.get': () => {
        if (failing === 'missing')
          throw new StubFault('NotFound', 404, 'No memory.', { resource: 'memory' });
        if (failing === 'broken') throw new StubFault('EngineFailure', 500, 'The server broke.');
        return { memory: AISLE, lineage: NO_LINEAGE };
      },
    });
    const view = open();
    const text = await view.findByText(AISLE.content);
    await fireEvent.click(text.closest('button')!);

    await view.findByText(MEMORY_COPY.detail.failed);
    failing = undefined;
    await fireEvent.click(view.getByRole('button', { name: RETRY_LABEL }));
    await waitFor(() => expect(view.container.querySelector('blockquote')).not.toBeNull());
    expect(served.callsTo('bureau.memory.get').length).toBeGreaterThan(1);

    failing = 'missing';
    await fireEvent.click(rowOf(view, WINDOW.id));
    expect(await view.findByText(MEMORY_COPY.detail.notFound.title)).not.toBeNull();
  });
});

describe('forgetting a memory', () => {
  async function forgetWith(deletion: string, extra: Answers = {}) {
    // As the server does: a memory that was forgotten is not found when it is read again.
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
    await fireEvent.click(
      within(detail).getByRole('button', { name: MEMORY_COPY.forget.iconLabel }),
    );
    const dialog = await view.findByRole('dialog', { name: MEMORY_COPY.forget.dialog.title });
    // The question names the memory that goes.
    expect(dialog.textContent).toContain(AISLE.content.slice(0, 20));
    expect(dialog.textContent).toContain(MEMORY_COPY.forget.dialog.description(AISLE.content));
    await fireEvent.click(
      within(dialog).getByRole('button', { name: MEMORY_COPY.forget.dialog.confirm }),
    );
    return { served, view, detail };
  }

  test('asks first, and forgets nothing when the question is declined', async () => {
    const served = bureau();
    const view = open();
    const detail = await openDetails(view, AISLE.content);
    await fireEvent.click(
      within(detail).getByRole('button', { name: MEMORY_COPY.forget.iconLabel }),
    );
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
      expect(textOf(view.container)).toContain(
        `${MEMORY_COPY.forget.targets['source-evidence']}: ${MEMORY_COPY.forget.targetStatus[state]}`,
      );
    });
  }

  test('learns of a legal hold from the exempt answer, and leaves the memory listed', async () => {
    const { served, view, detail } = await forgetWith('exempt');

    await view.findByText(MEMORY_COPY.forget.outcome.exempt.title);

    expect(textOf(factOf(detail, MEMORY_COPY.detail.fields.legalHold))).toBe(
      MEMORY_COPY.detail.legalHold.held,
    );
    // It can be released from here.
    expect(
      within(detail).getByRole('button', { name: MEMORY_COPY.govern.hold.release }),
    ).not.toBeNull();
    expect(rowOf(view, AISLE.id)).not.toBeNull();
    await waitFor(() => expect(served.callsTo('bureau.memory.list').length).toBeGreaterThan(1));
  });

  test('keeps a legal hold known after the receipt that reported it is dismissed', async () => {
    const { view, detail } = await forgetWith('exempt');
    await view.findByText(MEMORY_COPY.forget.outcome.exempt.title);

    await fireEvent.click(view.getByRole('button', { name: /dismiss/i }));

    expect(view.queryByText(MEMORY_COPY.forget.outcome.exempt.title)).toBeNull();
    expect(textOf(factOf(detail, MEMORY_COPY.detail.fields.legalHold))).toBe(
      MEMORY_COPY.detail.legalHold.held,
    );
  });

  test('closes the details of a memory that is gone, and reads the list again', async () => {
    const { served, view } = await forgetWith('completed');

    await view.findByText(MEMORY_COPY.forget.outcome.completed.title);

    await waitFor(() =>
      expect(view.container.querySelector('[data-memory-detail]')?.outerHTML ?? null).toBeNull(),
    );
    expect(view.getByText(MEMORY_COPY.nothingOpen.title)).not.toBeNull();
    await waitFor(() => expect(served.callsTo('bureau.memory.list').length).toBeGreaterThan(1));
  });

  test('keeps the receipt and says nothing is left when the last memory is forgotten', async () => {
    let remaining = [AISLE];
    bureau({
      'bureau.memory.list': () => ({ memories: remaining, nextOffset: null }),
      'bureau.memory.forget': () => {
        remaining = [];
        return { id: AISLE.id, deletion: 'completed', receipt: RECEIPT };
      },
    });
    landAt('/agents/assistant/memories');
    const view = render(FramedMemory, { props: { agentId: 'assistant' } } as never);
    const detail = await openDetails(view, AISLE.content);
    await fireEvent.click(
      within(detail).getByRole('button', { name: MEMORY_COPY.forget.iconLabel }),
    );
    const dialog = await view.findByRole('dialog', { name: MEMORY_COPY.forget.dialog.title });
    await fireEvent.click(
      within(dialog).getByRole('button', { name: MEMORY_COPY.forget.dialog.confirm }),
    );

    // An empty state, not a status line, and the receipt is still there to read.
    expect(await view.findByText(MEMORY_COPY.nothingLeft.title, { selector: 'h2' })).not.toBeNull();
    expect(view.getByText(MEMORY_COPY.forget.outcome.completed.title)).not.toBeNull();
    expect(view.container.querySelector('[data-view="agents"]')?.getAttribute('data-state')).toBe(
      'ready',
    );
  });

  test('says so when the server refuses the forget, and lets the person dismiss it and try again', async () => {
    const { view } = await forgetWith('completed', {
      'bureau.memory.forget': () => {
        throw new StubFault('Forbidden', 403, 'No scope.', {
          reason: 'missing scope bureau.memory:write',
        });
      },
    });

    await view.findByText(MEMORY_COPY.forget.failed);
    expect(view.container.textContent).toContain(MEMORY_COPY.correct.refusal.forbidden.description);
    await fireEvent.click(view.getByRole('button', { name: /dismiss/i }));
    expect(view.queryByText(MEMORY_COPY.forget.failed)).toBeNull();
  });

  test('shows the server’s own words for a failure it has none of ours for', async () => {
    const { view } = await forgetWith('completed', {
      'bureau.memory.forget': () => {
        throw new StubFault('EngineFailure', 500, 'The disk is full.');
      },
    });

    await view.findByText(MEMORY_COPY.forget.failed);
    expect(view.container.textContent).toContain('The disk is full.');
  });

  test('holds every Forget while one is being saved, and asks the server once', async () => {
    let settle: (answer: unknown) => void = () => {};
    const served = bureau({
      'bureau.memory.forget': () =>
        new Promise((resolve) => {
          settle = resolve;
        }),
    });
    const view = open();
    const detail = await openDetails(view, AISLE.content);
    const forget = within(detail).getByRole('button', { name: MEMORY_COPY.forget.iconLabel });
    await fireEvent.click(forget);
    const dialog = await view.findByRole('dialog', { name: MEMORY_COPY.forget.dialog.title });
    await fireEvent.click(
      within(dialog).getByRole('button', { name: MEMORY_COPY.forget.dialog.confirm }),
    );
    await waitFor(() => expect(served.callsTo('bureau.memory.forget')).toHaveLength(1));

    await waitFor(() => expect(forget.hasAttribute('disabled')).toBe(true));
    await fireEvent.click(forget);
    expect(view.queryByRole('dialog', { name: MEMORY_COPY.forget.dialog.title })).toBeNull();
    expect(served.callsTo('bureau.memory.forget')).toHaveLength(1);

    settle({ id: AISLE.id, deletion: 'completed', receipt: RECEIPT });
    await view.findByText(MEMORY_COPY.forget.outcome.completed.title);
  });
});

describe('correcting a memory', () => {
  const CORRECTION = 'The user prefers the exit row.';
  const corrected = { ...WINDOW, id: 'memory-corrected', content: CORRECTION };

  async function correctWith(answer: BureauHandler, content = CORRECTION) {
    const served = bureau({
      'bureau.memory.correct': answer,
      'bureau.memory.get': (params) =>
        params['id'] === corrected.id
          ? { memory: corrected, lineage: { runId: null, corrects: AISLE.id, correctedBy: null } }
          : { memory: AISLE, lineage: NO_LINEAGE },
    });
    const view = open();
    const detail = await openDetails(view, AISLE.content);
    await fireEvent.click(
      within(detail).getByRole('button', { name: MEMORY_COPY.correct.iconLabel }),
    );
    const field = within(detail).getByLabelText(MEMORY_COPY.correct.edit.label);
    // The text is edited in place, starting from the memory's own words: there is no dialog.
    expect((field as HTMLTextAreaElement).value).toBe(AISLE.content);
    expect(view.queryByRole('dialog')).toBeNull();
    expect(detail.querySelector('blockquote')).toBeNull();
    await fireEvent.input(field, { target: { value: content } });
    return { served, view, detail };
  }

  const save = (detail: HTMLElement) =>
    fireEvent.click(within(detail).getByRole('button', { name: MEMORY_COPY.correct.edit.submit }));

  test('saves a correction, opens it, and keeps the original in its history', async () => {
    const { served, view, detail } = await correctWith(() => ({ id: AISLE.id, memory: corrected }));

    await save(detail);

    expect(await view.findByText(MEMORY_COPY.correct.saved.title)).not.toBeNull();
    expect(served.callsTo('bureau.memory.correct')[0]?.params).toEqual({
      agentId: 'assistant',
      id: AISLE.id,
      content: CORRECTION,
    });
    await waitFor(() => expect(served.callsTo('bureau.memory.list').length).toBeGreaterThan(1));
    // The correction is open, its text is the new words, and its history leads back to the original.
    await waitFor(() =>
      expect(detail.querySelector('blockquote')?.textContent).toContain(CORRECTION),
    );
    await waitFor(() =>
      expect(
        within(factOf(detail, MEMORY_COPY.detail.fields.corrects)!).queryByRole('button', {
          name: MEMORY_COPY.detail.openMemory,
        }),
      ).not.toBeNull(),
    );
    expect(MEMORY_COPY.correct.saved.description).toContain('kept in its history');
  });

  test('lets the person dismiss the note that the memory was replaced', async () => {
    const { view, detail } = await correctWith(() => ({ id: AISLE.id, memory: corrected }));
    await save(detail);
    await view.findByText(MEMORY_COPY.correct.saved.title);

    await fireEvent.click(view.getByRole('button', { name: /dismiss/i }));

    expect(view.queryByText(MEMORY_COPY.correct.saved.title)).toBeNull();
  });

  test('words the server’s refusal of a memory that was already corrected', async () => {
    const { detail } = await correctWith(() => {
      throw new StubFault('Conflict', 409, 'Superseded.', { reason: 'memory-superseded' });
    });

    await save(detail);

    await waitFor(() =>
      expect(
        detail.querySelector('[data-correction-refusal]')?.getAttribute('data-correction-refusal'),
      ).toBe('superseded'),
    );
    expect(detail.textContent).toContain(MEMORY_COPY.correct.refusal.superseded.title);
  });

  test('words the refusal of a correction it does not admit, and keeps what was typed', async () => {
    const { detail } = await correctWith(() => {
      throw new StubFault('Unprocessable', 422, 'No.', { reason: 'memory-successor-not-admitted' });
    });

    await save(detail);

    await waitFor(() =>
      expect(detail.textContent).toContain(
        MEMORY_COPY.correct.refusal['successor-not-admitted'].title,
      ),
    );
    expect(
      (within(detail).getByLabelText(MEMORY_COPY.correct.edit.label) as HTMLTextAreaElement).value,
    ).toBe(CORRECTION);
  });

  test('words a missing scope, a missing memory, and any other failure', async () => {
    for (const [fault, expected] of [
      [new StubFault('Forbidden', 403, 'No.'), MEMORY_COPY.correct.refusal.forbidden.title],
      [new StubFault('NotFound', 404, 'No.'), MEMORY_COPY.correct.refusal['not-found'].title],
      [
        new StubFault('EngineFailure', 500, 'The disk is full.'),
        MEMORY_COPY.correct.refusal.other.title,
      ],
    ] as const) {
      const { detail } = await correctWith(() => {
        throw fault;
      });
      await save(detail);
      await waitFor(() => expect(detail.textContent).toContain(expected));
      cleanup();
      stub?.restore();
    }
  });

  test('puts the text back and sends nothing when it is cancelled', async () => {
    const { served, detail } = await correctWith(() => ({ id: AISLE.id, memory: corrected }));

    await fireEvent.click(
      within(detail).getByRole('button', { name: MEMORY_COPY.correct.edit.cancel }),
    );

    expect(served.callsTo('bureau.memory.correct')).toEqual([]);
    expect(detail.querySelector('blockquote')?.textContent).toContain(AISLE.content);
  });

  test('does not send a blank correction', async () => {
    const { served, detail } = await correctWith(
      () => ({ id: AISLE.id, memory: corrected }),
      '   ',
    );

    expect(
      within(detail)
        .getByRole('button', { name: MEMORY_COPY.correct.edit.submit })
        .hasAttribute('disabled'),
    ).toBe(true);
    await fireEvent.submit(detail.querySelector('form')!);

    expect(served.callsTo('bureau.memory.correct')).toEqual([]);
  });

  test('does not leave for the correction when an older correction lands after the person moved on', async () => {
    let release: (answer: unknown) => void = () => {};
    const served = bureau({
      'bureau.memory.correct': () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    });
    const view = open();
    const detail = await openDetails(view, AISLE.content);
    await fireEvent.click(
      within(detail).getByRole('button', { name: MEMORY_COPY.correct.iconLabel }),
    );
    await fireEvent.input(within(detail).getByLabelText(MEMORY_COPY.correct.edit.label), {
      target: { value: CORRECTION },
    });
    await save(detail);
    await waitFor(() => expect(served.callsTo('bureau.memory.correct')).toHaveLength(1));
    // The person moves on to another memory while the correction is still being saved.
    await fireEvent.click(rowOf(view, WINDOW.id));
    await waitFor(() => expect(router.search.get('memory')).toBe(WINDOW.id));

    release({ id: AISLE.id, memory: { ...AISLE, id: 'memory-corrected', source: 'operator' } });

    expect(await view.findByText(MEMORY_COPY.correct.saved.title)).not.toBeNull();
    expect(router.search.get('memory')).toBe(WINDOW.id);
  });
});

describe('sharing a memory', () => {
  async function shareDialog() {
    const served = bureau({
      'bureau.memory.share': (params) => ({
        id: params['id'],
        changed: true,
        granteeOwnerId: params['granteeOwnerId'],
        grantedBy: 'me',
      }),
      'bureau.memory.share.revoke': (params) => ({
        id: params['id'],
        changed: true,
        granteeOwnerId: params['granteeOwnerId'],
        grantedBy: 'me',
      }),
    });
    const view = open();
    const detail = await openDetails(view, AISLE.content);
    await fireEvent.click(
      within(detail).getByRole('button', { name: MEMORY_COPY.govern.share.action }),
    );
    const dialog = await view.findByRole('dialog', { name: MEMORY_COPY.govern.share.dialog.title });
    return { served, view, detail, dialog };
  }

  test('names the memory, shares it with the owner typed, and says the ledger records it', async () => {
    const { served, view, dialog } = await shareDialog();
    expect(dialog.textContent).toContain(
      MEMORY_COPY.govern.share.dialog.description(AISLE.content),
    );
    const submit = within(dialog).getByRole('button', {
      name: MEMORY_COPY.govern.share.dialog.submit,
    });
    // Nothing is sent for no one.
    expect(submit.hasAttribute('disabled')).toBe(true);

    await fireEvent.input(within(dialog).getByLabelText(MEMORY_COPY.govern.share.dialog.label), {
      target: { value: ' owner-two ' },
    });
    await fireEvent.click(submit);

    const title = await view.findByText(MEMORY_COPY.govern.share.outcome.granted.title);
    expect(title.hasAttribute('data-governance-outcome')).toBe(true);
    expect(view.container.textContent).toContain(MEMORY_COPY.govern.recorded);
    expect(served.callsTo('bureau.memory.share')[0]?.params).toEqual({
      agentId: 'assistant',
      id: AISLE.id,
      granteeOwnerId: 'owner-two',
    });
  });

  test('stops sharing with an owner', async () => {
    const { served, view, dialog } = await shareDialog();
    await fireEvent.input(within(dialog).getByLabelText(MEMORY_COPY.govern.share.dialog.label), {
      target: { value: 'owner-two' },
    });

    await fireEvent.click(
      within(dialog).getByRole('button', { name: MEMORY_COPY.govern.share.dialog.revoke }),
    );

    await view.findByText(MEMORY_COPY.govern.share.outcome.revoked.title);
    expect(served.callsTo('bureau.memory.share.revoke')[0]?.params).toEqual({
      agentId: 'assistant',
      id: AISLE.id,
      granteeOwnerId: 'owner-two',
    });
  });

  test('says when nothing changed, and words an owner it cannot share with', async () => {
    const served = bureau({
      'bureau.memory.share': () => {
        throw new StubFault('Unprocessable', 422, 'No.', { reason: 'memory-invalid-grantee' });
      },
      'bureau.memory.share.revoke': (params) => ({
        id: params['id'],
        changed: false,
        granteeOwnerId: params['granteeOwnerId'],
        grantedBy: 'me',
      }),
    });
    const view = open();
    const detail = await openDetails(view, AISLE.content);
    await fireEvent.click(
      within(detail).getByRole('button', { name: MEMORY_COPY.govern.share.action }),
    );
    const dialog = await view.findByRole('dialog', { name: MEMORY_COPY.govern.share.dialog.title });
    await fireEvent.input(within(dialog).getByLabelText(MEMORY_COPY.govern.share.dialog.label), {
      target: { value: 'me' },
    });

    await fireEvent.click(
      within(dialog).getByRole('button', { name: MEMORY_COPY.govern.share.dialog.submit }),
    );
    await view.findByText(MEMORY_COPY.govern.failed);
    expect(view.container.textContent).toContain(
      MEMORY_COPY.govern.refusal['invalid-grantee'].description,
    );

    await fireEvent.click(view.getByRole('button', { name: MEMORY_COPY.govern.share.action }));
    const again = await view.findByRole('dialog', { name: MEMORY_COPY.govern.share.dialog.title });
    await fireEvent.input(within(again).getByLabelText(MEMORY_COPY.govern.share.dialog.label), {
      target: { value: 'nobody' },
    });
    await fireEvent.click(
      within(again).getByRole('button', { name: MEMORY_COPY.govern.share.dialog.revoke }),
    );
    await view.findByText(MEMORY_COPY.govern.share.outcome.notShared.title);
    expect(served.callsTo('bureau.memory.share.revoke')).toHaveLength(1);
  });
});

describe('the notes about a governance change', () => {
  test('closes the share question without sending anything, and lets the person dismiss a result and a refusal', async () => {
    const served = bureau({
      'bureau.memory.hold': (params) => ({ id: params['id'], changed: true, legalHold: 'held' }),
      'bureau.memory.hold.release': () => {
        throw new StubFault('Forbidden', 403, 'No scope.');
      },
    });
    const view = open();
    const detail = await openDetails(view, AISLE.content);
    await fireEvent.click(
      within(detail).getByRole('button', { name: MEMORY_COPY.govern.share.action }),
    );
    const dialog = await view.findByRole('dialog', { name: MEMORY_COPY.govern.share.dialog.title });

    await fireEvent.click(
      within(dialog).getByRole('button', { name: MEMORY_COPY.govern.share.dialog.cancel }),
    );

    expect(served.callsTo('bureau.memory.share')).toEqual([]);
    await fireEvent.click(
      within(detail).getByRole('button', { name: MEMORY_COPY.govern.hold.place }),
    );
    await view.findByText(MEMORY_COPY.govern.hold.outcome.placed.title);
    await fireEvent.click(view.getByRole('button', { name: /dismiss/i }));
    expect(view.queryByText(MEMORY_COPY.govern.hold.outcome.placed.title)).toBeNull();

    await fireEvent.click(
      within(detail).getByRole('button', { name: MEMORY_COPY.govern.hold.release }),
    );
    await view.findByText(MEMORY_COPY.govern.failed);
    await fireEvent.click(view.getByRole('button', { name: /dismiss/i }));
    expect(view.queryByText(MEMORY_COPY.govern.failed)).toBeNull();
  });
});

describe('the legal hold', () => {
  const hold =
    (held: boolean, changed = true): BureauHandler =>
    (params) => ({
      id: params['id'],
      changed,
      legalHold: held ? 'held' : 'released',
    });

  test('is placed and released from the details, and shown only once it is known', async () => {
    const served = bureau({
      'bureau.memory.hold': hold(true),
      'bureau.memory.hold.release': hold(false),
    });
    const view = open();
    const detail = await openDetails(view, AISLE.content);
    expect(factOf(detail, MEMORY_COPY.detail.fields.legalHold)).toBeNull();

    await fireEvent.click(
      within(detail).getByRole('button', { name: MEMORY_COPY.govern.hold.place }),
    );

    await view.findByText(MEMORY_COPY.govern.hold.outcome.placed.title);
    expect(view.container.textContent).toContain(MEMORY_COPY.govern.recorded);
    expect(served.callsTo('bureau.memory.hold')[0]?.params).toEqual({
      agentId: 'assistant',
      id: AISLE.id,
    });
    expect(textOf(factOf(detail, MEMORY_COPY.detail.fields.legalHold))).toBe(
      MEMORY_COPY.detail.legalHold.held,
    );

    await fireEvent.click(
      within(detail).getByRole('button', { name: MEMORY_COPY.govern.hold.release }),
    );

    await view.findByText(MEMORY_COPY.govern.hold.outcome.released.title);
    expect(served.callsTo('bureau.memory.hold.release')).toHaveLength(1);
    expect(textOf(factOf(detail, MEMORY_COPY.detail.fields.legalHold))).toBe(
      MEMORY_COPY.detail.legalHold.free,
    );
  });

  test('says when a hold was already placed, and when a release found none', async () => {
    bureau({
      'bureau.memory.hold': hold(true, false),
      'bureau.memory.hold.release': hold(false, false),
    });
    const view = open();
    const detail = await openDetails(view, AISLE.content);

    await fireEvent.click(
      within(detail).getByRole('button', { name: MEMORY_COPY.govern.hold.place }),
    );
    await view.findByText(MEMORY_COPY.govern.hold.outcome.alreadyPlaced.title);
    await fireEvent.click(
      within(detail).getByRole('button', { name: MEMORY_COPY.govern.hold.release }),
    );
    await view.findByText(MEMORY_COPY.govern.hold.outcome.notHeld.title);
  });

  test('words a missing scope', async () => {
    bureau({
      'bureau.memory.hold': () => {
        throw new StubFault('Forbidden', 403, 'No scope.');
      },
    });
    const view = open();
    const detail = await openDetails(view, AISLE.content);

    await fireEvent.click(
      within(detail).getByRole('button', { name: MEMORY_COPY.govern.hold.place }),
    );

    await view.findByText(MEMORY_COPY.govern.failed);
    expect(view.container.textContent).toContain(MEMORY_COPY.govern.refusal.forbidden.description);
  });
});

describe('quarantining a memory', () => {
  async function quarantineDialog(extra: Answers = {}) {
    const served = bureau({
      'bureau.memory.quarantine': (params) => ({ id: params['id'], changed: true, affected: 2 }),
      ...extra,
    });
    const view = open();
    const detail = await openDetails(view, AISLE.content);
    await fireEvent.click(
      within(detail).getByRole('button', { name: MEMORY_COPY.govern.quarantine.action }),
    );
    const dialog = await view.findByRole('dialog', {
      name: MEMORY_COPY.govern.quarantine.dialog.title,
    });
    return { served, view, detail, dialog };
  }

  test('names the memory, says it cannot be undone, and needs a reason', async () => {
    const { served, dialog } = await quarantineDialog();

    expect(dialog.textContent).toContain(AISLE.content.slice(0, 20));
    expect(dialog.textContent).toContain('This cannot be undone.');
    const confirm = within(dialog).getByRole('button', {
      name: MEMORY_COPY.govern.quarantine.dialog.confirm,
    });
    expect(confirm.hasAttribute('disabled')).toBe(true);
    await fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(served.callsTo('bureau.memory.quarantine')).toEqual([]);
  });

  test('quarantines with the reason, closes the details, and says how many records were reached', async () => {
    const { served, view, dialog } = await quarantineDialog();
    await fireEvent.input(
      within(dialog).getByLabelText(MEMORY_COPY.govern.quarantine.dialog.reasonLabel),
      { target: { value: '  It is wrong.  ' } },
    );

    await fireEvent.click(
      within(dialog).getByRole('button', { name: MEMORY_COPY.govern.quarantine.dialog.confirm }),
    );

    const title = await view.findByText(MEMORY_COPY.govern.quarantine.outcome.done.title);
    expect(title).not.toBeNull();
    expect(view.container.textContent).toContain(
      MEMORY_COPY.govern.quarantine.outcome.done.description(2),
    );
    expect(served.callsTo('bureau.memory.quarantine')[0]?.params).toEqual({
      agentId: 'assistant',
      id: AISLE.id,
      reason: 'It is wrong.',
    });
    await waitFor(() =>
      expect(view.container.querySelector('[data-memory-detail]')?.outerHTML ?? null).toBeNull(),
    );
    await waitFor(() => expect(served.callsTo('bureau.memory.list').length).toBeGreaterThan(1));
  });

  test('says when it was already quarantined', async () => {
    const { view, dialog } = await quarantineDialog({
      'bureau.memory.quarantine': (params) => ({ id: params['id'], changed: false, affected: 0 }),
    });
    await fireEvent.input(
      within(dialog).getByLabelText(MEMORY_COPY.govern.quarantine.dialog.reasonLabel),
      { target: { value: 'Again.' } },
    );

    await fireEvent.click(
      within(dialog).getByRole('button', { name: MEMORY_COPY.govern.quarantine.dialog.confirm }),
    );

    await view.findByText(MEMORY_COPY.govern.quarantine.outcome.already.title);
  });

  test('words a memory that is not there', async () => {
    const { view, dialog } = await quarantineDialog({
      'bureau.memory.quarantine': () => {
        throw new StubFault('NotFound', 404, 'No memory.');
      },
    });
    await fireEvent.input(
      within(dialog).getByLabelText(MEMORY_COPY.govern.quarantine.dialog.reasonLabel),
      { target: { value: 'Gone.' } },
    );

    await fireEvent.click(
      within(dialog).getByRole('button', { name: MEMORY_COPY.govern.quarantine.dialog.confirm }),
    );

    await view.findByText(MEMORY_COPY.govern.failed);
    expect(view.container.textContent).toContain(
      MEMORY_COPY.correct.refusal['not-found'].description,
    );
  });
});

describe('exporting the memories', () => {
  test('exports every memory of the agent to a file, and says the ledger records it', async () => {
    const served = bureau({
      'bureau.memory.export': () => ({ exportId: 'export-1', memories: [AISLE, WINDOW] }),
    });
    const originalCreate = URL.createObjectURL;
    const originalRevoke = URL.revokeObjectURL;
    const created: Blob[] = [];
    URL.createObjectURL = mock((blob: Blob) => {
      created.push(blob);
      return 'blob:memories';
    });
    URL.revokeObjectURL = mock(() => {});
    try {
      const view = open();
      await view.findByText(AISLE.content);

      await fireEvent.click(view.getByRole('button', { name: MEMORY_COPY.govern.export.action }));

      await view.findByText(MEMORY_COPY.govern.export.outcome.title);
      expect(view.container.textContent).toContain(
        MEMORY_COPY.govern.export.outcome.description(2, 'export-1'),
      );
      expect(view.container.textContent).toContain(MEMORY_COPY.govern.recorded);
      expect(served.callsTo('bureau.memory.export')[0]?.params).toEqual({ agentId: 'assistant' });
      expect(created).toHaveLength(1);
      expect(JSON.parse(await created[0]!.text())).toEqual([AISLE, WINDOW]);
    } finally {
      URL.createObjectURL = originalCreate;
      URL.revokeObjectURL = originalRevoke;
    }
  });

  test('says when an export could not be made', async () => {
    bureau({
      'bureau.memory.export': () => {
        throw new StubFault('Forbidden', 403, 'No scope.');
      },
    });
    const view = open();
    await view.findByText(AISLE.content);

    await fireEvent.click(view.getByRole('button', { name: MEMORY_COPY.govern.export.action }));

    await view.findByText(MEMORY_COPY.govern.failed);
  });
});

describe('the agent’s page', () => {
  test('links to its memory, which keeps the Agents view', async () => {
    bureau({ 'bureau.agents.list': () => ({ agents: [AGENT] }) });
    stub?.on('bureau.contexts.list', () => ({ contexts: [], nextOffset: null }));
    landAt('/agents/assistant');
    const { findByRole } = mount(AgentDetail);

    const link = await findByRole('link', { name: MEMORY_COPY.link });
    expect(link.getAttribute('href')).toBe('/agents/assistant/memories');
    link.click();

    expect(router.pathname).toBe('/agents/assistant/memories');
    expect(router.current.route?.view).toBe('agents');
    expect(router.current.params['agent']).toBe('assistant');
  });
});
