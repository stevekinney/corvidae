# Migration inventory

The source consolidation into Corvidae is complete and verified. This inventory records its boundaries and evidence. Dependency arrows point from consumer to provider. All fifteen libraries are private source workspaces; chat-room is an application.

## Source revisions

- Agent Bureau: `87f701072cd9f2f427dd17b5f08f3ba15db87269`, clean at inspection.
- Weft: `9ddc15c882e5e2c9ab70489e63e947b988c5961e`, clean at inspection.
- Cinder: `895716bfd7d3b19b9c94818800349e0aee3cb664`; preserve staged `AB-429-final-contract-review.md`.
- Corvidae base: `94950e35fe4d030c47da58b3e62fe6197a3d877a`; preserve three deleted setup scripts.

## Package inventory

| Source repository and path | Destination | Old name | New name | Classification |
| --- | --- | --- | --- | --- |
| `/Users/stevekinney/Developer/agent-bureau/packages/bureau` | `packages/bureau` | `bureau` | `@repo/bureau` | Library |
| `/Users/stevekinney/Developer/agent-bureau/packages/operative` | `packages/operative` | `@lostgradient/operative` | `@repo/operative` | Library |
| `/Users/stevekinney/Developer/agent-bureau/packages/armorer` | `packages/armorer` | `armorer` | `@repo/armorer` | Library |
| `/Users/stevekinney/Developer/agent-bureau/packages/conversationalist` | `packages/conversationalist` | `conversationalist` | `@repo/conversationalist` | Library |
| `/Users/stevekinney/Developer/agent-bureau/packages/memory` | `packages/memory` | `memory` | `@repo/memory` | Library |
| `/Users/stevekinney/Developer/agent-bureau/packages/skills` | `packages/skills` | `skills` | `@repo/skills` | Library |
| `/Users/stevekinney/Developer/agent-bureau/packages/interoperability` | `packages/interoperability` | `interoperability` | `@repo/interoperability` | Library |
| `/Users/stevekinney/Developer/agent-bureau/packages/lifecycle` | `packages/lifecycle` | `lifecycle` | `@repo/lifecycle` | Library |
| `/Users/stevekinney/Developer/weft/packages/weft` | `packages/weft` | `@lostgradient/weft` | `@repo/weft` | Library |
| `/Users/stevekinney/Developer/weft/packages/weft-ui` | `packages/weft-ui` | `@lostgradient/weft-ui` | `@repo/weft-ui` | Library |
| `/Users/stevekinney/Developer/cinder/packages/components` | `packages/cinder` | `@lostgradient/cinder` | `@repo/cinder` | Library |
| `/Users/stevekinney/Developer/cinder/packages/chat` | `packages/chat` | `@lostgradient/chat` | `@repo/chat` | Library |
| `/Users/stevekinney/Developer/cinder/packages/editor` | `packages/editor` | `@lostgradient/editor` | `@repo/editor` | Library |
| `/Users/stevekinney/Developer/cinder/packages/markdown` | `packages/markdown` | `@lostgradient/markdown` | `@repo/markdown` | Library |
| `/Users/stevekinney/Developer/cinder/packages/testing` | `packages/testing` | `@cinder/testing` | `@repo/testing` | Library |
| `/Users/stevekinney/Developer/cinder/labs/chat-room` | `applications/chat-room` | `@cinder/chat-room-lab` | `@repo/chat-room` | Application |

## Architecture

All libraries are private ESM packages with the sole export `{ ".": "./src/index.ts" }`. Consumers compile source. Internal dependencies use `workspace:*`; external versions are centralized in the root Bun catalog. The existing TypeScript configuration workspace remains configuration-only.

Applications own executable toolchains: `applications/chat-room` owns SvelteKit and Vite, `applications/weft-console` owns the console Vite build, `applications/weft-cli` owns the Weft command line, and `applications/cinder-browser-fixtures` owns browser fixture preparation and serving. The original `applications/server` still owns its Bun executable build. Libraries have no build or upstream-build dependency.

Turbo's transit task incorporates upstream source in check hashes without executing builds. Application build outputs are `build/**` and `.svelte-kit/**`. Cinder browser fixtures also cache their generated manifest for build and test; Chat-room lint and typecheck cache SvelteKit's generated configuration and types without capturing production output. Dev, preview, clean, and lint-fix tasks are uncached. Workspace tests execute serially because absolute performance assertions require an uncontended workload. Thresholds, assertions, timeouts, and retries are preserved.

File length, cyclomatic complexity, closure hoisting, and generic simplification are design-review guidance. Refactors retained here establish specific source owners, remove duplication, or repair demonstrated defects. TypeScript's strict configuration, including `noImplicitReturns`, enforces the contracts; lint remains warning-failing. Cinder retains its ES2022 browser runtime contract.

## Complete internal dependency graph

Arrows run from consumer to provider. Every manifest edge appears below, including development dependencies. The 22-workspace graph has 78 edges and no cycles; the root additionally depends on `@repo/typescript-configuration` for development.

| Consumer | Runtime or source-contract providers | Development providers |
| --- | --- | --- |
| `@repo/chat-room` | `@repo/armorer`, `@repo/chat`, `@repo/cinder`, `@repo/conversationalist`, `@repo/editor`, `@repo/markdown`, `@repo/operative`, `@repo/weft` | `@repo/testing`, `@repo/typescript-configuration` |
| `@repo/cinder-browser-fixtures` | `@repo/chat`, `@repo/cinder`, `@repo/conversationalist`, `@repo/editor` | `@repo/testing`, `@repo/typescript-configuration` |
| `@repo/server` | `@repo/shared` | `@repo/typescript-configuration` |
| `@repo/weft-cli` | `@repo/weft` | `@repo/typescript-configuration` |
| `@repo/weft-console` | `@repo/weft`, `@repo/weft-ui` | `@repo/typescript-configuration` |
| `@repo/armorer` | `@repo/interoperability`, `@repo/lifecycle` | `@repo/typescript-configuration` |
| `@repo/bureau` | `@repo/armorer`, `@repo/conversationalist`, `@repo/interoperability`, `@repo/lifecycle`, `@repo/memory`, `@repo/operative`, `@repo/skills`, `@repo/weft` | `@repo/typescript-configuration` |
| `@repo/chat` | `@repo/cinder`, `@repo/conversationalist`, `@repo/markdown` | `@repo/testing`, `@repo/typescript-configuration` |
| `@repo/cinder` | `@repo/markdown` | `@repo/testing`, `@repo/typescript-configuration` |
| `@repo/conversationalist` | `@repo/interoperability`, `@repo/lifecycle` | `@repo/typescript-configuration` |
| `@repo/editor` | `@repo/cinder`, `@repo/markdown` | `@repo/testing`, `@repo/typescript-configuration` |
| `@repo/interoperability` | `@repo/lifecycle` | `@repo/typescript-configuration` |
| `@repo/lifecycle` | None | `@repo/typescript-configuration` |
| `@repo/markdown` | None | `@repo/typescript-configuration` |
| `@repo/memory` | `@repo/armorer`, `@repo/interoperability`, `@repo/lifecycle`, `@repo/weft` | `@repo/typescript-configuration` |
| `@repo/operative` | `@repo/armorer`, `@repo/conversationalist`, `@repo/interoperability`, `@repo/lifecycle`, `@repo/weft` | `@repo/typescript-configuration` |
| `@repo/shared` | None | `@repo/typescript-configuration` |
| `@repo/skills` | `@repo/armorer`, `@repo/interoperability`, `@repo/lifecycle`, `@repo/weft` | `@repo/typescript-configuration` |
| `@repo/testing` | None | `@repo/typescript-configuration` |
| `@repo/typescript-configuration` | None | None |
| `@repo/weft` | None | `@repo/typescript-configuration` |
| `@repo/weft-ui` | `@repo/cinder`, `@repo/markdown`, `@repo/weft` | `@repo/testing`, `@repo/typescript-configuration` |

## Direct external dependencies

These dependencies belong to the workspaces that import them. Source-consumed type contracts, including Conversationalist's Anthropic SDK types, remain explicit dependencies. Test runners, compiler tools, and test-only SDKs are development dependencies. All listed versions resolve through the root catalog; third-party implementations remain installed dependencies.

Bun applies a two-line declaration patch to the installed MCP SDK 1.30.0: `Transport.sessionId` permits the `undefined` value returned by the SDK's own getter under exact optional-property checking. The patch changes no runtime code and does not disable compiler checks. Its paths refer to the installed third-party package's declarations; no migrated library retains distribution output.

A root override consolidates SvelteKit and Express on `cookie@0.7.2`. This removes the low-severity [cookie attribute-injection advisory](https://github.com/advisories/GHSA-pxg6-pf52-xh8x). The installed SvelteKit consumer rejects malformed names, paths, and domains while preserving ordinary secure serialization and parsing; the same probe failed those three rejection cases with `0.6.0`. The all-severity audit now returns an empty advisory set.

| Workspace | Direct external dependencies |
| --- | --- |
| `@repo/chat-room` | `@lasercat/homogenaize`, `@milkdown/ctx`, `@milkdown/kit`, `@sveltejs/kit`, `lucide-svelte`, `prosemirror-state`, `prosemirror-view`, `svelte`, `zod` |
| `@repo/cinder-browser-fixtures` | `@shikijs/langs`, `@shikijs/themes`, `shiki`, `svelte` |
| `@repo/server` | `zod` |
| `@repo/weft-cli` | `zod` |
| `@repo/weft-console` | `svelte` |
| `@repo/armorer` | `@modelcontextprotocol/sdk`, `@openai/agents`, `@opentelemetry/api`, `zod` |
| `@repo/bureau` | `zod` |
| `@repo/chat` | `decode-named-character-reference`, `micromark-util-decode-numeric-character-reference`, `svelte`, `zod` |
| `@repo/cinder` | `@floating-ui/dom`, `@shikijs/engine-oniguruma`, `@shikijs/langs`, `@shikijs/themes`, `@shikijs/types`, `@tanstack/virtual-core`, `ajv`, `ajv-formats`, `culori`, `esm-env`, `libphonenumber-js`, `lucide-svelte`, `qrcode`, `shiki`, `svelte`, `zod` |
| `@repo/conversationalist` | `@anthropic-ai/sdk`, `js-yaml`, `zod` |
| `@repo/editor` | `@floating-ui/dom`, `@milkdown/ctx`, `@milkdown/kit`, `@milkdown/prose`, `esm-env`, `prosemirror-inputrules`, `prosemirror-model`, `prosemirror-state`, `prosemirror-view`, `svelte` |
| `@repo/interoperability` | `@standard-schema/spec` |
| `@repo/markdown` | `@shikijs/engine-oniguruma`, `@shikijs/langs`, `@shikijs/types`, `@types/mdast`, `@types/unist`, `comlink`, `diff-match-patch`, `hast-util-sanitize`, `js-yaml`, `rehype-katex`, `rehype-sanitize`, `rehype-stringify`, `remark-gfm`, `remark-math`, `remark-parse`, `remark-rehype`, `remark-stringify`, `shiki`, `unified`, `unist-util-visit` |
| `@repo/memory` | `zod` |
| `@repo/operative` | `@anthropic-ai/sdk`, `@google/genai`, `@opentelemetry/api`, `openai`, `zod` |
| `@repo/skills` | `gray-matter`, `zod` |
| `@repo/testing` | `@axe-core/playwright`, `@playwright/test`, `@testing-library/svelte`, `happy-dom`, `postcss-value-parser`, `svelte`, `typescript`, `zod` |
| `@repo/weft` | `@electric-sql/pglite`, `@libsql/client`, `@msgpack/msgpack`, `@neondatabase/serverless`, `@valibot/to-json-schema`, `better-sqlite3`, `lmdb`, `pg`, `valibot`, `zod` |
| `@repo/weft-ui` | `@shikijs/langs`, `@shikijs/themes`, `@tanstack/svelte-query`, `cron-parser`, `lucide-svelte`, `svelte` |

## Public API and ownership changes

- Every former library subpath is consolidated into its supported source root. Consumers use `@repo/*`; no old-name packages, aliases, or compatibility entrypoints remain.
- Operative owns agent runtime, providers, sessions, scheduling, and test fixtures. Runtime and generation tracing use their actual distinct names (`instrumentRun`, `instrumentGenerate`); scheduler events use `SchedulerTaskCompletedEvent` and `SchedulerTaskFailedEvent`. Identical provider response-format/tool-choice definitions share their existing type owner.
- Armorer exports MCP and OAuth directly from their source owners, removing the internal barrel cycle. Its runtime-service types remain intentional constituents of the public execution contract; their implementation is owned by Lifecycle.
- Bureau exposes its supported harness and quiescence APIs without forwarding unrelated Operative constants. Interoperability owns shared JSON/tool contracts; Lifecycle owns event and runtime primitives.
- Chat exposes the named `Chat` component. Cinder, Chat, and Editor root entries load their required styles. Editor's placeholder contracts are imported directly from Markdown. Markdown exposes its parser, serializer, renderer, highlighter, worker, diff, and templating APIs at the root.
- Weft owns durable execution and storage. The console and CLI consume it through application boundaries; Weft has no reverse dependency on Weft UI. Generated workflow declaration fixtures augment `@repo/weft` and remain exact product-code-generation contracts, not library declaration output.
- Workflow-file loading and CLI validation belong to `applications/weft-cli`. Their accidental library-root exports were removed after verifying that every caller is a CLI caller and that the source library never exposed them. Native module loading and all validation tests moved with their owner.
- Cinder's supported component types and runtime helpers are available from its source root. Its Bun knowledge command remains package-local tooling. Browser applications consume public components and explicit fixture hosts; they do not copy component implementations or recreate the omitted playground application.

The Editor import-boundary suite retains its real browser/server import checks and synthetic matcher regressions. Two obsolete README assertions requiring registry installation of optional peers were removed after the dependency documentation was corrected to private workspace ownership.

## Shared configuration and infrastructure

- Root Prettier, Oxlint, Stylelint, editor settings, ignores, catalog, and lockfile govern the workspace. Repository source-inclusion rules prevent personal Git ignore patterns from hiding required source while preserving explicit environment, credential, dependency, and generated-output exclusions. `@repo/typescript-configuration` owns strict compiler policy. Local configurations remain only where their tool requires a workspace boundary.
- `@repo/testing` owns Happy DOM setup, Svelte cleanup, real server rendering/hydration, fixture extraction, accessibility, browser interactions, and screenshot utilities. Consuming applications own browser servers and Playwright projects.
- `scripts/shiki-grammar-assets.ts` serves Chat-room, Weft Console, and Cinder Browser Fixtures, which consume the same grammar bundles. Asset identity, imports, grammar immutability, and production loading have focused regression coverage.
- Root architecture checks require locked workspace executable metadata to match manifests and point to existing files; this catches the stale Weft CLI entrypoint found during the lockfile refresh. They also reject internal dependency cycles, undeclared imports, old package imports, subpaths, library builds, publishing setup, and hook installation. They also verify canonical project-skill ownership and native uncached Turbo watch dispatch in the editor. A real Turbo fixture verifies that upstream source changes invalidate downstream tasks and that the existing `CODEX_CI` benchmark profile is passed through strict mode and included in the cache hash.

## Removed systems

- Root GitHub Actions, Lefthook configuration, hook scripts, hook installation, template postinstall/setup automation, and obsolete build/check scripts.
- Source CI/CD definitions, publishing workflows, Changesets/release metadata, npm archives, publish-only fixtures, package lockfiles, generated library output, declaration builds, bundler/package adapters, and release scripts.
- Copied package lint/format/editor configuration, redundant TypeScript build configurations, duplicate DOM/compiler infrastructure, and references to intentionally omitted applications where they existed only for packaging or playground execution.
- The old Testing-owned browser runner, Docker snapshot setup, playground URL and page fixture were removed after mapping their assertions to the browser application. Native Playwright snapshot paths replace the package-local baseline resolver; all 1,372 PNG baselines were moved byte-for-byte to the application. Three unreferenced Operative provider-subpath facades were removed; the root already exports the provider owners directly.
- Four obsolete Cinder selective-CI scoping files (`component-graph` and `test-changed`, each with its obsolete tests). Retained Cinder token and component tooling participates in source lint, typechecking, and tests.
- The unreferenced CLI package-mount fixture manifest and stale library output exclusions were removed. The CLI mounts the Weft Console application build directly; its help and Operative’s source-provider description now match those owners.
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

## Browser accounting

Chat-room has 1,129 supported project executions: the source's 1,127 entries, plus three Shiki executions, three selection-dismissal and three selection-helper error-path regression executions and two overflow-readiness regressions, minus six unsupported non-Chromium clipboard entries and three WebKit native-tab entries formerly skipped at runtime. Exact title/project and moved-body comparisons account for every source case.

The Cinder application manifest has 190 components and 230 explicit fixture groups. Two themes and three viewports produce 1,380 generated cases. The development and preview matrices now select 2,467 tests across 73 files: the prior 2,425 cases plus 42 focused keyboard interactions across Chromium, Firefox, and WebKit. All 38 original Chat harness cases and the restored focus, nested-overlay, and reduced-motion assertions remain. The prior full runs identified Carousel focus, Chat fixture selection, and Tree mounting defects; those repairs pass their focused regression checks. The complete final development run executed all 2,467 cases: 2,464 passed and three failed. Two failures coincided with independently recorded host network changes; one exposed an ambiguous Marquee fixture scope introduced by the new scrolling example. The repaired fixture and unchanged network-interrupted cases all pass in the 99-case focused development rerun. The original development run remains recorded as exit 1. The complete final production matrix passes all 2,467 cases with exit 0 (`/tmp/corvidae-cinder-production-final-lock-status.json`).

The 42 new cases prove actual keyboard scrolling, visible focus, list semantics, reduced-motion behavior, Carousel tab order, outgoing-slide focus recovery, sticky autoplay pause, explicit restart, pointer cancellation, and editable input/range ownership. macOS WebKit uses its native Option-Tab navigation for controls; the input test initializes the caret before checking native arrow movement. Native scroll tests hold the arrow until scrolling begins and release in `finally`, because a plain-HTML control demonstrates that WebKit can cancel scrolling on immediate keyup. No browser or assertion is skipped.

## Validation

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
| `packages/cinder` | `env TZ=UTC LANG=en_US.UTF-8 bun test --conditions browser --conditions svelte --parallel=1 src/components/carousel` | 0 | 110 cases; `/tmp/corvidae-carousel-pointer-cancellation-green.log` |
| `packages/cinder`, `applications/cinder-browser-fixtures` | `bun run lint`, `bun run typecheck` in each workspace | 0 each | `/tmp/corvidae-focus-final-static/status.json` |
| Repository root | `bun test applications/chat-room/src/lib/chat-agent.part-03.test.ts` | 0 | Eight cases after an original-implementation exit1 control; `/tmp/corvidae-repair-causal-controls/status.json` |
| Repository root | `bun test packages/editor/src/lib/session/persistence.test.ts` | 0 | 17 cases after a production-bundle exit1 control; `/tmp/corvidae-production-bundle-causal/status.json` |
| `packages/cinder` | `bun test --conditions browser --conditions svelte src/components/toolbar/toolbar.test.ts` | 0 | 28 cases after three causal failures; `/tmp/corvidae-toolbar-focus-green.log` |
| `applications/weft-console` | `bun run test:e2e --max-failures=1` | 0 | 17 browser cases; `/tmp/corvidae-weft-console-browser-after-ownership-status.json` |
| `applications/chat-room` | `bun run test:browser src/routes/exercises/review-comment-creation --max-failures=1` | 0 | 48 browser cases; `/tmp/corvidae-root-popover-family-readiness-status.json` |
| `packages/editor` | `bun run lint`; `bun run typecheck` | 0 each | `/tmp/corvidae-root-selection-static/status.json` |
| `applications/chat-room` | `bun run lint`; `bun run typecheck` | 0 each | `/tmp/corvidae-root-selection-static/status.json` |
| Repository root | `bun test scripts/workspace-contract.test.ts scripts/workspace-imports.test.ts` | 0 | 27 architecture cases; `/tmp/corvidae-architecture-after-cli-owner.log` |
| Repository root | `bunx tsc --noEmit`; `bun run test:self`; `bun run format:check` | 0 each | Final source-ownership checks, including all 59 repository tests; `/tmp/corvidae-final-source-ownership-quality/status.json` |

### Focused workspace gates

All commands below run from the repository root and have recorded exit-zero evidence.

| Workspace | Exact command | Exit | Evidence |
| --- | --- | --- | --- |
| `@repo/armorer` | `bunx turbo run lint typecheck test --filter=@repo/armorer --concurrency=1` | 0 | `/tmp/corvidae-focused-agent-graph-final/1.log` |
| `@repo/bureau` | `bunx turbo run lint typecheck test --filter=@repo/bureau --concurrency=1` | 0 | `/tmp/corvidae-focused-agent-graph-final/2.log` |
| `@repo/chat` | `bunx turbo run lint typecheck test --filter=@repo/chat --concurrency=1` | 0 | `/tmp/corvidae-focused-interface-graph-final/1.log` |
| `@repo/cinder` | `bunx turbo run lint typecheck test --filter=@repo/cinder --concurrency=1` | 0 | 11,814 tests; `/tmp/corvidae-cinder-after-focus-and-toast-final/1.log` |
| `@repo/conversationalist` | `bunx turbo run lint typecheck test --filter=@repo/conversationalist --concurrency=1` | 0 | `/tmp/corvidae-focused-agent-graph-final/3.log` |
| `@repo/editor` | `bunx turbo run lint typecheck test --filter=@repo/editor --concurrency=1` | 0 | `/tmp/corvidae-focused-interface-repair-final/1.log` |
| `@repo/interoperability` | `bunx turbo run lint typecheck test --filter=@repo/interoperability --concurrency=1` | 0 | `/tmp/corvidae-focused-light-graph-final/1.log` |
| `@repo/lifecycle` | `bunx turbo run lint typecheck test --filter=@repo/lifecycle --concurrency=1` | 0 | `/tmp/corvidae-focused-light-graph-final/2.log` |
| `@repo/markdown` | `bunx turbo run lint typecheck test --filter=@repo/markdown --concurrency=1` | 0 | `/tmp/corvidae-focused-markdown-weft-final/1.log` |
| `@repo/memory` | `bunx turbo run lint typecheck test --filter=@repo/memory --concurrency=1` | 0 | `/tmp/corvidae-focused-light-graph-final/3.log` |
| `@repo/operative` | `bunx turbo run lint typecheck test --filter=@repo/operative --concurrency=1` | 0 | `/tmp/corvidae-focused-agent-graph-final/4.log` |
| `@repo/skills` | `bunx turbo run lint typecheck test --filter=@repo/skills --concurrency=1` | 0 | `/tmp/corvidae-focused-light-graph-final/4.log` |
| `@repo/testing` | `bunx turbo run lint typecheck test --filter=@repo/testing --concurrency=1` | 0 | `/tmp/corvidae-focused-interface-repair-final/2.log` |
| `@repo/weft` | `bunx turbo run lint typecheck test --filter=@repo/weft --concurrency=1` | 0 | `/tmp/corvidae-native-node-cinder-final/2.log` |
| `@repo/weft-ui` | `bunx turbo run lint typecheck test --filter=@repo/weft-ui --concurrency=1` | 0 | `/tmp/corvidae-focused-interface-repair-final/3.log` |
| `@repo/chat-room` | `bunx turbo run lint typecheck test build --filter=@repo/chat-room --concurrency=1` | 0 | Final dependency state; `/tmp/corvidae-cookie-focused/2.log` |

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

## Reviewed change summary

The selected source and tests occupy fifteen new library directories. Application entrypoints and browser infrastructure occupy four new application directories alongside the existing server. Root manifests, lockfile, shared configuration, validation scripts, editor settings, ignores, and documentation describe this internal workspace. The source repositories, user environment files, and unrelated worktrees remain unchanged. The Chef history contains rejected submissions, recovery snapshots, review findings, and final command evidence. Final acceptance confirms all eighteen reviewed integration files are unchanged, the 22-workspace/78-edge graph matches the reviewed acyclic graph, and all three source repository revisions and working-tree states match their initial snapshots (`/tmp/corvidae-final-acceptance.json`). All 1,372 baseline PNGs and their provenance JSON remain byte-identical under the native Chromium/Linux snapshot directory (`/tmp/corvidae-final-baseline-preservation.json`); this is preservation evidence, not a claim of new pixel-comparison coverage.

The reviewed file inventory contains 38 tracked changes and 10,001 new files or links, including 7,149 source and script files, including declaration fixtures and 1,372 browser snapshot baselines. The nine additional project-skill paths are three canonical documents and six relative provider links. Package and application directories are listed in the tables above. Shared changes are concentrated in these files:

- Workspace policy and dependency ownership: `package.json`, `bun.lock`, `turbo.json`, `packages/shared/package.json`, `packages/shared/tsconfig.json`, and `packages/typescript-configuration/{package.json,library.json}`.
- Quality and editor configuration: `.oxlintrc.json`, `.stylelintrc.json`, `.prettierrc.json`, `.prettierignore`, `.gitignore`, and `.vscode/{extensions.json,tasks.json}`.
- Local validation: `scripts/{bun-matchers.test.ts,lint-policy.test.ts,task-cache.test.ts,typecheck-contracts.ts,workspace-contract.test.ts,workspace-imports.test.ts}` and `scripts/shiki-grammar-assets{.ts,.test.ts}`.
- Existing application tooling: `applications/server/{package.json,tsconfig.json,scripts/build.ts}`; redundant local lint, Bun test, and build TypeScript configurations were removed.
- Documentation and agent guidance: `README.md`, `MIGRATION.md`, `AGENTS.md`, and the existing project skills, now owned once under `.agents/skills/{add-dependency,add-workspace,validate-monorepo}/SKILL.md` with relative links from both `.claude/skills` and `.codex/skills`. The existing `CLAUDE.md` delegates to `AGENTS.md`.
- Installed dependency correction: `patches/@modelcontextprotocol%2Fsdk@1.30.0.patch`, with the declaration-only change described above.

CI, hook, and obsolete setup-script deletions are recorded under removed systems. The three user-owned setup deletions and `.env.example` remain preserved user state.

## Workspace naming and imported-document cleanup

All five applications now live under `applications/`; workspace discovery, Bun lockfile paths, lint and TypeScript configuration, editor launch commands, CLI mount fixtures, screenshot commands, and project guidance use that directory. Cinder's documentation lives under `packages/cinder/documentation`; token generation and documentation checks read the renamed directory. Historical command evidence above predates the directory rename; its workspace paths are displayed using the current names.

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
| `packages/cinder` | `TZ=UTC LANG=en_US.UTF-8 bun test --conditions browser --conditions svelte --parallel=1 src/components/source-diff-viewer/source-diff-viewer.test.ts` | 0 | 81 tests; `/tmp/corvidae-staged-whitespace-tests.log` |

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
