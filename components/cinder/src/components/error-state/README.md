# ErrorState

Placeholder layout for a region whose data failed to load. The default layout is the centred page state: a 48px disc, the title (16px semibold), a sentence of at most 380px, an optional progress line, the actions, and a collapsed details disclosure. A failure is announced as an alert and never looks like an empty result; a `neutral` tone covers a thing that doesn't exist, where nothing failed.

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

The retry button is the primary action, with a refresh glyph, and the only primary on the page. Add a second action with the `secondaryAction` snippet, and a line of progress with `retryStatus` (it is not a live region, so a countdown never announces itself every second):

```svelte
<script lang="ts">
  import { Button, ErrorState } from '@lostgradient/cinder';
</script>

<ErrorState
  title="Couldn't load runs"
  description="Interborough didn't answer. Your runs are safe; they're stored on this machine."
  retryStatus="Retrying in 8 s (attempt 3 of 8)"
  retryLabel="Retry now"
  onRetry={() => console.log('retry')}
>
  {#snippet secondaryAction()}
    <Button variant="secondary" label="Open Health" />
  {/snippet}
</ErrorState>
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

## Props

<!-- generated:props:start -->

| Prop | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `class` | `string` | no | — | Additional class merged onto the `.cinder-error-state` root element. |
| `description` | `string` | yes | — | Secondary descriptive text rendered as a paragraph below the title. |
| `detail` | `string` | no | — | Optional technical detail, such as a fault code. It sits behind a disclosure labelled `detailsLabel`, so the plain-words description stays the first thing a person reads. |
| `detailsLabel` | `string` | no | `"Show the error details"` | Label of the disclosure that holds `detail`. |
| `headingLevel` | `1` \| `2` \| `3` \| `4` \| `5` \| `6` | no | `2` | Heading level for the title element. |
| `retryLabel` | `string` | no | `"Try again"` | Label of the retry button. |
| `retryStatus` | `string` | no | — | A line of progress under the description, such as "Retrying in 8 s (attempt 3 of 8)". It renders in tabular figures and is not a live region, so a countdown never announces itself every second. |
| `title` | `string` | yes | — | Primary heading text rendered as a heading element at the configured `headingLevel`. |
| `tone` | `"danger"` \| `"neutral"` | no | `"danger"` | What kind of problem this reports. `'danger'` is a failure and is announced as an alert; `'neutral'` is a state where nothing failed, such as a missing page, and is a plain group. |
| `variant` | `"default"` \| `"flat"` | no | `"default"` | Layout. `'default'` is the centred page layout: a 48px tinted disc with a glyph, the title, the description, the progress line, then the actions, centred in the region it fills. `'flat'` renders the same text as a start-aligned block with no disc and no padding of its own, for a card or tab whose container already pads it. |
| `icon` | `(opaque)` | no | — | Replaces the glyph in the disc. The default is a warning triangle for the `'danger'` tone and a magnifying glass for `'neutral'`. Decorative, so it is hidden from assistive technology. Not expressible in JSON Schema; see the component types for the signature. |
| `onRetry` | `(opaque)` | no | — | Called when the retry button is activated. The retry button renders only when this is given. It is the page's primary action. Not expressible in JSON Schema; see the component types for the signature. |
| `secondaryAction` | `(opaque)` | no | — | A second action rendered after the retry button, such as an "Open Health" link or a "Back to chats" button. Give it the secondary or ghost button variant so the retry button stays the only primary on the page. Not expressible in JSON Schema; see the component types for the signature. |

<!-- generated:props:end -->

## CSS Variables

<!-- generated:variables:start -->

This component does not declare any local CSS variables.
<!-- generated:variables:end -->

## Subcomponents

<!-- generated:subcomponents:start -->
<!-- generated:subcomponents:end -->
