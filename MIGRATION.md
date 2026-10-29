# Migration inventory

This is the historical consolidation record, including decisions and validation results from the migration. Use the [workspace README](README.md) for current commands and package boundaries. Temporary evidence paths and test totals below describe their recorded runs; they are not prerequisites or current validation results.

This inventory records the consolidation boundaries and validation evidence. The architecture and dependency tables describe the current workspace; later sections retain earlier checkpoints and their original commands. Dependency arrows point from consumer to provider. All fifteen libraries are private source workspaces; the playground is the application.

## Source revisions

- Agent Bureau: `87f701072cd9f2f427dd17b5f08f3ba15db87269`, clean at inspection.
- Weft: `9ddc15c882e5e2c9ab70489e63e947b988c5961e`, clean at inspection.
- Cinder: `895716bfd7d3b19b9c94818800349e0aee3cb664`; preserve staged `AB-429-final-contract-review.md`.
- Corvidae base: `94950e35fe4d030c47da58b3e62fe6197a3d877a`; preserve three deleted setup scripts.

## Package inventory

| Source repository and path | Destination | Old name | New name | Classification |
| --- | --- | --- | --- | --- |
| `/Users/stevekinney/Developer/agent-bureau/packages/bureau` | `packages/bureau` | `bureau` | `@lostgradient/bureau` | Library |
| `/Users/stevekinney/Developer/agent-bureau/packages/operative` | `packages/operative` | `@lostgradient/operative` | `@lostgradient/operative` | Library |
| `/Users/stevekinney/Developer/agent-bureau/packages/armorer` | `packages/armorer` | `armorer` | `armorer` | Library |
| `/Users/stevekinney/Developer/agent-bureau/packages/conversationalist` | `packages/conversationalist` | `conversationalist` | `conversationalist` | Library |
| `/Users/stevekinney/Developer/agent-bureau/packages/memory` | `packages/memory` | `memory` | `@lostgradient/memory` | Library |
| `/Users/stevekinney/Developer/agent-bureau/packages/skills` | `packages/skills` | `skills` | `@lostgradient/skills` | Library |
| `/Users/stevekinney/Developer/agent-bureau/packages/interoperability` | `packages/tool-protocol` | `interoperability` | `@lostgradient/tool-protocol` | Library |
| `/Users/stevekinney/Developer/agent-bureau/packages/interoperability` | `packages/embeddings` | `interoperability` | `@lostgradient/embeddings` | Library |
| `/Users/stevekinney/Developer/agent-bureau/packages/interoperability` | `packages/cryptography` | `interoperability` | `@lostgradient/cryptography` | Library |
| `/Users/stevekinney/Developer/agent-bureau/packages/lifecycle` | `packages/lifecycle` | `lifecycle` | `@lostgradient/lifecycle` | Library |
| `/Users/stevekinney/Developer/weft/packages/weft` | `packages/weft` | `@lostgradient/weft` | `@lostgradient/weft` | Library |
| `/Users/stevekinney/Developer/weft/packages/weft-ui` | `components/weft-ui` | `@lostgradient/weft-ui` | `@lostgradient/weft-ui` | Browser component library |
| `/Users/stevekinney/Developer/cinder/packages/components` | `components/cinder` | `@lostgradient/cinder` | `@lostgradient/cinder` | Browser component library |
| `/Users/stevekinney/Developer/cinder/packages/chat` | `components/chat` | `@lostgradient/chat` | `@lostgradient/chat` | Browser component library |
| `/Users/stevekinney/Developer/cinder/packages/editor` | `components/editor` | `@lostgradient/editor` | `@lostgradient/editor` | Browser component library |
| `/Users/stevekinney/Developer/cinder/packages/markdown` | `packages/markdown` | `@lostgradient/markdown` | `@lostgradient/markdown` | Library |
| `/Users/stevekinney/Developer/cinder/packages/testing` | `packages/testing` | `@cinder/testing` | `@lostgradient/testing` | Library |
| `/Users/stevekinney/Developer/cinder/labs/chat-room` | `applications/chat-room`, later `applications/desktop`, since removed | `@cinder/chat-room-lab` | `@lostgradient/chat-room`, later `@lostgradient/desktop` | Application |
| `/Users/stevekinney/Developer/cinder/packages/playground` | `applications/playground` | `@cinder/playground` | `@lostgradient/playground` | Application |
| Extracted from `applications/chat-room` | `packages/telephone`, since removed | — | `@lostgradient/telephone` | Library |
| New in COR-1348 | `packages/evaluation` | — | `@lostgradient/evaluation` | Library |

## Architecture

Browser component libraries Cinder, Chat, Editor, and Weft UI live under `components/`; other shared libraries remain under `packages/`. Repository configuration lives under `internal/`. Every workspace uses `@lostgradient/*`.

All source libraries are private ESM packages with the sole export `{ ".": "./src/index.ts" }`. Consumers compile source. Internal dependencies use `workspace:*`; external versions are centralized in the root Bun catalog. The configuration-only `@lostgradient/typescript` workspace lives at `internal/typescript` and exports only `library.json` and `browser.json`. Both compose a private `base.json`; the unused server preset has been removed.

Shared tool and JSON contracts belong to `@lostgradient/tool-protocol`. Embedding contracts and vector mathematics belong to `@lostgradient/embeddings`. Hashing, signing, and timing-safe comparison belong to `@lostgradient/cryptography`. Armorer owns its Standard Schema detection and declares `@standard-schema/spec` directly.

The playground is the application. It owns a Bun dev server and static exporter. The `weft` package owns the `weft` and `weft-mcp` source executables. Weft UI owns its Bun browser test host in `components/weft-ui/scripts/browser`. Cross-component browser tests and their Bun host belong to root `scripts/browser-fixtures`; neither test host has a workspace identity. The unused starter server and greeting library have been removed. Libraries have no build or upstream-build dependency.

Turbo's transit task incorporates upstream source in check hashes without executing builds. Application build outputs are `build/**` and `.svelte-kit/**`. Root browser fixture tests cache their generated manifest and lazy-import catalog; dev, preview, clean, and lint-fix tasks are uncached. Workspace tests execute serially because absolute performance assertions require an uncontended workload. Thresholds, assertions, timeouts, and retries are preserved.

File length, closure hoisting, and generic simplification are design-review guidance. Classic cyclomatic complexity is capped at 100 in implementation and tests and 300 under `scripts/`. Refactors retained here establish specific source owners, remove duplication, or repair demonstrated defects. TypeScript's strict configuration, including `noImplicitReturns`, enforces the contracts; lint remains warning-failing. Cinder retains its ES2022 browser runtime contract.

## Complete internal dependency graph

Arrows run from consumer to provider. Every manifest edge appears below, including development dependencies. The 20-workspace graph has 79 edges. Root tooling adds 1 development edge; no package depends on the root.

| Consumer | Runtime or source-contract providers | Development providers |
| --- | --- | --- |
| `@lostgradient/playground` | `@lostgradient/chat`, `@lostgradient/cinder`, `@lostgradient/editor`, `@lostgradient/markdown`, `@lostgradient/testing` | `@lostgradient/typescript` |
| `@lostgradient/chat` | `@lostgradient/cinder`, `conversationalist`, `@lostgradient/markdown` | `@lostgradient/testing`, `@lostgradient/typescript` |
| `@lostgradient/cinder` | `@lostgradient/markdown` | `@lostgradient/testing`, `@lostgradient/typescript` |
| `@lostgradient/editor` | `@lostgradient/cinder`, `@lostgradient/markdown` | `@lostgradient/testing`, `@lostgradient/typescript` |
| `@lostgradient/weft-ui` | `@lostgradient/cinder`, `@lostgradient/markdown`, `@lostgradient/weft` | `@lostgradient/testing`, `@lostgradient/typescript` |
| `armorer` | `@lostgradient/cryptography`, `@lostgradient/embeddings`, `@lostgradient/lifecycle`, `@lostgradient/tool-protocol` | `@lostgradient/typescript` |
| `@lostgradient/bureau` | `armorer`, `conversationalist`, `@lostgradient/lifecycle`, `@lostgradient/memory`, `@lostgradient/operative`, `@lostgradient/skills`, `@lostgradient/tool-protocol`, `@lostgradient/weft` | `@lostgradient/typescript` |
| `conversationalist` | `@lostgradient/lifecycle`, `@lostgradient/tool-protocol` | `@lostgradient/typescript` |
| `@lostgradient/cryptography` | None | `@lostgradient/typescript` |
| `@lostgradient/embeddings` | None | `@lostgradient/typescript` |
| `@lostgradient/evaluation` | `armorer`, `conversationalist`, `@lostgradient/cryptography`, `@lostgradient/operative` | `@lostgradient/typescript` |
| `@lostgradient/lifecycle` | None | `@lostgradient/typescript` |
| `@lostgradient/markdown` | None | `@lostgradient/typescript` |
| `@lostgradient/memory` | `armorer`, `@lostgradient/cryptography`, `@lostgradient/embeddings`, `@lostgradient/lifecycle`, `@lostgradient/weft` | `@lostgradient/typescript` |
| `@lostgradient/operative` | `armorer`, `conversationalist`, `@lostgradient/cryptography`, `@lostgradient/embeddings`, `@lostgradient/lifecycle`, `@lostgradient/tool-protocol`, `@lostgradient/weft` | `@lostgradient/typescript` |
| `@lostgradient/operative-anthropic` | `armorer`, `conversationalist`, `@lostgradient/operative` | `@lostgradient/lifecycle`, `@lostgradient/testing`, `@lostgradient/typescript` |
| `@lostgradient/operative-gemini` | `armorer`, `conversationalist`, `@lostgradient/cryptography`, `@lostgradient/lifecycle`, `@lostgradient/operative` | `@lostgradient/testing`, `@lostgradient/typescript` |
| `@lostgradient/operative-openai` | `armorer`, `conversationalist`, `@lostgradient/operative` | `@lostgradient/lifecycle`, `@lostgradient/testing`, `@lostgradient/typescript` |
| `@lostgradient/operative-typesafe` | `conversationalist`, `@lostgradient/operative` | `@lostgradient/typescript` |
| `@lostgradient/skills` | `armorer`, `@lostgradient/cryptography`, `@lostgradient/lifecycle`, `@lostgradient/tool-protocol`, `@lostgradient/weft` | `@lostgradient/typescript` |
| `@lostgradient/testing` | None | `@lostgradient/typescript` |
| `@lostgradient/tool-protocol` | `@lostgradient/lifecycle` | `@lostgradient/typescript` |
| `@lostgradient/typescript` | None | None |
| `@lostgradient/weft` | None | `@lostgradient/typescript` |
| Repository root | None | `@lostgradient/chat`, `@lostgradient/cinder`, `conversationalist`, `@lostgradient/editor`, `@lostgradient/testing`, `@lostgradient/typescript` |

## Direct external dependencies

These dependencies belong to the workspaces that import them. Source-consumed type contracts, including Conversationalist's Anthropic SDK types, remain explicit dependencies. Test runners, compiler tools, and test-only SDKs are development dependencies. All listed versions resolve through the root catalog; third-party implementations remain installed dependencies.

A root override consolidates SvelteKit and Express on `cookie@0.7.2`. This removes the low-severity [cookie attribute-injection advisory](https://github.com/advisories/GHSA-pxg6-pf52-xh8x). The installed SvelteKit consumer rejects malformed names, paths, and domains while preserving ordinary secure serialization and parsing; the same probe failed those three rejection cases with `0.6.0`. The all-severity audit now returns an empty advisory set.

| Workspace | Direct external dependencies |
| --- | --- |
| `@lostgradient/playground` | `@lostgradient/environmentalist`, `@shikijs/themes`, `lucide-svelte`, `postcss`, `shiki`, `svelte`, `ts-morph`, `zod` |
| `armorer` | `@modelcontextprotocol/client`, `@modelcontextprotocol/core`, `@modelcontextprotocol/server`, `@openai/agents`, `@opentelemetry/api`, `@standard-schema/spec`, `zod` |
| `@lostgradient/bureau` | `zod` |
| `@lostgradient/chat` | `decode-named-character-reference`, `micromark-util-decode-numeric-character-reference`, `svelte`, `zod` |
| `@lostgradient/cinder` | `@floating-ui/dom`, `@shikijs/engine-oniguruma`, `@shikijs/langs`, `@shikijs/themes`, `@shikijs/types`, `@tanstack/virtual-core`, `ajv`, `ajv-formats`, `culori`, `esm-env`, `libphonenumber-js`, `lucide-svelte`, `qrcode`, `shiki`, `svelte`, `zod` |
| `conversationalist` | `@anthropic-ai/sdk`, `js-yaml`, `zod` |
| `@lostgradient/evaluation` | `zod` |
| `@lostgradient/editor` | `@floating-ui/dom`, `@milkdown/ctx`, `@milkdown/kit`, `@milkdown/prose`, `esm-env`, `prosemirror-inputrules`, `prosemirror-model`, `prosemirror-state`, `prosemirror-view`, `svelte` |
| `@lostgradient/markdown` | `@shikijs/engine-oniguruma`, `@shikijs/langs`, `@shikijs/types`, `@types/mdast`, `@types/unist`, `comlink`, `diff-match-patch`, `hast-util-sanitize`, `js-yaml`, `rehype-katex`, `rehype-sanitize`, `rehype-stringify`, `remark-gfm`, `remark-math`, `remark-parse`, `remark-rehype`, `remark-stringify`, `shiki`, `unified`, `unist-util-visit` |
| `@lostgradient/memory` | `zod` |
| `@lostgradient/operative` | `@lostgradient/environmentalist`, `@opentelemetry/api`, `zod` |
| `@lostgradient/operative-anthropic` | `@anthropic-ai/sdk` |
| `@lostgradient/operative-gemini` | `@google/genai`, `@lostgradient/environmentalist`, `zod` |
| `@lostgradient/operative-openai` | `openai` |
| `@lostgradient/operative-typesafe` | `@tanstack/ai`, `@tanstack/ai-typesafe` (optional peers) |
| `@lostgradient/skills` | `gray-matter`, `zod` |
| `@lostgradient/testing` | `@axe-core/playwright`, `@playwright/test`, `@testing-library/svelte`, `happy-dom`, `postcss-value-parser`, `svelte`, `typescript`, `zod` |
| `@lostgradient/weft` | `@msgpack/msgpack`, `@valibot/to-json-schema`, `valibot`, `zod` |
| `@lostgradient/weft-ui` | `@shikijs/langs`, `@shikijs/themes`, `@tanstack/svelte-query`, `cron-parser`, `lucide-svelte`, `svelte` |

## Public API and ownership changes

- Every former library subpath is consolidated into its supported source root. Consumers use `@lostgradient/*`; no old-name packages, aliases, or compatibility entrypoints remain.
- Operative owns agent runtime, providers, sessions, scheduling, and test fixtures. Runtime and generation tracing use their actual distinct names (`instrumentRun`, `instrumentGenerate`); scheduler events use `SchedulerTaskCompletedEvent` and `SchedulerTaskFailedEvent`. Identical provider response-format/tool-choice definitions share their existing type owner.
- Armorer exports MCP and OAuth directly from their source owners, removing the internal barrel cycle. Its runtime-service types remain intentional constituents of the public execution contract; their implementation is owned by Lifecycle.
- Bureau exposes its supported harness and quiescence APIs without forwarding unrelated Operative constants. Interoperability owns shared JSON/tool contracts; Lifecycle owns event and runtime primitives.
- Chat exposes the named `Chat` component. Cinder, Chat, and Editor root entries load their required styles. Editor's placeholder contracts are imported directly from Markdown. Markdown exposes its parser, serializer, renderer, highlighter, worker, diff, and templating APIs at the root.
- Weft owns durable execution and storage. Its CLI lives beside the engine, while Weft UI consumes its public API; Weft has no reverse dependency on Weft UI. Generated workflow declaration fixtures augment `@lostgradient/weft` and remain exact product-code-generation contracts, not library declaration output.
- Workflow-file loading and CLI validation belong to `packages/weft/src/cli`. Their accidental library-root exports were removed after verifying that every caller is a CLI caller and that the source library never exposed them. Native module loading and all validation tests moved with their owner.
- Cinder's supported component types and runtime helpers are available from its source root. Its Bun knowledge command remains package-local tooling. Browser applications consume public components and explicit fixture hosts; they do not copy component implementations or recreate the omitted playground application.

The Editor import-boundary suite retains its real browser/server import checks and synthetic matcher regressions. Two obsolete README assertions requiring registry installation of optional peers were removed after the dependency documentation was corrected to private workspace ownership.

## Shared configuration and infrastructure

- Root Prettier, Oxlint, editor settings, ignores, catalog, and lockfile govern the workspace. Repository source-inclusion rules prevent personal Git ignore patterns from hiding required source while preserving explicit environment, credential, dependency, and generated-output exclusions. `@lostgradient/typescript` owns strict compiler policy. Local configurations remain only where their tool requires a workspace boundary.
- `@lostgradient/testing` owns Happy DOM setup, Svelte cleanup, real server rendering/hydration, fixture extraction, accessibility, browser interactions, and screenshot utilities. Owning test suites keep browser servers and Playwright projects under `scripts/`; applications own their application-specific browser tests.
- `scripts/build-browser.ts` shares native Bun compilation settings between the two browser test hosts, using the existing `@lostgradient/testing` Svelte compiler. Chat-room owns its Vite-specific grammar plugin under `applications/chat-room/scripts`; its tested grammar parsing helpers remain at the root. Asset identity, imports, grammar immutability, and production loading retain regression coverage.
- Root architecture checks require locked workspace executable metadata to match manifests and point to existing files; this catches the stale Weft CLI entrypoint found during the lockfile refresh. They also reject internal dependency cycles, undeclared imports, old package imports, subpaths, library builds, publishing setup, and hook installation. They also verify canonical project-skill ownership and native uncached Turbo watch dispatch in the editor. A real Turbo fixture verifies that upstream source changes invalidate downstream tasks and that the existing `CODEX_CI` benchmark profile is passed through strict mode and included in the cache hash.

## Removed systems

- Root GitHub Actions, Lefthook configuration, hook scripts, hook installation, template postinstall/setup automation, and obsolete build/check scripts.
- Source CI/CD definitions, publishing workflows, Changesets/release metadata, npm archives, publish-only fixtures, package lockfiles, generated library output, declaration builds, bundler/package adapters, and release scripts.
- Copied package lint/format/editor configuration, redundant TypeScript build configurations, duplicate DOM/compiler infrastructure, and references to intentionally omitted applications where they existed only for packaging or playground execution.
- The old Testing-owned browser runner, Docker snapshot setup, playground URL and page fixture were removed after mapping their assertions to the browser application. Native Playwright snapshot paths replace the package-local baseline resolver; all 1,372 PNG baselines are preserved byte-for-byte under the root browser test tooling. Three unreferenced Operative provider-subpath facades were removed; the root already exports the provider owners directly.
- Four obsolete Cinder selective-CI scoping files (`component-graph` and `test-changed`, each with its obsolete tests). Retained Cinder token and component tooling participates in source lint, typechecking, and tests.
- The unreferenced CLI package-mount fixture manifest and stale library output exclusions were removed. The obsolete CLI console-build mount and its flags are removed. Operator UI behavior remains covered by the Weft UI browser suite.
- Dead manifest dependencies identified by import inventory: four Bureau development dependencies and six Armorer documentation-tool dependencies. Unused root catalog entries were removed.

Existing user changes are preserved, including the three removed setup scripts and `.env.example`. Source repositories are read-only throughout. Committed fixtures and metadata needed by product behavior and tests remain.

## Demonstrated defects and regression coverage

- Own `__proto__` JSON keys previously disappeared or changed prototypes during canonical serialization. Armorer and Bureau now create own data properties; original-source controls fail and corrected cases pass.
- Cinder token readers reject malformed JSON records and non-string registry values while preserving own special keys. Focused guide checks compare exact token/value pairs through the existing Markdown table parser, independent of formatter padding, and reject missing, incorrect, duplicated, or misplaced values. GuidanceRegion’s reset assertion follows the renamed loop binding while preserving every dismissal/focus oracle. Its documentation checker validates supported root exports, including aliased, type-only and multiline imports, and rejects removed subpaths. The retained tooling suite includes token, component, prose-import, and README Usage contracts. The original 2,861 tooling cases passed before the final README restoration; the new source-oracle selection passes all 45 focused cases.
- Restored Weft checkout and order-processing demonstrations retain all nine runtime cases, including real SQLite and server health/shell checks. Their source and tests participate in the existing package gates, with no new workspace or library build.
- Weft native SQLite tests verify executable identity before launching all 21 native Node cases. Two regressions reject filesystem-backed Bun shims, including a PATH containing no real Node. The actual root-launched Weft test command and its focused lint/typecheck/test command both pass after the repair; the earlier root failure remains recorded. Turbo preserves the existing constrained-runner benchmark profile without changing any threshold.
- Chat virtual rows use their actual content height instead of intrinsic placeholder sizes. Smooth bottom navigation uses the existing scroll guard to retain its target as rows mount. History fixtures compare request generations to preserve ownership across Svelte proxies. Browser tests fail on runtime errors and warnings. Chat session updates retain stale-run fences and propagate fixture errors. Editor restores the overflow-closing effect and avoids duplicate document traversal.
- Editor form helpers now reproduce the exact live form payload, including anchor positions; persisted state exports still omit those transient positions. All 28 form/export browser cases pass. The JSON export assertion validates the original object instead of projecting away fields before checking them.
- Editor selection-popover dismissal uses the existing settled-selection owner for both close and submit. A reverted-implementation control fails the new transient-refocus regression in all three engines; the corrected complete comment-creation family passes 48 cases. Keyboard setup observes the public editor selection and advances the installed ProseMirror focus timer with Playwright Clock before arrow input instead of sleeping between keys. Current Editor and Chat-room lint/typecheck pass.
- Cinder browser fixture generation and runtime resolution share one application-owned declaration. This removes the mismatch that advertised the dropdown's labelled fixture without allowing it to load. All six labelled-dropdown theme/viewport cases pass. Tabs fixtures now supply the panels their triggers control, and Mega-menu shortcut lists use valid list children; their full focused 34-case browser selection passes.
- Weft Console's obsolete Popover stylesheet import is removed because the Cinder source entry owns that stylesheet. A real Vite CSS compilation regression rejects discarded imports and other CSS warnings. The fresh complete 17-case operator browser suite passes after moving filesystem workflow loading to its CLI owner.
- Testing retains its screenshot mode, pixel comparison, metadata, fixture schema and border-tier assertions. Native application baseline paths preserve all 1,372 PNG files. Real local image loading and object-URL tests replace fake-host assumptions; the 217-case helper suite passes without DNS errors.
- Split Chat-room specifications previously disappeared from Firefox/WebKit project selection. Configuration and selection regressions restore every applicable case. Clipboard and native-tab contracts select supported engines explicitly, with no runtime skipped tests.
- Fresh application checks generate the inputs they consume: Chat-room lint synchronizes SvelteKit configuration, and Cinder fixture tests generate their manifest. Turbo caches those generated inputs separately from application build output. Disposable cold checks reproduce both original missing-file failures and pass after repair; a behavioral cache regression proves restoration without re-executing the task.
- Chat-room’s provider inventory classifies Operative’s direct dependencies and requires every supported SDK. Two causal regressions reject an unclassified dependency and a removed provider; the old optional-peer check passed both incorrectly. The workspace import scanner also covers `Bun.resolve` and `Bun.resolveSync`, preserving the sole-entry-point boundary for explicit resolution calls.
- Browser callbacks retain their own runtime bindings. Three migration-induced references to test-runner helpers or renamed outer variables are repaired; a TypeScript symbol-scope regression checks inline Playwright callbacks. Review-mode absence tests retain both negative oracles and now verify the first registered positive observer as well. All 51 focused review-mode cases pass; a subsequent diagnostic-path regression is included in the complete matrix.
- Marquee browser examples have explicit mount ownership. Its dynamic-label assertions preserve labelled content, label changes, and removal of region semantics without matching the separate scrolling example; a visible-component assertion prevents a vacuous absence check. The original full-matrix failure and the corrected 99-case development selection provide regression evidence.
- Toast timer regressions wait for component setup before installing Bun's fake clock, then observe Svelte updates directly. This avoids Testing Library's Jest-only fake-timer polling without adding a compatibility global. The original seven failing cases pass in the complete 54-case focused file, preserving timer cleanup, focus restoration, Escape ownership, swipe, and removal assertions.
- Toolbar retains disabled controls for managed tab indexes while selecting only enabled controls for the active tab stop and Escape navigation. Three causal regressions fail against the broken implementation; all 28 Toolbar tests pass with the repair.
- Editor persistence, clipboard, command and diff diagnostics retain their original console methods and production/development boundaries. A production browser bundle regression fails against the migrated `devWarn` persistence path and passes after restoring the original warning. Explicit document-debug utilities may print under a focused root lint policy; ordinary UI debug logging remains rejected.
- Chat-room emits the canonical denied tool call before its typed settlement and legacy result. A causal regression verifies exact ordering, one settlement per call, nonexecution and successful run completion. The transport owns this repair; Operative remains unchanged.
- Cinder array-copy lint rewrites introduced ES2023 methods into ES2022 browser code. Copy/sort/reverse primitives restore the contract, with a source regression. Getter-based error stringification preserves a single read and the original receiver.

- Carousel, Marquee, and horizontal Timeline preserve native keyboard access. Carousel pauses after focus entry until explicit Play, places rotation first in keyboard order, preserves editable/widget shortcuts and transfers focus before outgoing content becomes inert. Pointer actions are captured before focus changes their label; a WebKit event trace and canceled-press regression prove the repair. The complete focused Carousel suite passes 110 tests; native keyboard interaction coverage passes 42 cases across three engines and both themes. [CIN-637](https://linear.app/lost-gradient/issue/CIN-637) records the independently owned original-source Carousel defects without modifying that repository.

## Initial browser accounting

Chat-room has 1,129 supported project executions: the source's 1,127 entries, plus three Shiki executions, three selection-dismissal and three selection-helper error-path regression executions and two overflow-readiness regressions, minus six unsupported non-Chromium clipboard entries and three WebKit native-tab entries formerly skipped at runtime. Exact title/project and moved-body comparisons account for every source case.

The Cinder application manifest has 190 components and 230 explicit fixture groups. Two themes and three viewports produce 1,380 generated cases. The development and preview matrices now select 2,467 tests across 73 files: the prior 2,425 cases plus 42 focused keyboard interactions across Chromium, Firefox, and WebKit. All 38 original Chat harness cases and the restored focus, nested-overlay, and reduced-motion assertions remain. The prior full runs identified Carousel focus, Chat fixture selection, and Tree mounting defects; those repairs pass their focused regression checks. The complete final development run executed all 2,467 cases: 2,464 passed and three failed. Two failures coincided with independently recorded host network changes; one exposed an ambiguous Marquee fixture scope introduced by the new scrolling example. The repaired fixture and unchanged network-interrupted cases all pass in the 99-case focused development rerun. The original development run remains recorded as exit 1. The complete final production matrix passes all 2,467 cases with exit 0 (`/tmp/corvidae-cinder-production-final-lock-status.json`).

The 42 new cases prove actual keyboard scrolling, visible focus, list semantics, reduced-motion behavior, Carousel tab order, outgoing-slide focus recovery, sticky autoplay pause, explicit restart, pointer cancellation, and editable input/range ownership. macOS WebKit uses its native Option-Tab navigation for controls; the input test initializes the caret before checking native arrow movement. Native scroll tests hold the arrow until scrolling begins and release in `finally`, because a plain-HTML control demonstrates that WebKit can cancel scrolling on immediate keyup. No browser or assertion is skipped.

## Initial validation

The user approved the assessed focus repairs. Their implementation and independent final review are complete. All eight required root commands pass against the final lockfile, and the complete production browser matrix passes all 2,467 cases. Focused Cinder and browser-application lint/typecheck pass with zero warnings. All 110 Carousel tests and all 42 new browser interaction cases pass. The complete Chat-room browser command already passes all 1,129 cases, including production routes and development hydration. All fifteen migrated libraries have passing focused lint/typecheck/test evidence; the complete Cinder gate passes 11,814 tests after the Toast repair.

Carousel uses a programmatically focusable root (`tabindex=-1`) and a keyboard-reachable viewport. Three narrow Svelte compiler comments document standards-valid native scrolling in Carousel, Marquee, and horizontal Timeline; the compiler cannot infer CSS overflow. These comments do not disable a compiler check globally. Identical original components emit the same relevant warnings under source Svelte 5.56.4 and destination Svelte 5.57.0. The source permitted warnings, while this workspace fails them. Removed focus targets were migration regressions and are restored. The separate inherited autoplay/control-order/input-ownership defects are also repaired. The earlier four-comment proposal is superseded.

The native Node resolver failure is repaired. The final ordered root sequence passes installation, lint, typecheck, tests, builds, formatting, aggregate validation, and the high-severity audit. The later all-severity audit also reports no advisories after the cookie dependency correction.

Accepted focused integration evidence:

| Working directory | Command | Exit | Evidence |
| --- | --- | --- | --- |
| `applications/chat-room` | `bun run test:browser` | 0 | 1,129 cases; `/tmp/corvidae-chat-room-final-observer-overflow-status.json` |
| `applications/chat-room` | `bun run test:browser 'hydration.e2e\|server-owned-streaming\|page.svelte'` | 0 | 103 cases with the final cookie dependency; `/tmp/corvidae-chat-room-cookie-runtime-status.json` |
| `applications/chat-room` | `bun run test:browser 'hydration.e2e\|server-owned-streaming\|server-owned-overflow\|review-ssr-and-a11y\|review-comment-creation\|review-state-and-session' --max-failures=1` | 0 | 219 cases; `/tmp/corvidae-observer-overflow-integration-focused-status.json` |
| `applications/chat-room` | `bun run test:browser 'review-ssr-and-a11y.native-tab\|review-state-and-session\|review-comment-creation\|server-owned' --max-failures=1` | 0 | 173 browser cases; `/tmp/corvidae-chat-room-four-repairs-focused-status.json` |
| `applications/cinder-browser-fixtures` | `bun run test:browser:preview --workers=1` | 0 | 2,467 cases; `/tmp/corvidae-cinder-production-final-lock-status.json` |
| `applications/cinder-browser-fixtures` | `bun run test:browser:preview keyboard-scroll.playwright.ts --workers=1` | 0 | 42 cases; `/tmp/corvidae-keyboard-pointer-final-status.json` |
| `applications/cinder-browser-fixtures` | `bun run test:browser documentation-product.playwright.ts keyboard-scroll.playwright.ts schema-form.playwright.ts components.playwright.ts --grep 'documentation product contracts\|keyboard-scroll\|SchemaForm native\|access-gate\|marquee' --workers=1` | 0 | 99 cases; `/tmp/corvidae-development-final-repairs-status.json` |
| `components/cinder` | `env TZ=UTC LANG=en_US.UTF-8 bun test --conditions browser --conditions svelte --parallel=1 src/components/carousel` | 0 | 110 cases; `/tmp/corvidae-carousel-pointer-cancellation-green.log` |
| `components/cinder`, `applications/cinder-browser-fixtures` | `bun run lint`, `bun run typecheck` in each workspace | 0 each | `/tmp/corvidae-focus-final-static/status.json` |
| Repository root | `bun test applications/chat-room/src/lib/chat-agent.part-03.test.ts` | 0 | Eight cases after an original-implementation exit1 control; `/tmp/corvidae-repair-causal-controls/status.json` |
| Repository root | `bun test components/editor/src/lib/session/persistence.test.ts` | 0 | 17 cases after a production-bundle exit1 control; `/tmp/corvidae-production-bundle-causal/status.json` |
| `components/cinder` | `bun test --conditions browser --conditions svelte src/components/toolbar/toolbar.test.ts` | 0 | 28 cases after three causal failures; `/tmp/corvidae-toolbar-focus-green.log` |
| `applications/weft-console` | `bun run test:e2e --max-failures=1` | 0 | 17 browser cases; `/tmp/corvidae-weft-console-browser-after-ownership-status.json` |
| `components/editor` | `bun run lint`; `bun run typecheck` | 0 each | `/tmp/corvidae-root-selection-static/status.json` |
| `applications/chat-room` | `bun run lint`; `bun run typecheck` | 0 each | `/tmp/corvidae-root-selection-static/status.json` |
| Repository root | `bun test scripts/workspace-contract.test.ts scripts/workspace-imports.test.ts` | 0 | 27 architecture cases; `/tmp/corvidae-architecture-after-cli-owner.log` |
| Repository root | `bunx tsc --noEmit`; `bun run test:self`; `bun run format:check` | 0 each | Final source-ownership checks, including all 59 repository tests; `/tmp/corvidae-final-source-ownership-quality/status.json` |

### Focused workspace gates

All commands below run from the repository root and have recorded exit-zero evidence.

| Workspace | Exact command | Exit | Evidence |
| --- | --- | --- | --- |
| `armorer` | `bunx turbo run lint typecheck test --filter=armorer --concurrency=1` | 0 | `/tmp/corvidae-focused-agent-graph-final/1.log` |
| `@lostgradient/bureau` | `bunx turbo run lint typecheck test --filter=@lostgradient/bureau --concurrency=1` | 0 | `/tmp/corvidae-focused-agent-graph-final/2.log` |
| `@lostgradient/chat` | `bunx turbo run lint typecheck test --filter=@lostgradient/chat --concurrency=1` | 0 | `/tmp/corvidae-focused-interface-graph-final/1.log` |
| `@lostgradient/cinder` | `bunx turbo run lint typecheck test --filter=@lostgradient/cinder --concurrency=1` | 0 | 11,814 tests; `/tmp/corvidae-cinder-after-focus-and-toast-final/1.log` |
| `conversationalist` | `bunx turbo run lint typecheck test --filter=conversationalist --concurrency=1` | 0 | `/tmp/corvidae-focused-agent-graph-final/3.log` |
| `@lostgradient/editor` | `bunx turbo run lint typecheck test --filter=@lostgradient/editor --concurrency=1` | 0 | `/tmp/corvidae-focused-interface-repair-final/1.log` |
| `@lostgradient/interoperability` | `bunx turbo run lint typecheck test --filter=@lostgradient/interoperability --concurrency=1` | 0 | `/tmp/corvidae-focused-light-graph-final/1.log` |
| `@lostgradient/lifecycle` | `bunx turbo run lint typecheck test --filter=@lostgradient/lifecycle --concurrency=1` | 0 | `/tmp/corvidae-focused-light-graph-final/2.log` |
| `@lostgradient/markdown` | `bunx turbo run lint typecheck test --filter=@lostgradient/markdown --concurrency=1` | 0 | `/tmp/corvidae-focused-markdown-weft-final/1.log` |
| `@lostgradient/memory` | `bunx turbo run lint typecheck test --filter=@lostgradient/memory --concurrency=1` | 0 | `/tmp/corvidae-focused-light-graph-final/3.log` |
| `@lostgradient/operative` | `bunx turbo run lint typecheck test --filter=@lostgradient/operative --concurrency=1` | 0 | `/tmp/corvidae-focused-agent-graph-final/4.log` |
| `@lostgradient/skills` | `bunx turbo run lint typecheck test --filter=@lostgradient/skills --concurrency=1` | 0 | `/tmp/corvidae-focused-light-graph-final/4.log` |
| `@lostgradient/testing` | `bunx turbo run lint typecheck test --filter=@lostgradient/testing --concurrency=1` | 0 | `/tmp/corvidae-focused-interface-repair-final/2.log` |
| `@lostgradient/weft` | `bunx turbo run lint typecheck test --filter=@lostgradient/weft --concurrency=1` | 0 | `/tmp/corvidae-native-node-cinder-final/2.log` |
| `@lostgradient/weft-ui` | `bunx turbo run lint typecheck test --filter=@lostgradient/weft-ui --concurrency=1` | 0 | `/tmp/corvidae-focused-interface-repair-final/3.log` |
| `@lostgradient/chat-room` | `bunx turbo run lint typecheck test build --filter=@lostgradient/chat-room --concurrency=1` | 0 | Final dependency state; `/tmp/corvidae-cookie-focused/2.log` |

Required ordered commands, completed against the final lockfile (`/tmp/corvidae-final-required-lock-verified/status.json`):

| Command                         | Exit | Evidence                                           |
| ------------------------------- | ---- | -------------------------------------------------- |
| `bun install --frozen-lockfile` | 0    | `/tmp/corvidae-final-required-lock-verified/1.log` |
| `bun run lint`                  | 0    | `/tmp/corvidae-final-required-lock-verified/2.log` |
| `bun run typecheck`             | 0    | `/tmp/corvidae-final-required-lock-verified/3.log` |
| `bun run test`                  | 0    | `/tmp/corvidae-final-required-lock-verified/4.log` |
| `bun run build`                 | 0    | `/tmp/corvidae-final-required-lock-verified/5.log` |
| `bun run format:check`          | 0    | `/tmp/corvidae-final-required-lock-verified/6.log` |
| `bun run validate`              | 0    | `/tmp/corvidae-final-required-lock-verified/7.log` |
| `bun audit --audit-level=high`  | 0    | `/tmp/corvidae-final-required-lock-verified/8.log` |

```bash
bun install --frozen-lockfile
bun run lint
bun run typecheck
bun run test
bun run build
bun run format:check
bun run validate
bun audit --audit-level=high
```

The supported Vite builds complete and can emit Rolldown's visible `PLUGIN_TIMINGS` advisory. Chat-room's reported SvelteKit `writeBundle` time includes awaited nested compilation; Weft Console's report measures Svelte/CSS transformation. These are profiling diagnostics, and no warning filter or timing threshold was changed. [Rolldown documents the timing heuristic and overlapping callback measurements](https://rolldown.rs/reference/InputOptions.checks#plugintimings).

Chat-room’s complete browser command, `bun run test:browser` from `applications/chat-room`, exits 0 with 1,129 passing cases (`/tmp/corvidae-chat-room-final-observer-overflow-status.json`). Its Playwright configuration starts production through `bun run build && bun run preview` and development through `bun run dev -- --port 5175 --strictPort`. These scripts execute `bun --bun vite build`, `bun --bun vite preview`, and `bun --bun vite dev`. Production routes, streaming, and hydration checks exercise the actual servers; Playwright owns their startup and shutdown.

Focused commands cover every migrated library and `applications/chat-room`; application evidence additionally runs supported Vite dev/build/preview commands. Independent reviews cover runtime semantics, source APIs and dependencies, Cinder reactivity/browser compatibility, and browser case/assertion preservation.

## Original consolidation review

This section records the original consolidation snapshot, before component relocation and starter removal. Its file counts, paths, and 22-workspace graph are historical; the architecture and complete dependency graph above describe the current workspace.

The selected source and tests occupy fifteen new library directories. Application entrypoints and browser infrastructure occupy four new application directories alongside the existing server. Root manifests, lockfile, shared configuration, validation scripts, editor settings, ignores, and documentation describe this internal workspace. The source repositories, user environment files, and unrelated worktrees remain unchanged. The Chef history contains rejected submissions, recovery snapshots, review findings, and final command evidence. Final acceptance confirms all eighteen reviewed integration files are unchanged, the 22-workspace/78-edge graph matches the reviewed acyclic graph, and all three source repository revisions and working-tree states match their initial snapshots (`/tmp/corvidae-final-acceptance.json`). All 1,372 baseline PNGs and their provenance JSON remain byte-identical under the native Chromium/Linux snapshot directory (`/tmp/corvidae-final-baseline-preservation.json`); this is preservation evidence, not a claim of new pixel-comparison coverage.

The reviewed file inventory contains 38 tracked changes and 10,001 new files or links, including 7,149 source and script files, including declaration fixtures and 1,372 browser snapshot baselines. The nine additional project-skill paths are three canonical documents and six relative provider links. Package and application directories are listed in the tables above. Shared changes are concentrated in these files:

- Workspace policy and dependency ownership: `package.json`, `bun.lock`, `turbo.json`, `packages/shared/package.json`, `packages/shared/tsconfig.json`, and `internal/typescript/{package.json,library.json}`.
- Quality and editor configuration: `.oxlintrc.json`, `.prettierrc.json`, `.prettierignore`, `.gitignore`, and `.vscode/{extensions.json,tasks.json}`.
- Local validation: `scripts/{bun-matchers.test.ts,lint-policy.test.ts,task-cache.test.ts,typecheck-contracts.ts,workspace-contract.test.ts,workspace-imports.test.ts}` and `scripts/shiki-grammar-assets{.ts,.test.ts}`.
- Existing application tooling: `applications/server/{package.json,tsconfig.json,scripts/build.ts}`; redundant local lint, Bun test, and build TypeScript configurations were removed.
- Documentation and agent guidance: `README.md`, `MIGRATION.md`, `AGENTS.md`, and the existing project skills, now owned once under `.agents/skills/{add-dependency,add-workspace,validate-monorepo}/SKILL.md` with relative links from both `.claude/skills` and `.codex/skills`. The existing `CLAUDE.md` delegates to `AGENTS.md`.

CI, hook, and obsolete setup-script deletions are recorded under removed systems. The three user-owned setup deletions and `.env.example` remain preserved user state.

## Workspace naming and imported-document cleanup

This section records the directory-normalization snapshot, before starter removal. All five applications at that point moved under `applications/`; workspace discovery, Bun lockfile paths, lint and TypeScript configuration, editor launch commands, CLI mount fixtures, screenshot commands, and project guidance use that directory. The starter-removal checkpoint retained four applications; the later ownership correction retains only Chat-room. Cinder's documentation lives under `components/cinder/documentation`; token generation and documentation checks read the renamed directory. Historical command evidence above predates the directory rename; its workspace paths are displayed using the current names.

The repository retains one root `LICENSE`. Five duplicate package license files, eight redundant package license declarations, and package README license sections were removed. Obsolete imports removed after consumer inspection: Weft's release traceability matrix, both Weft migration-omission notes, Cinder's registry-oriented `llms.txt`, its unused public-package peer-version checker and companion constant test, and the completed Tree multi-select gap-analysis note. The root inventory owns migration bookkeeping.

Weft's runtime acceptance suite retains every external test-reference assertion previously supplied by the release matrix, with explicit source paths, as well as its behavioral tests. Current worker protocol documents remain because protocol tests verify their message contracts. Component manifests, coverage thresholds, token guides, focus policy, and current component ownership guidance remain with their consumers. Dead documentation links to omitted repository material were removed from the affected guides. Root workspace identity now matches the lockfile; an existing contract test also verifies that identity.

### Verification after directory normalization

The renamed applications pass their existing runtime gates:

| Directory | Command | Exit | Evidence |
| --- | --- | --- | --- |
| `applications/chat-room` | `bun run test:browser 'hydration.e2e\|page.svelte.e2e'` | 0 | 55 tests, including Vite development hydration and production preview; `/tmp/corvidae-follow-on-runtime/1.log` |
| `applications/cinder-browser-fixtures` | `bun run test:browser:preview keyboard-scroll.playwright.ts --workers=1` | 0 | 42 tests across Chromium, Firefox, and WebKit; `/tmp/corvidae-follow-on-runtime/2.log` |
| `applications/cinder-browser-fixtures` | `bun run test:browser documentation-product.playwright.ts --workers=1` | 0 | 20 development tests; `/tmp/corvidae-follow-on-runtime/3.log` |
| `applications/weft-console` | `bun run test:e2e` | 0 | 17 tests; `/tmp/corvidae-follow-on-runtime/4.log` |
| Repository root | `bun applications/weft-cli/src/cli-main.ts --help` | 0 | CLI entrypoint resolves; `/tmp/corvidae-renamed-cli-help.log` |
| `packages/weft` | `bun test src/server/operation-catalog-acceptance.test.ts src/worker/protocol.test.ts` | 0 | 29 tests; `/tmp/corvidae-document-cleanup-weft-tests.log` |
| `components/cinder` | `TZ=UTC LANG=en_US.UTF-8 bun test --conditions browser --conditions svelte --parallel=1 src/components/source-diff-viewer/source-diff-viewer.test.ts` | 0 | 81 tests; `/tmp/corvidae-staged-whitespace-tests.log` |

Staging exposed whitespace in imported comments and intentional trailing spaces inside patch fixtures. Comment whitespace was removed; fixture spaces use explicit escapes. All 464 parsed string and template values in that test file remain identical, and its regression suite passes. The obsolete template setup scripts that were already deleted in the user's working tree are included in the commit because they are retired migration setup machinery; `.env.example` remains untouched and uncommitted.

The complete root sequence also passes after cleanup. Exact command statuses are recorded in `/tmp/corvidae-follow-on-validation/status.json`, with one numbered log per command.

| Command                         | Exit |
| ------------------------------- | ---- |
| `bun install --frozen-lockfile` | 0    |
| `bun run lint`                  | 0    |
| `bun run typecheck`             | 0    |
| `bun run test`                  | 0    |
| `bun run build`                 | 0    |
| `bun run format:check`          | 0    |
| `bun run validate`              | 0    |
| `bun audit --audit-level=high`  | 0    |

The final `validate` run verifies the source and fixture edits found during staging. `git diff --cached --check` also passes. The source repositories retain their original revisions and working-tree states.

## Component workspace follow-on

This section records component relocation before starter removal. Cinder, Chat, Editor, and Weft UI moved from `packages/` to `components/`, and every workspace was renamed to `@lostgradient/*`. Runtime dependency direction and the then-current 22-workspace graph were unchanged by that relocation. Markdown remains an isomorphic processing library under `packages/`.

Shared `browser.json` supplies DOM types, browser/Svelte export conditions, and production-source selection without ambient Bun or Node types. Each component runs browser source and inclusive test/tooling checks. Root lint rejects server globals and imports in component source; the default inclusive `tsconfig.json` preserves Oxlint’s automatic type-aware project discovery. Moved Cinder’s local knowledge command from `src/cli` into `scripts/knowledge`, marked filesystem-only test helpers explicitly, and removed its unused alternate TypeScript configuration. Updated fixture discovery, metadata, styles, local commands, skills, and Turbo/cache/import contracts for the new roots.

The browser check exposed an ambient Bun dependency in portable hashing; its runtime capability checks now use the small structural contracts they actually consume, and hex comparison uses standard byte arrays. Editor development warnings use the existing `esm-env` export conditions. Regression tests cover browser compiler/lint boundaries, portable hashing compilation, warning conditions, and component-source cache invalidation.

Relocation regressions also cover Cinder’s Stylelint source classifiers, test-fixture compilation, and POSIX/Windows component-path normalization. Knowledge CLI coverage fixtures now assert its tooling ownership under `scripts/`. The root import-contract suite has one test per workspace, preserving every import assertion and the existing timeout. Independent review accepted these changes and verified that the then-current 22-workspace, 78-edge graph remained acyclic.

### Verification after component relocation

The required sequence passed in order on the final source. Full test execution completed all 21 workspace tasks, including 11,815 Cinder tests. The final repository contract run passed 87 tests and 47,274 assertions. The audit checked 742 dependencies and found no vulnerabilities. Exact logs and statuses are in `/tmp/corvidae-components-validation/`.

| Command                         | Exit |
| ------------------------------- | ---- |
| `bun install --frozen-lockfile` | 0    |
| `bun run lint`                  | 0    |
| `bun run typecheck`             | 0    |
| `bun run test`                  | 0    |
| `bun run build`                 | 0    |
| `bun run format:check`          | 0    |
| `bun run validate`              | 0    |
| `bun audit --audit-level=high`  | 0    |

Focused checks passed all 48 tasks with this command; the final root run supplied the matching cache entries. Evidence: `/tmp/corvidae-components-all-focused.log`, exit 0.

```bash
bunx turbo run lint typecheck test \
  --filter=@lostgradient/bureau --filter=@lostgradient/operative \
  --filter=armorer --filter=conversationalist \
  --filter=@lostgradient/memory --filter=@lostgradient/skills \
  --filter=@lostgradient/interoperability --filter=@lostgradient/lifecycle \
  --filter=@lostgradient/weft --filter=@lostgradient/weft-ui \
  --filter=@lostgradient/cinder --filter=@lostgradient/chat \
  --filter=@lostgradient/editor --filter=@lostgradient/markdown \
  --filter=@lostgradient/testing --filter=@lostgradient/chat-room --concurrency=1
```

Application probes passed 134 browser tests. These commands start the supported Vite development and production-preview servers through the existing Playwright configuration. The Weft CLI and relocated Cinder knowledge command also resolve their source dependencies and exit successfully. Evidence: `/tmp/corvidae-components-runtime/status.json` and its numbered logs.

| Directory | Command | Exit | Result |
| --- | --- | --- | --- |
| `applications/chat-room` | `bun run test:browser 'hydration.e2e\|page.svelte.e2e'` | 0 | 55 tests; development hydration and production preview |
| `applications/cinder-browser-fixtures` | `bun run test:browser:preview keyboard-scroll.playwright.ts --workers=1` | 0 | 42 tests across Chromium, Firefox, and WebKit |
| `applications/cinder-browser-fixtures` | `bun run test:browser documentation-product.playwright.ts --workers=1` | 0 | 20 development tests |
| `applications/weft-console` | `bun run test:e2e` | 0 | 17 browser tests with the real backend |
| Repository root | `bun applications/weft-cli/src/cli-main.ts --help` | 0 | CLI source entrypoint resolves |
| `components/cinder` | `bun run knowledge --help` | 0 | Relocated tooling entrypoint resolves |

The reviewed changes cover the four component trees; every workspace manifest and internal import; root Bun, Turbo, TypeScript, lint, formatting, and ignore integration; application fixture discovery; shared browser compiler policy; portable hashing and Editor development detection; regression tests; and repository documentation and skills. All moved functional files are accounted for. Source repositories remain unchanged, and the user-owned `.env.example` remains untouched. No compatibility aliases, library builds, publishing, deployment, CI/CD, or hooks were added.

## Starter removal and tooling policy

The unused `applications/server` and `packages/shared` starter workspaces were removed after the baseline report. Their sample code, tests, Bun build, debugger entries, and server-only lint exception are gone. That checkpoint contained 20 workspaces and 75 internal dependency edges and remained acyclic. Earlier validation sections describe their original snapshots; the generated baseline report was subsequently removed.

Oxlint now enforces classic cyclomatic complexity of at most 100 outside `scripts/` and 300 inside it. Regression tests exercise both boundaries, including JavaScript, TypeScript, Svelte scripts, tests, and root and workspace tooling paths. File size remains review guidance; no source refactoring was required by the new limits.

Executable repository tooling belongs under its owning `scripts/` directory. Weft’s benchmark runners, support, and associated regression suites move together from `src/benchmarks` to `scripts/benchmarks`; product imports and subprocess paths follow their new owner. Root report collectors now live at `scripts/measure-codebase.ts` and `scripts/inventory-dependencies.ts`, with normal strict TypeScript and type-aware lint checks. The root directly declares the Svelte compiler dependency used by measurement. Framework configuration, application entrypoints, product examples, test fixtures, and the supported Testing library API retain their existing responsibilities.

That earlier checkpoint had three Vite application hosts. The application-ownership correction below supersedes it: only Chat-room retains Vite; the two browser test hosts use Bun, and the root has no Vite dependency.

### Focused verification and reviewed files

The relocated Weft benchmark suites pass the same 31 tests and 361 assertions before and after the move. The eight new complexity cases accept exactly 100 or 300 and reject 101 or 301 for their respective paths. The root contract tests also compare the lockfile’s workspace keys with discovered manifests, preventing removed workspaces from lingering in the lockfile. The report collector reproduces the original collector’s file measurements, mapped template functions, complexity units, and aggregate statistics exactly against the same final source tree. The dependency collector resolves all 257 external dependency declarations to matching installed and locked versions.

| Directory | Command | Exit | Evidence |
| --- | --- | --- | --- |
| `packages/weft`, before relocation | `bun test ./src/benchmarks ./src/storage/bun-sql-benchmark.test.ts ./src/benchmarks/speculation.bench.ts` | 0 | 31 tests, 361 assertions; `/tmp/corvidae-remove-starters/benchmarks-before.log` |
| `packages/weft`, after relocation | `bun test ./scripts/benchmarks ./src/storage/bun-sql-benchmark.test.ts ./scripts/benchmarks/speculation.bench.ts` | 0 | 31 tests, 361 assertions; `/tmp/corvidae-remove-starters/benchmarks-after.log` |
| Repository root | `bun test scripts/lint-policy.test.ts scripts/workspace-contract.test.ts` | 0 | 56 tests, 1,889 assertions; `/tmp/corvidae-remove-starters/focused.log` |
| Repository root | `bun scripts/measure-codebase.ts /tmp/corvidae-remove-starters/measurement-final` | 0 | Exact original/new collector parity |
| Repository root | `bun scripts/inventory-dependencies.ts` | 0 | `/tmp/corvidae-dependency-inventory.json` |

Independent integration review accepted the tooling moves, dependency ownership, and lint policy after correcting stale current-state claims in this inventory. The reviewed follow-on touches these files and groups:

- Removed starter files: `applications/server/{package.json,tsconfig.json,scripts/build.ts,src/index.ts,src/index.test.ts}` and `packages/shared/{package.json,tsconfig.json,src/index.ts,src/index.test.ts}`.
- Relocated tooling: all 21 files from `packages/weft/src/benchmarks/` to `packages/weft/scripts/benchmarks/`; the two report collectors from `documentation/reports/codebase-baseline/` to `scripts/{measure-codebase.ts,inventory-dependencies.ts}`.
- Updated executable references and guardrails: `packages/weft/src/storage/bun-sql-benchmark.test.ts`, `scripts/{lint-policy.test.ts,workspace-contract.test.ts}`, `.oxlintrc.json`, and `.vscode/launch.json`.
- Updated dependency ownership: `package.json`, `bun.lock`, and `components/{cinder,weft-ui}/package.json`.
- Updated durable documentation: `AGENTS.md`, `README.md`, and this inventory. The generated `documentation/reports/codebase-baseline` snapshot was subsequently removed; the collectors remain under `scripts/` and write to `/tmp` by default.

The pre-existing migration changes and user-owned `.env.example` remain preserved. Source repositories are unchanged. No compatibility layers, library builds, publication, deployment, CI/CD, hooks, skipped tests, suppressions, or increased test budgets were introduced.

### Verification after starter removal and tooling relocation

The required sequence passed in order. All 19 workspace lint, typecheck, and test tasks ran successfully without cache reuse; all three application builds succeeded. The concluding `validate` command reused those matching Turbo results and reran the root checks. Its final root contract suite passed 92 tests and 47,199 assertions. Exact statuses and numbered logs are in `/tmp/corvidae-remove-starters/validation/`.

| Command                         | Exit |
| ------------------------------- | ---- |
| `bun install --frozen-lockfile` | 0    |
| `bun run lint`                  | 0    |
| `bun run typecheck`             | 0    |
| `bun run test`                  | 0    |
| `bun run build`                 | 0    |
| `bun run format:check`          | 0    |
| `bun run validate`              | 0    |
| `bun audit --audit-level=high`  | 0    |

## Application ownership correction

The standalone `weft-cli`, `weft-console`, and `cinder-browser-fixtures` workspaces are removed. Chat-room is the sole application. The current graph above accounts for every internal dependency; it is acyclic, with 19 workspaces, 72 workspace edges, and 6 root tooling edges.

Weft owns its CLI implementation, tests, fixtures, and source `weft`/`weft-mcp` executables. The obsolete console mount command and options are removed, with unknown-option regression coverage. Weft UI retains the `WeftConsole` component and all operator workflows; its browser host, backend fixture, and Playwright tests now live under `components/weft-ui/scripts/browser`. Cross-component browser fixtures live under `scripts/browser-fixtures`, with no application manifest or package identity.

Both test hosts compile Svelte and serve browser assets with Bun. Root `scripts/build-browser.ts` owns common HTML-entry compilation, browser export conditions, explicit development/production compiler modes, module provenance, and native WebAssembly loading. The existing Testing package still owns the Svelte compiler integration. Root tooling declares its actual component and compiler dependencies. Chat-room owns its Vite grammar-asset plugin and retains the documented SvelteKit `vite dev`, `vite build`, and `vite preview` commands.

Five Cinder component export barrels were flattened into its sole public entrypoint because Bun otherwise retained unused component CSS. All 1,508 public exports are preserved. The curated browser fixture retains its original 500 KiB asset limit, verifies that Button CSS is present and Tree CSS absent, and now exercises actual syntax highlighting. This caught and fixed a binary-WASM-versus-instantiator mismatch that static artifact checks alone missed.

Browser host regressions cover nested asset URLs, malformed requests, serialized rebuilds, failed-build recovery, source changes, HTTP authorization and redirects, compressed responses, SSE cancellation, and WebSocket text and binary frames. Weft UI watches its two browser entrypoints with Bun’s documented stat-based file watches because native macOS directory events intermittently missed immediate atomic saves. Watches start before compilation and are released on partial startup failure; regression tests inspect rebuilt assets after repeated saves and verify natural process exit after a failed build. No test assertions, snapshots, timeouts, retry counts, or asset thresholds were weakened. All 1,372 moved PNG snapshots are byte-identical.

### Reviewed files and removed systems

- Moved the CLI tree and source entrypoints from `applications/weft-cli` into `packages/weft/src`; updated `packages/weft/package.json`, internal imports, and its 38 public-consumer type fixtures.
- Moved the cross-component browser fixture tree from `applications/cinder-browser-fixtures` into `scripts/browser-fixtures`; replaced Vite configuration, glob discovery, and the old host with Bun build/serve scripts and an explicit generated fixture catalog. The build now owns manifest copying, removing the separate copy command.
- Moved the console host and tests from `applications/weft-console` into `components/weft-ui/scripts/browser`; removed its application manifest, Vite configuration, and standalone build contract. Weft UI owns the retained development and browser test commands.
- Updated `scripts/build-browser.ts`, its regression suite, and `packages/testing/src/svelte-plugin.ts` and tests; removed Cinder's five obsolete component-export barrels and updated its public entrypoint and stylesheet contract test.
- Updated root `package.json`, `bun.lock`, `turbo.json`, `tsconfig.json`, `.oxlintrc.json`, ignores, and workspace/import/cache tests. Root fixture-generated inputs have declared cache outputs; all watchers remain uncached. Libraries retain source-only exports and have no build tasks.
- Updated `README.md`, this inventory, affected package documentation, the CSS audit command, and Testing's browser command references. The generated baseline report was subsequently removed; reproducible collectors remain under `scripts/`.

The independent MCP-v2 task's Armorer, catalog, lockfile, and patch-removal changes were preserved and included in combined workspace validation. This ownership correction did not alter the source repositories or the user-owned `.env.example`. No publishing, CI/CD, deployment, Git-hook, compatibility, or library-build machinery was introduced.

### Browser and cold-start verification

| Working directory | Exact command or probe | Exit | Result |
| --- | --- | --- | --- |
| Repository root | `bun run test:browser:preview --workers=1 --max-failures=1` | 0 | 2,467 browser tests; Bun production host, including Chromium, Firefox, and WebKit projects |
| Repository root | `bun run test:browser documentation-product.playwright.ts --workers=1 --max-failures=1` | 0 | 20 development browser tests |
| `components/weft-ui` | `bun run test:browser` | 0 | 17 operator workflow tests against the Bun host and real Weft backend |
| `applications/chat-room` | `bun run test:browser 'hydration.e2e\|page.svelte.e2e\|shiki-grammar-assets.e2e' --max-failures=1` | 0 | 58 tests exercising supported Vite development and production-preview tooling |
| `packages/weft` | `bun test src/cli src/cli-edge-coverage.test.ts src/cold-start.test.ts` | 0 | 758 focused CLI, client, and cold-start tests |
| Disposable authored-source copy | `bun install --frozen-lockfile` and root fixture task cache miss/hit | 0 | Cold generation succeeds; a cache hit restores the generated manifest and module catalog after both are removed |
| Disposable authored-source copy | Native Bun development host and Chromium provider-edit probe | 0 | 190 fixture groups; an actual Cinder Button source edit appears after rebuild, with no browser diagnostics |

Detailed command logs, immutable before-captures, move/removal accounting, public-export comparison, and snapshot hashes are retained under `/tmp/corvidae-app-ownership/`. The cold copy excludes credentials, environment files, dependencies, caches, and generated output; it does not modify a source repository or another worktree.

### Final integrated validation

The required sequence completed in order on September 17, 2026, after the final watcher fix and the parallel Armorer task's formatting corrections. The first integrated run executed all 17 test tasks without cache reuse. The final run reran changed tasks and reused only matching results; it represents 36,784 passing workspace tests. The concluding root contract suite passed 93 tests and 46,941 assertions. The audit found no vulnerabilities across 666 packages.

Exact statuses and logs are in `/tmp/corvidae-app-ownership/validation-02/status.json` and its numbered command logs.

| Command                         | Exit |
| ------------------------------- | ---- |
| `bun install --frozen-lockfile` | 0    |
| `bun run lint`                  | 0    |
| `bun run typecheck`             | 0    |
| `bun run test`                  | 0    |
| `bun run build`                 | 0    |
| `bun run format:check`          | 0    |
| `bun run validate`              | 0    |
| `bun audit --audit-level=high`  | 0    |

All fifteen migrated libraries and Chat-room also passed their focused commands. The TypeScript configuration workspace is configuration-only and is validated through its consumers and the root contracts. Exact focused evidence is in `/tmp/corvidae-app-ownership/focused-accepted.json`; the Weft UI entry points to the fresh command after the final host change.

| Exact focused command | Exit |
| --- | --- |
| `bunx turbo run lint typecheck test --filter=armorer --concurrency=1` | 0 |
| `bunx turbo run lint typecheck test --filter=@lostgradient/bureau --concurrency=1` | 0 |
| `bunx turbo run lint typecheck test --filter=@lostgradient/chat --concurrency=1` | 0 |
| `bunx turbo run lint typecheck test build --filter=@lostgradient/chat-room --concurrency=1` | 0 |
| `bunx turbo run lint typecheck test --filter=@lostgradient/cinder --concurrency=1` | 0 |
| `bunx turbo run lint typecheck test --filter=conversationalist --concurrency=1` | 0 |
| `bunx turbo run lint typecheck test --filter=@lostgradient/editor --concurrency=1` | 0 |
| `bunx turbo run lint typecheck test --filter=@lostgradient/interoperability --concurrency=1` | 0 |
| `bunx turbo run lint typecheck test --filter=@lostgradient/lifecycle --concurrency=1` | 0 |
| `bunx turbo run lint typecheck test --filter=@lostgradient/markdown --concurrency=1` | 0 |
| `bunx turbo run lint typecheck test --filter=@lostgradient/memory --concurrency=1` | 0 |
| `bunx turbo run lint typecheck test --filter=@lostgradient/operative --concurrency=1` | 0 |
| `bunx turbo run lint typecheck test --filter=@lostgradient/skills --concurrency=1` | 0 |
| `bunx turbo run lint typecheck test --filter=@lostgradient/testing --concurrency=1` | 0 |
| `bunx turbo run lint typecheck test --filter=@lostgradient/weft --concurrency=1` | 0 |
| `bunx turbo run lint typecheck test --filter=@lostgradient/weft-ui --concurrency=1` | 0 |

The final Weft UI browser rerun passed all 17 tests; its status is in `weft-ui-browser-accepted.status.json`. The final watcher regression passes both in the complete package suite and through root validation. Removing startup cleanup in the disposable copy makes the new process-exit regression fail at the unchanged test timeout; restoring it passes. The control is retained in `startup-cleanup-control.json` and does not modify the live checkout.

Final boundary verification accounts for every moved or removed worker-owned file. `console-boundary-accepted.json` and `console-authored-review-accepted.json` distinguish the 24 authored browser-tool additions from ignored build output without changing the original capture. All 1,372 browser snapshots remain hash-identical. `git diff --check` passes; the index remains untouched, and no commit, publication, or deployment was performed for this follow-on.

## Durable documentation and internal compiler configuration

The generated `documentation/reports/codebase-baseline` snapshot has been removed: 27 untracked files, approximately 20 MiB. The report collectors remain under `scripts/` and write to `/tmp` by default. The durable root contracts are `documentation/operative-type-safe-api.md` and `documentation/workflow-versioning.md`; current Bureau and Operative source and README references resolve to those files. The stale numeric lifecycle reference in Bureau now names the required-capabilities section.

`@lostgradient/typescript` now lives under `internal/typescript`. Its entire authored surface is four JSON files: the package manifest, private `base.json`, and public `library.json` and `browser.json` presets. The unused server preset is removed. This configuration workspace has no source-library entry point or task scripts. All consumers, the root Bun workspace pattern, lockfile, inventory collectors, import checks, and graph checks use the new owner. Chat-room composes the public library preset with its generated SvelteKit configuration; its parsed effective compiler options are unchanged.

The dependency graph above includes the renamed configuration provider. No new dependency direction or runtime dependency was introduced. The Turbo regression proves that changing the internal preset invalidates downstream application checks through the existing transit graph. The architecture regression verifies the two public exports and rejects direct imports of the private base and removed server preset. Root documentation, canonical project skills, and agent instructions describe the new boundary; provider instruction and skill links retain their shared owner.

The reviewed change includes the four-file configuration move and server removal; workspace manifests and TypeScript configurations; `scripts/{workspace-contract.test.ts,workspace-imports.test.ts,task-cache.test.ts,lint-policy.test.ts,measure-codebase.ts,inventory-dependencies.ts}`; the Bureau comment reference and Operative README contract wording; root workspace/lock/configuration files; README, this inventory, and the two restored documents. The independent architecture review found no correctness defects. Source repositories and unrelated working-tree changes remain untouched.

### Verification of the configuration move

The required sequence completed in order on September 17, 2026. All 16 workspace lint and typecheck tasks passed. All 17 test tasks executed without cache reuse, with 36,784 passing workspace tests; the concluding root contract suite passed 95 tests and 46,958 assertions. The dependency audit checked 666 packages and found no vulnerabilities. Exact command statuses and logs are in `/tmp/corvidae-internal-typescript/validation-02/`.

| Exact command                   | Exit |
| ------------------------------- | ---- |
| `bun install --frozen-lockfile` | 0    |
| `bun run lint`                  | 0    |
| `bun run typecheck`             | 0    |
| `bun run test`                  | 0    |
| `bun run build`                 | 0    |
| `bun run format:check`          | 0    |
| `bun run validate`              | 0    |
| `bun audit --audit-level=high`  | 0    |

Focused configuration and import-contract checks passed 50 tests and 46,762 assertions. The configuration/Turbo graph probe passed five tests and 611 assertions. Three complete examples extracted from the restored documents compiled against current source under the shared library preset. All 16 document source links resolved. The dependency inventory and codebase measurement collectors completed with exit 0, found the internal configuration owner, and wrote only under `/tmp`. The parsed Chat-room compiler options remained deep-equal before and after replacing its base-preset reference.

The build's [Rolldown plugin-timing diagnostic](https://rolldown.rs/reference/InputOptions.checks#plugintimings) was investigated against the installed SvelteKit source: its `writeBundle` hook starts the nested client build. That callback accounts for 5.5 seconds of the 9.3-second build, compared with 5.7 seconds of the previous accepted 9.6-second build. No timing check was disabled or threshold changed; this diagnostic measures the framework's required nested compilation.

Chat-room's focused runtime command, run from `applications/chat-room`, passed all 58 Chromium, Firefox, and WebKit cases with exit 0:

```bash
bun run test:browser 'hydration.e2e|page.svelte.e2e|shiki-grammar-assets.e2e' --max-failures=1
```

The command exercises the supported Vite development and production-preview toolchains, including actual hydration, streaming, cancellation, approval checks, and grammar assets. Its log and status are `chat-room-browser.log` and `chat-room-browser.status.json` in the evidence directory. The reviewed authored file list is `changed-paths.json`; `documentation-reviewed.json` confirms the document worker stayed within its two-file boundary. No source repository, unrelated user change, index entry, publication, or deployment was modified by this follow-on.
