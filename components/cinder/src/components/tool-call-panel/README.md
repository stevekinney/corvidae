# ToolCallPanel

The side panel of one tool call, opened from a `ToolCallRail` row. The header names the tool with its identifier small and monospaced, then says where the call stands: a dot, the state, how long it took and where it falls in the turn ("Failed 10.0s · call 28 of 30"). Under it, an Input section lists what the call was given as labelled fields, and the rest depends on the state: a done call shows its Result, a running call says the result is coming, a failed call shows an Error block with its message first and the next steps, and a waiting call carries a note field with Deny and Approve.

Use `ToolCallPanel` for one call's details beside a conversation. Use `PayloadInspector` for an arbitrary payload on its own page, and `Drawer` for navigation or settings from a page edge. The panel is a `Drawer` below the width it docks at, so it never reflows the conversation on a small screen.

## Placement

- `docked`: an inset panel about 340px wide in the flow of the page, with an X. Esc closes it while focus is inside.
- `overlay`: a right sheet over the content on a dimming scrim, closed by its X or Esc. The conversation stays visible behind it.
- `sheet`: a full-height bottom sheet with a grabber and a `Close` button, like the shared sheets. It cross-fades under reduced motion. The copy buttons give way to the retry button, which rests at the foot.
- `auto` (the default): `sheet` below 640px, `overlay` up to `dockedFrom` (1280px), and `docked` from there. 1280px is where a 190px sidebar, a 250px list, about 480px of conversation and the 340px panel fit; it is a threshold of its own, apart from the shared 1024px desktop breakpoint.

## Usage

```svelte
<script lang="ts">
  import { ToolCallPanel } from '@lostgradient/cinder';

  let open = $state(true);
</script>

<ToolCallPanel
  bind:open
  name="Send email"
  identifier="send-email"
  status="failed"
  duration="10.0s"
  position="call 28 of 30"
  input={{ to: 'maya@example.com', template: 'refund-notice', orderId: '4471' }}
  error={{
    message: 'No reply from mail.example.com after 10s',
    code: 'smtp-timeout',
    retryable: true,
  }}
  retryMessage="Please retry Send email to maya@example.com"
  onRetry={() => undefined}
/>
```

## Kinds of call

- `done`, `approved` and `denied`: Input and Result as fields, with secondary `Copy input` and `Copy result` buttons. Pass `resultLabel="Output"` for a tool that calls its answer an output.
- `running`: Input, and a Result that reads "The result appears when the call finishes."
- `waiting`: Input, a "Note (optional)" field and Deny and Approve. Approve is the only primary action on the screen. `onApprove` and `onDeny` receive the note; `resolving` writes "Approving…" or "Denying…" on that button and turns both off.
- `failed`: Input and an Error block, tinted red, with the message first and then the code in monospace and Retryable. It explains what retrying sends (`retryMessage`), then a full-width secondary `Ask the agent to retry` (`onRetry`) and secondary `Copy input` and `Copy error`.

Input and Result read as the Fields view of `PayloadInspector` does: keys become sentence-case words with acronyms kept (`orderId` reads "Order ID"), ISO dates read as dates, booleans as "Yes" and "No", null as "None" and an empty string as "Empty". Values the caller's schema marks secret, or that read as secrets when `redact` is not passed, show "Hidden" in both views and in the copy buttons. `view="json"` shows the stored value in a code block instead; text that is already JSON is shown as it was stored.

## Closing and focus

`open` is bindable and `onClose` fires once whenever the panel closes. Call `focusCall(id)` on the rail from `onClose` to hand focus back to the row that opened it; the overlay and the sheet also restore focus to `triggerRef`, or to where it was before they opened.

## Props

```
open          boolean (bindable)     optional  Whether the panel is open. Defaults to true.
name          string                 required  The tool's name as a person reads it.
identifier    string                 optional  The tool's identifier, small and monospaced.
status        done | approved | running | waiting | denied | failed   required
duration      string                 optional  How long the call took, formatted by the caller.
position      string                 optional  Where it falls in the turn ("call 28 of 30").
summary       string                 optional  The line under the name, replacing the status line.
input         unknown                optional  What the call was given.
result        unknown                optional  What the call returned.
resultLabel   string                 optional  The Result heading. Defaults to "Result".
error         ToolCallPanelError     optional  Why a failed call failed: message, code, retryable.
view          fields | json (bindable) optional  How Input and Result show. Defaults to fields.
redact        string[]               optional  Secret paths to hide.
retryMessage  string                 optional  The message the retry button sends, quoted in the note.
onRetry       () => void             optional  Shows "Ask the agent to retry" on a failed call.
onApprove     (note) => void         optional  Shows Approve on a waiting call.
onDeny        (note) => void         optional  Shows Deny on a waiting call.
resolving     approve | deny         optional  The answer on its way.
onClose       () => void             optional  Fired once when the panel closes.
placement     auto | docked | overlay | sheet   optional  Defaults to auto.
dockedFrom    string                 optional  The width it docks from. Defaults to 1280px.
triggerRef    HTMLElement | null     optional  Where focus returns for an overlay or sheet.
labels        ToolCallPanelLabels    optional  The panel's words, for another language.
class         string                 optional  Extra class names.
children      Snippet                optional  Extra sections after Input and Result.
```
