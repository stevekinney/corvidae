# ToolCallRail

One turn's tool calls on a rail. Each call is one line that never wraps: the tool's name as a person reads it (its identifier is a tooltip), the muted key input, `→ result`, and the duration at the end. A long turn keeps its first and last few calls and folds the middle behind one dashed button that says what it hides. A call that failed, was denied, is waiting on a person or is still running never folds, and a failed call carries one danger line with its consequence and quiet links instead of a filled error block.

Use `ToolCallRail` for the tool calls of a chat turn, where the agent's reply leads and the calls follow. Use `RunStepTimeline` for the steps of a run with their own timing, retries and branches, and `Timeline` for dated events. The rail is built on `Timeline`'s `rows` variant, because run pages and chat read the same kind of sequence: Timeline draws the marker column and the connector, and the rail draws what sits in each row, since a tool call has no timestamp to lead with. A folded group is one entry of its own.

## Usage

```svelte
<script lang="ts">
  import { ToolCallRail } from '@lostgradient/cinder';
  import type { ToolCallRailCall } from '@lostgradient/cinder';

  const calls: ToolCallRailCall[] = [
    {
      id: 'search',
      name: 'Search orders',
      identifier: 'search-orders',
      input: 'carrier Parcelly, damaged',
      result: '14 orders',
      duration: '0.6s',
      status: 'done',
    },
    {
      id: 'lookup',
      name: 'Lookup order',
      identifier: 'lookup-order',
      input: '4471',
      result: '$42.00, delivered Mon',
      duration: '0.2s',
      status: 'done',
    },
    {
      id: 'refund',
      name: 'Issue refund',
      identifier: 'issue-refund',
      input: '4480, $27.25',
      status: 'waiting',
    },
  ];
</script>

<ToolCallRail {calls} duration="1.2s" />
```

## How many calls

- One or two calls are plain rows: no `Used N tools` line, no rail connector and no fold.
- From three calls the summary line appears (`Used 3 tools`) and every call still shows. It adds `· 1 failed` and `· 1 waiting on you`, each with its dot, only when such calls exist, and the turn's `duration` when you pass one.
- From eight calls the middle folds: the first 3 and the last 3 stay, with `Show 2 more · 2 done: Lookup order ×2` between them. A folded group hides at least two calls, because hiding one saves nothing, so seven calls show all seven.
- Calls that failed, were denied, wait on a person or are running are _pinned_: they stay on the rail wherever they fall and split the folded middle into separate groups, each counting only the calls it hides. The group's summary lists the three names that appear most (`×N` when more than once) and counts every other call as `6 others`.
- `Show N more` opens that group in place, in time order, and a `Show fewer` button after the last row folds every open group again.
- Closing the summary line (`open={false}`) leaves the summary and the pinned calls, so nothing that needs a person is ever folded away.
- While the turn `running`, the summary reads `Used 12 tools so far…` with a spinner and no counts, and the rail keeps the first 3 calls and the ones under way instead of the last 3.

## Call states

`status` picks the glyph on the rail and the words:

- `done`: a neutral grey dot, the result after an arrow.
- `approved`: a green dot, for a call a person approved. `decision` writes what was decided in the person's words, without an arrow (`Approved by you 10:33 AM · $18.50 refunded`); without it the row shows `result` after an arrow like a `done` call.
- `running`: a spinner in place of the dot, `Running…` in place of a result, and the elapsed time.
- `waiting`: an amber shield and `Waiting on you`, as its own row.
- `denied`: a prohibition glyph and neutral words. It is not called failed and carries no error block.
- `failed`: a red cross and the result in red. `failure` adds one danger-text line with an error glyph and the quiet links `Details` (when `onSelect` is set), `Ask the agent to retry` (`onRetry`) and `Copy input` (`onCopyInput`).

## Selecting a row and nesting an approval

Set `onSelect` and every row is a button. The row whose id is `selectedId` is tinted and keeps the quiet focus ring while its panel is open. Call `focusCall(id)` on the component to hand focus back to a row when the panel closes.

A call with `nested: true` draws the `children` snippet under its row: the approval a `waiting` call is waiting on, or the decided approval under a call that has been approved. Nothing gates it on the call's status.

```svelte
<script lang="ts">
  import { ApprovalCard, ToolCallRail } from '@lostgradient/cinder';

  let selectedId = $state<string | undefined>(undefined);
</script>

<ToolCallRail
  calls={[
    {
      id: 'refund',
      name: 'Issue refund',
      identifier: 'issue-refund',
      input: '4480, $27.25',
      status: 'waiting',
      nested: true,
    },
  ]}
  {selectedId}
  onSelect={(id) => (selectedId = id)}
>
  {#snippet children(call)}
    <ApprovalCard
      layout="row"
      tool={{ name: call.identifier ?? call.id, label: call.name, risk: 'high' }}
      question="Refund order 4480 for $27.25?"
      operation={{ kind: 'other' }}
      policyVersion="policy-1"
      idempotencyKey="approval-4480"
      state="pending"
    />
  {/snippet}
</ToolCallRail>
```

## Narrow containers

In a container narrower than 28rem (a phone) each row has two lines: the name and duration on line one, and a muted line of key input and result, cut with an ellipsis, on line two. The summary drops the duration, the dashed button keeps `Show 24 more` beside the short `24 done`, and the failure line gives way to the call's panel.

## Props

```
calls        ToolCallRailCall[]      required  The calls of one turn, in order.
running      boolean                 optional  The turn is still running. Defaults to false.
duration     string                  optional  How long the turn took, formatted by the caller.
open         boolean (bindable)      optional  Whether the rail is open. Defaults to true.
selectedId   string                  optional  The call whose panel is open.
onSelect     (id) => void            optional  Makes rows buttons; fired with the call's id.
onRetry      (id) => void            optional  Shows "Ask the agent to retry" on failed calls.
onCopyInput  (id) => void            optional  Shows "Copy input" on failed calls.
endLabel     string                  optional  The run's end state on its own line ("Run finished · no reply").
footnote     string                  optional  A muted line under the rail.
label        string                  optional  Accessible name. Defaults to "Tool calls".
labels       ToolCallRailLabels      optional  The rail's words, for another language.
class        string                  optional  Extra class names.
children     Snippet<[call]>         optional  Content under the rows of calls that set `nested`.
```

### ToolCallRailCall shape

```
id          string   required  Stable identity.
name        string   required  The tool's name as a person reads it.
identifier  string   optional  The tool's identifier, in a tooltip on the name.
input       string   optional  The key input, muted and truncated.
result      string   optional  What came back, in one line.
decision    string   optional  What a person decided, in their own words and without an arrow.
duration    string   optional  How long it took, formatted by the caller.
status      done | approved | running | waiting | denied | failed   required
failure     string   optional  A failed call's consequence, in one danger line.
nested      boolean  optional  Draw `children` under this row.
```
