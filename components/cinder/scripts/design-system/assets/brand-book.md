Cinder is the Svelte 5 component library behind Corvidae's applications, Interborough first among them. Its identity is calm and content-first: the content of a page is the focal element, and everything else steps back until it is needed. Space does most of the work, text carries the hierarchy, and one accent colour, an indigo, is reserved for the thing that needs action. Density is a setting, not the identity. Lists of runs and workers, settings, approvals, logs, terminals and editors can be set closely (`density="condensed"` on a row, `cinder-control-height-sm` on a control) without becoming a console of bordered panels. Each component card mounts the real component from its playground examples.

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

## Composition

These rules are binding. Most of what makes a page read as enterprise software is composition: a sidebar, a title with buttons at the right, then a grid of bordered panels. The components are right; the arrangement is the defect. A finding that a component, default or token can carry belongs in Cinder, never in a one-off page fix. Each rule has a do and a don't.

### Surface and emphasis

- **Space before tone before border, and elevation for anything that floats.** Separate neighbours with space first. If space is not enough, step the surface tone (`cinder-surface-canvas`, `cinder-surface`, `cinder-surface-inset`). Draw a border only where a control needs its boundary or a table needs its rules. Use a shadow (`cinder-shadow-md` and up) only for what floats above the page: a popover, a menu, a modal.
  - Do: group a page into `Section` blocks, which separate by space under a heading, and hold a settings list on one `GroupedList` surface.
  - Don't: draw a bordered `Card` around every block, or put a shadow on a resting surface.
- **One focal element per screen.** A person should be able to say what the screen is for in one glance. It is a single value, a single list or a single question, set larger or earlier than everything else.
  - Do: open an overview with one `Spotlight` ("2 need you"), and let the list beneath it be the content.
  - Don't: set four equal statistic tiles and three buttons side by side, so nothing leads.
- **The emphasis order is size, then weight, then text tone, then colour.** Reach for the quietest lever that works. Make something larger or earlier first; then bolder; then step its text from `cinder-text-subtle` through `cinder-text-muted` to `cinder-text-default`; and only then use colour. Accent is last, and it means an action.
  - Do: make the page title `cinder-text-page-title` at semibold and leave the metadata in `cinder-text-muted`.
  - Don't: tint a value red and bold it and underline it to make it important.
- **At most one tinted box and at most one line of explanation per screen.** A tinted box is a `Callout`, `Alert`, `Banner` or any status-tinted surface. An explanation line is a `Section` `description` or a note under a heading.
  - Do: one neutral `Callout` with a link, and a `description` under the first heading only.
  - Don't: stack an `Alert`, a `Callout` and a paragraph under every heading, so that the page explains itself instead of showing its content.
- **No nested inset boxes.** No wells, and no bordered cards inside cards. A box inside a box doubles the edges and shrinks the content.
  - Do: use flat rows, a `Section` under a heading, an `Inspector` of quiet property rows, and editable titles that look like text until they are focused.
  - Don't: put a `cinder-surface-inset` well inside a `Card`, or a bordered field group inside a bordered panel.

### Rows, controls and actions

- **A row is a link, and its title is never underlined.** The whole row is the target: `StackedListItem` and `GroupedListItem` take an `href`, tint on hover and draw one focus ring around the row.
  - Do: give the row an `href` and let the hover tint say it is a link.
  - Don't: underline the title, or add a "View" link at the end of the row to open what the row already opens.
- **A badge or status never moves a click target.** Trailing row actions sit in a fixed column at the end of the row. A badge belongs with the metadata in the content column, so its width never changes where a button lands.
  - Do: put the status in the content column (`StackedListItem`'s status cell or `meta`) and keep `actions` for buttons alone.
  - Don't: put a `Badge` inside `trailing` beside a button, so the button sits further left on the rows that have one.
- **Controls keep a 3:1 boundary, and touch targets are 44px.** The visible edge of an input, checkbox, radio or segmented control is `cinder-control-border`, which clears 3:1 against every surface. On a coarse pointer a row or control grows to `cinder-touch-target-min` (44px).
  - Do: fill a control with `cinder-control-background` and outline it with `cinder-control-border`.
  - Don't: drop an input's border because the surface behind it is tinted, or shrink a tap target below 44px to fit another column.
- **Approve, deny, edit and Cancel are never hidden behind an overflow menu.** The decision and its way out stay visible as labelled buttons, where the failure or the question is.
  - Do: show `ApprovalCard`'s Approve, Deny and Edit buttons, and a Cancel next to any pending operation.
  - Don't: tuck Deny or Cancel into a "More" `DropdownMenu` to make the row look tidier.
- **Secondary options are icon-only buttons with tooltips, and there is one labelled primary.** A row or screen has one labelled primary action. Other options are `Button` with `iconOnly` and a `Tooltip`, each with an accessible name. The decision pair above is the exception: those stay labelled.
  - Do: one "Save changes" primary, and a pencil and a trash icon button beside it, each with a tooltip.
  - Don't: a row of four labelled secondary buttons, which all read as equal.
- **Status shows only when it is actionable.** A status says that a person has something to do or that something went wrong. Never show a status badge beside a button that says the same thing.
  - Do: show "Waiting on you" on a run that needs a decision, and nothing on a run that is fine.
  - Don't: show a "Failed" badge beside a "Retry failed run" button. Show the button, with the failure message beside it.

### Content and records

- **Record metadata is label and value, not pills.** A `Badge` or a `Chip` is for a status or a short tag. The label and value metadata of a record goes in a `DescriptionList`, or a `KeyFacts` row for a few typed facts.
  - Do: `DescriptionList` with `variant="two-column"`: Owner, Created, Price, each a muted label with its value.
  - Don't: a row of pills that reads "Ada Lovelace", "Nov 10", "$$", with nothing to say which is which.
- **An inline choice stays in the page flow.** Do not wrap a form control or an inline choice, such as a `SegmentedControl`, in a tinted `Callout` or `Alert`. Place it in the flow with a plain label.
  - Do: a heading or `FormField` label, and the `SegmentedControl` beneath it.
  - Don't: an info-tinted `Callout` that holds a `SegmentedControl`, whose tint clashes with the control and stretches it.
- **History and audit lists use the existing `Timeline`.** Events in time, with who and when, are a `Timeline` (`variant="list"` for compact rows).
  - Do: `Timeline` entries with a timestamp and a title for each change.
  - Don't: hand-draw a list of rows with dots and a line.
- **Freshness is subtle in lists.** A row shows a gray clock and a short age ("4 h"), and only when its data is stale. The full warning, in words, goes on the detail page (`Spotlight`'s `caveat`, or `StaleRegion`).
  - Do: a gray clock icon and "4 h" at the end of a stale row; nothing on a fresh one.
  - Don't: tint every row's age amber, or write "Data may be out of date" under each row.
- **No metadata subtitle on listing rows.** A listing row is a title, and at most one status or one time. The rest is on the detail page.
  - Do: "Spring menu launch" with "Waiting on you" when it needs the reader.
  - Don't: a second line of owner, neighbourhood and price under every title.
- **Assume most records have no image.** Lists are text first. A photo, when a record has one, sits at the end of the row (`GroupedListItem`'s trailing photo), and a record without one shows nothing in its place.
  - Do: a text row, with an optional photo at its end.
  - Don't: reserve a leading column of grey placeholder squares for images most rows do not have.
- **Never use a middle dot as a separator.** See Content above; the repository guard fails the build on one.
  - Do: a comma, separate elements, a line break or a `DescriptionList`.
  - Don't: "Waiting on you" then a dot, then "Chat", then a dot, then "4 min ago".
- **Prototype text entry uses `MarkdownEditor`.** Capture fields, notes, descriptions, comments and prompts use `MarkdownEditor` from `@lostgradient/editor`, in the bundle as `Cinder.MarkdownEditor`.
  - Do: `Cinder.MarkdownEditor` for a note field.
  - Don't: draw a plain textarea or a look-alike editor.

## Page archetypes

A page is one of these eight. Pick the archetype first, then compose it from the components it names. Each has one focal element, and the page is arranged to lead with it. A page that fits none is usually two pages.

- **Focus list.** A short list of the things that need a person now. Components: `Section`, `GroupedList` or `DataList` with `StackedListItem` rows, and optionally one `Spotlight`. Focal element: the first row, or the `Spotlight` value above the list.
- **Collection.** Many like records to scan, filter and open. Components: `FilterBar`, `DataList` with `StackedListItem` rows (or `DataTable` for columns), `LoadMore` or `Pagination`, and `EmptyState`. Focal element: the list. The page has one labelled primary action, such as "New".
- **Detail with inspector.** One record, read and edited in place. Components: `PageHeader`, `Section`, `Inspector` with `InspectorRow` properties (a quiet right rail at desktop width), `DescriptionList` for read-only metadata, and `Timeline` for its history. Focal element: the record's title and its content, with the inspector kept quiet.
- **Conversation.** A turn-by-turn exchange with a person or an agent. Components: `Message`, `ToolCallPanel`, `ApprovalCard` for a pending decision, and `MarkdownEditor` as the composer. Focal element: the latest message, then the composer.
- **Flow.** One task in steps: set up, create, check out. Components: `Steps`, `FormSection`, `FormField` with its control, and `FormActions` (or `DockedActionBar` on a phone). Focal element: the current step's one question.
- **Queue.** Items that each need a decision, worked from the top. Components: `SegmentedControl` for the filter with counts, `DataList` with status-first `StackedListItem` rows, and `ApprovalCard` for the decision. Focal element: the item at the head of the queue and its decision buttons.
- **Overview.** The state of a whole system at a glance, and the only archetype with stat tiles or cards. Components: `Spotlight`, `StatisticGroup` of `Statistic` tiles, `Card`, `Sparkbar`, `Meter` and the charts. Focal element: the `Spotlight`; the tiles and cards stay secondary to it.
- **Browse.** Discovering records by searching, filtering and reading. Components: `SearchField`, `SegmentedControl`, `GroupedList` rows with an optional photo at the end, `KeyFacts`, `WeekSchedule` for a recurring time, and `Image` for a hero. Focal element: the record being read, or the results while searching. It is rows, not a grid of cards.

## Colour

Colours are OKLCH and come in light and dark themes. Set the theme with `data-theme="light"` or `data-theme="dark"` on `html`, or on any subtree for a scoped theme island.

- **Surfaces:** `cinder-surface-canvas` is the page, `cinder-surface` is a grouped surface that holds rows, when a group needs one, and `cinder-surface-raised` is anything lifted (popovers, inputs and a selected row). In light mode the default is an app-shell ladder: a near-white canvas with the grouped surface a soft grey step below it, so a group separates from the page by fill rather than by a hairline, and raised stays pure white. The comfortable density switches the light arm to a consumer ladder (a grey canvas under white surfaces). Dark mode is a neutral ladder that builds up from the canvas through the surface and the inset to raised. Use `cinder-surface-inset` for code blocks, header bands and tracks, not for a well that holds other boxes (see Composition). Hover and pressed states use `cinder-surface-hover` and `cinder-surface-pressed`, which wash toward the accent in light mode.
- **Text:** `cinder-text-default` for body copy and primary content. `cinder-text-muted` for readable secondary text that is still part of the content. `cinder-text-subtle` only for tertiary metadata and chrome, never for primary content or a control's only label. `cinder-text-disabled` for disabled controls. All except disabled meet WCAG AA on `cinder-surface`.
- **Accent:** indigo is the only accent, and it is reserved for primary actions, links and focus. `cinder-accent-solid` is the brand fill: deep indigo in light mode, periwinkle in dark mode. Put `cinder-accent-contrast` on it for labels. When the accent is text or an icon (a link, the active tab), use `cinder-accent-text`. It hovers to `cinder-accent-text-hover`, never the fill-derived `cinder-accent-solid-hover`. Everything that is not an action is neutral: a `Spotlight` value, an eyebrow above a title, an info dot, and the fill of a `Meter` or `Sparkbar` are `cinder-text-default`, `cinder-text-muted` or a neutral tone, never indigo.
- **Status** comes in four tones, `info`, `success`, `warning` and `danger`, plus `neutral`. Use the solid family (`cinder-status-*-solid` with `cinder-status-*-contrast`) for badges and dots. Use the soft triple (`-background`, `-text`, `-border`) for Alert, Toast, Callout and other tinted surfaces.
- **Borders** have two jobs. The structural tiers `cinder-border-muted`, `cinder-border` and `cinder-border-strong` are quiet alpha steps that separate regions. Use `cinder-border-muted` for interior dividers and `cinder-border` for a component's outer edge. The control tiers `cinder-border-control` and `cinder-border-control-hover` are the only visible edge of an input, checkbox or radio, so they clear 3:1 on every surface.
- **Controls** fill with `cinder-control-background` (the raised surface) and outline with `cinder-control-border`. Never use `cinder-surface` as an input fill.
- **Charts** use `cinder-chart-series-1` through `cinder-chart-series-8` in order. Terminal output uses the `cinder-terminal-ansi-*` palette.

## Type

- Cinder uses the system UI stack (the `sans` family, CSS `--cinder-font-sans`) and the system monospace stack (the `mono` family, `--cinder-font-mono`). There are no web fonts to load.
- The base size is 14px (`cinder-text-base`), a step below the browser default, which keeps long lists of rows readable without crowding them. Sizes use rem so browser zoom scales them.
- Type roles: a page title is `cinder-text-page-title` (20px) at semibold. A section title is `cinder-text-section-title` (16px) at semibold. Body text is `cinder-text-body` (14px). Secondary text is `cinder-text-secondary` (13px) in `cinder-text-muted`. Code is `cinder-text-code` (13px) in the mono stack.
- Label and value pairs share one hierarchy. The label is `cinder-text-base`, semibold, full-strength text with snug leading. The value is `cinder-text-sm`, normal weight, muted text with normal leading.
- Line heights: `cinder-leading-tight` (1.15) for headings, `cinder-leading-normal` (1.5) for body text, `cinder-leading-relaxed` (1.625) for long-form reading. Keep prose to `cinder-content-width-prose` (65ch).

## Space, size and shape

- Space on the rem scale (`cinder-space-0` to `cinder-space-32`, with half steps). Prefer the semantic aliases: `cinder-pad-control`, `cinder-pad-card` (16px), `cinder-pad-page` (24px), `cinder-gap-stack` (12px) and `cinder-gap-inline` (8px).
- Controls share one height scale: `cinder-control-height-xs`, `-sm`, `-md` and `-lg` are 24, 28, 32 and 40px. A Button, Input, Select and SegmentedControl of the same size line up. Use `md` for inline actions, and keep `lg` for the one page-level primary action. On a coarse pointer, rows grow to `cinder-touch-target-min` (44px).
- Corners: controls use `cinder-radius-control` (8px) and surfaces use `cinder-radius-surface` (12px). Pills and dots use `cinder-radius-full`.
- Elevation: `cinder-shadow-sm` for raised controls, `cinder-shadow-md` and `cinder-shadow-lg` for floating panels, and `cinder-shadow-overlay` for overlays. Surfaces separate by lightness first and shadow second.
- Layers: tooltip, dropdown or popover, backdrop, modal, toast, focused affordance, then drag preview, from `cinder-z-tooltip` (1000) up to `cinder-z-drag-preview` (1400).

## Density

Density is one axis with three steps. A page declares it once, with `data-density` on an ancestor such as the page outlet, and every component inside reads the result through the same tokens. Nothing branches on the attribute.

- **Compact** (`data-density="compact"`) is for a page that is a table of operator rows: run lists, queues, logs. Rows drop from 56px to 40px and row and card padding take the next step down.
- **Default** (no attribute) is for dense application screens: Interborough's settings, detail pages and lists. Use it unless the page is clearly one of the other two.
- **Comfortable** (`data-density="comfortable"`) is for a consumer product page that people read rather than scan. Body text is 15px (16px on a touch screen), secondary text 14px, section titles 18px and page titles 28px. Controls are 32, 40 and 48px tall, surfaces round to 16px and controls to 10px, cards pad 20px and stacks gap 16px. In light mode it also uses the consumer surface ladder: a grey canvas under white cards. Dark mode looks the same in every density.

Don't mix densities on one page, and don't use comfortable to make an operator table feel friendlier: it costs rows on screen.

## Focus and states

- Focus is one tight 2px ring (`cinder-ring-width`) in `cinder-ring-color`, which is the accent hue at 62% lightness in both themes, drawn directly on the control's edge (`cinder-ring-offset` is 0). Filled controls keep a 2px gap in `cinder-ring-offset-color`. Under forced colours the ring uses the system highlight colour.
- Disabled controls look the same in every variant: a neutral surface, `cinder-text-disabled` text and `cinder-opacity-disabled`. A disabled danger button does not stay red.
- Loading keeps a control at full strength, holds its width and sets `aria-busy`.

## Motion

- Durations run from `cinder-duration-fast` (120ms) through `cinder-duration-normal` (200ms) to `cinder-duration-slow` (400ms). Ease with `cinder-ease-standard`, or `cinder-ease-decelerate` for things that enter.
- Reduced motion sets durations to 0. Never let motion carry meaning on its own.

## Icons and imagery

- **Icons are a curated vocabulary of Lucide glyphs** (`@lucide/svelte`), one glyph per meaning, used the same way on every page. Cinder's entry exports the ones its own components draw, and the curated vocabulary for pages is being filed separately; until it lands, choose from these. Actions: `Plus`, `Pencil`, `Trash2`, `Copy`, `Check`, `X`, `Search`, `RefreshCw`, `RotateCcw`, `SendHorizontal`, and `MoreHorizontal` for an overflow menu of secondary options only. Direction: `ChevronDown`, `ChevronLeft`, `ChevronRight`, `ChevronUp` and `ArrowUp`. Status: `Info`, `CircleAlert` and `TriangleAlert`. Things: `FileText`, `FileCode`, `Globe`, `Terminal`, `MessageSquare`, `MessageCircle` and `Paperclip`. Import them from `@lostgradient/cinder`, as in `import { Pencil } from '@lostgradient/cinder'`.
- Icons are passed in through snippet props such as `leadingIcon` and `trailingIcon`. Draw them at 14 to 16px with a stroke of 2, in `currentColor`, in a neutral text colour. Icon slots render `aria-hidden`, so the meaning belongs in the label or `aria-label`. An icon-only button still needs an accessible name and, for a secondary option, a `Tooltip`.
- **Use one glyph per meaning.** Do not draw two icons for the same thing on different pages, and do not use an icon only to fill space beside a label that already says it.
- **Media falls back to a monogram, and a monogram is never decoration.** `Avatar` shows a person's or an entity's image, and falls back to their initials when there is none or it fails to load. A monogram identifies someone or something; do not put one on a row, a card or a heading as ornament.
- **No placeholders for missing images.** A record without an image shows no image. An `Image` that fails to load shows its fallback, and a list never reserves an empty leading column for pictures.
- Cinder has no logo mark, so a design supplies its own in the application and does not draw one in Cinder's name.

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

## Writing HTML: the class-level recipe

A canvas that is plain HTML, or that needs a component's Svelte snippet props, links `components/bundle.css` and copies its markup from `recipe.md`, never hand-building component classes. `bundle.css` carries Cinder's real component styles, so the recipe's markup renders as the component does, and a fix to a Cinder component reaches the canvas the next time the design system is republished.

- Link `tokens.css`, then `components/bundle.css`. Do not copy Cinder's CSS into the canvas, and do not write look-alike classes such as `.btn`, `.pill` or `.row` and style them by hand. Hand-built copies drift: two prototypes that each rebuilt the components differed by more than a hundred rule lines.
- `recipe.md` gives the markup for Button, Chip, SegmentedControl, Input, Select, Section, Card, GroupedList rows, Badge, StatusDot, Callout, Banner, navigation and Drawer. A variant or a size is a `data-cinder-*` attribute, not an extra class. A Select keeps its `cinder-select-field__chevron` span, which is the only caret it shows.
- Mount `Cinder.<Name>` when the canvas runs React, and use the recipe's markup when it does not. Do not draw one component both ways on a board.
- Each page archetype but Conversation has a full-page preview card, built from the same markup, in the "Page archetypes" group: Focus list, Collection, Detail, Flow, Queue, Overview and Browse, plus Map, Record and Form. Detail's card sets the record's metadata in a quiet aside, and Flow's shows its steps over a Form. Copy a card's page when the canvas is a page of that kind. Conversation has none, because its composer is `MarkdownEditor`, which only the mounted bundle can show. Each renders in light and dark, at a phone width and at a desktop width, and its layout follows the width the page is given.

## Not synced

- **Archetype previews.** The cards in the "Page archetypes" group are static HTML written from the recipe's markup, not live components, so they look right but do not respond to input. Cinder has no map surface, so the Map and Browse previews stand a quiet grid in for the host's map tiles.
- **Previews.** Each card's `components/<Name>/preview.js` is its own compiled script that mounts up to four of the component's playground examples; the cards do not use the bundle.
- **Static renditions.** {{staticComponents}} bundle editors too large for a preview script, so their cards are static HTML captured from the live component. They look right but don't respond to input.
- **Parts of compound components.** {{componentsWithoutCard}} sub-components (for example `TabList`, `TableCell` and `DropdownItem`) appear in their parent's preview and have guidelines but no card of their own.
- **Types, fonts and assets.** There is no `index.d.ts`, because each component's README carries its props table. There are no font files, because Cinder uses system font stacks. There are no logo or icon files, because Cinder has no mark and takes its icons from Lucide (see Icons and imagery).
