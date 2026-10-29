# Implementation file sizes

`bun run lint` fails when an implementation file under `src/` or `scripts/` grows past 500 lines without an entry in the registry that `scripts/check-implementation-file-sizes.ts` holds. The limit is a prompt to look for a seam, not a hard ceiling: some files are legitimately one unit, and the registry is where we record which, and why.

The table below is generated from that registry and asserted against it byte-for-byte by `scripts/check-implementation-file-sizes.test.ts`, so a classification cannot be added in code without also being visible here.

## Classifications

A **justified exception** is a file that is one cohesive unit at its current size: splitting it would scatter a single contract, duplicate shared machinery, or fragment an order the code depends on. It is not expected to shrink.

A file **tracked separately** has a real seam and is expected to be split; the refactor is its own change with its own review, not something folded into whatever work happened to measure the file. Adding an entry here to avoid doing that split is the one thing this registry must not be used for.

The check also fails when a classified file drops to 500 lines or fewer, so a classification cannot outlive the condition that earned it.

## Registry

| File | Classification | Rationale |
| --- | --- | --- |
| `scripts/validate-package-consumers.ts` | Justified exception | The packed-consumer regression suite `bun run prepack` drives is deliberately one script so every "install the built tarball and exercise a real consumer scenario" check shares one pack/install/cleanup lifecycle; splitting it would scatter that lifecycle across files. |
| `scripts/check-coverage.ts` | Justified exception | Coverage allowances, LCOV parsing, and adjusted-total reporting stay together so the coverage gate has one auditable policy owner. |
| `src/core/engine/index.ts` | Tracked separately | The Engine declaration surface is tracked by local task 3765ffa6-1430-4be5-970c-c0f984ff34df; this issue excludes that refactor. |
| `src/core/types/options.ts` | Justified exception | Every engine and lifecycle options interface (StartOptions, ForkOptions, EngineOptions, and their siblings) lives here as one public import surface with runnable @example JSDoc per field — splitting would scatter one import contract across multiple subpaths. WFT-21 pushed it over the ceiling by ~19 lines documenting ForkOptions.revision; the file was already at 498/500 lines before that addition. COR-1281 raised its single-file lint ceiling for a complete two-mode ActivityExecutionOptions example, not for new logic. |
| `src/client/client-contract.test-support.ts` | Justified exception | The shared client contract harness intentionally keeps cross-transport behavior assertions in one reusable test-support module. |
| `src/core/engine/state-utilities.ts` | Justified exception | Workflow state decoding, summaries, filters, and debug sanitization are coupled around the persisted workflow-state boundary. |
| `scripts/snapshot-public-api.ts` | Justified exception | Public API snapshotting keeps export traversal, declaration capture, and snapshot comparison together as one release-surface audit. |
| `src/client/interface.ts` | Justified exception | The public client interface keeps transport-uniform overloads, handles, schedules, reviews, and stream contracts in one type surface. |
| `src/core/engine/termination/complete.ts` | Justified exception | Terminal completion coordinates status transitions, timers, indexes, waiters, events, and cleanup from one status gate. |
| `src/worker/index.ts` | Justified exception | The worker entrypoint keeps registration, protocol negotiation, dispatch, completion, heartbeat, and shutdown behavior together. |
| `src/worker/registry.ts` | Justified exception | WorkerRegistry is the single in-memory state store for connected workers, in-flight tasks, and the bounded registration-rejection log (WFT-29); routing, fair-share, drain, consistency, and summary logic are already extracted into sibling modules under registry/. |
| `scripts/verify-tree-shaking.ts` | Justified exception | Tree-shaking verification keeps build setup, bundle inspection, source-map checks, and package export assertions in one audit. |
| `src/core/types/workflow-builder.ts` | Justified exception | Workflow-builder types form one fluent type-state contract where splitting would obscure the compile-time state transitions. |
| `src/client/http-client.ts` | Justified exception | The HTTP client class centralizes the transport implementation behind the public client interface without preserving old import paths. |
| `src/workers/workflow-runner.ts` | Justified exception | Worker-runner message handling, replay, context wiring, and result reporting stay together as the worker isolate boundary. |
| `src/core/engine/checkpoint-io.ts` | Justified exception | Checkpoint I/O owns decode, encode, chunk, archive, and retention behavior around one durable checkpoint boundary. |
| `scripts/husky/run-tests.ts` | Justified exception | The hook test runner keeps staged-file routing, load-sensitive exclusions, and diagnosable output in one local hook command. |
| `src/core/context/index.ts` | Justified exception | Workflow context exposes the generator-facing API surface; splitting it would make one context contract harder to inspect. |
| `src/core/types/workflow-context.ts` | Justified exception | Workflow-context types define one public generator API contract whose overloads and helper result types need local adjacency. |
| `src/server/operations/bulk-filter-helpers.ts` | Justified exception | Bulk filter helpers keep REST, JSON-RPC, preview, and commit parsing aligned for the shared bulk-operation contract. |
| `src/server/index.ts` | Justified exception | The server entrypoint owns the public serve surface and exported server types; further splitting would create shallow re-export files. |
| `src/core/worker-protocol.ts` | Justified exception | Worker protocol types and validators stay together so wire messages, limits, and validation errors remain one auditable contract. |
| `src/mcp/tools.ts` | Justified exception | MCP tool schemas and handlers are intentionally adjacent so tool metadata and operation dispatch cannot drift. |
| `src/storage/web-extension.ts` | Justified exception | WebExtension storage keeps namespace detection, callback/promise bridging, quota handling, and scans in one adapter boundary. |
| `src/core/engine/operations-coordination.ts` | Justified exception | Coordination operations keep race, all, nested signal, and branch-dispatch semantics together around one coordinator boundary. |
| `src/core/engine/operations-activity.ts` | Justified exception | Activity operations coordinate interceptors, retries, reconciliation, async completion, verification, and result feeding together. |
| `src/core/engine/signals.ts` | Justified exception | Signal buffering, waiter tracking, payload validation, and atomic consumption share one durable signal-delivery contract. |
| `src/client/http-client-requests.ts` | Justified exception | HTTP request helpers are grouped by one client transport and mostly sit just above the threshold; splitting would add routing noise. |
| `src/core/engine/source-resolution.ts` | Justified exception | The single-flight load -> validate -> install pipeline, its cancellation/disposal races, and the per-caller waiter bookkeeping around it are one cohesive state machine that resists further splitting without scattering that machine across files. WFT-21 (Codex review round 14, P1 item Q7jH) pushed it over the ceiling by adding a durable removal-generation fence read before the host loader runs; the file was already at exactly 500/500 lines before that addition. |
| `src/server/runtime/task-dispatch.ts` | Justified exception | Dispatch and cancel are two directions of one ledger transition machine: both derive the same attempt token, drive the same conditional batch, and co-commit the same async-activity resolution writes. Separating them would duplicate that machinery on both sides. |
| `src/server/runtime/websocket-worker.ts` | Justified exception | One WebSocket message dispatcher whose branches all mutate the same per-connection lease and attempt state; the task-result variant parsing it delegates to already lives in siblings. |
| `src/core/engine/construction.ts` | Justified exception | Engine construction is one ordered assembly — storage defaulting, interceptor composition, broker and dispatcher wiring — whose steps are order-dependent on each other and on initializeInternals. Splitting it scatters an initialization order that replay determinism depends on. |
| `src/server/runtime/task-reconciliation.ts` | Justified exception | The orphaned-record scanners share one tracked-record predicate and one visibility-timeout model; separating the scanners would duplicate both and let them drift apart. |
| `src/core/engine/workflow-claim-registry.ts` | Justified exception | The stateful claim unit specified by ADR 0002 — acquire, renew, release, takeover, release-all, plus the two-step fold seam — over pure transition fragments that already live in workflow-claim-transitions.ts. The unit is the file. |
| `src/core/engine/handles.ts` | Justified exception | WorkflowHandle is one public object whose methods all close over the same engine and workflow identity; splitting by method group would expose that shared closure as parameters on every call. |
| `src/core/engine/lifecycle/prepare-and-launch.ts` | Justified exception | COR-75s two-phase prepare()/launch() surface is deliberately one file so it stays visibly derived from startWorkflow()s existing commit/begin boundary rather than reimplementing admission, reservation, and ownership semantics separately. |
| `src/core/engine/lifecycle/start.ts` | Justified exception | startWorkflow() is the one admission, reservation, and create-commit path every start funnels through, and prepare-and-launch.ts is derived from it; splitting its ordered checks across files would hide the order the duplicate-id and revision fences depend on. |
| `src/core/engine/internals.ts` | Justified exception | The EngineInternals declaration is the engine state kernel: one type whose every field carries the doc comment explaining what reads and writes it. It is a declaration surface, like core/types/options.ts, not logic that can be extracted. |
| `src/core/engine/async-activity-records.ts` | Justified exception | Two record shapes sharing one async-act:v1: keyspace, discriminated by decode guards rather than key shape — so their encoders, guards, and batch builders have to be read together. The completion orchestration is already a sibling. |
| `src/worker/protocol.ts` | Justified exception | The canonical parser trust boundary, already split: wire-shape types, JSON Schema documents, the taskResult variant parser, and internal helpers each live in their own sibling and are re-exported here so the public surface stays one import path. |
| `src/server/serve-internals.ts` | Justified exception | Already the product of a split — these are the helpers extracted from serve() to reduce its cyclomatic complexity, kept together as one @internal unit behind that one entry point. |
| `src/core/engine/termination/cleanup.ts` | Justified exception | Terminal cleanup sweeps every durable keyspace a workflow owns from one status gate, five lines over the ceiling; splitting by keyspace would fragment a sweep that must stay exhaustive and ordered. |
