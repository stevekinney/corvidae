# Host responsibilities for an Operative-backed chat route

This document defines the constraints a host application must satisfy when it drives an agent loop on behalf of a browser chat client. It exists next to the code because violating any rule here is a **bug**, not a plan change—a leaked credential, a replayed side effect, an orphaned run, a transcript the provider will reject on the next turn.

It is deliberately not a planning document. It names no package versions, no issue numbers, and no schedule. (`wireVersion` below is a constant of the protocol this document defines, not a dependency version.) What to adopt, when, and in what order is tracked in Linear; `package.json` and `bun.lock` are the only source of truth for what is installed. Anything here that can be settled by reading the lockfile has been removed on purpose, because duplicating that state is what made an earlier version of this file go stale.

Where a rule names an API, confirm it against the declarations in this workspace before relying on it. Every `@corvidae/*` library exports TypeScript source directly, so the declaration this document describes and the one the application compiles are the same file.

<a id="state-model"></a>

## State model

The two route families have different owners and continuation rules. The stop conditions in each route and its browser transport must agree.

### Browser-owned route

For `/api/chat`, the browser owns the authoritative `ConversationHistory`. Each request sends that history to a new, ephemeral `AgentRun`, and `stopAfterAnyToolCall` ends the run after the model step and its tool executions. The chat session controller drives subsequent model steps by posting again after a resolved tool result.

Operative's `maximumSteps` bounds each individual run, so it resets on each request. The controller's `maxContinuationTurns`, which defaults to 5, bounds the number of follow-up requests for a user turn. Both limits matter, but configuring the agent alone does not bound this browser-driven sequence. The stateless contract in the sections below describes this route family.

### Server-owned route

For `/api/server-owned/conversations/[id]/stream`, the session store owns the authoritative conversation. The browser posts the new user text, and one durable Operative run drives the model and tool steps for that turn. This route passes `stopWhen: [stopWhen.noToolCalls()]` and deliberately omits `stopAfterAnyToolCall`; `maximumSteps` bounds the multi-step run. Approval pauses execution inside the run through elicitation, then the same run continues after the answer.

The browser keeps a rendering mirror of the server conversation. Its controller may invoke the transport after a resolved tool result, and there are two ways to keep that from reposting the turn. The controller's own `executionOwner` option is the declared one: set to `'server'`, `shouldStopAfterTurn` ends the submission the moment the stream closes, without consulting what the turn contained. A transport that does not set it stays browser-owned and must defend itself, which this route's transport does: a call whose last conversation message is not user text returns an empty stream and makes no HTTP request. Either way the browser must neither repost the previous user text nor start another model run, and the browser's continuation cap does not bound this family's server-side model steps.

Both families emit terminal run frames, the client codec decodes them, and the session controller now reconciles the conversation they carry. It is applied once, after the stream closes, against whatever is on screen rather than installed over it. In the server-owned family, loading the route again reads the authoritative session-store history.

<a id="conversation-ownership"></a>

## Conversation ownership

In the browser-owned family, the browser creates, renders, and stores `ConversationHistory`, and sends `{ conversation }` to `/api/chat`. The server validates that boundary before passing the value to the run. In the server-owned family, the session store owns history and the browser posts only the new user text; the loaded and streamed browser history is a rendering mirror.

Operative snapshots the input. It must never mutate the object supplied by the request parser, and the browser must never assume its posted object is updated remotely. During a streamed run, wire events extend the browser's copy, and the terminal frame settles it: `run.completed` is recorded rather than reduced as it arrives, and `mergeRunHistory` reconciles the serialized final conversation once the stream has closed. Recording rather than applying is what stops a frame arriving after the terminal from being reduced into a history the terminal has already replaced.

The reconciliation is authoritative about **this run's rows and nothing else**. It is guarded like every other installation: a terminal that arrives after a cancel, a navigation, or a newer accepted snapshot has nothing left to be authoritative about, and is dropped. A user cancellation is checked before that guard rather than after, because cancelling retires the run's token; a staleness check alone would swallow the case and leave the row the turn was streaming into flagged as streaming forever.

System instructions belong to the agent definition. The browser-owned route does not append them again when resuming from `{ conversation }`—the posted history already carries the accumulated context. The server-owned route reads its accumulated history through the session handle.

In the browser-owned park-and-resume path, approval resume changes one existing message: the resolved result replaces the earlier `action_required` result by `callId`. Appending a second tool result for the same call is invalid, because it leaves the provider with two results for one tool call.

<a id="credential-boundary"></a>

## Credential boundary

`ANTHROPIC_API_KEY` stays server-side. Provider constructors are called only in server modules. No `.svelte` file, browser bundle, NDJSON frame, transcript message, error message, or log may contain the provider credential or the toolbox approval secret.

The browser may hold a signed pending-approval descriptor. That descriptor is a capability for one represented action—not the signing secret, and not general tool authority.

<a id="toolbox-and-approval-ownership"></a>

## Toolbox and approval ownership

The host creates **one module-scoped `Toolbox`** and passes that exact instance to the agent. Building a fresh toolbox per request breaks `toolbox.resumeApproval(signedApproval)`, because only the instance configured with the signing `approvalSecret` can verify the token.

The secret must stay stable at least as long as an approval descriptor can be resumed, and every server instance that may accept a resume request must use the same secret. A process-random secret is acceptable only as a documented local-development limitation where a restart invalidates pending approvals; it is not the deployable contract.

The browser-owned agent parks by combining a pending-approval stop condition with a no-tool-calls stop condition and `stopAfterAnyToolCall`. The first stops after an approval-gated result; the second ends an ordinary text response instead of running to `maximumSteps`.

The server never trusts a client-edited approval descriptor. The resume route validates its shape and lets the toolbox verify the signature before execution. **Signature validity is necessary but not sufficient**: the host atomically consumes each signed capability before the side effect begins. A second submission returns the already-recorded outcome or a deterministic consumed-capability response—it never calls `resumeApproval()` again. The deployable contract therefore includes a shared consumed-capability ledger keyed by the descriptor's stable identity. A process-local ledger is a local-development limitation and must never be presented as replay protection across restarts or instances. Signature verification comes from the toolbox; the ledger and its idempotency are host responsibilities.

In the browser-owned family, every tool that can cause a non-reversible external effect must use that approval-and-consumption path. The server-owned family uses the elicitation contract below. A tool may run unapproved only when it is read-only, safely replayable, or protected by a host-owned idempotency key claimed atomically before the effect and reused across retries of the same user intent. A fresh model-generated `toolCallId` is not sufficient, because a retry may generate a different call for the same action.

### Two approval paths, and which one a consumer should reach for

Operative supports approval in two places, and the choice is decided by who owns the run rather than by taste.

**Park and resume, through the toolbox.** The tool declares `policy.beforeExecute` answering `needs_approval`; armorer mints a signed descriptor of the call; the run STOPS; the client sends the descriptor back on a later request and `toolbox.resumeApproval()` verifies it before the effect. Everything about the pending decision travels in that token, so the server holds nothing between the two requests—which is what makes it survive a restart, a load balancer, and a client that waits an hour before answering. This is the canonical browser-owned path, and it is the one to reach for by default.

**Elicit, through the loop.** A `beforeToolExecution` hook calls `ctx.elicit(message, schema)`; the host's `onElicitation` callback answers; the run WAITS inside the step rather than stopping. The decision never becomes a token, so nothing has to be signed, verified, or ledgered—and nothing survives the process either. A pending question is pinned to the one server holding the promise.

The trade is not about ergonomics. It is:

|  | Park and resume | Elicit in the loop |
| --- | --- | --- |
| Pending state lives | in a signed token the client holds | in the process holding the run |
| Survives a restart | yes | no, the question dies with the run |
| Survives more than one instance | yes, with a shared consumed-capability ledger | no |
| Replay protection needed | yes: signature plus an atomic consumed-capability claim | no: there is no token to replay |
| The run, while waiting | stopped; the client starts the next turn | parked mid-step; the client answers out of band |
| A denial | a tool result the model sees; the conversation continues | the hook drops the call, Operative seals it with an error result, the run completes |

So: **a stateless route owning no run state should park and resume. A route that already owns the run server-side, where the client cannot restart a turn, should elicit.** The server-owned variant below is the second case, and it is not a preference—the park is unreachable there. A continuation there carries no user turn to send, because the last conversation message on that call is a tool result, so the token would be minted and then have nowhere to go. (The transport answers such a call with an empty stream rather than rejecting it; see the continuation rule below. It used to throw, which was right while the toolbox was empty and became destructive once a tool could succeed.)

Two properties of the elicitation path are worth stating because they are not obvious from the type signatures:

- `ctx.elicit` returns `T | null` and never throws. A denial is `null`, and what it means is the hook's decision. `ElicitationDeniedError` is a different thing—the shape a denial takes when a _tool_ throws on one, reconstructed by the durable run adapter—and it is a run terminal. A hook that filters the call out instead is not.
- **A denied call reports no result of its own, so the host supplies one.** Operative seals the filtered call with an error result in the CONVERSATION—enough that a later replay is not left with a dangling tool call—but dispatches no tool event. The client renders a pending tool row from the `tool_call` frame and resolves it on a result, so without one that row stays pending until another turn or a reload clears it. A gate whose "no" is invisible is worse than no gate.

  So the pump settles it: any call a step leaves without a result gets an `outcome: 'error'` `tool_result` frame, written in the same loop that writes the calls. That placement is the whole trick—a first attempt wrote the frame from the `beforeToolExecution` hook, which runs BEFORE the step's `tool_call` frames reach the wire, so the result described a call the client had not seen and was dropped. The message stays generic (`This call did not run, and reported no result.`) because the pump knows a result is missing but not why.

Two consequences for the run's shape, both of which cost a review round to find:

- **The server-owned family must not stop after a tool call.** `stopAfterAnyToolCall` hands control back to a client that drives the next turn, which is the browser-owned contract. Under elicitation the approval happens mid-step, so stopping there leaves a tool result with no reply after it—and the session controller's continuation attempt then fails the very turn the tool succeeded in. Dropping the condition lets the loop reach a second generate and deliver one complete turn.
- **A continuation request has nothing to fetch, and must not throw.** The controller re-runs the transport whenever a turn ends with every tool call resolved. In this family the server already sent everything, and there is no user text to send on that call anyway, so the transport answers with an empty stream. Throwing there was right while the toolbox was empty and a continuation could only mean a wiring mistake; it became destructive the moment a tool could succeed.

**A multi-step response used to render out of order live, and correctly only after a reload.** On the approved-note turn, the live transcript put the second step's reply above the tool activity it was replying about, while a reload showed the server's own order:

```
live:   You … | Assistant "Saved that note."  Called 1 tool … remember_note Succeeded
reload: You … | Assistant Called 1 tool … Succeeded | Assistant "Saved that note."
```

The cause was that the session controller inserted one assistant placeholder before reading any frames, so a single response carrying two model steps wrote the second step's text back into a row that already precedes the tool activity.

The wire now delineates the steps, and the controller reads that delineation. `withAssistantStepFrames` wraps the generate function and writes `assistant.step.started` before the provider call and `assistant.step.completed` after it, each carrying the step index and `streaming.messageId`—the HOST'S identifier for the row that step's text belongs to, read before the provider emits anything. The controller opens a row on `started` and settles it on `completed`, and only for the step that is actually open, so a late or duplicated completion cannot finalize the row the next step is streaming into. The persisted order a reload renders is unchanged; the live order now agrees with it.

**Every gated call needs its own decision, and every decision needs to name its call.** A step can carry more than one approval-gated call—the stop condition runs after a step and never constrained that—so the hook elicits per call rather than once. And because `ctx.elicit` carries no call identity, the answer has to: a click that lands after its own run ended would otherwise settle whatever question is pending next. The host's answering endpoint requires the call id it displayed and compares it in the same step that settles.

### How a client learns a question exists

**On the stream, on the connection that is already open.** `elicitation.requested` raises a question and `elicitation.resolved` takes it away, and nothing else removes one.

This is worth stating plainly because the previous answer was a 250 ms `GET …/elicitation` poll, and the poll is gone. Under it, the component learned that a question had been raised—or answered elsewhere—by asking rather than by being told: a client whose reads could not get through had a run parked on a question it would never show, every other client learned about one up to a full interval late, and a question answered elsewhere left stale controls on screen offering a decision that could no longer be made.

Two things about that replacement are load-bearing:

- **The answering channel is still a separate request.** `POST …/elicitation` carries `{ approved, callId }`. An answer travels out of band under either design, so nothing was lost there.
- **The `GET` remains, demand-driven, and decides nothing.** The frame carries the question's identity and its sentence—everything needed to show it and to answer it—but has no field for the model's proposed arguments. So the sentence renders from the frame immediately and the disclosure of what is being approved fills in when the read lands. A read naming a different call, or no call at all, is ignored rather than applied: a read issued the instant a question is raised can answer `null` if the server settles it in between, and letting that clear the prompt would put removal back in the hands of the channel this change exists to take it away from. The only other read is a re-read after a `409`.

The controls do not wait on that read. Gating Approve and Deny on it would put the side channel back on the critical path, showing a person a question they could not act on.

One consequence is not obvious. **Replacing one question with another is two frames now, not one.** The poll reported a replacement as a single event: a different `callId` came back, focus was still on Approve, and it could be moved straight to the new question. On the stream it is `elicitation.resolved` for the old question and then `elicitation.requested` for the new one. The first hands focus to the transcript, so by the time the second arrives focus is no longer inside the approval region and a naive handoff would decline to move it, leaving the person in the transcript mid-decision. The surface therefore remembers that the transcript holds focus because it put it there, and reclaims it for the replacement. Focus the person moved themselves is never taken.

A frame with no `toolCallId` names no call, and the answering `POST` is keyed on exactly that, so the surface leaves it to the side channel rather than showing a question nobody could answer.

<a id="stream-wire-contract"></a>

## Stream wire contract

UTF-8 NDJSON, `Content-Type: application/x-ndjson; charset=utf-8`. Every frame is one complete JSON object followed by `\n`; an object never spans lines. The route projects event data into JSON-safe values explicitly rather than calling `JSON.stringify()` on an `Event` instance and hoping its fields are enumerable.

Each frame carries a `wireVersion`, a request-local monotonically increasing `sequence`, a `type`, and the event-specific payload.

### Versions

**The wire is at version 2, and version 2 is a superset of version 1.** `WireEnvelope` accepts `1 | 2`. A separate `V2WireEnvelope` is pinned to `2` and is declared on exactly the members version 2 introduced, which is what makes "this frame did not exist before version 2" a type error rather than a convention: a version 1 producer cannot construct an `assistant.step.*` or `elicitation.*` frame at all. `requireV2Envelope` enforces the same thing at decode time, so a frame claiming version 1 on a version 2 member is rejected rather than accepted with a decorative version field.

Version 1 still decodes unchanged, and the version is CARRIED rather than normalized: a frame that arrived as version 2 re-encodes as version 2, and a consumer reading a decoded event can tell which vocabulary produced it.

Three members—`text`, `tool_call`, `tool_result`—predate the envelope and may still arrive bare. For them the envelope is optional but **all-or-nothing**: a frame carrying `wireVersion` without `sequence`, or the reverse, is neither the bare legacy format nor a valid versioned frame, and is rejected. `WithOptionalEnvelope<T>` encodes that in the public type with `?: never` keys on the bare branch, because excess-property checking alone would let a half-envelope typecheck against it.

**Mixed versions within one stream are rejected at stream level**, not per frame, and that placement is the point. Version 2 being a superset means every frame in a mixed stream is individually well-formed, so no single decode can catch it. A consumer that read the opening frame as version 1 and then meets a version 2 frame has been told two different things about which vocabulary it is reading, and the stream guard is the only place that is visible. The same guard holds the stream to one envelope mode—wholly bare or wholly versioned—for its whole length.

### Members

| Event types | Browser responsibility |
| --- | --- |
| `stream:text-delta` | Append `content` to the active assistant message and push the same delta as a token. |
| `stream:tool-call-start`, `stream:tool-call-delta`, `stream:tool-call-complete` | Render tool activity as request-local provisional state; stage the complete call, but do not append it to authoritative history yet. |
| `tool.started`, `tool.progress`, `tool.settled`, `tool.error`, `tool.policy-denied` | Render execution progress. Once a result exists, append the staged call and its result as one update keyed by `toolCallId`. A paused result may carry a descriptor. |
| `assistant.step.started` (v2) | Open a row for this model step, identified by the host's `messageId`. Text that follows belongs to that row. |
| `assistant.step.completed` (v2) | Settle the open row, and ONLY if `step` is the one currently open. A late or duplicated completion must not finalize the row the next step is streaming into. |
| `elicitation.requested` (v2) | Show the question. `requestId` is the host's identifier for it, minted once. `toolCallId` is optional; a frame without one names no call and cannot be answered. |
| `elicitation.resolved` (v2) | Clear the question with the SAME `requestId`, and no other. This reports the human's response; it is not tool settlement, which still arrives as its own result. |
| `run.completed` | Record the final conversation and terminal result; reconcile once the stream closes, then finalize the placeholder. The only successful terminal frame. |
| `run.error`, `run.tripwire` | Preserve committed call/result pairs, discard unresolved staged calls, apply the error contract, cancel the placeholder, end the turn. |
| `run.aborted` | Discard every staged call and unresolved mutation from this run, then apply the cancellation contract without presenting an adapter failure. |

`elicitation.resolved` reporting an answer rather than a settlement is the distinction this vocabulary exists to keep. A denied call still settles afterwards through its own `tool.settled`/`tool_result` frame saying the tool did not run. A client that read a resolution as a settlement would close the call's row on an answer rather than on a result, and would have nothing at all to show for a question answered while its tool was still executing.

Events from the streaming target and the run iterator enter **one request-local sequencer** before encoding, so their relative order is explicit rather than dependent on two consumers racing to call `controller.enqueue()`.

The enhanced-streaming event target must also be **request-local**. `EventTarget` dispatch is broadcast, so a module-scoped target cannot distinguish overlapping requests unless every event carries a stable public run identifier and the listener filters on it before sequencing. Arrival time, listener registration order, and conversation identity are not sufficient provenance.

Exactly one terminal frame is written when the connection remains available, and the server closes the stream immediately after it. EOF without a terminal frame is a truncated response—a transport failure, not success. A frame arriving after the terminal one is a protocol violation rather than a late no-op, and bytes already buffered past the terminal count even before they form a complete line. Client cancellation is the exception, because the client deliberately stopped reading and cannot receive the terminal frame; a consumer that stops iterating calls the generator's `return()`, which never reaches the EOF assertions, so that exemption needs no extra bookkeeping.

The same stream-level guard applies to a transport that returns decoded events rather than bytes. Without it, a typed iterable that ends without a terminal frame, runs its sequence backwards, or switches envelope mode mid-stream would be accepted while the identical NDJSON response is rejected, and the contract's validity would depend on the transport's representation.

<a id="cancellation-contract"></a>

## Cancellation contract

One causal chain:

```text
ChatAdapter.stopGenerating()
  -> AbortController.abort()
  -> fetch signal aborts and the response reader cancels
  -> ReadableStream.cancel()
  -> AgentRun.abort('user cancelled')
  -> run context signal reaches the provider
  -> provider connection closes
```

The route holds the run handle before constructing the response stream, registers the incoming `Request.signal` with the run's one-shot abort-and-dispose path, calls that same path from `ReadableStream.cancel()`, and removes the request listener during cleanup. The request signal is required because a disconnect may abort the request before the client acquires or cancels the response body. **Cleanup must be idempotent**, because provider failure, normal completion, request cancellation, and stream cancellation can race.

A user stop is not an adapter error. The browser finalizes a non-empty partial assistant message, removes an empty placeholder, ends streaming, and resolves `stopGenerating()`. It does not mark the user message failed and does not populate the error banner.

Tool-call frames are provisional until a matching result arrives. On cancellation the adapter discards that request's staged calls and progress UI before the next turn can be posted. If history was already mutated, it restores the pre-run snapshot and may preserve only the non-empty partial assistant text. It must not retain a call without a result, and must not invent a provider-visible aborted result that Operative never produced—either would make the next provider transcript invalid.

<a id="error-contract"></a>

## Error contract

Three boundaries, kept separate so a denied tool never looks like a broken network request, and a broken network request never becomes permanent transcript content.

- **Request errors**: malformed JSON or an invalid body fails before streaming begins, with a non-2xx JSON response. No placeholder is committed.
- **Run errors**: provider, generation, output-validation, guardrail, budget, and runtime failures become a terminal `run.error` or `run.tripwire` frame. Operative types these two paths differently, and the host must not treat them alike. The run **event** classes carry a typed `AgentRunError` with `kind` and `code`, and ship a JSON-safe serializer for it—use that rather than inventing a parallel envelope. The terminal **result**, by contrast, still declares its error as `unknown`, so anything read from there must be narrowed by the host, for which a classification helper exists. Under either path the host decides which fields cross to the browser: it never serializes an unknown error object, and never forwards an error's `cause` unfiltered, since `cause` is untyped and may carry a credential-bearing provider payload.
- **Tool outcomes**: success, denial, and `action_required` are transcript-domain results delivered through `tool.*` events. They update the conversation and tool UI. They are not adapter errors.

### The classification the wire carries

`ChatAgentRunErrorKind` and `ChatAgentRunErrorCode` are declared structurally in the chat component rather than imported from Operative, because importing them at runtime would invert the provider-neutral layering and pull Operative's provider code into the browser bundle. Declared structurally does not mean declared loosely: `ChatAgentRunErrorCode` now carries **all fourteen members** of Operative's `AgentRunErrorCode`, and a compile-time bidirectional type-equality assertion fails the typecheck gate if either side drifts. Add or remove a member on one side only in the change that does so on the other.

Bidirectional is the requirement rather than an extra. A one-way assignability check passes with a member missing from whichever side it does not constrain, which is exactly the drift the assertion exists to catch.

`ChatSerializedRunError` is Operative's `SerializedAgentRunError` **with `cause` removed entirely**, and that removal is deliberate and permanent. The decoder rebuilds the value into exactly its declared fields rather than validating and passing the parsed object through, so nothing re-attaches an incoming `cause` by construction rather than by convention. If a redacted, JSON-safe projection of a cause is ever needed, that is a new and deliberately-named field, not this one made permissive again.

The one field ever added to that list is `retryable`, and it is carried because a client cannot derive it: a rate-limited provider and a rejected API key are both `kind: 'generate'`, and one deserves a retry button while the other never does. It is optional, and absent means the producer said nothing—which a client must render as neither retryable nor terminal rather than defaulting to either.

### Adapter behavior

The adapter rejects its active command for transport failures, malformed frames, truncated EOF, or terminal run failures. Every unsuccessful terminal path preserves committed call/result pairs but discards request-local staged calls before a retry can render or post the history.

For a client-detected protocol failure while the response is still open—malformed JSON, an unsupported `wireVersion`, an invalid `sequence`, a mixed envelope—the adapter **first** aborts its fetch controller and cancels the reader through the same idempotent stop path, so the server reaches `AgentRun.abort()`. Only then does it cancel the placeholder and mark the initiating user message failed, so the Retry affordance stays available. The decoder supports this ordering directly: `onProtocolError` is called with the rejection at the throw site, before the generator unwinds and before any producer cleanup is awaited, because a consumer whose transport needs its signal aborted to finish cleaning up would otherwise deadlock.

No automatic host retry is added. Retry policy configured on the agent is part of the loop; a user-visible retry is a new adapter command from unchanged client-owned history.

<a id="guardrails-and-context"></a>

## Guardrails and context

Guardrails and context management are agent-owned configuration. They may not move trust decisions or canonical history into the browser. A tripwire follows the terminal error-frame contract. Compaction changes the **model-visible projection**, never the browser's authoritative transcript.

<a id="lifecycle-and-disposal"></a>

## Lifecycle and disposal

The stateless route owns one agent and one run per request, and disposes the run after completion, error, or cancellation.

Module-scoped: immutable agent configuration, provider client or factory, toolbox, consumed-approval ledger. **Not** module-scoped: enhanced-streaming targets, live runs, request conversations.

Development hot-module replacement must not leave a run, provider connection, request listener, or toolbox listener orphaned.

<a id="durability-and-recovery"></a>

## Durability and recovery

The canonical path is ephemeral by design: a disconnected or restarted request does not reattach to its old run. The browser keeps conversation history, never executable run state.

### The history token, and why it counts twice

`ChatHistoryToken` is `Readonly<{ conversationId, generation, revision }>`. A host captures one before an asynchronous read and hands it back when the response carries an authoritative snapshot, so the controller can tell whether the session still looks the way the reader last saw it.

The two counters answer different questions, and collapsing them into one breaks both.

- **`revision` counts every accepted write.** A full-session snapshot replaces membership outright, so it is only safe to install while nothing has been written since it was asked for. `adoptHistory` therefore compares `revision` and refuses a snapshot that would land over any write at all.
- **`generation` counts only the events that retire outstanding work**: a new submission, a cancel, a navigation, disposal.

The run-scoped guard deliberately does **not** compare `revision`. A run writes on every delta, so a guard that did would consider the run's own first frame a reason to abandon itself. `isRunRequestCurrent` therefore checks the run token, the submission id, the conversation id, and `generation`, and nothing else. It is deliberately not a function of the abort signal either: aborting has its own handling, with a protocol-failure exemption that has to keep working, and folding the signal in here would swallow a terminal failure that aborted on its way to being reported.

A submission is what the transport identifies a turn by, so it changes exactly when the user asks for something new—a send, a retry, an edit—and must NOT change when a run continues itself after a tool resolves. A continuation is more of the same submission; only the run token moves.

### Recovered runs

Durable recovery belongs to the server-owned variant below, which must preserve the distinction between live token streaming and recovered execution—the latter may expose only step-level progress. A failed re-attach must be distinguishable in the UI from a benign "nothing to resume".

**Why step-level, precisely.** A live turn streams because the process holding the provider connection is re-encoding its deltas. A recovered run is one the engine resumed from a checkpoint: its progress is whatever the workflow writes from there, which advances a step at a time. The tokens that were in flight when the previous process died were never persisted, so there is nothing to replay. That is the reason, and it is about where events come from rather than about the handle's type.

**A recovered run is NOT a `DiagnosticAgentRun`**, contrary to what this section once implied. Checked against the declarations in this workspace: `SessionHandle.recover()` is declared `Promise<AgentRun | null>`, and the recovery path wraps the reattached run with `createAgentRun` so the caller can observe the resumed run normally. `DiagnosticAgentRun` is what `createDiagnosticAgentRun` produces on the paths that resume a run _without_ a trusted live agent definition, and nothing on the session path calls it.

(An earlier version of this paragraph explained the choice by saying `SessionHandleContext.runOptions` is required. It is not—it is declared optional, and the recovery path reads it only to forward `childRegistry`. The conclusion is unchanged and now rests on the call itself rather than on that premise.)

The difference between the two shapes is smaller than it sounds, and in one place larger:

- `output()` is absent from `AgentRun` at the default `H = false` anyway, so its absence from `DiagnosticAgentRun` is not a distinction a `recover()` caller could ever observe.
- `unwrap()` is the accessor they genuinely differ on. At `H = false` it resolves to `Promise<string>`—plain text, no schema validation—so its presence on a recovered handle is a mild hazard at most.
- `closed()` is the difference with teeth. `DiagnosticAgentRun` downgrades a wrapped `'completed'` to `{ status: 'unresolved', reason: 'unknown-effect' }`, because durability is undeterminable from a recovered wrapper. The session path passes that status through unchanged, so a run recovered through `recover()` can report a durable boundary the wrapper cannot vouch for. This is a declared gap on the Operative side rather than something the host can close.

`server-owned-recovery-contract.test.ts` pins the declared `recover()`, `unwrap()`, `output()`, and `result()` members at the type level, so changes to those declarations break the build. The `closed()` distinction above describes runtime behavior; this type test does not enforce it.

### The synchronization snapshot

The detail route also exposes a no-store synchronization snapshot containing `id`, `title`, the full native `ConversationHistory`, and a `turnFailures` map. A failed run is recorded before its terminal wire frame: the map is keyed by the authoritative last user message from that run's result, and each value contains only the classified `kind`, `code`, the controlled user-safe reason `The assistant could not complete this turn.`, and optional `retryable` fields. The session update merges metadata atomically with first-write-wins semantics and does not refresh activity, so concurrent failures and unrelated metadata survive. If that metadata write rejects after the run's conversation is readable, a separate local `stream:error` hint preserves the failed row through later submissions until that same authoritative id is durably confirmed, or until navigation; GET and SSR remain strictly store-authoritative.

**Recovery classification is reported once.** `recover()` reconciles a stranded `running` reference as it reports the rejection, so the first ask after a restart answers `orphaned` with its failures and the second answers `nothing-to-resume`. Both are correct. A surface that showed the classification without saying so would look like it lost the answer, so the panel says it.

The kill/restart procedure, its exact commands, and the observed state at each step are in [durability-exercise.md](./durability-exercise.md).

The recovery panel starts collapsed so idle conversations retain a fixed-height chat with its own transcript scroll. When an approval question, recovery status, or failure message is visible, the page may grow and scroll; the chat keeps an `8rem` minimum block size so expanded content cannot consume the transcript and composer. Both layout selectors include failure messages, which may appear when recovery has no success status to show. The short-viewport, long-approval, and failed-recovery browser tests verify those states.

<a id="server-owned-session-variant"></a>

## Server-owned session variant

A labeled, non-canonical route family may own sessions server-side using Operative's session and durable-run APIs. It is additive: it does not silently replace the browser-owned exemplar, which remains canonical.

Its lifecycle boundary differs from the stateless route's and must be documented and tested on its own terms rather than borrowed by implication, because the host owns a session store, a run engine, checkpoint storage, and workflow-service reconstruction.

### Execution ownership

`ChatExecutionOwner` is `'browser' | 'server'`, and `executionOwner` on the controller defaults to `'browser'`—the historical behavior, where the client owns the loop and a turn that ended with every tool call resolved is the cue to submit the next step.

`'server'` says the host ran the whole turn inside one response. Every step already crossed the wire, so continuing would either duplicate the turn or ask for a step the host has nothing to answer with. A server-owned multistep run therefore uses exactly one submission even after its tools resolve.

**Ownership is a property of the SUBMISSION, never of a frame.** No terminal frame promotes or demotes it: a host that wants the browser to continue says so by being configured that way, not by what it happened to send. `shouldStopAfterTurn` enforces that ordering literally—the server-owned check comes first and consults nothing else, because every other clause reads the turn's content to decide whether the client still owes the host a step, and letting a frame reach that decision would let a frame decide ownership.

Omitting the option preserves browser-owned continuation, which is why a server-owned transport that does not set it still needs the empty-stream defense described under [State model](#state-model). The two are not equivalent: the option makes the intent declared, while the defense makes an undeclared intent survivable.

### The store owns the index

The session store owns the conversation-list index. `SessionStore.list()` returns conversation-shaped summaries—id, agent name, message count, timestamps, and metadata—so the host drives that call rather than maintaining a parallel index, which could only drift from the store it copies. Conversation titles live in session metadata for the same reason: a separate title store would be a second thing to keep in step.

Ordering is by `updatedAt`, newest first, and the host states that explicitly rather than inheriting a default. Sessions written inside the same millisecond share a timestamp and fall back to key order, which is deterministic but unrelated to creation order—anything needing creation order carries it rather than inferring it from the list. A caller cannot work around that by supplying its own timestamps: the store owns `updatedAt` and overwrites what it is given.

### Recovery and storage

Reconstructing workflow services on restart, and sweeping orphaned run references that can no longer be resumed, are the host's responsibilities. `handle.recover()` **is** wired up now, behind `POST /api/server-owned/conversations/[id]/recovery`—a POST because asking RECONCILES the stranded run it reports, so the question is one-shot rather than safely repeatable, and its three outcomes are rendered distinctly on the detail route. The variant still supplies a `resolveWorkflowServices` resolver that always answers `status: 'unavailable'`, which remains the honest answer while a run's dependencies are a provider bound to a request-scoped key and a writer bound to one HTTP response: there is nothing to rebuild once that response is gone. So a run this variant recovers is always terminally orphaned, and the endpoint says so rather than reporting the benign "nothing to resume" a bare `null` would suggest. Nothing sweeps orphaned references on a schedule; Operative's own reconciliation of the ref it just rejected is what clears them, one ask at a time.

The backing store is **in-memory by default and SQLite on disk when `CHAT_ROOM_SERVER_OWNED_DATABASE` names a file**. The default is right for a test suite and for a first read; the on-disk branch is what makes the recovery question answerable at all, because nothing else survives a process. `':memory:'` is accepted and reported as in-memory, because it is. `ServerOwnedRuntime.storage` is typed as Weft's `Storage` interface rather than a concrete adapter precisely so this is one line in one file, and the recovery panel names which of the two it is running over—"nothing to resume" is the truth under one and a surprise under the other.

Each target-state claim elsewhere in this document says so at the point it is made rather than relying on a blanket assurance. One such assurance used to live in this section and was false: three sections still described terminal frames as unshipped after they had landed.

This variant must not import `@corvidae/bureau` internals or locally recreate capabilities that belong in a shared workspace library.
