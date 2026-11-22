/**
 * Which run panels have something to say about the run a page shows (COR-2544, owner decision
 * 2026-11-22, refined by the design review of #1219): a card is mounted only when it can tell the
 * reader something about that run.
 *
 * A panel declares only that it shows on a run's page (`placements: [{ kind: 'run' }]`), not which
 * kind of run, so the host that ships the inspectors plugin keeps what it knows about them here. A
 * panel with no entry is a third party's, and shows on every run, as its placement says.
 *
 * What each inspectors panel reads from the input a run page gives it (`{ taskId }` on an agent
 * run, `{ runId, runKind: 'workflow' }` on a workflow instance): the run timeline and the run
 * comparison read `runId` (the timeline falls back to `taskId`), so both work on either; the run
 * inspector and the schedule editor read `taskId`, which is why neither is mounted on a workflow
 * run. The run timeline serves an agent run or an instance of a workflow file
 * (`bureau.runs.timeline`), and answers any other engine run, such as the end-to-end fixture's own
 * workflows and their forks, as not found, which its panel says in its own words.
 */

/** The run a page shows: a Bureau task (an agent run) or a workflow instance the engine holds. */
export type RunPanelRun =
  | { readonly kind: 'task' }
  | {
      readonly kind: 'workflow';
      /** Whether the instance was forked from another run, so there is a source to compare it with. */
      readonly fork: boolean;
    };

/** Whether a panel has something to say about a run. */
type RunPanelScope = (run: RunPanelRun) => boolean;

/**
 * The inspectors plugin's panels, by `plugin/app`:
 * - the run inspector reads an agent task, so it has nothing to say about a workflow instance, which
 *   has no task;
 * - the schedule editor reads a task to open the schedule whose fire started it. It lists every
 *   schedule and cannot narrow them to one workflow's, so on a workflow instance it would show a list
 *   that says nothing about that run, and is not mounted there;
 * - the run comparison compares a fork with its source, so it is mounted on a fork and nowhere else.
 */
const SCOPES: Readonly<Record<string, RunPanelScope>> = Object.freeze({
  'inspectors/run-inspector': (run) => run.kind === 'task',
  'inspectors/schedule-editor': (run) => run.kind === 'task',
  'inspectors/run-comparison': (run) => run.kind === 'workflow' && run.fork,
});

/** Whether the panel `app` of `plugin` is mounted on `run`. */
export function panelHasSomethingToSay(plugin: string, app: string, run: RunPanelRun): boolean {
  const key = `${plugin}/${app}`;
  const scope = Object.hasOwn(SCOPES, key) ? SCOPES[key] : undefined;
  return scope === undefined || scope(run);
}
