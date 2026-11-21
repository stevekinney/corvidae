# Pinned inventory

`ledger.json` is generated from NUL-delimited `git ls-files` and package manifests in `tests/reference/upstream` at the exact recorded Kit commit. Every tracked test-shaped file retains classification, runner, modes, status and provenance; every package test/check script retains its literal command. The file inventory is not an executed-test count.

Every entry has one accountable feature batch. The deterministic `featureOwner` classifier assigns specific mutation/static/compiler/routing/build/server/browser families before assigning shared fixture and runner infrastructure to A. Broad upstream test files can span several features; their file owner owns decomposition, while `routing-cases.json` and `runtime-cases.json` identify the independently executed cases. An owner does not imply completion. Existing `reference-only` statuses remain unchanged.

| Owner | Responsibility for remaining source inventory |
| --- | --- |
| A | Reference harness, runner/configuration and shared fixture infrastructure |
| B | Svelte compilation, development server and hot reload |
| C | Routing, matchers and generated declarations |
| D | Build, assets, manifests, adapters and deployment |
| E | Server rendering, shared runtime, loads, hooks, cookies, fetch and streaming |
| F | Browser navigation, hydration, history, preload, scroll and focus |
| G | Forms, actions, remotes and mutation security |
| H | Prerendering, static deployment and service workers |

Run `bun tests/reference/prepare-upstream.ts`, then `bun tests/inventory/generate-ledger.ts` only when deliberately refreshing the pinned source or ownership classification, followed by `bun tests/inventory/check-inventory.ts`. The checker verifies all 2,658 files and 195 scripts, exact source identity, metadata and commands. Missing entry, missing script, altered script, unknown file owner and missing script owner controls must fail for their intended diagnostic.

## Batch Z audit

The prototype uses SvelteKit 3.3.0 at `a58e0a92c35dbeee161e96c733464dc7397e073a` as a behavioral reference. The source inventory contains 149 executable test-definition files, 2,509 support files, and 195 package test/check scripts. All inventory entries retain their `reference-only` disposition. A source file can contain many tests, and a fixture can draw on several of them.

[Runtimes and pinned cases](./runtime-cases.json) maps 28 shared fixtures to 58 named cases in nine pinned source files. Each fixture ran on Velveteen and pinned Kit, in development and production, for 112 observations. The harness uses Playwright Chromium, with explicit JavaScript-disabled checks for native actions, rendering modes, route announcements, custom action transport, and progressive remote forms. [Selected routing](./routing-cases.json) accounts separately for four Batch C routing and manifest entries, checked with Bun, real HTTP and Chromium as appropriate. [Shared harness](../conformance/README.md)

The full Batch J chain includes framework tests outside the comparison matrix. These include a fresh TypeScript starter, strict generated declarations and their failing controls, Bun graph retirement and stream cleanup, scoped tracing, native upload limits, and a relocated Bun-only artifact with compression. The tracing and compression fixtures draw on pinned upstream examples and run as Velveteen tests. [Execution and exact gate evidence](../../EXECUTION.md#accepted-batch-z-pinned-inventory-audit)

### Intentional differences

- Escaped literals take literal route precedence. The pinned Unicode sibling fixture selects the dynamic route in Kit.
- Form CSRF checks apply in both modes. The pinned Kit development path permits the equivalent submission.
- The query-batching fixture starts cache reads on mount and initially serves a 200 document. Kit's initial SSR with a missing query serves 404. Both retain successful sibling results.
- The prototype's typed registries, navigation context and shallow-state entry points use explicit framework APIs. [API mappings and limits](../conformance/README.md)

### Unverified coverage

- Firefox, WebKit, the full JavaScript-disabled project, and the cross-product of async compilation and server-side router resolution remain outside the executed matrix. The pinned runner defines them as distinct configurations. [Browser settings](../reference/upstream/packages/kit/test/utils.js#L242) · [Basics variants](../reference/upstream/packages/kit/test/apps/basics/playwright.config.js)
- The remote proof covers cached finite queries, batching, command refresh and dedicated progressive forms. Live query streaming and reconnects, `requested(...)` refresh behavior, and the broader remote form field API still need individual fixtures. [Pinned async cases](../reference/upstream/packages/kit/test/apps/async/test/client.test.js)
- The portable Bun artifact and the offline static fixture establish their own deployment behavior. Node, Cloudflare and Vercel adapter suites, comparative performance and long-run memory bounds remain unverified. Interborough remains a read-only reference, with real application adoption outside the fixture acceptance.
