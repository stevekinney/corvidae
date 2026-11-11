# @lostgradient/cinder

Private [Svelte](https://svelte.dev/) components for Corvidae: accessible primitives, design tokens, component styles, generated prop schemas, and examples for people and local tooling.

## Workspace usage

Declare `"@lostgradient/cinder": "workspace:*"` in the consuming workspace's dependencies, then run `bun install --frozen-lockfile` from the Corvidae root. Svelte and other external dependency versions come from the root Bun catalog.

The package exports its TypeScript source through `@lostgradient/cinder`. Your application compiles the Svelte components and includes their styles. The root entry imports the base stylesheet, which establishes the cascade-layer order, tokens, foundation rules, and shared component styles.

The [interface patterns guide](./documentation/interface-guide.md) collects the ownership, composition, accessibility, and failure-state rules that span multiple components. Use the leaf README beside a component for its generated API table.

```svelte
<script lang="ts">
  import { Button } from '@lostgradient/cinder';
</script>

<Button id="save-project" variant="primary" label="Save changes" />
```

Import components, utilities, types, and metadata from this one entry point. Compound components retain their namespace API, such as `Tabs.List`, `Tabs.Trigger`, and `Tabs.Panel`. The application bundler handles the source graph and CSS side effects.

[Editor](../editor/README.md) and [Markdown](../../packages/markdown/README.md) own their respective product APIs in separate workspaces. Syntax highlighting dependencies used by Cinder's `CodeBlock` are declared directly by Cinder.

## Component metadata

The root exports the component manifest and named metadata values:

```ts
import {
  manifest,
  buttonSchema,
  buttonVariables,
  buttonConstraints,
  buttonExamples,
} from '@lostgradient/cinder';
```

You can inspect a component's props, CSS variables, cross-prop constraints, and examples from the package root. `manifest.components` ties those artifacts to each public component and records its identifier, category, tags, purpose, usage guidance, and related components. Its artifact paths point to files in this workspace—not package import subpaths.

- **Schema**: A JSON Schema document for component props, exported as `<componentName>Schema`.
- **Variables**: Public CSS custom property names, exported as `<componentName>Variables`.
- **Constraints**: Cross-prop rules, exported as `<componentName>Constraints` when present.
- **Examples**: Canonical usage snippets, exported as `<componentName>Examples` when present.

Use lower-camel component names, such as `button` or `dataTable`. Check the manifest's `hasConstraints` and `hasExamples` flags for optional artifacts.

Applications import `manifest` and named metadata from `@lostgradient/cinder`; the library root supports browser and server rendering.

## Token data

The package root also exports `TOKEN_REGISTRY`, its `TokenRegistry` and `TokenRegistryEntry` types, `tokenResolver`, and `tokenIndex`. The registry supports dynamic string lookups, such as `TOKEN_REGISTRY.pathToCssProperty[path]`.

`tokenIndex.sources` lists each corpus file and its named root export; `tokenIndex.resolvedContexts` identifies the four resolved theme and motion contexts. For example, import `foundationTokens` for the unresolved foundation document or `resolvedDarkReducedMotionTokens` for its resolved context. The resolver's relative references still describe the corpus files, and the index maps those files to the root exports.

The generated registry module reads the same JSON data used by local token tooling. Run `bun run tokens:generate` after changing the corpus and `bun run tokens:check` to verify generated data matches it.

## Theming

Cinder uses CSS custom properties and `color-scheme`; there is no provider to mount.

```css
html {
  color-scheme: light;
}

html[data-theme='dark'] {
  color-scheme: dark;
}

[data-theme='light'] {
  color-scheme: light;
}

[data-theme='dark'] {
  color-scheme: dark;
}
```

Use `[data-theme='dark']` or `[data-theme='light']` on a subtree for scoped theme islands. Cinder pins the core semantic surface, text, border, overlay, interaction, status, and control tokens inside those scopes so components inherit local values without app-level token overrides. If your app replaces Cinder's public tokens for custom branding, set those brand overrides in the same scoped theme selector.

A theme island also paints its own canvas: a `[data-theme]` element that is not the root gets `background-color: var(--cinder-surface-canvas)` and `color: var(--cinder-text-default)` at zero specificity (`:where()`), so a dark island inside a light page does not keep the page's light background and text, and every component background and color inside it still wins. Set `data-theme-paint="none"` on an island that must stay transparent, such as an overlay layer. The root is never painted by this rule; `body` paints the page.

Call `guardThemeTransitions()` once at application start. Components transition color, background and border for hover and press feedback, and a theme change alters all of those at once, so without the guard every button, card and banner animates from the old theme's colors to the new ones (and a hidden or throttled page can stall halfway, leaving light surfaces under dark text). The guard watches `data-theme` on the root and the system `prefers-color-scheme` setting, sets `THEME_CHANGING_ATTRIBUTE` (`data-cinder-theme-changing`) on the root for the two frames that render the change, which the foundation styles answer with `transition: none`, and returns a function that removes it. `ThemeTransitionGuardOptions` takes another `root`, a `matchMedia` (or `null` to ignore the system setting) and a `requestFrame` scheduler.

```ts
import { guardThemeTransitions } from '@lostgradient/cinder';

const stopGuarding = guardThemeTransitions();
```

To author a complete theme, use the theme builder: the `/theme-builder` route of the playground application (`bun run --filter=@lostgradient/playground dev`). It edits every public token, reports scoped accessibility findings, and exports a Cinder Theme v1 source file, deployment CSS, and portable DTCG. See [Theming](./documentation/theming.md#the-theme-builder) for the export formats, a worked example, and what the accessibility checks do and do not cover, and [Design tokens](./documentation/tokens.md#editing-the-full-registry-in-the-theme-builder) for how the registry is exposed for editing.

Public tokens use the `--cinder-` prefix. Internal implementation variables use `--_cinder-`; do not redefine those.

## Content

Cinder's copy is sentence case, names exactly what a control does, and never uses a middle dot (U+00B7) to separate pieces of text. A line such as a status, an agent and a time is not written with a dot between its parts. Pick the alternative that fits:

- **A comma** when the pieces read as one short phrase: "Waiting on you, Chat, 4 min ago".
- **Separate elements** when each piece is its own thing, such as a `StatusDot` beside a name, or a time in its own `<time>`. Let the layout's gap and the type's tone separate them, not a glyph.
- **A line break** when the pieces are different kinds of information: a title on one line and its detail on the next.
- **A `DescriptionList`** when the pieces are label and value metadata, such as "Owner" and "Tool runner".

The root `lint:root` guard `scripts/check-middle-dot-separators.ts` fails on a middle dot in Cinder, the playground and Interborough. Code that must name the character, such as a test asserting its absence, builds it with `String.fromCodePoint(0xb7)`.

## A2UI catalog (experimental)

> [!WARNING] Experimental, pinned to A2UI v0.9.1 The catalog follows A2UI v0.9.1 and may change until a stable A2UI 1.0 compatibility review. It is opt-in: no surface uses it unless a client asks for it.

`a2ui-catalog.json` at the package root is Cinder's A2UI catalog (COR-1310): the Cinder components an agent may place on an A2UI surface, projected from their generated `*.schema.json` files and `components.json`. It is a file in the package, not an export of `@lostgradient/cinder`; a server that offers it copies it (Bureau keeps a byte-identical copy, which the root `scripts/a2ui-catalog-copies.test.ts` enforces).

- **Identity.** Its `catalogId` and `$id` are the same URI, `https://cinder.website/a2ui/v0_9_1/catalogs/cinder/v1/catalog.json`: `v0_9_1` is the pinned A2UI version and `v1` is Cinder's catalog revision. A client lists that URI in `supportedCatalogIds`; Bureau offers the catalog only to a client that does (see [Bureau's adapter](../../packages/bureau/documentation/interactive-surface.md#the-adapter-experimental)), and offers the A2UI basic catalog otherwise.
- **Contents.** An explicit allowlist (`scripts/a2ui-catalog-allowlist.json`) of eight components: `Checkbox`, `CopyButton`, `Meter`, `NumberInput`, `Progress`, `Rating`, `Spinner`, and `Toggle`. It defines no functions, and its `anyComponent` is those eight alone, so it does not include the basic catalog's layout or text components.
- **What a property keeps.** Model-generated UI gets no ambient authority. Styling hooks (`class`, `style`), DOM identity and form association (`id`, `form`, `name`), anything that fetches or navigates (`href`, `src`), raw markup (`html`), event handlers, ARIA references to other elements, and `data-*` attributes never reach the catalog. Each entry carries an accessible name as its `label`, taken from the component's `label`, `ariaLabel`, `alt`, or `title`; the generator fails when a listed component has none.
- **Regenerating.** `bun run a2ui-catalog:generate` rewrites the file; `bun run a2ui-catalog:check` fails on drift. The generator validates the result against the vendored A2UI v0.9.1 schemas (`scripts/a2ui/PROVENANCE.json` names the upstream commit) and writes nothing if a listed component has no schema or no accessible name.
- **Rendering.** `A2uiSurface` in `@lostgradient/chat` renders the basic catalog only, so it does not render this catalog's components; they report as `unsupported-component`. A renderer that lists this catalog has to implement those components itself.

## Design system

Cinder's design system for Claude Design is generated from this workspace: the tokens from `src/tokens/resolved/`, a guideline page per component from `components.json` and the component's README, a preview card per component that mounts up to four of its playground examples, and `components/bundle.js`, one script that exposes every component as `window.Cinder` so a design canvas mounts the real components. Each `Cinder.<Export>` is a React component over the Svelte one, built by `scripts/design-system/bundle-runtime.svelte.ts`; the canvas supplies React 18, and the bundle carries none. The brand book's "Consuming the components" section shows a canvas using it. The editor package's components (`components/editor/components.json`, among them `MarkdownEditor`, the default for multi-line text entry in prototypes) are included the same way: a guideline page and a preview card each, with their styles in `bundle.css`, and a bundle entry that loads the editor package, Milkdown and ProseMirror with it, only when the first editor mounts. Build it after Cinder or the editor changes. From the Corvidae root:

```bash
bun run --filter=@lostgradient/cinder design-system:build
```

The build writes the publishable folder to `tmp/cinder-design-system/out/project/` (`--out <directory>` moves the `out` directory). It renders every card in headless Chromium, in light and dark, and exits non-zero when a preview fails to build, logs an error, or renders empty; the folder is not ready to publish until it passes. The output is deterministic for a commit, apart from its timestamps and card heights, which depend on the fonts installed. The brand book and the cover card are checked in as `scripts/design-system/assets/brand-book.md` and `scripts/design-system/assets/cover.html`.

Each person publishes to their own artifact, so its URL is per-user configuration and never in the repository: the `CORVIDAE_DESIGN_SYSTEM_URL` environment variable, or else `url` in `~/.config/corvidae/design-system.json`. Print the configured URL, or learn that none is set, with:

```bash
bun run --filter=@lostgradient/cinder design-system:url
```

On the first publish, create the artifact from the Design System type with Claude Code's Artifact tool, then save its URL with `design-system:url --set <url>` or by writing the file by hand. Later runs republish to that URL. First list the artifact's files (`action: "list"`, `scope: "files"`), because the tool refuses to overwrite files the session has not seen; an account that can't open the artifact can't republish it, and creates its own instead. Then publish once for each entry of `tmp/cinder-design-system/out/publish-batches.json`, in order. Each publish passes the artifact's `url`, `root` set to `tmp/cinder-design-system/out`, and that entry's paths as `files`. A batch holds at most 240 files, and the last one holds only the index, `project/design-system.json`, so the system never points at files that have not arrived. A publish keeps files it does not name, so when a component leaves Cinder, remove its paths with `null` entries.

## What Cinder Does Not Provide

Cinder is a presentation library, not an application framework.

- No router.
- No form-state manager.
- No application-wide toast singleton; use `ToastRegion` for scoped toast UI.
- No data fetching layer.
- No global state provider.
- No general-purpose icon library for product-specific icons.

Wire those pieces with your application stack and pass the resulting state, callbacks, links, icons, and data into cinder components.

## Development

From `components/cinder`, run the source checks:

```bash
bun run lint
bun run typecheck
bun run test
bun run components:check
bun run tokens:check
```

After editing component source under `src/components/<component-id>/`, run `bun run components:generate` to refresh schemas, variables, examples, the manifest, and metadata exports. Token corpus changes use `bun run tokens:generate`.

From the Corvidae root, `bunx turbo run lint typecheck test --filter=@lostgradient/cinder` checks this workspace and `bun run validate` checks the complete repository. Browser fixtures and interaction tests live in `scripts/browser-fixtures`. Cinder has no library build or publishing step.

### Component authoring checklist

Before adding a component, search the inventory and compose an existing primitive when it already provides the behavior. A new component needs its own behavior, state, or accessibility semantics; presentation differences belong in props, variants, or documented presets. Check the [machine-readable prop conventions](./scripts/component-conventions-props.ts) before naming public props, and use `Input` and `FormField` for form controls. Add a substantive test, README, stylesheet registration, generated artifacts, and the required root export. Record the design review in `*.a11y.md`; novel interaction models also need a human accessibility review covering focus, keyboard behavior, and announcements.

The machine-readable checklist lives in [`component-conventions-props.ts`](./scripts/component-conventions-props.ts). Its checks are enforced by `components:check` and the focused [prop-convention checker](./scripts/check-prop-conventions.ts); the generated README link points here so the guidance stays with the current source rules.
