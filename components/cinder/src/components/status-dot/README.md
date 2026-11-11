# Status Dot

A semantic status indicator that pairs a colored dot with an accessible label.

## Usage

```svelte
<script lang="ts">
  import { StatusDot } from '@lostgradient/cinder';
</script>

<StatusDot status="online" label="Online" />
```

A status is a dot and a word, never a dot alone. With only `status`, the component renders a default word derived from it (`online` renders "Online", `danger` renders "Danger"), so `<StatusDot status="online" />` shows the same dot and word as the example above. Pass `label` to say something more specific, such as "Healthy" or "Deploying", and pass `labelVisible={false}` only where the word sits right next to the dot in the surrounding text; the word stays the accessible name either way.

## Status words

Status-dot owns the word-to-tone table for Interborough's status words, so a page passes a `word` and never picks a tone of its own. The word sets both the tone and the visible text:

```svelte
<script lang="ts">
  import { StatusDot } from '@lostgradient/cinder';
</script>

<StatusDot word="Waiting on you" size="sm" />
<StatusDot word="Running, checking the result" size="sm" />
<StatusDot word="Done, refund not issued" size="sm" />
```

One word has one tone, identical in light and dark. A qualifier after a comma rides along on its base word (`Running, checking the result` is `info`, `Missed runs, 4` is `warning`) unless the table lists the whole phrase (`Done, refund not issued` is `neutral`, because a finished run whose task was not achieved is never green). An explicit `status` or `label` still wins over what the word supplies.

| Tone | Words |
| --- | --- |
| `warning` (amber) | Waiting on you, Missed runs, Disconnected, Needs attention, Needs sign-in |
| `info` (solid neutral) | Running, Running, checking the result, Live, Live, last event 1 s ago |
| `pending` (hollow ring) | Waiting, Scheduled, Reconnecting… |
| `success` (green dot) | Done, Approved, Active, Available, Delivered, Connected |
| `danger` (red) | Failed, Failed for good, Gave up, Can't load, Can't find workflow, Not loaded |
| `neutral` | Done, refund not issued, Check not met, Denied, Sent back, Expired, Canceled, Stopped, Paused, Off, Unavailable, Needs setup, Ended, Retrying, Draining |

Only `warning` and `danger` words are coloured; every other word, `info` included, is muted, so the dot carries the tone. The `info` dot is the neutral control-border colour, not the accent or a blue: emphasis comes from position and weight first, and hues are kept for what needs attention. Amber is only for waiting on you and Needs attention, and red is reserved for failures to run or to load. The table is exported as `statusDotWordTones`, and `statusForStatusDotWord(word)` returns a word's status, or `undefined` for a word the table does not know (a `word` the table does not know renders a neutral dot).

Some words are scoped, and the page decides where they belong: Ended is for chats only, Delivered and Retrying are for hooks only, Connected, Draining and Disconnected are for workers only, and Stopped also covers a worker that finished draining. Live and Reconnecting… are for the line above a streaming run's steps: `<StatusDot word="Live, last event 1 s ago" />`, and `<StatusDot word="Reconnecting…" label="Reconnecting… last event 40 s ago" />`, where the word sets the tone and `label` the text.

`pending` is a hollow ring (a 1.5px ring in `--cinder-border-control` over a transparent fill), so Waiting and Scheduled read differently from the solid Running dot. Under forced colors the solid dot uses `Highlight` and the hollow ring uses `CanvasText`; the word always carries the meaning.

## Props

<!-- generated:props:start -->

| Prop | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `class` | `string` | no | — | Extra classes appended to the root element. |
| `connectionState` | `"connected"` \| `"connecting"` \| `"disconnected"` \| `"error"` | no | — | Realtime connection preset. Sets status, default label, and live-region semantics. |
| `label` | `string` | no | — | Human label. Rendered visibly when `labelVisible` is true; used as the accessible name either way. Defaults to a word derived from `status` (for example "Online"), so a bare StatusDot is a dot and a word, never a dot alone. |
| `labelVisible` | `boolean` | no | `true` | Whether to render the visible label. |
| `live` | `boolean` | no | — | Use role="status" with polite live-region attributes. Defaults true when connectionState is provided. |
| `size` | `"sm"` \| `"md"` | no | `"md"` | Dot size. |
| `status` | `"online"` \| `"offline"` \| `"warning"` \| `"danger"` \| `"info"` \| `"pending"` \| `"neutral"` \| `"success"` \| `"accent"` | no | — | Semantic status. Drives color via `data-cinder-status`; defaults to a neutral dot or derives from `connectionState`. `success` maps to `--cinder-status-success-solid`; `info` maps to `--cinder-border-control`, the neutral dot; `pending` is a hollow ring; `accent` maps to `--cinder-accent-solid`. |
| `wordTone` | `"muted"` \| `"status"` | no | `"muted"` | How the visible word is coloured: `muted` (the default) leaves a success, neutral, info or pending word muted so the dot carries the tone; `status` paints it in the status's text colour, for a result sentence such as a green "Found 3 tools". Warning and danger words are always coloured. |
| `word` | `(opaque)` | no | — | A status word from the word-to-tone table, such as "Waiting on you" or "Failed". It sets both the tone and the visible word, so a page never picks its own tone; a qualifier after a comma ("Running, checking the result") rides along. An explicit `status` or `label` wins over what the word supplies. Not expressible in JSON Schema; see the component types for the signature. |

<!-- generated:props:end -->

## Breaking changes

The `"pending"` status is now a hollow ring (it was a solid info-blue dot). Use the new `"info"` status for the solid dot.

The `"building"` status was renamed to `"pending"`. Update any usage:

```svelte
<!-- before -->
<StatusDot status="building" label="Deploying" />
<!-- after -->
<StatusDot status="pending" label="Deploying" />
```

The dot color is unchanged by that rename — only the status token name changed. (`info` has since become the neutral dot colour, COR-2314.)

## CSS Variables

<!-- generated:variables:start -->

- `--cinder-status-dot-color`
- `--cinder-status-dot-size`

<!-- generated:variables:end -->

## Subcomponents

<!-- generated:subcomponents:start -->

<!-- generated:subcomponents:end -->
