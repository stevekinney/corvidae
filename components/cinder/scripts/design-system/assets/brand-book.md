Cinder is the Svelte 5 component library behind Corvidae's applications, Interborough first among them. It is built for dense, operational interfaces: lists of runs and workers, settings, approvals, logs, terminals and editors. It is quiet by default and reserves its one accent colour, an indigo, for the thing that needs action. Each component card mounts the real component from its playground examples.

## Principles

- **Pass state in.** Cinder renders state. It does not own data, transport, retries or persistence. Components take values and callbacks, and the application decides what happens. An `ApprovalCard` records nothing, and a `TerminalFrame` is not a process manager.
- **Compose the smallest surface that fits.** Reach for the component whose contract matches the job, not the one that looks closest: `ConfirmDialog` for a choice the user started, `AlertDialog` for a system acknowledgement that can't be dismissed, `InlineConfirm` to keep the confirmation in the page. The contract controls Escape, backdrop, focus and recovery.
- **Keep the next action next to the failure.** When something fails, the failed operation and what to do next stay in the same layout. Don't swap the surface for a generic error.
- **Status is never colour alone.** Every status carries a word or an icon as well. Animation and colour are supporting signals.

## Content

- Write labels, headings and section titles in sentence case ("Recent runs", not "RECENT RUNS" or "Recent Runs"). Cinder never sets section labels in uppercase with letter spacing.
- A button names exactly what it does ("Save changes", "Delete chat"). A loading button keeps its label, or changes it to the present participle ("Creating…").
- Explain an unavailable action instead of hiding it: `AccessGate` names the missing scope, and a stale region names its reason.
- Never separate pieces of copy with a middle dot (U+00B7). Use a comma for one short phrase ("Waiting on you, Chat, 4 min ago"), separate elements, a line break, or a `DescriptionList` for label and value metadata. A repository guard fails the build on a middle dot.
- No emoji in interface copy. Icons are decorative unless the label says otherwise.

## Colour

Colours are OKLCH and come in light and dark themes. Set the theme with `data-theme="light"` or `data-theme="dark"` on `html`, or on any subtree for a scoped theme island.

- **Surfaces** step up from `cinder-surface-canvas` (the page) to `cinder-surface` (panels and cards) to `cinder-surface-raised` (popovers, inputs and anything lifted). Use `cinder-surface-inset` for wells, code blocks, header bands and tracks inside a card. Hover and pressed states use `cinder-surface-hover` and `cinder-surface-pressed`, which wash toward the accent in light mode.
- **Text:** `cinder-text-default` for body copy and primary content. `cinder-text-muted` for readable secondary text that is still part of the content. `cinder-text-subtle` only for tertiary metadata and chrome, never for primary content or a control's only label. `cinder-text-disabled` for disabled controls. All except disabled meet WCAG AA on `cinder-surface`.
- **Accent:** `cinder-accent-solid` is the brand fill: deep indigo in light mode, periwinkle in dark mode. Put `cinder-accent-contrast` on it for labels. When the accent is text or an icon (links, active tabs, selected rows), use `cinder-accent-text`. It hovers to `cinder-accent-text-hover`, never the fill-derived `cinder-accent-solid-hover`.
- **Status** comes in four tones, `info`, `success`, `warning` and `danger`, plus `neutral`. Use the solid family (`cinder-status-*-solid` with `cinder-status-*-contrast`) for badges and dots. Use the soft triple (`-background`, `-text`, `-border`) for Alert, Toast, Callout and other tinted surfaces.
- **Borders** have two jobs. The structural tiers `cinder-border-muted`, `cinder-border` and `cinder-border-strong` are quiet alpha steps that separate regions. Use `cinder-border-muted` for interior dividers and `cinder-border` for a component's outer edge. The control tiers `cinder-border-control` and `cinder-border-control-hover` are the only visible edge of an input, checkbox or radio, so they clear 3:1 on every surface.
- **Controls** fill with `cinder-control-background` (the raised surface) and outline with `cinder-control-border`. Never use `cinder-surface` as an input fill.
- **Charts** use `cinder-chart-series-1` through `cinder-chart-series-8` in order. Terminal output uses the `cinder-terminal-ansi-*` palette.

## Type

- Cinder uses the system UI stack (the `sans` family, CSS `--cinder-font-sans`) and the system monospace stack (the `mono` family, `--cinder-font-mono`). There are no web fonts to load.
- The base size is 14px (`cinder-text-base`), a step below the browser default for dense application UI. Sizes use rem so browser zoom scales them.
- Type roles: a page title is `cinder-text-page-title` (20px) at semibold. A section title is `cinder-text-section-title` (16px) at semibold. Body text is `cinder-text-body` (14px). Secondary text is `cinder-text-secondary` (13px) in `cinder-text-muted`. Code is `cinder-text-code` (13px) in the mono stack.
- Label and value pairs share one hierarchy. The label is `cinder-text-base`, semibold, full-strength text with snug leading. The value is `cinder-text-sm`, normal weight, muted text with normal leading.
- Line heights: `cinder-leading-tight` (1.15) for headings, `cinder-leading-normal` (1.5) for body text, `cinder-leading-relaxed` (1.625) for long-form reading. Keep prose to `cinder-content-width-prose` (65ch).

## Space, size and shape

- Space on the rem scale (`cinder-space-0` to `cinder-space-32`, with half steps). Prefer the semantic aliases: `cinder-pad-control`, `cinder-pad-card` (16px), `cinder-pad-page` (24px), `cinder-gap-stack` (12px) and `cinder-gap-inline` (8px).
- Controls share one height scale: `cinder-control-height-xs`, `-sm`, `-md` and `-lg` are 24, 28, 32 and 40px. A Button, Input, Select and SegmentedControl of the same size line up. Use `md` for inline actions, and keep `lg` for the one page-level primary action. On a coarse pointer, rows grow to `cinder-touch-target-min` (44px).
- Corners: controls use `cinder-radius-control` (8px) and surfaces use `cinder-radius-surface` (12px). Pills and dots use `cinder-radius-full`.
- Elevation: `cinder-shadow-sm` for raised controls, `cinder-shadow-md` and `cinder-shadow-lg` for floating panels, and `cinder-shadow-overlay` for overlays. Surfaces separate by lightness first and shadow second.
- Layers: tooltip, dropdown or popover, backdrop, modal, toast, focused affordance, then drag preview, from `cinder-z-tooltip` (1000) up to `cinder-z-drag-preview` (1400).

## Focus and states

- Focus is one tight 2px ring (`cinder-ring-width`) in `cinder-ring-color`, which is the accent hue at 62% lightness in both themes, drawn directly on the control's edge (`cinder-ring-offset` is 0). Filled controls keep a 2px gap in `cinder-ring-offset-color`. Under forced colours the ring uses the system highlight colour.
- Disabled controls look the same in every variant: a neutral surface, `cinder-text-disabled` text and `cinder-opacity-disabled`. A disabled danger button does not stay red.
- Loading keeps a control at full strength, holds its width and sets `aria-busy`.

## Motion

- Durations run from `cinder-duration-fast` (120ms) through `cinder-duration-normal` (200ms) to `cinder-duration-slow` (400ms). Ease with `cinder-ease-standard`, or `cinder-ease-decelerate` for things that enter.
- Reduced motion sets durations to 0. Never let motion carry meaning on its own.

## Iconography

Cinder ships no general-purpose icon set. Icons come from Lucide (`@lucide/svelte`) and are passed in through snippet props such as `leadingIcon` and `trailingIcon`. Draw them at 14 to 16px with a stroke of 2, in `currentColor`. Icon slots render `aria-hidden`, so the meaning belongs in the label or `aria-label`. An icon-only button still needs an accessible name.

## Using it

- In a Corvidae workspace, depend on `"@lostgradient/cinder": "workspace:*"` and import everything from that entry: `import { Button } from '@lostgradient/cinder'`. Compound components keep their namespace, as in `Tabs.List`, `Tabs.Trigger` and `Tabs.Panel`.
- Retheme by overriding public `--cinder-*` tokens in the same `[data-theme]` scope that sets the theme. Never redefine internal `--_cinder-*` variables.
- Cinder provides no router, form-state manager, global toast singleton, data fetching or global state. Wire those in the application and pass the results into the components.
- `MarkdownEditor`, the rich Markdown editor from `@lostgradient/editor`, is the default for any multi-line text entry in a prototype: capture fields, notes, descriptions, comments and prompts. Don't draw a plain textarea or a look-alike editor. Reach for `Textarea` only where the text is plain by definition, such as a raw log line or a JSON value.
- A design built with this system should use these components and tokens as they are. A finding a component, default or token can absorb belongs in Cinder, not in a one-off page fix.
- This system is generated from the repository and is read-only here. To change it, change Cinder and regenerate.

## Consuming the components

`components/bundle.js` exposes every component in this system as the global `window.Cinder`, so a design canvas mounts the real components instead of drawing look-alikes in its own markup and CSS. Load `tokens.css`, then `components/bundle.css`, then `components/bundle.js`. The canvas supplies React 18; the bundle carries no React of its own.

- Mount a component by its export name: `Cinder.Button`, `Cinder.Card`, `Cinder.Modal`. Attributes are props, written in kebab case for camelCase props, and element content becomes the component's `children`.
- A component mounted inside another one's content joins it as it would in Svelte, so `Cinder.TabList` inside `Cinder.Tabs` works.
- Props update in place: a changed prop re-renders the component and keeps its state. Callbacks are the component's own props, such as `onclick`.
- A prop that takes a Svelte snippet other than `children`, such as a button's `leadingIcon`, takes no canvas content. Use the component's string props, such as `label`, `title` and `description`, instead.
- The editors from `@lostgradient/editor` (`Cinder.MarkdownEditor`, `Cinder.ReviewEditor`, `Cinder.DiffViewer`, `Cinder.DiffReview` and `Cinder.DiffReviewComments`) are in the bundle too, but their code runs only when the first one mounts, so a board without an editor never starts Milkdown or ProseMirror. An editor appears a moment after the rest of the board.
- Without React, `Cinder.mount('Button', element, { label: 'Save' })` mounts a component into a DOM element and returns `update(props)` and `destroy()`. `Cinder.componentNames` lists every name.

A canvas artboard with Cinder installed under `ds/cinder/`:

```html
<link rel="stylesheet" href="ds/cinder/tokens.css" />
<link rel="stylesheet" href="ds/cinder/components/bundle.css" />
<script src="ds/cinder/components/bundle.js"></script>

<x-import
  component-from-global-scope="Cinder.Card"
  title="Inbox"
  description="Three items to process"
>
  <x-import component-from-global-scope="Cinder.Button" variant="primary">Process inbox</x-import>
</x-import>
```

## Not synced

- **Previews.** Each card's `components/<Name>/preview.js` is its own compiled script that mounts up to four of the component's playground examples; the cards do not use the bundle.
- **Static renditions.** {{staticComponents}} bundle editors too large for a preview script, so their cards are static HTML captured from the live component. They look right but don't respond to input.
- **Parts of compound components.** {{componentsWithoutCard}} sub-components (for example `TabList`, `TableCell` and `DropdownItem`) appear in their parent's preview and have guidelines but no card of their own.
- **Types, fonts and assets.** There is no `index.d.ts`, because each component's README carries its props table. There are no font files, because Cinder uses system font stacks. There are no logo or icon assets, because Cinder has no mark and takes its icons from Lucide.
