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

## Local component discovery

From `components/cinder`, run the retained knowledge CLI with Bun:

```bash
bun run knowledge list --json
bun run knowledge search modal --json
bun run knowledge show button --json
bun run knowledge best-practices styles --json
```

The CLI reads the manifest and source artifacts from this workspace. Its filesystem-backed knowledge service stays internal to developer tooling. Applications import `manifest` and named metadata from `@lostgradient/cinder`; the library root supports browser and server rendering.

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

To author a complete theme, use the theme builder: the `/theme-builder` route of the playground application (`bun run --filter=@lostgradient/playground dev`). It edits every public token, reports scoped accessibility findings, and exports a Cinder Theme v1 source file, deployment CSS, and portable DTCG. See [Theming](./documentation/theming.md#the-theme-builder) for the export formats, a worked example, and what the accessibility checks do and do not cover, and [Design tokens](./documentation/tokens.md#editing-the-full-registry-in-the-theme-builder) for how the registry is exposed for editing.

Public tokens use the `--cinder-` prefix. Internal implementation variables use `--_cinder-`; do not redefine those.

## A2UI catalog (experimental)

> [!WARNING] Experimental, pinned to A2UI v0.9.1 The catalog follows A2UI v0.9.1 and may change until a stable A2UI 1.0 compatibility review. It is opt-in: no surface uses it unless a client asks for it.

`a2ui-catalog.json` at the package root is Cinder's A2UI catalog (COR-1310): the Cinder components an agent may place on an A2UI surface, projected from their generated `*.schema.json` files and `components.json`. It is a file in the package, not an export of `@lostgradient/cinder`; a server that offers it copies it (Bureau keeps a byte-identical copy, which the root `scripts/a2ui-catalog-copies.test.ts` enforces).

- **Identity.** Its `catalogId` and `$id` are the same URI, `https://cinder.website/a2ui/v0_9_1/catalogs/cinder/v1/catalog.json`: `v0_9_1` is the pinned A2UI version and `v1` is Cinder's catalog revision. A client lists that URI in `supportedCatalogIds`; Bureau offers the catalog only to a client that does (see [Bureau's adapter](../../packages/bureau/documentation/interactive-surface.md#the-adapter-experimental)), and offers the A2UI basic catalog otherwise.
- **Contents.** An explicit allowlist (`scripts/a2ui-catalog-allowlist.json`) of eight components: `Checkbox`, `CopyButton`, `Meter`, `NumberInput`, `Progress`, `Rating`, `Spinner`, and `Toggle`. It defines no functions, and its `anyComponent` is those eight alone, so it does not include the basic catalog's layout or text components.
- **What a property keeps.** Model-generated UI gets no ambient authority. Styling hooks (`class`, `style`), DOM identity and form association (`id`, `form`, `name`), anything that fetches or navigates (`href`, `src`), raw markup (`html`), event handlers, ARIA references to other elements, and `data-*` attributes never reach the catalog. Each entry carries an accessible name as its `label`, taken from the component's `label`, `ariaLabel`, `alt`, or `title`; the generator fails when a listed component has none.
- **Regenerating.** `bun run a2ui-catalog:generate` rewrites the file; `bun run a2ui-catalog:check` fails on drift. The generator validates the result against the vendored A2UI v0.9.1 schemas (`scripts/a2ui/PROVENANCE.json` names the upstream commit) and writes nothing if a listed component has no schema or no accessible name.
- **Rendering.** `A2uiSurface` in `@lostgradient/chat` renders the basic catalog only, so it does not render this catalog's components; they report as `unsupported-component`. A renderer that lists this catalog has to implement those components itself.

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
