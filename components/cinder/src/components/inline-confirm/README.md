# InlineConfirm

`InlineConfirm` keeps a confirmation in document flow for reversible actions. It uses a labelled `role="group"`, focuses Cancel on open, and restores focus to the trigger when dismissed.

Use `presentation="two-press"` for an irreversible action. It renders one named primary action, arms on the first press, resets after three seconds or Escape, and never renders a competing Cancel action.

## Usage

```svelte
<script lang="ts">
  import { Button } from '@lostgradient/cinder';
  import { InlineConfirm } from '@lostgradient/cinder';

  let open = $state(false);

  function removeWorkspace() {
    open = false;
  }
</script>

<Button variant="danger" onclick={() => (open = true)}>Remove workspace</Button>
<InlineConfirm
  prompt="Remove this workspace?"
  confirmLabel="Remove workspace"
  bind:open
  destructive
  onConfirm={removeWorkspace}
/>
```

## Props

<!-- generated:props:start -->

| Prop | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `ariaDescribedBy` | `string` | no | — | Id referenced by the action button's aria-describedby. |
| `ariaDisabled` | `boolean` | no | — | Explicit aria-disabled value for a blocked action. |
| `armed` | `boolean` | no | — | Bindable armed state for two-press presentation. |
| `armedEscapeHint` | `string` | no | — | Optional keyboard instruction shown beside the armed status on fine pointers. |
| `armedHint` | `string` | no | — | Status text shown while the two-press action is armed. |
| `armedLabel` | `string` | no | — | Full accessible label shown after the first press. |
| `blocked` | `boolean` | no | — | Blocks interaction while keeping the action focusable for an explanatory reason. |
| `cancelLabel` | `string` | no | `"Cancel"` | Label for the cancelling action. Defaults to `'Cancel'`. |
| `class` | `string` | no | — | Additional class merged with the component's root class. |
| `confirmLabel` | `string` | yes | — | Label for the confirming action. |
| `destructive` | `boolean` | no | `false` | Marks the confirming action as destructive. Defaults to `false`. |
| `disabled` | `boolean` | no | — | Disables and disarms two-press presentation. |
| `flush` | `boolean` | no | `false` | The strip sits flush inside a bordered container. At the container's start or end it drops its own rule there instead of doubling the container's edge. Defaults to `false`. |
| `hintClass` | `string` | no | — | Additional class merged with the two-press status hint. |
| `hintId` | `string` | no | — | Id assigned to the two-press status hint. |
| `loading` | `boolean` | no | — | Shows a loading state on the action button. |
| `loadingLabel` | `string` | no | — | Accessible loading label for the action button. |
| `mutating` | `boolean` | no | — | Marks the two-press action as one that changes something, so a stale `StaleRegion` makes it inert. |
| `open` | `boolean` | no | `false` | Whether the confirmation is open. Bindable, and component-owned on close: confirming, clicking Cancel, and pressing Escape all set this to `false` before calling `onConfirm`/`onCancel`, so a bound parent observes the confirmation as already closed by the time either callback runs—neither callback can veto or delay that close. Defaults to `false`. |
| `presentation` | `"strip"` \| `"two-press"` | no | — | The in-flow strip (default) or a single guarded action button. |
| `prompt` | `string` | no | — |  |
| `requestKey` | `string` | no | — | Request identity; changing it disarms two-press presentation. |
| `requiresSecondPress` | `boolean` | no | — | Requires a second press; defaults to `true` in two-press presentation. |
| `children` | `(opaque)` | no | — | Additional content rendered below the prompt, above the confirm/cancel actions, while the confirmation is open. Not expressible in JSON Schema; see the component types for the signature. |
| `onCancel` | `(opaque)` | no | — | Called when the user cancels the action (via the Cancel action or Escape), after `open` is already set to `false`. Not expressible in JSON Schema; see the component types for the signature. |
| `onConfirm` | `(opaque)` | no | — | Called when the user confirms the action, after `open` is already set to `false`. Not expressible in JSON Schema; see the component types for the signature. |

<!-- generated:props:end -->

## CSS Variables

<!-- generated:variables:start -->

This component does not declare any local CSS variables.
<!-- generated:variables:end -->
