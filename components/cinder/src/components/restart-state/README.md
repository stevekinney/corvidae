# RestartState

<!-- generated:a11y-record:required -->

`RestartState` takes over the page while its host restarts, and cannot be dismissed. The host is not answering, so the page behind the scrim would show nothing true. The page confirms first with [`ConfirmDialog`](../confirm-dialog/README.md), then shows this, and closes it when the host is back with a success banner that says what applied.

It has three phases, one card each:

- **`restarting`**: the heading, a sentence that names what is happening and says that running work picks up where it stopped, and the steps as a status list ([`Steps`](../steps/README.md) with `variant="status"`). `currentStep` is how many steps are done; the next one spins.
- **`reconnecting`**: the host stopped and has not answered. The sentence counts the attempts ("Trying again in 4 s. Attempt 3 of 8.") and a meter of one segment per attempt fills as they pass. Retry now tries at once. [`restartRetryDelaySeconds`](#choosing-the-wait) gives the wait before each attempt: 1, 2, 4, then 8 seconds.
- **`failed`**: the host never answered. The card turns red, says what was saved before the host stopped, what to check, the error behind a disclosure, and the exact command to start the host again with a Copy button. Keep waiting is the one primary action. There is no restart-again action, because the route that restarts lives on the host that is not answering.

The card is drawn inside a chromeless [`Modal`](../modal/README.md), so it gets the scrim, the focus trap and the scroll lock for free, with Escape, the backdrop and a close button all switched off.

## Choosing the wait

`restartRetryDelaySeconds(attempt)` is the schedule the connection banner also uses: attempt 1 waits 1 s, 2 waits 2 s, 3 waits 4 s, and every attempt after waits 8 s. The page owns the timer; the component only draws it.

## Usage

```svelte
<script lang="ts">
  import { RestartState, restartRetryDelaySeconds } from '@lostgradient/cinder';

  let attempt = $state(3);
</script>

<RestartState
  open
  phase="reconnecting"
  {attempt}
  retryInSeconds={restartRetryDelaySeconds(attempt)}
  onRetry={() => (attempt += 1)}
/>
```

## Props

<!-- generated:props:start -->

| Prop | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `attempt` | `number` | no | — | The attempt under way in `reconnecting`, counted from 1. Fills that many segments of the meter. |
| `check` | `string` | no | — | What to check in `failed`, in plain words: that the host is still running and that its address is reachable from this browser. Left out, the box does not show. |
| `checkTitle` | `string` | no | `"What to check"` | Heading of the checklist in `failed`. |
| `class` | `string` | no | — | Optional extra class on the underlying `<Modal>`. |
| `command` | `string` | no | — | The exact command the host was launched with, in `failed`, with a Copy button: the way back when the host that would restart itself is the one that is not answering. Left out, the line does not show. |
| `commandLabel` | `string` | no | `"Start it again from the terminal:"` | The words before `command`. |
| `copyLabel` | `string` | no | `"Copy"` | Label of the button that copies `command`. |
| `currentStep` | `number` | no | `0` | How many of `steps` are done in `restarting`: the step at that index is in progress, and the ones after it are waiting. |
| `description` | `string` | no | — | The sentence under the heading. `restarting` and `failed` name what is happening and what was saved ("Unloading Web search. Running work picks up where it stopped; reviews stay waiting."), so the page supplies them. `reconnecting` builds its own from `retryInSeconds`, `attempt` and `maxAttempts` when this is left out. |
| `detailsLabel` | `string` | no | `"Show the error details"` | Label of the disclosure for `details`. |
| `keepWaitingLabel` | `string` | no | `"Keep waiting"` | Label of the primary button in `failed`. There is no restart-again action, because the route that restarts lives on the host that is not answering. |
| `maxAttempts` | `number` | no | `8` | How many attempts there are. The meter has this many segments. |
| `open` | `boolean` | yes | — | Whether the state is showing. It never closes itself: nothing the person can press dismisses it, because the host is not answering and the page behind it would show nothing true. The page closes it when the host is back, and says what applied in a banner. |
| `phase` | `"restarting"` \| `"reconnecting"` \| `"failed"` | yes | — | Which of the three states to show. |
| `retryInSeconds` | `number` | no | — | Seconds until the next automatic attempt in `reconnecting`. Adds "Trying again in 4 s." |
| `retryLabel` | `string` | no | `"Retry now"` | Label of the button that tries at once in `reconnecting`. |
| `steps` | `string`[] | no | `["Saved your choice","Stopped the server","Starting Interborough","Checking plugins"]` | The labels of the steps, in order, for `restarting`. |
| `title` | `string` | no | — | Heading of the state. Defaults to the phase's own words: "Restarting Interborough", "Waiting for Interborough", "Interborough didn’t come back". |
| `details` | `(opaque)` | no | — | The error behind a failure, shown behind the `detailsLabel` disclosure in `failed`. Left out, the disclosure does not show. Not expressible in JSON Schema; see the component types for the signature. |
| `onKeepWaiting` | `(opaque)` | no | — | Fired when the person chooses to keep waiting. The button shows only when this is set. Not expressible in JSON Schema; see the component types for the signature. |
| `onRetry` | `(opaque)` | no | — | Fired when the person asks to try at once. The button shows only when this is set. Not expressible in JSON Schema; see the component types for the signature. |

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
<!-- generated:subcomponents:end -->
