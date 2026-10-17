/**
 * Test-only fixtures for the remediation suites (COR-487): a content-keyed memoizing
 * evaluator (so a proposal, its Apply-time recomputation and the report all reuse one
 * runtime evaluation of the same source), the shipped and failing envelopes, and a helper
 * that finds one finding in a report. COR-1571: the suites that use it keep every test body
 * under the 2 s fast-lane budget by warming the states their bodies reach at module scope.
 */

import { test as bunTest, describe, mock } from 'bun:test';

import { cinderThemeBase } from './theme-builder-base.ts';
import { ThemeBuilderController } from './theme-builder-controller.svelte.ts';
import type { ReportRecord } from './theme-check-types.ts';
import type { ThemeEvaluation, ThemeEvaluator } from './theme-draft-evaluation.ts';
import type { JsonValue, ThemeContextId, ThemeEnvelope } from './theme-draft-types.ts';
import { createEnvelope } from './theme-envelope.ts';
import { setNode } from './theme-override-tree.ts';
import { reportForEnvelope } from './theme-remediation-check.ts';
import { createRuntimeEvaluator } from './theme-runtime-evaluator.ts';
import { ThemeWorkbenchState } from './theme-workbench-state.svelte.ts';

const real = createRuntimeEvaluator();
const remembered = new Map<string, Promise<ThemeEvaluation>>();

/** The real runtime evaluator, remembered by the content of the editable state. */
export const memoEvaluator: ThemeEvaluator = {
  evaluate(source, revision, context: ThemeContextId) {
    const key = JSON.stringify([source.overrides, source.cssOverrides, context]);
    const known = remembered.get(key);
    if (known !== undefined) return known.then((value) => ({ ...value, revision }));
    const pending = real.evaluate(source, revision, context);
    remembered.set(key, pending);
    return pending;
  },
};

// Snapshot of the real exports, taken before the memo is installed: `mock.module` also rewrites
// the live bindings of an already imported namespace, so spreading the namespace inside the
// factory would recurse into the module being replaced.
const actualRemediation = { ...(await import('./theme-remediation.ts')) };

/**
 * Remember the foreground search by its whole input (COR-1571). `searchForeground` is the
 * deterministic, pure, 0.6 s core of every proposal, recomputation at Apply, and restore
 * regression check; the content-keyed evaluator already makes everything around it replay, so
 * without this each body repeats the same search for a source it has already searched. The
 * first call for an input still runs the real search, so a suite that warms its states at
 * module scope pays that once, outside any test budget. Returns a function that puts the real
 * module back, for the suite's `afterAll`: `mock.module` outlives a file, and
 * `theme-remediation.test.ts` asserts the search's determinism and must see the real one.
 */
export function rememberForegroundSearch(): () => void {
  const searched = new Map<string, ReturnType<typeof actualRemediation.searchForeground>>();
  void mock.module('./theme-remediation.ts', () => ({
    ...actualRemediation,
    searchForeground(input: Parameters<typeof actualRemediation.searchForeground>[0]) {
      const key = JSON.stringify(input);
      let known = searched.get(key);
      if (known === undefined) {
        known = actualRemediation.searchForeground(input);
        searched.set(key, known);
      }
      return known;
    },
  }));
  return () => {
    void mock.module('./theme-remediation.ts', () => actualRemediation);
  };
}

type Scenario = () => Promise<unknown>;

/** The registration functions `warmedTests` calls; a test of the helper itself passes fakes. */
export type ScenarioRegistrar = {
  describe(name: string, define: () => void): void;
  test(name: string, body: Scenario): void;
};

/**
 * Tests whose bodies run the token runtime, or the remediation search, on states no earlier test
 * visited (COR-1427, COR-1571): each is registered through `scenario` inside a `group`, and
 * `warmScenarios` runs every body once at module scope, outside Bun's 5 s per-test budget, so the
 * content-keyed evaluator and the foreground-search memo already hold every state the real run
 * visits and the body replays from memory. A failure while warming is left for the registered
 * test to report. `before` and `after` stand in for the file's per-test hooks.
 *
 * `group` stands in for `describe`: Bun 1.4.2 defers a `describe` callback until the file has
 * finished loading, so a `scenario` declared inside one is not known when `warmScenarios` runs at
 * module scope. `group` runs its callback immediately to collect the scenarios, then registers
 * them under a real `describe` of the same name. A `scenario` outside any `group` registers
 * directly. Groups do not nest.
 *
 * Two guards keep a warm-up from silently doing nothing: `warmScenarios` throws when it has no
 * body to warm, and `scenario` throws when it is declared after `warmScenarios` ran, which is
 * what a `scenario` inside a plain `describe` does. `group` also throws when called inside
 * another group, and when the `test` this returns (Bun's `test`, guarded) is used inside one.
 */
export function warmedTests(
  hooks: { before?: () => void; after?: () => void } = {},
  registrar: ScenarioRegistrar = { describe, test: bunTest },
) {
  const bodies: Scenario[] = [];
  let collecting: { name: string; body: Scenario }[] | null = null;
  let warmed = false;
  const refuseInsideGroup = (what: string): void => {
    if (collecting === null) return;
    throw new Error(
      `${what} was called inside group(), where it would register at file level, outside the group. Declare it with scenario().`,
    );
  };
  // Bun's own `test`, except that using it while a group is collecting throws. A file that
  // declares a group takes `test` from here so a stray plain test cannot slip out of the group.
  const guardedTest = new Proxy(bunTest, {
    apply(_target, _this, args: [string, Scenario]) {
      refuseInsideGroup('test()');
      return registrar.test(...args);
    },
    get(target, property, receiver) {
      const value: unknown = Reflect.get(target, property, receiver);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        refuseInsideGroup(`test.${String(property)}()`);
        return (value as (...rest: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  return {
    test: guardedTest,
    scenario(name: string, body: Scenario): void {
      if (warmed) {
        throw new Error(
          `The scenario "${name}" was declared after warmScenarios() ran, so it was never warmed. Declare it inside group(), not describe().`,
        );
      }
      if (collecting !== null) {
        collecting.push({ name, body });
        return;
      }
      bodies.push(body);
      registrar.test(name, body);
    },
    group(name: string, define: () => void): void {
      if (collecting !== null) {
        throw new Error(
          `group("${name}") was called inside another group(). Groups do not nest: the outer group's remaining scenarios would register at file level.`,
        );
      }
      const own: { name: string; body: Scenario }[] = [];
      collecting = own;
      try {
        define();
      } finally {
        collecting = null;
      }
      for (const { body } of own) bodies.push(body);
      registrar.describe(name, () => {
        for (const entry of own) registrar.test(entry.name, entry.body);
      });
    },
    async warmScenarios(): Promise<void> {
      if (bodies.length === 0) {
        throw new Error(
          'warmScenarios() found no scenarios to warm. Declare them with scenario() inside group(); a scenario inside describe() is not collected before module scope ends.',
        );
      }
      warmed = true;
      for (const body of bodies) {
        hooks.before?.();
        try {
          await body();
        } catch {
          // The registered test reports it.
        } finally {
          hooks.after?.();
        }
      }
    },
  };
}

export const shippedEnvelope = createEnvelope('shipped', 'Cinder default', cinderThemeBase());

export const oklchColor = (l: number, c: number, h: number, alpha?: number): JsonValue => ({
  $type: 'color',
  $value: {
    colorSpace: 'oklch',
    components: [l, c, h],
    ...(alpha === undefined ? {} : { alpha }),
  },
});

/** The shipped theme with one token overridden in one scope. */
export function withOverride(
  scope: 'shared' | 'light' | 'dark',
  path: string,
  node: JsonValue,
  base: ThemeEnvelope = shippedEnvelope,
): ThemeEnvelope {
  return {
    ...base,
    overrides: { ...base.overrides, [scope]: setNode(base.overrides[scope], path, node) },
  };
}

/** Light text so pale it fails the 4.5:1 text threshold on every light surface. */
export const dimmedText = withOverride('light', 'text.default', oklchColor(0.93, 0.01, 245));

export async function findFinding(
  envelope: ThemeEnvelope,
  predicate: (record: ReportRecord) => boolean,
): Promise<ReportRecord> {
  const { report } = await reportForEnvelope(memoEvaluator, envelope, 1);
  const all = [...report.records.wcag, ...report.records.advisory, ...report.records.cinderProfile];
  const found = all.find((record) => record.severity !== null && predicate(record));
  if (found === undefined) throw new Error('The fixture produced no matching finding.');
  return found;
}

export const textOnCanvas = (record: ReportRecord): boolean =>
  record.pairingId === 'text:default:canvas' && record.context === 'light/default';

/** A controller over the real runtime with the given envelope's state committed as revision 2. */
export async function openController(
  envelope: ThemeEnvelope = shippedEnvelope,
  evaluator: ThemeEvaluator = memoEvaluator,
): Promise<{ controller: ThemeBuilderController; workbench: ThemeWorkbenchState }> {
  const workbench = new ThemeWorkbenchState();
  const controller = new ThemeBuilderController({
    workbench,
    evaluator,
    persistence: null,
    newId: () => 'shipped',
    now: () => '2026-10-14T00:00:00.000Z',
  });
  await controller.start();
  if (envelope !== shippedEnvelope) {
    const outcome = await controller.commit({
      kind: 'edit',
      label: 'Set up the fixture',
      state: { overrides: envelope.overrides, cssOverrides: envelope.cssOverrides },
    });
    if (!outcome.ok) throw new Error(outcome.message);
  }
  return { controller, workbench };
}
