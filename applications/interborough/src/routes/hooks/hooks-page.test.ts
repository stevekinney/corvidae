/**
 * `/hooks` (COR-1858): the caller's hooks, listed as sentences with their last delivery and an On
 * switch, the failing ones first; the editor that makes or changes one in three steps; and a home
 * that keeps hooks off saying so. Driven through the route outlet against a stand-in Bureau that
 * keeps the hooks and their deliveries, so the route, the view frame, and the pages are exercised
 * together.
 */
import { HttpClient } from '@lostgradient/weft';
import { focusManager } from '@tanstack/svelte-query';
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';

import { chooseFilterOption } from '../../../tests/dom.test-support.ts';
import { RETRY_LABEL } from '../../app/copy.ts';
import RouteOutletHarness from '../../app/shell/route-outlet.test-harness.svelte';
import {
  installBureauStub,
  StubFault,
  type BureauStub,
} from '../../lib/bureau-stub.test-support.ts';
import { router } from '../../lib/router.svelte.ts';
import { AUTHORIZATION_SCOPES } from '../../lib/scopes.svelte.ts';
import { AGENT, landAt } from '../chat/pages.test-support.ts';
import { HOOKS_COPY } from './hook-copy.ts';
import { eventOptionLabel } from './hook-presentation.ts';

let stub: BureauStub | undefined;
afterEach(() => {
  cleanup();
  stub?.restore();
  stub = undefined;
});

const MADE_SECRET = 'whsec_3f9a1c0d7e5b4a62c8d1e0f9';
const REPLACED_SECRET = 'whsec_b7d2a9e4c1f8035d6e2a4b90';

type HookRow = ReturnType<typeof hook>;
type DeliveryRow = ReturnType<typeof delivery>;

function hook(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    owner: 'anonymous:local',
    name: null as string | null,
    action: { type: 'webhook', url: `https://example.com/${id}` } as Record<string, unknown>,
    events: ['review.requested'],
    scope: null as { kind: string; id: string } | null,
    enabled: true,
    createdAt: 1_000,
    updatedAt: 1_000,
    revision: 1,
    ...overrides,
  };
}

function delivery(hookId: string, status: string, overrides: Record<string, unknown> = {}) {
  const failed = status !== 'delivered';
  return {
    id: `delivery-${hookId}-${String(Math.random()).slice(2, 8)}`,
    hookId,
    owner: 'anonymous:local',
    actionType: 'webhook',
    kind: 'review.requested',
    test: false,
    status,
    request: { url: `https://example.com/${hookId}`, headers: {}, body: '{}' },
    work: null,
    attempts: [
      {
        number: 1,
        startedAt: 2_000,
        finishedAt: 2_100,
        outcome: failed ? 'network-error' : 'response',
        status: failed ? null : 200,
        responseExcerpt: null,
        responseTruncated: null,
        error: failed ? 'connect refused' : null,
        receipt: null,
      },
    ],
    maxAttempts: 5,
    createdAt: 2_000,
    updatedAt: 2_100,
    ...overrides,
  };
}

const EVERY_SCOPE = ['agent', 'workflow', 'schedule'];
const CATALOG = (
  [
    ['review.requested', 'run', EVERY_SCOPE],
    ['goal.attempt.evaluating', 'run', ['agent']],
    ['notification.created', 'unattributed', []],
    ['schedule.missed', 'external', EVERY_SCOPE],
    ['definitions.changed', 'unattributed', []],
  ] as const
).map(([kind, origin, scopes]) => ({
  kind,
  origin,
  description: `Describes ${kind}`,
  payload: [],
  scopes,
}));

/** The newest delivery of a hook, as `bureau.hooks.list` carries it. */
function lastDeliveryOf(rows: readonly DeliveryRow[] | undefined) {
  const newest = rows?.[0];
  if (newest === undefined) return null;
  const {
    hookId: _hookId,
    owner: _owner,
    actionType: _action,
    request: _request,
    ...rest
  } = newest;
  const { work: _work, attempts, maxAttempts: _maxAttempts, ...summary } = rest;
  const last = attempts.at(-1);
  return {
    ...summary,
    lastAttempt:
      last === undefined
        ? null
        : {
            number: last.number,
            startedAt: last.startedAt,
            finishedAt: last.finishedAt,
            outcome: last.outcome,
            status: last.status,
            error: last.error,
          },
  };
}

type Served = {
  hooks: HookRow[];
  deliveries: Map<string, DeliveryRow[]>;
  /** Every read of one hook's deliveries, by hook: the list needs none. */
  deliveryReads: string[];
};

function open(
  initial: HookRow[] = [],
  options: {
    deliveries?: Record<string, DeliveryRow[]>;
    path?: string;
    /** A home that keeps hooks off answers every hooks call with this fault. */
    off?: boolean;
    workflows?: { id: string; state: string; paused: boolean }[];
    schedules?: unknown[];
    /** A remote home says so at `/host/paths`. */
    hostMode?: 'local' | 'remote';
    /** Operations the Bureau refuses, by name, with the fault it answers. */
    refuse?: Record<string, StubFault>;
    /** The signing secret a created webhook answers with, shown once. */
    createdSecret?: string;
    /** What a test of a hook not yet saved answers: delivered, or one that failed with a status. */
    draftTest?: 'delivered' | { status: number };
    /** The read of one hook never answers, as a slow server does. */
    holdRead?: boolean;
  } = {},
) {
  const served: Served = {
    hooks: [...initial],
    deliveries: new Map(Object.entries(options.deliveries ?? {})),
    deliveryReads: [],
  };
  let created = 0;
  const unsupported = () => {
    throw new StubFault('UnsupportedCapability', 501, 'This Bureau has no hooks', {
      capability: 'hooks',
    });
  };
  const found = (params: Record<string, unknown>) => {
    const entry = served.hooks.find((candidate) => candidate.id === params['hookId']);
    if (entry === undefined) throw new StubFault('NotFound', 404, 'No such hook.');
    return entry;
  };
  const handlers: Parameters<typeof installBureauStub>[0] = {
    'bureau.hooks.list': (params) => {
      if (options.off) return unsupported();
      const scope = params['scope'] as { kind: string; id: string } | undefined;
      return {
        hooks: served.hooks
          .filter(
            (entry) =>
              scope === undefined ||
              (entry.scope?.kind === scope.kind && entry.scope.id === scope.id),
          )
          .map((entry) => ({
            ...entry,
            lastDelivery: lastDeliveryOf(served.deliveries.get(entry.id)),
          })),
      };
    },
    'bureau.hooks.get': (params) => {
      if (options.holdRead) return new Promise(() => undefined);
      return options.off ? unsupported() : found(params);
    },
    'bureau.hooks.deliveries': (params) => {
      const id = String(params['hookId']);
      served.deliveryReads.push(id);
      const limit = typeof params['limit'] === 'number' ? params['limit'] : 50;
      return { deliveries: (served.deliveries.get(id) ?? []).slice(0, limit) };
    },
    'bureau.hooks.create': (params) => {
      created += 1;
      const made = hook(`hook-created-${String(created)}`, {
        name: params['name'] ?? null,
        events: params['events'],
        action: params['action'],
        scope: params['scope'] ?? null,
      });
      served.hooks.push(made);
      return options.createdSecret === undefined
        ? made
        : { ...made, signingSecret: options.createdSecret };
    },
    'bureau.hooks.secret.replace': (params) => {
      const entry = found(params);
      if (params['expectedRevision'] !== undefined && params['expectedRevision'] !== entry.revision) {
        throw new StubFault('StaleRevision', 409, 'The hook changed since it was read.', {
          currentRevision: entry.revision,
        });
      }
      entry.revision += 1;
      return { ...entry, signingSecret: REPLACED_SECRET };
    },
    'bureau.hooks.draft.test': () => {
      const outcome = options.draftTest ?? 'delivered';
      if (outcome === 'delivered') return delivery('draft', 'delivered', { test: true });
      const sent = delivery('draft', 'exhausted', { test: true });
      sent.attempts = [
        {
          number: 1,
          startedAt: 2_000,
          finishedAt: 2_100,
          outcome: 'response',
          status: outcome.status,
          responseExcerpt: null,
          responseTruncated: null,
          error: null,
          receipt: null,
        },
      ];
      return sent;
    },
    'bureau.hooks.update': (params) => {
      const entry = found(params);
      if (params['expectedRevision'] !== entry.revision) {
        throw new StubFault('StaleRevision', 409, 'The hook changed since it was read.', {
          currentRevision: entry.revision,
        });
      }
      if (typeof params['enabled'] === 'boolean') entry.enabled = params['enabled'];
      if (params['events'] !== undefined) entry.events = params['events'] as string[];
      if ('scope' in params) entry.scope = params['scope'] as HookRow['scope'];
      if (params['action'] !== undefined) entry.action = params['action'] as never;
      if ('name' in params) entry.name = (params['name'] as string | null) ?? null;
      entry.revision += 1;
      return entry;
    },
    'bureau.hooks.delete': (params) => {
      const entry = found(params);
      served.hooks = served.hooks.filter((candidate) => candidate !== entry);
      return { hookId: entry.id, deleted: true };
    },
    'bureau.hooks.test': (params) => {
      const entry = found(params);
      const sent = delivery(entry.id, 'delivered', { test: true, kind: 'hook.test' });
      served.deliveries.set(entry.id, [sent, ...(served.deliveries.get(entry.id) ?? [])]);
      return sent;
    },
    'bureau.events.catalog': () => ({ events: CATALOG }),
    'bureau.agents.list': () => ({ agents: [AGENT] }),
    'bureau.schedules.list': () => ({ schedules: options.schedules ?? [], nextOffset: null }),
    'bureau.workflows.list': () => ({
      workflows: (options.workflows ?? []).map((file) => ({
        ...file,
        owner: 'anonymous:local',
        hash: null,
        description: null,
        agent: null,
        inputSchema: null,
        outputSchema: null,
        version: null,
        trigger: null,
        problem: null,
        runs: null,
      })),
      nextOffset: null,
    }),
  };
  const refusals = options.refuse ?? {};
  stub = installBureauStub(
    Object.fromEntries(
      Object.entries(handlers).map(([method, handler]) => [
        method,
        (params: Record<string, unknown>) => {
          const refusal = Object.hasOwn(refusals, method) ? refusals[method] : undefined;
          if (refusal !== undefined) throw refusal;
          return handler(params);
        },
      ]),
    ),
    options.hostMode === undefined ? {} : { hostMode: options.hostMode },
  );
  landAt(options.path ?? '/hooks');
  const view = render(RouteOutletHarness, {
    props: {
      client: new HttpClient({ baseUrl: 'http://localhost/api' }),
      scopes: AUTHORIZATION_SCOPES,
    },
  } as never);
  return { served, view };
}

const row = (container: HTMLElement, id: string) =>
  container.querySelector<HTMLElement>(`li[data-hook="${id}"]`);
const rowIds = (container: HTMLElement) =>
  Array.from(container.querySelectorAll<HTMLElement>('li[data-hook]')).map(
    (element) => element.dataset['hook'],
  );
/** Line two of a row: the hook's sentence, and what else it is limited to. */
const lineTwo = (container: HTMLElement, id: string) =>
  row(container, id)?.querySelector<HTMLElement>('.ib-hooks__line')?.textContent?.trim();

describe('the hooks list', () => {
  test('reads each hook as a status word, a name and a sentence, and puts a failing hook first', async () => {
    const { view } = open(
      [
        hook('quiet', { events: ['review.requested'] }),
        hook('broken', {
          events: ['review.requested', 'schedule.missed'],
          name: 'Page the team',
        }),
        hook('fresh'),
      ],
      {
        deliveries: {
          quiet: [delivery('quiet', 'delivered')],
          broken: [delivery('broken', 'exhausted')],
        },
      },
    );

    await waitFor(() => expect(row(view.container, 'broken')).not.toBeNull());
    await waitFor(() =>
      expect(within(row(view.container, 'broken')!).getByText('Gave up')).not.toBeNull(),
    );
    await waitFor(() => expect(rowIds(view.container)).toEqual(['broken', 'quiet', 'fresh']));

    // The name is the bold title and the link to the hook; line two is the sentence, in words.
    const broken = within(row(view.container, 'broken')!);
    expect(broken.getByRole('link', { name: 'Page the team' })).not.toBeNull();
    expect(lineTwo(view.container, 'broken')).toBe(
      'When a review is waiting or a schedule misses a run, send a webhook to example.com',
    );
    // A hook with no name is titled by its sentence.
    expect(
      within(row(view.container, 'quiet')!).getByRole('link', {
        name: 'When a review is waiting, send a webhook to example.com',
      }),
    ).not.toBeNull();
    expect(within(row(view.container, 'quiet')!).getByText('Delivered')).not.toBeNull();
    expect(
      within(row(view.container, 'fresh')!).getByText(HOOKS_COPY.row.noDelivery),
    ).not.toBeNull();
    expect(view.container.querySelector('[data-view="hooks"]')?.getAttribute('data-state')).toBe(
      'ready',
    );
    // The count, the header and the one filter row are on the page.
    expect(view.getByTestId('hooks-count').textContent?.trim()).toBe('3 hooks');
    expect(view.getByRole('heading', { level: 1, name: 'Hooks' })).not.toBeNull();
    expect(view.getByText(HOOKS_COPY.list.subtitle)).not.toBeNull();
  });

  test('leads a hook that is off with Off, says no time, and moves its last delivery to line two', async () => {
    const { view } = open([hook('quiet', { enabled: false, name: 'Refund audit' })], {
      deliveries: { quiet: [delivery('quiet', 'delivered')] },
    });

    await waitFor(() => expect(row(view.container, 'quiet')).not.toBeNull());
    const quiet = row(view.container, 'quiet')!;
    expect(within(quiet).getByText('Off')).not.toBeNull();
    expect(quiet.querySelector('[data-last-delivery]')).toBeNull();
    expect(lineTwo(view.container, 'quiet')).toMatch(/, last delivery /);
    expect(within(quiet).getByRole('switch').getAttribute('aria-checked')).toBe('false');
  });

  test('labels each switch On, and names the hook’s sentence after it', async () => {
    const { view } = open([hook('alpha')]);
    await waitFor(() => expect(row(view.container, 'alpha')).not.toBeNull());
    const toggle = within(row(view.container, 'alpha')!).getByRole('switch');
    expect(toggle.getAttribute('aria-label')).toBe(
      `${HOOKS_COPY.row.on}, When a review is waiting, send a webhook to example.com`,
    );
    expect(within(row(view.container, 'alpha')!).getByText(HOOKS_COPY.row.on)).not.toBeNull();
  });

  // COR-1978: the list carries each hook's newest delivery, so a page of hooks is one read and every
  // hook sorts by it, past the fifty the page used to read one at a time.
  test('makes no read per hook, and puts a failing hook first however long the list is', async () => {
    const many = Array.from({ length: 60 }, (_, index) =>
      hook(`hook-${String(index).padStart(3, '0')}`),
    );
    const last = many.at(-1)!;
    const { view, served } = open(many, {
      deliveries: { [last.id]: [delivery(last.id, 'exhausted')] },
    });

    await waitFor(() => expect(rowIds(view.container).length).toBe(many.length));
    expect(rowIds(view.container)[0]).toBe(last.id);
    expect(served.deliveryReads).toEqual([]);
  });

  test('says what each hook is limited to, and links to it', async () => {
    const { view } = open([
      hook('everyone'),
      hook('scoped', { scope: { kind: 'agent', id: 'researcher' } }),
      hook('nightly', { scope: { kind: 'workflow', id: 'nightly' } }),
      hook('future', { scope: { kind: 'team', id: 'blue' } }),
    ]);

    await waitFor(() => expect(rowIds(view.container).length).toBe(4));
    const sentence = 'When a review is waiting, send a webhook to example.com';
    // These hooks have no name, so each is titled by its sentence and line two says only what else
    // limits it: a hook for everything has no line two, a workflow reads inside the sentence (the
    // title), and any other subject follows as line two. Each row is the link to its hook.
    expect(lineTwo(view.container, 'everyone')).toBeUndefined();
    expect(
      within(row(view.container, 'everyone')!).getByRole('link', { name: sentence }),
    ).not.toBeNull();
    expect(lineTwo(view.container, 'nightly')).toBeUndefined();
    expect(
      within(row(view.container, 'nightly')!).getByRole('link', {
        name: 'When a review is waiting in Nightly, send a webhook to example.com',
      }),
    ).not.toBeNull();
    expect(lineTwo(view.container, 'scoped')).toBe('Only for Researcher');
    expect(lineTwo(view.container, 'future')).toBe('Only for Blue');
    expect(
      within(row(view.container, 'scoped')!)
        .getByRole('link', { name: sentence })
        .getAttribute('href'),
    ).toBe('/hooks/scoped');
  });

  test('filters by agent from the address, and clears it', async () => {
    const { view } = open(
      [
        hook('mine', { scope: { kind: 'agent', id: 'researcher' } }),
        hook('other', { scope: { kind: 'agent', id: 'writer' } }),
        hook('everyone'),
      ],
      { path: '/hooks?agent=researcher' },
    );

    await waitFor(() => expect(rowIds(view.container)).toEqual(['mine']));
    await chooseFilterOption(view, HOOKS_COPY.agentFilter, HOOKS_COPY.anyAgent);
    await waitFor(() => expect(rowIds(view.container)).toEqual(['mine', 'other', 'everyone']));
  });

  test('searches the sentences, filters by event, and clears both', async () => {
    const { view } = open([
      hook('alpha', { events: ['review.requested'] }),
      hook('beta', { events: ['schedule.missed'], action: { type: 'notify', title: null } }),
    ]);
    await waitFor(() => expect(rowIds(view.container)).toEqual(['alpha', 'beta']));

    await fireEvent.input(view.getByRole('searchbox', { name: HOOKS_COPY.searchLabel }), {
      target: { value: 'notify' },
    });
    await waitFor(() => expect(rowIds(view.container)).toEqual(['beta']));

    await fireEvent.input(view.getByRole('searchbox', { name: HOOKS_COPY.searchLabel }), {
      target: { value: 'zzz' },
    });
    await view.findByRole('heading', { level: 2, name: HOOKS_COPY.list.noMatch.title });
    // The filter row stays over the state, and the state's only action is Clear filters.
    expect(view.getByRole('searchbox', { name: HOOKS_COPY.searchLabel })).not.toBeNull();
    expect(view.getByText(HOOKS_COPY.list.noMatch.description(false, 'zzz'))).not.toBeNull();
    await fireEvent.click(view.getByRole('button', { name: HOOKS_COPY.clearAction }));
    await waitFor(() => expect(rowIds(view.container)).toEqual(['alpha', 'beta']));

    await chooseFilterOption(view, HOOKS_COPY.eventFilter, eventOptionLabel('review.requested'));
    await waitFor(() => expect(rowIds(view.container)).toEqual(['alpha']));
  });

  test('turns a hook off with its switch, naming the revision it read', async () => {
    const { view, served } = open([hook('alpha')]);
    await waitFor(() => expect(row(view.container, 'alpha')).not.toBeNull());

    const toggle = within(row(view.container, 'alpha')!).getByRole('switch');
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    await fireEvent.click(toggle);

    await waitFor(() => expect(stub?.callsTo('bureau.hooks.update').length).toBe(1));
    expect(stub?.callsTo('bureau.hooks.update')[0]?.params).toEqual({
      hookId: 'alpha',
      expectedRevision: 1,
      enabled: false,
    });
    await waitFor(() =>
      expect(
        within(row(view.container, 'alpha')!).getByRole('switch').getAttribute('aria-checked'),
      ).toBe('false'),
    );
    expect(served.hooks[0]?.enabled).toBe(false);
  });

  test('says a hook changed since it was read, and reads the list again, when its switch is stale', async () => {
    const { view, served } = open([hook('alpha')]);
    await waitFor(() => expect(row(view.container, 'alpha')).not.toBeNull());
    // Someone else changes the hook after the page read it.
    served.hooks[0]!.revision = 2;

    await fireEvent.click(within(row(view.container, 'alpha')!).getByRole('switch'));

    await view.findByText(/changed since you loaded it/);
    expect(served.hooks[0]?.enabled).toBe(true);
  });

  test('is first use under its own header, with no filter row and one primary New hook', async () => {
    const { view } = open([]);
    await view.findByRole('heading', { level: 2, name: HOOKS_COPY.list.firstUse.title });
    expect(view.getByRole('heading', { level: 1, name: 'Hooks' })).not.toBeNull();
    expect(view.getByText(HOOKS_COPY.list.subtitleShort)).not.toBeNull();
    expect(view.getByText(HOOKS_COPY.list.firstUse.description)).not.toBeNull();
    expect(view.queryByRole('searchbox')).toBeNull();
    // The frame still says what its probe learned, though the page draws the state.
    await waitFor(() =>
      expect(view.container.querySelector('[data-view="hooks"]')?.getAttribute('data-state')).toBe(
        'empty',
      ),
    );

    // The header's secondary "+" and the state's primary button are both named New hook.
    const buttons = view.getAllByRole('button', { name: HOOKS_COPY.newAction });
    expect(buttons.length).toBe(2);
    const primary = buttons.filter(
      (button) => button.getAttribute('data-cinder-variant') === 'primary',
    );
    expect(primary.length).toBe(1);
    await fireEvent.click(primary[0]!);
    await waitFor(() => expect(router.pathname).toBe('/hooks/new'));
  });

  test('says a read that failed with nothing to show is an error under the header, with the plus off', async () => {
    const { view } = open([], {
      refuse: { 'bureau.hooks.list': new StubFault('EngineFailure', 500, 'It broke.') },
    });
    await view.findByRole('heading', { level: 2, name: HOOKS_COPY.list.loadFailed.title });
    expect(view.getByRole('heading', { level: 1, name: 'Hooks' })).not.toBeNull();
    expect(view.getByText(HOOKS_COPY.list.loadFailed.answered(500))).not.toBeNull();
    expect(view.getByRole('button', { name: RETRY_LABEL })).not.toBeNull();
    expect(
      view.getByRole('link', { name: HOOKS_COPY.list.loadFailed.openHealth }).getAttribute('href'),
    ).toBe(HOOKS_COPY.list.loadFailed.openHealthPath);
    const plus = view
      .getAllByRole('button', { name: HOOKS_COPY.newAction })
      .find((button) => button.getAttribute('aria-disabled') === 'true');
    expect(plus).not.toBeUndefined();
    await waitFor(() =>
      expect(view.container.querySelector('[data-view="hooks"]')?.getAttribute('data-state')).toBe(
        'error',
      ),
    );
  });

  test('keeps the hooks it has under a refresh-failed banner, with the switches and New hook held', async () => {
    const refuse: Record<string, StubFault> = {};
    const { view } = open([hook('alpha')], { refuse });
    await waitFor(() => expect(row(view.container, 'alpha')).not.toBeNull());

    // The next read of the list fails, and a switch that saves makes the page read it.
    refuse['bureau.hooks.list'] = new StubFault('EngineFailure', 500, 'It broke.');
    await fireEvent.click(within(row(view.container, 'alpha')!).getByRole('switch'));

    await view.findByText(/refresh this page/);
    // The rows stay at full contrast, filters and links stay live, and what changes something is held.
    expect(row(view.container, 'alpha')).not.toBeNull();
    expect(view.getByRole('searchbox', { name: HOOKS_COPY.searchLabel })).not.toBeNull();
    const toggle = within(row(view.container, 'alpha')!).getByRole('switch');
    expect(toggle.getAttribute('aria-disabled')).toBe('true');
    expect(toggle.getAttribute('aria-describedby')).not.toBeNull();
    expect(
      view
        .getAllByRole('button', { name: HOOKS_COPY.newAction })
        .every((button) => button.getAttribute('aria-disabled') === 'true'),
    ).toBe(true);
  });

  test('says hooks are off on a home that keeps them off, with no action', async () => {
    const { view } = open([], { off: true });
    await view.findByRole('heading', { level: 1, name: HOOKS_COPY.unavailable.title });
    expect(view.getByTestId('hooks-unavailable').querySelector('a, button')).toBeNull();
  });
});

describe('the hook editor', () => {
  async function chooseEvent(view: ReturnType<typeof open>['view'], search: string, name: string) {
    const input = await view.findByRole('combobox', { name: HOOKS_COPY.editor.event.label });
    await fireEvent.focus(input);
    await fireEvent.input(input, { target: { value: search } });
    const option = await waitFor(() => {
      const found = Array.from(document.body.querySelectorAll('[role="option"]')).find((element) =>
        element.textContent?.includes(name),
      );
      if (found === undefined) throw new Error(`no option ${name}`);
      return found;
    });
    await fireEvent.mouseDown(option);
  }

  test('searches every event by its words, its raw kind, its area, and what it means', async () => {
    const { view } = open([], { path: '/hooks/new' });
    const input = await view.findByRole('combobox', { name: HOOKS_COPY.editor.event.label });
    const optionLabels = async (query: string) => {
      await fireEvent.focus(input);
      await fireEvent.input(input, { target: { value: query } });
      await waitFor(() => expect(document.body.querySelector('[role="listbox"]')).not.toBeNull());
      return Array.from(document.body.querySelectorAll('[role="option"]')).map((element) =>
        (element.textContent ?? '').trim(),
      );
    };

    // By words, by raw kind, by area, and by the description the Bureau gives; each finds one event.
    for (const query of [
      'attempt evaluating',
      'schedule.missed',
      'Reviews',
      'Describes definitions',
    ]) {
      await waitFor(async () => {
        const labels = await optionLabels(query);
        expect(labels.length, query).toBe(1);
      });
    }
    // With nothing typed, every event of the catalog is offered.
    await waitFor(async () => {
      const labels = await optionLabels('');
      expect(labels.length).toBe(CATALOG.length);
    });
  });

  test('makes a webhook hook from an event and an address, which the Bureau signs with a secret it makes', async () => {
    const { view } = open([], { path: '/hooks/new' });
    expect(view.getByRole('heading', { level: 1, name: HOOKS_COPY.editor.newTitle })).not.toBeNull();
    // A new hook is told what to do first, and has no secret field: the Bureau makes the secret.
    expect(view.getByTestId('hook-check-summary').textContent).toContain(
      HOOKS_COPY.editor.check.pickEvent,
    );
    await chooseEvent(view, 'review', 'A review is waiting');
    expect(view.queryByLabelText(HOOKS_COPY.editor.webhook.secretLabel)).toBeNull();

    await fireEvent.input(view.getByLabelText(HOOKS_COPY.editor.webhook.urlLabel), {
      target: { value: 'https://example.com/receive' },
    });
    await fireEvent.input(view.getByLabelText(HOOKS_COPY.editor.check.nameLabel), {
      target: { value: 'Tell the receiver' },
    });
    // Until it is saved the Check step says the event it will watch, and that nothing watches yet.
    const summary = view.getByTestId('hook-check-summary');
    expect(summary.textContent).toContain('A review is waiting');
    expect(summary.textContent).toContain('review.requested');
    expect(summary.textContent).toContain(HOOKS_COPY.editor.check.saveToStart);
    await fireEvent.click(view.getByRole('button', { name: HOOKS_COPY.editor.check.create }));

    await waitFor(() => expect(stub?.callsTo('bureau.hooks.create').length).toBe(1));
    expect(stub?.callsTo('bureau.hooks.create')[0]?.params).toEqual({
      name: 'Tell the receiver',
      events: ['review.requested'],
      action: { type: 'webhook', url: 'https://example.com/receive' },
    });
    // A hook that is made opens on its own page, where it can be tested.
    await waitFor(() => expect(router.pathname).toBe('/hooks/hook-created-1'));
    await view.findByRole('button', { name: HOOKS_COPY.editor.check.test });
  });

  test('shows the secret the Bureau made once, revealed, and masked once the page is left', async () => {
    const { view } = open([], { path: '/hooks/new', createdSecret: MADE_SECRET });
    await chooseEvent(view, 'review', 'A review is waiting');
    await fireEvent.input(view.getByLabelText(HOOKS_COPY.editor.webhook.urlLabel), {
      target: { value: 'https://example.com/receive' },
    });
    await fireEvent.click(view.getByRole('button', { name: HOOKS_COPY.editor.check.create }));

    await waitFor(() => expect(router.pathname).toBe('/hooks/hook-created-1'));
    const secret = await view.findByTestId('hook-secret');
    // Revealed once, with the note that it cannot be seen again and a Copy button.
    await waitFor(() => expect(secret.textContent).toContain(MADE_SECRET));
    expect(secret.textContent).toContain(HOOKS_COPY.editor.webhook.secretOnce);
    expect(
      within(secret).getByRole('button', { name: `Copy ${HOOKS_COPY.editor.webhook.secretLabel}` }),
    ).not.toBeNull();

    // Leaving the page forgets it: the hook opens again with the secret masked and no Copy.
    cleanup();
    stub?.restore();
    stub = undefined;
    const again = open([hook('hook-created-1')], { path: '/hooks/hook-created-1' });
    const masked = await again.view.findByTestId('hook-secret');
    expect(masked.textContent).not.toContain(MADE_SECRET);
    expect(within(masked).getByTestId('hook-secret-mask').getAttribute('aria-label')).toBe(
      HOOKS_COPY.editor.webhook.secretMasked,
    );
    expect(within(masked).queryByRole('button', { name: /^Copy/ })).toBeNull();
  });

  test('Replace makes a new secret, names the revision it read, and shows it once', async () => {
    const { view } = open([hook('alpha')], { path: '/hooks/alpha' });
    const secret = await view.findByTestId('hook-secret');
    expect(secret.textContent).not.toContain(REPLACED_SECRET);

    await fireEvent.click(
      within(secret).getByRole('button', { name: /^Replace/ }),
    );

    await waitFor(() => expect(stub?.callsTo('bureau.hooks.secret.replace').length).toBe(1));
    expect(stub?.callsTo('bureau.hooks.secret.replace')[0]?.params).toEqual({
      hookId: 'alpha',
      expectedRevision: 1,
    });
    await waitFor(() => expect(secret.textContent).toContain(REPLACED_SECRET));
    expect(secret.textContent).toContain(HOOKS_COPY.editor.webhook.secretOnce);
  });

  test('says a secret that could not be replaced beside the field', async () => {
    const { view } = open([hook('alpha')], {
      path: '/hooks/alpha',
      refuse: {
        'bureau.hooks.secret.replace': new StubFault('Forbidden', 403, 'Not yours.'),
      },
    });
    const secret = await view.findByTestId('hook-secret');
    await fireEvent.click(within(secret).getByRole('button', { name: /^Replace/ }));
    const failure = await within(secret).findByTestId('hook-secret-failure');
    expect(failure.textContent).toContain(HOOKS_COPY.editor.webhook.secretReplaceFailed);
  });

  test('offers what the chosen events can be limited to, and writes the subject chosen', async () => {
    const { view } = open([], { path: '/hooks/new' });
    expect(view.queryByLabelText(HOOKS_COPY.editor.onlyFor.label)).toBeNull();
    await chooseEvent(view, 'review', 'A review is waiting');

    const only = (await view.findByLabelText(HOOKS_COPY.editor.onlyFor.label)) as HTMLSelectElement;
    expect(Array.from(only.options).map((option) => option.textContent?.trim())).toEqual([
      HOOKS_COPY.editor.onlyFor.everything,
      'One agent',
      'One workflow',
      'One schedule',
    ]);

    await chooseEvent(view, 'goal', 'Goal attempt evaluating');
    await waitFor(() =>
      expect(Array.from(only.options).map((option) => option.value)).toEqual(['', 'agent']),
    );

    await fireEvent.change(only, { target: { value: 'agent' } });
    const subject = (await view.findByLabelText(
      HOOKS_COPY.editor.onlyFor.subject.agent,
    )) as HTMLSelectElement;
    await waitFor(() => expect(subject.options.length).toBe(2));
    await fireEvent.change(subject, { target: { value: AGENT.name } });

    expect(view.getByTestId('hook-sentence').textContent).toContain(`for the agent ${AGENT.name}`);
  });

  test('lists the workflows and the schedules Only for can name, by what a person calls them', async () => {
    const { view } = open([], {
      path: '/hooks/new',
      workflows: [{ id: 'nightly', state: 'ready', paused: false }],
      schedules: [
        {
          id: 'every-hour',
          owner: 'anonymous:local',
          agentName: null,
          inputPreview: null,
          workflowType: 'agent',
          description: 'Every hour',
          cronExpression: null,
          intervalMs: 3_600_000,
          status: 'active',
          overlap: 'skip',
          revision: 1,
          timeZone: 'UTC',
          nextFireAt: null,
          skippedOccurrences: [],
          lastFireAt: null,
          missedFireCount: 0,
          skippedCount: 0,
          createdAt: '2026-11-01T00:00:00.000Z',
          updatedAt: '2026-11-01T00:00:00.000Z',
        },
      ],
    });
    await chooseEvent(view, 'review', 'A review is waiting');
    const only = (await view.findByLabelText(HOOKS_COPY.editor.onlyFor.label)) as HTMLSelectElement;

    await fireEvent.change(only, { target: { value: 'workflow' } });
    const workflow = (await view.findByLabelText(
      HOOKS_COPY.editor.onlyFor.subject.workflow,
    )) as HTMLSelectElement;
    await waitFor(() => expect(workflow.options.length).toBe(2));

    await fireEvent.change(only, { target: { value: 'schedule' } });
    const schedule = (await view.findByLabelText(
      HOOKS_COPY.editor.onlyFor.subject.schedule,
    )) as HTMLSelectElement;
    await waitFor(() => expect(schedule.options.length).toBe(2));
    expect(schedule.options[1]?.textContent?.trim()).toBe('Every hour');
  });

  test('says when the choices could not be read, and keeps the form', async () => {
    const { view } = open([], {
      path: '/hooks/new',
      refuse: { 'bureau.agents.list': new StubFault('EngineFailure', 500, 'It broke.') },
    });
    await chooseEvent(view, 'review', 'A review is waiting');
    const only = await view.findByLabelText(HOOKS_COPY.editor.onlyFor.label);
    await fireEvent.change(only, { target: { value: 'agent' } });

    await view.findByText(HOOKS_COPY.editor.onlyFor.loadFailed);
  });

  test('says nothing can be limited for events about the whole system', async () => {
    const { view } = open([], { path: '/hooks/new' });
    await chooseEvent(view, 'notification', 'Notification created');

    expect(await view.findByTestId('hook-only-for-none')).not.toBeNull();
    expect(view.queryByLabelText(HOOKS_COPY.editor.onlyFor.label)).toBeNull();
  });

  test('refuses to save a limit an added event cannot tell, and saves once the limit is lifted', async () => {
    const { view } = open([], { path: '/hooks/new' });
    await chooseEvent(view, 'review', 'A review is waiting');
    await fireEvent.input(view.getByLabelText(HOOKS_COPY.editor.webhook.urlLabel), {
      target: { value: 'https://example.com/receive' },
    });
    const only = await view.findByLabelText(HOOKS_COPY.editor.onlyFor.label);
    await fireEvent.change(only, { target: { value: 'agent' } });
    const subject = (await view.findByLabelText(
      HOOKS_COPY.editor.onlyFor.subject.agent,
    )) as HTMLSelectElement;
    await waitFor(() => expect(subject.options.length).toBe(2));
    await fireEvent.change(subject, { target: { value: AGENT.name } });
    await chooseEvent(view, 'notification', 'Notification created');

    await view.findByTestId('hook-scope-refused');
    // Save hook stays enabled and is the way to be told: nothing is made, and focus goes to Only for.
    const save = view.getByRole('button', {
      name: HOOKS_COPY.editor.check.create,
    }) as HTMLButtonElement;
    expect(save.disabled).toBe(false);
    await fireEvent.click(save);
    await waitFor(() => expect(document.activeElement?.id).toBe('ib-hook-only-for'));
    expect(stub?.callsTo('bureau.hooks.create').length).toBe(0);

    await fireEvent.change(view.getByLabelText(HOOKS_COPY.editor.onlyFor.label), {
      target: { value: '' },
    });
    await waitFor(() =>
      expect(view.queryByTestId('hook-scope-refused')?.outerHTML ?? null).toBeNull(),
    );
    await fireEvent.click(save);
    await waitFor(() => expect(stub?.callsTo('bureau.hooks.create').length).toBe(1));
    expect(stub?.callsTo('bureau.hooks.create')[0]?.params).not.toHaveProperty('scope');
  });

  test('sends no scope for a save that leaves it, and keeps a subject the lists no longer hold', async () => {
    const { view } = open([hook('alpha', { scope: { kind: 'agent', id: 'retired-agent' } })], {
      path: '/hooks/alpha',
    });
    const subject = (await view.findByLabelText(
      HOOKS_COPY.editor.onlyFor.subject.agent,
    )) as HTMLSelectElement;
    await waitFor(() => expect(subject.value).toBe('retired-agent'));

    await fireEvent.click(view.getByRole('button', { name: HOOKS_COPY.editor.check.save }));
    await waitFor(() => expect(stub?.callsTo('bureau.hooks.update').length).toBe(1));
    expect(stub?.callsTo('bureau.hooks.update')[0]?.params).not.toHaveProperty('scope');
  });

  test('shows a scope kind it does not know as a disabled choice, and renames the hook without its events', async () => {
    const { view } = open([hook('alpha', { scope: { kind: 'team', id: 'blue' } })], {
      path: '/hooks/alpha',
    });
    const only = (await view.findByLabelText(HOOKS_COPY.editor.onlyFor.label)) as HTMLSelectElement;
    await waitFor(() => expect(only.value).toBe('team'));
    const unknown = Array.from(only.options).find((option) => option.value === 'team');
    expect(unknown?.disabled).toBe(true);
    expect(unknown?.textContent?.trim()).toBe(HOOKS_COPY.editor.onlyFor.unknownKind('team'));

    await fireEvent.input(view.getByLabelText(HOOKS_COPY.editor.check.nameLabel), {
      target: { value: 'Renamed' },
    });
    await fireEvent.click(view.getByRole('button', { name: HOOKS_COPY.editor.check.save }));

    await waitFor(() => expect(stub?.callsTo('bureau.hooks.update').length).toBe(1));
    expect(stub?.callsTo('bureau.hooks.update')[0]?.params).toEqual({
      hookId: 'alpha',
      expectedRevision: 1,
      name: 'Renamed',
    });
  });

  // COR-1978: a remote home cannot hold a signing secret, so it writes every other action.
  test('does not offer a webhook on a remote home, and starts on notify', async () => {
    const { view } = open([], { path: '/hooks/new', hostMode: 'remote' });
    const notify = await view.findByRole('radio', { name: HOOKS_COPY.editor.action.notify });

    await waitFor(() => expect(notify.getAttribute('aria-checked')).toBe('true'));
    const webhook = view.getByRole('radio', { name: HOOKS_COPY.editor.action.webhook });
    expect(webhook.getAttribute('aria-disabled')).toBe('true');
    await view.findByText(HOOKS_COPY.editor.action.chooseRemote);
    // Notify has no fields, and says what it does.
    expect(view.getByTestId('hook-notify-note').textContent).toContain(
      HOOKS_COPY.editor.action.notifyNote,
    );
    expect(view.queryByLabelText(HOOKS_COPY.editor.webhook.urlLabel)).toBeNull();
  });

  test('starts limited to the agent the address names', async () => {
    const { view } = open([], { path: `/hooks/new?agent=${AGENT.name}` });
    await chooseEvent(view, 'review', 'A review is waiting');
    const only = (await view.findByLabelText(HOOKS_COPY.editor.onlyFor.label)) as HTMLSelectElement;
    await waitFor(() => expect(only.value).toBe('agent'));
    const subject = (await view.findByLabelText(
      HOOKS_COPY.editor.onlyFor.subject.agent,
    )) as HTMLSelectElement;
    await waitFor(() => expect(subject.value).toBe(AGENT.name));
  });

  test('never shows a stored signing secret: a saved hook masks it, and a save never sends one', async () => {
    const { view } = open([hook('alpha', { name: 'Keep' })], { path: '/hooks/alpha' });
    const secret = await view.findByTestId('hook-secret');
    expect(within(secret).getByTestId('hook-secret-mask').textContent).not.toContain('whsec');
    // There is no field to type a secret into: the Bureau makes it.
    expect(view.container.querySelector('input[type="password"]')).toBeNull();

    await fireEvent.input(view.getByLabelText(HOOKS_COPY.editor.check.nameLabel), {
      target: { value: 'Kept' },
    });
    await fireEvent.click(view.getByRole('button', { name: HOOKS_COPY.editor.check.save }));

    await waitFor(() => expect(stub?.callsTo('bureau.hooks.update').length).toBe(1));
    const sent = stub?.callsTo('bureau.hooks.update')[0]?.params ?? {};
    expect(sent).toEqual({
      hookId: 'alpha',
      expectedRevision: 1,
      name: 'Kept',
    });
    expect(Object.keys(sent)).not.toContain('signingSecret');
  });

  test('sends a test event to the saved address, says what answered under the buttons, and shows the delivery beside the editor', async () => {
    const { view } = open([hook('alpha')], {
      path: '/hooks/alpha',
      deliveries: { alpha: [delivery('alpha', 'exhausted')] },
    });
    const deliveries = await view.findByTestId('hook-deliveries');
    await within(deliveries).findByText('No answer: connect refused');

    await fireEvent.click(view.getByRole('button', { name: HOOKS_COPY.editor.check.test }));

    await waitFor(() => expect(stub?.callsTo('bureau.hooks.test').length).toBe(1));
    expect(stub?.callsTo('bureau.hooks.test')[0]?.params).toEqual({ hookId: 'alpha' });
    const result = await view.findByTestId('hook-test-result');
    expect(result.textContent).toContain(
      HOOKS_COPY.editor.check.testSent('example.com', '200 OK', 100),
    );
    expect(result.textContent).toContain(HOOKS_COPY.editor.webhook.seePayload);
    // The result sits directly under the buttons, and Save hook is first.
    const buttons = view.getByRole('button', { name: HOOKS_COPY.editor.check.test }).parentElement;
    expect(buttons?.firstElementChild?.textContent).toContain(HOOKS_COPY.editor.check.save);
    expect(buttons?.nextElementSibling).toBe(result);
    await within(deliveries).findByText(HOOKS_COPY.editor.deliveries.testEvent);
    expect(within(deliveries).getByText('Answered 200')).not.toBeNull();
  });

  test('sends a test event before the first save, saves nothing, and says so', async () => {
    const { view, served } = open([], { path: '/hooks/new', draftTest: 'delivered' });
    await chooseEvent(view, 'review', 'A review is waiting');
    await fireEvent.input(view.getByLabelText(HOOKS_COPY.editor.webhook.urlLabel), {
      target: { value: 'https://hooks.example.com/receive' },
    });

    await fireEvent.click(view.getByRole('button', { name: HOOKS_COPY.editor.check.test }));

    await waitFor(() => expect(stub?.callsTo('bureau.hooks.draft.test').length).toBe(1));
    expect(stub?.callsTo('bureau.hooks.draft.test')[0]?.params).toEqual({
      url: 'https://hooks.example.com/receive',
    });
    const result = await view.findByTestId('hook-test-result');
    expect(result.textContent).toContain(
      `${HOOKS_COPY.editor.check.testSent('hooks.example.com', '200 OK', 100)} ${HOOKS_COPY.editor.check.testSentUnsaved}`,
    );
    expect(stub?.callsTo('bureau.hooks.create').length).toBe(0);
    expect(served.hooks).toEqual([]);
    expect(router.pathname).toBe('/hooks/new');
  });

  test('a failed test event is a red alert under the buttons that says what answered', async () => {
    const { view } = open([], { path: '/hooks/new', draftTest: { status: 410 } });
    await chooseEvent(view, 'review', 'A review is waiting');
    await fireEvent.input(view.getByLabelText(HOOKS_COPY.editor.webhook.urlLabel), {
      target: { value: 'https://events.pagerduty.com/v2/enqueue' },
    });
    await fireEvent.click(view.getByRole('button', { name: HOOKS_COPY.editor.check.test }));

    const result = await view.findByTestId('hook-test-result');
    expect(result.textContent).toContain(HOOKS_COPY.editor.check.testFailed);
    expect(result.textContent).toContain(
      HOOKS_COPY.editor.check.testFailedAnswered('events.pagerduty.com', '410 Gone'),
    );
    expect(result.textContent).not.toContain(HOOKS_COPY.editor.webhook.seePayload);
  });

  test('a test event without a usable address asks for one the way Save hook does', async () => {
    const { view } = open([], { path: '/hooks/new' });
    await chooseEvent(view, 'review', 'A review is waiting');
    await fireEvent.input(view.getByLabelText(HOOKS_COPY.editor.webhook.urlLabel), {
      target: { value: 'events.pagerduty.com' },
    });
    await fireEvent.click(view.getByRole('button', { name: HOOKS_COPY.editor.check.test }));

    await view.findByText(HOOKS_COPY.editor.webhook.urlMissing);
    await waitFor(() => expect(document.activeElement?.id).toBe('ib-hook-url'));
    expect(stub?.callsTo('bureau.hooks.draft.test').length).toBe(0);
  });

  test('offers no test event for an action that would start a real run or write a real notification', async () => {
    const { view } = open([hook('alpha', { action: { type: 'notify', title: 'Look' } })], {
      path: '/hooks/alpha',
    });
    const test = (await view.findByRole('button', {
      name: HOOKS_COPY.editor.check.test,
    })) as HTMLButtonElement;
    expect(test.disabled).toBe(true);
    expect(view.getByText(HOOKS_COPY.editor.check.testWebhookOnly)).not.toBeNull();
    // The action of a hook is fixed once it is made: its segments are held, and it has no fields.
    const notify = view.getByRole('radio', { name: HOOKS_COPY.editor.action.notify });
    expect(notify.getAttribute('aria-disabled')).toBe('true');
    await waitFor(() => expect(notify.getAttribute('aria-checked')).toBe('true'));
    expect(view.getByText(HOOKS_COPY.editor.action.fixed)).not.toBeNull();
  });

  test('lists an event the action cannot listen to, disabled, with the reason', async () => {
    const { view } = open([], { path: '/hooks/new' });
    await fireEvent.click(await view.findByRole('radio', { name: HOOKS_COPY.editor.action.notify }));
    const input = await view.findByRole('combobox', { name: HOOKS_COPY.editor.event.label });
    await fireEvent.focus(input);
    await fireEvent.input(input, { target: { value: 'notification' } });
    const option = await waitFor(() => {
      const found = document.body.querySelector('[role="option"]');
      if (found === null) throw new Error('no option');
      return found;
    });
    expect(option.getAttribute('aria-disabled')).toBe('true');
    expect(option.textContent).toContain(HOOKS_COPY.editor.event.notifyLoop);
  });

  test('says a hook changed since it was read, and reads it again, when its revision is stale', async () => {
    const { view, served } = open([hook('alpha')], { path: '/hooks/alpha' });
    await view.findByLabelText(HOOKS_COPY.editor.check.nameLabel);
    served.hooks[0]!.revision = 2;

    await fireEvent.click(view.getByRole('button', { name: HOOKS_COPY.editor.check.save }));

    await view.findByTestId('hook-stale');
    await waitFor(() => expect(stub?.callsTo('bureau.hooks.get').length).toBeGreaterThan(1));
  });

  test('keeps what was typed, an address included, when the hook changed under a stale save, and reloads on request', async () => {
    const { view, served } = open([hook('alpha', { name: 'Old' })], { path: '/hooks/alpha' });
    const name = (await view.findByLabelText(
      HOOKS_COPY.editor.check.nameLabel,
    )) as HTMLInputElement;
    await fireEvent.input(name, { target: { value: 'Mine' } });
    const address = view.getByLabelText(HOOKS_COPY.editor.webhook.urlLabel) as HTMLInputElement;
    await fireEvent.input(address, { target: { value: 'https://example.com/mine' } });
    served.hooks[0]!.revision = 2;
    served.hooks[0]!.name = 'Theirs';

    await fireEvent.click(view.getByRole('button', { name: HOOKS_COPY.editor.check.save }));

    await view.findByTestId('hook-changed');
    expect(name.value).toBe('Mine');
    expect(address.value).toBe('https://example.com/mine');
    expect(view.queryByTestId('hook-stale')).toBeNull();

    // Saving again is still held to the revision the form was read at, so it cannot overwrite.
    await fireEvent.click(view.getByRole('button', { name: HOOKS_COPY.editor.check.save }));
    await waitFor(() => expect(stub?.callsTo('bureau.hooks.update').length).toBe(2));
    expect(stub?.callsTo('bureau.hooks.update')[1]?.params['expectedRevision']).toBe(1);
    expect(served.hooks[0]!.name).toBe('Theirs');

    await fireEvent.click(view.getByRole('button', { name: HOOKS_COPY.editor.reload }));
    await waitFor(() => expect(name.value).toBe('Theirs'));
    expect(view.queryByTestId('hook-changed')).toBeNull();
    expect(address.value).toBe('https://example.com/alpha');
  });

  test('keeps what was typed when a window-focus refetch finds a newer revision, and updates an unedited form', async () => {
    const { view, served } = open([hook('alpha', { name: 'Old' })], { path: '/hooks/alpha' });
    const name = (await view.findByLabelText(
      HOOKS_COPY.editor.check.nameLabel,
    )) as HTMLInputElement;
    const refocus = async () => {
      const reads = stub?.callsTo('bureau.hooks.get').length ?? 0;
      focusManager.setFocused(false);
      focusManager.setFocused(true);
      await waitFor(() => expect(stub?.callsTo('bureau.hooks.get').length).toBeGreaterThan(reads));
    };

    // Unedited: the form follows the newer revision.
    served.hooks[0]!.revision = 2;
    served.hooks[0]!.name = 'Second';
    await refocus();
    await waitFor(() => expect(name.value).toBe('Second'));
    expect(view.queryByTestId('hook-changed')).toBeNull();

    // Edited: the form keeps the edit and offers a reload.
    await fireEvent.input(name, { target: { value: 'Mine' } });
    served.hooks[0]!.revision = 3;
    served.hooks[0]!.name = 'Third';
    await refocus();
    await view.findByTestId('hook-changed');
    expect(name.value).toBe('Mine');
  });

  test('its own save does not raise the warning, and the form follows the saved revision', async () => {
    const { view } = open([hook('alpha', { name: 'Old' })], { path: '/hooks/alpha' });
    const name = (await view.findByLabelText(
      HOOKS_COPY.editor.check.nameLabel,
    )) as HTMLInputElement;
    await fireEvent.input(name, { target: { value: 'Mine' } });

    await fireEvent.click(view.getByRole('button', { name: HOOKS_COPY.editor.check.save }));
    await waitFor(() => expect(stub?.callsTo('bureau.hooks.update').length).toBe(1));
    await waitFor(() => expect(stub?.callsTo('bureau.hooks.get').length).toBeGreaterThan(1));

    expect(view.queryByTestId('hook-changed')).toBeNull();
    expect(name.value).toBe('Mine');
    // A second save goes out at the revision the first one wrote.
    await fireEvent.input(name, { target: { value: 'Again' } });
    await fireEvent.click(view.getByRole('button', { name: HOOKS_COPY.editor.check.save }));
    await waitFor(() => expect(stub?.callsTo('bureau.hooks.update').length).toBe(2));
    expect(stub?.callsTo('bureau.hooks.update')[1]?.params['expectedRevision']).toBe(2);
    expect(view.queryByTestId('hook-changed')).toBeNull();
  });

  test('renaming a workflow hook sends no action, so a paused workflow does not hold it up', async () => {
    const { view } = open(
      [
        hook('alpha', {
          action: { type: 'start-workflow', workflowId: 'resting', input: 'payload' },
        }),
      ],
      { path: '/hooks/alpha', workflows: [{ id: 'resting', state: 'ready', paused: true }] },
    );
    await fireEvent.input(await view.findByLabelText(HOOKS_COPY.editor.check.nameLabel), {
      target: { value: 'Renamed' },
    });
    await fireEvent.click(view.getByRole('button', { name: HOOKS_COPY.editor.check.save }));
    await waitFor(() => expect(stub?.callsTo('bureau.hooks.update').length).toBe(1));
    expect(Object.keys(stub?.callsTo('bureau.hooks.update')[0]?.params ?? {})).not.toContain(
      'action',
    );
  });

  /** Opens the header's More actions menu and presses Delete hook, which asks first. */
  async function pressDelete(view: ReturnType<typeof open>['view']): Promise<void> {
    await fireEvent.click(
      await view.findByRole('button', { name: HOOKS_COPY.editor.header.menuLabel }),
    );
    await fireEvent.click(
      await view.findByRole('menuitem', { name: HOOKS_COPY.editor.check.delete }),
    );
  }

  test('deletes a hook from the menu after a confirmation that names it, and returns to the list', async () => {
    const { view, served } = open([hook('alpha', { name: 'Page on-call' })], {
      path: '/hooks/alpha',
    });
    await pressDelete(view);
    // The dialog names the hook, says what is lost, and the button names the action.
    const dialog = await view.findByRole('dialog');
    expect(dialog.textContent).toContain(HOOKS_COPY.editor.check.deleteTitle('Page on-call'));
    expect(dialog.textContent).toContain(HOOKS_COPY.editor.check.deleteDescription);
    expect(stub?.callsTo('bureau.hooks.delete').length).toBe(0);
    await fireEvent.click(
      within(dialog).getByRole('button', { name: HOOKS_COPY.editor.check.deleteConfirm }),
    );

    await waitFor(() => expect(stub?.callsTo('bureau.hooks.delete').length).toBe(1));
    await waitFor(() => expect(router.pathname).toBe('/hooks'));
    expect(served.hooks).toEqual([]);
  });

  test('says a hook is not found when it is not the caller’s', async () => {
    const { view } = open([], { path: '/hooks/ghost' });
    await view.findByRole('heading', { level: 1, name: HOOKS_COPY.editor.notFound.title });
    expect(view.getByText(HOOKS_COPY.editor.notFound.description)).not.toBeNull();
  });

  test('says hooks are off on a home that keeps them off, on the new hook page too', async () => {
    const { view } = open([], { off: true, path: '/hooks/new' });
    await view.findByRole('heading', { level: 1, name: HOOKS_COPY.unavailable.title });
  });

  test('starts a workflow that is ready and not paused, and says when there is none', async () => {
    const { view } = open([], {
      path: '/hooks/new',
      workflows: [
        { id: 'digest', state: 'ready', paused: false },
        { id: 'resting', state: 'ready', paused: true },
        { id: 'broken', state: 'invalid', paused: false },
      ],
    });
    await fireEvent.click(
      await view.findByRole('radio', { name: HOOKS_COPY.editor.action.startWorkflow }),
    );
    const select = (await view.findByLabelText(
      HOOKS_COPY.editor.workflow.label,
    )) as HTMLSelectElement;
    await waitFor(() =>
      expect(Array.from(select.options).map((option) => option.value)).toEqual(['', 'digest']),
    );
  });

  test('offers a way to make a workflow when none is ready', async () => {
    const { view } = open([], { path: '/hooks/new', workflows: [] });
    await fireEvent.click(
      await view.findByRole('radio', { name: HOOKS_COPY.editor.action.startWorkflow }),
    );
    await view.findByRole('heading', { level: 3, name: HOOKS_COPY.editor.workflow.none });
    expect(
      view.getByRole('link', { name: HOOKS_COPY.editor.workflow.create }).getAttribute('href'),
    ).toBe('/workflows/new');
  });
});

describe('a saved hook’s header', () => {
  const PAGER_ADDRESS = 'https://events.pagerduty.com/v2/enqueue';
  const gaveUp = () =>
    delivery('alpha', 'exhausted', {
      attempts: [
        {
          number: 1,
          startedAt: 2_000,
          finishedAt: 2_100,
          outcome: 'response',
          status: 410,
          responseExcerpt: null,
          responseTruncated: null,
          error: null,
          receipt: null,
        },
      ],
    });
  const named = () =>
    hook('alpha', {
      name: 'Page on-call when a run fails',
      action: { type: 'webhook', url: PAGER_ADDRESS },
    });

  test('is the hook’s name, its On switch, a menu, its sentence and its latest delivery, with no way back to a list', async () => {
    const { view } = open([named()], {
      path: '/hooks/alpha',
      deliveries: { alpha: [gaveUp()] },
    });
    const header = await view.findByTestId('hook-header');
    expect(
      within(header).getByRole('heading', { level: 1, name: 'Page on-call when a run fails' }),
    ).not.toBeNull();
    expect(within(header).getByRole('switch').getAttribute('aria-checked')).toBe('true');
    expect(within(header).getByText(HOOKS_COPY.editor.header.on)).not.toBeNull();
    expect(
      within(header).getByRole('button', { name: HOOKS_COPY.editor.header.menuLabel }),
    ).not.toBeNull();
    expect(header.textContent).toContain(
      'When a review is waiting, send a webhook to events.pagerduty.com.',
    );
    expect(view.queryByRole('link', { name: 'All hooks' })).toBeNull();

    // The latest delivery: a red Gave up dot and word, what answered, and a link to the log.
    const latest = await within(header).findByTestId('hook-latest-delivery');
    expect(latest.textContent).toContain('Gave up');
    expect(within(latest).getByTestId('hook-latest-when').textContent).toContain('410 Gone');
    const jump = within(latest).getByRole('link', { name: HOOKS_COPY.editor.header.jumpToLog });
    expect(jump.getAttribute('href')).toBe('#ib-hook-log');
    await fireEvent.click(jump);
    await waitFor(() => expect(document.activeElement?.id).toBe('ib-hook-log'));
  });

  test('says a hook that has sent nothing yet', async () => {
    const { view } = open([named()], { path: '/hooks/alpha' });
    const latest = await view.findByTestId('hook-latest-delivery');
    expect(latest.textContent).toContain(HOOKS_COPY.editor.header.nothingSent);
    expect(within(latest).queryByTestId('hook-latest-when')).toBeNull();
  });

  test('a hook with no name is headed by its sentence', async () => {
    const { view } = open([hook('alpha')], { path: '/hooks/alpha' });
    const header = await view.findByTestId('hook-header');
    expect(
      within(header).getByRole('heading', {
        level: 1,
        name: 'When a review is waiting, send a webhook to example.com',
      }),
    ).not.toBeNull();
  });

  test('saves the On switch at once, says so in a toast with Undo, and Undo turns it back on', async () => {
    const { view } = open([named()], { path: '/hooks/alpha' });
    const header = await view.findByTestId('hook-header');
    await fireEvent.click(within(header).getByRole('switch'));

    await waitFor(() => expect(stub?.callsTo('bureau.hooks.update').length).toBe(1));
    expect(stub?.callsTo('bureau.hooks.update')[0]?.params).toEqual({
      hookId: 'alpha',
      expectedRevision: 1,
      enabled: false,
    });
    await view.findByText(HOOKS_COPY.editor.toggled.off('Page on-call when a run fails'));
    await waitFor(() =>
      expect(within(header).getByRole('switch').getAttribute('aria-checked')).toBe('false'),
    );

    await fireEvent.click(await view.findByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(stub?.callsTo('bureau.hooks.update').length).toBe(2));
    expect(stub?.callsTo('bureau.hooks.update')[1]?.params).toEqual({
      hookId: 'alpha',
      expectedRevision: 2,
      enabled: true,
    });
    await waitFor(() =>
      expect(within(header).getByRole('switch').getAttribute('aria-checked')).toBe('true'),
    );
  });

  test('the switch saves alone: what was typed stays, and the next Save names the new revision', async () => {
    const { view } = open([named()], { path: '/hooks/alpha' });
    const name = (await view.findByLabelText(
      HOOKS_COPY.editor.check.nameLabel,
    )) as HTMLInputElement;
    await fireEvent.input(name, { target: { value: 'Mine' } });
    const header = await view.findByTestId('hook-header');
    await fireEvent.click(within(header).getByRole('switch'));
    await waitFor(() =>
      expect(within(header).getByRole('switch').getAttribute('aria-checked')).toBe('false'),
    );
    expect(name.value).toBe('Mine');
    expect(view.queryByTestId('hook-changed')).toBeNull();

    await fireEvent.click(view.getByRole('button', { name: HOOKS_COPY.editor.check.save }));
    await waitFor(() => expect(stub?.callsTo('bureau.hooks.update').length).toBe(2));
    expect(stub?.callsTo('bureau.hooks.update')[1]?.params).toEqual({
      hookId: 'alpha',
      expectedRevision: 2,
      name: 'Mine',
    });
  });

  test('says a switch the Bureau refused, and leaves the hook as it was', async () => {
    const { view } = open([named()], {
      path: '/hooks/alpha',
      refuse: { 'bureau.hooks.update': new StubFault('Forbidden', 403, 'Not yours.') },
    });
    const header = await view.findByTestId('hook-header');
    await fireEvent.click(within(header).getByRole('switch'));
    await view.findByText(new RegExp(HOOKS_COPY.editor.toggled.failed));
    expect(within(header).getByRole('switch').getAttribute('aria-checked')).toBe('true');
  });
});

describe('the steps of a saved hook', () => {
  test('shows the event as plain text with its raw kind and a note, and offers no picker', async () => {
    const { view } = open([hook('alpha')], { path: '/hooks/alpha' });
    const locked = await view.findByTestId('hook-event-locked');
    expect(locked.textContent).toContain('A review is waiting');
    expect(locked.textContent).toContain('review.requested');
    expect(locked.textContent).toContain(HOOKS_COPY.editor.event.fixed);
    expect(locked.querySelector('[aria-readonly="true"]')).not.toBeNull();
    expect(view.container.querySelector('input[role="combobox"]')).toBeNull();
  });

  test('is numbered 1 When, 2 Then, 3 Check, with the delivery log beside them', async () => {
    const { view } = open([hook('alpha')], { path: '/hooks/alpha' });
    const titles = await waitFor(() => {
      const found = Array.from(view.container.querySelectorAll('h2.ib-hook-step__title')).map(
        (element) => element.textContent?.replaceAll(/\s+/g, ' ').trim(),
      );
      expect(found.length).toBe(3);
      return found;
    });
    expect(titles).toEqual(['1 When', '2 Then', '3 Check']);
    expect(view.container.querySelector('aside#ib-hook-log [data-testid="hook-deliveries"]')).not.toBeNull();
  });

  test('keeps the Check sentence as the hook reads in the editor, in a quiet box above the buttons', async () => {
    const { view } = open([hook('alpha')], { path: '/hooks/alpha' });
    const sentence = await view.findByTestId('hook-sentence');
    expect(sentence.textContent).toBe(
      'When a review is waiting, send a webhook to example.com.',
    );
    const save = view.getByRole('button', { name: HOOKS_COPY.editor.check.save });
    expect(sentence.nextElementSibling).toBe(save.parentElement);
  });

  test('on a phone When and Then are one-line summaries that open to their fields', async () => {
    const original = Object.getOwnPropertyDescriptor(window, 'matchMedia');
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: (query: string) => ({
        media: query,
        matches: query.includes('640'),
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        addListener: () => undefined,
        removeListener: () => undefined,
      }),
    });
    try {
      const { view } = open([hook('alpha', { events: ['goal.attempt.evaluating'] })], {
        path: '/hooks/alpha',
      });
      const when = await view.findByTestId('hook-step-summary-when');
      // The event narrows by one kind of subject only, so the summary says it covers any of them.
      await waitFor(() => expect(when.textContent).toContain('Goal attempt evaluating, Any agent'));
      const then = view.getByTestId('hook-step-summary-then');
      expect(then.textContent).toContain('Send a webhook to example.com');
      expect(view.queryByLabelText(HOOKS_COPY.editor.webhook.urlLabel)).toBeNull();

      await fireEvent.click(within(then).getByRole('button', { name: HOOKS_COPY.editor.steps.edit }));
      expect(view.getByLabelText(HOOKS_COPY.editor.webhook.urlLabel)).not.toBeNull();
      expect(view.queryByTestId('hook-step-summary-then')).toBeNull();
      await fireEvent.click(within(when).getByRole('button', { name: HOOKS_COPY.editor.steps.edit }));
      expect(view.getByTestId('hook-event-locked')).not.toBeNull();
    } finally {
      if (original === undefined) Reflect.deleteProperty(window, 'matchMedia');
      else Object.defineProperty(window, 'matchMedia', original);
    }
  });

  test('a workflow hook whose workflow was deleted keeps its old name marked and asks for another', async () => {
    const { view } = open(
      [
        hook('alpha', {
          action: { type: 'start-workflow', workflowId: 'weekly-cleanup', input: 'payload' },
        }),
      ],
      { path: '/hooks/alpha', workflows: [] },
    );
    const select = (await view.findByLabelText(
      HOOKS_COPY.editor.workflow.label,
    )) as HTMLSelectElement;
    await waitFor(() =>
      expect(select.options[1]?.textContent?.trim()).toBe(
        HOOKS_COPY.editor.workflow.deletedName('weekly-cleanup'),
      ),
    );
    await view.findByText(HOOKS_COPY.editor.workflow.deleted);

    // Save hook says what to pick, moves to the field, and sends nothing.
    await fireEvent.click(view.getByRole('button', { name: HOOKS_COPY.editor.check.save }));
    await waitFor(() => expect(document.activeElement?.id).toBe('ib-hook-workflow'));
    expect(stub?.callsTo('bureau.hooks.update').length).toBe(0);
  });

  test('says what a workflow hook starts, and what the workflow receives', async () => {
    const { view } = open(
      [
        hook('alpha', {
          action: { type: 'start-workflow', workflowId: 'order-refund', input: 'payload' },
        }),
      ],
      { path: '/hooks/alpha', workflows: [{ id: 'order-refund', state: 'ready', paused: false }] },
    );
    const select = (await view.findByLabelText(
      HOOKS_COPY.editor.workflow.label,
    )) as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe('order-refund'));
    expect(view.getByText(HOOKS_COPY.editor.workflow.payload)).not.toBeNull();
    expect(view.queryByText(HOOKS_COPY.editor.workflow.deleted)).toBeNull();
  });
});

describe('the Then step of a new hook', () => {
  test('is a segmented control, and each choice shows its own fields', async () => {
    const { view } = open([], {
      path: '/hooks/new',
      workflows: [{ id: 'order-refund', state: 'ready', paused: false }],
    });
    const webhook = await view.findByRole('radio', { name: HOOKS_COPY.editor.action.webhook });
    expect(webhook.getAttribute('aria-checked')).toBe('true');
    const address = view.getByLabelText(HOOKS_COPY.editor.webhook.urlLabel) as HTMLInputElement;
    expect(address.placeholder).toBe(HOOKS_COPY.editor.webhook.urlPlaceholder);

    await fireEvent.click(view.getByRole('radio', { name: HOOKS_COPY.editor.action.startWorkflow }));
    await view.findByLabelText(HOOKS_COPY.editor.workflow.label);
    expect(view.getByText(HOOKS_COPY.editor.workflow.payload)).not.toBeNull();
    expect(view.queryByLabelText(HOOKS_COPY.editor.webhook.urlLabel)).toBeNull();

    await fireEvent.click(view.getByRole('radio', { name: HOOKS_COPY.editor.action.notify }));
    expect(view.getByTestId('hook-notify-note').textContent).toContain(
      HOOKS_COPY.editor.action.notifyNote,
    );
    expect(view.queryByLabelText(HOOKS_COPY.editor.workflow.label)).toBeNull();
  });

  test('names a missing event and address beside their fields when Save hook is pressed, and moves focus to the first', async () => {
    const { view } = open([], { path: '/hooks/new' });
    const save = (await view.findByRole('button', {
      name: HOOKS_COPY.editor.check.create,
    })) as HTMLButtonElement;
    expect(save.disabled).toBe(false);
    // Nothing is said before it is pressed, and the Check step says what to do first.
    expect(view.queryByText(HOOKS_COPY.editor.event.required)).toBeNull();
    expect(view.getByTestId('hook-check-summary').textContent).toContain(
      HOOKS_COPY.editor.check.pickEvent,
    );

    await fireEvent.click(save);

    await view.findByText(HOOKS_COPY.editor.event.required);
    await view.findByText(HOOKS_COPY.editor.webhook.urlMissing);
    await waitFor(() =>
      expect(document.activeElement).toBe(
        view.getByRole('combobox', { name: HOOKS_COPY.editor.event.label }),
      ),
    );
    expect(stub?.callsTo('bureau.hooks.create').length).toBe(0);
  });

  test('says an address without https:// as it is typed, keeps it, and sends nothing', async () => {
    const { view } = open([], { path: '/hooks/new' });
    await chooseEvent(view, 'review', 'A review is waiting');
    const address = view.getByLabelText(HOOKS_COPY.editor.webhook.urlLabel) as HTMLInputElement;
    await fireEvent.input(address, { target: { value: 'events.pagerduty.com' } });
    await view.findByText(HOOKS_COPY.editor.webhook.urlMissing);
    expect(address.getAttribute('aria-invalid')).toBe('true');

    await fireEvent.click(view.getByRole('button', { name: HOOKS_COPY.editor.check.create }));
    await waitFor(() => expect(document.activeElement).toBe(address));
    expect(address.value).toBe('events.pagerduty.com');
    expect(stub?.callsTo('bureau.hooks.create').length).toBe(0);
  });

  test('is headed New hook with its one-line subtitle, and a Check that says to pick an event', async () => {
    const { view } = open([], { path: '/hooks/new' });
    await view.findByRole('heading', { level: 1, name: HOOKS_COPY.editor.newTitle });
    expect(view.getByText(HOOKS_COPY.editor.newDescription)).not.toBeNull();
    expect(
      (view.getByLabelText(HOOKS_COPY.editor.webhook.urlLabel) as HTMLInputElement).placeholder,
    ).toBe('https://');
    expect(view.queryByRole('switch')).toBeNull();
    expect(view.queryByRole('button', { name: HOOKS_COPY.editor.header.menuLabel })).toBeNull();
  });
});

describe('while the hook is read', () => {
  test('draws placeholders for the title and the three steps instead of the editor', async () => {
    const { view } = open([hook('alpha')], { path: '/hooks/alpha', holdRead: true });
    await view.findByTestId('hook-loading');
    expect(view.queryByTestId('hook-header')).toBeNull();
    expect(view.container.querySelector('h2.ib-hook-step__title')).toBeNull();
    expect(view.queryByRole('button', { name: HOOKS_COPY.editor.check.save })).toBeNull();
  });
});

describe('the Bureau’s own words about a hook that is gone', () => {
  test('say it does not exist, and that the other hooks are unchanged', async () => {
    const { view } = open([hook('alpha')], { path: '/hooks/ghost' });
    await view.findByRole('heading', { level: 1, name: HOOKS_COPY.editor.notFound.title });
    expect(view.getByText(HOOKS_COPY.editor.notFound.description)).not.toBeNull();
    expect(view.queryByRole('button', { name: HOOKS_COPY.editor.check.save })).toBeNull();
  });
});

describe('when the Bureau refuses', () => {
  const invalid = () =>
    new StubFault('InvalidParams', 400, 'The address is not acceptable.', {
      issues: [{ path: ['action', 'url'], message: 'refused', code: 'custom' }],
    });

  test('a new hook, the page says so under the Check sentence and keeps what was typed', async () => {
    const { view } = open([], {
      path: '/hooks/new',
      refuse: { 'bureau.hooks.create': invalid() },
    });
    const picker = await view.findByRole('combobox', { name: HOOKS_COPY.editor.event.label });
    await fireEvent.focus(picker);
    await fireEvent.input(picker, { target: { value: 'review' } });
    const option = await waitFor(() => {
      const found = document.body.querySelector('[role="option"]');
      if (found === null) throw new Error('no option');
      return found;
    });
    await fireEvent.mouseDown(option);
    await fireEvent.input(view.getByLabelText(HOOKS_COPY.editor.webhook.urlLabel), {
      target: { value: 'https://example.com/receive' },
    });
    await fireEvent.click(view.getByRole('button', { name: HOOKS_COPY.editor.check.create }));

    const failure = await view.findByTestId('hook-failure');
    expect(failure.textContent).toContain(HOOKS_COPY.editor.saveFailed);
    expect(failure.textContent).toContain(HOOKS_COPY.editor.saveFailedKept);
    expect(router.pathname).toBe('/hooks/new');
    expect(
      (view.getByLabelText(HOOKS_COPY.editor.webhook.urlLabel) as HTMLInputElement).value,
    ).toBe('https://example.com/receive');
    // Save hook stays enabled and is the retry: there is no second "Try again".
    expect(
      (view.getByRole('button', { name: HOOKS_COPY.editor.check.create }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
    expect(view.queryByRole('button', { name: RETRY_LABEL })).toBeNull();
  });

  test('a server error is said with its status, in the words of the design', async () => {
    const { view } = open([hook('alpha')], {
      path: '/hooks/alpha',
      refuse: { 'bureau.hooks.update': new StubFault('EngineFailure', 500, 'It broke.') },
    });
    await fireEvent.input(await view.findByLabelText(HOOKS_COPY.editor.check.nameLabel), {
      target: { value: 'Renamed' },
    });
    await fireEvent.click(view.getByRole('button', { name: HOOKS_COPY.editor.check.save }));

    const failure = await view.findByTestId('hook-failure');
    expect(failure.textContent).toContain(
      `${HOOKS_COPY.editor.saveFailed} ${HOOKS_COPY.editor.answeredWithError(500)} ${HOOKS_COPY.editor.saveFailedKept}`,
    );
  });

  test('a delivery list that cannot be read, the page says so beside the steps', async () => {
    const { view } = open([hook('alpha')], {
      path: '/hooks/alpha',
      refuse: { 'bureau.hooks.deliveries': new StubFault('EngineFailure', 500, 'It broke.') },
    });
    const deliveries = await view.findByTestId('hook-deliveries');
    await within(deliveries).findByText(HOOKS_COPY.editor.deliveries.loadFailed);
  });

  test('an event list that cannot be read, the page says so in the first step', async () => {
    const { view } = open([], {
      path: '/hooks/new',
      refuse: { 'bureau.events.catalog': new StubFault('EngineFailure', 500, 'It broke.') },
    });
    await view.findByText(HOOKS_COPY.editor.event.loadFailed);
  });

  test('a test event that cannot be sent, the page says so under the buttons', async () => {
    const { view } = open([hook('alpha')], {
      path: '/hooks/alpha',
      refuse: { 'bureau.hooks.test': new StubFault('Unprocessable', 422, 'No secret.') },
    });
    await fireEvent.click(await view.findByRole('button', { name: HOOKS_COPY.editor.check.test }));
    const result = await view.findByTestId('hook-test-result');
    expect(result.textContent).toContain(HOOKS_COPY.editor.check.testFailed);
  });

  test('a delete, the page stays and says so', async () => {
    const { view } = open([hook('alpha')], {
      path: '/hooks/alpha',
      refuse: { 'bureau.hooks.delete': new StubFault('Forbidden', 403, 'Not yours.') },
    });
    await fireEvent.click(
      await view.findByRole('button', { name: HOOKS_COPY.editor.header.menuLabel }),
    );
    await fireEvent.click(
      await view.findByRole('menuitem', { name: HOOKS_COPY.editor.check.delete }),
    );
    const dialog = await view.findByRole('dialog');
    await fireEvent.click(
      within(dialog).getByRole('button', { name: HOOKS_COPY.editor.check.deleteConfirm }),
    );
    await view.findByText(new RegExp(HOOKS_COPY.editor.check.deleteFailed));
    expect(router.pathname).toBe('/hooks/alpha');
  });

  test('a switch, the list says so and leaves the hook as it was', async () => {
    const { view } = open([hook('alpha')], {
      refuse: { 'bureau.hooks.update': new StubFault('Forbidden', 403, 'Not yours.') },
    });
    await waitFor(() => expect(row(view.container, 'alpha')).not.toBeNull());
    await fireEvent.click(within(row(view.container, 'alpha')!).getByRole('switch'));
    await view.findByText(new RegExp(HOOKS_COPY.toggleFailed));
    expect(
      within(row(view.container, 'alpha')!).getByRole('switch').getAttribute('aria-checked'),
    ).toBe('true');
  });
});

describe('the editor for a hook it cannot change the action of', () => {
  test('a hook from a plugin keeps its action, and saves only what changed', async () => {
    const { view } = open(
      [hook('alpha', { action: { type: 'plugin', plugin: 'acme', kind: 'page' }, name: 'Paged' })],
      { path: '/hooks/alpha' },
    );
    await view.findByText(HOOKS_COPY.editor.action.plugin);
    expect(view.getByTestId('hook-sentence').textContent).toContain('run page from acme');
    expect(view.queryByLabelText(HOOKS_COPY.editor.action.label)).toBeNull();
    // Without a test: a plugin's action is not a signed message.
    expect(
      (view.getByRole('button', { name: HOOKS_COPY.editor.check.test }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);

    await fireEvent.click(view.getByRole('button', { name: HOOKS_COPY.editor.check.save }));

    await waitFor(() => expect(stub?.callsTo('bureau.hooks.update').length).toBe(1));
    expect(stub?.callsTo('bureau.hooks.update')[0]?.params).toEqual({
      hookId: 'alpha',
      expectedRevision: 1,
      name: 'Paged',
    });
  });

  test('an event the action cannot listen to, left chosen after the action changed, blocks the save', async () => {
    const { view } = open([], { path: '/hooks/new' });
    const picker = await view.findByRole('combobox', { name: HOOKS_COPY.editor.event.label });
    await fireEvent.focus(picker);
    await fireEvent.input(picker, { target: { value: 'notification' } });
    const option = await waitFor(() => {
      const found = document.body.querySelector('[role="option"]');
      if (found === null) throw new Error('no option');
      return found;
    });
    await fireEvent.mouseDown(option);
    await fireEvent.input(view.getByLabelText(HOOKS_COPY.editor.webhook.urlLabel), {
      target: { value: 'https://example.com/receive' },
    });

    await fireEvent.click(await view.findByRole('radio', { name: HOOKS_COPY.editor.action.notify }));

    const refused = await view.findByTestId('hook-refused-events');
    expect(refused.textContent).toContain(HOOKS_COPY.editor.event.notifyLoop);
    // Save hook stays enabled; pressing it makes nothing and moves focus to the Event field.
    const save = view.getByRole('button', {
      name: HOOKS_COPY.editor.check.create,
    }) as HTMLButtonElement;
    expect(save.disabled).toBe(false);
    await fireEvent.click(save);
    await waitFor(() =>
      expect(document.activeElement).toBe(
        view.getByRole('combobox', { name: HOOKS_COPY.editor.event.label }),
      ),
    );
    expect(stub?.callsTo('bureau.hooks.create').length).toBe(0);
  });

});
