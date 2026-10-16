# Dashboard coverage matrix

Weft's dashboard exposes everything Weft offers. This matrix records, for every operation in Weft's generated operation client (`CLIENT_OPERATION_NAMES`) and for every surface Weft offers outside that catalog, whether the dashboard reaches it, which Linear issue will make it reach it, or why it never will.

`src/ui/coverage-matrix.test.ts` keeps the matrix honest and runs in Weft's default `test` task. It fails when an operation is added to Weft without a row here, and when a row says something the source does not back up.

## Reading and updating a row

Each row has exactly one status:

- `exposed`: the dashboard reaches the surface. `Location` names the route or component file that reaches it and `Test` names a test that exercises it. The test requires `Location` to contain the operation identifier in quotes (for example `'weft.workers.list'`, as `client.operations['weft.workers.list']` does), or to call `client.<Method>(` when `Method` is filled in. For a surface outside the catalog, `Location` must contain the marker the test lists for that surface.
- `tracked`: the dashboard does not reach it yet. `Issue` names the Linear issue that will expose it.
- `not-in-dashboard`: the dashboard deliberately does not reach it. `Reason` says why in one sentence.

`Method` names the `HttpClient` method `Location` calls when it reaches the operation through `HttpClient` rather than by identifier. The test calls that method on an `HttpClient` with a recording `fetch` and fails unless the request matches the operation's REST binding in Weft's catalog. Leave `Method` empty for a row reached by identifier. A new `Method` also needs an entry in the test's example-argument table.

`Issue` may list several identifiers separated by commas. On an `exposed` row it names issues that extend what the dashboard shows for that operation.

Paths are relative to `packages/weft/`. Keep rows in `CLIENT_OPERATION_NAMES` order, followed by the non-catalog surfaces, and do not use `|` inside a cell.

When an issue lands that exposes a `tracked` row, change that row's `Status` to `exposed`, fill in `Location` and `Test` (and `Method` when the code calls an `HttpClient` method), and leave the issue's identifier in `Issue` as a record of what exposed it.

## Gaps without a catalog row

Four dashboard issues own work that no `tracked` row can carry today. COR-166 (conditional workflow refresh) adds `weft.workflows.refresh` operations that do not exist yet, so the test will demand their rows when that issue lands. COR-162 (contract verification) computes manifest drift in the browser from `weft.system.registry` and `weft.workers.diagnostics`, and COR-274 and COR-281 (remote activity execution and execution provenance) extend what the dashboard shows from `weft.tasks.get` and `weft.tasks.diagnostics`, which it already reaches; those issues are named in the `Issue` column of those `exposed` rows.

## Matrix

| Operation | Status | Location | Method | Test | Issue | Reason |
| --- | --- | --- | --- | --- | --- | --- |
| `weft.activities.complete` | exposed | `src/ui/routes/workflows/detail/async-activity/async-activity-drawer.svelte` | `activity.complete` | `src/ui/routes/workflows/detail/async-activity/async-activity-drawer.test.ts` |  |  |
| `weft.activities.fail` | exposed | `src/ui/routes/workflows/detail/async-activity/async-activity-drawer.svelte` | `activity.completeExceptionally` | `src/ui/routes/workflows/detail/async-activity/async-activity-drawer.test.ts` |  |  |
| `weft.alerts.list` | exposed | `src/ui/routes/system/alerts-tab.svelte` |  | `src/ui/routes/system/alerts-tab.test.ts` |  |  |
| `weft.catalog.diagnostics` | exposed | `src/ui/routes/system/source-load-diagnostics.svelte` |  | `src/ui/routes/system/source-load-diagnostics.test.ts` |  |  |
| `weft.catalog.sources.list` | exposed | `src/ui/routes/system/dynamic-source-list.svelte` |  | `src/ui/routes/system/dynamic-source-list.test.ts` |  |  |
| `weft.conformance.report` | tracked |  |  |  | COR-160 |  |
| `weft.conformance.targets` | tracked |  |  |  | COR-160 |  |
| `weft.realms.diagnostics` | exposed | `src/ui/routes/system/realms-tab.svelte` |  | `src/ui/routes/system/realms-tab.test.ts` |  |  |
| `weft.recover.all` | exposed | `src/ui/routes/system/health-tab.svelte` |  | `src/ui/routes/system/health-tab.test.ts` |  |  |
| `weft.retention.get` | exposed | `src/ui/routes/system/health-tab.svelte` | `getRetentionOverview` | `src/ui/routes/system/health-tab.test.ts` |  |  |
| `weft.reviews.decision.submit` | exposed | `src/ui/routes/reviews/reviews-data.ts` | `submitReview` | `src/ui/routes/reviews/review-decision-form.test.ts` |  |  |
| `weft.reviews.get` | not-in-dashboard |  |  |  |  | The reviews inbox reads every review record, artifact included, from `weft.reviews.list`, so fetching one review by workflow adds nothing it lacks. |
| `weft.reviews.list` | exposed | `src/ui/routes/reviews/reviews-data.ts` | `listReviews` | `src/ui/routes/reviews/reviews.integration.test.ts` |  |  |
| `weft.schedules.cancel` | exposed | `src/ui/routes/schedules/schedule-queries.ts` | `cancelSchedule` | `src/ui/routes/schedules/schedule-queries.test.ts` |  |  |
| `weft.schedules.create` | exposed | `src/ui/routes/schedules/schedule-queries.ts` | `schedule` | `src/ui/routes/schedules/schedule-queries.test.ts` |  |  |
| `weft.schedules.get` | exposed | `src/ui/routes/schedules/schedule-queries.ts` | `getSchedule` | `src/ui/routes/schedules/schedule-queries.test.ts` |  |  |
| `weft.schedules.list` | exposed | `src/ui/routes/schedules/schedule-queries.ts` | `listSchedules` | `src/ui/routes/schedules/schedule-queries.test.ts` |  |  |
| `weft.schedules.pause` | exposed | `src/ui/routes/schedules/schedule-queries.ts` | `pauseSchedule` | `src/ui/routes/schedules/schedule-queries.test.ts` |  |  |
| `weft.schedules.resume` | exposed | `src/ui/routes/schedules/schedule-queries.ts` | `resumeSchedule` | `src/ui/routes/schedules/schedule-queries.test.ts` |  |  |
| `weft.schedules.update` | exposed | `src/ui/routes/schedules/schedule-queries.ts` | `updateSchedule` | `src/ui/routes/schedules/schedule-queries.test.ts` |  |  |
| `weft.storage.capabilities` | tracked |  |  |  | COR-298 | No issue owns this gap yet: the Storage capabilities panel still infers conditional-batch support by probing, so an issue must be filed and named here. |
| `weft.system.lease` | tracked |  |  |  | COR-124 |  |
| `weft.system.metrics` | exposed | `src/ui/routes/system/metrics-tab.svelte` |  | `src/ui/routes/system/metrics-tab.test.ts` |  |  |
| `weft.system.principal` | exposed | `src/ui/lib/scopes.svelte.ts` |  | `src/ui/lib/scopes.svelte.test.ts` |  |  |
| `weft.system.registry` | exposed | `src/ui/routes/system/registry-tab.svelte` |  | `src/ui/routes/system/registry-tab.test.ts` | COR-162 |  |
| `weft.task.queues.list` | exposed | `src/ui/routes/workers/workers-data.ts` |  | `src/ui/routes/workers/index.test.ts` |  |  |
| `weft.tasks.deadletters.get` | tracked |  |  |  | COR-284 |  |
| `weft.tasks.deliveries` | tracked |  |  |  | COR-284 |  |
| `weft.tasks.diagnostics` | exposed | `src/ui/routes/workers/workers-data.ts` |  | `src/ui/routes/workers/index.test.ts` | COR-274, COR-281 |  |
| `weft.tasks.diagnostics.deadletters.clear` | exposed | `src/ui/routes/workers/workers-data.ts` |  | `src/ui/routes/workers/clear-dead-letter-dialog.test.ts` |  |  |
| `weft.tasks.get` | exposed | `src/ui/routes/workers/workers-data.ts` |  | `src/ui/routes/workers/task-ledger-detail.test.ts` | COR-124, COR-274, COR-281, COR-284 |  |
| `weft.updates.result.get` | tracked |  |  |  | COR-1463 |  |
| `weft.worker.deployments.diagnostics` | tracked |  |  |  | COR-277 |  |
| `weft.worker.deployments.drain` | exposed | `src/ui/routes/workers/workers-data.ts` |  | `src/ui/routes/workers/index-actions.test.ts` | COR-277 |  |
| `weft.worker.deployments.preview` | tracked |  |  |  | COR-277 |  |
| `weft.worker.deployments.promote` | tracked |  |  |  | COR-277 |  |
| `weft.worker.deployments.resume` | exposed | `src/ui/routes/workers/workers-data.ts` |  | `src/ui/routes/workers/index-actions.test.ts` | COR-277 |  |
| `weft.worker.deployments.rollback` | tracked |  |  |  | COR-277 |  |
| `weft.worker.deployments.setrouting` | tracked |  |  |  | COR-277 |  |
| `weft.worker.startoverrides.preview` | tracked |  |  |  | COR-164 |  |
| `weft.workers.diagnostics` | exposed | `src/ui/routes/workers/workers-data.ts` |  | `src/ui/routes/workers/workers-manifest-data.test.ts` | COR-124, COR-162 |  |
| `weft.workers.drain` | exposed | `src/ui/routes/workers/workers-data.ts` |  | `src/ui/routes/workers/index-actions.test.ts` |  |  |
| `weft.workers.list` | exposed | `src/ui/routes/workers/workers-data.ts` |  | `src/ui/routes/workers/index.test.ts` |  |  |
| `weft.workers.rejections` | exposed | `src/ui/routes/workers/workers-data.ts` |  | `src/ui/routes/workers/index.test.ts` |  |  |
| `weft.workers.resume` | exposed | `src/ui/routes/workers/workers-data.ts` |  | `src/ui/routes/workers/index-actions.test.ts` |  |  |
| `weft.workflows.active.get` | exposed | `src/ui/routes/system/workflow-revisions-panel.svelte` |  | `src/ui/routes/system/workflow-revisions-panel-activation.test.ts` |  |  |
| `weft.workflows.activities.pending.list` | exposed | `src/ui/routes/workflows/detail/async-activity/async-activity-query.ts` |  | `src/ui/routes/workflows/detail/async-activity/async-activity-query.test.ts` |  |  |
| `weft.workflows.aggregate` | exposed | `src/ui/routes/workflows/aggregate/aggregate-view.svelte` |  | `src/ui/routes/workflows/aggregate/aggregate-view.test.ts` |  |  |
| `weft.workflows.attributes.get` | tracked |  |  |  | COR-1461 |  |
| `weft.workflows.attributes.set` | tracked |  |  |  | COR-1461 |  |
| `weft.workflows.bulk.cancel` | exposed | `src/ui/routes/workflows/list/bulk-operations-client.ts` |  | `src/ui/routes/workflows/list/bulk-operations-client.test.ts` |  |  |
| `weft.workflows.bulk.delete` | exposed | `src/ui/routes/workflows/list/bulk-operations-client.ts` |  | `src/ui/routes/workflows/list/bulk-operations-client.test.ts` |  |  |
| `weft.workflows.bulk.retryfailed` | exposed | `src/ui/routes/workflows/list/bulk-operations-client.ts` |  | `src/ui/routes/workflows/list/bulk-operations-client.test.ts` |  |  |
| `weft.workflows.bulk.signal` | exposed | `src/ui/routes/workflows/list/bulk-operations-client.ts` |  | `src/ui/routes/workflows/list/bulk-operations-client.test.ts` |  |  |
| `weft.workflows.bulk.tags` | exposed | `src/ui/routes/workflows/list/bulk-operations-client.ts` |  | `src/ui/routes/workflows/list/bulk-operations-client.test.ts` |  |  |
| `weft.workflows.cancel` | exposed | `src/ui/routes/workflows/detail/workflow-detail.svelte` | `cancel` | `src/ui/routes/workflows/detail/workflow-detail.test.ts` |  |  |
| `weft.workflows.checkpoints.get` | exposed | `src/ui/routes/workflows/detail/checkpoints/checkpoints-data.ts` |  | `src/ui/routes/workflows/detail/checkpoints/checkpoints-data.test.ts` |  |  |
| `weft.workflows.checkpoints.list` | exposed | `src/ui/routes/workflows/detail/checkpoints/checkpoints-data.ts` |  | `src/ui/routes/workflows/detail/checkpoints/checkpoints-data.test.ts` |  |  |
| `weft.workflows.events.list` | exposed | `src/ui/routes/workflows/detail/events-tab.svelte` | `getEvents` | `src/ui/routes/workflows/detail/events-tab.test.ts` |  |  |
| `weft.workflows.finalizer.get` | exposed | `src/ui/routes/workflows/detail/workflow-observability.ts` |  | `src/ui/routes/workflows/detail/workflow-observability.test.ts` |  |  |
| `weft.workflows.fork` | exposed | `src/ui/routes/workflows/detail/checkpoints/fork-dialog.svelte` | `fork` | `src/ui/routes/workflows/detail/checkpoints/fork-dialog.test.ts` |  |  |
| `weft.workflows.get` | exposed | `src/ui/routes/workflows/detail/workflow-detail.svelte` | `get` | `src/ui/routes/workflows/detail/workflow-detail.test.ts` | COR-164 |  |
| `weft.workflows.list` | exposed | `src/ui/routes/workflows/list/workflow-list.svelte` | `list` | `src/ui/routes/workflows/list/workflow-list.test.ts` |  |  |
| `weft.workflows.purge` | exposed | `src/ui/routes/workflows/list/bulk-operations-client.ts` |  | `src/ui/routes/workflows/list/bulk-operations-client.test.ts` |  |  |
| `weft.workflows.query` | exposed | `src/ui/routes/workflows/detail/workflow-detail.svelte` | `query` | `src/ui/routes/workflows/detail/workflow-detail.test.ts` |  |  |
| `weft.workflows.replay` | exposed | `src/ui/routes/workflows/detail/checkpoints/checkpoints-data.ts` | `replayTo` | `src/ui/routes/workflows/detail/checkpoints/checkpoints-data.test.ts` |  |  |
| `weft.workflows.result.get` | not-in-dashboard |  |  |  |  | Workflow detail shows the result from the `weft.workflows.get` state it already loads, and this operation waits for the run to settle, which would hold a dashboard request open. |
| `weft.workflows.resume` | exposed | `src/ui/routes/workflows/detail/workflow-detail.svelte` | `resume` | `src/ui/routes/workflows/detail/workflow-detail.test.ts` |  |  |
| `weft.workflows.revisions.activate` | exposed | `src/ui/routes/system/workflow-revisions-panel.svelte` |  | `src/ui/routes/system/workflow-revisions-panel-activation.test.ts` |  |  |
| `weft.workflows.revisions.get` | tracked |  |  |  | COR-1464 |  |
| `weft.workflows.revisions.install` | tracked |  |  |  | COR-1464 |  |
| `weft.workflows.revisions.list` | exposed | `src/ui/routes/system/workflow-revisions-panel.svelte` |  | `src/ui/routes/system/workflow-revisions-panel-activation.test.ts` |  |  |
| `weft.workflows.revisions.preload` | exposed | `src/ui/routes/system/dynamic-source-panel.svelte` |  | `src/ui/routes/system/dynamic-source-panel.test.ts` |  |  |
| `weft.workflows.scheduleprovenance.get` | exposed | `src/ui/routes/workflows/detail/lineage-panel.svelte` |  | `src/ui/routes/workflows/detail/lineage-panel.test.ts` |  |  |
| `weft.workflows.signal` | exposed | `src/ui/routes/workflows/detail/signals-tab.svelte` | `signal` | `src/ui/routes/workflows/detail/signals-tab.test.ts` |  |  |
| `weft.workflows.start` | exposed | `src/ui/routes/workflows/start/start-wizard.svelte` | `start` | `src/ui/routes/workflows/start/start-wizard.test.ts` | COR-164 |  |
| `weft.workflows.startorsignal` | exposed | `src/ui/routes/workflows/detail/restart-dialog.svelte` | `startOrSignal` | `src/ui/routes/workflows/detail/restart-dialog.test.ts` |  |  |
| `weft.workflows.streams.chunks` | tracked |  |  |  | COR-1462 |  |
| `weft.workflows.suspend` | exposed | `src/ui/routes/workflows/detail/workflow-detail.svelte` | `suspend` | `src/ui/routes/workflows/detail/workflow-detail.test.ts` |  |  |
| `weft.workflows.tags.add` | exposed | `src/ui/routes/workflows/detail/overview-tab.svelte` | `addTags` | `src/ui/routes/workflows/detail/overview-tab.test.ts` |  |  |
| `weft.workflows.tags.remove` | exposed | `src/ui/routes/workflows/detail/overview-tab.svelte` | `removeTags` | `src/ui/routes/workflows/detail/overview-tab.test.ts` |  |  |
| `weft.workflows.timeline.get` | exposed | `src/ui/routes/workflows/detail/timeline-tab.svelte` | `getTimeline` | `src/ui/routes/workflows/detail/timeline-tab.test.ts` |  |  |
| `weft.workflows.timeout` | exposed | `src/ui/routes/workflows/detail/workflow-detail.svelte` | `timeout` | `src/ui/routes/workflows/detail/workflow-detail.test.ts` |  |  |
| `weft.workflows.update` | exposed | `src/ui/routes/workflows/detail/updates-tab.svelte` | `update` | `src/ui/routes/workflows/detail/updates-tab.test.ts` | COR-1463 |  |
| `feed:workflow-events:sse` | exposed | `src/ui/lib/live-source/workflow-tail-source.svelte.ts` |  | `src/ui/lib/live-source/workflow-tail-source.test.ts` |  |  |
| `feed:workflow-events:websocket` | exposed | `src/ui/lib/live-source/workflow-tail-source.svelte.ts` |  | `src/ui/lib/live-source/workflow-tail-source.test.ts` |  |  |
| `feed:fleet-events:sse` | exposed | `src/ui/lib/live-source/fleet-event-source.svelte.ts` |  | `src/ui/lib/live-source/fleet-event-source.test.ts` |  |  |
| `feed:fleet-events:websocket` | not-in-dashboard |  |  |  |  | The dashboard reads the fleet feed over SSE, which carries the same fleet events as the `weft.events.subscribe` WebSocket subscription. |
| `metrics:prometheus` | not-in-dashboard |  |  |  |  | `GET /v1/metrics` serves Prometheus text for a scraper, and the Metrics tab reads the same collector as JSON through `weft.system.metrics`. |
| `traces:opentelemetry` | not-in-dashboard |  |  |  |  | Weft exports traces to an OpenTelemetry collector and does not serve them, so there is nothing for the dashboard to read. |
| `audit:authentication` | tracked |  |  |  | COR-1465 |  |
| `mount:dashboard` | exposed | `src/server/dashboard.ts` |  | `src/server/dashboard.test.ts` | COR-1448 |  |
