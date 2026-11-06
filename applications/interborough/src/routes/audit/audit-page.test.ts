/**
 * `/health/audit` (COR-2018, rows 82a to 82z and 83f, 83g): the audit log as a table of events under
 * a heading for each day, with the open event beside it. The Bureau is asked for the event types
 * only, newest first, with the period as `since` and the action as a shorter list of types; Who and
 * the search narrow what was read. Each event is worded from its record and from what the page
 * looks up for it.
 */
import { quietFor } from '@lostgradient/testing/wait-until';
import { HttpClient } from '@lostgradient/weft';
import type { QueryClient } from '@tanstack/svelte-query';
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, jest, test } from 'bun:test';
import { flushSync } from 'svelte';

import { AUDIT_COPY, RETRY_LABEL, VIEW_COPY } from '../../app/copy.ts';
import RouteOutletHarness from '../../app/shell/route-outlet.test-harness.svelte';
import { AUDIT_EVENT_TYPES } from '../../lib/audit-event-types.ts';
import {
  installBureauStub,
  StubFault,
  type BureauHandler,
  type BureauStub,
} from '../../lib/bureau-stub.test-support.ts';
import { AUTHORIZATION_SCOPES } from '../../lib/scopes.svelte.ts';
import { landAt } from '../chat/pages.test-support.ts';

let stub: BureauStub | undefined;
afterEach(() => {
  jest.useRealTimers();
  cleanup();
  stub?.restore();
  stub = undefined;
});

const MINUTE = 60_000;
const NOW = Date.now();

/** A record `minutesAgo` minutes before the page opened. */
function record(sequence: number, minutesAgo: number, overrides: Record<string, unknown> = {}) {
  return {
    sequence,
    timestamp: new Date(NOW - minutesAgo * MINUTE).toISOString(),
    type: 'run.started',
    resource: `run-${String(sequence)}`,
    principal: 'anonymous:local',
    detail: { agentName: 'tool-runner', sessionId: 'chat-1' },
    ...overrides,
  };
}

const KEY_REMOVED = record(5, 1, {
  type: 'provider.disconnected',
  resource: 'provider:anthropic',
  detail: { provider: 'anthropic' },
});
const ASKED = record(4, 4, {
  type: 'tool.settled',
  resource: 'run-4',
  principal: null,
  detail: {
    agentName: 'tool-runner',
    status: 'paused',
    toolName: 'issue-refund',
    toolCallId: 'c1',
  },
});
const STARTED = record(3, 5);
const NOISE = record(2, 6, {
  type: 'tool.settled',
  principal: null,
  detail: { status: 'success' },
});
const BOOTED = record(1, 90, {
  type: 'host.started',
  resource: 'host',
  principal: 'system:host',
  detail: null,
});

type Query = Record<string, unknown>;
type Page = { records: unknown[]; nextCursor: string | null; total?: number };

/** The one record the view frame's probe asks for, to learn whether the log is empty. */
const isProbe = (params: Query) => params['limit'] === 1 && params['includeTotal'] !== true;

/** The read of how many events the filters match. */
const isTotal = (params: Query) => params['includeTotal'] === true;

const client = () => new HttpClient({ baseUrl: 'http://localhost/api' });

const REVIEW = {
  source: 'bureau',
  kind: 'tool-approval',
  id: 'approval:run-4:c1',
  runId: 'run-4',
  agentName: 'tool-runner',
  requestedAt: NOW - 4 * MINUTE,
  ageMilliseconds: 4 * MINUTE,
  status: 'pending',
  sessionId: 'chat-1',
  round: 1,
  approval: {
    callId: 'c1',
    toolName: 'issue-refund',
    arguments: { orderId: '4471', cents: 4200, reason: 'damaged' },
    action: {
      type: 'approval',
      message: 'Refund order 4471 for $42.00?',
      risk: 'high',
      operation: { kind: 'tool' },
    },
  },
};

const CATALOG = {
  models: [],
  tools: [
    {
      name: 'issue-refund',
      description: 'Refund an order.',
      shortDescription: null,
      title: 'Issue refund',
      inputSchema: null,
      tier: 'dangerous',
      defaultApproval: 'ask',
      source: 'bureau',
      plugin: null,
      skill: null,
      users: ['tool-runner'],
    },
  ],
};

/**
 * Serves the log: `answer` says what each read finds, by what it asked. A read is answered from the
 * request and never from the order of calls, because the query library may ask twice.
 */
function open(
  answer: Page | ((params: Query) => Page),
  extra: Record<string, BureauHandler> = {},
  options: { scopes?: readonly string[]; at?: string } = {},
) {
  const respond = typeof answer === 'function' ? answer : () => answer;
  stub = installBureauStub({
    'bureau.audit.query': (params) =>
      isProbe(params)
        ? { records: [KEY_REMOVED], nextCursor: null }
        : isTotal(params)
          ? {
              records: [],
              nextCursor: null,
              total: respond(params).total ?? respond(params).records.length,
            }
          : respond(params),
    'bureau.agents.list': () => ({
      agents: [
        {
          name: 'tool-runner',
          displayName: 'tool-runner',
          description: null,
          kind: 'code',
          a2a: false,
          definitionRevision: 4,
          media: { image: false, audio: false, video: false, document: false },
          tools: [],
          examples: [],
        },
      ],
    }),
    'bureau.agents.catalog': () => CATALOG,
    'bureau.contexts.get': () => ({
      id: 'chat-1',
      owner: 'anonymous:local',
      agentName: 'tool-runner',
      title: 'Please refund order 4471, it arrived damaged.',
      lastMessagePreview: null,
      parentContextId: null,
      forkedFromMessageId: null,
      model: null,
      effort: null,
      permissionMode: 'on-changes',
      configVersion: 0,
      messageCount: 2,
      createdAt: new Date(NOW).toISOString(),
      updatedAt: new Date(NOW).toISOString(),
      activity: 'idle',
    }),
    'bureau.reviews.get': () => REVIEW,
    ...extra,
  });
  landAt(options.at ?? '/health/audit');
  return render(RouteOutletHarness, {
    props: { client: client(), scopes: options.scopes ?? AUTHORIZATION_SCOPES },
  } as never);
}

/** The reads of the log the page made, not the frame's probe or its count. */
const queries = (): Query[] =>
  (stub?.callsTo('bureau.audit.query') ?? [])
    .map((call) => call.params)
    .filter((params) => !isProbe(params) && !isTotal(params));

const rowsOf = (container: HTMLElement): HTMLElement[] => [
  ...container.querySelectorAll<HTMLElement>('tbody tr[data-cinder-row-id]'),
];

const cellsOf = (row: HTMLElement): string[] =>
  [...row.querySelectorAll('th, td')].map((cell) => cell.textContent?.trim() ?? '');

const frameState = (container: HTMLElement) =>
  container.querySelector('[data-view="audit"]')?.getAttribute('data-state');

const FULL: Page = {
  records: [KEY_REMOVED, ASKED, STARTED, NOISE, BOOTED],
  nextCursor: null,
};

describe('the table', () => {
  test('lists the events, newest first, with When, Who, What and Target, and leaves out a run’s steps', async () => {
    const { container, findByText } = open(FULL);

    await findByText('Removed the Anthropic key');
    expect(
      [...container.querySelectorAll('thead th')].map((cell) => cell.textContent?.trim()),
    ).toEqual([
      AUDIT_COPY.columns.when,
      AUDIT_COPY.columns.who,
      AUDIT_COPY.columns.what,
      AUDIT_COPY.columns.target,
    ]);
    // A sentence sharpens as what the page looks up for it arrives: the review and the chat.
    await waitFor(() =>
      expect(
        rowsOf(container).map((row) => [cellsOf(row)[1], cellsOf(row)[2], cellsOf(row)[3]]),
      ).toEqual([
        ['You', 'Removed the Anthropic key', 'Anthropic provider'],
        ['Tool runner', 'Asked to refund order 4471', 'Issue refund · order 4471'],
        ['You', 'Started a run', 'Chat › Please refund order 4471, it arrived damaged.'],
        ['Interborough', 'Server started', 'Interborough'],
      ]),
    );
    expect(frameState(container)).toBe('ready');
    // The Bureau is asked for events only, newest first, over the last seven days.
    const first = queries()[0] ?? {};
    expect(first['types']).toEqual([...AUDIT_EVENT_TYPES]);
    expect(first['order']).toBe('newest');
    expect(Number(first['since'])).toBeGreaterThan(NOW - 8 * 24 * 60 * MINUTE);
  });

  test('puts each day under a heading that names the zone', async () => {
    const { container, findByText } = open({
      records: [
        KEY_REMOVED,
        record(6, 3 * 24 * 60, {
          type: 'host.started',
          resource: 'host',
          principal: 'system:host',
          detail: null,
        }),
      ],
      nextCursor: null,
    });
    await findByText('Removed the Anthropic key');
    const headings = [...container.querySelectorAll('tbody th[colspan], tbody td[colspan]')].map(
      (cell) => cell.textContent?.replace(/\s+/g, ' ').trim(),
    );
    expect(headings).toHaveLength(2);
    expect(headings[0]).toMatch(/^Today, [A-Z][a-z]{2} \d+ · .+$/);
    expect(headings[1]).toMatch(/^[A-Z][a-z]{2} [A-Z][a-z]{2} \d+ · .+$/);
  });

  test('shows the filters in one row with the count, and Export as a secondary button after it', async () => {
    const { container, findByText, getByLabelText, getByPlaceholderText, getByRole, getByTestId } =
      open(FULL);
    await findByText('Removed the Anthropic key');

    expect((getByLabelText(AUDIT_COPY.actorLabel) as HTMLSelectElement).value).toBe('');
    expect((getByLabelText(AUDIT_COPY.periodLabel) as HTMLSelectElement).value).toBe('7d');
    expect((getByLabelText(AUDIT_COPY.actionLabel) as HTMLSelectElement).value).toBe('');
    const options = (label: string) =>
      [...(getByLabelText(label) as HTMLSelectElement).options].map((option) => option.text);
    expect(options(AUDIT_COPY.actionLabel)).toEqual([
      'Any action',
      'Approved',
      'Deleted',
      'Edited',
      'Removed',
      'Started',
    ]);
    expect(options(AUDIT_COPY.actorLabel)).toEqual(['Anyone', 'You', 'Agents', 'Interborough']);
    expect(getByPlaceholderText('Search by actor, action or target')).not.toBeNull();
    expect(getByTestId('audit-count').textContent).toBe('4 events');
    const exportButton = getByRole('button', { name: AUDIT_COPY.exportAction });
    expect(exportButton.getAttribute('data-cinder-variant')).toBe('secondary');
    expect(exportButton.querySelector('svg')).not.toBeNull();
    // The count reads before Export in the document, so the button ends the row.
    expect(
      getByTestId('audit-count').compareDocumentPosition(exportButton) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(container.querySelector('[data-page="audit"] tbody')).not.toBeNull();
  });

  test('says how many events there are while more are to be read, and how many are loaded once it has read them all', async () => {
    const { findByTestId } = open((params) => ({
      records: [KEY_REMOVED, STARTED],
      nextCursor: params['cursor'] === undefined ? 'c1' : null,
      total: 1240,
    }));
    const count = await findByTestId('audit-count');
    await waitFor(() => expect(count.textContent).toBe('1,240 events'));
  });
});

describe('the open event', () => {
  test('is the newest on load, with its row tinted and its pane beside the table', async () => {
    const { container, findByTestId } = open(FULL);
    const detail = await findByTestId('audit-detail');

    expect(detail.querySelector('h3')?.textContent).toBe('You removed the Anthropic key');
    expect(detail.textContent).toContain('from this browser');
    expect(detail.textContent).toContain('Anthropic');
    expect(detail.textContent).toContain(AUDIT_COPY.providerRemovedEffect);
    expect(rowsOf(container)[0]?.getAttribute('aria-current')).toBe('true');
    const link = [...detail.querySelectorAll('a')].find((a) =>
      a.textContent?.includes('Open Providers'),
    );
    expect(link?.getAttribute('href')).toBe('/settings/models');
    expect(detail.textContent).toContain(AUDIT_COPY.copyAsJson);
    // The footer names the retention and links to where it is set.
    expect(detail.textContent).toContain(
      'Audit records are kept 90 days (Settings › Data and retention).',
    );
    expect(detail.textContent).toContain('Export downloads the filtered list as JSON Lines.');
    expect(
      [...detail.querySelectorAll('a')]
        .find((a) => a.textContent === AUDIT_COPY.retention.link)
        ?.getAttribute('href'),
    ).toBe('/settings/data-and-retention');
  });

  test('is whichever row is chosen, and its record is kept in the address', async () => {
    const { container, findByTestId } = open(FULL);
    await findByTestId('audit-detail');

    await fireEvent.click(rowsOf(container)[3] as HTMLElement);

    await waitFor(() =>
      expect(document.querySelector('[data-testid="audit-detail"] h3')?.textContent).toBe(
        'Server started',
      ),
    );
    expect(new URLSearchParams(window.location.search).get('record')).toBe(`${BOOTED.timestamp}#1`);
  });

  test('a tool call that asks says what it asks, in the tool’s own words, and its status is Waiting on you', async () => {
    const { container, findByTestId, findByText } = open(FULL);
    await findByText('Asked to refund order 4471');
    const row = rowsOf(container).find((candidate) =>
      cellsOf(candidate).includes('Asked to refund order 4471'),
    ) as HTMLElement;
    expect(cellsOf(row)[3]).toBe('Issue refund · order 4471');

    await fireEvent.click(row);

    const detail = await findByTestId('audit-detail');
    await waitFor(() =>
      expect(detail.querySelector('h3')?.textContent).toBe(
        'Tool runner asked to refund order 4471',
      ),
    );
    expect(detail.textContent).toContain(
      'in the chat “Please refund order 4471, it arrived damaged.”',
    );
    const facts = [...detail.querySelectorAll('dl')].map((list) =>
      list.textContent?.replace(/\s+/g, ' ').trim(),
    );
    expect(facts).toEqual([
      'Tool Issue refund issue-refund',
      expect.stringContaining('Risk Dangerous · Can’t be undone'),
      'Amount $42.00',
      'Status Waiting on you',
    ]);
    expect(detail.querySelector('[data-status-word], .cinder-status-dot')).not.toBeNull();
    const review = [...detail.querySelectorAll('a')].find((a) =>
      a.textContent?.includes('Open review'),
    );
    expect(review?.getAttribute('href')).toBe('/reviews?review=approval%3Arun-4%3Ac1');
  });

  test('shows an agent’s change as its version and what changed, with the instructions’ diff clamped to six lines', async () => {
    const edited = record(7, 10, {
      type: 'agent.updated',
      resource: 'agent:tool-runner',
      detail: {
        agentName: 'tool-runner',
        revision: 4,
        previousRevision: 3,
        changedKeys: 'instructions,tools',
        toolsAdded: 'issue-refund',
      },
    });
    const instructions = (lines: string[]) => lines.join('\n');
    const definition = (text: string) => ({
      name: 'tool-runner',
      description: null,
      model: 'sonnet',
      tools: [],
      skillDescriptors: [],
      a2a: false,
      instructions: text,
    });
    const before = instructions([
      'Keep it short.',
      ...Array.from({ length: 40 }, (_, i) => `Rule ${i}`),
    ]);
    const after = instructions([
      'Be thorough.',
      ...Array.from({ length: 40 }, (_, i) => `Rule ${i} changed`),
    ]);
    const { findByTestId, container, findByText } = open(
      { records: [edited], nextCursor: null },
      {
        'bureau.agents.versions.list': () => ({
          versions: [
            {
              revision: 4,
              hash: 'b',
              savedAt: new Date(NOW).toISOString(),
              savedBy: null,
              definition: definition(after),
              changedKeys: [],
            },
            {
              revision: 3,
              hash: 'a',
              savedAt: new Date(NOW).toISOString(),
              savedBy: null,
              definition: definition(before),
              changedKeys: [],
            },
          ],
        }),
      },
    );
    await findByText('Edited an agent');
    expect(cellsOf(rowsOf(container)[0] as HTMLElement)[3]).toBe('Tool runner · version 3 → 4');

    const detail = await findByTestId('audit-detail');
    const facts = [...detail.querySelectorAll('dl')].map((list) =>
      list.textContent?.replace(/\s+/g, ' ').trim(),
    );
    expect(facts).toEqual([
      'Agent Tool runner',
      'Version 3 → 4',
      'Changed Instructions · Tools · added Issue refund',
    ]);
    const diff = await findByTestId('audit-instruction-diff');
    expect(diff.textContent).toContain('Showing 6 of');
    expect(diff.textContent).toContain('Show all');
    expect(detail.querySelector('a[href="/agents/tool-runner"]')).not.toBeNull();
  });

  test('a very long target is one line in the table and whole in the pane, with its length and Copy key', async () => {
    const key = `workflows/release-notes/${'checkpoints/'.repeat(160)}notes.json`;
    const deleted = record(8, 2, {
      type: 'storage.key.deleted',
      resource: `storage:${key}`,
      principal: 'system:host',
      detail: null,
    });
    const { container, findByTestId } = open({ records: [deleted], nextCursor: null });

    const detail = await findByTestId('audit-target');
    expect(detail.textContent).toContain(
      `Target · ${key.length.toLocaleString('en-US')} characters`,
    );
    expect(detail.textContent).toContain(key);
    expect(detail.querySelector('button')?.textContent?.trim()).toBe(AUDIT_COPY.copyKey);
    // The whole value is shown once, under its heading, and not again as a fact.
    expect(detail.querySelectorAll('dl')).toHaveLength(0);
    // The table cell keeps the full text in its title and ends it with an ellipsis, on one line.
    const cell = container.querySelector(
      'tbody td:last-child, tbody tr[data-cinder-row-id] td:last-child',
    );
    expect(cell?.textContent).toContain('Storage › ');
    expect(cell?.querySelector('.cinder-table__cell-text')?.getAttribute('title')).toBe(
      `Storage › ${key}`,
    );
  });

  test('the pane says to select an event when none is open, after the filters change', async () => {
    const { container, findByTestId, findByText, getByLabelText } = open((params) =>
      params['types'] !== undefined &&
      (params['types'] as string[]).length < AUDIT_EVENT_TYPES.length
        ? { records: [BOOTED], nextCursor: null }
        : FULL,
    );
    await findByTestId('audit-detail');
    expect(rowsOf(container)[0]?.getAttribute('aria-current')).toBe('true');

    await fireEvent.change(getByLabelText(AUDIT_COPY.actionLabel), {
      target: { value: 'started' },
    });

    await findByText(AUDIT_COPY.emptyDetailTitle);
    expect(window.location.search).not.toContain('record=');
  });
});

describe('the filters', () => {
  test('the period reaches the Bureau as `since`, and All time sends none', async () => {
    const { findByText, getByLabelText } = open(FULL);
    await findByText('Removed the Anthropic key');

    await fireEvent.change(getByLabelText(AUDIT_COPY.periodLabel), { target: { value: '30d' } });

    await waitFor(() => {
      const since = Number(queries().at(-1)?.['since']);
      expect(since).toBeLessThan(NOW - 29 * 24 * 60 * MINUTE);
    });
    expect(window.location.search).toContain('period=30d');
    await fireEvent.change(getByLabelText(AUDIT_COPY.periodLabel), { target: { value: 'all' } });
    await waitFor(() => expect(queries().at(-1)).not.toHaveProperty('since'));
  });

  test('the action reaches the Bureau as the types of that kind', async () => {
    const { findByText, getByLabelText } = open(FULL);
    await findByText('Removed the Anthropic key');

    await fireEvent.change(getByLabelText(AUDIT_COPY.actionLabel), {
      target: { value: 'removed' },
    });

    await waitFor(() =>
      expect(queries().at(-1)?.['types']).toEqual(['tool.source.removed', 'provider.disconnected']),
    );
    expect(window.location.search).toContain('action=removed');
  });

  test('Who narrows what was read without asking the Bureau again, and Agents are the agents', async () => {
    const { container, findByText, getByLabelText } = open(FULL);
    await findByText('Removed the Anthropic key');

    await fireEvent.change(getByLabelText(AUDIT_COPY.actorLabel), { target: { value: 'agents' } });

    await waitFor(() =>
      expect(rowsOf(container).map((row) => cellsOf(row)[1])).toEqual(['Tool runner']),
    );
    expect(new Set(queries().map((params) => JSON.stringify(params))).size).toBe(1);
    await fireEvent.change(getByLabelText(AUDIT_COPY.actorLabel), {
      target: { value: 'interborough' },
    });
    await waitFor(() =>
      expect(rowsOf(container).map((row) => cellsOf(row)[1])).toEqual(['Interborough']),
    );
  });

  test('the search matches the actor, the action or the target, whatever its case, and says how many it found', async () => {
    const { container, findByText, getByPlaceholderText, getByTestId } = open(FULL);
    await findByText('Removed the Anthropic key');

    await fireEvent.input(getByPlaceholderText('Search by actor, action or target'), {
      target: { value: 'ANTHROPIC' },
    });

    await waitFor(() => expect(rowsOf(container)).toHaveLength(1));
    expect(getByTestId('audit-count').textContent).toBe('1 event');
    expect(window.location.search).toContain('q=ANTHROPIC');
  });

  test('a search with no match keeps what was typed and says so, and Clear filters resets the search too', async () => {
    const { findByText, getByPlaceholderText, getByRole } = open(FULL);
    await findByText('Removed the Anthropic key');
    const box = getByPlaceholderText('Search by actor, action or target') as HTMLInputElement;

    await fireEvent.input(box, { target: { value: 'refund 9999' } });

    // Row 83h: the title names the search, and the box keeps what was typed.
    await findByText('No events match “refund 9999”');
    await findByText(AUDIT_COPY.noMatches.searchHint);
    expect(box.value).toBe('refund 9999');
    await fireEvent.click(getByRole('button', { name: AUDIT_COPY.noMatches.clear }));
    await findByText('Removed the Anthropic key');
    expect(box.value).toBe('');
    expect(window.location.search).toBe('');
  });

  test('the address holds the filters, so a search can be linked to and survives a reload', async () => {
    const { getByLabelText, findByText } = open(
      FULL,
      {},
      { at: '/health/audit?actor=you&period=today&action=started&q=run' },
    );
    await findByText('Started a run');

    expect((getByLabelText(AUDIT_COPY.actorLabel) as HTMLSelectElement).value).toBe('you');
    expect((getByLabelText(AUDIT_COPY.periodLabel) as HTMLSelectElement).value).toBe('today');
    expect((getByLabelText(AUDIT_COPY.actionLabel) as HTMLSelectElement).value).toBe('started');
  });

  test('a value the page does not offer is the default', async () => {
    const { getByLabelText, findByText } = open(
      FULL,
      {},
      { at: '/health/audit?actor=nobody&period=forever&action=exploded' },
    );
    await findByText('Removed the Anthropic key');
    expect((getByLabelText(AUDIT_COPY.actorLabel) as HTMLSelectElement).value).toBe('');
    expect((getByLabelText(AUDIT_COPY.periodLabel) as HTMLSelectElement).value).toBe('7d');
  });
});

describe('an empty log', () => {
  test('filters that match nothing are the filtered empty state, which clears them', async () => {
    const { findByRole, getByRole, findByText } = open(
      (params) =>
        (params['types'] as string[]).length === 1 ? { records: [], nextCursor: null } : FULL,
      {},
      { at: '/health/audit?action=approved' },
    );

    await findByRole('heading', { name: AUDIT_COPY.noMatches.title });
    await findByText('Nothing approved was recorded in the last 7 days. Try a longer period.');
    await fireEvent.click(getByRole('button', { name: AUDIT_COPY.noMatches.clear }));
    await findByText('Removed the Anthropic key');
  });

  test('Agents and Today: the count reads 0 events, and the empty state says what was not recorded, with a search icon in a neutral disc', async () => {
    const { container, findByRole, findByText, getByTestId } = open(
      { records: [], nextCursor: null },
      {},
      { at: '/health/audit?actor=agents&period=today' },
    );

    await findByRole('heading', { name: 'No events match these filters' });
    await findByText('Nothing by agents was recorded today. Try a longer period.');
    expect(getByTestId('audit-count').textContent).toBe('0 events');
    const state = container.querySelector('.cinder-empty-state') as HTMLElement;
    expect(state.getAttribute('data-cinder-kind')).toBe('filtered');
    expect(state.querySelector('.cinder-empty-state-icon svg')).not.toBeNull();
  });

  test('a period the log already reaches back through the most of offers a different filter, not a longer period', async () => {
    const { findByText } = open(
      { records: [], nextCursor: null },
      {},
      { at: '/health/audit?period=all&action=removed&actor=you' },
    );

    await findByText('Nothing removed by you has been recorded. Change or clear a filter.');
  });

  test('a default view of a log that holds events but none in the period has nothing to clear', async () => {
    const { findByText, queryByRole } = open({ records: [], nextCursor: null });

    await findByText('Nothing was recorded in the last 7 days. Try a longer period.');
    expect(queryByRole('button', { name: AUDIT_COPY.noMatches.clear })).toBeNull();
  });

  test('a log with nothing in it is the first-use empty state, with nothing to clear', async () => {
    stub = installBureauStub({
      'bureau.audit.query': () => ({ records: [], nextCursor: null }),
    });
    landAt('/health/audit');
    const { container, findByRole, queryByRole } = render(RouteOutletHarness, {
      props: { client: client(), scopes: AUTHORIZATION_SCOPES },
    } as never);

    // Row 82u: the empty state is the page body, with a document icon and no action; the filter
    // row has nothing to filter, and Health's own heading and tabs stay.
    await findByRole('heading', { name: 'Nothing recorded yet' });
    expect(
      queryByRole('button', { name: AUDIT_COPY.noMatches.clear }) ?? queryByRole('link'),
    ).toBeNull();
    expect(container.querySelector('.cinder-empty-state-action')).toBeNull();
    expect(container.querySelector('.cinder-empty-state-icon svg')).not.toBeNull();
    expect(container.querySelector('[role="search"]')).toBeNull();
    expect(container.querySelector('[data-page="health"]')).not.toBeNull();
    expect(frameState(container)).toBe('empty');
  });
});

describe('an address that names an event', () => {
  test('reads on to the page that holds the event, and opens it', async () => {
    const wanted = record(3, 30, {
      type: 'host.started',
      resource: 'host',
      principal: 'system:host',
      detail: null,
    });
    const { findByTestId } = open(
      (params) =>
        params['cursor'] === 'c1'
          ? { records: [wanted], nextCursor: null }
          : { records: [KEY_REMOVED], nextCursor: 'c1' },
      {},
      { at: `/health/audit?record=${encodeURIComponent(`${wanted.timestamp}#3`)}` },
    );

    const detail = await findByTestId('audit-detail');
    await waitFor(() => expect(detail.querySelector('h3')?.textContent).toBe('Server started'));
  });

  test('reads twenty pages, then says the event was not found', async () => {
    const { findByText } = open(
      (params) => {
        const page = typeof params['cursor'] === 'string' ? Number(params['cursor'].slice(1)) : 0;
        return { records: [record(page + 1, page + 1)], nextCursor: `c${String(page + 1)}` };
      },
      {},
      { at: '/health/audit?record=nowhere%231' },
    );

    await findByText(AUDIT_COPY.recordNotFound.more);
    expect(queries()).toHaveLength(20);
  });
});

describe('Export', () => {
  let originalCreate: typeof URL.createObjectURL;
  let originalRevoke: typeof URL.revokeObjectURL;
  let blobs: Blob[];
  let names: string[];
  let originalClick: typeof HTMLAnchorElement.prototype.click;

  beforeEach(() => {
    blobs = [];
    names = [];
    originalCreate = URL.createObjectURL;
    originalRevoke = URL.revokeObjectURL;
    originalClick = HTMLAnchorElement.prototype.click;
    URL.createObjectURL = (blob) => {
      blobs.push(blob as Blob);
      return 'blob:audit';
    };
    URL.revokeObjectURL = () => {};
    HTMLAnchorElement.prototype.click = function click(this: HTMLAnchorElement) {
      names.push(this.download);
    };
  });

  afterEach(() => {
    URL.createObjectURL = originalCreate;
    URL.revokeObjectURL = originalRevoke;
    HTMLAnchorElement.prototype.click = originalClick;
  });

  test('downloads every page the filters match as JSON Lines, events only, newest first', async () => {
    const { findByText, getByRole } = open((params) =>
      params['cursor'] === 'c1'
        ? { records: [BOOTED], nextCursor: null }
        : { records: [KEY_REMOVED, NOISE], nextCursor: 'c1' },
    );
    await findByText('Removed the Anthropic key');

    await fireEvent.click(getByRole('button', { name: AUDIT_COPY.exportAction }));

    await waitFor(() => expect(blobs).toHaveLength(1));
    const text = await blobs[0]!.text();
    expect(
      text
        .trimEnd()
        .split('\n')
        .map((line) => (JSON.parse(line) as { sequence: number }).sequence),
    ).toEqual([5, 1]);
    expect(blobs[0]!.type).toBe('application/x-ndjson');
    expect(names[0]).toMatch(/^audit-log-\d{4}-\d{2}-\d{2}\.jsonl$/);
  });

  test('with Who or a search set, saves the events on screen', async () => {
    const { findByText, getByRole } = open(FULL, {}, { at: '/health/audit?actor=agents' });
    await findByText('Asked to use Issue refund');

    await fireEvent.click(getByRole('button', { name: AUDIT_COPY.exportAction }));

    await waitFor(() => expect(blobs).toHaveLength(1));
    const saved = await blobs[0]!.text();
    const lines = saved.trimEnd().split('\n');
    expect(lines.map((line) => (JSON.parse(line) as { sequence: number }).sequence)).toEqual([4]);
  });

  test('saves no file when nothing matches', async () => {
    const { findByText, getByRole } = open(FULL, {}, { at: '/health/audit?q=nothing-says-this' });
    await findByText('No events match “nothing-says-this”');

    await fireEvent.click(getByRole('button', { name: AUDIT_COPY.exportAction }));

    await findByText(AUDIT_COPY.nothingToExport);
    expect(blobs).toHaveLength(0);
  });

  test('a failed export is a danger alert with Export again at its right, and Export stays the retry', async () => {
    const { container, findByText, getByRole, findByRole } = open(FULL);
    await findByText('Removed the Anthropic key');
    stub?.on('bureau.audit.query', () => {
      throw new StubFault('Unavailable', 503, 'The log is down.');
    });

    await fireEvent.click(getByRole('button', { name: AUDIT_COPY.exportAction }));

    // Row 83e: the lead, why, that the filters are as they were and nothing was downloaded.
    const lead = await findByText(AUDIT_COPY.exportFailed.lead);
    const alert = lead.closest('[role="alert"]');
    expect(alert?.textContent).toContain(AUDIT_COPY.exportFailed.answered);
    expect(alert?.getAttribute('data-cinder-variant')).toBe('danger');
    expect(blobs).toHaveLength(0);
    const again = alert?.querySelector('.cinder-alert__actions button');
    expect(again?.textContent?.trim()).toBe('Export again');
    // The filters are unchanged, and the log is still on screen.
    expect(window.location.search).not.toMatch(/actor=|period=|action=|q=/);
    expect(rowsOf(container).length).toBeGreaterThan(0);
    expect(getByRole('button', { name: AUDIT_COPY.exportAction })).not.toBeNull();

    stub?.on('bureau.audit.query', () => FULL);
    await fireEvent.click(await findByRole('button', { name: 'Export again' }));
    await waitFor(() => expect(blobs).toHaveLength(1));
    await waitFor(() => expect(container.querySelector('.cinder-alert') === null).toBe(true));
  });

  test('while Export reads the log it is replaced by its status, and a line says how many events it prepares, with Cancel', async () => {
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { findByRole, findByTestId, findByText, getByRole, getByTestId, queryByTestId } =
      open(FULL);
    await findByText('Removed the Anthropic key');
    stub?.on('bureau.audit.query', async (params) => {
      if (params['limit'] === 100) await held;
      return isTotal(params) ? { records: [], nextCursor: null, total: 1240 } : FULL;
    });

    await fireEvent.click(getByRole('button', { name: AUDIT_COPY.exportAction }));

    // Row 83d: the button reads Exporting… and is inert; the line below says what is being made.
    await findByTestId('audit-export-progress');
    const button = await findByRole('button', { name: 'Exporting…' });
    expect(button.getAttribute('aria-disabled')).toBe('true');
    const progress = await findByTestId('audit-export-progress');
    // It repeats the count beside the search (the noise record the log leaves out is not counted).
    expect(getByTestId('audit-count').textContent).toBe('4 events');
    expect(progress.textContent).toContain('Preparing 4 events as JSON Lines…');
    await fireEvent.click(getByRole('button', { name: AUDIT_COPY.exportCancel }));
    // A failing `toBeNull` on an element formats the whole element, so the wait asks a boolean.
    await waitFor(() => expect(queryByTestId('audit-export-progress') === null).toBe(true));
    // Cancelling is not a failure: no alert, and the button is Export again.
    expect(document.querySelector('.cinder-alert')).toBeNull();
    expect(getByRole('button', { name: AUDIT_COPY.exportAction })).not.toBeNull();
    release?.();
    expect(blobs).toHaveLength(0);
  });
});

describe('who may see it', () => {
  test('a principal holding no console scope sees the events, not a forbidden view', async () => {
    const { container, findByText } = open(FULL, {}, { scopes: [] });

    await findByText('Removed the Anthropic key');
    expect(frameState(container)).toBe('ready');
  });

  test('a refusal from the Bureau is the forbidden state', async () => {
    stub = installBureauStub({
      'bureau.audit.query': () => {
        throw new StubFault('Forbidden', 403, 'Not yours.');
      },
    });
    landAt('/health/audit');
    const { container, findByRole } = render(RouteOutletHarness, {
      props: { client: client(), scopes: AUTHORIZATION_SCOPES },
    } as never);

    await findByRole('heading', { level: 1, name: VIEW_COPY.audit.forbidden.title });
    expect(frameState(container)).toBe('forbidden');
  });

  test('a read that fails when the log had nothing on screen is a full error state with Try again and Open Health', async () => {
    let failing = false;
    stub = installBureauStub({
      'bureau.audit.query': (params) => {
        if (isProbe(params)) return { records: [KEY_REMOVED], nextCursor: null };
        if (failing) throw new StubFault('Unavailable', 503, 'The log is down.');
        return FULL;
      },
    });
    landAt('/health/audit');
    const { container, findByText, getByLabelText, getByRole } = render(RouteOutletHarness, {
      props: { client: client(), scopes: AUTHORIZATION_SCOPES },
    } as never);
    await findByText('Removed the Anthropic key');
    failing = true;
    await fireEvent.change(getByLabelText(AUDIT_COPY.periodLabel), { target: { value: 'all' } });

    // Row 82w: Health's own heading stays, the error says the status, and the second action is Open Health.
    await findByText(AUDIT_COPY.failed.title);
    expect(container.textContent).toContain(
      'The server answered with an error (503). Nothing you did caused it.',
    );
    expect(container.querySelector('[data-page="health"]')).not.toBeNull();
    expect(container.querySelector('[role="search"]')).toBeNull();
    const retry = getByRole('button', { name: RETRY_LABEL });
    expect(retry.getAttribute('data-cinder-variant')).toBe('primary');
    expect(retry.querySelector('svg')).not.toBeNull();
    const open = getByRole('link', { name: AUDIT_COPY.failed.openHealth });
    expect(open.getAttribute('href')).toContain('/health');
    expect(container.textContent).not.toContain('Check Health');
    expect(container.querySelector('.cinder-banner')).toBeNull();

    failing = false;
    await fireEvent.click(retry);
    await findByText('Removed the Anthropic key');
  });

  test('a read that does not answer at all says so, not a status', async () => {
    stub = installBureauStub({
      'bureau.audit.query': (params) => {
        if (isProbe(params)) return { records: [KEY_REMOVED], nextCursor: null };
        throw new TypeError('fetch failed');
      },
    });
    landAt('/health/audit');
    const { findByText } = render(RouteOutletHarness, {
      props: { client: client(), scopes: AUTHORIZATION_SCOPES },
    } as never);

    await findByText(AUDIT_COPY.failed.title);
    await findByText(AUDIT_COPY.failed.noAnswer);
  });
});

describe('a refresh that fails over events on screen', () => {
  test('keeps the events under the shared banner, holds only Export, and Retry now reads again', async () => {
    let failing = false;
    stub = installBureauStub({
      'bureau.audit.query': (params) => {
        if (isProbe(params)) return { records: [KEY_REMOVED], nextCursor: null };
        if (failing) throw new StubFault('Unavailable', 503, 'The log is down.');
        return isTotal(params) ? { records: [], nextCursor: null, total: 5 } : FULL;
      },
    });
    landAt('/health/audit');
    let queryClient: QueryClient | undefined;
    const { container, findByText } = render(RouteOutletHarness, {
      props: {
        client: client(),
        scopes: AUTHORIZATION_SCOPES,
        onQueryClient: (created: QueryClient) => {
          queryClient = created;
        },
      },
    } as never);
    await findByText('Removed the Anthropic key');
    const view = within(container);
    const exportButton = view.getByRole('button', { name: AUDIT_COPY.exportAction });
    expect(exportButton.getAttribute('aria-disabled')).toBeNull();

    failing = true;
    await queryClient?.invalidateQueries({ queryKey: ['audit', 'list'] });
    const banner = await view.findByRole('region', { name: 'Refresh problem' });

    // Row 83a: the shared preset's words, with a Retry now and no dismiss.
    expect(banner.textContent).toContain('Couldn’t refresh this page.');
    expect(banner.textContent).toMatch(/Showing what loaded as of .+\./);
    expect(banner.textContent).not.toMatch(/Retrying in|attempt/);
    expect(banner.querySelector('[aria-label*="ismiss"]')).toBeNull();
    // Rows 83b: the events stay, and the banner sits between the filters and the table.
    expect(rowsOf(container).length).toBeGreaterThan(0);
    const filters = container.querySelector('[role="search"]') as Element;
    const table = container.querySelector('table') as Element;
    expect(filters.compareDocumentPosition(banner) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(banner.compareDocumentPosition(table) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Row 83c: Export is inert with its reason as its description; the filters and rows are live.
    expect(exportButton.getAttribute('aria-disabled')).toBe('true');
    const reasonId = exportButton.getAttribute('aria-describedby') ?? '';
    expect(container.ownerDocument.getElementById(reasonId)?.textContent).toBe(
      AUDIT_COPY.exportOff,
    );
    expect(
      (view.getByLabelText(AUDIT_COPY.periodLabel) as HTMLSelectElement).getAttribute(
        'aria-disabled',
      ),
    ).toBeNull();
    expect(
      view.getByRole('button', { name: 'Retry now' }).getAttribute('aria-disabled'),
    ).toBeNull();

    failing = false;
    await fireEvent.click(view.getByRole('button', { name: 'Retry now' }));
    await waitFor(() =>
      expect(view.queryByRole('region', { name: 'Refresh problem' }) === null).toBe(true),
    );
    expect(exportButton.getAttribute('aria-disabled')).toBeNull();
    expect(rowsOf(container).length).toBeGreaterThan(0);
  });

  test('does not ask again by itself for the next page of a narrowed log once that read failed', async () => {
    stub = installBureauStub({
      'bureau.audit.query': (params) => {
        if (isProbe(params)) return { records: [KEY_REMOVED], nextCursor: null };
        if (params['cursor'] === 'c1') throw new StubFault('Broken', 500, 'The log is down.');
        return isTotal(params)
          ? { records: [], nextCursor: null, total: 9 }
          : { records: [KEY_REMOVED, BOOTED], nextCursor: 'c1' };
      },
    });
    // A search reads on by itself, looking for what it narrows to; the second page fails.
    landAt('/health/audit?q=anthropic');
    const { findByRole } = render(RouteOutletHarness, {
      props: { client: client(), scopes: AUTHORIZATION_SCOPES },
    } as never);
    await findByRole('region', { name: 'Refresh problem' });
    const secondPageReads = () => queries().filter((params) => params['cursor'] === 'c1');
    const first = secondPageReads().length;
    expect(first).toBeGreaterThan(0);

    // Asking again after a failure would repeat at once, and again after that.
    await quietFor(100);
    expect(secondPageReads()).toHaveLength(first);
  });
});

describe('a log that is slow to read', () => {
  /** The page with a log that never answers, once it has waited long enough to offer Cancel. */
  async function openHanging() {
    // The route's page is loaded on demand; load it first so that mounting it needs no real time.
    await import('./index.svelte');
    jest.useFakeTimers();
    const view = open(FULL, {
      'bureau.audit.query': (params) =>
        isProbe(params) ? { records: [KEY_REMOVED], nextCursor: null } : new Promise(() => {}),
    });
    for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
    flushSync();
    jest.advanceTimersByTime(10_500);
    flushSync();
    return view;
  }

  test('Cancel stops the read and says nothing was changed, and Try again reads once more', async () => {
    const view = await openHanging();
    await fireEvent.click(view.getByRole('button', { name: /cancel/i }));
    flushSync();
    expect(view.getByText(AUDIT_COPY.stopped.title)).not.toBeNull();
    expect(view.getByText(AUDIT_COPY.stopped.description)).not.toBeNull();
    expect(view.queryByTestId('audit-loading')).toBeNull();

    const before = queries().length;
    await fireEvent.click(view.getByRole('button', { name: RETRY_LABEL }));
    flushSync();
    expect(view.queryByText(AUDIT_COPY.stopped.title)).toBeNull();
    expect(view.getByTestId('audit-loading')).not.toBeNull();
    expect(queries().length).toBeGreaterThanOrEqual(before);
  });

  test('pressing Enter in the search box submits nothing', async () => {
    const view = open(FULL);
    await view.findByText('Removed the Anthropic key');
    const form = view.getByRole('search', { name: AUDIT_COPY.searchLabel });
    // A submit that is not prevented would reload the page; this one is taken over.
    expect(await fireEvent.submit(form)).toBe(false);
  });
});

describe('what the page looks up to word an event', () => {
  const SCHEDULE = (id: string, description: string | null) => ({
    id,
    owner: 'anonymous:local',
    agentName: null,
    inputPreview: null,
    workflowType: 'daily-report',
    description,
    cronExpression: '0 9 * * *',
    intervalMs: null,
    status: 'active',
    overlap: 'skip',
    revision: 1,
    timeZone: 'America/Denver',
    nextFireAt: null,
    skippedOccurrences: [],
    lastFireAt: null,
    missedFireCount: 0,
    skippedCount: 0,
    createdAt: new Date(NOW).toISOString(),
    updatedAt: new Date(NOW).toISOString(),
    blocker: null,
  });

  test('a memory an agent corrected is quoted, and a schedule is called by its name when it has one', async () => {
    const corrected = record(7, 2, {
      type: 'memory.corrected',
      principal: 'run-7',
      detail: { agentName: 'tool-runner', writer: 'agent', memoryId: 'm-1' },
    });
    const named = record(8, 3, {
      type: 'schedule.created',
      resource: 'schedule:s-1',
      detail: { scheduleId: 's-1' },
    });
    const unnamed = record(9, 4, {
      type: 'schedule.paused',
      resource: 'schedule:s-2',
      detail: { scheduleId: 's-2' },
    });
    const view = open(
      { records: [corrected, named, unnamed], nextCursor: null },
      {
        'bureau.memory.get': () => ({
          memory: {
            id: 'm-1',
            content: 'prefers long summaries',
            memoryClass: 'preference',
            source: 'agent',
            trust: 'trusted',
            createdAt: new Date(NOW).toISOString(),
            sessionId: null,
          },
          lineage: { runId: null, corrects: null, correctedBy: null },
        }),
        'bureau.schedules.list': () => ({
          schedules: [SCHEDULE('s-1', 'Daily summary'), SCHEDULE('s-2', null)],
          nextOffset: null,
        }),
      },
    );
    await view.findByText('“prefers long summaries”');
    await view.findByText('Daily summary');
    // A schedule with no name is a schedule, not an identifier.
    expect(view.getAllByText('A schedule').length).toBeGreaterThan(0);
  });
});
