# ApprovalCard

Presentational human-in-the-loop approval surface for reviewing a tool operation before the host application executes it.

## Usage

```svelte
<script lang="ts">
  import { ApprovalCard } from '@lostgradient/cinder';
</script>

<ApprovalCard
  tool={{ name: 'deploy-cloud', risk: 'medium' }}
  sandbox={{
    provider: 'codex',
    name: 'workspace-write',
    workingDir: '/workspace/project',
  }}
  operation={{
    kind: 'command',
    command: 'bun run --filter=@lostgradient/cinder validate',
    argsPreview: { package: '@lostgradient/cinder' },
  }}
  env={['DATABASE_URL', 'OPENAI_API_KEY']}
  policyVersion="policy-2026-06"
  idempotencyKey="approval-01JZ8T"
  state="pending"
  onResolve={(resolution) => console.log(resolution)}
/>
```

`ApprovalCard` is fully controlled. It does not execute commands, apply patches, persist policy decisions, or read environment values. The component only renders the supplied context and invokes callback props for host-owned actions.

## Resolution callback

`onResolve` is the single decision contract. It fires for every action — Approve, Approve with edits and Deny — with the complete `ApprovalResolution` payload: the selected `decision`, parsed `editedArgs` for edited approvals, the approver's note as `reason` (saved with the decision; when denying, the agent reads it as the reason), and the `remember` checkbox state. Action buttons render only while the request is actionable and `onResolve` is wired; a card without the callback is purely presentational.

`decision: 'deny'` means the approver actively refused the operation. `decision: 'cancel'` is for a host that dismisses the prompt without a decision, such as on Escape; the component draws no Dismiss button, so Approve is the only primary action and Deny the only other one.

## The shared approval row

`layout="row"` is the one approval row used in a chat transcript and beneath a tool call in a step rail. It sits on a neutral raised surface, never a warning fill, and the risk glyph carries the alert.

```svelte
<script lang="ts">
  import { ApprovalCard } from '@lostgradient/cinder';
</script>

<ApprovalCard
  layout="row"
  question="Refund order 4471 for $42.00?"
  tool={{ name: 'issue-refund', label: 'Issue refund', risk: 'high', irreversible: true }}
  source="Tool runner"
  requestedAt="2026-11-02T10:38:00.000Z"
  consequence="Sends $42.00 back to the original card"
  operation={{
    kind: 'other',
    argsPreview: { orderId: 4471, amount: '$42.00', reason: 'Arrived damaged' },
  }}
  policyVersion="policy-2026-06"
  idempotencyKey="approval-row-4471"
  state="pending"
  onResolve={(resolution) => console.log(resolution)}
/>
```

- The title is the question and wraps; it never truncates.
- Line two reads the tool's `label`, its `name` as a small monospaced identifier, the risk word (Reads, Changes things or Dangerous, muted regular text, never red), "Can't be undone" when `tool.irreversible`, then "Approval from `source`" and the time it was asked ("4 min ago"; `sourcePrefix` replaces "Approval from" in every layout). The line wraps between its pieces and never inside one: each piece keeps the comma that follows it, so "Can't be undone" and "4 min ago" are never cut off or split from their comma. In a card narrower than 40rem, who asked and when move to their own line. Omit `tool.label` when the call above the row already names the tool.
- `consequence` is one muted line below it, such as "Sends $42.00 back to the original card".
- The Input disclosure shows a chevron, a bold "Input" and the arguments as one inline line of pairs ("Order ID 4471, Amount $42.00, Reason Arrived damaged"), cut with an ellipsis only if it must. Opening it shows the command, the touched files and a `PayloadInspector` labelled Input in its Fields view.
- "Add a note" is a quiet button at the start of the actions row that opens a "Note" field and moves focus into it. The note is closed by default in every layout and stays open once opened. It is sent as `reason` with Approve and with Deny.
- Pass `rememberScope` ("the rest of this chat") to offer "Allow `label` for the rest of this chat" as a checkbox on its own line before Deny and Approve; checking it sets `remember`. Leave it out for a tool set to Always, which never offers it.
- Deny is secondary and Approve is the only primary action. In a card narrower than 32rem, and on a touch screen, Deny and Approve are equal-width 44px targets under "Add a note".
- `disabledReason` turns Deny and Approve off while the approval is pending and writes the reason above the actions; both buttons go inert with `aria-disabled`, so they stay focusable, and name the reason with `aria-describedby`. "Add a note" and Input stay available.

A decided approval stays in the transcript as a decision in neutral text: `state="denied"` with `decidedBy="you"` and `decidedAt` reads "Denied by you, 10:40 AM", with no decision buttons and no error colour. The row reads the question, the tool line, the Input summary, then the decision, so the decision is the last thing under what was asked. An approval decided on another page while this one was open adds `decidedIn`, and the row collapses to what became of it: a check (or, for a denial, the neutral prohibition glyph) in place of the risk shield, the question, and "Approved by you in Reviews, 10:46 AM" under it, with no tool line, no Input summary and no dot.

## The explicit decision

`layout="decision"` is the approval a transcript asks the person to decide, and the receipt it leaves behind. It has no icon gutter. The action is the title (`question`), with a danger "Can't be undone" badge beside it when `tool.irreversible` is true. The host's `facts` (Target, Amount, anything else with an optional `monospace`) form the compact metadata list; tool identity is already carried by the surrounding approval step, and the always-visible command is presented as readable monospaced code with an accessible label but no redundant visible `Command` row. `pauseSentence` remains accepted for callers that share approval props, but the decision surface does not repeat a generic pause explanation. The rest of the input (touched files, a patch diff, the arguments) sits behind an Input disclosure, and `why` adds a "Why the agent wants to do this" disclosure. Arguments that only repeat a fact shown in the open (the command, the target, the tool) get no Input disclosure. Once decided, the title says what was decided instead of repeating the question: the primary action's label (or the tool's label or name) and the Target fact, such as "Refund $42.00, order 4471" beside the Approved badge, with the outcome spoken first to assistive technology. An expired or cancelled approval reads "Expired before a decision: Refund $42.00, order 4471". Below 20rem each fact stacks its label above its value.

- The live countdown shows while `expiresAt` is ahead: "Expires in 4m 10s" under an hour, "Expires in 3 h" under a day, and the deadline itself ("Expires Thu Nov 20, 9:30 AM") beyond that. Add a note, `rememberScope`, `failure`, `disabledReason` and `footnote` behave as they do in the row.
- Actions are Deny as the secondary button on the left and the primary on the right. `approveLabel` names the primary ("Refund $42.00"); it reads "Approve" by default.
- An irreversible primary arms first. The first press turns it into a danger button that reads "Press again to refund $42.00" and writes "Reverts in 3 seconds." under the actions. The keyboard-only instruction "Escape cancels." remains in the accessibility description. The second press commits. Three seconds, Escape, a new request, a `disabledReason` or unmounting all revert it without committing. Escape is handled (the event is default-prevented) only while armed, so a host that closes the surrounding surface on Escape can check `defaultPrevented`. Deny never arms.
- A decided approval stays as a receipt: a check badge (a neutral prohibition glyph for a denial) and the action, then "by Priya Raman in Reviews, 10:46 AM" with `decidedBy`, `decidedIn` (a link when `decidedInHref` is set) and `decidedAt`. A denial quotes its `decisionNote` inline; an approval keeps the note, the `result` and the command behind a Details disclosure. A comma, never a middle dot, separates the parts.

## The approval's own page

`layout="detail"` is the approval on its own page, such as a review. It reads top to bottom as an eyebrow with the risk glyph (`eyebrow`, "Tool approval" by default), the question, who asked and how long it has waited ("Asked by Tool runner in a chat, waiting 4 min"; `sourcePrefix` replaces "Asked by"; `sourceHref` and `sourceInHref` write the source and the place as links, and `sourceIn` names the place), what the source said as a collapsed line (`said`: "Tool runner said Order 4471 is $42.00…", one line cut with an ellipsis that opens in place), the `context` snippet, the tool ("It wants to run Issue refund `issue-refund`, Dangerous"; `toolPrefix` replaces the opening words), the Input block with its Fields and JSON switch, and one line with the risk glyph that carries "Can't be undone." and `consequence`. A `failure` sits under that line, then the optional `rememberScope` checkbox, one actions row with Add a note at its start and Deny and Approve at its end, and the `footnote`. It has no Details disclosure.

Once decided, the green outcome line leads ("Approved by you 10:33 AM today, Tool runner in a chat", with the chat a link when `sourceInHref` is set and the day word "today", "yesterday" or the date after the time), only an approval is green and a denial stays neutral text, and `result` follows the Input block. A read-only approval says nothing more than its outcome unless there is a `notice`, an expiry or an `unavailableReason` to add.

`decisionNote` writes the note the approver left under the outcome, in any layout: "Your note Check the carrier's claim first. Sent to the agent as the reason." for a denial. `view` is bindable, so a page can hold one Fields and JSON choice and give it to every card on it.

## Answers in flight, failed answers and read-only approvals

The host owns the answer, so it tells the card where the answer stands:

- `resolving="approve"` writes "Approving…" with a spinner on Approve and turns Deny off; `resolving="deny"` does the same for Deny ("Denying…"). The note and the checkbox stop taking changes, the approval stays pending, and a second press is ignored until the host clears `resolving`.
- `failure={{ summary, detail }}` writes a tinted, bordered danger message (an `Alert`, announced as it appears: "Couldn't approve. Interborough couldn't reach the agent. Nothing was refunded.") below the input, with the summary in bold. Nothing was decided, so Deny and Approve stay live and Approve is the retry; the card draws no second "Try again".
- An approval that passed its `expiresAt` is `expired`: read-only, with no Deny or Approve, and a notice that says when it expired in the viewer's time zone ("This approval expired at 10:15 AM CST, the time its request set."). Pass `notice` to write your own sentence for any read-only approval, such as what was refunded or what happened elsewhere.
- `result` writes what a decided approval led to ("Result: Refunded $18.50 to the original card."), and `decidedIn` says where it was decided when that was not here ("Approved by you in Reviews at 10:44 AM", with `decidedBy` and `decidedAt`). In the `card` layout a decision made elsewhere replaces the whole card with a check glyph, that sentence and one more: "Refund order 4471 for $42.00, Issue refund." followed by `notice`, such as "The run is continuing, so this page changed. You don't need to do anything here." Nothing of the card is left to answer, so nobody answers twice.
- `footnote` writes a muted line under the buttons while the approval waits, such as what happens once you decide. It goes with the buttons.
- `context` is a snippet written above the question, such as "Test chat, this runs for real: order 4471 is refunded".

An `unavailable` approval is a held approval nobody can answer now, such as one that belongs to an agent whose plugin is disabled. The row shows the neutral word "Unavailable" at the right, the input line, and `unavailableReason` below it, with no Deny or Approve.

## Operation rendering

- `tool.name` renders in monospace as the identifier; `tool.label` is the human name written before it.
- `tool.risk` is read as a muted word (Reads, Changes things, Dangerous). One shield glyph carries the alert in amber while the approval is pending and goes quiet once it is decided; its `aria-label` names the risk level ("High risk").
- In the `card` layout the heading is the first row of the card, on the card's own fill with no band or divider: who asked and when, the question, one line with the tool and its risk word, and the consequence. Without a `question` the title is "Approval required for `name`".
- `operation.kind: 'command'` renders the command as a syntax-highlighted shell `CodeBlock`.
- `operation.kind: 'patch'` renders the supplied unified patch as a syntax-highlighted diff.
- `operation.filesTouched` renders one row per unique path, each with a copy button. Duplicate paths are collapsed.
- `operation.argsPreview` renders through `PayloadInspector`; oversized previews are replaced with a bounded truncation notice before rendering. Both layouts open the Fields view, with the exact stored JSON one click away on the Fields/JSON switch. The card names the block `<tool> arguments`; pass `inputLabel` (for example `Runs with`) to name it yourself.
- `env` renders variable names only, as plain text. Values are not accepted and are stripped if a caller accidentally passes `NAME=value`.
- Sandbox context, environment names, and the policy version / idempotency key / snapshot id all live in a single collapsed "Details" disclosure so supporting context stays out of the approver's way until they ask for it. The disclosure appears only when the host supplies a sandbox, environment names or a snapshot; a request with none of them has nothing to disclose, and the policy version and idempotency key stay with the request. The action buttons are the last element of a pending card.

## Approval states

Pending requests render action buttons. Non-pending requests render a read-only summary in neutral text; a denied approval is never drawn in an error colour. When `expiresAt` passes while `state` is still `pending`, the effective state becomes `expired`, actions disappear, and no callback fires automatically.

## Heading levels

The card title defaults to an `h3` with section headings one level deeper. Pass `headingLevel` to fit the card into the host page's document outline, matching the `Card` convention.

## Props

<!-- generated:props:start -->

| Prop | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `approveLabel` | `string` | no | — | The `decision` layout's own words for the primary action, such as `Refund $42.00`. Default `Approve`. An irreversible primary reads "Press again to refund $42.00" once armed. |
| `class` | `string` | no | — | Additional CSS classes applied to the root element. |
| `consequence` | `string` | no | — | What approving does, in one line, such as `Sends $42.00 back to the original card`. |
| `decidedAt` | `string` | no | — | When the approval was decided, as an ISO timestamp, written as a time of day after the outcome. |
| `decidedBy` | `string` | no | — | Who decided, once the approval is decided: `you`. Written as "Denied by you". |
| `decidedIn` | `string` | no | — | Where it was decided when that was not here, such as `Reviews`: "Approved by you in Reviews at 10:44 AM". |
| `decidedInHref` | `string` | no | — | Where `decidedIn` leads, written as a link in the `decision` layout's receipt: "by Priya Raman in Reviews, 10:46 AM". |
| `decisionNote` | `string` | no | — | The note the approver left with the decision, written under the outcome as "Your note", the note, and a caption saying where it went. |
| `disabledReason` | `string` | no | — | Why Deny and Approve are off while the approval is still pending. Written above the actions and named by both buttons. |
| `editableArgs` | `boolean` | no | `false` | Whether approving with edited JSON arguments is available. Default `false`. |
| `env` | `string`[] | no | — | Environment variable names only. Values are ignored if accidentally supplied as `NAME=value`. |
| `expiresAt` | `string` | no | — | Optional ISO timestamp after which a pending approval is treated as expired. |
| `eyebrow` | `string` | no | — | The small line above the question in the `detail` layout, beside the risk glyph. Default `Tool approval`. |
| `facts` | { label: `string`; monospace?: `boolean`; value: `string` }[] | no | — | Meaningful host facts the `decision` layout writes under the title, such as Target and Amount. Tool identity and the readable Command come from the approval itself. |
| `failure` | { detail?: `string`; summary: `string` } | no | — | Why the last answer did not go through, written as a red-toned inline message below the consequence. Nothing was decided, so Deny and Approve stay live; Approve is the retry. |
| `footnote` | `string` | no | — | A line of text written under the buttons while the approval is pending, such as what happens once you decide. |
| `headingLevel` | `2` \| `3` \| `4` \| `5` \| `6` | no | `3` | Heading level for the card title; section headings render one level deeper. Default `3`. |
| `idempotencyKey` | `string` | yes | — | Idempotency key that makes repeated decisions durable. |
| `inputLabel` | `string` | no | — | What the payload is called in the Input block, such as `Runs with`. Default `Input` in the row and `<tool> arguments` in the card. |
| `layout` | `"card"` \| `"row"` \| `"detail"` \| `"decision"` | no | `"card"` | Layout: the full `card`, the shared `row` (one approval inside a transcript or beneath a tool call), the approval's own `detail` page, or the explicit `decision` surface with its retained receipt. Default `'card'`. |
| `notice` | `string` | no | — | A notice written beneath a read-only approval, such as why it expired or what happened elsewhere. Without one, an approval that passed its `expiresAt` says when it expired. |
| `operation` | { argsPreview?: `unknown`; command: `string`; filesTouched?: `string`[]; kind: `"command"` } \| { argsPreview?: `unknown`; filesTouched: `string`[]; kind: `"file-write"` } \| { argsPreview?: `unknown`; diff: `string`; filesTouched?: `string`[]; kind: `"patch"` } \| { argsPreview?: `unknown`; filesTouched?: `string`[]; kind: `"other"` } | yes | — | Operation details shown to the approver. |
| `outcomeLabel` | `string` | no | — | Names the decision for a request that is not a tool approval, in place of Approved or Denied, such as `Answered` for a question: "Answered by you in Reviews at 10:44 AM". The request's question is then the sentence beneath, with no tool named. |
| `pauseSentence` | `string` | no | — | Shared approval context accepted by callers; the compact decision layout does not repeat a generic pause sentence. |
| `policyVersion` | `string` | yes | — | Policy version that produced the approval request. |
| `question` | `string` | no | — | The question the approval asks, such as `Refund order 4471 for $42.00?`. Default `Run <tool>?`. |
| `rememberScope` | `string` | no | — | Offers "Allow <tool> for <scope>" as a checkbox on its own line before Deny and Approve, with the scope written after "for", such as `the rest of this chat`. Leave it out for a tool set to Always. |
| `requestedAt` | `string` | no | — | When the approval was asked, as an ISO timestamp. Written as relative time ("4 min ago") while the approval is pending. |
| `resolving` | `"approve"` \| `"deny"` | no | — | The answer that is on its way: `approve` writes "Approving…" with a spinner on Approve, `deny` writes "Denying…" on Deny, and both buttons, the note and the checkbox turn off until the host clears it. |
| `result` | `string` | no | — | What the approval led to, once it is decided: written as "Result: Refunded $18.50 to the original card.". |
| `said` | `string` | no | — | What the source said when it asked, in the `detail` layout: a collapsed line under who asked, "Tool runner said Order 4471 is $42.00…", that opens in place to the whole text. |
| `sandbox` | { name: `string`; provider: `string`; workingDir: `string` } | no | — | Optional sandbox context in which the operation will run. |
| `snapshotId` | `string` | no | — | Snapshot identifier for the pending approval context. |
| `source` | `string` | no | — | Who asked, written after the source prefix: `Tool runner`, or `the agent`. |
| `sourceHref` | `string` | no | — | Where the source's name leads, in the `detail` layout: the name is written as a link ("Asked by Tool runner in a chat"). |
| `sourceIn` | `string` | no | — | Where it was asked, written after "in" in the `detail` layout, such as the chat's title: "Asked by Tool runner in Please refund order 4471". |
| `sourceInHref` | `string` | no | — | Where `sourceIn` leads, written as a link in the `detail` layout. |
| `sourcePrefix` | `string` | no | — | The words before `source`. Default `Approval from`, or `Asked by` in the `detail` layout. |
| `state` | `"pending"` \| `"approved"` \| `"approved_with_edits"` \| `"denied"` \| `"expired"` \| `"cancelled"` \| `"unavailable"` | yes | — | Persisted approval state. |
| `tool` | { irreversible?: `boolean`; label?: `string`; name: `string`; risk: `"low"` \| `"medium"` \| `"high"` } | yes | — | Tool requesting approval. |
| `toolPrefix` | `string` | no | — | The words before the tool in the `detail` layout: "It wants to run Issue refund `issue-refund`, Dangerous". Default `It wants to run`. |
| `unavailableReason` | `string` | no | — | Why an `unavailable` approval cannot be answered now, written beneath it. |
| `view` | `"fields"` \| `"json"` | no | `"fields"` | Which view of the arguments the Input block shows, Fields or JSON. Bindable, so one switch can govern every payload on a page. Default `fields`. |
| `why` | `string` | no | — | Why the agent wants to do this, written by the host and offered in the `decision` layout as a disclosure named "Why the agent wants to do this". |
| `context` | `(opaque)` | no | — | A line of context written above the question, such as "Test chat, this runs for real". Not expressible in JSON Schema; see the component types for the signature. |
| `onAskAgain` | `(opaque)` | no | — | Requests a fresh approval after this one has expired in the decision layout. Not expressible in JSON Schema; see the component types for the signature. |
| `onResolve` | `(opaque)` | no | — | Called for approve, approve-with-edits, and deny with the complete resolution payload. Not expressible in JSON Schema; see the component types for the signature. |

<!-- generated:props:end -->

## CSS Variables

<!-- generated:variables:start -->

This component does not declare any local CSS variables.
<!-- generated:variables:end -->

## Subcomponents

<!-- generated:subcomponents:start -->

None.

<!-- generated:subcomponents:end -->
