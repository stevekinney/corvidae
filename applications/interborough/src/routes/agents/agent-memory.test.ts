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

/** Opens the Details of the memory whose text is `content`. */
async function openDetails(view: ReturnType<typeof open>, content: string) {
  const text = await view.findByText(content);
  const row = text.closest('li');
  if (row === null) throw new Error(`No row holds "${content}".`);
  await fireEvent.click(
    within(row).getByRole('button', { name: new RegExp(MEMORY_COPY.openDetails) }),
  );
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
    expect(rows[0]?.textContent).toContain(MEMORY_COPY.memoryClass.episodic);
    expect(rows[0]?.querySelector('time')?.getAttribute('datetime')).toBe(AISLE.createdAt);
  });

  test('searches by the typed text, ranks every hit with its relevance, and lists again when cleared', async () => {
    const served = bureau({
      'bureau.memory.search': () => ({ hits: [{ memory: WINDOW, score: 0.8 }] }),
    });
    const { findByText, getByRole, getByLabelText, queryByText } = open();
    await findByText(AISLE.content);

    await fireEvent.input(getByLabelText(MEMORY_COPY.searchLabel), {
      target: { value: ' window ' },
    });
    await fireEvent.click(getByRole('button', { name: MEMORY_COPY.searchAction }));

    await findByText(`${MEMORY_COPY.relevance}: 0.80`);
    expect(queryByText(AISLE.content)).toBeNull();
    expect(served.callsTo('bureau.memory.search')[0]?.params).toEqual({
      agentId: 'assistant',
      query: 'window',
      limit: 20,
    });

    await fireEvent.click(getByRole('button', { name: /clear/i }));
    await findByText(AISLE.content);
    expect(queryByText(new RegExp(MEMORY_COPY.relevance))).toBeNull();
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

    await fireEvent.click(view.getAllByRole('button', { name: /^Details/ })[0]!);

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
    await fireEvent.click(view.getAllByRole('button', { name: /^Details/ })[0]!);
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
    await fireEvent.click(view.getAllByRole('button', { name: /^Details/ })[0]!);
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
    await fireEvent.click(failing.getAllByRole('button', { name: /^Details/ })[0]!);
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
      const { served, detail } = await forgetWith(state);
      const words = MEMORY_COPY.forget.outcome[state];

      const title = await within(detail).findByText(words.title);

      expect(title.getAttribute('data-forget-outcome')).toBe(state);
      expect(detail.textContent).toContain(words.description);
      expect(served.callsTo('bureau.memory.forget')[0]?.params).toEqual({
        agentId: 'assistant',
        id: AISLE.id,
      });
      // The receipt's rows are shown in the receipt's own states.
      expect(textOf(detail)).toContain(
        `${MEMORY_COPY.forget.targets['source-evidence']}: ${MEMORY_COPY.forget.targetStatus[state]}`,
      );
    });
  }

  test('learns of a legal hold from the exempt answer, and leaves the memory listed', async () => {
    const { served, view, detail } = await forgetWith('exempt');

    await within(detail).findByText(MEMORY_COPY.forget.outcome.exempt.title);

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

  test('takes the actions away from a memory that is gone, and reads the list again', async () => {
    const { served, detail } = await forgetWith('completed');

    await within(detail).findByText(MEMORY_COPY.forget.outcome.completed.title);

    expect(within(detail).queryByRole('button', { name: MEMORY_COPY.forget.action })).toBeNull();
    expect(within(detail).queryByRole('button', { name: MEMORY_COPY.correct.action })).toBeNull();
    await waitFor(() => expect(served.callsTo('bureau.memory.list').length).toBeGreaterThan(1));
    // The memory is gone, so its details are not asked for again: the outcome stays, and the
    // page does not answer it with "not found".
    expect(served.callsTo('bureau.memory.get')).toHaveLength(1);
    expect(within(detail).queryByText(MEMORY_COPY.detail.notFound.title)).toBeNull();
    expect(within(detail).getByText(MEMORY_COPY.forget.outcome.completed.title)).not.toBeNull();
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
    expect(textOf(detail)).toContain(MEMORY_COPY.forget.targets['source-evidence']);
  });

  test('says so when the Bureau refuses the forget', async () => {
    const { detail } = await forgetWith('completed', {
      'bureau.memory.forget': () => {
        throw new StubFault('Forbidden', 403, 'No.', {
          reason: 'missing scope bureau.memory:write',
        });
      },
    });

    await within(detail).findByText(MEMORY_COPY.forget.failed);

    expect(detail.textContent).toContain(MEMORY_COPY.correct.refusal.forbidden.description);
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

    await within(detail).findByText(MEMORY_COPY.forget.failed);
    expect(detail.textContent).toContain('The Bureau broke.');
    await fireEvent.click(within(detail).getByRole('button', { name: /dismiss/i }));

    expect(within(detail).queryByText(MEMORY_COPY.forget.failed)).toBeNull();
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
