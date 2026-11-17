# ConfirmDialog

Pre-wired modal dialog for user-initiated binary decisions: "proceed" or "cancel". Focus defaults to the cancel button — the industry-standard guard against accidental destructive confirms.

See the [dialog preset boundary](https://github.com/stevekinney/cinder/blob/main/docs/decisions/dialog-presets.md) for the preserved role, acknowledgement, and dismissal contract.

Below 640px (`sheetBelow`, which accepts any CSS length, or `false` for the centred dialog) the dialog is a bottom sheet: a grabber, a compact Cancel beside the confirmation, which fills the rest of the row (above Cancel when the two do not fit), both drawn at the button's painted height and reaching 44px through its hit area. Cancel keeps initial focus, the corner close button is not drawn, and Escape still closes it.

## Dialog model

ConfirmDialog is one of three dialog-level components:

- **`Modal`** — generic shell for rich content and forms. Use when the interaction requires more than two actions or rich body content.
- **`ConfirmDialog`** — this component. Preset for user-initiated yes/no decisions. Escape, backdrop click, and the close-X all fire `onCancel`.
- **`AlertDialog`** — preset for urgent blocking acknowledgements. Cannot be dismissed by Escape or backdrop click. No close button. The user _must_ click an action button.

The key distinction between ConfirmDialog and AlertDialog is _who initiates_ the interruption:

- ConfirmDialog is for user-initiated actions that need a safety gate ("You clicked Delete — are you sure?"). Escape is a safe exit; cancel is the default focus.
- AlertDialog is for system-initiated or out-of-band urgency ("Your session expired", "A background process failed"). Escape is blocked; acknowledgement is mandatory.

## Choosing this component

- Asking the user to confirm before deleting, discarding, or publishing something that cannot easily be undone.
- Any two-action flow where the only choices are "proceed" and "cancel" — ConfirmDialog saves you from composing Modal + two Buttons manually.
- Destructive actions: set `destructive` to apply the danger variant to the confirm button.

## Choosing something else

- When the dialog body needs rich content beyond a list and a note (a form, several sections, markup around controls) — compose [`Modal`](../modal/README.md) directly instead. A plain list or a short note goes in `options`; see [A list or a note in `options`](#a-list-or-a-note-in-options).
- When more than two actions are needed — use [`Modal`](../modal/README.md) with a custom `footer` snippet.
- When the dialog is triggered by a system event or out-of-band condition requiring mandatory acknowledgement — use [`AlertDialog`](../alert-dialog/README.md) instead.
- Non-blocking notifications — use a toast or inline alert that does not interrupt the flow.

## Related components

- [`Modal`](../modal/README.md) — the underlying primitive; use directly when you need more control over content or actions.
- [`AlertDialog`](../alert-dialog/README.md) — sticky blocking acknowledgement; cannot be dismissed by Escape or backdrop click.

## Usage

```svelte
<script lang="ts">
  import { Button } from '@lostgradient/cinder';
  import { ConfirmDialog } from '@lostgradient/cinder';

  let open = $state(false);
  let triggerRef: HTMLElement | null = $state(null);
  let lastAction = $state('');
</script>

<div style="display: flex; flex-direction: column; gap: 1rem; align-items: flex-start;">
  <Button
    label="Delete item"
    variant="danger"
    onclick={(event: MouseEvent) => {
      triggerRef = event.currentTarget as HTMLElement;
      open = true;
    }}
  />

  {#if lastAction}
    <p style="margin: 0; color: var(--cinder-text-muted); font-size: var(--cinder-text-sm);">
      Last action: <strong>{lastAction}</strong>
    </p>
  {/if}
</div>

<ConfirmDialog
  bind:open
  {triggerRef}
  title="Delete item?"
  description="This permanently removes the item. This action cannot be undone."
  destructive
  confirmLabel="Delete"
  onConfirm={() => (lastAction = 'confirmed')}
  onCancel={() => (lastAction = 'cancelled')}
/>
```

## A list or a note in `options`

Put what each choice does in `options`. A plain `<ul>` as a direct child is drawn as flat rows: no bullets, a hairline between rows, and long words wrap. Each `<li>` is one item, usually a `<strong>` name and one sentence; join them with a full stop or a colon. A `<p>` as a direct child is a note and takes the description's muted, small treatment. Do not wrap the list in a card, callout, or tinted panel: the dialog is already the surface, and the page adds no CSS for the list.

```svelte
<ConfirmDialog
  bind:open
  title="Disable the plugin?"
  description="These stop working until you enable it again."
  confirmLabel="Disable"
  onConfirm={disable}
>
  {#snippet options()}
    <ul>
      <li><strong>Agents.</strong> Two agents stop running.</li>
      <li><strong>Tools.</strong> Three tools leave the catalog.</li>
    </ul>
    <p>Nothing is deleted.</p>
  {/snippet}
</ConfirmDialog>
```

## Props

<!-- generated:props:start -->

| Prop | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `busy` | `boolean` | no | `false` | True while the confirmed work is in flight. The confirm button shows `busyLabel` and a spinner and ignores presses (it stays focusable), Cancel is inert, the typed field is read-only, and the dialog cannot be dismissed (Escape, the backdrop and the close button do nothing) until the work answers. Pair it with `closeOnConfirm={false}`, so the dialog stays open to show the answer. |
| `busyLabel` | `string` | no | — | Confirm button label while `busy`, such as "Restoring…" or "Deleting…". Defaults to `confirmLabel`, so the words stay put and only the spinner shows. |
| `cancelLabel` | `string` | no | `"Cancel"` | Label for the cancel button, which ALWAYS renders. |
| `class` | `string` | no | — | Optional extra class on the underlying <Modal>. Destructured as `class: className` per repo convention. |
| `closeOnConfirm` | `boolean` | no | `true` | Whether the dialog closes itself when the confirm button is pressed. Set `false` when the confirmed work can fail and the page needs the dialog to stay open to show it: the page then closes the dialog with `open = false` once the work succeeds. |
| `confirmLabel` | `string` | yes | — | Confirm button label. Required — no default. Name the action being confirmed: - Destructive: "Delete", "Discard changes", "Remove from organization". - Non-destructive: "Save", "Continue", "Publish". Never use "OK" or "Confirm" in production — they don't describe the action. |
| `destructive` | `boolean` | no | — | When true, the confirm button uses variant="danger". The cancel button still receives default focus regardless — color is never the sole destructive signal. |
| `error` | `string` | no | — | Why the confirmed work failed, in a danger callout between the body and the actions that is announced as it appears: "Nothing was deleted." The dialog stays open, the typed text stays, and the confirm button stays armed under its own label, so pressing it again is the retry. Clear it to hide the callout. |
| `errorTitle` | `string` | no | — | Bold lead sentence of the failure, such as "Couldn’t delete the agent.", set before `error`. Shown only with `error`. |
| `open` | `boolean` | yes | — | Controls visibility. Bindable. |
| `sheetBelow` | `string` \| `false` | no | `"640px"` | Viewport width below which the dialog is a bottom sheet: a grabber, a compact Cancel beside the confirmation, which fills the rest of the row (above Cancel when the two do not fit), both drawn at the button's painted height and reaching 44px through its hit area, with Cancel keeping initial focus. A CSS length such as `"640px"`, or `false` for the centred dialog at every width. |
| `title` | `string` | yes | — | Modal title; passed through to <Modal>. |
| `typeToConfirm` | `string` | no | — | When set, renders a labelled text input and disables the confirm button until the trimmed input matches this value case-insensitively. |
| `typeToConfirmLabel` | `string` | no | — | Visible label for the typed-confirmation input. Defaults to `Type "<value>" to confirm`. |
| `confirmIcon` | `(opaque)` | no | — | Glyph at the start of the confirm button, such as a restart, stop or trash icon. Decorative: the label names the action. Not expressible in JSON Schema; see the component types for the signature. |
| `description` | `(opaque)` | no | — | Optional body description — a short sentence or two. Rendered as a single <p> and wired to aria-describedby. A string is plain text; a snippet may add phrasing content inside the sentence, such as a key in `<code>`. Anything bigger than a sentence (a list, a code block, a checkbox) goes in `options`, below it. Screen readers announce aria-describedby targets as one continuous run, so keep the description short either way. Not expressible in JSON Schema; see the component types for the signature. |
| `onCancel` | `(opaque)` | no | — | Called when the user cancels (cancel button, Escape, or backdrop per the dialog's policy). Not expressible in JSON Schema; see the component types for the signature. |
| `onConfirm` | `(opaque)` | yes | — | Fired when the user activates the confirm button. Required. The component closes itself after, unless `closeOnConfirm` is `false`. Not expressible in JSON Schema; see the component types for the signature. |
| `onExitComplete` | `(opaque)` | no | — | Fired once the underlying modal's exit transition has completed. Not expressible in JSON Schema; see the component types for the signature. |
| `options` | `(opaque)` | no | — | Content rendered below the description and above the typed confirmation: a checkbox that changes what the confirmation does, or the exact command about to run in a code block. The description says what the dialog does; the options say what each choice does. Keep the description short, and keep controls here labelled. Not expressible in JSON Schema; see the component types for the signature. |
| `triggerRef` | `(opaque)` | no | — | Forwarded to <Modal>; focus is restored here on close. Not expressible in JSON Schema; see the component types for the signature. |

<!-- generated:props:end -->

## CSS Variables

<!-- generated:variables:start -->

This component does not declare any local CSS variables.
<!-- generated:variables:end -->

## Subcomponents

<!-- generated:subcomponents:start -->

None.

<!-- generated:subcomponents:end -->
