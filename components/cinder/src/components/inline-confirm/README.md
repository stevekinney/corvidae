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
| `cancelLabel` | `string` | no | `"Cancel"` | Label for the cancelling action. Defaults to `'Cancel'`. |
| `class` | `string` | no | — | Additional class merged with the component's root class. |
| `confirmLabel` | `string` | yes | — | Label for the confirming action. |
| `destructive` | `boolean` | no | `false` | Marks the confirming action as destructive. Defaults to `false`. |
| `flush` | `boolean` | no | `false` | The strip sits flush inside a bordered container. At the container's start or end it drops its own rule there instead of doubling the container's edge. Defaults to `false`. |
| `open` | `boolean` | no | `false` | Whether the confirmation is open. Bindable, and component-owned on close: confirming, clicking Cancel, and pressing Escape all set this to `false` before calling `onConfirm`/`onCancel`, so a bound parent observes the confirmation as already closed by the time either callback runs—neither callback can veto or delay that close. Defaults to `false`. |
| `presentation` | `"strip"` \| `"two-press"` | no | `"strip"` | The in-flow strip or a single guarded action button. |
| `prompt` | `string` | no | — | Confirmation prompt text; required for strip presentation and omitted for two-press presentation. |
| `armed` | `boolean` | no | `false` | Bindable armed state for two-press presentation. |
| `requestKey` | `string` | no | — | Request identity; changing it disarms two-press presentation. |
| `disabled` | `boolean` | no | `false` | Disables and disarms two-press presentation. |
| `blocked` | `boolean` | no | `false` | Blocks interaction while keeping the action focusable for an explanatory reason. |
| `requiresSecondPress` | `boolean` | no | `true` | Requires a second press in two-press presentation. |
| `armedLabel` | `string` | no | — | Full accessible label shown after the first press. |
| `armedHint` | `string` | no | — | Status text shown while the two-press action is armed. |
| `armedEscapeHint` | `string` | no | — | Optional keyboard instruction shown beside the armed status on fine pointers; coarse pointers hide the visual copy while the host can keep an accessible description. |
| `children` | `(opaque)` | no | — | Additional content rendered below the prompt, above the confirm/cancel actions, while the confirmation is open. Not expressible in JSON Schema; see the component types for the signature. |
| `onCancel` | `(opaque)` | no | — | Called when the user cancels the action (via the Cancel action or Escape), after `open` is already set to `false`. Not expressible in JSON Schema; see the component types for the signature. |
| `onConfirm` | `(opaque)` | no | — | Called when the user confirms the action, after `open` is already set to `false`. Not expressible in JSON Schema; see the component types for the signature. |

<!-- generated:props:end -->

## CSS Variables

<!-- generated:variables:start -->

This component does not declare any local CSS variables.
<!-- generated:variables:end -->
