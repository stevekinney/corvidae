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

## Web Components

From the repository root, run `bun run --cwd components/cinder web-components:build`. Serve the resulting `components/cinder/dist/web-components/` directory over HTTP and open `index.html` to try the [plain HTML example](./src/web-components/example.html). The build compiles the Cinder source components directly and bundles the Svelte runtime. Load the module and stylesheet in the page.

```html
<link rel="stylesheet" href="./web-components.css" />
<script type="module" src="./web-components.js"></script>
```

Workspace applications can import the generated assets as `@lostgradient/cinder/web-components` and `@lostgradient/cinder/web-components.css`. The stylesheet supplies the page theme. The browser build also emits element typings for the Web Components entry point. The accordion uses the shared Cinder styles in its shadow root.

Each entry in the Cinder component manifest gets a `cinder-<id>` element. The build reads the corresponding prop schema to choose attribute conversions, such as Boolean presence, numbers, and JSON arrays. Assign structured values, DOM references, and callbacks directly as JavaScript properties. Use kebab-case in HTML for camel-case property names. Component props that share a name with a native element property use a `component` prefix, as in `component-id` and `componentId`.

Use authored HTML for static `children`. To supply a named content region, use its snippet name as the `slot` attribute. For content that receives live data, assign the corresponding `render` property. For example, `renderRow` receives the current item and row context from VirtualList. Return a DOM node or a string. Strings are rendered as text.

```html
<template id="rows">
  <cinder-virtual-list item-height="32" height="128px"></cinder-virtual-list>
</template>
<script type="module">
  await customElements.whenDefined('cinder-virtual-list');
  const template = document.querySelector('#rows');
  const list = template.content.querySelector('cinder-virtual-list');
  list.items = ['Daily digest', 'As they arrive'];
  list.renderRow = (item, { index }) => `${index + 1}. ${item}`;
  template.replaceWith(list);
</script>
```

- `<cinder-avatar>` accepts `name`, `src`, `alt`, `size`, and `shape`. It inherits Cinder theme tokens from the page.
- `<cinder-button>` accepts `label`, `variant`, `size`, `disabled`, and `loading`. Use `type="submit"` inside a form.
- `<cinder-select>` accepts `label`, `name`, `value`, `required`, and `disabled`. Add `<option>` children with `value`, `disabled`, or `selected` attributes as needed, or set the `options` JavaScript property with objects containing `value` and `label`. The native select bubbles `change` and participates in form submission.
- `<cinder-accordion>` takes direct `<cinder-accordion-item heading="…">` children. Each item's HTML becomes its panel content. Use `disabled` on an item to disable its trigger, or `multiple` on the parent to allow multiple expanded panels.

## Token utilities

Import `@lostgradient/cinder/utilities.css` alongside Cinder's base styles to opt into unprefixed classes such as `gap-3`, `padding-inline-3`, `margin-block-start-4`, `text-muted`, `background-surface-raised`, and `rounded-medium`. The stylesheet is generated with Cinder's metadata and uses the same CSS variables as its components. A theme override applies anywhere the variable is in scope.

## Maintainer tool

The component tooling owns `internal/component-tooling/scripts/export-names.ts`, a manual export-inventory CLI for reviewing a TypeScript barrel's runtime and type names. From this workspace, run `bun ../../internal/component-tooling/scripts/export-names.ts src/index.ts`; it prints sorted `runtime` and `types` lists for a review diff.

## Component metadata

Component metadata is JSON the package exports by subpath, apart from the root barrel:

```js
import manifest from '@lostgradient/cinder/manifest' with { type: 'json' };
import buttonSchema from '@lostgradient/cinder/button/schema' with { type: 'json' };
import buttonVariables from '@lostgradient/cinder/button/variables' with { type: 'json' };
import buttonExamples from '@lostgradient/cinder/button/examples' with { type: 'json' };
```

`manifest.components` ties those files to each public component and records its identifier, category, tags, purpose, usage guidance, and related components. Its artifact paths are package-relative files.

- **Schema** (`./<component-id>/schema`): a JSON Schema document for the component's props.
- **Variables** (`./<component-id>/variables`): the public CSS custom property names it declares.
- **Examples** (`./<component-id>/examples`): canonical usage snippets, when it has them.
- **Constraints**: cross-prop rules, authored as `src/components/<component-id>/<component-id>.constraints.json` when present.

Use kebab-case component ids, such as `button` or `data-table`. Check the manifest's `hasConstraints` and `hasExamples` flags for optional artifacts.

The package's `metadata` task (`bunx turbo run metadata --filter=@lostgradient/cinder`) generates these files into the ignored `.metadata/` directory from each component's `<name>.meta.json`, types, and stylesheets; every task that reads them depends on it.

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

Call `trackInputModality()` once at application start as well. It writes `data-cinder-input-modality` (`keyboard` or `pointer`) on the root from the last input, and the foundation styles draw the global default focus ring on a script focus target (`tabindex="-1"`) only while it says `keyboard`; without it a keyboard user never sees that ring. A ring a component draws on such a target, and an application's own unlayered `:focus-visible` rule, are unaffected (see the [focus ring policy](./documentation/focus-ring-policy.md#script-focus-targets)).

```ts
import { trackInputModality } from '@lostgradient/cinder';

const stopTracking = trackInputModality();
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

## Composition

Most defects in a generated page come from how the components are arranged, not from the components. The [brand book](./scripts/design-system/assets/brand-book.md) states the binding composition rules and [Composing a page](./documentation/interface-guide.md#composing-a-page) names the page archetypes. Two rules apply to every page:

- **Record metadata is label and value, not pills.** A [`Badge`](./src/components/badge/README.md) or a [`Chip`](./src/components/chip/README.md) is for a status or a short tag. The label and value metadata of a record (an owner, a created date, a price) goes in a [`DescriptionList`](./src/components/description-list/README.md), or a [`KeyFacts`](./src/components/key-facts/README.md) row for a few typed facts.
- **An inline choice stays in the page flow.** Do not wrap a form control or an inline choice, such as a [`SegmentedControl`](./src/components/segmented-control/README.md), in a tinted [`Callout`](./src/components/callout/README.md) or [`Alert`](./src/components/alert/README.md). Place it in the flow with a plain label, and keep the callout or alert for a note or a message about it.

A third applies to lists: trailing row actions sit in a fixed column, so a badge never changes where an action button lands. Put the badge with the metadata in the content column of the [`StackedListItem`](./src/components/stacked-list-item/README.md).

A surface of your own docked to the bottom of the page, such as a composer, takes the `dockedToBottom()` attachment, so a [`ToastRegion`](./src/components/toast-region/README.md#where-the-region-sits) sits above it as it sits above a `DockedActionBar` or a bottom `NavigationBar`.

## A2UI catalog (experimental)

> [!WARNING] Experimental, pinned to A2UI v0.9.1 The catalog follows A2UI v0.9.1 and may change until a stable A2UI 1.0 compatibility review. It is opt-in: no surface uses it unless a client asks for it.

Cinder's A2UI catalog (COR-1310) lists the Cinder components an agent may place on an A2UI surface, projected from their generated schemas and manifest. The `metadata` task writes it to `.metadata/a2ui-catalog.json`; it is not an export of `@lostgradient/cinder`. A server that offers it copies it: Bureau keeps a formatted copy, `packages/bureau/src/a2ui/cinder-catalog.schema.json`, which Cinder's lint holds byte for byte to the generated catalog, with its digest in Bureau's `PROVENANCE.json`.

- **Identity.** Its `catalogId` and `$id` are the same URI, `https://cinder.website/a2ui/v0_9_1/catalogs/cinder/v1/catalog.json`: `v0_9_1` is the pinned A2UI version and `v1` is Cinder's catalog revision. A client lists that URI in `supportedCatalogIds`; Bureau offers the catalog only to a client that does (see [Bureau's adapter](../../packages/bureau/documentation/interactive-surface.md#the-adapter-experimental)), and offers the A2UI basic catalog otherwise.
- **Contents.** An explicit allowlist (`scripts/a2ui-catalog-allowlist.json`) of eight components: `Checkbox`, `CopyButton`, `Meter`, `NumberInput`, `Progress`, `Rating`, `Spinner`, and `Toggle`. It defines no functions, and its `anyComponent` is those eight alone, so it does not include the basic catalog's layout or text components.
- **What a property keeps.** Model-generated UI gets no ambient authority. Styling hooks (`class`, `style`), DOM identity and form association (`id`, `form`, `name`), anything that fetches or navigates (`href`, `src`), raw markup (`html`), event handlers, ARIA references to other elements, and `data-*` attributes never reach the catalog. Each entry carries an accessible name as its `label`, taken from the component's `label`, `ariaLabel`, `alt`, or `title`; the generator fails when a listed component has none.
- **Regenerating.** The `metadata` task rewrites the catalog; `bun ../../internal/component-tooling/scripts/generate-a2ui-catalog.ts --write-bureau` rewrites Bureau's copy and its digest after a change. The generator validates the result against the vendored A2UI v0.9.1 schemas (`internal/component-tooling/scripts/a2ui/PROVENANCE.json` names the upstream commit) and writes nothing if a listed component has no schema or no accessible name.
- **Rendering.** `A2uiSurface` in `@lostgradient/chat` renders the basic catalog only, so it does not render this catalog's components; they report as `unsupported-component`. A renderer that lists this catalog has to implement those components itself.

## Design system

Cinder's design system for Claude Design is generated from this workspace: the tokens from `src/tokens/resolved/`, a guideline page per component from `components.json` and the component's README, a preview card per component that mounts up to four of its playground examples, and `components/bundle.js`, one script that exposes every component as `window.Cinder` so a design canvas mounts the real components. Each `Cinder.<Export>` is a React component over the Svelte one, built by `scripts/design-system/bundle-runtime.svelte.ts`; the canvas supplies React 18, and the bundle carries none. The brand book's "Consuming the components" section shows a canvas using it. The editor package's components (`components/editor/components.json`, among them `MarkdownEditor`, the default for multi-line text entry in prototypes) are included the same way: a guideline page and a preview card each, with their styles in `bundle.css`, and a bundle entry that loads the editor package, Milkdown and ProseMirror with it, only when the first editor mounts. Build it after Cinder or the editor changes. From the Corvidae root:

```bash
bun run --filter=@lostgradient/cinder design-system:build
```

The build writes the publishable folder to `tmp/cinder-design-system/out/project/` (`--out <directory>` moves the `out` directory). It renders every card in headless Chromium, in light and dark, and exits non-zero when a preview fails to build, logs an error, or renders empty; the folder is not ready to publish until it passes. The output is deterministic for a commit, apart from its timestamps and card heights, which depend on the fonts installed. The brand book and the cover card are checked in as `scripts/design-system/assets/brand-book.md` and `scripts/design-system/assets/cover.html`.

A canvas that writes plain HTML links `components/bundle.css`, which carries Cinder's real component styles, and copies markup from `recipe.md` (checked in as `scripts/design-system/assets/recipe.md`) instead of hand-building component classes. The build also publishes one full-page card per page archetype under the "Page archetypes" group (`ArchetypeBrowse`, `ArchetypeMap` and so on). Each page is a checked-in file in `scripts/design-system/assets/archetypes/`, written from the recipe's markup, with the layout they share in `archetype.css`. The build renders every archetype in light and dark at a phone and a desktop width, and fails on a console error, an empty page, a page that scrolls sideways, or a native select that shows the browser's caret. `scripts/design-system/archetypes.test.ts` checks that every `cinder-` class in the recipe and the pages is one `bundle.css` styles, and that every token the layout names exists.

Each person publishes to their own artifact, so its URL is per-user configuration and never in the repository: the `CORVIDAE_DESIGN_SYSTEM_URL` environment variable, or else `url` in `~/.config/corvidae/design-system.json`. Print the configured URL, or learn that none is set, with:

```bash
bun run --filter=@lostgradient/cinder design-system:url
```

On the first publish, create the artifact from the Design System type with Claude Code's Artifact tool, then save its URL with `design-system:url --set <url>` or by writing the file by hand. Later runs republish to that URL. First list the artifact's files (`action: "list"`, `scope: "files"`), because the tool refuses to overwrite files the session has not seen; an account that can't open the artifact can't republish it, and creates its own instead. Then publish once for each entry of `tmp/cinder-design-system/out/publish-batches.json`, in order. Each publish passes the artifact's `url`, `root` set to `tmp/cinder-design-system/out`, and that entry's paths as `files`. A batch holds at most 240 files, and the last one holds only the index, `project/design-system.json`, so the system never points at files that have not arrived. A publish keeps files it does not name, so when a component leaves Cinder, remove its paths with `null` entries.

## Panels

A plugin's panel is one self-contained document in a sandboxed frame, and `@lostgradient/cinder/panel` is the kit that makes it look like the application that hosts it. It exports `mountPanel(component, { target, props })`, which wraps Svelte's `mount` and defaults the target to the document body, and `PANEL_TOKEN_MAP`, the `[specKey, cinderToken]` pairs. Importing the entry loads Cinder's shared layers and an unlayered `:root` rule in which each `--cinder-*` token the MCP Apps spec maps reads `var(--color-…, <Cinder default>)`. The host's theme variables win where the host sends them, the fallback is Cinder's own value, and every other token keeps Cinder's default. The entry does not depend on `@modelcontextprotocol/ext-apps`: the panel applies the host's theme with that SDK, and the variables it writes are what the stylesheet reads. Dialogs, popovers and toasts stay inside the frame, focus does not flow between the host and the panel, and navigation, links, resizing and notifications go through the host's bridge. The [plugin SDK](../../packages/interborough-plugin/README.md) documents the same limits for a plugin author.

## Icons

Cinder exports a curated product icon vocabulary from `@lostgradient/cinder`, drawn from Lucide so the set shares one weight and the stroke follows the text beside it. It covers the nouns a product's navigation, rows, facts and empty states name, next to the editor and developer glyphs the library already carried:

| Group | Noun and export |
| --- | --- |
| Navigation | home `House`, inbox `Inbox`, today `Sun`, search `Search`, settings `Settings`, saved `Bookmark`, map `MapIcon`, list `List` |
| Entities | person `User`, project `FolderKanban`, area `Layers`, calendar `CalendarIcon`, place `MapPin`, run `Play`, agent `Bot`, workflow `Workflow`, schedule `CalendarClock`, review `ClipboardCheck` |
| States | clock `Clock`, check `Check`, warning `TriangleAlert`, offline `WifiOff` |
| Actions | share `Share`, directions `Navigation`, more `MoreHorizontal`, add `Plus`, filter `Funnel` |

`CalendarIcon` and `MapIcon` carry the suffix so they never shadow the `Calendar` component or the global `Map`.

Size an icon with `cinder-icon-sm`, `cinder-icon-md` or `cinder-icon-lg` (16, 20 and 24px). Each class also sets the stroke for its size (2, 1.75 and 1.5), so the glyph keeps the visual weight of the text beside it. An icon is decorative by default and is hidden from assistive technology; give it an `aria-label` only when it stands alone without text.

```svelte
<script lang="ts">
  import { House } from '@lostgradient/cinder';
</script>

<House class="cinder-icon-md" />
<House class="cinder-icon-md" aria-label="Home" />
```

## What Cinder Does Not Provide

Cinder is a presentation library, not an application framework.

- No router.
- No form-state manager.
- No application-wide toast singleton; use `ToastRegion` for scoped toast UI.
- No data fetching layer.
- No global state provider.
- No icon library beyond Cinder's common vocabulary. Product-specific glyphs stay in the application that owns them.

Wire those pieces with your application stack and pass the resulting state, callbacks, links, icons, and data into cinder components.

## Development

From `components/cinder`, run the source checks (from the root, `bunx turbo run lint test --filter=@lostgradient/cinder` runs the `metadata` task they read first):

```bash
bun run lint
bun run typecheck
bun run test
bun run tokens:check
```

After editing component source under `src/components/<component-id>/`, run `bun ../../internal/component-tooling/scripts/generate-component-artifacts.ts --fix` to refresh the README's generated regions and the root registries; the `metadata` task regenerates schemas, variables, examples and the manifest in `.metadata/`. Token corpus changes use `bun run tokens:generate`.

From the Corvidae root, `bunx turbo run lint typecheck test --filter=@lostgradient/cinder` checks this workspace and `bun run validate` checks the complete repository. Browser fixtures and interaction tests live in `scripts/browser-fixtures`. Cinder has no library build or publishing step.

### Component authoring checklist

Before adding a component, search the inventory and compose an existing primitive when it already provides the behavior. A new component needs its own behavior, state, or accessibility semantics; presentation differences belong in props, variants, or documented presets. Check the [machine-readable prop conventions](./scripts/component-conventions-props.ts) before naming public props, and use `Input` and `FormField` for form controls. Add a substantive test, README, stylesheet registration, generated artifacts, and the required root export. Record the design review in `*.a11y.md`; novel interaction models also need a human accessibility review covering focus, keyboard behavior, and announcements.

The machine-readable checklist lives in [`component-conventions-props.ts`](./scripts/component-conventions-props.ts). Its checks are enforced by `components:check` and the focused [prop-convention checker](./scripts/check-prop-conventions.ts); the generated README link points here so the guidance stays with the current source rules.
