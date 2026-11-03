# DockedActionBar

<!-- generated:a11y-record:required -->

`DockedActionBar` keeps a page's main actions at the bottom of its scrolling area, so they never scroll away: a live run's field with Send a message and Cancel run, or a review's Deny and Approve on a phone.

It is `position: sticky`, so it sits in the flow at the end of the content. The page scrolls behind it, and the content above it needs no bottom padding of its own because the bar occupies exactly that space. Put it inside the element that scrolls, as the last child.

- **Safe area**: the bar's bottom padding is at least `env(safe-area-inset-bottom)`, so it clears the home indicator.
- **Keyboard**: while the bar is mounted, `--_cinder-keyboard-inset` carries how much of the screen the on-screen keyboard covers, and the bar rides above it. A bottom drawer and the toast region read the same property.
- **Touch**: with a coarse pointer every control in the bar is a 44px target. The bar overrides the shared `--cinder-control-height-*` and `--cinder-button-height-*` steps, which buttons and fields both read.
- **Height**: the bar publishes its height, safe area included, as the internal `--_cinder-docked-action-bar-height` on the document element, and `ToastRegion` reads it to sit above the bar. The bar is sticky and in the flow, so the content above it never needs bottom padding of its own.
- **Off**: `off` and `reason` turn the actions off together. Buttons inside that opted in with `mutating` go inert exactly as under a `StaleRegion` (focusable, `aria-disabled`, described by the reason), and the reason is drawn under the row and announced politely. A field in the bar is the page's to make read-only.
- **Narrow**: below 32rem of bar width the actions take their own row under the content and share it. `equalActions` gives a pair such as Deny and Approve equal widths.

## Usage

```svelte
<script lang="ts">
  import { Button, DockedActionBar, Input } from '@lostgradient/cinder';

  let connected = $state(true);
  let message = $state('');
</script>

<DockedActionBar
  label="Run actions"
  off={!connected}
  reason="Reconnecting… Send a message and Cancel run are off until the connection is back."
>
  <Input
    id="run-context"
    bind:value={message}
    label="Add context"
    labelVisible={false}
    placeholder="Add context the agent will see on its next step"
    readonly={!connected}
  />
  {#snippet actions()}
    <Button mutating variant="secondary">Send a message</Button>
    <Button mutating variant="secondary">Cancel run</Button>
  {/snippet}
</DockedActionBar>
```

## Props

<!-- generated:props:start -->

| Prop | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `class` | `string` | no | — | Custom class merged with `.cinder-docked-action-bar`. |
| `equalActions` | `boolean` | no | `false` | Gives the actions equal widths, so a pair such as Deny and Approve share the row evenly. On a narrow bar the actions take their own row under the content and share it; with no content they fill the bar. |
| `label` | `string` | no | `"Actions"` | Accessible name of the bar, read as the name of its group: "Run actions", "Decision". |
| `off` | `boolean` | no | `false` | Turns the bar's actions off together, for one reason. Controls inside that opted in with `mutating` go inert (`aria-disabled`, still focusable, described by `reason`), exactly as under a `<StaleRegion>`, and the bar draws `reason` under its row. A field in the bar is the page's to make read-only. The bar keeps its place and its height, so nothing under it moves. |
| `reason` | `string` | no | — | Why the actions are off, drawn under the row and read as the description of every inert control: "Reconnecting… Send a message and Cancel run are off until the connection is back." It is announced politely when it appears. Ignored while the bar is not `off`. |
| `actions` | `(opaque)` | yes | — | The buttons, kept together at the end of the row. Not expressible in JSON Schema; see the component types for the signature. |
| `children` | `(opaque)` | no | — | The leading part of the bar: a field, a consequence line. It takes the room the actions leave. Not expressible in JSON Schema; see the component types for the signature. |

<!-- generated:props:end -->

## Authoring checklist

<!-- generated:authoring:start -->

Before publishing this component, complete the live [component authoring pre-flight](../../../README.md#component-authoring-checklist).
<!-- generated:authoring:end -->

## CSS Variables

<!-- generated:variables:start -->

This component does not declare any local CSS variables.
<!-- generated:variables:end -->

## Subcomponents

<!-- generated:subcomponents:start -->

None.
<!-- generated:subcomponents:end -->
