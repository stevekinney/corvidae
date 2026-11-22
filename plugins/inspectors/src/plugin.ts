import { definePlugin, type PluginPanel } from '@lostgradient/interborough-plugin';

import {
  BASE_STYLES,
  PENDING_REVIEW_STYLES,
  RUN_COMPARISON_STYLES,
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
 * The run comparison: a forked workflow run beside the run it was forked from, with the steps the
 * two share and the input and output differences of each step the fork ran again. A client opens it
 * from `bureau.runs.compare`, the tool the page is linked to and the only one it calls. A run's page
 * mounts it for every run it shows, so a run that is not a fork shows the server's message.
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
 * Four interface panels, the run inspector, pending-review list, workflow revision review, and run
 * comparison. Each is a page the host builds from a browser entry at startup and serves as a
 * `ui://` resource.
 */
export default definePlugin({
  name: 'inspectors',
  title: 'Inspectors',
  version: '1.0.1',
  description:
    'Adds the run inspector, the pending-review list, the workflow revision review and the run comparison as interface panels over the run, review and workflow tools.',
  setup: () => ({
    panels: [runInspector, pendingReview, workflowRevisionReview, runComparison],
  }),
});
