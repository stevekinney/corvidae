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

let stub: BureauStub | undefined;
afterEach(() => {
  cleanup();
  stub?.restore();
  stub = undefined;
});

const SIGNING_SECRET = 'a-signing-secret-of-twenty-chars';

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
    'bureau.hooks.get': (params) => (options.off ? unsupported() : found(params)),
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
      return made;
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
  container.querySelector<HTMLElement>(`tr[data-hook="${id}"]`);
const rowIds = (container: HTMLElement) =>
  Array.from(container.querySelectorAll<HTMLElement>('tr[data-hook]')).map(
    (element) => element.dataset['hook'],
  );

describe('the hooks list', () => {
  test('reads each hook as a sentence, with its last delivery, and puts a failing hook first', async () => {
    const { view } = open(
      [
        hook('quiet', { events: ['review.requested'] }),
        hook('broken', {
          events: ['goal.attempt.evaluating', 'schedule.missed'],
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
      expect(within(row(view.container, 'broken')!).getByText('Failed')).not.toBeNull(),
    );
    await waitFor(() => expect(rowIds(view.container)).toEqual(['broken', 'quiet', 'fresh']));

    const broken = within(row(view.container, 'broken')!);
    expect(
      broken.getByRole('link', {
        name: 'When Goal attempt evaluating or Schedule missed, send a signed message to https://example.com/broken',
      }),
    ).not.toBeNull();
    expect(broken.getByText('Page the team')).not.toBeNull();
    expect(broken.getByText('No answer: connect refused')).not.toBeNull();
    expect(within(row(view.container, 'quiet')!).getByText('Answered 200')).not.toBeNull();
    expect(within(row(view.container, 'fresh')!).getByText(HOOKS_COPY.noDelivery)).not.toBeNull();
    expect(view.container.querySelector('[data-view="hooks"]')?.getAttribute('data-state')).toBe(
      'ready',
    );
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
    expect(view.getByRole('columnheader', { name: HOOKS_COPY.onlyForColumn })).not.toBeNull();
    const cell = (id: string) => row(view.container, id)!.querySelector('[data-only-for]')!;
    expect(cell('everyone').textContent?.trim()).toBe(HOOKS_COPY.onlyFor.everything);
    expect(cell('nightly').querySelector('a')?.getAttribute('href')).toContain('nightly');
    expect(cell('scoped').querySelector('a')?.textContent).toBe('Agent researcher');
    expect(cell('future').textContent?.trim()).toBe('team blue');
    expect(
      within(row(view.container, 'scoped')!).getByRole('link', {
        name: 'When Review requested for the agent researcher, send a signed message to https://example.com/scoped',
      }),
    ).not.toBeNull();
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
    await fireEvent.click(view.getByRole('button', { name: /Agent: researcher/ }));
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
    await view.findByRole('heading', { level: 2, name: HOOKS_COPY.noMatch.title });
    await fireEvent.click(view.getByRole('button', { name: HOOKS_COPY.clearAction }));
    await waitFor(() => expect(rowIds(view.container)).toEqual(['alpha', 'beta']));

    await fireEvent.change(view.getByLabelText(HOOKS_COPY.eventFilter), {
      target: { value: 'review.requested' },
    });
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

  test('is empty with the frame’s first-use state and a New hook action', async () => {
    const { view } = open([]);
    await view.findByRole('heading', { level: 1, name: 'No hooks yet' });
    expect(view.getByRole('link', { name: HOOKS_COPY.newAction }).getAttribute('href')).toBe(
      '/hooks/new',
    );
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

  test('makes a webhook hook from an event, an address and a secret, and sends exactly those', async () => {
    const { view } = open([], { path: '/hooks/new' });
    await chooseEvent(view, 'review', 'Review requested');
    await waitFor(() =>
      expect(view.getByTestId('hook-sentence').textContent).toContain('Review requested'),
    );

    // A secret that is too short is said inline and cannot be saved.
    await fireEvent.input(view.getByLabelText(HOOKS_COPY.editor.webhook.urlLabel), {
      target: { value: 'https://example.com/receive' },
    });
    await fireEvent.input(view.getByLabelText(HOOKS_COPY.editor.webhook.secretLabel), {
      target: { value: 'short' },
    });
    await view.findByText(HOOKS_COPY.editor.webhook.secretTooShort);
    expect(
      (view.getByRole('button', { name: HOOKS_COPY.editor.check.create }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);

    await fireEvent.input(view.getByLabelText(HOOKS_COPY.editor.webhook.secretLabel), {
      target: { value: SIGNING_SECRET },
    });
    await fireEvent.input(view.getByLabelText(HOOKS_COPY.editor.check.nameLabel), {
      target: { value: 'Tell the receiver' },
    });
    expect(view.getByTestId('hook-sentence').textContent).toContain(
      'When Review requested, send a signed message to https://example.com/receive',
    );
    await fireEvent.click(view.getByRole('button', { name: HOOKS_COPY.editor.check.create }));

    await waitFor(() => expect(stub?.callsTo('bureau.hooks.create').length).toBe(1));
    expect(stub?.callsTo('bureau.hooks.create')[0]?.params).toEqual({
      name: 'Tell the receiver',
      events: ['review.requested'],
      action: { type: 'webhook', url: 'https://example.com/receive' },
      signingSecret: SIGNING_SECRET,
    });
    // A hook that is made opens on its own page, where it can be tested.
    await waitFor(() => expect(router.pathname).toBe('/hooks/hook-created-1'));
    await view.findByRole('button', { name: HOOKS_COPY.editor.check.test });
  });

  test('offers what the chosen events can be limited to, and writes the subject chosen', async () => {
    const { view } = open([], { path: '/hooks/new' });
    expect(view.queryByLabelText(HOOKS_COPY.editor.onlyFor.label)).toBeNull();
    await chooseEvent(view, 'review', 'Review requested');

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
          skipUntil: null,
          lastFireAt: null,
          missedFireCount: 0,
          skippedCount: 0,
          createdAt: '2026-11-01T00:00:00.000Z',
          updatedAt: '2026-11-01T00:00:00.000Z',
        },
      ],
    });
    await chooseEvent(view, 'review', 'Review requested');
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
    await chooseEvent(view, 'review', 'Review requested');
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

  test('refuses to save a limit an added event cannot tell, and clears when it is removed', async () => {
    const { view } = open([hook('alpha', { scope: { kind: 'schedule', id: 'every-hour' } })], {
      path: '/hooks/alpha',
    });
    const save = (await view.findByRole('button', {
      name: HOOKS_COPY.editor.check.save,
    })) as HTMLButtonElement;
    await view.findByLabelText(HOOKS_COPY.editor.onlyFor.subject.schedule);
    await chooseEvent(view, 'goal', 'Goal attempt evaluating');

    await view.findByTestId('hook-scope-refused');
    expect(save.disabled).toBe(true);

    await fireEvent.change(view.getByLabelText(HOOKS_COPY.editor.onlyFor.label), {
      target: { value: '' },
    });
    await waitFor(() =>
      expect(view.queryByTestId('hook-scope-refused')?.outerHTML ?? null).toBeNull(),
    );
    await fireEvent.click(save);
    await waitFor(() => expect(stub?.callsTo('bureau.hooks.update').length).toBe(1));
    expect(stub?.callsTo('bureau.hooks.update')[0]?.params).toMatchObject({ scope: null });
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

  // COR-1978: a remote home cannot hold a signing secret, so it writes every other action.
  test('does not offer a signed message on a remote home, and starts on notify', async () => {
    const { view } = open([], { path: '/hooks/new', hostMode: 'remote' });
    const action = (await view.findByLabelText(
      HOOKS_COPY.editor.action.label,
    )) as HTMLSelectElement;

    await waitFor(() => expect(action.value).toBe('notify'));
    const webhook = Array.from(action.options).find((option) => option.value === 'webhook');
    expect(webhook?.disabled).toBe(true);
    await view.findByText(HOOKS_COPY.editor.action.chooseRemote);
    expect(view.queryByLabelText(HOOKS_COPY.editor.webhook.secretLabel)).toBeNull();
  });

  test('starts limited to the agent the address names', async () => {
    const { view } = open([], { path: `/hooks/new?agent=${AGENT.name}` });
    await chooseEvent(view, 'review', 'Review requested');
    const only = (await view.findByLabelText(HOOKS_COPY.editor.onlyFor.label)) as HTMLSelectElement;
    await waitFor(() => expect(only.value).toBe('agent'));
    const subject = (await view.findByLabelText(
      HOOKS_COPY.editor.onlyFor.subject.agent,
    )) as HTMLSelectElement;
    await waitFor(() => expect(subject.value).toBe(AGENT.name));
  });

  test('never shows a signing secret: an existing hook opens with the field empty, and empty keeps the secret', async () => {
    const { view } = open([hook('alpha', { name: 'Keep' })], { path: '/hooks/alpha' });
    const secret = (await view.findByLabelText(
      HOOKS_COPY.editor.webhook.secretLabel,
    )) as HTMLInputElement;
    expect(secret.value).toBe('');
    expect(secret.type).toBe('password');

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
      events: ['review.requested'],
    });
    expect(Object.keys(sent)).not.toContain('signingSecret');
  });

  test('sends a test event to the saved address and shows the delivery beside the editor', async () => {
    const { view } = open([hook('alpha')], {
      path: '/hooks/alpha',
      deliveries: { alpha: [delivery('alpha', 'exhausted')] },
    });
    const deliveries = await view.findByTestId('hook-deliveries');
    await within(deliveries).findByText('No answer: connect refused');
    // The page says what the test reaches before it is pressed.
    expect(
      view.getByText(HOOKS_COPY.editor.check.testReaches('https://example.com/alpha')),
    ).not.toBeNull();

    await fireEvent.click(view.getByRole('button', { name: HOOKS_COPY.editor.check.test }));

    await waitFor(() => expect(stub?.callsTo('bureau.hooks.test').length).toBe(1));
    expect(stub?.callsTo('bureau.hooks.test')[0]?.params).toEqual({ hookId: 'alpha' });
    await within(deliveries).findByText(HOOKS_COPY.editor.deliveries.testEvent);
    expect(within(deliveries).getByText('Answered 200')).not.toBeNull();
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
    // The action of a hook is fixed once it is made.
    expect(
      (view.getByLabelText(HOOKS_COPY.editor.action.label) as HTMLSelectElement).disabled,
    ).toBe(true);
  });

  test('lists an event the action cannot listen to, disabled, with the reason', async () => {
    const { view } = open([], { path: '/hooks/new' });
    await fireEvent.change(await view.findByLabelText(HOOKS_COPY.editor.action.label), {
      target: { value: 'notify' },
    });
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

  test('keeps what was typed, a secret included, when the hook changed under a stale save, and reloads on request', async () => {
    const { view, served } = open([hook('alpha', { name: 'Old' })], { path: '/hooks/alpha' });
    const name = (await view.findByLabelText(
      HOOKS_COPY.editor.check.nameLabel,
    )) as HTMLInputElement;
    await fireEvent.input(name, { target: { value: 'Mine' } });
    await fireEvent.input(view.getByLabelText(HOOKS_COPY.editor.webhook.secretLabel), {
      target: { value: SIGNING_SECRET },
    });
    served.hooks[0]!.revision = 2;
    served.hooks[0]!.name = 'Theirs';

    await fireEvent.click(view.getByRole('button', { name: HOOKS_COPY.editor.check.save }));

    await view.findByTestId('hook-changed');
    expect(name.value).toBe('Mine');
    expect(
      (view.getByLabelText(HOOKS_COPY.editor.webhook.secretLabel) as HTMLInputElement).value,
    ).toBe(SIGNING_SECRET);
    expect(view.queryByTestId('hook-stale')).toBeNull();

    // Saving again is still held to the revision the form was read at, so it cannot overwrite.
    await fireEvent.click(view.getByRole('button', { name: HOOKS_COPY.editor.check.save }));
    await waitFor(() => expect(stub?.callsTo('bureau.hooks.update').length).toBe(2));
    expect(stub?.callsTo('bureau.hooks.update')[1]?.params['expectedRevision']).toBe(1);
    expect(served.hooks[0]!.name).toBe('Theirs');

    await fireEvent.click(view.getByRole('button', { name: HOOKS_COPY.editor.reload }));
    await waitFor(() => expect(name.value).toBe('Theirs'));
    expect(view.queryByTestId('hook-changed')).toBeNull();
    expect(
      (view.getByLabelText(HOOKS_COPY.editor.webhook.secretLabel) as HTMLInputElement).value,
    ).toBe('');
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
    await fireEvent.input(view.getByLabelText(HOOKS_COPY.editor.webhook.secretLabel), {
      target: { value: SIGNING_SECRET },
    });

    await fireEvent.click(view.getByRole('button', { name: HOOKS_COPY.editor.check.save }));
    await waitFor(() => expect(stub?.callsTo('bureau.hooks.update').length).toBe(1));
    await waitFor(() => expect(stub?.callsTo('bureau.hooks.get').length).toBeGreaterThan(1));

    expect(view.queryByTestId('hook-changed')).toBeNull();
    expect(name.value).toBe('Mine');
    await waitFor(() =>
      expect(
        (view.getByLabelText(HOOKS_COPY.editor.webhook.secretLabel) as HTMLInputElement).value,
      ).toBe(''),
    );
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

  test('deletes a hook after a confirmation and returns to the list', async () => {
    const { view, served } = open([hook('alpha')], { path: '/hooks/alpha' });
    await fireEvent.click(
      await view.findByRole('button', { name: HOOKS_COPY.editor.check.delete }),
    );
    await fireEvent.click(
      await view.findByRole('button', { name: HOOKS_COPY.editor.check.deleteConfirm }),
    );

    await waitFor(() => expect(stub?.callsTo('bureau.hooks.delete').length).toBe(1));
    await waitFor(() => expect(router.pathname).toBe('/hooks'));
    expect(served.hooks).toEqual([]);
  });

  test('says a hook is not found when it is not the caller’s', async () => {
    const { view } = open([], { path: '/hooks/ghost' });
    await view.findByRole('heading', { level: 1, name: 'This hook was not found' });
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
    await fireEvent.change(await view.findByLabelText(HOOKS_COPY.editor.action.label), {
      target: { value: 'start-workflow' },
    });
    const select = (await view.findByLabelText(
      HOOKS_COPY.editor.workflow.label,
    )) as HTMLSelectElement;
    await waitFor(() =>
      expect(Array.from(select.options).map((option) => option.value)).toEqual(['', 'digest']),
    );
  });

  test('offers a way to make a workflow when none is ready', async () => {
    const { view } = open([], { path: '/hooks/new', workflows: [] });
    await fireEvent.change(await view.findByLabelText(HOOKS_COPY.editor.action.label), {
      target: { value: 'start-workflow' },
    });
    await view.findByRole('heading', { level: 3, name: HOOKS_COPY.editor.workflow.none });
    expect(
      view.getByRole('link', { name: HOOKS_COPY.editor.workflow.create }).getAttribute('href'),
    ).toBe('/workflows/new');
  });
});

describe('when the Bureau refuses', () => {
  const invalid = () =>
    new StubFault('InvalidParams', 400, 'The address is not acceptable.', {
      issues: [{ path: ['action', 'url'], message: 'refused', code: 'custom' }],
    });

  test('a new hook, the page says so beside what was typed and keeps the secret field’s value', async () => {
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
    await fireEvent.input(view.getByLabelText(HOOKS_COPY.editor.webhook.secretLabel), {
      target: { value: SIGNING_SECRET },
    });
    await fireEvent.click(view.getByRole('button', { name: HOOKS_COPY.editor.check.create }));

    const failure = await view.findByTestId('hook-failure');
    expect(failure.textContent).toContain(HOOKS_COPY.editor.saveFailed);
    expect(router.pathname).toBe('/hooks/new');
    expect(
      (view.getByLabelText(HOOKS_COPY.editor.webhook.secretLabel) as HTMLInputElement).value,
    ).toBe(SIGNING_SECRET);
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

  test('a test event that cannot be sent, the page says so', async () => {
    const { view } = open([hook('alpha')], {
      path: '/hooks/alpha',
      refuse: { 'bureau.hooks.test': new StubFault('Unprocessable', 422, 'No secret.') },
    });
    await fireEvent.click(await view.findByRole('button', { name: HOOKS_COPY.editor.check.test }));
    await view.findByText(new RegExp(HOOKS_COPY.editor.check.testFailed));
  });

  test('a delete, the page stays and says so', async () => {
    const { view } = open([hook('alpha')], {
      path: '/hooks/alpha',
      refuse: { 'bureau.hooks.delete': new StubFault('Forbidden', 403, 'Not yours.') },
    });
    await fireEvent.click(
      await view.findByRole('button', { name: HOOKS_COPY.editor.check.delete }),
    );
    await fireEvent.click(
      await view.findByRole('button', { name: HOOKS_COPY.editor.check.deleteConfirm }),
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
  test('a hook from a plugin keeps its action, and saves its name and events only', async () => {
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
      events: ['review.requested'],
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
    await fireEvent.input(view.getByLabelText(HOOKS_COPY.editor.webhook.secretLabel), {
      target: { value: SIGNING_SECRET },
    });
    await waitFor(() =>
      expect(
        (view.getByRole('button', { name: HOOKS_COPY.editor.check.create }) as HTMLButtonElement)
          .disabled,
      ).toBe(false),
    );

    await fireEvent.change(view.getByLabelText(HOOKS_COPY.editor.action.label), {
      target: { value: 'notify' },
    });

    const refused = await view.findByTestId('hook-refused-events');
    expect(refused.textContent).toContain(HOOKS_COPY.editor.event.notifyLoop);
    expect(
      (view.getByRole('button', { name: HOOKS_COPY.editor.check.create }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });
});
