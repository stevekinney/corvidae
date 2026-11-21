# Velveteen execution record

## Accepted batch Z pinned inventory audit

The [pinned inventory audit](./tests/inventory/README.md#batch-z-audit) distinguishes ownership of 2,658 tracked test-shaped files and 195 scripts from behavior observed in the fixtures. The reconciliation matched all 28 shared fixture IDs exactly once per runtime and mode, with 58 named upstream cases in nine pinned source files. Four selected Batch C routing entries are accounted for separately. The audit records deliberate differences and unverified browser, configuration, remote and adapter coverage. Independent review cleared the accounting and provenance. [Machine-readable audit](./.velveteen/evidence/batch-z-audit.json)

`bun run test:inventory` passed independently. The full `bun run test:batch-j` included `bun run test:runtime-controls` and passed with 312 Bun test executions, zero failures and 112 observations across 28 cases. Development and production each passed on Velveteen and Kit. The source digest was `bfc6ac2a4efcca7e6d14a523ac17521c123cff5d9e4864d9e9674e71f161ac08` before and after. Both Corvidae checkouts match the recorded Batch Q baselines. [Inventory](./.velveteen/evidence/batch-z-inventory.log) · [Runtime controls](./.velveteen/evidence/batch-z-runtime-controls.json) · [Full result](./.velveteen/evidence/batch-z-result.json) · [Regression log](./.velveteen/evidence/batch-z-regression.log) · [Corvidae comparison](./.velveteen/evidence/batch-z-corvidae-comparison.json)

Files changed for Z include `EXECUTION.md`, `FEASIBILITY.md`, `tests/inventory/README.md` and `tests/inventory/routing-cases.json`. This closes the fixture program through Z.

## Accepted batch Y relocated artifact compression

The host can opt in to native streamed Brotli and gzip for emitted text assets through `createProductionAssetRoutes(generation, { compression: true })`. The route negotiates quality weights, selects representation-specific validators and uses identity for byte ranges when the client accepts it. The default serving path retains native identity range behavior. The relocated artifact ran outside the workspace with application source removed and no ancestor installation. Both compressed wire bodies decoded to the manifest digest, including a separate Brotli check for an emitted JavaScript asset. [Wire evidence](./.velveteen/evidence/batch-y-compression.json) · [Pinned behavior references](./.velveteen/evidence/batch-y-provenance.json)

Two workers owned separate serving and artifact surfaces. The coordinator added a causal test for an opt-out range regression before correcting it, then independent review cleared the final changes. Shared-account token and cost telemetry is unavailable. Focused serving, package, artifact audit and prerender gates passed. [Opt-out control](./.velveteen/evidence/batch-y-default-first.log) · [Serving](./.velveteen/evidence/batch-y-serving.log) · [Package](./.velveteen/evidence/batch-y-package.log) · [Artifact audit](./.velveteen/evidence/batch-y-artifact-audit.log) · [Prerender](./.velveteen/evidence/batch-y-prerender.log)

The full Batch J gate passed with 312 Bun test executions, zero failures and 112 observations across 28 runtime cases. The source digest was `571a7055eff87488ff2596910d97ef027db28a6ff4eeb977d5a54c69219dced8` before and after. [Full result](./.velveteen/evidence/batch-y-result.json) · [Regression log](./.velveteen/evidence/batch-y-regression.log)

Files changed for Y include `EXECUTION.md`, `FEASIBILITY.md`, `package.json`, `src/build/serving.ts`, `tests/build/serving.test.ts`, `tests/build/fixture-host.ts`, `tests/build/pack-production-fixture.ts`, `tests/build/production-process.ts`, `tests/build/package.test.ts` and `tests/build/run-production-fixture.ts`.

## Accepted batch V automatic remote behavior

The user chose cached queries, automatic batching and dedicated progressive forms. Each client owns its cache. Same-turn reads share a query-only exchange and equal inputs are deduplicated. A batch definition resolves validated inputs once. Per-entry failure and an unserializable value leave successful siblings usable. Commands can refresh cached queries in the command response, and late query results preserve the newer cache value. [Remote checks](./.velveteen/evidence/batch-v-remote.log) · [Types](./.velveteen/evidence/batch-v-types.log)

A dedicated form uses the registered handler, original request event and existing form transport. Native submission preserves the ordinary query with scripting disabled. Enhanced submission reports validation issues and retains its document. A compiled context fixture rejects a foreign origin before executing the handler. [Actions](./.velveteen/evidence/batch-v-actions.log) · [Request context](./.velveteen/evidence/batch-v-remote-form-context.log)

Both modes passed the pinned comparison. Cached rereads make no request, refreshing the rows makes one request, and a command refreshes both views in one exchange. The split-batch control makes four requests and fails the unchanged count assertion, then the restored fixture passes. Kit's initial server-rendered missing query returns a 404 document. Velveteen loads the client cache after mount and serves a 200 document. Both show the missing entry without dropping successful rows. [Development](./.velveteen/evidence/batch-v-development.log) · [Production](./.velveteen/evidence/batch-v-production.log) · [Controls](./.velveteen/evidence/batch-v-controls.json) · [Pinned sources](./.velveteen/evidence/batch-v-provenance.json)

Independent review cleared. The full Batch J gate passed with 312 Bun test executions, zero failures and 112 observations across 28 runtime cases. The source digest was `de0538255ade5b2cb267d80d9911187de311dbc2604d6d9fa24801b853313320` before and after. [Full result](./.velveteen/evidence/batch-v-result.json) · [Regression log](./.velveteen/evidence/batch-v-regression.log)

Files changed for V include `EXECUTION.md`, `FEASIBILITY.md`, `package.json`, `src/actions/server.ts`, `src/remote/client.ts`, `src/remote/forms.ts`, `src/remote/protocol.ts`, `src/remote/server.ts`, `src/server/index.ts`, `src/server/types.ts`, `tests/actions/actions.test.ts`, `tests/conformance/README.md`, `tests/conformance/runtime-cases.ts`, `tests/conformance/runtime-controls.ts`, `tests/conformance/runtime-fixture.ts`, `tests/conformance/runtime-host.ts`, `tests/conformance/runtime-remote-definitions.ts`, `tests/conformance/runtime-remotes.ts`, `tests/inventory/runtime-cases.json`, `tests/remote/check-types.ts`, `tests/remote/remote.test.ts` and `tests/server/mutations.test.ts`.

## Accepted batch X request tracing

`createApplication({ onTrace })` accepts an optional observer for completed request, server load, server-rendered universal load and page action spans. Each span records a trace ID, span ID, parent ID, route ID, elapsed timing and outcome. A compiled app verifies independent overlapping traces, semantic 422 over the enhanced transport's HTTP 200, sanitized load and action errors, and cancellation before and after response headers. A failing observer leaves the application response usable. [Focused fixture](./.velveteen/evidence/batch-x-candidate.log) · [Pinned behavior references](./.velveteen/evidence/batch-x-provenance.json)

The regression exposed browser timing in the existing recovery fixture and a separate watcher-test counting error. The hash-matched W control reproduced the recovery failure. The fixture now matches each data request to its network completion before a forced document transition. Eight complete focused runs passed. The watcher regression now asserts recovery and exact error propagation independently of duplicate native notifications. The isolated W and X package smoke tests passed after a full-run timeout under concurrent probe activity. [Recovery control](./.velveteen/evidence/batch-x-navigation-W-1.log) · [Focused reruns](./.velveteen/evidence/batch-x-navigation-restored.json) · [Watcher result](./.velveteen/evidence/batch-x-routing.log) · [Package controls](./.velveteen/evidence/batch-x-package-consumer-controls.json)

Independent review cleared and the serial `bun run test:batch-j` passed with 301 Bun test executions, zero failures and 104 runtime observations. The source digest was `0e4b82c54b9e1f579b3d50d37537d1c3ff512ca0cb0ffef31145ff4af9395684` before and after. [Full result](./.velveteen/evidence/batch-x-result.json) · [Regression log](./.velveteen/evidence/batch-x-regression.log)

Files changed for X include `EXECUTION.md`, `FEASIBILITY.md`, `src/data/loads.ts`, `src/routing/synchronize.test.ts`, `src/server/index.ts`, `src/server/lifetime.ts`, `src/server/loads.ts`, `src/server/tracing.ts`, `src/server/types.ts`, `tests/client/navigation-recovery-bootstrap.ts`, `tests/client/navigation-recovery-fixture.ts`, `tests/client/navigation-recovery.test.ts` and `tests/server/tracing.test.ts`.

## Accepted batch W retired graph lifetime

`application.retire()` stops new dynamic admissions and waits for requests and response bodies to finish. An already-admitted stream may still use its original application's internal fetch. A captured fetch loses that access when its owning request finishes. Consumer cancellation propagates immediately to the request signal and waits for asynchronous producer cleanup before release. Forceful disposal remains available for host shutdown.

The published development fixture reads the first A chunk before `server.reload()`, serves B from the same listener and finishes the A stream with data from A's compiled endpoint. A direct response consumer verifies one prefetched chunk while paused, bounded pulling after a read and cancellation waiting for producer cleanup. Repeated reloads keep one current graph and at most one outgoing graph. Every retired graph rejects a subsequent import. An invalid build preserves H. [Runtime lifecycle](./.velveteen/evidence/batch-w-runtime.log) · [Development](./.velveteen/evidence/batch-w-development.log)

The first full run caught a directory being removed during the recursive route scan. Hash-matched U and W routing code independently reproduced the descendant `ENOENT`. The watcher now rescans once when the disappearing path is inside the route root. The regression distinguishes that case from a missing root and checks that real duplicate-parameter diagnostics remain visible. [U control](./.velveteen/evidence/batch-w-routing-U-6.log) · [W reproduction](./.velveteen/evidence/batch-w-routing-W-6.log) · [Causal regression](./.velveteen/evidence/batch-w-routing-causal.log)

Independent review cleared. The full Batch J gate passed with 299 Bun test executions, zero failures and 104 runtime observations. The source digest was `fdc053853601a6a00b6ac2061da740025aff84dff2f4fb9d32e3bb52fc9f8de8` before and after. [Full result](./.velveteen/evidence/batch-w-result.json) · [Regression log](./.velveteen/evidence/batch-w-regression.log)

Files changed for W include `EXECUTION.md`, `FEASIBILITY.md`, `src/routing/synchronize.ts`, `src/routing/synchronize.test.ts`, `src/server/index.ts`, `src/server/lifetime.ts` and `tests/lifecycle/application-publication.test.ts`.

## Accepted batch U action transport and upload limits

The pinned comparison covers native POST with JavaScript disabled, a browser navigation POST whose hydrated page invokes the revived custom method, and an enhanced POST that retains the document and invokes the revived method. Development and production passed. Returning a plain object in place of the enhanced instance fails the named class-identity assertion. Restoring the decoder passes. [Pinned sources](./.velveteen/evidence/batch-u-provenance.json) · [Development](./.velveteen/evidence/batch-u-development.log) · [Production](./.velveteen/evidence/batch-u-production.log) · [Controls](./.velveteen/evidence/batch-u-controls.json)

A real Bun host sizes the complete serialized multipart body, including its boundary and headers. Below-limit and exact-limit bodies reach the action. One byte over returns 413 for fixed-length and chunked requests, with the action count unchanged. The oversized fixed-length request never enters the application. The chunked request enters the application and native form parsing prevents action execution. [Actions](./.velveteen/evidence/batch-u-actions.log) · [Server](./.velveteen/evidence/batch-u-server.log)

Independent review cleared. The first full gate found a strict test-fixture type mismatch. The corrected test uses an `ArrayBuffer`-backed typed array and Bun's native request streaming. The complete `bun run test:batch-j` rerun passed with 298 Bun test executions, zero failures and 104 observations across 26 runtime cases. The source digest was `a28f8e3355ecf75626d85deae6ac6649405f7e32b52e61048c1bda1e859272cb` before and after. [Exact run](./.velveteen/evidence/batch-u-result.json) · [Regression log](./.velveteen/evidence/batch-u-regression.log)

Files changed for U include `EXECUTION.md`, `FEASIBILITY.md`, `tests/actions/upload-limit.test.ts`, `tests/conformance/runtime-action-transport.ts`, `tests/conformance/runtime-actions-fixture.ts`, `tests/conformance/runtime-cases.ts`, `tests/conformance/runtime-controls.ts`, `tests/conformance/runtime-custom-transport.ts` and `tests/inventory/runtime-cases.json`.

## Accepted batch T TypeScript starter

From Velveteen, run `bun run create <empty-directory>`. The app includes a local framework archive and exact declaration pins. From the app directory, `bun install` resolves the installed framework, `bun run check` generates route declarations and runs strict TypeScript and Svelte checking, and `bun run dev` serves the development graph. `bun run build` emits the production generation and `bun run start` serves it.

Independent review cleared the exclusive directory claim. The installed-consumer probe verifies concurrent creation admits one writer, preserves existing files, rejects invalid TypeScript with `TS2322`, hydrates the counter in development and serves production after moving the route source away. [Package consumer](./.velveteen/evidence/batch-t-package-consumer.log) · [Types](./.velveteen/evidence/batch-t-types.log)

`bun run test:batch-j` passed with 297 Bun test executions, zero failures and 100 runtime observations. The source digest was `2c4733ef5c32b0c8f42c2d21df3ffed24b4015e640ab4148672d4136a8e42886` before and after. An earlier run recorded a browser reporting a canceled data fetch during navigation recovery. A hash-matched Batch S control and the Batch T candidate both passed the isolated suite and 12 interleaved runs of the specific case. The complete rerun kept the original assertions and limits. [Passed run](./.velveteen/evidence/batch-t-result.json) · [Initial failure](./.velveteen/evidence/batch-t-regression-first.log) · [Paired checks](./.velveteen/evidence/batch-t-navigation-paired.json)

Files changed for T include `EXECUTION.md`, `FEASIBILITY.md`, `package.json`, `src/create.ts` and `tests/build/starter-probe.ts`.

## Accepted batch S ordered middleware and typed locals

The server exports `sequence` over the existing handle contract. The real app fixture verifies pre- and post-order on pages, endpoints, actions and remotes, short-circuit responses for all four, overlapping request-local isolation and forwarded event context. A focused test verifies synchronous throws reject through the next handler promise. The selected Kit witness is the ordered sequencing case. [Focused runtime checks](./.velveteen/evidence/batch-s-runtime.log) · [Pinned case identity](./.velveteen/evidence/batch-s-provenance.json)

Applications declare fields on the TypeScript `VelveteenLocals` interface. The request-local record starts empty and makes declared fields optional until assigned. Strict fixtures exercise declared fields in hooks, generated handlers, actions, loads and remotes. They reject a wrong property type and access to a declared field before narrowing. [Type gate](./.velveteen/evidence/batch-s-types.log)

Independent review and `bun run test:batch-j` passed with 297 Bun test executions, zero failures and 100 runtime observations. The source digest remained `d6935c6e552780c0b0c5d509fd40820e9ae43af27a3eaffda55ae5b8d7dab56b`. Batch S wrote exclusively inside Velveteen. Shared-account token and cost telemetry is unavailable. [Full result](./.velveteen/evidence/batch-s-result.json) · [Regression log](./.velveteen/evidence/batch-s-regression.log)

Files changed for S:

- `EXECUTION.md`
- `FEASIBILITY.md`
- `src/server/index.ts`
- `src/server/server.test.ts`
- `src/server/types.ts`
- `tests/server/mutations.test.ts`
- `tests/types/generated/consumer-fixtures.ts`

## Accepted batch R escaped route filenames

The user authorized autonomous delivery of R through Z in Velveteen fixtures and chose static precedence for escaped filenames. Pinned Kit 3.3.0 selects `[value]` ahead of its sibling `[u+1f600]` for the emoji URL. Velveteen selects the escaped literal. Both runtimes select the escaped Unicode route when it stands alone. The explicit comparison passed in development and production. [Development](./.velveteen/evidence/batch-r-final-development.log) · [Production](./.velveteen/evidence/batch-r-final-production.log) · [Pinned sources](./.velveteen/evidence/batch-r-provenance.json)

Routing tests verify malformed escapes, literal precedence and conflict detection. Generated declarations expose only actual parameters. A structured prerender entry serves the encoded path and preserves parameter text that resembles a filename escape. The corrupted browser link double-encodes the hash, reaches the dynamic route and fails the unchanged static-route assertion. The restored run passes. [Routing](./.velveteen/evidence/batch-r-routing.log) · [Types](./.velveteen/evidence/batch-r-types.log) · [Prerender](./.velveteen/evidence/batch-r-prerender.log) · [Controls](./.velveteen/evidence/runtime-controls.json)

Independent review cleared. `bun run test:batch-j` exited 0 with 295 passing Bun executions, zero failures and 100 runtime observations across 25 cases. The source digest `7e33466e42a9c943da5d6bcf2b17b00e62bfc703d7226bce51e213b81d4073e6` was unchanged. Batch R wrote exclusively inside Velveteen. Shared-account token and cost telemetry is unavailable. [Complete result](./.velveteen/evidence/batch-r-result.json) · [Regression log](./.velveteen/evidence/batch-r-regression.log)

Files changed for R:

- `EXECUTION.md`
- `FEASIBILITY.md`
- `src/prerender/entries.ts`
- `src/routing/grammar.ts`
- `src/routing/matcher.test.ts`
- `src/routing/route-order.test.ts`
- `src/routing/route-order.ts`
- `src/routing/routing.test.ts`
- `tests/conformance/runtime-cases.ts`
- `tests/conformance/runtime-controls.ts`
- `tests/conformance/runtime-fixture.ts`
- `tests/conformance/runtime-route-escapes.ts`
- `tests/inventory/runtime-cases.json`
- `tests/prerender/contracts.test.ts`
- `tests/types/generated/consumer-fixtures.ts`

## Accepted batch Q custom data transport

Batch Q was authorized November 19, 2026, for Velveteen fixtures. The page runtime and comparative fixtures had separate owners. The coordinator integrated snapshots after Q01 passed against reference and candidate in both modes. Independent review cleared the integrated candidate.

Q01 passed against Kit 3.3.0 at `a58e0a92c35dbeee161e96c733464dc7397e073a`. The built server and browser registries load an optional application `src/transport.ts` that exports `transport`. The fixture renders a private-field method result in SSR, hydrates the original DOM, invokes the method in the browser, follows a same-document link and revives a held settlement after its explicit release. A build regression proves that the transport module cannot import server-only code into the browser graph. [Page development before snapshot wiring](./.velveteen/evidence/batch-q-page-development.log) · [Page production before snapshot wiring](./.velveteen/evidence/batch-q-page-production.log)

Q02 passed in both modes. Snapshots apply the same application codec to captured values and restore the instance after `afterNavigate` on same-tab reload. Review identified that devalue treats falsy reducer output as no match. Velveteen wraps matched values so `0`, empty strings, `null` and `undefined` round-trip with `false` reserved for no match. Custom tags are escaped and namespaced. Both comparative cases passed again after that correction. [Final comparisons and pinned source identities](./.velveteen/evidence/batch-q-provenance.json) · [Falsy regression before correction](./.velveteen/evidence/batch-q-falsy-before.log)

Q03 passed. A production fixture reviver returns a plain object for the saved value while retaining its field and restore order. The unchanged `instanceof` assertion fails. The restored run passes the identity check and calls the private-field method. [Control evidence](./.velveteen/evidence/runtime-controls.json)

Q04 passed. `bun run test:batch-j` exited 0 with 291 passing Bun test executions, zero failures and 96 runtime observations across 24 cases in four cells. All 199 recorded source inputs retained digest `ccb1e64a99a1ac888033d98c18f693cb7c348a82bb099da1d57300a5821b91c5` throughout the run. Batch Q made no Corvidae writes. Both Corvidae checkout observations match their pre-batch snapshots. Shared-account token and cost telemetry is unavailable. [Complete result](./.velveteen/evidence/batch-q-result.json) · [Regression log](./.velveteen/evidence/batch-q-regression.log) · [Corvidae comparison](./.velveteen/evidence/batch-q-corvidae-comparison.json)

Files changed for Q:

- `EXECUTION.md`
- `FEASIBILITY.md`
- `src/build/entries.ts`
- `src/build/graph.ts`
- `src/build/index.ts`
- `src/build/manifest-types.ts`
- `src/client/document.ts`
- `src/client/index.ts`
- `src/client/resolve-loaded-page.ts`
- `src/client/snapshots.ts`
- `src/data/codec.ts`
- `src/data/contract.ts`
- `src/data/custom-transport.test.ts`
- `src/data/custom-transport.ts`
- `src/data/transport.ts`
- `src/server/index.ts`
- `src/server/responses.ts`
- `tests/build/build-errors.test.ts`
- `tests/conformance/runtime-cases.ts`
- `tests/conformance/runtime-controls.ts`
- `tests/conformance/runtime-custom-transport.ts`
- `tests/conformance/runtime-fixture.ts`
- `tests/inventory/runtime-cases.json`

## Accepted batch P accessible route announcements

Batch P was authorized November 19, 2026, for Velveteen fixtures. Separate workers implemented the client live region and comparative browser fixture. The coordinator integrated the case, controls and source ledger. Independent review cleared the final candidate.

P01 passed against Kit 3.3.0 at `a58e0a92c35dbeee161e96c733464dc7397e073a` in development and production. The client initializes an empty, visually hidden assertive live region with atomic updates. A link and browser Back announce the settled title. An empty title produces `untitled page`. A same-title shallow transition after hydration populates the region with the currently rendered title, matching Kit. [Development](./.velveteen/evidence/batch-p-development.log) · [Production](./.velveteen/evidence/batch-p-production.log) · [Pinned provenance](./.velveteen/evidence/batch-p-provenance.json)

P02 passed. A separate JavaScript-disabled browser context verifies server-rendered titles and the absence of a live region on direct entry and after a link click. The candidate-only stale-title control substitutes the source title for one destination title read. The destination route and document title stay correct. The unchanged live-region assertion rejects the source title and passes when the control is removed. [Control results](./.velveteen/evidence/runtime-controls.json)

P03 passed. `bun run test:batch-j` exited 0 with 285 passing Bun test executions, zero failures and 88 runtime observations across 22 cases in four cells. All 196 recorded source inputs retained digest `407ae3d6a5069c86e5a0178491846f3cf59ced018b3e76e397601c4487e5582d` throughout the run. Batch P made no Corvidae writes. Corvidae's primary checkout advanced independently during the run. Both working-tree statuses and patch hashes match their pre-batch observations. Shared-account token and cost telemetry is unavailable. [Complete result](./.velveteen/evidence/batch-p-result.json) · [Regression log](./.velveteen/evidence/batch-p-regression.log) · [Corvidae comparison](./.velveteen/evidence/batch-p-corvidae-comparison.json)

Files changed for P:

- `EXECUTION.md`
- `FEASIBILITY.md`
- `src/client/root.svelte`
- `tests/conformance/runtime-cases.ts`
- `tests/conformance/runtime-controls.ts`
- `tests/conformance/runtime-fixture.ts`
- `tests/conformance/runtime-route-announcements.ts`
- `tests/inventory/runtime-cases.json`

## Accepted batch O shallow routing and snapshots

Batch O was authorized November 19, 2026, for Velveteen fixtures. The shallow routing worker drafted the history implementation and its fixture. The snapshot worker prepared and ran the pinned fixture in parallel, then integrated snapshots after the standalone shallow comparison passed in all four cells. The coordinator integrated the harness and resolved review findings. Independent review cleared the final candidate.

O01 passed against SvelteKit 3.3.0 at `a58e0a92c35dbeee161e96c733464dc7397e073a` in both modes. Shallow push and relative replace preserve the mounted page and load count, expose the intended target to lifecycle hooks, and restore entry state on traversal. Both canceled `goto` and canceled popstate preserve the settled entry. Relative invalidation resolves against the browser address and reloads the rendered route. A hard reload renders the visible route, and subsequent Back and Forward can reactivate the earlier shallow context. The pre-fix candidate lost that state on Forward. [Development](./.velveteen/evidence/batch-o-shallow-final-development.log) · [Production](./.velveteen/evidence/batch-o-shallow-final-production.log) · [Reload regression before correction](./.velveteen/evidence/batch-o-shallow-reload-before.log)

O02 passed in all four cells. Explicit component snapshot IDs associate serializable values with native history entries. The source snapshot is staged before `onNavigate` and stored on a successful history commit. Restoration follows completed hooks on popstate and initial navigation. Same-tab reload uses session storage and abandoned forward entries are pruned on a new push. The fixture mutates the draft during `onNavigate` and verifies the pre-hook value is restored. It also proves distinct shallow entry values, exact `afterNavigate,restore` ordering, reload and branch replacement. [Development](./.velveteen/evidence/batch-o-snapshots-final-development.log) · [Production](./.velveteen/evidence/batch-o-snapshots-final-production.log) · [Capture regression before correction](./.velveteen/evidence/batch-o-snapshot-preparation-before.log)

O03 passed. The runtime controls deliberately restore the wrong draft in the production candidate, require the literal assertion to reject it and rerun the restored candidate. The source ledger names the pinned tests used for both features. [Control evidence](./.velveteen/evidence/runtime-controls.json) · [Pinned provenance](./.velveteen/evidence/batch-o-provenance.json)

O04 passed. `bun run test:batch-j` exited 0 with 285 passing Bun test executions, zero failures and 84 runtime observations across 21 cases in four cells. All 195 recorded source inputs retained digest `b6071355d7ac54941d25a789f46ab8836181dbe95f90c80b9b5fd5dcbb14eaaa` throughout the run. Both Corvidae checkout states and patch hashes match the pre-batch snapshot. Shared-account token and cost telemetry is unavailable. [Complete result](./.velveteen/evidence/batch-o-result.json) · [Regression log](./.velveteen/evidence/batch-o-regression.log) · [Corvidae comparison](./.velveteen/evidence/batch-o-corvidae-comparison.json)

Files changed for O:

- `EXECUTION.md`
- `FEASIBILITY.md`
- `src/client/events.ts`
- `src/client/history.ts`
- `src/client/index.ts`
- `src/client/invalidation.ts`
- `src/client/navigation-context.ts`
- `src/client/navigation-hooks.ts`
- `src/client/preloads.ts`
- `src/client/resolve-loaded-page.ts`
- `src/client/root.svelte`
- `src/client/snapshots.ts`
- `src/client/state.svelte.ts`
- `src/client/types.ts`
- `src/data/contract.ts`
- `src/server/render.ts`
- `tests/conformance/runtime-cases.ts`
- `tests/conformance/runtime-controls.ts`
- `tests/conformance/runtime-fixture.ts`
- `tests/conformance/runtime-shallow.ts`
- `tests/conformance/runtime-snapshots-fixture.ts`
- `tests/conformance/runtime-snapshots.ts`
- `tests/inventory/runtime-cases.json`

## Accepted batch M optional and rest-qualified matchers

Batch M was authorized November 19, 2026, for Velveteen fixtures. The routing worker owns grammar, capture assignment, precedence, and focused routing tests. The fixture worker owns pinned Kit development and production observations and the negative control. The coordinator owns type and prerender integration and acceptance. The independent reviewer checks the integrated candidate.

Run the pinned comparison before accepting candidate semantics. Verify omitted optional keys, rejected captures reassigned to later parameters, and empty rest input accepted or rejected by its own matcher. Check single decoding, generated optional and rest types, tracked load updates, structured prerender entries, and exact rejection diagnostics. Then run the full `bun run test:batch-j` gate.

M01–M04 passed. The canonical matcher applies the pinned capture reassignment rules while retaining L's synchronous typed outputs. The shared fixture observes a numeric optional capture, a rejected optional segment reassigned into a qualified rest, an omitted optional key, and a present empty rest. A qualified route accepts a nonempty rest and falls through on empty input. HTTP and Chromium checks pass in development and production. Direct comparisons with the pinned routing implementation also cover multiple optionals, nonterminal rest, suffixes, and escaped percent. The deliberate corruption removes `guide/` from `guide/install`, fails the exact server-rendered parameter assertion, and passes after restoration.

Routing passed 16 tests. The generated consumer gate passed 29 compiler and checker executions with 17 negative controls. Prerender passed 11 tests. A structured entry must select its named route and preserve which optional captures it declares. The fixture verifies empty rest, encoded values, rejected matchers, reassigned parameters, and higher-priority static routes while checking that the prior artifact survives invalid input.

The first full attempt stopped when the existing recovery fixture recorded a canceled healthy-page data fetch. The exact startup phase of the failed request was unconfirmed. Focused traces showed two startup data reads per document. The fixture now mounts the real initial payload with one startup read and serves its non-deferred data with a fixed content length. Both modes record the exact six completed data requests during persistent recovery. Only the deliberately missing script requests fail. Diagnostic assertions and framework streaming stayed intact. Independent review cleared the recovery correction. [First attempt](./.velveteen/evidence/batch-m-attempt-1.log) · [Failed request evidence](./.velveteen/evidence/batch-m-attempt-1-recovery.json) · [Corrected request trace](./.velveteen/evidence/batch-m-recovery-fixture-after.json)

`bun run test:batch-j` exited 0 with 285 passing Bun test executions, zero failures, and 76 runtime observations across 19 cases in four cells. All 187 source inputs retained digest `557c07b5c3aa3480d17fb75c17945a33cbfc1a3cc6961df8d3e80f190b142afa` throughout the run. Both Corvidae checkout states and patch hashes match the Batch M snapshot. Shared-account token and cost telemetry is unavailable. [Complete result](./.velveteen/evidence/batch-m-result.json) · [Regression log](./.velveteen/evidence/batch-m-regression.log) · [Pinned provenance](./.velveteen/evidence/batch-m-provenance.json) · [Corvidae comparison](./.velveteen/evidence/batch-m-corvidae-comparison.json)

Files changed for M:

- `src/prerender/entries.ts`
- `src/prerender/index.ts`
- `src/routing/grammar.ts`
- `src/routing/manifest-types.ts`
- `src/routing/match.ts`
- `src/routing/matcher.test.ts`
- `tests/client/navigation-recovery-bootstrap.ts`
- `tests/client/navigation-recovery-fixture.ts`
- `tests/client/navigation-recovery.test.ts`
- `tests/conformance/runtime-cases.ts`
- `tests/conformance/runtime-controls.ts`
- `tests/conformance/runtime-fixture.ts`
- `tests/conformance/runtime-optional-rest.ts`
- `tests/inventory/runtime-cases.json`
- `tests/prerender/contracts.test.ts`
- `tests/types/generated/check-generated-types.ts`
- `tests/types/generated/consumer-fixtures.ts`
- `EXECUTION.md`
- `FEASIBILITY.md`

## Accepted batch L typed parameter matchers

Batch L was authorized November 19, 2026. The implementation covers required named matchers in Velveteen fixtures. A synchronous function consumes a decoded string and returns a string, number, boolean or bigint on success, or `undefined` to reject the candidate. Optional and rest-qualified matcher chains and the Standard Schema authoring interface have separate semantics and are outside this fixture contract.

The routing worker owns grammar, precedence, dispatch, and focused routing tests. The fixture worker owns pinned development and production comparisons and causal controls. The coordinator owns build registry integration, typed data transport, generated consumers, prerender and acceptance. An independent reviewer checks the integrated candidate. Run the pinned reference first, then focused tests and both shared comparison modes, then `bun run test:batch-j`. Keep all changes in Velveteen.

L01–L04 passed. One matcher registry is emitted with the server and browser graphs. Discovery uses a disposable Bun module graph so changes to transitive definitions are visible on the next build. The manifest keeps matcher names without publishing their source path. Generated declarations derive result types from the matcher definitions and combine matched and fallback types for shared layouts. The prerender fixture accepts raw URL-entry strings, then renders and transmits the transformed value. An invalid entry preserves the prior artifact. The browser graph rejects private matcher dependencies.

The shared fixture passes against pinned Kit 3.3.0 and Velveteen in both modes. It proves static precedence, fallback and matched-only 404, exact decoding, number zero, boolean false, bigint precision, hydration and client navigation. The `/0` → `/00` → `/1` sequence exposed lost dependency metadata when reusing skipped server data. The recorded unit failed with no selected load before the fix. Data and dependency metadata now travel together, and the unchanged browser assertions pass. The deliberate matcher corruption exits 1 at the required numeric assertion and the restored case exits 0. Routing passed 14 tests, and the generated consumer gate passed 27 compiler and checker executions with 15 negative controls.

The first full attempt failed in the existing J recovery fixture. Chromium recorded a canceled data fetch to `/recovery/broken` during document replacement. The fixture now finishes each non-deferred data response before the missing chunk can trigger replacement. The focused recovery suite and the full rerun passed with unchanged diagnostic assertions. Independent review cleared the matcher candidate and the recovery correction. [First attempt](./.velveteen/evidence/batch-l-attempt-1.log) · [Canceled request evidence](./.velveteen/evidence/batch-l-attempt-1-recovery.json) · [Load-reuse regression](./.velveteen/evidence/batch-l-reuse-red.log)

`bun run test:batch-j` exited 0 with 282 passing Bun test executions, zero failures, and 72 runtime observations across 18 cases in four cells. All 186 source inputs retained digest `09dfb7a9de14ed6567465ccf6cc914e1ecf300690819d7dd59dc8c6e1efa5ba9` throughout the run. Both Corvidae checkout states and patch hashes match their starting snapshots. Shared-account token and cost telemetry is unavailable. [Complete result](./.velveteen/evidence/batch-l-result.json) · [Regression log](./.velveteen/evidence/batch-l-regression.log) · [Pinned provenance](./.velveteen/evidence/batch-l-provenance.json) · [Corvidae comparison](./.velveteen/evidence/batch-l-corvidae-unchanged.json)

Files changed for L:

- `src/build/entries.ts`
- `src/build/graph.ts`
- `src/build/index.ts`
- `src/client/events.ts`
- `src/client/load-selection.ts`
- `src/data/contract.ts`
- `src/data/loads.test.ts`
- `src/data/loads.ts`
- `src/data/tracking.ts`
- `src/data/validate.ts`
- `src/prerender/entries.ts`
- `src/prerender/index.ts`
- `src/routing/grammar.ts`
- `src/routing/index.ts`
- `src/routing/manifest-types.ts`
- `src/routing/match.ts`
- `src/routing/matcher.test.ts`
- `src/server/index.ts`
- `src/server/types.ts`
- `src/types/generate-route-types.ts`
- `tests/build/build-errors.test.ts`
- `tests/client/navigation-lifecycle.test.ts`
- `tests/client/navigation-recovery-bootstrap.ts`
- `tests/conformance/runtime-cases.ts`
- `tests/conformance/runtime-controls.ts`
- `tests/conformance/runtime-fixture.ts`
- `tests/inventory/runtime-cases.json`
- `tests/prerender/contracts.test.ts`
- `tests/types/generated/check-generated-types.ts`
- `tests/types/generated/consumer-fixtures.ts`
- `EXECUTION.md`
- `FEASIBILITY.md`
- `tests/conformance/README.md`

## Accepted batch K layout inheritance

Batch K was authorized November 19, 2026. Its gates are K01–K04 in [the feasibility plan](./FEASIBILITY.md#proposed-batch-k--layout-inheritance). The routing worker owns discovery, branch resolution and focused routing tests. The fixture worker owns the pinned case map, reference and candidate observations, and negative control. The coordinator owns generated types, integration, and acceptance. The continuing reviewer checks the exact candidate.

K01–K04 passed. Pinned SvelteKit 3.3.0 supplied the manifest and browser expectations. The candidate separates physical route directories from the resolved layout branch and keeps the page leaf distinct. That branch drives layout loads, inherited options, rendering, errors and generated types. Fixtures prove root and named page resets, a child inheriting a reset layout, skipped loads, actual client navigation and retained ancestor data.

The focused routing gate passed 11 tests. Generated consumers passed 26 compiler and checker executions, including 14 negative controls. The original corrupt-fixture attempt left both component filenames present and failed during discovery. The fixed fixture removes the previous variant, then changes only the filename for the negative control. The resulting build fails the expected rendered-branch assertion, and the restored build passes. Independent review cleared the candidate.

`bun run test:batch-j` exited 0 with 274 passing Bun test executions, zero failures, and 68 runtime observations across 17 cases in four cells. All 185 source inputs retained digest `07f029f75204d4c150d35de59f14fcbcd5ad55993f15fdf7bb64bea1f6a545bf` throughout the run. Formatting, lint, strict TypeScript, Svelte and audits passed. The two Corvidae checkout states and patch hashes match the starting snapshot. Shared-account token and cost telemetry is unavailable. [Complete result](./.velveteen/evidence/batch-k-result.json) · [Regression log](./.velveteen/evidence/batch-k-regression.log) · [Pinned provenance](./.velveteen/evidence/batch-k-provenance.json) · [Corvidae comparison](./.velveteen/evidence/batch-k-corvidae-unchanged.json)

Files changed for K:

- `src/client/index.ts`
- `src/client/load-selection.ts`
- `src/data/errors.ts`
- `src/data/loads.test.ts`
- `src/data/validate.ts`
- `src/routing/index.ts`
- `src/routing/manifest-types.ts`
- `src/routing/routing.test.ts`
- `src/types/generate-route-types.ts`
- `tests/conformance/runtime-cases.ts`
- `tests/conformance/runtime-controls.ts`
- `tests/conformance/runtime-fixture.ts`
- `tests/inventory/runtime-cases.json`
- `tests/types/generated/check-generated-types.ts`
- `tests/types/generated/consumer-fixtures.ts`
- `FEASIBILITY.md`
- `EXECUTION.md`

## Accepted batch J navigation fixtures

The user authorized J on November 18, 2026, explicitly inside Velveteen fixtures with Interborough as a reference and no Corvidae changes. This replaces the former J adoption milestone. I's 177 accepted inputs still match `3102a24547bce028e36f97c67bfcd53df3c47780f4b3d3a1c0e44523c6ac9e35`. The exact starting source identities and both Corvidae checkout states are recorded in `.velveteen/evidence/batch-j-baseline.json`. Canonical Corvidae is clean at `721367ba220dc2384c83ee1c33b3a38bdf702e5b`; the disposable worktree retains its six-file unaccepted experiment at `d0e11c4d0a5899e6d85e89bbfd74970b000808f9`. Compare heads, porcelain status and patch hashes at acceptance. Neither checkout may be edited, installed into or tested in this batch. JF01–JF06 are now accepted. The final source digest is `12d80e7231cfe7561c4e03eaac71633f51335365141e8460f6e2e928ef6a636e`; the accepted scope remains representative navigation fixtures, with no real-app adoption.

The address worker owns `tests/client/navigation-addresses.test.ts` and its fixture helper. It verifies real emitted routes, query state, identifier encoding, plugin rest paths and redirects. The lifecycle worker owns `src/client`, narrow changes to `src/data/contract.ts`, `tests/client/navigation-lifecycle.test.ts` and its helpers. It verifies guards, component retention, loading, stale work and cleanup. The coordinator owns the recovery fixture and tests, the malformed-URL server boundary fix, shared contracts, package scripts, evidence and integration. The continuing reviewer checks exact assertions and the final candidate. Workers inspect existing conventions, do not delegate, keep files below 500 lines and do not edit another owner's surfaces. Shared-account token/cost telemetry is unavailable.

All three suites build the real Velveteen graph and run Chromium against native Bun hosts in explicit development and production modes. Fixtures call the actual application handler and generated client registry; they must not supply fabricated page payloads, another router or copied Corvidae runtime code. The SPA lifecycle fixture may own its HTML/bootstrap and call the generated `start(options)` with a decoded real data response, matching the existing host-composition contract. It does not need to rewrite the framework's default bootstrap or change the server API.

The Interborough reference is `applications/interborough/src/lib/router.svelte.ts`, `identifier-paths.ts` and their tests, plus `src/app/routes.ts`, `src/app/shell/route-outlet.svelte`, `chunk-reload.ts` and their tests. Record source hashes and the relevant symbols with the gate evidence. Dot-only/reserved identifiers and plugin registration remain application policy represented in the fixture. Kit's rest grammar and malformed-encoding 400 behavior stay intact: a plugin route's application load enforces one or more rest segments, and the explicit malformed-encoding difference from Interborough's not-found behavior is recorded rather than hidden.

Existing `beforeNavigate`, `afterNavigate` and `onError` hooks handle application leave questions, loading/error presentation and recovery. Before-unload registration and bounded missing-chunk recovery remain application-owned fixture policy. The small missing runtime capability is opt-in page identity: `ClientOptions.pageKey?: (payload: PagePayload) => string`, with `goto(..., { replace: true, keepView: true })` preserving the current leaf instance. `keepView` requires an explicit `pageKey`, replacement and the same ordered rendered component/role branch; changing a parent layout would otherwise unmount the retained leaf. Invalid use must fail before page or history commit. Default component reuse remains unchanged for the existing Kit conformance cases. Data refreshes preserve the mounted identity, including during explicit retention. Query-only updates retain the page when its identity is unchanged; an ordinary navigation or history traversal ends explicit retention, including a return to its original new-item address. Shared layouts retain their own component identity.

| Gate | Binary acceptance | Verification |
| --- | --- | --- |
| JF01 | Real routes preserve static/dynamic precedence, duplicate/empty query values and selection/pagination state; slash/percent/Unicode identifiers decode once; app-owned placeholder escapes round-trip only when valid; registered nested plugin paths resolve and missing/invalid paths have explicit outcomes | `bun run test:navigation-addresses` in development and production |
| JF02 | Link/goto/replace/back/forward keep URL, visible route and history consistent; redirects do not leave an intermediate history entry; query-only navigation retains dirty input and component identity | Both navigation suites; literal URL, mount and DOM assertions |
| JF03 | Opt-in identity remounts different resources; replacement with `keepView` retains the new-to-saved page, dirty input and ongoing state; subsequent navigation/history ends retention; invalid retention requests do not commit | `bun run test:navigation-lifecycle`; relevant type checks |
| JF04 | Leave guards refuse links, goto and history without corrupting the settled location; stay and disarm/continue work; before-unload and client disposal remove owned listeners; held loads show pending UI and stale/canceled work cannot overwrite a newer result | `bun run test:navigation-lifecycle` with causal release controls |
| JF05 | A real missing emitted chunk causes at most one guarded document reload; an unresolved repeat shows visible failure; successful route completion resets recovery; offline/unavailable storage and module evaluation errors do not trigger a reload loop | `bun run test:navigation-recovery`; exact expected failed-URL diagnostics and reload counts |
| JF06 | Independent review clears, relevant format/lint/types and all J/I/N–H gates pass on frozen source identities; Corvidae matches its recorded baseline | `bun run test:batch-j`; source and checkout comparisons |

Use focused commands, then candidate review and causal corrections, then the complete `bun run test:batch-j` once stable. The default `bun run test` includes J. Existing I and N–H evidence remains historical; source changes require the full regression gate before J acceptance. No diagnostic suppression, skipped assertion or timeout/retry increase is permitted. Expected browser errors must be attributed to the exact deliberately failed resource or explicit application error, not filtered by broad status/message patterns. After two unsuccessful corrections to one criterion, stop patching and reassess the cause. Every fixture must dispose its server/browser, release held requests and remove owned temporary files on success and failure. Passing J establishes representative navigation behavior; it does not accept Interborough adoption or claim visual design parity.

### J acceptance evidence

`bun run test:batch-j` ran from `2026-11-18T20:43:50.039653+00:00` to `2026-11-18T20:46:11.372220+00:00` on Bun 1.4.4 and exited 0: 271 Bun test executions, zero failures, and all 64 pinned runtime observations across reference/candidate development/production. The three focused navigation suites contain 30 tests: eight address tests, twelve lifecycle tests and ten recovery tests. They also run inside the broader browser gate, so the complete total counts executions rather than unique tests. The full I/N–H regression chain, package consumer, dependency/artifact audits, generated-type negative controls, formatting, lint, strict TypeScript and all three Svelte checks passed. All 185 source inputs matched before and after the run. See [the complete result](./.velveteen/evidence/batch-j-result.json), [full log](./.velveteen/evidence/batch-j.log), [primary review](./.velveteen/evidence/batch-j-review.json) and [reference provenance](./.velveteen/evidence/batch-j-reference-provenance.json).

The runtime addition is opt-in page identity and retained replacement. One identity owner separates the current address from the mounted view, preserves retention through data refresh, and ends it on ordinary navigation or history traversal. Repeated replacements, a direct return to the original new-item address and subsequent query-only navigation have causal regressions. `keepView` requires `pageKey`, `replace: true` and an identical ordered rendered branch. The changed-parent/same-leaf check is an explicit helper unit; browser tests independently reject incompatible emitted branches before committing URL, history or DOM. Default component reuse still passes the earlier Kit comparisons. The server now maps malformed route decoding to 400 at the matching boundary; an application-thrown `URIError` remains 500.

The held-load test proves request entry before superseding it, visible loading, idempotent release and settlement of the old navigation before checking the final page. Guard tests wait for cancellation and history reversal events, then verify before-unload registration/removal, framework listener disposal and unmount. Recovery tests fail the actual emitted chunk URL, count document requests, prove one guarded retry and visible persistent failure, and verify successful-route reset, unavailable storage, offline behavior and module evaluation errors. Browser diagnostic assertions remain exact.

The first complete attempt stopped after 29 passing navigation tests on an unexpected canceled `/recovery/broken` request. Its request type was not captured, so no classification theory is treated as confirmed. The fixture had two missing completion barriers: it could skip draining initial data when startup rejected, and proceed from a failure marker before the replacement document finished loading. Both barriers are now explicit; request metadata is retained before assertions. The focused gate and complete gate passed afterward without a timeout/retry increase or diagnostic allowance. [Attempt 1](./.velveteen/evidence/batch-j-attempt-1-result.json) remains recorded. Svelte MCP checks returned no issues or suggestions for the changed runtime components and reviewed fixture components.

[The final Corvidae comparison](./.velveteen/evidence/batch-j-corvidae-unchanged.json) confirms both heads, porcelain states and patch hashes match the starting baseline, and all nine reference files retain their hashes. The canonical checkout remains clean; the earlier disposable experiment retains its exact unaccepted patch. No Corvidae source, dependency, router, build or test was changed or run. Publication and Interborough adoption remain unaccepted. Shared-account token/cost telemetry is unavailable.

Files changed for J:

- `package.json`
- `src/client/index.ts`
- `src/client/navigation-retention.ts`
- `src/client/root.svelte`
- `src/client/state.svelte.ts`
- `src/client/types.ts`
- `src/data/contract.ts`
- `src/server/index.ts`
- `tests/client/navigation-addresses-fixture.ts`
- `tests/client/navigation-addresses.test.ts`
- `tests/client/navigation-lifecycle-fixture.ts`
- `tests/client/navigation-lifecycle.test.ts`
- `tests/client/navigation-recovery-bootstrap.ts`
- `tests/client/navigation-recovery-fixture.ts`
- `tests/client/navigation-recovery.test.ts`
- `tests/server/security.test.ts`
- `FEASIBILITY.md`
- `EXECUTION.md`

## Accepted batch I fixture prototype

On November 18, 2026, the user chose: “Use Interborough as a reference and prove representative builds in Velveteen fixtures. Leave real-app adoption unaccepted.” This supersedes the disposable-consumer IP01–IP06 plan. Batch I now accepts only representative fixtures inside Velveteen. The failed real-app experiment remains recorded below; its failures do not become passing claims. No further changes or gates run in Corvidae. J, publication and real-app adoption remain outside this batch.

One implementation worker owns the existing installed-package probe and its fixture helper under `tests/build`. The coordinator owns package scripts, this record, final integration and acceptance. The continuing primary reviewer checks the exact candidate and assertion integrity. Workers inspect the existing conventions and cannot delegate. No additional runtime abstractions, router migration, warning-policy changes, production packaging workflow or shared compiler migration is included.

The accepted producer checkpoint already proves installation outside this repository, identical application/compiler Svelte resolution, SSR, runtime plugin imports, interactive browser runes and authored CSS. Extend that same installed consumer with a native HTML entry in development and production. Model the application-owned build seam from Interborough's `scripts/build.ts`: native `Bun.build`, injected component CSS, explicit development mode, disabled HMR in built fixtures, browser/Svelte conditions, splitting, hashed `assets/` paths and linked development source maps. The fixture owns its mount and navigation and composes its own resolver and WebAssembly plugins. A small fixture registry proves resolver composition; it does not claim actual Shiki integration. Neither Corvidae source nor its installed dependencies are imported by the fixture.

| Gate | Binary acceptance | Verification |
| --- | --- | --- |
| IF01 | The private packed compiler installs outside the repository, resolves one Svelte 5.57.1 instance and retains literal SSR, runtime imports and interactive browser/CSS witnesses | `bun run test:package-consumer`; installed-consumer observations |
| IF02 | Native HTML builds succeed without warnings in development and production; hashed assets exist, lazy code loads only after the fixture action, typed rune state updates and computed CSS matches; application-owned resolver and emitted WASM binary produce their literal browser results | `bun run test:package-consumer`; observed results for both modes |
| IF03 | Development outputs contain linked source maps and production outputs contain none; missing mode results fail the outer test; owned temporary files, browser and server are cleaned up | `bun run test:package-consumer`; artifact and cleanup evidence |
| IF04 | Existing syntax/warning failures preserve the last published generation; prior lifecycle, serving and all accepted N–H gates remain green | Existing D05 test via `bun run test:batch-gh`; no assertion or policy changes |
| IF05 | Independent review is clear, relevant format/lint/types and the complete fixture/regression gate pass against recorded source hashes; both Corvidae checkouts remain unchanged from the decision checkpoint | `bun run test:batch-i`; checkpoint comparison and acceptance evidence |

Run focused fixture tests and relevant static checks, review the candidate and correct findings, then run `bun run test:batch-i` once stable. The default `bun run test` now includes the installed-consumer gate so future changes cannot silently omit this proof. Record command exits, exact file identities, literal browser observations and any unresolved findings. No failure is skipped, diagnostic suppressed or timeout/retry limit raised. After two unsuccessful corrections to one boundary, reassess the cause before more edits. Shared-account token/cost telemetry is unavailable.

The disposable Corvidae worktree remains at `/Users/stevekinney/.agent-worktrees/codex/corvidae/velveteen-interborough-build`, branch `steve/velveteen-interborough-build`, base `d0e11c4d0a5899e6d85e89bbfd74970b000808f9`. Its six-file experimental diff is retained as unaccepted evidence; do not restore or promote it. IF05 compares this dirty worktree against the post-failure `changedFiles` hashes and `patchSha256` in `.velveteen/evidence/batch-i-prototype-checkpoint.json`, not against a clean base. The canonical `/Users/stevekinney/Developer/corvidae` baseline is clean at `721367ba220dc2384c83ee1c33b3a38bdf702e5b`, recorded in the same checkpoint. No new edits in either checkout are permitted during the fixture run. The retained warning control records a real adoption limitation, not a fixture acceptance failure.

### I fixture acceptance

IF01–IF05 are accepted for representative Velveteen fixtures. `bun run test:batch-i` ran from `2026-11-18T17:07:10.691683+00:00` to `2026-11-18T17:09:03.568544+00:00` on Bun 1.4.4 and exited 0. It passed 209 Bun test executions with zero failures, all 64 reference/candidate development/production comparisons, generated type controls, every accepted N–H gate and both production archive audits. Formatting, lint, strict TypeScript and all three Svelte checking workspaces passed with zero errors and warnings. All 177 recorded source/configuration/test files remained unchanged during the run; aggregate digest: `3102a24547bce028e36f97c67bfcd53df3c47780f4b3d3a1c0e44523c6ac9e35`. See [the complete log](./.velveteen/evidence/batch-i-fixture.log) and [result with per-file identities](./.velveteen/evidence/batch-i-fixture-result.json).

Both native HTML modes serve a 200 document, update `Count: 1` to `Count: 2` and `Double: 2` to `Double: 4`, compute `rgb(9, 8, 7)`, render the application-owned resolver value and execute the emitted WASM binary to obtain `5`. Each mode requests its hashed JavaScript/WASM assets from `/assets/`; the lazy chunk is absent before the action and requested once afterward, rendering `Lazy: loaded`. Development has two linked source maps with parsed source provenance; production has no map artifacts or JavaScript map directives. Build logs and browser/network diagnostics are empty. The original SSR, runtime import and external-CSS browser witnesses remain intact. The consumer and compiler resolve the same Svelte 5.57.1 instance. The packed artifact digest is `20a8d6e18f75a55b893b00b59a51e3f2766ff385f49e9d114dae178c08f5b9d4` and matches the dependency audit's archive. [Installed-package observations](./.velveteen/evidence/batch-i-package-consumer.json) include the actual DOM values, requested assets, output identities and cleanup results.

The initial fixture conflated an inline CSS map inside generated JavaScript with the bundle's JavaScript map directive, then treated a root-relative map URL as a filesystem-relative path. The coordinator removed a proposed output rewrite and corrected the assertions against unmodified native output. The child builder is now a real TypeScript helper copied into the unrelated consumer, so formatting, lint and type checks cover it without nested-string escaping. Hashed asset/request correspondence is asserted, and cleanup evidence is written only after the directory is absent, the browser disconnects and native server shutdown resolves. The continuing reviewer cleared all findings. The Svelte MCP check also returned no fixture issues or suggestions. Compiler/runtime source and warning policy did not change.

[The Corvidae comparison](./.velveteen/evidence/batch-i-corvidae-unchanged.json) confirms the canonical checkout is still clean at its recorded head, the disposable experiment's exact patch is unchanged and all 1,012 protected application sources match. Real-app adoption remains unaccepted; its warnings and review findings were neither fixed nor represented as passing. No further Corvidae work, publication, push, merge or J implementation occurred. Shared-account token/cost telemetry is unavailable.

Files changed for this fixture acceptance:

- `package.json`
- `tests/build/clean-consumer.test.ts`
- `tests/build/package-consumer-probe.ts`
- `tests/build/package-consumer-build.ts`
- `FEASIBILITY.md`
- `EXECUTION.md`

### Unaccepted Interborough experiment

The disposable integration is implemented but not accepted. The worker copied the exact archive to `tmp/chef/velveteen-prototype/velveteen-package.tgz`, added Interborough's local dependency `file:../../tmp/chef/velveteen-prototype/velveteen-package.tgz` and pinned the root Svelte catalog to 5.57.1. After editing the manifests, the first frozen installation correctly rejected the stale lockfile; `bun install` regenerated it, and `bun install --frozen-lockfile` then exited 0. Both Interborough entrypoints import `createSveltePlugin` from the packed public compiler entry. No shared testing compiler or other application was migrated.

The worker reports 66 focused build/host tests and eleven selected UI tests passing, all with nonzero selection. It retained terminal output only, so these counts are worker evidence rather than a separately logged coordinator rerun. The real build command failed and was interrupted with exit 130 before the dev-watch tests completed. IP04 is not passed; IP05 has not run. The build regression invokes the actual `browserBuildOptions`, checks the Velveteen plugin identity, compiles authored CSS and a rune module, and cleans its temporary files. It is compilation evidence, not a runtime rune-interaction witness.

The real build exposes a warning-policy mismatch. `@tanstack/svelte-query@6.2.1` produces `state_referenced_locally` in `QueryClientProvider.svelte` at line 14 and `createMutation.svelte.js` at lines 177 and 203. A coordinator control on identical sources, Bun 1.4.4 and Svelte 5.57.1 confirms that the native compiler returns these warnings, the old compiler plugin discards them and returns JavaScript, and Velveteen rejects them. Interborough's `assertCleanBuild` already promises to fail on Svelte and bundler warnings, so dropping or relabeling diagnostics would not satisfy its documented contract. The worker also observed two Bun warnings about unsupported `:global` selectors without source paths; their cause remains unverified. No warning policy was weakened and no dependency was patched.

Independent review also found that the touched `scripts/build.ts` remains 532 lines and its introduction still names the previous compiler. Those corrections remain required before real-app adoption can be accepted. The user subsequently chose representative Velveteen fixtures and left real-app adoption unaccepted. This experiment has ended at its failed checkpoint; J has not started.

The coordinator verified that all 1,012 protected application sources and all 176 accepted producer files remain unchanged. The canonical Corvidae checkout is clean and untouched. No package was published, branch pushed or pull request opened. See [the exact checkpoint](./.velveteen/evidence/batch-i-prototype-checkpoint.json), [same-version warning control](./.velveteen/evidence/batch-i-warning-control.json) and [disposable consumer diff](./.velveteen/evidence/batch-i-consumer.patch). Shared-account token/cost telemetry is unavailable.

The disposable worktree changes are `package.json`, `bun.lock`, `applications/interborough/package.json`, `applications/interborough/scripts/build.ts`, `applications/interborough/scripts/build.test.ts` and `applications/interborough/tests/setup.ts`. The local scope correction changes `FEASIBILITY.md` and `EXECUTION.md` in Velveteen. Producer source remains at the accepted checkpoint below.

### I producer checkpoint

The bounded repair is complete and primary review cleared the package/compiler assertions. The installed tarball now proves literal server output `Count: 3`, runtime plugin imports of authored-style components and typed runes, browser interaction `Count: 3` → `Count: 4`, computed CSS `rgb(1, 2, 3)` and zero browser diagnostics. Compiler and application resolve the same real Svelte path at version 5.57.1. A separate native resolver control verified that Bun's file-URL parent selects a nested dependency rather than the caller's current directory. The compiler now forwards development and filename options to rune compilation as well as components. Native Svelte style hashes are retained; the existing development publication path retains its explicit stable hash and its CSS-only update gate still passes.

The dependency audit caught stale root workspace metadata in `bun.lock` even though `bun install --frozen-lockfile` exited 0. Native `bun install --lockfile-only` regenerated it. Exact manifest/lock comparison, dependency audit and frozen installation then passed. This existing mandatory audit prevents treating a frozen-install success as sufficient metadata evidence.

`bun run test:package-consumer` followed by `bun run test:batch-gh` ran from `2026-11-18T14:27:47.705672+00:00` to `2026-11-18T14:29:41.998325+00:00`; both exited 0 on Bun 1.4.4. The combined run passed 209 Bun test executions with zero failures, all 64 reference/candidate development/production comparisons, the compiler controls, and every accepted G/H/E/F/D/C/N/A/B gate. Formatting, lint, strict TypeScript, all three Svelte checks, dependency audits and production archive audits passed. Source digest before and after: `d3b269e156c644f01d106056e31a2a1f3f4c13c7381f55561d953b59fb3883b1`. See [producer results](./.velveteen/evidence/batch-i-producer-result.json), [complete log](./.velveteen/evidence/batch-i-producer.log) and [installed-package observations](./.velveteen/evidence/batch-i-package-consumer.json).

This checkpoint establishes producer readiness. At that checkpoint Corvidae was still clean and all 1,012 protected production files matched; no package was published and no branch was pushed or merged. The coordinator's requested distribution choice was subsequently withdrawn after the user's prototype clarification. The private local tarball established the fixture seam; no distributed dependency is required. No production adoption or J acceptance is claimed.

Changed files in this producer checkpoint:

- `package.json`
- `bun.lock`
- `src/compiler/index.ts`
- `src/compiler/compiler.test.ts`
- `tests/build/clean-consumer.test.ts`
- `tests/build/package-consumer-probe.ts`
- `FEASIBILITY.md`
- `EXECUTION.md`

## Accepted batches G and H

The user authorized G/H on November 17, 2026, with well-scoped agents and acceptance before Interborough. At preflight, all 149 accepted E/F files matched `8cdfac4a650c0e7248eff8c5199263284383427fce2e7b2f81a251b9839ae060`; Bun remains 1.4.4. Status: complete for G01–G04, H01–H04 and GH05. Delivery is local source and reproducible evidence in this non-Git workspace. The requested acceptance prerequisite to Interborough is satisfied; adoption has not started. Shared-account usage/cost telemetry is unavailable.

The coordinator owns shared server/client/build integration, generated action types, root scripts, shared reference/candidate conformance and acceptance. The mutation worker owns action dispatch helpers, enhancement and typed remote transport with focused regressions. The static-output worker owns route-option evaluation, prerender output, service-worker packaging and remaining inventory ownership. Workers inspect current conventions, do not delegate and do not edit each other's surfaces. The continuing primary reviewer owns assertion integrity; the independent security reviewer checks mutation authorization/origin, serialization and static file containment before acceptance.

The selected G contract preserves default/named POST actions, native FormData including files, validation failures, redirects, errors, post-action loads, no-JavaScript submission and enhanced submission without reload. Form state travels in the existing page payload. Explicit typed remote definitions are supplied to the existing application handler; a browser client imports their types only and uses one devalue-based, versioned protocol. Validators accept unknown input before invocation; commands invalidate after success; all calls run through existing hooks/context and enforce same-origin POST. This is an intentional authoring API difference from Kit's experimental compiler-transformed remote modules. This batch does not claim complete coverage of that experimental API; its other cases remain visible in the owned inventory.

The selected H contract includes inherited prerender/SSR/CSR/trailing-slash options, static and explicit dynamic entries, same-origin link crawling, HTML/endpoint/redirect artifacts, copied public assets, portable static serving, service-worker build/version/base metadata and actual browser registration/offline behavior. Native Bun build, files, responses and HTMLRewriter provide the mechanics. Output publication must reject escaping/colliding paths and preserve the previous successful artifact on failure. Explicit worker bootstrap inputs replace Kit virtual service-worker imports. Every pinned ledger file/script receives a feature owner with ownership controls; ownership does not change its implementation status.

The H browser witness precaches two prerendered documents, generated JavaScript/CSS and a copied public file. After worker control, offline full reloads of both documents must preserve literal content and interaction; the public file must preserve bytes and an unknown URL must fail. A second build changes public content; `registration.update()` must activate the new content version, serve the changed bytes and remove only the fixture-owned old cache while retaining an unrelated cache. The version is a deterministic SHA-256 digest of sorted public URLs and content hashes, excluding the worker itself. Dynamic `prerender = true` without an emitted matching entry fails with a missing-entry diagnostic; `/blog/one` supplied explicitly produces its concrete page. `false` remains runtime-only; `auto` permits hybrid output. Prerendered actions fail before publication.

| Gate | Binary acceptance | Verification |
| --- | --- | --- |
| G01 | Default/named forms, submitter overrides, files, validation, redirects, errors and post-action loads pass with JavaScript disabled and enabled against the same pinned reference assertions | `bun run test:actions`; development and production conformance |
| G02 | Remote validation precedes application code; rich values round-trip through one protocol; unsupported/malformed input fails; command invalidation and cancellation are causal tests; private implementations never enter browser output | `bun run test:remote`; `bun run test:security` |
| G03 | Hooks/auth short-circuit actions and remotes; same-origin policy, concurrent context isolation, error sanitization and stale/disposed enhanced submissions are covered | `bun run test:actions`; `bun run test:remote`; `bun run test:security` |
| G04 | Generated Actions/ActionData/PageProps and typed remote clients compile; wrong parameters/results fail at their intended compiler diagnostics | `bun run test:types`; `bun run typecheck` |
| H01 | Prerender inheritance, dynamic entries, crawl, endpoint bytes, redirects, base/trailing-slash URLs and no-client output produce inspectable static files and headers | `bun run test:prerender` |
| H02 | Invalid options, missing entries, actions on prerendered routes, unsafe/colliding output and failing renders fail with diagnostics while preserving accepted output | `bun run test:build-errors` |
| H03 | A copied static artifact runs without source/compiler/node_modules; versioned service worker registers under its base and serves cached content offline; output changes change version | `bun run test:prerender` |
| H04 | All 2,658 source files and 195 scripts retain identity/status and have explicit feature owners; missing/unknown owner controls fail; selected shared assertions retain literal reference expectations | `bun run test:inventory`; `bun run test:conformance` |
| GH05 | Primary/security reviews clear; all G/H gates and accepted E/F/D/C/N/A/B gates pass against unchanged source hashes | `bun run test:batch-gh` |

### G/H implementation and review checkpoint

The coordinator integrated and corrected the initial worker handbacks, then bounded worker follow-ups to tests. Passing unit handbacks had not proved browser enhancement, typed negative consumers or portable static deployment. The final witnesses use emitted registries and Root, literal assertions against pinned Kit, actual compiler processes, and copied static artifacts served from an unrelated directory after deleting source. The framework still uses Bun for builds, files, serving and cancellation; no supervisor was added.

Focused G/H checks pass: actions and real browser form disposal/clobbering, remote serialization/validation/auth/context and browser invalidation, static contracts and build failures, offline/update/failed-install browser behavior, generated action consumers and five strict remote consumer compiler invocations. The remote compiler gate follows the existing standalone CLI pattern; grouping five compiler processes inside one Bun unit test exceeded its unchanged default deadline. No timeout or retry limit was increased. Browser service-worker update assertions wait for `activated`, since `controllerchange` can precede completion of activation work. Expected cache-miss diagnostics are tied to the exact deliberately missing URL.

Review corrections include strict missing-Origin rejection for remotes, malformed remote-path 400s, media-type case normalization before CSRF checks, branded action-data inference, cancellation of an owned response reader, propagation of a destroyed form's signal into application navigation, source-free static asset copying and integrity checks, prerendered URL/fetch relocation, inherited options, canonical dynamic entries, redirect accounting, symlinked publication-directory rejection and atomic static/worker publication. The runtime harness waits for actual hydration before enhanced-form assertions. Its negative controls corrupt both fetched data and action data and must fail against unchanged literal expectations.

Pinned Kit disables CSRF checks in development. The candidate deliberately requires same-origin forms in both modes; the shared case asserts reference development executes the action with 200 and all other cells return 403 without its output. This source-backed security difference is recorded in the selected-case ledger. Remote authoring uses explicit server definitions and `client.call(name, input)` with type-only client imports; the worker initializer synchronously registers application-owned native lifecycle handlers. These API differences do not claim full experimental Kit remote coverage or a framework-owned offline cache policy.

The continuing primary reviewer cleared the current G/H interfaces and assertion integrity. A stale redirect finding was rejected against a fresh source hash and an actual passing redirect-artifact fixture. The independent security reviewer cleared the final origin/path/CSRF/cancellation and static-containment corrections, including the latest mixed-case content-type and disposed-form regressions. The final bounded primary review also cleared the same corrections; full integrated acceptance is recorded below. Shared-account token/cost telemetry is unavailable; the local delivery boundary remains G/H, with no Interborough changes.

### G/H acceptance

`bun run test:batch-gh` started at `2026-11-18T04:22:05.765359+00:00` and finished at `2026-11-18T04:23:51.374000+00:00` with exit 0 on Bun 1.4.4. It passed 204 Bun test executions with zero failures, all 64 application comparisons (sixteen cases × reference/candidate × development/production), the empty/corrupt/restored runtime controls, 22 generated-consumer compiler/checker executions with twelve causal negative controls, and five strict remote-consumer compiler executions with three causal negative controls. Counts are executions: focused security checks deliberately overlap earlier suites. The complete accepted E/F/D/C/N/A/B gate also passed, including both production archives, dependency/process/privacy audits, formatting, lint, strict TypeScript and all three Svelte checking workspaces with zero errors and warnings.

All 174 recorded source/configuration/test/assets files remained unchanged throughout the run. Aggregate digest: `8e4c8ca29841e728a5d3844e912cd500c08b9aefd700ea457ca5802846cf45a3`. Evidence: [complete log](./.velveteen/evidence/batch-gh.log), [result and per-file hashes](./.velveteen/evidence/batch-gh-result.json), [runtime controls](./.velveteen/evidence/runtime-controls.json), [generated consumers](./.velveteen/evidence/c05-generated-consumers.json), and [portable offline/update witness](./.velveteen/evidence/h03-static-browser.json). The four `runtime-reference-development`, `runtime-candidate-development`, `runtime-reference-production` and `runtime-candidate-production` evidence directories record the actual comparison processes and case results. The source ledger is `tests/inventory/runtime-cases.json`; ownership controls preserve all 2,658 test-file identities and 195 package scripts without changing reference-only statuses into passing claims.

G01–G04, H01–H04 and GH05 are accepted. Primary and independent security reviews have no unresolved findings. Acceptance documentation changed after the source-frozen gate and receives a separate formatting/source-identity check. This remains a non-Git workspace; no commit, pull request, package publication, deployment or Corvidae change is included. Interborough's required prerequisite is satisfied, and its adoption remains a separate batch. Complete upstream parity remains unclaimed. Shared-account token/cost telemetry is unavailable.

### G/H changed files

These paths are relative to `/Users/stevekinney/Developer/velveteen`. There are 47 changed or added source/configuration/test files compared with the accepted E/F identity, plus four documentation files. Generated evidence lives under `.velveteen/evidence`.

- `package.json`
- `src/actions/enhance.ts`
- `src/actions/server.ts`
- `src/client/events.ts`
- `src/client/index.ts`
- `src/client/navigation-context.ts`
- `src/client/root.svelte`
- `src/client/types.ts`
- `src/data/contract.ts`
- `src/data/fetch.test.ts`
- `src/data/fetch.ts`
- `src/data/validate.ts`
- `src/prerender/entries.ts`
- `src/prerender/index.ts`
- `src/prerender/serve.ts`
- `src/prerender/service-worker.ts`
- `src/remote/client.ts`
- `src/remote/protocol.ts`
- `src/remote/server.ts`
- `src/server/index.ts`
- `src/server/loads.ts`
- `src/server/page-options.ts`
- `src/server/types.ts`
- `src/types/generate-route-types.ts`
- `tests/actions/actions.test.ts`
- `tests/actions/enhance.test.ts`
- `tests/build/build-errors.test.ts`
- `tests/client/client.test.ts`
- `tests/conformance/runtime-actions-fixture.ts`
- `tests/conformance/runtime-actions.ts`
- `tests/conformance/runtime-cases.ts`
- `tests/conformance/runtime-controls.ts`
- `tests/conformance/runtime-fixture.ts`
- `tests/conformance/runtime-harness.ts`
- `tests/inventory/check-inventory.ts`
- `tests/inventory/classify.ts`
- `tests/inventory/ledger.json`
- `tests/inventory/runtime-cases.json`
- `tests/prerender/browser.test.ts`
- `tests/prerender/contracts.test.ts`
- `tests/prerender/fixture.ts`
- `tests/prerender/prerender.test.ts`
- `tests/remote/browser.test.ts`
- `tests/remote/check-types.ts`
- `tests/remote/remote.test.ts`
- `tests/server/mutations.test.ts`
- `tests/types/generated/consumer-fixtures.ts`
- `FEASIBILITY.md`
- `EXECUTION.md`
- `tests/conformance/README.md`
- `tests/inventory/README.md`

## Accepted batches E and F

The user authorized E and F after D acceptance. Status: complete for the selected acceptance contract. The D source digest `e8da5f3db97e49bcb81b4d3d79dd2c6ba7ee0e7b15177af6097004632c4b20e6` still matched all 104 recorded files at preflight, with Bun 1.4.4. Delivery remains local implementation, independent review, conformance fixtures and recorded evidence; G/H and Corvidae adoption are outside this execution.

The observable outcome is a Bun-hosted application that executes nested server/universal loads, renders and hydrates nested Svelte components, then navigates with load reuse, preload, invalidation, history, scroll/focus, errors and cancellation using one data protocol. First record and verify that protocol; then run E server implementation and F client implementation in parallel; integrate against real production/development builds and the pinned Kit oracle; finally run independent review and the complete regression gate.

The coordinator owns `src/data`, D build integration, generated event types, common application/reference fixtures, command wiring and evidence. The server worker owns `src/server` and focused server regressions. The browser worker owns `src/client` and focused browser regressions. The continuing reviewer owns contract and assertion review; a separate read-only security review will cover request isolation, serialization, credentials and public data. Workers cannot delegate or change the shared protocol independently.

Verified premises: D supplies separate role registries and real bundled assets; the retained E/F composition probe proves recursive Svelte layouts, DOM-free SSR, hydration without recovery and retained layout state. Installed `devalue` 5.9.4 passes rich-value/cycle and promise-reducer probes and is now an explicit dependency at the already installed version. A standalone Bun CookieMap supplies mutation serialization. Bun's Request/Response/Headers/AbortSignal/streams remain the transport primitives. The framework owns load dependency tracking, response policy, promise framing and navigation state.

| Gate | Binary acceptance | Verification command |
| --- | --- | --- |
| EF01 | One typed/versioned data contract and pinned codec round-trip rich values/cycles; deferred values settle or reject through native streams; malformed frames, unsupported executable values, script injection and canceled/truncated streams fail explicitly | `bun test src/data` |
| E01 | Server/universal loads preserve own server data, merged parent data, child overrides and concurrency without forced waterfalls; generated event types match actual runtime events | `bun run test:server`; `bun run test:types` |
| E02 | Handle/init/fetch/error hooks compose with ordinary Request/Response; locals and request context stay isolated during overlapping requests; cookies/defaults, headers, relative/internal fetch and credential boundaries pass | `bun run test:server`; `bun run test:security` |
| E03 | Real nested SSR, heads, route CSS, redirects, nearest load/render error boundaries, endpoints/methods and HTML assembly work; unknown errors hide implementation details; browser payload excludes locals/private code/credentials | `bun run test:conformance -- --mode=production --group=server` |
| E04 | Deferred server data renders a pending state and resolves/rejects without a second document; client abort cancels load/fetch/stream work; application disposal releases owned resources | `bun run test:server`; `bun run test:conformance -- --mode=production --group=server` |
| F01 | SSR hydrates without recovery/errors, nested layout state survives navigation, universal loads replay captured fetches, SPA and no-client modes behave as configured | `bun run test:browser`; `bun run test:conformance -- --mode=production --group=navigation` |
| F02 | Link/programmatic navigation, dependency-based load reuse, code/data preload and explicit/predicate/all invalidation preserve expected data and do not reuse failed preloads | `bun run test:conformance -- --mode=development --group=navigation`; `bun run test:conformance -- --mode=production --group=navigation` |
| F03 | Back/forward and replace navigation restore history/scroll/focus; redirects and nested errors preserve appropriate layouts; stale navigation/invalidation cannot overwrite a newer result; disposing/restarting does not duplicate handlers or subscriptions | `bun run test:browser`; both navigation conformance modes |
| EF02 | The application runs from actual D output, selected literal expectations agree with pinned Kit, rejected controls remain rejected, source/test ledger records intentional API differences, independent reviews clear and all accepted D/C/N/A/B gates remain green | `bun run test:batch-ef` |

The shared types are `src/data/contract.ts`. Data requests use the same page URL with `Accept: application/x-velveteen-data`; responses vary on Accept and are not publicly cached. Server data is devalue-encoded in a versioned initial frame, followed by promise settlement frames. HTML embeds inert JSON and safely escaped settlement records; no executable serialized data is evaluated. Universal load results are recreated for hydration from server data and captured fetch responses, so client-only values do not cross the wire. Public helpers and explicit handler/client options replace Kit-specific virtual imports; behavior, not source compatibility, remains the accepted target.

Hooks are explicit options passed to the composable server handler and bundled by the application host. They do not require a second discovery mechanism. Native CookieMap handles parsing/serialization; framework defaults and propagation are tested. E/F includes `ssr`/`csr` inheritance, not H prerendering. Development conformance must use development compilation/conditions, not a relabeled production bundle. The selected-case ledger will name exact upstream source/test identities; complete upstream coverage is not claimed. Shared-account usage/cost telemetry is unavailable.

### E/F implementation and review checkpoint

The initial server/client handbacks did not satisfy the integrated acceptance contract. The coordinator took over orchestration and navigation; workers completed bounded response streaming, document decoding/context, shared-data corrections, security regressions, and the actual ModuleGraph fixture. Early tests missed failures because their fixture manifests or startup paths were incomplete. The final witnesses use actual emitted registries and Root, valid manifests, real Chromium, and the pinned Kit runtime. A proposed filesystem test lock was rejected and removed; the actual combined-run failure was an invalid fixture manifest, and lock-free tests pass.

The shared cases pass independently on candidate production and reference production, and the earlier seven-case development matrix passed before the race extensions. The production reference now uses the generated adapter handler: pinned upstream itself documents Vite preview's streaming buffering. Explicit same-origin headers and adapter ORIGIN correct the fixture's request context. No timeout, retry count, assertion, or compiler warning gate has been relaxed. Final integrated acceptance passed after the source was frozen; the result below supersedes the intermediate runs.

Review corrections include request metadata before handle, error-hook failure sanitization, abortable load coordination, one initial-document decoder, promise references across frames, canceled/truncated transport cleanup, direct-body fetch capture before EOF, canonical Bun/browser request policy, invalidation/preload races, and secure credential/cookie propagation across redirects. Internal fetch now tests omitted and explicit credentials, method/body changes, per-hop cookie scope, caller cancellation, and loop termination. Generated consumers check actual event methods and reject server-only cookie access from universal loads.

The public preload API intentionally follows pinned Kit 3: `preloadCode(routeId)` and `goto(url, { replace })`. These replace stale pre-3 examples; compatibility overloads were not added. Bun's native Request constructor can lose policy before framework entry; explicit fetch init is preserved, and the unrecoverable native boundary is documented in the conformance README. The framework cancels its own coordination and signals application work; it cannot terminate arbitrary user promises that ignore cancellation.

The specialized security-reviewer role could not start because its configured model is unavailable. A separate read-only general reviewer performed the same security review, including concrete Secure-cookie reproduction; the coordinator added further causal redirect tests. The original primary reviewer continues through corrections. Shared account token and cost telemetry remains unavailable.

### E/F acceptance result

`bun run test:batch-ef` started at `2026-11-18T03:01:14.354005+00:00` and finished at `2026-11-18T03:02:37.748527+00:00` with exit 0 on Bun 1.4.4. It passed 124 Bun tests with zero failures, all 44 application comparisons (eleven cases × reference/candidate × development/production), the empty/corrupt/restored runtime controls, twenty generated-consumer compiler/checker executions with ten causal negative controls, and the complete accepted D/C/N/A/B gate. Formatting, lint, strict TypeScript and all three Svelte checking workspaces passed; the checkers reported zero errors and warnings. Both actual D production archives and their integrity/privacy/process controls passed again.

The 149 recorded source/configuration/test/assets files remained unchanged throughout the run. Aggregate digest: `8cdfac4a650c0e7248eff8c5199263284383427fce2e7b2f81a251b9839ae060`. Evidence: [complete log](./.velveteen/evidence/batch-ef.log), [result and per-file hashes](./.velveteen/evidence/batch-ef-result.json), [runtime controls](./.velveteen/evidence/runtime-controls.json), and the `runtime-reference-development`, `runtime-candidate-development`, `runtime-reference-production`, and `runtime-candidate-production` evidence directories, each containing process logs and case results. The source ledger is `tests/inventory/runtime-cases.json`. Acceptance documentation changes follow the run and receive a separate formatting check.

The continuing primary reviewer cleared its final transport-failure finding after an actual-browser terminal-failure regression. Independent security review cleared Secure-cookie scope, explicit/ambient credentials across redirect hops, omitted credentials, caller aborts before the next dispatch, and body ownership on rejected/manual redirects. A malformed protocol terminates the page with status 500 instead of retaining a successful state. Logical page errors travel inside a successful data-protocol response, matching the pinned oracle's browser behavior; document and endpoint responses retain their HTTP statuses.

The local delivery boundary is complete. This remains a non-Git workspace: no commit, pull request, deployment, package publication, G/H implementation or Corvidae change is part of this result. Full upstream parity remains outside the selected-case claim. Shared account token/cost telemetry is unavailable.

### E/F changed files

These paths are relative to `/Users/stevekinney/Developer/velveteen`. There are 52 changed or added source/configuration/test files compared with the accepted D identity, plus three documentation files.

- `bun.lock`
- `package.json`
- `src/build/entries.ts`
- `src/build/graph.ts`
- `src/build/index.ts`
- `src/build/manifest-types.ts`
- `src/client/document.ts`
- `src/client/history.ts`
- `src/client/index.ts`
- `src/client/load-selection.ts`
- `src/client/navigation-context.ts`
- `src/client/root.svelte`
- `src/client/state.svelte.ts`
- `src/client/styles.ts`
- `src/data/codec.test.ts`
- `src/data/codec.ts`
- `src/data/contract.ts`
- `src/data/errors.ts`
- `src/data/fetch.test.ts`
- `src/data/fetch.ts`
- `src/data/loads.test.ts`
- `src/data/loads.ts`
- `src/data/tracking.ts`
- `src/data/transport.test.ts`
- `src/data/transport.ts`
- `src/data/validate.ts`
- `src/server/context.ts`
- `src/server/index.ts`
- `src/server/lifetime.ts`
- `src/server/loads.ts`
- `src/server/render.ts`
- `src/server/request.ts`
- `src/server/responses.test.ts`
- `src/server/responses.ts`
- `src/server/server.test.ts`
- `src/server/types.ts`
- `src/types/generate-route-types.ts`
- `tests/client/client.test.ts`
- `tests/client/document.test.ts`
- `tests/conformance/runtime-cases.ts`
- `tests/conformance/runtime-controls.ts`
- `tests/conformance/runtime-fixture.ts`
- `tests/conformance/runtime-harness.ts`
- `tests/conformance/runtime-host.ts`
- `tests/conformance/runtime-process.ts`
- `tests/conformance/runtime-races.ts`
- `tests/inventory/runtime-cases.json`
- `tests/lifecycle/application-publication.test.ts`
- `tests/reference/runtime-launch.ts`
- `tests/server/internal-fetch.test.ts`
- `tests/server/security.test.ts`
- `tests/types/generated/consumer-fixtures.ts`
- `FEASIBILITY.md`
- `EXECUTION.md`
- `tests/conformance/README.md`

## Accepted batch D

The user authorized batch D on November 17, 2026: build the production graph and verify its gates before E/F. Status: complete. D01–D08 passed independent review and the complete integrated gate. The accepted C source digest `4ea3964d1a8190bc9c22b7444059478a5e2ee44963416d486d5bc14022d189cb` still matches every recorded source file, and Bun remains 1.4.4. Delivery is local source, reproducible fixtures and recorded evidence in this non-Git workspace. E/F runtime loads, hooks, serialization, document assembly, navigation and application adoption are outside D.

The observable outcome is a relocatable production generation built from C's canonical manifest: separate browser/server graphs, lazy compiled node modules, route CSS, hashed imported assets and base-prefixed public URLs, served through Bun primitives in a standalone fixture and an existing Bun host. The coordinator owns `src/build/manifest-types.ts`, privacy checks, compiler corrections, root scripts, integration/browser/package witnesses and this record. The graph worker first probes `Bun.build` output metadata and then owns graph construction and its tests. The serving worker first probes native file responses and then owns publication/native serving and their tests. The continuing primary reviewer validates the contract and evidence. Workers cannot delegate or unilaterally change the shared schema.

| Gate | Binary acceptance | Command |
| --- | --- | --- |
| D01 | Actual Bun builds establish hashed/split output, entry/CSS/asset provenance and URL behavior; native HTTP probes record GET/HEAD/Range/cache/compression/method behavior before policy glue is added | `bun run test:build` |
| D02 | C's manifest generates separate production browser/server registries and lazy node modules; entry/shared chunks, layout/leaf CSS and imported assets are connected by actual Bun metadata; no missing emitted reference | `bun run test:build`; `bun run test:production` |
| D03 | Empty and nonempty base paths work for page bootstrap, lazy imports, route CSS, imported images and static files; unknown assets and out-of-base URLs remain 404; static/output collisions and invalid paths fail | `bun run test:production`; `bun run test:package` |
| D04 | Browser graphs reject direct/transitive/dynamic server-only imports, including type-only negative/positive controls; private/development sentinel bytes and source maps are absent from production browser output; build warnings/errors fail before publication | `bun run test:build`; `bun run test:production` |
| D05 | Complete immutable generations publish through an atomic pointer update; an actual failed rebuild leaves the prior pointer/bytes and serving valid; overlapping builds cannot corrupt one generation; publication failures retain the prior generation and clean owned staging | `bun run test:build` |
| D06 | Public files use exact manifest URLs and Bun file responses, preserve tested GET/HEAD/Range behavior and explicit immutable-vs-static cache policy; private files, traversal and unsupported methods do not fall through to page HTML | `bun run test:build`; `bun run test:package` |
| D07 | A copied/archived output runs from an unrelated directory with only Bun and its own files, no application source/node_modules/compiler/build step; first SSR response, hydration without recovery, interaction, CSS, lazy route fetches and static assets pass; existing-host API routes coexist | `bun run test:package`; `bun run test:production` |
| D08 | Independent review has no open findings; all D gates plus the complete accepted C/N/A/B matrix, actual package/build dependency audits, format/lint and strict types pass against one unchanged source state | `bun run test:batch-d` |

The base-path contract normalizes undefined, empty and `/` to empty; `/app/` normalizes to `/app`. Other bases must be slash-prefixed ASCII unreserved segments, without empty, dot/dot-dot, query, hash, percent or backslash components. Browser URLs use `base + /_assets/ + emitted path`; static files use `base + / + encoded relative path`. The fixture host accepts the root document at `/app` and `/app/`; prefix collisions and out-of-base paths return 404.

Immutable browser assets use `Cache-Control: public, max-age=31536000, immutable`; copied static assets use `Cache-Control: no-cache`. ETags are quoted SHA-256 values. Matching conditional GET/HEAD returns 304 with no body; nonmatching requests return the representation. Bun owns 206/416 range handling and HEAD body suppression. Unsupported methods return 405 with `Allow: GET, HEAD`. The selected D transport is identity encoding; no compression-negotiation parity claim is made.

The baseline is verified. The native serving probe passed (52 assertions); file responses supply range/HEAD behavior but no ETag/cache/method/compression policy. The browser-boundary probe passed (19 assertions), including indirect, unused barrel, alias, symlink, dynamic and type-only controls. The bundler probe identified incorrect component-relative CSS asset resolution in the existing plugin; its regression now passes with synthetic file-namespace CSS paths, so Bun resolves relative asset URLs from the component directory. Server compilation omits browser CSS imports. Production uses `Bun.build` and the existing Svelte compiler, not a replacement bundler or custom HTTP server. Private import policy is checked at the browser build boundary; E adds request/data security semantics. The fixtures own their minimal render/bootstrap code so D does not silently implement E/F. No deployment, registry publication, Linear write or Corvidae change is included. Shared-account token/cost telemetry is unavailable.

### D implementation and review

The graph worker supplied the native bundler probe and asset correspondence plugin; the serving worker implemented immutable publication, native asset handlers and failure/cleanup regressions. The coordinator owns the shared schema, final graph implementation, compiler correction, package/browser fixture, command wiring and acceptance. The continuing primary reviewer reviews the candidate and its evidence. A separate read-only security reviewer checks the named private-module/public-file boundary. Workers do not delegate or write external trackers.

`src/build/manifest-types.ts` extends C without replacing its canonical route manifest. Browser and server registries lazily import separately built page, layout, error, universal, server-load and endpoint roles; server roles never enter browser registries. Each route collects its page and inherited layout CSS. This avoids pulling an ancestor page's code/CSS into a descendant merely because it shares a physical node with the ancestor layout. The registry exports the corresponding Svelte runtime alongside its components, and the fixture hydrates with recovery disabled.

Bun supplies hashed entries, chunks, file-loader artifacts, native CSS URL resolution, streaming file responses and HTTP range/HEAD behavior. Its metafile omits file-loader asset outputs in this pinned version. The SSR asset plugin therefore correlates actual emitted file-loader bytes and source identity, using native metadata to distinguish JavaScript-imported files from CSS-only inlining. Tests cover identical bytes under different names, distinct SVGs, a PDF and a CSS-only SVG. Browser builds reject unresolved imports; server builds allow Bun's opaque-import mechanism because Svelte's server runtime uses it for a native `node:crypto` fallback. The clean-package gate certifies the selected fixture's closure, not arbitrary application-computed import paths.

Production publishes validated immutable generation directories and atomically renames a small current pointer. The output directory is resolved through existing symlink ancestors before source/output overlap is checked. Failed syntax, compiler warnings, invalid manifests, reserved namespaces, corrupt bytes and pointer obstructions leave the prior publication intact. Concurrent completions can choose either complete generation; publication does not promise invocation-order precedence. Previously published generations remain available to existing readers. Only failed owned staging/generation paths are removed.

Asset handlers are an exact native `Bun.serve` route table with `Response(Bun.file(...))`, plus the measured missing method/cache/ETag policy. They do not start a listener. A fixture-owned host combines them with an existing `/host-api`, compiled endpoint and minimal rendering/bootstrap code. Real gzip archives are extracted outside the workspace; application source is removed before launch, no ancestor has `node_modules`, and the process runs with auto-install disabled and a Bun-only PATH. Root and `/app/` checks cover first-request SSR, matching SSR/client asset URLs, image decoding, CSS, hydration, clicks and a separately requested lazy page module. This proves D composition without implementing E/F loads, document or navigation semantics.

The final build gate passed 16 tests (382 assertions), and the two packaged browser cases passed 72 assertions. Candidate review closed its canonical-asset-URL finding by validating URLs before pointer publication. Final review closed a source-removal evidence gap: the audit independently requires the original source directory to be absent and the runtime to sit outside the source/workspace, while the fixture removes source before writing that evidence. The archive audit passed five tests with 22 assertions, including deliberate output corruption, missing entries, forbidden provenance, private content, restored source, invalid runtime placement and incomplete/non-Bun process evidence. The independent security review found no actionable issue in its private-module/public-asset scope. Shared-account token/cost telemetry is unavailable; no resource allowance or later batch has been added.

### D acceptance result

`bun run test:batch-d` started at `2026-11-18T02:00:10.302628+00:00` and finished at `2026-11-18T02:01:10.684324+00:00` with exit 0 on Bun 1.4.4. It ran 61 passing Bun tests and zero failures, the 21 selected Kit/HTTP/Chromium routing comparisons, the earlier reference/candidate browser controls, 18 generated-consumer compiler/checker executions, native lifecycle/compiler/production regressions, both actual production archives, and the package/dependency/process audits. Formatting, lint and strict TypeScript/Svelte checks passed; both shared Svelte projects reported zero errors and warnings. No source file changed during the run.

Evidence: [batch-d.log](./.velveteen/evidence/batch-d.log), [batch-d-result.json](./.velveteen/evidence/batch-d-result.json), [root package evidence](./.velveteen/evidence/d07-root/artifact.json) and [base-path package evidence](./.velveteen/evidence/d07-base/artifact.json). Each package evidence directory contains the actual `production.tar.gz`, `process.json`, `stdout.log`, `stderr.log` and `browser.json`. The result records per-file hashes and aggregate source digest `e8da5f3db97e49bcb81b4d3d79dd2c6ba7ee0e7b15177af6097004632c4b20e6`. The command launcher resolves through the host's mise shim; the recorded runtime executable is independently checked against the successful packaged process. Its installation directory name is not the runtime version.

Markdown acceptance updates follow the run and receive a separate formatting check. Full upstream conformance and arbitrary application-computed dynamic-import closure are not claimed. E/F and Interborough adoption remain unstarted.

### D changed files

- `FEASIBILITY.md`, `EXECUTION.md`, `package.json`: accepted production scope, agent ownership, explicit commands, evidence and delivery boundary.
- `src/compiler/index.ts`: native relative CSS asset resolution, warning failures and server CSS omission.
- `src/build/manifest-types.ts`, `paths.ts`, `browser-boundary.ts`, `server-assets.ts`, `graph.ts`, `index.ts`, `publication.ts`, `serving.ts`: role graphs, public/server separation, asset correspondence, contained paths, complete-generation builds and native serving composition.
- `tests/build/native-bundler.test.ts`, `native-serving.test.ts`, `browser-boundary.test.ts`, `server-assets.test.ts`, `graph.test.ts`, `build.test.ts`, `publication.test.ts`, `serving.test.ts`: native boundary, privacy, provenance, CSS isolation, failure, concurrency and serving regressions.
- `tests/build/production-fixture.ts`, `fixture-host.ts`, `pack-production-fixture.ts`, `production-process.ts`, `run-production-fixture.ts`, `production.test.ts`, `package.test.ts`: actual archive, Bun-only startup, DOM-free SSR and browser integration witnesses.
- `tests/audit/audit-core.ts`, `audit.test.ts`, `production-artifact.ts`, `production-artifact.test.ts`: synthetic stylesheet provenance plus actual production archive/process audit and causal rejection controls.

## Accepted batch C

The user authorized batch C on November 17, 2026: routing, one canonical manifest, and generated TypeScript types. Status: complete. C01–C07 passed independent review and the full integrated gate; D had not started at C acceptance. The first-batch source identity still matches the accepted result, and Bun still reports 1.4.4. No baseline rerun is needed before implementation. Delivery remains local source and verification in this non-Git workspace.

The coordinator owns the shared manifest contract, route/type synchronization, root scripts, integration, this record and FEASIBILITY.md. The initial routing worker owned discovery and matching; the initial types worker owned generation and consumer checking. After review, the coordinator completed those implementations and strengthened their tests; the routing worker delivered the bounded upstream ordering port and the types worker supplied initial consumer fixtures. The continuing primary reviewer owns assertion-integrity and candidate review. Workers cannot delegate or change the shared schema unilaterally. One specialized agent could not start because its configured model is unavailable; the types assignment was dispatched to a supported worker, without changing scope or dependencies.

The selected C grammar includes static and embedded dynamic segments, optional and rest parameters (including empty rest and nonterminal rest), route groups, normal inherited layouts/errors, page and endpoint file roles, precedence, trailing slashes and encoded parameter values. Param matchers, layout-reset syntax, actions/remotes, load execution, navigation and production graph construction are outside this selected batch; unsupported route syntax must fail explicitly. Normal framework defaults have no physical application file and must be represented honestly in the manifest. C does not certify rendering error-boundary behavior, which belongs to E/F.

| Gate | Binary acceptance | Command |
| --- | --- | --- |
| C01 | Native Bun HTTP probes record exact route-selection/parameter mismatches before fallback matching is implemented; candidate dependency closure remains Bun-native | `bun run test:routing`; `bun run audit:dependencies` |
| C02 | Bun.Glob discovery yields deterministic route/node identities, one serializable manifest and aligned inherited layout/error structure; browser projection removes server implementation paths | `bun run test:routing` |
| C03 | Static/dynamic/optional/rest/grouped and embedded-parameter fixtures select the expected route and decoded parameters through both browser-safe matching and a real Bun listener; malformed encodings fail safely | `bun run test:routing` |
| C04 | Invalid grammar, duplicate parameter names, conflicting routes and invalid file roles fail with located diagnostics; upstream-derived cases keep provenance and preserved expectations | `bun run test:routing` |
| C05 | Generated route IDs/parameters, load/endpoint contexts, inferred page/layout data and typed Svelte props pass strict checking; invalid IDs, parameters, data and endpoint returns fail with expected diagnostics | `bun run test:types`; `bun run typecheck` |
| C06 | Actual create/rename/delete events regenerate owned declarations and publish the same manifest to HTTP/client consumers; stale generated files disappear, unrelated files survive, invalid candidates retain the last good publication, and watchers stop cleanly | `bun run test:routing`; `bun run test:types` |
| C07 | Independent review has no open findings; all C tests plus existing first-batch regressions, formatting, lint, strict types and package/dependency audit pass against one recorded source state | `bun run test:batch-c` |

The named C scripts are installed with their concrete tests. Source and runtime prerequisites are verified by the prior first-batch gate; C01 now verifies the native-dispatch behavior and its exact fallback boundary. Workers run focused gates, receive consolidated review findings, fix them and rerun affected checks. The complete integrated matrix runs once the candidate is stable. No failures, warnings, missing tests or unsupported syntax may be hidden to pass C. Shared usage/cost telemetry remains unavailable.

### C candidate evidence and review

The shared schema is `src/routing/manifest-types.ts`. Native probes show that ordinary parameter routes decode values, while trailing slashes, empty wildcard matches and wildcard/embedded capture names differ from the selected Kit contract. Compatible static/required paths use Bun's route registry; one browser-safe matcher reconciles precedence with optional/rest routes and handles fallback requests. A malformed URL raises `URIError` at matching and becomes HTTP 400 at dispatch. Route IDs retain groups; only URL paths erase them.

The selected routing matrix passes 21 literal expectations against the clean pinned Kit parser/matcher/sorter, an actual Bun listener and a Bun-built Chromium module. Sorting retains the upstream 28-route expected order. The selected-case ledger is `tests/inventory/routing-cases.json`; it does not mark whole upstream files passed. Discovery preserves physical ancestors, distinct source roles and aligned layout/error slots. Browser metadata excludes private server paths. Matchers, escape syntax, embedded optional/rest parameters and layout-reset syntax remain explicit rejections in C.

Generated declarations use TypeScript `rootDirs` for sibling `$types` imports. Application loads use `satisfies PageLoad`, `PageServerLoad`, `LayoutLoad` or `LayoutServerLoad` to preserve inferred return types; C does not implement Kit's annotation-stripping proxy generation. Strict consumer checks prove inherited server/universal data boundaries, child overrides, layout-only directories, config-only load fallback, coexisting page/endpoint sources, optional/rest parameters and Svelte props. The gate executes 18 compiler/checker commands, including eight causal negative controls and positive checks after restoration/create/rename/delete. Runtime execution of loads is outside C.

Early worker handbacks lacked consumer checking and complete routing semantics. They were rejected. The coordinator took discovery, grammar, dispatch, synchronization and generator implementation; the workers supplied a bounded upstream ordering port and initial consumer fixtures, which the coordinator strengthened. A reviewer initially reported static inspection as a passing test and raised two incorrect Kit-semantic findings; both were explicitly corrected against pinned source. Only actual command exits count as verification. No acceptance requirement was removed, and no timeout, retry or resource limit was increased. Shared-account token/cost telemetry is unavailable.

Focused checks passed: `bun test src/routing` (9 tests, 208 assertions), `bun test src/types` (2 tests, 9 assertions), `bun tests/types/generated/check-generated-types.ts` (18 compiler/checker executions), strict root TypeScript and affected ESLint. Final independent review cleared the remaining source-location witness after conflict errors and their assertions were strengthened. The complete integrated gate passed. C evidence is in `.velveteen/evidence/c01-native-routing.json`, `c03-routing-consumers.json`, `c05-generated-consumers.json` and `c06-synchronization.json`.

### C acceptance result

`bun run test:batch-c` started at `2026-11-17T23:05:12.478598+00:00` and finished at `2026-11-17T23:06:07.448999+00:00` with exit 0 on Bun 1.4.4. It ran 38 passing Bun tests, the 21-case Kit/HTTP/Chromium comparison, 18 generated-consumer compiler/checker executions (eight intended negative controls), and the complete earlier reference/candidate browser matrix, compiler, hot-reload, lifecycle and production regressions. The package/dependency/process audit, formatting, lint and strict TypeScript/Svelte checks all passed. Both shared Svelte projects reported zero errors and zero warnings. No source file changed during the run.

Evidence: [batch-c.log](./.velveteen/evidence/batch-c.log), [batch-c-result.json](./.velveteen/evidence/batch-c-result.json). The result records per-file hashes and aggregate source digest `4ea3964d1a8190bc9c22b7444059478a5e2ee44963416d486d5bc14022d189cb`. Markdown acceptance updates occur after the run and are checked separately; the source identity intentionally excludes Markdown. Full upstream conformance is not claimed. D was unblocked by C; its execution is recorded above.

### C changed files

- `FEASIBILITY.md`, `EXECUTION.md`, `package.json`: accepted scope, evidence, ownership and executable gates.
- `src/routing/manifest-types.ts`, `grammar.ts`, `match.ts`, `route-order.ts`, `index.ts`, `synchronize.ts`: canonical types, selected grammar, matching, native dispatch, discovery and watched publication.
- `src/routing/routing.test.ts`, `route-order.test.ts`, `synchronize.test.ts`, `LICENSE`: regression and oracle witnesses plus retained upstream license.
- `src/types/generate-route-types.ts`, `generate-route-types.test.ts`, `index.ts`: declarations, strict generated configuration, ownership checks and regressions.
- `tests/types/generated/consumer-fixtures.ts`, `check-generated-types.ts`: real application type consumers and causal controls.
- `tests/reference/routing-control.ts`, `tests/inventory/routing-cases.json`: isolated pinned oracle and selected-case accounting.

## Accepted first batch

The user authorized N verification followed by A and B in parallel on November 17, 2026. The fixed acceptance requirements are P01–P10 in [FEASIBILITY.md](./FEASIBILITY.md). Status: complete. N and P01–P10 passed independent review, and the entire first-batch gate exited 0 on November 17, 2026.

## Scope and ownership

Two implementation workers and one continuing primary reviewer were used. Worker A owned the pinned reference, inventory, and behavioral harness, then completed isolated browser and entry-discovery tests. Worker B implemented the Svelte compiler and production/source-map probes. The coordinator owned native verification, shared tooling, integration, lifecycle publication, dependency/process audits, and corrections. The read-only `feasibility_review` agent remained the primary reviewer throughout and cleared all N/P01–P10 findings before the final gate. No worker delegated.

The directory was initially empty and is not a Git repository. Delivery is local source, reproducible probes, and evidence. No later framework batch, Corvidae change, package publication, Linear issue, pull request, release, or deployment was performed. Shared-account token and cost telemetry is unavailable; no additional resource allowance has been assumed.

## Exact environment

| Component | Identity |
| --- | --- |
| Host | macOS arm64 |
| Bun | 1.4.4, revision `38afee6c8` |
| TypeScript | 6.0.3 |
| Bun declarations | `@types/bun` and `bun-types` 1.4.4 |
| Node declarations | `@types/node` 26.6.6 |
| Svelte | 5.57.1 on both targets |
| Browser driver | Playwright 1.63.0, Chromium |
| Svelte checker | 4.7.8 |
| Kit reference | `a58e0a92c35dbeee161e96c733464dc7397e073a`, package 3.3.0 |
| Reference build tooling | Vite 8.3.3, Svelte Vite plugin 7.3.1, Node adapter 6.0.4 |
| Compiler map composition | `@jridgewell/remapping` 2.3.5 |

The actual Bun executable reports 1.4.4 even though its installation directory contains `1.3.14`. Recorded commands use `process.execPath`; executable realpath and runtime version are verified separately. Do not infer runtime version from the installation directory. Candidate subprocess PATH contains only Bun. Chromium is the browser subprocess, not an application Node dependency.

Both declaration boundaries use `skipLibCheck: false`. Candidate Bun ambient declarations and reference Vite ambient declarations are checked in separate TypeScript projects. Explicit checker configuration prevents Svelte Check from scanning unrelated configurations in the isolated upstream checkout. Positive Svelte checking passes; deliberately invalid TypeScript and Svelte files must produce their expected type errors.

## Accepted mechanisms and limits

N passed review before A/B began. R01–R10 prove native handler/route replacement, admitted-request and stream continuity, cancellation, graceful stop, module-cache limits, and narrow form/cookie/HTML/CSRF behavior. The inventory retains explicit unverified scope for broader APIs.

P02 compares a real pinned Kit fixture and the real candidate in development and production. Both serve the same page, endpoint, and non-HTML 404 contract, signal hydration, and respond to an actual browser click. The reference copies 243 exact Kit source files into the installed package location; symlinking the checkout caused Kit's server-only import guard to misclassify paths. No Kit implementation was patched. Source cleanliness and exact identity are checked before use.

P03 retains causal negative controls for a wrong endpoint, empty selection, forbidden transitive/aliased dependency, Node executable, incomplete execution evidence, and invalid bundle/package provenance. Real candidate build metadata, emitted file hashes, completed command records, and the actual tarball are audited. Each production invocation has an immutable build directory and manifest so a later control cannot overwrite its evidence.

P04/P08 use Svelte's compiler with Bun builds. A typed component imports a typed rune module; DOM-free SSR, external CSS, hydration with recovery disabled, interactivity, and empty browser errors pass. Generated browser stack positions map through served maps to exact original component/rune lines and contents. Nontrivial TypeScript syntax has its own regression. TypeScript's parser and map composition are used because the installed Bun transpiler API does not expose the source maps needed for rune-module type erasure; Bun remains the runtime and bundler.

P05–P07 publish separate generated JavaScript, CSS, and maps. The direct plugin control resets state on CSS edits with maps both enabled and disabled. The generated-file control and actual watched-source browser tests preserve counter state and document identity on a CSS edit. Component/rune edits reinitialize state as specified. A malformed source produces a located watcher diagnostic; the last good output remains mounted until repair. Bun supplies HTML hot reload and its browser transport.

P09 uses real filesystem add/rename/delete events, serialized rescans, and `server.reload()` on one listener. It records background errors and requires none, and it preserves an unrelated admitted request. This is simple entry discovery; full route grammar belongs to C.

P10 uses experimental `Bun.ModuleGraph` and explicit application-owned cleanup. Held A requests remain A while new requests and an existing browser fetch B. Syntax/initialization failures preserve B and clean failed resources. Abort releases request subscriptions; ten edits retain one current callback; a stale asynchronous candidate cannot replace a newer publication. Each retired graph is disposed after its requests drain, and an actual owned Bun build child exits cleanly. This proves buffered SSR lifecycle composition, not streaming graph disposal or general memory bounds. No custom supervisor was introduced.

The raw native `--hot` probe remains deliberately unsuccessful: it leaves the held A request unsettled and retains old callbacks. `bun run probe:native-hot` exits 1 and writes the rejected mechanism's observations. Its assertions were not weakened; the accepted P10 implementation is the independently tested ModuleGraph alternative. Experimental ModuleGraph remains a material dependency to reassess when upgrading Bun.

## Reproduction and verification

From `/Users/stevekinney/Developer/velveteen`, run `bun install --frozen-lockfile`, then `bun run prepare:reference`. If needed, install the browser with `bun node_modules/@playwright/test/cli.js install chromium`. Run `bun run test:first-batch` for the complete first-batch gate. Later framework scripts named in the proposal are not implemented by this batch.

| Command | Required result | Evidence |
| --- | --- | --- |
| `bun install --frozen-lockfile` | Exit 0, exact root dependency graph | Installed lock and manifest |
| `bun run prepare:reference` | Exit 0, clean pinned checkout and 243 matching source files | `.velveteen/evidence/reference-prepare.log`; `tests/reference/identity-digest.json` |
| `bun run test:native` | Exit 0, R01–R10 | Complete gate log |
| `bun run test:inventory` | Exit 0, complete file/script ledger and rejected inventory-loss controls | Complete gate log; `tests/inventory/ledger.json` |
| `bun run test:harness` | Exit 0, four-cell baseline and restoration; causal negative controls | `harness-controls.json`, `commands.jsonl`, per-process logs under `.velveteen/evidence` |
| `bun run test:types` | Exit 0, valid fixture accepted and both invalid fixtures rejected | Complete gate log |
| `bun run audit:dependencies` | Exit 0, real dependency/process/build/package audit and negative controls | `.velveteen/evidence/dependency-audit.json` |
| `bun run test:compiler` | Exit 0, component/rune compilation, TypeScript regression, diagnostics and CSS | Complete gate log |
| `bun run test:development` | Exit 0, P05–P07/P09/P10 | Complete gate log; P09/P10 JSON evidence |
| `bun run test:production` | Exit 0, P04/P08 browser/SSR/hydration/maps | Complete gate log |
| `bun run format:check`; `bun run lint`; `bun run typecheck` | All exit 0, no skipped library checks or warnings | Complete gate log |
| `bun run probe:native-hot` | Exit 1 for the documented rejected mechanism | `.velveteen/evidence/native-hot-control.log`; `p10-native-hot-lifecycle.json` |

The final `bun run test:first-batch` execution started at `2026-11-17T22:21:33.932329+00:00` and finished at `2026-11-17T22:22:06.266196+00:00` with exit 0. It ran 27 passing Bun tests, the four-cell baseline and restored browser matrix, causal negative controls, the real dependency/artifact/process audits, and all formatting/lint/strict type gates. Both Svelte Check projects reported zero errors and zero warnings. No source file changed during the run. The full log is [first-batch.log](./.velveteen/evidence/first-batch.log); the command, exit, per-file source hashes and aggregate source digest `54d702e5b5748f8abd108044ca31dffac35ec7a8e9823d7f098c69f566b4a5c5` are in [first-batch-result.json](./.velveteen/evidence/first-batch-result.json). The preserved raw hot-reload diagnostic separately exited 1 for the documented held-request and retired-callback failures. Full upstream conformance remains the later batches.

## Changed surfaces

- `FEASIBILITY.md` and this record: observed results, native choices, ownership, scope and evidence.
- `package.json`, `bun.lock`, `tsconfig.json`, `svelte.config.ts`, `eslint.config.ts`, `.prettierrc.json`, `.prettierignore`, `.gitignore`: exact dependencies, reproducible commands and tooling boundaries.
- `src/compiler/index.ts`, `compiler.test.ts`, `production.test.ts`: component/rune compiler, map composition, production and browser regressions.
- `src/development/index.ts`: watched source compilation and separate generated asset publication.
- `tests/reference`, `tests/inventory`, `tests/conformance`: exact oracle, source ledger, comparative harness and retained CSS mechanism controls.
- `tests/audit`, `tests/types`, `tests/lifecycle`, `tests/fixtures/candidate`: audit/type negative controls, native lifecycle/discovery probes and the real candidate fixture.
- `bun-primitives.test.ts`: existing native probe retained, with formatting normalized by the project formatter.

## Decision history

The user chose SvelteKit behavior with room for API improvements, requested inventory-first native composition, and explicitly authorized finding a strict compatible declaration matrix. The first-batch authorization followed those decisions. Focused review rejected false witnesses in early prototypes, including direct diagnostic calls, map-presence checks, synthetic stale tickets, uncalled resource initializers, and simulated entry updates; the accepted tests exercise those effects directly. Review also corrected reference source identity, hydration readiness, cleanup races, filesystem publication ordering, and evidence overwritten by later builds. These corrections changed the implementation and probes, not the fixed P01–P10 acceptance criteria.
