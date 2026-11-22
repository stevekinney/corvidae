import { definePlugin, type PluginPanel } from '@lostgradient/interborough-plugin';

import {
  BASE_STYLES,
  PENDING_REVIEW_STYLES,
  RUN_COMPARISON_STYLES,
  RUN_TIMELINE_STYLES,
  SCHEDULE_EDITOR_STYLES,
  WORKFLOW_REVISION_STYLES,
} from './styles.ts';

/**
 * The run inspector: one Bureau task's liveness, ownership tree, progress, result, and abort. A
 * client opens it from `bureau.tasks.inspect`, the tool the page is linked to; the page also
 * follows the task through `bureau.tasks.events` and aborts it with `bureau.tasks.cancel`.
 * `allowedTools` lists every tool the page calls, which a test keeps true.
 */
export const runInspector: PluginPanel = {
  name: 'run-inspector',
  title: 'Run inspector',
  description: 'Liveness, ownership tree, progress, result, and abort for one Bureau task.',
  uri: 'ui://inspectors/run-inspector/v1',
  entry: new URL('./run-inspector/app.ts', import.meta.url),
  styles: BASE_STYLES,
  allowedTools: ['bureau.tasks.inspect', 'bureau.tasks.events', 'bureau.tasks.cancel'],
  placements: [{ kind: 'run' }],
  opensFromTool: 'bureau.tasks.inspect',
};

/**
 * The pending-review app: the reviews waiting for the caller. A client opens it from
 * `bureau.reviews.list`, the tool the page is linked to; the page also reads one review through
 * `bureau.reviews.get` and decides it through `bureau.reviews.resolve`. `allowedTools` lists every
 * tool the page calls, which a test keeps true.
 */
export const pendingReview: PluginPanel = {
  name: 'pending-review',
  title: 'Pending reviews',
  description: 'The reviews waiting for the caller: approve, deny, or reject with feedback.',
  uri: 'ui://inspectors/pending-review/v1',
  entry: new URL('./pending-review/app.ts', import.meta.url),
  styles: PENDING_REVIEW_STYLES,
  allowedTools: ['bureau.reviews.list', 'bureau.reviews.get', 'bureau.reviews.resolve'],
  opensFromTool: 'bureau.reviews.list',
};

/** The workflow revision review panel opened by an agent's proposed update in Chat. */
export const workflowRevisionReview: PluginPanel = {
  name: 'workflow-revision-review',
  title: 'Review workflow revision',
  description: 'Compare and apply a proposed workflow revision.',
  uri: 'ui://inspectors/workflow-revision-review/v1',
  entry: new URL('./workflow-revision/app.ts', import.meta.url),
  styles: WORKFLOW_REVISION_STYLES,
  allowedTools: ['bureau.workflows.get', 'bureau.workflows.update'],
  hostOnlyTools: ['bureau.workflows.update'],
  placements: [{ kind: 'chat-tool', agentTool: 'bureau:workflows-propose-update' }],
  opensFromTool: 'bureau.workflows.update',
};

/**
 * The run timeline: one run's steps as a waterfall, each with its status, duration and tries. A
 * client opens it from `bureau.runs.timeline`, the tool the page is linked to, Chat opens it inline
 * when an agent calls `bureau:runs-timeline`, and a run's page mounts it beside the run. It reads
 * `bureau.runs.timeline` and no other tool, and changes nothing. The bars come
 * from `stepWaterfall`, the layout the run page draws its own steps with. `allowedTools` lists
 * every tool the page calls, which a test keeps true.
 */
export const runTimeline: PluginPanel = {
  name: 'run-timeline',
  title: 'Run timeline',
  description: 'The steps of one run as a waterfall: each step’s status, duration and tries.',
  uri: 'ui://inspectors/run-timeline/v1',
  entry: new URL('./run-timeline/app.ts', import.meta.url),
  styles: RUN_TIMELINE_STYLES,
  allowedTools: ['bureau.runs.timeline'],
  placements: [{ kind: 'run' }, { kind: 'chat-tool', agentTool: 'bureau:runs-timeline' }],
  opensFromTool: 'bureau.runs.timeline',
};

/**
 * The schedule editor (COR-2545): the schedules the caller may change, and one schedule's form to
 * change when it runs, which agent or workflow it runs, and whether it is paused, or to make a new
 * one. It reads through `bureau.schedules.list`, `bureau.schedules.get`, `bureau.agents.list` and
 * `bureau.workflows.list`, and saves through the four schedule writes, which are `hostOnlyTools`:
 * they are not MCP tools, so no model reaches them, and the host's panel route names this panel's
 * URI to the Bureau so the audit entry of each write says it came from here. `allowedTools` lists
 * every tool the page calls, which a test keeps true. It opens as a page of its own, and on a run's
 * page, which passes it the run's `taskId`: the editor reads that task through `bureau.tasks.get`
 * and opens the schedule whose fire started it, and shows the list for a run nothing scheduled.
 */
export const scheduleEditor: PluginPanel = {
  name: 'schedule-editor',
  title: 'Schedule editor',
  description: 'Change when a schedule runs, what it runs, and whether it is paused, or make one.',
  uri: 'ui://inspectors/schedule-editor/v1',
  entry: new URL('./schedule-editor/app.ts', import.meta.url),
  styles: SCHEDULE_EDITOR_STYLES,
  allowedTools: [
    'bureau.schedules.list',
    'bureau.schedules.get',
    'bureau.schedules.create',
    'bureau.schedules.update',
    'bureau.schedules.pause',
    'bureau.schedules.resume',
    'bureau.agents.list',
    'bureau.workflows.list',
    'bureau.tasks.get',
  ],
  hostOnlyTools: [
    'bureau.schedules.create',
    'bureau.schedules.update',
    'bureau.schedules.pause',
    'bureau.schedules.resume',
  ],
  // A page of its own, reachable from the command palette and by its path, and a run's page. No
  // sidebar entry: the application's own Schedules page is where people look for schedules.
  placements: [{ kind: 'page', path: 'schedules' }, { kind: 'run' }],
};

/**
 * The run comparison: a forked workflow run beside the run it was forked from, with the steps the
 * two share and the input and output differences of each step the fork ran again. A client opens it
 * from `bureau.runs.compare`, the tool the page is linked to and the only one it calls. It declares a
 * `run` placement, and the Interborough run page mounts it on a workflow instance that is a fork,
 * giving it `{ runId, runKind: 'workflow' }` (owner decision, 2026-11-22, refined by the design
 * review of #1219: a card is mounted only when it has something to say about the run). A client
 * that opens it on a run that is not a fork gets the server's message, shown as written.
 * `allowedTools` lists every tool the page calls, which a test keeps true.
 */
export const runComparison: PluginPanel = {
  name: 'run-comparison',
  title: 'Run comparison',
  description: 'A forked workflow run beside its source: shared steps and payload differences.',
  uri: 'ui://inspectors/run-comparison/v1',
  entry: new URL('./run-comparison/app.ts', import.meta.url),
  styles: RUN_COMPARISON_STYLES,
  allowedTools: ['bureau.runs.compare'],
  placements: [{ kind: 'run' }],
  opensFromTool: 'bureau.runs.compare',
};

/**
 * Six interface panels, the run inspector, pending-review list, workflow revision review, schedule
 * editor, run timeline and run comparison. Each is a page the host builds from a browser entry
 * at startup and serves as a `ui://` resource.
 */
export default definePlugin({
  name: 'inspectors',
  title: 'Inspectors',
  version: '1.0.1',
  description:
    'Adds the run inspector, the pending-review list, the workflow revision review, the schedule editor, the run timeline and the run comparison as interface panels over the run, review, workflow and schedule tools.',
  setup: () => ({
    panels: [
      runInspector,
      pendingReview,
      workflowRevisionReview,
      scheduleEditor,
      runTimeline,
      runComparison,
    ],
  }),
});
