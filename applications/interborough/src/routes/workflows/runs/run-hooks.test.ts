/**
 * What the Run hooks section says (COR-2115, rows C3-02 to C3-10 and C3-22): which hooks it lists
 * and in what order for a live run and a settled one, the status of a hook that threw, each hook
 * point in words (every entry of the table, and the fallback), who registered a hook in words, and
 * line two. The words are the agreed design's tables, verbatim.
 */
import { describe, expect, test } from 'bun:test';

import { RUN_DETAIL_COPY } from '../../../app/copy/runs.ts';
import type { TaskFailedHook, TaskHook, TaskHooks } from '../../../lib/bureau-tasks.ts';
import {
  hookLineParts,
  hookLineString,
  hookPointString,
  hookPointText,
  hookSourceText,
  hookStatusWord,
  runHooksView,
} from './run-hooks.ts';

const hook = (id: string, overrides: Partial<TaskHook> = {}): TaskHook => ({
  id,
  hookPoint: 'onStep',
  source: 'acme-audit',
  priority: 100,
  replay: 'effectful',
  ...overrides,
});

const failure = (id: string, overrides: Partial<TaskFailedHook> = {}): TaskFailedHook => ({
  hookId: id,
  hookPoint: 'onStep',
  source: 'acme-audit',
  count: 1,
  lastFailedAt: '2026-11-02T16:42:00.000Z',
  ...overrides,
});

const live = (plan: TaskHook[] | null, failed: TaskFailedHook[] = []): TaskHooks => ({
  plan,
  failed,
});

describe('each hook point in words (C3-06)', () => {
  const table: ReadonlyArray<readonly [string, string]> = [
    ['prepareStep', 'Before each step'],
    ['onStep', 'After each step'],
    ['beforeToolExecution', 'Before a tool runs'],
    ['afterToolExecution', 'After a tool runs'],
    ['selectTools', 'When tools are chosen'],
    ['selectToolChoice', 'When the tool choice is made'],
    ['validateResponse', 'When a reply is checked'],
    ['validateToolResult', 'When a tool’s result is checked'],
    ['beforeGenerate', 'Before the model is asked'],
    ['afterGenerate', 'After the model answers'],
    ['onLLMInput', 'Watching what the model is sent'],
    ['onLLMOutput', 'Watching what the model sends back'],
    ['beforeCompaction', 'Before the conversation is shortened'],
    ['beforeBackgroundCompaction', 'Before a background shortening'],
    ['afterCompaction', 'After the conversation is shortened'],
    ['onRunStart', 'When the run starts'],
    ['onRunComplete', 'When the run finishes'],
    ['onRunError', 'When the run fails'],
    ['onRunAbort', 'When the run is stopped'],
    ['onError', 'When a step fails'],
  ];

  test.each(table)('%s reads "%s"', (point, words) => {
    expect(hookPointText(point)).toEqual({ words });
    expect(hookPointString(point)).toBe(words);
  });

  test('has words for exactly the twenty hook points, each once', () => {
    expect(Object.keys(RUN_DETAIL_COPY.hooks.points).toSorted()).toEqual(
      table.map(([point]) => point).toSorted(),
    );
    expect(new Set(Object.values(RUN_DETAIL_COPY.hooks.points)).size).toBe(20);
  });

  test('shows a point the table does not know as its name in code, never as words', () => {
    expect(hookPointText('beforeTeleport')).toEqual({ code: 'beforeTeleport' });
    expect(hookPointText('constructor')).toEqual({ code: 'constructor' });
    expect(hookPointText('toString')).toEqual({ code: 'toString' });
    expect(hookPointString('beforeTeleport')).toBe('beforeTeleport');
  });

  test('says no camel-case name as words', () => {
    for (const words of Object.values(RUN_DETAIL_COPY.hooks.points)) {
      expect(words).not.toMatch(/[a-z][A-Z]/);
    }
  });
});

describe('who registered a hook (C3-08)', () => {
  const plugins: Record<string, string> = { 'acme-audit': 'Acme audit' };
  const context = {
    agentLabel: 'Tool runner' as string | undefined,
    pluginTitle: (plugin: string) => plugins[plugin],
  };

  test('reads Interborough for the Bureau’s, This run for a direct one, and the agent by its name', () => {
    expect(hookSourceText('bureau', context)).toEqual({ words: 'Interborough' });
    expect(hookSourceText('direct', context)).toEqual({ words: 'This run' });
    expect(hookSourceText('agent', context)).toEqual({ words: 'Tool runner' });
  });

  test('reads a plugin by its title when the catalog has one, and otherwise as its raw source in code', () => {
    expect(hookSourceText('acme-audit', context)).toEqual({ words: 'Acme audit' });
    expect(hookSourceText('stranger-plugin', context)).toEqual({ code: 'stranger-plugin' });
    expect(hookSourceText('agent', { ...context, agentLabel: undefined })).toEqual({
      code: 'agent',
    });
  });

  test('reads nothing for a hook that names no one', () => {
    expect(hookSourceText(null, context)).toBeUndefined();
  });

  test('never says Bureau, tier, effectful or safe as words', () => {
    const everyWord = [
      ...Object.values(RUN_DETAIL_COPY.hooks.sources),
      ...Object.values(RUN_DETAIL_COPY.hooks.replay),
    ].join(' ');
    for (const forbidden of [/\bBureau\b/, /\btier\b/, /\beffectful\b/, /\bsafe\b/]) {
      expect(everyWord).not.toMatch(forbidden);
    }
  });
});

describe('line two of a row (C3-07)', () => {
  const context = {
    agentLabel: 'Tool runner' as string | undefined,
    pluginTitle: (plugin: string) => (plugin === 'acme-audit' ? 'Acme audit' : undefined),
  };

  test('reads the source in words, the hook id in code, then the priority and the replay words', () => {
    const parts = hookLineParts(
      { id: 'acme-audit:redact-secrets', source: 'acme-audit', priority: 100, replay: 'effectful' },
      context,
    );
    expect(parts).toEqual([
      { words: 'Acme audit' },
      { code: 'acme-audit:redact-secrets' },
      { words: 'priority 100' },
      { words: 'has side effects' },
    ]);
    expect(hookLineString(parts)).toBe(
      'Acme audit, acme-audit:redact-secrets, priority 100, has side effects',
    );
  });

  test('reads "no side effects" for a safe hook, and a Bureau hook as Interborough', () => {
    expect(
      hookLineString(
        hookLineParts(
          { id: 'onRunStart#1', source: 'bureau', priority: 1000, replay: 'safe' },
          context,
        ),
      ),
    ).toBe('Interborough, onRunStart#1, priority 1000, no side effects');
  });

  test('leaves out the priority and the replay of a hook known only from its failure, and a source it has none of', () => {
    expect(
      hookLineString(
        hookLineParts(
          { id: 'acme-audit:redact', source: null, priority: undefined, replay: undefined },
          context,
        ),
      ),
    ).toBe('acme-audit:redact');
  });
});

describe('a live run (C3-02, C3-05, C3-09)', () => {
  test('lists the failed hooks first, latest failure first, then every other hook in the plan’s order, each once', () => {
    const view = runHooksView(
      live(
        [hook('a'), hook('b'), hook('c', { hookPoint: 'prepareStep' }), hook('d')],
        [
          failure('c', { lastFailedAt: '2026-11-02T10:00:00.000Z' }),
          failure('d', { lastFailedAt: '2026-11-02T11:00:00.000Z' }),
        ],
      ),
      false,
    );

    expect(view.kind).toBe('rows');
    expect(view.description).toBe('In the order they run, failed hooks first.');
    expect(view.rows.map((row) => row.id)).toEqual(['d', 'c', 'a', 'b']);
    expect(new Set(view.rows.map((row) => row.key)).size).toBe(4);
    // A failed hook keeps what the plan says of it, so its line two is whole.
    const failedRow = view.rows.find((row) => row.id === 'c');
    expect(failedRow).toMatchObject({
      priority: 100,
      replay: 'effectful',
      hookPoint: 'prepareStep',
    });
  });

  test('says "Failed" for a hook that threw once, "Failed, N times" for more, and nothing for one that did not', () => {
    const view = runHooksView(
      live([hook('a'), hook('b'), hook('c')], [failure('a'), failure('b', { count: 3 })]),
      false,
    );

    expect(view.rows.map((row) => hookStatusWord(row))).toEqual([
      'Failed',
      'Failed, 3 times',
      undefined,
    ]);
    expect(RUN_DETAIL_COPY.hooks.failed(2)).toBe('Failed, 2 times');
    expect(RUN_DETAIL_COPY.hooks.failed(1)).toBe('Failed');
  });

  test('carries the time of the latest failure on a failed row and none on any other', () => {
    const view = runHooksView(live([hook('a'), hook('b')], [failure('a')]), false);

    expect(view.rows[0]?.failure?.lastFailedAt).toBe(Date.parse('2026-11-02T16:42:00.000Z'));
    expect(view.rows[1]?.failure).toBeUndefined();
  });

  test('lists a hook that threw but is not in the plan, from its failure alone', () => {
    const view = runHooksView(live([hook('a')], [failure('gone', { source: 'agent' })]), false);

    expect(view.rows.map((row) => row.id)).toEqual(['gone', 'a']);
    expect(view.rows[0]).toMatchObject({ source: 'agent', priority: undefined, replay: undefined });
  });

  test('lists a hook the plan names twice once', () => {
    const view = runHooksView(live([hook('a'), hook('a'), hook('b')]), false);

    expect(view.rows.map((row) => row.id)).toEqual(['a', 'b']);
  });

  test('draws no section for a plan with no entries and nothing that threw (C3-04)', () => {
    expect(runHooksView(live([]), false).kind).toBe('none');
  });

  test('draws the section for a plan with no entries when a hook threw', () => {
    const view = runHooksView(live([], [failure('a')]), false);
    expect(view.kind).toBe('rows');
    expect(view.rows.map((row) => row.id)).toEqual(['a']);
  });

  test('says the plan cannot be read, and lists the failed hooks and nothing else (C3-14)', () => {
    const none = runHooksView(live(null), false);
    expect(none.kind).toBe('rows');
    expect(none.description).toBe('This run’s hook plan can’t be read.');
    expect(none.rows).toEqual([]);

    const some = runHooksView(live(null, [failure('a'), failure('b', { count: 2 })]), false);
    expect(some.description).toBe('This run’s hook plan can’t be read.');
    expect(some.rows.map((row) => row.id)).toEqual(['a', 'b']);
  });
});

describe('a settled run (C3-03, C3-04, C3-11)', () => {
  test('lists only the hooks that threw, and says the full plan is shown while a run is live', () => {
    const view = runHooksView(
      live(null, [failure('a'), failure('b', { lastFailedAt: '2026-11-02T17:00:00.000Z' })]),
      true,
    );

    expect(view.kind).toBe('rows');
    expect(view.description).toBe('The full hook plan is shown while a run is live.');
    expect(view.rows.map((row) => row.id)).toEqual(['b', 'a']);
  });

  test('draws no section when no hook threw, with or without a plan', () => {
    expect(runHooksView(live(null), true).kind).toBe('none');
    expect(runHooksView(live([hook('a')]), true).kind).toBe('none');
  });

  test('drops the clean rows of a plan that is still on hand when the run settles, and keeps the failed ones', () => {
    const hooks = live([hook('a'), hook('b'), hook('c')], [failure('b')]);

    expect(runHooksView(hooks, false).rows.map((row) => row.id)).toEqual(['b', 'a', 'c']);
    const settled = runHooksView(hooks, true);
    expect(settled.rows.map((row) => row.id)).toEqual(['b']);
    expect(settled.description).toBe('The full hook plan is shown while a run is live.');
  });
});

describe('the section’s words', () => {
  test('is "Run hooks", and no heading, row or message offers a retry of a hook or a reason (C3-10, C3-22)', () => {
    const { heading, loadFailed, forbidden } = RUN_DETAIL_COPY.hooks;
    expect(heading).toBe('Run hooks');
    expect(loadFailed).toEqual({
      title: 'Couldn’t load this run’s hooks.',
      description: 'The rest of the run is shown.',
    });
    expect(forbidden.title).toBe('Your sign-in can’t see this run’s hooks');
    const everyWord = JSON.stringify(RUN_DETAIL_COPY.hooks);
    for (const forbiddenWord of ['Retry now', 'Retry delivery', 'Retry', 'Reload']) {
      expect(everyWord).not.toContain(forbiddenWord);
    }
  });
});
