# @corvidae/cinder

Private [Svelte](https://svelte.dev/) components for Corvidae: accessible primitives, design tokens, component styles, generated prop schemas, and examples for people and local tooling.

## Workspace usage

Declare `"@corvidae/cinder": "workspace:*"` in the consuming workspace's dependencies, then run `bun install --frozen-lockfile` from the Corvidae root. Svelte and other external dependency versions come from the root Bun catalog.

The package exports its TypeScript source through `@corvidae/cinder`. Your application compiles the Svelte components and includes their styles. The root entry imports the base stylesheet, which establishes the cascade-layer order, tokens, foundation rules, and shared component styles.

The [interface patterns guide](./documentation/interface-guide.md) collects the ownership, composition, accessibility, and failure-state rules that span multiple components. Use the leaf README beside a component for its generated API table.

```svelte
<script lang="ts">
  import { Button } from '@corvidae/cinder';
</script>

<Button id="save-project" variant="primary" label="Save changes" />
```

Import components, utilities, types, and metadata from this one entry point. Compound components retain their namespace API, such as `Tabs.List`, `Tabs.Trigger`, and `Tabs.Panel`. The application bundler handles the source graph and CSS side effects.

[Chat](../chat/README.md), [Editor](../editor/README.md), and [Markdown](../../packages/markdown/README.md) own their respective product APIs in separate private workspaces. Syntax highlighting dependencies used by Cinder's `CodeBlock` are declared directly by Cinder.

## Component metadata

The root exports the component manifest and named metadata values:

```ts
import {
  manifest,
  buttonSchema,
  buttonVariables,
  buttonConstraints,
  buttonExamples,
} from '@corvidae/cinder';
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

The CLI reads the manifest and source artifacts from this workspace. Its filesystem-backed knowledge service stays internal to developer tooling. Applications import `manifest` and named metadata from `@corvidae/cinder`; the library root supports browser and server rendering.

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

Public tokens use the `--cinder-` prefix. Internal implementation variables use `--_cinder-`; do not redefine those.

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

From the Corvidae root, `bunx turbo run lint typecheck test --filter=@corvidae/cinder` checks this workspace and `bun run validate` checks the complete repository. Browser fixtures and interaction tests live in `scripts/browser-fixtures`. Cinder has no library build or publishing step.

### Component authoring checklist

Before adding a component, search the inventory and compose an existing primitive when it already provides the behavior. A new component needs its own behavior, state, or accessibility semantics; presentation differences belong in props, variants, or documented presets. Check the [machine-readable prop conventions](./scripts/component-conventions-props.ts) before naming public props, and use `Input` and `FormField` for form controls. Add a substantive test, README, stylesheet registration, generated artifacts, and the required root export. Record the design review in `*.a11y.md`; novel interaction models also need a human accessibility review covering focus, keyboard behavior, and announcements.

The machine-readable checklist lives in [`component-conventions-props.ts`](./scripts/component-conventions-props.ts). Its checks are enforced by `components:check` and the focused [prop-convention checker](./scripts/check-prop-conventions.ts); the generated README link points here so the guidance stays with the current source rules.
