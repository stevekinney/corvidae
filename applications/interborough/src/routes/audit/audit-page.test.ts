/**
 * `/audit` (COR-1493): the audit trail, searched by `bureau.audit.query`. Each filter the operation
 * takes reaches it (`since`, a free-text `type`, and a resource sent as `runId`), the records come
 * oldest first as the Bureau returns them, and Load more follows `nextCursor`. Owner scoping is the
 * gate, so the view holds no scope of its own.
 */
import { HttpClient } from '@lostgradient/weft';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';

import { AUDIT_COPY, RETRY_LABEL, VIEW_COPY } from '../../app/copy.ts';
import RouteOutletHarness from '../../app/shell/route-outlet.test-harness.svelte';
import {
  installBureauStub,
  StubFault,
  type BureauStub,
} from '../../lib/bureau-stub.test-support.ts';
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
  landAt('/audit');
  return render(RouteOutletHarness, {
    props: { client: client(), scopes: options.scopes ?? AUTHORIZATION_SCOPES },
  } as never);
}

/** The searches the page made, not the frame's probe. */
const queries = (): Query[] =>
  (stub?.callsTo('bureau.audit.query') ?? []).map((call) => call.params).filter((p) => !isProbe(p));

const rows = (container: HTMLElement) =>
  [...container.querySelectorAll<HTMLElement>('[data-record]')].map((row) => row.dataset['record']);

const frameState = (container: HTMLElement) =>
  container.querySelector('[data-view="audit"]')?.getAttribute('data-state');

describe('the trail', () => {
  test('lists the records in the order the Bureau returns them, oldest first, with what each is about', async () => {
    const { container, findByText } = open({
      records: [record(1), record(2, { type: 'schedule.created', resource: 'schedule:s-1' })],
      nextCursor: null,
    });

    await findByText('schedule:s-1');
    expect(rows(container)).toEqual(['1', '2']);
    const second = container.querySelector('[data-record="2"]')?.textContent ?? '';
    expect(second).toContain('schedule.created');
    expect(second).toContain('anonymous:local');
    expect(second).toContain('status: completed');
    expect(frameState(container)).toBe('ready');
    // Nothing narrows the first search, and it asks for no bound or ordering the Bureau lacks.
    const first = queries()[0] ?? {};
    for (const name of ['since', 'type', 'runId', 'until', 'cursor', 'order']) {
      expect(first, name).not.toHaveProperty(name);
    }
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

  test('a free-text type reaches the operation as `type`, including one outside the audit event types', async () => {
    const { findByLabelText, getByRole, findByText } = open((params) => ({
      records: [record(1, { resource: params['type'] === undefined ? 'run-all' : 'schedule:s-9' })],
      nextCursor: null,
    }));
    await findByText('run-all');

    await fireEvent.input(await findByLabelText(AUDIT_COPY.typeLabel), {
      target: { value: 'schedule.created' },
    });
    await fireEvent.click(getByRole('button', { name: AUDIT_COPY.searchAction }));

    await findByText('schedule:s-9');
    expect(queries().at(-1)).toMatchObject({ type: 'schedule.created' });
  });

  test('a run id, or a resource such as schedule:<id>, reaches the operation as `runId`', async () => {
    const { findByLabelText, getByRole, findByText } = open((params) => ({
      records: [record(1, { resource: params['runId'] === undefined ? 'run-all' : 'found-it' })],
      nextCursor: null,
    }));
    await findByText('run-all');

    await fireEvent.input(await findByLabelText(AUDIT_COPY.resourceLabel), {
      target: { value: 'schedule:s-9' },
    });
    await fireEvent.click(getByRole('button', { name: AUDIT_COPY.searchAction }));

    await findByText('found-it');
    expect(queries().at(-1)).toMatchObject({ runId: 'schedule:s-9' });
    expect(queries().at(-1)).not.toHaveProperty('resource');
  });

  test('the address holds the filters, so a search can be linked to and survives a reload', async () => {
    stub = installBureauStub({
      'bureau.audit.query': (params) =>
        isProbe(params)
          ? { records: [record(1)], nextCursor: null }
          : { records: [record(1, { resource: `for-${String(params['runId'])}` })], nextCursor: null },
    });
    landAt('/audit?type=schedule.created&resource=schedule%3As-9');

    const { findByLabelText, findByText } = render(RouteOutletHarness, {
      props: { client: client(), scopes: AUTHORIZATION_SCOPES },
    } as never);

    await findByText('for-schedule:s-9');
    expect(queries().at(-1)).toMatchObject({ type: 'schedule.created', runId: 'schedule:s-9' });
    expect(((await findByLabelText(AUDIT_COPY.typeLabel)) as HTMLInputElement).value).toBe(
      'schedule.created',
    );
  });

  test('clearing the filters searches the whole trail again', async () => {
    const { findByLabelText, getByRole, findByText } = open((params) =>
      params['type'] === undefined
        ? { records: [record(1)], nextCursor: null }
        : { records: [], nextCursor: null },
    );
    await findByText('run-1');
    await fireEvent.input(await findByLabelText(AUDIT_COPY.typeLabel), {
      target: { value: 'nothing.like.this' },
    });
    await fireEvent.click(getByRole('button', { name: AUDIT_COPY.searchAction }));
    await findByText(AUDIT_COPY.noMatches.title);

    await fireEvent.click(getByRole('button', { name: AUDIT_COPY.clearAction }));

    await findByText('run-1');
    expect(queries().at(-1)).not.toHaveProperty('type');
    expect(((await findByLabelText(AUDIT_COPY.typeLabel)) as HTMLInputElement).value).toBe('');
  });

  test('a search that finds nothing says so, and is not the empty trail', async () => {
    const { findByLabelText, getByRole, findByText, container } = open((params) =>
      params['type'] === undefined
        ? { records: [record(1)], nextCursor: null }
        : { records: [], nextCursor: null },
    );
    await findByText('run-1');
    await fireEvent.input(await findByLabelText(AUDIT_COPY.typeLabel), { target: { value: 'x' } });
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

describe('Load more', () => {
  const pageOf = (params: Query): Page => {
    const filter = String(params['runId'] ?? '');
    if (params['cursor'] === undefined) {
      return {
        records: [record(1, { resource: `first${filter}` }), record(2, { resource: `second${filter}` })],
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
    await waitFor(() => expect(queryByRole('button', { name: AUDIT_COPY.loadMore })).toBeNull());
  });

  test('keeps the filters it was asked with when it loads the next page', async () => {
    const { findByLabelText, getByRole, findByRole, findByText } = open(pageOf);
    await findByText('second');
    await fireEvent.input(await findByLabelText(AUDIT_COPY.resourceLabel), {
      target: { value: 'schedule:s-9' },
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
    const { container, findByText } = open({ records: [record(1)], nextCursor: null }, { scopes: [] });

    await findByText('run-1');
    expect(frameState(container)).toBe('ready');
  });

  test('a refusal from the Bureau is the forbidden state', async () => {
    stub = installBureauStub({
      'bureau.audit.query': () => {
        throw new StubFault('Forbidden', 403, 'Not yours.');
      },
    });
    landAt('/audit');
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
        if (isProbe(params) || params['type'] === undefined) {
          return { records: [record(1)], nextCursor: null };
        }
        if (failing) throw new StubFault('Unavailable', 503, 'The trail is down.');
        return { records: [record(2, { resource: 'back-again' })], nextCursor: null };
      },
    });
    landAt('/audit');
    const { findByLabelText, getByRole, findByRole, findByText } = render(RouteOutletHarness, {
      props: { client: client(), scopes: AUTHORIZATION_SCOPES },
    } as never);
    await findByText('run-1');
    await fireEvent.input(await findByLabelText(AUDIT_COPY.typeLabel), { target: { value: 'x' } });
    await fireEvent.click(getByRole('button', { name: AUDIT_COPY.searchAction }));

    expect((await findByRole('alert')).textContent).toContain(AUDIT_COPY.failed.title);
    failing = false;
    await fireEvent.click(getByRole('button', { name: RETRY_LABEL }));
    await findByText('back-again');
  });
});
