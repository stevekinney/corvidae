/**
 * The worker-binding inheritance rules the console states (COR-164), each tied
 * to the Weft source or test that proves it. A surface may only say what one of
 * these entries says; `worker-inheritance-rules.test.ts` pins each `source`
 * path to a file that exists, so a moved or renamed rule fails here instead of
 * leaving the console asserting a rule nothing backs.
 *
 * The statements restate behavior; they do not implement it. Weft decides every
 * binding.
 *
 * @module
 */
export type WorkerInheritanceSurface =
  'start' | 'schedule' | 'child' | 'fork' | 'restart' | 'activity';

/**
 * One statement of how a worker binding is inherited on a surface, with the Weft files that prove
 * it.
 */
export interface WorkerInheritanceRule {
  readonly surface: WorkerInheritanceSurface;
  readonly heading: string;
  readonly text: string;
  /** Repository-relative paths of the Weft files that prove the rule. */
  readonly sources: readonly string[];
}

/** The worker-binding inheritance rule of each surface that starts a workflow. */
export const WORKER_INHERITANCE_RULES: Readonly<
  Record<WorkerInheritanceSurface, WorkerInheritanceRule>
> = {
  start: {
    surface: 'start',
    heading: 'Worker version at start',
    text: 'A workflow that declares a worker versioning policy is pinned to a worker version when it starts: Weft picks the routed deployment build that carries the run’s revision and records it. A workflow that declares no policy gets no worker version.',
    sources: ['packages/weft/src/core/engine/lifecycle/start-state.ts'],
  },
  schedule: {
    surface: 'schedule',
    heading: 'Worker version for scheduled runs',
    text: 'A scheduled occurrence is an ordinary workflow start. It follows the workflow’s own worker versioning policy and is handled like any other start; a schedule carries no worker-versioning rule of its own.',
    sources: ['packages/weft/src/core/engine/lifecycle/start-state.ts'],
  },
  child: {
    surface: 'child',
    heading: 'Worker version for child workflows',
    text: 'A child workflow started from inside its parent inherits the parent’s worker version when the child has the same workflow type and the same revision. Otherwise it takes its worker version from routing like any other start.',
    sources: [
      'packages/weft/src/core/engine/lifecycle/start-state.ts',
      'packages/weft/src/core/engine/worker-versioning-child-inheritance.test.ts',
    ],
  },
  fork: {
    surface: 'fork',
    heading: 'Worker version for a fork',
    text: 'A fork inherits the source run’s worker policy, worker version, and worker version history unless it names an explicit revision that differs from the pinned revision; in that case it inherits nothing.',
    sources: [
      'packages/weft/src/core/engine/lifecycle/fork-helpers.ts',
      'packages/weft/src/core/engine/worker-versioning-policy.test.ts',
    ],
  },
  restart: {
    surface: 'restart',
    heading: 'Worker version for a restart or retry',
    text: 'Restarting a terminal run under the same ID (a start-new retry) inherits that run’s current worker version, even when routing has moved on. Only a server-issued override preview, spent on that restart, pins the replacement from current routing instead.',
    sources: [
      'packages/weft/src/core/engine/lifecycle/start-state.ts',
      'packages/weft/src/core/engine/lifecycle/start-worker-override.ts',
      'packages/weft/src/core/engine/worker-versioning-policy.test.ts',
    ],
  },
  activity: {
    surface: 'activity',
    heading: 'Workflow-bound and standalone activities',
    text: 'A remote activity dispatched by a bound workflow is routed to the bound deployment, build, artifact digest, and workflow revision, and carries that requirement into its attempt history. A standalone activity task, dispatched outside any workflow run, has no worker version and so no requirement derived from one.',
    sources: [
      'packages/weft/src/core/engine/remote-activity-broker.ts',
      'packages/weft/src/core/task-ledger/task-ledger-types.ts',
    ],
  },
};
