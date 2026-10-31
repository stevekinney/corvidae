/**
 * `/health/audit` (COR-1493): the audit trail, searched by `bureau.audit.query`. Each filter the operation
 * takes reaches it (`since`, a free-text `type`, and a resource sent as `runId`), the records come
 * oldest first as the Bureau returns them, and Load more follows `nextCursor`. Owner scoping is the
 * gate, so the view holds no scope of its own.
 */
import { HttpClient } from '@lostgradient/weft';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { AUDIT_COPY, RETRY_LABEL, VIEW_COPY } from '../../app/copy.ts';
import RouteOutletHarness from '../../app/shell/route-outlet.test-harness.svelte';
import {
  installBureauStub,
  StubFault,
  type BureauStub,
} from '../../lib/bureau-stub.test-support.ts';
import { router } from '../../lib/router.svelte.ts';
import { AUTHORIZATION_SCOPES } from '../../lib/scopes.svelte.ts';
import { landAt } from '../chat/pages.test-support.ts';

let stub: BureauStub | undefined;
afterEach(() => {
  cleanup();
  stub?.restore();
  stub = undefined;
});

function record(sequence: number, overrides: Record<string, unknown> = {}) {
  return {
    sequence,
    timestamp: `2026-10-19T08:0${String(sequence)}:00.000Z`,
    type: 'run.completed',
    resource: `run-${String(sequence)}`,
    principal: 'anonymous:local',
    detail: { status: 'completed' },
    ...overrides,
  };
}

type Query = Record<string, unknown>;
type Page = { records: unknown[]; nextCursor: string | null };

/** The one record the view frame's probe asks for, to learn whether the trail is empty. */
const isProbe = (params: Query) => params['limit'] === 1;

/** The first page of the whole trail, which the Type select reads for the types to offer. */
const isTypesRead = (params: Query) => params['limit'] === 100;

const client = () => new HttpClient({ baseUrl: 'http://localhost/api' });

/**
 * Serves the trail: `answer` says what each search finds, by what it asked. A search is answered
 * from the request and never from the order of calls, because the query library may ask twice.
 */
function open(
  answer: Page | ((params: Query) => Page),
  options: { scopes?: readonly string[] } = {},
) {
  const respond = typeof answer === 'function' ? answer : () => answer;
  stub = installBureauStub({
    'bureau.audit.query': (params) =>
      isProbe(params) ? { records: [record(1)], nextCursor: null } : respond(params),
  });
  landAt('/health/audit');
  return render(RouteOutletHarness, {
    props: { client: client(), scopes: options.scopes ?? AUTHORIZATION_SCOPES },
  } as never);
}

/** The searches the page made, not the frame's probe or the read of the types. */
const queries = (): Query[] =>
  (stub?.callsTo('bureau.audit.query') ?? [])
    .map((call) => call.params)
    .filter((p) => !isProbe(p) && !isTypesRead(p));

const OTHER_TYPE = '__other__';

const rows = (container: HTMLElement) =>
  [...container.querySelectorAll<HTMLElement>('[data-record]')].map((row) => row.dataset['record']);

const frameState = (container: HTMLElement) =>
  container.querySelector('[data-view="audit"]')?.getAttribute('data-state');

describe('the trail', () => {
  test('lists the records in the order the Bureau returns them, oldest first, with who, what and when on each', async () => {
    const { container, findByText } = open({
      records: [record(1), record(2, { type: 'schedule.created', resource: 'schedule:s-1' })],
      nextCursor: null,
    });

    await findByText('schedule:s-1');
    expect(rows(container)).toEqual(['1', '2']);
    const second = container.querySelector('[data-record="2"]');
    expect(second?.textContent).toContain('schedule.created');
    expect(second?.textContent).toContain('anonymous:local');
    expect(second?.querySelector('time')?.getAttribute('datetime')).toBe(
      '2026-10-19T08:02:00.000Z',
    );
    expect(frameState(container)).toBe('ready');
    // Nothing narrows the first search, and it asks for no bound or ordering the Bureau lacks.
    const first = queries()[0] ?? {};
    for (const name of ['since', 'type', 'runId', 'until', 'cursor', 'order']) {
      expect(first, name).not.toHaveProperty(name);
    }
  });

  test('says how many records are loaded, and that there are more when the Bureau hands back a cursor', async () => {
    const { findByTestId } = open({ records: [record(1), record(2)], nextCursor: 'c1' });
    const count = await findByTestId('audit-count');
    expect(count.textContent).toBe(AUDIT_COPY.count(2, true));
  });
});

describe('a record', () => {
  test('is a row of the list; the pane says to choose one until it is opened, and then holds the record', async () => {
    const { container, findByText, findByTestId, queryByTestId, getByRole } = open({
      records: [
        record(1),
        record(2, { type: 'schedule.created', resource: 'schedule:s-1', detail: { status: 'ok' } }),
      ],
      nextCursor: null,
    });
    await findByText('schedule:s-1');
    expect(queryByTestId('audit-detail')).toBeNull();

    await fireEvent.click(container.querySelector('button[data-record="2"]') as HTMLElement);

    const detail = await findByTestId('audit-detail');
    expect(detail.getAttribute('data-record')).toBe('2');
    expect(detail.textContent).toContain('schedule.created');
    expect(detail.textContent).toContain('anonymous:local');
    expect(detail.textContent).toContain('status');
    // The raw JSON is introduced by a heading, shown with the record and not before.
    expect(detail.textContent).toContain(AUDIT_COPY.rawRecord);
    expect(detail.textContent).toContain('"sequence": 2');
    expect(
      getByRole('link', { name: AUDIT_COPY.openResource('schedule:s-1') }).getAttribute('href'),
    ).toBe('/schedules/s-1');
  });

  test('keeps the open record in the address, so it can be linked to', async () => {
    const { container, findByText, findByTestId } = open({
      records: [record(1), record(2)],
      nextCursor: null,
    });
    await findByText('run-2');
    await fireEvent.click(container.querySelector('button[data-record="2"]') as HTMLElement);
    await findByTestId('audit-detail');

    expect(new URLSearchParams(window.location.search).get('record')).toBe(
      '2026-10-19T08:02:00.000Z#2#0',
    );
  });

  test('shows a value before and after side by side, and the other fields as they are', async () => {
    const { container, findByText, findByTestId } = open({
      records: [
        record(1, {
          type: 'settings.changed',
          resource: 'agent:helper',
          detail: { before: 'low', after: 'high', field: 'effort' },
        }),
      ],
      nextCursor: null,
    });
    await findByText('agent:helper');
    await fireEvent.click(container.querySelector('button[data-record="1"]') as HTMLElement);

    const before = await findByTestId('audit-before');
    const after = await findByTestId('audit-after');
    expect(before.textContent?.trim()).toBe('low');
    expect(after.textContent?.trim()).toBe('high');
    const detail = await findByTestId('audit-detail');
    expect(detail.textContent).toContain('effort');
    expect(detail.textContent).toContain(AUDIT_COPY.fact.beforeAfter);
  });

  test('has no before and after section when its detail names neither', async () => {
    const { container, findByText, findByTestId, queryByTestId } = open({
      records: [record(1)],
      nextCursor: null,
    });
    await findByText('run-1');
    await fireEvent.click(container.querySelector('button[data-record="1"]') as HTMLElement);
    await findByTestId('audit-detail');
    expect(queryByTestId('audit-change')).toBeNull();
  });

  test('links a run by its id, and names no link for a resource it has no page for', async () => {
    const { container, findByText, findByTestId, queryByRole } = open({
      records: [record(1, { resource: 'run-abc' }), record(2, { resource: 'run-xyz', type: 'x' })],
      nextCursor: null,
    });
    await findByText('run-abc');
    await fireEvent.click(container.querySelector('button[data-record="1"]') as HTMLElement);
    await findByTestId('audit-detail');
    expect(
      queryByRole('link', { name: AUDIT_COPY.openResource('run-abc') })?.getAttribute('href'),
    ).toBe('/runs/run-abc');
  });

  test('opens the thing it is about when the link is clicked, and leaves a modified click to the browser', async () => {
    const { container, findByText, findByTestId, getByRole } = open({
      records: [record(1, { resource: 'schedule:s-7' })],
      nextCursor: null,
    });
    await findByText('schedule:s-7');
    await fireEvent.click(container.querySelector('button[data-record="1"]') as HTMLElement);
    await findByTestId('audit-detail');
    const link = getByRole('link', { name: AUDIT_COPY.openResource('schedule:s-7') });

    // A click with a modifier is the browser's (a new tab), so the page does not navigate.
    expect(await fireEvent.click(link, { metaKey: true })).toBe(true);
    expect(router.pathname).toBe('/health/audit');

    expect(await fireEvent.click(link)).toBe(false);
    expect(router.pathname).toBe('/schedules/s-7');
  });

  test('is plain text when it names nothing a page exists for, and shows a time it cannot read as it was written', async () => {
    const { container, findByText, findByTestId, queryByRole } = open({
      records: [record(1, { resource: '', timestamp: 'not a time' })],
      nextCursor: null,
    });
    await findByText('not a time');
    await fireEvent.click(container.querySelector('button[data-record="1"]') as HTMLElement);
    await findByTestId('audit-detail');
    expect(queryByRole('link')).toBeNull();
  });

  test('is named for its actor, or None when the record names none', async () => {
    const { container, findByText } = open({
      records: [record(1, { principal: null, resource: 'run-nobody' })],
      nextCursor: null,
    });
    await findByText('run-nobody');

    expect(container.querySelector('[data-record="1"] .ib-audit__who')?.textContent).toBe(
      AUDIT_COPY.noActor,
    );
  });
});

describe('the filters', () => {
  test('a time reaches the operation as `since`, in epoch milliseconds', async () => {
    const since = new Date('2026-10-19T08:30').getTime();
    const { findByLabelText, getByRole, findByText } = open((params) => ({
      records: [record(2, { resource: params['since'] === undefined ? 'run-all' : 'run-since' })],
      nextCursor: null,
    }));
    await findByText('run-all');

    await fireEvent.input(await findByLabelText(AUDIT_COPY.sinceLabel), {
      target: { value: '2026-10-19T08:30' },
    });
    await fireEvent.click(getByRole('button', { name: AUDIT_COPY.searchAction }));

    await findByText('run-since');
    expect(queries().at(-1)).toMatchObject({ since });
  });

  test('a type picked from the types the trail has shown reaches the operation as `type`', async () => {
    const { findByLabelText, getByRole, findByText } = open((params) => ({
      records: [
        record(1, { type: 'run.completed', resource: 'run-all' }),
        record(2, { type: 'schedule.created', resource: 'schedule:s-1' }),
      ].filter((entry) => params['type'] === undefined || entry.type === params['type']),
      nextCursor: null,
    }));
    await findByText('run-all');

    const select = (await findByLabelText(AUDIT_COPY.typeLabel)) as HTMLSelectElement;
    await waitFor(() =>
      expect([...select.options].map((option) => option.textContent?.trim())).toEqual([
        AUDIT_COPY.anyType,
        'run.completed',
        'schedule.created',
        AUDIT_COPY.otherType,
      ]),
    );
    await fireEvent.change(select, { target: { value: 'schedule.created' } });
    await fireEvent.click(getByRole('button', { name: AUDIT_COPY.searchAction }));

    await waitFor(() => expect(queries().at(-1)).toMatchObject({ type: 'schedule.created' }));
    await findByText('schedule:s-1');
    // The types stay on offer after the search narrowed the trail to one of them.
    expect([...select.options].map((option) => option.value)).toContain('run.completed');
  });

  test('Other brings a field for a type the trail has not shown, which reaches the operation as `type`', async () => {
    const { findByLabelText, queryByLabelText, getByRole, findByText } = open((params) => ({
      records: [record(1, { resource: params['type'] === undefined ? 'run-all' : 'schedule:s-9' })],
      nextCursor: null,
    }));
    await findByText('run-all');
    expect(queryByLabelText(AUDIT_COPY.otherTypeLabel)).toBeNull();

    await fireEvent.change(await findByLabelText(AUDIT_COPY.typeLabel), {
      target: { value: OTHER_TYPE },
    });
    await fireEvent.input(await findByLabelText(AUDIT_COPY.otherTypeLabel), {
      target: { value: 'schedule.created' },
    });
    await fireEvent.click(getByRole('button', { name: AUDIT_COPY.searchAction }));

    await findByText('schedule:s-9');
    expect(queries().at(-1)).toMatchObject({ type: 'schedule.created' });
  });

  test('a kind and an id reach the operation as `runId`, with the kind’s prefix built and never typed', async () => {
    const { findByLabelText, queryByLabelText, getByRole, findByText } = open((params) => ({
      records: [record(1, { resource: params['runId'] === undefined ? 'run-all' : 'found-it' })],
      nextCursor: null,
    }));
    await findByText('run-all');
    // The id field waits for a kind: there is nothing to name until one is chosen.
    expect(queryByLabelText(AUDIT_COPY.resourceIdLabel)).toBeNull();

    await fireEvent.change(await findByLabelText(AUDIT_COPY.resourceLabel), {
      target: { value: 'schedule' },
    });
    await fireEvent.input(await findByLabelText(AUDIT_COPY.resourceIdLabel), {
      target: { value: 's-9' },
    });
    await fireEvent.click(getByRole('button', { name: AUDIT_COPY.searchAction }));

    await findByText('found-it');
    expect(queries().at(-1)).toMatchObject({ runId: 'schedule:s-9' });
    expect(queries().at(-1)).not.toHaveProperty('resource');
  });

  test('each kind builds its own prefix, and a run id is sent bare', async () => {
    const { findByLabelText, getByRole, findByText } = open((params) => ({
      records: [record(1, { resource: params['runId'] === undefined ? 'run-all' : 'found-it' })],
      nextCursor: null,
    }));
    await findByText('run-all');

    for (const [kind, expected] of [
      ['session', 'session:x-1'],
      ['agent', 'agent:x-1'],
      ['workflow', 'workflow:x-1'],
      ['run', 'x-1'],
    ] as const) {
      await fireEvent.change(await findByLabelText(AUDIT_COPY.resourceLabel), {
        target: { value: kind },
      });
      await fireEvent.input(await findByLabelText(AUDIT_COPY.resourceIdLabel), {
        target: { value: 'x-1' },
      });
      await fireEvent.click(getByRole('button', { name: AUDIT_COPY.searchAction }));
      await waitFor(() => expect(queries().at(-1)).toMatchObject({ runId: expected }));
    }
  });

  test('the address holds the filters, so a search can be linked to and survives a reload', async () => {
    stub = installBureauStub({
      'bureau.audit.query': (params) =>
        isProbe(params)
          ? { records: [record(1)], nextCursor: null }
          : {
              records: [record(1, { resource: `for-${String(params['runId'])}` })],
              nextCursor: null,
            },
    });
    landAt('/health/audit?type=schedule.created&resource=schedule%3As-9');

    const { findByLabelText, findByText } = render(RouteOutletHarness, {
      props: { client: client(), scopes: AUTHORIZATION_SCOPES },
    } as never);

    await findByText('for-schedule:s-9');
    expect(queries().at(-1)).toMatchObject({ type: 'schedule.created', runId: 'schedule:s-9' });
    // The form is the address, decomposed: the type is chosen, and the resource is a kind and an id.
    expect(((await findByLabelText(AUDIT_COPY.typeLabel)) as HTMLSelectElement).value).toBe(
      'schedule.created',
    );
    expect(((await findByLabelText(AUDIT_COPY.resourceLabel)) as HTMLSelectElement).value).toBe(
      'schedule',
    );
    expect(((await findByLabelText(AUDIT_COPY.resourceIdLabel)) as HTMLInputElement).value).toBe(
      's-9',
    );
  });

  test('clearing the filters searches the whole trail again', async () => {
    const { findByLabelText, getByRole, findByText } = open((params) =>
      params['type'] === undefined
        ? { records: [record(1)], nextCursor: null }
        : { records: [], nextCursor: null },
    );
    await findByText('run-1');
    await fireEvent.change(await findByLabelText(AUDIT_COPY.typeLabel), {
      target: { value: OTHER_TYPE },
    });
    await fireEvent.input(await findByLabelText(AUDIT_COPY.otherTypeLabel), {
      target: { value: 'nothing.like.this' },
    });
    await fireEvent.click(getByRole('button', { name: AUDIT_COPY.searchAction }));
    await findByText(AUDIT_COPY.noMatches.title);

    await fireEvent.click(getByRole('button', { name: AUDIT_COPY.clearAction }));

    await findByText('run-1');
    expect(queries().at(-1)).not.toHaveProperty('type');
    expect(((await findByLabelText(AUDIT_COPY.typeLabel)) as HTMLSelectElement).value).toBe('');
  });

  test('a search that finds nothing says so, and is not the empty trail', async () => {
    const { findByLabelText, getByRole, findByText, container } = open((params) =>
      params['type'] === undefined
        ? { records: [record(1)], nextCursor: null }
        : { records: [], nextCursor: null },
    );
    await findByText('run-1');
    await fireEvent.change(await findByLabelText(AUDIT_COPY.typeLabel), {
      target: { value: OTHER_TYPE },
    });
    await fireEvent.input(await findByLabelText(AUDIT_COPY.otherTypeLabel), {
      target: { value: 'x' },
    });
    await fireEvent.click(getByRole('button', { name: AUDIT_COPY.searchAction }));

    await findByText(AUDIT_COPY.noMatches.title);
    expect(frameState(container)).toBe('ready');
  });

  test('marks a time that is not one as invalid, and narrows nothing', async () => {
    const { findByLabelText, getByRole, findByText } = open({
      records: [record(1)],
      nextCursor: null,
    });
    await findByText('run-1');

    const since = await findByLabelText(AUDIT_COPY.sinceLabel);
    await fireEvent.input(since, { target: { value: 'yesterday' } });

    await waitFor(() => expect(since.getAttribute('aria-invalid')).toBe('true'));
    await fireEvent.click(getByRole('button', { name: AUDIT_COPY.searchAction }));
    await waitFor(() => expect(queries().length).toBeGreaterThan(0));
    expect(queries().at(-1)).not.toHaveProperty('since');
  });
});

describe('an empty list', () => {
  test('an unfiltered trail with nothing in it is the first-use empty state, with nothing to clear', async () => {
    const { findByText, queryByRole } = open({ records: [], nextCursor: null });
    await findByText(VIEW_COPY.audit.empty?.title ?? '');
    expect(queryByRole('button', { name: AUDIT_COPY.noMatches.clear })).toBeNull();
  });

  test('Who can hide every record loaded while the Bureau has more, so the list offers Load more and to clear', async () => {
    landAt('/health/audit?who=carol');
    stub = installBureauStub({
      'bureau.audit.query': (params) =>
        params['cursor'] === 'c1'
          ? { records: [record(3, { principal: 'carol', resource: 'run-c' })], nextCursor: null }
          : { records: [record(1), record(2)], nextCursor: 'c1' },
    });
    const { container, findByText, getByRole, queryByText } = render(RouteOutletHarness, {
      props: { client: client(), scopes: AUTHORIZATION_SCOPES },
    } as never);

    // Later pages may match, so the list does not say the trail holds nothing.
    await findByText(AUDIT_COPY.noLoadedMatches.title);
    expect(queryByText(AUDIT_COPY.noMatches.title)).toBeNull();
    expect(rows(container)).toEqual([]);
    await fireEvent.click(getByRole('button', { name: AUDIT_COPY.loadMore }));

    await waitFor(() => expect(rows(container)).toEqual(['3']));
  });
});

describe('an address that names a record', () => {
  test('reads on to the page that holds the record, and opens it', async () => {
    const wanted = record(3, { resource: 'run-c' });
    landAt(`/health/audit?record=${encodeURIComponent(`${wanted.timestamp}#3#0`)}`);
    stub = installBureauStub({
      'bureau.audit.query': (params) =>
        params['cursor'] === 'c1'
          ? { records: [wanted], nextCursor: null }
          : { records: [record(1), record(2)], nextCursor: 'c1' },
    });
    const { findByTestId } = render(RouteOutletHarness, {
      props: { client: client(), scopes: AUTHORIZATION_SCOPES },
    } as never);

    const detail = await findByTestId('audit-detail');
    expect(detail.getAttribute('data-record')).toBe('3');
  });
});

describe('an address that names a record that is not there', () => {
  test('reads twenty pages, then says the record was not found and leaves Load more', async () => {
    landAt('/health/audit?record=nowhere%231%230');
    const pageOf = (cursor: unknown) => {
      const page = typeof cursor === 'string' ? Number(cursor.slice(1)) : 0;
      return {
        records: [record(page + 1)],
        nextCursor: `c${String(page + 1)}`,
      };
    };
    stub = installBureauStub({
      'bureau.audit.query': (params) =>
        isProbe(params) || isTypesRead(params)
          ? { records: [record(1)], nextCursor: null }
          : pageOf(params['cursor']),
    });
    const { findByText, getByRole } = render(RouteOutletHarness, {
      props: { client: client(), scopes: AUTHORIZATION_SCOPES },
    } as never);

    await findByText(AUDIT_COPY.recordNotFound.more);
    expect(queries()).toHaveLength(20);
    expect(getByRole('button', { name: AUDIT_COPY.loadMore })).not.toBeNull();
  });
});

describe('Who', () => {
  const people = {
    records: [
      record(1, { principal: 'alice', resource: 'run-a' }),
      record(2, { principal: 'bob', resource: 'run-b' }),
      record(3, { principal: 'alice', resource: 'run-c' }),
      record(4, { principal: null, resource: 'run-d' }),
    ],
    nextCursor: null,
  };

  test('offers the people the trail has shown, and narrows the loaded records to one of them without asking the Bureau', async () => {
    const { container, findByLabelText, getByRole, findByText } = open(people);
    await findByText('run-a');
    const who = (await findByLabelText(AUDIT_COPY.whoLabel)) as HTMLSelectElement;
    await waitFor(() =>
      expect([...who.options].map((option) => option.textContent?.trim())).toEqual([
        AUDIT_COPY.anyone,
        'alice',
        'bob',
      ]),
    );

    await fireEvent.change(who, { target: { value: 'alice' } });
    await fireEvent.click(getByRole('button', { name: AUDIT_COPY.searchAction }));

    await waitFor(() => expect(rows(container)).toEqual(['1', '3']));
    expect(new URLSearchParams(window.location.search).get('who')).toBe('alice');
    // The operation takes no actor, so nothing about Who is sent.
    for (const query of queries()) expect(query).not.toHaveProperty('principal');
  });

  test('a person nobody has acted as leaves the filtered empty state, which clears the filter', async () => {
    landAt('/health/audit?who=carol');
    stub = installBureauStub({
      'bureau.audit.query': () => ({ records: people.records, nextCursor: null }),
    });
    const { container, findByText, getByRole } = render(RouteOutletHarness, {
      props: { client: client(), scopes: AUTHORIZATION_SCOPES },
    } as never);

    await findByText(AUDIT_COPY.noMatches.title);
    await fireEvent.click(getByRole('button', { name: AUDIT_COPY.noMatches.clear }));

    await waitFor(() => expect(rows(container)).toEqual(['1', '2', '3', '4']));
    expect(window.location.search).toBe('');
  });
});

describe('Export JSON Lines', () => {
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

  test('downloads every page of the trail the filters match, one JSON record per line', async () => {
    const { findByText, getByRole } = open((params) =>
      params['cursor'] === 'c1'
        ? { records: [record(3)], nextCursor: null }
        : { records: [record(1), record(2)], nextCursor: 'c1' },
    );
    await findByText('run-1');

    await fireEvent.click(getByRole('button', { name: AUDIT_COPY.exportAction }));

    await waitFor(() => expect(blobs).toHaveLength(1));
    const text = await blobs[0]!.text();
    const lines = text.trimEnd().split('\n');
    expect(lines.map((line) => (JSON.parse(line) as { sequence: number }).sequence)).toEqual([
      1, 2, 3,
    ]);
    expect(text.endsWith('\n')).toBe(true);
    expect(blobs[0]!.type).toBe('application/x-ndjson');
    expect(names[0]).toMatch(/^audit-log-\d{4}-\d{2}-\d{2}\.jsonl$/);
  });

  test('exports only what the filters match: the search it was opened with, and Who', async () => {
    landAt('/health/audit?type=run.completed&who=alice');
    stub = installBureauStub({
      'bureau.audit.query': () => ({
        records: [record(1, { principal: 'alice' }), record(2, { principal: 'bob' })],
        nextCursor: null,
      }),
    });
    const { findByText, getByRole } = render(RouteOutletHarness, {
      props: { client: client(), scopes: AUTHORIZATION_SCOPES },
    } as never);
    await findByText('run-1');

    await fireEvent.click(getByRole('button', { name: AUDIT_COPY.exportAction }));

    await waitFor(() => expect(blobs).toHaveLength(1));
    const exported = await blobs[0]!.text();
    const sequences = exported
      .trimEnd()
      .split('\n')
      .map((line) => (JSON.parse(line) as { sequence: number }).sequence);
    expect(sequences).toEqual([1]);
    const exportRead = (stub?.callsTo('bureau.audit.query') ?? [])
      .map((call) => call.params)
      .filter((params) => params['limit'] === 100 && params['type'] === 'run.completed');
    expect(exportRead).toHaveLength(1);
  });

  test('saves no file when nothing matches', async () => {
    landAt('/health/audit?who=nobody');
    stub = installBureauStub({
      'bureau.audit.query': () => ({ records: [record(1)], nextCursor: null }),
    });
    const { findByText, getByRole } = render(RouteOutletHarness, {
      props: { client: client(), scopes: AUTHORIZATION_SCOPES },
    } as never);
    await findByText(AUDIT_COPY.noMatches.title);

    await fireEvent.click(getByRole('button', { name: AUDIT_COPY.exportAction }));

    await findByText(AUDIT_COPY.nothingToExport);
    expect(blobs).toHaveLength(0);
  });

  test('a failed export is an error with Try again, which saves the file once the server answers', async () => {
    const { findByText, getByRole, findByRole } = open({ records: [record(1)], nextCursor: null });
    await findByText('run-1');
    stub?.on('bureau.audit.query', () => {
      throw new StubFault('Unavailable', 503, 'The trail is down.');
    });

    await fireEvent.click(getByRole('button', { name: AUDIT_COPY.exportAction }));

    await findByText(AUDIT_COPY.exportFailed.title);
    expect(blobs).toHaveLength(0);
    stub?.on('bureau.audit.query', () => ({ records: [record(1)], nextCursor: null }));
    await fireEvent.click(await findByRole('button', { name: RETRY_LABEL }));

    await waitFor(() => expect(blobs).toHaveLength(1));
  });
});

describe('Load more', () => {
  const pageOf = (params: Query): Page => {
    const runId = params['runId'];
    const filter = typeof runId === 'string' ? runId : '';
    if (params['cursor'] === undefined) {
      return {
        records: [
          record(1, { resource: `first${filter}` }),
          record(2, { resource: `second${filter}` }),
        ],
        nextCursor: '1760860920000:2',
      };
    }
    return { records: [record(3, { resource: `third${filter}` })], nextCursor: null };
  };

  test('follows nextCursor to the next page, and appends it after the first', async () => {
    const { findByRole, queryByRole, container, findByText } = open(pageOf);
    await findByText('second');
    expect(rows(container)).toEqual(['1', '2']);

    await fireEvent.click(await findByRole('button', { name: AUDIT_COPY.loadMore }));

    await findByText('third');
    expect(queries().at(-1)).toMatchObject({ cursor: '1760860920000:2' });
    expect(rows(container)).toEqual(['1', '2', '3']);
    await waitFor(() =>
      expect(queryByRole('button', { name: AUDIT_COPY.loadMore }) === null).toBe(true),
    );
  });

  test('keeps the filters it was asked with when it loads the next page', async () => {
    const { findByLabelText, getByRole, findByRole, findByText } = open(pageOf);
    await findByText('second');
    await fireEvent.change(await findByLabelText(AUDIT_COPY.resourceLabel), {
      target: { value: 'schedule' },
    });
    await fireEvent.input(await findByLabelText(AUDIT_COPY.resourceIdLabel), {
      target: { value: 's-9' },
    });
    await fireEvent.click(getByRole('button', { name: AUDIT_COPY.searchAction }));
    await findByText('secondschedule:s-9');

    await fireEvent.click(await findByRole('button', { name: AUDIT_COPY.loadMore }));

    await findByText('thirdschedule:s-9');
    expect(queries().at(-1)).toMatchObject({ runId: 'schedule:s-9', cursor: '1760860920000:2' });
  });
});

describe('who may see it', () => {
  test('a principal holding no console scope sees the records, not a forbidden view', async () => {
    const { container, findByText } = open(
      { records: [record(1)], nextCursor: null },
      { scopes: [] },
    );

    await findByText('run-1');
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

  test('a search that fails after the view opened says so inline, and can be tried again', async () => {
    let failing = true;
    stub = installBureauStub({
      'bureau.audit.query': (params) => {
        if (isProbe(params) || isTypesRead(params) || params['type'] === undefined) {
          return { records: [record(1)], nextCursor: null };
        }
        if (failing) throw new StubFault('Unavailable', 503, 'The trail is down.');
        return { records: [record(2, { resource: 'back-again' })], nextCursor: null };
      },
    });
    landAt('/health/audit');
    const { findByLabelText, getByRole, findByText } = render(RouteOutletHarness, {
      props: { client: client(), scopes: AUTHORIZATION_SCOPES },
    } as never);
    await findByText('run-1');
    await fireEvent.change(await findByLabelText(AUDIT_COPY.typeLabel), {
      target: { value: OTHER_TYPE },
    });
    await fireEvent.input(await findByLabelText(AUDIT_COPY.otherTypeLabel), {
      target: { value: 'x' },
    });
    await fireEvent.click(getByRole('button', { name: AUDIT_COPY.searchAction }));

    await findByText(AUDIT_COPY.failed.title);
    failing = false;
    await fireEvent.click(getByRole('button', { name: RETRY_LABEL }));
    await findByText('back-again');
  });
});
