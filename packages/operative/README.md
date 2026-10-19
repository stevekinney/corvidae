# Operative

`@lostgradient/operative` is Corvidae's provider-agnostic agent runtime. It owns the loop that assembles context, calls a generate function, executes tools, records steps, handles stop conditions, emits events, manages sessions, and coordinates advanced runtime behavior.

## Workspace usage

Declare `"@lostgradient/operative": "workspace:*"` in the consuming workspace's dependencies. Install dependencies from the Corvidae root with `bun install --frozen-lockfile`. The private package exports TypeScript source from `@lostgradient/operative`; the consumer compiles it. Shared external versions come from the root Bun catalog.

## What It Does

- Defines agents with `createAgent()` and drives the loop directly with `createActiveRun()`.
- Executes tools through `armorer` and conversation history through `conversationalist`.
- Accepts caller-provided generate functions and includes Anthropic, OpenAI, and Gemini provider factories.
- Provides sessions, session stores, durable run support, scheduler primitives, and heartbeat utilities.
- Adds hooks for generation, tool execution, context assembly, validation, run lifecycle, and error handling.
- Provides guardrails, retry mutators, cache middleware, context compaction, streaming, backpressure, budgets, handoffs, and subagents. Supervisors and agent discovery live in `@lostgradient/bureau`.
- Dispatches child runs with typed, parent-mediated signals and provides the signed delegation-grant helpers Bureau's durable parent-child topology uses.
- Lets a retry or reset start from a typed, validated handoff artifact instead of a failed transcript, and names the three ways an attempt gets its conversation: continue, fork from a baseline, or fresh from an artifact.

## How It Works

The core loop starts with an agent definition, a conversation, tools, and a `GenerateFunction`. For each step, it prepares context, calls the generate function, validates the response, executes requested tools, appends tool results back to the conversation, emits typed events, and evaluates stop conditions.

Provider factories such as `createAnthropicProvider`, `createOpenAIProvider`, and `createGeminiProvider` are exported from `@lostgradient/operative`, alongside fallover, routing, and embedding helpers. Callers can also supply any function that satisfies `GenerateFunction`. Durable execution, scheduler tasks, and session persistence build on the same loop so product surfaces can recover or resume runs without changing agent code.

## Project Role

`@lostgradient/bureau` composes Operative runs and scheduler tasks. `@lostgradient/memory` and Bureau's skills subsystem attach through hooks and tools, `armorer` supplies validated actions, and `conversationalist` supplies the conversation model. Applications own request handling and other runtime composition.

## Quick Start

Create an agent with a stub generate function and run it to completion:

```typescript
import { createAgent } from '@lostgradient/operative';
import type { GenerateFunction } from '@lostgradient/operative';

// Minimal inline generate function—swap for a real provider in production.
const generate: GenerateFunction = async ({ conversation }) => {
  const last = conversation.getMessages().at(-1);
  // `Message.content` is `string | readonly MultiModalContent[]`—guard rather than
  // interpolate it directly, which would print "[object Object],[object Object]" for
  // multi-modal input.
  const lastText = typeof last?.content === 'string' ? last.content : '(non-text content)';
  return {
    content: `Echo: ${lastText}`,
    toolCalls: [],
  };
};

const assistant = createAgent({
  generate,
  instructions: 'You are a helpful assistant.',
});

const run = assistant.run('Hello, agent!');
const result = await run.result();
console.log(result.content); // "Echo: Hello, agent!"
console.log(result.finishReason); // "stop-condition"
```

> [!NOTE] `createAgent` defaults `stopWhen` to `stopWhen.noToolCalls()` when you don't supply one, so the loop above stops after the first step (the stub `generate` never returns tool calls) instead of running to `maximumSteps` (`DEFAULT_MAXIMUM_STEPS`, 25) and re-echoing its own output 25 times over. Pass an explicit `stopWhen`—for example `stopWhen.toolCalled('submit-form')`—to override it, most importantly for any agent that is expected to finish on a tool call rather than a plain reply (a handoff tool, for instance—see the Handoffs section under [Multi-Agent Patterns](#multi-agent-patterns)).

### Event-Driven Style with `createActiveRun()`

`createAgent().run()` returns a non-thenable `AgentRun` handle: iterate it directly for events, or call `.result()` for the terminal `RunResult`. For the full event-emitting surface (`addEventListener`, `on`, `subscribe`, …) reach for `createActiveRun()`—the lower-level factory `createAgent` builds on—which returns an `ActiveRun` instead. Attach listeners before awaiting `result`—the loop defers its first microtask so you never miss the opening events:

`result()` resolves for an ordinary completed, errored, or cancelled run and carries the classification in `finishReason`; `abort()` is therefore observed as `finishReason: 'aborted'`. A persistence or infrastructure failure rejects `result()` so a caller cannot mistake an uncommitted terminal run for success. The promise remains cached, including after rejection. `abort()` is synchronous request signaling; await `result()` when the caller needs the terminal outcome.

```typescript
import { Conversation } from 'conversationalist';
import { createActiveRun, stopWhen } from '@lostgradient/operative';

const conversation = new Conversation();
conversation.appendUserMessage('Summarize the docs.');

const activeRun = createActiveRun({
  generate,
  toolbox, // a Toolbox from armorer's createToolbox()—empty or populated
  conversation,
  stopWhen: stopWhen.noToolCalls(),
});

activeRun.addEventListener('step.completed', (event) => {
  console.log(`Step ${event.step} done—${event.content}`);
});

activeRun.addEventListener('run.completed', (event) => {
  console.log('Finish reason:', event.finishReason);
});

// Abort any time before completion.
// activeRun.abort('user cancelled');

const result = await activeRun.result;
```

## Public API

### Provider capability and effective context

For the cross-package contract, including the provider capability matrix, selection-plan fields, steering boundary, and cleanup ownership table, see [Runtime contracts across Corvidae](../../documentation/runtime-contracts.md).

Operative keeps provider differences at the provider boundary. [Anthropic](https://www.anthropic.com/api), [OpenAI](https://platform.openai.com/docs/api-reference), [Gemini](https://ai.google.dev/gemini-api/docs), and OpenAI-compatible generators share the same `GenerateFunction` contract; native features such as Anthropic extended thinking, Gemini cached content, Gemini token counting, and provider batch operations are exposed through capability-aware provider helpers. A capability that has no portable fallback is reported as unavailable rather than synthesized into a misleading success. Vision and managed-file policy belong to their own capability contracts and are not inferred from a text-only generator.

When a host composes the context-epoch sealer, each generation records the effective context it consumed: the context epoch, selected model plan, and provider response metadata travel with the step and its events. Without that optional dependency, no context epoch is emitted. If a caller changes model policy or steering while a step is already running, that change applies at the next named generation boundary. Read the plan from the run or Bureau selection surface before presenting it to a user; do not infer it from the requested model alone.

The started-work boundary is equally explicit. In-memory `AgentRun` handles are live locators whose `result`, events, snapshots, and abort methods observe one run. A durable `createActiveRun(options, { engine, checkpointStore, runId })` additionally exposes `durablyStarted`, which settles after the initial workflow record commits. Await that promise before treating a returned durable identifier as recoverable after a crash. Cancellation requests are signals; `result()` reports the terminal run outcome, while `closed()` is the cleanup acknowledgement that waits for owned drains and children.

### Core Entry Point

The main import surface for defining agents, running loops, managing sessions, backpressure, caching, context assembly, cost tracking, and multi-agent patterns.

### `createAgent(options)`

The documented public factory for a standalone, bureau-less agent. `generate` is required—there's no bureau to inherit a provider from. Runs are in-memory and ephemeral by default (no durability, no session, no shared memory) unless you inject your own `Toolbox` and `ConversationHistory`, as below.

```typescript
import { createAgent } from '@lostgradient/operative';

const agent = createAgent({
  generate: myProvider, // GenerateFunction—required
  instructions: 'You are a research assistant.',
  tools: { search: searchTool }, // name-keyed map; the map key is canonical
  stopWhen: (step) => step.toolCalls.length === 0,
});

const run = agent.run('Summarize the Q3 report.'); // fresh conversation
for await (const event of run) {
  /* iterate, OR */
}
const result = await run.result(); // await—same handle
```

`createAgent`'s return value satisfies `RunnableAgent<O, H>` (AB-21)—it carries a `readonly name` (`options.name`, defaulting to `'(agent)'` when omitted), a `readonly hasOutput: boolean` (AB-234—`output !== undefined`, the runtime witness for `H`), and `run` accepts an optional second `AgentRunContext` argument (`{ signal, agentName, traceContext, withTraceContext, principal }`), so it slots into `createLazyAgent` or a future `AgentDefinitions` map without a cast. `context.signal` drives per-run abort, `context.agentName` overrides the run's stamped agent name, `context.traceContext` becomes the same `parentContext` field `RunOptions` already uses for nested tracing, and `context.principal` (AB-241) forwards unchanged into `RunOptions.principal`—a bureau-owned `bureau.run()` catalog dispatch sets it from `BureauRunOptions.principal`.

**`CreateAgentOptions`**—key fields:

| Field | Type | Description |
| --- | --- | --- |
| `generate` | `GenerateFunction` | Required. The caller-supplied LLM call. |
| `tools` | `Record<string, Tool>` | Name-keyed tool map. Mutually exclusive with `toolbox`. |
| `toolbox` | `Toolbox` | A pre-built `Toolbox`, used as-is across every run. Mutually exclusive with `tools`. |
| `instructions` | `string` | System prompt appended on fresh string-input runs only. |
| `stopWhen` | `StopCondition \| StopCondition[]` | Loop exit predicates. |
| `maximumSteps` | `number` | Hard step cap. |
| `retry` | `RetryOptions` | Transient generate failure retry policy. |
| `contextManagement` | `ContextManagementOptions` | Automatic context compaction. |
| `permissions` | `HeadlessPermissionPolicyConfiguration` | Deny-by-default headless mode (AB-94). Mutually exclusive with `toolbox`. |

`agent.run(input)` accepts a plain `string` (starts a fresh conversation—`instructions`, if given, is appended as a system message, then `input` as a user message), an ordered array of user-admissible parts (text, and image, audio, video, document, or file parts addressed by a `ContentSource`; the array becomes exactly one user message, in order, and an empty array throws an `AgentContractError`), or `{ conversation: ConversationHistory }` (resumes an existing history—see the next section). `SessionHandle.run` and `MonitorOptions.input` accept the same string-or-parts payload.

### Stateless chat host: resume a conversation, share a toolbox, park on approval

A host with a browser- or client-owned conversation and an approval-gated toolbox—a stateless HTTP chat backend, for example—needs five things `createAgent` provides directly:

1. **A conversation input**, not just a fresh string: `agent.run({ conversation })` starts the loop from an existing `ConversationHistory`—the shape a stateless backend POSTs and stores between turns.
2. **Request-scoped authority**, not authority stored on the toolbox: pass the authenticated request's `requestContext` through `executeOptions`. On resume, construct a fresh context for the approval request while preserving every identity and revision field bound into the approval. Do not reuse ephemeral controls such as the original request's absolute `deadline`.
3. **Versioned tools**, not anonymous mutable definitions: every tool that can produce a resumable approval needs a stable `version`. Armorer binds that version into the approval and rejects unversioned or changed definitions.
4. **A pre-built `Toolbox`**, not a freshly composed one: pass `toolbox` instead of `tools`. Reuse the same instance across requests, or configure every instance with the same secret and durable approval state store, so a later request can validate and consume the issued approval.
5. **Park-on-approval**, not headless denial: `stopWhen: [stopWhen.pendingApproval(), stopWhen.noToolCalls()]` (from `@lostgradient/operative`) stops the run cleanly after a step whose tool results include a pending approval—no further `generate` call happens, and the pending approval stays reachable on the final `RunResult`'s last step. `noToolCalls()` has to be combined in: `pendingApproval()` alone never fires on a normal, no-tool-call turn, so a plain text reply would otherwise run to `maximumSteps` instead of finishing.

```typescript
import { unlink } from 'node:fs/promises';
import { createTool, createToolbox } from 'armorer';
import { createAgent, stopWhen } from '@lostgradient/operative';
import { z } from 'zod';

const deleteFileTool = createTool({
  name: 'delete-file',
  version: '1',
  description: 'Delete one file',
  input: z.object({ path: z.string() }),
  metadata: { mutates: true },
  async execute({ path }) {
    await unlink(path);
    return { deleted: true };
  },
});

// Built once per process—the stable approvalSecret is what makes
// resumeApproval() work across separate HTTP requests.
//
// `approvalPolicy` is load-bearing, not decoration: armorer only installs its
// approval hook when a policy (or a registry/tool policy, or a deny flag) is
// present. Without one, `allowMutation` and `allowDangerous` both default to
// true and `deleteFileTool` would simply EXECUTE—`approvalSecret` alone only
// signs a pending approval once something has produced one.
const toolbox = createToolbox([deleteFileTool], {
  approvalPolicy: { mode: 'on-mutation' },
  approvalSecret: Bun.env['APPROVAL_SECRET'],
});

// Build this from the authenticated request. Do not store tenant or principal
// authority in the reusable toolbox.
const requestContext = {
  authority: {
    principalId: currentUser.id,
    tenantId: currentTenant.id,
    ownerId: currentSession.id,
    capabilities: currentAuthorization.capabilities,
    authorizationRevision: currentAuthorization.revision,
  },
  audience: 'tenant',
  agentId: agentId,
  runId: runId,
} as const;

const agent = createAgent({
  generate: myProvider,
  toolbox,
  executeOptions: { requestContext },
  stopWhen: [stopWhen.pendingApproval(), stopWhen.noToolCalls()],
});

// Turn 1: run from the client-POSTed history.
const run = agent.run({ conversation: clientHistory });
const result = await run.result();
const pending = result.steps.at(-1)?.results.find((r) => r.pendingApproval)?.pendingApproval;
// ...send `pending` to a human, store `result.conversation.current` server-side...

// Later, on approval: authenticate the new HTTP request and construct a fresh
// context. Preserve the bound identity fields, but derive controls such as a
// deadline from this request instead of copying an expired deadline.
const approvalRequestContext = {
  authority: {
    principalId: approvalUser.id,
    tenantId: approvalTenant.id,
    ownerId: approvalSession.id,
    capabilities: approvalAuthorization.capabilities,
    authorizationRevision: approvalAuthorization.revision,
  },
  audience: requestContext.audience,
  agentId: requestContext.agentId,
  runId: requestContext.runId,
  deadline: Date.now() + 30_000,
};
const resumedResult = await toolbox.resumeApproval(signedApproval, {
  requestContext: approvalRequestContext,
});
```

> [!IMPORTANT] Reconcile the pending result—do not append on top of it `result.conversation` already carries an `action_required` tool-result for this call: the loop appends it before `stopWhen` ever runs. Appending `resumedResult` alongside it leaves two tool-results for one call, which most providers reject or mishandle on the next turn.
>
> Replace it in place with conversationalist's `resolveToolResult(conversation, callId, resumedResult)`, which addresses the message by `callId` (not by position or recency) and therefore works identically on a `Conversation` rehydrated from a persisted `ConversationHistory`—the case a stateless host hits on every resumed request. `Conversation.undo()` is NOT a substitute: it walks the in-process undo/redo graph, which a rehydrated conversation does not have in the same shape.
>
> Start the next turn from the resolved history. This README does not yet carry a full worked example of that round trip; see conversationalist's own documentation for `resolveToolResult` until one lands here.

**Mutation ownership:** `agent.run({ conversation })` SNAPSHOTS the supplied `ConversationHistory`—it clones the value before wrapping it in a fresh internal `Conversation`, so the run's state and the object you passed in are independent from the moment `run()` is called: the run never mutates your object, and mutations you make to it afterward (a stateless host commonly keeps a mutable reference between turns) never leak into an in-flight run. This matches the durable path's existing snapshot semantics. `instructions` is not re-appended on this path; the supplied history is assumed to already carry whatever system context it needs, so resuming it repeatedly never duplicates system messages.

### Media input (COR-716)

A run's input can carry media, not just text. Pass an ordered array of parts to `agent.run`, `session.run`, or a `toAgentInput` projection, and the provider boundary receives those parts in that order, unchanged, or the step fails with a typed error before any provider call. Nothing is replaced by an empty string, reduced to its text, or rewritten as marker prose.

**The admission invariant.** Every `GenerateContext` handed to the run's `generate` carries a `resolvedSources` that admission derived from that context's own conversation, immediately before the call, against the backends the call can reach. The derivation is never carried across a mutation: the step boundary derives a preview (which selection, the compaction budget, and the input guardrail read through `StepContext.resolvedSources`), every `generate` call derives again on the exact conversation it receives after the `prepareStep` hooks and the `beforeGenerate` waterfall, a retry mutator's rebuilt request is derived again before the retry is issued, and both `onMaximumSteps` tails derive for the conversation they hand the handler (`createEarlyStoppingHandler` forwards it). Resolutions are memoized per part for the step, so the bytes and verdict the guardrail inspected are the bytes sent, and an unchanged conversation costs no resolver call. Three sites sit outside the derivation by design and are documented where they live: a background compaction can publish a compacted history between the derivation and the call (COR-808), which is safe because it only removes messages and keeps their ids, so a stale map is a superset of what the adapter substitutes; `onMaximumSteps` may append text after the derivation (media a handler appends is its own responsibility); and a provider's `pinnedMessages` are host configuration assembled inside the provider, never user input, so they do not pass admission.

Each derivation runs these checks, in order, before anything else sees the media:

1. **Resolve.** A part whose source kind no provider takes directly (`managed-asset`, `upload`, `local-file`, `mcp-resource`, `a2a-reference`) goes through `RunOptions.contentSourceResolver` (also a `createAgent` option). The resolver is called as `(part, { messageId, partIndex, signal })`, where `signal` is the run's `AbortSignal`: honor it to release a stalled read, and know that admission abandons a resolver that does not, so `run.abort()` ends the run as aborted without waiting on it. A resolution is reused for the same message, part index, and source (a sanitized caption does not change them), so the bytes a guardrail inspected are the bytes sent. It returns a `ResolvedMediaSource` (an `inline`, `data-url`, `remote-url`, or `provider-file` source, with optional `mimeType`, `byteLength`, and a `safety` of `clean`, `flagged`, or `unknown`) or `{ outcome: 'unavailable', reason }`. Without a resolver such a part is unavailable (`source-form-not-accepted`), whatever a custom estimator would say. The stored message keeps the part's original source, so asset identity and revision survive; the resolved form reaches the provider adapter through `GenerateContext.resolvedSources`. A media type from a resolver or a data URL that does not fit the part's modality is refused as `mime-type-mismatch`. A resolver's `mimeType` for the resolved bytes takes precedence over a stale one on the stored part, in the adapters and in the cost estimator. An unpinned `managed-asset` resolves to its latest revision once per step.
2. **Verdict.** Admission, not the guardrail, owns the safety verdict: every resolved part in every message is checked, so an asset the safety gate `flagged` is refused as `asset-flagged`, and one with no verdict (`unknown`) as `asset-unverified` when `RunOptions.assetSafety` is `{ unknown: 'block' }` (`createAgent` takes the policy from its input guardrail declaration when `assetSafety` is not set). This holds with no input guardrail, with one that only warns, and for an asset from an earlier turn or one a hook, handler, or mutator added. The session cliff that follows is deliberate and documented rather than quarantined: once a flagged asset, or an `unknown` one under `block`, sits in a session's history, every later turn of that session fails with the same typed error naming the message and part, because quarantining would rewrite the history silently, which the no-silent-loss rule forbids. Remove the message, or re-verify the asset, to continue.
3. **Backends.** Each backend the `generate` function reports (`readBackendDescriptors`, the union over every route or provider a dispatcher can reach) is judged on the whole request with `evaluateInputMedia`, the evaluator selection uses: modality, source form, MIME family, per-part and aggregate byte limits, and per-request counts. The request is admitted when at least one backend takes every part, and dispatch is then limited to those backends. When none does, the error names the parts that single it out: a part no backend takes on its own keeps its specific reason, the parts past the largest count cap are `media-count-exceeded`, the parts past the largest aggregate cap are `media-limit-exceeded`, and otherwise every part is `no-backend-admits-media`. A dispatcher that keeps a candidate with no descriptor (an opaque generate function beside described ones) reports an incomplete union, carried on the descriptor array through every wrapper: the described rows then do not say what every reachable backend takes, so admission refuses nothing on eligibility grounds and dispatch decides through `generateAdmitsMedia`, which keeps the opaque candidate. Resolution, the safety verdict, and costing still apply; under an incomplete union with no custom estimator, a part the described rows cannot price is `no-estimator`. The MIME family a part is judged by comes from the same document table the schema uses (`application/pdf`, `application/json`, `application/xml`, `application/rtf`, and the office containers are all `document`).
4. **Cost.** `RunOptions.mediaCostEstimator` (also a `createAgent` option) returns a `MediaCostOutcome` per part. Without one, `createCatalogMediaCostEstimator` costs the part against the admitting backends: a part is acceptable when at least one of them takes it, and the token figure is an estimate from the part's bytes and a per-modality rate, with `basis` `catalog-estimate`. It is not an upper bound: the rate is per KiB, so a text-heavy document costs more tokens than it assumes, and an underestimate surfaces as a typed provider context-overflow error, which the overflow mutator answers by compacting. A part of unknown size (a remote URL nothing resolved, a provider file handle) is costed at the largest per-part byte cap among the backends that take it, and is `size-unknown` when none of them declares one. A `remote-url` on a backend that does not fetch URLs itself is `source-form-not-accepted`. A caller with a provider token counter supplies its own estimator and reports `provider-count`.
5. **Admit.** Any outcome other than `estimated` fails the step with a `MediaAdmissionError` (code `MEDIA_NOT_ADMITTED`, kind `policy`) carrying one outcome per refused part, before any provider call; a refusal of a retry mutator's request ends the step the same way, without consulting `onError`. A `generate` function with no descriptors and no estimator therefore admits no media, and every provider factory and wrapper in this package (the Gemini streaming factory under the `generateContentStream` endpoint, `composeGenerate`, routing, fallover, fallback, cache, instrumentation) carries its backends' descriptors so that a plain `createAgent({ generate })` handles media without configuration. Estimated media tokens count toward `contextManagement`'s compaction threshold, and `createContextAssembler` reports them in `BudgetReport.mediaTokens` and `AssemblyResult.mediaCosts`; it leaves a message out, never admits it at zero, when a part is not `estimated`.

The OpenAI, Anthropic, and Gemini factories record what each request delivered in `GenerateResponse.metadata.inputLineage`: one entry per media part with its `from` and `to` source kinds and the `transform` applied, so it lands in the durable transcript beside the assistant message. On a response that only calls tools, the lineage is stamped on the step's first tool-call message instead, since no assistant message is appended. An unsupported combination throws conversationalist's `UnsupportedContentError` outside the SDK `try`, so it is never wrapped in a `ProviderError`.

`onLLMInput` receives a snapshot copy of the conversation the call sends, not the live object: it is a read-only hook that runs between the binding derivation and the call, so a write to its copy never reaches the request. `createInputGuardrail` inspects every user message appended since the previous generation (every user message after the last assistant message, so several session inputs landing at one step boundary are each inspected), field by field, each text-bearing field as its own detector input: text parts; a media part's `name`, `alt`, `caption`, `transcript`, and `extractedText`; the strings in its `metadata`; and the locator its source names (a `remote-url`'s URL, an `mcp-resource`'s `uri`, a `local-file`'s `path`, an `a2a-reference`'s `agentCardUrl`, a `provider-file`'s `providerFileId`). Locators are read but never rewritten. `sanitize` rewrites only the flagged fields of each flagged message and keeps every media part in order (a URL has no sanitized form, so it blocks). The text a provider reads from a part's own bytes (inline UTF-8, inline base64 or a data URL under a textual media type, or the body a resolver returned) is read through conversationalist's `readMediaBody` and inspected as a field of its own; its bytes cannot be rewritten, so `sanitize` blocks it. A text body that does not decode is blocked, whatever the guardrail's action. A resolved asset the safety gate marked `flagged` is always refused; `assetSafety: { unknown: 'block' }` also refuses assets with no verdict (default `'allow'`).

Compaction keeps media: `Conversation.compact()` preserves every message that holds a media part verbatim (`preservePolicy.media`, default `true`), so `createContextCompactor`, the sliding-window strategy, and `createOverflowMutator` summarize around them. The consequence is that a history made mostly of media cannot be compacted below its media: compaction frees only the text around it, and the overflow mutator rethrows the provider's overflow error when nothing else is left. Pass `preservePolicy: { media: false }` only when your summarizer reads the media and losing the original parts is your explicit choice. `prepareSubagentContext` carries text and media parts to the child and leaves out provider-private reasoning blocks. A fresh attempt carries none of the source transcript: its seed is the rendered artifact.

For selection, `describeInputMedia(parts)` derives `InputMediaRequirement`s, and `SelectionRequest.inputMedia` makes `select()` exclude any backend that cannot take them (no input for the modality, a source form it does not list, a MIME family it does not list, a part over `mediaLimits`, or more parts than `mediaCounts` allows, or a `remote-url` it cannot fetch itself, or a `provider-file` handle from another provider) with `incompatible-modality` before ranking. At each step the selection gate's `revalidate({ inputMedia })` receives the media the step's conversation carries, described by the source form each part takes once resolved, so a backend that cannot accept it fails the step with a `SelectionRevalidationError` (`incompatible-modality`) instead of a provider error; `aggregate` byte limits exclude a backend the same way. `AgentPreferences.requiredInputModalities` excludes backends missing a modality or source form with `missing-required-capability`. `BackendDescriptor` (version 2) declares `mediaCounts` and `providerFetchesRemoteUrls` beside `modalities`, `mimeFamilies`, and `mediaLimits`.

`createRoutingGenerate`, `createFalloverGenerate`, and `createFallbackGenerate` share one dispatcher filter (`generateAdmitsMedia`): each offers only the candidates whose backends admit every media part of the request it receives (a candidate with no descriptor is opaque and is kept), judged on the same context admission just derived `resolvedSources` for. Routing judges the routes its map keeps (the last route with a given name), refuses a steering override of a route the media does not fit, and fails with a `MediaAdmissionError` (reason `no-route-admits-media`) before any provider call when no route admits; fallover and fallback never call a provider that cannot take the request, so a content rejection is never booked as a provider failure, and refuse with `no-backend-admits-media` when none can. A caching provider (`assembler` with `contextBudget`) costs media with the budget's estimator or the catalog's, keeps message ids so resolved sources still match (a pinned message that also sits in the history is included once), and never leaves a media message out silently: it fails with a `MediaAdmissionError` (`media-over-budget` for a message the budget cannot hold). That refusal never ages out on its own: the budget is a fixed construction-time cap and the message stays in the history, so every later turn of that conversation fails the same way until the history is compacted or the budget raised.

Two notes on what text admission and the guardrail read. Conversationalist's PII redaction plugin runs at append time, on the message as it is stored, so a `managed-asset` part, whose bytes exist only after resolution, is never redacted by it; such content is covered by the input guardrail's inspection of the resolved body and by the safety verdict instead. Decoding a text body ignores any `charset` parameter: inline text and textual base64 or data-URL bodies are decoded as UTF-8, and a body that is not UTF-8 is refused rather than read wrongly.

A durable run carries the same payload: `AgentRunWorkflowInput.prompt`, `ScheduledAgentRunInput.input`, and `AgentScheduleOptions.input` are a string or an ordered list of user-admissible parts, validated with `parseSessionInputPayload` (an empty list or an invalid part is refused when the run or schedule is created, and a persisted prompt that fails the same check is not trusted on recovery). The checkpointed transcript holds the parts unchanged, so a recovered run re-sends them.

The durable run envelope is `RUN_ENVELOPE_SCHEMA_VERSION` 4 (COR-713 added the response `parts` below): an envelope stored under version 3 or earlier is refused with `UnsupportedRunResultVersionError`, not read.

### Response parts and generated media (COR-713)

A model's response is an ordered list of typed parts, not a string. `GenerateResponse.parts`, `StepResult.parts` and `RunResult.parts` carry `MultiModalContent` from Conversationalist: text (with its `citations`), `thinking` and `redacted_thinking`, the server-tool blocks (`server_tool_use` and the five result types), `container_upload`, and generated media (`image`, `audio`, `video`, `document`, `file`). The three built-in adapters always set `parts`; a `generate` you write may return only `content`, and the loop derives `[{ type: 'text', text: content }]`, or `[]` when `content` is empty.

- **Content and parts agree.** `content` is the in-order concatenation of the text parts. On `RunResult` it stays the final assistant text, while `RunResult.parts` is run-wide: every step's parts in step order, then the parts of an `onMaximumSteps` replacement row when there is one.
- **A row holds the parts.** The loop commits a step's assistant row whenever its parts are non-empty, so a response that is a thinking block and a tool call keeps its thinking, where it used to be lost. A row that is exactly one plain text part keeps the string shorthand; anything else, including one cited text part, stores the array. A part is identified by `(messageId, partIndex)`, matching `ContentSourceResolutionContext`: `StepResult.messageId` is the committed row's id (`undefined` only when the step committed no row) and `partIndex` is the position in that row's content.
- **The response after the hooks is authoritative.** Exactly one function in the loop applies this to the response each phase leaves behind (after `generate` or `prepareStep`, after the `afterGenerate` handlers, after the `validateResponse` hooks). A hook that returns `content` without `parts` gets its parts derived as text only, so an output guardrail that redacts leaves nothing unredacted in the parts, the row or the next request, including a streamed row, which the loop rewinds and re-appends. A hook that returns both, with text parts that do not concatenate to `content`, fails the step with a `ResponsePartsMismatchError` (`RESPONSE_PARTS_MISMATCH`, kind `contract`) rather than proceeding with stale parts. A response that passes every hook unchanged keeps its parts. Guardrails still inspect `content` only.
- **Anthropic replay.** Both Anthropic factories keep every `thinking` and `redacted_thinking` block with its signature or data, citations, server-tool blocks and `container_upload`, in provider order. The next request holds each byte-identical, with thinking before `tool_use` in the same assistant turn. This replaces the old known limitation that thinking could not be combined with tools.
- **Nothing vanishes.** Each adapter maps every block, part and stream delta type it can receive to a part, a tool call, usage, metadata or control, and anything else throws a `ProviderContractError` (a `ProviderError`; `reason` `unlisted-block` or `unadvertised-modality`, with `provider`, `blockType`, `partIndex` and the billed `usage`). It is never retried under `RetryOptions`, whether or not `shouldRetry` is set, and a streaming adapter throws it after the stream drains. The OpenAI adapter keeps `refusal` and `annotations` in `metadata` and fields the SDK does not declare (`reasoning_content` and the like) in `metadata.providerExtensions`, and refuses `audio` and the deprecated `function_call`. The Gemini adapter keeps thought summaries out of the answer (`metadata.geminiThoughtSummaries`), coalesces adjacent text, and refuses `fileData`, `executableCode`, `codeExecutionResult`, `functionResponse`, `toolCall`, `toolResponse`, `audioTranscription` and any key it does not know.
- **A non-fatal signal for replay data that cannot be kept.** A Gemini 2.5 part's `thoughtSignature` has no content representation. The adapter returns the response, naming it in `GenerateResponse.metadata.replayDataDropped` (read with `readDroppedReplayData`), and the loop dispatches a `ReplayDataDroppedEvent` (`generate.replay-data-dropped`) read from the response `generate` returned, before any hook. It never throws. Anthropic has none: every replay block it returns is a part.

**Generated media becomes a managed asset in the loop.** A built-in backend advertises media output only if its descriptor says so; none of the catalog's rows does, so generated media comes from a backend you describe. An adapter's media part carries an `inline` source, and only there. `RunOptions.generatedMediaAdmitter` (also a `createAgent` option, and `GenerateContext.generatedMediaAdmitter` for a streaming wrapper) is the injected port, after `contentSourceResolver`: Bureau supplies it on every run from its asset service, scoped to the run's owning principal. The loop admits every media part right after `generate` returns, before any hook, event or row write sees the response, so no hook, event, row or persisted result observes inline bytes; `GenerateMiddleware` wraps `generate` and is the only code that can. The parts of one response are admitted together (`admitAll` when the port has it, so the policy's aggregate ceilings hold across them), and a refused admission aborts its siblings and waits for them to settle before the step fails; the response `onLLMOutput` sees is a frozen copy, so a read-only hook cannot reach the admitted parts. A streaming wrapper admits a media part when it completes, one at a time. After admission a media part has a `managed-asset` source; without a port, or when the admission fails, the step fails with a `GeneratedMediaNotAdmittedError` (`GENERATED_MEDIA_NOT_ADMITTED`, kind `policy`) naming the part. A refused admission ends the run with `finishReason: 'error'`; a cancellation aborts the open admission through its signal. A response with a non-text part is not cached by `withCache`.

The run's terminal result and `ActiveRun.closed()` wait for every admission the run started, in the in-memory, durable and reattached drivers. `closed()` returns `completed` once each has settled as available, rejected or deleted (a failed admission settles `rejected`, so it is `completed` too), `unresolved` with `unknown-effect` for one whose outcome cannot be confirmed, and `unresolved` with `timed-out` when the caller's `closed({ signal })` aborts first. No timer is added.

**Known limit: an admitted asset a persisted row does not reference.** A step that admits an asset and then does not reference it in a persisted row leaves that asset `available` and unreferenced until the policy's default retention expires it. Every one of these paths ends there: a crash between admission and the step record (a durable step runs whole inside one memo, so the step re-runs and generates again), an `afterGenerate` hook that returns `content` without `parts`, a `validateResponse` redaction or an output guardrail's rewrite, a parts mismatch or validation retry after admission, a retried stream whose failed attempt had already admitted a completed part, and a sibling admission that is rejected while another part is already `available`. None references a missing asset and none loses data; no reconciliation runs. Operative does not reconcile this.

**Streaming.** `StreamingHandle.reportPart` is the structured channel for parts (`start`, `delta`, `progress`, `complete`, `failed`, each with its part index), alongside `update` and `report`; both wrappers install it, and the built-in adapters use it instead of `update` when it is there, falling back to `update(accumulatedText)` for a bare handle. A hand-written function that only calls `update` gets one text part synthesized from its `content`. The wrapper owns the row: it writes the parts seen so far, finalizes with the settled parts in one write (`finalizeStreamingMessage(id, { content })`), and commits no row for a response with no parts. `withEnhancedStreaming` adds `stream:part-start`, `stream:part-delta`, `stream:part-progress`, `stream:part-complete`, `stream:part-asset-linked`, `stream:part-asset-available` and `stream:part-failed`, each identified by `(messageId, partIndex)` and, for deltas and progress, a per-part `sequence`. A duplicate or stale sequence, and any delta after a part completed, is a no-op. Text and thinking receive string deltas, a media part only byte progress, and no event or state snapshot carries inline bytes. `stream:complete` is emitted last, after admission and row finalization, and a stream ends in exactly one terminal event. `StreamState.parts` tracks every part; `StreamStateMachine.accepts` says whether a command would change the state.

**Durable shapes.** `RUN_ENVELOPE_SCHEMA_VERSION` is 4 (`assistant-final` frames and `RunReport` carry `parts`; `assistant-final` also carries `messageId`, and Bureau emits one for any step with parts), `AGENT_RUN_WORKFLOW_RESULT_SCHEMA_VERSION` is 3, and the checkpoint `StepRecord` (`parts`, `messageId`) and `RunCursor` (`lastParts`, `finalRowIsReplacement`) are stamped `schemaVersion: 2`. There is no dual read: a version 3 envelope, a version 2 result, and a cursor or step record without a version fail with `UnsupportedRunResultVersionError` or `UnsupportedCheckpointRecordVersionError`, and nothing derives parts from `content` on load. A durable run in flight on the old shapes cannot be resumed.

### Process-local session timing

`SessionHandle.sleep()` and `SessionHandle.monitor()` are host-process conveniences. Both use local timers, so process exit loses the outstanding delay or monitor loop even when the session has a durable engine. Individual monitor ticks can still be durable runs; the monitor controller itself is not persisted or recovered.

For a process that only needs to reconnect to an existing durable run, construct the handle with the same session store, engine, and checkpoint store, then call `await session.recover()` without calling `run()` first. Recovery returns `null` when no run is available or when an engine resume fails, and emits `session.recover` failures for inspection, including a reconciliation persistence failure. `run()` requires configured `runOptions` and throws `MissingRunOptionsError` synchronously before reserving a run when they are absent.

```typescript
const session = createSessionHandle(sessionId, {
  store,
  agentName: 'assistant',
  engine,
  checkpointStore,
  // No runOptions are needed for this recover-only path.
});
const recovered = await session.recover();
if (recovered) await recovered.result();
```

An elicitation callback returns a response carrying the same immutable request identity and schema-validated data, or `null` to decline/cancel:

```typescript
const onElicitation: OnElicitation = async (request) => ({
  requestId: request.requestId,
  ...(request.toolCallId ? { toolCallId: request.toolCallId } : {}),
  data: request.schema.parse({ approved: true }),
});
```

Each persisted `RunRef` carries the exact `userMessageId` when available and a safe terminal `outcome`. Both fields are optional for older records, so an absent `outcome` does not mean the run completed successfully. Engine-level cancellation is recorded as `{ finishReason: 'aborted' }`; engine failure and timeout are recorded as `{ finishReason: 'error' }`. Failed schema validation retains `finishReason: 'stop-condition'` and records the safe `output`/`INVALID_OUTPUT` classifier, so consumers must also inspect `outcome.error`.

New `RunRef` records also retain `baseConversationMetadata`, captured when the run is reserved, so recovery can apply the checkpoint's metadata changes while preserving concurrent session edits. Older records without this snapshot use current-session precedence for conflicting metadata and apply only candidate-only additions; terminal records keep their current metadata during repeated reconciliation.

`session.cancel()` requests cancellation immediately. An attached run owns the terminal transaction: await its `result()` to observe the persisted outcome and final transcript. Without an attached run, cancellation reconciles the engine’s actual terminal state and available checkpoint history; without a checkpoint store, it retains the session’s existing history. A matching terminal record keeps its classification and known rows while accepting missing transcript rows from the same run. Cancellation cannot clear a newer run’s handle or overwrite another terminal classification. For a recovered run, `closed()` and `session.closed()` wait for the terminal session commit; a failed commit yields a failed cleanup acknowledgement.

Pass an `AbortSignal` to clear the active timer and stop the operation:

```typescript
const controller = new AbortController();

const monitoring = session.monitor({
  every: 'PT30S',
  input: 'Check deployment health',
  until: (result) => result.content.includes('healthy'),
  signal: controller.signal,
});

controller.abort();
await monitoring; // rejects with AbortError
```

Use a Weft-backed run wakeup or signal when a current run must survive restart, and use a Bureau recurring schedule when future runs must survive restart. Session timing does not switch to those durable capabilities implicitly.

### Session liveness (AB-88, AB-214, AB-215)

`SessionHandle` implements `LivenessObservable` (`@lostgradient/operative`): `snapshot()` returns a `LivenessSnapshot` narrowed to `kind: 'session'`, and `subscribeSnapshot(observer, options?)` delivers it immediately, then again on every revision change. Unlike an `AgentRun`, a session never reaches a terminal liveness status—it can always accept another `run()`—so a `subscribeSnapshot` subscription stays open until `unsubscribe()` or `options.signal` aborts it. `durability` is always `'process-local'` (AB-39: session monitoring is not durable-ized by this record).

```typescript
const subscription = session.subscribeSnapshot((snapshot) => {
  console.log(snapshot.status, snapshot.reachability, snapshot.missedPulseCount);
});

await session.monitor({ every: 'PT30S', input: 'Check deployment health', until: () => false });
subscription.unsubscribe();
```

The `session.monitor` `StallPolicy` row (`policies.ts`) drives a watchdog for the lifetime of an active `monitor()` loop only—built via `createStallWatchdog` over the SAME `setTimeoutFunction`/`clearTimeoutFunction` pair `sleep()`/`monitor()` already use (no second timer seam), and disposed once the loop returns or throws, so a session not currently being polled accrues no missed pulses. Each `session.monitor.tick` records a `'host-reachability'` pulse—a caller's own poll tick proves the process is scheduling callbacks, not that the underlying watched work is progressing—which sets `lastActivityAt`/`lastHeartbeatAt`/`lastProgressAt` on the snapshot.

A `HumanWaitParkedEvent` observed on a run this session started (typically from a `requestHumanInput`-style tool) moves the session to `status: 'waiting'` with a `DeclaredWait`: `reason: 'review'` when the event carries a `prompt`, `reason: 'signal'` otherwise, and `deadline` intentionally absent—both are legal unbounded waits per AB-88's unbounded-wait exception. The watchdog is paused (not merely ignored) for the wait's duration, so elapsed time never accrues toward stalled/unreachable, and resumes with a fresh instance once `session.signal()` delivers the matching signal.

### `createLazyAgent(loader, options?)`

Type-preserving lazy loading for a whole `RunnableAgent` (AB-21)—instructions, tools, and output schema together, not just the `generate` function (`createLazyGenerate` covers that narrower case: `createAgent({ generate: createLazyGenerate(loader) })`). It defers `import()`ing an agent's module until the first `run()` call, while still returning an `AgentRun` handle synchronously:

```typescript
import { createLazyAgent } from '@lostgradient/operative';

// A named export: select it inside the loader—there is no selector overload.
const researcher = createLazyAgent(() =>
  import('./agents/researcher').then((module) => module.researcher),
);

const run = researcher.run('Summarize the Q3 report.'); // synchronous—no await here
const result = await run.result(); // the module loads on first run(), then is cached

// A default export: `createLazyAgent` accepts the raw `import()` result
// directly and unwraps `.default` itself (AB-15's `AgentModule<O, H>`).
const plugin = createLazyAgent(() => import('./agents/plugin'));
```

`createLazyAgent`'s `options` also accepts `runtime?: RuntimeServices` (AB-92/AB-252/AB-325)—the clock the synthetic liveness snapshot reads through for the window before the underlying agent resolves (`startedAt`/`observedAt`), forwarded into `createDeferredAgentRun`. Defaults to the real implementation.

`createLazyAgent`'s return value is an ordinary `RunnableAgent<O, H>`—the same shape `createAgent` produces—so it slots into an `AgentDefinitions` map without unwrapping. The first successful load is cached and shared across concurrent `run()` calls; a load failure clears only that pending load, so a later `run()` retries.

Because this return value is synchronous—built before the loader has ever run—`hasOutput` is a live getter, not a value frozen at construction (AB-234). Before the loader resolves it falls back to `options.hasOutput` (typed as `H` itself, so it cannot disagree with the call's own type argument—pass `{ hasOutput: true }` for a schema-backed agent; defaults to `false`, matching `H`'s own default); once resolved, it switches to reading the _loaded_ agent's own `hasOutput` directly, regardless of what (or whether) `options.hasOutput` said—so an omitted or inaccurate provisional value can never leave a permanently wrong witness once loading completes.

Each `run()` call owns its own `waiting → started → terminal` state, independent of every other call to the same lazy agent:

- `input` and `context` are both snapshotted synchronously at `run()` call time (matching `createAgent`'s own snapshot semantics), so a caller mutating the object it passed in—after `run()` already returned—never leaks into this run.
- Events emitted before the underlying agent resolves are buffered and replayed to the returned handle's async iterator once a consumer actually starts iterating; a caller who only ever calls `result()` never subscribes to the underlying event stream at all, so a long or tool-heavy run doesn't grow an unbounded buffer of events nobody reads.
- `run.abort(reason)` called before resolution completes means the underlying agent's `run()` is never called at all—a fast abort, not a delayed one; an abort that raced synchronously inside `agent.run()` itself disposes the handle it just returned instead of leaving it running unobserved.
- `run.abort(reason)` called after resolution forwards to the real handle exactly once. `context.signal` is passed straight through to the underlying agent's own `run()`, so once the underlying handle exists, the wrapper stops separately forwarding that same signal—a compliant agent is already responsible for honoring it directly, and forwarding twice would risk duplicating non-idempotent cleanup.
- `result()`, `unwrap()`, and `output()` delegate to the real handle once it exists.

A loader that throws or rejects surfaces `AsyncDefinitionLoadError` (the same error `createLazyGenerate` uses, kind `'load'`). A loader that resolves to something that isn't a valid `RunnableAgent`—or whose `run()` returns something that isn't a valid `AgentRun` (missing `result`, `abort`, iteration, or `[Symbol.dispose]`)—surfaces `AgentContractError` (kind `'contract'`, code `'INVALID_AGENT_HANDLE'`) instead: the load itself succeeded, so this isn't retried on the next `run()` call. Either failure is delivered both ways—the returned `AgentRun`'s `result()` resolves with `finishReason: 'error'` (or `'aborted'`) and the matching event, and its async iterator yields that one event before completing.

### `createActiveRun(options)`

The full-control factory behind `createAgent`, `createSessionHandle`, and bureau-owned agents alike—documented, public API, not an internal implementation detail. It accepts the complete `RunOptions` bag directly: an existing `Conversation` instance (not just a `ConversationHistory`), a pre-built `Toolbox`, hooks, and durable routing (engine + checkpoint store + run id). `bureau` and `evaluation` both depend on it as first-party consumers.

Most callers should reach for `createAgent({...}).run(...)` instead—it wraps `createActiveRun` in the higher-level `AgentRun` handle and covers the common cases. Reach for `createActiveRun` directly when you need something `createAgent` doesn't expose: an already-live `Conversation` instance, durable routing, a `hooks` registry for that one run, structured output via `output`, or a pre-built emitter to bind tool dispatches to.

```typescript
import { createActiveRun, stopWhen } from '@lostgradient/operative';

// `stopWhen` is required for the in-memory loop to finish on an ordinary turn:
// without a stop condition, a text-only provider response keeps advancing until
// `maximumSteps` (25) instead of returning after the first reply.
const activeRun = createActiveRun({
  generate,
  toolbox,
  conversation,
  stopWhen: [stopWhen.noToolCalls()],
});
const result = await activeRun.result;
console.log(result.content, result.usage.total);
```

Like `createAgent`, a plain `ConversationHistory` passed here is SNAPSHOTTED on the way in, so a host that keeps mutating its stored history between turns cannot corrupt an in-flight run. Pass an already-live `Conversation` instance instead when you deliberately want the run to share it.

**`RunOptions`**—the complete options bag accepted by `createActiveRun`; key fields:

| Field | Type | Description |
| --- | --- | --- |
| `generate` | `GenerateFunction` | Required. The caller-supplied LLM call. |
| `toolbox` | `Toolbox` | Required. Tool registry. |
| `conversation` | `Conversation \| ConversationHistory` | Required. Seed conversation. |
| `stopWhen` | `StopCondition \| StopCondition[]` | Loop exit predicates. |
| `maximumSteps` | `number` | Hard step cap (default: `25`). |
| `retry` | `RetryOptions` | Transient generate failure retry policy. |
| `backpressure` | `BackpressureStrategy` | Delay strategy applied before each step. |
| `onElicitation` | `OnElicitation` | Human-in-the-loop input handler. |
| `contextManagement` | `ContextManagementOptions` | Automatic context compaction. |
| `output` | `ZodType` | Structured output schema (AB-18) with retry. MUST NOT declare a field intended to carry binary or media content—a generated asset belongs in `RunResult.parts` as a managed-asset reference, never inlined as base64. |
| `schemaRetries` | `number` | Retry attempts on schema validation failure. |
| `onMaximumSteps` | `(context) => Promise<string \| void>` | Called when the loop exits on `maximumSteps`—a returned string replaces `content`. |
| `hooks` | `HookRegistry<OperativeHookMap>` | The run's hook plan. The ONLY hook surface — COR-1268 removed the seven parallel array fields (`prepareStep`, `beforeToolExecution`, `afterToolExecution`, `onStep`, `validateResponse`, `validateToolResult`, `selectTools`), because two surfaces meant ordering depended on which one a caller reached for and everything built on registration identity was blind to the arrays. |
| `sessionId` | `string` | The session this run belongs to, when it belongs to one. Read only to stamp the run's hook-plan observations. |
| `childCorrelation` | `HookObservationCorrelation` | Set by `dispatchChildRun` when this run is somebody's child, so its hook observations name the parent-child pair. Correlation data, never a hook surface. |
| `parentSignals` | `ChildSignalPort` | Set (through `AgentRunContext.parentSignals`) when this run's parent dispatched it with a signal contract. Every tool call receives it as `ToolContext.executionContext.parentSignals`; read it with `readParentSignals`. In-memory only. |
| `signal` | `AbortSignal` | External cancellation signal. |
| `runId` | `string` | Stable run identity, used to stamp curated `tool.*` bubble events. Optional for a run with no `steering` (only supplied when the run has one, e.g. session-owned runs)—**required whenever `steering` is set** (AB-236): `RunOptions` is a discriminated pair on `runId`/`steering`, not two independently-optional fields, so a steering-enabled `RunOptions` literal with no `runId` is a compile error, not a silently-dropped `steering.applied` event. |
| `steering` | `SteeringGate` | AB-67 runtime steering: `{ sessionId, getDesiredState(), awaitResume(), getAppliedFloor?() }`, consulted at the entry of every step. `paused: true` blocks the step until `awaitResume()` resolves or `signal` fires. `sessionId` (AB-221) stamps `steering.applied`'s `sessionId` field. `getAppliedFloor?()` (AB-199)—optional, the highest `configVersion` the gate has already observed applied by ANY run on the session—seeds a brand-new run's cross-run dedupe cursor (`executeLoop`/the durable driver call it once, at run start only) so a `configVersion` a prior run already applied is not re-fired as `steering.applied`; a gate that omits it seeds every fresh run at 0, unchanged from before AB-199. Optional—omit for unsteered runs; setting it requires `runId` (see above). |
| `selection` | `SelectionGate` | AB-64/AB-250 selection-revalidation gate: `{ getPlan(), revalidate() }`, both synchronous and pure, consulted at the same boundary as `steering` (after the pause-wait loop, before backpressure). A revalidated plan that no longer reaches `outcome: 'selected'` fails the step with `SelectionRevalidationError`. No `runId` coupling. Optional—omit for a run with no selection dependency. |

**`RunResult`:**

```typescript
interface RunResult {
  conversation: Conversation;
  steps: readonly StepResult[];
  content: string;
  usage: TokenUsage; // { prompt, completion, total }
  finishReason: FinishReason; // 'stop-condition' | 'maximum-steps' | 'aborted' | 'error' | …
  error?: unknown;
  schemaValidation?: { success: boolean; error?: unknown }; // present when `output` is set
}
```

**`ActiveRun` interface**—returned by `createActiveRun`, the event-emitting entry point. Attach listeners before awaiting `result`:

| Member | Description |
| --- | --- |
| `result: Promise<RunResult>` | Resolves when the loop completes. |
| `durablyStarted?: Promise<void>` | AB-361—durable branch only; see below. |
| `abort(reason?)` | Cancels the loop immediately; `result` resolves with `finishReason: 'aborted'` when cancellation is observed. |
| `closed(options?)` | Cleanup acknowledgement—see below. |
| `complete()` | Completes the event stream without aborting the loop. |
| `addEventListener(type, listener)` | Standard `EventTarget` listener. |
| `removeEventListener(type, listener)` | Removes a listener. |
| `on(type)` | Returns an `ObservableLike` stream for the event type. |
| `once(type, listener)` | One-time listener. |
| `subscribe(type, observer)` | RxJS-style subscription. |
| `events(type, options?)` | `AsyncIterableIterator` of typed events. |
| `toObservable()` | All events as a single `ObservableLike`. |
| `snapshot()` | Current `LivenessSnapshot`—see below. |
| `subscribeSnapshot(observer, opts?)` | Non-consuming liveness observer—see below. |
| `[Symbol.dispose]()` | Aborts and completes—use with `using`. |

**`durablyStarted` (AB-361).** On the durable branch (`createActiveRun(options, { engine, checkpointStore, runId })`), `durablyStarted` settles once this run's initial workflow record is durably committed—the write `context.engine.start(...)` performs—distinct from `result` (the run's own completion). A caller that needs the started-work control contract's durability guarantee (AB-34/AB-15: an acknowledged run is recoverable after any later crash) awaits it before treating a returned run identifier as durable; a caller that never reads it is unaffected, including when `engine.start` rejects. The in-memory branch leaves it `undefined`—there is no durable write to await.

**Liveness (AB-88, AB-214).** `ActiveRun`, `AgentRun`, and `DiagnosticAgentRun` all implement `LivenessObservable`: `snapshot()` returns the current `LivenessSnapshot` synchronously (never starts work, never blocks, never mutates); `subscribeSnapshot(observer, options?)` delivers that snapshot immediately, then a new one on every revision change, and delivers a terminal snapshot exactly once for already-terminal work. See `@lostgradient/operative` below for the full type contract and `createStallWatchdog`.

**Event types** emitted on `ActiveRun` (all prefixed by their lifecycle stage):

`run.started`, `run.completed`, `run.error`, `run.aborted`, `step.started`, `step.generated`, `step.completed`, `step.aborted`, `generate.started`, `generate.completed`, `generate.replay-data-dropped`, `generate.error`, `generate.retry`, `tools.executing`, `tools.executed`, `response.validated`, `tool-result.validated`, `context.compacted`, `context.budget-warning`, `elicitation.requested`, `elicitation.resolved`, `backpressure.applied`, `backpressure.released`, `usage.accumulated`, `session.saved`, `session.loaded`, `steering.applied` (AB-67/AB-221—dispatched at the `runStep` boundary; see the `SteeringGate`/steering command table above and `documentation/operative-type-safe-api.md`'s "Steering commands" section for `steering.accepted`/`rejected`/`superseded`/`failed`—exported here, documented as Bureau's `submitSteeringCommand` (AB-199) events to dispatch, but not yet actually dispatched by anything: `ActiveRun`'s in-memory driver exposes no external `dispatchEvent` surface for an owner outside the run to use, a named gap `documentation/operative-type-safe-api.md`'s "Steering commands" section tracks). `budget.threshold` and `budget.exceeded` are also exported members of `OperativeEventMap`, but neither has a production dispatch site: `createCostBudgetMonitor` (below) reports threshold and exhaustion through its own plain `onThreshold`/`onExceeded` callbacks, not by dispatching these events, so a subscriber never receives either one. `budget.exceeded` (`BudgetExceededEvent`) is additionally `@deprecated`—AB-231 settled budget-exceeded accounting through a `run.completed` event whose `finishReason` is `'budget-exceeded'` instead, reached only via a thrown `BudgetExceededError` (not `createCostBudgetMonitor`'s `stopCondition`, which resolves with `finishReason: 'stop-condition'`) (AB-365).

Tool settlement is represented by the run's sealed `tool-result.validated` event and corresponding `StepResult` tool result. Filtering occurs before execution, so a filtered tool has no scripted settlement call; hook and validation failures preserve their final result payload and outcome in the emitted step result.

```typescript
// Iterate events as an async stream
for await (const event of activeRun.events('step.completed')) {
  console.log(event.step, event.content);
}
```

### `GenerateFunction`

The interface operative never provides for you. Wire in any provider:

```typescript
import type { GenerateFunction } from '@lostgradient/operative';

// Stub for tests or demos
const generate: GenerateFunction = async ({ conversation, toolbox }) => ({
  content: 'I can help with that.',
  toolCalls: [],
  usage: { prompt: 10, completion: 8, total: 18 },
});
```

The root also exports ready-made generate functions for Anthropic, OpenAI, and Gemini.

### Sessions

The main entry point exposes session helpers for direct session management without a `SessionStore`:

- **`createAgentSession(options)`**: Creates a new `AgentSession` object.
- **`loadAgentSession(persistence, sessionId)`**: Loads an `AgentSession` from a conditional text-value store.
- **`saveAgentSession(persistence, session)`**: Persists an `AgentSession` through conflict-aware session storage.

```typescript
import { createAgentSession, loadAgentSession, saveAgentSession } from '@lostgradient/operative';
import { createConversationHistory } from 'conversationalist';
import { MemoryStorage, textValueStore } from '@lostgradient/weft';

// Direct persistence (see createSessionStore() below for the full SessionStore API)
const store = textValueStore(new MemoryStorage());
const session = createAgentSession({
  agentName: 'my-agent',
  conversationHistory: createConversationHistory(),
  id: 'session-abc',
});

await saveAgentSession(store, session);
const loaded = await loadAgentSession(store, 'session-abc');
```

For richer session management, [`createSessionStore()` and `resumeSession()`](#createsessionstore-and-resumesession) are available from the same package root and documented below.

### `createSessionStore()` and `resumeSession()`

```typescript
import {
  createActiveRun,
  createSessionStore,
  resumeSession,
  stopWhen,
} from '@lostgradient/operative';
import type { GenerateFunction } from '@lostgradient/operative';
import { createToolbox } from 'armorer';
import { MemoryStorage, textValueStore } from '@lostgradient/weft';

// createSessionStore requires a real Weft `ConditionalTextValueStore`—it
// checks for a `.conditionalBatch` method, so a hand-rolled `{ get, set,
// delete }` stub throws `TypeError: createSessionStore requires a
// ConditionalTextValueStore`. For tests and prototyping, wrap an in-memory
// `MemoryStorage` with `textValueStore()` (from `@lostgradient/weft`)
//—this is the same pattern operative's own test suite uses. Swap in a
// real Weft-backed store for production.
const kvStore = textValueStore(new MemoryStorage());
const sessions = createSessionStore(kvStore);

// resumeSession loads an existing session (or creates a new one) and returns
// the restored Conversation so you can pass it into a run.
const { session, conversation, isNew } = await resumeSession(sessions, 'session-abc', {
  agentName: 'my-agent',
});

await sessions.save(session);
const summaries = await sessions.list({ agentName: 'my-agent', sortBy: 'updatedAt' });
const loaded = await sessions.load('session-abc');

// Then drive a run from the restored, already-live Conversation instance.
// createAgent().run() only accepts a plain ConversationHistory (it snapshots
// its own fresh Conversation internally); createActiveRun accepts a live
// Conversation directly, which is what resumeSession returns. `isNew` is
// true here (fresh in-memory store), so this conversation has no history
// yet—append a turn before running, the same as the Conversation example
// above, or a real provider sees an empty message list.
conversation.appendUserMessage('Summarize the docs.');
// `generate` and `toolbox` follow the same shapes introduced in Quick Start
// above—swap in a real provider and a populated `createToolbox()` toolbox.
const generate: GenerateFunction = async () => ({ content: 'Echo', toolCalls: [] });
const toolbox = createToolbox([]);
const activeRun = createActiveRun({
  generate,
  toolbox,
  conversation,
  stopWhen: stopWhen.noToolCalls(),
});
const result = await activeRun.result;

// `resumeSession` deep-clones the stored history into `conversation`, so
// the run above updates `conversation.current` without touching
// `session.conversationHistory` or the stored record—copy it back and
// save, or the resumed turn is lost the next time this session loads.
session.conversationHistory = conversation.current;
await sessions.save(session);

// Once you're done with a session, remove it directly, or reclaim storage
// in bulk on a schedule. This creates and immediately discards a separate,
// disposable session—not 'session-abc' above, whose resumed turn was just
// persisted—so the removal below has a real record to act on.
const { session: scratchSession } = await resumeSession(sessions, 'session-to-discard', {
  agentName: 'my-agent',
});
await sessions.save(scratchSession);
await sessions.delete('session-to-discard');
await sessions.cleanup({ olderThan: 7 * 24 * 60 * 60 * 1000 }); // 1 week
```

**`SessionStore` interface:**

| Method | Description |
| --- | --- |
| `save(session)` | Persist a session with conflict-aware merging. |
| `update(id, updater, options?)` | Read-modify-write a session through optimistic concurrency. `options.refreshActivity` (default `true`) controls whether a successful write stamps a fresh `updatedAt`; pass `false` for a background write (e.g. pruning stale metadata) that must not read as session activity. |
| `load(id)` | Load by id; returns `undefined` if not found. |
| `delete(id)` | Remove a session atomically. Resolves `true` only when this call itself removed a live record, `false` when there was nothing to remove—already gone, or never existed. A custom store must implement this as one delete-and-count operation, never a separate existence check followed by a delete, so a caller can tell which of two racing callers actually won (AB-371). |
| `delete(id, { returnIncarnation: true })` | The same atomic delete, additionally reporting `{ removed, incarnation }`—the `AgentSession.incarnation` of the body actually removed (AB-384). Use this instead of reading `load(id)` beforehand when the deleted incarnation matters: a separate `load()` has a real race window a concurrent delete-and-recreate can fall into, where this overload has none. |
| `exists(id)` | Check existence. |
| `list(options?)` | Paginated list of `SessionSummary` objects. |
| `updateMetadata(id, metadata)` | Merge metadata without rewriting the conversation. |
| `cleanup(options)` | Delete sessions older than `options.olderThan` ms. |
| `events` | `TypedEventTarget<OperativeEventMap>` (AB-384, re-scoped by AB-389) the store dispatches its commit-outbox drain trigger onto—see below. |
| `outbox` | The commit outbox (AB-389/AB-390): `outbox.pending()` lists undrained `SessionOutboxEntry` records in ordinal order; `outbox.claim(ordinal, { owner, until })` takes exclusive replay rights on one entry until the lease expires; `outbox.acknowledge(ordinal, owner)` removes one once its replay has durably settled, only if `owner` still holds its claim—see below. |

Sessions include a persisted `revision` number. New `AgentSession` objects start at revision `0`; successful `SessionStore` writes increment the stored revision. When concurrent writers save stale copies of the same session, the store retries with Weft's conditional batch primitive and merges conversation messages, run references, and metadata instead of silently dropping one writer's turns.

**Incarnation identity (AB-384):** `AgentSession.incarnation` distinguishes live bodies of the same session id across a delete-then-recreate cycle (a supported flow). `SessionStore` mints it the first time an id's body is committed—a brand-new id, or one recreated after its previous body was deleted—and preserves it unchanged across every later `save()`/`update()` of that same live body. A freshly constructed, not-yet-persisted session (`createAgentSession()`) carries `''`, the same value a pre-AB-384 record loaded from storage defaults to.

**Commit outbox (AB-389):** every successful `save()`, `update()`, or `delete()` commit appends a `SessionOutboxEntry` to the SAME atomic `conditionalBatch` as the body and summary-index write (or the removal)—a discriminated union on `kind`: `{ ordinal, kind: 'session.created' | 'session.saved', sessionId, agentName, incarnation, committedAtMs }` or `{ ordinal, kind: 'session.deleted', sessionId, incarnation, committedAtMs }`. `agentName` is a required `string` for `'session.created'`/`'session.saved'` (every live commit always names an agent) and present only there—a `'session.deleted'` entry has no live body left to describe. `committedAtMs` is the wall-clock time (`RuntimeServices.clock.now()`) THIS commit was appended, not the time a later drain happens to read it back—persisted so a delayed replay (a stalled maintenance pass, or a process restart) stamps durable history and the audit trail with the true commit time. `kind` is `'session.created'` the first time an id's body is committed, `'session.saved'` on every later commit of the same live body, or `'session.deleted'` for a `delete()` that actually removed a live record (a delete that removes nothing appends no entry and consumes no ordinal). `ordinal` is the store's own commit ordinal: a single monotonically increasing counter shared across every session id in this store, never a per-session `revision`—a caller draining entries in ordinal order sees every commit across the whole store in true commit order, even across two `SessionStore` instances sharing one persistent backend. `outbox.pending()` fails loudly (throws), rather than silently treating the entry as absent, when a stored entry is malformed—it is the sole record of a durable lifecycle fact until a drain replays it, so silently skipping a corrupt one would misorder or lose that fact instead of surfacing the corruption.

The store does **not** dispatch `SessionCreatedEvent`/`SessionSavedEvent`/ `SessionDeletedEvent` directly anymore—that direct, fire-and-forget dispatch was a known limitation (AB-384, PR #592): a crash between a commit succeeding and its listener's write running lost the fact forever, with no recovery-time producer to reconstruct it, and two `SessionStore` instances over one shared backend could record events out of true commit order. `save()`/`update()`/ `delete()` now dispatch only `SessionOutboxAppendedEvent` on `SessionStore.events`—a best-effort drain trigger naming the appended entry's ordinal, never the event itself. A caller that needs the actual `session.created`/`session.saved`/ `session.deleted` facts must drain `outbox.pending()`, `claim()` each entry it intends to replay, replay it as the matching event, and acknowledge it only once that replay's own durable write has settled—Bureau's own drain loop (`drainOutbox` in `create-bureau.ts`, generalized as of AB-391 to also replay `session.attachment` entries) does exactly this, run on the runtime clock inside the durable maintenance pass, right after each commit, and during boot recovery before serving reads.

**Caller-supplied attachments (AB-391):** `update(id, updater, { outbox })` accepts a fourth `SessionOutboxEntry` variant a caller couples its own durable write to this commit with: `{ ordinal, kind: 'session.attachment', sessionId, incarnation, namespace, payload, committedAtMs }`, where `namespace`/`payload` are opaque to this store—interpreted only by whichever consumer recognizes the namespace it appended. `options.outbox` is a list of `{ namespace, payload }` pairs appended in the SAME `conditionalBatch` as the update's own body/summary/ordinal writes, at consecutive ordinals immediately after the update's own `session.created`/ `session.saved` entry—never appended, and no ordinal consumed, when the updater declines to commit (returns `undefined`). Bureau uses this to couple a review-transition audit record to the session-store commit that resolves the review, under the `'audit-record'` namespace, so a crash between the two can no longer lose the audit record—see `packages/bureau/README.md`'s "Review-transition audit records ride the outbox" section.

`update()` validates every `options.outbox` entry synchronously, before its `conditionalBatch` runs (Codex P2 review finding, PR #601, "Validate attachments before committing malformed outbox entries"): `namespace` must be a non-empty string and `payload` must be defined and JSON-serializable, or it throws `TypeError` immediately. This is the boundary that owns the contract—an untyped caller (or a value cast past `JSONValue`) passing `payload: undefined` would otherwise commit successfully (the session body and outbox ordinal both land), since `JSON.stringify` silently drops an `undefined`-valued key rather than erroring, but every LATER `outbox.pending()` call would then throw on that stored entry (`parseOutboxEntry` requires `payload`)—permanently blocking delivery of it and everything queued behind it, with no self-healing path short of manual storage repair. Validated attachments are then snapshotted (a JSON round-trip, which doubles as the serializability check) before `updater` runs (Codex P2 review finding, PR #601, "Snapshot attachments before invoking the updater")—`updater` is caller code, awaited across this method's own retry loop, and could otherwise mutate one of the SAME attachment objects (setting `payload` to `undefined`, say) after it passed validation but before `commit()` serializes it; the snapshot means only the validated values a caller actually gets back can ever be what commits.

**Claim lease (AB-390):** `pending()` alone claims nothing—it is safe to call repeatedly and concurrently from multiple processes sharing one backend, but two processes both draining the SAME still-unacknowledged entry would both replay it without a claim. `outbox.claim(ordinal, { owner, until })` is a compare-and-swap on the entry's own `claim` field (never a separate lock record) that resolves a `SessionOutboxClaimAttempt`: `{ claimed: true }` when the entry was unclaimed, its prior claim's `until` has already passed by this store's own `RuntimeServices.clock.now()`, or `owner` already held it (claim renewal always succeeds—this is same-owner reentry, not the cross-owner exclusivity the lease protects, and a same-owner renewal can only ever EXTEND the stored `until`, never shorten it, so two overlapping renewal calls can never resurrect an already-expired deadline); `{ claimed: false, lease }` when a DIFFERENT owner holds an unexpired claim or a concurrent same-owner call already won (`lease` names the current winning claim either way, so a caller always has fresh evidence to schedule a retry against—never a stale `pending()` snapshot a peer's own `claim()` may have since invalidated); or `{ claimed: false }` with no `lease` when the entry no longer exists at all (already acknowledged). `outbox.acknowledge(ordinal, owner)` now additionally requires `owner` to still hold the entry's claim—verified by the same compare-and-swap discipline `claim()` uses, retrying against a fresh read when the CAS loses to this same owner's own concurrent renewal—so an owner whose lease lapsed and was reclaimed by a peer can never retire an entry it no longer owns. A drainer that crashes between winning a claim and acknowledging leaves the entry claimed but undelivered only until its own lease's `until` passes; a later drain (this same process's next tick, or a peer's) reclaims and completes it—**at least once, not exactly once**: a crash after `dispatch()` has already run a listener's side effect (or after a durable write has persisted) but before `acknowledge()` leaves the entry pending, and the next drain necessarily replays it again once the lease expires, because a lease prevents two owners from replaying an entry CONCURRENTLY but cannot tell whether a crashed owner's own replay completed first. Every consumer of these events (a durable event history producer, the audit trail, a direct `bureau.addEventListener` subscriber) must be idempotent on its own dedupe key (this outbox's `ordinal`) if redelivery after a crash would otherwise double an effect. This assumes every process draining one shared backend has a runtime clock within the lease's own tolerance of the others'—`claim()` compares `lease.until` against ITS OWN `RuntimeServices.clock.now()`, so a drainer whose clock runs meaningfully ahead of a peer's can treat that peer's live claim as already expired and reclaim it early; operate drainers sharing a backend with synchronized clocks (NTP or equivalent) within a small fraction of the lease duration.

`save()`/`update()` reject with `StaleSessionIncarnationError` when a candidate names a specific, nonempty `incarnation` that no longer matches the live body's current one—writing back a prior incarnation's own object after that body was deleted and the id recreated. A candidate with `incarnation: ''` (the `createAgentSession()` default) is never rejected this way.

```ts
import { createSessionStore } from '@lostgradient/operative';
import { MemoryStorage, textValueStore } from '@lostgradient/weft';

const sessions = createSessionStore(textValueStore(new MemoryStorage()));
const LEASE_MS = 30_000;
// Unique across PROCESSES, not merely across calls in this one—two
// processes minting `drainerId` the same deterministic way (a fixed
// literal, a shared counter seed) would look like the SAME owner to
// `claim()`, letting both replay concurrently. The production drainer adds
// exactly this kind of real-randomness suffix to its own id for the
// identical reason.
const drainerId = `my-drainer-instance:${crypto.randomUUID()}`;

let retryTimer: ReturnType<typeof setTimeout> | undefined;
function scheduleRetry(atMs: number): void {
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = setTimeout(
    () => {
      retryTimer = undefined;
      drain().catch((error: unknown) => console.error('outbox retry drain failed:', error));
    },
    Math.max(0, atMs - Date.now()),
  );
}

// Single-flighted, the same way Bureau's own `drainOutbox` is: two
// `session.outbox-appended` events firing before the first callback below
// finishes must join ONE drain rather than run two overlapping ones—two
// concurrent callbacks sharing `drainerId` would each look like a valid
// same-owner claim renewal to the OTHER, letting both replay the same
// entry.
let drainInFlight: Promise<void> | undefined;
let rerunRequested = false;
async function drain(): Promise<void> {
  if (drainInFlight) {
    rerunRequested = true;
    return drainInFlight;
  }
  drainInFlight = (async () => {
    try {
      do {
        rerunRequested = false;
        // Ordinals define store-wide replay order—stop at the first
        // entry this drainer cannot own, rather than skipping ahead to a
        // later one, or a `session.saved`/`session.deleted` could replay
        // before an earlier `session.created` a peer still holds.
        for (const entry of await sessions.outbox.pending()) {
          const attempt = await sessions.outbox.claim(entry.ordinal, {
            owner: drainerId,
            until: Date.now() + LEASE_MS,
          });
          if (!attempt.claimed) {
            // A peer already holds this entry's lease—wake up and try
            // again right when it expires, rather than depending on some
            // unrelated future trigger to ever retry this store-wide
            // choke point.
            if (attempt.lease) scheduleRetry(attempt.lease.until);
            return;
          }
          // Keeps the lease alive for as long as replaying this ONE entry
          // takes—a slow durable write or a slow verification read could
          // otherwise outlast the fixed lease above, letting a peer
          // reclaim and replay the SAME entry while this callback is still
          // working it.
          const renewal = setInterval(
            () => {
              sessions.outbox
                .claim(entry.ordinal, { owner: drainerId, until: Date.now() + LEASE_MS })
                .catch((error: unknown) => console.error('outbox lease renewal failed:', error));
            },
            Math.floor(LEASE_MS / 3),
          );
          try {
            console.log(`outbox entry ${entry.ordinal}: ${entry.kind} for ${entry.sessionId}`);
            // Replay `entry` as the real event, await its own durable write, THEN:
            const acknowledged = await sessions.outbox.acknowledge(entry.ordinal, drainerId);
            if (!acknowledged) return; // lost the claim before acknowledging
          } finally {
            clearInterval(renewal);
          }
        }
      } while (rerunRequested);
    } finally {
      drainInFlight = undefined;
    }
  })();
  await drainInFlight;
}

sessions.events.addEventListener('session.outbox-appended', () => {
  drain().catch((error: unknown) => console.error('outbox drain failed:', error));
});
```

### Forking a session through a completed run (COR-816)

`SessionHandle.fork(options?)` creates a new session with a new id and an empty run list. With `throughRun` (a 0-based run sequence), its conversation is rebuilt from that terminal run's immutable `RunRef.conversationBoundary`, so no message from a later run reaches the fork. Tool calls stay paired with their results. Without `throughRun`, the fork copies the session's latest stored history. Nothing is shared between the two sessions afterwards, and a `SessionForkEvent` (`session.fork`, with `sourceSessionId`, `forkedSessionId`, and `throughRun`) fires once the fork is persisted. Each terminal `RunRef` records its boundary once, as a `RunConversationBoundary` delta-encoded against an earlier run's boundary, and never rewrites it.

```typescript
import {
  createSessionHandle,
  createSessionStore,
  ForkThroughRunError,
  type GenerateFunction,
  stopWhen,
} from '@lostgradient/operative';
import { MemoryStorage, textValueStore } from '@lostgradient/weft';
import { createToolbox } from 'armorer';

const generate: GenerateFunction = async ({ conversation }) => ({
  content: `reply to message ${conversation.getMessages().length}`,
  toolCalls: [],
});

const store = createSessionStore(textValueStore(new MemoryStorage()));
const session = createSessionHandle('support-thread', {
  store,
  agentName: 'assistant',
  // Session runs do not default `stopWhen` the way `createAgent` does.
  runOptions: { generate, toolbox: createToolbox([]), stopWhen: stopWhen.noToolCalls() },
});

await session.run('First question').result(); // run 0
await session.run('Second question').result(); // run 1

const branch = await session.fork({ throughRun: 0 });
const forked = await branch.getSession();
// forked.id is new, forked.runs is [], and the history holds run 0's
// question and reply only.

let reason: string | undefined;
try {
  await session.fork({ throughRun: 5 });
} catch (error) {
  if (error instanceof ForkThroughRunError) reason = error.reason; // 'out-of-range'
}
```

`test/multi-agent-lifecycle-guide.test.ts` runs this example and asserts each commented result.

An unusable fork point rejects with `ForkThroughRunError` before anything is persisted or any event fires. Its `reason` (`ForkThroughRunErrorReason`) is `'invalid'` (not an integer), `'negative'`, `'out-of-range'` (no run with that sequence yet), `'non-terminal'` (the run is still running), or `'unavailable'` (the run is terminal but has no reconstructable boundary—a legacy `RunRef`, or a terminal commit with no transcript to record). The error also carries `sessionId`, `throughRun`, and `runCount`.

A fork is a branch of history, not a child run: it has no parent relationship, signal channel, or cancellation link, and it does not replay tool calls or clone an in-flight provider request. A fresh attempt, context compaction, subagent summaries, and same-session handoffs are separate mechanisms with different histories; [Fresh attempts and conversation policies](#fresh-attempts-and-conversation-policies-cor-1354) compares them.

### Fresh attempts and conversation policies (COR-1354)

A retry or reset that must not inherit a failed attempt's transcript starts from a typed, validated handoff artifact instead. The artifact carries the minimum state the next attempt needs (objective, constraints, completed work, validated facts, known failures, open questions, the next action, and references to evidence) and has no field that can hold a message or a transcript. Operative keeps this apart from every other way an attempt can get its context:

| Mechanism | API | Session | What the next run starts from |
| --- | --- | --- | --- |
| Continue | `SessionHandle.run()` | Same | The stored history, appended to in place. |
| Fork from baseline | `SessionHandle.fork(options?)` | New id, `runs: []` | A verbatim copy of the stored history or, with `{ throughRun }`, of that terminal run's recorded boundary. An unusable fork point rejects with `ForkThroughRunError` (`reason`: `invalid`, `negative`, `out-of-range`, `non-terminal`, or `unavailable`) before anything is saved. |
| Fresh from artifact | `SessionHandle.startFreshAttempt({ artifact, instructions })` | New id, `runs: []` | Exactly two messages: `instructions` as a system message and one rendering of the validated artifact as a user message. No message of the source session is copied, by id or by content. |
| Same-session handoff | `createHandoffTool()` | Same | Unchanged. The tool returns a marker, and the caller decides which agent continues the same conversation (see Handoffs under [Multi-Agent Patterns](#multi-agent-patterns)). |
| Subagent summary | `createSubagentTool()` | The child's own | The parent keeps its own history plus the tool result, by default a capped summary of the child's `content`. |
| Compaction | `createContextCompactor()` | Same | The same conversation, with older messages replaced in place by a summary system message and the most recent `retainRecentMessages` visible non-system messages kept. Kept messages keep their identifiers (only their position changes), and hidden messages are kept, never summarized or dropped; conversationalist's [What compaction keeps](../conversationalist/README.md#what-compaction-keeps) lists the current limits. |

#### Choosing a policy

`ConversationPolicy` names the first three rows as values, so a controller can decide which one an attempt gets:

```typescript
type ConversationPolicy =
  | { kind: 'continue' }
  | { kind: 'fork-from-baseline'; throughRun?: number }
  | { kind: 'fresh-from-artifact'; artifact: FreshAttemptHandoffArtifact };
```

`applyConversationPolicy(session, { policy, instructions })` resolves the `SessionHandle` an attempt should run in: `session` itself for `continue` (also the result when `policy` is omitted), `session.fork()` for `fork-from-baseline`, and `session.startFreshAttempt()` for `fresh-from-artifact`. Only `fresh-from-artifact` reads `instructions`; a continued or forked conversation already carries its own.

```typescript
const attempt = await applyConversationPolicy(session, {
  policy: { kind: 'fresh-from-artifact', artifact },
  instructions: 'You are the implementer. Follow AGENTS.md.',
});
await attempt.run('Continue from the handoff.').result();
```

Nothing calls it for you. `SessionHandle.run()`, `createAgent().run()`, and `createActiveRun()` take no policy and always continue the conversation they are given.

#### A reset from start to finish

The host owns three things Operative does not keep: the producing run's sealed context epoch, the actors allowed to publish for that run, and the artifact's text. This example runs a first attempt, records its epoch, publishes a handoff, and starts a fresh attempt from it. It runs offline with a stub `generate`:

```typescript
import {
  applyConversationPolicy,
  createContextEpochSealer,
  createFreshAttemptArtifactStore,
  createSessionHandle,
  createSessionStore,
  finalizeFreshAttemptHandoffArtifact,
  SecretBearingFreshAttemptArtifactError,
  StaleFreshAttemptArtifactError,
  type FreshAttemptHandoffArtifactDraft,
  type FreshAttemptSourceRecord,
  type GenerateFunction,
} from '@lostgradient/operative';
import { MemoryStorage, textValueStore } from '@lostgradient/weft';
import { createToolbox } from 'armorer';

const generate: GenerateFunction = async () => ({
  content: 'The revision-realm test still times out under load.',
  toolCalls: [],
});

// The producing run seals its effective context. The epoch is the only
// record of which sources a fresh attempt may name as carry-forward context.
const sealer = createContextEpochSealer({ agentName: 'implementer' });

// Operative does not keep epochs or publisher lists for you: the host does.
const sources = new Map<string, FreshAttemptSourceRecord>();

const session = createSessionHandle('session-1', {
  store: createSessionStore(textValueStore(new MemoryStorage())),
  agentName: 'implementer',
  runOptions: { generate, toolbox: createToolbox([]), maximumSteps: 1, contextEpoch: sealer },
  resolveFreshAttemptSource: (source) => sources.get(source.runId),
});

// 1. The first attempt runs and fails.
await session.run('Fix the flaky revision-realm test.').result();
const [failedRun] = (await session.getSession()).runs;
sources.set(failedRun!.runId, { epoch: sealer.current()!, permittedActors: ['operator:steve'] });

// 2. The host summarizes the failed attempt. Operative never writes an artifact for you.
const now = new Date().toISOString();
const draft = {
  artifactId: 'revision-realm-handoff',
  revision: 1,
  objective: 'Make revision-realm-execution.test.ts pass under host load.',
  successRevision: 'COR-1333#acceptance-1',
  constraints: ['Never raise a test timeout.'],
  completedWork: ['Replaced the first signal poll with an event wait.'],
  validatedFacts: ['The old file fails 7 of 9 runs with an injected 700 ms boot delay.'],
  evidenceReferences: [{ kind: 'commit', id: '55a9f8d2' }],
  knownFailures: [
    { kind: 'tool', summary: 'bun test timed out waiting for a realm.', occurredAt: now },
  ],
  unresolvedQuestions: ['Does the child-process sibling need the same change?'],
  nextRequestedAction: 'Convert the remaining polls to observed events.',
  allowedCarryForwardContext: ['agent-instructions', 'toolbox'],
  producer: { agentName: 'implementer', runId: failedRun!.runId, sessionId: session.id },
  sourceRunOrAttempt: {
    sessionId: session.id,
    runId: failedRun!.runId,
    sequence: failedRun!.sequence,
  },
  timestamp: now,
  lineage: { sourceRevision: 1 },
  provenance: { producedAt: now, producingActor: 'operator:steve' },
} satisfies FreshAttemptHandoffArtifactDraft;
const artifact = await finalizeFreshAttemptHandoffArtifact(draft);

// 3. Publish it. Every publish-time check runs before anything is written.
const artifacts = createFreshAttemptArtifactStore(textValueStore(new MemoryStorage()), {
  resolveSource: (source) => sources.get(source.runId),
  clock: { now: () => Date.now() },
});
await artifacts.update(artifact.artifactId, () => artifact);

// Publishing revision 1 again loses the compare-and-write: republish as revision 2 instead.
await artifacts
  .update(artifact.artifactId, () => artifact)
  .catch((error: unknown) => {
    if (!(error instanceof StaleFreshAttemptArtifactError)) throw error;
    console.log(error.diagnostics); // [ { path: 'revision', rule: 'revision-conflict' } ]
  });

// 4. Start the fresh attempt from the latest published revision.
const fresh = await session.startFreshAttempt({
  artifact: (await artifacts.load(artifact.artifactId))!,
  instructions: 'You are the implementer. Follow AGENTS.md.',
});
const { runs, conversationHistory, metadata } = await fresh.getSession();
console.log(fresh.id === session.id); // false
console.log(runs.length); // 0
console.log(conversationHistory.ids.map((id) => conversationHistory.messages[id]?.role)); // ['system', 'user']
console.log(metadata['freshAttempt']);
// { artifactId: 'revision-realm-handoff', revision: 1, digest: '<sha-256 hex>',
//   sourceSessionId: 'session-1', sourceRunId: 'session-1:0' }

// A credential typed into an ordinary field is rejected before anything is minted.
const leaky = await finalizeFreshAttemptHandoffArtifact({
  ...draft,
  artifactId: 'leaky-handoff',
  objective: 'Retry with password: swordfish',
});
try {
  await session.startFreshAttempt({ artifact: leaky, instructions: 'You are the implementer.' });
} catch (error) {
  if (!(error instanceof SecretBearingFreshAttemptArtifactError)) throw error;
  console.log(error.outcome, error.kind, error.diagnostics);
  // secret-bearing policy [ { path: 'objective', rule: 'sensitive-key-pattern' } ]
}

// The same reset, chosen by value.
const attempt = await applyConversationPolicy(session, {
  policy: { kind: 'fresh-from-artifact', artifact },
  instructions: 'You are the implementer. Follow AGENTS.md.',
});
await attempt.run('Continue from the handoff.').result();
```

The expected output is in the comments. The fresh session's user message renders every artifact field under its own name; for each allowlisted source it renders only what the epoch recorded (`sourceId`, trust, redaction, revision, and digest), never the source's content. Its metadata records `freshAttemptArtifactId` and `freshAttemptArtifactRevision`. The handle `startFreshAttempt` returns shares the source handle's context, so its runs use the same `runOptions` and resolver.

#### The handoff artifact

| Field | Type | Meaning |
| --- | --- | --- |
| `schemaVersion` | `1` | Stamped by `finalizeFreshAttemptHandoffArtifact`. Its own counter (`FRESH_ATTEMPT_ARTIFACT_SCHEMA_VERSION`), independent of any conversation schema version. |
| `artifactId`, `revision` | string, positive integer | Identity, and the publication counter: `1` on first publication, then one more per republication. |
| `objective`, `successRevision` | string | What the next attempt must achieve, and a reference to the revision of its success criteria (never the criteria text). |
| `constraints`, `completedWork`, `validatedFacts`, `unresolvedQuestions` | `string[]` | Summary statements. Never `Message` objects. |
| `evidenceReferences` | `{ kind, id, digest?, uri? }[]` | References to evidence held elsewhere. Evidence content is never embedded. |
| `knownFailures` | `{ kind, summary, occurredAt }[]` | What already failed. `kind` is an `AgentRunErrorKind`: `load`, `contract`, `generate`, `tool`, `abort`, `output`, or `policy`. |
| `nextRequestedAction` | string | The one next step. |
| `allowedCarryForwardContext` | `string[]` | `sourceId`s from the producing run's sealed context epoch, such as `agent-instructions` or `toolbox`. At most `FRESH_ATTEMPT_ARTIFACT_MAX_CARRY_FORWARD_SOURCES`. |
| `producer` | `{ agentName, runId, sessionId }` | The agent and run that produced the artifact. Its `runId` and `sessionId` must equal `sourceRunOrAttempt`'s. |
| `sourceRunOrAttempt` | `{ sessionId, runId, sequence }` | The run the artifact hands off from. The host's resolver looks it up. |
| `timestamp` | ISO-8601 with offset | When the handoff was produced. Retention is measured from here. |
| `lineage` | `{ parentConversationId?, sourceRevision }` | Mirrors `ConversationSnapshot.lineage` without its conversation-tree fields. |
| `provenance` | `{ producedAt, producingActor }` | Who authorized the write, kept separate from `producer` so an unauthorized actor is detectable. |
| `digest` | `{ algorithm: 'sha-256', value }` | SHA-256 (`FRESH_ATTEMPT_ARTIFACT_DIGEST_ALGORITHM`) over the canonical serialization of every other field: keys sorted, `undefined` members dropped. |

Every string must be non-empty, and every object is strict, so an unknown key is a rejection. `freshAttemptHandoffArtifactSchema` is the Zod schema. Build an artifact from a `FreshAttemptHandoffArtifactDraft` (every field but `schemaVersion` and `digest`) with `finalizeFreshAttemptHandoffArtifact(draft)`, and recompute a digest with `computeFreshAttemptArtifactDigest`. Changing any field after finalizing, without finalizing again, makes the artifact `corrupt`.

#### Validation and rejection

`validateFreshAttemptArtifact(value, { resolveSource, now })` runs before a fresh attempt consumes an artifact, and `validateFreshAttemptArtifactForPublication(value, context)` before the store writes one. Both resolve `{ artifact, source, carryForward }` or reject. The checks run in this order and stop at the first stage that fails:

1. Shape. A value that is not an object is `invalid`. A numeric `schemaVersion` other than `1` is `incompatible`, and the body is never read. A transcript-shaped value anywhere (an object with a `role` key, a raw tool-call or tool-result payload, or a `ConversationHistory`, or a string holding a serialized `role` key or tool payload) is `secret-bearing`. Any other schema failure is `provenance-free` when `producer`, `provenance`, `sourceRunOrAttempt`, or `timestamp` is missing, and `invalid` otherwise.
2. Size. A canonical serialization over `FRESH_ATTEMPT_ARTIFACT_MAX_BYTES` is `oversized`. An artifact is never truncated.
3. Digest. A recomputed digest that differs from `digest.value` is `corrupt`.
4. Window. A `timestamp` or `provenance.producedAt` more than `FRESH_ATTEMPT_ARTIFACT_CLOCK_SKEW_MS` after `now` is `stale`, at publication and at consumption. At consumption only, an artifact whose `timestamp` is more than `FRESH_ATTEMPT_ARTIFACT_RETENTION_MS` before `now` is `stale`.
5. Authorization. `resolveSource(artifact.sourceRunOrAttempt)` must return a `FreshAttemptSourceRecord` (`{ epoch, permittedActors }`), `producer` must name the same session and run, and `provenance.producingActor` must be in `permittedActors`. Otherwise the artifact is `unauthorized`.
6. Secrets. Every string field is checked for a `key: value` or `key=value` pair whose key matches `SENSITIVE_KEY_PATTERN`, an API-key-shaped assignment (the output PII guardrail's API-key rule), a verbatim copy of a `protected-secret` or `forbidden` epoch source (by `digestText`), and a token of at least `FRESH_ATTEMPT_ARTIFACT_ENTROPY_MINIMUM_TOKEN_LENGTH` characters above `FRESH_ATTEMPT_ARTIFACT_ENTROPY_THRESHOLD` bits per character. Any match is `secret-bearing`.
7. Carry-forward. An allowlist longer than the bound, or an entry the epoch does not hold or marks `protected-secret` or `forbidden`, is `overbroad`.

| Outcome | Error class | `kind` | Diagnostic `rule` values |
| --- | --- | --- | --- |
| `invalid` | `InvalidFreshAttemptArtifactError` | `contract` | `not-an-object`, `required`, a Zod issue code such as `invalid_type` or `unrecognized_keys`, and `artifact-id-mismatch` from the store |
| `incompatible` | `IncompatibleFreshAttemptArtifactError` | `contract` | `unsupported-schema-version` |
| `provenance-free` | `ProvenanceFreeFreshAttemptArtifactError` | `contract` | `required` on a provenance field, plus any other schema issue |
| `oversized` | `OversizedFreshAttemptArtifactError` | `contract` | `exceeds-byte-ceiling` |
| `corrupt` | `CorruptFreshAttemptArtifactError` | `load` | `digest-mismatch`, and `unreadable-stored-artifact` from the store |
| `stale` | `StaleFreshAttemptArtifactError` | `load` | `timestamp-in-future`, `retention-window`, and `revision-conflict` from the store |
| `unauthorized` | `UnauthorizedFreshAttemptArtifactError` | `policy` | `source-unresolved`, `producer-source-mismatch`, `actor-not-permitted` |
| `secret-bearing` | `SecretBearingFreshAttemptArtifactError` | `policy` | `transcript-role-key`, `transcript-tool-payload`, `conversation-history-shape`, `sensitive-key-pattern`, `pii-api-key`, `protected-source-digest`, `high-entropy-token` |
| `overbroad` | `OverbroadFreshAttemptArtifactError` | `contract` | `exceeds-bounded-count`, `source-absent-from-epoch`, `source-not-carriable` |

Every class extends `FreshAttemptArtifactError`, itself an `AgentRunError`, and carries `outcome` (a `FreshAttemptRejectionOutcome`), `kind`, and `diagnostics` (`FreshAttemptRejectionDiagnostic[]`, each `{ path, rule }`, with a path such as `knownFailures[0].summary`, or `''` for the whole artifact). Its `code` is always `'UNKNOWN'`, so tell rejections apart by class, `outcome`, or `kind`. A diagnostic never includes the offending value, so a rejection cannot become a second copy of a secret.

The thresholds are exported constants, fixed from a corpus of ten hand-written sample handoffs in `src/fresh-attempt/fixtures/samples/`; `src/fresh-attempt/thresholds.ts` records how each was derived:

| Constant                                              | Value                                   |
| ----------------------------------------------------- | --------------------------------------- |
| `FRESH_ATTEMPT_ARTIFACT_MAX_BYTES`                    | 10,240 bytes of canonical serialization |
| `FRESH_ATTEMPT_ARTIFACT_RETENTION_MS`                 | 7 days after `timestamp`                |
| `FRESH_ATTEMPT_ARTIFACT_CLOCK_SKEW_MS`                | 60 seconds                              |
| `FRESH_ATTEMPT_ARTIFACT_ENTROPY_THRESHOLD`            | 4.5 bits per character                  |
| `FRESH_ATTEMPT_ARTIFACT_ENTROPY_MINIMUM_TOKEN_LENGTH` | 20 characters                           |
| `FRESH_ATTEMPT_ARTIFACT_MAX_CARRY_FORWARD_SOURCES`    | 8 sources                               |

#### Publishing: the artifact store

`createFreshAttemptArtifactStore(backing, { resolveSource, clock })` wraps a Weft `ConditionalTextValueStore` and returns a `FreshAttemptArtifactStore`:

- `update(artifactId, updater)` loads the latest revision, calls `updater(latest)`, runs every publish-time check on the candidate (all of the above except retention, with `clock.now()` as `now`), and commits it with a compare-and-write. The candidate's `artifactId` must match (`invalid`, `artifact-id-mismatch`), and its `revision` must be the latest revision plus one, starting at `1`. A wrong revision, or a concurrent writer that commits first, rejects with `StaleFreshAttemptArtifactError` (`revision-conflict`). A conflict is never merged or retried: read the new latest revision and republish, or give up. An updater that returns `undefined` publishes nothing and resolves the latest revision.
- `load(artifactId)` resolves the latest revision or `undefined`, and `history(artifactId)` resolves every revision, oldest first. Both check only that the stored body parses as an artifact (`corrupt`, `unreadable-stored-artifact`); the digest, retention, and authorization are checked when the artifact is consumed.
- Nothing is ever deleted. Retention decides whether an artifact may still seed a fresh attempt, not whether its record survives, so a failed attempt's handoff stays available for audit and evaluation.

#### Starting the attempt

`SessionHandle.startFreshAttempt({ artifact, instructions })` validates the artifact with `validateFreshAttemptArtifact`, measuring time with the handle's `runtime.clock` and resolving the source through `SessionHandleContext.resolveFreshAttemptSource`. A rejection throws before a session id is minted or anything is saved. On success it saves a new session under the handle's `agentName` with `runs: []`, the two seed messages, and `metadata.freshAttempt` (`{ artifactId, revision, digest, sourceSessionId, sourceRunId }`), and returns a handle over it.

#### What fresh attempts do not do

- **Operative never produces an artifact.** No code in this workspace turns a failed run into a handoff, and no shipped controller chooses a policy for you; the in-memory goal controller `startGoal()` (COR-634) accepts a `fresh-from-artifact` conversation policy but does not produce the artifact. The host writes the draft, including its summaries.
- **Policies are opt-in.** `applyConversationPolicy` is the only function that reads a `ConversationPolicy`. A run started any other way continues its conversation.
- **Operative stores neither epochs nor publisher lists.** Keep the producing run's sealed epoch (the sealer's `current()` right after that run ends, before another run seals a newer one) and the actors allowed to publish for it, and serve them from `resolveFreshAttemptSource`. A handle without a resolver rejects every artifact as `unauthorized`. Neither the validator nor the store checks that the epoch a resolver returns really belongs to that run.
- **Carry-forward context is an allowlist of source identities, not content.** A fresh conversation receives no source's text. Its instructions come from the `instructions` you pass, and its tools and generation settings from the handle's `runOptions`.
- **The secret scan is a second line of defense, not a complete scanner.** The strict schema is the first. The scan misses a credential that is not a `key: value` or `key=value` pair under a key name containing `password`, `secret`, `token`, `apiKey`, `authorization`, `credential`, or `privateKey` (in any case), does not look like an API-key assignment, and contains no token of 20 or more characters above 4.5 bits per character: a short password in prose passes. It can also reject legitimate text that pairs a sensitive key name with a value, such as `token: 3`; rephrase such a field.
- **The protected-source check matches only verbatim copies.** It compares each whole string field's 64-bit FNV-1a `digestText` with the digests of sources the epoch marks `protected-secret` or `forbidden`. None of the sources `createContextEpochSealer` records carries either marking today, so the check fires only for epochs a host extends with such sources.
- **The thresholds are not options.** No call overrides the byte ceiling, retention window, clock skew, entropy threshold, or carry-forward bound.
- **A fresh attempt dispatches no session event.** `fork()` dispatches `SessionForkEvent`; `startFreshAttempt()` does not. Read `metadata.freshAttempt` to trace a fresh session to its source.
- **A fork is not a reset.** `fork-from-baseline` copies the transcript verbatim, failed turns included.

#### Fresh-attempt exports

Every name here is exported from `@lostgradient/operative`:

| Area | Values | Types |
| --- | --- | --- |
| Policies | `applyConversationPolicy` | `ConversationPolicy`, `ApplyConversationPolicyOptions` |
| Artifact | `finalizeFreshAttemptHandoffArtifact`, `computeFreshAttemptArtifactDigest`, `freshAttemptHandoffArtifactSchema`, `FRESH_ATTEMPT_ARTIFACT_SCHEMA_VERSION`, `FRESH_ATTEMPT_ARTIFACT_DIGEST_ALGORITHM` | `FreshAttemptHandoffArtifact`, `FreshAttemptHandoffArtifactDraft`, `EvidenceReference`, `FailureRecord`, `FreshAttemptProducer`, `FreshAttemptSourceRunOrAttempt`, `FreshAttemptLineage`, `FreshAttemptProvenance`, `FreshAttemptArtifactDigest` |
| Validation | `validateFreshAttemptArtifact`, `validateFreshAttemptArtifactForPublication` | `FreshAttemptValidationContext`, `FreshAttemptSourceResolver`, `FreshAttemptSourceRecord`, `ValidatedFreshAttemptArtifact` |
| Rejections | `FreshAttemptArtifactError`, `InvalidFreshAttemptArtifactError`, `IncompatibleFreshAttemptArtifactError`, `ProvenanceFreeFreshAttemptArtifactError`, `OversizedFreshAttemptArtifactError`, `CorruptFreshAttemptArtifactError`, `StaleFreshAttemptArtifactError`, `UnauthorizedFreshAttemptArtifactError`, `SecretBearingFreshAttemptArtifactError`, `OverbroadFreshAttemptArtifactError` | `FreshAttemptRejectionOutcome`, `FreshAttemptRejectionDiagnostic` |
| Store | `createFreshAttemptArtifactStore` | `FreshAttemptArtifactStore`, `FreshAttemptArtifactStoreContext` |
| Thresholds | `FRESH_ATTEMPT_ARTIFACT_MAX_BYTES`, `FRESH_ATTEMPT_ARTIFACT_RETENTION_MS`, `FRESH_ATTEMPT_ARTIFACT_CLOCK_SKEW_MS`, `FRESH_ATTEMPT_ARTIFACT_ENTROPY_THRESHOLD`, `FRESH_ATTEMPT_ARTIFACT_ENTROPY_MINIMUM_TOKEN_LENGTH`, `FRESH_ATTEMPT_ARTIFACT_MAX_CARRY_FORWARD_SOURCES` | None |

`SessionHandle.startFreshAttempt` and `SessionHandleContext.resolveFreshAttemptSource` are part of the session handle exported with `createSessionHandle`.

### Hooks

Hooks plug into the loop lifecycle. Register them on `RunOptions.hooks`, which is a `HookRegistry` and the only hook surface a run has. The seven parallel array fields are gone (COR-1268): two surfaces meant a hook point's ordering depended on which one a caller reached for, and an array registration carried no identity, so per-registration ids, priorities, error policy, tier provenance and the `hook-plan.*` events below were all blind to half the hooks on a run.

An agent can carry a registry of its own — `createAgent({ hooks })`, surfaced as the readonly `RunnableAgent.hooks` — and Bureau composes one per run. Those compose into a single immutable plan per run; see [Hierarchical hook composition](../../documentation/hierarchical-hook-composition.md) for the tier ordering, the authority rules and what an inspector can read back.

```typescript
import {
  composeHooks,
  createActiveRun,
  everyNSteps,
  HookRegistry,
  type OperativeHookMap,
  onlyOnStep,
  runOnce,
  stopWhen,
  withTimeout,
} from '@lostgradient/operative';

// Compose two prepare-step hooks into one
const combined = composeHooks(
  onlyOnStep(0, async ({ conversation }) => {
    conversation.appendSystemMessage('Extra context injected on step 0.');
  }),
  withTimeout(5000, async (ctx) => {
    // Fetch something slow—times out and silently returns undefined after 5s
  }),
);

const hooks = new HookRegistry<OperativeHookMap>({ source: 'direct' });
hooks.on('prepareStep', combined, { id: 'app:step-0-context', replay: 'safe' });
hooks.on(
  'prepareStep',
  everyNSteps(3, async (ctx) => {
    /* every 3rd step */
  }),
  { id: 'app:every-third-step', replay: 'safe' },
);
hooks.on(
  'onStep',
  runOnce(async (step) => {
    console.log('First step only:', step.content);
  }),
  { id: 'app:first-step-log', replay: 'safe' },
);

const activeRun = createActiveRun({
  generate,
  toolbox,
  conversation,
  stopWhen: stopWhen.noToolCalls(),
  hooks,
});

// Which sources applied, and in what order — redacted, with no handler in it.
console.log(activeRun.describeHookPlan());
```

`id` names a registration so an observation can be correlated back to it; without one the registry generates `<hookName>#<n>`. `replay` classifies the registration for durable recovery — a crashed in-flight step re-runs its hooks, so anything writing outside the run should be `effectful` AND idempotent. Omitting `replay` falls back to `effectful` and is reportable through `HookRegistryOptions.onUnclassifiedReplay`, which exists precisely to separate a considered choice from an unconsidered default.

**Hook composition utilities:**

| Function | Signature | Description |
| --- | --- | --- |
| `composeHooks` | `(...hooks: H[]) => H` | Sequential waterfall—a non-void return replaces the first arg for subsequent hooks. |
| `onlyOnStep` | `(step: number, hook: H) => H` | Wraps a hook so it only fires on the given step number. |
| `runOnce` | `(hook: H) => H & { reset() }` | Fires at most once; call `.reset()` to re-arm between runs. |
| `everyNSteps` | `(n: number, hook: H) => H` | Fires on steps 0, N, 2N, … |
| `withTimeout` | `(ms, hook, onTimeout?) => H` | Races the hook against a timeout; `'ignore'` (default) silently returns `undefined`, `'error'` throws. |

### Hook plan events

A run emits four events describing the `HookRegistry` it was dispatched with, so a consumer can see which hooks were in force and what each of them did without holding the registry itself. They fire only for a run given a registry; a run with no `hooks` emits none.

| Event | Fires | Carries |
| --- | --- | --- |
| `hook-plan.registered` | once per entry in the plan, and again for any entry registered while the run is live | `hookName`, `hookId`, `priority`, `replay`, `runId` |
| `hook-plan.invoked` | once per handler call that returned | `hookName`, `hookId`, `durationMilliseconds`, `runId` |
| `hook-plan.failed` | once per handler call that threw | the same, plus `error` |
| `hook-plan.removed` | when an entry is unregistered while the run holds the plan | `hookName`, `hookId`, `runId` |

```typescript
const activeRun = createActiveRun({ generate, toolbox, conversation, stopWhen, hooks });

activeRun.addEventListener('hook-plan.registered', (event) => {
  console.log(`plan: ${event.hookName}/${event.hookId} priority=${event.priority}`);
});
activeRun.addEventListener('hook-plan.failed', (event) => {
  console.error(`hook ${event.hookId} threw during ${event.hookName}`, event.error);
});

await activeRun.result;
```

The plan present at dispatch is announced in full before any hook runs, so a consumer reading the stream from `run.started` reconstructs the plan without reading the registry. Observation begins before `onRunStart`, which is itself a plan entry — its invocation is reported like any other.

`invoked` and `failed` are mutually exclusive for one invocation. `failed` fires for the throw itself, before the registry's error policy decides whether to continue or abort, so a handler whose `onError` returns `'continue'` is still visible.

**There is no `hook-plan.replayed`.** On a durable recovery a crashed step re-runs from its boundary, and its hooks genuinely run again — that is the contract `HookReplayPolicy` describes, which asks an effectful hook to be idempotent rather than skipped. Distinguishing "this entry ran before" would take durable per-entry invocation history, which is the very thing that contract avoids. A durable re-execution therefore emits an ordinary `hook-plan.invoked`. A consumer that needs to tell the two apart reads the recovery marker on its own run correlation, which is where that fact actually lives.

`replay` on `hook-plan.registered` reports the entry's declared `HookReplayPolicy`, or `'effectful'` when none was declared — the classification in force, not the absence of a declaration. It is documentation for a consumer; nothing in the runtime gates execution on it.

### Guardrails

See [Guardrails](#guardrails) below for the tripwire model, the detector and validator catalog, provenance, the three retrieval surfaces, and the Bureau default preset. This is a quick-start example; import the implementation from the package's single public entry point, `@lostgradient/operative`.

```typescript
import {
  createActiveRun,
  createGuardrails,
  createPromptInjectionDetector,
  createInputLengthDetector,
  createTopicBoundaryDetector,
  createOutputPIIValidator,
  stopWhen,
} from '@lostgradient/operative';

// Injection detection on inputs
const injectionDetector = createPromptInjectionDetector();

// Restrict topics
const topicGuard = createTopicBoundaryDetector({
  allowedTopics: ['cooking', 'recipes'],
  blockedKeywords: ['finance', 'legal'],
});

// Block overlong inputs
const lengthGuard = createInputLengthDetector({ maxLength: 2000 });

// Compose into a guardrails hook set
const guardrails = createGuardrails({
  input: { detectors: [injectionDetector, topicGuard, lengthGuard] },
  output: { validators: [createOutputPIIValidator()] },
});

const activeRun = createActiveRun({
  generate,
  toolbox,
  conversation,
  stopWhen: stopWhen.noToolCalls(),
  prepareStep: guardrails.prepareStep,
  validateResponse: guardrails.validateResponse,
});
```

### Context Assembly

`createContextAssembler()` returns a function that, given a conversation and a budget, partitions messages into system / retrieved / history slices and trims each to fit:

```typescript
import { createContextAssembler, createTokenBudget } from '@lostgradient/operative';

const budget = createTokenBudget({
  maxTokens: 100_000,
  minimumResponseTokens: 4_000,
});

const assembler = createContextAssembler();
const { messages, budgetReport } = assembler({ conversation, budget });
```

**Stable-prefix mode (`stablePrefix: true`)** trades the default priority-ranked/budget-fill behavior for a prompt-cache-friendly one: system messages and `pinnedMessages` are assembled into a prefix that stays byte-identical across steps as the conversation grows—never budget-truncated, never re-ranked—and the last message of that prefix comes back with `cacheBoundary: true`. History and `retrievedMessages` are unaffected: they're assembled exactly as in the default mode and appended AFTER the stable prefix, so their normal per-step re-ranking never touches the cached region.

```typescript
const { messages } = assembler({
  conversation,
  budget,
  stablePrefix: true,
  pinnedMessages: [toolUsageNotesMessage], // always included, in order, right after system
});
```

The `cacheBoundary` mark is the same conversation-level primitive `conversationalist`'s Anthropic adapter already lowers to a `cache_control` breakpoint (`toAnthropicMessages`). `createAnthropicProvider` and `createAnthropicProviderStream` consume it directly—pass `assembler` and `contextBudget` and every request runs through stable-prefix assembly instead of sending the conversation verbatim:

```typescript
import {
  createAnthropicProvider,
  createContextAssembler,
  createTokenBudget,
} from '@lostgradient/operative';

const generate = createAnthropicProvider({
  model: 'claude-sonnet-4-20250514',
  assembler: createContextAssembler(),
  contextBudget: createTokenBudget({ maxTokens: 100_000 }),
  pinnedMessages: [toolUsageNotesMessage],
});
```

**Cache economics.** Anthropic prices a cache write at 1.25x the base prompt rate and a cache read at 0.1x (`estimateCost` already applies this—see `cost-estimation.ts`). A run whose system prompt is a few thousand tokens pays that 1.25x premium once, on the first step, then reads the same prefix at 0.1x on every following step instead of paying full price for it again—a ~90% cost cut on that slice of the request for steps 2 onward. Prompt-cache hit rate is exposed per step and cumulatively on `usage.accumulated` (`UsageAccumulatedEvent.stepCacheHitRate` / `totalCacheHitRate`, computed by `estimateCacheHitRate`). `test/prompt-cache-economics.test.ts` walks through these numbers end to end against the mock Anthropic client (no live API calls)—see it for the worked example.

**Extended (1-hour) cache TTL.** Anthropic's cache breakpoints default to a 5-minute TTL. Passing `extendedCacheTtl: true` to `createAnthropicProvider` / `createAnthropicProviderStream` opts every `cache_control` breakpoint lowered from a `cacheBoundary` mark into the extended one-hour TTL instead (`cache_control: { type: 'ephemeral', ttl: '1h' }`), which Anthropic bills at a higher cache-write rate in exchange for a longer-lived cache. It only takes effect on requests that actually have a cache boundary (i.e. `assembler` + `contextBudget`, or an already-marked conversation). OpenAI and Gemini use implicit, non-configurable prompt caching—there's no checkpoint metadata to interpret, so this option doesn't apply to `createOpenAIProvider` / `createGeminiProvider`.

### Providers Behind a Proxy

Every shipped provider (`createAnthropicProvider`, `createOpenAIProvider`, `createGeminiProvider`, and their streaming counterparts) accepts a `baseURL` override and an arbitrary `apiKey` string with no shape validation—both pass straight to the underlying SDK client, so a credential-injecting proxy can sit in front of the real provider and swap in the real key server-side:

```typescript
const generate = createAnthropicProvider({
  model: 'claude-sonnet-4-20250514',
  apiKey: 'placeholder-token', // never a real key—the proxy injects it
  baseURL: 'https://llm-proxy.internal.example.com',
});
```

**Per-provider endpoint allowlist.** Each provider issues requests to exactly one endpoint per generate call (a second, distinct endpoint for the streaming factories of OpenAI and Gemini)—the set below is pinned by `test/provider-proxy-contract.test.ts`, which runs each provider (and each streaming counterpart) through a real SDK client against a local `Bun.serve` mock and asserts the exact `(method, path)` set observed over a multi-step run. Use it to build a proxy allowlist:

| Provider | Method | Path | Auth header |
| --- | --- | --- | --- |
| Anthropic | POST | `/v1/messages` (streaming uses the same path) | `x-api-key` |
| OpenAI | POST | `/chat/completions` (streaming uses the same path) | `authorization: Bearer <token>` |
| Gemini | POST | `/v1beta/models/{model}:generateContent` | `x-goog-api-key` |
| Gemini (streaming) | POST | `/v1beta/models/{model}:streamGenerateContent` | `x-goog-api-key` |

No provider issues a token-counting, models-list, or beta/experimental endpoint call as part of a normal generate step.

**Per-run request metadata.** `requestMetadata` (a `Record<string, string>`) attaches to every generate request of a run:

```typescript
const generate = createAnthropicProvider({
  model: 'claude-sonnet-4-20250514',
  requestMetadata: { requestId: 'run-42', tenant: 'acme' },
});
```

It's mapped to each provider's native field: Anthropic Messages `metadata`, OpenAI Chat Completions `metadata` (native string-keyed map, up to 16 keys). Gemini's `generateContent` API has no request-level metadata field, so `requestMetadata` is an explicit no-op for `createGeminiProvider` / `createGeminiProviderStream`.

**Anthropic caveat—the whole object is forwarded, but the real API only accepts `user_id`.** Anthropic's `Metadata` type has exactly one documented field (`user_id`); calling `createAnthropicProvider` with `requestMetadata` containing OTHER keys and pointing `baseURL` at Anthropic's real endpoint directly (no proxy in front) gets the request rejected. This option exists for the credential-injecting-proxy case above: the proxy sees the whole object on the wire and can route/log on it, then either forward only `user_id` to the real Anthropic API or strip/translate the rest before forwarding. Don't pass arbitrary `requestMetadata` keys straight through to `api.anthropic.com`—only to a proxy that knows what to do with them.

### Provider Errors

Every shipped provider throws `ProviderError` (`@lostgradient/operative`) for HTTP/SDK failures—it carries `provider`, `cause`, an optional `statusCode`, and `retryable` (true only for status codes in `{429, 500, 502, 503, 504}`).

`createAnthropicProviderStream` and `createOpenAIProviderStream` throw the more specific `ToolCallParseError`—a `ProviderError` subclass—when the model finishes a turn but the accumulated tool-call argument JSON it streamed doesn't parse. This is a malformed-output problem, not an API failure: the request succeeded, the model just emitted bad JSON. It carries `toolName`, `toolCallId` (`string | undefined`—the provider didn't always assign one before the parse failed), and `rawArguments` (the unparsed fragment) alongside the inherited `ProviderError` fields, and `retryable` is always `false` since it never has a `statusCode`.

```typescript
import { ToolCallParseError } from '@lostgradient/operative';

try {
  await generate(context);
} catch (error) {
  if (error instanceof ToolCallParseError) {
    // The model streamed unparseable arguments for error.toolName —
    // distinct from a provider outage.
  }
}
```

If the caller aborts `context.signal` mid-stream while a tool call's arguments are still accumulating, the truncated fragment is never parsed and never thrown as a `ToolCallParseError`—that's cancellation, not malformed model output, so the tool call is simply omitted from the response's `toolCalls`.

`classifyError` (from `operative`) recognizes `ToolCallParseError` and reports it under the `'model-output'` category, so error-classification and routing code can tell "the provider is down" apart from "the model emitted bad JSON" without an `instanceof` check.

Use `isToolCallParseError` to recognize the error structurally when it crosses a serialization or module boundary:

```typescript
import { isToolCallParseError } from '@lostgradient/operative';

if (isToolCallParseError(error)) {
  // Matches structurally even if `error` came from a different
  // operative entrypoint's bundle than this check.
}
```

### Backpressure

```typescript
import {
  createActiveRun,
  createSlidingWindow,
  createTokenBucket,
  createAdaptiveBackoff,
  stopWhen,
} from '@lostgradient/operative';

// Smooth out burst traffic with a sliding window
const backpressure = createSlidingWindow({ windowSize: 60_000, maximumRequests: 20 });

// Token bucket for sustained rate control
const bucket = createTokenBucket({ tokensPerInterval: 1, interval: 1000 }); // 1 token/sec

// Exponential backoff that self-adjusts based on error rate
const adaptive = createAdaptiveBackoff({ initialDelay: 500, maximumDelay: 30_000 });

const activeRun = createActiveRun({
  generate,
  toolbox,
  conversation,
  stopWhen: stopWhen.noToolCalls(),
  backpressure,
});
const result = await activeRun.result;
```

### Caching

```typescript
import { createActiveRun, stopWhen, withCache, withCacheMetrics } from '@lostgradient/operative';

// withCache requires a TextValueStore backend (e.g. from Weft)
const cachedGenerate = withCache(generate, {
  store: kvStore, // TextValueStore
  keyStrategy: 'last-message', // or 'conversation-hash' or a custom CacheKeyFunction
  ttl: 3600, // seconds; 0 = no expiry
});

// withCacheMetrics wraps withCache and returns { generate, metrics }
const { generate: metered, metrics } = withCacheMetrics(generate, {
  store: kvStore,
  keyStrategy: 'conversation-hash',
  model: 'claude-sonnet-4-20250514', // optional, for cost-savings estimation
});

const activeRun = createActiveRun({
  generate: metered,
  toolbox,
  conversation,
  stopWhen: stopWhen.noToolCalls(),
});
const result = await activeRun.result;
// metrics.hits, metrics.misses, metrics.hitRate, metrics.totalSavedTokens
metrics.reset(); // clear counters between test runs
```

### Generate Middleware

```typescript
import { composeGenerate, createFallbackGenerate } from '@lostgradient/operative';
import type { GenerateMiddleware } from '@lostgradient/operative';

// composeGenerate(base, ...middleware) applies middleware right-to-left (outermost first)
const loggingMiddleware: GenerateMiddleware = (next) => async (context) => {
  const response = await next(context);
  return response;
};
const stacked = composeGenerate(generate, loggingMiddleware);

// Failover: try providers in order, fall back on error
const withFallback = createFallbackGenerate({
  providers: [primaryGenerate, fallbackGenerate],
  shouldFallback: (error) => error instanceof Error && error.message.includes('rate limit'),
});
```

### Multi-Agent Patterns

For the whole lifecycle across packages—addressing, observation, signals, budgets, cancellation, recovery, and what is unsupported—read [Multi-agent lifecycle and communication](../../documentation/multi-agent-lifecycle.md). Communication is supervisor-mediated only (COR-807): a parent can address its own children, and nothing here lets a child address a sibling, an unrelated run, or a global mailbox. To pass information between siblings, the parent observes one and signals the other.

`createSupervisor` and `createAgentDiscoveryTool` moved to the `bureau` package (AB-22)—they now operate directly on a `BureauAgentCatalog`/`AgentDescriptor` rather than the older registry types, which no longer exist in this package. See `bureau`'s README for both. `createHandoffTool` stays here; it now takes a `RunnableAgent` (from `createAgent` or `createLazyAgent`) directly instead of a registry adapter.

**Subagents:**

```typescript
import { createAgent, createSubagentTool } from '@lostgradient/operative';
import { z } from 'zod';

const researcherTool = createSubagentTool({
  name: 'research',
  description: 'Delegates a research task to a specialist agent.',
  agentName: 'researcher',
  // `agent` (AB-19) is a `RunnableAgent`—`researcherAgent` from
  // `createAgent({...})` satisfies this directly, with no adapter.
  agent: researcherAgent,
  input: z.object({ query: z.string() }),
  // toAgentInput (AB-19; renamed from mapInput) receives the tool's parsed,
  // Zod-validated arguments—already typed to the schema above, no cast
  // needed—and returns the child's `AgentInput` (a string, or
  // `{ conversation }` to resume an existing history).
  toAgentInput: (input) => input.query,
});

const orchestrator = createAgent({
  generate,
  tools: { research: researcherTool },
});
```

`createSubagentTool` is built on `dispatchChildRun` (AB-50), the lower-level child dispatch primitive—see [Child dispatch and discovery (AB-50)](#child-dispatch-and-discovery-ab-50) below. It threads the parent tool call's `signal` and `traceContext`—plus this tool's own `agentName` and `withTraceContext` option—through to `agent.run(input, { agentName, signal, traceContext, withTraceContext })`, so a real `createAgent` child aborts when the parent's tool call does. `signal` always propagates, composed with a private per-child `AbortController` so a child-targeted abort (through `AgentRun.abortChild()`, or the `ChildRunHandle.abort()` a direct `dispatchChildRun` caller retains) never reaches a sibling. `traceContext` is read off the executing `ToolContext` (AB-233): the ordinary `createAgent`-driven agent loop populates it on every call, from the run's own `parentContext`, via `run-step.ts`'s toolbox execute call site—no special toolbox construction required. Pass `withTraceContext` directly on `createSubagentTool`'s own options when the child needs its `agent.run()` call wrapped in a trace context.

Every non-success terminal (abort, execution error, tripwire, budget exceeded, elicitation denied, maximum steps, or a clean stop whose output failed schema validation) rejects with `SubagentRunError`, which carries the child's full `RunResult` as `.result`—there is no `treatMaximumStepsAsError` toggle to opt out of this. That guarantee holds for a caller that invokes the tool's own execute function directly; once the tool call is driven through armorer's toolbox (the ordinary agent-loop path), armorer normalizes every thrown tool error—including `SubagentRunError`—into a plain, structured `ToolError` on the resulting `ToolExecutionResult`, the same as it does for every other tool in this codebase. `instanceof SubagentRunError` and `.result` are reachable only above that normalization boundary.

**Context isolation (AB-64):** by default, `createSubagentTool` keeps a sub-agent's full conversation, steps, and usage out of the parent's context window—only a capped summary of its `content` crosses back. `returnMode` controls this:

- `'summary'`—the **documented default**. Only `result.content`, condensed by a `summarizer` and hard-capped at `summaryTokenCap` tokens (default `500`), returns to the parent. The sub-agent's own transcript stays isolated. This is what keeps a fan-out of several sub-agents from blowing up the orchestrator's context window.
- `'full'`—`result.content` is returned verbatim and uncapped. Opt in deliberately, e.g. for a single close-coupled delegation that needs the sub-agent's exact output (structured extraction, code the parent will paste unmodified).

Both modes ultimately hand off to `toToolOutput(result)` (AB-19; renamed from `mapOutput`), which receives the complete successful `RunResult`—including `conversation`, `steps`, and `usage`—so a custom `toToolOutput` CAN reach past the summary and return those fields directly. `toToolOutput` is a pure projection, not runtime validation: it is never invoked for a non-success terminal, which rejects with `SubagentRunError` before `toToolOutput` is ever reached. `returnMode`/`summaryTokenCap` cap `result.content`, not what a custom `toToolOutput` chooses to do with the rest of the object; keep that in mind if you override it. Omit `toToolOutput` entirely for a schema-less child and the tool returns a plain string (`result.content`).

```typescript
const researcherTool = createSubagentTool({
  name: 'research',
  description: 'Delegates a research task to a specialist agent.',
  agentName: 'researcher',
  agent: researcherAgent,
  input: z.object({ query: z.string() }),
  toAgentInput: (input) => input.query,
  // returnMode: 'summary' is the default—shown explicitly here.
  returnMode: 'summary',
  summaryTokenCap: 300,
  // Swap in a real LLM-backed condensation instead of the default
  // character-truncation summarizer:
  summarizer: async (result, { agentName, maxTokens, signal }) => {
    // Pass `signal` through to cancel the LLM call if the parent tool call
    // is aborted while summarization is in flight.
    return condenseWithLLM(result.content, { agentName, maxTokens, signal });
  },
});
```

### Child dispatch and discovery (AB-50)

`createSubagentTool` is the model-facing entry point; `dispatchChildRun` is the lower-level primitive underneath it, exported for code that dispatches a subagent directly rather than through a tool. It returns a `ChildRunHandle` that carries `childRunId`, `parentRunId`, and `agentName` alongside `AgentRun`'s own iterate/await/abort/dispose surface, so two concurrently retained handles stay independently addressable—aborting or iterating one never touches the other:

```typescript
import { dispatchChildRun } from '@lostgradient/operative';

// `AgentRun` carries no id of its own (a recorded gap owned by AB-88), so a
// caller who wants one supplies it—here, generated up front so it can
// also correlate every event these two dispatches emit.
const parentRunId = crypto.randomUUID();

const alpha = dispatchChildRun(researcherAgent, 'Research topic A', {
  agentName: 'researcher-alpha',
  parentRunId,
});
const beta = dispatchChildRun(researcherAgent, 'Research topic B', {
  agentName: 'researcher-beta',
  parentRunId,
});

const [resultAlpha, resultBeta] = await Promise.all([alpha.result(), beta.result()]);
// alpha.abort('no longer needed') stops only alpha—beta keeps running.
```

`dispatchChildRun` dispatches through `RunnableAgent.run()`—the in-process route—and emits the four `multiagent.child-workflow.*` lifecycle events (`started`/`completed`/`failed`/`aborted`) on `emitter` when one is supplied, each correlated by `parentRunId` and `childRunId`.

Two failures surface as exceptions rather than as a resolved result. If `agent.run()` throws, `dispatchChildRun` closes the child's signal channel as `failed`, settles its registry entry as `'failed'`, emits `multiagent.child-workflow.failed`, and then rethrows synchronously, so the caller gets no handle. If the child's own `result()` rejects, or throws instead of returning a promise, the handle's `result()` rejects with that error after the same failure settlement. A child that finishes with any finish reason other than `stop-condition` or an abort still resolves `result()`, and is reported as `'failed'`.

**Child discovery.** `AgentRun.children()` / `.abortChild(id, reason?)` (the signatures the started-work control contract in `documentation/operative-type-safe-api.md` assigns to AB-50) are backed by an opt-in `ChildRunRegistry`. Discovery does not happen automatically—a tool is constructed once, independent of any particular run, so nothing can inject a run-scoped registry into an already-built tool by itself. Wire the same registry into both places to make a run's children discoverable even when the tool's own return value never surfaces them to the caller:

```typescript
import { createChildRunRegistry, createSubagentTool } from '@lostgradient/operative';

const registry = createChildRunRegistry();
// Tools are built once, independent of any particular run—so the parent
// run's id has to exist before the tool does, not be read off a `run`
// value that doesn't exist yet.
const parentRunId = crypto.randomUUID();

const researcherTool = createSubagentTool({
  name: 'research',
  description: 'Delegates a research task to a specialist agent.',
  agentName: 'researcher',
  agent: researcherAgent,
  input: z.object({ query: z.string() }),
  toAgentInput: (input) => input.query,
  parentContext: {
    emitter, // the parent run's own event emitter
    parentAgentName: 'orchestrator',
    parentRunId,
    durable: false,
    registry, // <- makes this tool's children discoverable
  },
});

const run = orchestratorAgent.run('...', { childRegistry: registry }); // <- same registry
// ... after the orchestrator has dispatched some subagent calls ...
run.children(); // [{ id, parentId, agentName: 'researcher', durable: false, status: 'running' | ..., assessment: 'healthy' | ... }]
run.abortChild(run.children()[0]?.id, 'no longer needed'); // scoped: this child only
run.snapshot().worstChildAssessment; // AB-216—most severe non-terminal child assessment, or absent
```

`ChildRunDescriptor.parentId` carries the edge back to whatever id `parentRunId` was, so nesting `createSubagentTool` inside a child's own toolbox—with every level threading through the SAME `registry`—makes the whole ownership tree reconstructable from one `registry.children()` call at the root, reassembled by `parentId`, even though the registry itself stores a flat list.

`ChildRunDescriptor.assessment` (AB-216) tracks that child's own `LivenessSnapshot.assessment`—populated the moment `dispatchChildRun` attaches the child's `LivenessObservable` to `registry` (synchronously, at dispatch), and kept current by the child's own `subscribeSnapshot` deliveries thereafter. It is the source `AgentRun.snapshot().worstChildAssessment` folds over on the parent side (see "Child-liveness aggregation" above); reading it directly off one child's own descriptor is also useful on its own when a caller wants that one child's state without a parent-level fold.

Omit `registry` on either side and `children()` reads back an empty array and `abortChild()` is a no-op—never a throw. `abortChild()` is idempotent on an unknown or already-terminal child id, matching `abort()`'s own rule, and never propagates to a sibling.

**AB-233—one registry is enough in the ordinary loop.** The explicit `parentContext: { registry }` wiring above remains fully supported (and is still what a direct `dispatchChildRun` caller, or a tool built outside the ordinary agent loop, needs). But for a `createSubagentTool` reached through `createAgent`'s ordinary loop, passing `childRegistry` to `agent.run()` alone is now enough—`run-step.ts` threads THAT run's own registry into every tool call's per-execution context, and `createSubagentTool` reads it there in preference to `parentContext.registry`:

```typescript
const registry = createChildRunRegistry();
const researcherTool = createSubagentTool({
  name: 'research',
  description: 'Delegates a research task to a specialist agent.',
  agentName: 'researcher',
  agent: researcherAgent,
  input: z.object({ query: z.string() }),
  toAgentInput: (input) => input.query,
  // No parentContext.registry needed here.
});

const run = orchestratorAgent.run('...', { childRegistry: registry });
```

This also fixes a reuse hazard the construction-time wiring had: build `researcherTool` ONCE and run `orchestratorAgent` twice concurrently, each with its own `childRegistry`—every call registers its child into THAT call's own registry, never a registry frozen at the moment the tool was built and never the other run's registry.

`parentRunId` follows the same per-execution-over-construction-time rule, but only when the active run actually carries a `runId`—session-owned and durable runs (`RunOptions.runId`). A bare `createAgent().run()` call, as in the example above, has none: `AgentRunContext` has no `runId` field today, so `parentContext.parentRunId` (the construction-time value) is what gets stamped on that path. Supply `parentContext.parentRunId` explicitly when you need a correct value there.

**Child terminal lifecycle and relationship-query events (AB-90 child ab90-02, AB-222).** Alongside `ChildWorkflowStartedEvent` (`multiagent.child-workflow.started`), `dispatchChildRun` emits `ChildWorkflowCompletedEvent`/`ChildWorkflowFailedEvent`/`ChildWorkflowAbortedEvent` (`multiagent.child-workflow.completed`/`.failed`/`.aborted`—AB-87's decision record names these `child.completed`/`child.failed`/`child.aborted`; AB-50 shipped them under the `multiagent.child-workflow.*` names). They're mutually exclusive terminals for one child run, each carrying `childRunId` and `parentRunId`. Bureau's audit trail uses the `child.*` names for its own durable records (see [Bureau's parent-child topology](../bureau/README.md#parent-child-topology-cor-772)); those are audit entries, not these events.

Two further event classes are typed and exported by this package but have no production emitter. `ChildWorkflowReattachedEvent` (`multiagent.child-workflow.reattached`, `childRunId`/`parentRunId`) describes a child reattached to its parent after recovery. This package does not persist or recover children, and Bureau's durable topology (COR-772) records reattachment as a `child.reattached` audit-trail entry rather than dispatching this event—see [Bureau's parent-child topology](../bureau/README.md#parent-child-topology-cor-772). `ChildWorkflowProgressEvent` (`multiagent.child-workflow.progress`) additionally carries the child's own `SemanticProgress` (`@lostgradient/operative`'s `liveness` module, AB-88/AB-214) and is explicitly non-cursor-advancing—an ephemeral delta, never a durable state transition.

`listChildRuns(registry, parentRunId)` is a relationship-query function over the same `ChildRunRegistry` `AgentRun.children()` reads from—it lets a caller enumerate a run's children and their outcomes without polling each child's own handle:

```typescript
import { createChildRunRegistry, dispatchChildRun, listChildRuns } from '@lostgradient/operative';

const registry = createChildRunRegistry();
dispatchChildRun(researcherAgent, 'Research topic A', {
  agentName: 'researcher',
  parentRunId: 'parent-1',
  registry,
});

listChildRuns(registry, 'parent-1');
// [{ id, parentId: 'parent-1', agentName: 'researcher', durable: false, status: undefined }]
// status is 'completed' | 'failed' | 'aborted' once terminal, undefined while running.
```

A `parentRunId` with no registered children returns an empty array—never a throw. Deliberately not `bureau.*`-namespaced: `listChildRuns` is an operative-level export over operative's own in-process registry; a Bureau-level relationship-query API, if wanted later, wraps this function rather than being built here.

**Typed parent-child signals (COR-814).** A parent and a live in-memory child can exchange typed, correlated messages without waiting for the child's terminal result. Define the contract once—`signals` flow parent → child, `events` flow child → parent, and every entry is a Zod schema—then pass it to `dispatchChildRun` as `signals`. The returned handle gains a `signals` endpoint, and the child receives the matching port as `AgentRunContext.parentSignals` (a `createAgent` child also hands it to every tool call as `ToolContext.executionContext.parentSignals`):

```typescript
import { createTool } from 'armorer';
import { defineChildSignals, dispatchChildRun, readParentSignals } from '@lostgradient/operative';
import { z } from 'zod';

export const researchSignals = defineChildSignals({
  signals: { focus: z.object({ topic: z.string() }) },
  events: { progress: z.object({ percent: z.number().min(0).max(100) }) },
});

// Inside the child: a tool reads the port typed by the same contract object.
const research = createTool({
  name: 'research',
  description: 'Researches the current topic.',
  input: z.object({}),
  async execute(_input, context) {
    const parent = readParentSignals(context.executionContext, researchSignals);
    parent?.onSignal('focus', ({ payload }) => refocus(payload.topic));
    parent?.emit('progress', { percent: 50 });
    return 'done';
  },
});

// In the parent:
const child = dispatchChildRun(researcherAgent, 'Research birds', {
  agentName: 'researcher',
  parentRunId,
  signals: researchSignals,
});
child.signals.on('progress', ({ payload }) => console.log(payload.percent));
const outcome = await child.signals.send('focus', { topic: 'corvids' });
// { status: 'acknowledged', id, sequence, name: 'focus', parentRunId, childRunId }
// or { status: 'rejected', code, reason, delivered, closeReason? }
```

- **Acknowledgement or typed rejection.** `send` never rejects: it resolves `acknowledged` once the child's handler returns or resolves, or `rejected` with a `code`—`handler-failed` (the handler threw), `invalid-payload` (the schema refused it or threw while parsing it—including a refinement or transform that throws, or one that is asynchronous—or it cannot be structurally cloned), `unknown-name`, `buffer-full`, or `channel-closed`. `emit` returns `emitted` (with `delivered: false` when it was buffered) or the same rejection shape, synchronously.
- **Validated and isolated.** Every payload is parsed by its schema and then structurally cloned, so the recipient receives the schema's output and never shares a reference with the sender. The recipient still decides whether to act: a handler that refuses throws, and the parent sees `handler-failed`.
- **Correlated to one pair.** Neither endpoint takes a run id—each is bound to one `parentRunId`/`childRunId` pair when `dispatchChildRun` builds the channel, and every message and outcome carries that pair. `readParentSignals` returns a port only for the exact contract object the channel was built with, and only for a port a channel created. A grandchild the child dispatches never receives its parent's port; there is no sibling addressing or global mailbox.
- **Signal before listener.** A message sent before its consumer registers waits in a bounded buffer (`signalBufferLimit`, default `DEFAULT_CHILD_SIGNAL_BUFFER_LIMIT` = 64 per direction; `0` refuses instead of buffering) and is delivered in order the moment `onSignal`/`on` registers. With `signals` supplied, a `signalBufferLimit` that is not a non-negative integer makes `dispatchChildRun` throw `RangeError` before anything is registered, emitted, or started; `createChildSignalChannel` throws the same `RangeError` for its `bufferLimit`.
- **One consumer per name.** One handler per signal name and one listener per event name at a time. `handle.signals.on` and the port's `onSignal` throw `TypeError` for a name the contract does not declare, and `Error` when that name already has a consumer. Once the channel has closed, a registration for a declared name is inert instead of throwing.
- **Deterministic close.** The channel closes once, with the first of `aborted` (the handle's `abort()` or the parent's `signal`), `completed`/`failed`/`aborted` (the child's settled result, before `result()` resolves), or `disposed` (`[Symbol.dispose]()`). Closing resolves every unsettled send as `channel-closed`—`delivered: true` when the child's handler was already running—drops buffered messages, releases every handler and listener, and makes later sends, emits, and registrations inert. `closeReason` on either endpoint reports it.

Everything here is in-process: no persistence, restart recovery, or network transport. `createAgent` children receive the port automatically; `createSubagentTool` has no `signals` option. A host that starts a child run itself, as Bureau does for `bureau.children`, can build the channel with `createChildSignalChannel(contract, { parentRunId, childRunId }, { bufferLimit? })`, hand `channel.child` to the child as `AgentRunContext.parentSignals`, keep `channel.parent`, and call `channel.close(reason)` when the child ends. Bureau's durable children use a contract registered in `BureauOptions.children.signals`, and Bureau can send them signals but exposes no way to observe their `events`.

**Exported types.** Child dispatch and discovery export `DispatchChildRunOptions`; `ChildRunHandle`, and `SignaledChildRunHandle` (a handle with `signals`, returned when `signals` is supplied); `ChildEventEmitter` (the `dispatchEvent` surface `emitter` needs); `ChildRunRegistry` (the read surface) and `MutableChildRunRegistry` (what `registry` accepts and `createChildRunRegistry()` returns); `ChildRunDescriptor`; `ChildRunStatus` (`'running' | 'completed' | 'failed' | 'aborted'`); `ChildRunTerminalStatus` (every status but `'running'`); and `ChildRunSummary`, whose `status` is a `ChildRunTerminalStatus` or `undefined` while the child runs. Every `multiagent.child-workflow.*` event carries `ChildWorkflowCorrelation` (`parentAgentName`, `parentRunId`, `childAgentName`, `childRunId`). `ChildWorkflowReattachedPayload` and `ChildWorkflowProgressPayload` type the two events with no emitter. Signals export `ChildSignalSchemas` and `ChildSignalContract` (the contract); `ParentSignalEndpoint` (`handle.signals`) and `ChildSignalPort` (the child's port); `ChildSignalCorrelation`; `ChildSignalMessage` (`id`, `sequence`, `name`, `payload`, and the correlation); `ChildSignalHandler`; `ChildSignalOutcome` (`ChildSignalAcknowledgement | ChildSignalRejection`); `ChildEventOutcome` (`ChildEventEmission | ChildSignalRejection`); `ChildSignalRejectionCode`; `ChildSignalCloseReason`; and, for `createChildSignalChannel`, `ChildSignalChannel` and `CreateChildSignalChannelOptions`.

**Cleanup acknowledgement.** `closed(options?)` (AB-37, delivered by AB-204) is on `ActiveRun`, `AgentRun`, and `DiagnosticAgentRun` alike—a truthful cleanup acknowledgement, backed by the same settlement `abort()` already uses, for a caller that wants more than "I fired `abort()` and hoped":

```typescript
const cleanup = await run.closed(); // never rejects
// { status: 'not-required' | 'completed' | 'failed' | 'unresolved', reason?, error? }
```

`closed()` never rejects and is idempotent: once the underlying cleanup has genuinely settled, a repeated call returns the identical cached object by reference. `not-required` covers work that never needed cleanup in the first place; `completed` is the clean-teardown case; `failed` is a definite, observed teardown failure; `unresolved` covers everything the outcome could not be determined for, with `reason` distinguishing a caller-side `options.signal` timeout (`'timed-out'`—bounds only THIS call's wait, never writes into the shared cache) from an unreachable durable worker (`'unreachable'`), an unconfirmed durable write (`'persistence-failed'`), or unknown side-effect residue (`'unknown-effect'`). On a `DiagnosticAgentRun` (a durable run recovered without a trusted live agent definition) durability cannot be determined from the wrapper, so a wrapped `'completed'` outcome is downgraded to `unresolved`/`unknown-effect`; every other outcome passes through unchanged.

**`completed` waits for real tool-callback completion, not just the cancellation race (AB-289).** In-memory `ActiveRun.closed()` withholds `{ status: 'completed' }` until every run-owned tool call's own callback has genuinely returned or thrown—armorer's toolbox `settled` event fires as soon as the cancellation race against the execution signal settles, and a callback that ignores its abort signal keeps running after that. A caller with its own bounded wait (`closed({ signal })`) still observes `{ status: 'unresolved', reason: 'timed-out' }` if that signal fires before the callback returns.

Approval- and input-gated invocations also settle: their `tool.settled` status is `paused`, and their authoritative tool result remains `action_required` with its pending-approval descriptor. Live, fresh durable, and recovered event projections preserve this status. Pausing does not execute the callback or represent tool success; it allows the owning run to drain the completed invocation without losing the pending approval. A later approved invocation settles separately.

**Parent `closed()` awaits child cleanup (AB-211/AB-304).** When a run was started with `childRegistry` (the same `ChildRunRegistry` backing `children()` / `abortChild()`), its `closed()` does not resolve `completed` while any registered child's own `closed()` is still pending—not merely while the child's `result()` is unresolved. A run with no `childRegistry`, or one with zero registered children, behaves identically to before this change, with no added latency. Aborting one child never affects an untouched sibling's own path to settlement. This gate applies uniformly to both the in-memory and durable `ActiveRun` paths: `createDurableActiveRun` and `reattachDurableActiveRun` (`durable/active-run-adapter.ts`) also thread `RunOptions.childRegistry` through and fold `awaitChildrenClosed()` into their own `closed()`, so a durable parent's `closed()` waits on its children exactly the same way an in-memory parent's does—including a child dispatched after a reattach/recovery, discovered through the same registry.

**Supervisor:** moved to the `bureau` package (AB-22)—see its README for `createSupervisor`, `RoutingStrategy<D>`, and the built-in routing strategies, which now operate on a `BureauAgentCatalog<D>` and metadata-only `AgentDescriptor`s.

**Handoffs:**

A handoff passes the same conversation to another agent. It is not a reset: to retry without the failed transcript, start a [fresh attempt](#fresh-attempts-and-conversation-policies-cor-1354) instead. `createHandoffTool(options)` takes `CreateHandoffToolOptions` and returns an armorer tool:

| Option | Default | Meaning |
| --- | --- | --- |
| `agent` | Required | A `HandoffTarget`, `{ agentName, agent }`: the target's identity and its `RunnableAgent`. `agentName` is the identity used everywhere, because a `createLazyAgent` result's `name` is a placeholder until it loads. |
| `name` | `transfer_to_<agentName>` | The tool name. |
| `description` | `Hand off the conversation to the "<agentName>" agent.` | The description shown to the model. |
| `input` | `z.object({})` | The Zod schema for the call's arguments (see the warning below). |
| `sourceContext` | None | `{ emitter, sourceAgentName, sessionId? }`. When set, every execution dispatches a `HandoffOccurredEvent` on `emitter` with the source agent, the target agent, and `sessionId` when given. |

The tool never runs the target agent and never touches a session. Executing it returns `JSON.stringify({ type: HANDOFF_MARKER, agent: agentName })`, where `HANDOFF_MARKER` is `'__handoff__'`, and `extractHandoffTarget(steps)` reads that marker from the final step. Starting the target agent, in the same session or anywhere else, is the caller's job.

```typescript
import {
  createAgent,
  createHandoffTool,
  extractHandoffTarget,
  HANDOFF_MARKER,
  stopWhen,
} from '@lostgradient/operative';

// Each handoff targets one specific agent
const escalateToSupport = createHandoffTool({
  name: 'escalate-to-support',
  description: 'Transfer the conversation to the human support agent.',
  agent: { agentName: 'support', agent: supportAgent },
});

const triageAgent = createAgent({
  generate,
  tools: { 'escalate-to-support': escalateToSupport },
  stopWhen: [
    // Pair a handoff tool with stopWhen.toolCalled(name), not
    // stopWhen.noToolCalls(): the handoff itself IS a tool call, so
    // noToolCalls() never sees a step with zero tool calls and the loop runs
    // to maximumSteps instead of exiting on the handoff.
    //
    // toolCalled() inspects only the generated call NAME, never the result, so
    // on its own it also fires on a handoff that FAILED—bad arguments error
    // before execute runs, no HANDOFF_MARKER is produced, and the run ends
    // with extractHandoffTarget returning undefined. Requiring the step to be
    // error-free keeps a failed handoff from ending the loop, giving the model
    // another step to call it correctly.
    stopWhen.every(
      stopWhen.toolCalled('escalate-to-support'),
      stopWhen.not(stopWhen.toolOutcome('error')),
    ),
    // Bound the retry: a handoff the model never gets right would otherwise
    // run to the default maximumSteps.
    stopWhen.maximumSteps(8),
  ],
});

// After a run, check whether a handoff occurred. extractHandoffTarget expects
// each step's tool-result content as a string—true for any tool built with
// createTool() (execute always returns a string), but RunResult.steps carries
// the wider ToolExecutionResult.content (JSONValue), so narrow it first.
const target = extractHandoffTarget(
  result.steps.map((step) => ({
    results: step.results.map((r) => ({ content: String(r.content) })),
  })),
);

// Always branch on undefined rather than assuming the run stopped because a
// transfer happened. The run can end with no marker in the final step—a
// handoff that never validated, or a maximumSteps/budget stop.
if (target) {
  // target is the agent name that was handed off to
} else {
  // No transfer. Handle it—retry, escalate differently, or return the
  // assistant's own last message—instead of treating it as a handoff.
}
```

> [!NOTE] Why the composition, and its limits No built-in stop condition inspects a tool result for _success_—`stopWhen.toolOutcome` triggers on `'error'`/`'action_required'`, and `stopWhen.contentMatches` reads the assistant's text, not tool results. Composing `every` with `not(toolOutcome('error'))` is how you express "the handoff was called _and_ the step is clean" out of what exists. Two consequences are worth knowing:
>
> - `toolOutcome('error')` is evaluated across the whole step, not per call. A successful handoff that shares a step with some other failing tool will not stop the loop, and if the run ends later, the marker is no longer in the final step—`extractHandoffTarget` reads only the last step, so it will miss it.
> - Neither form removes the `undefined` check. `stopWhen.toolCalled` alone stops on a failed handoff; the composition can stop for an unrelated reason. The caller is what decides a transfer occurred.

> [!WARNING] `createHandoffTool`'s `input` option defaults to `z.object({})`—an empty-object schema—when omitted. A tool call whose `arguments` is a bare string (rather than an object) fails schema validation and the call errors instead of reaching `execute`, with nothing in the type signature to flag it. Pass a custom schema when the handoff needs structured input from the model, for example a reason or a ticket summary:
>
> ```typescript
> import { z } from 'zod';
>
> const escalateToSupport = createHandoffTool({
>   name: 'escalate-to-support',
>   description: 'Transfer the conversation to the human support agent.',
>   agent: { agentName: 'support', agent: supportAgent },
>   input: z.object({ reason: z.string() }),
> });
> ```
>
> A custom schema **constrains and validates** the call; it does not add anything to the transfer. `createHandoffTool`'s `execute` takes no arguments and returns a marker containing only `type` and `agent`, so `extractHandoffTarget` can only ever give you the target agent name—never the `reason`. `HandoffOccurredEvent` is the same story: it carries the source agent, target agent, and session id, and nothing from the input.
>
> Read the value back off the recorded tool _call_ instead, which `RunResult.steps` keeps alongside the results. Note this is the raw `arguments` the model sent, as materialized JSON—not Zod's parse output, so schema defaults and transforms are not reflected in it:
>
> ```typescript
> // Read the LAST step, the same step extractHandoffTarget reads. A failed attempt is still
> // recorded on toolCalls, so scanning every step would find the failed call first and throw.
> // Gate on `target` so you only parse arguments a successful handoff actually validated.
> const handoffCall = target
>   ? result.steps.at(-1)?.toolCalls.find((call) => call.name === 'escalate-to-support')
>   : undefined;
>
> const reason =
>   handoffCall && z.object({ reason: z.string() }).parse(handoffCall.arguments).reason;
> ```
>
> If the target agent needs the reason in its own context, pass it explicitly when you start that agent's run—the handoff mechanism will not carry it across for you.

**Agent discovery:** moved to the `bureau` package (AB-22)—see its README for `createAgentDiscoveryTool`, which now takes a `BureauAgentCatalog<D>` directly rather than a standalone registry.

### Delegation grants (COR-336)

A `DelegationGrant` is the signed authority record for one child dispatch. It binds the parent and child run identifiers, the child's agent name and version, an `objective` (or an `artifactDigest` when the objective is an approved artifact), the recipient, the child's `effectiveCapabilities`, a `delegatedAuthority` for model selection, `budget` ceilings, the remaining nesting `depth`, `policyVersion`, `issuedAt`/`expiresAt`, `revoked`, and a `disclosurePolicy`. The HMAC-SHA-256 `signature` covers every other field in a canonical serialization, so a changed field, including `revoked`, fails verification. The objective is metadata: a natural-language claim that authority exists is never the authority record.

The helpers are pure functions:

- `signDelegationGrant(unsigned, secret)` signs a grant. `verifyDelegationGrant(grant, secret, now)` checks, in order, `version`, signature, revocation, and expiry, and returns `{ valid: true }` or `{ valid: false, code, reason }` with `code` of `'unsupported-version'`, `'invalid-signature'`, `'revoked'`, or `'expired'`. Every failure is a hard deny.
- `revokeDelegationGrant(grant, secret)` returns the grant revoked and re-signed.
- `attenuateDelegationCapabilities(parent, requested)` and `attenuateDelegationBudget(parent, requested)` compute a child's values that are never wider than the parent's. Allow-lists intersect, `network`/`admin` switches can only turn off, numeric ceilings take the lower value, and a dimension absent on one side inherits the other. `parent === undefined` returns `requested` unchanged.
- `isDelegationGrant(value)` is a fail-closed structural guard for a grant read back from storage. `digestDelegationArtifact(value)` is a SHA-256 digest of a value's canonical JSON. `DELEGATION_GRANT_VERSION` (`1`) is the compatibility boundary for the signed payload.
- The exported types are `DelegationGrant`, `UnsignedDelegationGrant` (a grant without `signature`, the input to `signDelegationGrant`), `DelegationCapabilities` (`tools`, `pathPatterns`, and `secrets` allow-lists, plus `network` and `admin`, each an allow-list or a switch), `DelegationBudget` (`concurrentChildren`, `totalDescendants`, `duration`, `steps`, `tokens`, `cost`, `toolCalls`), `DelegationDisclosurePolicy` (`'full' | 'redacted' | 'digest-only'`), `DelegationGrantVerification`, and `DelegationGrantVerificationCode`.

```typescript
import {
  attenuateDelegationBudget,
  attenuateDelegationCapabilities,
  DELEGATION_GRANT_VERSION,
  revokeDelegationGrant,
  signDelegationGrant,
  verifyDelegationGrant,
} from '@lostgradient/operative';

const secret = 'replace-with-a-real-secret';
const now = Date.now();

const grant = signDelegationGrant(
  {
    version: DELEGATION_GRANT_VERSION,
    id: 'delegation:planner-1',
    parentRunId: 'root-run',
    childRunId: 'planner-1',
    agentName: 'planner',
    agentVersion: '1',
    objective: 'Plan the corvid report',
    recipientId: 'planner-1',
    effectiveCapabilities: { tools: ['search', 'fetch'], network: ['example.com'] },
    delegatedAuthority: { policyVersion: 'policy/1' },
    budget: { concurrentChildren: 2, totalDescendants: 4 },
    depth: 1,
    policyVersion: 'policy/1',
    issuedAt: now,
    expiresAt: now + 60_000,
    revoked: false,
    disclosurePolicy: 'redacted',
  },
  secret,
);

const capabilities = attenuateDelegationCapabilities(grant.effectiveCapabilities, {
  tools: ['search', 'shell'],
  network: true,
});
// { tools: ['search'], network: ['example.com'] }

const budget = attenuateDelegationBudget(grant.budget, { concurrentChildren: 5, steps: 20 });
// { concurrentChildren: 2, totalDescendants: 4, steps: 20 }

const valid = verifyDelegationGrant(grant, secret, now); // { valid: true }
const tampered = verifyDelegationGrant({ ...grant, depth: 5 }, secret, now); // code: 'invalid-signature'
const revoked = verifyDelegationGrant(revokeDelegationGrant(grant, secret), secret, now); // code: 'revoked'
const expired = verifyDelegationGrant(grant, secret, grant.expiresAt); // code: 'expired'
```

`test/multi-agent-lifecycle-guide.test.ts` runs this example and asserts each commented result.

This package issues no grants on its own: `dispatchChildRun` and `createSubagentTool` narrow only model selection, through `DelegatedAuthority` (see [Selection Gate and Boundary Revalidation](#selection-gate-and-boundary-revalidation-ab-64-ab-250)). Nothing here stores grants, keeps a budget ledger, or counts usage. Bureau's `bureau.children` issues, stores, reserves budget against, and re-verifies grants on recovery; see [Bureau's parent-child topology](../bureau/README.md#parent-child-topology-cor-772). Even there, only the signature, revocation, expiry, `depth`, `concurrentChildren`, and `totalDescendants` are enforced. The capability lists, the grant's `delegatedAuthority`, and the `steps`, `tokens`, `cost`, `toolCalls`, and `duration` ceilings are recorded and attenuated, but they do not constrain the running child.

### Scheduler

```typescript
import {
  createScheduler,
  createHeartbeat,
  createChunkedTask,
  stopWhen,
} from '@lostgradient/operative';
import type { SchedulerTask } from '@lostgradient/operative';

// The scheduler shares a generate function and toolbox across all its tasks.
const scheduler = createScheduler({
  generate,
  toolbox,
  idleDelay: 500, // ms to wait before dispatching non-immediate tasks
});

scheduler.start();

// Submit a task—resolves when complete, or null if preempted and not re-queued
const task: SchedulerTask = {
  id: 'background-sync',
  priority: 'background',
  createRun: () => ({
    generate,
    toolbox,
    conversation,
    stopWhen: stopWhen.noToolCalls(),
  }),
  onComplete: (result) => {
    /* result.content */
  },
};

await scheduler.submit(task);

// Later, holding only the id, resolve or await the outcome without the promise
scheduler.locateTask('background-sync');
// { status: 'terminal', outcome: { status: 'fulfilled', value: RunResult | null } }
await scheduler.awaitTask('background-sync'); // RunResult | null, or the original error

// Periodic proactive task (heartbeat)—requires a running scheduler
const heartbeat = createHeartbeat({
  scheduler,
  interval: 60_000,
  createHeartbeatRun: () => ({ generate, toolbox, conversation, stopWhen: stopWhen.noToolCalls() }),
});
heartbeat.start();

// Break long work into preemption-friendly chunks
// createChunkedTask returns a function you call with a scheduler
const runChunked = createChunkedTask({
  name: 'dataset-processing',
  initialState: { offset: 0, processed: 0 },
  processChunk: async (state, signal) => {
    // do one chunk of work
    const done = state.offset >= totalItems;
    return { state: { ...state, offset: state.offset + 50 }, done };
  },
  onComplete: (finalState) => {
    /* all chunks done */
  },
});

await runChunked(scheduler);
```

**Callback promises are tracked and awaited, not fired-and-forgotten (AB-208).** A scheduler task's `onComplete`/`onPreempted` callback can return a promise; `Scheduler.stop()` awaits every such promise (in the same pass it already awaits durable cancellations) before its own returned promise resolves, so a stopped scheduler is a real boundary for anything the callback closes over—a rejection after the owner stopped is captured and reported as a `task.failed` event rather than becoming an unhandled rejection. `createChunkedTask`'s `onComplete`/`onError` callbacks are likewise awaited before `submitChunkedWork`'s returned promise settles. `createHeartbeat(...).stop()` returns `Promise<void>`, resolving once the in-flight `tick()` (and its `onTick` callback promise) settles—calling it on an already-stopped heartbeat is a no-op that resolves promptly.

#### Task locator and retention

Tasks submitted through `submit()` and `submitImmediate()` (not `dispatch()`) stay resolvable by id after they settle:

- `locateTask(taskId)` is synchronous, never throws, and returns a `SchedulerTaskLocation`: `{ status: 'in-progress' }`, `{ status: 'terminal', outcome }` (a `PromiseSettledResult<RunResult | null>`: a cancelled or `stop()`-discarded task is `fulfilled` with `null`, a failure is `rejected` with the original reason), `{ status: 'expired' }`, or `{ status: 'not-found' }`.
- `awaitTask(taskId)` mirrors `submit()`'s settlement: it waits for an in-progress task, settles immediately for a retained one, and rejects with `SchedulerTaskLookupError` (`reason: 'expired' | 'not-found'`) otherwise. It never waits for a future submission, and an unobserved returned promise does not raise `unhandledRejection`.
- `retentionWindowMs` (finite, greater than zero, otherwise `createScheduler` throws) bounds retention on `runtime.timers`. Each terminal outcome is evicted exactly one window after it settles, emitting `TaskRetentionCleanedEvent` (`task.retention-cleaned`, `outcome: 'completed'`) and leaving an `expired` tombstone; one further window later the id is `not-found`. Unset keeps outcomes indefinitely with no timers.
- Resubmitting an id replaces its retained entry or tombstone. `stop()` clears all retention state and timers (emitting nothing), so every id is `not-found` afterward. Retention is in memory and per scheduler.

### Cost Estimation and Budget

```typescript
import { estimateCost, createCostBudgetMonitor } from '@lostgradient/operative';

const estimate = estimateCost(
  { prompt: 5000, completion: 800, total: 5800 },
  'claude-opus-4-20250514',
);
// estimate.totalCost—total dollar cost for this call

const monitor = createCostBudgetMonitor({
  budget: 0.1, // $0.10 USD
  model: 'claude-sonnet-4-20250514',
  thresholds: [0.5, 0.8], // warn at 50% and 80%
  onThreshold: (event) => console.warn(`${event.threshold * 100}% of budget used`),
  onExceeded: (event) => console.error('Budget exceeded at $' + event.currentCost.toFixed(4)),
});
```

### Model Catalog (AB-64)

`createModelCatalog` (`@lostgradient/operative`) builds a static, synchronous, side-effect-free `ModelCatalog`—one `BackendDescriptor` row per `(provider, endpoint, model)` this package ships a generate function for. Each descriptor names its `modalities` (an AB-70 `ModalityMatrix`, re-exported from `conversationalist`), context/output limits, effort support and degradation, parameter compatibility, pricing (derived from `defaultPricingTable`, never fabricated), and availability/health. `voyage` and `ollama` are embedding-only and get no row. `CreateModelCatalogOptions.runtime?: RuntimeServices` (AB-325) backs the default `now` when `options.now` is not supplied—defaults to the real implementation; an explicit `now` still takes precedence over `runtime` when both are given.

```typescript
import { createModelCatalog } from '@lostgradient/operative';

const catalog = createModelCatalog();
// catalog.revision, catalog.descriptors, catalog.projection ('privileged')

const anthropicRows = catalog.descriptors.filter((d) => d.provider === 'anthropic');
```

`getProviderCapabilities` is now implemented as a projection over `createModelCatalog`'s descriptors—its public signature and every previously published answer are unchanged.

### Agent Generation Profile (AB-64, AB-245)

Every `RunnableAgent` optionally carries an immutable, cached `generationProfile: AgentGenerationProfile` naming which `BackendDescriptor`(s) sit behind its `GenerateFunction` and in which mode: `'fixed'` (exactly one descriptor—a single provider factory), `'routed'` (more than one—e.g. `createRoutingGenerate`), `'selectable'` (candidates named, no selector yet—AB-66), or `'opaque'` (a custom `GenerateFunction` this package can't introspect, never an invented descriptor). Read it with `readGenerationProfile(agent)`, which falls back to a frozen `mode: 'opaque'` profile when an agent carries none—never a network call, a lazy-module load, or any other background work.

```typescript
import {
  createAgent,
  createLazyGenerate,
  readGenerationProfile,
  type AgentGenerationProfile,
} from '@lostgradient/operative';
import {
  createAnthropicProvider,
  createModelCatalog,
  readBackendDescriptors,
  withBackendDescriptors,
} from '@lostgradient/operative';

// createAnthropicProvider/createOpenAIProvider/createGeminiProvider (and the
// Anthropic/OpenAI streaming siblings) attach the single seed descriptor
// matching their resolved model automatically—nothing to do here.
// createGeminiProviderStream is the one exception: the seed catalog's Gemini
// row describes `generateContent`, not the distinct `generateContentStream`
// operation this factory calls, so it deliberately attaches nothing.
const generate = createAnthropicProvider({ model: 'claude-sonnet-5', apiKey: '...' });
const agent = createAgent({ generate });
agent.generationProfile.mode; // 'fixed'

// A custom GenerateFunction can attach its own descriptor(s)—e.g. one
// resolved from the seed catalog for a model this package doesn't wrap.
const catalog = createModelCatalog();
const customDescriptor = catalog.descriptors.find((d) => d.provider === 'anthropic');
const custom = withBackendDescriptors(
  async (context) => {
    /* ... */
    return { content: '', toolCalls: [] };
  },
  customDescriptor ? [customDescriptor] : [],
);
readBackendDescriptors(custom); // the array just attached, never inferred

// A lazy generate function attaches descriptors at construction time—a
// profile read never triggers the loader.
const lazyGenerate = createLazyGenerate(
  () => import('./anthropic-generate.ts').then((m) => m.default),
  {
    descriptors: customDescriptor ? [customDescriptor] : [],
  },
);

const readOnly: AgentGenerationProfile = readGenerationProfile(agent);
```

`AgentPreferences` (`requiredCapabilities`, `preferredProviders`, `preferredModels`, `minimumContextWindowTokens`) and `allowedCandidates` reach the profile through two new `createAgent` options, `generationPreferences` and `allowedCandidates`—the latter promotes the mode to `'selectable'`. `selector` always reads `'unavailable'` on a standalone agent (no Bureau, no policy, no catalog to select through); `'available'` is reported only through Bureau's future catalog read (AB-66/AB-247).

Every generate-function wrapper this package ships preserves whatever descriptors the function it wraps carried, so composing wrappers around a described provider factory never silently downgrades an Agent's profile to `'opaque'`: `withStreaming`, `withRoutingMetrics`, `withEnhancedStreaming`, `withCache`, `withCacheMetrics`, the provider instrumentation wrapper (`instrumentGenerate`), `createFallbackGenerate`, and `createFalloverGenerate` all read `readBackendDescriptors` off their inner function(s) and reattach the result to the function they return. `createFallbackGenerate` and `createFalloverGenerate`, like `createRoutingGenerate`, attach the ordered union of every candidate's descriptors, deduplicated by `(provider, endpoint, model)`.

### Model Policy Precedence (AB-64, AB-248)

`composePolicy` (`@lostgradient/operative`) is a pure, synchronous function that composes AB-64's five precedence layers—deployment invariants, Bureau invariants, Agent requirements and preferences, delegated authority, and user constraints and preferences—over a fixed set of `BackendDescriptor`s. Each layer only narrows what the layer above allowed; the first layer to exclude a candidate owns its `exclusionCode`, and no later layer can overwrite it or re-admit a candidate a higher layer denied.

```typescript
import { composePolicy, createModelCatalog } from '@lostgradient/operative';

const { descriptors } = createModelCatalog();

const result = composePolicy({
  descriptors,
  deployment: { deniedProviders: ['gemini'] },
  bureau: { deniedModels: ['gpt-4o'] },
  agent: { minimumContextWindowTokens: 100_000 },
  delegated: { grantedProviders: ['anthropic', 'openai'], policyVersion: 'grant-v1' },
  user: { deniedRegions: ['eu'] },
});

// One PolicyCandidate per descriptor, in input order—never dropped silently.
result[0]?.eligible; // boolean
result[0]?.exclusionCode; // e.g. 'denied-by-deployment', when excluded
```

`AgentPreferences` expresses needs, never denials: a missing `requiredCapabilities` entry or a `minimumContextWindowTokens` shortfall excludes with `missing-required-capability`, while `preferredProviders`/`preferredModels` exclude nothing and are carried through for the selector below to rank on. `DelegatedAuthority` narrows by omission—`grantedProviders`/`grantedModels` absent narrows nothing, present-and-not-naming excludes with `exceeds-delegated-authority`, and `policyVersion` is traceable in every exclusion this layer produces. `user.exactOverride` must name both `provider` and `model` to identify exactly one descriptor—a partially specified override resolves to none, never an ambiguous multi-candidate result. A fully specified override is checked only against the four layers above the user's before being honored: a rejected override yields a single-candidate result carrying the denying layer's own code, never `denied-by-user`.

Ranking, tie-breaking, the deterministic selector, and the `SelectionPlan` itself are the next section's scope (AB-249)—this composition only produces the eligible/excluded candidate set that selector consumes.

### Deterministic Backend Selector and Selection Plan (AB-64, AB-249)

`select(request, options)` (`@lostgradient/operative`) is a pure, synchronous function: no input or output, no clock read except the injected `options.now`/`options.runtime`. It calls `composePolicy` internally for hard-constraint filtering, applies effort compatibility within the eligible set, then ranks by `costPreference`/`latencyPreference`/`preferredProviders`/`preferredModels`, breaking ties by `(provider, model)` lexicographic order. Two calls with the same recorded input produce deeply equal plans. `SelectOptions.runtime?: RuntimeServices` (AB-325) backs the default `now`/`newPlanId` when those are not supplied, defaulting to the real implementation; explicit `now`/`newPlanId` still take precedence over `runtime` when both are given.

```typescript
import { composePolicy, createModelCatalog, select } from '@lostgradient/operative';

const catalog = createModelCatalog();

const plan = select(
  {
    agentName: 'researcher',
    catalogRevision: catalog.revision,
    policyRevision: 1,
    availabilitySnapshotRevision: 1,
    requestedValue: { target: 'effort', override: 'high' },
  },
  {
    catalog,
    user: { costPreference: 'lowest-cost', effortFallbackMode: 'degrade' },
    now: () => new Date().toISOString(),
    newPlanId: () => crypto.randomUUID(),
  },
);

plan.outcome; // 'selected' | 'no-candidate' | 'stale-catalog' | ...
plan.selected; // { provider, model, effort? } | undefined
plan.candidates[0]?.descriptorSnapshot; // inlined by value—safe to replay after the catalog moves on
```

Every eligible candidate's `descriptorSnapshot` is a deep, independent structural copy of the deciding `BackendDescriptor`—never a live reference—so a `SelectionPlan` replays its own eligibility reasoning unchanged after the source catalog has moved on, been mutated, or been discarded. `rankingInputs` names three signals per eligible candidate (`cost`, `latency`, `preferenceMatch`) rather than summarizing into one score. All seven `SelectionOutcomeKind` values are reachable; `failure` is present if and only if `outcome !== 'selected'`, enforced structurally by the exported type. `recordEffectiveGeneration(plan, effective)` folds a completed generation's actual backend into a `'selected'` plan without ever rewriting `selected`: a divergence produces a new terminal `'provider-effective-divergence'` plan alongside the original selection; a non-divergence returns `plan` unchanged, by reference.

Bureau wiring (`BureauOptions.modelPolicy`, `Bureau.planSelection`) and `runStep` boundary revalidation ship next (AB-250, below); cross-mode replay fixtures are AB-251's.

### Selection Gate and Boundary Revalidation (AB-64, AB-250)

`RunOptions` gains an optional `selection?: SelectionGate`, mirroring the shipped `steering?: SteeringGate` field (unlike `steering`, it carries no `runId` coupling). `run-step.ts` reads it at the same shared boundary the steering gate is already read—after the pause-wait loop, before backpressure—and calls `gate.revalidate()`, which is synchronous and pure, exactly like `select` itself:

```typescript
import { createSelectionGate } from '@lostgradient/operative';
import { select } from '@lostgradient/operative';

const gate = createSelectionGate({
  initialPlan: select(request, options),
  request: () => currentRequest(), // read fresh on every revalidate() call
  options: () => currentOptions(), // read fresh on every revalidate() call
});

// ...later, at the runStep boundary:
const revalidated = gate.revalidate();
revalidated.outcome; // 'selected' when nothing changed; a typed replacement otherwise
```

A revalidated plan that no longer reaches `outcome: 'selected'` fails the step with the new `SelectionRevalidationError` (`kind: 'policy'`, `code: 'SELECTION_REVALIDATION_FAILED'`), carrying both the failed replacement plan (`.plan`) and the superseded plan it replaces (`.supersededPlan`)—never silently falling back to the superseded plan's model. Omitting `RunOptions.selection` leaves `runStep` behaving exactly as it does today.

`DelegatedAuthority` threads through `dispatchChildRun`'s `DispatchChildRunOptions.delegatedAuthority`, forwarded to `agent.run()` as the new `AgentRunContext.delegatedAuthority`—never through `BureauRunOptions`. `attenuateDelegatedAuthority(parent, child)` (`@lostgradient/operative`) composes a parent's grant with the authority a dispatch site wants to hand one specific child: `grantedProviders`/`grantedModels` intersect (never widen), `maximumEffort` takes the lower tier, and the result's `policyVersion` is the attenuating (child) grant's own version.

`AgentRunContext.delegatedAuthority` also threads through `RunOptions.delegatedAuthority` into every tool call's per-execution `ToolContext.executionContext.delegatedAuthority` (AB-300), matching the AB-233 `childRegistry`/`parentRunId` pattern exactly. `createSubagentTool` reads it there at execute time, attenuates it with its own `delegatedAuthority` construction option (a tool's own narrowing for the specific child it dispatches, if any) via `attenuateDelegatedAuthority`, and forwards the result into `dispatchChildRun`. A parent run carrying no grant and a tool with no narrowing of its own dispatch with `delegatedAuthority` left `undefined`, exactly as before this wiring existed.

Bureau's `planSelection`/`createSelectionGateFor` surface (`packages/bureau/src/model-policy.ts`) is documented in `packages/bureau/README.md`.

### Structured Output

`output` (AB-18) is the single validated output contract: one Zod schema that drives inference, the provider-native JSON Schema (via `z.toJSONSchema(schema, { io: 'input' })`), and runtime validation. There is no separate `responseSchema`/`responseJsonSchema` pair, no non-Zod Standard Schema branch, and no raw JSON Schema input—a caller who needs the latter converts it to a Zod schema first.

```typescript
import { createActiveRun, stopWhen } from '@lostgradient/operative';
import { z } from 'zod';

const OutputSchema = z.object({
  summary: z.string(),
  keyPoints: z.array(z.string()),
  confidence: z.number().min(0).max(1),
});

const activeRun = createActiveRun({
  generate,
  toolbox,
  conversation,
  stopWhen: stopWhen.noToolCalls(),
  output: OutputSchema,
  schemaRetries: 2,
});
```

An unrepresentable schema (e.g. `z.date()`, `z.custom()`) throws a synchronous `OutputSchemaConversionError`—there is no generic-object fallback; both `createAgent` and `createActiveRun` run this check at their own (synchronous) call time, before a run ever starts. The final text is parsed with `JSON.parse` when it's valid JSON (and the parsed value is checked against the recursive JSON-value contract: finite numbers, dense arrays, no cycles, no exotic objects); otherwise the raw string itself is validated against the schema, so `output: z.string()` still works for a non-JSON reply. A schema mismatch on JSON throws `OutputValidationError` (its `.issues` field exposes the underlying `ZodError`'s per-field issues); non-JSON text that still fails validation throws `NonJsonOutputError`.

`validateOutputValue(schema, candidate)` runs that same JSON-value-then-schema contract directly on an already-decoded value, for a caller that holds one rather than raw text—a durable checkpoint's persisted `output`, or a provider whose native structured-output mode returns a decoded object. `validateOutput(schema, text)` (the text-based entry point above) delegates to it for its JSON-parsed branch.

> [!IMPORTANT] An `output` schema **must not** declare a field intended to carry binary or media content (the AB-70 amendment to this issue). Structured output is JSON-only—`output` is never permitted to contain a `PortableContentPart` or a base64 blob. A generated asset (an image, a file, audio) a run produces belongs in `RunResult.parts` as a managed-asset reference part (`{ source: { kind: 'managed-asset', assetId } }`), never inlined as base64 inside the schema-validated `output`. `output` and conversational content are orthogonal and may both be present on a successful result.

### Scratchpad

```typescript
import {
  createAgent,
  createScratchpad,
  createScratchpadReadTool,
  createScratchpadWriteTool,
} from '@lostgradient/operative';

const scratchpad = createScratchpad({ initialValues: { step: 0 } });

const readTool = createScratchpadReadTool(scratchpad);
const writeTool = createScratchpadWriteTool(scratchpad);

const agent = createAgent({
  generate,
  tools: { 'scratchpad-read': readTool, 'scratchpad-write': writeTool },
});
```

### Context Compaction

```typescript
import { createActiveRun, createContextCompactor, stopWhen } from '@lostgradient/operative';

// createContextCompactor returns an onCompact function for contextManagement.
// The summarize callback receives an array of Message objects (not a Conversation).
const onCompact = createContextCompactor({
  summarize: async (messages) => {
    // Condense messages into a summary string—call your provider here.
    return `Summary of ${messages.length} prior messages.`;
  },
  retainRecentMessages: 6,
});

const activeRun = createActiveRun({
  generate,
  toolbox,
  conversation,
  stopWhen: stopWhen.noToolCalls(),
  contextManagement: {
    maxTokens: 80_000,
    onCompact,
  },
});
```

#### Background compaction

A step can also prepare compaction ahead of time without waiting for it. Create a scheduler for the run's conversation with conversationalist's `createCompactionScheduler`, then pass it as `contextManagement.background`. When a step's estimate is above `background.threshold` but at or below the synchronous `compactionThreshold`, the step requests background compaction and generates without waiting.

The candidate publishes only through `Conversation.compact()`'s revision compare-and-swap. A step therefore reads either the whole history before the commit or the whole compacted history after it. When a message or streamed token lands while the summary is being written, the candidate goes stale and is rescheduled under the scheduler's bounded policy instead of overwriting the write. A candidate also starts only at a durable boundary: a window that opens while a step is streaming or while its tool calls are still running waits until the stream closes or the results land, so a summary never strands a streaming reply or removes a pending tool call. Aborting the run withdraws queued work and aborts a running summary. A step that reaches the synchronous threshold cancels background work and waits for any aborted summary to return before its own `onCompact` runs, so the synchronous summary never overlaps a background one. Overflow recovery through `createOverflowMutator` never waits for background work, and the retry loop hands it the history the failed request was sent with. What it does depends on where the background candidate is when the overflow arrives. If the candidate already committed after the request was sent, for example during the provider's network wait, recovery retries once against that compaction without writing a summary of its own. If the candidate is still running, recovery's summary overlaps it and the compare-and-swap publishes whichever commits first; when the candidate wins, recovery retries once against it. If no candidate is running, recovery compacts the history itself. In every case a second overflow against the same compacted history rethrows the provider error instead of compacting it again. The caller owns the scheduler and disposes it.

```typescript
import { Conversation, createCompactionScheduler } from 'conversationalist';

const conversation = new Conversation();
const scheduler = createCompactionScheduler(conversation, {
  summarizer: async (messages) => `Summary of ${messages.length} prior messages.`,
  compaction: { preserveRecentCount: 6 },
});

const activeRun = createActiveRun({
  generate,
  toolbox,
  conversation,
  stopWhen: stopWhen.noToolCalls(),
  contextManagement: {
    maxTokens: 80_000,
    onCompact,
    background: { threshold: 40_000, scheduler },
  },
});

await activeRun.result;
console.log(scheduler.state.phase, scheduler.state.counts);
await scheduler.dispose();
```

### Memory Bridge

```typescript
import {
  createActiveRun,
  createMemoryBridge,
  createScratchpad,
  stopWhen,
} from '@lostgradient/operative';
import type { GenerateFunction, MemoryLike } from '@lostgradient/operative';

declare const generate: GenerateFunction;
declare const myMemoryAdapter: MemoryLike;

// operative never imports the memory package directly—supply a MemoryLike adapter.
// createMemoryBridge returns { prepareStep, onStep }.
// prepareStep recalls memories into the scratchpad on step 0.
// onStep persists scratchpad entries back to long-term memory on the final step.
// Register createScratchpadReadTool(scratchpad) / createScratchpadWriteTool(scratchpad)
// on the toolbox you pass below so the model can read and write it.
const scratchpad = createScratchpad();
const bridge = createMemoryBridge({
  memory: myMemoryAdapter, // satisfies MemoryLike
  scratchpad,
  recallLimit: 5,
  scratchpadKey: 'memories',
});

const activeRun = createActiveRun({
  generate,
  toolbox,
  conversation,
  stopWhen: stopWhen.noToolCalls(),
  prepareStep: bridge.prepareStep,
  onStep: bridge.onStep,
});
```

### Identity Hook

```typescript
import { createActiveRun, createIdentityHook, stopWhen } from '@lostgradient/operative';

const identityHook = createIdentityHook({
  resolve: async () => 'You are Aria, a friendly customer success agent.',
});

const activeRun = createActiveRun({
  generate,
  toolbox,
  conversation,
  stopWhen: stopWhen.noToolCalls(),
  prepareStep: identityHook,
});
```

### Policy Enforcement

```typescript
import { createPolicyEnforcementHook } from '@lostgradient/operative';
import type { ToolLike } from '@lostgradient/operative';

// createPolicyEnforcementHook returns a tool-filtering function:
//   (tools: T[]) => T[]
// Apply it to any array of ToolLike objects to enforce allow/deny policies.
const enforcePolicy = createPolicyEnforcementHook({
  personaToolPolicy: {
    denyList: ['fs.write', 'fs.delete'], // always blocked
  },
  getActiveSkillToolPolicy: () => ({
    allowList: ['search', 'summarize'], // dynamic—per active skill
  }),
});

// Example: filter a tool-descriptor array before constructing a toolbox.
// `toolbox.tools()` returns the registered tools; pass them through enforcePolicy.
const allTools: ToolLike[] = toolbox.tools();
const allowedTools = enforcePolicy(allTools);
```

### Early Stopping

```typescript
import { createActiveRun, createEarlyStoppingHandler, stopWhen } from '@lostgradient/operative';

// Creates an onMaximumSteps callback that calls the model one final time
// without tools, prompting it to summarize findings before the loop ends.
const onMaximumSteps = createEarlyStoppingHandler(generate, {
  message: 'Summarize your findings so far in one paragraph.',
});

const activeRun = createActiveRun({
  generate,
  toolbox,
  conversation,
  stopWhen: stopWhen.noToolCalls(),
  maximumSteps: 10,
  onMaximumSteps,
});
```

### Stop Conditions

Composable predicates for loop exit. All are available on the `stopWhen` namespace object, or can be imported individually.

```typescript
import { createActiveRun } from '@lostgradient/operative';
import { stopWhen } from '@lostgradient/operative';

// Stop when the model produces no tool calls (each predicate is a factory—call it)
const noTools = stopWhen.noToolCalls();

// Stop after 5 steps
const maxSteps = stopWhen.maximumSteps(5);

// Stop when a specific tool was called
const submitted = stopWhen.toolCalled('submit-form');

// Stop when any tool result's outcome is 'error' or 'action_required'
const errored = stopWhen.toolOutcome('error');

// Stop when content satisfies a predicate
const goodbyeDetected = stopWhen.contentMatches((content) => /goodbye/i.test(content));

// Logical composition
const compound = stopWhen.some(stopWhen.noToolCalls(), stopWhen.maximumSteps(10));

// Must ALL conditions be true to stop
const strict = stopWhen.every(stopWhen.noToolCalls(), stopWhen.toolCalled('finalize'));

// Invert any condition
const mustUseTool = stopWhen.not(stopWhen.noToolCalls());

// Detect the model repeating the same tool call in a loop (windowSize defaults to 3)
const noLoop = stopWhen.repeatingToolCalls({ windowSize: 3 });

// Stop on token budget (maxTokens is positional)
const underBudget = stopWhen.tokenBudget(50_000);

// Hard wall-clock timeout (milliseconds is positional)
const timed = stopWhen.wallClockTimeout(30_000);

// Stop when accumulated cost exceeds a dollar amount
const affordable = stopWhen.costBudget({ budget: 0.05, model: 'claude-sonnet-4-20250514' });

// Fork: stop condition for branching workflows
const branchDone = stopWhen.forked();

// Park cleanly after a step whose tool results include a pending approval —
// no further generate call happens. See createAgent's stateless chat host
// recipe above for the full resume flow (toolbox.resumeApproval + a fresh
// run started from the updated conversation history).
const parkOnApproval = stopWhen.pendingApproval();

const activeRun = createActiveRun({
  generate,
  toolbox,
  conversation,
  stopWhen: [noTools, maxSteps],
});
```

**All `stopWhen` predicates:**

| Predicate | Description |
| --- | --- |
| `noToolCalls()` | Stop when a step produces zero tool calls. |
| `toolCalled(name)` | Stop when a tool with the given name was called. |
| `maximumSteps(n)` | Stop after `n` steps. |
| `toolOutcome(outcome)` | Stop when any tool result's outcome is `'error'` or `'action_required'`. |
| `contentMatches(predicate)` | Stop when `predicate(content)` returns `true`. |
| `every(...conditions)` | AND—stop when all conditions are true. |
| `some(...conditions)` | OR—stop when any condition is true. |
| `not(condition)` | Negate a condition. |
| `forked()` | Stop condition for branching / forked workflow control. |
| `repeatingToolCalls(options?)` | Stop when the same tool repeats `windowSize` times (default 3). |
| `tokenBudget(maxTokens, options?)` | Stop when cumulative token usage exceeds `maxTokens`. |
| `wallClockTimeout(milliseconds, options?)` | Stop when elapsed wall-clock time exceeds `milliseconds`. |
| `costBudget(options)` | Stop when accumulated dollar cost exceeds `options.budget`. |

### Guardrails

Guardrails are the trust boundary between the agent loop and everything that can inject untrusted content into it—the user, retrieved memories, ingested documents, and skill resources. Detectors live in `armorer` (shared with the retrieval surfaces); `@lostgradient/operative` wires them into the loop as `prepareStep`/`validateResponse` hooks. Import these functions from the single `@lostgradient/operative` entry point.

### The Tripwire Model (AB-40)

Every detector/validator returns a `DetectionResult`/`ValidationResult` carrying a `confidence` score. What happens when one triggers is governed by an `action`, configured per guardrail group—`InputGuardrailOptions.action` (`'block' | 'warn' | 'sanitize' | 'tripwire'`, using `DetectionResult.sanitized` for `'sanitize'`) and `OutputGuardrailOptions.action` (`'block' | 'warn' | 'redact' | 'tripwire'`, using `ValidationResult.redacted` for `'redact'`). `GuardrailsOptions.mode` sets both sides at once:

- **`mode: 'validate'`** (default)—a tripped detector/validator substitutes a blocked/sanitized/redacted response and the run continues, per each guardrail's own `action`.
- **`mode: 'tripwire'`**—overrides `input.action`/`output.action` to `'tripwire'` regardless of what they were set to. A tripped wire throws a `GuardrailTripwireError`, hard-halting the run with `finishReason: 'tripwire'` and a `run.tripwire` event identifying the guardrail, instead of substituting a blocked or redacted response. Use this where a false negative is unacceptable and a human should look at the transcript before the agent takes another step.

`withMinimumTripwireConfidence(detector, threshold)` wraps a detector so it only trips at or above a confidence floor, letting a broad detector stay quiet on low-confidence hits while still reaching the tripwire on high-confidence ones.

### Detector and Validator Catalog

| Name | Kind | Scans | Notes |
| --- | --- | --- | --- |
| `createPromptInjectionDetector` | Input detector | Incoming content, any provenance | Pattern + heuristic scoring; confidence scales with the number of matched signals. |
| `createInputLengthDetector` | Input detector | Incoming content | Blocks overlong inputs before they reach the model. |
| `createTopicBoundaryDetector` | Input detector | Incoming content | Restricts the conversation to an allow/block topic list. Matching is literal, case-insensitive substring matching, not semantic—see the note below the table. |
| `createOutputPIIValidator` | Output validator | Model output | Detects and redacts email addresses, phone numbers, and API-key-shaped secrets in generated text. |
| `createGroundingValidator` | Output validator | Model output vs. supplied context | Flags claims the output makes that aren't traceable to the provided context. |
| `createCodeSafetyValidator` | Output validator | Model output | Flags destructive shell patterns (`rm -rf`), code execution (`eval`/`exec`/`Function`/`subprocess`), dangerous SQL (`DROP TABLE`, unfiltered `DELETE FROM`), and pipe-to-shell (`curl \| bash`) in generated code. Extend with `blockedPatterns`. |
| `createSessionTaintTracker` | Session state | Cumulative session history | Sticky escalation: once a high-confidence hit taints a session, escalated detectors/validators activate for its remainder. |

> [!WARNING] `createTopicBoundaryDetector`'s `allowedTopics`/`blockedKeywords` matching is **literal, case-insensitive substring matching**—`input.toLowerCase().includes(keyword.toLowerCase())`—not semantic matching. There is no NLP, embeddings, or synonym lookup involved. With `allowedTopics: ['cooking']`, the clearly on-topic input `"What is a good recipe for banana bread?"` is flagged and blocked, because the literal substring `"cooking"` never appears. List every literal word or phrase you expect callers to use—including common synonyms and paraphrases—not just one representative term.

### Provenance and the Three Retrieval Surfaces (AB-41)

Input detectors run against a `GuardrailProvenance` tag—every `DetectorContext.provenance` and every `GuardrailTriggeredEvent.provenance` on the input side carries one of:

- `'user-input'`—content typed directly by the session's user.
- `'recalled-memory'`—content pulled in by `memory`'s recall tool.
- `'ingested-document'`—content pulled in from an ingested document (e.g. a file or URL fetched into context).
- `'skill-resource'`—content pulled in from a skill's bundled resources.

The three retrieval tags mark a distinct trust boundary from `'user-input'`: that content was authored by someone (or something) other than the current session's user and may have been crafted specifically to manipulate the model. Callers that assemble context from memory, documents, or skills should tag detector calls with the matching provenance so guardrail triggers and audit logs can distinguish "the user asked for this" from "this arrived via retrieval." (Provenance is an input-side concept—output validators run against generated text with no retrieval source to tag; a taint raised from a retrieval surface can still carry its `provenance` through `SessionTaintedEvent.provenance` into `createSessionTaintTracker`.)

### The Bureau Default Preset

`bureau` wires a guardrail preset automatically whenever `BureauOptions.guardrails` is left `undefined`:

- `mode: 'tripwire'`—any trigger hard-halts the run.
- **Input**: `createPromptInjectionDetector()` wrapped in `withMinimumTripwireConfidence(..., DEFAULT_PROMPT_INJECTION_TRIPWIRE_THRESHOLD)`—the threshold is `0.6`, so only medium-to-high-confidence injection matches trip the run.
- **Output**: `createOutputPIIValidator()`—output PII trips the run rather than being redacted.

Pass `guardrails: false` to `bureau`'s options to opt out entirely, or a `GuardrailsOptions` object to replace the preset with your own detectors/validators.

The preset is exported as `createDefaultGuardrailsPreset()`, and `createAgent` applies it too (COR-1367): an agent whose `guardrails` option is omitted resolves its run's guardrails as `inheritedGuardrails ?? createDefaultGuardrailsPreset()`, where `inheritedGuardrails` is the policy a host hands down through `AgentRunContext` (Bureau hands down the deprecated `BureauOptions.guardrails`). `guardrails: false` opts the agent out, and a `GuardrailsOptions` replaces the preset whatever the host says. The guardrails are created per run, registered in the agent's tier (`agent:guardrails-prepare-step`, `agent:guardrails-validate-response`, pinned behind the agent's own hooks), and also scan the agent's skill bodies and resources when `skills` is set.

```typescript
const guarded = createAgent({ generate }); // AB-40 preset
const custom = createAgent({ generate, guardrails: { mode: 'tripwire', input: { detectors } } });
const unguarded = createAgent({ generate, guardrails: false });
```

A `createAgent` agent does not buffer its own `generate`: if that function streams text to a client as it arrives, the output validator sees the response only after it was delivered. Buffer generation when the output tripwire must gate what a client sees.

**Buffered-generation note:** the default preset's output PII validator only ever sees a complete response—it cannot inspect a stream mid-flight. `bureau` accounts for this: whenever the default preset is in effect (`options.guardrails === undefined`), it forces buffered (non-streaming) generation so the tripwire has a chance to fire before any output reaches the caller. A caller who supplies their own `GuardrailsOptions` (replacing the preset) has opted into managing that tradeoff themselves and keeps streaming enabled.

### Usage

```typescript
import {
  createGuardrails,
  createPromptInjectionDetector,
  createOutputPIIValidator,
  withMinimumTripwireConfidence,
} from '@lostgradient/operative';
import { createActiveRun, stopWhen } from '@lostgradient/operative';

const guardrails = createGuardrails({
  mode: 'tripwire',
  input: {
    detectors: [withMinimumTripwireConfidence(createPromptInjectionDetector(), 0.6)],
  },
  output: { validators: [createOutputPIIValidator()] },
});

const activeRun = createActiveRun({
  generate,
  toolbox,
  conversation,
  stopWhen: stopWhen.noToolCalls(),
  prepareStep: guardrails.prepareStep,
  validateResponse: guardrails.validateResponse,
});
```

**Exported functions:** `createGuardrails`, `createInputGuardrail`, `createOutputGuardrail`, `createSessionTaintTracker`, `createCodeSafetyValidator`, `createGroundingValidator`, `createOutputPIIValidator`, `createInputLengthDetector`, `createPromptInjectionDetector`, `createTopicBoundaryDetector`, `withMinimumTripwireConfidence`, `DEFAULT_PROMPT_INJECTION_TRIPWIRE_THRESHOLD`.

**Exported types:** `DetectionResult`, `DetectorContext`, `GuardrailHooks`, `GuardrailProvenance`, `GuardrailsOptions`, `GuardrailTriggeredEvent`, `InputDetector`, `InputGuardrailOptions`, `OutputGuardrailOptions`, `OutputGuardrailTriggeredEvent`, `OutputValidator`, `SessionTaintedEvent`, `SessionTaintOptions`, `SessionTaintTracker`, `ValidationResult`, `ValidatorContext`, `CodeSafetyValidatorOptions`, `GroundingValidatorOptions`, `InputLengthDetectorOptions`, `PromptInjectionDetectorOptions`, `TopicBoundaryDetectorOptions`.

### Liveness Watchdog

AB-88's binding liveness, progress, and stuck-work contract, implemented by AB-214/obs-01. `LivenessSnapshot` is the plain-data, immutable-per-revision read every `LivenessObservable` (`ActiveRun`, `AgentRun`, `DiagnosticAgentRun`) returns from `snapshot()`/`subscribeSnapshot()`: lifecycle status, reachability, progress, a derived single-glance `assessment`, attempt-fenced evidence, and the `StallPolicy` version that produced it.

```typescript
import {
  createStallWatchdog,
  LIVENESS_POLICY_VERSION,
  TOOL_CALL_POLICY,
  toolCallPolicy,
} from '@lostgradient/operative';

const clock = {
  now: () => Date.now(),
  setTimeout: (cb, ms) => setTimeout(cb, ms),
  clearTimeout: (handle) => clearTimeout(handle),
};

const watchdog = createStallWatchdog(toolCallPolicy(30_000), clock);
watchdog.recordPulse('tool-progress', /* attempt */ 0, { percent: 50 });
const { reachability, progress, missedPulseCount } = watchdog.assess();
watchdog.dispose(); // clears the internal cadence timer
```

`createStallWatchdog` is the single timer-agnostic implementation of a `StallPolicy` row's cadence, grace, jitter, and missed-pulse math—every consumer that classifies its OWN silence (obs-02's `SessionHandle` wiring, obs-06's Gateway connection watchdog) imports it rather than reimplementing it. obs-03's child-liveness rollup (below) is deliberately NOT a `createStallWatchdog` consumer: a parent never classifies a child's silence with a watchdog of its own—it only folds each child's own already-computed `assessment`, per AB-88's delegated-policy rule. Evidence sources are isolated per AB-88's AC5 table: a `host-reachability` pulse never resets a missed-pulse count accrued from `provider-io`, `tool-progress`, `worker-session-heartbeat`, `task-attempt-heartbeat`, or `lease-renewal`; an evidence entry whose `attempt` is older than the watchdog's current attempt is discarded, never merged. Every `monotonic-observer` policy pauses accrual across a clock gap an order of magnitude larger than `cadenceMs + graceMs` (a suspected process/laptop suspension, not real silence).

**Exported functions:** `createStallWatchdog`, `createDefaultRunIdentifierSeam(runtime?: RuntimeServices)`, `sessionMonitorPolicy`, `toolCallPolicy`.

`createDefaultRunIdentifierSeam` (AB-325) reads through a `RuntimeServices` instance (`options.runtime`, defaulting to `createDefaultRuntimeServices()`) rather than a bare `crypto.randomUUID()` call, so a manual runtime controls its minted ids in tests. `createActiveRunLiveness`'s `ActiveRunLivenessOptions` gains the same `runtime?: RuntimeServices` option (AB-325), backing `startedAt`/`lastTransitionAt` and—when `options.clock` is not separately supplied—the watchdog's monotonic/timer seam too; `options.clock` still takes precedence over `runtime` for that seam when both are supplied.

**Exported constants:** `LIVENESS_POLICY_VERSION`, `defaultRunIdentifierSeam`, `AGENT_RUN_PROVIDER_TURN_POLICY`, `TOOL_CALL_POLICY`, `SCHEDULER_TASK_POLICY`, `GATEWAY_CONNECTION_POLICY`, `BACKGROUND_EVALUATION_POLICY`, `WEBHOOK_DELIVERY_POLICY`, `WEFT_ACTIVITY_POLICY`, `WEFT_WORKER_POLICY`, `WEFT_TASK_POLICY`, `WEFT_STREAM_POLICY`.

**Exported types:** `LivenessSnapshot`, `LivenessSubjectKind`, `LivenessLifecycleStatus`, `LivenessReachability`, `LivenessProgressState`, `LivenessAssessment`, `SemanticProgress`, `LivenessLeaseEvidence`, `LivenessEvidenceSource`, `LivenessEvidenceEntry`, `DeclaredWait`, `DeclaredWaitReason`, `StallPolicy`, `LivenessClockSource`, `LivenessSuspensionBehavior`, `LivenessRecoveryRule`, `LivenessObservable`, `StallWatchdog`, `StallWatchdogAssessment`, `StallWatchdogClock`, `RunIdentifierSeam`.

**Child-liveness aggregation (AB-216, obs-03).** When a run is dispatched through `dispatchChildRun`/`createSubagentTool` with a `ChildRunRegistry` (the same registry backing `children()`/`abortChild()`, below), that registry also tracks each child's own `LivenessAssessment` and notifies its parent on every change. A parent `ActiveRun`/`AgentRun` supplied that same `RunOptions.childRegistry` therefore also carries an optional `LivenessSnapshot.worstChildAssessment`: the most severe assessment among its non-terminal children (`assessment !== 'terminal'`), most severe first—`unreachable` > `alive-but-stalled` > `aborting` > `cleaning-up` > `legitimately-waiting` > `healthy`—or absent when there are no children or every child is terminal. The parent's own `revision` advances whenever the folded value changes, even when none of the parent's own dimensions did; a stalled or unreachable child never changes the parent's own `reachability`/`progress`/`status`. Omit `childRegistry` and `worstChildAssessment` stays permanently absent, matching `children()`'s own opt-in default.

**Standalone-run identity (AB-88's Amendment 1, corrected by AB-214, migrated onto `RuntimeServices` by AB-325).** A standalone (non-Bureau) run mints a process-local id at `ActiveRun` construction from `createActiveRun`'s own resolved `RuntimeServices.identifiers` directly whenever `RunOptions.runId` and `CreateActiveRunDependencies.identifiers` are both absent—`RunIdentifierSeam` (`createDefaultRunIdentifierSeam`, itself now backed by a `RuntimeServices` instance) remains only as that explicit-override escape hatch and as public API from `@lostgradient/operative`. The minted id populates `LivenessSnapshot.id` and stamps curated `tool.*` bubble events and `createSubagentTool`'s per-call `parentRunId`; it is never registered with Bureau's `Store` and confers no locator or reattachment capability. A Bureau- or caller-supplied `runId` is always used as-is.

### Run Store

Observes one or more `ActiveRun` instances, accumulating steps, usage, and the action log. Use this to build dashboards, replay UIs, or cross-run analytics.

```typescript
import { createStore } from '@lostgradient/operative';
import { createActiveRun, stopWhen } from '@lostgradient/operative';

const store = createStore({ maxActions: 500, maxSnapshots: 10 });

const activeRun = createActiveRun({
  generate,
  toolbox,
  conversation,
  stopWhen: stopWhen.noToolCalls(),
});
const runId = store.register(activeRun, 'run-001');

// Subscribe to all store mutations
store.subscribe((state, action) => {
  const runState = state.runs.get(runId);
  console.log(runState?.status, action.type);
});

// Subscribe to a specific event type
store.subscribe('action', (event) => {
  console.log('Action recorded:', event.action.type);
});

// Inspect a run
const run = store.getRun(runId);
console.log(run?.steps.length, run?.usage.total);

// Remove when done
store.removeRun(runId);

// Tear down all subscriptions
store.dispose();
```

**`Store` interface:**

| Member                      | Description                                                   |
| --------------------------- | ------------------------------------------------------------- |
| `register(activeRun, id?)`  | Start tracking an `ActiveRun`. Returns the run id.            |
| `getState()`                | Returns `{ runs: Map<string, RunState>, actions: Action[] }`. |
| `getRun(id)`                | Returns the current `RunState` for a run.                     |
| `subscribe(listener)`       | Subscribe to all state mutations.                             |
| `subscribe(type, observer)` | Subscribe to a specific `StoreEventType`.                     |
| `removeRun(id)`             | Remove a run from the store.                                  |
| `deregister(id)`            | Detach store listeners without deleting run state.            |
| `dispose()`                 | Unsubscribe all runs and complete the event target.           |

**`RunState`:**

| Field | Type | Description |
| --- | --- | --- |
| `id` | `string` | Run identifier. |
| `status` | `'running' \| 'completed' \| 'error' \| 'aborted'` | Current run status. |
| `steps` | `StepResult[]` | Completed steps. |
| `usage` | `TokenUsage` | Accumulated token counts. |
| `finishReason` | `FinishReason \| undefined` | Set on terminal transition. |
| `snapshots` | `ConversationSnapshot[]` | Conversation snapshots after each step. |
| `actions` | `Action[]` | Per-run action log slice. |
| `activeRun` | `ActiveRun` | Reference to the live run. |

**Events:** `RunRegisteredEvent`, `RunRemovedEvent`, `StoreActionEvent`.

### Streaming Helpers

Wraps a streaming generate function into the standard `GenerateFunction` contract, and provides enhanced streaming primitives with state machines and backpressure buffers.

### `withStreaming(fn)`

Adapts a `StreamingGenerateFunction` (one that receives a `StreamingHandle`) into a standard `GenerateFunction`. The helper manages `appendStreamingMessage → updateStreamingMessage → finalizeStreamingMessage` on the conversation so the loop never sees raw streaming state:

```typescript
import { createActiveRun, stopWhen } from '@lostgradient/operative';
import { withStreaming } from '@lostgradient/operative';
import type { StreamingGenerateFunction } from '@lostgradient/operative';

const streamingGenerate: StreamingGenerateFunction = async ({ conversation, streaming }) => {
  // Push incremental tokens through streaming.update()
  streaming.update('Hello');
  streaming.update(', world');
  return {
    content: 'Hello, world',
    toolCalls: [],
    usage: { prompt: 5, completion: 10, total: 15 },
  };
};

const generate = withStreaming(streamingGenerate);

// `generate` is now a standard GenerateFunction—pass it anywhere.
const activeRun = createActiveRun({
  generate,
  toolbox,
  conversation,
  stopWhen: stopWhen.noToolCalls(),
});
const result = await activeRun.result;
```

### `withEnhancedStreaming(fn, options?)`

Wraps a `StreamingGenerateFunction` (like `withStreaming`, above) but also drives a `StreamStateMachine` internally and calls fine-grained callbacks as text and tool-call deltas arrive:

```typescript
import { withEnhancedStreaming } from '@lostgradient/operative';
import type { StreamingGenerateFunction } from '@lostgradient/operative';

declare const streamingGenerate: StreamingGenerateFunction;

const generate = withEnhancedStreaming(streamingGenerate, {
  onTextDelta: (delta, accumulated) => console.log('Text delta:', delta, accumulated),
  onToolCallStart: (toolName) => console.log('Tool call started:', toolName),
  onToolCallDelta: (_toolName, partialArgs) => console.log('Tool call args so far:', partialArgs),
});
```

By default the tool-call events are reconstructed from the resolved `GenerateResponse`, which means they land _after_ the provider response has closed. Text deltas stream live; tool-call deltas do not. Set `liveToolCalls` to change that:

```typescript
import { createAnthropicProviderStream } from '@lostgradient/operative';
import { withEnhancedStreaming } from '@lostgradient/operative';

const generate = withEnhancedStreaming(createAnthropicProviderStream({ model, apiKey }), {
  eventTarget,
  liveToolCalls: true,
});
```

The option installs `StreamingHandle.report`, an optional structured channel alongside the text-only `update`. The Anthropic and OpenAI streaming adapters push through it as the provider emits—Anthropic from `content_block_start`/`input_json_delta`, OpenAI from `delta.tool_calls`—so `stream:tool-call-start` and `stream:tool-call-delta` reach a host while the response is still open.

Two things to know before turning it on:

- **`blockId` changes.** Live events carry the provider's own block id (`toolu_01`, `call_01`) instead of the wrapper's synthesized `tool-${name}-${index}-${messageId}`.
- **`stream:tool-call-complete` stays late, by design.** An adapter only knows a tool call's parsed `arguments` once the stream has closed and the accumulated JSON has been through `JSON.parse`—the step that raises `ToolCallParseError`. The wrapper synthesizes the completion from the resolved response, reusing the live `blockId` so start, delta, and complete correlate.

A streaming function that reports nothing—a hand-written one, or the Gemini adapter—falls back to the reconstruction, so the option is safe to leave on across providers. (Parts, the other structured channel, are described under Response parts and generated media above.)

### `createBackpressureBuffer(options)`

Creates a backpressure-aware buffer for streaming events—queues, coalesces, and drops `StreamEvent`s under load:

```typescript
import { createBackpressureBuffer } from '@lostgradient/operative';

const buffer = createBackpressureBuffer({
  maxBufferSize: 100,
  coalesceDeltas: true,
  onOverflow: (droppedCount) => console.warn(`Dropped ${droppedCount} buffered events`),
  onEmit: (event) => console.log('Emit:', event.type),
});

buffer.push({ type: 'stream:text-delta', content: 'Hello', accumulated: 'Hello' });
```

### `createStreamStateMachine()`

Parses a raw token stream into typed blocks (`text`, `tool-call`, `thinking`, `metadata`):

```typescript
import { createStreamStateMachine } from '@lostgradient/operative';

const machine = createStreamStateMachine();
const state = machine.process({ type: 'block-start', id: 'block-1', blockType: 'text' });
machine.process({ type: 'block-delta', id: 'block-1', delta: 'Hello' });
console.log(state.textContent);
```

**Exported types:** `StreamBlock`, `StreamCommand`, `StreamEvent`, `StreamEventMap`, `StreamState`, `StreamStateMachine`, `BlockType`, `EnhancedStreamingOptions`, `LiveStreamEvent`, `BackpressureBuffer`, `BackpressureBufferOptions`, `StreamCustomEvent`.

### Retry Mutators

Transforms the generate context before each retry attempt—escalate temperature, drop bad tools, inject schema error feedback, or add jitter to delays. A mutator receives the context, the error, the attempt number, and the conversation history the failed attempt was sent with, so it can tell whether another writer changed the history while the request was in flight.

```typescript
import {
  composeMutators,
  createTemperatureEscalationMutator,
  createSchemaErrorMutator,
  createToolRemovalMutator,
  createOverflowMutator,
  addJitter,
} from '@lostgradient/operative';
import { createActiveRun, stopWhen } from '@lostgradient/operative';

// Increase by 0.2 per attempt (default), capped at 1.0
const escalate = createTemperatureEscalationMutator({
  increment: 0.2,
  max: 1.0,
});

// Re-inject a schema validation error as a user message
const schemaFeedback = createSchemaErrorMutator();

// Remove tools that caused errors on the previous attempt
const dropBadTools = createToolRemovalMutator();

// Recover from one context-window overflow by compacting the run's conversation
const overflow = createOverflowMutator({
  summarize: async (messages) => `Summary of ${messages.length} trimmed messages.`,
  retainRecentMessages: 10,
});

// Compose into a single mutator
const mutator = composeMutators(escalate, schemaFeedback, dropBadTools, overflow);

const activeRun = createActiveRun({
  generate,
  toolbox,
  conversation,
  stopWhen: stopWhen.noToolCalls(),
  retry: {
    attempts: 3,
    // addJitter(delay, options) is a plain function, not a factory—apply it
    // inside your own delay function to jitter each computed backoff.
    delay: (attempt) => addJitter(1000 * attempt, { maxJitter: 200 }),
    mutate: mutator,
  },
});
```

**Exported functions:**

| Function | Description |
| --- | --- |
| `composeMutators(...mutators)` | Chains mutators left-to-right—each receives the context the previous one returned, and the history the failed attempt was sent with. |
| `createTemperatureEscalationMutator(options)` | Increases temperature on each retry. Writes to `RETRY_TEMPERATURE_KEY` in metadata. |
| `createSchemaErrorMutator()` | Appends schema validation error details as a user message. |
| `createToolRemovalMutator()` | Removes tools that failed on the previous attempt. |
| `createOverflowMutator(options)` | On a context-overflow error, compacts the run's conversation once through `Conversation.compact()` and retries. When another writer, such as a background candidate, compacted the history after the failed request was sent, either before recovery started or while its own summary was being written, it retries once against that compaction instead of compacting again. A second overflow before any new durable message rethrows the provider error instead of looping. It never compacts over an open stream. |
| `addJitter(options?)` | Wraps a delay function to add random offset. |
| `RETRY_TEMPERATURE_KEY` | Metadata key used by `createTemperatureEscalationMutator`. |

### OpenTelemetry

Attaches OpenTelemetry spans to an `ActiveRun`, mirroring the agent loop lifecycle as nested spans. `@opentelemetry/api` is a direct dependency whose version comes from the root catalog.

```typescript
import { instrumentRun } from '@lostgradient/operative';
import { createActiveRun, stopWhen } from '@lostgradient/operative';
import { trace } from '@opentelemetry/api';

const activeRun = createActiveRun({
  generate,
  toolbox,
  conversation,
  stopWhen: stopWhen.noToolCalls(),
});

// Wire up OTel spans
const stopInstrumentation = instrumentRun(activeRun, {
  tracer: trace.getTracer('my-app', '1.0.0'),
  // Or let instrumentRun create a default tracer:
  // tracerName: 'operative',
  // tracerVersion: '0.0.0',
  agentName: 'Math Tutor', // optional—names the run span `invoke_agent Math Tutor`
});

await activeRun.result;
stopInstrumentation(); // Remove listeners and end any open spans
```

`instrumentRun()` creates:

- `invoke_agent` (or `invoke_agent {agentName}`) span for the full run lifetime—the OTel GenAI "Invoke agent (internal)" span.
- `step` spans for each loop iteration, nested under the run span (`operative.step.index` carries the step number; the name is intentionally stable to avoid unbounded span-name cardinality).
- `generate` spans for each LLM call observed at the loop boundary, nested under their step.
- `tool_calls` spans grouping the tool calls issued in a step, nested under their step.

See [OTel GenAI Semantic Conventions](#otel-genai-semantic-conventions) below for the full attribute mapping and pinned conventions version.

**Exported:**

| Symbol                               | Description                                            |
| ------------------------------------ | ------------------------------------------------------ |
| `instrumentRun(activeRun, options?)` | Attach OTel spans; returns an unsubscribe function.    |
| `RunInstrumentationOptions`          | `{ tracer?, tracerName?, tracerVersion?, agentName? }` |

### OpenTelemetry (Inference Calls)

Wraps a `GenerateFunction` with a single CLIENT span per call, following the OTel GenAI "Inference" (chat) span convention. Use this when you want the canonical, spec-compliant span for the actual LLM request—with model, provider, and token usage—as opposed to the loop-level `generate` span from `@lostgradient/operative`, which has no model/provider visibility.

```typescript
import { instrumentGenerate } from '@lostgradient/operative';
import { createAnthropicProvider } from '@lostgradient/operative';
import { trace } from '@opentelemetry/api';

const rawGenerate = createAnthropicProvider({ model: 'claude-sonnet-5' });
const generate = instrumentGenerate(rawGenerate, {
  provider: 'anthropic',
  model: 'claude-sonnet-5',
  tracer: trace.getTracer('my-app', '1.0.0'),
});
```

`instrumentGenerate()` creates a `{operation} {model}` CLIENT span—`operation` is `chat` for turn-based chat completion providers (Anthropic, OpenAI, Voyage, Ollama) and `generate_content` for Gemini's native `generateContent` surface—with `gen_ai.operation.name`, `gen_ai.provider.name`, `gen_ai.request.model`, `gen_ai.request.max_tokens` (when supplied), and `gen_ai.usage.*` token attributes (including provider cache fields, when present).

**Exported:**

| Symbol | Description |
| --- | --- |
| `instrumentGenerate(generateFunction, options)` | Wrap a `GenerateFunction` with a CLIENT chat span. |
| `GenerateInstrumentationOptions` | `{ tracer?, tracerName?, tracerVersion? }` |
| `InstrumentableGenerateOptions` | `{ provider: ProviderName, model: string, maximumTokens? }` |

### OTel GenAI Semantic Conventions

Spans and attributes across Operative runtime and provider instrumentation and `armorer` follow the [OpenTelemetry GenAI semantic conventions](https://github.com/open-telemetry/semantic-conventions-genai) wherever a direct mapping exists. The conventions are still in **Development** status (no tagged release as of this writing) and can change—this table is pinned to:

- `open-telemetry/semantic-conventions-genai` commit [`63f8200`](https://github.com/open-telemetry/semantic-conventions-genai/commit/63f8200eee093730ce845d26ce2aafb621b0807e) (`docs/gen-ai/gen-ai-spans.md`, `docs/gen-ai/gen-ai-agent-spans.md`)
- general attributes (`error.*`, `server.*`) cross-referenced against semantic-conventions [v1.43.0](https://github.com/open-telemetry/semantic-conventions/tree/v1.43.0)

When the pinned spec revision changes, re-diff these two files against the new commit and update this table alongside the code.

| Our span (package) | OTel GenAI span | Span name | Kind | Key attributes | Divergence |
| --- | --- | --- | --- | --- | --- |
| `invoke_agent` (`@lostgradient/operative`) | Invoke agent (internal) | `invoke_agent [{agentName}]` | INTERNAL | `gen_ai.operation.name=invoke_agent`, `gen_ai.agent.name`, `gen_ai.usage.*` | `operative.finish_reason`/`operative.total_steps`/`operative.abort_reason` are documented custom extensions. `event.finishReason` (`stop-condition`, `maximum-steps`, `budget-exceeded`, `aborted`, ...) is intentionally kept OFF `gen_ai.response.finish_reasons`—it is operative's own agent-loop control-flow reason, not a provider-reported model completion reason, and mapping it there would mislead OTel GenAI backends that expect well-known provider stop reasons. |
| `step` (`@lostgradient/operative`) | _(none)_ | `step` | INTERNAL | `operative.step.index` | **Divergent.** No spec equivalent for a single loop iteration. Kept as a non-normative structural span; name held constant (not `step {n}`) to avoid unbounded span-name cardinality. |
| `generate` (`@lostgradient/operative`) | _(none—see `providers/instrumentation` row)_ | `generate` | INTERNAL | `operative.usage.*`, `operative.generate.duration_ms` | **Divergent, intentionally.** Observes the loop's call boundary without model/provider visibility. NOT labeled `gen_ai.operation.name=chat` and usage is namespaced under `operative.*` (not `gen_ai.*`) so it never double-reports usage against the canonical chat span below when both instrumentation points are wired to the same call. |
| `tool_calls` (`@lostgradient/operative`) | _(none)_ | `tool_calls` | INTERNAL | `operative.tools.count`, `operative.tools.names`, `operative.tools.results_count` | **Divergent.** The spec defines a per-call `execute_tool` span (see below), not a batch wrapper for the calls issued in one step. |
| `{chat\|generate_content} {model}` (`@lostgradient/operative`) | Inference | `{gen_ai.operation.name} {model}` | CLIENT | `gen_ai.operation.name` (`chat`, or `generate_content` for Gemini), `gen_ai.provider.name`, `gen_ai.request.model`, `gen_ai.request.max_tokens`, `gen_ai.usage.*` | None—full compliance. This is the canonical span for a single LLM inference call. |
| `execute_tool {name}` (`armorer`) | Execute tool | `execute_tool {gen_ai.tool.name}` | INTERNAL | `gen_ai.operation.name=execute_tool`, `gen_ai.tool.name`, `gen_ai.tool.call.id`, `gen_ai.tool.description`, `error.type` | `gen_ai.tool.call.arguments`/`gen_ai.tool.call.result` are Opt-In under the conventions and deliberately not emitted—they can carry privileged tool arguments/results (AB-87/AB-230). `armorer.tool.*` carries duration/digest/status extensions the spec doesn't define. |

`gen_ai.provider.name` values are mapped from operative's internal `ProviderName` to the conventions' well-known values where one is registered:

| `ProviderName` | `gen_ai.provider.name` | Note |
| --- | --- | --- |
| `anthropic` | `anthropic` | Well-known value. |
| `openai` | `openai` | Well-known value. |
| `gemini` | `gcp.gemini` | operative's `gemini` provider talks to the AI Studio endpoint (`generativelanguage.googleapis.com`) via `@google/genai`, which the conventions register as `gcp.gemini` (not bare `gemini`). |
| `voyage` | `voyage` | No well-known value registered—a custom value, as explicitly permitted by the conventions. |
| `ollama` | `ollama` | No well-known value registered—a custom value, as explicitly permitted by the conventions. |

`total_tokens` is intentionally not emitted as a `gen_ai.usage.*` attribute anywhere—it isn't a defined attribute in the conventions, and any GenAI-aware backend already sums `input_tokens` + `output_tokens` itself.

### Durable Runs

Drives agent runs through the Weft durable execution engine—checkpointed, crash-recoverable, and resumable. The `ActiveRun` surface is identical to the in-memory path; only the second argument to `createActiveRun()` changes.

```typescript
import { createActiveRun } from '@lostgradient/operative';
import type { DurableRunRouting } from '@lostgradient/operative';
import { createCheckpointStore, createRunEngine, createRunWorkflow } from '@lostgradient/operative';

// Build the durable substrate once at startup. createRunEngine returns
// { engine, checkpointStore }—`storage` is Weft's raw Storage backend;
// `checkpointStore` wraps a TextValueStore over that same backend.
const checkpointStore = createCheckpointStore(kvStore);
const runWorkflow = createRunWorkflow(checkpointStore);
const { engine } = await createRunEngine({ storage: rawStorage, runWorkflow, checkpointStore });

// Start a new durable run—survives crashes and resumes automatically
const durable: DurableRunRouting = {
  engine,
  checkpointStore,
  runId: 'run-2024-001',
  prompt: 'Summarize the annual report.',
};

const activeRun = createActiveRun({ generate, toolbox, conversation }, durable);
const result = await activeRun.result;
```

> [!NOTE] Reattaching after a restart `reattachDurableActiveRun` wraps a handle already returned by `engine.recoverAll()`—it does not take a `sessionId`/`options` bag. `createRunEngine`'s default `recover: true` runs recovery during construction and does not surface the handles, so observing a recovered run as a live `ActiveRun` requires `recover: false` plus calling `engine.recoverAll()` yourself and reattaching each returned handle. See `reattachDurableActiveRun`'s own JSDoc and `bureau`'s `create-bureau.ts` (`reattachRecoveredRun`) for the full recovery-driven flow.

> [!NOTE] Multi-process safety (AB-178) `createRunEngine`'s `ownership` option defaults to `'workflow-lease'`, so more than one engine can safely share a store without opting in: Weft claims each workflow for exactly one engine before its generator runs, so a second engine racing to resume the same workflow fails closed instead of double-executing it. This requires a storage backend with the `conditionalBatch` capability (`MemoryStorage` and `SQLiteStorage` both qualify). Same-engine suspend/resume preemption is supported under `'workflow-lease'`; the claim is reacquired after suspend and remains exclusive to the resuming engine. Construction throws when the storage lacks `conditionalBatch`; hosts with such an adapter, or that deliberately run one engine per store by infrastructure convention (one replica, a `Recreate` deploy), pass `ownership: 'none'` to opt out.

> [!NOTE] Per-step persistence cost (COR-1376) Weft encodes every step's memoized result into the run's checkpoint, hashes it into the workflow event log, and stores every operation's input and output in the timeline. A step's result therefore records the conversation as a delta from the snapshot the step started from (the messages, history nodes, and path entries it appended), and that step's `saveConversation` activity receives the same delta and applies it to the transcript the run saved last, so what each step writes stays the size of that step however long the run grows. The checkpoint store still holds the whole transcript. The first step, and the first step after a wakeup or signal continuation, record the snapshot whole, because their input is built outside a memo with fresh ids and timestamps on every replay. A delta refuses to apply to any snapshot but its recorded base, so a diverged replay fails loudly rather than corrupting the transcript. `scripts/benchmarks/durable-snapshot-save.ts` times a long run on demand and can be profiled with `bun --cpu-prof`; nothing in `bun run test` measures time.

> [!WARNING] weft 0.23 persisted-data schema bump (breaking for existing stores) `@lostgradient/weft` 0.23 advances its persisted-data schema from version 1 to version 2 with **no in-place migration**: a store written by weft 0.22.x or earlier is rejected with `PersistedDataIncompatibleError` when opened under 0.23+. There is no online upgrade path—plan a cutover (new store, or offline migration) before deploying this version against an existing durable store.

**Exported functions:**

| Function | Description |
| --- | --- |
| `createRunEngine(options)` | Creates and recovers a `RunEngine` backed by Weft storage. |
| `createCheckpointStore(kvStore)` | KV-backed store for per-step run checkpoints. |
| `createDurableActiveRun(context, input)` | Low-level: create a durable `ActiveRun` directly. |
| `reattachDurableActiveRun(context, input)` | Reattach listeners to a run already in progress (e.g. after server restart). |
| `createRunWorkflow(options)` | Creates the Weft workflow definition for agent runs. |
| `isAgentRunWorkflowInput(value)` | Type guard for `AgentRunWorkflowInput`. |
| `createStorageActivities(store)` | Weft activities for checkpoint read/write. |
| `startDurableRunResult(options)` | Starts a run result inside a durable workflow context. |
| `resumeDurableRunResult(options)` | Resumes an existing run result from checkpoint. |
| `SCHEDULER_ORIGIN_TAG` | Tag identifying scheduler-originated durable runs. |
| `SCHEDULER_RUN_ID_PREFIX` | Prefix for scheduler-managed run IDs. |

**Exported types:** `DurableActiveRunOptions`, `DurableActiveRunContext`, `RecoveredRunHandle`, `StartDurableRunResultOptions`, `CheckpointStore`, `RunEngine`, `RegistryAgnosticEngine`, `CreateRunEngineOptions`, `RunEngineObservability`, `AgentRunWorkflowInput`, `AgentRunWorkflowResult`, `DurableRunDeps`, `RunCheckpoint`, `RunCursor`, `StepRecord`, `SteeringCommand`, `SteeringCommandFailure`, `SteeringCommandState`, `SteeringDesiredState`, `SteeringEffectiveState`, `SteeringRequestedValue`, `SteeringTargetKind` (AB-67—the runtime steering contract's type-only surface). `SteeringDesiredState`/`SteeringEffectiveState` are exported here for the contract's shape; the runtime consumer of `SteeringDesiredState` is `RunOptions.steering: SteeringGate` (see the `RunOptions` table above and `GenerateContext.steering` below)—the `runStep` boundary read, pause/resume gate, and `GenerateContext` threading now ship. Bureau's `submitSteeringCommand` admission surface ships all seven steering targets on authorized in-memory and durable sessions; durable commands persist before desired-state admission and replay during recovery. Policy references remain unsupported until the selector can resolve them, while unknown concrete coordinates are rejected at admission. See [the full steering contract](../../documentation/operative-type-safe-api.md#steering-commands). AB-67's 2026-09-02 coordinator amendments, as tightened by AB-236: `SteeringCommandFailure` is a discriminated union on `reason`—the `'superseded-by'` member requires `readonly supersededBy: string` (the successor command's `id`); every other member carries `supersededBy?: never`, so a literal or non-literal value supplying a real `supersededBy` alongside a different reason, or omitting it alongside `'superseded-by'`, fails to type-check rather than merely violating a documented invariant (the shared TypeScript configuration also rejects an explicit `supersededBy: undefined`); every `SteeringRequestedValue` variant encodes `policyRef`/`override` as an exclusive pair (`policyRef?: never` alongside `override`, `override?: never` alongside `policyRef`), rejecting a literal that supplies both or neither; `SteeringCommand` carries `runId?: string`, binding a `pause`/`resume` command to a session's non-terminal run—present, it must name a non-terminal run owned by the session or admission fails with `'run-terminal'`; absent with exactly one non-terminal run, the command binds to it; absent with zero or more than one, admission fails with the new `SteeringCommandFailure.reason: 'run-ambiguous'`.

> [!NOTE] Session-input admission types (AB-42, type-only) `@lostgradient/operative` also exports `SessionInputDeliveryMode`, `UserAdmissibleContent`, `SessionInputPayload`, `SessionInputRecord`, `SessionInputAdmissionRequest`, `SessionInputReceipt`, `SessionInputConflict`, `SessionInputAdmissionOutcome`, `SessionInputState`, `SessionInputPromotion`, and `SessionInputFailure`—the request, receipt, and state-transition shapes AB-42's decision record fixes for session-input admission (`submitSessionInput`, illustratively named). Operative exports these shapes as types. Bureau implements `submitSessionInput`: authorized, non-terminal requests are admitted to the session's durable mailbox (`unsupported-capability` with reason `durable-mailbox-unavailable` only when no mailbox is composed), and a durable run receives an admitted input through `RunOptions.sessionInput`, a `SessionInputGate` (`createMailboxSessionInputGate` builds one over a Weft mailbox, `parseSessionInputPayload` validates a stored payload). The workflow asks the gate before each step generates, and once more when the step would end the run while steps remain, so input sent during the last step is answered in the same run; each input's promotion commits in the same atomic write as the transcript that holds its turn, whatever the step's outcome, so the two cannot disagree, and the turn's message id is the input's own `id`. Bureau never starts a run to answer input: input still open when its run ends is cancelled, with reason `the run ended before the input was delivered`, so the client resends it; see `documentation/runtime-contracts.md` for the full lifecycle. Per AB-42's coordinator amendments (2026-09-02, applied by AB-202): `SessionInputRecord` and `SessionInputAdmissionRequest` take a `TPayload extends SessionInputPayload` bound rather than an unbounded generic, `SessionInputPayload` accepts only `UserAdmissibleContent`, an explicit allowlist of `TextContent` (with citation values structurally forbidden via `citations?: undefined`, not merely omitted; an explicit `undefined` remains allowed), `ImageContent`, and `DocumentContent`—not an `Exclude<>` blacklist, because a blacklist would silently admit a future conversation content kind, and `SessionInputConflict.reason` gains `'id-owned-by-other-principal'` for a session-input `id` collision across principals. See `documentation/operative-type-safe-api.md`'s "Session input admission" section for the full contract.

**Session-input admission types:** `SessionInputDeliveryMode`, `UserAdmissibleContent`, `SessionInputPayload`, `SessionInputRecord`, `SessionInputAdmissionRequest`, `SessionInputReceipt`, `SessionInputConflict`, `SessionInputAdmissionOutcome`, `SessionInputState`, `SessionInputPromotion`, `SessionInputFailure`.

> [!NOTE] Durable event history types (AB-91's `ab91-01` slice, AB-310; widened by AB-320) `@lostgradient/operative` also exports `DurableEventOwnerKind` (`'run' | 'session' | 'schedule'`—`'schedule'` added by AB-320, owning a schedule's four definition events only; a scheduled fire stays on the `'run'` owner), `DurableEventOwner`, `DurableEventEnvelope`, `DurableEventPage`, and `DurableEventGap`—the wire types Bureau's `durable-event-history.ts` store and `Bureau.eventHistory(owner, options?)` read/return. `DurableEventEnvelope` is a redacted, owner-scoped projection of Weft's own `FleetEventEnvelope`, carrying a new `schemaVersion` field Weft's envelope does not have. `DurableEventGap` is returned instead of a `DurableEventPage` when a caller's `since` cursor predates the store's retention floor—distinguishable from an ordinary empty page.

**Durable event history types:** `DurableEventOwnerKind`, `DurableEventOwner`, `DurableEventEnvelope`, `DurableEventPage`, `DurableEventGap`.

### Test Utilities

Test helpers for the agent loop. Import in test files only.

```typescript
import {
  createEventRecorder,
  createManualRuntimeServices,
  createMockGenerate,
  createMockGenerateOnce,
  createResourceScope,
  createRunRecorder,
  createMockScratchpad,
  createTestStore,
} from '@lostgradient/operative';
import type { EventRecorder, QuiescenceReport, RunRecorder } from '@lostgradient/operative';
import { createActiveRun, stopWhen } from '@lostgradient/operative';

// Replay pre-canned responses in sequence
const generate = createMockGenerate([
  { content: 'Step 1 response', toolCalls: [] },
  { content: 'Step 2 response', toolCalls: [], usage: { prompt: 5, completion: 8, total: 13 } },
]);

// A deterministic RuntimeServices—no real timer or real clock anywhere in it
const runtime = createManualRuntimeServices();

const activeRun = createActiveRun({
  generate,
  toolbox,
  conversation,
  stopWhen: stopWhen.noToolCalls(),
  runtime,
});

// Record every event for assertion
const recorder: RunRecorder = createRunRecorder(activeRun);
await activeRun.result;

expect(recorder.events.map((e) => e.type)).toContain('run.completed');
expect(recorder.steps).toHaveLength(2);
expect(generate.callCount).toBe(2);

// EventRecorder (AB-92/AB-255): subscribes through the complete event-map
// type, no hand-maintained allowlist, and normalizes into a portable,
// byte-identical-across-machines causal trace.
const eventRecorder: EventRecorder = createEventRecorder(runtime);
eventRecorder.attach(activeRun, { kind: 'run', id: 'example' });
eventRecorder.assertHappensBefore('run.started', 'run.completed');

// Single-shot generate—throws if called more than once
const once = createMockGenerateOnce({ content: 'Only once', toolCalls: [] });

// In-memory store for testing operative/store consumers
const store = createTestStore();

// ResourceScope (AB-92/AB-256): register runs, subscriptions, timers, and
// deferred-queue items a test expects to become quiescent, then prove it.
const scope = createResourceScope('example-test', runtime);
scope.register({ kind: 'run', identifier: 'run-1', run: activeRun });
const report: QuiescenceReport = await scope.close(); // rejects with a QuiescenceError if anything leaked
expect(report.quiescent).toBe(true);
```

**Exported:**

| Symbol | Description |
| --- | --- |
| `createMockGenerate(responses)` | Replays `GenerateResponse[]` in sequence; exposes `.calls` and `.callCount`. |
| `createMockGenerateOnce(response)` | Returns response once; throws on subsequent calls. |
| `createRunRecorder(activeRun, runtime?)` | Records all events from an `ActiveRun` for assertion. Exposes `.events`, `.steps`, `.clear()`. Built on `createEventRecorder`. |
| `createEventRecorder(runtime)` | AB-92/AB-255's `EventRecorder`: `attach`/`attachIterable` a resource's complete event-map type, `normalize()` into a portable `CausalTraceEntry[]`, `assertSequence`/`assertHappensBefore`. |
| `createManualRuntimeServices(options?)` | Deterministic `RuntimeServices` (AB-92/AB-252): explicit `advance(ms)`/`setTime(epoch)` time control, seeded identifiers and randomness, no real timer. Re-exported from `@lostgradient/lifecycle`, a private workspace inlined into this package, so import it from `@lostgradient/operative` (COR-89). An `options.origin` that `Date.parse` cannot read throws a `RangeError` at construction. |
| `createMockScratchpad(initialValues?)` | In-memory `Scratchpad` for testing scratchpad-dependent agents. |
| `createTestStore()` | In-memory `Store` instance from `@lostgradient/operative`. |
| `createResourceScope(label, runtime)` | AB-92/AB-256's `ResourceScope`: `register()` a run, timer, subscription, deferred-queue item, or `ChildRunRegistry`; `child(label)` nests a scope; `assertQuiescent()` probes without aborting; `close()` aborts every registered run, awaits its `closed()`, and rejects with a `QuiescenceError` naming every resource still live. |
| `runReactiveSourceConformanceSuite(options, testRunner?)` | AB-92/AB-258's framework-neutral reactive-source conformance suite: registers one `describe` block with one `it` per case (`stableSnapshotIdentity`, `immutableReplacementAfterChange`, `multipleIndependentSubscribers`, `subscribeReadRaceClosure`, `earlyCompletionBeforeSubscription`, `subscribeUnsubscribeSubscribeNoDuplicateWork`, and—only when `options.reattach` is supplied—`serializableLocatorRoundTrip`) against any subject implementing `ReactiveSourceSubject<TSnapshot>`. Never imports a resource type from this package outside its own generic parameter, so it runs against `ActiveRun`/`AgentRun`'s upcoming snapshot surface or any other conforming resource by supplying an adapter. `testRunner` defaults to `bun:test`'s real `describe`/`it`. |

**Exported types:** `RunRecorder`, `EventRecorder`, `CausalTraceEntry`, `EventRecorderOwnerIdentity`, `ManualRuntimeServices`, `ResourceScope`, `QuiescenceReport`, `LeakedResource`, `LeakedResourceKind`, `LeakedResourceDiscoveredVia`, `DetachedResource`, `RegisterableResource`, `ClosableRun`, `ReactiveSourceSubject`, `ReactiveSourceConformanceOptions`, `ReactiveSourceConformanceTestRunner`.

**Also exported (runtime value, not a type):** `QuiescenceError`—the `Error` subclass `close()` rejects with; import it normally (`import { QuiescenceError } from '@lostgradient/operative'`), not with `import type`.

### Scripted doubles and the `FaultPlan` vocabulary (AB-92/AB-257)

`fault-plan.ts` ships AB-92's `FaultPlan` type vocabulary—`FaultBoundary`, `FaultOperation`, `FaultOccurrence`, `FaultPlanEntry`, `FaultPlan`, `FiredFault`—with no executor yet (a future fault engine applies a `FaultPlan` at a boundary; this slice ships only the shapes).

`createScriptedGenerate`, `createScriptedTool`, and `createScriptedHook` are named doubles for the boundaries AB-92 enumerates—a `GenerateFunction`, a toolbox-ready `Tool`, and a `HookRegistry<OperativeHookMap>` handler, respectively—each driven by a script of steps consumed one per call:

```typescript
import { createToolbox } from 'armorer';
import { Conversation } from 'conversationalist';
import {
  HookRegistry,
  createManualRuntimeServices,
  createScriptedGenerate,
  createScriptedHook,
  createScriptedTool,
} from '@lostgradient/operative';
import { createActiveRun, stopWhen } from '@lostgradient/operative';
import type { OperativeHookMap } from '@lostgradient/operative';

const runtime = createManualRuntimeServices();

// One ScriptedGenerateStep consumed per call: 'respond' | 'stream' | 'block' | 'fail' | 'ignore-abort'.
const generate = createScriptedGenerate([
  { kind: 'respond', response: { content: 'hi', toolCalls: [] } },
]);

// A toolbox-ready Tool double: 'resolve' | 'reject' | 'block' steps, settled() for async assertions.
const tool = createScriptedTool('search', [{ kind: 'resolve', result: 'ok' }]);
const toolbox = createToolbox([tool]);

// A hook double for one of the four phases; `hookName` is the OperativeHookMap key to register it under.
const hooks = new HookRegistry<OperativeHookMap>();
const afterTool = createScriptedHook('after-tool', [{ kind: 'resolve', value: undefined }]);
hooks.on(afterTool.hookName, afterTool);

const activeRun = createActiveRun({
  generate,
  toolbox,
  conversation: new Conversation(),
  stopWhen: stopWhen.noToolCalls(),
  hooks,
  runtime,
});
await activeRun.result;

// assertReceived compares only the fields you supply, against a call already recorded.
generate.assertReceived(0, { tools: ['search'] });
await tool.settled(); // readonly ScriptedSettlement[]—resolved/rejected outcome per call
```

A `block` step (`{ kind: 'block', barrier: 'name' }`) suspends the call until the test calls `release('name')`; `reached('name')` resolves once the double has arrived at that barrier, so a test awaits arrival instead of sleeping. `release` before `reached` is a latch, not a race—releasing a barrier no one has hit yet still unblocks the call once it gets there.

**Exported:** `createScriptedGenerate(script)`, `createScriptedTool(name, script)`, `createScriptedHook(phase, script)`.

**Exported types:** `FaultBoundary`, `FaultOperation`, `FaultOccurrence`, `FaultPlanEntry`, `FaultPlan`, `FiredFault`, `ScriptedGenerate`, `ScriptedGenerateStep`, `ScriptedGenerateCall`, `ScriptedGenerateExpectation`, `ScriptedTool`, `ScriptedToolStep`, `ScriptedToolCall`, `ScriptedHook`, `ScriptedHookPhase`, `ScriptedHookStep`, `ScriptedHookCall`, `ScriptedSettlement`.

### The named barrier registry (AB-92/AB-266)

`createBarrierRegistry(recorder?)` builds a `BarrierRegistry`: a named collection of `Barrier`s a deterministic suite uses in place of a real-timer sleep, at any coordination point where the public surface already offers a hook, an event, or an injected double—a model call, a tool call, a hook phase (through the scripted doubles' own `block` step), a durable checkpoint, a session commit, a child registration, a signal delivery, an event publication, or a cleanup boundary (through `closed()`).

```typescript
import { createBarrierRegistry } from '@lostgradient/operative';

const registry = createBarrierRegistry();
const barrier = registry.barrier('slow-write');

// The guarded operation: suspends until the test releases it.
async function guardedOperation() {
  const value = await barrier.arrive(); // resolves to release()'s value, or throws reject()'s error
  return value;
}
const pending = guardedOperation();

// The test: waits for arrival (never hangs on a late subscribe), inspects
// counts, then lets exactly one waiting arrival through.
await barrier.reached();
expect(barrier.inspect()).toEqual({ name: 'slow-write', arrivals: 1, released: 0, pending: true });
barrier.release('ok');
expect(await pending).toBe('ok');

// A test that ends with an arrival never released fails loudly, naming it.
registry.assertNoPending();
```

`release()` called before any arrival is banked and lets the next `arrive()` through without blocking—an over-release, not a race. `reject(error)` makes the waiting `arrive()` call throw `error`, doubling as a fault-placement mechanism at a point `fault-plan.ts`'s vocabulary doesn't name; it counts toward `released` the same way `release()` does, so a rejected arrival is never reported as still pending.

When `recorder` (an `EventRecorder`) is supplied, every arrival, release, and rejection is recorded as a `CausalTraceEntry` with `resource: 'barrier:<name>'` and `event: 'barrier.reached' | 'barrier.released' | 'barrier.rejected'`—`attach`'s own `${kind}:${id}` resource shape, not the bare name, since `event-recorder.ts` exposes no lower-level entry-push API.

**Exported:** `createBarrierRegistry(recorder?)`.

**Exported types:** `Barrier`, `BarrierRegistry`, `BarrierState`.

### The reproduction artifact (AB-92/AB-334)

`ReproductionArtifact<TCleanupReport>` is AB-92 AC8's normalized reproduction shape—`sourceRevision`, `packageVersions`, `effectiveModel`, `clockOrigin`/`identifierSeed`/`randomSeed`, `scriptedOutcomes`, `firedFaults`, `causalTrace`, `terminalResult`, and `cleanupReport`—written and read by `writeReproductionArtifact`/`readReproductionArtifact` (AB-267) as stable, fixed-key-order JSON. It is the ONE declaration of the shape in the repository: `cleanupReport` is a type parameter (defaulting to `ReproductionCleanupReport`, i.e. `CleanupAcknowledgement | DeferredDrainReport`) rather than a fixed union, so a downstream package with its own cleanup-report shape—`bureau/test`'s `ReproductionArtifact` adds `BureauShutdownReport`—instantiates this declaration instead of redeclaring it (`bureau` depends on `@lostgradient/operative`, never the reverse, so the canonical shape has to live here for that to work).

```typescript
import type { ReproductionArtifact, ReproductionCleanupReport } from '@lostgradient/operative';

// A caller with no wider cleanup-report shape of its own uses the default:
type MyArtifact = ReproductionArtifact; // cleanupReport: ReproductionCleanupReport

// A caller that widens it composes onto the named union instead of
// repeating its members:
type MyWiderArtifact = ReproductionArtifact<ReproductionCleanupReport | { readonly custom: true }>;
```

**Exported types:** `ReproductionArtifact<TCleanupReport>`, `ReproductionCleanupReport`, `ScriptedOutcome`, `BaselineReplayResult`.

## Development

Run the focused checks from this package directory:

```bash
bun run lint
bun run typecheck
bun run test
```

From the Corvidae root, run `bunx turbo run lint typecheck test --filter=@lostgradient/operative` for this workspace or `bun run validate` for the complete workspace. Formatting is configured at the root. This library has no build or publishing command.
