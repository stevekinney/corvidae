# Dashboard coverage matrix

Interborough's Engine console exposes everything Weft offers. This matrix records, for every operation in Weft's generated operation client (`CLIENT_OPERATION_NAMES`) and for every surface Weft offers outside that catalog, whether the dashboard reaches it, which Linear issue will make it reach it, or why it never will.

`src/coverage-matrix.test.ts` keeps the matrix honest and runs in this application's `test` task. It fails when an operation is added to Weft without a row here, and when a row says something the source does not back up.

## Reading and updating a row

Each row has exactly one status:

- `exposed`: the dashboard reaches the surface. `Location` names the route or component file that reaches it and `Test` names a test that exercises it. The test requires `Location` to contain the operation identifier in quotes (for example `'weft.workers.list'`, as `client.operations['weft.workers.list']` does), or to call `client.<Method>(` when `Method` is filled in. For a surface outside the catalog, `Location` must contain the marker the test lists for that surface.
- `tracked`: the dashboard does not reach it yet. `Issue` names the Linear issue that will expose it.
- `not-in-dashboard`: the dashboard deliberately does not reach it. `Reason` says why in one sentence.

`Method` names the `HttpClient` method `Location` calls when it reaches the operation through `HttpClient` rather than by identifier. The test calls that method on an `HttpClient` with a recording `fetch` and fails unless the request matches the operation's REST binding in Weft's catalog. Leave `Method` empty for a row reached by identifier. A new `Method` also needs an entry in the test's example-argument table.

`Issue` may list several identifiers separated by commas. On an `exposed` row it names issues that extend what the dashboard shows for that operation.

Paths are relative to `applications/interborough/`. Keep rows in `CLIENT_OPERATION_NAMES` order, followed by the non-catalog surfaces, and do not use `|` inside a cell.

When an issue lands that exposes a `tracked` row, change that row's `Status` to `exposed`, fill in `Location` and `Test` (and `Method` when the code calls an `HttpClient` method), and leave the issue's identifier in `Issue` as a record of what exposed it.

## Gaps without a catalog row

Two dashboard issues own work that no `tracked` row can carry today. COR-162 (contract verification) computes manifest drift in the browser from `weft.system.registry` and `weft.workers.diagnostics`, and COR-274 (remote activity execution) extends what the dashboard shows from `weft.tasks.get` and `weft.tasks.diagnostics`, which it already reaches; those issues are named in the `Issue` column of those `exposed` rows.

## Matrix

| Operation | Status | Location | Method | Test | Issue | Reason |
| --- | --- | --- | --- | --- | --- | --- |
| `weft.activities.complete` | exposed | `src/routes/workflows/detail/async-activity/async-activity-drawer.svelte` | `activity.complete` | `src/routes/workflows/detail/async-activity/async-activity-drawer.test.ts` |  |  |
| `weft.activities.fail` | exposed | `src/routes/workflows/detail/async-activity/async-activity-drawer.svelte` | `activity.completeExceptionally` | `src/routes/workflows/detail/async-activity/async-activity-drawer.test.ts` |  |  |
| `weft.alerts.list` | exposed | `src/routes/system/alerts-tab.svelte` |  | `src/routes/system/alerts-tab.test.ts` |  |  |
| `weft.catalog.diagnostics` | exposed | `src/routes/system/source-load-diagnostics.svelte` |  | `src/routes/system/source-load-diagnostics.test.ts` |  |  |
| `weft.catalog.sources.list` | exposed | `src/routes/system/dynamic-source-list.svelte` |  | `src/routes/system/dynamic-source-list.test.ts` |  |  |
| `weft.conformance.report` | exposed | `src/routes/workers/workers-data.ts` |  | `src/routes/workers/conformance-panel.test.ts` | COR-160 |  |
| `weft.conformance.targets` | exposed | `src/routes/workers/workers-data.ts` |  | `src/routes/workers/conformance-panel.test.ts` | COR-160 |  |
| `weft.realms.diagnostics` | exposed | `src/routes/system/realms-view.ts` |  | `src/routes/system/realms-tab.test.ts` |  |  |
| `weft.recover.all` | exposed | `src/routes/system/health-tab.svelte` |  | `src/routes/system/health-tab.test.ts` |  |  |
| `weft.retention.get` | exposed | `src/routes/system/retention-panel.svelte` | `getRetentionOverview` | `src/routes/system/retention-panel.test.ts` |  |  |
| `weft.reviews.decision.submit` | exposed | `src/routes/reviews/reviews-data.ts` | `submitReview` | `src/routes/reviews/review-decision-form.test.ts` |  |  |
| `weft.reviews.get` | not-in-dashboard |  |  |  |  | The reviews inbox reads every review record, artifact included, from `weft.reviews.list`, so fetching one review by workflow adds nothing it lacks. |
| `weft.reviews.list` | exposed | `src/routes/reviews/reviews-data.ts` | `listReviews` | `src/routes/reviews/reviews.integration.test.ts` |  |  |
| `weft.schedules.cancel` | exposed | `src/routes/schedules/schedule-queries.ts` | `cancelSchedule` | `src/routes/schedules/schedule-queries.test.ts` |  |  |
| `weft.schedules.create` | exposed | `src/routes/schedules/schedule-queries.ts` | `schedule` | `src/routes/schedules/schedule-queries.test.ts` |  |  |
| `weft.schedules.get` | exposed | `src/routes/schedules/schedule-queries.ts` | `getSchedule` | `src/routes/schedules/schedule-queries.test.ts` |  |  |
| `weft.schedules.list` | exposed | `src/routes/schedules/schedule-queries.ts` | `listSchedules` | `src/routes/schedules/schedule-queries.test.ts` |  |  |
| `weft.schedules.missed` | exposed | `src/routes/schedules/schedule-queries.ts` |  | `src/routes/schedules/schedule-queries.test.ts` |  | A schedule that runs an agent is read through `bureau.schedules.missed`, which checks its owner. |
| `weft.schedules.pause` | exposed | `src/routes/schedules/schedule-queries.ts` | `pauseSchedule` | `src/routes/schedules/schedule-queries.test.ts` |  |  |
| `weft.schedules.resume` | exposed | `src/routes/schedules/schedule-queries.ts` | `resumeSchedule` | `src/routes/schedules/schedule-queries.test.ts` |  |  |
| `weft.schedules.runnow` | exposed | `src/routes/schedules/schedule-queries.ts` |  | `src/routes/schedules/schedule-queries.test.ts` |  | A schedule that runs an agent is run through `bureau.schedules.runnow`, which checks its owner. |
| `weft.schedules.skipnext` | exposed | `src/routes/schedules/schedule-queries.ts` |  | `src/routes/schedules/schedule-queries.test.ts` |  | Sent as the REST call, because the JSON-RPC client reads its empty answer as invalid. A schedule that runs an agent is skipped through `bureau.schedules.skipnext`, which checks its owner. |
| `weft.schedules.update` | exposed | `src/routes/schedules/schedule-queries.ts` | `updateSchedule` | `src/routes/schedules/schedule-queries.test.ts` |  |  |
| `weft.storage.capabilities` | exposed | `src/routes/storage/index.svelte` |  | `src/routes/storage/index.test.ts` | COR-1539 |  |
| `weft.system.lease` | exposed | `src/lib/system-lease.ts` |  | `src/lib/system-lease.test.ts` | COR-124 |  |
| `weft.system.metrics` | exposed | `src/routes/system/metrics-tab.svelte` |  | `src/routes/system/metrics-tab.test.ts` |  |  |
| `weft.system.principal` | exposed | `src/lib/scopes.svelte.ts` |  | `src/lib/scopes.svelte.test.ts` |  |  |
| `weft.system.registry` | exposed | `src/routes/workers/workers-data.ts` |  | `src/routes/workers/workers-registry-data.test.ts` | COR-162 |  |
| `weft.task.queues.list` | exposed | `src/routes/workers/workers-data.ts` |  | `src/routes/workers/index.test.ts` |  |  |
| `weft.tasks.deadletters.get` | exposed | `src/routes/workers/workers-data.ts` |  | `src/routes/workers/task-dead-letter-panel.test.ts` | COR-284 |  |
| `weft.tasks.deliveries` | exposed | `src/routes/workers/workers-data.ts` |  | `src/routes/workers/task-delivery-history.test.ts` | COR-284 |  |
| `weft.tasks.diagnostics` | exposed | `src/routes/workers/workers-data.ts` |  | `src/routes/workers/index.test.ts` | COR-274, COR-281 |  |
| `weft.tasks.diagnostics.deadletters.clear` | exposed | `src/routes/workers/workers-data.ts` |  | `src/routes/workers/clear-dead-letter-dialog.test.ts` |  |  |
| `weft.tasks.get` | exposed | `src/routes/workers/workers-data.ts` |  | `src/routes/workers/task-ledger-detail.test.ts` | COR-124, COR-274, COR-281, COR-284 |  |
| `weft.updates.result.get` | exposed | `src/routes/workflows/detail/updates/updates-data.ts` |  | `src/routes/workflows/detail/updates-tab.test.ts` | COR-1463 |  |
| `weft.worker.deployments.diagnostics` | exposed | `src/routes/workers/deployments-data.ts` |  | `src/routes/workers/deployments-panel.test.ts` | COR-277 |  |
| `weft.worker.deployments.drain` | exposed | `src/routes/workers/workers-data.ts` |  | `src/routes/workers/index-actions.test.ts` | COR-277 |  |
| `weft.worker.deployments.preview` | exposed | `src/routes/workers/deployments-data.ts` |  | `src/routes/workers/routing-dialog.test.ts` | COR-277 |  |
| `weft.worker.deployments.promote` | exposed | `src/routes/workers/deployments-data.ts` |  | `src/routes/workers/deployments-panel.test.ts` | COR-277 |  |
| `weft.worker.deployments.remove` | exposed | `src/routes/workers/deployments-data.ts` |  | `src/routes/workers/deployments-panel.test.ts` | COR-277 |  |
| `weft.worker.deployments.resume` | exposed | `src/routes/workers/workers-data.ts` |  | `src/routes/workers/index-actions.test.ts` | COR-277 |  |
| `weft.worker.deployments.rollback` | exposed | `src/routes/workers/deployments-data.ts` |  | `src/routes/workers/routing-dialog.test.ts` | COR-277 |  |
| `weft.worker.deployments.setrouting` | exposed | `src/routes/workers/deployments-data.ts` |  | `src/routes/workers/routing-dialog.test.ts` | COR-277 |  |
| `weft.worker.startoverrides.preview` | exposed | `src/routes/workflows/detail/restart-worker-override.svelte` |  | `src/routes/workflows/detail/restart-dialog-worker-override.test.ts` | COR-164 |  |
| `weft.workers.diagnostics` | exposed | `src/routes/workers/workers-data.ts` |  | `src/routes/workers/workers-manifest-data.test.ts` | COR-124, COR-162 |  |
| `weft.workers.drain` | exposed | `src/routes/workers/workers-data.ts` |  | `src/routes/workers/index-actions.test.ts` |  |  |
| `weft.workers.list` | exposed | `src/routes/workers/workers-data.ts` |  | `src/routes/workers/index.test.ts` |  |  |
| `weft.workers.rejections` | exposed | `src/routes/workers/workers-data.ts` |  | `src/routes/workers/index.test.ts` |  |  |
| `weft.workers.resume` | exposed | `src/routes/workers/workers-data.ts` |  | `src/routes/workers/index-actions.test.ts` |  |  |
| `weft.workflows.active.get` | exposed | `src/routes/system/workflow-revisions-panel.svelte` |  | `src/routes/system/workflow-revisions-panel-activation.test.ts` |  |  |
| `weft.workflows.activities.pending.list` | exposed | `src/routes/workflows/detail/async-activity/async-activity-query.ts` |  | `src/routes/workflows/detail/async-activity/async-activity-query.test.ts` |  |  |
| `weft.workflows.aggregate` | exposed | `src/routes/workflows/aggregate/aggregate-view.svelte` |  | `src/routes/workflows/aggregate/aggregate-view.test.ts` |  |  |
| `weft.workflows.attributes.get` | exposed | `src/routes/workflows/detail/attributes/attributes-data.ts` |  | `src/routes/workflows/detail/attributes/attributes-panel.test.ts` | COR-1461 |  |
| `weft.workflows.attributes.set` | exposed | `src/routes/workflows/detail/attributes/attributes-data.ts` |  | `src/routes/workflows/detail/attributes/attributes-panel.test.ts` | COR-1461 |  |
| `weft.workflows.bulk.cancel` | exposed | `src/routes/workflows/list/bulk-operations-client.ts` |  | `src/routes/workflows/list/bulk-operations-client.test.ts` |  |  |
| `weft.workflows.bulk.delete` | exposed | `src/routes/workflows/list/bulk-operations-client.ts` |  | `src/routes/workflows/list/bulk-operations-client.test.ts` |  |  |
| `weft.workflows.bulk.retryfailed` | exposed | `src/routes/workflows/list/bulk-operations-client.ts` |  | `src/routes/workflows/list/bulk-operations-client.test.ts` |  |  |
| `weft.workflows.bulk.signal` | exposed | `src/routes/workflows/list/bulk-operations-client.ts` |  | `src/routes/workflows/list/bulk-operations-client.test.ts` |  |  |
| `weft.workflows.bulk.tags` | exposed | `src/routes/workflows/list/bulk-operations-client.ts` |  | `src/routes/workflows/list/bulk-operations-client.test.ts` |  |  |
| `weft.workflows.cancel` | exposed | `src/routes/workflows/runs/run-engine.svelte.ts` | `cancel` | `src/routes/workflows/runs/run-detail-engine.test.ts` |  |  |
| `weft.workflows.checkpoints.get` | exposed | `src/routes/workflows/detail/checkpoints/checkpoints-data.ts` |  | `src/routes/workflows/detail/checkpoints/checkpoints-data.test.ts` |  |  |
| `weft.workflows.checkpoints.list` | exposed | `src/routes/workflows/detail/checkpoints/checkpoints-data.ts` |  | `src/routes/workflows/detail/checkpoints/checkpoints-data.test.ts` |  |  |
| `weft.workflows.definitions.get` | not-in-dashboard |  |  |  |  | Weft's own dashboard lists a workflow's revisions through `weft.workflows.revisions.list` and its registry from `weft.system.registry`; the definitions catalog serves the Interborough workflows page. |
| `weft.workflows.definitions.list` | not-in-dashboard |  |  |  |  | Weft's own dashboard lists a workflow's revisions through `weft.workflows.revisions.list` and its registry from `weft.system.registry`; the definitions catalog serves the Interborough workflows page. |
| `weft.workflows.events.list` | exposed | `src/routes/workflows/detail/events-tab.svelte` | `getEvents` | `src/routes/workflows/detail/events-tab.test.ts` |  |  |
| `weft.workflows.finalizer.get` | exposed | `src/routes/workflows/detail/workflow-observability.ts` |  | `src/routes/workflows/detail/workflow-observability.test.ts` |  |  |
| `weft.workflows.fork` | exposed | `src/routes/workflows/detail/checkpoints/fork-dialog.svelte` | `fork` | `src/routes/workflows/detail/checkpoints/fork-dialog.test.ts` |  |  |
| `weft.workflows.get` | exposed | `src/routes/workflows/runs/run-engine.svelte.ts` | `get` | `src/routes/workflows/runs/run-detail-engine.test.ts` | COR-164 |  |
| `weft.workflows.list` | exposed | `src/routes/workflows/list/workflow-list.svelte` | `list` | `src/routes/workflows/list/workflow-list.test.ts` |  |  |
| `weft.workflows.logs.list` | exposed | `src/routes/workflows/detail/steps/step-logs.ts` |  | `src/routes/workflows/detail/steps/step-logs.test.ts` | COR-1811, COR-1860 |  |
| `weft.workflows.purge` | exposed | `src/routes/workflows/list/bulk-operations-client.ts` |  | `src/routes/workflows/list/bulk-operations-client.test.ts` |  |  |
| `weft.workflows.query` | exposed | `src/routes/workflows/runs/run-engine.svelte.ts` | `query` | `src/routes/workflows/runs/run-detail-engine.test.ts` |  |  |
| `weft.workflows.refresh` | exposed | `src/routes/system/refresh-panel.svelte` |  | `src/routes/system/refresh-panel-actions.test.ts` | COR-166 |  |
| `weft.workflows.refresh.diagnostics` | exposed | `src/routes/system/refresh-panel.svelte` |  | `src/routes/system/refresh-panel.test.ts` | COR-166 |  |
| `weft.workflows.replay` | exposed | `src/routes/workflows/detail/checkpoints/checkpoints-data.ts` | `replayTo` | `src/routes/workflows/detail/checkpoints/checkpoints-data.test.ts` |  |  |
| `weft.workflows.result.get` | not-in-dashboard |  |  |  |  | Workflow detail shows the result from the `weft.workflows.get` state it already loads, and this operation waits for the run to settle, which would hold a dashboard request open. |
| `weft.workflows.resume` | exposed | `src/routes/workflows/runs/run-engine.svelte.ts` | `resume` | `src/routes/workflows/runs/run-detail-engine.test.ts` |  |  |
| `weft.workflows.revisions.activate` | exposed | `src/routes/system/workflow-revisions-panel.svelte` |  | `src/routes/system/workflow-revisions-panel-activation.test.ts` |  |  |
| `weft.workflows.revisions.get` | exposed | `src/routes/system/revision-detail.svelte` |  | `src/routes/system/revision-detail.test.ts` | COR-1464 |  |
| `weft.workflows.revisions.install` | exposed | `src/routes/system/revision-install-form.svelte` |  | `src/routes/system/revision-install-form.test.ts` | COR-1464 |  |
| `weft.workflows.revisions.list` | exposed | `src/routes/system/workflow-revisions-panel.svelte` |  | `src/routes/system/workflow-revisions-panel-activation.test.ts` |  |  |
| `weft.workflows.revisions.preload` | exposed | `src/routes/system/dynamic-source-panel.svelte` |  | `src/routes/system/dynamic-source-panel.test.ts` |  |  |
| `weft.workflows.scheduleprovenance.get` | exposed | `src/routes/workflows/detail/lineage-panel.svelte` |  | `src/routes/workflows/detail/lineage-panel.test.ts` |  |  |
| `weft.workflows.signal` | exposed | `src/routes/workflows/detail/signals-tab.svelte` | `signal` | `src/routes/workflows/detail/signals-tab.test.ts` |  |  |
| `weft.workflows.start` | exposed | `src/routes/workflow-definitions/run-setup-form.svelte` | `start` | `src/routes/workflow-definitions/run-setup.test.ts` | COR-164, COR-1855 |  |
| `weft.workflows.startorsignal` | exposed | `src/routes/workflows/detail/restart-dialog.svelte` | `startOrSignal` | `src/routes/workflows/detail/restart-dialog.test.ts` |  |  |
| `weft.workflows.streams.chunks` | exposed | `src/routes/workflows/detail/streams/stream-chunks-data.ts` |  | `src/routes/workflows/detail/streams/stream-chunks-view.test.ts` | COR-1462 |  |
| `weft.workflows.suspend` | exposed | `src/routes/workflows/runs/run-engine.svelte.ts` | `suspend` | `src/routes/workflows/runs/run-detail-engine.test.ts` |  |  |
| `weft.workflows.tags.add` | exposed | `src/routes/workflows/runs/run-tags.svelte` | `addTags` | `src/routes/workflows/runs/run-tags.test.ts` |  |  |
| `weft.workflows.tags.remove` | exposed | `src/routes/workflows/runs/run-tags.svelte` | `removeTags` | `src/routes/workflows/runs/run-tags.test.ts` |  |  |
| `weft.workflows.timeline.get` | exposed | `src/routes/workflows/detail/timeline-tab.svelte` | `getTimeline` | `src/routes/workflows/detail/timeline-tab.test.ts` |  |  |
| `weft.workflows.timeout` | exposed | `src/routes/workflows/runs/run-engine.svelte.ts` | `timeout` | `src/routes/workflows/runs/run-detail-engine.test.ts` |  |  |
| `weft.workflows.update` | exposed | `src/routes/workflows/detail/updates/updates-data.ts` |  | `src/routes/workflows/detail/updates-tab.test.ts` | COR-1463 |  |
| `weft.workflows.updates.list` | exposed | `src/routes/workflows/detail/updates/updates-data.ts` |  | `src/routes/workflows/detail/updates-tab.test.ts` | COR-1463 |  |
| `feed:workflow-events:sse` | exposed | `src/lib/live-source/workflow-tail-source.svelte.ts` |  | `src/lib/live-source/workflow-tail-source.test.ts` |  |  |
| `feed:workflow-events:websocket` | not-in-dashboard |  |  |  |  | The workflow tail reads the per-workflow feed over SSE so it can resume from its last cursor with `Last-Event-ID`, and the `/watch` WebSocket channel is live-only and carries no cursor. |
| `feed:fleet-events:sse` | exposed | `src/lib/live-source/fleet-event-source.svelte.ts` |  | `src/lib/live-source/fleet-event-source.test.ts` |  |  |
| `feed:fleet-events:websocket` | not-in-dashboard |  |  |  |  | The dashboard reads the fleet feed over SSE, which carries the same fleet events as the `weft.events.subscribe` WebSocket subscription. |
| `metrics:prometheus` | not-in-dashboard |  |  |  |  | `GET /v1/metrics` serves Prometheus text for a scraper, and the Metrics tab reads the same collector as JSON through `weft.system.metrics`. |
| `traces:opentelemetry` | not-in-dashboard |  |  |  |  | Weft exports traces to an OpenTelemetry collector and does not serve them, so there is nothing for the dashboard to read. |
| `audit:authentication` | tracked |  |  |  | COR-1465 |  |
| `mount:console` | exposed | `src/host/host.ts` |  | `src/host/host.test.ts` | COR-1488 |  |
