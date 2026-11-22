/**
 * Tests the import graph cannot reach, and the changes that must still select them.
 *
 * A test that reads workspace files by a path it computes at run time (`join(COMPONENTS, name,
 * `${name}.types.ts`)` for every `name` in a list) has no import edge and no path literal to any
 * file it reads, so `affected-tests-selection.ts` cannot connect a change to it. COR-2645: #1214
 * added two `DataList` props without recording them in Cinder's frozen API contract, and its
 * pull-request checks passed because `api-contract.test.ts` was never selected.
 *
 * Each rule names the changed paths that arm it and the tests it then selects. Both planners read
 * this list: `selectTests` (`scripts/affected-tests.ts`, the pull-request lane) and
 * `computeEvidencePlan` (`scripts/chef/verification-plan.ts`, targeted runs). A rule only ever adds
 * tests; it never removes one from a lane.
 *
 * The list was found by tracing the files every candidate test reads and keeping those whose reads
 * no import edge or path literal reaches and a changed file does not select (COR-2645). A test that
 * reads a new family of files by a computed path belongs here too.
 */

export interface ComputedPathRule {
  /** A changed path under any of these prefixes arms the rule. */
  changed: readonly string[];
  /** The workspace directory that holds the tests, `''` for the repository root. */
  workspace: string;
  /** The tests the rule selects: exact repository-relative paths, or patterns over them. */
  tests: readonly (string | RegExp)[];
  /** What the tests read that no import reaches. */
  reads: string;
}

const CINDER = 'components/cinder/';
const CHAT = 'components/chat/';
const EDITOR = 'components/editor/';
const TERMINAL = 'components/terminal/';
const PLAYGROUND = 'applications/playground/';

export const computedPathRules: readonly ComputedPathRule[] = [
  {
    changed: [CINDER],
    workspace: 'components/cinder',
    tests: [/^components\/cinder\/src\/[^/]+\.test\.ts$/],
    reads: 'Cinder component files by a path it computes',
  },
  {
    changed: [`${CINDER}src/`],
    workspace: 'components/cinder',
    tests: [
      'components/cinder/src/styles/component-variables-contract.test.ts',
      'components/cinder/src/styles/source-style-imports.test.ts',
      'components/cinder/src/styles/check-token-contrast-border-indicators.test.ts',
      'components/cinder/src/styles/components/row-item.test.ts',
      'components/cinder/src/styles/components/label-value.test.ts',
      'components/cinder/src/components/banner/banner-warning-tint.test.ts',
    ],
    reads: 'Cinder component sources and stylesheets by a path it computes',
  },
  {
    changed: ['applications/interborough/src/'],
    workspace: 'components/cinder',
    tests: ['components/cinder/src/styles/check-token-contrast-border-indicators.test.ts'],
    reads: 'Interborough component sources by a path it computes',
  },
  {
    changed: [CINDER, CHAT, EDITOR],
    workspace: 'components/cinder',
    tests: ['components/cinder/src/styles/border-tier-corpus-audit.test.ts'],
    reads: 'every component library source file by a path it computes',
  },
  {
    changed: [CINDER, CHAT, EDITOR],
    workspace: 'internal/component-tooling',
    tests: ['internal/component-tooling/src/styles/border-tier-classification.test.ts'],
    reads: 'every component library source file by a path it computes',
  },
  {
    changed: [`${CINDER}src/`, `${CHAT}src/`, `${EDITOR}src/`, `${TERMINAL}src/`],
    workspace: 'applications/playground',
    tests: [
      'applications/playground/src/component-page-overview-stage.test.ts',
      'applications/playground/src/shell-app/compound-parts.test.ts',
      'applications/playground/src/declared-examples.test.ts',
      'applications/playground/src/examples/image/basic.example.test.ts',
    ],
    reads: 'component library sources and example manifests by a path it computes',
  },
  {
    changed: [`${PLAYGROUND}src/`],
    workspace: 'applications/playground',
    tests: [
      'applications/playground/src/component-page-overview-stage.test.ts',
      'applications/playground/src/declared-examples.test.ts',
    ],
    reads: 'the playground examples by a path it computes',
  },
  {
    changed: [`${CINDER}src/styles/`],
    workspace: 'components/editor',
    tests: ['components/editor/src/lib/components/markdown-editor/editor-skeleton.sr-only.test.ts'],
    reads: 'a Cinder stylesheet by a path it computes',
  },
  {
    changed: [`${CHAT}src/`],
    workspace: 'components/chat',
    tests: ['components/chat/src/lib/package-style-contracts.test.ts'],
    reads: 'Chat component sources by a path it computes',
  },
  {
    changed: ['packages/bureau/src/'],
    workspace: 'packages/bureau',
    tests: [
      'packages/bureau/src/sources/bundle-boundary.test.ts',
      'packages/bureau/src/settings/setting-owners.test.ts',
      'packages/bureau/src/bureau-seams/construction-window.test.ts',
    ],
    reads: 'Bureau sources by a path it computes',
  },
  {
    changed: ['packages/memory/src/'],
    workspace: 'packages/memory',
    tests: ['packages/memory/test/create-in-memory-evidence-projection-storage.test.ts'],
    reads: 'Memory sources by a path it computes',
  },
  {
    changed: [`${CHAT}browser/`, `${EDITOR}browser/`, `${TERMINAL}browser/`],
    workspace: '',
    tests: ['scripts/check-playwright-collection.test.ts'],
    reads: 'the component libraries browser harnesses by a path it computes',
  },
];

export interface ComputedPathSelection {
  /** The repository-relative test path. */
  path: string;
  /** The workspace directory that holds it. */
  workspace: string;
  /** Why the import graph does not reach it, for `--explain`. */
  reason: string;
}

const matches = (test: string | RegExp, path: string): boolean =>
  typeof test === 'string' ? test === path : test.test(path);

/** The tests a change selects by rule, from the paths that exist. Pure. */
export function computedPathTests(
  changed: readonly string[],
  paths: Iterable<string>,
): ComputedPathSelection[] {
  const armed = computedPathRules.filter((rule) =>
    changed.some((path) => rule.changed.some((prefix) => path.startsWith(prefix))),
  );
  if (armed.length === 0) return [];
  const found = new Map<string, ComputedPathSelection>();
  for (const path of paths) {
    for (const rule of armed) {
      if (found.has(path) || !rule.tests.some((test) => matches(test, path))) continue;
      found.set(path, { path, workspace: rule.workspace, reason: `${path} reads ${rule.reads}` });
    }
  }
  return [...found.values()].toSorted((a, b) => a.path.localeCompare(b.path));
}
