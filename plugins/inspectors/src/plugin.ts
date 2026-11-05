import { definePlugin, type PluginMcpApp } from '@lostgradient/interborough-plugin';

import { BASE_STYLES, PENDING_REVIEW_STYLES, WORKFLOW_REVISION_STYLES } from './styles.ts';

/**
 * The run inspector: one Bureau task's liveness, ownership tree, progress, result, and abort. A
 * client opens it from `bureau.tasks.inspect`, the tool the page is linked to; the page also
 * follows the task through `bureau.tasks.events` and aborts it with `bureau.tasks.cancel`.
 * `allowedTools` lists every tool the page calls, which a test keeps true.
 */
export const runInspector: PluginMcpApp = {
  name: 'run-inspector',
  title: 'Run inspector',
  description: 'Liveness, ownership tree, progress, result, and abort for one Bureau task.',
  uri: 'ui://bureau/run-inspector/v1',
  entry: new URL('./run-inspector/app.ts', import.meta.url),
  styles: BASE_STYLES,
  allowedTools: ['bureau.tasks.inspect', 'bureau.tasks.events', 'bureau.tasks.cancel'],
  opensFromTool: 'bureau.tasks.inspect',
};

/**
 * The pending-review app: the reviews waiting for the caller. A client opens it from
 * `bureau.reviews.list`, the tool the page is linked to; the page also reads one review through
 * `bureau.reviews.get` and decides it through `bureau.reviews.resolve`. `allowedTools` lists every
 * tool the page calls, which a test keeps true.
 */
export const pendingReview: PluginMcpApp = {
  name: 'pending-review',
  title: 'Pending reviews',
  description: 'The reviews waiting for the caller: approve, deny, or reject with feedback.',
  uri: 'ui://bureau/pending-review/v1',
  entry: new URL('./pending-review/app.ts', import.meta.url),
  styles: PENDING_REVIEW_STYLES,
  allowedTools: ['bureau.reviews.list', 'bureau.reviews.get', 'bureau.reviews.resolve'],
  opensFromTool: 'bureau.reviews.list',
};

/** The workflow revision review panel opened by an agent's proposed update in Chat. */
export const workflowRevisionReview: PluginMcpApp = {
  name: 'workflow-revision-review',
  title: 'Review workflow revision',
  description: 'Compare and apply a proposed workflow revision.',
  uri: 'ui://bureau/workflow-revision-review/v1',
  entry: new URL('./workflow-revision/app.ts', import.meta.url),
  styles: WORKFLOW_REVISION_STYLES,
  allowedTools: ['bureau.workflows.get', 'bureau.workflows.update'],
  opensFromTool: 'bureau.workflows.update',
  opensFromAgentTool: 'bureau:workflows-propose-update',
};

/**
 * Three interface panels, the run inspector, pending-review list, and workflow revision review. Each is a page the host
 * builds from a browser entry at startup and serves as a `ui://` resource.
 */
export default definePlugin({
  name: 'inspectors',
  title: 'Inspectors',
  version: '1.0.0',
  description:
    'Adds the run inspector and the pending-review list as interface panels over the run and review tools.',
  setup: () => ({ mcpApps: [runInspector, pendingReview, workflowRevisionReview] }),
});
