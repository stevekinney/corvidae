# Cinder exports map: copy or regenerate

COR-1186. Decided between the two candidate strategies for getting `@lostgradient/cinder`'s published subpath exports out of corvidae and into the public repository the mirror transform builds and publishes from.

## Decision

**Regenerate.** The transform owns the exports map. Corvidae's `components/cinder/package.json` keeps its one-line `{".": "./src/index.ts"}` map unchanged, and no generated map or drift check lands in this repository under this issue.

The prior analysis preferred copy. The evidence below reverses that preference, and the reversal turns on a single structural fact rather than on a judgment call.

## Why the shape, not the percentages, decides it

The published map is not a description of corvidae's source tree that happens to be written down elsewhere. It is a description of a _build tree_ corvidae does not have and, by its own architecture, will never produce. AGENTS.md states that only applications have `build` tasks and that shared source libraries export TypeScript source directly; `scripts/workspace-contract.test.ts` enforces this, asserting that every library workspace's `exports` equals exactly `{".": "./src/index.ts"}` and that no library carries a `build`, `pack`, `publish`, `prepare`, or `postinstall` script.

Against that architecture, neither form of copy survives contact.

A _verbatim_ copy is unresolvable. Upstream orders each component entry `types`, `browser`, `svelte`, `node`, `import`, `default`. TypeScript's resolver falls through a condition whose target is absent, so `types` pointing at a missing `./dist/index.d.ts` costs nothing. Bun's runtime resolver does not fall through: it selects `node`, finds `./dist/server/index.js` missing, and fails hard. Every corvidae consumer that runs plain `bun test` without `--conditions browser --conditions svelte` therefore loses the package entirely. That is measured below, not predicted.

A _rewritten_ copy, one expressed in terms corvidae can also resolve, cannot preserve the map's shape. Of the 992 published keys, 182 have no source-shaped condition at all: `./knowledge`, whose only targets are `dist/cli/knowledge.{js,d.ts}`, and the 181 per-component `/styles` entries, which carry exactly `{types, default}` and point both at `dist`. Making those resolve in corvidae means _adding conditions upstream does not emit_. Once the stored map's shape diverges from the published map's shape, the transform has to reverse the divergence on every sync, per facet, under three different output roots. That reversal is the generator's logic, written backwards and lossily.

So both routes converge on the same place: the transform carries the generator. Regenerate says so directly. Copy says so while also asking corvidae to store a 992-key artifact that is neither what corvidae needs nor what the registry receives, and to punch a cinder-shaped hole in an architectural invariant to hold it.

### What copy was supposed to buy, and why it does not

Two arguments favored copy. Neither survives inspection.

- _Surface parity becomes a diff against a stored map._ It does not need to be. The release gate is that every subpath the last published version exported still resolves after a sync. That is a check against the published tarball, run at sync time, and it reads identically whether the map was stored or generated. Storing the map actively weakens the gate, because it invites diffing stored-against-published instead of published-against-actually-resolves—and a stored map that drifted in the same direction as the generator would pass that diff while the surface broke.
- _Copying avoids reimplementing ~1000 lines of subtle upstream logic._ The reimplementation is real but much smaller than that number suggests, because the discovery half already lives here. Corvidae carries `components/cinder/scripts/lib/discover-components.ts`, and `diff` against upstream's copy shows the two differ only in doc comments—the algorithm is identical line for line. What has to be ported is the emit half of `generate-exports.ts`, with its `import.meta.dir`-relative package root made a parameter so it can be pointed at a staged tree. Corvidae has no `generate-exports.ts` and no `build.ts` under `components/cinder/scripts/`, so there is nothing here to simply sync; that is the honest cost of this decision.

## Evidence

Every command was run in the worktree `/Users/stevekinney/.agent-worktrees/claude/corvidae-cor-1186` on branch `steve/cor-1186`. Exit codes were read from `$?`, never grepped from output.

### Baseline

| Command | Exit |
| --- | --- |
| `bunx turbo run typecheck test --filter=@corvidae/cinder --filter=@corvidae/chat --filter=@corvidae/editor --filter=@corvidae/chat-room` | 0 |

### The verbatim-copy experiment

Upstream's 992-key `exports` object was written verbatim into `components/cinder/package.json`, then reverted.

| Probe | Exit | Result |
| --- | --- | --- |
| `bunx tsc --noEmit -p tsconfig.browser.json` in `components/chat`, importing `@corvidae/cinder` | 0 | TypeScript falls through the missing `types` target to `browser`, reaching source |
| same probe with a deliberate type error | 2 | confirms the probe was in the program, resolving `Button` to the Svelte source type |
| `bun --conditions browser --conditions svelte -e 'import.meta.resolve("@corvidae/cinder")'` | 0 | resolves to `components/cinder/src/index.ts` |
| `bun --conditions browser --conditions svelte -e 'import.meta.resolve("@corvidae/cinder/button")'` | 0 | resolves to `src/components/button/index.ts` |
| `bun --conditions browser --conditions svelte -e 'import.meta.resolve("@corvidae/cinder/button/styles")'` | 1 | `Cannot find module`—no condition resolves |
| `bun -e 'import.meta.resolve("@corvidae/cinder")'` (default conditions) | 1 | `Cannot find module`—`node` selects the absent `dist/server/index.js` |
| `bun run test:self` (repository root) | 1 | `workspace-contract.test.ts:298`, _cinder exposes source without a build or publication contract_: `expect(manifest.exports).toEqual({'.': './src/index.ts'})` |
| `bun test` in `applications/chat-room` | 1 | 8 failures, 7 errors; `environment-configuration.test.ts` spawns a subprocess whose stderr is `Cannot find module '@corvidae/cinder' from '.../components/chat/src/index.ts'` |

The chat-room failure is the one that closes the argument. That test asserts a clean stderr from a spawned process; its script is plain `bun test` with no conditions, and it lives in `applications/chat-room`, outside this issue's change boundary. Making a verbatim map work would mean adding `--conditions browser --conditions svelte` to consumer test scripts across the workspace—spending the consumers' configuration to hold an artifact they do not use.

### Target audit

Every target of all 992 published keys, tested for existence against `components/cinder/`:

| Condition | Targets | Missing in corvidae |
| --------- | ------- | ------------------- |
| `types`   | 801     | 801                 |
| `node`    | 614     | 614                 |
| `default` | 992     | 795                 |
| `import`  | 804     | 4                   |
| `browser` | 613     | 3                   |
| `svelte`  | 613     | 3                   |

Grouped by key: 801 keys are fully source-resolvable, 182 have no source-shaped target at all, and 9 more name source corvidae does not have.

## Does corvidae's tree match what the generator walks

For discovered components, exactly. Upstream's `discoverComponents` (`packages/components/scripts/lib/discover-components.ts`) walks `src/components/`, skipping `_`-prefixed directories and `icons`, descending one level into `experimental/`, and requiring both `<name>.svelte` and `<name>.types.ts`. Replaying that algorithm against both trees and diffing the results, including each component's `hasCss`, `examples.json`, `constraints.json` and `-enhancement.ts` sidecars: 200 components on each side, zero differences. `src/tokens/` is byte-identical in file listing, so the generator's `tokenExports` discovery matches too.

The raw top-level directory counts differ (217 upstream, 215 here) for two benign reasons: upstream's `src/components/diff-viewer/` is an empty directory that discovery skips, and `src/components/experimental/` does not exist here at all. Neither contributes a discovered component.

Beyond discovery, though, the generator's _hardcoded_ reserved entries do not match, and that is a genuine finding recorded in the next section.

## Named locations

Per the acceptance criteria for the regenerate path, these are named, not built.

The generator's intended location is `scripts/mirror/cinder/generate-exports.ts`, invoked by the transform after it has staged corvidae's `components/cinder/src` into the public repository's `packages/components/src`. It is a port of upstream's emit logic with the package root taken as a parameter, reusing the discovery module corvidae already carries.

Upstream's own `exports:check` is not replaced by this. `packages/components/scripts/build.ts` calls it and aborts the build on drift, and that stays where it is: after a sync, the public repository still validates its own generated map against its own component tree. What corvidae adds is a different gate at a different moment.

That gate is a **surface parity check**: a committed snapshot of the last published version's key set under `scripts/mirror/`, compared against the keys the generator just produced, failing loudly on any key present in the published set and absent from the generated one. Additions pass; removals do not.

The parity check belongs at `scripts/cinder-exports-parity.test.ts`, at the top level of `scripts/`, not nested under `scripts/mirror/`. The root `test:self` script is `bun test ./scripts/*.test.ts`, a non-recursive glob, so a test placed at `scripts/mirror/*.test.ts` would be silently skipped by `bun run validate`. Siting it at the top level is what lets it run with no root-manifest change at all. If a future issue prefers to nest it, that issue must also change `test:self` to `bun test ./scripts/**/*.test.ts`, or the check does not run.

## Unresolved finding: reserved entries whose source corvidae dropped

This blocks the first sync regardless of which strategy had been chosen, and it needs a coordinator decision before any parity gate can pass.

The generator hardcodes several reserved entries rather than discovering them. Four published subpaths name source that is absent from or relocated within corvidae:

- `./styles/guard` → `stylesGuardExport()` points at `src/styles/base-guard.ts`, which is absent here.
- `./experimental/json-viewer` and `./experimental/message` → each resolves its component entry through a shim at `src/components/experimental/<name>/index.ts`. The whole `src/components/experimental/` directory is absent here. Their `/schema`, `/variables` and `/styles` subpaths are **not** affected: those six keys point at the promoted component's non-experimental location, which exists in corvidae.
- `./knowledge` → `knowledgeExport()` points at `dist/cli/knowledge.js`, built from `src/cli/`. Corvidae relocated that code to `components/cinder/scripts/knowledge/`, which is outside the published source surface and outside the browser TypeScript configuration's `include`.

Separately, the six reserved `./styles*` entries each carry a `types` target of `<css path>.d.ts`, and none of `src/styles/{index,all,tokens,foundation,utilities,json-highlight}.css.d.ts` exists here. Those are declaration targets rather than whole subpaths: the entries' `default` targets resolve, so the subpaths themselves survive while their types do not.

So: four broken subpaths and six missing declaration targets. The generator would still emit all of them, because they are hardcoded rather than discovered, pointing at files the build cannot produce. The parity gate is expected to fail on exactly these on its first run.

This is reporting what the consolidation already removed, not a proposal to trim the surface. Reducing the 992 is explicitly out of scope. The coordinator needs to choose restore-or-accept for each item before a sync can be gated on parity.

## Correction to the issue's figures

The issue states 991 subpath exports. The published map in the read-only upstream checkout at `/Users/stevekinney/Developer/cinder` carries 992 keys. That count includes the `./package.json` self-export; the basis for the issue's 991 is unknown, and the one-key gap is worth confirming against the registry before the parity snapshot is taken from either number.
