import { definePlugin, type PluginPanel } from '@lostgradient/interborough-plugin';

import {
  BASE_STYLES,
  FAILURE_EXPLANATION_STYLES,
  PENDING_REVIEW_STYLES,
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
 * The failure explanation (COR-2543): why one failed run failed, in the Bureau's own words from
 * what it stored about the run and nothing else: the summary, the cause, the step, how often it was
 * tried, the guardrails that fired and what to do next. A client opens it from the explain tool,
 * which hands the page its result, and a run's page mounts it with the run's `taskId`, which the
 * page reads through the same tool. That read is the only call it makes, and it is a read, so the
 * panel has nothing a model or a person could change through it. A run that did not fail is the
 * Bureau's refusal, whose message and remediation the page shows. `allowedTools` lists every tool the
 * page calls, which a test keeps true.
 */
export const failureExplanation: PluginPanel = {
  name: 'failure-explanation',
  title: 'Failure explanation',
  description: 'Why one failed run failed, from what the Bureau stored about it.',
  uri: 'ui://inspectors/failure-explanation/v1',
  entry: new URL('./failure-explanation/app.ts', import.meta.url),
  styles: FAILURE_EXPLANATION_STYLES,
  allowedTools: ['bureau.tasks.explain'],
  placements: [{ kind: 'run' }],
  opensFromTool: 'bureau.tasks.explain',
};

/**
 * Five interface panels, the run inspector, pending-review list, workflow revision review, schedule
 * editor and failure explanation. Each is a page the host builds from a browser entry at startup and
 * serves as a `ui://` resource.
 */
export default definePlugin({
  name: 'inspectors',
  title: 'Inspectors',
  version: '1.0.1',
  description:
    'Adds the run inspector, the pending-review list, the workflow revision review, the schedule editor and the failure explanation as interface panels over the run, review, workflow and schedule tools.',
  setup: () => ({
    panels: [
      runInspector,
      pendingReview,
      workflowRevisionReview,
      scheduleEditor,
      failureExplanation,
    ],
  }),
});
