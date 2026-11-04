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
- Line two reads the tool's `label`, its `name` as a small monospaced identifier, the risk word (Reads, Changes things or Dangerous, muted regular text, never red), "Can't be undone" when `tool.irreversible` (it never breaks across lines), then "Approval from `source`" and the time it was asked ("4 min ago"). In a card narrower than 40rem, who asked and when move to their own line.
- `consequence` is one muted line below it, such as "Sends $42.00 back to the original card".
- The Input disclosure shows a chevron, a bold "Input" and the arguments as one inline line of pairs ("Order ID 4471 · Amount $42.00 · Reason Arrived damaged"), cut with an ellipsis only if it must. Opening it shows the command, the touched files and a `PayloadInspector` labelled Input in its Fields view.
- "Add a note" is a link that opens a "Note (optional)" field. The note is sent as `reason` with Approve and with Deny.
- Pass `rememberScope` ("the rest of this chat") to offer "Allow `label` for the rest of this chat" as a checkbox on its own line before Deny and Approve; checking it sets `remember`. Leave it out for a tool set to Always, which never offers it.
- Deny is secondary and Approve is the only primary action. In a card narrower than 32rem, and on a touch screen, Deny and Approve are equal-width 44px targets under "Add a note".
- `disabledReason` turns Deny and Approve off while the approval is pending and writes the reason above the actions; both buttons name it with `aria-describedby`. "Add a note" and Input stay available.

A decided approval stays in the transcript as a decision in neutral text: `state="denied"` with `decidedBy="you"` and `decidedAt` reads "Denied by you · 10:40 AM", with no decision buttons and no error colour.

An `unavailable` approval is a held approval nobody can answer now, such as one that belongs to an agent whose plugin is disabled. The row shows the neutral word "Unavailable" at the right, the input line, and `unavailableReason` below it, with no Deny or Approve.

## Operation rendering

- `tool.name` renders in monospace as the identifier; `tool.label` is the human name written before it.
- `tool.risk` is read as a muted word (Reads, Changes things, Dangerous). One shield glyph carries the alert in amber while the approval is pending and goes quiet once it is decided; its `aria-label` names the risk level ("High risk").
- In the `card` layout the header stacks who asked and when, the question, the tool line, the risk line and the consequence on a neutral surface. Without a `question` the title is "Approval required for `name`".
- `operation.kind: 'command'` renders the command as a syntax-highlighted shell `CodeBlock`.
- `operation.kind: 'patch'` renders the supplied unified patch as a syntax-highlighted diff.
- `operation.filesTouched` renders one row per unique path, each with a copy button. Duplicate paths are collapsed.
- `operation.argsPreview` renders through `PayloadInspector`; oversized previews are replaced with a bounded truncation notice before rendering. The card shows the exact JSON an approver signs off on; the row opens the Fields view.
- `env` renders variable names only, as plain text. Values are not accepted and are stripped if a caller accidentally passes `NAME=value`.
- Sandbox context, environment names, and the policy version / idempotency key / snapshot id all live in a single collapsed "Details" disclosure so supporting context stays out of the approver's way until they ask for it. The action buttons are the last element of a pending card.

## Approval states

Pending requests render action buttons. Non-pending requests render a read-only summary in neutral text; a denied approval is never drawn in an error colour. When `expiresAt` passes while `state` is still `pending`, the effective state becomes `expired`, actions disappear, and no callback fires automatically.

## Heading levels

The card title defaults to an `h3` with section headings one level deeper. Pass `headingLevel` to fit the card into the host page's document outline, matching the `Card` convention.

## Props

<!-- generated:props:start -->

| Prop | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `class` | `string` | no | — | Additional CSS classes applied to the root element. |
| `consequence` | `string` | no | — | What approving does, in one line, such as `Sends $42.00 back to the original card`. |
| `decidedAt` | `string` | no | — | When the approval was decided, as an ISO timestamp, written as a time of day after the outcome. |
| `decidedBy` | `string` | no | — | Who decided, once the approval is decided: `you`. Written as "Denied by you". |
| `disabledReason` | `string` | no | — | Why Deny and Approve are off while the approval is still pending. Written above the actions and named by both buttons. |
| `editableArgs` | `boolean` | no | `false` | Whether approving with edited JSON arguments is available. Default `false`. |
| `env` | `string`[] | no | — | Environment variable names only. Values are ignored if accidentally supplied as `NAME=value`. |
| `expiresAt` | `string` | no | — | Optional ISO timestamp after which a pending approval is treated as expired. |
| `headingLevel` | `2` \| `3` \| `4` \| `5` \| `6` | no | `3` | Heading level for the card title; section headings render one level deeper. Default `3`. |
| `idempotencyKey` | `string` | yes | — | Idempotency key that makes repeated decisions durable. |
| `layout` | `"card"` \| `"row"` | no | `"card"` | Layout: the full `card`, or the shared `row`, one approval inside a transcript or beneath a tool call. Default `'card'`. |
| `operation` | { argsPreview?: `unknown`; command: `string`; filesTouched?: `string`[]; kind: `"command"` } \| { argsPreview?: `unknown`; filesTouched: `string`[]; kind: `"file-write"` } \| { argsPreview?: `unknown`; diff: `string`; filesTouched?: `string`[]; kind: `"patch"` } \| { argsPreview?: `unknown`; filesTouched?: `string`[]; kind: `"other"` } | yes | — | Operation details shown to the approver. |
| `policyVersion` | `string` | yes | — | Policy version that produced the approval request. |
| `question` | `string` | no | — | The question the approval asks, such as `Refund order 4471 for $42.00?`. Default `Run <tool>?`. |
| `rememberScope` | `string` | no | — | Offers "Allow <tool> for <scope>" as a checkbox on its own line before Deny and Approve, with the scope written after "for", such as `the rest of this chat`. Leave it out for a tool set to Always. |
| `requestedAt` | `string` | no | — | When the approval was asked, as an ISO timestamp. Written as relative time ("4 min ago") while the approval is pending. |
| `sandbox` | { name: `string`; provider: `string`; workingDir: `string` } | no | — | Optional sandbox context in which the operation will run. |
| `snapshotId` | `string` | no | — | Snapshot identifier for the pending approval context. |
| `source` | `string` | no | — | Who asked, written after "Approval from": `Tool runner`, or `the agent`. |
| `state` | `"pending"` \| `"approved"` \| `"approved_with_edits"` \| `"denied"` \| `"expired"` \| `"cancelled"` \| `"unavailable"` | yes | — | Persisted approval state. |
| `tool` | { irreversible?: `boolean`; label?: `string`; name: `string`; risk: `"low"` \| `"medium"` \| `"high"` } | yes | — | Tool requesting approval. |
| `unavailableReason` | `string` | no | — | Why an `unavailable` approval cannot be answered now, written beneath it. |
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
