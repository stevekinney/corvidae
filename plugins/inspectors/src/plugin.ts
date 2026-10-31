import { definePlugin, type PluginMcpApp } from '@lostgradient/interborough-plugin';

import { BASE_STYLES, PENDING_REVIEW_STYLES } from './styles.ts';

/**
 * The run inspector: one Bureau task's liveness, ownership tree, progress, result, and abort. A
 * client opens it from `bureau.tasks.inspect`, the one tool the page is linked to; the page also
 * follows the task through `bureau.tasks.events` and aborts it with `bureau.tasks.cancel`.
 */
export const runInspector: PluginMcpApp = {
  name: 'run-inspector',
  title: 'Run inspector',
  description: 'Liveness, ownership tree, progress, result, and abort for one Bureau task.',
  uri: 'ui://bureau/run-inspector/v1',
  entry: new URL('./run-inspector/app.ts', import.meta.url),
  styles: BASE_STYLES,
  allowedTools: ['bureau.tasks.inspect'],
};

/**
 * The pending-review app: the reviews waiting for the caller. A client opens it from
 * `bureau.reviews.list`, the one tool the page is linked to; the page also reads one review
 * through `bureau.reviews.get` and decides it through `bureau.reviews.resolve`.
 */
export const pendingReview: PluginMcpApp = {
  name: 'pending-review',
  title: 'Pending reviews',
  description: 'The reviews waiting for the caller: approve, deny, or reject with feedback.',
  uri: 'ui://bureau/pending-review/v1',
  entry: new URL('./pending-review/app.ts', import.meta.url),
  styles: PENDING_REVIEW_STYLES,
  allowedTools: ['bureau.reviews.list'],
};

/**
 * Two interface panels, the run inspector and the pending-review list. Each is a page the host
 * builds from a browser entry at startup and serves as a `ui://` resource.
 */
export default definePlugin({
  name: 'inspectors',
  version: '1.0.0',
  description:
    'Adds the run inspector and the pending-review list as interface panels over the Bureau task and review tools.',
  setup: () => ({ mcpApps: [runInspector, pendingReview] }),
});
