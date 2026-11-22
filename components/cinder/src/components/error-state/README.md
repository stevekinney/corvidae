# ErrorState

Placeholder layout for a region whose data failed to load. The default layout is the centred page state: a 48px disc, the title (16px semibold), a sentence of at most 380px, an optional progress line, the actions, and a collapsed details disclosure. A failure is announced as an alert and never looks like an empty result; a `warning` tone covers a problem the person can resolve (announced as a status), and a `neutral` tone a thing that doesn't exist, where nothing failed (a plain group). `announce` raises either to an alert.

The words follow one rule on every page: say what failed in plain words, whether it was the person, and the next action. Use contractions, sentence case and no exclamation marks. Fault codes go in `detail`, behind the "Show the error details" disclosure. Show an error where it happened (a field, a row, a step); use a full-page error state only when the page has nothing to show, and never beside a banner for the same failure.

## Usage

```svelte
<script lang="ts">
  import { ErrorState } from '@lostgradient/cinder';
</script>

<ErrorState
  title="Couldn't load runs"
  description="The server answered with an error (500). Nothing you did caused it."
  detail="HTTP 500 from /api/runs"
  onRetry={() => console.log('retry')}
/>
```

The retry button is the primary action, with a refresh glyph, and the only primary on the page. When the primary action is not a retry (a "New chat" button on a not-found page), give it its own words with `retryLabel` and its own glyph with the `retryIcon` snippet. Add a second action with the `secondaryAction` snippet, and a line of progress with `retryStatus` (it is not a live region, so a countdown never announces itself every second):

```svelte
<script lang="ts">
  import { Button, ErrorState } from '@lostgradient/cinder';
</script>

<ErrorState
  title="Couldn't load runs"
  description="Interborough didn't answer. Your runs are safe; they're stored on this machine."
  retryStatus="Retrying in 8 s (attempt 3 of 8)"
  retryLabel="Try again"
  onRetry={() => console.log('retry')}
>
  {#snippet secondaryAction()}
    <Button variant="secondary" label="Open Health" />
  {/snippet}
</ErrorState>
```

A fault that names its next step passes it as `remediation`. It is its own line right after the description, in the description's type, and sits inside the alert, so a screen reader reads what failed and then what to do. Pair it with `onRetry` when asking again can help:

```svelte
<script lang="ts">
  import { ErrorState } from '@lostgradient/cinder';
</script>

<ErrorState
  title="Couldn’t load runs"
  description="Interborough didn’t answer. Your runs are safe; they’re stored on this machine."
  remediation="Check that Interborough is running, then try again."
  onRetry={() => console.log('retry')}
/>
```

When asking again cannot help (a fault that is not retryable), omit `onRetry`: the remediation is then the only next step and no Try again button is drawn:

```svelte
<script lang="ts">
  import { ErrorState } from '@lostgradient/cinder';
</script>

<ErrorState
  title="Couldn’t start this run"
  description="The workflow refers to a step that no longer exists. Nothing you did caused it."
  remediation="Open the workflow and remove or replace the missing step, then start the run again."
/>
```

The `neutral` tone is for a state where nothing failed, such as a missing page: a neutral disc with a search glyph, a plain group instead of an alert, and no retry:

```svelte
<script lang="ts">
  import { Button, ErrorState } from '@lostgradient/cinder';
</script>

<ErrorState
  tone="neutral"
  title="This run doesn't exist"
  description="It may have been deleted. The address might also be mistyped."
>
  {#snippet secondaryAction()}
    <Button variant="secondary" label="Back to Runs" />
  {/snippet}
</ErrorState>
```

The `warning` tone is for a problem the person can resolve, such as a conflicting change: the warning colors instead of red, announced politely as a status. Add `announce` to raise a `warning` or `neutral` state to an alert when it replaces the content the person came for:

```svelte
<script lang="ts">
  import { ErrorState } from '@lostgradient/cinder';
</script>

<ErrorState
  tone="warning"
  announce
  title="Someone else changed this workflow"
  description="Your edit was not saved because the workflow changed while you were editing."
  remediation="Read the workflow again, then make your change on the new revision."
  onRetry={() => {}}
/>
```

Flat — no disc and no padding of its own, for a card or tab whose container already pads it. The content is start-aligned and the error is still announced as an alert:

```svelte
<script lang="ts">
  import { ErrorState } from '@lostgradient/cinder';
</script>

<ErrorState
  variant="flat"
  title="Couldn't load runs"
  description="The server did not respond in time."
  onRetry={() => console.log('retry')}
/>
```

Row — a small warning glyph, the title (medium weight, on its own line) with the description under it, and a secondary "Try again" at the end, for one card that failed to load while the others stay live. A `secondaryAction` sits beside it, and stands alone when there is no retry. `bordered` draws a quiet hairline in the tone's border color around the row. The actions drop under the words on a phone:

```svelte
<script lang="ts">
  import { ErrorState } from '@lostgradient/cinder';
</script>

<ErrorState
  variant="row"
  headingLevel={3}
  title="Couldn’t load system problems."
  description="The rest of Home is live."
  onRetry={() => console.log('retry')}
/>
```

## Props

<!-- generated:props:start -->

| Prop | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `announce` | `boolean` | no | `false` | Announces a `'warning'` or `'neutral'` state as an alert, so assistive technology interrupts with it as it does for a failure. Use it when the state replaces the content the person came for, so staying quiet would leave them with nothing. The `'danger'` tone is always an alert. |
| `bordered` | `boolean` | no | `false` | Draws the state inside a bordered, rounded box, for a list or page body that has no container of its own. Leave it off when a card or panel already surrounds the state. On the centred layout it is a panel; on the `'row'` variant it is a quiet hairline in the tone's border token (danger, warning or neutral) around the one line; the `'flat'` variant has no box. |
| `class` | `string` | no | — | Additional class merged onto the `.cinder-error-state` root element. |
| `description` | `string` | yes | — | Secondary descriptive text rendered as a paragraph below the title. A `'row'` whose title is its whole sentence passes `''` and draws no second paragraph. |
| `detail` | `string` | no | — | Optional technical detail, such as a fault code. It sits behind a disclosure labelled `detailsLabel`, so the plain-words description stays the first thing a person reads. |
| `detailsLabel` | `string` | no | `"Show the error details"` | Label of the disclosure that holds `detail`. |
| `headingLevel` | `1` \| `2` \| `3` \| `4` \| `5` \| `6` | no | `2` | Heading level for the title element. |
| `remediation` | `string` | no | — | What to do next, such as "Check that the server is running, then try again." It renders as its own line right after the description, in the same type, inside the labelled region, so assistive technology reads it in order. Leave it off when the fault names no next step. Pair it with `onRetry` when asking again can help, and omit `onRetry` when it cannot. |
| `retryLabel` | `string` | no | `"Try again"` | Label of the retry button. |
| `retryStatus` | `string` | no | — | A line of progress under the description, such as "Retrying in 8 s (attempt 3 of 8)". It renders in tabular figures and is not a live region, so a countdown never announces itself every second. |
| `retryVariant` | `"primary"` \| `"secondary"` | no | `"primary"` | How prominent the retry button is. `'primary'` suits a full-page failure, where retrying is the one thing to do. `'secondary'` suits a section of a page that has other controls, such as a tab's body under a tab bar, so the retry does not outrank them. |
| `size` | `"default"` \| `"compact"` | no | `"default"` | Scale of the centred layout. `'compact'` tightens the padding, shrinks the disc to 40px and tints it neutral, sets the title in the base size, and makes the retry a small secondary button with no refresh glyph, so the state fits a list pane that failed to load without claiming the page's one primary action. It has no effect on the `'flat'` and `'row'` variants. |
| `title` | `string` | yes | — | Primary heading text rendered as a heading element at the configured `headingLevel`. |
| `tone` | `"danger"` \| `"warning"` \| `"neutral"` | no | `"danger"` | What kind of problem this reports. `'danger'` is a failure and is announced as an alert; `'warning'` is a problem that may clear by itself or that the person can resolve, such as a conflicting change or a server that is not answering, drawn in the warning colors and announced politely as a status; `'neutral'` is a state where nothing failed, such as a missing page, and is a plain group. `announce` raises a warning or neutral state to an alert. |
| `variant` | `"default"` \| `"flat"` \| `"row"` | no | `"default"` | Layout. `'default'` is the centred page layout: a 48px tinted disc with a glyph, the title, the description, the progress line, then the actions, centred in the region it fills. `'flat'` renders the same text as a start-aligned block with no disc and no padding of its own, for a card or tab whose container already pads it. `'row'` lays a small warning glyph, the title (medium weight, on its own line), the description and remediation under it, and the actions (a secondary retry button with no refresh glyph unless `retryIcon` is given, and any `secondaryAction`) at the end, for the failure of one card among others that are live; the actions drop under the words on a phone. |
| `icon` | `(opaque)` | no | — | Replaces the glyph in the disc. The default is a warning triangle for the `'danger'` tone and a magnifying glass for `'neutral'`. Decorative, so it is hidden from assistive technology. Not expressible in JSON Schema; see the component types for the signature. |
| `onRetry` | `(opaque)` | no | — | Called when the retry button is activated. The retry button renders only when this is given. It is the page's primary action. Not expressible in JSON Schema; see the component types for the signature. |
| `retryIcon` | `(opaque)` | no | — | Replaces the refresh glyph on the primary button. Use it when the primary action is not a retry, such as a "New chat" button with a pencil on a not-found page. Decorative. Not expressible in JSON Schema; see the component types for the signature. |
| `secondaryAction` | `(opaque)` | no | — | A second action rendered alongside the retry button, such as an "Open Health" link or a "Back to chats" button. Give it the secondary or ghost button variant so the retry button stays the only primary on the page. When both actions are present, the secondary action is first in DOM and keyboard order, visually left of the primary. Every variant draws it, the `'row'` too, and it stands alone when the state has no retry. Not expressible in JSON Schema; see the component types for the signature. |

<!-- generated:props:end -->

## CSS Variables

<!-- generated:variables:start -->

This component does not declare any local CSS variables.
<!-- generated:variables:end -->

## Subcomponents

<!-- generated:subcomponents:start -->
<!-- generated:subcomponents:end -->
