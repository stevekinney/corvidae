/**
 * The Run hooks section of `/runs/:run` as a person reads it (COR-2115, rows C3-01 to C3-23): after
 * What happened and before How it ran, a live run's plan with the hooks that threw first, a settled
 * run's failed hooks alone with the line that says so, no section for a run with nothing to say, and
 * each state it can be in (loading, failed, refused). Through the route outlet, over a Bureau that
 * answers `bureau.tasks.inspect` from a table. Reattaching a run after a restart is the Bureau's and
 * is tested there (`tasks-inspect-hooks-recovery.test.ts`): this page reads the same answer.
 */
import { quietFor } from '@lostgradient/testing/wait-until';
import { HttpClient } from '@lostgradient/weft';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { RUN_DETAIL_COPY } from '../../../app/copy/runs.ts';
import { RETRY_LABEL } from '../../../app/copy/views.ts';
import RouteOutletHarness from '../../../app/shell/route-outlet.test-harness.svelte';
import { taskFixture } from '../../../lib/bureau-fixtures.test-support.ts';
import { StubFault } from '../../../lib/bureau-stub.test-support.ts';
import type { TaskHooks, TaskView } from '../../../lib/bureau-tasks.ts';
import {
  emptyBureauWorld,
  installBureauWorld,
  type BureauWorldStub,
} from '../../../lib/bureau-world.test-support.ts';
import { AUTHORIZATION_SCOPES } from '../../../lib/scopes.svelte.ts';
import { landAt } from '../../chat/pages.test-support.ts';
import RunHooksHarness from './run-hooks.test-harness.svelte';

const copy = RUN_DETAIL_COPY.hooks;

let stub: BureauWorldStub | undefined;
beforeEach(() => {
  sessionStorage.clear();
});
afterEach(() => {
  cleanup();
  stub?.restore();
  stub = undefined;
  sessionStorage.clear();
});

const LIVE: TaskView = taskFixture({ id: 'run-1', agentName: 'tool-runner', status: 'working' });
const SETTLED: TaskView = taskFixture({
  id: 'run-1',
  agentName: 'tool-runner',
  status: 'completed',
  finishReason: 'stop',
});

const plan: TaskHooks['plan'] = [
  { id: 'onRunStart#1', hookPoint: 'onRunStart', source: 'bureau', priority: 1000, replay: 'safe' },
  {
    id: 'acme-audit:redact-secrets',
    hookPoint: 'beforeToolExecution',
    source: 'acme-audit',
    priority: 100,
    replay: 'effectful',
  },
  { id: 'agent:trim', hookPoint: 'onStep', source: 'agent', priority: 5, replay: 'safe' },
];

const failures: TaskHooks['failed'] = [
  {
    hookId: 'acme-audit:redact-secrets',
    hookPoint: 'beforeToolExecution',
    source: 'acme-audit',
    count: 3,
    lastFailedAt: '2026-10-19T08:42:00.000Z',
  },
];

function open(
  task: TaskView,
  answer: (() => TaskHooks | Promise<TaskHooks>) | 'forbidden' | 'error',
) {
  stub = installBureauWorld(emptyBureauWorld({ tasks: [task] }));
  stub.on('bureau.goals.list', () => ({ goals: [], nextOffset: null }));
  stub.on('bureau.contexts.list', () => ({ contexts: [], nextOffset: null }));
  stub.on('bureau.agents.list', () => ({
    agents: [{ name: 'tool-runner', displayName: 'Tool runner' }],
  }));
  stub.on('bureau.tasks.inspect', async () => {
    if (answer === 'forbidden') throw new StubFault('Forbidden', 403, 'Forbidden');
    if (answer === 'error') throw new StubFault('EngineFailure', 500, 'The Bureau broke.');
    return { steps: [], hooks: await answer() };
  });
  landAt('/runs/run-1');
  return render(RouteOutletHarness, {
    props: {
      client: new HttpClient({ baseUrl: 'http://localhost/api' }),
      scopes: AUTHORIZATION_SCOPES,
    },
  } as never);
}

const section = (container: HTMLElement) =>
  container.querySelector<HTMLElement>('[data-section="run-hooks"]');
const hookIds = (container: HTMLElement) =>
  [...container.querySelectorAll('[data-hook]')].map((row) => row.getAttribute('data-hook'));

describe('where the section is', () => {
  test('is a level-two section after What happened and before How it ran, and nothing else mentions hooks (C3-01)', async () => {
    const view = open(LIVE, () => ({ plan, failed: failures }));
    await waitFor(() => expect(section(view.container)).not.toBeNull());

    const order = [
      ...view.container.querySelectorAll(
        '[data-section="what-happened"], [data-section="run-hooks"], [data-section="how-it-ran"]',
      ),
    ].map((element) => element.getAttribute('data-section'));
    expect(order).toEqual(['what-happened', 'run-hooks', 'how-it-ran']);
    const heading = section(view.container)?.querySelector('h2');
    expect(heading?.textContent?.trim()).toBe('Run hooks');
    // The header's status line, What happened and the Details rail never say a hook.
    const outside = [
      view.container.querySelector('[data-run-header]'),
      view.container.querySelector('[data-section="what-happened"]'),
      view.container.querySelector('.ib-run-details, [data-section="details"]'),
    ];
    for (const region of outside) expect(region?.textContent ?? '').not.toMatch(/hook/i);
  });
});

describe('a live run (C3-02, C3-05, C3-06, C3-07, C3-08, C3-09, C3-10, C3-22)', () => {
  test('lists the plan with the failed hook first, in words, with its status and its time', async () => {
    const view = open(LIVE, () => ({ plan, failed: failures }));
    await waitFor(() => expect(hookIds(view.container)).toHaveLength(3));

    const body = section(view.container)!;
    expect(body.textContent).toContain(copy.descriptionLive);
    expect(hookIds(view.container)).toEqual([
      'acme-audit:redact-secrets',
      'onRunStart#1',
      'agent:trim',
    ]);
    const first = body.querySelector('[data-hook="acme-audit:redact-secrets"]')!;
    expect(first.getAttribute('data-failed')).toBe('');
    expect(first.querySelector('.cinder-status-dot')?.textContent).toContain('Failed, 3 times');
    expect(first.querySelector('.cinder-stacked-list-item__title')?.textContent?.trim()).toBe(
      'Before a tool runs',
    );
    expect(first.querySelector('time')?.getAttribute('datetime')).toBe('2026-10-19T08:42:00.000Z');
    expect(first.querySelector('.cinder-stacked-list-item__meta')?.textContent?.trim()).toBe(
      'acme-audit, acme-audit:redact-secrets, priority 100, has side effects',
    );
    // The hook id is the identifier, in code.
    // (The plugin catalog does not name `acme-audit` here, so its raw source is in code too.)
    expect(
      [...first.querySelectorAll('code[data-cinder-variant="code"]')].map(
        (code) => code.textContent,
      ),
    ).toEqual(['acme-audit', 'acme-audit:redact-secrets']);
    // A hook that did not throw has no status and no time.
    const clean = body.querySelector('[data-hook="onRunStart#1"]')!;
    expect(clean.querySelector('.cinder-status-dot')).toBeNull();
    expect(clean.querySelector('time')).toBeNull();
    expect(clean.querySelector('.cinder-stacked-list-item__meta')?.textContent?.trim()).toBe(
      'Interborough, onRunStart#1, priority 1000, no side effects',
    );
    expect(
      body.querySelector('[data-hook="agent:trim"] .cinder-stacked-list-item__meta')?.textContent,
    ).toContain('Tool runner');
  });

  test('has no link, button, retry or reason on a row (C3-10)', async () => {
    const view = open(LIVE, () => ({ plan, failed: failures }));
    await waitFor(() => expect(hookIds(view.container)).toHaveLength(3));

    for (const row of section(view.container)!.querySelectorAll('[data-hook]')) {
      expect(row.querySelectorAll('button')).toHaveLength(0);
      expect(row.querySelectorAll('a[href]')).toHaveLength(0);
    }
    expect(section(view.container)!.textContent).not.toMatch(/retry|reload|because|reason/i);
  });

  test('carries no count, badge or summary beside the heading (C3-22)', async () => {
    const view = open(LIVE, () => ({ plan, failed: failures }));
    await waitFor(() => expect(hookIds(view.container)).toHaveLength(3));

    const heading = section(view.container)!.querySelector('h2')!;
    expect(heading.textContent?.trim()).toBe('Run hooks');
    expect(heading.parentElement?.querySelector('.cinder-badge')).toBeNull();
    expect(section(view.container)!.textContent).not.toMatch(/\d+ failed/);
  });

  test('says an unknown hook point as its name in code, and the raw source of a plugin the catalog does not know', async () => {
    const view = open(LIVE, () => ({
      plan: [
        { id: 'x:y', hookPoint: 'beforeTeleport', source: 'stranger', priority: 1, replay: 'safe' },
      ],
      failed: [],
    }));
    await waitFor(() => expect(hookIds(view.container)).toEqual(['x:y']));

    const row = section(view.container)!.querySelector('[data-hook="x:y"]')!;
    expect(row.querySelector('.cinder-stacked-list-item__title code')?.textContent).toBe(
      'beforeTeleport',
    );
    expect(
      [...row.querySelectorAll('.cinder-stacked-list-item__meta code')].map(
        (code) => code.textContent,
      ),
    ).toEqual(['stranger', 'x:y']);
  });

  test('draws no section for a plan with no hooks (C3-04)', async () => {
    const view = open(LIVE, () => ({ plan: [], failed: [] }));
    await view.findByRole('heading', { level: 1 });
    await waitFor(() =>
      expect(view.container.querySelector('[data-section="what-happened"]')).not.toBeNull(),
    );
    // Give the read time to arrive; there is still no section.
    await quietFor(50);
    expect(section(view.container)).toBeNull();
  });

  test('says the plan cannot be read, and lists the failed hooks and no placeholder rows (C3-14)', async () => {
    const view = open(LIVE, () => ({ plan: null, failed: failures }));
    await waitFor(() =>
      expect(section(view.container)?.textContent).toContain(copy.descriptionUnreadable),
    );

    expect(hookIds(view.container)).toEqual(['acme-audit:redact-secrets']);
    expect(view.container.querySelector('[data-section="run-hooks"] .cinder-skeleton')).toBeNull();
  });
});

describe('a settled run (C3-03, C3-04)', () => {
  test('lists only the hooks that threw, under the line that says the full plan is shown while a run is live', async () => {
    const view = open(SETTLED, () => ({ plan: null, failed: failures }));
    await waitFor(() => expect(hookIds(view.container)).toEqual(['acme-audit:redact-secrets']));

    expect(section(view.container)!.textContent).toContain(
      'The full hook plan is shown while a run is live.',
    );
    expect(section(view.container)!.textContent).not.toContain(copy.descriptionLive);
  });

  test('draws no section, no heading and no empty state, when no hook threw', async () => {
    const view = open(SETTLED, () => ({ plan: null, failed: [] }));
    await waitFor(() =>
      expect(view.container.querySelector('[data-section="what-happened"]')).not.toBeNull(),
    );
    await quietFor(50);

    expect(section(view.container)).toBeNull();
    expect(view.container.textContent).not.toContain('Run hooks');
  });

  test('draws nothing while a settled run’s failed hooks load, so the page does not grow and then shrink (C3-15)', async () => {
    const held = Promise.withResolvers<TaskHooks>();
    const view = open(SETTLED, () => held.promise);
    await waitFor(() =>
      expect(view.container.querySelector('[data-section="what-happened"]')).not.toBeNull(),
    );
    await quietFor(400);

    expect(section(view.container)).toBeNull();
    held.resolve({ plan: null, failed: [] });
  });
});

describe('the states (C3-15, C3-16, C3-17)', () => {
  test('a live run shows its heading and placeholders named for what loads, while the hooks load', async () => {
    const held = Promise.withResolvers<TaskHooks>();
    const view = open(LIVE, () => held.promise);

    await waitFor(() => expect(section(view.container)).not.toBeNull());
    await waitFor(() =>
      expect(
        [...section(view.container)!.querySelectorAll('[role="status"]')].map((status) =>
          status.textContent?.trim(),
        ),
      ).toContain(copy.loading),
    );
    held.resolve({ plan: [], failed: [] });
  });

  test('a read that failed is one row-form error with a secondary Try again, and the rest of the page is shown', async () => {
    const view = open(LIVE, 'error');

    const title = await view.findByText(copy.loadFailed.title);
    expect(title).not.toBeNull();
    expect(view.getByText(copy.loadFailed.description)).not.toBeNull();
    const retry = section(view.container)!.querySelector('button')!;
    expect(retry.textContent?.trim()).toBe(RETRY_LABEL);
    expect(retry.getAttribute('data-cinder-variant')).toBe('secondary');
    // The rest of the page is unchanged.
    expect(view.container.querySelector('[data-section="what-happened"]')).not.toBeNull();
  });

  test('Try again reads the hooks again', async () => {
    let failing = true;
    const view = open(LIVE, () => {
      if (failing) throw new StubFault('EngineFailure', 500, 'The Bureau broke.');
      return { plan, failed: failures };
    });
    await view.findByText(copy.loadFailed.title);
    failing = false;

    await fireEvent.click(section(view.container)!.querySelector('button')!);

    await waitFor(() => expect(hookIds(view.container)).toHaveLength(3));
  });

  test('a read that was refused is an inline access gate, with the scope in code and only See your scopes', async () => {
    const view = open(LIVE, 'forbidden');

    await view.findByText(copy.forbidden.title);
    const body = section(view.container)!;
    expect(body.textContent).toContain(`requires ${copy.forbidden.requirement}`);
    const actions = [...body.querySelectorAll('a, button')];
    expect(actions.map((action) => action.textContent?.trim())).toEqual(['See your scopes']);
    expect(actions[0]?.getAttribute('data-cinder-variant')).toBe('secondary');
    expect(hookIds(view.container)).toEqual([]);
  });
});

describe('a run watched while it goes on (C3-11, C3-12)', () => {
  function watch(task: TaskView, answer: () => TaskHooks) {
    stub = installBureauWorld(emptyBureauWorld({ tasks: [task] }));
    stub.on('bureau.agents.list', () => ({ agents: [] }));
    stub.on('bureau.tasks.inspect', () => ({ steps: [], hooks: answer() }));
    return render(RunHooksHarness, { props: { task, over: false, events: 0 } } as never);
  }

  test('a run that settles drops the rows of the hooks that did not throw, and says the full plan is shown while a run is live', async () => {
    const view = watch(LIVE, () => ({ plan, failed: failures }));
    await waitFor(() => expect(hookIds(view.container)).toHaveLength(3));

    await view.rerender({ task: SETTLED, over: true, events: 1 });

    await waitFor(() => expect(hookIds(view.container)).toEqual(['acme-audit:redact-secrets']));
    expect(section(view.container)!.textContent).toContain(copy.descriptionSettled);
    expect(section(view.container)!.textContent).not.toContain(copy.descriptionLive);
  });

  test('a run that settles with no hook thrown loses its section, and keeps nothing of it on the page', async () => {
    const view = watch(LIVE, () => ({ plan, failed: [] }));
    await waitFor(() => expect(hookIds(view.container)).toHaveLength(3));

    await view.rerender({ task: SETTLED, over: true, events: 1 });

    await waitFor(() => expect(section(view.container)?.outerHTML ?? null).toBeNull());
  });

  test('a read that fails after the hooks were read keeps the rows that were read, and shows no error (C3-23)', async () => {
    let answering = true;
    const view = watch(LIVE, () => {
      if (!answering) throw new StubFault('EngineFailure', 500, 'The Bureau broke.');
      return { plan, failed: failures };
    });
    await waitFor(() => expect(hookIds(view.container)).toHaveLength(3));

    answering = false;
    await view.rerender({ events: 1 });
    // The second read is made after a short wait; the error it ends in has its turns to arrive.
    await waitFor(() => expect(stub!.callsTo('bureau.tasks.inspect')).toHaveLength(2));
    await quietFor(50);

    expect(hookIds(view.container)).toHaveLength(3);
    expect(view.queryByText(copy.loadFailed.title)).toBeNull();
  });

  test('a hook that throws while the run is watched moves to the top, with its status, without a reload', async () => {
    let thrown = false;
    const view = watch(LIVE, () => ({
      plan,
      failed: thrown ? failures : [],
    }));
    await waitFor(() => expect(hookIds(view.container)).toEqual(plan.map((entry) => entry.id)));
    expect(section(view.container)!.querySelector('.cinder-status-dot')).toBeNull();

    thrown = true;
    // The run's stream reported something: the hooks are read again, once, after a short wait.
    await view.rerender({ events: 1 });

    await waitFor(() => expect(hookIds(view.container)[0]).toBe('acme-audit:redact-secrets'));
    expect(
      section(view.container)!
        .querySelector('[data-hook="acme-audit:redact-secrets"]')
        ?.getAttribute('data-failed'),
    ).toBe('');
  });
});
