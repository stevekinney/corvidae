# Banner

Full-width announcement strip for page-level alerts, promotions, or system messages.

## Usage

```svelte
<script lang="ts">
  import { Banner } from '@lostgradient/cinder';
</script>

<Banner>Your message here.</Banner>
```

### Connection presets

A `preset` carries the tone, the accessible name, the words, a glyph and the actions of a connection or restart state, so no page words its own. Every preset is non-dismissible and labels its retry "Retry now". Pass the facts; the preset writes the sentence:

```svelte
<script lang="ts">
  import { Banner } from '@lostgradient/cinder';

  let seconds = $state(4);
  let attempt = $state(3);
</script>

<Banner
  preset="unreachable"
  dataUpdatedAt={loadedAt}
  retryInSeconds={seconds}
  {attempt}
  onRetry={retryNow}
/>
```

That reads "Can’t reach the Interborough server. Showing what loaded as of 10:44 AM CST. Changes are off until it’s back. Retrying in 4 s (attempt 3 of 8)." The "as of" time is absolute with its zone, and names the day when the data is from another day. It is never "2 minutes ago".

| Preset | Tone | Words | Actions |
| --- | --- | --- | --- |
| `offline` | warning | **You’re offline.** Showing what loaded as of 10:44 AM CST. Changes are off until you’re back. Retrying in 8 s. | Retry now |
| `unreachable` | warning | **Can’t reach the Interborough server.** Showing what loaded as of 10:44 AM CST. Changes are off until it’s back. Retrying in 4 s (attempt 3 of 8). | Retry now |
| `stopped` | warning | **Stopped retrying.** Can’t reach the Interborough server. Showing what loaded as of 10:44 AM CST. Changes are off until it’s back. | Retry now (primary) |
| `out-of-date` | warning | **Can’t reach the Interborough server.** Showing what loaded as of 10:44 AM CST. Retries stopped after 8 attempts. | Retry now (primary) |
| `refresh-failed` | warning | **Couldn’t refresh this page.** Showing what loaded as of 10:44 AM CST. | Retry now |
| `restarting` | info | **Restarting Interborough.** Your changes are saved. Running work picks up where it stopped; reviews stay waiting. | none |
| `reconnecting` | info | **Reconnecting… attempt 2 of 8.** Your changes are saved. Running work picks up where it stopped; reviews stay waiting. | Retry now |
| `restart-failed` | warning | **Interborough didn’t come back.** Your changes were saved first. Showing what loaded as of 10:44 AM CST. Changes are off until it’s back. | Restart again (primary), Open Health |
| `back-online` | success | Back online. Updated just now. | none |

`out-of-date` is `stopped` for a page that is only read (Health), and a read-only page that is still retrying passes `consequence={false}` to `unreachable` so no sentence says changes are off. `offline` shows a wifi-off glyph, and `unreachable`, `stopped` and `out-of-date` an unplugged glyph; pass `icon` to draw another. `restarting`, `restart-failed` and `back-online` never offer Retry now, with or without `onRetry`. `restart-failed` takes `onRestart` and `onOpenHealth`, or `healthHref` to make Open Health a link. `back-online` is a toast in the design; the preset carries the same words for a surface that cannot show one, and `BANNER_BACK_ONLINE_COPY` is the string a toast uses.

A page changes facts, not wording. `subject` completes "Showing … as of …" ("Showing reviews as of 10:44 AM CST."), `consequence` replaces the sentence that says what is off ("Start run is off until the connection is back.") or, as `false`, leaves it out, and `title` replaces the bold lead. `retryVariant="primary"` moves the emphasis for a page whose retries have stopped. `bannerPresetCopy(preset, facts)` writes the same words for anywhere else they are needed.

Passing `children` replaces the generated words and keeps everything else; with children, `dataUpdatedAt` shows the live relative notice ("Showing data from 2 minutes ago") instead. Use a banner only for the whole application or a page-wide condition; show a failure of one field, row or step where it happened.

### Title, glyph, neutral tone and sticky

`title` sets a bold lead. With a preset it runs inline as the first words of the sentence; on a plain banner it sits on its own line above the message, and `titleLayout` moves it either way. `icon` draws a decorative glyph at the start; a `success` banner leads with a check-circle unless `icon` draws another. `variant="neutral"` is a notice that is not a status, such as a setting the person chose. `sticky` keeps the banner at the top of its scroll container.

```svelte
<script lang="ts">
  import { Banner, Button } from '@lostgradient/cinder';
</script>

<Banner variant="warning" dismissible={false} sticky title="1 change waits for a restart">
  Workflow claim renew interval. Running work picks up where it stopped; reviews stay waiting.
  {#snippet actions()}
    <Button variant="secondary" size="sm" label="Revert 1 change" />
    <Button variant="secondary" size="sm" label="Restart now" />
  {/snippet}
</Banner>
```

When the width runs out (a phone) the message wraps and the actions drop to a line of their own at the right. On a touch pointer each action is 44px tall.

## Props

<!-- generated:props:start -->

| Prop | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `attempt` | `number` | no | — | The attempt under way, counted from 1. A preset writes "(attempt 3 of 8)". |
| `class` | `string` | no | — | Extra classes appended to the root element. Pass via the explicit `class` prop — it is excluded from rest-prop spread, so writing `class="x"` inside spread attributes will not reach the root. |
| `consequence` | `string` \| `false` | no | — | The sentence that says what is off while the banner shows, replacing the preset's own. Pass `false` to leave the sentence out. |
| `dismissible` | `boolean` | no | `true` | Whether the banner shows a dismiss (×) button. Default `true`. A banner with a `preset` is never dismissible: the connection and restart states cannot be hidden. |
| `healthHref` | `string` | no | — | Makes "Open Health" a link to this address instead of a button. |
| `maxAttempts` | `number` | no | `8` | How many attempts there are. |
| `preset` | `"offline"` \| `"unreachable"` \| `"stopped"` \| `"out-of-date"` \| `"refresh-failed"` \| `"restarting"` \| `"reconnecting"` \| `"restart-failed"` \| `"back-online"` | no | — | Applies a ready-made configuration: the tone, the accessible name, the words, a glyph and the actions of a connection or restart state (see {@link BannerPreset}). The preset overrides `variant`, makes the banner non-dismissible and, when `children` is omitted, writes its copy from `dataUpdatedAt`, `subject`, `retryInSeconds`, `attempt` and `consequence`. Passing `children` replaces the generated words and keeps the rest. |
| `retryInSeconds` | `number` | no | — | Seconds until the next automatic retry. A preset writes "Retrying in 4 s". |
| `retryLabel` | `string` | no | `"Retry"` | Label of the Retry button. A preset labels it "Retry now" unless this says otherwise. |
| `retryVariant` | `"primary"` \| `"secondary"` | no | — | How prominent the Retry button is. A preset makes it `primary` where Retry now is the way back (`stopped`) and `secondary` everywhere else, so one action at a time looks primary. |
| `staleDataLabel` | `string` | no | `"Showing data from"` | Text that precedes the relative time in the stale-data notice. |
| `sticky` | `boolean` | no | — | Keeps the banner at the top of its scroll container while the page scrolls under it. |
| `subject` | `string` | no | `"what loaded"` | What the page is showing, completing the preset's "Showing … as of …" sentence. |
| `timeZone` | `string` | no | — | IANA time zone of the preset's "as of" time. Defaults to the viewer's zone. |
| `title` | `string` | no | — | A bold lead for the banner, such as "1 change waits for a restart". With a `preset` it replaces the preset's lead and sits inline before the words; otherwise it sits on its own line above them. |
| `titleLayout` | `"inline"` \| `"stacked"` | no | — | Where the title sits. A preset runs it inline, as the first words of its sentence; a banner without a preset puts it on its own line above the message. |
| `variant` | `"neutral"` \| `"info"` \| `"success"` \| `"warning"` \| `"danger"` | no | `"info"` | Visual + semantic variant. Default `'info'`. |
| `actions` | `(opaque)` | no | — | Optional trailing CTA region (e.g., "Renew now" button). Not expressible in JSON Schema; see the component types for the signature. |
| `children` | `(opaque)` | no | — | Banner body content. Optional with a `preset`, which writes its own words. Not expressible in JSON Schema; see the component types for the signature. |
| `dataUpdatedAt` | `(opaque)` | no | — | When the data still on screen was last loaded. With a `preset` and no `children` the copy names it as an absolute time with its zone ("as of 10:44 AM CST"). Otherwise it adds a stale-data notice that reads "Showing data from" followed by a live relative time such as "2 minutes ago". Not expressible in JSON Schema; see the component types for the signature. |
| `icon` | `(opaque)` | no | — | A glyph at the start of the banner, drawn decoratively (`aria-hidden`). The `offline`, `unreachable` and `stopped` presets supply their own connection glyph, and a `success` banner leads with a check-circle unless this draws another. Not expressible in JSON Schema; see the component types for the signature. |
| `onDismiss` | `(opaque)` | no | — | Called after the dismiss button is clicked. Use to persist state. Not expressible in JSON Schema; see the component types for the signature. |
| `onOpenHealth` | `(opaque)` | no | — | Called when the `restart-failed` preset's secondary action, "Open Health", is pressed. Not expressible in JSON Schema; see the component types for the signature. |
| `onRestart` | `(opaque)` | no | — | Called when the `restart-failed` preset's primary action, "Restart again", is pressed. Not expressible in JSON Schema; see the component types for the signature. |
| `onRetry` | `(opaque)` | no | — | Called when the Retry button is pressed. The button renders in the actions region, before `actions`, only when this is set. A preset that retries (`offline`, `unreachable`, `stopped`, `refresh-failed`, `reconnecting`) offers it only when this is set; `restarting`, `restart-failed` and `back-online` never offer it. Not expressible in JSON Schema; see the component types for the signature. |

<!-- generated:props:end -->

## CSS Variables

<!-- generated:variables:start -->

This component does not declare any local CSS variables.
<!-- generated:variables:end -->

## Subcomponents

<!-- generated:subcomponents:start -->

None.

<!-- generated:subcomponents:end -->
