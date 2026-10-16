# Completed-project documentation coverage

When you pick up a completed feature, you should be able to learn its supported behavior from the repository without reconstructing a project in [Linear](https://linear.app/). This record connects every completed project found on 2026-09-19 to that documentation.

## Audit scope

The inventory used Linear's completed project state with archived projects included and no date cutoff. The final read included 28 projects, of which 27 belong to Corvidae and one to Internal Operations, with no further page of results. The Operative adoption project completed during the audit and was included in that read. Full project descriptions and available linked issue lists were read; older projects with empty issue lists were assessed from their full project scope and current implementation. Project completion is historical evidence, not proof that every original proposal became a supported public API.

The documentation follows the reader-oriented structure in `packages/weft/documentation`: a concrete problem, the simplest useful example, configuration and ownership, failure behavior, and links to the detailed reference. Existing comprehensive package references and generated component pages remain authoritative. New guides connect those references where the feature crossed package boundaries.

## Project coverage

| Completed project | Completed date (UTC) | Reader entry point | Audit result |
| --- | --- | --- | --- |
| [Corvidae UI remediation](https://linear.app/lost-gradient/project/corvidae-ui-remediation-043f0128f365) | 2026-09-19 | Documentation (retired with the SvelteKit chat-room; see repository history) | Application integration guide added; component references retained for tool activity, approvals, artifacts, editing, and accessibility. |
| [Operative Provider SDK Feature Parity](https://linear.app/lost-gradient/project/operative-provider-sdk-feature-parity-581835df2729) | 2026-08-31 | [Documentation](runtime-contracts.md#provider-capability-matrix) | Provider reference retained; capability matrix and fallback boundaries added. |
| [Deterministic Lifecycle Testability](https://linear.app/lost-gradient/project/deterministic-lifecycle-testability-02d91607988d) | 2026-09-19 | [Documentation](../testing/testing/README.md#deterministic-test-boundaries) | Expanded testing guide; runtime harness and deferred-work ownership references retained and linked. |
| [Runtime Steering and Effective Context](https://linear.app/lost-gradient/project/runtime-steering-and-effective-context-6b66134ee881) | 2026-09-19 | [Documentation](runtime-contracts.md#effective-context-and-steering) | Cross-runtime guide added for command admission, turn boundaries, epochs, and actual supported targets. |
| [Model Capability and Selection Planning](https://linear.app/lost-gradient/project/model-capability-and-selection-planning-8ed7767c8acd) | 2026-09-09 | [Documentation](runtime-contracts.md#selection-plans-and-model-policy) | Selection-plan fields, capability decisions, and revalidation guidance added. |
| [Conversationalist State Integrity](https://linear.app/lost-gradient/project/conversationalist-state-integrity-11097f5be45e) | 2026-08-27 | [Documentation](../packages/conversationalist/README.md#state-integrity-and-restoration) | Existing immutable-state and event references retained; revision conflicts and snapshot restoration clarified. |
| [Armorer Runtime Safety](https://linear.app/lost-gradient/project/armorer-runtime-safety-1d4a7c3cc78a) | 2026-08-29 | [Documentation](../packages/armorer/README.md#started-work-authority-and-cleanup) | Execution lifetime and policy reference retained; ownership and cleanup boundaries clarified. |
| [Durable Sessions, Scheduling, and Human Review](https://linear.app/lost-gradient/project/durable-sessions-scheduling-and-human-review-24f14f1cebc9) | 2026-09-19 | [Documentation](../packages/bureau/README.md) | Existing session, schedule, and human-review APIs retained; composed capability limits connected to the runtime guide. |
| [Durability Ownership and Workflow Control](https://linear.app/lost-gradient/project/durability-ownership-and-workflow-control-5818e3c380a4) | 2026-09-01 | [Documentation](runtime-contracts.md#ownership-and-cleanup) | Cross-package ownership matrix added and connected to Weft ownership and agent versioning guides. |
| [Cancellation and Awaitable Shutdown](https://linear.app/lost-gradient/project/cancellation-and-awaitable-shutdown-73027c73b116) | 2026-09-19 | [Documentation](runtime-contracts.md#ownership-and-cleanup) | Cancellation request, terminal result, cleanup acknowledgement, and unknown effects distinguished. |
| [Universal Started-Work Contract](https://linear.app/lost-gradient/project/universal-started-work-contract-d4389cea4e08) | 2026-09-01 | [Documentation](runtime-contracts.md#ownership-and-cleanup) | Started-work handles, durable admission, locators, observation, and cleanup mapped across package owners. |
| [Weft: MultiEngine Concurrent Resume Ownership](https://linear.app/lost-gradient/project/weft-multiengine-concurrent-resume-ownership-2c57df81ee43) | 2026-08-27 | [Documentation](../packages/weft/documentation/guides/shared-store-ownership.md) | Dedicated usage and operations guide added for modes, storage requirements, timing, takeover, shutdown, and coordinated mode changes. |
| [Weft: Durable Remote Task Ledger and Recovery](https://linear.app/lost-gradient/project/weft-durable-remote-task-ledger-and-recovery-a064ff394a23) | 2026-08-20 | [Documentation](../packages/weft/documentation/guides/remote-task-recovery.md) | Dedicated state, readiness, retry, adoption, retention, and troubleshooting guide added. |
| [Weft: Canonical Worker Manifest and Execution Identity](https://linear.app/lost-gradient/project/weft-canonical-worker-manifest-and-execution-identity-762deb0aff95) | 2026-08-19 | [Documentation](../packages/weft/documentation/reference/api-workers.md#canonical-worker-manifest) | Detailed manifest reference retained; recovery guide explains artifact identity and admission, and wire examples include attempt fencing. |
| [Weft: Durable Workflow Revision Pinning](https://linear.app/lost-gradient/project/weft-durable-workflow-revision-pinning-ff7f4f1dabc1) | 2026-09-12 | [Documentation](../packages/weft/documentation/guides/workflow-revisions.md#what-runs-after-activation) | Dedicated guide added for persisted revisions, unavailable-code failure, schedules, and retained artifacts. |
| [Weft: Workflow Type Safety and Compatibility](https://linear.app/lost-gradient/project/weft-workflow-type-safety-and-compatibility-ada33e9e9543) | 2026-09-11 | [Documentation](../packages/weft/documentation/guides/workflow-revisions.md#client-types-and-runtime-validation) | Contract identity, compatibility refusals, snapshot version, and source CLI generation documented. |
| [Weft: Per-Workflow Dynamic Loading](https://linear.app/lost-gradient/project/weft-per-workflow-dynamic-loading-e9b9a7d57799) | 2026-09-14 | [Documentation](../packages/weft/documentation/guides/workflow-revisions.md#loading-a-workflow-on-demand) | Working module and host example added with preload, single-flight loading, cancellation, and validation behavior. |
| [Weft: Versioned Workflow Catalog](https://linear.app/lost-gradient/project/weft-versioned-workflow-catalog-7445685531fc) | 2026-09-09 | [Documentation](../packages/weft/documentation/guides/workflow-revisions.md#installing-and-activating) | Catalog operations, generation guards, eager/lazy execution distinction, and removal documented; stale README routing claim corrected. |
| [Cinder: Authoring guardrails & tooling program](https://linear.app/lost-gradient/project/cinder-authoring-guardrails-and-tooling-program-e500615e0a30) | 2026-08-22 | [Documentation](../components/cinder/documentation/interface-guide.md) | Existing generated references and contributor checks retained; composition, accessibility, and failure-state guidance added. |
| [Cinder: New standalone components](https://linear.app/lost-gradient/project/cinder-new-standalone-components-b6c86a3b829f) | 2026-08-30 | [Documentation](../components/cinder/documentation/interface-guide.md) | Existing leaf API and accessibility references retained; cross-component selection and composition guide added. |
| [Cinder: Chat transcript, composer & UI polish](https://linear.app/lost-gradient/project/cinder-chat-transcript-composer-and-ui-polish-0cdda89a4366) | 2026-08-31 | Documentation (retired with the SvelteKit chat-room; see repository history) | Chat package API retained; application guide adds streaming, composer, approvals, artifacts, and recovery ownership. |
| [Cinder: Token & color system refinements](https://linear.app/lost-gradient/project/cinder-token-and-color-system-refinements-30aa4277d8b1) | 2026-09-11 | [Documentation](../components/cinder/documentation/interface-guide.md#tokens-themes-and-motion) | Generated token reference retained; scoped overrides, motion, and non-color state signaling added. |
| [Cinder: JSON Schema Builder improvements](https://linear.app/lost-gradient/project/cinder-json-schema-builder-improvements-69b924ff1da1) | 2026-08-22 | [Documentation](../components/cinder/documentation/interface-guide.md#editing-and-review) | Existing editor API retained; controlled ownership, validation, nested rows, and rejection behavior explained. |
| [Cinder: Component visual sweep](https://linear.app/lost-gradient/project/cinder-component-visual-sweep-e23b3138a03b) | 2026-08-29 | [Documentation](../components/cinder/documentation/interface-guide.md) | Leaf visual and accessibility references retained; shared composition and failure-state rules added. |
| [Design Tokens: DTCG 2025.10 migration](https://linear.app/lost-gradient/project/design-tokens-dtcg-202510-migration-670225b52a4b) | 2026-09-01 | [Documentation](../components/cinder/documentation/tokens.md) | Existing generated token reference retained and linked from the practical interface guide. |
| [Operative 0.1.0 publication pilot](https://linear.app/lost-gradient/project/operative-010-publication-pilot-8515c99b1e5e) | 2026-08-19 | [Documentation](../packages/operative/README.md#workspace-usage) | Historical publication milestone; current private source consumption remains documented without suggesting a registry installation for this workspace. |
| [Linear control-plane rollout](https://linear.app/lost-gradient/project/linear-control-plane-rollout-59d9b1ade049) | 2026-08-22 | [Documentation](https://linear.app/lost-gradient/project/linear-control-plane-rollout-59d9b1ade049) | Operational project, already covered by the authoritative Linear Plan and installed operating skills; no runtime feature to add. |
| [Cinder: Operative adoption in chat-room exemplar](https://linear.app/lost-gradient/project/cinder-operative-adoption-in-chat-room-exemplar-df7af2c29f3a) | 2026-09-19 | Reference architecture (retired with the SvelteKit chat-room; see repository history) and durability exercise (retired with the SvelteKit chat-room; see repository history) | Existing architecture and restart exercises retained; interface guide connects streaming, approvals, and server-owned history. |

## Historical and operational boundaries

The Operative publication pilot established an earlier public-package delivery path. This repository now consumes private `@lostgradient/*` source packages through `workspace:*`, as described in the [workspace guide](../README.md). Historical publication does not change the current installation contract.

The control-plane rollout's authoritative document is `/Users/stevekinney/Vaults/Lost Gradient/Linear Plan.md`. It documents team routing, issue and project readiness, native dependencies, coordinator ownership, verification, reconciliation, and the recorded decision to leave hosted delegation disabled. Its rollout checklist is historical; use the live project and issue state for completion dates. This audit does not rewrite shared agent policy or change Linear configuration.

Several completed projects established explicit capability boundaries. The runtime guide documents unsupported session operations as unsupported, and the Weft guides distinguish a declared contract revision from executable bytes, catalog metadata from loaded code, a task digest from a result payload, and cancellation from cleanup. Those distinctions are part of the feature documentation.

## Verification

Source baseline: `8a23a859`. Documentation edits are local to this checkout.

The executable Weft guide examples were extracted into temporary files, run with Bun 1.4.2, and typechecked with the workspace TypeScript compiler. They exercise lazy source registration and recovery, preloading, guarded activation, pinned scheduling, per-workflow ownership, and authenticated task-plane readiness. The focused ownership, source, catalog, schedule, ledger-recovery, and result-adoption regression selection passed 287 tests.

All four complete TypeScript examples in the runtime guide pass strict typechecking; the context-sealing and Bureau steering examples also execute successfully. All six Svelte examples compile without warnings. The updated protocol examples contain 18 valid JSON blocks. Local documentation targets and heading anchors resolve, and independent source review found no remaining actionable findings.

The protocol documentation contract test now reads third-level message headings, matching this repository’s heading limit, while preserving its exact comparison against the exported schema catalog. All 18 protocol tests pass. The initial complete validation identified this heading mismatch. After the correction, `bun run validate` completed with exit code 0: lint, typechecking, repository and workspace tests, application builds, formatting, and dependency audit all passed. The dependency audit checked 704 packages and reported no vulnerabilities.

## Existing documentation improvement pass

The follow-on inventory contains 496 tracked and newly authored Markdown files. The five agent instruction and skill files are outside this prose pass; the remaining 491 documents include 423 interface and chat-room files, runtime references, package guides, architecture decisions, and historical migration and benchmark records. Generated component regions were checked through their owning tooling and retained where accurate. Hand-maintained prose was reviewed for current imports, commands, links, ownership, examples, and failure behavior.

The pass expands small package guides for Cryptography, Embeddings, Markdown, and Tool Protocol; clarifies Memory and Skills ownership; improves sparse component references; repairs local navigation; and distinguishes historical records from current operating guidance. Weft’s overview and architecture decision now describe recovery by restarting a generator and reusing durable operation results, rather than claiming live JavaScript stack restoration. Bureau steering guidance is reconciled with the executable admission path and its regression tests.

The component scaffold’s authoring link and package-root example are corrected at their source, with a regression check for the generated link target and heading. Existing affected pages use the corrected template. This prevents the same documentation defect from recurring when a new component is created.

The expanded pass has its own final validation; the successful run recorded above belongs to the initial completed-project batch. Seven new small-package examples execute and pass strict typechecking. Both updated Memory hook examples typecheck, and the Memory and Skills import inventory resolves against current public exports. The recovery and wire-format selection passes 42 tests; the policy-reference and durable-steering selection passes five tests. Corpus-wide local links, heading anchors, and code-fence checks pass. The scaffold regression selection passes 27 tests, and Cinder’s generated-artifact check passes. The final expanded `bun run validate` completed with exit code 0: lint, typechecking, repository and workspace tests, all three build tasks, formatting, and dependency audit passed. The audit reported no vulnerabilities across 704 packages. No test limits, coverage requirements, or validation gates were weakened.

## Files changed

- [MIGRATION.md](../MIGRATION.md)
- [README.md](../README.md)
- applications/desktop/README.md (removed with the desktop application; see repository history)
- applications/chat-room/docs/interface-surfaces.md (retired with the SvelteKit chat-room; see repository history)
- [components/chat/src/lib/components/chat-composer-popover/README.md](../components/chat/src/lib/components/chat-composer-popover/README.md)
- [components/cinder/README.md](../components/cinder/README.md)
- [components/cinder/documentation/interface-guide.md](../components/cinder/documentation/interface-guide.md)
- [components/cinder/scripts/create-component.test.ts](../components/cinder/scripts/create-component.test.ts)
- [components/cinder/scripts/create-component.ts](../components/cinder/scripts/create-component.ts)
- [components/cinder/src/components/citation/README.md](../components/cinder/src/components/citation/README.md)
- [components/cinder/src/components/code-location/README.md](../components/cinder/src/components/code-location/README.md)
- [components/cinder/src/components/donut-chart/README.md](../components/cinder/src/components/donut-chart/README.md)
- [components/cinder/src/components/drawer/drawer.a11y.md](../components/cinder/src/components/drawer/drawer.a11y.md)
- [components/cinder/src/components/form/README.md](../components/cinder/src/components/form/README.md)
- [components/cinder/src/components/key-value-editor/README.md](../components/cinder/src/components/key-value-editor/README.md)
- [components/cinder/src/components/modal-region/README.md](../components/cinder/src/components/modal-region/README.md)
- [components/cinder/src/components/parameter-field/README.md](../components/cinder/src/components/parameter-field/README.md)
- [components/cinder/src/components/policy-lock/README.md](../components/cinder/src/components/policy-lock/README.md)
- [components/cinder/src/components/preview-panel/README.md](../components/cinder/src/components/preview-panel/README.md)
- [components/cinder/src/components/quota-meter/README.md](../components/cinder/src/components/quota-meter/README.md)
- [components/cinder/src/components/relative-time/README.md](../components/cinder/src/components/relative-time/README.md)
- [components/cinder/src/components/setting-row/README.md](../components/cinder/src/components/setting-row/README.md)
- [components/cinder/src/components/shortcut-field/README.md](../components/cinder/src/components/shortcut-field/README.md)
- [components/cinder/src/components/sidebar/sidebar.a11y.md](../components/cinder/src/components/sidebar/sidebar.a11y.md)
- [components/cinder/src/components/stack/README.md](../components/cinder/src/components/stack/README.md)
- [components/cinder/src/components/terminal-output/README.md](../components/cinder/src/components/terminal-output/README.md)
- [components/cinder/src/components/toast-region.md](../components/cinder/src/components/toast-region.md)
- [components/cinder/src/components/toast-region/toast-region.a11y.md](../components/cinder/src/components/toast-region/toast-region.a11y.md)
- [components/cinder/src/components/zoom-pan-viewer/README.md](../components/cinder/src/components/zoom-pan-viewer/README.md)
- [documentation/bun-optimization-results.md](../documentation/bun-optimization-results.md)
- [documentation/completed-project-documentation.md](../documentation/completed-project-documentation.md)
- [documentation/operative-type-safe-api.md](../documentation/operative-type-safe-api.md)
- [documentation/runtime-contracts.md](../documentation/runtime-contracts.md)
- [documentation/workflow-versioning.md](../documentation/workflow-versioning.md)
- [packages/armorer/README.md](../packages/armorer/README.md)
- [packages/armorer/documentation/README.md](../packages/armorer/documentation/README.md)
- [packages/armorer/documentation/agent-sdk-integrations.md](../packages/armorer/documentation/agent-sdk-integrations.md)
- [packages/armorer/documentation/mcp.md](../packages/armorer/documentation/mcp.md)
- [packages/armorer/documentation/openai-agents-sdk.md](../packages/armorer/documentation/openai-agents-sdk.md)
- [packages/armorer/documentation/provider-adapters.md](../packages/armorer/documentation/provider-adapters.md)
- [packages/bureau/README.md](../packages/bureau/README.md)
- [packages/bureau/documentation/skills.md](../packages/bureau/documentation/skills.md)
- [packages/conversationalist/README.md](../packages/conversationalist/README.md)
- [packages/cryptography/README.md](../packages/cryptography/README.md)
- [packages/lifecycle/README.md](../packages/lifecycle/README.md)
- [packages/markdown/README.md](../packages/markdown/README.md)
- [packages/memory/README.md](../packages/memory/README.md)
- [packages/operative/README.md](../packages/operative/README.md)
- [testing/testing/README.md](../testing/testing/README.md)
- [packages/weft/README.md](../packages/weft/README.md)
- [packages/weft/documentation/contributing/architecture-decisions/0001-workflows-typescript-only.md](../packages/weft/documentation/contributing/architecture-decisions/0001-workflows-typescript-only.md)
- [packages/weft/documentation/guides/remote-task-recovery.md](../packages/weft/documentation/guides/remote-task-recovery.md)
- [packages/weft/documentation/guides/remote-workers.md](../packages/weft/documentation/guides/remote-workers.md)
- [packages/weft/documentation/guides/shared-store-ownership.md](../packages/weft/documentation/guides/shared-store-ownership.md)
- [packages/weft/documentation/guides/workflow-revisions.md](../packages/weft/documentation/guides/workflow-revisions.md)
- [packages/weft/documentation/reference/api-workers.md](../packages/weft/documentation/reference/api-workers.md)
- [packages/weft/documentation/reference/remote-worker-protocol.md](../packages/weft/documentation/reference/remote-worker-protocol.md)
- [packages/weft/src/server/**fixtures**/subscription-wire/README.md](../packages/weft/src/server/__fixtures__/subscription-wire/README.md)
- [packages/weft/src/worker/protocol.test.ts](../packages/weft/src/worker/protocol.test.ts)
- [scripts/mirror/cinder-exports-decision.md](../scripts/mirror/cinder-exports-decision.md)
- [scripts/mirror/playground-asset-delivery-decision.md](../scripts/mirror/playground-asset-delivery-decision.md)
