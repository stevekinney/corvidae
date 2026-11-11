/**
 * The Memory tab of an agent's page (`/agents/:agent/memory`) against a stand-in for the server's
 * memory operations: the list with the open memory beside it (`?selected=`), the search that runs as
 * you type, the kind and writer filters, one memory's rows (Came from, Written by, History), adding
 * a memory (with its Undo toast), what forgetting answers in each of the deletion's states,
 * correcting in place (the original is kept in the history), and the governance actions (share,
 * hold, quarantine, export). The tab words its own first load and its failure in its body
 * (`agent-tab-state.svelte`); the Agents view's frame owns not-found (`app/view-frame.test.ts`).
 * The real server is exercised in the Playwright suite. Row 45r (forget at once, with an Undo that
 * restores it) waits for a Bureau operation that restores a forgotten memory, which does not exist.
 */
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/svelte';
import { afterEach, describe, expect, mock, test } from 'bun:test';

import { AGENT_PAGE_COPY, MEMORY_COPY, RETRY_LABEL } from '../../app/copy.ts';
import {
  installBureauStub,
  StubFault,
  type BureauHandler,
  type BureauStub,
} from '../../lib/bureau-stub.test-support.ts';
import { router } from '../../lib/router.svelte.ts';
import { AGENT, CONTEXT, landAt } from '../chat/pages.test-support.ts';
import AgentDetail from './agent-detail.svelte';
import FramedMemory from './agent-memory-frame.test-harness.svelte';
import MemoryToasts from './agent-memory-toasts.test-harness.svelte';
import AgentMemory from './agent-memory.svelte';

let stub: BureauStub | undefined;
afterEach(() => {
  cleanup();
  stub?.restore();
  stub = undefined;
});

const mount = (page: unknown) => render(MemoryToasts, { props: { page } } as never);

/** What the agent is called where the page names it (`AGENT` in the shared support). */
const AGENT_NAME = 'Assistant';
/** The words of the add dialog, which name the agent. */
const ADD_LABEL = MEMORY_COPY.add.dialog.label(AGENT_NAME);
/** What the toast says after a memory was added. */
const ADDED_TOAST = MEMORY_COPY.add.saved(AGENT_NAME);
/** The title of the chat the first memory came from, and the link that names it. */
const CHAT_TITLE = 'Where is order 4398?';
const CHAT_LINK = MEMORY_COPY.detail.cameFrom.chat(CHAT_TITLE);

/** A fact the agent wrote from a chat. */
const AISLE = {
  id: 'memory-aisle',
  content: 'The user prefers aisle seats.',
  memoryClass: 'episodic',
  kind: 'fact',
  source: 'conversation',
  writer: 'agent',
  trust: 'untrusted',
  createdAt: '2026-10-19T08:00:00.000Z',
  sessionId: 'session-1',
};
/** A fact the person wrote. */
const WINDOW = {
  ...AISLE,
  id: 'memory-window',
  content: 'The user prefers window seats.',
  memoryClass: 'semantic',
  source: 'operator',
  writer: 'person',
  trust: 'verified',
  sessionId: null,
};
/** A how-to the agent wrote. */
const RECIPE = {
  ...AISLE,
  id: 'memory-recipe',
  content: 'To book a flight, ask for the date first.',
  memoryClass: 'procedural',
  kind: 'how-to',
};
/** A fact the agent wrote, and a second one, so the writer filter has a person's memory to hide. */
const FACT = {
  ...AISLE,
  id: 'memory-fact',
  content: 'The user lives in Lisbon.',
  memoryClass: 'semantic',
};
const NO_LINEAGE = { runId: null, corrects: null, correctedBy: null };
/** What `bureau.memory.get` answers for a memory: the lineage and the versions a correction replaced. */
const detailOf_ = (
  memory: unknown,
  lineage: {
    runId: string | null;
    corrects: string | null;
    correctedBy: string | null;
  } = NO_LINEAGE,
  history: unknown[] = [],
): { memory: unknown; lineage: typeof lineage; history: unknown[] } => ({
  memory,
  lineage,
  history,
});

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
    'bureau.memory.get': (params) => detailOf_(params['id'] === WINDOW.id ? WINDOW : AISLE),
    'bureau.contexts.get': () => ({ ...CONTEXT, title: CHAT_TITLE }),
    ...answers,
  });
  return stub;
}

function open(path = '/agents/assistant/memory') {
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
  // The governance actions sit under "More options": open it, as a person does to reach them.
  const more = region.querySelector<HTMLDetailsElement>('details');
  if (more !== null) more.open = true;
  return region;
}

/** The value of a fact in the details, found by its term. */
const factOf = (detail: HTMLElement, term: string): HTMLElement | null =>
  (within(detail).queryByText(term, { selector: 'dt' })?.nextElementSibling as
    HTMLElement | undefined) ?? null;

describe('the list', () => {
  test('lists what the agent remembers, newest first, in two lines: the text, then its kind, writer and time', async () => {
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
    // Line two says what it is, who wrote it and when, joined by commas and with no status dot.
    const line = (row: Element | undefined) => textOf(row?.querySelector('[data-memory-line]'));
    expect(line(rows[0])).toMatch(new RegExp(`^${MEMORY_COPY.kind.fact}, From ${AGENT_NAME}, `));
    expect(line(rows[1])).toMatch(new RegExp(`^${MEMORY_COPY.kind.fact}, From you, `));
    expect(line(rows[0])).not.toContain(String.fromCodePoint(0xb7));
    // The engine's own terms are nowhere in the list.
    for (const engine of ['Semantic', 'Episodic', 'Procedural', 'Operator']) {
      expect(rows[0]?.textContent).not.toContain(engine);
    }
    expect(rows[0]?.querySelector('[data-cinder-status], .cinder-badge')).toBeNull();
  });

  test('is a list with the open memory beside it: search, the two filters, a plus and Export sit in its own header', async () => {
    bureau();
    const view = open();
    await view.findByText(AISLE.content);

    const list = view.getByRole('region', { name: MEMORY_COPY.listLabel });
    // The tab bar names the tab, so the list repeats no heading of its own (sweep S51).
    expect(within(list).queryByRole('heading', { level: 1 })).toBeNull();
    expect(within(list).getByRole('button', { name: MEMORY_COPY.add.action })).not.toBeNull();
    expect(
      within(list).getByRole('button', { name: MEMORY_COPY.govern.export.action }),
    ).not.toBeNull();
    expect(within(list).getByRole('searchbox', { name: MEMORY_COPY.searchLabel })).not.toBeNull();
    expect(within(list).getByLabelText(MEMORY_COPY.filter.kindLabel)).not.toBeNull();
    expect(within(list).getByLabelText(MEMORY_COPY.filter.writerLabel)).not.toBeNull();
    // Nothing is open, and a row has no actions of its own.
    expect(view.getByText(MEMORY_COPY.nothingOpen.title)).not.toBeNull();
    expect(within(rowOf(view, AISLE.id).closest('li')!).queryAllByRole('button')).toHaveLength(1);
    expect(view.queryByRole('button', { name: /^Back to/ })).toBeNull();
  });

  test('shows the two filters as selects that read Kind: All and Written by: Anyone', async () => {
    bureau();
    const view = open();
    await view.findByText(AISLE.content);

    const kind = view.getByLabelText<HTMLSelectElement>(MEMORY_COPY.filter.kindLabel);
    const writer = view.getByLabelText<HTMLSelectElement>(MEMORY_COPY.filter.writerLabel);

    // Each starts on its first choice, which reads "Kind: All" and "Written by: Anyone".
    expect(kind.value).toBe('all');
    expect(writer.value).toBe('all');
    expect(kind.querySelector('option')?.textContent).toBe(MEMORY_COPY.filter.kind.all);
    expect([...writer.querySelectorAll('option')].map((option) => option.textContent)).toEqual([
      MEMORY_COPY.filter.writer.all,
      MEMORY_COPY.filter.writer.you,
      MEMORY_COPY.filter.writer.agent(AGENT_NAME),
    ]);
  });

  test('hides Export and the header’s plus for an agent with no memory, whose empty state holds the one Add a memory', async () => {
    bureau({ 'bureau.memory.list': () => ({ memories: [], nextOffset: null }) });
    const view = open();

    const heading = await view.findByText(MEMORY_COPY.nothing.title, { selector: 'h2' });

    expect(view.queryByRole('button', { name: MEMORY_COPY.govern.export.action })).toBeNull();
    const adds = view.getAllByRole('button', { name: MEMORY_COPY.add.action });
    expect(adds).toHaveLength(1);
    expect(heading.closest('[data-cinder-kind]')?.contains(adds[0] ?? null)).toBe(true);
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

    // Nothing was read, so the tab's body says it could not load, under the header and the tabs.
    await findByText(AGENT_PAGE_COPY.tabState.failedTitle);
    await findByText(AGENT_PAGE_COPY.tabState.failedDescription(500));
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
    const { container, findByTestId, findByText, getByLabelText } = open();
    await findByText(AISLE.content);

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
    const { findByTestId, findByText, getByLabelText } = open();
    await findByText(AISLE.content);

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

describe('the kind and writer filters', () => {
  const MIXED = [AISLE, WINDOW, RECIPE, FACT];

  async function mixed() {
    const served = bureau({ 'bureau.memory.list': () => ({ memories: MIXED, nextOffset: null }) });
    const view = open();
    await view.findByText(FACT.content);
    return { served, view };
  }

  const chooseKind = (view: ReturnType<typeof open>, value: string) =>
    fireEvent.change(view.getByLabelText(MEMORY_COPY.filter.kindLabel), { target: { value } });

  const chooseWriter = (view: ReturnType<typeof open>, value: string) =>
    fireEvent.change(view.getByLabelText(MEMORY_COPY.filter.writerLabel), { target: { value } });

  const shownIds = (view: ReturnType<typeof open>) =>
    [...view.container.querySelectorAll('[data-memory]')].map((row) =>
      row.getAttribute('data-memory'),
    );

  test('names the kinds Fact and How-to, and keeps the engine’s terms out of the list', async () => {
    const { view } = await mixed();
    const select = view.getByLabelText(MEMORY_COPY.filter.kindLabel);

    expect([...select.querySelectorAll('option')].map((option) => option.textContent)).toEqual([
      MEMORY_COPY.filter.kind.all,
      MEMORY_COPY.filter.kind.fact,
      MEMORY_COPY.filter.kind.howTo,
    ]);
    const list = view.getByRole('region', { name: MEMORY_COPY.listLabel });
    for (const engine of ['Semantic', 'Episodic', 'Procedural', 'Operator']) {
      expect(list.textContent).not.toContain(engine);
    }
  });

  for (const [value, expected] of [
    ['fact', ['memory-aisle', 'memory-window', 'memory-fact']],
    ['how-to', ['memory-recipe']],
    ['all', ['memory-aisle', 'memory-window', 'memory-recipe', 'memory-fact']],
  ] as const) {
    test(`narrows the list to the kind ${value}`, async () => {
      const { view } = await mixed();

      await chooseKind(view, value);

      await waitFor(() => expect(shownIds(view)).toEqual([...expected]));
    });
  }

  for (const [value, expected] of [
    ['you', ['memory-window']],
    ['agent', ['memory-aisle', 'memory-recipe', 'memory-fact']],
    ['all', ['memory-aisle', 'memory-window', 'memory-recipe', 'memory-fact']],
  ] as const) {
    test(`narrows the list to what ${value} wrote`, async () => {
      const { view } = await mixed();

      await chooseWriter(view, value);

      await waitFor(() => expect(shownIds(view)).toEqual([...expected]));
    });
  }

  test('works together: a kind and a writer both narrow the list', async () => {
    const { view } = await mixed();

    await chooseKind(view, 'fact');
    await chooseWriter(view, 'agent');

    await waitFor(() => expect(shownIds(view)).toEqual(['memory-aisle', 'memory-fact']));
  });

  test('says it works over the memories loaded so far while pages are left', async () => {
    bureau({ 'bureau.memory.list': () => ({ memories: MIXED, nextOffset: 4 }) });
    const view = open();
    await view.findByText(FACT.content);

    await chooseKind(view, 'how-to');

    expect(textOf(await view.findByTestId('memory-kind-note'))).toBe(
      MEMORY_COPY.filter.note(1, 4, true),
    );
    expect(MEMORY_COPY.filter.note(1, 4, true)).toContain('loaded so far');
  });

  test('says no loaded memory matches the filters, with a way back to every memory', async () => {
    bureau({ 'bureau.memory.list': () => ({ memories: [AISLE], nextOffset: null }) });
    const view = open();
    await view.findByText(AISLE.content);

    await chooseKind(view, 'how-to');

    await view.findByText(MEMORY_COPY.noFiltered.title, { selector: 'h2' });
    await fireEvent.click(view.getByRole('button', { name: MEMORY_COPY.clearMatch }));
    await view.findByText(AISLE.content);
    expect((view.getByLabelText(MEMORY_COPY.filter.kindLabel) as HTMLSelectElement).value).toBe(
      'all',
    );
    expect((view.getByLabelText(MEMORY_COPY.filter.writerLabel) as HTMLSelectElement).value).toBe(
      'all',
    );
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
    await chooseWriter(view, 'you');

    await waitFor(() => expect(shownIds(view)).toEqual(['memory-window']));
  });
});

describe('one memory', () => {
  test('leads with its kind and when and the two icon buttons, then its text as a heading, then Came from, Written by and History', async () => {
    bureau();
    const view = open();
    const detail = await openDetails(view, AISLE.content);

    expect(textOf(detail.querySelector('h2'))).toBe(AISLE.content);
    // "Fact, remembered <when>", muted, with the commas the page uses in place of a middle dot.
    const context = textOf(detail.querySelector('[data-memory-context]'));
    expect(context).toMatch(new RegExp(`^${MEMORY_COPY.kind.fact}, remembered `));
    expect(detail.textContent).not.toContain(String.fromCodePoint(0xb7));
    expect(
      within(detail).getByRole('button', { name: MEMORY_COPY.correct.iconLabel }),
    ).not.toBeNull();
    expect(
      within(detail).getByRole('button', { name: MEMORY_COPY.forget.iconLabel }),
    ).not.toBeNull();
    // The agent wrote it from a chat, so the rows say which chat, who wrote it, and its history.
    expect([...detail.querySelectorAll('dt')].map((term) => textOf(term))).toEqual([
      MEMORY_COPY.detail.fields.cameFrom,
      MEMORY_COPY.detail.fields.writtenBy,
      MEMORY_COPY.detail.fields.history,
    ]);
    expect(textOf(factOf(detail, MEMORY_COPY.detail.fields.writtenBy))).toBe(AGENT_NAME);
    expect(textOf(factOf(detail, MEMORY_COPY.detail.fields.history))).toBe(
      MEMORY_COPY.detail.history.none,
    );
    // The chat is a link inside the app, named by the chat's title.
    const chat = await waitFor(() =>
      within(factOf(detail, MEMORY_COPY.detail.fields.cameFrom)!).getByRole('link'),
    );
    expect(chat.getAttribute('href')).toBe('/chats/session-1');
    expect(textOf(chat)).toBe(CHAT_LINK);
    // Trust follows from the writer, and the engine's terms, the run and the time are not rows.
    for (const term of ['Trust', 'Source', 'Kind', 'Run', 'Created']) {
      expect(factOf(detail, term)).toBeNull();
    }
    expect(detail.textContent).not.toContain('Untrusted');
    expect(detail.textContent).not.toContain('Episodic');
  });

  test('shows a memory you wrote as Written by You, with no Came from row and no legal hold yet', async () => {
    bureau();
    const view = open();
    const detail = await openDetails(view, WINDOW.content);

    expect(factOf(detail, MEMORY_COPY.detail.fields.cameFrom)).toBeNull();
    expect(textOf(factOf(detail, MEMORY_COPY.detail.fields.writtenBy))).toBe(
      MEMORY_COPY.writer.person.detail,
    );
    expect(textOf(factOf(detail, MEMORY_COPY.detail.fields.history))).toBe(
      MEMORY_COPY.detail.history.none,
    );
    // Nothing has said whether it is held, so the page does not guess.
    expect(factOf(detail, MEMORY_COPY.detail.fields.legalHold)).toBeNull();
  });

  test('says no chat is on record for a memory an agent wrote with none, in muted text', async () => {
    const orphan = { ...AISLE, sessionId: null };
    bureau({
      'bureau.memory.list': () => ({ memories: [orphan], nextOffset: null }),
      'bureau.memory.get': () => detailOf_(orphan),
    });
    const view = open();
    const detail = await openDetails(view, orphan.content);

    const value = factOf(detail, MEMORY_COPY.detail.fields.cameFrom);
    expect(textOf(value)).toBe(MEMORY_COPY.detail.cameFrom.notRecorded);
    expect(value?.querySelector('a')).toBeNull();
  });

  test('says the chat a memory came from was deleted, as muted text rather than a link, and keeps the memory listed', async () => {
    const served = bureau({
      'bureau.contexts.get': () => {
        throw new StubFault('NotFound', 404, 'No chat.', { resource: 'session' });
      },
    });
    const view = open();
    const detail = await openDetails(view, AISLE.content);

    const value = factOf(detail, MEMORY_COPY.detail.fields.cameFrom);
    await within(detail).findByText(MEMORY_COPY.detail.cameFrom.deleted);
    expect(textOf(value)).toBe(MEMORY_COPY.detail.cameFrom.deleted);
    expect(value?.querySelector('a')).toBeNull();
    expect(value?.querySelector('[data-came-from="deleted"]')).not.toBeNull();
    // The same pencil and trash as every other memory, and the memory is still in the list.
    expect(
      within(detail).getByRole('button', { name: MEMORY_COPY.correct.iconLabel }),
    ).not.toBeNull();
    expect(
      within(detail).getByRole('button', { name: MEMORY_COPY.forget.iconLabel }),
    ).not.toBeNull();
    expect(rowOf(view, AISLE.id)).not.toBeNull();
    expect(served.callsTo('bureau.contexts.get')[0]?.params).toEqual({ contextId: 'session-1' });
  });

  test('keeps the chat link, named plainly, when the chat could not be read for another reason', async () => {
    bureau({
      'bureau.contexts.get': () => {
        throw new StubFault('EngineFailure', 500, 'The server broke.');
      },
    });
    const view = open();
    const detail = await openDetails(view, AISLE.content);

    const link = await waitFor(() =>
      within(factOf(detail, MEMORY_COPY.detail.fields.cameFrom)!).getByRole('link'),
    );
    expect(textOf(link)).toBe(MEMORY_COPY.detail.cameFrom.openChat);
  });

  test('wraps a long memory in the detail and clamps its row to two lines', async () => {
    const long = {
      ...WINDOW,
      id: 'memory-long',
      content:
        'Customers in the EU must be told the refund can take up to 14 days to reach their account, even when the order was paid for by card.',
      kind: 'how-to',
      memoryClass: 'procedural',
    };
    bureau({
      'bureau.memory.list': () => ({ memories: [long], nextOffset: null }),
      'bureau.memory.get': () => detailOf_(long),
    });
    const view = open();
    const detail = await openDetails(view, long.content);

    // The detail shows the whole text; the row's own text carries the two-line clamp.
    expect(textOf(detail.querySelector('h2'))).toBe(long.content);
    expect(rowOf(view, long.id).querySelector('.ib-memory__content')).not.toBeNull();
    const line = textOf(rowOf(view, long.id).querySelector('[data-memory-line]'));
    expect(line).toMatch(new RegExp(`^${MEMORY_COPY.kind['how-to']}, From you, `));
  });

  test('keeps the open memory in the address, and opens the one the address names', async () => {
    bureau();
    const view = open('/agents/assistant/memory?selected=memory-window');

    const detail = await view.findByRole('region', { name: MEMORY_COPY.detail.heading });
    await waitFor(() =>
      expect(detail.querySelector('[data-memory-text]')?.textContent).toContain(WINDOW.content),
    );
    await fireEvent.click(rowOf(view, AISLE.id));
    await waitFor(() => expect(router.search.get('selected')).toBe(AISLE.id));
    // The tab stays the Memory tab: only the query names the memory.
    expect(router.pathname).toBe('/agents/assistant/memory');
    expect(router.current.route?.pattern).toBe('/agents/:agent/memory');
  });

  test('writes an identifier that is not a plain word into the address whole, and reads it back', async () => {
    const odd = { ...AISLE, id: 'memory/with space?and#more', content: 'An odd identifier.' };
    bureau({ 'bureau.memory.list': () => ({ memories: [odd], nextOffset: null }) });
    const view = open();

    await fireEvent.click(await waitFor(() => rowOf(view, odd.id)));
    await waitFor(() => expect(router.search.get('selected')).toBe(odd.id));
    expect(router.pathname).toBe('/agents/assistant/memory');
    expect(router.search.toString()).toBe(new URLSearchParams({ selected: odd.id }).toString());
  });

  test('stays on the memory page, with the same typed search, when a memory is chosen', async () => {
    const served = bureau({
      'bureau.memory.search': () => ({ hits: [{ memory: AISLE, score: 0.9 }] }),
    });
    const view = open();
    await view.findByText(AISLE.content);
    const search = view.getByRole('searchbox', { name: MEMORY_COPY.searchLabel });
    await fireEvent.input(search, { target: { value: 'aisle' } });
    await waitFor(() =>
      expect(served.calls.some((call) => call.method === 'bureau.memory.search')).toBe(true),
    );

    await fireEvent.click(rowOf(view, AISLE.id));
    await waitFor(() => expect(router.search.get('selected')).toBe(AISLE.id));

    // Choosing a memory is not a new page: what was typed is still in the box.
    expect((search as HTMLInputElement).value).toBe('aisle');
  });

  test('shows the list alone when the address stops naming a memory, as Back does', async () => {
    bureau();
    const view = open(`/agents/assistant/memory?selected=${AISLE.id}`);
    await view.findByRole('region', { name: MEMORY_COPY.detail.heading });

    router.navigate('/agents/assistant/memory');

    await view.findByText(MEMORY_COPY.nothingOpen.title);
    expect(view.container.querySelector('[data-memory-detail]')).toBeNull();
  });

  test('opens the memory a correction replaced from its History row, though no list holds it', async () => {
    const ORIGINAL = {
      ...AISLE,
      id: 'memory-original',
      content: 'The user prefers the middle seat.',
    };
    const served = bureau({
      'bureau.memory.list': () => ({ memories: [WINDOW], nextOffset: null }),
      'bureau.memory.get': (params) =>
        params['id'] === ORIGINAL.id
          ? detailOf_(ORIGINAL, { runId: null, corrects: null, correctedBy: WINDOW.id })
          : detailOf_(WINDOW, { runId: null, corrects: ORIGINAL.id, correctedBy: null }, [
              {
                id: ORIGINAL.id,
                content: ORIGINAL.content,
                kind: 'fact',
                writer: 'agent',
                trust: 'untrusted',
                writtenAt: ORIGINAL.createdAt,
                correctedAt: WINDOW.createdAt,
              },
            ]),
    });
    const view = open();
    const detail = await openDetails(view, WINDOW.content);

    // The row says what was corrected, in the original's own words, and leads to it.
    const history = factOf(detail, MEMORY_COPY.detail.fields.history)!;
    expect(textOf(history)).toContain(MEMORY_COPY.detail.history.corrects(ORIGINAL.content));
    await fireEvent.click(
      within(history).getByRole('button', { name: MEMORY_COPY.detail.history.original }),
    );

    await waitFor(() =>
      expect(detail.querySelector('[data-memory-text]')?.textContent).toContain(ORIGINAL.content),
    );
    expect(served.callsTo('bureau.memory.get').map((call) => call.params['id'])).toContain(
      ORIGINAL.id,
    );
    // It leads the list while it is open, and the link back reaches the correction.
    expect(rowOf(view, ORIGINAL.id).textContent).toContain(ORIGINAL.content);
    await fireEvent.click(
      within(factOf(detail, MEMORY_COPY.detail.fields.history)!).getByRole('button', {
        name: MEMORY_COPY.detail.history.correction,
      }),
    );
    await waitFor(() =>
      expect(detail.querySelector('[data-memory-text]')?.textContent).toContain(WINDOW.content),
    );
  });

  test('follows the chat link inside the app, and leaves a modified click to the browser', async () => {
    bureau();
    const view = open();
    const detail = await openDetails(view, AISLE.content);
    const link = await within(detail).findByRole('link', { name: CHAT_LINK });

    link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, metaKey: true }));
    expect(router.pathname).toBe('/agents/assistant/memory');
    expect(router.search.get('selected')).toBe(AISLE.id);
    link.click();

    expect(router.pathname).toBe('/chats/session-1');
  });

  test('keeps a row for a memory the list does not hold while it is read, and says when it cannot be', async () => {
    bureau({ 'bureau.memory.get': () => new Promise(() => {}) });
    const view = open('/agents/assistant/memory?selected=memory-elsewhere');

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
    const failed = open('/agents/assistant/memory?selected=memory-elsewhere');
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
        return detailOf_(AISLE);
      },
    });
    const view = open();
    const text = await view.findByText(AISLE.content);
    await fireEvent.click(text.closest('button')!);

    await view.findByText(MEMORY_COPY.detail.failed);
    failing = undefined;
    await fireEvent.click(view.getByRole('button', { name: RETRY_LABEL }));
    await waitFor(() => expect(view.container.querySelector('[data-memory-text]')).not.toBeNull());
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
        return detailOf_(AISLE);
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

  test('opens the next memory when the open one is forgotten, and reads the list again', async () => {
    const { served, view } = await forgetWith('completed');

    await view.findByText(MEMORY_COPY.forget.outcome.completed.title);

    // The memory after it in the list opens in its place.
    await waitFor(() => expect(router.search.get('selected')).toBe(WINDOW.id));
    await waitFor(() =>
      expect(
        view.container.querySelector(`[data-memory-detail="${WINDOW.id}"]`)?.outerHTML ?? null,
      ).not.toBeNull(),
    );
    await waitFor(() => expect(served.callsTo('bureau.memory.list').length).toBeGreaterThan(1));
  });

  test('opens the memory before it when the last one in the list is forgotten', async () => {
    let remaining = [AISLE, WINDOW];
    bureau({
      'bureau.memory.list': () => ({ memories: remaining, nextOffset: null }),
      'bureau.memory.forget': (params) => {
        remaining = remaining.filter((memory) => memory.id !== params['id']);
        return { id: params['id'], deletion: 'completed', receipt: RECEIPT };
      },
    });
    const view = open(`/agents/assistant/memory?selected=${WINDOW.id}`);
    const detail = await view.findByRole('region', { name: MEMORY_COPY.detail.heading });
    await waitFor(() => expect(detail.querySelector('[data-memory-detail]')).not.toBeNull());

    await fireEvent.click(
      within(detail).getByRole('button', { name: MEMORY_COPY.forget.iconLabel }),
    );
    const dialog = await view.findByRole('dialog', { name: MEMORY_COPY.forget.dialog.title });
    await fireEvent.click(
      within(dialog).getByRole('button', { name: MEMORY_COPY.forget.dialog.confirm }),
    );

    await waitFor(() => expect(router.search.get('selected')).toBe(AISLE.id));
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
    landAt('/agents/assistant/memory');
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
    expect(await view.findByText(MEMORY_COPY.nothing.title, { selector: 'h2' })).not.toBeNull();
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
          ? detailOf_(corrected, { runId: null, corrects: AISLE.id, correctedBy: null }, [
              {
                id: AISLE.id,
                content: AISLE.content,
                kind: 'fact',
                writer: 'agent',
                trust: 'untrusted',
                writtenAt: AISLE.createdAt,
                correctedAt: corrected.createdAt,
              },
            ])
          : detailOf_(AISLE),
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
    expect(detail.querySelector('[data-memory-text]')).toBeNull();
    // The original stays in History, as the form says.
    expect(within(detail).getByText(MEMORY_COPY.correct.edit.description)).not.toBeNull();
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
      expect(detail.querySelector('[data-memory-text]')?.textContent).toContain(CORRECTION),
    );
    await waitFor(() =>
      expect(
        within(factOf(detail, MEMORY_COPY.detail.fields.history)!).queryByRole('button', {
          name: MEMORY_COPY.detail.history.original,
        }),
      ).not.toBeNull(),
    );
    // A person has now vouched for it: the corrected memory reads Written by You.
    expect(textOf(factOf(detail, MEMORY_COPY.detail.fields.writtenBy))).toBe(
      MEMORY_COPY.writer.person.detail,
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
    const { view, detail } = await correctWith(() => {
      throw new StubFault('Conflict', 409, 'Superseded.', { reason: 'memory-superseded' });
    });

    await save(detail);

    await waitFor(() =>
      expect(
        view.container
          .querySelector('[data-correction-refusal]')
          ?.getAttribute('data-correction-refusal'),
      ).toBe('superseded'),
    );
    expect(view.container.textContent).toContain(MEMORY_COPY.correct.refusal.superseded.title);
  });

  test('words the refusal of a correction it does not admit, and keeps what was typed', async () => {
    const { view, detail } = await correctWith(() => {
      throw new StubFault('Unprocessable', 422, 'No.', { reason: 'memory-successor-not-admitted' });
    });

    await save(detail);

    await waitFor(() =>
      expect(view.container.textContent).toContain(
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
      const { view, detail } = await correctWith(() => {
        throw fault;
      });
      await save(detail);
      await waitFor(() => expect(view.container.textContent).toContain(expected));
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
    expect(detail.querySelector('[data-memory-text]')?.textContent).toContain(AISLE.content);
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
    await waitFor(() => expect(router.search.get('selected')).toBe(WINDOW.id));

    release({ id: AISLE.id, memory: { ...AISLE, id: 'memory-corrected', source: 'operator' } });

    expect(await view.findByText(MEMORY_COPY.correct.saved.title)).not.toBeNull();
    expect(router.search.get('selected')).toBe(WINDOW.id);
  });
});

describe('adding a memory', () => {
  const TEXT = 'The user flies out of Oakland.';
  const ADDED = {
    ...WINDOW,
    id: 'memory-added',
    content: TEXT,
    source: 'operator',
    writer: 'person',
    trust: 'verified',
    memoryClass: 'semantic',
    kind: 'fact',
    sessionId: null,
    createdAt: new Date().toISOString(),
  };

  const refusing = (reason: string) => () => {
    throw new StubFault('Unprocessable', 422, 'Refused.', { reason });
  };

  /** The page with the form open from its header and `content` typed into it. */
  async function formWith(
    answer: BureauHandler,
    content = TEXT,
    extra: Record<string, BureauHandler> = {},
  ) {
    const served = bureau({
      'bureau.memory.remember': answer,
      ...extra,
      'bureau.memory.get': () => detailOf_(ADDED),
    });
    const view = open();
    await view.findByText(AISLE.content);
    await fireEvent.click(view.getByRole('button', { name: MEMORY_COPY.add.action }));
    const dialog = await view.findByRole('dialog', { name: MEMORY_COPY.add.dialog.title });
    const field = within(dialog).getByLabelText<HTMLTextAreaElement>(ADD_LABEL);
    if (content !== '') await fireEvent.input(field, { target: { value: content } });
    const submit = within(dialog).getByRole<HTMLButtonElement>('button', {
      name: MEMORY_COPY.add.dialog.submit,
    });
    return { served, view, dialog, field, submit };
  }

  test('names the agent in the dialog, hints how it is saved, and offers Fact and How-to with Fact chosen', async () => {
    const { dialog, submit } = await formWith(() => ({ outcome: 'added', memory: ADDED }), '');

    expect(textOf(dialog)).toContain(MEMORY_COPY.add.dialog.description(AGENT_NAME));
    expect(textOf(dialog)).toContain(MEMORY_COPY.add.dialog.hint);
    expect(
      within(dialog).getByRole<HTMLInputElement>('radio', {
        name: MEMORY_COPY.add.dialog.kind.fact,
      }).checked,
    ).toBe(true);
    expect(
      within(dialog).getByRole<HTMLInputElement>('radio', {
        name: MEMORY_COPY.add.dialog.kind.howTo,
      }).checked,
    ).toBe(false);
    // Add memory is the primary button and Cancel the secondary one, and it is enabled while empty.
    expect(submit.disabled).toBe(false);
    expect(
      within(dialog).getByRole('button', { name: MEMORY_COPY.add.dialog.cancel }),
    ).not.toBeNull();
  });

  test('saves what was typed as a fact, says so in a toast with Undo, closes, and opens the new memory', async () => {
    const { served, view, submit } = await formWith(() => ({ outcome: 'added', memory: ADDED }));

    await fireEvent.click(submit);

    expect(await view.findByText(ADDED_TOAST)).not.toBeNull();
    expect(view.getByRole('button', { name: 'Undo' })).not.toBeNull();
    expect(served.callsTo('bureau.memory.remember')[0]?.params).toEqual({
      agentId: 'assistant',
      content: TEXT,
      kind: 'fact',
    });
    await waitFor(() => expect(view.queryByRole('dialog')?.outerHTML ?? null).toBeNull());
    await waitFor(() => expect(served.callsTo('bureau.memory.list').length).toBeGreaterThan(1));
    await waitFor(() => expect(router.search.get('selected')).toBe(ADDED.id));
    // The toast has no middle dot, and the page repeats nothing of it above the list.
    expect(ADDED_TOAST).not.toContain(String.fromCodePoint(0xb7));
  });

  test('saves a how-to when the person chooses How-to', async () => {
    const { served, view, dialog, submit } = await formWith(() => ({
      outcome: 'added',
      memory: { ...ADDED, kind: 'how-to', memoryClass: 'procedural' },
    }));

    await fireEvent.click(
      within(dialog).getByRole('radio', { name: MEMORY_COPY.add.dialog.kind.howTo }),
    );
    await fireEvent.click(submit);

    await view.findByText(ADDED_TOAST);
    expect(served.callsTo('bureau.memory.remember')[0]?.params).toEqual({
      agentId: 'assistant',
      content: TEXT,
      kind: 'how-to',
    });
  });

  test('forgets the memory just added when Undo is pressed, and closes its details', async () => {
    const { served, view, submit } = await formWith(
      () => ({ outcome: 'added', memory: ADDED }),
      TEXT,
      {
        'bureau.memory.forget': (params) => ({
          id: params['id'],
          deletion: 'completed',
          receipt: RECEIPT,
        }),
      },
    );
    await fireEvent.click(submit);
    await view.findByText(ADDED_TOAST);
    await waitFor(() => expect(router.search.get('selected')).toBe(ADDED.id));

    await fireEvent.click(view.getByRole('button', { name: 'Undo' }));

    await waitFor(() => expect(served.callsTo('bureau.memory.forget')).toHaveLength(1));
    expect(served.callsTo('bureau.memory.forget')[0]?.params).toEqual({
      agentId: 'assistant',
      id: ADDED.id,
    });
    await waitFor(() => expect(view.queryByText(ADDED_TOAST)?.outerHTML ?? null).toBeNull());
    await waitFor(() => expect(router.search.get('selected') ?? 'none').toBe('none'));
  });

  test('says Undo did not go through, and keeps the memory, when the server will not forget it', async () => {
    const { view, submit } = await formWith(() => ({ outcome: 'added', memory: ADDED }), TEXT, {
      'bureau.memory.forget': () => {
        throw new StubFault('EngineFailure', 500, 'The server broke.');
      },
    });
    await fireEvent.click(submit);
    await view.findByText(ADDED_TOAST);

    await fireEvent.click(view.getByRole('button', { name: 'Undo' }));

    expect(await view.findByText(MEMORY_COPY.add.undoFailed)).not.toBeNull();
    expect(router.search.get('selected')).toBe(ADDED.id);
  });

  test('starts empty the next time, once a memory was saved', async () => {
    const { view, submit } = await formWith(() => ({ outcome: 'added', memory: ADDED }));
    await fireEvent.click(submit);
    await view.findByText(ADDED_TOAST);

    await fireEvent.click(view.getByRole('button', { name: MEMORY_COPY.add.action }));

    const dialog = await view.findByRole('dialog', { name: MEMORY_COPY.add.dialog.title });
    expect(within(dialog).getByLabelText<HTMLTextAreaElement>(ADD_LABEL).value).toBe('');
    expect(
      within(dialog).getByRole<HTMLInputElement>('radio', {
        name: MEMORY_COPY.add.dialog.kind.fact,
      }).checked,
    ).toBe(true);
  });

  test('keeps the text and stays open when the add fails, with the reason above the buttons, and saves it on the next try', async () => {
    let refuse = true;
    const { served, view, dialog, field, submit } = await formWith(() => {
      if (refuse) throw new StubFault('EngineFailure', 500, 'The server broke.');
      return { outcome: 'added', memory: ADDED };
    });

    await fireEvent.click(submit);

    expect(await within(dialog).findByText(MEMORY_COPY.add.notSaved)).not.toBeNull();
    expect(within(dialog).getByText(MEMORY_COPY.add.stillHere.server(500))).not.toBeNull();
    expect(field.value).toBe(TEXT);
    // The error panel sits between the field and the buttons, and the primary button now says Try again.
    const reason = dialog.querySelector('[data-add-refusal]')!;
    expect(Boolean(field.compareDocumentPosition(reason) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(
      true,
    );
    expect(Boolean(reason.compareDocumentPosition(submit) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(
      true,
    );
    expect(textOf(submit)).toBe(MEMORY_COPY.add.dialog.retry);
    expect(view.queryByText(ADDED_TOAST)).toBeNull();

    refuse = false;
    await fireEvent.click(submit);

    expect(await view.findByText(ADDED_TOAST)).not.toBeNull();
    expect(served.callsTo('bureau.memory.remember')).toHaveLength(2);
  });

  test('words the refusal of text the memory rules do not admit, and keeps what was typed', async () => {
    const { dialog, field, submit } = await formWith(refusing('memory-not-admitted'));

    await fireEvent.click(submit);

    const words = MEMORY_COPY.add.refusal['not-admitted'];
    expect(await within(dialog).findByText(words.title)).not.toBeNull();
    expect(within(dialog).getByText(words.description)).not.toBeNull();
    expect(field.value).toBe(TEXT);
  });

  test('saves nothing when Add memory is pressed with nothing written, and says what to write at the field', async () => {
    const { served, dialog, field, submit } = await formWith(
      () => ({ outcome: 'added', memory: ADDED }),
      '',
    );

    expect(submit.disabled).toBe(false);
    await fireEvent.click(submit);

    expect(
      await within(dialog).findByText(MEMORY_COPY.add.dialog.empty(AGENT_NAME)),
    ).not.toBeNull();
    expect(served.callsTo('bureau.memory.remember')).toEqual([]);
    // The field is marked and takes focus; the dialog stays open and Add memory stays enabled.
    await waitFor(() => expect(field.getAttribute('aria-invalid')).toBe('true'));
    await waitFor(() => expect(document.activeElement === field).toBe(true));
    expect(within(dialog).queryByRole('button', { name: MEMORY_COPY.add.dialog.retry })).toBeNull();
    expect(submit.disabled).toBe(false);
  });

  test('stops saying what to write once something is written', async () => {
    const { dialog, field, submit } = await formWith(
      () => ({ outcome: 'added', memory: ADDED }),
      '',
    );
    await fireEvent.click(submit);
    await within(dialog).findByText(MEMORY_COPY.add.dialog.empty(AGENT_NAME));

    await fireEvent.input(field, { target: { value: TEXT } });

    await waitFor(() =>
      expect(
        within(dialog).queryByText(MEMORY_COPY.add.dialog.empty(AGENT_NAME))?.outerHTML ?? null,
      ).toBeNull(),
    );
  });

  describe('text the content rules hold back', () => {
    const HELD_ID = 'memory-held';
    const held = () => ({ outcome: 'held', id: HELD_ID });
    const forgotten = (deletion = 'completed') => ({
      id: HELD_ID,
      deletion,
      receipt: RECEIPT,
    });

    test('says the text was held back, keeps it, and offers to remove the stored copy', async () => {
      const { view, dialog, field, submit } = await formWith(held);

      await fireEvent.click(submit);

      expect(await within(dialog).findByText(MEMORY_COPY.add.held.title)).not.toBeNull();
      expect(within(dialog).getByText(MEMORY_COPY.add.held.description)).not.toBeNull();
      expect(
        within(dialog).getByRole('button', { name: MEMORY_COPY.add.held.remove }),
      ).not.toBeNull();
      expect(field.value).toBe(TEXT);
      expect(view.queryByText(ADDED_TOAST)).toBeNull();
    });

    test('forgets the held record by its identifier when the person removes it', async () => {
      const { served, dialog, field, submit } = await formWith(held, TEXT, {
        'bureau.memory.forget': () => forgotten(),
      });
      await fireEvent.click(submit);
      await fireEvent.click(
        await within(dialog).findByRole('button', { name: MEMORY_COPY.add.held.remove }),
      );
      await waitFor(() => expect(served.callsTo('bureau.memory.forget')).toHaveLength(1));

      await waitFor(() =>
        expect(
          within(dialog).queryByText(MEMORY_COPY.add.held.title)?.outerHTML ?? null,
        ).toBeNull(),
      );
      expect(served.callsTo('bureau.memory.forget')).toHaveLength(1);
      expect(served.callsTo('bureau.memory.forget')[0]?.params).toEqual({
        agentId: 'assistant',
        id: HELD_ID,
      });
      expect(field.value).toBe(TEXT);
    });

    test('forgets the held record when the person cancels', async () => {
      const { served, view, dialog, submit } = await formWith(held, TEXT, {
        'bureau.memory.forget': () => forgotten(),
      });
      await fireEvent.click(submit);
      await within(dialog).findByText(MEMORY_COPY.add.held.title);

      await fireEvent.click(
        within(dialog).getByRole('button', { name: MEMORY_COPY.add.dialog.cancel }),
      );

      await waitFor(() => expect(served.callsTo('bureau.memory.forget')).toHaveLength(1));
      expect(served.callsTo('bureau.memory.forget')[0]?.params).toEqual({
        agentId: 'assistant',
        id: HELD_ID,
      });
      await waitFor(() => expect(view.queryByRole('dialog')?.outerHTML ?? null).toBeNull());
    });

    test('removes the held copy before saving a reworded text, so a retry leaves one', async () => {
      let first = true;
      const { served, view, field, submit } = await formWith(
        () => {
          if (first) {
            first = false;
            return held();
          }
          return { outcome: 'added', memory: ADDED };
        },
        TEXT,
        { 'bureau.memory.forget': () => forgotten() },
      );
      await fireEvent.click(submit);
      await view.findByText(MEMORY_COPY.add.held.title);
      await fireEvent.input(field, { target: { value: 'The user flies out of San Jose.' } });

      await fireEvent.click(submit);

      expect(await view.findByText(ADDED_TOAST)).not.toBeNull();
      expect(served.callsTo('bureau.memory.forget')).toHaveLength(1);
      expect(served.callsTo('bureau.memory.remember')).toHaveLength(2);
    });

    test('says so, and stays open, when the held copy could not be removed', async () => {
      const { served, dialog, submit } = await formWith(held, TEXT, {
        'bureau.memory.forget': () => forgotten('failed'),
      });
      await fireEvent.click(submit);

      await fireEvent.click(
        await within(dialog).findByRole('button', { name: MEMORY_COPY.add.held.remove }),
      );

      expect(await within(dialog).findByText(MEMORY_COPY.add.held.notRemoved.title)).not.toBeNull();
      expect(within(dialog).getByText(MEMORY_COPY.add.held.title)).not.toBeNull();
      expect(served.callsTo('bureau.memory.forget')).toHaveLength(1);

      await fireEvent.click(within(dialog).getByRole('button', { name: /dismiss/i }));

      expect(
        within(dialog).queryByText(MEMORY_COPY.add.held.notRemoved.title)?.outerHTML ?? null,
      ).toBeNull();
    });
  });

  test('names the scope when the server refuses it, and the agent when it is gone', async () => {
    const { dialog, submit } = await formWith(() => {
      throw new StubFault('Forbidden', 403, 'No scope.', {
        reason: 'missing scope bureau.memory:write',
      });
    });

    await fireEvent.click(submit);

    expect(
      await within(dialog).findByText(MEMORY_COPY.correct.refusal.forbidden.description),
    ).not.toBeNull();
    cleanup();
    stub?.restore();

    const gone = await formWith(() => {
      throw new StubFault('NotFound', 404, 'No agent.', { resource: 'agent' });
    });
    await fireEvent.click(gone.submit);
    expect(
      await within(gone.dialog).findByText(MEMORY_COPY.add.refusal['not-found'].title),
    ).not.toBeNull();
  });

  test('says the server answered with an error, by its status, for a failure it has no name for', async () => {
    const { dialog, submit } = await formWith(() => {
      throw new StubFault('EngineFailure', 500, 'The disk is full.');
    });

    await fireEvent.click(submit);

    expect(await within(dialog).findByText(MEMORY_COPY.add.stillHere.server(500))).not.toBeNull();
    expect(within(dialog).getByText(MEMORY_COPY.add.notSaved)).not.toBeNull();
  });

  test('keeps a draft the person closed, and drops the old refusal when it opens again', async () => {
    const { view, dialog, submit } = await formWith(refusing('memory-not-admitted'));
    await fireEvent.click(submit);
    const words = MEMORY_COPY.add.refusal['not-admitted'];
    await within(dialog).findByText(words.title);

    await fireEvent.click(
      within(dialog).getByRole('button', { name: MEMORY_COPY.add.dialog.cancel }),
    );
    await waitFor(() => expect(view.queryByRole('dialog')?.outerHTML ?? null).toBeNull());
    await fireEvent.click(view.getByRole('button', { name: MEMORY_COPY.add.action }));

    const again = await view.findByRole('dialog', { name: MEMORY_COPY.add.dialog.title });
    expect(within(again).getByLabelText<HTMLTextAreaElement>(ADD_LABEL).value).toBe(TEXT);
    expect(within(again).queryByText(words.title)).toBeNull();
  });

  test('reopens with the refusal when a save fails after the form was closed', async () => {
    let refuse: (error: unknown) => void = () => {};
    const { served, view, dialog, submit } = await formWith(
      () =>
        new Promise((_resolve, reject) => {
          refuse = reject;
        }),
    );
    await fireEvent.click(submit);
    await waitFor(() => expect(served.callsTo('bureau.memory.remember')).toHaveLength(1));
    await fireEvent.click(
      within(dialog).getByRole('button', { name: MEMORY_COPY.add.dialog.cancel }),
    );
    await waitFor(() => expect(view.queryByRole('dialog')?.outerHTML ?? null).toBeNull());

    refuse(new StubFault('Unprocessable', 422, 'Refused.', { reason: 'memory-not-admitted' }));

    const again = await view.findByRole('dialog', { name: MEMORY_COPY.add.dialog.title });
    expect(
      await within(again).findByText(MEMORY_COPY.add.refusal['not-admitted'].title),
    ).not.toBeNull();
    expect(within(again).getByLabelText<HTMLTextAreaElement>(ADD_LABEL).value).toBe(TEXT);
  });

  test('sends one add while one is being saved', async () => {
    const { served, submit } = await formWith(() => new Promise(() => {}));

    await fireEvent.click(submit);
    await waitFor(() => expect(submit.disabled).toBe(true));
    await fireEvent.submit(submit.closest('form')!);

    expect(served.callsTo('bureau.memory.remember')).toHaveLength(1);
  });

  test('has nothing to save while the text is blank, however many times Add memory is pressed', async () => {
    const { served, submit } = await formWith(() => ({ outcome: 'added', memory: ADDED }), '   ');

    await fireEvent.submit(submit.closest('form')!);
    await fireEvent.submit(submit.closest('form')!);

    expect(served.callsTo('bureau.memory.remember')).toEqual([]);
  });

  test('adds the first memory of an agent that has none, from the page the frame shows', async () => {
    let memories: unknown[] = [];
    const served = bureau({
      'bureau.memory.list': () => ({ memories, nextOffset: null }),
      'bureau.memory.remember': () => {
        memories = [ADDED];
        return { outcome: 'added', memory: ADDED };
      },
      'bureau.memory.get': () => detailOf_(ADDED),
    });
    landAt('/agents/assistant/memory');
    const view = render(FramedMemory, { props: { agentId: 'assistant' } } as never);

    const heading = await view.findByText(MEMORY_COPY.nothing.title, { selector: 'h2' });
    const empty = heading.closest('[data-cinder-kind]');
    expect(empty?.getAttribute('data-cinder-kind')).toBe('first-use');
    await fireEvent.click(
      within(empty as HTMLElement).getByRole('button', { name: MEMORY_COPY.add.action }),
    );
    const dialog = await view.findByRole('dialog', { name: MEMORY_COPY.add.dialog.title });
    await fireEvent.input(within(dialog).getByLabelText(ADD_LABEL), {
      target: { value: TEXT },
    });
    await fireEvent.click(
      within(dialog).getByRole('button', { name: MEMORY_COPY.add.dialog.submit }),
    );

    await waitFor(() => expect(served.callsTo('bureau.memory.remember')).toHaveLength(1));
    await waitFor(() =>
      expect(view.queryByText(MEMORY_COPY.nothing.title)?.outerHTML ?? null).toBeNull(),
    );
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
  const HISTORY = [
    {
      id: 'memory-original',
      content: 'The user prefers the middle seat.',
      kind: 'fact',
      writer: 'agent',
      trust: 'untrusted',
      writtenAt: '2026-10-18T08:00:00.000Z',
      correctedAt: '2026-10-19T08:00:00.000Z',
    },
  ];
  const EXPORTED = [
    { ...AISLE, history: [] },
    { ...WINDOW, history: HISTORY },
  ];

  /** Runs `body` with the blob URLs a download makes held, so the saved file can be read. */
  async function downloading(body: (created: Blob[]) => Promise<void>) {
    const originalCreate = URL.createObjectURL;
    const originalRevoke = URL.revokeObjectURL;
    const created: Blob[] = [];
    URL.createObjectURL = mock((blob: Blob) => {
      created.push(blob);
      return 'blob:memories';
    });
    URL.revokeObjectURL = mock(() => {});
    try {
      await body(created);
    } finally {
      URL.createObjectURL = originalCreate;
      URL.revokeObjectURL = originalRevoke;
    }
  }

  test('saves one JSON file named by the server with each memory’s text, kind, writer, trust and history, and says so in a toast', async () => {
    const served = bureau({
      'bureau.memory.export': () => ({
        exportId: 'export-1',
        fileName: 'assistant-memories.json',
        memories: EXPORTED,
      }),
    });
    await downloading(async (created) => {
      const view = open();
      await view.findByText(AISLE.content);

      await fireEvent.click(view.getByRole('button', { name: MEMORY_COPY.govern.export.action }));

      expect(
        await view.findByText(MEMORY_COPY.govern.export.done(2, 'assistant-memories.json')),
      ).not.toBeNull();
      expect(MEMORY_COPY.govern.export.done(2, 'assistant-memories.json')).not.toContain(
        String.fromCodePoint(0xb7),
      );
      expect(served.callsTo('bureau.memory.export')[0]?.params).toEqual({ agentId: 'assistant' });
      expect(created).toHaveLength(1);
      const saved = JSON.parse(await created[0]!.text()) as Record<string, unknown>[];
      expect(saved).toEqual(EXPORTED);
      for (const memory of saved) {
        for (const key of ['content', 'kind', 'writer', 'trust', 'history']) {
          expect(Object.hasOwn(memory, key)).toBe(true);
        }
      }
    });
  });

  test('says the button is exporting while the export runs, and goes back once it is saved', async () => {
    let finish: (answer: unknown) => void = () => {};
    bureau({
      'bureau.memory.export': () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    });
    await downloading(async () => {
      const view = open();
      await view.findByText(AISLE.content);

      await fireEvent.click(view.getByRole('button', { name: MEMORY_COPY.govern.export.action }));

      const busy = await view.findByRole('button', { name: MEMORY_COPY.govern.export.exporting });
      expect(busy.hasAttribute('disabled')).toBe(true);
      finish({ exportId: null, fileName: 'assistant-memories.json', memories: EXPORTED });
      await view.findByRole('button', { name: MEMORY_COPY.govern.export.action });
    });
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

describe('a fault the list or search met', () => {
  const broke = () => new StubFault('EngineFailure', 500, 'The server broke.');

  test('says a failed Load more, and keeps the memories already read', async () => {
    bureau({
      'bureau.memory.list': (params) => {
        if (params['offset'] === 0) return { memories: [AISLE], nextOffset: 1 };
        throw broke();
      },
    });
    const view = open();
    await view.findByText(AISLE.content);

    await fireEvent.click(view.getByRole('button', { name: MEMORY_COPY.loadMore }));

    await view.findByText(MEMORY_COPY.listFailed);
    expect(view.queryByText(AISLE.content)).not.toBeNull();
    expect(view.queryByRole('button', { name: RETRY_LABEL })).not.toBeNull();
  });

  test('says a refetch that failed after a change, while the memories read before stay listed', async () => {
    let reads = 0;
    bureau({
      'bureau.memory.list': () => {
        reads += 1;
        if (reads > 1) throw broke();
        return { memories: [AISLE, WINDOW], nextOffset: null };
      },
      'bureau.memory.hold': (params) => ({ id: params['id'], changed: true, legalHold: 'held' }),
      'bureau.memory.hold.release': (params) => ({
        id: params['id'],
        changed: true,
        legalHold: 'released',
      }),
    });
    const view = open();
    const detail = await openDetails(view, AISLE.content);
    await fireEvent.click(
      within(detail).getByRole('button', { name: MEMORY_COPY.govern.hold.place }),
    );
    await view.findByText(MEMORY_COPY.govern.hold.outcome.placed.title);
    expect(view.queryByText(MEMORY_COPY.listFailed)).toBeNull();

    await fireEvent.click(
      within(detail).getByRole('button', { name: MEMORY_COPY.govern.hold.release }),
    );

    await view.findByText(MEMORY_COPY.listFailed);
    expect(view.queryByText(WINDOW.content)).not.toBeNull();
  });

  test('says a failed search while a memory is open, and does not read the open memory as a result', async () => {
    bureau({
      'bureau.memory.search': () => {
        throw broke();
      },
    });
    const view = open();
    await openDetails(view, AISLE.content);

    await fireEvent.input(view.getByLabelText(MEMORY_COPY.searchLabel), {
      target: { value: 'seats' },
    });

    await view.findByText(MEMORY_COPY.listFailed);
    // The open memory still leads the list, and says it is not one of its results.
    expect(rowOf(view, AISLE.id).textContent).toContain(MEMORY_COPY.pinnedNote);
    expect(view.queryByText(MEMORY_COPY.noMatch.title('seats'))).toBeNull();
  });

  test('says a search is loading while a memory is open, rather than listing the open memory alone', async () => {
    bureau({ 'bureau.memory.search': () => new Promise(() => {}) });
    const view = open();
    await openDetails(view, AISLE.content);

    await fireEvent.input(view.getByLabelText(MEMORY_COPY.searchLabel), {
      target: { value: 'seats' },
    });

    const list = view.getByRole('region', { name: MEMORY_COPY.listLabel });
    await waitFor(() =>
      expect(within(list).queryByRole('status', { name: MEMORY_COPY.loading })).not.toBeNull(),
    );
    expect(rowOf(view, AISLE.id).textContent).toContain(MEMORY_COPY.pinnedNote);
  });

  test('says no memory matches while a memory is open, and does not count the open memory as a match', async () => {
    bureau({ 'bureau.memory.search': () => ({ hits: [{ memory: WINDOW, score: 0.2 }] }) });
    const view = open();
    await openDetails(view, AISLE.content);

    await fireEvent.input(view.getByLabelText(MEMORY_COPY.searchLabel), {
      target: { value: 'zebra' },
    });

    await view.findByText(MEMORY_COPY.noMatch.title('zebra'), { selector: 'h2' });
    expect(rowOf(view, AISLE.id).textContent).toContain(MEMORY_COPY.pinnedNote);
    expect(rowOf(view, AISLE.id).textContent).not.toContain(MEMORY_COPY.relevance);
    expect(view.queryByTestId('memory-match-count')).toBeNull();
  });

  test('says no loaded memory matches the filters, not that nothing matches, when a filter hides the search hits', async () => {
    bureau({
      'bureau.memory.search': () => ({
        hits: [
          { memory: AISLE, score: 0.5 },
          { memory: WINDOW, score: 0.4 },
        ],
      }),
    });
    const view = open();
    await view.findByText(AISLE.content);

    await fireEvent.input(view.getByLabelText(MEMORY_COPY.searchLabel), {
      target: { value: 'seats' },
    });
    await view.findByTestId('memory-match-count');
    await fireEvent.change(view.getByLabelText(MEMORY_COPY.filter.kindLabel), {
      target: { value: 'how-to' },
    });

    await view.findByText(MEMORY_COPY.noFiltered.title, { selector: 'h2' });
    expect(view.queryByText(MEMORY_COPY.noMatch.title('seats'))).toBeNull();
    expect(textOf(view.getByTestId('memory-match-count'))).toContain('2');
  });
});

describe('a correction that was refused', () => {
  const CORRECTION = 'The user prefers the exit row.';

  test('is reported on the page with the text that was sent when the person moved on, and can be edited again', async () => {
    let refuse: (error: unknown) => void = () => {};
    const served = bureau({
      'bureau.memory.correct': () =>
        new Promise((_resolve, reject) => {
          refuse = reject;
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
    await fireEvent.click(
      within(detail).getByRole('button', { name: MEMORY_COPY.correct.edit.submit }),
    );
    await waitFor(() => expect(served.callsTo('bureau.memory.correct')).toHaveLength(1));
    // The person moves on to another memory while the correction is being saved.
    await fireEvent.click(rowOf(view, WINDOW.id));
    await waitFor(() => expect(router.search.get('selected')).toBe(WINDOW.id));
    await waitFor(() =>
      expect(
        view.container.querySelector(`[data-memory-detail="${AISLE.id}"]`)?.outerHTML ?? null,
      ).toBeNull(),
    );

    refuse(new StubFault('Unprocessable', 422, 'No.', { reason: 'memory-successor-not-admitted' }));

    await view.findByText(MEMORY_COPY.correct.notSaved.title);
    expect(view.container.textContent).toContain(
      MEMORY_COPY.correct.refusal['successor-not-admitted'].title,
    );
    expect(textOf(view.container.querySelector('[data-correction-draft]'))).toBe(CORRECTION);
    expect(router.search.get('selected')).toBe(WINDOW.id);

    await fireEvent.click(
      view.getByRole('button', { name: MEMORY_COPY.correct.notSaved.editAgain }),
    );

    expect(router.search.get('selected')).toBe(AISLE.id);
    await waitFor(() =>
      expect(
        (view.getByLabelText(MEMORY_COPY.correct.edit.label) as HTMLTextAreaElement).value,
      ).toBe(CORRECTION),
    );
    expect(view.queryByText(MEMORY_COPY.correct.notSaved.title)).toBeNull();
  });

  test('is said at the form, with the typed text kept, when the person stayed: not as a banner', async () => {
    bureau({
      'bureau.memory.correct': () => {
        throw new StubFault('EngineFailure', 500, 'The server broke.');
      },
    });
    const view = open();
    const detail = await openDetails(view, AISLE.content);
    await fireEvent.click(
      within(detail).getByRole('button', { name: MEMORY_COPY.correct.iconLabel }),
    );
    const field = within(detail).getByLabelText<HTMLTextAreaElement>(
      MEMORY_COPY.correct.edit.label,
    );
    await fireEvent.input(field, { target: { value: CORRECTION } });

    await fireEvent.click(
      within(detail).getByRole('button', { name: MEMORY_COPY.correct.edit.submit }),
    );

    // The reason is in the form, above its buttons, and nothing is reported over the list.
    const reason = await within(detail).findByText(MEMORY_COPY.add.stillHere.server(500));
    expect(textOf(detail)).toContain(MEMORY_COPY.correct.refusal.other.title);
    expect(field.value).toBe(CORRECTION);
    expect(detail.querySelector('form')?.contains(reason)).toBe(true);
    expect(view.container.querySelector('[data-correction-draft]')).toBeNull();
    expect(view.queryByRole('button', { name: MEMORY_COPY.correct.notSaved.editAgain })).toBeNull();
    // Cancel and a primary Try again, which sends the same text again.
    expect(
      within(detail).getByRole('button', { name: MEMORY_COPY.correct.edit.cancel }),
    ).not.toBeNull();
    expect(
      within(detail).getByRole('button', { name: MEMORY_COPY.correct.edit.retry }),
    ).not.toBeNull();
  });

  test('is worded for a refusal the server named, in the form, and goes when the person cancels', async () => {
    bureau({
      'bureau.memory.correct': () => {
        throw new StubFault('Conflict', 409, 'Superseded.', { reason: 'memory-superseded' });
      },
    });
    const view = open();
    const detail = await openDetails(view, AISLE.content);
    await fireEvent.click(
      within(detail).getByRole('button', { name: MEMORY_COPY.correct.iconLabel }),
    );
    await fireEvent.input(within(detail).getByLabelText(MEMORY_COPY.correct.edit.label), {
      target: { value: CORRECTION },
    });
    await fireEvent.click(
      within(detail).getByRole('button', { name: MEMORY_COPY.correct.edit.submit }),
    );

    await within(detail).findByText(MEMORY_COPY.correct.refusal.superseded.title);
    await fireEvent.click(
      within(detail).getByRole('button', { name: MEMORY_COPY.correct.edit.cancel }),
    );

    expect(within(detail).queryByText(MEMORY_COPY.correct.refusal.superseded.title)).toBeNull();
    expect(textOf(detail.querySelector('[data-memory-text]'))).toBe(AISLE.content);
  });
});

describe('what a governance note claims', () => {
  test('says the ledger records a change that was made, and not one that changed nothing', async () => {
    bureau({
      'bureau.memory.hold': (params) => ({ id: params['id'], changed: true, legalHold: 'held' }),
      'bureau.memory.hold.release': (params) => ({
        id: params['id'],
        changed: false,
        legalHold: 'released',
      }),
    });
    const view = open();
    const detail = await openDetails(view, AISLE.content);

    await fireEvent.click(
      within(detail).getByRole('button', { name: MEMORY_COPY.govern.hold.place }),
    );
    await view.findByText(MEMORY_COPY.govern.hold.outcome.placed.title);
    expect(view.container.textContent).toContain(MEMORY_COPY.govern.recorded);

    await fireEvent.click(
      within(detail).getByRole('button', { name: MEMORY_COPY.govern.hold.release }),
    );
    await view.findByText(MEMORY_COPY.govern.hold.outcome.notHeld.title);
    expect(view.container.textContent).not.toContain(MEMORY_COPY.govern.recorded);
  });

  test('does not claim a ledger record for a share or a quarantine that changed nothing', async () => {
    bureau({
      'bureau.memory.share.revoke': (params) => ({
        id: params['id'],
        changed: false,
        granteeOwnerId: params['granteeOwnerId'],
        grantedBy: 'me',
      }),
      'bureau.memory.quarantine': (params) => ({ id: params['id'], changed: false, affected: 0 }),
    });
    const view = open();
    const detail = await openDetails(view, AISLE.content);
    await fireEvent.click(
      within(detail).getByRole('button', { name: MEMORY_COPY.govern.share.action }),
    );
    const share = await view.findByRole('dialog', { name: MEMORY_COPY.govern.share.dialog.title });
    await fireEvent.input(within(share).getByLabelText(MEMORY_COPY.govern.share.dialog.label), {
      target: { value: 'nobody' },
    });
    await fireEvent.click(
      within(share).getByRole('button', { name: MEMORY_COPY.govern.share.dialog.revoke }),
    );
    await view.findByText(MEMORY_COPY.govern.share.outcome.notShared.title);
    expect(view.container.textContent).not.toContain(MEMORY_COPY.govern.recorded);

    await fireEvent.click(
      within(detail).getByRole('button', { name: MEMORY_COPY.govern.quarantine.action }),
    );
    const quarantine = await view.findByRole('dialog', {
      name: MEMORY_COPY.govern.quarantine.dialog.title,
    });
    await fireEvent.input(
      within(quarantine).getByLabelText(MEMORY_COPY.govern.quarantine.dialog.reasonLabel),
      { target: { value: 'Again.' } },
    );
    await fireEvent.click(
      within(quarantine).getByRole('button', {
        name: MEMORY_COPY.govern.quarantine.dialog.confirm,
      }),
    );
    await view.findByText(MEMORY_COPY.govern.quarantine.outcome.already.title);
    expect(view.container.textContent).not.toContain(MEMORY_COPY.govern.recorded);
  });

  test('shows a refused share and a refused quarantine inside the open dialog, not behind it', async () => {
    bureau({
      'bureau.memory.share': () => {
        throw new StubFault('Unprocessable', 422, 'No.', { reason: 'memory-invalid-grantee' });
      },
      'bureau.memory.quarantine': () => {
        throw new StubFault('Forbidden', 403, 'No scope.');
      },
    });
    const view = open();
    const detail = await openDetails(view, AISLE.content);

    await fireEvent.click(
      within(detail).getByRole('button', { name: MEMORY_COPY.govern.share.action }),
    );
    const share = await view.findByRole('dialog', { name: MEMORY_COPY.govern.share.dialog.title });
    await fireEvent.input(within(share).getByLabelText(MEMORY_COPY.govern.share.dialog.label), {
      target: { value: 'me' },
    });
    await fireEvent.click(
      within(share).getByRole('button', { name: MEMORY_COPY.govern.share.dialog.submit }),
    );
    await within(share).findByText(MEMORY_COPY.govern.failed);
    expect(within(share).getByText(MEMORY_COPY.govern.refusal['invalid-grantee'].description));
    expect(view.getAllByText(MEMORY_COPY.govern.failed)).toHaveLength(1);
    await fireEvent.click(
      within(share).getByRole('button', { name: MEMORY_COPY.govern.share.dialog.cancel }),
    );

    await fireEvent.click(
      within(detail).getByRole('button', { name: MEMORY_COPY.govern.quarantine.action }),
    );
    const quarantine = await view.findByRole('dialog', {
      name: MEMORY_COPY.govern.quarantine.dialog.title,
    });
    // Asking again leaves the last refusal behind.
    expect(within(quarantine).queryByText(MEMORY_COPY.govern.failed)).toBeNull();
    await fireEvent.input(
      within(quarantine).getByLabelText(MEMORY_COPY.govern.quarantine.dialog.reasonLabel),
      { target: { value: 'Wrong.' } },
    );
    await fireEvent.click(
      within(quarantine).getByRole('button', {
        name: MEMORY_COPY.govern.quarantine.dialog.confirm,
      }),
    );
    await within(quarantine).findByText(MEMORY_COPY.govern.failed);
    expect(view.getAllByText(MEMORY_COPY.govern.failed)).toHaveLength(1);
  });
});

describe('the agent’s page', () => {
  test('has a Memory tab with its own address, which shows the memory under the agent’s header', async () => {
    bureau({ 'bureau.agents.list': () => ({ agents: [AGENT] }) });
    stub?.on('bureau.contexts.list', () => ({ contexts: [], nextOffset: null }));
    landAt('/agents/assistant');
    const { findByRole, findByText, getByTestId } = mount(AgentDetail);

    const tab = await findByRole('tab', { name: /^Memory/ });
    await fireEvent.click(tab);

    await waitFor(() => expect(router.pathname).toBe('/agents/assistant/memory'));
    expect(router.current.route?.view).toBe('agents');
    expect(router.current.params['agent']).toBe('assistant');
    // The memory list is the tab's body: the agent's header and its tab bar stay above it.
    expect(await findByText(AISLE.content)).not.toBeNull();
    expect(getByTestId('agent-header')).not.toBeNull();
    expect((await findByRole('tab', { name: /^Memory/ })).getAttribute('aria-selected')).toBe(
      'true',
    );
  });
});
