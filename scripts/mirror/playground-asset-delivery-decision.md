# Playground build prefixes: which survive the move into corvidae

COR-1199. Decided which of the five build prefixes carried by `@cinder/playground`'s `dev`, `test`, `typecheck`, `validate`, and `vercel-build` scripts can be removed when the playground moves into this workspace, and named the mechanism that delivers CSS and other assets once they are gone.

This is the COR-1199 decision-time record. Paths, counts, and unresolved follow-up items below describe that analysis; use the current [layout map](layout-map.json) and [source transform](source.ts) when inspecting what the mirror emits today. The internal workspace continues to compile library source directly.

## Decision

All five prefixes are removed, in full. None is replaced by anything.

| Script         | Prefix                         | Determination |
| -------------- | ------------------------------ | ------------- |
| `dev`          | 4 chained `--filter ... build` | Removed       |
| `test`         | 4 chained `--filter ... build` | Removed       |
| `typecheck`    | 4 chained `--filter ... build` | Removed       |
| `validate`     | 4 chained `--filter ... build` | Removed       |
| `vercel-build` | 4 chained `--filter ... build` | Removed       |

The reason is shared across all five, and it is structural rather than a judgment call: the prefix invokes `build` on `@lostgradient/markdown`, `@lostgradient/cinder`, `@lostgradient/editor`, and `@lostgradient/chat`. In corvidae those four workspaces have no `build` script, and `scripts/workspace-contract.test.ts` forbids adding one. A prefix cannot be kept when the command it names cannot exist. This is the same invariant that decided COR-1186, seen from the consumer side.

Asset delivery needs no replacement mechanism, because it never used the prefix. The playground's CSS routes read package source trees off disk with `Bun.file()`; they do not resolve module specifiers, and they never touched `dist/`. Corvidae carries every file those routes read, at the same path relative to each package root. What COR-1200 owes is **path repointing**, not a build: the route roots move from cinder's `packages/<name>/` layout to corvidae's `components/<name>/` and `packages/<name>/` layout. That is named precisely below.

## Why the issue's premise inverts

COR-1199 was scoped on the expectation that code imports were the settled half and assets the uncertain half. Measurement reverses both.

Assets are settled and they are fine. Every stylesheet the playground serves comes from a source-tree file read:

- `src/static-assets.ts` roots the `/styles.css` and `/styles/*` routes at `STYLES_ROOT = <cinder>/src/styles`, and the `/components/*.css` route at `COMPONENTS_SRC_ROOT = <cinder>/src/components`.
- `src/documentation-styles.ts` assembles the `/playground-styles/*.css` bundles from a virtual entrypoint whose `@import` list is built by joining `PLAYGROUND_ROOT/../components/src/...`, then runs it through `Bun.build`.
- `handlePackageComponentStyleRoute` reads `componentSource.componentsRoot`, which is each peer package's `src/lib/components`.

Not one of these paths contains `dist`. Across all of `src/` and `scripts/`, the only `dist/` mention at all is a doc comment inside a test file, `src/playground-server.test.ts`.

Code imports are the broken half. Corvidae's libraries export `{".": "./src/index.ts"}` and nothing else, so every subpath specifier the playground uses fails to resolve. The playground uses roughly 180 distinct ones, `@lostgradient/cinder/button` alone appearing 94 times, and they are not confined to example files: `src/playground-server.ts:40` imports `@lostgradient/markdown/rendering` at module scope, and `src/depict-highlighter.ts` imports `@lostgradient/cinder/highlighters/shiki/curated`. This is a direct consequence of COR-1186, not a challenge to it, and it is recorded below as the finding that blocks COR-1200's acceptance criteria.

### What the prefix was actually protecting upstream

Auditing which condition each specifier selects in the read-only cinder checkout shows the prefix is far narrower than its uniform shape suggests. Under Bun's default conditions, `@lostgradient/cinder` selects `node` → `dist/server/index.js` and `@lostgradient/cinder/highlighters/shiki/curated` selects `node` → `dist/server/highlighters/shiki/index.js`. Those two are imported by server-side playground modules that run under plain `bun`, with no `--conditions` flags, so cinder's build is load-bearing there today.

The other three builds are not. `@lostgradient/markdown/*` selects the `bun` condition and lands on `src/` even by default, so markdown's build is never needed. `@lostgradient/chat` and `@lostgradient/editor` have no bare-specifier import anywhere in the playground's non-test TypeScript at all; they appear only inside `.example.svelte` files and tests, both of which run under `browser` plus `svelte` conditions and resolve to `src/`. The playground already pins those conditions in three places: `tsconfig.json`'s `customConditions: ["svelte"]`, `SHARED_BUILD_OPTIONS.conditions` in `src/build-artifacts-shared.ts`, and `SHARED_FLAGS` in `scripts/run-tests.ts`.

So the honest upstream picture is one load-bearing build out of four, guarding two server-side imports. In corvidae even that one disappears, because `@corvidae/cinder` resolves to source under default conditions with no build at all.

This audit was run with `dist/` present, so it reports which condition each map selects, not what happens when a target is missing. COR-1186 established separately that Bun does not fall through a selected condition whose target is absent, which is what makes selection the decisive fact.

## Evidence

Every command ran in the worktree `/Users/stevekinney/.agent-worktrees/claude/corvidae-cor-1199` on branch `steve/cor-1199`, except the resolution audit of upstream specifiers, which ran in the read-only checkout at `/Users/stevekinney/Developer/cinder` and modified nothing. Exit codes were read from `$?`, never grepped from output.

### The prefix commands do not exist in corvidae

| Command                                       | Exit |
| --------------------------------------------- | ---- |
| `bun run --filter='@corvidae/cinder' build`   | 1    |
| `bun run --filter='@corvidae/chat' build`     | 1    |
| `bun run --filter='@corvidae/editor' build`   | 1    |
| `bun run --filter='@corvidae/markdown' build` | 1    |

`bunx turbo run build --dry=json` reports `command: "<NONEXISTENT>"` for `@corvidae/cinder#build`, `@corvidae/chat#build`, `@corvidae/editor#build`, and `@corvidae/markdown#build`. The only resolvable `build` in the graph belongs to the application `@corvidae/chat-room`.

### Corvidae resolution: the barrel works, every subpath fails

`import.meta.resolve` under `--conditions browser --conditions svelte`, from the repository root:

| Specifier                          | Exit |
| ---------------------------------- | ---- |
| `@corvidae/cinder`                 | 0    |
| `@corvidae/chat`                   | 0    |
| `@corvidae/editor`                 | 0    |
| `@corvidae/cinder/button`          | 1    |
| `@corvidae/cinder/button/styles`   | 1    |
| `@corvidae/cinder/tokens/registry` | 1    |
| `@corvidae/chat/composer-popover`  | 1    |
| `@corvidae/editor/markdown-editor` | 1    |

Under Bun's default conditions, `@corvidae/cinder`, `@corvidae/chat`, and `@corvidae/editor` each exit 0. `@corvidae/markdown` is not linked at the repository root, so it was probed from `components/cinder/`, where the barrel exits 0 and `@corvidae/markdown/rendering` and `@corvidae/markdown/rendering/highlighter` each exit 1 under both condition sets.

`@corvidae/cinder/button/styles` failing here restates COR-1186's finding from the playground's side and confirms the constraint this determination had to respect.

### The stylesheet build works against corvidae source

`src/documentation-styles.ts`'s mechanism was replicated against corvidae: a scratchpad entrypoint that `@import`s absolute paths to `components/cinder/src/styles/index.css`, `styles/json-highlight.css`, and the `button`, `callout`, and `code-block` component stylesheets, run through `Bun.build({ target: 'browser' })`.

| Probe                                                  | Exit | Result                       |
| ------------------------------------------------------ | ---- | ---------------------------- |
| `Bun.build` of the replicated documentation entrypoint | 0    | 104,674 bytes of CSS emitted |
| output contains the `cinder.tokens` layer              | —    | true                         |
| output contains `cinder-button` rules                  | —    | true                         |
| output retains any unresolved bare `@import`           | —    | false                        |

This is the empirical asset answer. The exact bundling path the playground uses for its two shared stylesheets produces a complete, correct cascade from corvidae's source with no build step anywhere upstream of it.

### Other assets are the empty set

Scanning every `.css` file under `components/*/src` and `packages/markdown/src`: no bare-specifier `@import` survives anywhere (the four grep hits are prose inside comments), and every `url()` is an inline `data:image/svg+xml` mask in `rating`, `checkbox`, `multi-select`, `radio-group`, and `select`. There is no external font, image, or binary asset reachable from library CSS. The playground's only binary asset, `src/assets/social.png`, is playground-owned and moves with it.

Notably, corvidae's chat component stylesheets carry no `@import '@lostgradient/cinder/<name>/styles'` lines at all, where the upstream copies of `chat-conversation-header.css` and `chat-composer-popover.css` each carry one. `src/static-assets.ts`'s `rewritePackageComponentStyleImports`, which exists to rewrite exactly those specifiers into playground URLs, is therefore a no-op against corvidae's tree. It is harmless to keep and pointless to keep.

### The cross-package reaches, probed

`ls` against each target in corvidae, exit read from `$?`:

| Target                                                    | Exit |
| --------------------------------------------------------- | ---- |
| `components/cinder/tsconfig.json`                         | 0    |
| `components/cinder/scripts/lib/visual-fixtures/loader.ts` | 0    |
| `components/cinder/scripts/svelte-plugin.ts`              | 2    |
| `components/cinder/src/test/happy-dom.ts`                 | 2    |
| `components/cinder/scripts/lib/visual-fixtures/schema.ts` | 2    |
| `components/cinder/scripts/lib/strip-example-harness.ts`  | 2    |
| `packages/testing/scripts/source-fingerprint.ts`          | 2    |
| `tsconfig.base.json`                                      | 2    |

`find` across the workspace locates no `svelte-plugin.ts` or `happy-dom.ts` under `components/cinder` at any depth, and no file named `strip-example-harness` or `source-fingerprint` anywhere. Importing the `@corvidae/testing` barrel under `browser` plus `svelte` conditions exits 0 and reports `sveltePlugin` and `setupHappyDom` both present, which is where the first two moved.

### `vercel-build` and `validate` inherit `dev`'s answer

`scripts/static-export.ts` does not re-implement asset serving. It imports `handleRequest` from `src/playground-server.ts` and drives the same route table, writing each response body to `public/`. `src/validate-playground.ts` contains no CSS or `dist` reference whatsoever. Neither script can need something the dev server does not.

## Named replacement mechanism

Asset delivery keeps its current mechanism. The routes stay; their roots move.

The package roots that drive every CSS route live in two files:

- `src/component-sources.ts`: `PACKAGES_ROOT` and the three roots derived from it. `cinderPackageRoot = join(PACKAGES_ROOT, 'components')` becomes `components/cinder`; `chatPackageRoot` becomes `components/chat`; `editorPackageRoot` becomes `components/editor`. Markdown is the asymmetric one, living under `packages/markdown` rather than `components/`, so a single shared parent no longer serves all four. Each `ComponentSource`'s `repositoryComponentsRoot` also spells out `packages/components/src/components`, `packages/chat/src/lib/components`, and `packages/editor/src/lib/components` as literal strings.
- `src/documentation-styles.ts`: `stylesheetEntry`'s hardcoded `join(PLAYGROUND_ROOT, '..', 'components', 'src')`.

`src/static-assets.ts` needs no change of its own, because its roots derive from `CINDER_COMPONENT_SOURCE.packageRoot`.

### Every reach out of the playground package

Those two files are not the whole surface. Regenerate the full list with `grep -rn --include='*.ts' --include='*.svelte' --include='*.json' "\.\./\.\./" src scripts tsconfig.json` from the playground root: 20 non-test hits, of which the `../../src/...` ones are self-relative strings inside bundler entrypoints and need nothing. The genuine cross-package reaches, each probed for existence in corvidae, are these:

| Reach | Sites | In corvidae |
| --- | --- | --- |
| `../../components/scripts/svelte-plugin.ts` | `preload.ts`, `build-artifacts-shared.ts`, `featured-example-server-worker.ts`, `ssr-renderer.ts` | absent at that path; exported as `sveltePlugin` from the `@corvidae/testing` barrel |
| `../../components/src/test/happy-dom.ts` | `preload.ts` | absent at that path; exported as `setupHappyDom` from the `@corvidae/testing` barrel |
| `../../components/scripts/lib/visual-fixtures/loader.ts` | `playground-server.ts` | present at `components/cinder/scripts/lib/visual-fixtures/loader.ts` |
| `../../components/scripts/lib/visual-fixtures/schema.ts` | `playground-server.ts`, `fixture-bundle.ts` | absent; `packages/testing/src/visual-fixtures.ts` is re-exported from the same barrel |
| `../../components/tsconfig.json` | `analyze.ts` | present at `components/cinder/tsconfig.json` |
| `../../components/scripts/lib/strip-example-harness.ts` | `playground-server.ts` | absent from the whole workspace |
| `../../testing/scripts/source-fingerprint.ts` | `playground-server.ts` | absent from the whole workspace |
| `../../tsconfig.base.json` | `tsconfig.json` `extends` | absent; corvidae's equivalents are `internal/typescript/{browser,library}.json` |

Of the eight, two are a plain path rewrite, three collapse into a single `@corvidae/testing` barrel import (which resolves cleanly and exports both `sveltePlugin` and `setupHappyDom`, as the evidence above records), and one swaps cinder's root `tsconfig.base.json` for corvidae's `internal/typescript` configurations. The remaining two, `strip-example-harness.ts` and `source-fingerprint.ts`, exist nowhere in corvidae and must be ported or replaced. That last pair is real work COR-1200 has to scope, not a rename.

## Unresolved: the subpath specifiers, which block COR-1200

This is the real work the prefix was hiding, and it is not settled by this determination. Roughly 180 distinct subpath specifiers do not resolve in corvidae, in five classes that need different answers:

- **Cinder component barrels**: `@lostgradient/cinder/<name>`, about 170 of them. The root barrel is a viable target and is already the local convention. `components/cinder/src/index.ts` was probed for `Button`, `RunStepTimeline`, `SelectionPopover`, `Dropdown`, `CommandMenu`, `JsonViewer`, `Waveform`, and `Spectrogram`, and exports all eight. Corvidae's own `components/chat/src` imports cinder through the barrel 38 times and through a subpath zero times, and `components/cinder/components.json` already records `"import": "@corvidae/cinder"` for all 200 components.
- **Data subpaths**: `/button/{schema,examples,constraints,variables}`, `/tokens/registry`, `/tokens/resolved/light`. These reach JSON and generated files that a value barrel cannot carry. A relative file read or a JSON import is the likely shape, but it is a decision, not a rewrite.
- **Highlighter subpaths**: `/highlighters/shiki` and `/highlighters/shiki/curated`, imported by server-side modules under default conditions.
- **Peer-package subpaths**: eight across chat and editor, enumerated in `CHAT_IMPORT_PATHS` and `EDITOR_IMPORT_PATHS`.
- **Markdown rendering subpaths**: `/rendering`, `/rendering/highlighter`, `/rendering/types`, one of them imported at module scope by the dev server itself.

The coupling that makes this more than a find-and-replace: `src/component-sources.ts` _parses_ these specifiers as text to decide which CSS to link. `CINDER_COMPONENT_IMPORT` matches `from '@lostgradient/cinder/<name>'` in example sources, and `implementationDependencies` follows a component's own Svelte implementation looking for the same pattern. Under corvidae's barrel-only convention that regex matches nothing, and the entire dependency walk falls to `CINDER_ROOT_BARREL_IMPORT`, which maps export names to component ids through `components.json`. That manifest exists here with all 200 entries carrying `exportName`, so the barrel path is workable, but whichever import form COR-1200 picks changes the asset-delivery walk as well as the imports. Picking the import form and re-establishing the CSS dependency walk are one decision, not two.

Related, and small: `resolveEditorStylesheetUrl` decides whether an editor component has a CSS sidecar by testing `exportKeys.has('./<name>/styles')` against editor's real `exports` map. In corvidae that map has one key, so the set is empty and every editor component silently loses its sidecar link. The failure is quiet rather than loud, which is what makes it worth naming here.

## Unresolved: whether `vercel-build` should exist at all

The prefix comes off `vercel-build` for the same reason it comes off the other four. Whether the script itself survives the move is a separate coordinator call: `scripts/static-export.ts` is deployment tooling, and AGENTS.md prohibits deployment infrastructure in this workspace outside the narrow mirror exception at `scripts/mirror/` and `.github/workflows/mirror-sync.yaml`. This determination does not decide it, and COR-1200 should not assume it either way.

## Correction to the issue's framing

The issue states that removing the build need for code imports is "certain" and that CSS and asset delivery "may still require a build step, or may need a different mechanism entirely." Both halves are wrong in the same direction.

Asset delivery never required a build and requires no new mechanism. It requires the four package roots to be repointed at corvidae's directory layout.

Code imports are not certain. Corvidae's source exports fix resolution for the four package barrels and break it for every one of the roughly 180 subpaths the playground actually imports, including two inside the dev server's own module graph. That is the open question COR-1200 inherits, and it is larger than the one this issue was split out to answer.
