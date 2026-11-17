# Cinder interface patterns

Cinder gives an application the pieces to render a useful interface; it does not decide who owns the data, transport, or recovery policy. That boundary is the thread running through the completed component work: pass state in, compose the smallest surface that fits, and keep the next action visible when something fails.

This guide collects the patterns that are easy to miss when you read one component at a time. The generated README beside each component remains the source of truth for its complete prop table, CSS variables, and examples.

## Composing a page

Cinder's identity is calm and content-first. The content of a page is its focal element, space separates before tone or a border does, and one accent colour is kept for the thing that needs action. A page that starts from a sidebar, a title with buttons at the right and a grid of bordered panels has already lost that, however good its components are. Pick the page's archetype first, then compose it from the components it names.

The binding rules (one focal element, the emphasis order, at most one tinted box and one line of explanation, no nested inset boxes, a row that is a link, actions that a badge never moves) are in the [brand book's Composition section](../scripts/design-system/assets/brand-book.md#composition), each with a do and a don't. The README's [Composition](../README.md#composition) section states the two rules that most often go wrong: record metadata is label and value rather than pills, and an inline choice stays out of a tinted callout.

There are eight archetypes. Each names its components and its focal element; the [brand book](../scripts/design-system/assets/brand-book.md#page-archetypes) carries the same list for design canvases.

| Archetype | Components | Focal element |
| --- | --- | --- |
| Focus list: the few things that need a person now | [`Section`](../src/components/section/README.md), [`GroupedList`](../src/components/grouped-list/README.md) or [`DataList`](../src/components/data-list/README.md) with [`StackedListItem`](../src/components/stacked-list-item/README.md), optionally one [`Spotlight`](../src/components/spotlight/README.md) | The first row, or the `Spotlight` value above the list |
| Collection: many like records to scan, filter and open | [`FilterBar`](../src/components/filter-bar/README.md), `DataList` with `StackedListItem` (or [`DataTable`](../src/components/data-table/README.md)), [`LoadMore`](../src/components/load-more/README.md) or [`Pagination`](../src/components/pagination/README.md), [`EmptyState`](../src/components/empty-state/README.md) | The list, with one labelled primary action |
| Detail with inspector: one record, read and edited in place | [`PageHeader`](../src/components/page-header/README.md), `Section`, [`Inspector`](../src/components/inspector/README.md), [`DescriptionList`](../src/components/description-list/README.md), [`Timeline`](../src/components/timeline/README.md) | The record's title and content, with the inspector kept quiet |
| Conversation: a turn-by-turn exchange | [`Message`](../src/components/message/README.md), [`ToolCallPanel`](../src/components/tool-call-panel/README.md), [`ApprovalCard`](../src/components/approval-card/README.md), [`MarkdownEditor`](../../editor/src/lib/components/markdown-editor/README.md) as the composer | The latest message, then the composer |
| Flow: one task in steps | [`Steps`](../src/components/steps/README.md), [`FormSection`](../src/components/form-section/README.md), [`FormField`](../src/components/form-field/README.md), [`FormActions`](../src/components/form-actions/README.md) or [`DockedActionBar`](../src/components/docked-action-bar/README.md) | The current step's one question |
| Queue: items that each need a decision | [`SegmentedControl`](../src/components/segmented-control/README.md) for the filter, `DataList` with status-first `StackedListItem` rows, `ApprovalCard` | The item at the head of the queue and its decision buttons |
| Overview: a whole system at a glance | `Spotlight`, [`StatisticGroup`](../src/components/statistic-group/README.md) of [`Statistic`](../src/components/statistic/README.md) tiles, [`Card`](../src/components/card/README.md), [`Sparkbar`](../src/components/sparkbar/README.md), [`Meter`](../src/components/meter/README.md) | The `Spotlight`; it is the only archetype with stat tiles or cards |
| Browse: finding and reading records | [`SearchField`](../src/components/search-field/README.md), `SegmentedControl`, `GroupedList` rows with an optional photo at the end, [`KeyFacts`](../src/components/key-facts/README.md), [`WeekSchedule`](../src/components/week-schedule/README.md), [`Image`](../src/components/image/README.md) | The record being read, or the results while searching; rows, not a grid of cards |

Two choices recur across them. History and audit lists are a `Timeline`, not a hand-drawn list. Prototype text entry is a `MarkdownEditor`, not a textarea.

## Operational surfaces

Use [`ApprovalCard`](../src/components/approval-card/README.md) for a pending operation that needs a human decision. It is controlled and deliberately has no execution authority: the host records the resolution and performs the operation.

```svelte
<script lang="ts">
  import { ApprovalCard } from '@lostgradient/cinder';

  let state = $state<
    'pending' | 'approved' | 'approved_with_edits' | 'denied' | 'expired' | 'cancelled'
  >('pending');
</script>

<ApprovalCard
  tool={{ name: 'deploy-cloud', risk: 'high' }}
  operation={{ kind: 'command', command: 'bun run deploy' }}
  policyVersion="policy-2026-09"
  idempotencyKey="approval-01"
  {state}
  onResolve={({ decision }) => {
    if (decision === 'approve') state = 'approved';
    if (decision === 'deny') state = 'denied';
    if (decision === 'cancel') state = 'cancelled';
  }}
/>
```

Pass environment variable names through `env`; values are intentionally discarded. A pending card exposes actions only when `onResolve` exists. An expired request becomes read-only from `expiresAt`, so a host should persist the terminal state it receives and remove the card only after the decision is recorded.

For structured tool arguments, compose [`PayloadInspector`](../src/components/payload-inspector/README.md) rather than inventing another JSON tree. It accepts JSON values or serialized strings, defaults to a one-level opening depth and a 1 MB byte cap, and turns parse failures, circular values, and oversized payloads into visible states. Redact secrets before passing `value`; the component renders what it receives.

## Bounded output and previews

[`TerminalOutput`](../src/components/terminal-output/README.md) is for read-only [ANSI escape-code](https://en.wikipedia.org/wiki/ANSI_escape_code) output. It follows the newest line by default and pauses following when the reader scrolls away. [`TerminalFrame`](../src/components/terminal-frame/README.md) is the surrounding chrome for an interactive terminal whose renderer and transport belong to the application.

```svelte
<script lang="ts">
  import { TerminalFrame, TerminalOutput } from '@lostgradient/cinder';

  let output = $state('\u001b[32mready\u001b[0m\\n');
</script>

<TerminalFrame title="Build shell" status="connected">
  <TerminalOutput aria-label="Build output" value={output} />
</TerminalFrame>
```

Do not treat a terminal frame as a process manager. If the connection drops, update `status` and provide the reconnect action in the frame's slots; the frame owns the visual state while the application owns retry, cancellation, and transport cleanup.

[`PreviewPanel`](../src/components/preview-panel/README.md) is the matching layout shell for artifacts and generated content. Its `error` status uses `role="alert"`; ordinary `ready` and `loading` states stay layout-only. Pair it with [`ZoomPanViewer`](../src/components/zoom-pan-viewer/README.md) when the preview is larger than its viewport, and keep the child renderer responsible for the actual image, SVG, or diagram.

## Forms, policy, and confirmation

[`SettingRow`](../src/components/setting-row/README.md) publishes the form-field context that its composed control consumes. This keeps labels, descriptions, warnings, errors, and managed-policy text aligned across settings screens.

```svelte
<script lang="ts">
  import { Input, SettingRow } from '@lostgradient/cinder';
</script>

<SettingRow
  id="display-name"
  label="Display name"
  description="Shown to collaborators."
  warning="Changing this updates existing invitations."
>
  {#snippet control()}
    <Input id="display-name" value="Ada Lovelace" />
  {/snippet}
</SettingRow>
```

Use the [`FormField`](../src/components/form-field/README.md) warning tier for an advisory condition that does not block submission. Use [`ConfirmDialog`](../src/components/confirm-dialog/README.md) for a user-initiated binary choice, [`AlertDialog`](../src/components/alert-dialog/README.md) for a system-originated acknowledgement that cannot be dismissed, and [`InlineConfirm`](../src/components/inline-confirm/README.md) when the confirmation should remain in document flow. The distinction controls Escape, backdrop, focus, and recovery behavior; choosing by appearance alone loses that contract.

[`AccessGate`](../src/components/access-gate/README.md) keeps an unavailable capability understandable. Keep the denied state visible when the surrounding workflow benefits from discoverability, provide a concrete `requirement`, and let the host decide whether a retry or permission request changes the content.

## Overlay lifecycle

Two shared exit-transition lifecycles govern how an overlay leaves the DOM, and which one a component follows is not visible from its props alone. `Modal` and `Drawer` use `SlidingDialogState`. `Popover`, `SelectionPopover`, `Tooltip`, `HoverCard`, and `NavigationBar`'s mobile panel use `AnchoredOverlayExitState`: each renders `data-cinder-closing` and awaits its real CSS exit transition before unmounting, instead of disappearing the instant `open` flips to `false`. `Popover` and `SelectionPopover` expose `onExitComplete` for code that needs to know when the transition actually finishes, not just when `open` changed.

`DropdownMenu`, `ContextMenu`, `CommandMenu`, and `MultiSelect` are the documented exception: they destroy on close with no exit motion, because their panels have no enter transition to mirror in the first place. Don't assume every anchored overlay behaves the same way — check `src/_internal/OVERLAY-POLICY.md`'s census table for the authoritative, per-component list before writing a test or integration that asserts synchronous unmount on close.

## Editing and review

[`JsonSchemaEditor`](../src/components/json-schema-editor/README.md) supports both local and controlled ownership for [JSON Schema](https://json-schema.org/). Use `defaultSchema` for a form that owns edits; use `schema` with `onValueChangeRequest` when the parent or server is authoritative. The editor's form, JSON, diff, undo, and validation views share one state model, so a rejected controlled update should return the authoritative schema rather than mutating a second copy.

```svelte
<script lang="ts">
  import { JsonSchemaEditor } from '@lostgradient/cinder';

  let schema = $state({ type: 'object', properties: {} });
</script>

<JsonSchemaEditor
  id="request-schema"
  {schema}
  view="form"
  onValueChangeRequest={({ schema: next }) => (schema = next)}
/>
```

Rows expose their action through accessible names that include the property or enum value. Keep the editor's `id`, leave validation messages attached to the row that owns them, and do not replace the form table with a visually similar list: keyboard movement, required-state editing, nested schemas, enum ordering, and diff tracking are part of the interaction model.

For Markdown, use [`ReviewEditor`](../../editor/src/lib/components/review-editor/README.md) when comments must survive edits and [`DiffViewer`](../../editor/src/lib/components/diff-viewer/README.md) when the user is comparing two documents. Restore review state through `toRuntimeThreads` or `setState`; anchors are [ProseMirror](https://prosemirror.net/) positions, not string offsets, and an unmatched quote is intentionally retained as an orphan. `DiffViewer`'s custom `toolbar` replaces the built-in toolbar completely, while `toolbarActions` only works with the built-in toolbar.

## Tokens, themes, and motion

The generated [`token reference`](./tokens.md) documents the public `--cinder-*` surface. Cinder generates its CSS and registry artifacts from the validated token corpus; consumers should override public tokens in the same `[data-theme]` scope that establishes the theme and should never redefine internal `--_cinder-*` variables.

```css
[data-theme='dark'] {
  color-scheme: dark;
  --cinder-accent-solid: oklch(70% 0.16 250);
}
```

The token system carries explicit light, dark, reduced-motion, and ANSI contexts. Components use the reduced-motion context automatically. If an interaction has a meaningful state beyond motion, keep that state in text, structure, or an icon as well—animation and color are supporting signals, not the only announcement.

## Failure and recovery checklist

When a surface reports a failure, keep the failed operation and its next action in the same layout. `ApprovalCard` becomes a terminal summary, `PayloadInspector` keeps the parse or size message, `PreviewPanel` announces an error status, and `TerminalOutput` preserves the output already received. The application should own retries and persistence, then pass the new state back into the component.

For accessibility, give every interactive surface a stable `id` and visible or programmatic name, retain focus when a state changes, and test keyboard interaction against the component's `.a11y.md` record. Those records sit beside the README and describe the component-specific semantics; the README explains composition and API ownership.
